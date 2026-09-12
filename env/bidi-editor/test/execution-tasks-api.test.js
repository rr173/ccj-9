/* node --test test/execution-tasks-api.test.js
 * 决策发布与定时执行（执行队列）HTTP 集成测试：真实启动 server.js
 * （临时数据文件 + 随机端口 + 100ms 调度间隔），覆盖：
 *   发布校验（缺生效时间/过去时间/非待执行草案/重复发布/晚于截止/版本冲突）、
 *   发布锁定文本批注批次版本、暂停/恢复/取消、到点自动执行、自动快照关联、
 *   逐条冲突的部分成功、失败重试幂等（成功条目不重复处理）、重锁重试成功、
 *   服务重启后错过任务的补执行与未来任务保持等待、排期后草案锁定不可修改、
 *   队列记录按时间筛选、快照嵌入执行队列。
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

const PORT = 8710 + Math.floor(Math.random() * 180);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "task-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "task-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "task-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "task-dec-" + TAG + ".json")
};

let server;

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: FILES.SNAP_DATA,
      ANNOTATIONS_FILE: FILES.ANN_DATA,
      REVIEW_BATCHES_FILE: FILES.BATCH_DATA,
      REVIEW_DECISIONS_FILE: FILES.DEC_DATA,
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
      const req = http.get(BASE + "/api/execution-tasks", function (res) {
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

describe("决策定时执行队列 API（顺序用例）", function () {
  before(async function () { await startServer(); });
  after(async function () {
    await stopServer();
    for (const f of Object.values(FILES)) {
      for (const suffix of ["", ".tmp"]) {
        try { fs.unlinkSync(f + suffix); } catch (e) {}
      }
    }
  });

  function request(method, urlPath, body, headers) {
    return new Promise(function (resolve) {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const h = { "Accept": "application/json" };
      if (payload) Object.assign(h,
        { "Content-Type": "application/json", "Content-Length": payload.length });
      if (method !== "GET" && headers) Object.assign(h, headers);
      const req = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) {}
          resolve({
            status: res.statusCode, data: data,
            drev: res.headers["x-decision-rev"],
            annRev: res.headers["x-annotation-rev"],
            batchRev: res.headers["x-batch-rev"]
          });
        });
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function drev() { return (await request("GET", "/api/review-decisions")).drev; }
  async function arev() { return (await request("GET", "/api/annotations")).annRev; }
  async function brev() { return (await request("GET", "/api/review-batches")).batchRev; }

  let annSeq = 0;
  async function createAnn(ov) {
    const r = await request("POST", "/api/annotations",
      Object.assign({
        author: "审阅者", body: "b" + annSeq++,
        paraIndex: 0, start: 0, end: 2, quote: "中文", paraDir: "ltr"
      }, ov || {}),
      { "If-Match": await arev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.annotation;
  }
  async function createBatch(ids, name, deadline) {
    const r = await request("POST", "/api/review-batches", {
      name: name || "批" + annSeq, owner: "负责人",
      deadline: deadline || "2030-01-01T00:00:00Z",
      annotationIds: ids
    }, { "If-Match": await brev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.batch;
  }
  const PARAS = [{ dir: "ltr", text: "中文示例文本" }];
  async function createDecision(batchId, ids) {
    const items = (ids || []).map(function (id) {
      return { annotationId: id, disposition: "delete" };
    });
    const r = await request("POST", "/api/review-decisions", {
      batchId: batchId, threshold: 1,
      // 多条目时段落要覆盖所有 quote；具体方案由 readyDecision 重写
      paragraphs: PARAS, items: items
    }, { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.decision;
  }
  async function readyDecision(did, ids) {
    let r = await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: ids.map(function (id, i) {
          return i === 0 && ids.length > 1
            ? { annotationId: id, disposition: "replace", replacement: "英文" }
            : { annotationId: id, disposition: "delete" };
        }), actor: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await request("POST", "/api/review-decisions/" + did + "/submit",
      { actor: "甲" }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    for (const id of ids) {
      r = await request("POST", "/api/review-decisions/" + did + "/votes",
        { annotationId: id, vote: "approve", voter: "甲" },
        { "If-Match": await drev() });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    const detail = await request("GET", "/api/review-decisions/" + did);
    assert.equal(detail.data.decision.status, "ready");
  }
  async function publish(decisionId, paras, whenMs, actor) {
    return request("POST", "/api/execution-tasks", {
      decisionId: decisionId,
      scheduledAt: new Date(whenMs || (Date.now() + 700)).toISOString(),
      paragraphs: paras || PARAS,
      actor: actor || "负责人"
    }, { "If-Match": await drev() });
  }
  async function waitTask(tid, terminal, timeout) {
    const end = Date.now() + (timeout || 6000);
    while (Date.now() < end) {
      const r = await request("GET", "/api/execution-tasks/" + tid);
      const t = r.data.task;
      if (terminal ? terminal.indexOf(t.status) !== -1 : t.finishedAt) return t;
      await sleep(120);
    }
    const last = await request("GET", "/api/execution-tasks/" + tid);
    throw new Error("task not terminal in time: " + JSON.stringify(last.data.task));
  }

  /* ---------- 基础数据 ---------- */

  let a1, a2, batch, did;
  it("准备两条批注、一个批次和一个 ready 草案", async function () {
    a1 = await createAnn({ start: 0, end: 2, quote: "中文", body: "m1" });
    a2 = await createAnn({ start: 2, end: 4, quote: "示例", body: "m2" });
    batch = await createBatch([a1.id, a2.id], "队列批次");
    const d = await createDecision(batch.id, []);
    did = d.id;
    await readyDecision(did, [a1.id, a2.id]);
  });

  /* ---------- 发布校验 ---------- */

  it("发布：缺 If-Match 428；旧版本 409", async function () {
    const noLock = await request("POST", "/api/execution-tasks", {
      decisionId: did, scheduledAt: new Date(Date.now() + 1000).toISOString(),
      paragraphs: PARAS
    });
    assert.equal(noLock.status, 428);
    const stale = await request("POST", "/api/execution-tasks", {
      decisionId: did, scheduledAt: new Date(Date.now() + 1000).toISOString(),
      paragraphs: PARAS
    }, { "If-Match": "9999" });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, "version_conflict");
  });

  it("发布：缺生效时间 / 过去时间 / 非法时间 明确拒绝", async function () {
    const rev = await drev();
    let r = await request("POST", "/api/execution-tasks",
      { decisionId: did, paragraphs: PARAS }, { "If-Match": rev });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "missing_scheduled_at");
    r = await request("POST", "/api/execution-tasks",
      { decisionId: did, scheduledAt: new Date(Date.now() - 1000).toISOString(),
        paragraphs: PARAS }, { "If-Match": rev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "scheduled_at_in_past");
    r = await request("POST", "/api/execution-tasks",
      { decisionId: did, scheduledAt: "not-a-date", paragraphs: PARAS },
      { "If-Match": rev });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "invalid_scheduled_at");
    // 校验失败不推进版本
    assert.equal(await drev(), rev);
  });

  it("发布：生效时间晚于批次截止被拒绝", async function () {
    const r = await request("POST", "/api/execution-tasks", {
      decisionId: did,
      scheduledAt: "2031-06-01T00:00:00Z",
      paragraphs: PARAS
    }, { "If-Match": await drev() });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "scheduled_after_deadline");
  });

  it("非待执行草案不能发布：drafting 草案 409 decision_not_ready", async function () {
    const x = await createAnn({ body: "x" });
    const bx = await createBatch([x.id], "另一批次");
    const dd = await createDecision(bx.id, []);
    const r = await publish(dd.id);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "decision_not_ready");
  });

  it("正常发布：任务 scheduled、草案 scheduled、锁定版本", async function () {
    const r = await publish(did, PARAS, Date.now() + 900);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.task.status, "scheduled");
    assert.equal(r.data.decision.status, "scheduled");
    assert.ok(r.data.task.lock.textRev.length === 16);
    assert.equal(r.data.task.lock.paragraphCount, 1);
    assert.ok(r.data.task.scheduledAtMs > Date.now());
  });

  it("重复发布：task_already_scheduled", async function () {
    const r = await publish(did);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "task_already_scheduled");
    assert.ok(r.data.existingTaskId);
  });

  it("排期后草案锁定：改方案/投票/手动执行全部 409 decision_scheduled", async function () {
    const rev = await drev();
    let r = await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: [{ annotationId: a1.id, disposition: "keep" }] },
      { "If-Match": rev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "decision_scheduled");
    r = await request("POST", "/api/review-decisions/" + did + "/votes",
      { annotationId: a1.id, vote: "reject", voter: "乙" },
      { "If-Match": await drev() });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "decision_scheduled");
    r = await request("POST", "/api/review-decisions/" + did + "/execute",
      { paragraphs: PARAS, actor: "甲" }, { "If-Match": await drev() });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "decision_scheduled");
  });

  /* ---------- 暂停 / 恢复 / 取消 ---------- */

  let tid;
  it("暂停：到点前暂停，任务保持 paused 不执行；重复暂停 409", async function () {
    const list = await request("GET", "/api/execution-tasks?status=scheduled");
    tid = list.data.tasks[0].id;
    const r = await request("POST", "/api/execution-tasks/" + tid + "/pause",
      { actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 200);
    assert.equal(r.data.task.status, "paused");
    assert.ok(r.data.task.pausedAt);
    const again = await request("POST", "/api/execution-tasks/" + tid + "/pause",
      {}, { "If-Match": await drev() });
    assert.equal(again.status, 409);
    await sleep(1200); // 原计划时间已过
    const t = (await request("GET", "/api/execution-tasks/" + tid)).data.task;
    assert.equal(t.status, "paused", "暂停后不能到点自动执行");
  });

  it("恢复：不填时间且原时间已过 → 立即执行；任务成功并自动快照", async function () {
    const r = await request("POST", "/api/execution-tasks/" + tid + "/resume",
      { actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.task.status, "scheduled");
    const t = await waitTask(tid, ["succeeded", "partial", "failed"]);
    assert.equal(t.status, "succeeded");
    assert.equal(t.lastCounts.success, 2);
    assert.ok(t.snapshotId, "自动执行应保存关联快照");
    const detail = await request("GET", "/api/review-decisions/" + did);
    assert.equal(detail.data.decision.status, "executed");
    const ex = detail.data.executions[detail.data.executions.length - 1];
    assert.equal(ex.trigger, "scheduled");
    assert.ok(ex.taskId === tid);
  });

  it("成功任务不能重试、不能暂停/取消", async function () {
    const rev = await drev();
    let r = await request("POST", "/api/execution-tasks/" + tid + "/retry",
      {}, { "If-Match": rev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "task_succeeded");
    r = await request("POST", "/api/execution-tasks/" + tid + "/cancel",
      {}, { "If-Match": await drev() });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "task_not_cancellable");
  });

  /* ---------- 取消后草案回到 ready ---------- */

  let a3, batch2, did2, tid2;
  it("取消尚未开始的任务：草案回到 ready，可手动执行", async function () {
    a3 = await createAnn({ start: 0, end: 1, quote: "中", body: "m3" });
    batch2 = await createBatch([a3.id], "取消批次");
    const d = await createDecision(batch2.id, []);
    did2 = d.id;
    await readyDecision(did2, [a3.id]);
    const pub = await publish(did2, [{ dir: "ltr", text: "中文" }],
      Date.now() + 3600 * 1000);
    assert.equal(pub.status, 201);
    tid2 = pub.data.task.id;
    const r = await request("POST", "/api/execution-tasks/" + tid2 + "/cancel",
      { reason: "暂缓", actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 200);
    assert.equal(r.data.task.status, "cancelled");
    assert.equal(r.data.decision.status, "ready");
    // 已取消不能恢复/重试/再取消
    for (const sub of ["resume", "retry", "cancel"]) {
      const rr = await request("POST", "/api/execution-tasks/" + tid2 + "/" + sub,
        {}, { "If-Match": await drev() });
      assert.equal(rr.status, 409, sub);
    }
  });

  /* ---------- 部分成功 + 幂等重试 ---------- */

  let a4, a5, batch3, did3, tid3;
  it("自动执行遇到批注版本变化：只把冲突条目标冲突，其余成功（部分成功）", async function () {
    a4 = await createAnn({ start: 0, end: 2, quote: "中文", body: "m4" });
    a5 = await createAnn({ start: 2, end: 4, quote: "示例", body: "m5" });
    batch3 = await createBatch([a4.id, a5.id], "冲突批次");
    const d = await createDecision(batch3.id, []);
    did3 = d.id;
    await readyDecision(did3, [a4.id, a5.id]);
    const pub = await publish(did3, PARAS, Date.now() + 500);
    assert.equal(pub.status, 201);
    tid3 = pub.data.task.id;
    // 生效前把 a4 改成处理中 → a4 冲突 annotation_changed；a5 成功
    await sleep(150);
    await request("PUT", "/api/annotations/" + a4.id,
      { status: "in_progress", actor: "别人" }, { "If-Match": await arev() });
    const t = await waitTask(tid3, ["partial", "failed", "succeeded"]);
    assert.equal(t.status, "partial");
    assert.equal(t.lastCounts.success, 1);
    assert.equal(t.lastCounts.conflict, 1);
    assert.deepEqual(t.successAnnotationIds, [a5.id]);
    assert.ok(t.snapshotId, "部分成功也保存快照");
    // 成功批注 a5 已解决；冲突批注 a4 保留别人的状态
    const anns = Object.fromEntries(
      (await request("GET", "/api/annotations")).data.annotations.map(function (x) {
        return [x.id, x];
      }));
    assert.equal(anns[a5.id].status, "resolved");
    assert.equal(anns[a4.id].status, "in_progress");
    // 草案回到 ready 允许重试
    assert.equal((await request("GET", "/api/review-decisions/" + did3)).data.decision.status,
      "ready");
  });

  it("普通失败重试（沿用发布锁）：冲突依旧，已成功条目幂等跳过，不重复解决", async function () {
    const attemptsBefore = (await request("GET", "/api/execution-tasks/" + tid3)).data.task.attempts.length;
    const r = await request("POST", "/api/execution-tasks/" + tid3 + "/retry",
      { actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // 立即重试可能在响应返回前就已被调度器执行完，故 scheduled/partial 都合法
    assert.ok(["scheduled", "partial"].indexOf(r.data.task.status) !== -1, r.data.task.status);
    const t = await waitTask(tid3, ["partial", "failed", "succeeded"]);
    assert.equal(t.status, "partial");
    assert.ok(t.attempts.length > attemptsBefore, "应留下重试尝试记录");
    assert.equal(t.lastCounts.success, 0, "本次没有新成功条目");
    assert.equal(t.lastCounts.conflict, 1);
    assert.equal(t.lastCounts.skipped, 1, "已成功条目幂等跳过");
    assert.deepEqual(t.successAnnotationIds, [a5.id]);
    // 执行记录里 a5 只成功过一次
    const logs = (await request("GET", "/api/review-decisions/" + did3 + "/logs")).data.logs;
    const a5Success = logs.filter(function (l) {
      return l.annotationId === a5.id &&
        (l.action === "task_auto_execute_item_success" ||
         l.action === "task_retry_execute_item_success");
    });
    assert.equal(a5Success.length, 1, "a5 只能有一次成功记录");
  });

  it("重锁重试：用当前文本/版本重新锁定后，剩余条目成功，任务全部成功", async function () {
    // 上一步是“立即重试”，可能尚在执行；先等其回到 partial 终态
    await waitTask(tid3, ["partial", "failed", "succeeded"]);
    // a4 仍 in_progress 且 quote 未动；重锁时把批注版本基线推进到当前，
    // 文本基线改为当前（“中文文本”，因为 a5 删除后锁定文本已含该变化）。
    const r = await request("POST", "/api/execution-tasks/" + tid3 + "/retry", {
      actor: "负责人",
      paragraphs: [{ dir: "ltr", text: "中文文本" }]
    }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = await waitTask(tid3, ["succeeded", "partial", "failed"]);
    assert.equal(t.status, "succeeded");
    assert.equal(t.lastCounts.success, 1, "a4 本次成功");
    assert.equal(t.lastCounts.skipped, 1, "a5 幂等跳过");
    assert.equal(t.successAnnotationIds.length, 2);
    const anns = Object.fromEntries(
      (await request("GET", "/api/annotations")).data.annotations.map(function (x) {
        return [x.id, x];
      }));
    assert.equal(anns[a4.id].status, "resolved");
    assert.equal(anns[a4.id].resolvedBy, "系统定时执行");
  });

  /* ---------- 队列记录与快照嵌入 ---------- */

  it("队列记录可按时间筛选，覆盖发布/暂停/恢复/自动执行/重试全流程", async function () {
    // tid3：发布 → 自动执行（部分成功）→ 普通重试 → 重锁重试（全部成功）
    const all = await request("GET", "/api/execution-tasks/" + tid3 + "/logs");
    const actions = all.data.logs.map(function (l) { return l.action; });
    ["task_publish", "task_auto_execute", "task_retry",
     "task_partial", "task_succeeded"
    ].forEach(function (a) {
      assert.ok(actions.indexOf(a) !== -1, "缺少记录 " + a + "：" + actions.join(","));
    });
    assert.ok(actions.filter(function (a) { return a === "task_auto_execute"; }).length >= 2,
      "两次定时执行尝试都应留痕");
    // tid（暂停→恢复→自动成功）：暂停/恢复记录齐全
    const pausedLogs = await request("GET", "/api/execution-tasks/" + tid + "/logs");
    const pausedActions = pausedLogs.data.logs.map(function (l) { return l.action; });
    ["task_publish", "task_pause", "task_resume",
     "task_auto_execute", "task_succeeded"].forEach(function (a) {
      assert.ok(pausedActions.indexOf(a) !== -1,
        "暂停恢复任务缺少记录 " + a + "：" + pausedActions.join(","));
    });
    // 时间倒序
    for (let i = 1; i < all.data.logs.length; i++) {
      assert.ok(all.data.logs[i - 1].at >= all.data.logs[i].at);
    }
    const pivot = all.data.logs[Math.floor(all.data.logs.length / 2)].at;
    const filtered = await request("GET",
      "/api/execution-tasks/" + tid3 + "/logs?from=" + encodeURIComponent(pivot));
    assert.ok(filtered.data.logs.every(function (l) { return l.at >= pivot; }));
  });

  it("保存快照时嵌入执行队列（锁定文本/状态/成功条目）", async function () {
    const r = await request("POST", "/api/snapshots", {
      name: "队列时刻", paragraphs: PARAS
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const tasks = r.data.executionTasks;
    assert.ok(Array.isArray(tasks) && tasks.length >= 3);
    const mine = tasks.find(function (t) { return t.id === tid3; });
    assert.equal(mine.status, "succeeded");
    assert.ok(mine.lock.paragraphs.length >= 1, "锁定文本随快照保存");
    assert.equal(mine.successAnnotationIds.length, 2);
    // 决策摘要里携带 activeTaskId/scheduledAt
    const dd = r.data.decisions.find(function (x) { return x.id === did3; });
    assert.equal(dd.status, "executed");
  });

  /* ---------- 重启恢复 ---------- */

  it("重启：未来任务保持 scheduled；停机期间错过的任务重启后自动补执行", async function () {
    // 新建一个 ready 草案，发布到 5 分钟后
    const a = await createAnn({ body: "future", start: 0, end: 1, quote: "中" });
    const b = await createBatch([a.id], "未来批次");
    const d = await createDecision(b.id, []);
    await readyDecision(d.id, [a.id]);
    const future = await request("POST", "/api/execution-tasks", {
      decisionId: d.id,
      scheduledAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      paragraphs: [{ dir: "ltr", text: "中文" }],
      actor: "负责人"
    }, { "If-Match": await drev() });
    assert.equal(future.status, 201);
    const futureTid = future.data.task.id;
    const futureDid = d.id;

    // 再发布一个 0.3 秒后到期的任务，然后立刻停服，让它在停机期间错过
    const a2b = await createAnn({ body: "missed", start: 0, end: 1, quote: "中" });
    const b2b = await createBatch([a2b.id], "错过批次");
    const d2 = await createDecision(b2b.id, []);
    await readyDecision(d2.id, [a2b.id]);
    const missed = await request("POST", "/api/execution-tasks", {
      decisionId: d2.id,
      scheduledAt: new Date(Date.now() + 300).toISOString(),
      paragraphs: [{ dir: "ltr", text: "中文" }],
      actor: "负责人"
    }, { "If-Match": await drev() });
    assert.equal(missed.status, 201);
    const missedTid = missed.data.task.id;

    await stopServer();
    await sleep(1500); // 到期时服务处于停止状态
    await startServer();

    const ft = await waitTask(futureTid, ["scheduled", "paused"], 3000);
    assert.equal(ft.status, "scheduled", "未来任务不应在重启后被执行");
    assert.equal((await request("GET", "/api/review-decisions/" + futureDid))
      .data.decision.status, "scheduled");

    const mt = await waitTask(missedTid, ["succeeded", "partial", "failed", "blocked"]);
    assert.equal(mt.status, "succeeded", "错过的任务重启后自动补执行");
    assert.equal(mt.lastCounts.success, 1);
    // 补执行幂等：再等一会确认没有重复执行记录
    await sleep(400);
    const detail = await request("GET", "/api/review-decisions/" + d2.id);
    const autoExecs = detail.data.executions;
    assert.equal(autoExecs.length, 1, "补执行只能发生一次");
  });
});
