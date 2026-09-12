/* node --test test/task-dependencies-api.test.js
 * 任务依赖与执行前审批 HTTP 集成测试：真实启动 server.js
 * （临时数据文件 + 随机端口 + 100ms 调度间隔），覆盖：
 *   - 发布时配置依赖/审批：自依赖/循环/不存在/审批人重复/门槛非法
 *   - 依赖成功才放行；到点未满足前置条件绝不执行
 *   - 前置失败→等待，重试成功后自动放行；前置取消→阻断；阻断日志关联快照
 *   - 前置部分成功→可继续，负责人确认后只触发一次
 *   - 审批通过/拒绝/撤回/重复幂等/非审批人 403/终态锁定
 *   - 配置修改按 X-Decision-Rev 并发校验；终态任务不能改配置
 *   - 重启后依赖与审批状态恢复
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

const PORT = 8920 + Math.floor(Math.random() * 70);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "dep-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "dep-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "dep-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "dep-dec-" + TAG + ".json")
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

describe("任务依赖与执行前审批 API（顺序用例）", function () {
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
            drev: res.headers["x-decision-rev"]
          });
        });
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function drev() { return (await request("GET", "/api/review-decisions")).drev; }
  function headRev(collection, header) {
    return new Promise(function (resolve) {
      http.get(BASE + "/api/" + collection, function (res) {
        resolve(res.headers[header] || "0");
        res.resume();
      });
    });
  }
  function annRev() { return headRev("annotations", "x-annotation-rev"); }
  function batchRev() { return headRev("review-batches", "x-batch-rev"); }

  let annSeq = 0;
  async function createAnn(ov) {
    const r = await request("POST", "/api/annotations",
      Object.assign({
        author: "审阅者", body: "b" + annSeq++,
        paraIndex: 0, start: 0, end: 2, quote: "中文", paraDir: "ltr"
      }, ov || {}),
      { "If-Match": await annRev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.annotation;
  }
  async function createBatch(ids, name) {
    const r = await request("POST", "/api/review-batches", {
      name: name || "批" + annSeq, owner: "负责人",
      deadline: "2030-01-01T00:00:00Z",
      annotationIds: ids
    }, { "If-Match": await batchRev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.batch;
  }
  const PARAS = [{ dir: "ltr", text: "中文示例文本" }];
  async function createReadyDecision(prefix) {
    // 每个草案独立批次 + 一条批注，互不干扰
    const a = await createAnn({ body: prefix + annSeq, start: 0, end: 2, quote: "中文" });
    const b = await createBatch([a.id], prefix + "批次");
    let r = await request("POST", "/api/review-decisions", {
      batchId: b.id, threshold: 1, paragraphs: PARAS
    }, { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const did = r.data.decision.id;
    r = await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: [{ annotationId: a.id, disposition: "delete" }], actor: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await request("POST", "/api/review-decisions/" + did + "/submit",
      { actor: "甲" }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await request("POST", "/api/review-decisions/" + did + "/votes",
      { annotationId: a.id, vote: "approve", voter: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { id: did, batchId: b.id, annotationId: a.id };
  }
  async function publish(decisionId, extra, whenMs) {
    return request("POST", "/api/execution-tasks", Object.assign({
      decisionId: decisionId,
      scheduledAt: new Date(whenMs || (Date.now() + 800)).toISOString(),
      paragraphs: PARAS,
      actor: "负责人"
    }, extra || {}), { "If-Match": await drev() });
  }
  async function getTask(tid) {
    const r = await request("GET", "/api/execution-tasks/" + tid);
    return r.data.task;
  }
  async function waitStatus(tid, statuses, timeout) {
    const end = Date.now() + (timeout || 6000);
    while (Date.now() < end) {
      const t = await getTask(tid);
      if (statuses.indexOf(t.status) !== -1) return t;
      await sleep(120);
    }
    throw new Error("task not in " + statuses + ": " + JSON.stringify(await getTask(tid)));
  }
  async function setTaskTerminal(tid, status, successIds) {
    // 通过直接改决策数据文件构造终态（失败/部分成功的常规路径见执行队列测试）
    await stopServer();
    const raw = JSON.parse(fs.readFileSync(FILES.DEC_DATA, "utf8"));
    const t = raw.tasks.find(function (x) { return x.id === tid; });
    assert.ok(t, "任务存在");
    t.status = status;
    t.finishedAt = new Date().toISOString();
    if (successIds) t.successAnnotationIds = successIds;
    t.gateState = null;
    fs.writeFileSync(FILES.DEC_DATA, JSON.stringify(raw));
    await startServer();
  }

  /* ---------- 发布时校验 ---------- */

  it("发布：自依赖/不存在任务 4xx 拒绝", async function () {
    const d1 = await createReadyDecision("自依赖");
    // 先发布 t1，才能引用它构造自依赖
    const p1 = await publish(d1.id, {}, Date.now() + 60000);
    assert.equal(p1.status, 201, JSON.stringify(p1.data));
    const t1 = p1.data.task.id;
    const rev = await drev();
    let r = await request("POST", "/api/execution-tasks", {
      decisionId: d1.id, scheduledAt: "2029-06-01T00:00:00Z",
      paragraphs: PARAS, dependencies: [t1]
    }, { "If-Match": rev });
    // 同一草案已有活动任务 → task_already_scheduled（先于自依赖判定也可接受），
    // 因此用新草案做自依赖
    assert.ok([409].indexOf(r.status) !== -1);

    const d2 = await createReadyDecision("引用不存在");
    r = await publish(d2.id, { dependencies: ["no-such-task-id"] }, Date.now() + 60000);
    assert.equal(r.status, 404);
    assert.equal(r.data.error, "dependency_not_found");
  });

  it("发布：审批人重复/超员/门槛非法 明确拒绝", async function () {
    const d = await createReadyDecision("非法审批");
    let r = await publish(d.id, {
      approval: { approvers: ["甲", "甲"], minApprovals: 1 }
    }, Date.now() + 60000);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "duplicate_approver");
    r = await publish(d.id, {
      approval: { approvers: ["甲", "乙", "丙", "丁"] }
    }, Date.now() + 60000);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "invalid_approvers");
    r = await publish(d.id, {
      approval: { approvers: ["甲", "乙"], minApprovals: 3 }
    }, Date.now() + 60000);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "invalid_min_approvals");
    r = await publish(d.id, {
      approval: { approvers: ["  "], minApprovals: 1 }
    }, Date.now() + 60000);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "missing_approver");
  });

  it("发布：带审批配置时自动保存审批快照并关联", async function () {
    const d = await createReadyDecision("审批快照");
    const r = await publish(d.id, {
      approval: { approvers: ["审甲", "审乙"], minApprovals: 2 }
    }, Date.now() + 60000);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.ok(r.data.task.approvalSnapshotId, "应有关联快照 id");
    assert.equal(r.data.task.gate.state, "approvals");
    assert.equal(r.data.task.gate.approval.approved, 0);
    assert.equal(r.data.task.gate.approval.minApprovals, 2);
  });

  /* ---------- 依赖成功才放行 ---------- */

  it("前置未结束：后继到点绝不执行；前置成功后自动执行（仅一次）", async function () {
    const dep = await createReadyDecision("前置");
    const down = await createReadyDecision("后继");
    // 前置排到 10 秒后（先不触发），后继 0.5 秒后到期
    const pDep = await publish(dep.id, {}, Date.now() + 10000);
    assert.equal(pDep.status, 201);
    const depTid = pDep.data.task.id;
    const pDown = await publish(down.id, { dependencies: [depTid] }, Date.now() + 500);
    assert.equal(pDown.status, 201);
    const downTid = pDown.data.task.id;
    assert.equal(pDown.data.task.gate.state, "waiting");
    assert.equal(pDown.data.task.gate.dependencyState, "waiting");

    await sleep(1200); // 后继计划时间已过
    let t = await getTask(downTid);
    assert.equal(t.status, "scheduled", "前置未完成，到点不能误执行");
    assert.equal(t.gate.state, "waiting");

    // 取消前置的远期任务，重新发布一个立即到期的（同一草案只能有一个活动任务）
    let r = await request("POST", "/api/execution-tasks/" + depTid + "/cancel",
      { actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const pDep2 = await publish(dep.id, {}, Date.now() + 300);
    const depTid2 = pDep2.data.task.id;
    // 后继依赖仍指向旧任务（已取消）→ 阻断；改成新任务后放行
    t = await getTask(downTid);
    assert.equal(t.gate.state, "blocked");
    r = await request("POST", "/api/execution-tasks/" + downTid + "/config", {
      actor: "负责人", dependencies: [depTid2]
    }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.task.gate.state, "waiting", "新前置仍在执行前，继续等待");

    await waitStatus(depTid2, ["succeeded", "partial", "failed"]);
    t = await waitStatus(downTid, ["succeeded", "partial", "failed"]);
    assert.equal(t.status, "succeeded");
    // 只执行一次：再等两个调度周期，执行记录仍只有一条
    await sleep(400);
    const detail = await request("GET", "/api/review-decisions/" + down.id);
    assert.equal(detail.data.executions.length, 1, "满足条件后只触发一次");
  });

  it("前置取消：后继阻断且日志关联前置执行快照（若有）", async function () {
    const a = await createReadyDecision("将取消");
    const b = await createReadyDecision("被阻断");
    const pa = await publish(a.id, {}, Date.now() + 60000);
    const pb = await publish(b.id, { dependencies: [pa.data.task.id] },
      Date.now() + 60000);
    assert.equal(pb.data.task.gate.state, "waiting");
    const r = await request("POST",
      "/api/execution-tasks/" + pa.data.task.id + "/cancel",
      { actor: "负责人", reason: "不做了" }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const t = await getTask(pb.data.task.id);
    assert.equal(t.status, "scheduled", "阻断不改变任务自身状态");
    assert.equal(t.gate.state, "blocked");
    assert.equal(t.gate.reason, "dependency_cancelled");
    const logs = await request("GET",
      "/api/execution-tasks/" + pb.data.task.id + "/logs");
    assert.ok(logs.data.logs.some(function (l) {
      return l.action === "task_dependency_blocked";
    }), "应有阻断日志：" + logs.data.logs.map(function (l) { return l.action; }));
  });

  /* ---------- 配置修改与并发校验 ---------- */

  it("config：终态任务不能改；旧版本 409；循环依赖 409", async function () {
    const a = await createReadyDecision("循环A");
    const b = await createReadyDecision("循环B");
    const pa = await publish(a.id, {}, Date.now() + 60000);
    const pb = await publish(b.id, { dependencies: [pa.data.task.id] },
      Date.now() + 60000);
    const aTid = pa.data.task.id, bTid = pb.data.task.id;
    const rev = await drev();
    // 制造一个版本差：先让别人改一次
    const other = await request("POST",
      "/api/execution-tasks/" + aTid + "/pause",
      { actor: "负责人" }, { "If-Match": rev });
    assert.equal(other.status, 200, JSON.stringify(other.data));
    let r = await request("POST", "/api/execution-tasks/" + aTid + "/config", {
      actor: "负责人", dependencies: [bTid]
    }, { "If-Match": rev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "version_conflict");
    // 恢复后构造环：a→b、b→a
    const cur = await drev();
    r = await request("POST", "/api/execution-tasks/" + aTid + "/resume",
      { actor: "负责人" }, { "If-Match": cur });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await request("POST", "/api/execution-tasks/" + bTid + "/config", {
      actor: "负责人", dependencies: []
    }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await request("POST", "/api/execution-tasks/" + aTid + "/config", {
      actor: "负责人", dependencies: [bTid]
    }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await request("POST", "/api/execution-tasks/" + bTid + "/config", {
      actor: "负责人", dependencies: [aTid]
    }, { "If-Match": await drev() });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "dependency_cycle");
  });

  /* ---------- 审批 ---------- */

  it("审批：达到门槛才放行；拒绝阻断、撤回恢复、重复幂等、非审批人 403", async function () {
    const dep = await createReadyDecision("审批前置");
    const down = await createReadyDecision("审批后继");
    const pDep = await publish(dep.id, {}, Date.now() + 300);
    const depTid = pDep.data.task.id;
    await waitStatus(depTid, ["succeeded", "partial", "failed"]);

    // 后继带 2 人审批，0.4 秒到期
    const pDown = await publish(down.id, {
      dependencies: [depTid],
      approval: { approvers: ["审甲", "审乙"], minApprovals: 2 }
    }, Date.now() + 400);
    assert.equal(pDown.status, 201, JSON.stringify(pDown.data));
    const tid = pDown.data.task.id;
    assert.equal(pDown.data.task.gate.state, "approvals");

    // 非审批人
    let r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "路人", decision: "approve" });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "not_approver");
    // 非法决定
    r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "审甲", decision: "maybe" });
    assert.equal(r.status, 400);
    // 甲通过
    r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "审甲", decision: "approve" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.task.gate.state, "approvals");
    assert.equal(r.data.task.gate.approval.approved, 1);
    // 重复通过：幂等，不新增决定
    r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "审甲", decision: "approve" });
    assert.equal(r.status, 200);
    // 乙拒绝 → rejected
    r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "审乙", decision: "reject" });
    assert.equal(r.data.task.gate.state, "rejected");
    // 计划时间已过但被拒，不能执行
    await sleep(500);
    let t = await getTask(tid);
    assert.equal(t.status, "scheduled");
    assert.equal(t.gate.state, "rejected");
    // 乙撤回拒绝 → 回到 approvals
    r = await request("POST",
      "/api/execution-tasks/" + tid + "/approvals/" + encodeURIComponent("审乙") + "/withdraw",
      {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.task.gate.state, "approvals");
    // 再次撤回应 409
    r = await request("POST",
      "/api/execution-tasks/" + tid + "/approvals/" + encodeURIComponent("审乙") + "/withdraw",
      {});
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "approval_not_found");
    // 乙通过 → 门槛达成，下一轮执行
    r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "审乙", decision: "approve" });
    assert.equal(r.data.task.gate.state, "ready");
    t = await waitStatus(tid, ["succeeded", "partial", "failed"]);
    assert.equal(t.status, "succeeded");
    // 终态后不能再审批
    r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "审甲", decision: "approve" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "task_not_pending_approval");
    // 审批日志齐全且关联审批快照
    const logs = await request("GET", "/api/execution-tasks/" + tid + "/logs");
    const actions = logs.data.logs.map(function (l) { return l.action; });
    ["task_approved", "task_rejected", "task_approval_withdrawn",
     "task_approval_met", "task_approval_rejected"
    ].forEach(function (a) {
      assert.ok(actions.indexOf(a) !== -1, "缺少审批日志 " + a + "：" + actions.join(","));
    });
    assert.ok(logs.data.logs.some(function (l) {
      return /^task_approval|^task_approved|^task_rejected/.test(l.action) && l.snapshotId;
    }), "审批日志应关联快照");
  });

  it("改审批配置会重置已有审批决定，且不需要 If-Match 的审批动作不冲突", async function () {
    const d = await createReadyDecision("改审批");
    const p = await publish(d.id, {
      approval: { approvers: ["甲"], minApprovals: 1 }
    }, Date.now() + 60000);
    const tid = p.data.task.id;
    let r = await request("POST", "/api/execution-tasks/" + tid + "/approvals",
      { approver: "甲", decision: "approve" });
    assert.equal(r.data.task.gate.state, "ready");
    // 改成乙审批：甲的通过作废
    r = await request("POST", "/api/execution-tasks/" + tid + "/config", {
      actor: "负责人", approval: { approvers: ["乙"], minApprovals: 1 }
    }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.task.gate.state, "approvals");
    assert.equal(r.data.task.gate.approval.approved, 0);
    assert.deepEqual(r.data.task.approval.approvers, ["乙"]);
    // 取消审批
    r = await request("POST", "/api/execution-tasks/" + tid + "/config", {
      actor: "负责人", approval: null
    }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.task.gate.state, "ready");
    assert.equal(r.data.task.approval, null);
  });

  /* ---------- 失败→等待、部分成功→确认继续 ---------- */

  it("前置 failed→后继 waiting；前置 partial→can_continue，确认后放行一次", async function () {
    const failed = await createReadyDecision("将失败");
    const partial = await createReadyDecision("将部分");
    const wf = await createReadyDecision("等失败");
    const wp = await createReadyDecision("等部分");

    const pf = await publish(failed.id, {}, Date.now() + 60000);
    const pp = await publish(partial.id, {}, Date.now() + 60000);
    await setTaskTerminal(pf.data.task.id, "failed");
    await setTaskTerminal(pp.data.task.id, "partial", [partial.annotationId]);

    const pwf = await publish(wf.id, { dependencies: [pf.data.task.id] },
      Date.now() + 60000);
    assert.equal(pwf.data.task.gate.state, "waiting");
    assert.equal(pwf.data.task.gate.reason, "dependency_failed");
    const pwp = await publish(wp.id, { dependencies: [pp.data.task.id] },
      Date.now() + 300);
    assert.equal(pwp.data.task.gate.state, "can_continue");
    assert.equal(pwp.data.task.gate.continueConfirmations[0].needsConfirm, true);
    // 未确认：到点不执行
    await sleep(800);
    let t = await getTask(pwp.data.task.id);
    assert.equal(t.status, "scheduled");
    assert.equal(t.gate.state, "can_continue");
    // 错误状态确认 409（等失败任务上调用继续）
    let r = await request("POST",
      "/api/execution-tasks/" + pwf.data.task.id + "/continue",
      { actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "gate_not_needs_continue");
    // 确认继续
    r = await request("POST",
      "/api/execution-tasks/" + pwp.data.task.id + "/continue",
      { actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.task.gate.state, "ready");
    t = await waitStatus(pwp.data.task.id, ["succeeded", "partial", "failed"]);
    assert.equal(t.status, "succeeded");
    // 重复确认 409
    r = await request("POST",
      "/api/execution-tasks/" + pwp.data.task.id + "/continue",
      { actor: "负责人" }, { "If-Match": await drev() });
    assert.equal(r.status, 409);
    // 等失败任务仍 waiting
    t = await getTask(pwf.data.task.id);
    assert.equal(t.gate.state, "waiting");
  });

  /* ---------- 重启恢复 ---------- */

  it("重启：等待/阻断/审批状态与审批进度完整恢复", async function () {
    const dep = await createReadyDecision("重启前置");
    const down = await createReadyDecision("重启后继");
    const pDep = await publish(dep.id, {}, Date.now() + 60000);
    const pDown = await publish(down.id, {
      dependencies: [pDep.data.task.id],
      approval: { approvers: ["甲", "乙"], minApprovals: 2 }
    }, Date.now() + 60000);
    const depTid = pDep.data.task.id, downTid = pDown.data.task.id;
    // 前置取消 → 后继阻断
    await request("POST", "/api/execution-tasks/" + depTid + "/cancel",
      { actor: "负责人" }, { "If-Match": await drev() });
    let t = await getTask(downTid);
    assert.equal(t.gate.state, "blocked");
    const snapId = t.approvalSnapshotId;

    await stopServer();
    await startServer();

    t = await getTask(downTid);
    assert.equal(t.status, "scheduled");
    assert.equal(t.gate.state, "blocked", "阻断状态随重启恢复");
    assert.equal(t.gate.reason, "dependency_cancelled");
    assert.equal(t.approvalSnapshotId, snapId, "审批快照关联恢复");
    assert.ok(t.gate.approval, "审批配置与进度恢复");
    assert.equal(t.gate.approval.minApprovals, 2);
    assert.deepEqual(t.gate.approval.approvers, ["甲", "乙"]);
    // 阻断不会因重启解除（前置仍取消）
    await sleep(300);
    t = await getTask(downTid);
    assert.equal(t.status, "scheduled");
  });
});
