/* permission-request-group-core.js
 * “申请分组与批量处理”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.PermissionRequestGroupCore），Node 下可直接 require 单测。
 *
 * 在既有“权限变更申请与生效预览”（permission-request-core.js）之上引入：
 *   负责人按 资源 / 申请类型 / 成员 / 状态 把申请加入分组（分组锁定到单一资源，
 *   scope+resourceId），可为分组设置名称、处理截止时间 deadline 与备注 note；
 *   申请列表对外携带所属分组（groupId/groupName）、分组截止状态（deadlineState）
 *   与该组待处理数量（pendingCount）。普通成员只能看到“自己申请所在分组”的摘要。
 *
 * 版本与审计（与既有版本链一致）：
 *   - 分组集合有独立单调版本号 groupRev（X-Permission-Group-Rev），
 *     与申请集合 requestRev、正式委派集合 rev 三者相互独立；
 *   - 分组创建/改名/改截止/改备注/加成员/移除成员/删除 必须 If-Match 等于
 *     groupRev；批量决定同时校验 If-Match=申请集合 requestRev（与逐条审批一致）
 *     与每条申请 X-Request-Version 严格相等；
 *   - 分组变更（group_change）、批量审批（batch_decide）、截止提醒
 *     （deadline_reminder）写入独立审计日志 groupLogs（只增不改，重启可查）。
 *
 * 批量决定（原子，整批要么全改要么全不改）：
 *   前置校验覆盖——分组存在且同组、每条申请存在且当前 pending 且未过自身审批
 *   截止、集合版本 requestRev 与每条 version 严格相等、负责人身份与自审分离、
 *   拒绝必填原因、批准瞬间对“正式委派 + 其它待处理申请 + 本批其它批准授予项”
 *   重新做窗口/职责冲突复核。任一条过期、已被处理或存在角色冲突，整批不改变
 *   任何权限，并对每条返回失败原因（results[].ok=false/code/message）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./permission-request-core"));
  } else {
    root.PermissionRequestGroupCore = factory(root.PermissionRequestCore);
  }
})(typeof self !== "undefined" ? self : this, function (prc) {
  "use strict";

  prc = prc || (typeof require === "function"
    ? require("./permission-request-core") : null);

  var SCOPES = prc.SCOPES;
  var ROLES = prc.ROLES;
  var ROLE_LABELS = prc.ROLE_LABELS;
  var SCOPE_LABELS = prc.SCOPE_LABELS;
  var KINDS = prc.KINDS;
  var LIMITS = {
    NAME_MAX_CHARS: 100,
    NOTE_MAX_CHARS: 500,   // 分组备注
    REASON_MAX_CHARS: 500, // 批量决定原因
    GROUPS_MAX: 1000,      // 分组数量上限
    GROUP_LOGS_MAX: 20000
  };

  function fail(code, message, extra) {
    var f = { ok: false, code: code, message: message };
    if (extra) { for (var k in extra) { f[k] = extra[k]; } }
    return f;
  }
  function ok(value) { return { ok: true, value: value }; }

  function cleanName(name) {
    return typeof name === "string" ? name.trim() : "";
  }
  function charLen(s) { return Array.from(s).length; }

  function validateGroupText(value, field, code, max) {
    if (value === undefined || value === null) return ok("");
    if (typeof value !== "string") return fail("invalid_" + field, "字段必须是字符串");
    var v = value.trim();
    if (charLen(v) > max) return fail(code, "字段最长 " + max + " 字符");
    return ok(v);
  }

  /* ================= 分组创建/更新校验 =================
   * body: {name, deadline(ISO 或空), note}
   * ctx:  {now, scope?, resourceId?, isCreate, groupCount?}
   * 创建（isCreate）时 scope/resourceId 必填且合法；更新时只校验给出的字段。
   * 分组处理截止 deadline 必须是未来时刻（可只精确到分钟），用于待处理提醒，
   * 与申请自身的审批截止 expiresAt 相互独立。
   */
  function validateGroupBody(body, ctx) {
    body = body || {};
    ctx = ctx || {};
    var nowIso = ctx.now || new Date().toISOString();
    var nowMs = Date.parse(nowIso);
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
      if (Number.isInteger(ctx.groupCount) &&
          ctx.groupCount >= LIMITS.GROUPS_MAX) {
        return fail("group_too_large",
          "申请分组数量已达上限 " + LIMITS.GROUPS_MAX);
      }
    }

    if (ctx.isCreate || body.name !== undefined) {
      var nc = validateGroupText(body.name, "name", "name_too_long",
        LIMITS.NAME_MAX_CHARS);
      if (!nc.ok) return nc;
      if (!nc.value) return fail("missing_group_name", "分组名称不能为空");
      out.name = nc.value;
    }

    if (ctx.isCreate || body.deadline !== undefined) {
      var raw = body.deadline;
      if (raw === undefined || raw === null || raw === "") {
        out.deadline = null; // 允许不设处理截止
      } else {
        if (!prc.isISODateString(raw)) {
          return fail("invalid_deadline", "处理截止时间不是合法 ISO 时间");
        }
        // 创建要求未来时刻；更新允许改成过去时间（用于把组标记为逾期），
        // 逾期状态仅影响 deadlineState 与截止提醒，不改变任何权限。
        if (ctx.isCreate && Date.parse(raw) <= nowMs) {
          return fail("deadline_in_past", "处理截止时间必须晚于当前时间");
        }
        out.deadline = raw;
      }
    }

    if (ctx.isCreate || body.note !== undefined) {
      var gc = validateGroupText(body.note, "note", "note_too_long",
        LIMITS.NOTE_MAX_CHARS);
      if (!gc.ok) return gc;
      out.note = gc.value;
    }

    return ok(out);
  }

  /* 分组处理截止状态（纯按时间计算，与组内申请是否处理完无关）：
   *   none 未设置 / pending 未到期 / overdue 已过处理截止
   */
  function deadlineState(group, nowIso) {
    if (!group || !group.deadline) return "none";
    var nowMs = Date.parse(nowIso || new Date().toISOString());
    return Date.parse(group.deadline) <= nowMs ? "overdue" : "pending";
  }
  function deadlineStateLabel(s) {
    return { none: "未设截止", pending: "未到截止", overdue: "已过截止" }[s] || s;
  }

  /* 组装分组内的申请（groupId 冗余在申请记录上，是唯一归属来源） */
  function requestsInGroup(group, requests) {
    return (Array.isArray(requests) ? requests : [])
      .filter(function (r) { return r.groupId === group.id; });
  }

  /* 分组摘要/详情的纯计算：总数、按申请类型/成员/状态计数、待处理数量、
   * 截止状态。普通成员视图由调用方把 requests 预先过滤为本人申请。
   */
  function groupSummary(group, requests, nowIso) {
    nowIso = nowIso || new Date().toISOString();
    var list = requestsInGroup(group, requests);
    var byKind = { grant: 0, revoke: 0 };
    var byStatus = { pending: 0, approved: 0, rejected: 0, expired: 0, failed: 0 };
    var byMember = Object.create(null);
    var pending = 0;
    list.forEach(function (r) {
      if (byKind[r.kind] === undefined) byKind[r.kind] = 0;
      byKind[r.kind]++;
      var live = prc.requestState(r, Date.parse(nowIso));
      if (byStatus[live] === undefined) byStatus[live] = 0;
      byStatus[live]++;
      byMember[r.member] = (byMember[r.member] || 0) + 1;
      if (live === "pending") pending++;
    });
    var ds = deadlineState(group, nowIso);
    return {
      totalCount: list.length,
      pendingCount: pending,
      grantCount: byKind.grant,
      revokeCount: byKind.revoke,
      statusCounts: byStatus,
      memberCounts: byMember,
      deadlineState: ds,
      deadlineStateLabel: deadlineStateLabel(ds)
    };
  }

  /* ================= 截止提醒（确定性、幂等） =================
   * 输入：groups（全部分组）、requests（全部申请）、
   *       {now, approachingMs(提前量，默认 24 小时), reminded:{groupId:{approaching,overdue}}}
   * 输出：本次应产生提醒的数组 [{groupId, kind:"approaching"|"overdue",
   *        scope, resourceId, name, deadline, pendingCount}]。
   * 规则（同一分组同一类型只提醒一次，由调用方持久化 reminded 标记）：
   *   - 组内仍有 pending 申请；
   *   - approaching：deadline 起前 approachingMs 内（含边界）且未过期、未提醒；
   *   - overdue：已过 deadline 且未提醒（即使之前发过 approaching 也补发 overdue）。
   */
  function dueReminders(groups, requests, opts) {
    opts = opts || {};
    var nowIso = opts.now || new Date().toISOString();
    var nowMs = Date.parse(nowIso);
    var approachingMs = Number.isFinite(opts.approachingMs) && opts.approachingMs >= 0
      ? opts.approachingMs : 24 * 3600 * 1000;
    var reminded = opts.reminded || {};
    var out = [];
    (Array.isArray(groups) ? groups : []).forEach(function (g) {
      if (!g.deadline) return;
      var mark = reminded[g.id] || {};
      var pending = requestsInGroup(g, requests)
        .filter(function (r) { return prc.requestState(r, nowMs) === "pending"; });
      if (!pending.length) return;
      var dl = Date.parse(g.deadline);
      var base = {
        groupId: g.id, scope: g.scope, resourceId: g.resourceId,
        name: g.name, deadline: g.deadline, pendingCount: pending.length
      };
      if (dl <= nowMs) {
        if (!mark.overdue) out.push(Object.assign({ kind: "overdue" }, base));
      } else if (dl - nowMs <= approachingMs) {
        if (!mark.approaching) out.push(Object.assign({ kind: "approaching" }, base));
      }
    });
    return out;
  }

  /* ================= 批量决定（原子前置校验） =================
   * items: [{id, version, decision:"approve"|"reject", reason?}]
   * ctx: {now, actor, owner, requestRev(当前申请集合版本),
   *       expectedRev(请求头 If-Match), group, requests(全量或本资源),
   *       delegations(本资源正式委派)}
   * 返回 {ok:true,value:{items:[{request, decision, reason, actor}]}}
   *   或 {ok:false,code,results:[{id/index,ok,code,message,currentVersion,currentStatus}]}
   * 不修改任何入参；调用方在 value 上一次性落库（整批同一事务）。
   */
  function validateBatchDecisions(items, ctx) {
    ctx = ctx || {};
    var nowIso = ctx.now || new Date().toISOString();
    var results = [];
    var hasFatal = false; // 400 级别的整批格式错误
    var hasItemFailure = false;

    // 集合版本先于逐条校验：旧页面整批拒绝
    var expectedRev = ctx.expectedRev;
    if (expectedRev === undefined || expectedRev === null || expectedRev === "") {
      return fail("precondition_required",
        "批量审批必须携带 If-Match 申请集合版本号");
    }
    var theirRev = parseInt(expectedRev, 10);
    if (!Number.isInteger(theirRev) || theirRev !== ctx.requestRev) {
      return fail("version_conflict",
        "申请集合已被其他页面更新（当前版本 " + ctx.requestRev +
        "），本次批量审批整批取消，请刷新后重试",
        { currentRev: ctx.requestRev });
    }

    if (!Array.isArray(items) || !items.length) {
      return fail("empty_batch", "批量审批至少包含一条申请决定");
    }

    var group = ctx.group || null;
    var requests = Array.isArray(ctx.requests) ? ctx.requests : [];
    var delegations = Array.isArray(ctx.delegations) ? ctx.delegations : [];
    var actor = typeof ctx.actor === "string" ? ctx.actor.trim() : "";
    if (!actor) return fail("missing_actor", "缺少处理人身份");

    var seen = Object.create(null);
    var parsed = [];

    items.forEach(function (raw, idx) {
      var seq = idx + 1;
      function itemFail(code, message, extra) {
        hasItemFailure = true;
        var row = Object.assign({ seq: seq, id: raw && raw.id || null,
          ok: false, code: code, message: message }, extra || {});
        results.push(row);
      }
      var id = raw && typeof raw.id === "string" ? raw.id.trim() : "";
      if (!id) {
        hasFatal = true;
        itemFail("missing_request_id", "第 " + seq + " 条缺少申请 id");
        return;
      }
      if (seen[id]) {
        hasFatal = true;
        itemFail("duplicate_in_batch",
          "申请 " + id + " 在同一批中出现多次，批量审批不能对同一申请重复决定",
          { id: id });
        return;
      }
      seen[id] = true;

      var req = requests.find(function (x) { return x.id === id; }) || null;
      if (!req) {
        hasFatal = true;
        itemFail("request_not_found", "申请 " + id + " 不存在", { id: id });
        return;
      }
      // 必须属于同一分组
      if (group) {
        if (req.groupId !== group.id) {
          hasFatal = true;
          itemFail("not_in_group",
            "申请 " + id + " 不属于分组 “" + group.name + "”，不能在该组批量审批",
            { id: id, currentGroupId: req.groupId || null });
          return;
        }
      }
      // 每条申请版本严格相等
      var ver = raw.version;
      if (ver === undefined || ver === null || ver === "") {
        itemFail("precondition_required",
          "申请 " + id + " 缺少 X-Request-Version 申请版本号",
          { id: id, currentVersion: req.version, currentStatus: req.status });
        return;
      }
      var their = parseInt(ver, 10);
      if (!Number.isInteger(their) || their !== req.version) {
        itemFail("request_version_conflict",
          "申请 " + id + " 已被其他处理推进到版本 " + req.version +
          "（提交版本 " + their + "），旧版本整批拒绝",
          { id: id, currentVersion: req.version, currentStatus: req.status });
        return;
      }
      // 必须 pending（已被处理 -> request_not_pending）
      if (req.status !== "pending") {
        itemFail("request_not_pending",
          "申请 " + id + " 当前状态为 " + req.status + "，只有待处理申请可以审批",
          { id: id, currentVersion: req.version, currentStatus: req.status });
        return;
      }
      // 自身审批截止过期（不臆测为可批准）
      if (prc.requestState(req, Date.parse(nowIso)) === "expired") {
        itemFail("request_expired",
          "申请 " + id + " 已过审批截止时间 " + req.expiresAt +
          "，过期审批明确拒绝，整批不改变任何权限",
          { id: id, expiredAt: req.expiresAt,
            currentVersion: req.version, currentStatus: "expired" });
        return;
      }
      // 职责分离：负责人审批自己的申请
      if (req.member === actor) {
        itemFail("self_approval",
          "申请 " + id + " 由处理人本人提交，负责人不能审批自己的申请（职责分离）",
          { id: id });
        return;
      }
      // 资源负责人（同组同资源，校验一次即可语义，逐条保留原因）
      if (ctx.owner != null && actor !== ctx.owner) {
        itemFail("not_resource_owner",
          "只有资源负责人（" + ctx.owner + "）可以批量审批申请 " + id,
          { id: id });
        return;
      }
      var decision = raw.decision;
      if (decision !== "approve" && decision !== "reject") {
        itemFail("invalid_decision",
          "申请 " + id + " 的决定必须是 approve 或 reject", { id: id });
        return;
      }
      var reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
      if (charLen(reason) > LIMITS.REASON_MAX_CHARS) {
        itemFail("reason_too_long",
          "申请 " + id + " 的原因最长 " + LIMITS.REASON_MAX_CHARS + " 字符",
          { id: id });
        return;
      }
      if (decision === "reject" && !reason) {
        itemFail("reject_reason_required",
          "申请 " + id + " 标记为拒绝，拒绝必须填写原因（申请人可见）",
          { id: id });
        return;
      }
      parsed.push({ request: req, decision: decision, reason: reason, raw: raw });
    });

    if (hasFatal || hasItemFailure) {
      // 仍然对“格式合法”的条目给出逐条原因占位，便于调用方/前端定位
      return fail(hasFatal ? "batch_invalid" : "batch_conflict",
        hasFatal
          ? "批量审批包含非法条目，整批未改变任何权限"
          : "批量审批存在过期/已处理/版本冲突/角色冲突条目，整批未改变任何权限",
        { results: results });
    }

    /* ---- 批准瞬间复核（含批内批准授予项之间的成对窗口/职责冲突） ---- */
    // 模拟“本批批准授予”累积生成的正式委派，逐条复用既有审批复核，
    // 使批内重复/冲突与“期间已被直授”完全同一口径。
    var simulatedDelegations = delegations.slice();
    var batchGrantRequests = parsed
      .filter(function (p) { return p.decision === "approve" &&
        p.request.kind === "grant"; })
      .map(function (p) { return p.request; });

    parsed.forEach(function (p) {
      var req = p.request;
      var seq = items.indexOf(p.raw) + 1;
      if (p.decision === "reject") {
        results.push({ seq: seq, id: req.id, ok: true, decision: "reject" });
        return;
      }
      // 批准：复用逐条审批的全部硬规则；其它待处理申请需要包含
      // （a）批外 pending 申请（排除本批成员自身）与（b）本批批准授予项，
      // 二者都以 simulatedDelegations 为“当前正式委派”基准。
      var others = requests.filter(function (x) {
        return x.id !== req.id &&
          batchGrantRequests.indexOf(x) === -1;
      });
      var checkCtx = {
        now: nowIso, version: req.version, actor: actor, owner: ctx.owner,
        delegations: simulatedDelegations, requests: others
      };
      var re = prc.validateDecision(req, { decision: "approve", reason: p.reason },
        checkCtx);
      if (!re.ok) {
        hasItemFailure = true;
        results.push({
          seq: seq, id: req.id, ok: false, code: re.code, message: re.message,
          currentVersion: req.version, currentStatus: req.status,
          existingDelegationId: re.existingDelegationId || null,
          existingRequestId: re.existingRequestId || null,
          conflictingRole: re.conflictingRole || null
        });
        return;
      }
      // 通过：授予项把“将生成的正式委派”加入模拟集合，供后续批准项复核
      if (req.kind === "grant") {
        simulatedDelegations.push({
          id: "__batch_" + req.id, status: "active",
          scope: req.scope, resourceId: req.resourceId, role: req.role,
          member: req.member, effectiveAt: req.effectiveAt, expireAt: req.expireAt
        });
      }
      results.push({ seq: seq, id: req.id, ok: true, decision: "approve" });
    });

    if (hasItemFailure) {
      return fail("batch_conflict",
        "批量审批存在角色冲突/批准复核失败条目，整批未改变任何权限",
        { results: results });
    }
    return ok({ items: parsed.map(function (p) {
      return { request: p.request, decision: p.decision, reason: p.reason,
        actor: actor };
    }), results: results });
  }

  return {
    SCOPES: SCOPES,
    ROLES: ROLES,
    KINDS: KINDS,
    ROLE_LABELS: ROLE_LABELS,
    SCOPE_LABELS: SCOPE_LABELS,
    LIMITS: LIMITS,
    validateGroupBody: validateGroupBody,
    deadlineState: deadlineState,
    deadlineStateLabel: deadlineStateLabel,
    requestsInGroup: requestsInGroup,
    groupSummary: groupSummary,
    dueReminders: dueReminders,
    validateBatchDecisions: validateBatchDecisions
  };
});
