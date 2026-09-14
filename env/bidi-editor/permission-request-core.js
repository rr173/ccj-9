/* permission-request-core.js
 * “权限变更申请与生效预览”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.PermissionRequestCore），Node 下可直接 require 单测。
 *
 * 在既有“角色委派”（permission-core.js：负责人直接授予/撤销）之上引入申请流：
 *   普通成员针对回放空间(space)/复核会话(session)/纠错批次(batch)提交
 *   授予申请(grant)或撤销申请(revoke) -> 负责人逐项批准(approve)/拒绝(reject)
 *   -> 只有批准才生成正式委派（授予）或执行正式撤销；拒绝不改变任何权限。
 *
 * 版本与审计：
 *   - 申请集合有独立单调版本号 requestRev（X-Permission-Request-Rev），
 *     与正式委派集合版本（X-Permission-Rev）相互独立；
 *   - 每条申请有独立单调 version：创建=1，每次决定（批准/拒绝/过期/冲突标记）
 *     都推进 version；审批必须携带 X-Request-Version 严格相等，旧版本审批
 *     一律 409 request_version_conflict 拒绝；
 *   - 申请、决定、生成的正式委派 id、失败原因全部进只增不改的审计日志。
 *
 * 申请有效期：每条申请在创建时按 REQUEST_TTL_MS 锁定 expiresAt（审批截止时间）。
 *   负责人在 expiresAt 之后才审批一律 409 request_expired（申请转 expired，
 *   不改变任何权限）；过期判定以传入 now 为时钟，确定性、可重启恢复。
 *
 * 生效预览 previewEffective：给定成员与“未来时刻” at，纯计算该时刻的有效角色，
 * 并分四组列出：即将生效 activating（已批准的未来生效委派）、
 * 即将失效 expiring（当前生效但 at 前到期）、撤销 revoking（已批准、
 * 将在 at 前生效的撤销）、待处理申请 pending（pending 申请的期望值，
 * 不进入 effectiveRoles）。预览绝不修改正式权限，也不假设待处理申请会被批准。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PermissionRequestCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCOPES = ["space", "session", "batch"];
  var ROLES = ["view", "review", "approve", "execute"];
  var ROLE_LABELS = {
    view: "查看", review: "复核", approve: "审批", execute: "执行"
  };
  var SCOPE_LABELS = {
    space: "回放空间", session: "复核会话", batch: "纠错批次"
  };
  var KINDS = ["grant", "revoke"];
  // 申请状态：pending 待处理 / approved 已批准 / rejected 已拒绝 /
  //           expired 已过期（截止后审批） / failed 批准后落正式委派失败（仅审计异常）
  var STATUSES = ["pending", "approved", "rejected", "expired", "failed"];

  var LIMITS = {
    MEMBER_MAX_CHARS: 50,
    NOTE_MAX_CHARS: 500,    // 申请说明
    REASON_MAX_CHARS: 500,  // 批准/拒绝原因
    REQUESTS_PER_RESOURCE_MAX: 2000,
    REQUEST_LOGS_MAX: 20000,
    // 审批截止：创建后多少毫秒；可用 ctx.ttlMs 覆盖（测试用）
    DEFAULT_REQUEST_TTL_MS: 72 * 3600 * 1000
  };

  function fail(code, message, extra) {
    var f = { ok: false, code: code, message: message };
    if (extra) { for (var k in extra) { f[k] = extra[k]; } }
    return f;
  }
  function ok(value) { return { ok: true, value: value }; }

  function isISODateString(s) {
    if (typeof s !== "string") return false;
    var n = Date.parse(s);
    if (!Number.isFinite(n)) return false;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s);
  }

  function cleanName(name) {
    return typeof name === "string" ? name.trim() : "";
  }
  function charLen(s) { return Array.from(s).length; }

  function validateMember(name) {
    var m = cleanName(name);
    if (!m) return fail("missing_member", "成员名称不能为空");
    if (charLen(m) > LIMITS.MEMBER_MAX_CHARS) {
      return fail("member_too_long",
        "成员名称最长 " + LIMITS.MEMBER_MAX_CHARS + " 字符");
    }
    if (m.indexOf("/") !== -1 || m.indexOf("\\") !== -1) {
      return fail("invalid_member", "成员名称不能包含 / 或 \\");
    }
    return ok(m);
  }

  function validateText(value, field, code, max) {
    if (value === undefined || value === null) return ok("");
    if (typeof value !== "string") return fail("invalid_" + field, "字段必须是字符串");
    var v = value.trim();
    if (charLen(v) > max) {
      return fail(code, "字段最长 " + max + " 字符");
    }
    return ok(v);
  }

  function windowsOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  /* 委派在某时刻的状态（与 permission-core 口径一致，这里独立实现避免模块耦合） */
  function delegationState(d, nowMs) {
    if (!d || d.status === "revoked") return "revoked";
    if (Date.parse(d.effectiveAt) > nowMs) return "pending";
    if (Date.parse(d.expireAt) <= nowMs) return "expired";
    return "active";
  }

  function requestState(req, nowMs) {
    if (req.status !== "pending") return req.status;
    if (Date.parse(req.expiresAt) <= nowMs) return "expired";
    return "pending";
  }

  /* ================= 授予申请校验 =================
   * body: {scope, resourceId, role, member(申请人本人), note?,
   *         effectiveAt?, expireAt}
   * ctx:  {now, owner, ttlMs?, delegations:[正式委派], requests:[本资源全部申请]}
   * 与直接授予相同的硬规则（角色矩阵/负责人自审/时间窗/重复委派/职责冲突），
   * 另加申请流规则：
   *   - 同成员同资源同角色存在 pending 且审批未过期的授予申请 ->
   *     duplicate_request（重复申请明确拒绝，不新增）；
   *   - 与其他成员无关；与自己 pending 的“撤销申请”不冲突（撤与授可先后排队，
   *     批准时按当时正式委派重新校验，过期/已撤销都会被拦）。
   */
  function validateGrantRequest(body, ctx) {
    body = body || {};
    ctx = ctx || {};
    var nowIso = ctx.now || new Date().toISOString();
    var nowMs = Date.parse(nowIso);

    var base = validateTarget(body, nowIso);
    if (!base.ok) return base;
    var t = base.value;

    // 负责人自审：批次负责人申请 approve 角色无意义且被禁止
    if (t.scope === "batch" && t.role === "approve" &&
        ctx.owner && t.member === ctx.owner) {
      return fail("approver_is_owner",
        "负责人不能申请自己批次的审批角色（负责人自审明确禁止）");
    }

    var delegations = Array.isArray(ctx.delegations) ? ctx.delegations : [];
    var requests = Array.isArray(ctx.requests) ? ctx.requests : [];
    if (requests.length >= LIMITS.REQUESTS_PER_RESOURCE_MAX) {
      return fail("request_too_large",
        "该资源的权限变更申请已达上限 " + LIMITS.REQUESTS_PER_RESOURCE_MAX);
    }

    // 重复申请：同成员同角色 pending 且未到审批截止
    for (var i = 0; i < requests.length; i++) {
      var r = requests[i];
      if (r.kind !== "grant" || r.status !== "pending") continue;
      if (r.member !== t.member || r.role !== t.role) continue;
      if (requestState(r, nowMs) === "pending") {
        return fail("duplicate_request",
          "成员 “" + t.member + "” 在该" + SCOPE_LABELS[t.scope] +
          "上已有待处理的“" + ROLE_LABELS[t.role] + "”角色授予申请（" +
          r.id + "），重复申请明确拒绝；请等待负责人处理或更换角色/时间窗",
          { existingRequestId: r.id });
      }
    }

    // 与正式委派相同的重复/冲突校验（即使先申请后直授，提交时也提前暴露）
    var startMs = Date.parse(t.effectiveAt), endMs = Date.parse(t.expireAt);
    var conflictRoles = t.role === "approve" ? ["execute"]
      : t.role === "execute" ? ["approve"] : [];
    for (var j = 0; j < delegations.length; j++) {
      var d = delegations[j];
      if (d.status !== "active" || d.member !== t.member) continue;
      if (!windowsOverlap(startMs, endMs,
          Date.parse(d.effectiveAt), Date.parse(d.expireAt))) continue;
      if (d.role === t.role) {
        return fail("duplicate_delegation",
          "成员 “" + t.member + "” 在该" + SCOPE_LABELS[t.scope] +
          "上已有时间窗重叠的“" + ROLE_LABELS[t.role] + "”正式委派（" +
          d.effectiveAt + " ~ " + d.expireAt +
          "），无需重复申请；如需调整请申请撤销后重新申请",
          { existingDelegationId: d.id });
      }
      if (conflictRoles.indexOf(d.role) !== -1) {
        return fail("conflicting_roles",
          "成员 “" + t.member + "” 已持有时间窗重叠的“" +
          ROLE_LABELS[d.role] + "”角色，与申请的“" + ROLE_LABELS[t.role] +
          "”职责冲突，同一成员不能同时持有",
          { existingDelegationId: d.id, conflictingRole: d.role });
      }
    }

    // 与其他 pending 授予申请的 approve/execute 时间窗冲突
    // （同时批准必然造成职责分离冲突；同角色重复已由上面的 duplicate_request
    // 拦截，这里不再单列同角色窗口码）：
    for (var k = 0; k < requests.length; k++) {
      var rq = requests[k];
      if (rq.kind !== "grant" || rq.status !== "pending" ||
          rq.member !== t.member) continue;
      if (requestState(rq, nowMs) !== "pending") continue;
      if (!windowsOverlap(startMs, endMs,
          Date.parse(rq.effectiveAt), Date.parse(rq.expireAt))) continue;
      if (conflictRoles.indexOf(rq.role) !== -1) {
        return fail("conflicting_request_roles",
          "该成员已有一条时间窗重叠的“" + ROLE_LABELS[rq.role] +
          "”待处理申请（" + rq.id + "），两条申请若同时批准将造成职责冲突，" +
          "请调整时间窗或等待前一申请处理",
          { existingRequestId: rq.id, conflictingRole: rq.role });
      }
    }

    return ok(t);
  }

  /* 资源/角色/成员/时间窗公共校验；时间窗规则与 permission-core.validateGrant 一致 */
  function validateTarget(body, nowIso) {
    var nowMs = Date.parse(nowIso);
    var scope = typeof body.scope === "string" ? body.scope : "";
    if (SCOPES.indexOf(scope) === -1) {
      return fail("invalid_scope",
        "资源类型必须是 space / session / batch 之一");
    }
    var resourceId = typeof body.resourceId === "string" ? body.resourceId : "";
    if (!resourceId) return fail("missing_resource", "缺少资源 id");

    var role = typeof body.role === "string" ? body.role : "";
    if (ROLES.indexOf(role) === -1) {
      return fail("invalid_role",
        "角色必须是 view / review / approve / execute 之一");
    }
    var allowed = scope === "batch"
      ? ["view", "review", "approve", "execute"] : ["view", "review"];
    if (allowed.indexOf(role) === -1) {
      return fail("role_not_allowed_for_scope",
        SCOPE_LABELS[scope] + "不支持配置“" + ROLE_LABELS[role] + "”角色");
    }

    var mc = validateMember(body.member);
    if (!mc.ok) return mc;

    var expireAt = body.expireAt;
    if (expireAt === undefined || expireAt === null || expireAt === "") {
      return fail("missing_expire", "必须设置申请角色的失效时间");
    }
    if (!isISODateString(expireAt)) {
      return fail("invalid_expire", "失效时间不是合法 ISO 时间");
    }
    var immediate = body.effectiveAt === undefined ||
      body.effectiveAt === null || body.effectiveAt === "";
    if (immediate && Date.parse(expireAt) <= nowMs) {
      return fail("expire_in_past", "失效时间必须晚于当前时间");
    }
    var effectiveAt;
    if (immediate) {
      effectiveAt = nowIso;
    } else {
      if (!isISODateString(body.effectiveAt)) {
        return fail("invalid_effective", "生效时间不是合法 ISO 时间");
      }
      effectiveAt = body.effectiveAt;
    }
    if (Date.parse(effectiveAt) >= Date.parse(expireAt)) {
      return fail("effective_after_expire", "生效时间必须早于失效时间");
    }
    if (!immediate && Date.parse(effectiveAt) > nowMs &&
        Date.parse(expireAt) <= nowMs) {
      return fail("expire_in_past",
        "未来生效的申请，失效时间必须晚于当前时间");
    }

    var nc = validateText(body.note, "note", "note_too_long",
      LIMITS.NOTE_MAX_CHARS);
    if (!nc.ok) return nc;

    return ok({
      scope: scope, resourceId: resourceId, role: role, member: mc.value,
      effectiveAt: effectiveAt, expireAt: expireAt, note: nc.value
    });
  }

  /* ================= 撤销申请校验 =================
   * body: {scope, resourceId, role, delegationId, member(申请人), note?}
   * 规则：
   *   - 目标正式委派必须存在且属于该资源、成员与角色一致；
   *   - 已撤销 duplicate_revoke、已自然过期 delegation_expired 明确拒绝
   *     （与直接撤销口径一致）；
   *   - 同一委派存在 pending 撤销申请 -> duplicate_revoke_request；
   *   - 成员只能为自己的委派申请撤销（负责人直接走撤销接口，无需申请）。
   */
  function validateRevokeRequest(body, ctx) {
    body = body || {};
    ctx = ctx || {};
    var nowIso = ctx.now || new Date().toISOString();
    var nowMs = Date.parse(nowIso);

    var scope = typeof body.scope === "string" ? body.scope : "";
    if (SCOPES.indexOf(scope) === -1) {
      return fail("invalid_scope",
        "资源类型必须是 space / session / batch 之一");
    }
    var resourceId = typeof body.resourceId === "string" ? body.resourceId : "";
    if (!resourceId) return fail("missing_resource", "缺少资源 id");
    var role = typeof body.role === "string" ? body.role : "";
    if (ROLES.indexOf(role) === -1) {
      return fail("invalid_role",
        "角色必须是 view / review / approve / execute 之一");
    }
    var mc = validateMember(body.member);
    if (!mc.ok) return mc;
    var member = mc.value;
    var delegationId = typeof body.delegationId === "string"
      ? body.delegationId.trim() : "";
    if (!delegationId) return fail("missing_delegation", "缺少要撤销的委派 id");

    var delegations = Array.isArray(ctx.delegations) ? ctx.delegations : [];
    var d = delegations.find(function (x) { return x.id === delegationId; }) || null;
    if (!d) return fail("delegation_not_found", "要撤销的角色委派不存在");
    if (d.scope !== scope || d.resourceId !== resourceId) {
      return fail("delegation_scope_mismatch",
        "该委派不属于所填写的资源");
    }
    if (d.member !== member) {
      return fail("not_delegation_member",
        "只能为自己持有的角色提交撤销申请");
    }
    if (d.role !== role) {
      return fail("delegation_role_mismatch",
        "申请角色与委派记录的角色不一致");
    }
    if (d.status === "revoked") {
      return fail("duplicate_revoke",
        "该委派已被撤销（撤销人：" + (d.revokedBy || "—") +
        "），不能重复申请撤销");
    }
    if (delegationState(d, nowMs) === "expired") {
      return fail("delegation_expired",
        "该委派已过失效时间而自然失效，无需撤销，记录保留供审计");
    }

    var requests = Array.isArray(ctx.requests) ? ctx.requests : [];
    if (requests.length >= LIMITS.REQUESTS_PER_RESOURCE_MAX) {
      return fail("request_too_large",
        "该资源的权限变更申请已达上限 " + LIMITS.REQUESTS_PER_RESOURCE_MAX);
    }
    for (var i = 0; i < requests.length; i++) {
      var r = requests[i];
      if (r.kind !== "revoke" || r.status !== "pending") continue;
      if (r.delegationId === delegationId && requestState(r, nowMs) === "pending") {
        return fail("duplicate_revoke_request",
          "该委派已有待处理的撤销申请（" + r.id + "），不能重复申请",
          { existingRequestId: r.id });
      }
    }

    var nc = validateText(body.note, "note", "note_too_long",
      LIMITS.NOTE_MAX_CHARS);
    if (!nc.ok) return nc;

    return ok({
      scope: scope, resourceId: resourceId, role: role, member: member,
      delegationId: delegationId, note: nc.value
    });
  }

  /* ================= 审批校验（决定前的全部前置条件） =================
   * req: 申请记录；body: {decision:"approve"|"reject", reason?}
   * ctx: {now, version(请求头 X-Request-Version), actor, owner,
   *       delegations, requests, ttlMs?}
   * 返回 ok({decision, reason}) 或 fail。审批规则：
   *   - 必须是该资源负责人本人；负责人审批自己的申请 self_approval 拒绝
   *     （申请提交人 == 审批人）；
   *   - 申请必须 pending；非 pending -> request_not_pending；
   *   - 审批截止过期 -> request_expired（调用方据此把申请置 expired）；
   *   - X-Request-Version 严格等于 req.version，否则 request_version_conflict；
   *   - decision 非法 -> invalid_decision；
   *   - 拒绝原因：reject 时必填（reject_reason_required），approve 可空；
   *   - 批准瞬间重新校验正式委派：
   *       grant: 复用 validateGrantRequest 的窗口规则（重复/冲突/自审），
   *              此时其它 pending 申请不应拦自己——排除自身 id；
   *       revoke: 委派仍存在、未撤销、未过期（窗口可能已自然过期）。
   */
  function validateDecision(req, body, ctx) {
    body = body || {};
    ctx = ctx || {};
    var nowIso = ctx.now || new Date().toISOString();
    var nowMs = Date.parse(nowIso);

    if (!req) return fail("request_not_found", "权限变更申请不存在");

    // 旧版本审批先拦（并发：两个负责人页面同时审批）
    if (ctx.version === undefined || ctx.version === null ||
        ctx.version === "") {
      return fail("precondition_required",
        "审批必须携带 X-Request-Version 申请版本号");
    }
    var their = parseInt(ctx.version, 10);
    if (!Number.isInteger(their) || their !== req.version) {
      return fail("request_version_conflict",
        "申请已被其他处理推进到版本 " + req.version +
        "（提交版本 " + their + "），旧版本审批明确拒绝，请刷新后重试",
        { currentVersion: req.version, currentStatus: req.status });
    }

    // 已落终态（approved/rejected/expired/failed）的申请一律 request_not_pending，
    // 即使携带最新版本也不能再审（历史只读）
    if (req.status !== "pending") {
      return fail("request_not_pending",
        "申请当前状态为 " + req.status + "，只有待处理申请可以审批",
        { currentStatus: req.status });
    }

    // 仍为 pending 但已过审批截止 -> request_expired（调用方据此落 expired 终态）
    var state = requestState(req, nowMs);
    if (state === "expired") {
      return fail("request_expired",
        "申请已在 " + req.expiresAt + " 到达审批截止时间，过期审批明确拒绝，" +
        "不改变任何权限；可由申请人重新发起申请",
        { expiredAt: req.expiresAt });
    }

    var actor = typeof ctx.actor === "string" ? ctx.actor.trim() : "";
    if (!actor) return fail("missing_actor", "缺少处理人身份");
    // 负责人审批自己的申请：明确拒绝（先于负责人权限判定，
    // 即使提交人恰好就是资源负责人也不允许）
    if (req.member === actor) {
      return fail("self_approval",
        "负责人不能审批自己提交的权限变更申请（申请与审批必须职责分离）");
    }
    if (ctx.owner != null && actor !== ctx.owner) {
      return fail("not_resource_owner",
        "只有资源负责人（" + ctx.owner + "）可以审批权限变更申请");
    }

    var decision = body.decision;
    if (decision !== "approve" && decision !== "reject") {
      return fail("invalid_decision",
        "审批决定必须是 approve（批准）或 reject（拒绝）");
    }
    var rc = validateText(body.reason, "reason", "reason_too_long",
      LIMITS.REASON_MAX_CHARS);
    if (!rc.ok) return rc;
    var reason = rc.value;
    if (decision === "reject" && !reason) {
      return fail("reject_reason_required",
        "拒绝申请必须填写原因（申请人需要看到拒绝理由）");
    }

    if (decision === "approve") {
      var delegations = Array.isArray(ctx.delegations) ? ctx.delegations : [];
      var requests = Array.isArray(ctx.requests) ? ctx.requests : [];
      if (req.kind === "grant") {
        // 批准瞬间按“当前正式委派 + 其它待处理申请”重新校验窗口；
        // 排除自身，避免把自己判成重复申请。
        var others = requests.filter(function (x) { return x.id !== req.id; });
        var recheck = validateGrantRequest({
          scope: req.scope, resourceId: req.resourceId, role: req.role,
          member: req.member, effectiveAt: req.effectiveAt,
          expireAt: req.expireAt, note: req.note
        }, {
          now: nowIso, owner: ctx.owner,
          delegations: delegations, requests: others
        });
        if (!recheck.ok) {
          return fail(recheck.code,
            "批准时复核未通过，申请不能生成正式委派：" + recheck.message,
            recheck.existingDelegationId
              ? { existingDelegationId: recheck.existingDelegationId,
                  existingRequestId: recheck.existingRequestId,
                  conflictingRole: recheck.conflictingRole } : undefined);
        }
      } else {
        var d = delegations.find(function (x) {
          return x.id === req.delegationId;
        }) || null;
        if (!d) return fail("delegation_not_found",
          "批准时目标委派已不存在，不能执行撤销");
        if (d.status === "revoked") {
          return fail("duplicate_revoke",
            "批准时目标委派已被其他途径撤销，申请不再产生新变更");
        }
        if (delegationState(d, nowMs) === "expired") {
          return fail("delegation_expired",
            "批准时目标委派已自然过期，无需撤销；申请不改变任何权限");
        }
      }
    }

    return ok({ decision: decision, reason: reason, actor: actor });
  }

  /* ================= 生效预览（纯计算，绝不修改权限） =================
   * input: {scope, resourceId, member, at(未来时刻 ISO), now(当前时刻 ISO),
   *          delegations, requests}
   * 输出：
   *   {at, now, roles: [at 时刻有效角色],
   *    currentRoles: [now 时刻有效角色],
   *    activating: [当前未生效、at 时刻生效的已批准委派],
   *    expiring:   [当前生效、at 时刻已过期的已批准委派],
   *    active:     [at 时刻仍生效的已批准委派],
   *    revoking:   [已批准的撤销申请，且目标委派在 at 时刻本应生效],
   *    pending:    [本人 pending 授予/撤销申请（期望值，不影响 roles）],
   *    owner: bool}
   * 口径：
   *   - 只统计“已批准生成的正式委派”。pending 申请一律只在 pending 组展示，
   *     绝不臆测其会被批准；
   *   - 已批准的撤销申请：把目标委派标记为 at 时刻失效（从 roles/active 中排除）；
   *   - at 必须是合法 ISO；允许过去时刻（用于回看），不传 at 默认 now。
   */
  function previewEffective(input) {
    input = input || {};
    var nowIso = input.now || new Date().toISOString();
    var atIso = input.at || nowIso;
    if (!isISODateString(atIso)) {
      return fail("invalid_at", "预览时刻不是合法 ISO 时间");
    }
    var nowMs = Date.parse(nowIso), atMs = Date.parse(atIso);
    var member = input.member || "";
    var delegations = (Array.isArray(input.delegations) ? input.delegations : [])
      .filter(function (d) { return d.member === member; });
    var requests = (Array.isArray(input.requests) ? input.requests : [])
      .filter(function (r) { return r.member === member; });

    // at 时刻已生效（已批准）的撤销集合：被撤的委派 id
    var revokedByApproved = {};
    requests.forEach(function (r) {
      if (r.kind === "revoke" && r.status === "approved" &&
          r.decidedAt && Date.parse(r.decidedAt) <= atMs &&
          r.delegationId) {
        revokedByApproved[r.delegationId] = r;
      }
    });

    function pub(d) {
      return {
        id: d.id, role: d.role, scope: d.scope, resourceId: d.resourceId,
        effectiveAt: d.effectiveAt, expireAt: d.expireAt,
        statusAt: delegationState(d, atMs),
        grantedBy: d.grantedBy || null, grantedAt: d.grantedAt || null
      };
    }
    function aliveAt(d, ms) {
      if (revokedByApproved[d.id]) return false;
      if (d.status === "revoked") return false;
      return Date.parse(d.effectiveAt) <= ms &&
             Date.parse(d.expireAt) > ms;
    }

    var activating = [], expiring = [], activeAt = [], revokedNow = [];
    delegations.forEach(function (d) {
      // 预览只关心“经申请批准撤销”的委派：其它途径撤销的旧记录直接跳过，
      // 但经申请撤销的即使 d.status=revoked 也要在 revoking 组展示
      var approvedRv = revokedByApproved[d.id];
      if (d.status === "revoked" && !approvedRv) return;
      var cur = delegationState(d, nowMs);
      var futureAlive = aliveAt(d, atMs);
      if (futureAlive) {
        if (cur === "pending") activating.push(pub(d));
        else activeAt.push(pub(d));
      } else if (approvedRv &&
          // 当前视角有效或未生效（当前未生效 + 已批准撤销 也算撤销项）
          Date.parse(d.effectiveAt) <= nowMs &&
          Date.parse(d.expireAt) > nowMs) {
        var item = pub(d);
        item.revokedByRequestId = approvedRv.id;
        item.revokedBy = approvedRv.decidedBy || null;
        item.revokedAt = approvedRv.decidedAt || null;
        revokedNow.push(item);
      } else if (cur === "active") {
        expiring.push(pub(d));
      }
    });

    var roleSet = Object.create(null);
    activeAt.concat(activating).forEach(function (d) { roleSet[d.role] = true; });
    var roles = ROLES.filter(function (r) { return !!roleSet[r]; });

    var curSet = Object.create(null);
    delegations.forEach(function (d) {
      if (delegationState(d, nowMs) === "active") curSet[d.role] = true;
    });
    var currentRoles = ROLES.filter(function (r) { return !!curSet[r]; });

    var pending = requests.filter(function (r) {
      return requestState(r, nowMs) === "pending";
    }).map(function (r) {
      var base = {
        id: r.id, kind: r.kind, role: r.role,
        scope: r.scope, resourceId: r.resourceId,
        version: r.version, expiresAt: r.expiresAt,
        createdAt: r.createdAt, member: r.member
      };
      if (r.kind === "grant") {
        base.effectiveAt = r.effectiveAt;
        base.expireAt = r.expireAt;
        // 若批准，在 at 时刻是否会生效
        base.wouldActiveAt = Date.parse(r.effectiveAt) <= atMs &&
          Date.parse(r.expireAt) > atMs;
      } else {
        base.delegationId = r.delegationId;
      }
      return base;
    });

    return ok({
      scope: input.scope || "",
      resourceId: input.resourceId || "",
      member: member,
      now: nowIso, at: atIso,
      isFuture: atMs > nowMs,
      owner: !!(input.owner && member === input.owner),
      roles: roles,
      currentRoles: currentRoles,
      activating: activating,
      expiring: expiring,
      active: activeAt,
      revoking: revokedNow,
      pending: pending
    });
  }

  /* 申请对外视图（附带按当前时间实时计算的 displayState） */
  function publicRequest(r, nowIso) {
    var nowMs = Date.parse(nowIso || new Date().toISOString());
    var out = {
      id: r.id,
      kind: r.kind,
      scope: r.scope,
      resourceId: r.resourceId,
      role: r.role,
      member: r.member,
      status: r.status,
      displayState: requestState(r, nowMs),
      version: r.version,
      note: r.note || "",
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      expiresAt: r.expiresAt,
      decidedAt: r.decidedAt || null,
      decidedBy: r.decidedBy || null,
      decision: r.decision || null,
      decisionReason: r.decisionReason || null,
      delegationId: r.delegationId || null,
      effectiveAt: r.effectiveAt || null,
      expireAt: r.expireAt || null,
      // 正式委派关联：批准授予时生成的委派 id
      generatedDelegationId: r.generatedDelegationId || null
    };
    return out;
  }

  return {
    SCOPES: SCOPES,
    ROLES: ROLES,
    KINDS: KINDS,
    STATUSES: STATUSES,
    ROLE_LABELS: ROLE_LABELS,
    SCOPE_LABELS: SCOPE_LABELS,
    LIMITS: LIMITS,
    isISODateString: isISODateString,
    validateMember: validateMember,
    windowsOverlap: windowsOverlap,
    delegationState: delegationState,
    requestState: requestState,
    validateGrantRequest: validateGrantRequest,
    validateRevokeRequest: validateRevokeRequest,
    validateDecision: validateDecision,
    previewEffective: previewEffective,
    publicRequest: publicRequest
  };
});
