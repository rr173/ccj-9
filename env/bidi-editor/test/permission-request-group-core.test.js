/* node --test test/permission-request-group-core.test.js
 * 申请分组与批量处理纯逻辑单测：
 *   分组创建/更新校验（名称/截止未来/备注）、截止状态、分组摘要、
 *   截止提醒（approaching/overdue、幂等、无 pending 不提醒）、
 *   批量决定（集合版本/每条版本/过期/已处理/自审/拒绝原因/跨组/
 *   批内重复与角色冲突整批拒绝，全绿整批通过）。
 */
"use strict";

const test = require("node:test");
const { describe, it } = test;
const assert = require("node:assert/strict");
const gc = require("../permission-request-group-core");

const NOW = "2026-09-14T00:00:00Z";
const f = function (hours) {
  return new Date(Date.parse(NOW) + hours * 3600000).toISOString();
};

function group(over) {
  return Object.assign({
    id: "pgrp_1", name: "本周审批组", scope: "space", resourceId: "sp1",
    deadline: f(24), note: "", version: 1, createdAt: f(-1)
  }, over || {});
}
function req(over) {
  return Object.assign({
    id: "preq_1", kind: "grant", scope: "space", resourceId: "sp1",
    role: "view", member: "张三", status: "pending", version: 1,
    groupId: "pgrp_1", createdAt: f(-1), expiresAt: f(72),
    effectiveAt: NOW, expireAt: f(48)
  }, over || {});
}

