/* permission-core.js
 * “角色委派与操作权限”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.PermissionCore），Node 下可直接 require 单测。
 *
 * 能力模型：
 *   负责人可以为三类资源配置四类角色：
 *     资源 scope：space 回放空间 / session 复核会话 / batch 纠错批次
 *     角色 role： view 查看 / review 复核 / approve 审批 / execute 执行
 *   - 角色按层级包含：review / approve / execute 都隐含 view；
 *   - 委派记录带生效时间（effectiveAt）与失效时间（expireAt）：
 *       未到生效时间 -> role_not_active；已过失效时间 -> role_expired；
 *   - 同一成员同一资源同一角色在时间窗内重复委派 -> duplicate_delegation 明确拒绝
 *     （如需延期/换人请先撤销再授予，绝不静默覆盖）；
 *   - 职责分离：同一成员在同一纠错批次上不得同时持有“生效时间窗重叠”的
 *     approve 与 execute 角色 -> conflicting_roles 明确拒绝；
 *   - 负责人自审：批次负责人不得被授予 approve 角色（approver_is_owner），
 *     审批/执行接口对负责人本人也一律拒绝（owner_self_approval）。
 *
 * 本模块只做纯计算与校验，不做任何持久化；所有判定均以传入的 now 为时钟，
 * 因此重启恢复、过期与冲突判定都是确定性的。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PermissionCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 资源类型与允许的角色矩阵 */
  var SCOPES = ["space", "session", "batch"];
  var ROLES = ["view", "review", "approve", "execute"];
  var ROLE_LABELS = {
    view: "查看",
    review: "复核",
    approve: "审批",
    execute: "执行"
  };
  var SCOPE_LABELS = {
    space: "回放空间",
    session: "复核会话",
    batch: "纠错批次"
  };

  // 不同资源允许配置的角色（查看/复核对三类资源都有意义；
  // approve/execute 是纠错批次的审批与执行职责）
  var ROLES_BY_SCOPE = {
    space: ["view", "review"],
    session: ["view", "review"],
    batch: ["view", "review", "approve", "execute"]
  };

  // 角色层级：高角色隐含低角色（review/approve/execute 都隐含 view）
  var ROLE_RANK = { view: 1, review: 2, approve: 2, execute: 2 };

  // 职责分离冲突对（同一成员、同一资源、生效时间窗重叠时拒绝）
  var ROLE_CONFLICTS = {
    approve: ["execute"],
    execute: ["approve"]
  };

  var LIMITS = {
    MEMBER_MAX_CHARS: 50,
    REASON_MAX_CHARS: 500,
    DELEGATIONS_PER_RESOURCE_MAX: 500,
    LOGS_MAX: 10000
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

  function cleanMember(name) {
    if (typeof name !== "string") return "";
    return name.trim();
  }

  function validateMember(name) {
    var m = cleanMember(name);
    if (!m) return fail("missing_member", "成员名称不能为空");
    // 与 review.validateAuthor 相同的码点长度口径
    var len = Array.from(m).length;
    if (len > LIMITS.MEMBER_MAX_CHARS) {
      return fail("member_too_long",
        "成员名称最长 " + LIMITS.MEMBER_MAX_CHARS + " 字符");
    }
    if (m.indexOf("/") !== -1 || m.indexOf("\\") !== -1) {
      return fail("invalid_member", "成员名称不能包含 / 或 \\");
    }
    return ok(m);
  }

  function validateReason(reason) {
    if (reason === undefined || reason === null) return ok("");
    if (typeof reason !== "string") return fail("invalid_reason", "原因必须是字符串");
    var r = reason.trim();
    if (Array.from(r).length > LIMITS.REASON_MAX_CHARS) {
      return fail("reason_too_long",
        "原因最长 " + LIMITS.REASON_MAX_CHARS + " 字符");
    }
    return ok(r);
  }

  /* 校验一次委派授予输入：
   *   body: {scope, resourceId, role, member, effectiveAt?, expireAt, reason?}
   *   ctx:  {owner, existing:[delegation...], now}
   * 规则：
   *   - scope/role 合法且角色对该资源适用；
   *   - 成员非空、不超长；
   *   - 失效时间必填且晚于当前；生效时间可缺省（=立即生效），
   *     给了就必须是合法 ISO 且早于失效时间；
   *   - 重复委派：同成员同资源同角色，存在 status=active 且时间窗重叠的记录即拒绝；
   *   - 同成员权限冲突：active 且时间窗重叠的职责冲突角色（approve/execute）拒绝；
   *   - 负责人自审：batch 资源不得把 approve 授予负责人本人。
   */
  function validateGrant(body, ctx) {
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
    if (ROLES_BY_SCOPE[scope].indexOf(role) === -1) {
      return fail("role_not_allowed_for_scope",
        SCOPE_LABELS[scope] + "不支持配置“" + ROLE_LABELS[role] + "”角色");
    }

    var memberCheck = validateMember(body.member);
    if (!memberCheck.ok) return memberCheck;
    var member = memberCheck.value;

    // 负责人自审：批次负责人不能被授予审批角色
    if (scope === "batch" && role === "approve" &&
        ctx.owner && member === ctx.owner) {
      return fail("approver_is_owner",
        "负责人不能担任自己批次的审批人（负责人自审明确禁止）");
    }

    // 失效时间：必填、合法；立即生效（未给生效时间）时必须晚于当前
    var expireAt = body.expireAt;
    if (expireAt === undefined || expireAt === null || expireAt === "") {
      return fail("missing_expire", "必须设置角色失效时间");
    }
    if (!isISODateString(expireAt)) {
      return fail("invalid_expire", "失效时间不是合法 ISO 时间");
    }
    var immediate = body.effectiveAt === undefined ||
      body.effectiveAt === null || body.effectiveAt === "";
    if (immediate && Date.parse(expireAt) <= nowMs) {
      return fail("expire_in_past", "失效时间必须晚于当前时间");
    }

    // 生效时间：可缺省（立即生效）；给了必须合法且早于失效时间
    var effectiveAt = body.effectiveAt;
    if (immediate) {
      effectiveAt = nowIso;
    } else {
      if (!isISODateString(effectiveAt)) {
        return fail("invalid_effective", "生效时间不是合法 ISO 时间");
      }
    }
    if (Date.parse(effectiveAt) >= Date.parse(expireAt)) {
      return fail("effective_after_expire", "生效时间必须早于失效时间");
    }
    // 允许补录“已过期”窗口（生效时间也在过去），但未来生效的委派
    // 失效时间必须在未来（否则窗口永不生效）
    if (!immediate && Date.parse(effectiveAt) > nowMs &&
        Date.parse(expireAt) <= nowMs) {
      return fail("expire_in_past", "未来生效的委派，失效时间必须晚于当前时间");
    }

    var reasonCheck = validateReason(body.reason);
    if (!reasonCheck.ok) return reasonCheck;

    var existing = Array.isArray(ctx.existing) ? ctx.existing : [];
    if (existing.length >= LIMITS.DELEGATIONS_PER_RESOURCE_MAX) {
      return fail("delegation_too_large",
        "该资源的角色委派记录已达上限 " +
        LIMITS.DELEGATIONS_PER_RESOURCE_MAX);
    }

    // 只与仍可能生效的记录比较：status=active 且新窗口与其窗口重叠
    var startMs = Date.parse(effectiveAt), endMs = Date.parse(expireAt);
    for (var i = 0; i < existing.length; i++) {
      var d = existing[i];
      if (d.status !== "active") continue;
      if (d.member !== member) continue;
      if (d.role === role) {
        if (windowsOverlap(startMs, endMs,
                           Date.parse(d.effectiveAt), Date.parse(d.expireAt))) {
          return fail("duplicate_delegation",
            "成员 “" + member + "” 在该" + SCOPE_LABELS[scope] +
            "上已有时间窗重叠的“" + ROLE_LABELS[role] + "”委派（" +
            d.effectiveAt + " ~ " + d.expireAt +
            "），重复委派明确拒绝；如需调整请先撤销原委派",
            { existingDelegationId: d.id });
        }
      }
      var conflicts = ROLE_CONFLICTS[role] || [];
      if (conflicts.indexOf(d.role) !== -1 &&
          windowsOverlap(startMs, endMs,
                         Date.parse(d.effectiveAt), Date.parse(d.expireAt))) {
        return fail("conflicting_roles",
          "成员 “" + member + "” 在该" + SCOPE_LABELS[scope] +
          "上已持有时间窗重叠的“" + ROLE_LABELS[d.role] + "”角色，" +
          "“" + ROLE_LABELS[role] + "”与“" + ROLE_LABELS[d.role] +
          "”职责冲突，同一成员不能同时持有",
          { existingDelegationId: d.id, conflictingRole: d.role });
      }
    }

    return ok({
      scope: scope,
      resourceId: resourceId,
      role: role,
      member: member,
      effectiveAt: effectiveAt,
      expireAt: expireAt,
      reason: reasonCheck.value
    });
  }

  function windowsOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  /* 单条委派在某时刻的状态：
   *   revoked 已撤销（永久失效，保留记录）
   *   pending 未到生效时间
   *   expired 已过失效时间
   *   active 生效中
   */
  function delegationState(d, nowIso) {
    if (!d || d.status === "revoked") return "revoked";
    var nowMs = Date.parse(nowIso || new Date().toISOString());
    if (Date.parse(d.effectiveAt) > nowMs) return "pending";
    if (Date.parse(d.expireAt) <= nowMs) return "expired";
    return "active";
  }

  function isActive(d, nowIso) { return delegationState(d, nowIso) === "active"; }

  // 角色满足判断：actual 角色层级覆盖 required（review/approve/execute 隐含 view）
  function roleCovers(actual, required) {
    if (actual === required) return true;
    if (required === "view") return ROLES.indexOf(actual) >= 1;
    return false;
  }

  /* 计算某成员在某资源上某时刻持有的全部生效角色（去重）。
   * delegations 是该资源上的全部委派记录（含已撤销/已过期，供审计）。
   */
  function activeRoles(delegations, member, nowIso) {
    var set = Object.create(null);
    (delegations || []).forEach(function (d) {
      if (d.member === member && isActive(d, nowIso)) set[d.role] = true;
    });
    return ROLES.filter(function (r) { return !!set[r]; });
  }

  /* 计算某成员在某资源上“被明确拒绝”的原因（用于接口 403 明细与审计）。
   * 返回 {allowed, code, message, roles, state}：
   *   - 资源从未配置过任何角色（无委派记录）视为未启用权限管控，allowed=true；
   *   - 负责人始终放行（owner 隐含全部角色，但负责人自审在审批接口单独拦截）；
   *   - 否则按生效角色层级判断 required 角色；
   *   - 未授权 unauthorized；只有过期角色 role_expired；
   *     只有未生效角色 role_not_active。
   */
  function authorize(input) {
    var delegations = input.delegations || [];
    var member = input.member || "";
    var required = input.required;
    var nowIso = input.now || new Date().toISOString();

    var configured = delegations.some(function (d) {
      // 有过任意委派记录（含已撤销）即表示该资源已启用权限管控；
      // 撤销全部委派后资源保持受控，只有负责人能重新配置。
      return d && d.scope;
    });
    if (!configured) {
      return { allowed: true, configured: false, roles: [], reason: null };
    }
    if (input.owner && member && member === input.owner) {
      return { allowed: true, configured: true, owner: true,
        roles: ROLES.slice(), reason: null };
    }

    var mine = delegations.filter(function (d) { return d.member === member; });
    var roles = activeRoles(mine, member, nowIso);
    var covers = roles.some(function (r) { return roleCovers(r, required); });
    if (covers) {
      return { allowed: true, configured: true, roles: roles, reason: null };
    }

    // 未通过：区分未授权 / 角色过期 / 角色未生效，给出明确拒绝原因
    var hasPending = mine.some(function (d) {
      return delegationState(d, nowIso) === "pending" &&
             roleCovers(d.role, required);
    });
    var hasExpired = mine.some(function (d) {
      return delegationState(d, nowIso) === "expired" &&
             roleCovers(d.role, required);
    });
    var code, message;
    if (!member) {
      code = "missing_member";
      message = "请求未提供成员身份（X-Member 头或 as 查询参数），" +
        "该资源已启用角色权限管控，无法判定操作权限";
    } else if (hasExpired) {
      code = "role_expired";
      message = "成员 “" + member + "” 在该资源上的“" +
        ROLE_LABELS[required] + "”角色已过失效时间，操作被拒绝；" +
        "请联系负责人重新委派";
    } else if (hasPending) {
      code = "role_not_active";
      message = "成员 “" + member + "” 在该资源上的“" +
        ROLE_LABELS[required] + "”角色尚未到生效时间，操作被拒绝";
    } else {
      code = "unauthorized";
      message = "成员 “" + member + "” 没有该资源的“" +
        ROLE_LABELS[required] + "”角色，操作被拒绝";
    }
    return { allowed: false, configured: true, roles: roles,
      reason: { code: code, message: message } };
  }

  /* 撤销校验：只能撤销 status=active 的委派；
   * 已撤销 duplicate_revoke、自然过期 expired_delegation 都明确拒绝
   * （过期记录保留供审计，不需要撤销；如需重新授权请新建委派）。
   */
  function validateRevoke(delegation, body, nowIso) {
    if (!delegation) return fail("delegation_not_found", "角色委派不存在");
    if (delegation.status === "revoked") {
      return fail("duplicate_revoke",
        "该委派已被撤销（撤销人：" + (delegation.revokedBy || "—") +
        "），不能重复撤销");
    }
    var state = delegationState(delegation, nowIso);
    if (state === "expired") {
      return fail("delegation_expired",
        "该委派已过失效时间而自然失效，无需撤销，记录保留供审计");
    }
    var reasonCheck = validateReason(body && body.reason);
    if (!reasonCheck.ok) return reasonCheck;
    return ok({ reason: reasonCheck.value });
  }

  /* 某资源是否已启用权限管控（有任意委派记录即启用） */
  function isConfigured(delegations) {
    return (delegations || []).some(function (d) { return d && d.scope; });
  }

  function publicDelegation(d, nowIso) {
    return {
      id: d.id,
      scope: d.scope,
      resourceId: d.resourceId,
      role: d.role,
      member: d.member,
      effectiveAt: d.effectiveAt,
      expireAt: d.expireAt,
      status: delegationState(d, nowIso),
      reason: d.reason || "",
      grantedBy: d.grantedBy,
      grantedAt: d.grantedAt,
      revokedAt: d.revokedAt || null,
      revokedBy: d.revokedBy || null,
      revokeReason: d.revokeReason || null
    };
  }

  return {
    SCOPES: SCOPES,
    ROLES: ROLES,
    ROLE_LABELS: ROLE_LABELS,
    SCOPE_LABELS: SCOPE_LABELS,
    ROLES_BY_SCOPE: ROLES_BY_SCOPE,
    ROLE_RANK: ROLE_RANK,
    ROLE_CONFLICTS: ROLE_CONFLICTS,
    LIMITS: LIMITS,
    isISODateString: isISODateString,
    cleanMember: cleanMember,
    validateMember: validateMember,
    validateReason: validateReason,
    validateGrant: validateGrant,
    validateRevoke: validateRevoke,
    delegationState: delegationState,
    isActive: isActive,
    roleCovers: roleCovers,
    activeRoles: activeRoles,
    authorize: authorize,
    isConfigured: isConfigured,
    windowsOverlap: windowsOverlap,
    publicDelegation: publicDelegation
  };
});
