/* node --test test/annotations-api.test.js
 * 协作批注 HTTP 集成测试：真实启动 server.js（临时数据文件 + 随机端口），
 * 覆盖 CRUD、回复、解决/重开、校验拒绝、乐观锁 409（旧页面不能覆盖新批注）、
 * 快照与批注状态关联、从快照恢复批注、重启持久化。
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

const PORT = 8230 + Math.floor(Math.random() * 90);
const BASE = "http://127.0.0.1:" + PORT;
const SNAP_DATA = path.join(os.tmpdir(), "ann-snap-" + Date.now() + "-" + process.pid + ".json");
const ANN_DATA = path.join(os.tmpdir(), "ann-data-" + Date.now() + "-" + process.pid + ".json");

let server;

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: SNAP_DATA,
      ANNOTATIONS_FILE: ANN_DATA
    }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  return waitUp();
}

function waitUp() {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/annotations", function (res) {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", function () {
        if (Date.now() > deadline) reject(new Error("server failed to start"));
        else setTimeout(ping, 100);
      });
    })();
  });
}

describe("批注 API（顺序用例）", function () {
before(async function () { await startServer(); });

after(async function () {
  server.kill();
  for (const f of [SNAP_DATA, SNAP_DATA + ".tmp", ANN_DATA, ANN_DATA + ".tmp"]) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
});

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve) {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const baseHeaders = { "Accept": "application/json" };
    if (payload) Object.assign(baseHeaders,
      { "Content-Type": "application/json", "Content-Length": payload.length });
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
                  rev: res.headers["x-annotation-rev"],
                  snapRev: res.headers["x-snapshot-rev"] });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function annPayload(overrides) {
  return Object.assign({
    author: "审阅者甲",
    body: "这段阿文用词建议调整",
    paraIndex: 0,
    start: 4,
    end: 11,
    quote: "العربية",
    paraDir: "rtl"
  }, overrides || {});
}

async function currentRev() {
  const r = await request("GET", "/api/annotations");
  return r.rev;
}

/* ---------- 基础 ---------- */

it("空集合启动：rev=0，响应带批注版本头", async function () {
  const r = await request("GET", "/api/annotations");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.annotations, []);
  assert.equal(r.rev, "0");
});

it("新建批注必须带 If-Match：缺省 428，过期 409", async function () {
  const noLock = await request("POST", "/api/annotations", annPayload());
  assert.equal(noLock.status, 428);
  const stale = await request("POST", "/api/annotations", annPayload(),
    { "If-Match": "99" });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, "version_conflict");
  // 被拒绝的请求不推进版本、不产生数据
  const r = await request("GET", "/api/annotations");
  assert.equal(r.rev, "0");
  assert.equal(r.data.annotations.length, 0);
});

it("持正确版本新建成功：201，rev 递增，记录含原文/方向/位置/时间", async function () {
  const r = await request("POST", "/api/annotations", annPayload(),
    { "If-Match": "0" });
  assert.equal(r.status, 201);
  assert.equal(r.rev, "1");
  const a = r.data.annotation;
  assert.ok(a.id);
  assert.equal(a.quote, "العربية");
  assert.equal(a.paraDir, "rtl");
  assert.equal(a.start, 4);
  assert.equal(a.end, 11);
  assert.equal(a.status, "open");
  assert.ok(!isNaN(Date.parse(a.createdAt)));
  assert.deepEqual(a.replies, []);
});

/* ---------- 校验拒绝（且保留后续可用性） ---------- */

it("内容为空 / 范围为空 / 引文与范围不一致 / 超长：明确拒绝", async function () {
  const rev = await currentRev();
  const cases = [
    [annPayload({ body: "   " }), 400, "empty_body"],
    [annPayload({ start: 5, end: 5, quote: "" }), 400, "empty_range"],
    [annPayload({ start: 0, end: 9, quote: "短" }), 400, "range_quote_mismatch"],
    [annPayload({ body: "长".repeat(1001) }), 413, "body_too_large"],
    [annPayload({ paraIndex: -2 }), 400, "invalid_para_index"]
  ];
  for (const [body, status, code] of cases) {
    const r = await request("POST", "/api/annotations", body, { "If-Match": rev });
    assert.equal(r.status, status, code);
    assert.equal(r.data.error, code, code);
  }
  // 全部被拒：版本不变、集合不变
  const after = await request("GET", "/api/annotations");
  assert.equal(after.rev, rev);
  assert.equal(after.data.annotations.length, 1);
});

