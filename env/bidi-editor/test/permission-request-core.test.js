/* node --test test/permission-request-core.test.js
 * 权限变更申请与生效预览纯逻辑单测：
 *   授予/撤销申请校验（重复申请/时间窗冲突/职责冲突/负责人自审/已撤销委派）、
 *   审批校验（非 pending/自审/过期/旧版本/拒绝必填原因/批准时复核）、
 *   生效预览（即将生效/即将失效/已批准撤销/待处理不计入角色/owner）。
 */
"use strict";

const test = require("node:test");
const { describe, it } = test;
const assert = require("node:assert/strict");
const prc = require("../permission-request-core");

const NOW = "2026-09-14T00:00:00Z";
const f = function (hours) {
  return new Date(Date.parse(NOW) + hours * 3600000).toISOString();
};

function grantBody(over) {
  return Object.assign({
    scope: "space", resourceId: "sp1", role: "view",
    member: "张三", expireAt: f(48)
  }, over || {});
}

function pendingGrant(over) {
  return Object.assign({
    id: "preq_1", kind: "grant", scope: "space", resourceId: "sp1",
    role: "view", member: "张三", status: "pending", version: 1,
    createdAt: f(-1), expiresAt: f(72),
    effectiveAt: NOW, expireAt: f(48)
  }, over || {});
}

describe("授予申请校验", function () {
  it("合法授予申请通过，缺省生效时间=当前", function () {
    const r = prc.validateGrantRequest(grantBody(), { now: NOW, owner: "负责人" });
    assert.equal(r.ok, true);
    assert.equal(r.value.effectiveAt, NOW);
    assert.equal(r.value.member, "张三");
  });

  it("非法 scope/role/成员/时间窗明确拒绝", function () {
    let r = prc.validateGrantRequest(grantBody({ scope: "x" }), { now: NOW });
    assert.equal(r.code, "invalid_scope");
    r = prc.validateGrantRequest(grantBody({ role: "admin" }), { now: NOW });
    assert.equal(r.code, "invalid_role");
    r = prc.validateGrantRequest(grantBody({ member: " " }), { now: NOW });
    assert.equal(r.code, "missing_member");
    r = prc.validateGrantRequest(grantBody({ expireAt: "" }), { now: NOW });
    assert.equal(r.code, "missing_expire");
    r = prc.validateGrantRequest(grantBody({ expireAt: f(-1) }), { now: NOW });
    assert.equal(r.code, "expire_in_past");
    r = prc.validateGrantRequest(
      grantBody({ effectiveAt: f(50), expireAt: f(48) }), { now: NOW });
    assert.equal(r.code, "effective_after_expire");
  });

  it("space/session 不允许 approve/execute", function () {
    let r = prc.validateGrantRequest(
      grantBody({ scope: "session", role: "execute" }), { now: NOW });
    assert.equal(r.code, "role_not_allowed_for_scope");
  });

  it("重复申请：同成员同角色 pending 授予申请拒绝并返回既有 id", function () {
    const r = prc.validateGrantRequest(grantBody(),
      { now: NOW, owner: "负责人", requests: [pendingGrant()] });
    assert.equal(r.ok, false);
    assert.equal(r.code, "duplicate_request");
    assert.equal(r.existingRequestId, "preq_1");
  });

  it("已过期的 pending 申请不阻止重新申请（过期边界）", function () {
    const r = prc.validateGrantRequest(grantBody(),
      { now: NOW, owner: "负责人",
        requests: [pendingGrant({ expiresAt: f(-1) })] });
    assert.equal(r.ok, true);
  });

  it("与已批准/已拒绝的同角色申请不冲突（可撤销后重新申请的语义）", function () {
    const r = prc.validateGrantRequest(grantBody(),
      { now: NOW, owner: "负责人",
        requests: [pendingGrant({ status: "rejected" }),
                   pendingGrant({ id: "preq_2", status: "approved" })] });
    assert.equal(r.ok, true);
  });

  it("与正式委派时间窗重叠 -> duplicate_delegation", function () {
    const r = prc.validateGrantRequest(grantBody(), {
      now: NOW, owner: "负责人",
      delegations: [{
        id: "del_1", status: "active", member: "张三", role: "view",
        effectiveAt: f(-1), expireAt: f(10)
      }]
    });
    assert.equal(r.code, "duplicate_delegation");
    assert.equal(r.existingDelegationId, "del_1");
  });

  it("与正式委派的 approve/execute 职责冲突 -> conflicting_roles", function () {
    const r = prc.validateGrantRequest(
      grantBody({ scope: "batch", resourceId: "b1", role: "approve",
        expireAt: f(24) }),
      { now: NOW, owner: "负责人",
        delegations: [{
          id: "del_x", status: "active", member: "张三", role: "execute",
          effectiveAt: f(-1), expireAt: f(10)
        }] });
    assert.equal(r.code, "conflicting_roles");
    assert.equal(r.conflictingRole, "execute");
  });

  it("pending 批准/执行角色时间窗重叠 -> conflicting_request_roles；窗口错开允许", function () {
    // approve/execute：窗口重叠拒绝
    let r = prc.validateGrantRequest(
      grantBody({ scope: "batch", resourceId: "b1", role: "approve" }), {
        now: NOW, owner: "负责人",
        requests: [pendingGrant({ scope: "batch", resourceId: "b1",
          role: "execute", effectiveAt: f(1), expireAt: f(100) })]
      });
    assert.equal(r.code, "conflicting_request_roles");
    // 窗口不重叠则允许排队
    r = prc.validateGrantRequest(
      grantBody({ scope: "batch", resourceId: "b1", role: "approve",
        effectiveAt: f(200), expireAt: f(300) }), {
        now: NOW, owner: "负责人",
        requests: [pendingGrant({ scope: "batch", resourceId: "b1",
          role: "execute", effectiveAt: f(1), expireAt: f(100) })]
      });
    assert.equal(r.ok, true);
  });

  it("负责人为自己的批次申请 approve -> approver_is_owner", function () {
    const r = prc.validateGrantRequest(
      grantBody({ scope: "batch", resourceId: "b1", role: "approve",
        member: "负责人" }),
      { now: NOW, owner: "负责人" });
    assert.equal(r.code, "approver_is_owner");
  });
});

