/* node --test test/replay-api.test.js
 * 执行回放 HTTP 集成测试：真实启动 server.js（临时数据文件 + 随机端口），
 * 先走完整线上流程（批注→批次→草案→投票→发布定时任务→到点自动执行+快照），
 * 然后覆盖：
 *   导出预览 / 导出审计包（下载头）/ 空范围拒绝 / 时间范围筛选 /
 *   导入成功创建回放空间 / 重复导入幂等 / 同标识不同包冲突 /
 *   各类坏包拒绝（非 JSON、缺字段、重复事件、哈希篡改、断链、时间倒退、
 *   跨任务引用缺失、超限）/ 失败原因保留 / 校验失败不部分写入 /
 *   时间线按任务与类型筛选 / 筛选条件保存（If-Match）/ 冲突原因汇总 /
 *   回放空间只读、不含任何线上动作接口 / 导出与回放不改线上 rev /
 *   删除空间 / 重启后空间、筛选条件与校验结果恢复 / 大包条目数限制。
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

const PORT = 8620 + Math.floor(Math.random() * 80);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "rep-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "rep-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "rep-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "rep-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(TMP, "rep-space-" + TAG + ".json")
};

let server;

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: FILES.SNAP_DATA,
      ANNOTATIONS_FILE: FILES.ANN_DATA,
      REVIEW_BATCHES_FILE: FILES.BATCH_DATA,
      REVIEW_DECISIONS_FILE: FILES.DEC_DATA,
      REPLAY_SPACES_FILE: FILES.REPLAY_DATA,
      DECISION_SCHEDULER_INTERVAL_MS: "100"
    }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  return waitUp();
}
function waitUp() {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/replay/spaces", function (res) {
        res.resume(); res.on("end", resolve);
      });
      req.on("error", function () {
        if (Date.now() > deadline) reject(new Error("server failed to start"));
        else setTimeout(ping, 100);
      });
    })();
  });
}
function stopServer() {
  return new Promise(function (resolve) {
    if (!server || server.killed) { resolve(); return; }
    server.on("exit", function () { resolve(); });
    server.kill("SIGKILL");
  });
}
async function restartServer() {
  await stopServer();
  return startServer();
}

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve) {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = { "Accept": "application/json" };
    if (payload) Object.assign(h,
      { "Content-Type": "application/json", "Content-Length": payload.length });
    if (headers) Object.assign(h, headers);
    const req = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({
          status: res.statusCode, data: data, text: text,
          headers: res.headers,
          drev: res.headers["x-decision-rev"],
          rrev: res.headers["x-replay-rev"]
        });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
// 发送原始文本体（用于坏 JSON / 审计包原文）
function requestRaw(method, urlPath, raw, headers, contentType) {
  return new Promise(function (resolve) {
    const payload = raw == null ? null
      : (Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"));
    const h = Object.assign({
      "Content-Type": contentType || "application/json"
    }, headers || {});
    if (payload) h["Content-Length"] = payload.length;
    const req = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode, data: data, text: text, headers: res.headers });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function drev() { return (await request("GET", "/api/review-decisions")).drev; }
async function annRev() {
  return (await requestRaw("GET", "/api/annotations", null)).headers["x-annotation-rev"];
}
async function batchRev() {
  return (await requestRaw("GET", "/api/review-batches", null)).headers["x-batch-rev"];
}

const PARAS = [{ dir: "ltr", text: "中文示例文本" }];
let seq = 0;

describe("执行回放 API（顺序用例）", function () {
  let decisionRevBefore;
  let taskId;
  let pkg;

  before(async function () { await startServer(); });
  after(async function () {
    await stopServer();
    for (const f of Object.values(FILES)) {
      for (const suffix of ["", ".tmp"]) {
        try { fs.unlinkSync(f + suffix); } catch (e) {}
      }
    }
  });

  /* ---------- 线上数据准备 ---------- */

  it("准备批注/批次/ready 草案并发布一个定时任务，到点自动执行并生成快照", async function () {
    let ar = await annRev();
    const a1 = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": ar });
    assert.equal(a1.status, 201);
    const annId = a1.data.annotation.id;
    ar = await annRev();
    const br = await batchRev();
    const batch = await request("POST", "/api/review-batches", {
      name: "回放批次", owner: "负责人",
      deadline: "2030-01-01T00:00:00Z", annotationIds: [annId]
    }, { "If-Match": br });
    assert.equal(batch.status, 201, JSON.stringify(batch.data));
    const batchId = batch.data.batch.id;

    let r = await request("POST", "/api/review-decisions", {
      batchId: batchId, threshold: 1, paragraphs: PARAS, items: []
    }, { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const did = r.data.decision.id;
    r = await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: [{ annotationId: annId, disposition: "delete" }], actor: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200);
    r = await request("POST", "/api/review-decisions/" + did + "/submit",
      { actor: "甲" }, { "If-Match": await drev() });
    assert.equal(r.status, 200);
    r = await request("POST", "/api/review-decisions/" + did + "/votes",
      { annotationId: annId, vote: "approve", voter: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200);

    // 发布一个很快到期的任务
    r = await request("POST", "/api/execution-tasks", {
      decisionId: did,
      scheduledAt: new Date(Date.now() + 300).toISOString(),
      paragraphs: PARAS, actor: "负责人"
    }, { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    taskId = r.data.task.id;

    // 等到终态
    const end = Date.now() + 6000;
    let t;
    while (Date.now() < end) {
      t = (await request("GET", "/api/execution-tasks/" + taskId)).data.task;
      if (t.finishedAt) break;
      await sleep(120);
    }
    assert.ok(t.finishedAt, "任务应已执行结束：" + t.status);
    assert.equal(t.status, "succeeded");
    assert.ok(t.snapshotId, "成功执行应自动关联快照");
    decisionRevBefore = await drev();
  });

  /* ---------- 导出 ---------- */

  it("导出预览：无范围时报告任务与事件数", async function () {
    const r = await request("GET", "/api/replay/preview");
    assert.equal(r.status, 200);
    assert.ok(r.data.taskCount >= 1);
    assert.ok(r.data.eventCount >= 4); // 发布/自动执行/逐条/成功
  });

  it("预览：非法时间 400", async function () {
    assert.equal((await request("GET", "/api/replay/preview?from=nope")).status, 400);
  });

  it("导出：空时间范围返回 404 empty_export，且不影响线上版本", async function () {
    const r = await request("POST", "/api/replay/export",
      { from: "2000-01-01T00:00:00Z", to: "2000-02-01T00:00:00Z", actor: "负责人" });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, "empty_export");
    assert.equal(await drev(), decisionRevBefore);
  });

  it("导出：生成自洽审计包，含版本/依赖/审批流水/事件链/快照关联", async function () {
    const r = await request("POST", "/api/replay/export", { actor: "负责人", name: "九月审计包" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    pkg = r.data;
    assert.equal(pkg.format, "bidi-replay");
    assert.equal(pkg.packageVersion, 1);
    assert.equal(pkg.name, "九月审计包");
    assert.ok(pkg.packageId);
    assert.ok(pkg.manifest.contentHash);
    assert.ok(pkg.manifest.chainHead);
    assert.ok(pkg.content.events.length >= 4);
    assert.ok(pkg.content.tasks.some(function (t) { return t.id === taskId; }));
    // 版本锁定
    const t = pkg.content.tasks.find(function (x) { return x.id === taskId; });
    assert.ok(t.lock);
    assert.ok(Array.isArray(t.lock.paragraphs));
    assert.equal(typeof t.lock.annotationRev, "number");
    // 任务依赖字段存在（本任务无依赖）
    assert.deepEqual(t.dependencyIds, []);
    // 审批流水字段存在（本任务未配置审批）
    assert.deepEqual(t.approvalDecisions, []);
    // 关联快照
    assert.ok(pkg.content.snapshots.length >= 1);
    assert.ok(pkg.content.snapshots.some(function (s) { return s.id === t.snapshotId; }));
    // 执行记录 + 逐条结果 + 冲突原因字段
    assert.ok(pkg.content.executions.length >= 1);
    assert.ok(pkg.content.executions[0].results.length >= 1);
    // 事件链顺序
    for (let i = 1; i < pkg.content.events.length; i++) {
      assert.equal(pkg.content.events[i].prevEventId, pkg.content.events[i - 1].id);
      assert.ok(Date.parse(pkg.content.events[i].at) >=
                Date.parse(pkg.content.events[i - 1].at));
    }
  });

  it("导出：?download=1 返回附件下载头", async function () {
    const r = await requestRaw("POST", "/api/replay/export?download=1",
      JSON.stringify({ actor: "负责人" }));
    assert.equal(r.status, 200);
    assert.match(r.headers["content-disposition"] || "", /attachment/);
    assert.match(r.headers["content-disposition"] || "", /replay/);
  });

  it("导出是只读操作：线上决策/快照版本不变", async function () {
    assert.equal(await drev(), decisionRevBefore);
  });

  it("导出：时间范围只包范围内事件（范围外为空时 404）", async function () {
    const future = new Date(Date.now() + 86400000).toISOString();
    const r = await request("POST", "/api/replay/export",
      { from: future, to: new Date(Date.now() + 172800000).toISOString() });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, "empty_export");
  });

  /* ---------- 导入：成功 / 幂等 / 冲突 ---------- */

  let spaceId, spaceRev;

  it("导入：合法包创建回放空间", async function () {
    const r = await request("POST", "/api/replay/import",
      Object.assign({ importedBy: "负责人乙" }, pkg));
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.idempotent, false);
    spaceId = r.data.space.id;
    spaceRev = r.data.space.rev;
    assert.equal(r.data.space.name, "九月审计包");
    const detail = await request("GET", "/api/replay/spaces/" + spaceId);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.space.importedBy, "负责人乙");
    assert.equal(detail.data.space.validation.verified, true);
    assert.equal(detail.data.space.validation.contentHash, pkg.manifest.contentHash);
    assert.equal(detail.data.space.counts.events, pkg.content.events.length);
  });

  it("导入：同一审计包再次导入幂等（不新建空间、返回同一 id）", async function () {
    const r = await request("POST", "/api/replay/import", pkg);
    assert.equal(r.status, 200);
    assert.equal(r.data.idempotent, true);
    assert.equal(r.data.space.id, spaceId);
    const list = await request("GET", "/api/replay/spaces");
    assert.equal(list.data.spaces.length, 1);
  });

  it("导入：不同内容但相同 packageId 返回 409 replay_conflict，并保留失败记录", async function () {
    const R = require("../replay-core");
    const evil = JSON.parse(JSON.stringify(pkg));
    // 保持 packageId，但篡改内容并重算内容/链哈希：
    // 这是一份“完全合法但内容不同”的包，仅标识与已有空间冲突。
    evil.content.tasks[0].blockReason = "被伪造的阻断原因";
    evil.manifest = R.buildManifest(evil);
    assert.ok(R.verifyPackage(evil).ok, "篡改包本身应通过独立校验");
    assert.equal(evil.packageId, pkg.packageId);
    assert.notEqual(evil.manifest.contentHash, pkg.manifest.contentHash);
    const r = await request("POST", "/api/replay/import", evil);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "replay_conflict");
    assert.equal(r.data.existingSpaceId, spaceId);
    // 失败记录
    const fails = await request("GET", "/api/replay/failures");
    assert.ok(fails.data.failures.some(function (f) {
      return f.code === "replay_conflict" && f.packageId === pkg.packageId;
    }));
    // 冲突没有新建空间
    assert.equal((await request("GET", "/api/replay/spaces")).data.spaces.length, 1);
  });

  /* ---------- 坏包拒绝（不部分写入、保留原因） ---------- */

  const badBodies = [
    ["非 JSON", function (s) { return s + "xxx"; }, "invalid_format", true],
    ["缺字段", function (s) { const p = JSON.parse(s); delete p.content; return JSON.stringify(p); }, "missing_field"],
    ["格式标识错误", function (s) { const p = JSON.parse(s); p.format = "rar"; return JSON.stringify(p); }, "invalid_format"],
    ["版本号过高", function (s) { const p = JSON.parse(s); p.packageVersion = 99; return JSON.stringify(p); }, "unsupported_version"],
    ["重复事件", function (s) { const p = JSON.parse(s); p.content.events[2].id = p.content.events[0].id; return JSON.stringify(p); }, "duplicate_event"],
    ["内容哈希不匹配", function (s) { const p = JSON.parse(s); p.content.range.from = "1999-01-01T00:00:00Z"; return JSON.stringify(p); }, "hash_mismatch"],
    ["链头不匹配", function (s) {
      const p = JSON.parse(s);
      p.content.events[1].detail = "改了但重算了内容哈希";
      // 用 Node 端无法直接重算 fnv——这里仅改链头触发 chain mismatch 前先过不了 content hash，
      // 故改为直接改 manifest.chainHead（content hash 仍不匹配则报 hash_mismatch），
      // 因此本用例实际验证 hash_mismatch；chain 用例见下。
      p.manifest.chainHead = "fnv1a64:" + "a".repeat(16);
      return JSON.stringify(p);
    }, "hash_mismatch"],
    ["跨任务引用不存在", function (s) {
      const p = JSON.parse(s);
      p.content.tasks[0].dependencyIds = ["ghost-task"];
      return JSON.stringify(p);
    }, "cross_reference_missing"],
    ["事件时间倒退", function (s) {
      const p = JSON.parse(s);
      p.content.events[1].at = "1999-01-01T00:00:00.000Z";
      return JSON.stringify(p);
    }, "event_time_regression"]
  ];

  for (const [name, mutate, expectCode, rawText] of badBodies) {
    it("坏包拒绝：" + name, async function () {
      const body = mutate(JSON.stringify(pkg));
      const r = await requestRaw("POST", "/api/replay/import", body);
      assert.equal(r.status, 400, name + " -> " + r.status);
      assert.equal(r.data.error, expectCode, name + " got " + r.data.error);
      // 空间数不变：没有部分写入
      assert.equal((await request("GET", "/api/replay/spaces")).data.spaces.length, 1);
    });
  }

  it("失败原因在 /failures 中保留（含时间、包标识、错误明细）", async function () {
    const r = await request("GET", "/api/replay/failures");
    assert.equal(r.status, 200);
    assert.ok(r.data.failures.length >= 3);
    const dup = r.data.failures.find(function (f) { return f.code === "duplicate_event"; });
    assert.ok(dup);
    assert.ok(dup.at);
    assert.equal(dup.packageId, pkg.packageId);
    assert.ok(dup.message);
  });

  it("结构链断裂（prevEventId 指向错误）单独验证", async function () {
    // prevEventId 不参与内容哈希与链哈希（链哈希只看业务字段），
    // 因此只破坏 prev 指针即可精确命中 broken_event_chain，而非 hash_mismatch。
    const p = JSON.parse(JSON.stringify(pkg));
    p.content.events[2].prevEventId = "wrong";
    const r = await request("POST", "/api/replay/import", p);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "broken_event_chain");
  });

  /* ---------- 回放视图：只读时间线 + 筛选 ---------- */

  it("时间线：默认按任务分组、链顺序返回", async function () {
    const r = await request("GET", "/api/replay/spaces/" + spaceId + "/timeline");
    assert.equal(r.status, 200);
    assert.ok(r.data.timeline.length >= 1);
    const group = r.data.timeline.find(function (g) { return g.taskId === taskId; });
    assert.ok(group);
    assert.ok(group.task);
    assert.ok(group.events.length >= 4);
  });

  it("时间线：按事件类型筛选（execute / wait）", async function () {
    const ex = await request("GET",
      "/api/replay/spaces/" + spaceId + "/timeline?category=execute");
    assert.equal(ex.status, 200);
    ex.data.timeline.forEach(function (g) {
      g.events.forEach(function (e) { assert.equal(e.category, "execute"); });
    });
    assert.ok(ex.data.timeline.some(function (g) { return g.taskId === taskId; }));
    const wait = await request("GET",
      "/api/replay/spaces/" + spaceId + "/timeline?category=wait");
    wait.data.timeline.forEach(function (g) {
      g.events.forEach(function (e) { assert.equal(e.category, "wait"); });
    });
    assert.equal((await request("GET",
      "/api/replay/spaces/" + spaceId + "/timeline?category=bogus")).status, 400);
  });

  it("时间线：按任务筛选（包外任务返回空）", async function () {
    const r = await request("GET",
      "/api/replay/spaces/" + spaceId + "/timeline?taskId=" + taskId);
    assert.equal(r.data.timeline.length, 1);
    const none = await request("GET",
      "/api/replay/spaces/" + spaceId + "/timeline?taskId=not-in-package");
    assert.equal(none.data.timeline.length, 0);
  });

  it("冲突原因汇总可查看", async function () {
    const r = await request("GET", "/api/replay/spaces/" + spaceId + "/conflicts");
    assert.equal(r.status, 200);
    assert.ok(r.data.summary);
    assert.deepEqual(r.data.summary.counts, {}); // 全部成功，无冲突
  });

  it("回放空间内只能 GET：暂停/审批/执行等线上动作接口不存在", async function () {
    for (const sub of ["pause", "approvals", "retry", "cancel", "continue"]) {
      const r = await request("POST",
        "/api/replay/spaces/" + spaceId + "/" + sub, { approver: "x", decision: "approve" });
      assert.equal(r.status, 404, sub + " 不应在回放空间可用");
    }
    // 回放数据与线上任务接口隔离：空间内容不出现在线上任务列表里
    const online = await request("GET", "/api/execution-tasks");
    assert.ok(Array.isArray(online.data.tasks || online.data));
  });

  it("保存筛选条件：缺 If-Match 428、旧版本 409、成功后持久化", async function () {
    const noLock = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/view", { category: "execute" });
    assert.equal(noLock.status, 428);
    const stale = await request("PUT", "/api/replay/spaces/" + spaceId + "/view",
      { category: "execute" }, { "If-Match": "9999" });
    assert.equal(stale.status, 409);
    const ok = await request("PUT", "/api/replay/spaces/" + spaceId + "/view",
      { category: "execute", taskId: taskId }, { "If-Match": String(spaceRev) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.spaceRev, spaceRev + 1);
    // 再次请求时间线（不带参数）应回退到已保存筛选
    const tl = await request("GET", "/api/replay/spaces/" + spaceId + "/timeline");
    assert.equal(tl.data.applied.category, "execute");
    assert.equal(tl.data.applied.taskId, taskId);
    // 非法筛选
    const bad = await request("PUT", "/api/replay/spaces/" + spaceId + "/view",
      { category: "nope" }, { "If-Match": String(spaceRev + 1) });
    assert.equal(bad.status, 400);
  });

  it("包内锁定快照可只读查看", async function () {
    const snapId = pkg.content.tasks.find(function (t) { return t.id === taskId; }).snapshotId;
    const r = await request("GET",
      "/api/replay/spaces/" + spaceId + "/snapshots/" + snapId);
    assert.equal(r.status, 200);
    assert.equal(r.data.snapshot.id, snapId);
    assert.equal((await request("GET",
      "/api/replay/spaces/" + spaceId + "/snapshots/missing")).status, 404);
  });

  /* ---------- 重启恢复 ---------- */

  let pkg2, space2;

  it("再导入第二个包（不同时间范围）用于重启后多空间校验", async function () {
    // 用同一个包会幂等；构造一个不同范围但自洽的新包：直接用核心在进程内重建
    const R = require("../replay-core");
    // 从已导出包重打包为“不同标识”：换 producerId
    const rebuilt = JSON.parse(JSON.stringify(pkg));
    rebuilt.producerId = "team-b";
    rebuilt.packageId = pkg.packageId + "-b";
    rebuilt.manifest = R.buildManifest(rebuilt);
    assert.ok(R.verifyPackage(rebuilt).ok);
    const r = await request("POST", "/api/replay/import", rebuilt);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    space2 = r.data.space.id;
    pkg2 = rebuilt;
  });

  it("服务重启后：回放空间、筛选条件与校验结果全部恢复", async function () {
    await restartServer();
    const list = await request("GET", "/api/replay/spaces");
    assert.equal(list.status, 200);
    assert.equal(list.data.spaces.length, 2);
    const detail = await request("GET", "/api/replay/spaces/" + spaceId);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.space.view.category, "execute");
    assert.equal(detail.data.space.view.taskId, taskId);
    assert.equal(detail.data.space.validation.verified, true);
    assert.equal(detail.data.space.validation.contentHash, pkg.manifest.contentHash);
    // 时间线仍可查看锁定历史
    const tl = await request("GET", "/api/replay/spaces/" + spaceId + "/timeline");
    assert.ok(tl.data.timeline.length >= 1);
    // 失败记录也恢复
    const fails = await request("GET", "/api/replay/failures");
    assert.ok(fails.data.failures.length >= 3);
    // 重启后重复导入仍是幂等
    const again = await request("POST", "/api/replay/import", pkg);
    assert.equal(again.status, 200);
    assert.equal(again.data.idempotent, true);
    assert.equal(again.data.space.id, spaceId);
  });

  it("重启后线上数据未被回放操作改动（任务仍为 succeeded）", async function () {
    const t = (await request("GET", "/api/execution-tasks/" + taskId)).data.task;
    assert.equal(t.status, "succeeded");
  });

  it("删除回放空间；删除后 404，且不影响另一个空间与线上数据", async function () {
    const r = await request("DELETE", "/api/replay/spaces/" + space2);
    assert.equal(r.status, 200);
    assert.equal((await request("GET", "/api/replay/spaces/" + space2)).status, 404);
    assert.equal((await request("GET", "/api/replay/spaces")).data.spaces.length, 1);
    const t = (await request("GET", "/api/execution-tasks/" + taskId)).data.task;
    assert.equal(t.status, "succeeded");
  });

  it("大包限制：事件数超上限返回 413 且保留失败原因", async function () {
    const R = require("../replay-core");
    const big = JSON.parse(JSON.stringify(pkg));
    const ev = JSON.parse(JSON.stringify(big.content.events[0]));
    const many = [];
    const N = R.LIMITS.EVENTS_MAX + 5;
    for (let i = 0; i < N; i++) {
      const e = JSON.parse(JSON.stringify(ev));
      e.id = "pad-" + i;
      e.at = new Date(Date.parse(ev.at) + i).toISOString();
      e.action = "task_publish";
      e.category = "wait";
      many.push(e);
    }
    big.content.events = many;
    // 重排链
    many.forEach(function (e, i) { e.seq = i + 1; e.prevEventId = i === 0 ? null : many[i - 1].id; });
    big.manifest = R.buildManifest(big); // 构建端本身会因超限失败
    // buildManifest 不检查数量限制；verifyPackage 检查
    const v = R.verifyPackage(big);
    assert.equal(v.ok, false);
    assert.equal(v.code, "package_too_large");
    const r = await request("POST", "/api/replay/import", big);
    assert.equal(r.status, 413);
    assert.equal(r.data.error, "package_too_large");
    const fails = await request("GET", "/api/replay/failures");
    assert.ok(fails.data.failures.some(function (f) { return f.code === "package_too_large"; }));
    assert.equal((await request("GET", "/api/replay/spaces")).data.spaces.length, 1);
  });
});
