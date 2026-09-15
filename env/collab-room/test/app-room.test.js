"use strict";
/*
 * 房间页客户端（app-room.js）重连行为测试。
 *
 * 用 vm 沙箱 + DOM/WebSocket 桩加载真实客户端脚本，复现
 * 「编辑已发送、ack 未归、连接断开」的场景，验证：
 *   - 重连后未确认编辑不被清空，且以同一 opId 重新提交；
 *   - 服务器若已应用过（ack 丢失），重发得到 duplicate，不再重复发送；
 *   - inflight 期间的后续离线输入保持顺序接力提交。
 *
 * 纯 node:test，随 `npm test`（node --test test/）一起运行。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CORE_SRC = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "app-room.js"), "utf8");

/* ---------- 最小 DOM 桩 ---------- */

function makeEl(id) {
  const listeners = {};
  return {
    id: id,
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    selectionStart: 0,
    selectionEnd: 0,
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 600,
    style: {},
    parentElement: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { (listeners[type] || []).forEach(fn => fn(ev || {})); },
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    appendChild() {},
    querySelectorAll() { return []; }
  };
}

/* ---------- 在沙箱中启动真实 app-room.js ---------- */

function createApp() {
  const elements = {};
  const sockets = [];
  const timers = new Map();
  let timerSeq = 0;

  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    sockets.push(this);
  }
  FakeWebSocket.prototype.send = function (data) { this.sent.push(JSON.parse(data)); };
  FakeWebSocket.prototype.close = function () {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  };

  const sandbox = {
    URLSearchParams: URLSearchParams,
    location: { search: "?id=room1", protocol: "http:", host: "t.local",
      origin: "http://t.local", href: "" },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
      createElement(tag) { return makeEl(tag); },
      activeElement: null,
      title: ""
    },
    WebSocket: FakeWebSocket,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    // 手动触发的定时器：重连退避、光标节流、toast 都不自动跑
    setTimeout(fn) { const id = ++timerSeq; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++timerSeq; },
    clearInterval() {},
    getComputedStyle() { return {}; },
    addEventListener() {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CORE_SRC, sandbox, { filename: "core.js" });
  vm.runInContext(APP_SRC, sandbox, { filename: "app-room.js" });

  const editor = elements.editor;
  return {
    sockets: sockets,
    editor: editor,
    // 执行所有到期的定时器回调（触发重连等）
    runTimers() {
      const fns = Array.from(timers.values());
      timers.clear();
      fns.forEach(fn => fn());
    },
    type(text) {
      editor.value = text;
      editor.fire("input");
    },
    // 服务器视角：接受连接并下发 hello 快照
    serverHello(sock, rev, text) {
      sock.readyState = 1;
      sock.onopen();
      sock.onmessage({ data: JSON.stringify({
        type: "hello", rev: rev, text: text, conflicts: [], members: [],
        room: { id: "room1", name: "测试房" }
      }) });
    },
    deliver(sock, obj) { sock.onmessage({ data: JSON.stringify(obj) }); },
    commits(sock) { return sock.sent.filter(m => m.type === "commit"); }
  };
}

/* ---------- 用例 ---------- */

test("重连后保留未确认编辑并以同一 opId 重发（服务器未收到）", () => {
  const app = createApp();
  const sock1 = app.sockets[0];
  app.serverHello(sock1, 0, "");

  app.type("你好");
  const sent1 = app.commits(sock1);
  assert.equal(sent1.length, 1);
  assert.deepEqual(sent1[0].ops, [{ t: "ins", gap: 0, text: "你好" }]);
  const opId = sent1[0].opId;

  // ack 未归就断线 -> 客户端退避重连
  sock1.close();
  app.runTimers();
  assert.equal(app.sockets.length, 2);
  const sock2 = app.sockets[1];

  // 服务器从未收到该编辑：快照仍是空文本
  app.serverHello(sock2, 0, "");

  // 未确认文字不被清空，且以同一 opId 重新提交
  assert.equal(app.editor.value, "你好");
  const sent2 = app.commits(sock2);
  assert.equal(sent2.length, 1);
  assert.equal(sent2[0].opId, opId);
  assert.deepEqual(sent2[0].ops, [{ t: "ins", gap: 0, text: "你好" }]);

  // 服务器这次确认，正常收敛
  app.deliver(sock2, { type: "ack", opId: opId, result: "ok",
    rev: 1, text: "你好", conflicts: [] });
  assert.equal(app.editor.value, "你好");
});

test("服务器已应用但 ack 丢失：重连重发收到 duplicate，只生效一次", () => {
  const app = createApp();
  const sock1 = app.sockets[0];
  app.serverHello(sock1, 0, "");
  app.type("你好");
  const opId = app.commits(sock1)[0].opId;

  sock1.close();
  app.runTimers();
  const sock2 = app.sockets[1];

  // 服务器其实已应用该操作（ack 在路上丢了）：快照已含这段文字
  app.serverHello(sock2, 1, "你好");

  // 客户端无法确定服务器是否收到，仍会以同一 opId 重发一次
  const sent2 = app.commits(sock2);
  assert.equal(sent2.length, 1);
  assert.equal(sent2[0].opId, opId);
  assert.equal(app.editor.value, "你好");

  // 服务器幂等命中返回 duplicate：客户端清除待确认状态，不再重发
  app.deliver(sock2, { type: "ack", opId: opId, result: "duplicate",
    rev: 1, text: "你好", conflicts: [] });
  assert.equal(app.commits(sock2).length, 1);
  assert.equal(app.editor.value, "你好");

  // 之后再次断连重连，已没有未确认编辑，不应出现第三次重发
  sock2.close();
  app.runTimers();
  const sock3 = app.sockets[2];
  app.serverHello(sock3, 1, "你好");
  assert.equal(app.commits(sock3).length, 0);
  assert.equal(app.editor.value, "你好");
});

test("inflight 期间继续离线输入，重连后按原顺序接力提交", () => {
  const app = createApp();
  const sock1 = app.sockets[0];
  app.serverHello(sock1, 0, "");

  app.type("A");
  const op1 = app.commits(sock1)[0].opId;
  app.type("AB"); // inflight 未确认，这次编辑进入队列
  assert.equal(app.commits(sock1).length, 1);

  sock1.close();
  app.runTimers();
  const sock2 = app.sockets[1];
  app.serverHello(sock2, 0, "");

  // 先重发 inflight 的 op1
  let sent2 = app.commits(sock2);
  assert.equal(sent2.length, 1);
  assert.equal(sent2[0].opId, op1);

  // op1 确认后，op2 接力提交（基线重定到最新 rev）
  app.deliver(sock2, { type: "ack", opId: op1, result: "ok",
    rev: 1, text: "A", conflicts: [] });
  sent2 = app.commits(sock2);
  assert.equal(sent2.length, 2);
  assert.notEqual(sent2[1].opId, op1);
  assert.deepEqual(sent2[1].ops, [{ t: "ins", gap: 1, text: "B" }]);
  assert.equal(sent2[1].baseRev, 1);

  app.deliver(sock2, { type: "ack", opId: sent2[1].opId, result: "ok",
    rev: 2, text: "AB", conflicts: [] });
  assert.equal(app.editor.value, "AB");
});