describe("撤销申请校验", function () {
  function revokeBody(over) {
    return Object.assign({
      scope: "space", resourceId: "sp1", role: "view",
      member: "张三", delegationId: "del_1"
    }, over || {});
  }
  const del = function (over) {
    return Object.assign({
      id: "del_1", scope: "space", resourceId: "sp1", role: "view",
      member: "张三", status: "active",
      effectiveAt: f(-1), expireAt: f(48)
    }, over || {});
  };

  it("合法撤销申请通过", function () {
    const r = prc.validateRevokeRequest(revokeBody(),
      { now: NOW, delegations: [del()] });
    assert.equal(r.ok, true);
  });

  it("委派不存在/不属本人/角色不一致/不属该资源拒绝", function () {
    let r = prc.validateRevokeRequest(revokeBody({ delegationId: "nope" }),
      { now: NOW, delegations: [del()] });
    assert.equal(r.code, "delegation_not_found");
    r = prc.validateRevokeRequest(revokeBody({ member: "李四" }),
      { now: NOW, delegations: [del()] });
    assert.equal(r.code, "not_delegation_member");
    r = prc.validateRevokeRequest(revokeBody({ role: "review" }),
      { now: NOW, delegations: [del()] });
    assert.equal(r.code, "delegation_role_mismatch");
    r = prc.validateRevokeRequest(revokeBody({ resourceId: "sp2" }),
      { now: NOW, delegations: [del()] });
    assert.equal(r.code, "delegation_scope_mismatch");
  });

  it("已撤销/已自然过期的委派撤销申请拒绝", function () {
    let r = prc.validateRevokeRequest(revokeBody(),
      { now: NOW, delegations: [del({ status: "revoked" })] });
    assert.equal(r.code, "duplicate_revoke");
    r = prc.validateRevokeRequest(revokeBody(),
      { now: NOW, delegations: [del({ effectiveAt: f(-10), expireAt: f(-1) })] });
    assert.equal(r.code, "delegation_expired");
  });

  it("同一委派重复 pending 撤销申请拒绝；已过期的申请不阻止重新申请", function () {
    const req = [{
      id: "preq_r1", kind: "revoke", status: "pending",
      delegationId: "del_1", member: "张三", role: "view",
      scope: "space", resourceId: "sp1", expiresAt: f(72), version: 1,
      createdAt: NOW
    }];
    let r = prc.validateRevokeRequest(revokeBody(),
      { now: NOW, delegations: [del()], requests: req });
    assert.equal(r.code, "duplicate_revoke_request");
    req[0].expiresAt = f(-1);
    r = prc.validateRevokeRequest(revokeBody(),
      { now: NOW, delegations: [del()], requests: req });
    assert.equal(r.ok, true);
  });
});