describe("分组创建/更新校验", function () {
  it("合法创建通过；缺名称/名称过长拒绝", function () {
    let r = gc.validateGroupBody(
      { name: "组", scope: "space", resourceId: "sp1", deadline: f(12), note: "备注" },
      { now: NOW, isCreate: true });
    assert.equal(r.ok, true);
    assert.equal(r.value.deadline, f(12));
    r = gc.validateGroupBody({ scope: "space", resourceId: "sp1" },
      { now: NOW, isCreate: true });
    assert.equal(r.code, "missing_group_name");
    r = gc.validateGroupBody(
      { name: "x".repeat(101), scope: "space", resourceId: "sp1" },
      { now: NOW, isCreate: true });
    assert.equal(r.code, "name_too_long");
  });

  it("创建缺 scope/resourceId 拒绝；分组数超限拒绝", function () {
    let r = gc.validateGroupBody({ name: "组", resourceId: "sp1" },
      { now: NOW, isCreate: true });
    assert.equal(r.code, "invalid_scope");
    r = gc.validateGroupBody({ name: "组", scope: "space" },
      { now: NOW, isCreate: true });
    assert.equal(r.code, "missing_resource");
    r = gc.validateGroupBody(
      { name: "组", scope: "space", resourceId: "sp1" },
      { now: NOW, isCreate: true, groupCount: gc.LIMITS.GROUPS_MAX });
    assert.equal(r.code, "group_too_large");
  });

  it("截止必须是合法 ISO；创建要求未来，更新允许改成过去；允许清空；备注上限", function () {
    let r = gc.validateGroupBody({ name: "组", deadline: "bad" }, { now: NOW });
    assert.equal(r.code, "invalid_deadline");
    // 创建：过去截止拒绝
    r = gc.validateGroupBody(
      { name: "组", scope: "space", resourceId: "sp1", deadline: f(-1) },
      { now: NOW, isCreate: true });
    assert.equal(r.code, "deadline_in_past");
    // 更新：允许改成过去（用于把组标记为逾期，仅影响 deadlineState/提醒）
    r = gc.validateGroupBody({ name: "组", deadline: f(-1) }, { now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.value.deadline, f(-1));
    r = gc.validateGroupBody({ name: "组", deadline: "" }, { now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.value.deadline, null);
    r = gc.validateGroupBody({ name: "组", note: "n".repeat(501) }, { now: NOW });
    assert.equal(r.code, "note_too_long");
  });
});

describe("截止状态与分组摘要", function () {
  it("deadlineState: none/pending/overdue", function () {
    assert.equal(gc.deadlineState(group({ deadline: null }), NOW), "none");
    assert.equal(gc.deadlineState(group({ deadline: f(1) }), NOW), "pending");
    assert.equal(gc.deadlineState(group({ deadline: f(0) }), NOW), "overdue");
  });

  it("摘要按类型/状态/成员计数并给出待处理数量", function () {
    const g = group();
    const list = [
      req(),
      req({ id: "preq_2", kind: "revoke", member: "李四" }),
      req({ id: "preq_3", member: "张三", status: "approved" }),
      req({ id: "preq_4", member: "李四", expiresAt: f(-1) }) // live=expired
    ];
    const s = gc.groupSummary(g, list, NOW);
    assert.equal(s.totalCount, 4);
    assert.equal(s.pendingCount, 2);
    assert.equal(s.grantCount, 3);
    assert.equal(s.revokeCount, 1);
    assert.equal(s.statusCounts.approved, 1);
    assert.equal(s.statusCounts.expired, 1);
    assert.equal(s.memberCounts["张三"], 2);
    assert.equal(s.memberCounts["李四"], 2);
  });

  it("普通成员口径：只统计本人申请", function () {
    const g = group();
    const mine = [req(), req({ id: "preq_2", member: "李四" })]
      .filter(function (x) { return x.member === "张三"; });
    const s = gc.groupSummary(g, mine, NOW);
    assert.equal(s.totalCount, 1);
    assert.equal(s.pendingCount, 1);
  });
});

describe("截止提醒（确定性、幂等）", function () {
  it("临近截止 approaching；过期 overdue；已提醒不重复；无 pending 不提醒", function () {
    const gNear = group({ id: "g_near", deadline: f(10) });
    const gOver = group({ id: "g_over", deadline: f(-1) });
    const gDone = group({ id: "g_done", deadline: f(10) });
    const gFar = group({ id: "g_far", deadline: f(100) });
    const requests = [
      req({ groupId: "g_near" }),
      req({ groupId: "g_over" }),
      req({ groupId: "g_done", status: "approved" }),
      req({ groupId: "g_far" })
    ];
    let due = gc.dueReminders([gNear, gOver, gDone, gFar], requests,
      { now: NOW, approachingMs: 24 * 3600000, reminded: {} });
    const kinds = due.map(function (x) { return x.groupId + ":" + x.kind; });
    assert.deepEqual(kinds.sort(), ["g_near:approaching", "g_over:overdue"]);

    // 幂等：标记后不再产生
    due = gc.dueReminders([gNear, gOver], requests, {
      now: NOW, approachingMs: 24 * 3600000,
      reminded: { g_near: { approaching: NOW }, g_over: { overdue: NOW } }
    });
    assert.equal(due.length, 0);
  });

  it("过了截止即使只发过 approaching 也补发 overdue", function () {
    const g = group({ deadline: f(-1) });
    const due = gc.dueReminders([g], [req()],
      { now: NOW, reminded: { pgrp_1: { approaching: f(-2) } } });
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, "overdue");
  });
});

describe("批量决定（原子前置校验）", function () {
  const baseCtx = function (over) {
    return Object.assign({
      now: NOW, actor: "负责人", owner: "负责人",
      requestRev: 5, expectedRev: 5, group: group(),
      requests: [req()], delegations: []
    }, over || {});
  };
  const item = function (over) {
    return Object.assign({ id: "preq_1", version: 1, decision: "approve" }, over || {});
  };

  it("缺/旧 If-Match 整批拒绝（集合版本）", function () {
    let r = gc.validateBatchDecisions([item()], baseCtx({ expectedRev: undefined }));
    assert.equal(r.code, "precondition_required");
    r = gc.validateBatchDecisions([item()], baseCtx({ expectedRev: 4 }));
    assert.equal(r.code, "version_conflict");
  });

  it("空批/缺 id/批内重复 -> batch_invalid", function () {
    let r = gc.validateBatchDecisions([], baseCtx());
    assert.equal(r.code, "empty_batch");
    r = gc.validateBatchDecisions([item({ id: "" })], baseCtx());
    assert.equal(r.code, "batch_invalid");
    assert.equal(r.results[0].code, "missing_request_id");
    r = gc.validateBatchDecisions([item(), item()], baseCtx());
    assert.equal(r.code, "batch_invalid");
    assert.equal(r.results[0].code, "duplicate_in_batch");
  });

  it("申请不存在/不属于本组 -> batch_invalid", function () {
    let r = gc.validateBatchDecisions([item({ id: "nope" })], baseCtx());
    assert.equal(r.code, "batch_invalid");
    assert.equal(r.results[0].code, "request_not_found");
    r = gc.validateBatchDecisions([item()],
      baseCtx({ requests: [req({ groupId: "other" })] }));
    assert.equal(r.results[0].code, "not_in_group");
  });

  it("每条版本不符/已处理/过期/自审/非负责人/拒绝缺原因逐条返回", function () {
    let r = gc.validateBatchDecisions([item({ version: 9 })], baseCtx());
    assert.equal(r.code, "batch_conflict");
    assert.equal(r.results[0].code, "request_version_conflict");
    assert.equal(r.results[0].currentVersion, 1);

    r = gc.validateBatchDecisions([item({ version: undefined })], baseCtx());
    assert.equal(r.results[0].code, "precondition_required");

    r = gc.validateBatchDecisions([item()],
      baseCtx({ requests: [req({ status: "approved" })] }));
    assert.equal(r.results[0].code, "request_not_pending");

    r = gc.validateBatchDecisions([item()],
      baseCtx({ requests: [req({ expiresAt: f(-1) })] }));
    assert.equal(r.results[0].code, "request_expired");

    r = gc.validateBatchDecisions([item()],
      baseCtx({ requests: [req({ member: "负责人" })] }));
    assert.equal(r.results[0].code, "self_approval");

    r = gc.validateBatchDecisions([item()], baseCtx({ actor: "路人甲" }));
    assert.equal(r.results[0].code, "not_resource_owner");

    r = gc.validateBatchDecisions([item({ decision: "reject", reason: "  " })],
      baseCtx());
    assert.equal(r.results[0].code, "reject_reason_required");
  });

  it("批准瞬间角色冲突（期间已被直授）整批拒绝、逐条原因", function () {
    const r = gc.validateBatchDecisions([item()], baseCtx({
      delegations: [{
        id: "del_9", status: "active", member: "张三", role: "view",
        scope: "space", resourceId: "sp1",
        effectiveAt: f(-1), expireAt: f(24)
      }]
    }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "batch_conflict");
    assert.equal(r.results[0].code, "duplicate_delegation");
  });

  it("批内两条同成员同角色授予互相重复 -> 整批冲突，不改变权限", function () {
    const requests = [
      req({ id: "p1", role: "view" }),
      req({ id: "p2", role: "view" })
    ];
    const items = [
      { id: "p1", version: 1, decision: "approve" },
      { id: "p2", version: 1, decision: "approve" }
    ];
    const r = gc.validateBatchDecisions(items, baseCtx({ requests: requests }));
    assert.equal(r.ok, false);
    // 第二条因第一条将生成的同角色委派而 duplicate_delegation
    const failRow = r.results.find(function (x) { return !x.ok; });
    assert.equal(failRow.code, "duplicate_delegation");
  });

  it("批内 approve/execute 时间窗职责冲突 -> 整批冲突", function () {
    const requests = [
      req({ id: "pa", scope: "batch", resourceId: "b1", role: "approve",
        effectiveAt: NOW, expireAt: f(48) }),
      req({ id: "pe", scope: "batch", resourceId: "b1", role: "execute",
        effectiveAt: NOW, expireAt: f(48) })
    ];
    const items = [
      { id: "pa", version: 1, decision: "approve" },
      { id: "pe", version: 1, decision: "approve" }
    ];
    const g = group({ scope: "batch", resourceId: "b1" });
    const r = gc.validateBatchDecisions(items,
      baseCtx({ group: g, requests: requests }));
    assert.equal(r.ok, false);
    const failRow = r.results.find(function (x) { return !x.ok; });
    assert.equal(failRow.code, "conflicting_roles");
  });

  it("全部合法（批准+拒绝）整批通过，返回落库指令", function () {
    const requests = [
      req({ id: "pa", role: "view" }),
      req({ id: "pr", role: "review" })
    ];
    const items = [
      { id: "pa", version: 1, decision: "approve" },
      { id: "pr", version: 1, decision: "reject", reason: "暂不需要" }
    ];
    const r = gc.validateBatchDecisions(items, baseCtx({ requests: requests }));
    assert.equal(r.ok, true, JSON.stringify(r.results));
    assert.equal(r.value.items.length, 2);
    assert.equal(r.value.items[1].decision, "reject");
    assert.equal(r.value.items[1].reason, "暂不需要");
  });

  it("批内窗口不重叠的 approve/execute 允许整批通过", function () {
    const requests = [
      req({ id: "pa", scope: "batch", resourceId: "b1", role: "approve",
        effectiveAt: NOW, expireAt: f(10) }),
      req({ id: "pe", scope: "batch", resourceId: "b1", role: "execute",
        effectiveAt: f(20), expireAt: f(40) })
    ];
    const items = [
      { id: "pa", version: 1, decision: "approve" },
      { id: "pe", version: 1, decision: "approve" }
    ];
    const g = group({ scope: "batch", resourceId: "b1" });
    const r = gc.validateBatchDecisions(items,
      baseCtx({ group: g, requests: requests }));
    assert.equal(r.ok, true, JSON.stringify(r.results));
  });
});
