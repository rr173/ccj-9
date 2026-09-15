"use strict";
/*
 * 端到端集成测试：
 *   启动真实 HTTP+WebSocket 服务（临时数据文件、随机端口），用内置的零依赖
 *   WS 客户端模拟两个及以上浏览器标签，覆盖：
 *     - 两个页面（连接）创建/加入同一房间
 *     - 编辑实时同步（含 RTL 阿拉伯文 + emoji ZWJ）
 *     - 成员存在（presence）与远程光标
 *     - 同位置并发写入 -> 冲突区 -> HTTP 裁决 -> 同步
 *     - 离线期间继续输入 + 重连追赶（快照收敛）
 *     - 重复提交同一 opId（幂等，不产生重复内容）
 *     - 进程重启后房间/文本/冲突仍在
 *   纯 node:test，直接 `node test/integration.test.js` 也能跑（npm test 同效）。
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const PORT = 8300 + Math.floor(Math.random() * 400);
const DATA_FILE = path.join(os.tmpdir(),
  "collab-integ-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".json");
process.env.COLLAB_ROOMS_FILE = DATA_FILE;
process.env.PORT = String(PORT);

const { createClient } = require("../ws-protocol");
const BASE = "http://127.0.0.1:" + PORT;
const WS = "ws://127.0.0.1:" + PORT;

let server; // eslint-disable-line no-unused-vars

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, {
      method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (e) {}
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    req.on("error", reject);
    if (data) req.end(data); else req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 一个“页面”：WS 连接 + 消息收集（始终按 rev 跟踪最新文本/冲突） */
class Page {
  constructor(memberId, name, color) {
    this.member = { memberId, name, color };
    this.hello = null;
    this.acks = [];
    this.ops = [];
    this.cursors = [];
    this.presence = [];
    this.ws = null;
    this.latest = null; // {rev, text, conflicts}
  }
  async open(roomId) {
    this.ws = await createClient(WS + "/ws?room=" + encodeURIComponent(roomId));
    this.ws.on("message", raw => {
      const m = JSON.parse(raw);
      if (m.type === "hello") {
        this.hello = m;
        this._absorb(m);
      }
      if (m.type === "ack") { this.acks.push(m); this._absorb(m); }
      if (m.type === "op") { this.ops.push(m); this._absorb(m); }
      if (m.type === "cursor") this.cursors.push(m);
      if (m.type === "presence") this.presence.push(m);
    });
    this.send({ type: "hello", room: roomId, member: this.member });
    await this.waitFor(() => this.hello);
    return this;
  }
  _absorb(m) {
    if (typeof m.rev !== "number" || typeof m.text !== "string") return;
    // resync/error 的 ack 携带权威快照，应无条件采纳；其余按 rev 取最新。
    if (m.type === "ack" && m.result && m.result !== "ok" && m.result !== "duplicate") {
      this.latest = { rev: m.rev, text: m.text, conflicts: m.conflicts || [] };
      return;
    }
    if (!this.latest || m.rev >= this.latest.rev) {
      this.latest = { rev: m.rev, text: m.text, conflicts: m.conflicts || [] };
    }
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  commit(opId, baseRev, ops) {
    this.send({ type: "commit", opId, baseRev, ops });
  }
  cursor(anchor, selStart, selEnd) {
    this.send({ type: "cursor", anchor, selStart, selEnd });
  }
  waitFor(fn, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        let v;
        try { v = fn(); } catch (e) { v = undefined; }
        if (v) { clearInterval(timer); resolve(v); }
        else if (Date.now() - t0 > timeout) { clearInterval(timer); reject(new Error("waitFor timeout")); }
      }, 15);
    });
  }
  get text() { return this.latest ? this.latest.text : (this.hello && this.hello.text) || ""; }
  get rev() { return this.latest ? this.latest.rev : 0; }
  conflicts() {
    return this.latest ? this.latest.conflicts : (this.hello && this.hello.conflicts) || [];
  }
  close() { try { this.ws.close(); } catch (e) {} }
  /* 断线后重连：保留消息历史，只新建底层连接并重新 hello */
  async reconnect(roomId) {
    const newHello = new Promise(resolve => {
      this._onReconnectHello = resolve;
    });
    this.ws = await createClient(WS + "/ws?room=" + encodeURIComponent(roomId));
    this.ws.on("message", raw => {
      const m = JSON.parse(raw);
      if (m.type === "hello") { this.hello = m; this._absorb(m); this._onReconnectHello && this._onReconnectHello(m); }
      if (m.type === "ack") { this.acks.push(m); this._absorb(m); }
      if (m.type === "op") { this.ops.push(m); this._absorb(m); }
      if (m.type === "cursor") this.cursors.push(m);
      if (m.type === "presence") this.presence.push(m);
    });
    this.send({ type: "hello", room: roomId, member: this.member });
    await newHello;
    return this;
  }
}

