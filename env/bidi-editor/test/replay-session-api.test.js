/* node --test test/replay-session-api.test.js
 * 复核会话 HTTP 集成测试：真实启动 server.js（临时数据文件 + 随机端口），
 * 先走完整线上流程并导出/导入审计包、创建多条复核意见，然后覆盖：
 *   创建会话（锁定意见版本与引用摘要；空选集/重复加入/非法截止/缺参与人拒绝；
 *   缺 If-Match 428 / 旧空间版本 409）、
 *   提交结论（成功留痕与实时进度；缺 X-Session-Version 428 / 旧会话版本 409；
 *   非参与人 403；非法结论 400；会话外意见 404；重复结论 409）、
 *   冲突（意见已关闭/被会话外更新 -> 标记冲突并拒绝覆盖，意见不被改动）、
 *   过期会话拒绝提交、过期后意见可重新加入新会话、
 *   会话报告导出（只读不推 rev，失败不改变空间）、
 *   重启后会话/结论/冲突/记录恢复、
 *   会话路径无线上动作接口、删除空间级联移除会话。
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

const PORT = 8820 + Math.floor(Math.random() * 80);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "rs-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "rs-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "rs-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "rs-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(TMP, "rs-space-" + TAG + ".json")
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

const PARAS = [{ dir: "ltr", text: "中文示例文本内容用于复核会话" }];

describe("复核会话 API（顺序用例）", function () {
  let spaceId;
  let spaceRev;
  let evPublish, evAuto, evItem, evDone; // 四个可引用事件
  let executionId, annotationId;
  let decisionRevBefore;
  const rv = {}; // rv1..rv5 意见 id

  before(async function () { await startServer(); });
  after(async function () {
    await stopServer();
    for (const f of Object.values(FILES)) {
      for (const suffix of ["", ".tmp"]) {
        try { fs.unlinkSync(f + suffix); } catch (e) {}
      }
    }
  });

  async function addReview(target, reviewer) {
    const r = await request("POST", "/api/replay/spaces/" + spaceId + "/reviews",
      { target: target, reviewer: reviewer, content: "复核 " + reviewer,
        dueAt: new Date(Date.now() + 86400000).toISOString(), actor: "负责人" },
      { "If-Match": String(spaceRev) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    spaceRev = r.data.spaceRev;
    return r.data.review;
  }

  it("准备线上数据、导入回放空间并创建五条复核意见", async function () {
    // —— 线上：批注 → 批次 → 草案 → 投票 → 定时执行成功 ——
    const a1 = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": await annRev() });
    assert.equal(a1.status, 201);
    annotationId = a1.data.annotation.id;

    const batch = await request("POST", "/api/review-batches", {
      name: "会话批次", owner: "负责人",
      deadline: "2030-01-01T00:00:00Z", annotationIds: [annotationId]
    }, { "If-Match": await batchRev() });
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
    await sleep(300);
    decisionRevBefore = await drev();

    // —— 导出 + 导入 ——
    const ex = await request("POST", "/api/replay/export", { actor: "负责人", name: "会话审计包" });
    assert.equal(ex.status, 200, JSON.stringify(ex.data));
    const pkg = ex.data;
    evPublish = pkg.content.events.find(function (e) { return e.action === "task_publish"; }).id;
    evAuto = pkg.content.events.find(function (e) { return e.action === "task_auto_execute"; }).id;
    evItem = pkg.content.events.find(function (e) {
      return e.action.indexOf("_item_") !== -1 && !!e.annotationId;
    }).id;
    evDone = pkg.content.events.find(function (e) { return e.action === "task_succeeded"; }).id;
    executionId = pkg.content.executions[0].id;

    const imp = await request("POST", "/api/replay/import",
      Object.assign({ importedBy: "复核员" }, pkg));
    assert.equal(imp.status, 201, JSON.stringify(imp.data));
    spaceId = imp.data.space.id;
    spaceRev = imp.data.space.rev;
    assert.equal(imp.data.space.counts.sessions, 0);

    // —— 五条意见（五个不同锁定目标） ——
    rv.rv1 = (await addReview({ kind: "event", eventId: evPublish }, "张三")).id;
    rv.rv2 = (await addReview({ kind: "event", eventId: evAuto }, "李四")).id;
    rv.rv3 = (await addReview(
      { kind: "result", executionId: executionId, annotationId: annotationId }, "王五")).id;
    rv.rv4 = (await addReview({ kind: "event", eventId: evItem }, "赵六")).id;
    rv.rv5 = (await addReview({ kind: "event", eventId: evDone }, "钱七")).id;
  });

  /* ---------- 创建会话：校验 ---------- */

  it("创建校验：空选集/重复加入/空间外意见/缺截止/过去截止/非法截止/缺参与人/重复参与人",
    async function () {
      const base = {
        participants: ["张三", "李四"],
        deadline: new Date(Date.now() + 3600000).toISOString(),
        reviewIds: [rv.rv1, rv.rv2], actor: "负责人"
      };
      async function post(mut, headers) {
        return request("POST", "/api/replay/spaces/" + spaceId + "/sessions",
          Object.assign({}, base, mut),
          headers || { "If-Match": String(spaceRev) });
      }
      const empty = await post({ reviewIds: [] });
      assert.equal(empty.status, 400);
      assert.equal(empty.data.error, "empty_selection");

      const dup = await post({ reviewIds: [rv.rv1, rv.rv1] });
      assert.equal(dup.status, 409);
      assert.equal(dup.data.error, "duplicate_review_id");

      const ghost = await post({ reviewIds: [rv.rv1, "ghost"] });
      assert.equal(ghost.status, 404);
      assert.equal(ghost.data.error, "review_not_found");

      assert.equal((await post({ deadline: null })).status, 400);
      assert.equal((await post({ deadline: null })).data.error, "missing_deadline");
      const badDate = await post({ deadline: "not-a-date" });
      assert.equal(badDate.status, 400);
      assert.equal(badDate.data.error, "invalid_deadline");
      const past = await post({ deadline: "2000-01-01T00:00:00Z" });
      assert.equal(past.status, 400);
      assert.equal(past.data.error, "deadline_in_past");

      const noPart = await post({ participants: [] });
      assert.equal(noPart.status, 400);
      assert.equal(noPart.data.error, "missing_participant");
      const dupPart = await post({ participants: ["张三", "张三"] });
      assert.equal(dupPart.status, 400);
      assert.equal(dupPart.data.error, "duplicate_participant");

      // 并发：缺 If-Match 428、旧空间版本 409，且均未写入
      const noLock = await request("POST",
        "/api/replay/spaces/" + spaceId + "/sessions", base);
      assert.equal(noLock.status, 428);
      const stale = await post({}, { "If-Match": String(spaceRev - 1) });
      assert.equal(stale.status, 409);
      assert.equal(stale.data.error, "version_conflict");

      const list = await request("GET", "/api/replay/spaces/" + spaceId + "/sessions");
      assert.equal(list.data.count, 0, "全部拒绝后不应有任何会话");
    });

  let sessionA;
  it("创建会话成功：锁定意见版本与引用摘要，create 留痕", async function () {
    const r = await request("POST", "/api/replay/spaces/" + spaceId + "/sessions", {
      name: "九月集中复核",
      participants: ["张三", "李四"],
      deadline: new Date(Date.now() + 3600000).toISOString(),
      reviewIds: [rv.rv1, rv.rv2, rv.rv3],
      filters: { status: "open" },
      actor: "负责人"
    }, { "If-Match": String(spaceRev) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    sessionA = r.data.session;
    assert.equal(sessionA.version, 1);
    assert.equal(sessionA.name, "九月集中复核");
    assert.deepEqual(sessionA.participants, ["张三", "李四"]);
    assert.equal(sessionA.items.length, 3);
    // 锁定：版本与引用摘要
    const it1 = sessionA.items.find(function (i) { return i.reviewId === rv.rv1; });
    assert.equal(it1.lockedVersion, 1);
    assert.equal(it1.targetSummary.kind, "event");
    assert.equal(it1.targetSummary.event.id, evPublish);
    const it3 = sessionA.items.find(function (i) { return i.reviewId === rv.rv3; });
    assert.equal(it3.targetSummary.kind, "result");
    assert.equal(it3.targetSummary.result.annotationId, annotationId);
    // 实时进度：0 完成 0 冲突
    assert.equal(sessionA.progress.total, 3);
    assert.equal(sessionA.progress.concluded, 0);
    assert.equal(sessionA.progress.conflicts, 0);
    assert.equal(sessionA.progress.expired, false);
    spaceRev = r.data.spaceRev;

    const logs = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/logs");
    assert.equal(logs.data.logs.length, 1);
    assert.equal(logs.data.logs[0].action, "create");
    assert.equal(logs.data.logs[0].detail.reviewIds.length, 3);
  });

  it("重复加入：意见已在未过期会话中 -> 409 already_in_session", async function () {
    const r = await request("POST", "/api/replay/spaces/" + spaceId + "/sessions", {
      participants: ["王五"],
      deadline: new Date(Date.now() + 3600000).toISOString(),
      reviewIds: [rv.rv1, rv.rv4], actor: "负责人"
    }, { "If-Match": String(spaceRev) });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "already_in_session");
    assert.equal(r.data.existingSessionId, sessionA.id);
    assert.equal(r.data.reviewId, rv.rv1);
    // 整次拒绝，未创建任何会话
    const list = await request("GET", "/api/replay/spaces/" + spaceId + "/sessions");
    assert.equal(list.data.count, 1);
  });

  /* ---------- 提交结论 ---------- */

  it("提交结论：双重版本检查（428 缺会话版本 / 409 旧会话版本 / 旧空间版本）",
    async function () {
      const url = "/api/replay/spaces/" + spaceId + "/sessions/" +
        sessionA.id + "/conclusions";
      const body = { reviewId: rv.rv1, result: "confirm", note: "证据一致", actor: "张三" };

      const noVer = await request("POST", url, body,
        { "If-Match": String(spaceRev) });
      assert.equal(noVer.status, 428);
      assert.match(noVer.data.message, /X-Session-Version/);

      const staleVer = await request("POST", url, body,
        { "If-Match": String(spaceRev), "X-Session-Version": "999" });
      assert.equal(staleVer.status, 409);
      assert.equal(staleVer.data.error, "session_version_conflict");
      assert.equal(staleVer.data.currentVersion, 1);

      const staleSpace = await request("POST", url, body,
        { "If-Match": String(spaceRev - 1), "X-Session-Version": "1" });
      assert.equal(staleSpace.status, 409);
      assert.equal(staleSpace.data.error, "version_conflict");

      // 均未写入
      const detail = await request("GET",
        "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id);
      assert.equal(detail.data.session.progress.concluded, 0);
    });

  it("提交结论成功：进度实时更新、版本推进、conclusion 留痕", async function () {
    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/conclusions",
      { reviewId: rv.rv1, result: "confirm", note: "证据一致", actor: "张三" },
      { "If-Match": String(spaceRev), "X-Session-Version": "1" });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const s = r.data.session;
    assert.equal(s.version, 2);
    assert.equal(s.progress.concluded, 1);
    assert.equal(s.progress.percent, 33);
    const it1 = s.items.find(function (i) { return i.reviewId === rv.rv1; });
    assert.equal(it1.conclusion.result, "confirm");
    assert.equal(it1.conclusion.by, "张三");
    assert.equal(it1.conclusion.note, "证据一致");
    assert.equal(it1.conclusion.reviewVersion, 1);
    spaceRev = r.data.spaceRev;

    const logs = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/logs");
    assert.ok(logs.data.logs.some(function (l) { return l.action === "conclusion"; }));
    // 时间倒序
    for (let i = 1; i < logs.data.logs.length; i++) {
      assert.ok(Date.parse(logs.data.logs[i - 1].at) >= Date.parse(logs.data.logs[i].at));
    }
  });

  it("重复结论 409 / 非参与人 403 / 非法结论 400 / 会话外意见 404 / 备注超长 413",
    async function () {
      const url = "/api/replay/spaces/" + spaceId + "/sessions/" +
        sessionA.id + "/conclusions";
      function post(body, ver) {
        return request("POST", url, body,
          { "If-Match": String(spaceRev), "X-Session-Version": String(ver) });
      }
      const dup = await post({ reviewId: rv.rv1, result: "reject", actor: "李四" }, 2);
      assert.equal(dup.status, 409);
      assert.equal(dup.data.error, "conclusion_exists");

      const outsider = await post({ reviewId: rv.rv2, result: "confirm", actor: "外人" }, 2);
      assert.equal(outsider.status, 403);
      assert.equal(outsider.data.error, "not_participant");

      const badResult = await post({ reviewId: rv.rv2, result: "maybe", actor: "李四" }, 2);
      assert.equal(badResult.status, 400);
      assert.equal(badResult.data.error, "invalid_result");

      const notInSession = await post(
        { reviewId: rv.rv4, result: "confirm", actor: "李四" }, 2);
      assert.equal(notInSession.status, 404);
      assert.equal(notInSession.data.error, "session_item_not_found");

      const longNote = await post(
        { reviewId: rv.rv2, result: "confirm", actor: "李四", note: "n".repeat(1001) }, 2);
      assert.equal(longNote.status, 413);
      assert.equal(longNote.data.error, "note_too_large");

      // 均未改变进度
      const detail = await request("GET",
        "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id);
      assert.equal(detail.data.session.progress.concluded, 1);
      assert.equal(await drev(), decisionRevBefore, "会话操作不得触碰线上 rev");
    });

  /* ---------- 冲突：标记并拒绝覆盖 ---------- */

  it("意见被会话外关闭 -> 提交结论标记 review_closed 冲突并拒绝覆盖", async function () {
    // 会话外关闭 rv2（走复核意见自身的关闭接口）
    const rv2 = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rv.rv2);
    const close = await request("POST",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rv.rv2 + "/close",
      { reason: "会话外直接关闭", actor: "负责人" },
      { "If-Match": String(spaceRev), "X-Review-Version": String(rv2.data.review.version) });
    assert.equal(close.status, 200, JSON.stringify(close.data));
    spaceRev = close.data.spaceRev;

    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/conclusions",
      { reviewId: rv.rv2, result: "confirm", note: "想确认", actor: "李四" },
      { "If-Match": String(spaceRev), "X-Session-Version": "2" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "session_item_conflict");
    assert.equal(r.data.conflict.code, "review_closed");

    // 冲突已持久化标记：详情可见、进度冲突数 +1、结论未写入
    const detail = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id);
    const it2 = detail.data.session.items.find(function (i) { return i.reviewId === rv.rv2; });
    assert.ok(it2.conflict);
    assert.equal(it2.conflict.code, "review_closed");
    assert.equal(it2.conclusion, null);
    assert.equal(detail.data.session.progress.conflicts, 1);
    assert.equal(detail.data.session.progress.concluded, 1);
    spaceRev = detail.data.spaceRev;
    sessionA = detail.data.session;

    // 意见本身未被会话覆盖（仍是会话外关闭的样子）
    const rv2After = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rv.rv2);
    assert.equal(rv2After.data.review.status, "closed");
    assert.equal(rv2After.data.review.closeReason, "会话外直接关闭");

    // 冲突留痕
    const logs = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/logs");
    assert.ok(logs.data.logs.some(function (l) {
      return l.action === "conflict" && l.reviewId === rv.rv2;
    }));
  });

  it("意见被会话外更新 -> 提交结论标记 updated_outside 冲突并拒绝覆盖", async function () {
    // 会话外修改 rv3（版本 1 -> 2）
    const rv3 = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rv.rv3);
    const upd = await request("PUT",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rv.rv3,
      { content: "会话外改写了内容", actor: "负责人" },
      { "If-Match": String(spaceRev), "X-Review-Version": String(rv3.data.review.version) });
    assert.equal(upd.status, 200, JSON.stringify(upd.data));
    spaceRev = upd.data.spaceRev;

    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/conclusions",
      { reviewId: rv.rv3, result: "need_evidence", note: "需要更多日志", actor: "张三" },
      { "If-Match": String(spaceRev), "X-Session-Version": String(sessionA.version) });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "session_item_conflict");
    assert.equal(r.data.conflict.code, "updated_outside");

    const detail = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id);
    const it3 = detail.data.session.items.find(function (i) { return i.reviewId === rv.rv3; });
    assert.equal(it3.conflict.code, "updated_outside");
    assert.equal(it3.conclusion, null);
    assert.equal(detail.data.session.progress.conflicts, 2);
    spaceRev = detail.data.spaceRev;
    sessionA = detail.data.session;

    // 意见内容仍是会话外改写后的样子，未被结论覆盖
    const rv3After = await request("GET",
      "/api/replay/spaces/" + spaceId + "/reviews/" + rv.rv3);
    assert.equal(rv3After.data.review.content, "会话外改写了内容");
  });

  it("会话列表实时显示完成进度与冲突数量", async function () {
    const list = await request("GET", "/api/replay/spaces/" + spaceId + "/sessions");
    assert.equal(list.status, 200);
    const a = list.data.sessions.find(function (s) { return s.id === sessionA.id; });
    assert.equal(a.progress.total, 3);
    assert.equal(a.progress.concluded, 1);
    assert.equal(a.progress.conflicts, 2);
    assert.equal(a.progress.pending, 0);
  });

  /* ---------- 过期会话 ---------- */

  let sessionC;
  it("过期会话明确拒绝提交；过期后意见可重新加入新会话", async function () {
    // 先建一个正常会话 B（rv4），再建短寿命会话 C（rv5）
    const b = await request("POST", "/api/replay/spaces/" + spaceId + "/sessions", {
      name: "会话B", participants: ["王五"],
      deadline: new Date(Date.now() + 3600000).toISOString(),
      reviewIds: [rv.rv4], actor: "负责人"
    }, { "If-Match": String(spaceRev) });
    assert.equal(b.status, 201, JSON.stringify(b.data));
    spaceRev = b.data.spaceRev;

    const c = await request("POST", "/api/replay/spaces/" + spaceId + "/sessions", {
      name: "会话C", participants: ["钱七"],
      deadline: new Date(Date.now() + 500).toISOString(),
      reviewIds: [rv.rv5], actor: "负责人"
    }, { "If-Match": String(spaceRev) });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    sessionC = c.data.session;
    spaceRev = c.data.spaceRev;

    await sleep(700); // 等会话 C 过期

    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionC.id + "/conclusions",
      { reviewId: rv.rv5, result: "confirm", actor: "钱七" },
      { "If-Match": String(spaceRev), "X-Session-Version": "1" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "session_expired");

    // 过期会话详情仍可读，进度显示已过期
    const detail = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionC.id);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.session.progress.expired, true);
    assert.equal(detail.data.session.progress.concluded, 0);

    // 过期会话不阻塞意见重新加入新会话
    const d = await request("POST", "/api/replay/spaces/" + spaceId + "/sessions", {
      name: "会话D", participants: ["钱七"],
      deadline: new Date(Date.now() + 3600000).toISOString(),
      reviewIds: [rv.rv5], actor: "负责人"
    }, { "If-Match": String(spaceRev) });
    assert.equal(d.status, 201, JSON.stringify(d.data));
    spaceRev = d.data.spaceRev;
  });

  /* ---------- 会话报告导出（纯只读） ---------- */

  it("报告导出：独立文档含进度/结论/冲突/记录，只读不推任何 rev", async function () {
    const before = await request("GET", "/api/replay/spaces/" + spaceId);
    const revBefore = before.data.space.rev;
    const r = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/report",
      { actor: "负责人" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.format, "bidi-replay-review-session-report");
    assert.equal(r.data.space.id, spaceId);
    assert.ok(r.data.space.contentHash);
    assert.equal(r.data.session.id, sessionA.id);
    assert.equal(r.data.session.progress.concluded, 1);
    assert.equal(r.data.session.progress.conflicts, 2);
    const item1 = r.data.session.items.find(function (i) { return i.reviewId === rv.rv1; });
    assert.equal(item1.conclusion.result, "confirm");
    assert.equal(item1.conclusion.resultLabel, "确认");
    assert.equal(item1.targetSummary.event.id, evPublish);
    const item2 = r.data.session.items.find(function (i) { return i.reviewId === rv.rv2; });
    assert.equal(item2.conflict.code, "review_closed");
    assert.equal(item2.current.status, "closed");
    assert.ok(r.data.logs.some(function (l) { return l.action === "create"; }));
    assert.ok(r.data.logs.some(function (l) { return l.action === "conflict"; }));

    const after = await request("GET", "/api/replay/spaces/" + spaceId);
    assert.equal(after.data.space.rev, revBefore, "导出不得推进空间版本");
    const sAfter = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id);
    assert.equal(sAfter.data.session.version, sessionA.version, "导出不得推进会话版本");
    assert.equal(sAfter.data.session.progress.concluded, 1, "导出不得改变会话进度");
    assert.equal(await drev(), decisionRevBefore, "导出不得触碰线上数据");
  });

  it("报告导出：?download=1 给附件头；不存在的会话 404 且不改变空间", async function () {
    const dl = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/report?download=1",
      { actor: "负责人" });
    assert.equal(dl.status, 200);
    assert.match(dl.disposition || "", /attachment/);
    assert.match(dl.disposition || "", /review-session/);

    const before = await request("GET", "/api/replay/spaces/" + spaceId);
    const ghost = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/no-such-session/report",
      { actor: "负责人" });
    assert.equal(ghost.status, 404);
    const after = await request("GET", "/api/replay/spaces/" + spaceId);
    assert.equal(after.data.space.rev, before.data.space.rev);
    assert.equal(after.data.space.counts.sessions, before.data.space.counts.sessions);
  });

  /* ---------- 重启恢复 ---------- */

  it("重启后：会话、结论、冲突标记与操作记录全部恢复，可继续处理", async function () {
    await restartServer();
    const detail = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id);
    assert.equal(detail.status, 200);
    const s = detail.data.session;
    assert.equal(s.version, sessionA.version);
    assert.equal(s.items.length, 3);
    const it1 = s.items.find(function (i) { return i.reviewId === rv.rv1; });
    assert.equal(it1.conclusion.result, "confirm");
    const it2 = s.items.find(function (i) { return i.reviewId === rv.rv2; });
    assert.equal(it2.conflict.code, "review_closed");
    assert.equal(s.progress.concluded, 1);
    assert.equal(s.progress.conflicts, 2);
    spaceRev = detail.data.spaceRev;

    const logs = await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/logs");
    const actions = logs.data.logs.map(function (l) { return l.action; });
    assert.ok(actions.indexOf("create") !== -1);
    assert.ok(actions.indexOf("conclusion") !== -1);
    assert.ok(actions.indexOf("conflict") !== -1);

    // 版本检查仍生效：缺会话版本 428、重复结论 409
    const noVer = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/conclusions",
      { reviewId: rv.rv1, result: "reject", actor: "张三" },
      { "If-Match": String(spaceRev) });
    assert.equal(noVer.status, 428);
    const dup = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/conclusions",
      { reviewId: rv.rv1, result: "reject", actor: "张三" },
      { "If-Match": String(spaceRev), "X-Session-Version": String(s.version) });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error, "conclusion_exists");

    // 过期会话 C 重启后仍然拒绝提交
    const expired = await request("POST",
      "/api/replay/spaces/" + spaceId + "/sessions/" + sessionC.id + "/conclusions",
      { reviewId: rv.rv5, result: "confirm", actor: "钱七" },
      { "If-Match": String(spaceRev), "X-Session-Version": "1" });
    assert.equal(expired.status, 409);
    assert.equal(expired.data.error, "session_expired");
  });

  /* ---------- 隔离性 ---------- */

  it("会话路径没有任何线上动作接口；线上 rev 全程不变", async function () {
    for (const sub of ["pause", "resume", "cancel", "retry", "approvals", "continue"]) {
      const r = await request("POST",
        "/api/replay/spaces/" + spaceId + "/sessions/" + sessionA.id + "/" + sub,
        { approver: "x" },
        { "If-Match": String(spaceRev), "X-Session-Version": "1" });
      assert.equal(r.status, 404, sub);
    }
    assert.equal(await drev(), decisionRevBefore);
  });

  it("删除回放空间后会话一并消失（线上任务不受影响）", async function () {
    const r = await request("DELETE", "/api/replay/spaces/" + spaceId);
    assert.equal(r.status, 200);
    assert.equal((await request("GET",
      "/api/replay/spaces/" + spaceId + "/sessions")).status, 404);
    assert.equal((await request("GET", "/api/replay/spaces")).data.spaces.length, 0);
    assert.equal(await drev(), decisionRevBefore);
  });
});