describe("审批校验", function () {
  const baseCtx = function (over) {
    return Object.assign({
      now: NOW, version: 1, actor: "负责人", owner: "负责人",
      delegations: [], requests: []
    }, over || {});
  };

  it("缺少版本号 428 语义；旧版本 request_version_conflict", function () {
    let r = prc.validateDecision(pendingGrant(), { decision: "approve" },
      baseCtx({ version: undefined }));
    assert.equal(r.code, "precondition_required");
    r = prc.validateDecision(pendingGrant(), { decision: "approve" },
      baseCtx({ version: 5 }));
    assert.equal(r.code, "request_version_conflict");
    assert.equal(r.currentVersion, 1);
  });

  it("非 pending 状态拒绝（已批准/已拒绝）", function () {
    let r = prc.validateDecision(pendingGrant({ status: "approved" }),
      { decision: "approve" }, baseCtx());
    assert.equal(r.code, "request_not_pending");
    r = prc.validateDecision(pendingGrant({ status: "rejected" }),
      { decision: "approve" }, baseCtx());
    assert.equal(r.code, "request_not_pending");
  });

  it("过期申请审批 -> request_expired", function () {
    const r = prc.validateDecision(pendingGrant({ expiresAt: f(-1) }),
      { decision: "approve" }, baseCtx());
    assert.equal(r.code, "request_expired");
  });

  it("非负责人审批拒绝；负责人审批自己的申请 self_approval（优先于负责人判定）", function () {
    let r = prc.validateDecision(pendingGrant(), { decision: "approve" },
      baseCtx({ actor: "李四" }));
    assert.equal(r.code, "not_resource_owner");
    r = prc.validateDecision(
      pendingGrant({ member: "负责人" }), { decision: "approve" },
      baseCtx({ actor: "负责人" }));
    assert.equal(r.code, "self_approval");
  });

  it("非法 decision；拒绝必须填原因", function () {
    let r = prc.validateDecision(pendingGrant(), { decision: "maybe" },
      baseCtx());
    assert.equal(r.code, "invalid_decision");
    r = prc.validateDecision(pendingGrant(), { decision: "reject", reason: "  " },
      baseCtx());
    assert.equal(r.code, "reject_reason_required");
  });

  it("批准授予在批准瞬间重新校验：期间已被直授则 duplicate_delegation", function () {
    const r = prc.validateDecision(pendingGrant(), { decision: "approve" },
      baseCtx({ delegations: [{
        id: "del_2", status: "active", member: "张三", role: "view",
        effectiveAt: f(-1), expireAt: f(24)
      }] }));
    assert.equal(r.code, "duplicate_delegation");
  });

  it("批准撤销时目标已被其他途径撤销/已过期 -> 拒绝且不改变权限", function () {
    const rv = pendingGrant({ id: "preq_r", kind: "revoke",
      delegationId: "del_1" });
    let r = prc.validateDecision(rv, { decision: "approve" },
      baseCtx({ delegations: [{
        id: "del_1", status: "revoked", member: "张三", role: "view",
        scope: "space", resourceId: "sp1",
        effectiveAt: f(-10), expireAt: f(48)
      }] }));
    assert.equal(r.code, "duplicate_revoke");
    r = prc.validateDecision(rv, { decision: "approve" },
      baseCtx({ delegations: [{
        id: "del_1", status: "active", member: "张三", role: "view",
        scope: "space", resourceId: "sp1",
        effectiveAt: f(-10), expireAt: f(-1)
      }] }));
    assert.equal(r.code, "delegation_expired");
  });

  it("批准/拒绝合法输入通过", function () {
    let r = prc.validateDecision(pendingGrant(),
      { decision: "approve", reason: "" }, baseCtx());
    assert.equal(r.ok, true);
    assert.equal(r.value.decision, "approve");
    r = prc.validateDecision(pendingGrant(),
      { decision: "reject", reason: "窗口已满" }, baseCtx());
    assert.equal(r.ok, true);
    assert.equal(r.value.reason, "窗口已满");
  });
});

