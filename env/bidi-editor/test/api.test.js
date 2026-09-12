/* node --test test/api.test.js
 * HTTP 集成测试：启动真实 server.js（临时数据文件 + 随机端口），
 * 覆盖 CRUD、校验拒绝、名称重复、乐观锁 409、坏请求不影响后续编辑。
 */
"use strict";

const test = require("node:test");
const { describe, before, after, it } = test;
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const PORT = 8130 + Math.floor(Math.random() * 200);
const BASE = "http://127.0.0.1:" + PORT;
const DATA = path.join(os.tmpdir(), "snap-test-" + Date.now() + "-" + process.pid + ".json");

let server;

// 全部用例共享同一服务器且存在前后状态依赖，放进同一个 describe 顺序执行
describe("快照 API（顺序用例）", function () {
before(async function () {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, { SNAPSHOTS_FILE: DATA }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  // 等待端口可连
  await new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/snapshots", function (res) {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", function () {
        if (Date.now() > deadline) reject(new Error("server failed to start"));
        else setTimeout(ping, 100);
      });
    })();
  });
});

after(async function () {
  server.kill();
  try { fs.unlinkSync(DATA); } catch (e) {}
  try { fs.unlinkSync(DATA + ".tmp"); } catch (e) {}
});

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve) {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const baseHeaders = { "Accept": "application/json" };
    if (payload) Object.assign(baseHeaders,
      { "Content-Type": "application/json", "Content-Length": payload.length });
    // If-Match 只用于变更类请求；GET 不带
    if (method !== "GET" && headers) Object.assign(baseHeaders, headers);
    const req = http.request(BASE + urlPath, {
      method: method,
      headers: baseHeaders
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode, data: data,
                  rev: res.headers["x-snapshot-rev"], etag: res.headers.etag });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function snapPayload(name, texts) {
  return {
    name: name,
    paragraphs: texts.map(function (t, i) {
      return { dir: i === 0 ? "rtl" : "ltr", text: t,
               editedAt: "2026-09-12T0" + i + ":00:00.000Z" };
    })
  };
}

/* ---------- 正常 CRUD ---------- */

it("空列表启动", async function () {
  const r = await request("GET", "/api/snapshots");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.snapshots, []);
  assert.equal(r.rev, "0");
});

it("创建快照：201 且 rev 递增、头部回传版本", async function () {
  const r = await request("POST", "/api/snapshots", snapPayload("草稿一", ["مرحبا", "中文段落"]));
  assert.equal(r.status, 201);
  assert.ok(r.data.id);
  assert.equal(r.data.paragraphs[0].dir, "rtl");
  assert.equal(r.rev, "1");
});

it("列表与详情可读，字符/段落计数正确", async function () {
  const list = await request("GET", "/api/snapshots");
  assert.equal(list.data.snapshots.length, 1);
  assert.equal(list.data.snapshots[0].paragraphCount, 2);
  assert.equal(list.data.snapshots[0].charCount, 9); // مرحبا=5 + 中文段落=4
  const one = await request("GET", "/api/snapshots/" + list.data.snapshots[0].id);
  assert.equal(one.status, 200);
  assert.equal(one.data.paragraphs[0].text, "مرحبا");
});

/* ---------- 校验拒绝 ---------- */

it("名称为空 / 纯空白被拒绝（400），且不产生任何快照", async function () {
  const before = await request("GET", "/api/snapshots");
  for (const name of ["", "   "]) {
    const r = await request("POST", "/api/snapshots", snapPayload(name, ["x"]));
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "empty_name");
  }
  const after = await request("GET", "/api/snapshots");
  assert.equal(after.data.snapshots.length, before.data.snapshots.length);
  assert.equal(after.rev, before.rev, "被拒绝的请求不得推进版本号");
});

it("名称重复被明确拒绝（409 duplicate_name）", async function () {
  const r = await request("POST", "/api/snapshots", snapPayload("草稿一", ["别的内容"]));
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "duplicate_name");
  assert.ok(r.data.message.indexOf("同名") !== -1);
});

