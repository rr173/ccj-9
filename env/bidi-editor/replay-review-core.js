/* replay-review-core.js
 * 回放空间“历史证据复核”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.ReplayReviewCore），Node 下可直接 require 单测。
 *
 * 复核意见与锁定历史的关系：
 *   - 复核意见不属于审计包内容，不参与审计包内容哈希/事件链校验，也不随导出
 *     进入线上数据；意见挂在“回放空间”上，是导入之后才产生的协作数据。
 *   - 每条意见必须引用空间内锁定的一个事件（kind=event, eventId）或一条
 *     逐条执行结果（kind=result, executionId+annotationId）。引用目标在
 *     每次写入时都对锁定内容重新解析；历史内容本身永远只读。
 *
 * 并发模型：
 *   - 空间级 rev（X-Replay-Rev / If-Match）保证旧页面不能覆盖空间的任何变化；
 *   - 每条意见自带单调 version，修改/关闭/转派必须回传 expectedVersion；
 *   - 已关闭（closed）的意见拒绝一切修改与转派，旧页面无法覆盖关闭结论。
 *
 * 本模块只做纯计算与校验，不做任何持久化，也不知道线上暂停/审批/执行接口。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ReplayReviewCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 意见状态：
   * open       待复核（新建默认）
   * in_review  复核中
   * confirmed  已确认（复核结论：证据无误）
   * returned   已退回（复核结论：存疑/不成立，需负责人跟进）
   * closed     已关闭（终态，不可再改、不可转派）
   */
  var STATUSES = ["open", "in_review", "confirmed", "returned", "closed"];
  var MUTABLE_STATUSES = ["open", "in_review", "confirmed", "returned"];
  var STATUS_LABELS = {
    open: "待复核",
    in_review: "复核中",
    confirmed: "已确认",
    returned: "已退回",
    closed: "已关闭"
  };
  var TARGET_KINDS = ["event", "result"];

  var LIMITS = {
    REVIEWS_PER_SPACE_MAX: 1000,
    REVIEW_LOGS_PER_SPACE_MAX: 5000,
    REVIEWER_MAX_CHARS: 50,
    CONTENT_MAX_CHARS: 2000,
    CLOSE_REASON_MAX_CHARS: 500,
    FILTER_REVIEWER_MAX_CHARS: 50
  };

  function isISODateString(s) {
    if (typeof s !== "string") return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      return false;
    }
    var t = Date.parse(s);
    return !isNaN(t) && new Date(t).toISOString() != null;
  }

  function trimmed(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  /* ================= 引用目标（锁定事件 / 逐条结果） ================= */

  function targetKey(target) {
    if (!target || typeof target !== "object") return null;
    if (target.kind === "event") {
      return typeof target.eventId === "string" && target.eventId
        ? "event:" + target.eventId : null;
    }
    if (target.kind === "result") {
      return typeof target.executionId === "string" && target.executionId &&
             typeof target.annotationId === "string" && target.annotationId
        ? "result:" + target.executionId + ":" + target.annotationId
        : null;
    }
    return null;
  }

  // 在锁定内容中解析引用目标；不存在一律返回 null（调用方必须拒绝写入）
  function findTarget(content, target) {
    if (!content || !target) return null;
    if (target.kind === "event") {
      var ev = (content.events || []).filter(function (e) {
        return e.id === target.eventId;
      })[0];
      return ev ? { kind: "event", event: ev } : null;
    }
    if (target.kind === "result") {
      for (var i = 0; i < (content.executions || []).length; i++) {
        var ex = content.executions[i];
        if (ex.id !== target.executionId) continue;
        for (var j = 0; j < (ex.results || []).length; j++) {
          var r = ex.results[j];
          if (r.annotationId !== target.annotationId) continue;
          // paraIndex 为可选精化条件：给了就必须一致
          if (target.paraIndex != null && r.paraIndex !== target.paraIndex) continue;
          return { kind: "result", execution: ex, result: r };
        }
      }
      return null;
    }
    return null;
  }

  // 同一目标上的“未关闭”意见视为重复；已关闭意见不阻止重新提出
  function findDuplicate(reviews, key, excludeId) {
    return (reviews || []).filter(function (r) {
      return r.targetKey === key && r.status !== "closed" &&
             (!excludeId || r.id !== excludeId);
    })[0] || null;
  }

  /* ================= 输入校验 ================= */

  function fail(code, message) { return { ok: false, code: code, message: message }; }

  function validateTarget(input, content) {
    var t = input && input.target;
    if (!t || typeof t !== "object") {
      return fail("missing_target", "复核意见必须引用回放空间内锁定的事件或逐条结果");
    }
    if (TARGET_KINDS.indexOf(t.kind) === -1) {
      return fail("invalid_target", "引用类型非法：只支持 event（时间线事件）或 result（逐条执行结果）");
    }
    if (t.kind === "event" && (typeof t.eventId !== "string" || !t.eventId)) {
      return fail("invalid_target", "事件引用缺少 eventId");
    }
    if (t.kind === "result" &&
        (typeof t.executionId !== "string" || !t.executionId ||
         typeof t.annotationId !== "string" || !t.annotationId)) {
      return fail("invalid_target", "逐条结果引用缺少 executionId 或 annotationId");
    }
    var found = findTarget(content, t);
    if (!found) {
      return fail("review_target_not_found",
        "引用的" + (t.kind === "event" ? "事件" : "逐条执行结果") +
        "不在该回放空间的锁定内容内，不能创建复核意见");
    }
    return { ok: true, value: { raw: t, resolved: found, key: targetKey(t) } };
  }

  function validateDueAt(value, nowIso) {
    if (!isISODateString(value)) {
      return fail("invalid_due", "截止时间不是合法 ISO 时间");
    }
    if (nowIso && Date.parse(value) <= Date.parse(nowIso)) {
      return fail("due_in_past", "复核截止时间必须晚于当前时间");
    }
    return { ok: true, value: value };
  }

  // 新建意见校验。nowIso 由调用方注入（保持纯函数、可测）。
  function validateCreate(input, content, nowIso) {
    input = input || {};
    var tErr = validateTarget(input, content);
    if (!tErr.ok) return tErr;

    var reviewer = trimmed(input.reviewer);
    if (!reviewer) return fail("missing_reviewer", "必须指定复核人");
    if (reviewer.length > LIMITS.REVIEWER_MAX_CHARS) {
      return fail("reviewer_too_long", "复核人名称最长 " + LIMITS.REVIEWER_MAX_CHARS + " 字符");
    }

    var text = trimmed(input.content);
    if (!text) return fail("missing_content", "复核意见内容不能为空");
    if (text.length > LIMITS.CONTENT_MAX_CHARS) {
      return fail("review_too_large", "复核意见内容最长 " + LIMITS.CONTENT_MAX_CHARS + " 字符");
    }

    var status = input.status === undefined || input.status === null || input.status === ""
      ? "open" : input.status;
    if (MUTABLE_STATUSES.indexOf(status) === -1) {
      return fail("invalid_status",
        "新建意见状态非法（不能直接创建为已关闭）：" + status);
    }

    if (!input.dueAt) return fail("missing_due", "必须指定复核截止时间");
    var dErr = validateDueAt(input.dueAt, nowIso);
    if (!dErr.ok) return dErr;

    return {
      ok: true,
      value: {
        target: tErr.value.raw,
        targetKey: tErr.value.key,
        resolved: tErr.value.resolved,
        reviewer: reviewer,
        content: text,
        status: status,
        dueAt: input.dueAt
      }
    };
  }

  // 修改意见：content / status / dueAt 至少给一项；closed 只能经关闭动作达成
  function validatePatch(patch, nowIso) {
    patch = patch || {};
    var changes = {};
    var has = false;
    if (patch.content !== undefined) {
      var text = trimmed(patch.content);
      if (!text) return fail("missing_content", "复核意见内容不能为空");
      if (text.length > LIMITS.CONTENT_MAX_CHARS) {
        return fail("review_too_large", "复核意见内容最长 " + LIMITS.CONTENT_MAX_CHARS + " 字符");
      }
      changes.content = text;
      has = true;
    }
    if (patch.status !== undefined && patch.status !== null && patch.status !== "") {
      if (MUTABLE_STATUSES.indexOf(patch.status) === -1) {
        return fail("invalid_status", "修改后的状态非法，关闭请使用关闭操作：" + patch.status);
      }
      changes.status = patch.status;
      has = true;
    }
    if (patch.dueAt !== undefined && patch.dueAt !== null && patch.dueAt !== "") {
      var dErr = validateDueAt(patch.dueAt, nowIso);
      if (!dErr.ok) return dErr;
      changes.dueAt = patch.dueAt;
      has = true;
    }
    if (!has) return fail("empty_patch", "没有需要修改的字段（内容/状态/截止时间）");
    return { ok: true, value: changes };
  }

  function validateReassign(input) {
    var reviewer = trimmed(input && input.reviewer);
    if (!reviewer) return fail("missing_reviewer", "转派必须指定新的复核人");
    if (reviewer.length > LIMITS.REVIEWER_MAX_CHARS) {
      return fail("reviewer_too_long", "复核人名称最长 " + LIMITS.REVIEWER_MAX_CHARS + " 字符");
    }
    return { ok: true, value: { reviewer: reviewer } };
  }

  function validateCloseReason(reason) {
    if (reason === undefined || reason === null) return { ok: true, value: null };
    var r = trimmed(reason);
    if (r.length > LIMITS.CLOSE_REASON_MAX_CHARS) {
      return fail("review_too_large",
        "关闭说明最长 " + LIMITS.CLOSE_REASON_MAX_CHARS + " 字符");
    }
    return { ok: true, value: r || null };
  }

  /* ================= 筛选（时间线 / 冲突汇总 / 清单导出共用） ================= */

  // 规范化筛选条件（空串表示不过滤）；同时用于随空间持久化的已保存筛选
  function normalizeFilters(f) {
    f = f || {};
    var out = { status: "", reviewer: "", dueFrom: "", dueTo: "", targetKind: "" };
    if (f.status) {
      if (STATUSES.indexOf(f.status) === -1) {
        return fail("invalid_status", "复核状态筛选非法：" + f.status);
      }
      out.status = f.status;
    }
    if (f.reviewer != null) {
      var rv = String(f.reviewer);
      if (rv.length > LIMITS.FILTER_REVIEWER_MAX_CHARS) {
        return fail("invalid_reviewer", "复核人筛选超长");
      }
      out.reviewer = rv.trim();
    }
    if (f.dueFrom) {
      if (!isISODateString(f.dueFrom)) return fail("invalid_due", "截止时间起始边界非法");
      out.dueFrom = f.dueFrom;
    }
    if (f.dueTo) {
      if (!isISODateString(f.dueTo)) return fail("invalid_due", "截止时间结束边界非法");
      out.dueTo = f.dueTo;
    }
    if (out.dueFrom && out.dueTo &&
        Date.parse(out.dueFrom) > Date.parse(out.dueTo)) {
      return fail("invalid_range", "截止时间筛选的起始晚于结束");
    }
    if (f.targetKind) {
      if (TARGET_KINDS.indexOf(f.targetKind) === -1) {
        return fail("invalid_target", "引用类型筛选非法：" + f.targetKind);
      }
      out.targetKind = f.targetKind;
    }
    return { ok: true, value: out };
  }

  function filterReviews(reviews, opts) {
    var n = normalizeFilters(opts);
    var f = n.ok ? n.value : {};
    return (reviews || []).filter(function (r) {
      if (f.status && r.status !== f.status) return false;
      if (f.reviewer && r.reviewer !== f.reviewer) return false;
      if (f.targetKind && r.target.kind !== f.targetKind) return false;
      if (f.dueFrom && Date.parse(r.dueAt) < Date.parse(f.dueFrom)) return false;
      if (f.dueTo && Date.parse(r.dueAt) > Date.parse(f.dueTo)) return false;
      return true;
    });
  }

  // 一条意见应挂到哪些时间线事件上：
  //   event 意见挂其引用事件；
  //   result 意见挂对应逐条结果事件。线上逐条日志不冗余 executionId，
  //   因此按“同任务 + 同批注 + 逐条结果类事件”锚定（executionId 若存在也
  //   一并比对），任务信息由空间锁定内容解析。
  function resultEvents(content, target) {
    var execution = (content.executions || []).filter(function (ex) {
      return ex.id === target.executionId;
    })[0] || null;
    var taskId = execution ? execution.taskId : null;
    var events = [];
    (content.events || []).forEach(function (ev) {
      if (ev.annotationId !== target.annotationId) return;
      if (ev.executionId && ev.executionId !== target.executionId) return;
      if (taskId && ev.taskId !== taskId) return;
      // 只锚到逐条结果事件（*_item_success/conflict/skipped），
      // 避免误挂到同批注的普通状态事件
      if (ev.action.indexOf("_item_") === -1) return;
      events.push(ev);
    });
    return events;
  }

  function reviewMatchesEvent(content, r, ev) {
    if (r.target.kind === "event") return r.target.eventId === ev.id;
    if (r.target.kind === "result") {
      return resultEvents(content, r.target).some(function (e) { return e.id === ev.id; });
    }
    return false;
  }

  // 为 timelineByTask 的分组结果挂复核标记。timelineByTask 的分组包装是
  // 新建对象，但其 events 直接引用锁定内容里的事件对象——历史内容只读，
  // 因此这里用浅拷贝事件替换分组的 events，绝不就地给锁定事件加字段。
  function attachTimelineReviews(groups, reviews, content) {
    (groups || []).forEach(function (g) {
      g.events = g.events.map(function (ev) {
        var copy = Object.assign({}, ev);
        copy.reviews = (reviews || []).filter(function (r) {
          return reviewMatchesEvent(content, r, ev);
        }).map(reviewMarker);
        return copy;
      });
    });
    return groups;
  }

  // 就地为 conflictSummary 的每条冲突项挂复核标记
  function attachConflictReviews(summary, reviews) {
    if (!summary) return summary;
    (summary.items || []).forEach(function (item) {
      item.reviews = (reviews || []).filter(function (r) {
        return r.target.kind === "result" &&
          r.target.executionId === item.executionId &&
          r.target.annotationId === item.annotationId;
      }).map(reviewMarker);
    });
    return summary;
  }

  // 挂到时间线/冲突项上的轻量标记（详情仍走 /reviews/:id）
  function reviewMarker(r) {
    return {
      id: r.id, version: r.version, status: r.status,
      reviewer: r.reviewer, dueAt: r.dueAt, closedAt: r.closedAt || null
    };
  }

  /* ================= 复核清单（独立导出物，纯只读构建） ================= */

  // 从锁定内容复制引用目标的快照描述（清单独立于回放空间仍可读）
  function describeTarget(content, target) {
    var found = findTarget(content, target);
    if (!found) return null;
    if (found.kind === "event") {
      var e = found.event;
      return {
        kind: "event",
        event: {
          id: e.id, seq: e.seq, taskId: e.taskId, at: e.at, actor: e.actor,
          action: e.action, category: e.category, detail: e.detail || null,
          annotationId: e.annotationId || null,
          decisionId: e.decisionId || null,
          executionId: e.executionId || null,
          snapshotId: e.snapshotId || null
        }
      };
    }
    var r0 = found.result;
    return {
      kind: "result",
      execution: {
        id: found.execution.id, taskId: found.execution.taskId,
        decisionId: found.execution.decisionId || null, at: found.execution.at
      },
      result: {
        annotationId: r0.annotationId, disposition: r0.disposition || null,
        result: r0.result, reason: r0.reason || null,
        paraIndex: r0.paraIndex == null ? null : r0.paraIndex,
        start: r0.start == null ? null : r0.start,
        end: r0.end == null ? null : r0.end,
        at: r0.at || found.execution.at || null
      }
    };
  }

  // 构建独立复核清单。args:
  //   { space: {id,name,packageId,producerId,range,importedAt,importedBy,manifest},
  //     content, reviews, reviewLogs, filters, generatedAt, generatedBy }
  // 纯函数：不修改任何输入；导出失败（调用方落盘/网络原因）天然不影响空间。
  function buildChecklist(args) {
    args = args || {};
    var sp = args.space || {};
    var content = args.content || { events: [], executions: [] };
    var nf = normalizeFilters(args.filters);
    if (!nf.ok) return nf;
    var filters = nf.value;
    var nowIso = args.generatedAt || new Date().toISOString();

    var picked = filterReviews(args.reviews || [], filters)
      .slice()
      .sort(function (a, b) {
        var ta = Date.parse(a.createdAt), tb = Date.parse(b.createdAt);
        if (ta !== tb) return ta - tb;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });

    var logsById = Object.create(null);
    (args.reviewLogs || []).forEach(function (l) {
      if (!logsById[l.reviewId]) logsById[l.reviewId] = [];
      logsById[l.reviewId].push(l);
    });

    var items = picked.map(function (r) {
      var history = (logsById[r.id] || []).slice().sort(function (a, b) {
        var ta = Date.parse(a.at), tb = Date.parse(b.at);
        if (ta !== tb) return ta - tb;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
      return {
        id: r.id,
        version: r.version,
        status: r.status,
        statusLabel: STATUS_LABELS[r.status] || r.status,
        reviewer: r.reviewer,
        dueAt: r.dueAt,
        overdue: r.status !== "closed" && Date.parse(r.dueAt) < Date.parse(nowIso),
        content: r.content,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt || null,
        closedAt: r.closedAt || null,
        closedBy: r.closedBy || null,
        closeReason: r.closeReason || null,
        target: describeTarget(content, r.target),
        history: history
      };
    });

    var m = sp.manifest || {};
    return {
      ok: true,
      value: {
        format: "bidi-replay-review-checklist",
        checklistVersion: 1,
        generatedAt: nowIso,
        generatedBy: args.generatedBy || "负责人",
        space: {
          id: sp.id, name: sp.name || null,
          packageId: sp.packageId, producerId: sp.producerId || null,
          range: sp.range || { from: null, to: null },
          importedAt: sp.importedAt || null,
          importedBy: sp.importedBy || null,
          contentHash: m.contentHash || null,
          chainHead: m.chainHead || null,
          eventCount: m.eventCount == null ? null : m.eventCount
        },
        filters: filters,
        count: items.length,
        reviews: items
      }
    };
  }

  return {
    STATUSES: STATUSES,
    MUTABLE_STATUSES: MUTABLE_STATUSES,
    STATUS_LABELS: STATUS_LABELS,
    TARGET_KINDS: TARGET_KINDS,
    LIMITS: LIMITS,
    isISODateString: isISODateString,
    targetKey: targetKey,
    findTarget: findTarget,
    findDuplicate: findDuplicate,
    validateCreate: validateCreate,
    validatePatch: validatePatch,
    validateReassign: validateReassign,
    validateCloseReason: validateCloseReason,
    normalizeFilters: normalizeFilters,
    filterReviews: filterReviews,
    resultEvents: resultEvents,
    reviewMatchesEvent: reviewMatchesEvent,
    attachTimelineReviews: attachTimelineReviews,
    attachConflictReviews: attachConflictReviews,
    reviewMarker: reviewMarker,
    describeTarget: describeTarget,
    buildChecklist: buildChecklist
  };
});
