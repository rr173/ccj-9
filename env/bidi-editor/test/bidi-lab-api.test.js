/* node --test test/bidi-lab-api.test.js
 * HTTP 集成测试：实验室样例 CRUD、乐观锁、回归、记录与一次性撤销校验。
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

const PORT = 8260 + Math.floor(Math.random() * 90);
const BASE = "http://127.0.0.1:" + PORT;
const tmp = function (n) {
  return path.join(os.tmpdir(), "lab-" + n + "-" + Date.now() + "-" + process.pid + ".json");
};
const FILES = {
  SNAPSHOTS_FILE: tmp("snap"), ANNOTATIONS_FILE: tmp("ann"),
  REVIEW_BATCHES_FILE: tmp("batch"), REVIEW_DECISIONS_FILE: tmp("dec"),
  REPLAY_SPACES_FILE: tmp("rep"), REPLAY_ARCHIVES_FILE: tmp("arch"),
  REPLAY_RECONCILE_FILE: tmp("rec"), PERMISSIONS_FILE: tmp("perm"),
  BIDI_LAB_FILE: tmp("lab")
};

let server;

describe("双向安全实验室 API（顺序用例）", function () {
before(async function () {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, FILES),
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/bidi-lab/samples", function (res) {
        res.resume(); res.on("end", resolve);
      });
      req.on("error", function () {
        if (Date.now() > deadline) reject(new Error("server failed to start"));
        else setTimeout(ping, 100);
      });
    })();
  });
});

after(function () {
  server.kill();
  Object.keys(FILES).forEach(function (k) {
    try { fs.unlinkSync(FILES[k]); } catch (e) {}
    try { fs.unlinkSync(FILES[k] + ".tmp"); } catch (e) {}
  });
});

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve, reject) {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = { "Accept": "application/json" };
    if (payload) Object.assign(h, { "Content-Type": "application/json" });
    if (method !== "GET" && headers) Object.assign(h, headers);
    const req = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        resolve({ status: res.statusCode, data: data,
          rev: res.headers["x-bidi-lab-rev"] });
      });
    });
    req.on("error", reject);
    if (payload) req.end(payload); else req.end();
  });
}

let rev = 0;
let sampleId = null;

it("空样例列表，初始 rev=0", async function () {
  const r = await request("GET", "/api/bidi-lab/samples");
  assert.equal(r.status, 200);
  assert.equal(Number(r.rev), 0);
  assert.deepEqual(r.data.samples, []);
});

it("缺 If-Match 必须 428", async function () {
  const r = await request("POST", "/api/bidi-lab/samples",
    { name: "x", paragraphs: [{ text: "a" }] });
  assert.equal(r.status, 428);
  assert.equal(r.data.error, "precondition_required");
});

it("空名/坏段落被拒绝且不推进 rev", async function () {
  const r1 = await request("POST", "/api/bidi-lab/samples",
    { name: "  ", paragraphs: [{ text: "a" }] }, { "If-Match": String(rev) });
  assert.equal(r1.status, 400);
  const r2 = await request("POST", "/api/bidi-lab/samples",
    { name: "x", paragraphs: [] }, { "If-Match": String(rev) });
  assert.equal(r2.status, 400);
});

it("创建样例成功并计算 anchorFp", async function () {
  const r = await request("POST", "/api/bidi-lab/samples", {
    name: "覆盖控制样例",
    paragraphs: [{ dir: "auto", text: "a\u202Eb" }],
    expected: [{ type: "override_control", para: 1, start: 1 }],
    anchors: [{ para: 1, label: "RLO", start: 1, end: 2 }]
  }, { "If-Match": String(rev) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  rev = Number(r.rev);
  assert.equal(rev, 1);
  sampleId = r.data.sample.id;
  assert.equal(r.data.sample.expected[0].end, 2);
  assert.ok(typeof r.data.sample.anchorFp === "string");
});

it("重名 409；乐观锁冲突 409", async function () {
  const dup = await request("POST", "/api/bidi-lab/samples",
    { name: "覆盖控制样例", paragraphs: [{ text: "x" }] },
    { "If-Match": String(rev) });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, "duplicate_name");
  const stale = await request("POST", "/api/bidi-lab/samples",
    { name: "另一个", paragraphs: [{ text: "x" }] },
    { "If-Match": "0" });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, "version_conflict");
});

it("GET /:id 与 404", async function () {
  const ok = await request("GET", "/api/bidi-lab/samples/" + sampleId);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.sample.name, "覆盖控制样例");
  const missing = await request("GET", "/api/bidi-lab/samples/nope");
  assert.equal(missing.status, 404);
});

it("PUT 更新样例", async function () {
  const r = await request("PUT", "/api/bidi-lab/samples/" + sampleId, {
    name: "覆盖控制样例（改）",
    paragraphs: [{ dir: "rtl", text: "a\u202Ebc" }],
    expected: [], anchors: []
  }, { "If-Match": String(rev) });
  assert.equal(r.status, 200);
  rev = Number(r.rev);
  assert.equal(r.data.sample.paragraphs[0].dir, "rtl");
});

it("批量回归：报告新增/消失，且不改样例", async function () {
  const r = await request("POST", "/api/bidi-lab/samples/recheck", {});
  assert.equal(r.status, 200);
  assert.equal(r.data.results.length, 1);
  const rr = r.data.results[0];
  // expected 已清空，当前问题全部为新增
  assert.ok(rr.added.length >= 1);
  assert.equal(typeof r.data.summary.total, "number");
  // 回归是只读：rev 不变
  assert.equal(Number(r.rev), rev);
});

it("保存诊断报告记录", async function () {
  const r = await request("POST", "/api/bidi-lab/records", {
    kind: "report", note: "测试报告", paraCount: 1, issueCount: 2,
    contentFp: "abc", renderFp: "def",
    report: { issues: [{ type: "override_control", para: 1, start: 1 }] }
  }, { "If-Match": String(rev) });
  assert.equal(r.status, 201);
  rev = Number(r.rev);
  assert.equal(r.data.record.kind, "report");
  assert.ok(r.data.record.report.issues.length === 1);
});

it("无效记录类别被拒绝", async function () {
  const r = await request("POST", "/api/bidi-lab/records",
    { kind: "bogus" }, { "If-Match": String(rev) });
  assert.equal(r.status, 400);
});

it("撤销必须对应修复记录；重复撤销被拒绝", async function () {
  // 先建修复记录
  const repair = await request("POST", "/api/bidi-lab/records", {
    kind: "repair", paraCount: 1, issueCount: 1,
    applied: [{ id: "fix-0", para: 1, start: 1, end: 2 }],
    contentFp: "abc"
  }, { "If-Match": String(rev) });
  assert.equal(repair.status, 201);
  rev = Number(repair.rev);
  const repairId = repair.data.record.id;

  const bad = await request("POST", "/api/bidi-lab/records",
    { kind: "undo", undoOf: "nonexistent" }, { "If-Match": String(rev) });
  assert.equal(bad.status, 404);
  assert.equal(bad.data.error, "repair_record_not_found");

  const undo = await request("POST", "/api/bidi-lab/records", {
    kind: "undo", undoOf: repairId, paraCount: 1,
    undoResult: { restoredSelection: true, scrollY: 0 }
  }, { "If-Match": String(rev) });
  assert.equal(undo.status, 201);
  rev = Number(undo.rev);

  const again = await request("POST", "/api/bidi-lab/records", {
    kind: "undo", undoOf: repairId
  }, { "If-Match": String(rev) });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "already_undone");
});

it("GET 记录可按 kind 筛选，刷新后仍在", async function () {
  const all = await request("GET", "/api/bidi-lab/records");
  assert.equal(all.status, 200);
  assert.ok(all.data.records.length >= 3);
  const reports = await request("GET", "/api/bidi-lab/records?kind=report");
  assert.ok(reports.data.records.every(function (r) { return r.kind === "report"; }));
});

it("DELETE 样例", async function () {
  const r = await request("DELETE", "/api/bidi-lab/samples/" + sampleId,
    null, { "If-Match": String(rev) });
  assert.equal(r.status, 200);
  rev = Number(r.rev);
  const gone = await request("GET", "/api/bidi-lab/samples/" + sampleId);
  assert.equal(gone.status, 404);
});

it("持久化：数据文件包含 rev 与记录", async function () {
  const raw = JSON.parse(fs.readFileSync(FILES.BIDI_LAB_FILE, "utf8"));
  assert.equal(raw.rev, rev);
  assert.ok(Array.isArray(raw.records) && raw.records.length >= 3);
});
});
