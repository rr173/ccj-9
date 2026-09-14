/* permission-template-core.js
 * “申请模板与条件校验”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.PermissionTemplateCore），Node 下可直接 require 单测。
 *
 * 在既有“权限变更申请”（permission-request-core.js）与“申请分组与批量处理”
 * （permission-request-group-core.js）之上引入可复用申请模板：
 *   资源负责人为某个资源（space/session/batch）保存模板，模板包含角色、申请类型
 *   （grant 授予 / revoke 撤销）、默认有效期、说明与适用成员范围（全体或白名单）。
 *   普通成员只能看到/使用“适用范围包含自己且处于启用状态”的模板发起申请。
 *
 * 版本与历史：
 *   - 模板集合有独立单调版本号 templateRev（X-Permission-Template-Rev），
 *     与申请集合 requestRev、分组集合 groupRev、正式委派集合 rev 四者相互独立；
 *   - 每个模板自带单调内容版本 currentVersion：创建=1，每次内容修改 +1，
 *     停用不改内容版本；全部 create/update/disable 事件进入只增不改的
 *     history（版本历史），内容事件携带该版本的完整快照 snapshot；
 *   - 发起申请必须显式携带 templateVersion 且严格等于 currentVersion，
 *     模板在此期间被修改 -> template_version_changed 明确拒绝；
 *   - 停用模板与旧版本模板都不能继续创建新申请。
 *
 * 提交时条件校验（validateTemplateSubmit）：
 *   模板只提供“默认值”，真正建单前按提交瞬间的角色配置、已有正式委派与
 *   待处理申请重新校验，直接复用 permission-request-core 的硬规则：
 *   角色已存在 duplicate_delegation、重复申请 duplicate_request、
 *   时间窗/职责冲突 conflicting_roles / conflicting_request_roles、
 *   成员不在适用范围 member_not_in_template_scope、模板版本已变化
 *   template_version_changed、模板已停用 template_disabled 等，全部明确拒绝。
 *
 * 溯源：成功创建的申请记录 templateId/templateVersion 与该版本完整快照，
 * 后续模板修改/停用不改变任何已提交申请（快照独立留存）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./permission-request-core"));
  } else {
    root.PermissionTemplateCore = factory(root.PermissionRequestCore);
  }
})(typeof self !== "undefined" ? self : this, function (prc) {
  "use strict";

  prc = prc || (typeof require === "function"
    ? require("./permission-request-core") : null);

  var SCOPES = prc.SCOPES;
  var ROLES = prc.ROLES;
  var KINDS = prc.KINDS;
  var ROLE_LABELS = prc.ROLE_LABELS;
  var SCOPE_LABELS = prc.SCOPE_LABELS;

  // 模板状态：active 启用（可发起新申请）/ disabled 停用（只读，不能再发起）
  var STATUSES = ["active", "disabled"];
  var SCOPE_MODES = ["all", "members"];

  var LIMITS = {
    NAME_MAX_CHARS: 100,
    DESCRIPTION_MAX_CHARS: 500,
    NOTE_MAX_CHARS: prc.LIMITS.NOTE_MAX_CHARS,
    SCOPE_MEMBERS_MAX: 200,       // 白名单成员数量上限
    TEMPLATES_PER_RESOURCE_MAX: 500,
    TEMPLATE_LOGS_MAX: 20000,
    // 默认有效期（授予申请）：1 分钟 ~ 366 天
    MIN_DURATION_MS: 60 * 1000,
    MAX_DURATION_MS: 366 * 24 * 3600 * 1000
  };

  function fail(code, message, extra) {
    var f = { ok: false, code: code, message: message };
    if (extra) { for (var k in extra) { f[k] = extra[k]; } }
    return f;
  }
  function ok(value) { return { ok: true, value: value }; }

  function charLen(s) { return Array.from(s).length; }

  function validateTextField(value, field, codePrefix, max) {
    if (value === undefined || value === null) return ok(undefined);
    if (typeof value !== "string") {
      return fail("invalid_" + codePrefix, "字段必须是字符串");
    }
    var v = value.trim();
    if (charLen(v) > max) return fail(codePrefix + "_too_long", "字段最长 " + max + " 字符");
    return ok(v);
  }

  /* ================= 适用成员范围校验 =================
   * 允许两种形态：
   *   { mode: "all" }                     全体成员（资源上任何成员可见可用）
   *   { mode: "members", members: [...] } 白名单（成员名各 ≤50 字、去重、非空）
   * 缺省（创建时未给）视为全体。
   */
  function normalizeMemberScope(raw) {
    if (raw === undefined || raw === null) return ok(undefined);
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return fail("invalid_member_scope",
        "适用成员范围必须是对象：{mode:\"all\"} 或 {mode:\"members\",members:[...]}");
    }
    var mode = raw.mode;
    if (SCOPE_MODES.indexOf(mode) === -1) {
      return fail("invalid_member_scope",
        "适用成员范围的 mode 必须是 all（全体）或 members（指定成员）");
    }
    if (mode === "all") {
      return ok({ mode: "all", members: [] });
    }
    if (!Array.isArray(raw.members)) {
      return fail("missing_scope_members",
        "适用成员范围为指定成员时，members 必须是成员名数组");
    }
    var seen = Object.create(null);
    var members = [];
    for (var i = 0; i < raw.members.length; i++) {
      var mc = prc.validateMember(raw.members[i]);
      if (!mc.ok) {
        return fail("invalid_scope_member",
          "适用成员范围中的第 " + (i + 1) + " 个成员不合法：" + mc.message);
      }
      if (seen[mc.value]) continue; // 去重
      seen[mc.value] = true;
      members.push(mc.value);
    }
    if (!members.length) {
      return fail("missing_scope_members",
        "适用成员范围为指定成员时，至少包含一个成员");
    }
    if (members.length > LIMITS.SCOPE_MEMBERS_MAX) {
      return fail("too_many_scope_members",
        "适用成员范围最多 " + LIMITS.SCOPE_MEMBERS_MAX + " 个成员");
    }
    return ok({ mode: "members", members: members });
  }

  function memberInScope(template, member) {
    if (!template) return false;
    var ms = template.memberScope || { mode: "all" };
    if (ms.mode === "all") return true;
    return Array.isArray(ms.members) && ms.members.indexOf(member) !== -1;
  }

  /* ================= 模板创建/更新内容校验 =================
   * body: {name?, scope?, resourceId?, role?, kind?,
   *         defaultDurationMs?, description?, memberScope?}
   * ctx:  {isCreate, now, templateCount?}
   * 创建时 scope/resourceId/name/role/kind 必填；授予模板 defaultDurationMs 必填。
   * 更新时只校验给出的字段（调用方负责合并），不允许把必填字段改成空。
   */
  function validateTemplateBody(body, ctx) {
    body = body || {};
    ctx = ctx || {};
    var out = {};

    if (ctx.isCreate) {
      var scope = typeof body.scope === "string" ? body.scope : "";
      if (SCOPES.indexOf(scope) === -1) {
        return fail("invalid_scope", "资源类型必须是 space / session / batch 之一");
      }
      var resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
      if (!resourceId) return fail("missing_resource", "缺少资源 id");
      out.scope = scope;
      out.resourceId = resourceId;
      if (Number.isInteger(ctx.templateCount) &&
          ctx.templateCount >= LIMITS.TEMPLATES_PER_RESOURCE_MAX) {
        return fail("template_too_large",
          "该资源的申请模板已达上限 " + LIMITS.TEMPLATES_PER_RESOURCE_MAX);
      }
    }

    if (ctx.isCreate || body.name !== undefined) {
      var nc = validateTextField(body.name, "name", "name", LIMITS.NAME_MAX_CHARS);
      if (!nc.ok) return nc;
      if (!nc.value) return fail("missing_template_name", "模板名称不能为空");
      out.name = nc.value;
    }

    if (ctx.isCreate || body.kind !== undefined) {
      var kind = typeof body.kind === "string" ? body.kind : "";
      if (KINDS.indexOf(kind) === -1) {
        return fail("invalid_kind",
          "申请类型必须是 grant（授予申请）或 revoke（撤销申请）");
      }
      out.kind = kind;
    }

    if (ctx.isCreate || body.role !== undefined) {
      var role = typeof body.role === "string" ? body.role : "";
      if (ROLES.indexOf(role) === -1) {
        return fail("invalid_role",
          "角色必须是 view / review / approve / execute 之一");
      }
      // 与申请/委派同一角色矩阵：space/session 仅 view/review
      var scopeForRole = out.scope || ctx.currentScope;
      if (scopeForRole &&
          (scopeForRole === "space" || scopeForRole === "session") &&
          (role === "approve" || role === "execute")) {
        return fail("role_not_allowed_for_scope",
          SCOPE_LABELS[scopeForRole] + "不支持配置“" + ROLE_LABELS[role] + "”角色");
      }
      out.role = role;
    }

    // 默认有效期：只对授予模板有意义；撤销模板无论是否传值统一存 null
    var kindForDur = out.kind || ctx.currentKind;
    if (ctx.isCreate || body.defaultDurationMs !== undefined) {
      if (kindForDur === "revoke") {
        out.defaultDurationMs = null;
      } else {
        var d = body.defaultDurationMs;
        if (d === undefined || d === null) {
          if (ctx.isCreate) {
            return fail("missing_default_duration",
              "授予申请模板必须设置默认有效期（毫秒）");
          }
          out.defaultDurationMs = undefined;
        } else {
          var dv = checkDuration(d);
          if (!dv.ok) return dv;
          out.defaultDurationMs = dv.value;
        }
      }
    }

    if (ctx.isCreate || body.description !== undefined) {
      var gc = validateTextField(body.description, "description", "description",
        LIMITS.DESCRIPTION_MAX_CHARS);
      if (!gc.ok) return gc;
      out.description = gc.value || "";
    }

    if (ctx.isCreate || body.memberScope !== undefined) {
      var sc = normalizeMemberScope(body.memberScope);
      if (!sc.ok) return sc;
      if (sc.value !== undefined) out.memberScope = sc.value;
    }

    return ok(out);
  }

  function checkDuration(d) {
    var n = Number(d);
    if (!Number.isInteger(n)) {
      return fail("invalid_default_duration",
        "默认有效期必须是整数毫秒数");
    }
    if (n < LIMITS.MIN_DURATION_MS || n > LIMITS.MAX_DURATION_MS) {
      return fail("invalid_default_duration",
        "默认有效期必须在 " + LIMITS.MIN_DURATION_MS + " ~ " +
        LIMITS.MAX_DURATION_MS + " 毫秒之间（1 分钟 ~ 366 天）");
    }
    return ok(n);
  }

  /* ================= 组装某内容版本的不可变快照 ================= */
  function contentSnapshot(t, version) {
    return {
      version: version,
      name: t.name,
      role: t.role,
      kind: t.kind,
      defaultDurationMs: t.defaultDurationMs,
      description: t.description || "",
      memberScope: JSON.parse(JSON.stringify(t.memberScope || { mode: "all", members: [] }))
    };
  }

  // 申请记录上留存的模板来源（完整快照；模板日后修改不影响已提交申请）
  function provenance(t) {
    return {
      templateId: t.id,
      templateVersion: t.currentVersion,
      templateName: t.name,
      role: t.role,
      kind: t.kind,
      defaultDurationMs: t.defaultDurationMs,
      description: t.description || "",
      memberScope: JSON.parse(JSON.stringify(
        t.memberScope || { mode: "all", members: [] })),
      scope: t.scope,
      resourceId: t.resourceId
    };
  }

  /* ================= 用模板发起申请：提交时条件校验 =================
   * template: 模板当前记录（调用方按 id 取出）
   * body:     {effectiveAt?, expireAt?, note?, delegationId?(revoke)}
   * ctx:      {now, member(发起人本人), templateVersion(必填),
   *            owner, delegations, requests}
   *
   * 规则顺序（任一失败即拒绝，不创建任何申请）：
   *   1. 模板必须处于 active（停用 -> template_disabled）；
   *   2. templateVersion 严格等于 currentVersion（旧版本 -> template_version_changed）；
   *   3. 发起人必须在适用成员范围内（member_not_in_template_scope）；
   *   4. 授予模板默认时间窗 = now ~ now+defaultDurationMs，可显式给
   *      effectiveAt/expireAt 覆盖；随后复用申请流全部硬规则按“当前正式委派 +
   *      待处理申请”重新校验（角色已存在/时间窗冲突/职责冲突/负责人自审/重复申请）。
   */
  function validateTemplateSubmit(template, body, ctx) {
    body = body || {};
    ctx = ctx || {};
    var nowIso = ctx.now || new Date().toISOString();

    if (!template) return fail("template_not_found", "申请模板不存在");
    if (template.status === "disabled") {
      return fail("template_disabled",
        "模板 “" + template.name + "” 已停用，停用模板不能继续创建新申请；" +
        "请联系资源负责人启用或新建模板",
        { templateId: template.id, currentVersion: template.currentVersion });
    }

    if (ctx.templateVersion === undefined || ctx.templateVersion === null ||
        ctx.templateVersion === "") {
      return fail("precondition_required",
        "用模板发起申请必须携带 templateVersion（所依据的模板版本号）");
    }
    var their = parseInt(ctx.templateVersion, 10);
    if (!Number.isInteger(their) || their !== template.currentVersion) {
      return fail("template_version_changed",
        "模板 “" + template.name + "” 已被负责人修改到版本 " +
        template.currentVersion + "（提交依据版本 " + their +
        "），旧版本不能继续创建新申请，请刷新模板后重新发起",
        { templateId: template.id,
          currentVersion: template.currentVersion,
          submittedVersion: Number.isInteger(their) ? their : null });
    }

    var member = typeof ctx.member === "string" ? ctx.member.trim() : "";
    var mc = prc.validateMember(member);
    if (!mc.ok) return mc;
    member = mc.value;
    if (!memberInScope(template, member)) {
      var ms = template.memberScope || { mode: "all" };
      return fail("member_not_in_template_scope",
        ms.mode === "members"
          ? "成员 “" + member + "” 不在模板 “" + template.name +
            "” 的适用成员范围内，不能使用该模板发起申请"
          : "成员 “" + member + "” 不能使用该模板",
        { templateId: template.id });
    }

    var reqBody = {
      scope: template.scope,
      resourceId: template.resourceId,
      role: template.role,
      member: member,
      note: typeof body.note === "string" ? body.note : ""
    };

    if (template.kind === "grant") {
      var hasExpire = body.expireAt !== undefined && body.expireAt !== null &&
        body.expireAt !== "";
      var hasEffective = body.effectiveAt !== undefined &&
        body.effectiveAt !== null && body.effectiveAt !== "";
      if (hasExpire) reqBody.expireAt = body.expireAt;
      if (hasEffective) reqBody.effectiveAt = body.effectiveAt;
      if (!hasExpire) {
        // 默认有效期：提交瞬间锁定失效时间（默认值只在提交时取值，
        // 与模板日后修改完全解耦）
        var dur = template.defaultDurationMs;
        if (!Number.isInteger(dur) || dur <= 0) {
          return fail("invalid_default_duration",
            "模板缺少可用的默认有效期，无法按默认窗口发起申请");
        }
        reqBody.expireAt = new Date(Date.parse(nowIso) + dur).toISOString();
      }
      var recheck = prc.validateGrantRequest(reqBody, {
        now: nowIso, owner: ctx.owner,
        delegations: Array.isArray(ctx.delegations) ? ctx.delegations : [],
        requests: Array.isArray(ctx.requests) ? ctx.requests : []
      });
      if (!recheck.ok) return recheck;
      return ok({ kind: "grant", target: recheck.value,
        provenance: provenance(template) });
    }

    // 撤销模板：撤销对象（本人正式委派）只能在发起时指定，模板不固化委派 id
    reqBody.delegationId = body.delegationId;
    var rv = prc.validateRevokeRequest(reqBody, {
      now: nowIso,
      delegations: Array.isArray(ctx.delegations) ? ctx.delegations : [],
      requests: Array.isArray(ctx.requests) ? ctx.requests : []
    });
    if (!rv.ok) return rv;
    return ok({ kind: "revoke", target: rv.value,
      provenance: provenance(template) });
  }

  /* ================= 对外视图 ================= */

  function publicTemplate(t, opts) {
    opts = opts || {};
    var ms = t.memberScope || { mode: "all", members: [] };
    var out = {
      id: t.id,
      scope: t.scope,
      resourceId: t.resourceId,
      name: t.name,
      role: t.role,
      kind: t.kind,
      defaultDurationMs: t.defaultDurationMs,
      description: t.description || "",
      memberScope: {
        mode: ms.mode,
        // 普通成员视图不带完整白名单（避免泄露其他成员名单）
        members: opts.includeMembers !== false ? ms.members.slice() : [],
        memberCount: Array.isArray(ms.members) ? ms.members.length : 0
      },
      status: t.status || "active",
      currentVersion: t.currentVersion,
      createdAt: t.createdAt,
      createdBy: t.createdBy,
      updatedAt: t.updatedAt || null,
      updatedBy: t.updatedBy || null,
      disabledAt: t.disabledAt || null,
      disabledBy: t.disabledBy || null
    };
    if (opts.includeHistory) out.history = (t.history || []).slice();
    return out;
  }

  // 普通成员视图：只给当前启用版本的必要信息，不给历史/完整白名单
  function publicTemplateForMember(t, member) {
    if (!t || t.status !== "active" || !memberInScope(t, member)) return null;
    var view = publicTemplate(t, { includeMembers: false, includeHistory: false });
    view.inScope = true;
    return view;
  }

  return {
    SCOPES: SCOPES,
    ROLES: ROLES,
    KINDS: KINDS,
    STATUSES: STATUSES,
    SCOPE_MODES: SCOPE_MODES,
    LIMITS: LIMITS,
    ROLE_LABELS: ROLE_LABELS,
    SCOPE_LABELS: SCOPE_LABELS,
    normalizeMemberScope: normalizeMemberScope,
    memberInScope: memberInScope,
    validateTemplateBody: validateTemplateBody,
    validateTemplateSubmit: validateTemplateSubmit,
    contentSnapshot: contentSnapshot,
    provenance: provenance,
    publicTemplate: publicTemplate,
    publicTemplateForMember: publicTemplateForMember
  };
});