it("非 JSON / 结构错误 / 超大文本被拒绝", async function () {
  const r1 = await new Promise(function (resolve) {
    // 原生请求发送非法 JSON
    const req = http.request(BASE + "/api/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, function (res) {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.end("{ not json");
  });
  assert.equal(r1.status, 400);
  assert.equal(r1.data.error, "invalid_json");

  const r2 = await request("POST", "/api/snapshots", { name: "无段落" });
  assert.equal(r2.status, 400);
  assert.equal(r2.data.error, "invalid_paragraphs");

  const big = snapPayload("超大", ["x".repeat(50001)]);
  const r3 = await request("POST", "/api/snapshots", big);
  assert.equal(r3.status, 413);
});

it("错误请求之后合法编辑与保存仍然可用（不拖垮服务）", async function () {
  const r = await request("POST", "/api/snapshots", snapPayload("草稿二", ["نص جديد", "继续编辑"]));
  assert.equal(r.status, 201);
});

/* ---------- 乐观并发 ---------- */

it("覆盖保存必须带 If-Match，否则 428", async function () {
  const list = await request("GET", "/api/snapshots");
  const id = list.data.snapshots[0].id;
  const r = await request("PUT", "/api/snapshots/" + id, snapPayload("草稿一改", ["x"]));
  assert.equal(r.status, 428);
});

it("持最新版本覆盖保存成功（200），rev 递增", async function () {
  let list = await request("GET", "/api/snapshots");
  const id = list.data.snapshots.find(s => s.name === "草稿一").id;
  const rev = list.rev;
  const r = await request("PUT", "/api/snapshots/" + id,
    snapPayload("草稿一改", ["更新后的内容"]), { "If-Match": rev });
  assert.equal(r.status, 200);
  assert.equal(r.rev, String(Number(rev) + 1));
  const detail = await request("GET", "/api/snapshots/" + id);
  assert.equal(detail.data.paragraphs[0].text, "更新后的内容");
  assert.equal(detail.data.name, "草稿一改");
});

it("旧页面持过期版本保存：409 version_conflict，新内容不被覆盖", async function () {
  const list = await request("GET", "/api/snapshots");
  const target = list.data.snapshots.find(s => s.name === "草稿一改");
  const freshRev = list.rev;

  // 页面 A 拿到 freshRev；页面 B（也是 freshRev）先成功改了一次
  const b = await request("PUT", "/api/snapshots/" + target.id,
    snapPayload("B 的更新", ["页面B内容"]), { "If-Match": freshRev });
  assert.equal(b.status, 200);

  // 页面 A 仍用旧 rev 保存 —— 必须被拒绝
  const a = await request("PUT", "/api/snapshots/" + target.id,
    snapPayload("A 的覆盖", ["页面A内容"]), { "If-Match": freshRev });
  assert.equal(a.status, 409);
  assert.equal(a.data.error, "version_conflict");
  assert.equal(a.data.currentRev, Number(freshRev) + 1);

  // 服务端保留的是 B 的较新内容
  const detail = await request("GET", "/api/snapshots/" + target.id);
  assert.equal(detail.data.paragraphs[0].text, "页面B内容");
  assert.equal(detail.data.name, "B 的更新");
});

it("旧页面持过期版本删除：409，快照仍在", async function () {
  const list = await request("GET", "/api/snapshots");
  const target = list.data.snapshots.find(s => s.name === "B 的更新");
  const staleRev = String(Number(list.rev) - 1);
  const r = await request("DELETE", "/api/snapshots/" + target.id,
    null, { "If-Match": staleRev });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "version_conflict");
  const detail = await request("GET", "/api/snapshots/" + target.id);
  assert.equal(detail.status, 200);
});

it("非法或超前的版本号同样 409（不能用乱码/未来版本绕过锁）", async function () {
  const list = await request("GET", "/api/snapshots");
  const target = list.data.snapshots.find(s => s.name === "B 的更新");
  for (const bad of ["abc", String(Number(list.rev) + 100)]) {
    const r = await request("DELETE", "/api/snapshots/" + target.id,
      null, { "If-Match": bad });
    assert.equal(r.status, 409, "If-Match: " + bad);
  }
});

it("覆盖保存改成已存在的名称：409 duplicate_name", async function () {
  const list = await request("GET", "/api/snapshots");
  const first = list.data.snapshots.find(s => s.name === "草稿二");
  const r = await request("PUT", "/api/snapshots/" + first.id,
    snapPayload("B 的更新", ["想蹭名字"]), { "If-Match": list.rev });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "duplicate_name");
  // 被拒绝后内容未变
  const detail = await request("GET", "/api/snapshots/" + first.id);
  assert.equal(detail.data.paragraphs[0].text, "نص جديد");
});

it("持最新版本删除成功", async function () {
  const list = await request("GET", "/api/snapshots");
  const victim = list.data.snapshots.find(s => s.name === "草稿二");
  const r = await request("DELETE", "/api/snapshots/" + victim.id,
    null, { "If-Match": list.rev });
  assert.equal(r.status, 200);
  const detail = await request("GET", "/api/snapshots/" + victim.id);
  assert.equal(detail.status, 404);
});

it("不存在的快照：GET/PUT/DELETE 返回 404", async function () {
  const list = await request("GET", "/api/snapshots");
  assert.equal((await request("GET", "/api/snapshots/nope")).status, 404);
  const put = await request("PUT", "/api/snapshots/nope",
    snapPayload("x", ["y"]), { "If-Match": list.rev });
  assert.equal(put.status, 404);
  const del = await request("DELETE", "/api/snapshots/nope",
    null, { "If-Match": list.rev });
  assert.equal(del.status, 404);
});

/* ---------- 持久化 ---------- */

it("快照写入磁盘文件（刷新/重启后仍在）", async function () {
  const raw = JSON.parse(fs.readFileSync(DATA, "utf8"));
  assert.ok(Number.isInteger(raw.rev) && raw.rev > 0);
  assert.ok(raw.snapshots.some(s => s.name === "B 的更新"));
});

it("重启服务器后快照与版本号仍在", async function () {
  server.kill();
  await new Promise(r => setTimeout(r, 300));
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, { SNAPSHOTS_FILE: DATA }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/snapshots", function (res) {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", function () {
        if (Date.now() > deadline) reject(new Error("restart timeout"));
        else setTimeout(ping, 100);
      });
    })();
  });
  const r = await request("GET", "/api/snapshots");
  assert.equal(r.status, 200);
  assert.ok(r.data.snapshots.some(s => s.name === "B 的更新"));
  assert.ok(Number(r.rev) > 0, "版本号从磁盘恢复");
});
}); // end describe