test.before(async () => {
  server = require("../server");
  // 等待端口可连
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const req = http.get(BASE + "/healthz", res => { res.resume(); clearInterval(timer); resolve(); });
      req.on("error", () => { if (Date.now() - t0 > 3000) { clearInterval(timer); reject(new Error("server not up")); } });
    }, 50);
  });
});

test.after(() => {
  try { server.manager.flushSync(); } catch (e) {}
  try { server.server.close(); } catch (e) {}
});

test("两个页面创建并加入同一房间，编辑实时同步（含阿拉伯文与 emoji ZWJ）", async () => {
  const created = await api("POST", "/api/rooms", { name: "同步房" });
  assert.equal(created.status, 201);
  const roomId = created.json.room.id;

  const a = await new Page("mA", "甲", "#e6194b").open(roomId);
  const b = await new Page("mB", "乙", "#3cb44b").open(roomId);
  await sleep(100);

  // presence：双方互相可见
  assert.ok(a.presence.some(p => p.members.some(m => m.memberId === "mB")));
  assert.ok(b.presence.some(p => p.members.some(m => m.memberId === "mA")));

  // A 先写一版（中文 + 阿拉伯文 + emoji 组合）
  a.commit("op-sync-1:mA", 0, [{ t: "ins", gap: 0, text: "مرحبا 👨‍👩‍👧 世界" }]);
  await a.waitFor(() => a.acks.some(x => x.opId === "op-sync-1:mA" && x.result === "ok"));
  await b.waitFor(() => b.ops.some(m => m.text === "مرحبا 👨‍👩‍👧 世界"));
  assert.equal(b.text, "مرحبا 👨‍👩‍👧 世界");

  // B 基于最新 rev 在末尾追加，A 收到广播（该句共 10 个字素簇，gap=10 为文末）
  const baseRev = b.rev;
  b.commit("op-sync-2:mB", baseRev, [{ t: "ins", gap: 10, text: "!" }]);
  await a.waitFor(() => a.ops.some(m => m.text === "مرحبا 👨‍👩‍👧 世界!"));
  assert.equal(a.text, "مرحبا 👨‍👩‍👧 世界!");

  // 远程光标：B 移动光标，A 收到
  b.cursor(3, 2, 4);
  const cur = await a.waitFor(() => a.cursors.find(c => c.memberId === "mB" && c.anchor === 3));
  assert.equal(cur.name, "乙");
  assert.equal(cur.selStart, 2);
  assert.equal(cur.selEnd, 4);

  a.close(); b.close();
});

