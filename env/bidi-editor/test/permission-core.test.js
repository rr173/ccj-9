/* node --test test/permission-core.test.js
 * 角色委派与操作权限纯逻辑单测：角色矩阵、授予校验（重复委派/职责冲突/
 * 负责人自审/时间窗/非法输入）、有效期状态、授权判定（未授权/过期/未生效/
 * 负责人放行/层级隐含）、撤销校验、资源是否已管控。
 */
"use strict";

const test = require("node:test");
const { describe, it } = test;
const assert = require("node:assert/strict");
const perm = require("../permission-core");

const NOW = "2026-09-14T00:00:00Z";
const future = function (hours) {
  return new Date(Date.parse(NOW) + hours * 3600000).toISOString();
};
const past = function (hours) {
  return new Date(Date.parse(NOW) - hours * 3600000).toISOString();
};

function grant(over) {
  return Object.assign({
    scope: "space", resourceId: "sp1", role: "view",
    member: "张三", effectiveAt: NOW, expireAt: future(24)
  }, over || {});
}

describe("角色委派与操作权限纯逻辑", function () {
  it("角色矩阵：space/session 只能 view/review，batch 支持全部四角色", function () {
    assert.deepEqual(perm.ROLES_BY_SCOPE.space, ["view", "review"]);
    assert.deepEqual(perm.ROLES_BY_SCOPE.session, ["view", "review"]);
    assert.deepEqual(perm.ROLES_BY_SCOPE.batch,
      ["view", "review", "approve", "execute"]);
  });

  it("授予：缺少成员/角色/资源/失效时间、非法 scope/role 明确拒绝", function () {
    let r = perm.validateGrant(grant({ member: "  " }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "missing_member");
    r = perm.validateGrant(grant({ role: "admin" }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "invalid_role");
    r = perm.validateGrant(grant({ scope: "tenant" }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "invalid_scope");
    r = perm.validateGrant(grant({ resourceId: "" }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "missing_resource");
    r = perm.validateGrant(grant({ expireAt: "" }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "missing_expire");
    r = perm.validateGrant(grant({ expireAt: "not-a-date" }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "invalid_expire");
    r = perm.validateGrant(grant({ expireAt: past(1),
      effectiveAt: undefined }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "expire_in_past");
  });

  it("授予：space 不允许 approve/execute；生效时间非法或晚于失效时间拒绝", function () {
    let r = perm.validateGrant(grant({ scope: "space", role: "approve" }),
      { now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, "role_not_allowed_for_scope");
    r = perm.validateGrant(grant({ effectiveAt: future(48) }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "effective_after_expire");
    r = perm.validateGrant(grant({ effectiveAt: "bad" }), { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.code, "invalid_effective");
  });

  it("授予：缺省生效时间等于当前时间（立即生效）", function () {
    const r = perm.validateGrant(grant({ effectiveAt: undefined }), { now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.value.effectiveAt, NOW);
  });

  it("重复委派：同成员同角色时间窗重叠拒绝，并返回既有委派 id", function () {
    const existing = [{
      id: "del_old", scope: "space", resourceId: "sp1", role: "view",
      member: "张三", status: "active",
      effectiveAt: future(1), expireAt: future(48)
    }];
    const r = perm.validateGrant(grant(), { existing: existing, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, "duplicate_delegation");
    assert.equal(r.existingDelegationId, "del_old");
  });

  it("重复委派：时间窗不重叠（接续授权）允许", function () {
    const existing = [{
      id: "del_old", scope: "space", resourceId: "sp1", role: "view",
      member: "张三", status: "active",
      effectiveAt: past(48), expireAt: NOW
    }];
    const r = perm.validateGrant(
      grant({ effectiveAt: NOW, expireAt: future(24) }),
      { existing: existing, now: NOW });
    assert.equal(r.ok, true);
  });

  it("重复委派：已撤销或已过期的旧记录不阻挡新委派", function () {
    const existing = [{
      id: "del_old", scope: "batch", resourceId: "bt1", role: "approve",
      member: "李四", status: "revoked",
      effectiveAt: past(1), expireAt: future(1)
    }];
    const r = perm.validateGrant(
      grant({ scope: "batch", resourceId: "bt1", role: "approve",
        member: "李四" }),
      { existing: existing, owner: "负责人", now: NOW });
    assert.equal(r.ok, true);
  });

  it("同一成员权限冲突：batch 上 approve 与 execute 时间窗重叠拒绝", function () {
    const existing = [{
      id: "del_exec", scope: "batch", resourceId: "bt1", role: "execute",
      member: "王五", status: "active",
      effectiveAt: NOW, expireAt: future(48)
    }];
    const r = perm.validateGrant(
      grant({ scope: "batch", resourceId: "bt1", role: "approve",
        member: "王五" }),
      { existing: existing, owner: "负责人", now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, "conflicting_roles");
    assert.equal(r.conflictingRole, "execute");
  });

  it("职责冲突：窗口不重叠（先执行后审批）允许", function () {
    const existing = [{
      id: "del_exec", scope: "batch", resourceId: "bt1", role: "execute",
      member: "王五", status: "active",
      effectiveAt: NOW, expireAt: future(24)
    }];
    const r = perm.validateGrant(
      grant({ scope: "batch", resourceId: "bt1", role: "approve",
        member: "王五", effectiveAt: future(24), expireAt: future(48) }),
      { existing: existing, owner: "负责人", now: NOW });
    assert.equal(r.ok, true);
  });

  it("负责人自审：不能把 approve 角色授予批次负责人", function () {
    const r = perm.validateGrant(
      grant({ scope: "batch", resourceId: "bt1", role: "approve",
        member: "负责人" }),
      { owner: "负责人", now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, "approver_is_owner");
  });

  it("负责人自审规则只限 approve；execute 授予负责人允许", function () {
    const r = perm.validateGrant(
      grant({ scope: "batch", resourceId: "bt1", role: "execute",
        member: "负责人" }),
      { owner: "负责人", now: NOW });
    assert.equal(r.ok, true);
  });

  it("委派状态：active/pending/expired/revoked 按当前时间实时计算", function () {
    const pending = { effectiveAt: future(1), expireAt: future(2),
      status: "active" };
    assert.equal(perm.delegationState(pending, NOW), "pending");
    assert.equal(perm.delegationState(pending, future(1)), "active");
    assert.equal(perm.delegationState(
      { effectiveAt: NOW, expireAt: future(1), status: "active" }, NOW),
      "active");
    assert.equal(perm.delegationState(
      { effectiveAt: past(2), expireAt: past(1), status: "active" }, NOW),
      "expired");
    assert.equal(perm.delegationState(
      { effectiveAt: past(1), expireAt: future(1), status: "revoked" }, NOW),
      "revoked");
  });

  it("角色层级：review/approve/execute 隐含 view", function () {
    assert.equal(perm.roleCovers("review", "view"), true);
    assert.equal(perm.roleCovers("approve", "view"), true);
    assert.equal(perm.roleCovers("execute", "view"), true);
    assert.equal(perm.roleCovers("view", "review"), false);
    assert.equal(perm.roleCovers("approve", "execute"), false);
    assert.equal(perm.roleCovers("execute", "approve"), false);
  });

  it("authorize：未配置权限的资源直接放行（向后兼容）", function () {
    const r = perm.authorize({ delegations: [], member: "陌生人",
      required: "view", owner: "负责人", now: NOW });
    assert.equal(r.allowed, true);
    assert.equal(r.configured, false);
  });

  it("authorize：负责人始终放行（含全部角色）", function () {
    const dels = [{ scope: "space", resourceId: "sp1", role: "view",
      member: "张三", status: "active",
      effectiveAt: NOW, expireAt: future(1) }];
    const r = perm.authorize({ delegations: dels, member: "负责人",
      required: "execute", owner: "负责人", now: NOW });
    assert.equal(r.allowed, true);
    assert.equal(r.owner, true);
  });

  it("authorize：无角色 -> unauthorized；缺成员 -> missing_member", function () {
    const dels = [{ scope: "space", resourceId: "sp1", role: "view",
      member: "张三", status: "active",
      effectiveAt: NOW, expireAt: future(1) }];
    let r = perm.authorize({ delegations: dels, member: "李四",
      required: "view", owner: "负责人", now: NOW });
    assert.equal(r.allowed, false);
    assert.equal(r.reason.code, "unauthorized");
    r = perm.authorize({ delegations: dels, member: "",
      required: "view", owner: "负责人", now: NOW });
    assert.equal(r.allowed, false);
    assert.equal(r.reason.code, "missing_member");
  });

  it("authorize：只有过期角色 -> role_expired；只有未生效角色 -> role_not_active",
    function () {
      const expired = [{ scope: "space", resourceId: "sp1", role: "view",
        member: "张三", status: "active",
        effectiveAt: past(2), expireAt: past(1) }];
      let r = perm.authorize({ delegations: expired, member: "张三",
        required: "view", owner: "负责人", now: NOW });
      assert.equal(r.allowed, false);
      assert.equal(r.reason.code, "role_expired");
      const pending = [{ scope: "space", resourceId: "sp1", role: "review",
        member: "张三", status: "active",
        effectiveAt: future(1), expireAt: future(2) }];
      r = perm.authorize({ delegations: pending, member: "张三",
        required: "review", owner: "负责人", now: NOW });
      assert.equal(r.allowed, false);
      assert.equal(r.reason.code, "role_not_active");
    });

  it("authorize：高角色满足低角色要求（review 可以 view）", function () {
    const dels = [{ scope: "space", resourceId: "sp1", role: "review",
      member: "张三", status: "active",
      effectiveAt: NOW, expireAt: future(1) }];
    const r = perm.authorize({ delegations: dels, member: "张三",
      required: "view", owner: "负责人", now: NOW });
    assert.equal(r.allowed, true);
    assert.deepEqual(r.roles, ["review"]);
  });

  it("activeRoles：只返回当前时刻生效角色（撤销/过期/未生效均剔除）",
    function () {
      const dels = [
        { role: "view", member: "张三", status: "active",
          effectiveAt: NOW, expireAt: future(1) },
        { role: "review", member: "张三", status: "revoked",
          effectiveAt: NOW, expireAt: future(1) },
        { role: "execute", member: "张三", status: "active",
          effectiveAt: past(2), expireAt: past(1) },
        { role: "view", member: "李四", status: "active",
          effectiveAt: NOW, expireAt: future(1) }
      ];
      assert.deepEqual(perm.activeRoles(dels, "张三", NOW), ["view"]);
    });

  it("撤销校验：已撤销重复撤销拒绝；自然过期拒绝撤销；active 允许", function () {
    let r = perm.validateRevoke(
      { status: "revoked", revokedBy: "负责人" }, {}, NOW);
    assert.equal(r.ok, false); assert.equal(r.code, "duplicate_revoke");
    r = perm.validateRevoke(
      { status: "active", effectiveAt: past(2), expireAt: past(1) }, {}, NOW);
    assert.equal(r.ok, false); assert.equal(r.code, "delegation_expired");
    r = perm.validateRevoke(
      { status: "active", effectiveAt: NOW, expireAt: future(1) }, {}, NOW);
    assert.equal(r.ok, true);
    r = perm.validateRevoke(null, {}, NOW);
    assert.equal(r.ok, false); assert.equal(r.code, "delegation_not_found");
  });

  it("isConfigured：有任意委派记录（含已撤销）即为已管控", function () {
    assert.equal(perm.isConfigured([]), false);
    assert.equal(perm.isConfigured([{ scope: "space", status: "revoked" }]),
      true);
  });

  it("时间窗重叠判定：半开区间，相接不重叠", function () {
    assert.equal(perm.windowsOverlap(0, 10, 10, 20), false);
    assert.equal(perm.windowsOverlap(0, 11, 10, 20), true);
    assert.equal(perm.windowsOverlap(10, 20, 0, 10), false);
  });
});
