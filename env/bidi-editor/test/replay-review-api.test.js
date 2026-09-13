/* node --test test/replay-review-api.test.js
 * 历史证据复核 HTTP 集成测试：真实启动 server.js（临时数据文件 + 随机端口），
 * 先走完整线上流程并导出/导入审计包，然后覆盖：
 *   新增意见（事件/逐条结果引用、缺复核人/空内容/过去截止/非法状态拒绝）、
 *   引用不存在目标 404、同目标重复未关闭意见 409、关闭后可重提、
 *   空间 rev 乐观锁（缺 If-Match 428 / 旧版本 409）、
 *   意见版本并发（缺 X-Review-Version 428 / 旧版本 409）、
 *   已关闭意见不能被修改/转派（旧页面无法覆盖关闭结论）、
 *   修改/转派/关闭推进版本并留痕、状态变化记录按时间筛选、
 *   列表/时间线/冲突汇总按状态、复核人、截止时间筛选、
 *   复核清单导出（只读不推 rev、筛选生效、下载头、失败不改变空间）、
 *   筛选条件随空间持久化、重启后意见/记录/筛选恢复、
 *   复核流程不触碰线上暂停/审批/执行接口与线上 rev、
 *   删除空间级联移除意见。
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

const PORT = 8720 + Math.floor(Math.random() * 80);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "rr-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "rr-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "rr-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "rr-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(TMP, "rr-space-" + TAG + ".json")
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
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
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
          rrev: res.headers["x-replay-rev"],
          drev: res.headers["x-decision-rev"],
          disposition: res.headers["content-disposition"]
        });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
async function drev() {
  return (await request("GET", "/api/review-decisions", undefined)).drev;
}
async function annRev() {
  return (await request("GET", "/api/annotations", undefined)).headers["x-annotation-rev"];
}
async function batchRev() {
  return (await request("GET", "/api/review-batches", undefined)).headers["x-batch-rev"];
}

const PARAS = [{ dir: "ltr", text: "中文示例文本内容用于复核" }];

describe("历史证据复核 API（顺序用例）", function () {
  let spaceId;
  let spaceRev;
  let eventId;            // 发布事件 id
  let itemEventId;        // 逐条成功事件 id
  let executionId;
  let annotationId;
  let decisionRevBeforeReviews;

  before(async function () { await startServer(); });
  after(async function () {
    await stopServer();
    for (const f of Object.values(FILES)) {
      for (const suffix of ["", ".tmp"]) {
        try { fs.unlinkSync(f + suffix); } catch (e) {}
      }
    }
  });

  it("准备线上数据并导入回放空间", async function () {
    // —— 线上：批注 → 批次 → 草案 → 投票 → 定时执行成功 ——
    let ar = await annRev();
    const a1 = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": ar });
    assert.equal(a1.status, 201);
    annotationId = a1.data.annotation.id;

    const br = await batchRev();
    const batch = await request("POST", "/api/review-batches", {
      name: "复核批次", owner: "负责人",
      deadline: "2030-01-01T00:00:00Z", annotationIds: [annotationId]
    }, { "If-Match": br });
    assert.equal(batch.status, 201, JSON.stringify(batch.data));
    const batchId = batch.data.batch.id;

    let r = await request("POST", "/api/review-decisions", {
      batchId: batchId, threshold: 1, paragraphs: PARAS, items: []
    }, { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const did = r.data.decision.id;
    r = await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: [{ annotationId: annotationId, disposition: "delete" }], actor: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200);
    r = await request("POST", "/api/review-decisions/" + did + "/submit",
      { actor: "甲" }, { "If-Match": await drev() });
    assert.equal(r.status, 200);
    r = await request("POST", "/api/review-decisions/" + did + "/votes",
      { annotationId: annotationId, vote: "approve", voter: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200);

    r = await request("POST", "/api/execution-tasks", {
      decisionId: did,
      scheduledAt: new Date(Date.now() + 300).toISOString(),
      paragraphs: PARAS, actor: "负责人"
    }, { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const taskId = r.data.task.id;

    const end = Date.now() + 6000;
    let t;
    while (Date.now() < end) {
      t = (await request("GET", "/api/execution-tasks/" + taskId)).data.task;
      if (t.finishedAt) break;
      await sleep(120);
    }
    assert.ok(t.finishedAt);
    assert.equal(t.status, "succeeded");

    // 等调度器彻底静止，避免 rev 漂移影响后续“只读不推线上 rev”断言
    await sleep(300);
    decisionRevBeforeReviews = await drev();

    // —— 导出 + 导入 ——
    const ex = await request("POST", "/api/replay/export", { actor: "负责人", name: "复核审计包" });
    assert.equal(ex.status, 200, JSON.stringify(ex.data));
    const pkg = ex.data;
    eventId = pkg.content.events.find(function (e) { return e.action === "task_publish"; }).id;
    // 线上逐条流水不带 executionId（审计包保持不变），按 *_item_* 动作定位
    const itemEv = pkg.content.events.find(function (e) {
      return e.action.indexOf("_item_") !== -1 && !!e.annotationId;
    });
    itemEventId = itemEv.id;
    executionId = pkg.content.executions[0].id;

    const imp = await request("POST", "/api/replay/import",
      Object.assign({ importedBy: "复核员" }, pkg));
    assert.equal(imp.status, 201, JSON.stringify(imp.data));
    spaceId = imp.data.space.id;
    spaceRev = imp.data.space.rev;
    assert.equal(imp.data.space.counts.reviews, 0);
  });

  /* ---------- 新增意见：校验 ---------- */

  it("新增：事件意见成功（201 + 计数 + create 留痕）", async function () {
    const due = new Date(Date.now() + 86400000).toISOString();
    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews",
      { target: { kind: "event", eventId: eventId },
        reviewer: "张三", content: "请核对发布时间与计划时间",
        dueAt: due, actor: "负责人" },
      { "If-Match": String(spaceRev) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.review.status, "open");
    assert.equal(r.data.review.version, 1);
    assert.equal(r.data.review.reviewer, "张三");
    assert.equal(r.data.spaceRev, spaceRev + 1);
    spaceRev = r.data.spaceRev;

    const logs = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/" + r.data.review.id + "/logs");
    assert.equal(logs.data.logs.length, 1);
    assert.equal(logs.data.logs[0].action, "create");
  });

  let rvEventId;
  it("新增：逐条结果意见成功", async function () {
    rvEventId = undefined;
    const due = new Date(Date.now() + 2 * 86400000).toISOString();
    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews",
      { target: { kind: "result", executionId: executionId, annotationId: annotationId },
        reviewer: "李四", content: "核对该条删除结果", dueAt: due, actor: "负责人" },
      { "If-Match": String(spaceRev) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    rvEventId = r.data.review.id;
    spaceRev = r.data.spaceRev;
  });

  it("新增校验：缺复核人/空内容/缺截止/过去截止/非法状态/缺目标", async function () {
    const due = new Date(Date.now() + 86400000).toISOString();
    const base = { target: { kind: "event", eventId: eventId },
      reviewer: "王五", content: "c", dueAt: due };
    async function post(mut) {
      const body = Object.assign({}, base, mut);
      return request("POST", "/api/replay/spaces/" + spaceId + "/reviews", body,
        { "If-Match": String(spaceRev) });
    }
    assert.equal((await post({ reviewer: " " })).status, 400);
    assert.equal((await post({ content: "" })).status, 400);
    assert.equal((await post({ dueAt: null })).status, 400);
    const past = await post({ dueAt: "2000-01-01T00:00:00Z" });
    assert.equal(past.status, 400);
    assert.equal(past.data.error, "due_in_past");
    assert.equal((await post({ status: "closed" })).status, 400);
    assert.equal((await post({ target: null })).status, 400);
    assert.equal((await post({ dueAt: "not-a-date" })).status, 400);
  });

  it("引用不存在的事件/结果 -> 404 review_target_not_found，空间不变", async function () {
    const due = new Date(Date.now() + 86400000).toISOString();
    const r1 = await request("POST", "/api/replay/spaces/" + spaceId + "/reviews",
      { target: { kind: "event", eventId: "no-such-event" },
        reviewer: "王五", content: "x", dueAt: due },
      { "If-Match": String(spaceRev) });
    assert.equal(r1.status, 404);
    assert.equal(r1.data.error, "review_target_not_found");
    const r2 = await request("POST", "/api/replay/spaces/" + spaceId + "/reviews",
      { target: { kind: "result", executionId: executionId, annotationId: "ghost" },
        reviewer: "王五", content: "x", dueAt: due },
      { "If-Match": String(spaceRev) });
    assert.equal(r2.status, 404);
    assert.equal(r2.data.error, "review_target_not_found");
    // 未推进空间版本
    const list = await request("GET", "/api/replay/spaces/" + spaceId + "/reviews");
    assert.equal(list.data.total, 2);
  });

  it("同一目标重复未关闭意见 -> 409 duplicate_review（带 existingReviewId，不写入）",
    async function () {
      const due = new Date(Date.now() + 86400000).toISOString();
      const r = await request("POST", "/api/replay/spaces/" + spaceId + "/reviews",
        { target: { kind: "event", eventId: eventId },
          reviewer: "赵六", content: "再提一条", dueAt: due },
        { "If-Match": String(spaceRev) });
      assert.equal(r.status, 409);
      assert.equal(r.data.error, "duplicate_review");
      assert.ok(r.data.existingReviewId);
      const list = await request("GET", "/api/replay/spaces/" + spaceId + "/reviews");
      assert.equal(list.data.total, 2);
      assert.equal(await drev(), decisionRevBeforeReviews); // 复核不推线上 rev
    });

  it("新增并发：缺 If-Match 428、旧空间版本 409，且均不写盘", async function () {
    const due = new Date(Date.now() + 86400000).toISOString();
    const body = { target: { kind: "event", eventId: itemEventId },
      reviewer: "钱七", content: "逐条事件复核", dueAt: due };
    const noLock = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews", body);
    assert.equal(noLock.status, 428);
    const stale = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews", body,
      { "If-Match": String(spaceRev - 1) });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, "version_conflict");
    const list = await request("GET", "/api/replay/spaces/" + spaceId + "/reviews");
    assert.equal(list.data.total, 2);
  });

  /* ---------- 修改 / 转派 / 关闭：版本并发 ---------- */

  let rvId;
  it("修改意见：双重版本检查（428 缺意见版本 / 409 旧意见版本 / 旧空间版本）", async function () {
    // 先取一条意见 id（事件意见）
    const list = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews?reviewer=" + encodeURIComponent("张三"));
    rvId = list.data.reviews[0].id;

    // 缺 X-Review-Version
    const noVer = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { content: "改成新内容", actor: "负责人" },
      { "If-Match": String(spaceRev) });
    assert.equal(noVer.status, 428);
    assert.match(noVer.data.message, /X-Review-Version/);

    // 旧意见版本
    const oldVer = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { content: "改成新内容" },
      { "If-Match": String(spaceRev), "X-Review-Version": "999" });
    assert.equal(oldVer.status, 409);
    assert.equal(oldVer.data.error, "review_version_conflict");
    assert.equal(oldVer.data.currentVersion, 1);

    // 旧空间版本
    const oldSpace = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { content: "改成新内容" },
      { "If-Match": String(spaceRev - 1), "X-Review-Version": "1" });
    assert.equal(oldSpace.status, 409);
    assert.equal(oldSpace.data.error, "version_conflict");

    // 成功修改
    const ok = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { content: "改成新内容", status: "in_review",
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString() },
      { "If-Match": String(spaceRev), "X-Review-Version": "1" });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.review.version, 2);
    assert.equal(ok.data.review.status, "in_review");
    assert.equal(ok.data.review.content, "改成新内容");
    spaceRev = ok.data.spaceRev;

    // 旧版本页面再提交（基于 version=1 的旧表单）必被拒绝
    const replayStale = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { content: "旧页面迟到的覆盖" },
      { "If-Match": String(spaceRev), "X-Review-Version": "1" });
    assert.equal(replayStale.status, 409);
    assert.equal(replayStale.data.error, "review_version_conflict");
  });

  it("修改非法状态（直接置 closed）/ 空 patch 拒绝", async function () {
    const bad = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { status: "closed" },
      { "If-Match": String(spaceRev), "X-Review-Version": "2" });
    assert.equal(bad.status, 400);
    const empty = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      {},
      { "If-Match": String(spaceRev), "X-Review-Version": "2" });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error, "empty_patch");
  });

  it("转派：成功留痕；意见不存在 404", async function () {
    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId + "/reassign",
      { reviewer: " 王五 ", actor: "负责人" },
      { "If-Match": String(spaceRev), "X-Review-Version": "2" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.review.reviewer, "王五");
    assert.equal(r.data.review.version, 3);
    spaceRev = r.data.spaceRev;

    const logs = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId + "/logs");
    assert.ok(logs.data.logs.some(function (l) { return l.action === "reassign"; }));
    // 时间倒序
    for (let i = 1; i < logs.data.logs.length; i++) {
      assert.ok(Date.parse(logs.data.logs[i - 1].at) >= Date.parse(logs.data.logs[i].at));
    }

    const ghost = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/nope/reassign",
      { reviewer: "x" },
      { "If-Match": String(spaceRev), "X-Review-Version": "1" });
    assert.equal(ghost.status, 404);
  });

  it("关闭：成功后旧页面不能再修改/转派（review_closed 优先）", async function () {
    const close = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId + "/close",
      { reason: "证据与执行记录一致", actor: "负责人" },
      { "If-Match": String(spaceRev), "X-Review-Version": "3" });
    assert.equal(close.status, 200, JSON.stringify(close.data));
    assert.equal(close.data.review.status, "closed");
    assert.equal(close.data.review.version, 4);
    assert.equal(close.data.review.closeReason, "证据与执行记录一致");
    assert.ok(close.data.review.closedAt);
    spaceRev = close.data.spaceRev;

    // 带着“正确”的最新版本也不能改：终态保护
    const edit = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { content: "关闭后还想改" },
      { "If-Match": String(spaceRev), "X-Review-Version": "4" });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.error, "review_closed");
    const reassign = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId + "/reassign",
      { reviewer: "赵六" },
      { "If-Match": String(spaceRev), "X-Review-Version": "4" });
    assert.equal(reassign.status, 409);
    assert.equal(reassign.data.error, "review_closed");
    // 重复关闭仍是 review_closed
    const again = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId + "/close",
      {},
      { "If-Match": String(spaceRev), "X-Review-Version": "4" });
    assert.equal(again.status, 409);
  });

  it("关闭后同一目标可重新提出复核意见", async function () {
    const due = new Date(Date.now() + 86400000).toISOString();
    const r = await request("POST", "/api/replay/spaces/" + spaceId + "/reviews",
      { target: { kind: "event", eventId: eventId },
        reviewer: "赵六", content: "关闭结论后重新复核", dueAt: due },
      { "If-Match": String(spaceRev) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    spaceRev = r.data.spaceRev;
  });

  /* ---------- 筛选 ---------- */

  it("列表按状态/复核人/截止时间筛选；逾期标记；复核人名单", async function () {
    const all = await request("GET", "/api/replay/spaces/" + spaceId + "/reviews");
    assert.equal(all.data.total, 3);
    // 未关闭在前、按截止时间升序
    assert.notEqual(all.data.reviews[0].status, "closed");

    const closed = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews?status=closed");
    assert.equal(closed.data.count, 1);
    assert.equal(closed.data.reviews[0].id, rvId);

    const byReviewer = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews?reviewer=" + encodeURIComponent("李四"));
    assert.equal(byReviewer.data.count, 1);
    assert.equal(byReviewer.data.reviews[0].reviewer, "李四");

    const futureOnly = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews", undefined);
    assert.ok(futureOnly.data.reviews.length >= 1);

    // 截止时间区间（未来很远的上界 -> 空）
    const none = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews?dueTo=2000-01-01T00:00:00Z");
    assert.equal(none.data.count, 0);

    // 非法筛选
    assert.equal((await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews?status=bogus")).status, 400);

    const reviewers = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/reviewers");
    assert.ok(reviewers.data.reviewers.indexOf("李四") !== -1);
    assert.ok(reviewers.data.reviewers.indexOf("王五") !== -1);
  });

  it("时间线事件挂复核标记（event 与 result 意见都能挂到对应事件），并响应复核筛选",
    async function () {
      const tl = await request("GET", "/api/replay/spaces/" + spaceId + "/timeline");
      assert.equal(tl.status, 200);
      const allEvents = [];
      tl.data.timeline.forEach(function (g) {
        g.events.forEach(function (e) { allEvents.push(e); });
      });
      const pub = allEvents.find(function (e) { return e.id === eventId; });
      assert.ok(pub.reviews.length >= 2, "发布事件应有两条意见（含关闭后重提）");
      const item = allEvents.find(function (e) { return e.id === itemEventId; });
      assert.equal(item.reviews.length, 1);
      assert.equal(item.reviews[0].reviewer, "李四");

      // 只看 closed 标记
      const tlClosed = await request("GET",
        "/api/replay/spaces/" + spaceId + "/timeline?rvStatus=closed");
      const closedEvents = [];
      tlClosed.data.timeline.forEach(function (g) {
        g.events.forEach(function (e) { closedEvents.push(e); });
      });
      const pub2 = closedEvents.find(function (e) { return e.id === eventId; });
      assert.equal(pub2.reviews.length, 1);
      assert.equal(pub2.reviews[0].status, "closed");
      const item2 = closedEvents.find(function (e) { return e.id === itemEventId; });
      assert.equal(item2.reviews.length, 0);
    });

  it("冲突汇总支持复核筛选参数（无冲突时结构仍正确）", async function () {
    const r = await request("GET",
      "/api/replay/spaces/" + spaceId + "/conflicts?rvStatus=open");
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.summary.counts, {});
    assert.ok(Array.isArray(r.data.summary.resultReviews));
  });

  /* ---------- 复核清单导出（只读） ---------- */

  it("清单导出：独立文档、含锁定目标与状态变化记录、只读不推 rev", async function () {
    const before = await request("GET", "/api/replay/spaces/" + spaceId);
    const revBefore = before.data.space.rev;
    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/export",
      { actor: "负责人", status: "" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.format, "bidi-replay-review-checklist");
    assert.equal(r.data.space.id, spaceId);
    assert.ok(r.data.space.contentHash);
    assert.equal(r.data.count, 3);
    const closedItem = r.data.reviews.find(function (x) { return x.id === rvId; });
    assert.equal(closedItem.status, "closed");
    assert.equal(closedItem.target.kind, "event");
    assert.equal(closedItem.target.event.id, eventId);
    assert.ok(closedItem.history.some(function (h) { return h.action === "close"; }));
    const resultItem = r.data.reviews.find(function (x) { return x.target.kind === "result"; });
    assert.equal(resultItem.target.result.annotationId, annotationId);

    const after = await request("GET", "/api/replay/spaces/" + spaceId);
    assert.equal(after.data.space.rev, revBefore, "导出不得推进空间版本");
    assert.equal(await drev(), decisionRevBeforeReviews, "导出不得触碰线上数据");
  });

  it("清单导出：?download=1 给附件头；筛选生效", async function () {
    const dl = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/export?download=1",
      { actor: "负责人" });
    assert.equal(dl.status, 200);
    assert.match(dl.disposition || "", /attachment/);
    assert.match(dl.disposition || "", /review-checklist/);

    const filtered = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/export",
      { status: "closed" });
    assert.equal(filtered.data.count, 1);
    assert.equal(filtered.data.filters.status, "closed");
  });

  it("清单导出参数非法时 400，且空间与意见不改变", async function () {
    const before = await request("GET", "/api/replay/spaces/" + spaceId);
    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/export",
      { status: "nope" });
    assert.equal(r.status, 400);
    const after = await request("GET", "/api/replay/spaces/" + spaceId);
    assert.equal(after.data.space.rev, before.data.space.rev);
    assert.equal(after.data.space.counts.reviews, before.data.space.counts.reviews);
  });

  /* ---------- 筛选条件持久化 + 重启恢复 ---------- */

  it("保存复核筛选条件（随空间持久化，旧版本 409）", async function () {
    const stale = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/view",
      { rvStatus: "open", rvReviewer: "李四" },
      { "If-Match": String(spaceRev - 1) });
    assert.equal(stale.status, 409);
    const ok = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/view",
      { rvStatus: "open", rvReviewer: "李四" },
      { "If-Match": String(spaceRev) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.view.rvStatus, "open");
    assert.equal(ok.data.view.rvReviewer, "李四");
    spaceRev = ok.data.spaceRev;

    // 列表无参数时回退到已保存筛选
    const list = await request("GET", "/api/replay/spaces/" + spaceId + "/reviews");
    assert.equal(list.data.count, 1);
    assert.equal(list.data.reviews[0].reviewer, "李四");

    // 非法复核筛选拒绝保存
    const bad = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/view",
      { rvStatus: "bogus" },
      { "If-Match": String(spaceRev) });
    assert.equal(bad.status, 400);
  });

  it("重启后：意见、版本、状态变化记录、已保存筛选全部恢复", async function () {
    await restartServer();
    const detail = await request("GET", "/api/replay/spaces/" + spaceId);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.space.rev, spaceRev);
    assert.equal(detail.data.space.view.rvStatus, "open");
    assert.equal(detail.data.space.view.rvReviewer, "李四");
    assert.equal(detail.data.space.counts.reviews, 3);

    const closedOne = detail.data.space.reviews.find(function (r) { return r.id === rvId; });
    assert.equal(closedOne.status, "closed");
    assert.equal(closedOne.version, 4);
    assert.equal(closedOne.closeReason, "证据与执行记录一致");

    // 记录恢复
    const logs = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId + "/logs");
    const actions = logs.data.logs.map(function (l) { return l.action; });
    assert.ok(actions.indexOf("create") !== -1);
    assert.ok(actions.indexOf("update") !== -1);
    assert.ok(actions.indexOf("reassign") !== -1);
    assert.ok(actions.indexOf("close") !== -1);

    // 恢复后关闭保护仍生效
    const edit = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rvId,
      { content: "重启后旧页面迟到提交" },
      { "If-Match": String(spaceRev), "X-Review-Version": "4" });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.error, "review_closed");

    // 已保存筛选仍生效
    const list = await request("GET", "/api/replay/spaces/" + spaceId + "/reviews");
    assert.equal(list.data.count, 1);
  });

  /* ---------- 隔离性 ---------- */

  it("复核全程不触碰线上动作：回放路径没有暂停/审批/执行入口；线上 rev 不变",
    async function () {
      for (const sub of ["pause", "approvals", "retry", "cancel", "continue"]) {
        const r = await request("POST",
          "/api/replay/spaces/" + spaceId + "/" + sub, { approver: "x" });
        assert.equal(r.status, 404);
      }
      assert.equal(await drev(), decisionRevBeforeReviews);
    });

  it("删除回放空间后意见一并消失（线上任务不受影响）", async function () {
    const r = await request("DELETE", "/api/replay/spaces/" + spaceId);
    assert.equal(r.status, 200);
    assert.equal((await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews")).status, 404);
    assert.equal((await request("GET", "/api/replay/spaces")).data.spaces.length, 0);
  });
});