it("非法 JSON 与错误结构：400，不影响后续操作", async function () {
  const rev = await currentRev();
  const bad = await new Promise(function (resolve) {
    const req = http.request(BASE + "/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "If-Match": rev }
    }, function (res) {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.end("{ oops");
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "invalid_json");

  const ok = await request("POST", "/api/annotations",
    annPayload({ body: "第二条批注", start: 0, end: 2, quote: "中文" }),
    { "If-Match": rev });
  assert.equal(ok.status, 201);
});

/* ---------- 回复 ---------- */

it("追加回复成功；空回复与超长回复被拒绝", async function () {
  let list = await request("GET", "/api/annotations");
  const target = list.data.annotations[0];

  const empty = await request("POST", "/api/annotations/" + target.id + "/replies",
    { body: "" }, { "If-Match": list.rev });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error, "empty_body");

  const tooLong = await request("POST", "/api/annotations/" + target.id + "/replies",
    { body: "好".repeat(1001) }, { "If-Match": list.rev });
  assert.equal(tooLong.status, 413);

  const ok = await request("POST", "/api/annotations/" + target.id + "/replies",
    { author: "作者乙", body: "已按建议修改，请复查" }, { "If-Match": list.rev });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.annotation.replies.length, 1);
  assert.equal(ok.data.annotation.replies[0].author, "作者乙");
  assert.ok(!isNaN(Date.parse(ok.data.annotation.replies[0].createdAt)));
});

it("给不存在的批注回复：404", async function () {
  const rev = await currentRev();
  const r = await request("POST", "/api/annotations/nope/replies",
    { body: "喂" }, { "If-Match": rev });
  assert.equal(r.status, 404);
});

/* ---------- 解决 / 重开 + 乐观并发 ---------- */

it("标记已解决：记录解决人与时间；重新打开：清除解决信息", async function () {
  let list = await request("GET", "/api/annotations");
  const target = list.data.annotations[0];

  const resolved = await request("PUT", "/api/annotations/" + target.id,
    { status: "resolved", resolvedBy: "审阅者甲" }, { "If-Match": list.rev });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.annotation.status, "resolved");
  assert.equal(resolved.data.annotation.resolvedBy, "审阅者甲");
  assert.ok(resolved.data.annotation.resolvedAt);

  list = await request("GET", "/api/annotations");
  const reopened = await request("PUT", "/api/annotations/" + target.id,
    { status: "open" }, { "If-Match": list.rev });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.annotation.status, "open");
  assert.equal(reopened.data.annotation.resolvedAt, null);
  assert.equal(reopened.data.annotation.resolvedBy, null);
});

it("非法状态值：400", async function () {
  const list = await request("GET", "/api/annotations");
  const target = list.data.annotations[0];
  const r = await request("PUT", "/api/annotations/" + target.id,
    { status: "maybe" }, { "If-Match": list.rev });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "invalid_status");
});

it("两个页面同时解决同一批注：后到者 409，先提交的状态不被覆盖", async function () {
  const list = await request("GET", "/api/annotations");
  const target = list.data.annotations[0];
  const pageRev = list.rev; // 页面 A、B 都拿到这个版本

  // 页面 B 先解决
  const b = await request("PUT", "/api/annotations/" + target.id,
    { status: "resolved", resolvedBy: "页面B" }, { "If-Match": pageRev });
  assert.equal(b.status, 200);

  // 页面 A 持旧版本再操作：必须 409
  const a = await request("PUT", "/api/annotations/" + target.id,
    { status: "open" }, { "If-Match": pageRev });
  assert.equal(a.status, 409);
  assert.equal(a.data.error, "version_conflict");
  assert.equal(a.data.currentRev, Number(pageRev) + 1);

  // 服务端保留 B 的结果
  const detail = await request("GET", "/api/annotations");
  const kept = detail.data.annotations.find(x => x.id === target.id);
  assert.equal(kept.status, "resolved");
  assert.equal(kept.resolvedBy, "页面B");
});

it("两个页面同时提交新批注：旧页面不能覆盖新批注", async function () {
  const list = await request("GET", "/api/annotations");
  const pageRev = list.rev;
  const before = list.data.annotations.length;

  const b = await request("POST", "/api/annotations",
    annPayload({ body: "页面B的新批注", start: 0, end: 1, quote: "أ" }),
    { "If-Match": pageRev });
  assert.equal(b.status, 201);

  const a = await request("POST", "/api/annotations",
    annPayload({ body: "页面A的新批注", start: 1, end: 2, quote: "ن" }),
    { "If-Match": pageRev });
  assert.equal(a.status, 409);

  const after = await request("GET", "/api/annotations");
  assert.equal(after.data.annotations.length, before + 1,
    "A 的提交被拒绝，只有 B 的批注入库");
  assert.ok(after.data.annotations.some(x => x.body === "页面B的新批注"));
});

it("删除批注：过期版本 409，最新版本 200", async function () {
  let list = await request("GET", "/api/annotations");
  const victim = list.data.annotations.find(x => x.body === "第二条批注");
  const staleRev = String(Number(list.rev) - 1);

  const stale = await request("DELETE", "/api/annotations/" + victim.id,
    null, { "If-Match": staleRev });
  assert.equal(stale.status, 409);

  list = await request("GET", "/api/annotations");
  const ok = await request("DELETE", "/api/annotations/" + victim.id,
    null, { "If-Match": list.rev });
  assert.equal(ok.status, 200);
  const after = await request("GET", "/api/annotations");
  assert.ok(!after.data.annotations.some(x => x.id === victim.id));
});

