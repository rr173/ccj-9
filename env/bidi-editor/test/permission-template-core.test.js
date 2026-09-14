/* node --test test/permission-template-core.test.js
 * 申请模板与条件校验纯逻辑单测：
 *   模板创建/更新校验（名称/角色矩阵/默认有效期/说明/适用成员范围）、
 *   模板停用与旧版本拒绝、适用范围可见性、版本快照与溯源、
 *   用模板发起申请时按提交瞬间的正式委派/待处理申请重新校验
 *   （角色已存在/重复申请/时间窗职责冲突/负责人自审/版本变化/范围外）。
 */
"use strict";

const test = require("node:test");
const { describe, it } = test;
const assert = require("node:assert/strict");
const tc = require("../permission-template-core");

const NOW = "2026-09-14T00:00:00Z";
const f = function (hours) {
  return new Date(Date.parse(NOW) + hours * 3600000).toISOString();
};
const DAY = 24 * 3600000;

function baseCreate(over) {
  return Object.assign({
    name: "查看角色模板", scope: "space", resourceId: "sp1",
    role: "view", kind: "grant", defaultDurationMs: DAY,
    description: "说明", memberScope: { mode: "all", members: [] }
  }, over || {});
}
function tpl(over) {
  return Object.assign({
    id: "ptpl_1", scope: "space", resourceId: "sp1",
    name: "查看角色模板", role: "view", kind: "grant",
    defaultDurationMs: DAY, description: "说明",
    memberScope: { mode: "all", members: [] },
    status: "active", currentVersion: 1,
    createdAt: f(-10), createdBy: "负责人",
    updatedAt: null, updatedBy: null,
    disabledAt: null, disabledBy: null, history: []
  }, over || {});
}
function delegation(over) {
  return Object.assign({
    id: "del_1", status: "active", scope: "space", resourceId: "sp1",
    role: "view", member: "张三", effectiveAt: NOW, expireAt: f(48)
  }, over || {});
}
function pendingRequest(over) {
  return Object.assign({
    id: "preq_1", kind: "grant", status: "pending", scope: "space",
    resourceId: "sp1", role: "view", member: "张三",
    effectiveAt: NOW, expireAt: f(48), expiresAt: f(72)
  }, over || {});
}
function ctx(over) {
  return Object.assign({
    now: NOW, member: "张三", templateVersion: 1, owner: "负责人",
    delegations: [], requests: []
  }, over || {});
}