describe("生效预览（纯只读计算）", function () {
  it("当前生效但预览时刻到期 -> expiring；roles 不含该角色", function () {
    const r = prc.previewEffective({
      scope: "space", resourceId: "sp1", member: "张三",
      at: f(72), now: NOW,
      delegations: [{
        id: "del_1", status: "active", member: "张三", role: "view",
        effectiveAt: f(-1), expireAt: f(48), grantedBy: "负责人",
        grantedAt: f(-2)
      }], requests: []
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.roles, []);
    assert.equal(r.value.expiring.length, 1);
  });

  it("未到生效时间的正式委派 -> activating；预览时刻计入 roles", function () {
    const r = prc.previewEffective({
      scope: "space", resourceId: "sp1", member: "张三",
      at: f(24), now: NOW,
      delegations: [{
        id: "del_1", status: "active", member: "张三", role: "review",
        effectiveAt: f(12), expireAt: f(48), grantedBy: "负责人",
        grantedAt: f(-2)
      }], requests: []
    });
    assert.deepEqual(r.value.roles, ["review"]);
    assert.equal(r.value.activating.length, 1);
    assert.deepEqual(r.value.currentRoles, []);
  });

  it("已批准撤销申请：目标委派在预览时刻从 roles 排除并列 revoking", function () {
    const r = prc.previewEffective({
      scope: "space", resourceId: "sp1", member: "张三",
      at: f(24), now: NOW,
      delegations: [{
        id: "del_1", status: "active", member: "张三", role: "review",
        effectiveAt: f(-1), expireAt: f(48)
      }],
      requests: [pendingGrant({ id: "preq_rv", kind: "revoke",
        role: "review", status: "approved", delegationId: "del_1",
        decidedAt: NOW, decidedBy: "负责人" })]
    });
    assert.deepEqual(r.value.roles, []);
    assert.equal(r.value.revoking.length, 1);
    assert.equal(r.value.revoking[0].revokedByRequestId, "preq_rv");
  });

  it("pending 授予申请只出现在 pending 组，绝不计入 roles（预览不改权限）", function () {
    const r = prc.previewEffective({
      scope: "batch", resourceId: "b1", member: "张三",
      at: f(1), now: NOW, delegations: [],
      requests: [pendingGrant({ scope: "batch", resourceId: "b1",
        role: "approve" })]
    });
    assert.deepEqual(r.value.roles, []);
    assert.equal(r.value.pending.length, 1);
    assert.equal(r.value.pending[0].wouldActiveAt, true);
  });

  it("撤销 pending 申请在 pending 组携带 delegationId", function () {
    const r = prc.previewEffective({
      scope: "space", resourceId: "sp1", member: "张三",
      at: f(1), now: NOW,
      delegations: [{
        id: "del_1", status: "active", member: "张三", role: "view",
        effectiveAt: f(-1), expireAt: f(48)
      }],
      requests: [pendingGrant({ id: "preq_rv", kind: "revoke",
        delegationId: "del_1" })]
    });
    // 未批准，角色仍然有效
    assert.deepEqual(r.value.roles, ["view"]);
    assert.equal(r.value.pending[0].delegationId, "del_1");
  });

  it("非法预览时刻拒绝", function () {
    const r = prc.previewEffective({
      scope: "space", resourceId: "sp1", member: "张三",
      at: "not-a-date", now: NOW, delegations: [], requests: []
    });
    assert.equal(r.code, "invalid_at");
  });
});