/* ---------- 快照关联 ---------- */

it("保存快照时嵌入当时的批注及解决状态", async function () {
  // 当前应有 2 条批注：一条 resolved（页面B）、一条 open（页面B的新批注）
  const snap = await request("POST", "/api/snapshots", {
    name: "带批注的快照",
    paragraphs: [{ dir: "rtl", text: "أنا أحب العربية", editedAt: "2026-09-12T00:00:00.000Z" }]
  });
  assert.equal(snap.status, 201);
  assert.ok(Array.isArray(snap.data.annotations));
  assert.equal(snap.data.annotations.length, 2);
  assert.equal(typeof snap.data.annotationRev, "number");
  const statuses = snap.data.annotations.map(a => a.status).sort();
  assert.deepEqual(statuses, ["open", "resolved"]);
  // 回复也随快照保存
  const withReply = snap.data.annotations.find(a => a.replies.length);
  assert.ok(withReply, "快照中应能看到当时的回复");
  assert.equal(withReply.replies[0].body, "已按建议修改，请复查");
});

it("状态变化后新快照与旧快照的批注状态各自独立", async function () {
  const list = await request("GET", "/api/annotations");
  const openOne = list.data.annotations.find(a => a.status === "open");
  const r = await request("PUT", "/api/annotations/" + openOne.id,
    { status: "resolved", resolvedBy: "审阅者丙" }, { "If-Match": list.rev });
  assert.equal(r.status, 200);

  const snap2 = await request("POST", "/api/snapshots", {
    name: "全部解决后的快照",
    paragraphs: [{ dir: "rtl", text: "أنا أحب العربية", editedAt: "2026-09-12T01:00:00.000Z" }]
  });
  assert.equal(snap2.status, 201);
  assert.ok(snap2.data.annotations.every(a => a.status === "resolved"));

  // 旧快照里该批注仍是 open —— 历史状态不被新操作改写
  const snaps = await request("GET", "/api/snapshots");
  const first = snaps.data.snapshots.find(s => s.name === "带批注的快照");
  const firstFull = await request("GET", "/api/snapshots/" + first.id);
  const theOne = firstFull.data.annotations.find(a => a.id === openOne.id);
  assert.equal(theOne.status, "open");
});

it("从快照恢复批注集合：整体替换，乐观锁生效", async function () {
  const snaps = await request("GET", "/api/snapshots");
  const first = snaps.data.snapshots.find(s => s.name === "带批注的快照");
  const firstFull = await request("GET", "/api/snapshots/" + first.id);

  // 过期版本恢复：409
  const stale = await request("PUT", "/api/annotations",
    { annotations: firstFull.data.annotations }, { "If-Match": "0" });
  assert.equal(stale.status, 409);

  // 最新版本恢复：集合被快照内容整体替换
  const rev = await currentRev();
  const ok = await request("PUT", "/api/annotations",
    { annotations: firstFull.data.annotations }, { "If-Match": rev });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.annotations.length, 2);
  const again = await request("GET", "/api/annotations");
  const reopened = again.data.annotations.find(
    a => a.body === "这段阿文用词建议调整");
  assert.equal(reopened.status, "resolved"); // 快照一里它已是 resolved
  assert.ok(again.data.annotations.some(a => a.status === "open"),
    "快照一中仍未解决的批注也按当时状态恢复");
});

it("恢复载荷非法：逐条校验，全部通过才替换", async function () {
  const rev = await currentRev();
  const bad = await request("PUT", "/api/annotations", {
    annotations: [
      annPayload(),
      annPayload({ body: "" }) // 第二条非法
    ]
  }, { "If-Match": rev });
  assert.equal(bad.status, 400);
  const after = await request("GET", "/api/annotations");
  assert.equal(after.rev, rev, "非法恢复不得改变集合与版本");
});

/* ---------- 持久化 ---------- */

it("批注写入磁盘，重启后集合与版本号仍在", async function () {
  const raw = JSON.parse(fs.readFileSync(ANN_DATA, "utf8"));
  assert.ok(Number.isInteger(raw.rev) && raw.rev > 0);
  assert.ok(raw.annotations.length >= 1);

  server.kill();
  await new Promise(r => setTimeout(r, 300));
  await startServer();

  const r = await request("GET", "/api/annotations");
  assert.equal(r.status, 200);
  assert.equal(r.data.annotations.length, raw.annotations.length);
  assert.equal(Number(r.rev), raw.rev);
});

it("快照文件中也存有批注关联数据", async function () {
  const raw = JSON.parse(fs.readFileSync(SNAP_DATA, "utf8"));
  const withAnn = raw.snapshots.find(s => s.name === "带批注的快照");
  assert.ok(withAnn);
  assert.ok(Array.isArray(withAnn.annotations));
  assert.ok(Number.isInteger(withAnn.annotationRev));
});
}); // end describe