describe("模板创建校验", function () {
  it("合法授予模板通过并保留全部字段", function () {
    const r = tc.validateTemplateBody(baseCreate(),
      { now: NOW, isCreate: true });
    assert.equal(r.ok, true);
    assert.equal(r.value.defaultDurationMs, DAY);
    assert.deepEqual(r.value.memberScope, { mode: "all", members: [] });
  });

  it("缺 scope/resourceId/名称/类型/角色拒绝", function () {
    let r = tc.validateTemplateBody(baseCreate({ scope: "nope" }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "invalid_scope");
    r = tc.validateTemplateBody(baseCreate({ resourceId: " " }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "missing_resource");
    r = tc.validateTemplateBody(baseCreate({ name: "" }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "missing_template_name");
    r = tc.validateTemplateBody(baseCreate({ kind: "x" }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "invalid_kind");
    r = tc.validateTemplateBody(baseCreate({ role: "root" }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "invalid_role");
  });

  it("角色矩阵：space/session 不支持 approve/execute", function () {
    let r = tc.validateTemplateBody(
      baseCreate({ role: "approve" }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "role_not_allowed_for_scope");
    r = tc.validateTemplateBody(
      baseCreate({ scope: "batch", role: "execute" }),
      { now: NOW, isCreate: true });
    assert.equal(r.ok, true);
    r = tc.validateTemplateBody(
      baseCreate({ scope: "session", role: "review" }),
      { now: NOW, isCreate: true });
    assert.equal(r.ok, true);
  });

  it("授予模板必须设置合法默认有效期；撤销模板不需要", function () {
    let r = tc.validateTemplateBody(baseCreate({ defaultDurationMs: null }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "missing_default_duration");
    r = tc.validateTemplateBody(baseCreate({ defaultDurationMs: 1000 }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "invalid_default_duration");
    r = tc.validateTemplateBody(
      baseCreate({ kind: "revoke", role: "view", defaultDurationMs: null }),
      { now: NOW, isCreate: true });
    assert.equal(r.ok, true);
    assert.equal(r.value.defaultDurationMs, null);
    r = tc.validateTemplateBody(
      baseCreate({ kind: "revoke", role: "view" }),
      { now: NOW, isCreate: true });
    assert.equal(r.ok, true);
    assert.equal(r.value.defaultDurationMs, null);
  });

  it("说明长度上限拒绝", function () {
    const r = tc.validateTemplateBody(
      baseCreate({ description: "x".repeat(501) }),
      { now: NOW, isCreate: true });
    assert.equal(r.code, "description_too_long");
  });

  it("模板数量上限拒绝", function () {
    const r = tc.validateTemplateBody(baseCreate(),
      { now: NOW, isCreate: true,
        templateCount: tc.LIMITS.TEMPLATES_PER_RESOURCE_MAX });
    assert.equal(r.code, "template_too_large");
  });
});

describe("适用成员范围", function () {
  it("缺省视为全体；members 模式必须给非空去重后的成员数组", function () {
    let r = tc.normalizeMemberScope(undefined);
    assert.equal(r.value, undefined);
    r = tc.normalizeMemberScope({ mode: "members", members: ["张三", "张三", " 李四 "] });
    assert.deepEqual(r.value, { mode: "members", members: ["张三", "李四"] });
    r = tc.normalizeMemberScope({ mode: "members", members: [] });
    assert.equal(r.code, "missing_scope_members");
    r = tc.normalizeMemberScope({ mode: "members", members: ["a/b"] });
    assert.equal(r.code, "invalid_scope_member");
    r = tc.normalizeMemberScope({ mode: "wrong" });
    assert.equal(r.code, "invalid_member_scope");
  });

  it("memberInScope：全体恒真；白名单严格匹配", function () {
    assert.equal(tc.memberInScope(tpl(), "张三"), true);
    const t = tpl({ memberScope: { mode: "members", members: ["张三"] } });
    assert.equal(tc.memberInScope(t, "张三"), true);
    assert.equal(tc.memberInScope(t, "李四"), false);
  });
});

describe("模板更新校验", function () {
  it("只校验给出的字段；改角色后再给有效期按当前类型处理", function () {
    const r = tc.validateTemplateBody({ name: "新名称" }, { now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.value.name, "新名称");
    // 更新时把 kind 改成 grant 且同时给有效期 -> 合法
    const r2 = tc.validateTemplateBody(
      { kind: "grant", defaultDurationMs: DAY },
      { now: NOW, currentScope: "space", currentKind: "revoke" });
    assert.equal(r2.ok, true);
    assert.equal(r2.value.defaultDurationMs, DAY);
  });

  it("撤销模板改成授予但不给有效期 -> 明确拒绝，不产生可提交的死模板", function () {
    // 只改 kind，不带 defaultDurationMs（原撤销模板没有有效期）
    let r = tc.validateTemplateBody(
      { kind: "grant" },
      { now: NOW, currentScope: "space", currentKind: "revoke",
        currentDefaultDurationMs: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, "missing_default_duration");

    // 只改别的字段（如名称）也不能让结果变成无有效期的授予模板
    r = tc.validateTemplateBody(
      { name: "新名称" },
      { now: NOW, currentScope: "space", currentKind: "grant",
        currentDefaultDurationMs: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, "missing_default_duration");

    // 显式给 null 同样拒绝（不能静默清空）
    r = tc.validateTemplateBody(
      { kind: "grant", defaultDurationMs: null },
      { now: NOW, currentScope: "space", currentKind: "revoke",
        currentDefaultDurationMs: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, "missing_default_duration");

    // 给了有效期 -> 通过
    r = tc.validateTemplateBody(
      { kind: "grant", defaultDurationMs: DAY },
      { now: NOW, currentScope: "space", currentKind: "revoke",
        currentDefaultDurationMs: null });
    assert.equal(r.ok, true);
    assert.equal(r.value.defaultDurationMs, DAY);
  });

  it("授予模板更新时显式 null 保留既有合法有效期，不静默清空", function () {
    const r = tc.validateTemplateBody(
      { defaultDurationMs: null },
      { now: NOW, currentScope: "space", currentKind: "grant",
        currentDefaultDurationMs: DAY });
    assert.equal(r.ok, true);
    assert.equal(r.value.defaultDurationMs, DAY);
  });

  it("改成撤销类型时无论是否传有效期都归一为 null", function () {
    const r = tc.validateTemplateBody(
      { kind: "revoke", defaultDurationMs: DAY },
      { now: NOW, currentScope: "space", currentKind: "grant",
        currentDefaultDurationMs: DAY });
    assert.equal(r.ok, true);
    assert.equal(r.value.defaultDurationMs, null);
  });
});

describe("用模板发起申请：停用/版本/范围", function () {
  it("停用模板拒绝 template_disabled", function () {
    const r = tc.validateTemplateSubmit(tpl({ status: "disabled" }), {}, ctx());
    assert.equal(r.code, "template_disabled");
  });

  it("必须携带 templateVersion；旧版本 template_version_changed", function () {
    let r = tc.validateTemplateSubmit(tpl(), {}, ctx({ templateVersion: null }));
    assert.equal(r.code, "precondition_required");
    r = tc.validateTemplateSubmit(tpl({ currentVersion: 3 }), {},
      ctx({ templateVersion: 2 }));
    assert.equal(r.code, "template_version_changed");
    assert.equal(r.currentVersion, 3);
    assert.equal(r.submittedVersion, 2);
  });

  it("templateVersion 严格整数校验：1abc/小数/布尔/字符串一律拒绝", function () {
    const bad = ["1abc", "1", " 1 ", "1.0", 1.5, true, {}, [], -1, 0, NaN];
    for (const v of bad) {
      const r = tc.validateTemplateSubmit(tpl(), {}, ctx({ templateVersion: v }));
      assert.equal(r.code, "invalid_template_version",
        "templateVersion=" + JSON.stringify(v) + " 应被拒绝，实际：" +
        JSON.stringify(r));
      assert.equal("submittedVersion" in r, false);
    }
    // 合法正整数且匹配 -> 正常通过（不因严格校验误伤正常路径）
    const ok = tc.validateTemplateSubmit(tpl(), {}, ctx({ templateVersion: 1 }));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    // 数字形式但与当前版本不符 -> 仍按版本已变化处理
    const changed = tc.validateTemplateSubmit(tpl({ currentVersion: 2 }), {},
      ctx({ templateVersion: 1 }));
    assert.equal(changed.code, "template_version_changed");
    assert.equal(changed.submittedVersion, 1);
  });

  it("成员不在适用范围 member_not_in_template_scope", function () {
    const t = tpl({ memberScope: { mode: "members", members: ["李四"] } });
    const r = tc.validateTemplateSubmit(t, {}, ctx());
    assert.equal(r.code, "member_not_in_template_scope");
  });

  it("模板不存在 template_not_found；非法成员名拒绝", function () {
    let r = tc.validateTemplateSubmit(null, {}, ctx());
    assert.equal(r.code, "template_not_found");
    r = tc.validateTemplateSubmit(tpl(), {}, ctx({ member: "a/b" }));
    assert.equal(r.code, "invalid_member");
  });
});

describe("用模板发起授予申请：提交时条件复核", function () {
  it("默认时间窗 = now ~ now+defaultDurationMs，校验通过并回溯源", function () {
    const t = tpl();
    const r = tc.validateTemplateSubmit(t, {}, ctx());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.kind, "grant");
    assert.equal(r.value.target.effectiveAt, NOW);
    assert.equal(r.value.target.expireAt, f(24));
    assert.equal(r.value.provenance.templateId, "ptpl_1");
    assert.equal(r.value.provenance.templateVersion, 1);
    assert.equal(r.value.provenance.templateName, "查看角色模板");
  });

  it("显式 expireAt/effectiveAt 覆盖默认窗口", function () {
    const r = tc.validateTemplateSubmit(tpl(),
      { effectiveAt: f(1), expireAt: f(12) }, ctx());
    assert.equal(r.ok, true);
    assert.equal(r.value.target.effectiveAt, f(1));
    assert.equal(r.value.target.expireAt, f(12));
  });

  it("角色已存在（正式委派时间窗重叠）-> duplicate_delegation", function () {
    const r = tc.validateTemplateSubmit(tpl(), {},
      ctx({ delegations: [delegation()] }));
    assert.equal(r.code, "duplicate_delegation");
  });

  it("已有待处理同角色申请 -> duplicate_request", function () {
    const r = tc.validateTemplateSubmit(tpl(), {},
      ctx({ requests: [pendingRequest()] }));
    assert.equal(r.code, "duplicate_request");
  });

  it("approve/execute 时间窗职责冲突 -> conflicting_roles", function () {
    const t = tpl({ scope: "batch", resourceId: "b1", role: "approve" });
    const r = tc.validateTemplateSubmit(t, { expireAt: f(24) },
      ctx({ delegations: [delegation({
        scope: "batch", resourceId: "b1", role: "execute" })] }));
    assert.equal(r.code, "conflicting_roles");
  });

  it("负责人不能申请自己批次的 approve 角色（approver_is_owner）", function () {
    const t = tpl({ scope: "batch", resourceId: "b1", role: "approve" });
    const r = tc.validateTemplateSubmit(t, { expireAt: f(24) },
      ctx({ member: "负责人", owner: "负责人" }));
    assert.equal(r.code, "approver_is_owner");
  });

  it("白名单成员通过；范围外成员拒绝", function () {
    const t = tpl({ memberScope: { mode: "members", members: ["张三"] } });
    assert.equal(tc.validateTemplateSubmit(t, {}, ctx()).ok, true);
    assert.equal(tc.validateTemplateSubmit(t, {},
      ctx({ member: "李四" })).code, "member_not_in_template_scope");
  });
});

describe("用模板发起撤销申请", function () {
  it("必须指定本人有效委派，通过后返回 revoke 目标与溯源", function () {
    const t = tpl({ kind: "revoke", defaultDurationMs: null });
    const d = delegation();
    let r = tc.validateTemplateSubmit(t, {},
      ctx({ delegations: [d] }));
    assert.equal(r.code, "missing_delegation");
    r = tc.validateTemplateSubmit(t, { delegationId: "del_1" },
      ctx({ delegations: [d] }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.kind, "revoke");
    assert.equal(r.value.target.delegationId, "del_1");
    assert.equal(r.value.provenance.kind, "revoke");
  });

  it("非本人委派 not_delegation_member；已撤销 duplicate_revoke", function () {
    const t = tpl({ kind: "revoke", defaultDurationMs: null });
    let r = tc.validateTemplateSubmit(t, { delegationId: "del_1" },
      ctx({ delegations: [delegation({ member: "李四" })] }));
    assert.equal(r.code, "not_delegation_member");
    r = tc.validateTemplateSubmit(t, { delegationId: "del_1" },
      ctx({ delegations: [delegation({ status: "revoked" })] }));
    assert.equal(r.code, "duplicate_revoke");
  });
});

function releaseTemplate(over) {
  const t = tpl(over);
  const snap = Object.assign({
    releaseId: "trel_1", version: 1,
    scope: "space", resourceId: "sp1"
  }, tc.contentSnapshot(t, 1));
  t.releases = [{
    id: "trel_1", version: 1, source: "publish",
    publishedAt: NOW, publishedBy: "负责人", snapshot: snap
  }];
  t.currentVersion = 1;
  return t;
}

describe("发布草稿与发布版本", function () {
  it("成员提交只读取 releases 最新发布版本，不读取顶层草稿字段", function () {
    const t = releaseTemplate({
      name: "已发布名称", defaultDurationMs: DAY,
      memberScope: { mode: "members", members: ["张三"] }
    });
    t.name = "草稿名称";
    t.defaultDurationMs = 3 * DAY;
    t.currentVersion = 99;
    const r = tc.validateTemplateSubmit(t, {},
      ctx({ templateVersion: 1 }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.provenance.templateVersion, 1);
    assert.equal(r.value.provenance.templateName, "已发布名称");
    assert.equal(r.value.provenance.defaultDurationMs, DAY);
  });

  it("回滚目标必须存在且适用范围、角色、有效期完整", function () {
    const t = releaseTemplate();
    let r = tc.validateReleaseSnapshot(null);
    assert.equal(r.code, "release_version_not_found");
    const bad = JSON.parse(JSON.stringify(t.releases[0].snapshot));
    bad.role = "root";
    r = tc.validateReleaseSnapshot(bad, { scope: "space", resourceId: "sp1" });
    assert.equal(r.code, "invalid_published_template");
    bad.role = "view";
    bad.memberScope = { mode: "members", members: [] };
    r = tc.validateReleaseSnapshot(bad, { scope: "space", resourceId: "sp1" });
    assert.equal(r.code, "invalid_published_template");
    const good = JSON.parse(JSON.stringify(t.releases[0].snapshot));
    assert.equal(tc.validateReleaseSnapshot(good).ok, true);
  });

  it("同资源相同时间只能有一个待执行计划", function () {
    const a = releaseTemplate({ id: "ptpl_a" });
    const b = releaseTemplate({ id: "ptpl_b" });
    a.publishPlans = [{
      id: "tpln_1", status: "pending", scheduledAt: f(24),
      templateVersion: 1, draftVersion: 1
    }];
    const conflict = tc.validatePlanConflict([a, b], b,
      { scheduledAt: f(24), scope: "space", resourceId: "sp1" });
    assert.equal(conflict.code, "scheduled_publish_conflict");
    const otherTime = tc.validatePlanConflict([a, b], b,
      { scheduledAt: f(25), scope: "space", resourceId: "sp1" });
    assert.equal(otherTime.ok, true);
  });
});

describe("快照、溯源与对外视图", function () {
  it("contentSnapshot 是不可变拷贝（修改模板不影响旧快照）", function () {
    const t = tpl({ memberScope: { mode: "members", members: ["张三"] } });
    const snap = tc.contentSnapshot(t, 1);
    t.memberScope.members.push("李四");
    t.name = "改名";
    assert.deepEqual(snap.memberScope.members, ["张三"]);
    assert.equal(snap.name, "查看角色模板");
  });

  it("provenance 固化模板版本；publicTemplate 区分负责人/成员视图", function () {
    const t = tpl({ memberScope: { mode: "members", members: ["张三", "李四"] } });
    const prov = tc.provenance(t);
    assert.equal(prov.templateVersion, 1);
    const full = tc.publicTemplate(t);
    assert.deepEqual(full.memberScope.members, ["张三", "李四"]);
    assert.equal(full.memberScope.memberCount, 2);
    // 普通成员视图：不暴露完整白名单
    const mine = tc.publicTemplateForMember(t, "张三");
    assert.equal(mine.inScope, true);
    assert.deepEqual(mine.memberScope.members, []);
    // 停用 / 范围外 / null -> null
    assert.equal(tc.publicTemplateForMember(
      tpl({ status: "disabled" }), "张三"), null);
    assert.equal(tc.publicTemplateForMember(t, "王五"), null);
  });
});