test("同位置并发写入产生冲突，HTTP 裁决后两页面一致", async () => {
  const created = await api("POST", "/api/rooms", { name: "冲突房" });
  const roomId = created.json.room.id;
  const a = await new Page("cA", "子", "#4363d8").open(roomId);
  const b = await new Page("cB", "丑", "#f58231").open(roomId);

  a.commit("op-c0:cA", 0, [{ t: "ins", gap: 0, text: "abc" }]);
  await a.waitFor(() => a.acks.some(x => x.opId === "op-c0:cA"));
  await b.waitFor(() => b.ops.length);

  // 双方都基于 rev1 在同一 gap(3) 插入不同文本
  a.commit("op-c1:cA", 1, [{ t: "ins", gap: 3, text: "AAA" }]);
  b.commit("op-c2:cB", 1, [{ t: "ins", gap: 3, text: "BBB" }]);

  await a.waitFor(() => a.conflicts().length >= 1);
  await b.waitFor(() => b.conflicts().length >= 1);
  let cf = a.conflicts()[0];
  assert.ok(["AAA", "BBB"].includes(cf.aText));
  assert.ok(["AAA", "BBB"].includes(cf.bText));
  assert.notEqual(cf.aText, cf.bText);
  const finalTextBeforeResolve = a.text;
  assert.ok(finalTextBeforeResolve.includes("AAA") && finalTextBeforeResolve.includes("BBB"));

  // 通过 HTTP 裁决保留含 "AAA" 的一侧
  const chooseA = cf.aText === "AAA" ? "a" : "b";
  const res = await api("POST", `/api/rooms/${roomId}/resolve`, {
    conflictId: cf.id, choice: chooseA, member: a.member
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.text.includes("AAA"));
  assert.ok(!res.json.text.includes("BBB"));

  // 两个页面都收到裁决广播
  await a.waitFor(() => a.ops.some(m => m.note === "conflict_resolved" && m.text.includes("AAA") && !m.text.includes("BBB")));
  await b.waitFor(() => b.ops.some(m => m.note === "conflict_resolved"));
  assert.equal(a.text, b.text);

  a.close(); b.close();
});

test("重复提交同一 opId 幂等，不产生重复内容", async () => {
  const created = await api("POST", "/api/rooms", { name: "幂等房" });
  const roomId = created.json.room.id;
  const a = await new Page("iA", "寅", "#911eb4").open(roomId);

  a.commit("op-dup:iA", 0, [{ t: "ins", gap: 0, text: "once" }]);
  await a.waitFor(() => a.acks.some(x => x.opId === "op-dup:iA" && x.result === "ok"));
  const revAfter = a.rev;

  // 同样的 opId + 同样的载荷再发两次
  a.commit("op-dup:iA", 0, [{ t: "ins", gap: 0, text: "once" }]);
  a.commit("op-dup:iA", 0, [{ t: "ins", gap: 0, text: "once" }]);
  await sleep(200);

  const dupAcks = a.acks.filter(x => x.opId === "op-dup:iA" && x.result === "duplicate");
  assert.ok(dupAcks.length >= 2, "应有 duplicate 应答");
  assert.equal(a.text, "once");
  assert.equal(a.rev, revAfter, "版本号不应增长");

  a.close();
});

test("离线期间继续编辑，重连后以服务器文本收敛且不丢自己的新输入", async () => {
  const created = await api("POST", "/api/rooms", { name: "离线房" });
  const roomId = created.json.room.id;
  const a = await new Page("oA", "卯", "#42d4f4").open(roomId);
  const b = await new Page("oB", "辰", "#469990").open(roomId);

  a.commit("op-o0:oA", 0, [{ t: "ins", gap: 0, text: "BASE" }]);
  await a.waitFor(() => a.acks.some(x => x.opId === "op-o0:oA"));
  await b.waitFor(() => b.ops.length);

  // 模拟 A 离线：直接断开底层连接；B 在此期间改两次（A 落后 2 个 rev）
  a.ws.close();
  await sleep(100);
  b.commit("op-o1:oB", b.rev, [{ t: "ins", gap: 4, text: "-B1" }]);
  await b.waitFor(() => b.acks.some(x => x.opId === "op-o1:oB"));
  // BASE-B1 共 7 簇
  b.commit("op-o2:oB", b.rev, [{ t: "ins", gap: 7, text: "-B2" }]);
  await b.waitFor(() => b.acks.some(x => x.opId === "op-o2:oB"));

  // A 重连：hello 快照即服务器最新文本（包含 B 的两次编辑）
  await a.reconnect(roomId);
  assert.equal(a.text, "BASE-B1-B2");
  assert.equal(a.hello.rev, b.rev);

  // 重连后 A 基于最新 rev 的新编辑正常进入（"BASE-B1-B2" 为 10 簇，gap=10 文末）
  a.commit("op-o3:oA", a.rev, [{ t: "ins", gap: 10, text: "-A!" }]);
  await b.waitFor(() => b.ops.some(m => m.text === "BASE-B1-B2-A!"));
  assert.equal(a.text, b.text);

  a.close(); b.close();
});

test("滞后基线的并发编辑经多跳折叠收敛", async () => {
  const created = await api("POST", "/api/rooms", { name: "折叠房" });
  const roomId = created.json.room.id;
  const a = await new Page("fA", "巳", "#9A6324").open(roomId);
  const others = [];
  for (let i = 0; i < 3; i++) {
    others.push(await new Page("f" + i, "午" + i, "#800000").open(roomId));
  }
  a.commit("op-f0:fA", 0, [{ t: "ins", gap: 0, text: "0123456789" }]);
  await a.waitFor(() => a.acks.some(x => x.opId === "op-f0:fA"));
  await sleep(100);

  // 三个成员依次在 rev1 的不同位置编辑并提交
  others[0].commit("op-f1:f0", 1, [{ t: "ins", gap: 0, text: "HEAD-" }]);
  await sleep(60);
  others[1].commit("op-f2:f1", 1, [{ t: "ins", gap: 10, text: "-TAIL" }]);
  await sleep(60);
  others[2].commit("op-f3:f2", 1, [{ t: "del", start: 4, len: 2 }]);
  await sleep(60);

  // 第四个滞后客户端也基于 rev1 改头，折叠后应收敛到服务器文本
  const late = await new Page("fL", "未", "#e6194b").open(roomId);
  await sleep(100);
  late.commit("op-f4:fL", 1, [{ t: "ins", gap: 0, text: "~" }]);
  await late.waitFor(() => late.acks.some(x => x.opId === "op-f4:fL" && x.result === "ok"));
  await sleep(150);
  const server = (await api("GET", "/api/rooms/" + roomId)).json;
  // 期望：HEAD- + ~ + 0123 + 6789 + -TAIL（顺序由 opId 确定，关键是各片段各一份）
  for (const frag of ["HEAD-", "~", "0123", "6789", "-TAIL"]) {
    assert.ok(server.text.includes(frag), "文本应含 " + frag + "，实际：" + server.text);
  }
  for (const frag of ["HEAD-HEAD-", "-TAIL-TAIL", "45"]) {
    assert.ok(!server.text.includes(frag), "不应出现重复/复活片段 " + frag + "，实际：" + server.text);
  }
  // 所有在线页面收敛到同一文本
  for (const p of others) {
    await sleep(50);
    assert.equal(p.text, server.text);
  }
  a.close(); late.close();
  others.forEach(p => p.close());
});

test("服务重启后房间、文本、待裁决冲突仍在（重启恢复）", async () => {
  const created = await api("POST", "/api/rooms", { name: "重启房" });
  const roomId = created.json.room.id;
  const a = await new Page("rA", "申", "#3cb44b").open(roomId);
  const b = await new Page("rB", "酉", "#4363d8").open(roomId);
  a.commit("op-r0:rA", 0, [{ t: "ins", gap: 0, text: "abc" }]);
  await a.waitFor(() => a.acks.some(x => x.opId === "op-r0:rA"));
  await b.waitFor(() => b.ops.length);
  a.commit("op-r1:rA", 1, [{ t: "ins", gap: 3, text: "X" }]);
  b.commit("op-r2:rB", 1, [{ t: "ins", gap: 3, text: "Y" }]);
  await a.waitFor(() => a.conflicts().length >= 1);
  const cf = a.conflicts()[0];
  a.close(); b.close();

  // 重启服务进程内的数据层：新 RoomManager 读同一文件
  server.manager.flushSync();
  delete require.cache[require.resolve("../rooms")];
  const { RoomManager } = require("../rooms");
  const restored = new RoomManager(DATA_FILE);
  const room = restored.get(roomId);
  assert.ok(room, "房间应仍存在");
  assert.ok(["abcXY", "abcYX"].includes(room.atoms.map(x => x.ch).join("")), "文本含双方内容");
  assert.ok(room.conflicts.some(c => c.status === "open" && c.id === cf.id), "待裁决冲突应保留");
  assert.ok(room.rev >= 3, "版本号应保留");
  // 重启后仍可基于旧 rev 提交（检查点重建祖先）
  const member = { memberId: "rC", name: "戌", color: "#000000" };
  restored.touchMember(room, member);
  const r = restored.commit(room, { baseRev: 1, opId: "op-r3:rC", ops: [{ t: "ins", gap: 0, text: "Z" }] }, member);
  assert.equal(r.result, "ok");
  assert.ok(r.text.includes("Z"));
});

test("房间校验：空名称/非法房间返回明确错误", async () => {
  const r1 = await api("POST", "/api/rooms", { name: "   " });
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error, "empty_name");
  const r2 = await api("GET", "/api/rooms/nonexistent");
  assert.equal(r2.status, 404);
  assert.equal(r2.json.error, "room_not_found");
  const r3 = await api("GET", "/api/rooms/" + "x".repeat(300));
  assert.equal(r3.status, 404);
});

// 以独立进程方式运行时（node test/integration.test.js），node:test 自动执行。
