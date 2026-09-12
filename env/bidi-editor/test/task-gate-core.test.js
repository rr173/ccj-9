/* node --test test/task-gate-core.test.js
 * 执行任务依赖与执行前审批的纯逻辑测试：
 *   - 审批配置校验（1~3 人、不重复、最少通过人数边界）
 *   - 依赖归一化与图校验（自依赖/循环/不存在）
 *   - 审批统计（最后一次决定、撤回、拒绝即否决、门槛达成）
 *   - 门控计算：前置 succeeded/partial/failed/cancelled/blocked/活动
 *     分别映射 ready/可继续/等待/阻断，并沿依赖链传递
 *   - 部分成功前置经负责人确认后放行
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dc = require("../decision-core");

function task(overrides) {
  return Object.assign({
    id: "t" + Math.random().toString(36).slice(2, 8),
    decisionId: "d", decisionName: "任务", batchId: "b", batchName: "批",
    status: "scheduled", publishedAt: "p", scheduledAt: "2030-01-01T00:00:00Z",
    scheduledAtMs: Date.parse("2030-01-01T00:00:00Z"),
    dependencyIds: [], approval: null, approvalDecisions: [],
    continueConfirmed: {}, attempts: [], successAnnotationIds: []
  }, overrides || {});
}

/* ---------- 审批配置 ---------- */

test("审批配置：缺省/空 = 不要求审批", function () {
  assert.equal(dc.validateApprovalConfig(null).value, null);
  assert.equal(dc.validateApprovalConfig({ approval: null }).value, null);
  assert.equal(dc.validateApprovalConfig({ approval: { approvers: [] } }).value, null);
});

