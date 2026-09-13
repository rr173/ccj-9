/* replay-session-core.js
 * 回放空间“复核会话”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.ReplaySessionCore），Node 下可直接 require 单测。
 *
 * 复核会话是什么：
 *   负责人在一个回放空间内按当前筛选条件选取多条复核意见，组成一次集中复核
 *   会话，设置参与人与截止时间。创建瞬间锁定每条所选意见的版本号与引用摘要
 *   （targetSummary），参与人只能对会话内的意见逐条提交结论：
 *     confirm       确认（证据无误）
 *     reject        驳回（复核意见不成立）
 *     need_evidence 需补证据（现有材料不足以下结论）
 *
 * 并发与冲突模型：
 *   - 会话自带单调 version（X-Session-Version），提交结论必须回传；
 *   - 每条会话条目记录创建时的 lockedVersion；提交时若意见已关闭、
 *     意见版本已被会话外更新、或引用目标不再存在，则标记冲突并拒绝覆盖——
 *     冲突留痕持久化，结论不写入、意见不被改动；
 *   - 会话与每条结论的操作记录只增不改，随回放空间原子落盘，重启后可继续。
 *
 * 本模块只做纯计算与校验，不做任何持久化，也不知道线上暂停/审批/执行接口。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./replay-review-core"));
  } else {
    root.ReplaySessionCore = factory(root.ReplayReviewCore);
  }
})(typeof self !== "undefined" ? self : this, function (RR) {
  "use strict";

  /* 结论类型 */
  var RESULTS = ["confirm", "reject", "need_evidence"];
  var RESULT_LABELS = {
    confirm: "确认",
    reject: "驳回",
    need_evidence: "需补证据"
  };

  /* 冲突类型（提交结论时发现，标记到条目上并拒绝覆盖） */
  var CONFLICT_CODES = ["review_closed", "updated_outside", "target_missing", "review_missing"];
  var CONFLICT_LABELS = {
    review_closed: "意见已关闭",
    updated_outside: "意见已被会话外更新",
    target_missing: "引用目标不再存在",
    review_missing: "意见已不存在"
  };

  var LIMITS = {
    SESSIONS_PER_SPACE_MAX: 200,
    SESSION_ITEMS_MAX: 200,
    SESSION_NAME_MAX_CHARS: 100,
    PARTICIPANT_MAX_CHARS: 50,
    PARTICIPANTS_MAX: 20,
    NOTE_MAX_CHARS: 1000,
    SESSION_LOGS_PER_SPACE_MAX: 5000
  };

  function fail(code, message, extra) {
    var f = { ok: false, code: code, message: message };
    if (extra) { for (var k in extra) { f[k] = extra[k]; } }
    return f;
  }

  function trimmed(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  function isISODateString(s) {
    return RR.isISODateString(s);
  }

  // 会话是否已过期（deadline 到点即过期，过期会话拒绝一切结论提交）
  function isExpired(session, nowIso) {
    if (!session || !session.deadline) return false;
    return Date.parse(session.deadline) <=
      Date.parse(nowIso || new Date().toISOString());
  }

  // 某条意见当前所属的“未过期”会话（用于重复加入检查）
  function findActiveSessionOf(sessions, reviewId, nowIso) {
    var list = sessions || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (isExpired(s, nowIso)) continue;
      var items = s.items || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j].reviewId === reviewId) return s;
      }
    }
    return null;
  }

  /* ================= 创建会话校验 =================
   * input: {name?, participants:[...], deadline, reviewIds:[...], filters?}
   * reviews: 空间内全部复核意见；sessions: 空间内全部会话（查重复加入）。
   * nowIso 由调用方注入（保持纯函数、可测）。
   */
  function validateCreate(input, reviews, sessions, nowIso) {
    input = input || {};

    var name = trimmed(input.name);
    if (name.length > LIMITS.SESSION_NAME_MAX_CHARS) {
      return fail("session_name_too_long",
        "会话名称最长 " + LIMITS.SESSION_NAME_MAX_CHARS + " 字符");
    }

    // 参与人：去空白、明确拒绝重复、1..20 名
    var rawParts = Array.isArray(input.participants) ? input.participants : [];
    var participants = [];
    var seenP = Object.create(null);
    for (var i = 0; i < rawParts.length; i++) {
      var p = trimmed(rawParts[i]);
      if (!p) continue;
      if (p.length > LIMITS.PARTICIPANT_MAX_CHARS) {
        return fail("participant_too_long",
          "参与人名称最长 " + LIMITS.PARTICIPANT_MAX_CHARS + " 字符");
      }
      if (seenP[p]) {
        return fail("duplicate_participant", "参与人重复：" + p);
      }
      seenP[p] = true;
      participants.push(p);
    }
    if (!participants.length) {
      return fail("missing_participant", "必须指定至少一名会话参与人");
    }
    if (participants.length > LIMITS.PARTICIPANTS_MAX) {
      return fail("too_many_participants",
        "会话参与人最多 " + LIMITS.PARTICIPANTS_MAX + " 名");
    }

    // 截止时间：必填、合法 ISO、必须晚于当前
    if (!input.deadline) {
      return fail("missing_deadline", "必须指定会话截止时间");
    }
    if (!isISODateString(input.deadline)) {
      return fail("invalid_deadline", "会话截止时间不是合法 ISO 时间");
    }
    if (nowIso && Date.parse(input.deadline) <= Date.parse(nowIso)) {
      return fail("deadline_in_past", "会话截止时间必须晚于当前时间");
    }

    // 选集：非空、无重复、每条都必须存在于空间内
    var ids = Array.isArray(input.reviewIds) ? input.reviewIds : null;
    if (!ids || !ids.length) {
      return fail("empty_selection",
        "选集为空：请按当前筛选条件选取至少一条复核意见再创建会话");
    }
    if (ids.length > LIMITS.SESSION_ITEMS_MAX) {
      return fail("session_too_large",
        "一个复核会话最多包含 " + LIMITS.SESSION_ITEMS_MAX + " 条意见");
    }
    var byId = Object.create(null);
    (reviews || []).forEach(function (r) { byId[r.id] = r; });
    var seen = Object.create(null);
    var picked = [];
    for (var j = 0; j < ids.length; j++) {
      var rid = ids[j];
      if (typeof rid !== "string" || !rid) {
        return fail("invalid_review_id", "选集中包含非法的意见标识");
      }
      if (seen[rid]) {
        return fail("duplicate_review_id",
          "选集中重复加入同一条意见：" + rid, { reviewId: rid });
      }
      seen[rid] = true;
      var rv = byId[rid];
      if (!rv) {
        return fail("review_not_found",
          "意见 " + rid + " 不在该回放空间内，不能加入会话", { reviewId: rid });
      }
      picked.push(rv);
    }
    // 重复加入：已属于其他未过期会话的意见明确拒绝（过期会话的意见可重新选取）
    for (var k = 0; k < picked.length; k++) {
      var holder = findActiveSessionOf(sessions, picked[k].id, nowIso);
      if (holder) {
        return fail("already_in_session",
          "意见 " + picked[k].id + " 已在未过期会话「" +
          (holder.name || holder.id) + "」中，不能重复加入",
          { reviewId: picked[k].id, existingSessionId: holder.id });
      }
    }

    // 创建时的筛选条件（信息性，随会话保存供审计与报告）
    var filters = null;
    if (input.filters && typeof input.filters === "object") {
      var nf = RR.normalizeFilters(input.filters);
      if (!nf.ok) return fail(nf.code, nf.message);
      filters = nf.value;
    }

    return {
      ok: true,
      value: {
        name: name,
        participants: participants,
        deadline: input.deadline,
        reviewIds: ids.slice(),
        reviews: picked,
        filters: filters
      }
    };
  }

  /* ================= 提交结论校验 =================
   * input: {reviewId, result, note?, actor}
   */
  function validateConclusion(input) {
    input = input || {};
    var actor = trimmed(input.actor);
    if (!actor) {
      return fail("missing_participant", "提交结论必须署名会话参与人");
    }
    if (actor.length > LIMITS.PARTICIPANT_MAX_CHARS) {
      return fail("participant_too_long",
        "参与人名称最长 " + LIMITS.PARTICIPANT_MAX_CHARS + " 字符");
    }
    if (RESULTS.indexOf(input.result) === -1) {
      return fail("invalid_result",
        "结论非法：只支持 confirm（确认）/ reject（驳回）/ need_evidence（需补证据）");
    }
    var note = input.note == null ? "" : String(input.note).trim();
    if (note.length > LIMITS.NOTE_MAX_CHARS) {
      return fail("note_too_large",
        "结论备注最长 " + LIMITS.NOTE_MAX_CHARS + " 字符");
    }
    if (typeof input.reviewId !== "string" || !input.reviewId) {
      return fail("missing_review_id", "必须指定会话内的复核意见");
    }
    return { ok: true, value: {
      actor: actor, result: input.result, note: note, reviewId: input.reviewId
    } };
  }

  /* ================= 冲突检测（提交结论时） =================
   * 返回 null 表示无冲突；否则返回 {code, message}。
   * 三种必须拒绝覆盖的情形：意见已关闭 / 意见已被会话外更新（版本偏离锁定值）/
   * 引用目标不再存在；意见本身消失（防御性）同样按冲突处理。
   */
  function checkItemConflict(item, review, content) {
    if (!review) {
      return { code: "review_missing",
        message: "该意见已不在回放空间内，结论不能写入" };
    }
    if (review.status === "closed") {
      return { code: "review_closed",
        message: "该意见已关闭（终态），会话结论不能覆盖关闭结论" };
    }
    if (review.version !== item.lockedVersion) {
      return { code: "updated_outside",
        message: "该意见已被会话外更新（会话锁定版本 v" + item.lockedVersion +
          "，当前 v" + review.version + "），结论已拒绝覆盖" };
    }
    if (!RR.findTarget(content, review.target)) {
      return { code: "target_missing",
        message: "该意见引用的锁定目标已不存在，结论已拒绝" };
    }
    return null;
  }

  /* ================= 实时进度（每次读取即时计算，不缓存） ================= */
  function sessionProgress(session, nowIso) {
    var items = (session && session.items) || [];
    var concluded = 0;
    var conflicts = 0;
    items.forEach(function (it) {
      if (it.conclusion) concluded++;
      else if (it.conflict) conflicts++;
    });
    var total = items.length;
    return {
      total: total,
      concluded: concluded,
      conflicts: conflicts,
      pending: total - concluded - conflicts,
      percent: total ? Math.round((concluded / total) * 100) : 0,
      expired: isExpired(session, nowIso)
    };
  }

  /* ================= 会话报告（独立导出物，纯只读构建） =================
   * args: { space, session, reviews, logs, generatedAt, generatedBy }
   * 纯函数：不修改任何输入；导出失败（调用方原因）天然不影响意见、
   * 会话进度或回放空间。
   */
  function buildReport(args) {
    args = args || {};
    var sp = args.space || {};
    var s = args.session;
    if (!s) return fail("session_not_found", "复核会话不存在");
    var nowIso = args.generatedAt || new Date().toISOString();

    var reviewsById = Object.create(null);
    (args.reviews || []).forEach(function (r) { reviewsById[r.id] = r; });

    var items = (s.items || []).map(function (it) {
      var rv = reviewsById[it.reviewId] || null;
      return {
        reviewId: it.reviewId,
        lockedVersion: it.lockedVersion,
        lockedStatus: it.lockedStatus,
        // 创建会话时锁定的引用摘要（独立于空间当前状态仍可读）
        targetSummary: it.targetSummary || null,
        current: rv ? {
          version: rv.version,
          status: rv.status,
          statusLabel: RR.STATUS_LABELS[rv.status] || rv.status,
          reviewer: rv.reviewer,
          dueAt: rv.dueAt,
          content: rv.content,
          closedAt: rv.closedAt || null,
          closedBy: rv.closedBy || null
        } : null,
        conclusion: it.conclusion ? {
          result: it.conclusion.result,
          resultLabel: RESULT_LABELS[it.conclusion.result] || it.conclusion.result,
          note: it.conclusion.note || "",
          by: it.conclusion.by,
          at: it.conclusion.at,
          reviewVersion: it.conclusion.reviewVersion
        } : null,
        conflict: it.conflict ? {
          code: it.conflict.code,
          label: CONFLICT_LABELS[it.conflict.code] || it.conflict.code,
          message: it.conflict.message,
          at: it.conflict.at,
          by: it.conflict.by
        } : null
      };
    });

    var logs = (args.logs || []).filter(function (l) {
      return l.sessionId === s.id;
    }).slice().sort(function (a, b) {
      var d = Date.parse(a.at) - Date.parse(b.at);
      if (d) return d;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    var m = sp.manifest || {};
    return {
      ok: true,
      value: {
        format: "bidi-replay-review-session-report",
        reportVersion: 1,
        generatedAt: nowIso,
        generatedBy: args.generatedBy || "负责人",
        space: {
          id: sp.id, name: sp.name || null,
          packageId: sp.packageId, producerId: sp.producerId || null,
          range: sp.range || { from: null, to: null },
          contentHash: m.contentHash || null,
          chainHead: m.chainHead || null,
          eventCount: m.eventCount == null ? null : m.eventCount
        },
        session: {
          id: s.id,
          version: s.version,
          name: s.name,
          participants: (s.participants || []).slice(),
          deadline: s.deadline,
          expired: isExpired(s, nowIso),
          createdBy: s.createdBy,
          createdAt: s.createdAt,
          filters: s.filters || null,
          progress: sessionProgress(s, nowIso),
          items: items
        },
        logs: logs
      }
    };
  }

  return {
    RESULTS: RESULTS,
    RESULT_LABELS: RESULT_LABELS,
    CONFLICT_CODES: CONFLICT_CODES,
    CONFLICT_LABELS: CONFLICT_LABELS,
    LIMITS: LIMITS,
    isExpired: isExpired,
    findActiveSessionOf: findActiveSessionOf,
    validateCreate: validateCreate,
    validateConclusion: validateConclusion,
    checkItemConflict: checkItemConflict,
    sessionProgress: sessionProgress,
    buildReport: buildReport
  };
});