test("审批配置：1~3 名审批人，超过/为空被拒", function () {
  assert.equal(dc.validateApprovalConfig({ approvers: ["甲"] }).ok, true);
  assert.equal(
    dc.validateApprovalConfig({ approvers: ["甲", "乙", "丙"] }).ok, true);
  let r = dc.validateApprovalConfig({ approvers: ["甲", "乙", "丙", "丁"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_approvers");
  r = dc.validateApprovalConfig({ approval: { approvers: [] } });
  assert.equal(r.value, null); // 空数组视作取消审批
  r = dc.validateApprovalConfig({ approvers: "not-array" });
  assert.equal(r.code, "invalid_approvers");
});

test("审批配置：审批人不能为空、不能重复", function () {
  let r = dc.validateApprovalConfig({ approvers: ["  "] });
  assert.equal(r.code, "missing_approver");
  r = dc.validateApprovalConfig({ approvers: ["甲", " 甲 "] });
  assert.equal(r.code, "duplicate_approver");
});

test("审批配置：最少通过人数边界", function () {
  let r = dc.validateApprovalConfig({ approvers: ["甲", "乙"], minApprovals: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.value.minApprovals, 2);
  r = dc.validateApprovalConfig({ approvers: ["甲", "乙"] }); // 缺省=全员
  assert.equal(r.value.minApprovals, 2);
  r = dc.validateApprovalConfig({ approvers: ["甲", "乙"], minApprovals: 0 });
  assert.equal(r.code, "invalid_min_approvals");
  r = dc.validateApprovalConfig({ approvers: ["甲", "乙"], minApprovals: 3 });
  assert.equal(r.code, "invalid_min_approvals");
});

/* ---------- 依赖图校验 ---------- */

test("依赖归一化：去重保序、拒绝非数组/空 id", function () {
  assert.deepEqual(dc.normalizeDependencyIds(null).value, []);
  assert.deepEqual(dc.normalizeDependencyIds(["a", " a ", "a"]).value, ["a"]);
  assert.equal(dc.normalizeDependencyIds("x").ok, false);
  assert.equal(dc.normalizeDependencyIds([""]).ok, false);
});

test("依赖校验：自依赖/不存在/既有边循环/新边循环", function () {
  const a = task({ id: "a" }), b = task({ id: "b", dependencyIds: ["a"] });
  const c = task({ id: "c" });
  const all = [a, b, c];
  assert.equal(dc.validateTaskDependencies("a", ["a"], all).code, "self_dependency");
  assert.equal(dc.validateTaskDependencies("a", ["zzz"], all).code,
    "dependency_not_found");
  // a→b、b→a 闭合出环
  assert.equal(dc.validateTaskDependencies("a", ["b"], all).code, "dependency_cycle");
  // b 保持 b→a 合法
  assert.equal(dc.validateTaskDependencies("b", ["a"], all).ok, true);
  // 发布时（任务尚未入库）引用现有任务合法
  assert.equal(dc.validateTaskDependencies(null, ["a", "b"], all).ok, true);
});

/* ---------- 审批统计 ---------- */

test("审批统计：未配置返回 none", function () {
  const t = task();
  assert.equal(dc.approvalTally(null, []).state, "none");
  assert.equal(dc.taskGate(t, [t]).state, "ready");
});

test("审批统计：按最后一次未撤回决定计票，门槛达成", function () {
  const ap = { approvers: ["甲", "乙"], minApprovals: 2 };
  let tally = dc.approvalTally(ap, []);
  assert.equal(tally.state, "pending");
  tally = dc.approvalTally(ap, [{ approver: "甲", decision: "approve", at: "1" }]);
  assert.equal(tally.state, "pending");
  assert.equal(tally.approved, 1);
  // 甲拒绝又改通过：以最后一次为准
  tally = dc.approvalTally(ap, [
    { approver: "甲", decision: "reject", at: "1" },
    { approver: "甲", decision: "approve", at: "2" },
    { approver: "乙", decision: "approve", at: "3" }
  ]);
  assert.equal(tally.state, "approved");
  assert.equal(tally.approved, 2);
  // 非指定审批人的决定不计入
  tally = dc.approvalTally(ap, [
    { approver: "路人", decision: "approve", at: "1" }
  ]);
  assert.equal(tally.state, "pending");
});

test("审批统计：一名拒绝即否决；撤回拒绝后恢复", function () {
  const ap = { approvers: ["甲", "乙"], minApprovals: 1 };
  let tally = dc.approvalTally(ap, [{ approver: "乙", decision: "reject", at: "1" }]);
  assert.equal(tally.state, "rejected");
  // 即使另一人通过，有拒绝仍否决
  tally = dc.approvalTally(ap, [
    { approver: "甲", decision: "approve", at: "1" },
    { approver: "乙", decision: "reject", at: "2" }
  ]);
  assert.equal(tally.state, "rejected");
  // 撤回拒绝：只剩甲的通过，门槛达成
  tally = dc.approvalTally(ap, [
    { approver: "甲", decision: "approve", at: "1" },
    { approver: "乙", decision: "reject", at: "2", withdrawnAt: "3" }
  ]);
  assert.equal(tally.state, "approved");
});

/* ---------- 门控：终态前置映射 ---------- */

test("门控：无前置 ready；前置活动 waiting", function () {
  const a = task({ id: "a", status: "scheduled" });
  const b = task({ id: "b", dependencyIds: ["a"] });
  assert.equal(dc.taskGate(b, [a, b]).state, "waiting");
  assert.equal(dc.taskGate(b, [a, b]).reason, "dependency_active");
});

test("门控：succeeded→ready；failed→waiting", function () {
  const a = task({ id: "a", status: "succeeded", finishedAt: "x" });
  const b = task({ id: "b", dependencyIds: ["a"] });
  let g = dc.taskGate(b, [a, b]);
  assert.equal(g.state, "ready");
  assert.equal(g.dependencies[0].gate, "ready");
  a.status = "failed";
  g = dc.taskGate(b, [a, b]);
  assert.equal(g.state, "waiting");
  assert.equal(g.reason, "dependency_failed");
});

test("门控：partial→can_continue；负责人确认后 ready", function () {
  const a = task({ id: "a", status: "partial", finishedAt: "x" });
  const b = task({ id: "b", dependencyIds: ["a"] });
  let g = dc.taskGate(b, [a, b]);
  assert.equal(g.state, "can_continue");
  assert.equal(g.blockingDependency.taskId, "a");
  assert.equal(g.continueConfirmations[0].needsConfirm, true);
  assert.equal(g.continueConfirmations[0].confirmed, false);
  // 未确认时即使计划时间已过也不会 ready
  b.continueConfirmed = { a: { at: "t", by: "负责人" } };
  g = dc.taskGate(b, [a, b]);
  assert.equal(g.state, "ready");
  assert.equal(g.continueConfirmations[0].confirmed, true);
});

test("门控：cancelled/blocked 前置 → blocked", function () {
  const a = task({ id: "a", status: "cancelled", finishedAt: "x" });
  let b = task({ id: "b", dependencyIds: ["a"] });
  assert.equal(dc.taskGate(b, [a, b]).state, "blocked");
  assert.equal(dc.taskGate(b, [a, b]).reason, "dependency_cancelled");
  a.status = "blocked";
  assert.equal(dc.taskGate(b, [a, b]).state, "blocked");
  assert.equal(dc.taskGate(b, [a, b]).reason, "dependency_blocked");
});

test("门控：不存在的前置 → blocked（dependency_not_found）", function () {
  const b = task({ id: "b", dependencyIds: ["ghost"] });
  const g = dc.taskGate(b, [b]);
  assert.equal(g.state, "blocked");
  assert.equal(g.reason, "dependency_not_found");
});

/* ---------- 门控：依赖链传递 ---------- */

test("门控沿依赖链传递阻断与等待", function () {
  const a = task({ id: "a", status: "cancelled", finishedAt: "x" });
  const b = task({ id: "b", status: "succeeded", finishedAt: "x",
                   dependencyIds: ["a"] });
  const c = task({ id: "c", dependencyIds: ["b"] });
  // b 自身已 succeeded，但它的前置 a 被取消：c 必须被阻断（结果链不可用）
  const g = dc.taskGate(c, [a, b, c]);
  assert.equal(g.state, "blocked");
  assert.equal(g.blockingDependency.via, "a");
});

test("门控：活动前置自身等待审批时，后继等待；活动前置被拒绝，后继阻断", function () {
  const a = task({ id: "a", status: "succeeded", finishedAt: "x" });
  const b = task({
    id: "b", dependencyIds: ["a"],
    approval: { approvers: ["甲"], minApprovals: 1 }, approvalDecisions: []
  });
  const c = task({ id: "c", dependencyIds: ["b"] });
  let g = dc.taskGate(c, [a, b, c]);
  assert.equal(g.state, "waiting");
  b.approvalDecisions = [{ approver: "甲", decision: "reject", at: "1" }];
  g = dc.taskGate(c, [a, b, c]);
  assert.equal(g.state, "blocked");
});

/* ---------- 门控：依赖满足后审批才轮到 ---------- */

test("门控：依赖未满足优先显示等待；依赖满足后显示审批进度", function () {
  const a = task({ id: "a", status: "scheduled" });
  const ap = { approvers: ["甲", "乙"], minApprovals: 2 };
  const b = task({ id: "b", dependencyIds: ["a"], approval: ap });
  let g = dc.taskGate(b, [a, b]);
  assert.equal(g.state, "waiting", "前置未结束时先等前置");
  a.status = "succeeded"; a.finishedAt = "x";
  g = dc.taskGate(b, [a, b]);
  assert.equal(g.state, "approvals");
  assert.equal(g.approval.approved, 0);
  b.approvalDecisions = [
    { approver: "甲", decision: "approve", at: "1" },
    { approver: "乙", decision: "approve", at: "2" }
  ];
  g = dc.taskGate(b, [a, b]);
  assert.equal(g.state, "ready");
  assert.equal(g.reason, "approved");
});

test("computeGates：终态任务为 null，活动任务有门控", function () {
  const a = task({ id: "a", status: "succeeded", finishedAt: "x" });
  const b = task({ id: "b", status: "scheduled", dependencyIds: ["a"] });
  const gates = dc.computeGates([a, b]);
  assert.equal(gates.a, null);
  assert.equal(gates.b.state, "ready");
});

test("门控摘要：重启后仅凭持久化 gateState 恢复等待原因与审批进度", function () {
  const t = task({
    approval: { approvers: ["甲"], minApprovals: 1 },
    approvalDecisions: [{ approver: "甲", decision: "approve", at: "1" }],
    gateState: "blocked", gateReason: "dependency_cancelled",
    gateDependencyState: "blocked", gateAt: "2",
    gateDependencies: [{ taskId: "x", status: "cancelled", gate: "blocked",
                          reason: "dependency_cancelled" }],
    gateBlockingDependency: { taskId: "x", status: "cancelled",
                               reason: "dependency_cancelled" },
    gateContinueConfirmations: []
  });
  const s = dc.taskSummary(t, null);
  assert.equal(s.gate.state, "blocked");
  assert.equal(s.gate.label, "前置未通过，已阻断");
  assert.equal(s.gate.approval.approved, 1, "审批进度从决定流水重算");
});
