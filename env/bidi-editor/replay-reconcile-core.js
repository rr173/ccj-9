/* replay-reconcile-core.js
 * 回放“归档差异与纠错对账中心”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API
 * （哈希复用 ReplayCore），浏览器以 <script> 引入（window.ReplayReconcileCore），
 * Node 下可直接 require 单测。
 *
 * 对账中心解决什么：
 *   负责人选择两个“已生成的复核会话归档”做确定性差异比较，按六个维度产出可定位
 *   差异项：锁定意见（含会话头信息与当前意见快照）、逐条结论、冲突记录、
 *   操作时间线、空间内容指纹、恢复状态；任一侧归档被篡改、缺失引用或校验摘要
 *   不一致，都明确标出原因，绝不继续合并。交换两个归档的传入顺序，结果完全一致
 *   （两侧按归档 id 确定性归一化为 A/B）。
 *
 *   负责人可从差异结果创建纠错批次：为每条可裁决差异指定 keep_a（保留 A 侧）、
 *   keep_b（采用 B 侧/目标归档）或 manual（人工复核，不自动合并，只打标记）。
 *   批次记录版本、负责人、截止时间、审批人；提交与执行前都重新校验两个归档仍未
 *   被替换（同 id + 同 payloadHash）且差异指纹未变化。
 *
 *   审批通过后合成一个内容寻址、不可变的只读“纠错归档”，并用新的包标识生成一个
 *   新的回放空间（锁定内容取自基线归档，内容指纹与链头不变）。原归档、原空间、
 *   原会话与线上暂停/审批/执行数据全程只读，绝不被改写。
 *
 *   任一差异项缺少引用、审批不足、目标标识冲突或写入失败时整批拒绝（failed），
 *   由服务端留下可查询的操作记录（本模块只做纯计算与校验，不做任何持久化）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./replay-core"),
                           require("./replay-review-core"),
                           require("./replay-session-core"),
                           require("./replay-archive-core"));
  } else {
    root.ReplayReconcileCore = factory(root.ReplayCore,
                                      root.ReplayReviewCore,
                                      root.ReplaySessionCore,
                                      root.ReplayArchiveCore);
  }
})(typeof self !== "undefined" ? self : this, function (Core, RR, SC, AC) {
  "use strict";

  var DIFF_FORMAT = "bidi-replay-reconcile-diff";
  var DIFF_VERSION = 1;
  var CORRECTION_FORMAT = "bidi-replay-review-correction-archive";
  var CORRECTION_VERSION = 1;

  // 六个差异维度（weight 决定差异项的确定性排序）
  var DIFF_TYPES = [
    { type: "locked_opinion", label: "锁定意见", weight: 10 },
    { type: "conclusion", label: "逐条结论", weight: 20 },
    { type: "conflict", label: "冲突记录", weight: 30 },
    { type: "timeline", label: "操作时间线", weight: 40 },
    { type: "fingerprint", label: "空间内容指纹", weight: 50 },
    { type: "restore", label: "恢复状态", weight: 60 }
  ];
  var TYPE_META = (function () {
    var m = Object.create(null);
    DIFF_TYPES.forEach(function (t) { m[t.type] = t; });
    return m;
  })();

  // 仅意见/结论/冲突级差异可裁决；时间线/指纹/恢复为信息性差异
  var RESOLVABLE_TYPES = { locked_opinion: true, conclusion: true, conflict: true };
  var RESOLUTIONS = ["keep_a", "keep_b", "manual"];
  var RESOLUTION_LABELS = {
    keep_a: "保留 A 侧归档",
    keep_b: "采用 B 侧归档",
    manual: "人工复核（不自动合并）"
  };

  var BATCH_STATUSES = ["draft", "submitted", "approved", "rejected", "failed"];
  var BATCH_STATUS_LABELS = {
    draft: "拟定中", submitted: "待审批", approved: "已通过",
    rejected: "已驳回", failed: "已拒绝（整批失败）"
  };

  var LIMITS = {
    DIFFS_MAX: 500,
    BATCHES_MAX: 500,
    CORRECTIONS_MAX: 500,
    LOGS_MAX: 5000,
    DIFF_ITEMS_MAX: 3000,
    NAME_MAX_CHARS: 100,
    OWNER_MAX_CHARS: 50,
    APPROVER_MAX_CHARS: 50,
    APPROVERS_MAX: 3,
    NOTE_MAX_CHARS: 2000
  };

  // 当前意见快照逐字段比较的字段清单（值为中文标签）
  var OPINION_FIELDS = {
    version: "意见版本",
    status: "意见状态",
    reviewer: "复核人",
    dueAt: "意见截止时间",
    content: "意见内容",
    updatedAt: "意见更新时间",
    closedAt: "关闭时间",
    closedBy: "关闭人",
    closeReason: "关闭原因"
  };
  var CONCLUSION_FIELDS = {
    result: "结论",
    note: "结论备注",
    by: "提交人",
    at: "提交时间",
    reviewVersion: "结论基于的意见版本"
  };
  var CONFLICT_FIELDS = {
    code: "冲突原因",
    message: "冲突说明",
    at: "标记时间",
    by: "标记人"
  };
  var FINGERPRINT_FIELDS = {
    packageId: "审计包标识",
    producerId: "生产者标识",
    contentHash: "锁定内容哈希（FNV-1a64）",
    contentHashSha256: "锁定内容 SHA-256",
    chainHead: "事件链头哈希",
    chainHeadId: "事件链头事件 id",
    eventCount: "事件数",
    "source.spaceRev": "归档时空间版本",
    "source.sessionVersion": "归档时会话版本"
  };

  function fail(code, message, extra) {
    var f = { ok: false, code: code, message: message };
    if (extra) { for (var k in extra) { f[k] = extra[k]; } }
    return f;
  }

  function trimmed(v) { return typeof v === "string" ? v.trim() : ""; }
  function stableStringify(value) { return Core.stableStringify(value); }
  function hashCanonical(value) { return Core.hashCanonical(value); }
  function sha256Canonical(value) { return Core.sha256Canonical(value); }
  function hashHex(value) { return hashCanonical(value).replace(/^fnv1a64:/, ""); }
  function isISODateString(s) { return Core.isISODateString(s); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function sortedUnique(arr) {
    var seen = Object.create(null), out = [];
    (arr || []).forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out.sort();
  }

  /* ================= 归档侧归一化 ================= */

  // 差异比较与批次处理都只接受“归档中心记录”形状（rec.payload 为归档载荷）
  function archiveSide(rec) {
    var p = rec && rec.payload;
    return {
      archiveId: rec.id,
      status: rec.status,
      restoredSpaceId: rec.restoredSpaceId || null,
      restoredAt: rec.restoredAt || null,
      restoredBy: rec.restoredBy || null,
      payloadHash: rec.manifest && rec.manifest.payloadHash,
      sourceSpaceId: rec.sourceSpaceId,
      sourceSessionId: rec.sourceSessionId,
      source: p ? p.source : null,
      session: p ? p.session : null,
      items: p && p.session ? p.session.items : [],
      reviews: p ? p.reviews : [],
      timeline: p ? p.timeline : [],
      fingerprint: p ? p.fingerprint : null
    };
  }

  function sideEntry(present, value) {
    return { present: !!present, value: present ? value : null };
  }

  /* ================= 差异项构造 ================= */

  function makeItemId(type, locator) {
    return "dit_" + hashHex({ type: type, locator: locator });
  }

  // items 以数组累积，最后统一排序；locator 必须能定位到会话/意见/时间线条目
  function pushItem(store, type, locator, label, a, b) {
    var meta = TYPE_META[type];
    var item = {
      id: makeItemId(type, locator),
      type: type,
      typeLabel: meta.label,
      label: label || meta.label,
      locator: locator,
      resolvable: !!RESOLVABLE_TYPES[type],
      presence: a.present && b.present ? "both"
        : (a.present ? "a_only" : "b_only"),
      a: a,
      b: b,
      resolution: null // 批次创建时填充 keep_a/keep_b/manual
    };
    // 同一定位键重复推入是实现错误（防御性）
    for (var i = 0; i < store.length; i++) {
      if (store[i].id === item.id) return store[i];
    }
    store.push(item);
    return item;
  }

  function reviewFieldItem(store, type, rid, field, label, va, vb) {
    if (stableStringify(va) === stableStringify(vb)) return;
    pushItem(store, type,
      { reviewId: rid, field: field }, label,
      sideEntry(va !== undefined && va !== null, va === undefined ? null : va),
      sideEntry(vb !== undefined && vb !== null, vb === undefined ? null : vb));
  }

  /* ---------- 维度一：锁定意见（会话头 + 条目锁定三元组 + 当前意见快照） ---------- */

  var SESSION_HEADER_FIELDS = {
    id: "源会话 id",
    version: "会话版本",
    name: "会话名称",
    participants: "参与人",
    deadline: "会话截止时间",
    filters: "创建时筛选条件",
    createdBy: "会话创建人",
    createdAt: "会话创建时间"
  };

  function diffLockedOpinions(store, A, B) {
    var sa = A.session || {}, sb = B.session || {};

    // 会话头信息（locator 落在会话上）
    Object.keys(SESSION_HEADER_FIELDS).forEach(function (f) {
      var va = sa[f], vb = sb[f];
      if (stableStringify(va) !== stableStringify(vb)) {
        pushItem(store, "locked_opinion",
          { sessionId: sa.id || sb.id, field: "session_" + f },
          SESSION_HEADER_FIELDS[f],
          sideEntry(va !== undefined && va !== null, va === undefined ? null : va),
          sideEntry(vb !== undefined && vb !== null, vb === undefined ? null : vb));
      }
    });

    var itemA = Object.create(null), itemB = Object.create(null);
    A.items.forEach(function (it) { itemA[it.reviewId] = it; });
    B.items.forEach(function (it) { itemB[it.reviewId] = it; });
    var rvA = Object.create(null), rvB = Object.create(null);
    A.reviews.forEach(function (r) { rvA[r.id] = r; });
    B.reviews.forEach(function (r) { rvB[r.id] = r; });

    var rids = sortedUnique(A.items.map(function (it) { return it.reviewId; })
      .concat(B.items.map(function (it) { return it.reviewId; })));

    rids.forEach(function (rid) {
      var ia = itemA[rid] || null, ib = itemB[rid] || null;
      var ra = rvA[rid] || null, rb = rvB[rid] || null;

      // 会话条目（锁定意见）的存在性
      if (!ia || !ib) {
        pushItem(store, "locked_opinion",
          { reviewId: rid, field: "item_present" },
          "会话条目（锁定意见）存在性",
          sideEntry(!!ia, ia ? {
            lockedVersion: ia.lockedVersion,
            lockedStatus: ia.lockedStatus,
            targetSummary: ia.targetSummary || null
          } : null),
          sideEntry(!!ib, ib ? {
            lockedVersion: ib.lockedVersion,
            lockedStatus: ib.lockedStatus,
            targetSummary: ib.targetSummary || null
          } : null));
      } else {
        reviewFieldItem(store, "locked_opinion", rid, "lockedVersion",
          "锁定意见版本", ia.lockedVersion, ib.lockedVersion);
        reviewFieldItem(store, "locked_opinion", rid, "lockedStatus",
          "锁定意见状态", ia.lockedStatus, ib.lockedStatus);
        reviewFieldItem(store, "locked_opinion", rid, "targetSummary",
          "锁定引用摘要", ia.targetSummary || null, ib.targetSummary || null);
      }

      // 当前意见快照的存在性与逐字段差异（归档瞬间冻结的当前值）
      if (!ra || !rb) {
        pushItem(store, "locked_opinion",
          { reviewId: rid, field: "opinion_present" },
          "当前意见快照存在性",
          sideEntry(!!ra, ra ? opinionBrief(ra) : null),
          sideEntry(!!rb, rb ? opinionBrief(rb) : null));
      } else {
        Object.keys(OPINION_FIELDS).forEach(function (f) {
          reviewFieldItem(store, "locked_opinion", rid, "opinion_" + f,
            "当前意见·" + OPINION_FIELDS[f], ra[f] === undefined ? null : ra[f],
            rb[f] === undefined ? null : rb[f]);
        });
      }
    });
  }

  function opinionBrief(r) {
    return {
      id: r.id, version: r.version, status: r.status,
      reviewer: r.reviewer, dueAt: r.dueAt
    };
  }

  /* ---------- 维度二/三：逐条结论、冲突记录 ---------- */

  function diffItemParts(store, A, B, kind) {
    var mapA = Object.create(null), mapB = Object.create(null);
    A.items.forEach(function (it) { mapA[it.reviewId] = it; });
    B.items.forEach(function (it) { mapB[it.reviewId] = it; });
    var rids = sortedUnique(A.items.map(function (it) { return it.reviewId; })
      .concat(B.items.map(function (it) { return it.reviewId; })));
    var partName = kind === "conclusion" ? "结论" : "冲突记录";
    var fields = kind === "conclusion" ? CONCLUSION_FIELDS : CONFLICT_FIELDS;

    rids.forEach(function (rid) {
      var pa = (mapA[rid] && mapA[rid][kind]) || null;
      var pb = (mapB[rid] && mapB[rid][kind]) || null;
      if (!pa && !pb) return;
      if (!pa || !pb) {
        pushItem(store, kind,
          { reviewId: rid, field: "present" },
          partName + "存在性",
          sideEntry(!!pa, pa), sideEntry(!!pb, pb));
        return;
      }
      Object.keys(fields).forEach(function (f) {
        var va = pa[f] === undefined ? null : pa[f];
        var vb = pb[f] === undefined ? null : pb[f];
        reviewFieldItem(store, kind, rid, f, partName + "·" + fields[f], va, vb);
      });
    });
  }

  /* ---------- 维度四：操作时间线（按规范化内容做多重集比较，与顺序无关） ---------- */

  // 时间线条目去掉 id 后的规范化形状（id 只是容器，内容才是差异）；
  // 两侧同内容条目可能各有自己的 id，定位器给出两侧的代表 id 列表。
  function timelineShape(e) {
    return {
      kind: e.kind,
      at: e.at,
      actor: e.actor,
      action: e.action,
      from: e.from || null,
      to: e.to || null,
      reviewId: e.reviewId || null,
      sessionId: e.sessionId || null,
      detail: e.detail || null
    };
  }

  // 合并时间线的确定性排序（与归档中心同毫秒规则一致）
  function timelineCompare(a, b) {
    var d = Date.parse(a.at) - Date.parse(b.at);
    if (d) return d;
    if (a.kind !== b.kind) return a.kind === "session" ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  /* 纠错归档时间线自洽重建：条目 id 必须带来源命名空间前缀（1:/2:），
   * 规范化内容不得重复，整体按时间线比较器排序。校验时与存储值做全等比较。 */
  function rebuildMergedTimeline(p) {
    var seen = Object.create(null);
    var out = [];
    (p.timeline || []).forEach(function (e) {
      if (!/^[12]:/.test(e.id)) return;
      var key = stableStringify(timelineShape(e));
      if (seen[key]) return;
      seen[key] = true;
      out.push(clone(e));
    });
    out.sort(timelineCompare);
    return out;
  }

  function diffTimeline(store, A, B) {
    function tally(list) {
      var m = Object.create(null), order = [];
      list.forEach(function (e) {
        var key = stableStringify(timelineShape(e));
        if (!m[key]) { m[key] = { shape: timelineShape(e), count: 0, ids: [] }; order.push(key); }
        m[key].count++;
        m[key].ids.push(e.id);
      });
      return { m: m, order: order };
    }
    var ta = tally(A.timeline), tb = tally(B.timeline);
    var keys = sortedUnique(ta.order.concat(tb.order));
    keys.forEach(function (key, idx) {
      var xa = ta.m[key], xb = tb.m[key];
      var ca = xa ? xa.count : 0, cb = xb ? xb.count : 0;
      if (ca === cb) return;
      var shape = xa ? xa.shape : xb.shape;
      pushItem(store, "timeline",
        { timelineKey: "tl-" + idx, timelineId: (xa ? xa.ids[0] : xb.ids[0]),
          at: shape.at, action: shape.action, reviewId: shape.reviewId },
        "时间线条目·" + shape.kind + "/" + shape.action,
        sideEntry(ca > 0, { count: ca, ids: xa ? xa.ids.slice().sort() : [], entry: shape }),
        sideEntry(cb > 0, { count: cb, ids: xb ? xb.ids.slice().sort() : [], entry: shape }));
    });
  }

  /* ---------- 维度五：空间内容指纹（含归档时版本锚点） ---------- */

  function fingerprintValues(A) {
    var fp = A.fingerprint || {}, src = A.source || {};
    return {
      packageId: fp.packageId === undefined ? null : fp.packageId,
      producerId: fp.producerId === undefined ? null : fp.producerId,
      contentHash: fp.contentHash === undefined ? null : fp.contentHash,
      contentHashSha256: fp.contentHashSha256 === undefined ? null : fp.contentHashSha256,
      chainHead: fp.chainHead === undefined ? null : fp.chainHead,
      chainHeadId: fp.chainHeadId === undefined ? null : fp.chainHeadId,
      eventCount: fp.eventCount === undefined ? null : fp.eventCount,
      "source.spaceRev": src.spaceRev === undefined ? null : src.spaceRev,
      "source.sessionVersion": src.sessionVersion === undefined ? null : src.sessionVersion
    };
  }

  function diffFingerprint(store, A, B) {
    var va = fingerprintValues(A), vb = fingerprintValues(B);
    Object.keys(FINGERPRINT_FIELDS).forEach(function (f) {
      if (stableStringify(va[f]) !== stableStringify(vb[f])) {
        pushItem(store, "fingerprint",
          { field: f }, FINGERPRINT_FIELDS[f],
          sideEntry(true, va[f]), sideEntry(true, vb[f]));
      }
    });
  }

  /* ---------- 维度六：恢复状态 ---------- */

  function diffRestore(store, A, B) {
    var va = { status: A.status, restoredSpaceId: A.restoredSpaceId,
      restoredAt: A.restoredAt, restoredBy: A.restoredBy };
    var vb = { status: B.status, restoredSpaceId: B.restoredSpaceId,
      restoredAt: B.restoredAt, restoredBy: B.restoredBy };
    if (stableStringify(va) !== stableStringify(vb)) {
      pushItem(store, "restore", { field: "restore_status" },
        "归档恢复状态", sideEntry(true, va), sideEntry(true, vb));
    }
  }

  /* ================= 差异项确定性排序 ================= */

  function sortItems(items) {
    return items.slice().sort(function (x, y) {
      var w = TYPE_META[x.type].weight - TYPE_META[y.type].weight;
      if (w) return w;
      var lx = stableStringify(x.locator), ly = stableStringify(y.locator);
      if (lx !== ly) return lx < ly ? -1 : 1;
      return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
    });
  }

  function countsByType(items) {
    var counts = Object.create(null);
    DIFF_TYPES.forEach(function (t) { counts[t.type] = 0; });
    items.forEach(function (it) { counts[it.type]++; });
    return counts;
  }

  /* ================= 差异比较主入口（纯函数，不修改输入） =================
   * args: { a: rec1, b: rec2, actor, now }
   *
   * 1) 两侧先各自跑归档中心完整性校验：篡改/缺失引用/摘要不一致 ->
   *    明确失败原因，绝不继续合并（不产出任何差异项）；
   * 2) 通过后按归档 id 升序归一化为 A/B —— 交换入参顺序结果完全一致。
   */
  function buildDiff(args) {
    args = args || {};
    var r1 = args.a, r2 = args.b;
    if (!r1 || !r2) return fail("archive_not_found", "参与差异比较的两个归档都必须存在");
    if (r1.id === r2.id) {
      return fail("diff_same_archive", "必须选择两个不同的归档进行差异比较");
    }

    // 两侧完整性校验：收集全部失败原因（而不是只报第一个）
    var problems = [];
    [["a", r1], ["b", r2]].forEach(function (pair) {
      var v = AC.verifyArchiveRecord(pair[1]);
      if (!v.ok) {
        problems.push({
          side: pair[0], archiveId: pair[1].id,
          code: v.code, message: v.message,
          errors: v.errors || [], embeddedCode: v.embeddedCode || null
        });
      }
    });
    if (problems.length) {
      return fail("diff_archive_invalid",
        "参与比较的归档未通过完整性校验，已明确标出原因，不继续合并",
        { problems: problems });
    }

    var swap = r1.id > r2.id;
    var recA = swap ? r2 : r1, recB = swap ? r1 : r2;
    var A = archiveSide(recA), B = archiveSide(recB);

    var items = [];
    diffLockedOpinions(items, A, B);
    diffItemParts(items, A, B, "conclusion");
    diffItemParts(items, A, B, "conflict");
    diffTimeline(items, A, B);
    diffFingerprint(items, A, B);
    diffRestore(items, A, B);
    items = sortItems(items);
    if (items.length > LIMITS.DIFF_ITEMS_MAX) {
      return fail("diff_too_large",
        "差异项数量超过上限 " + LIMITS.DIFF_ITEMS_MAX);
    }

    var byType = countsByType(items);
    var resolvable = items.filter(function (it) { return it.resolvable; }).length;
    var contentHashMismatch = items.some(function (it) {
      return it.type === "fingerprint" &&
        (it.locator.field === "contentHash" || it.locator.field === "contentHashSha256");
    });

    // 差异指纹：覆盖两侧归档标识/载荷摘要/恢复状态与全部差异项（含定位器与取值），
    // 不含墙钟时间。归档此后被恢复（状态变化）或内容变化都会使指纹变化。
    var fingerprint = hashCanonical({
      pair: [A.archiveId, B.archiveId],
      sides: [
        { archiveId: A.archiveId, payloadHash: A.payloadHash,
          status: A.status, restoredSpaceId: A.restoredSpaceId },
        { archiveId: B.archiveId, payloadHash: B.payloadHash,
          status: B.status, restoredSpaceId: B.restoredSpaceId }
      ],
      items: items.map(function (it) {
        return { id: it.id, type: it.type, locator: it.locator,
          presence: it.presence, a: it.a, b: it.b };
      })
    });

    var now = args.now || new Date().toISOString();
    var id = "did_" + hashHex({
      kind: DIFF_FORMAT, pair: [A.archiveId, B.archiveId], fingerprint: fingerprint
    });

    return {
      ok: true,
      value: {
        id: id,
        format: DIFF_FORMAT,
        diffVersion: DIFF_VERSION,
        createdAt: now,
        createdBy: trimmed(args.actor) || "负责人",
        a: {
          archiveId: A.archiveId,
          sourceSpaceId: A.sourceSpaceId,
          sourceSessionId: A.sourceSessionId,
          payloadHash: A.payloadHash,
          status: A.status,
          restoredSpaceId: A.restoredSpaceId
        },
        b: {
          archiveId: B.archiveId,
          sourceSpaceId: B.sourceSpaceId,
          sourceSessionId: B.sourceSessionId,
          payloadHash: B.payloadHash,
          status: B.status,
          restoredSpaceId: B.restoredSpaceId
        },
        items: items,
        counts: {
          total: items.length,
          byType: byType,
          resolvable: resolvable,
          contentHashMismatch: contentHashMismatch
        },
        fingerprint: fingerprint,
        status: "ok"
      }
    };
  }

  // 归档损坏时也生成一个确定性的“失败差异”记录（供持久化与查询），不含差异项
  function buildInvalidDiff(args, problems) {
    var r1 = args.a, r2 = args.b;
    var pair = sortedUnique([r1 && r1.id, r2 && r2.id].filter(Boolean));
    var now = args.now || new Date().toISOString();
    var id = "did_invalid_" + hashHex({
      kind: DIFF_FORMAT, pair: pair,
      problems: (problems || []).map(function (p) {
        return { side: p.side, archiveId: p.archiveId, code: p.code };
      })
    });
    return {
      id: id,
      format: DIFF_FORMAT,
      diffVersion: DIFF_VERSION,
      createdAt: now,
      createdBy: trimmed(args.actor) || "负责人",
      a: r1 ? { archiveId: r1.id, status: r1.status || null } : null,
      b: r2 ? { archiveId: r2.id, status: r2.status || null } : null,
      items: [],
      counts: { total: 0, byType: countsByType([]), resolvable: 0,
        contentHashMismatch: false },
      fingerprint: null,
      status: "invalid",
      problems: clone(problems || [])
    };
  }

  /* ================= 纠错批次输入校验 =================
   * input: { diff, name, owner, deadline, approvers:[...], baseArchiveId,
   *          items:[{id, resolution}], note }
   */
  function validateBatchInput(input, nowIso) {
    input = input || {};
    var diff = input.diff;
    if (!diff || diff.format !== DIFF_FORMAT || diff.status !== "ok") {
      return fail("diff_not_found", "必须基于一个有效的差异结果创建纠错批次");
    }

    var name = trimmed(input.name);
    if (!name) return fail("missing_name", "纠错批次必须填写名称");
    if (name.length > LIMITS.NAME_MAX_CHARS) {
      return fail("name_too_long", "批次名称最长 " + LIMITS.NAME_MAX_CHARS + " 字符");
    }
    var owner = trimmed(input.owner);
    if (!owner) return fail("missing_owner", "纠错批次必须指定负责人");
    if (owner.length > LIMITS.OWNER_MAX_CHARS) {
      return fail("owner_too_long", "负责人名称最长 " + LIMITS.OWNER_MAX_CHARS + " 字符");
    }
    var note = input.note == null ? "" : String(input.note).trim();
    if (note.length > LIMITS.NOTE_MAX_CHARS) {
      return fail("note_too_long", "备注最长 " + LIMITS.NOTE_MAX_CHARS + " 字符");
    }
    if (!input.deadline) return fail("missing_deadline", "纠错批次必须指定截止时间");
    if (!isISODateString(input.deadline)) {
      return fail("invalid_deadline", "截止时间不是合法 ISO 时间");
    }
    if (nowIso && Date.parse(input.deadline) <= Date.parse(nowIso)) {
      return fail("deadline_in_past", "截止时间必须晚于当前时间");
    }

    // 审批人：1~3 名、去重、不能是负责人本人（审批必须独立）
    var raw = Array.isArray(input.approvers) ? input.approvers : [];
    var approvers = [], seen = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var ap = trimmed(raw[i]);
      if (!ap) continue;
      if (ap.length > LIMITS.APPROVER_MAX_CHARS) {
        return fail("approver_too_long",
          "审批人名称最长 " + LIMITS.APPROVER_MAX_CHARS + " 字符");
      }
      if (seen[ap]) return fail("duplicate_approver", "审批人重复：" + ap);
      if (ap === owner) {
        return fail("approver_is_owner", "负责人不能同时担任本批次审批人");
      }
      seen[ap] = true;
      approvers.push(ap);
    }
    if (!approvers.length) return fail("missing_approver", "必须指定至少一名审批人");
    if (approvers.length > LIMITS.APPROVERS_MAX) {
      return fail("too_many_approvers",
        "审批人最多 " + LIMITS.APPROVERS_MAX + " 名");
    }

    // 内容指纹（锁定内容哈希）不同：必须指定以哪个归档的空间内容为基线
    var baseArchiveId = trimmed(input.baseArchiveId);
    if (diff.counts.contentHashMismatch) {
      if (!baseArchiveId) {
        return fail("missing_base_archive",
          "两个归档的回放空间内容指纹不同，必须指定采用哪个归档的锁定内容作为纠错基线");
      }
      if (baseArchiveId !== diff.a.archiveId && baseArchiveId !== diff.b.archiveId) {
        return fail("invalid_base_archive", "基线归档必须是参与差异比较的两个归档之一");
      }
    } else if (baseArchiveId &&
               baseArchiveId !== diff.a.archiveId && baseArchiveId !== diff.b.archiveId) {
      return fail("invalid_base_archive", "基线归档必须是参与差异比较的两个归档之一");
    }

    // 裁决：每条可裁决差异必须且只能得到一个合法取值；不可裁决差异不得裁决
    var itemsById = Object.create(null);
    diff.items.forEach(function (it) { itemsById[it.id] = it; });
    var resolutions = Object.create(null);
    var list = Array.isArray(input.items) ? input.items : [];
    for (var j = 0; j < list.length; j++) {
      var row = list[j] || {};
      var id = row.id;
      var res = row.resolution;
      var it = itemsById[id];
      if (!it) return fail("diff_item_not_found",
        "裁决指向的差异项不存在：" + id, { diffItemId: id });
      if (!it.resolvable) {
        return fail("item_not_resolvable",
          "差异项（" + it.typeLabel + "）不能逐条裁决，只能作为信息性差异查看：" + id);
      }
      if (RESOLUTIONS.indexOf(res) === -1) {
        return fail("invalid_resolution",
          "差异项裁决非法（只支持 keep_a/keep_b/manual）：" + id);
      }
      if (resolutions[id]) {
        return fail("duplicate_resolution", "同一差异项被重复裁决：" + id);
      }
      resolutions[id] = res;
    }
    var unresolved = diff.items.filter(function (it) {
      return it.resolvable && !resolutions[it.id];
    }).map(function (it) { return it.id; });
    if (unresolved.length) {
      return fail("unresolved_items",
        "还有 " + unresolved.length + " 条可裁决差异未指定处理方式",
        { unresolved: unresolved.slice(0, 50) });
    }

    var chosen = diff.items
      .filter(function (it) { return it.resolvable; })
      .map(function (it) {
        return { id: it.id, type: it.type, locator: clone(it.locator),
          resolution: resolutions[it.id] };
      });
    if (!chosen.length) {
      return fail("no_resolvable_items", "该差异结果没有可裁决差异项，不能创建纠错批次");
    }

    return {
      ok: true,
      value: {
        name: name, owner: owner, note: note, deadline: input.deadline,
        approvers: approvers, baseArchiveId: baseArchiveId || null,
        items: chosen
      }
    };
  }

  /* ================= 提交/执行前：归档未被替换且差异指纹未变化 =================
   * recordsById：当前归档中心全部记录（按 id 索引）。
   * 返回重新计算的差异（ok）或明确失败原因。
   */
  function recheckDiff(diff, recordsById) {
    var ra = recordsById[diff.a.archiveId];
    var rb = recordsById[diff.b.archiveId];
    if (!ra || !rb) {
      return fail("diff_archive_replaced",
        "差异比较使用的归档已不存在（可能已被替换），本批次拒绝继续");
    }
    if (ra.manifest.payloadHash !== diff.a.payloadHash ||
        rb.manifest.payloadHash !== diff.b.payloadHash) {
      return fail("diff_archive_replaced",
        "差异比较使用的归档内容已被替换（载荷摘要变化），本批次拒绝继续");
    }
    var problems = [];
    [[ra, "a"], [rb, "b"]].forEach(function (pair) {
      var v = AC.verifyArchiveRecord(pair[0]);
      if (!v.ok) problems.push({ side: pair[1], archiveId: pair[0].id,
        code: v.code, message: v.message, errors: v.errors || [],
        embeddedCode: v.embeddedCode || null });
    });
    if (problems.length) {
      return fail("diff_archive_invalid",
        "归档当前未通过完整性校验，本批次拒绝继续", { problems: problems });
    }
    var fresh = buildDiff({ a: ra, b: rb, now: diff.createdAt, actor: diff.createdBy });
    if (!fresh.ok) return fresh;
    if (fresh.value.fingerprint !== diff.fingerprint) {
      return fail("diff_fingerprint_changed",
        "差异指纹与创建批次时不同（归档恢复状态或内容已变化），本批次拒绝继续；" +
        "请重新比较后创建批次",
        { previousFingerprint: diff.fingerprint,
          currentFingerprint: fresh.value.fingerprint });
    }
    return fresh;
  }

  /* ================= 纠错合成：合并意见 / 会话条目 / 时间线 ================= */

  // 按某差异项的裁决选边；manual 回退到基线侧并登记人工标记
  function chooseSide(resolution, baseSide) {
    if (resolution === "keep_a") return "a";
    if (resolution === "keep_b") return "b";
    return baseSide; // manual
  }

  /* buildCorrection(args):
   * { batch, diff, recA, recB, now, actor }
   * 纯函数：产出 { archive: 纠错归档记录(未落盘), package: 新标识审计包, space: 空间骨架数据 }
   * 失败即整批拒绝（缺引用/目标标识冲突），不返回部分结果。
   */
  function buildCorrection(args) {
    args = args || {};
    var batch = args.batch, diff = args.diff;
    var inA = args.recA, inB = args.recB;
    if (!batch || !diff || !inA || !inB) {
      return fail("internal_error", "纠错合成缺少批次、差异或归档输入");
    }
    // 调用方传入的归档顺序可能与差异结果的 A/B 归一化顺序不同；
    // 按 diff 锚定（diff 中 keep_a/keep_b 的 a/b 是归一化后的两侧）。
    var recA = inA.id === diff.a.archiveId ? inA
      : (inB.id === diff.a.archiveId ? inB : null);
    var recB = inB.id === diff.b.archiveId ? inB
      : (inA.id === diff.b.archiveId ? inA : null);
    if (!recA || !recB) {
      return fail("internal_error",
        "纠错合成输入的归档与差异结果不一致（归档已被替换）");
    }

    var A = archiveSide(recA), B = archiveSide(recB);
    var baseId = batch.baseArchiveId ||
      (A.fingerprint.contentHash === B.fingerprint.contentHash ? A.archiveId : null);
    if (!baseId || (baseId !== A.archiveId && baseId !== B.archiveId)) {
      return fail("missing_base_archive", "缺少合法的纠错基线归档");
    }
    var baseSide = baseId === A.archiveId ? "a" : "b";
    var baseRec = baseSide === "a" ? recA : recB;
    var otherRec = baseSide === "a" ? recB : recA;

    var resById = Object.create(null);
    batch.items.forEach(function (r) { resById[r.id] = r; });
    function resOf(type, rid, field) {
      var id = makeItemId(type, { reviewId: rid, field: field });
      return resById[id] ? resById[id].resolution : null;
    }

    var manualFlags = Object.create(null); // reviewId -> {fields:[], parts:[]}
    function flagManual(rid, where, name) {
      if (!manualFlags[rid]) manualFlags[rid] = { fields: [], parts: [] };
      var bucket = where === "part" ? manualFlags[rid].parts : manualFlags[rid].fields;
      if (bucket.indexOf(name) === -1) bucket.push(name);
    }

    /* ---- 合并当前意见集合（union；同 id 不同 targetKey = 目标标识冲突） ---- */
    var rvA = Object.create(null), rvB = Object.create(null);
    A.reviews.forEach(function (r) { rvA[r.id] = r; });
    B.reviews.forEach(function (r) { rvB[r.id] = r; });
    var rids = sortedUnique(A.reviews.map(function (r) { return r.id; })
      .concat(B.reviews.map(function (r) { return r.id; })));

    var reviews = [];
    var targetConflict = null;
    for (var ri = 0; ri < rids.length && !targetConflict; ri++) {
      var rid = rids[ri];
      var ra = rvA[rid] || null, rb = rvB[rid] || null;
      var presentRes = resOf("locked_opinion", rid, "opinion_present");

      if (!ra || !rb) {
        // 存在性差异：默认采用存在侧；keep 另一侧表示剔除该意见；manual 保留+标记
        var presentSide = ra ? "a" : "b";
        var presentRec = ra || rb;
        if (presentRes === "keep_a" || presentRes === "keep_b") {
          var keepSide = presentRes === "keep_a" ? "a" : "b";
          if (keepSide === presentSide) {
            reviews.push(clone(presentRec));
          } // 另一侧：剔除
        } else {
          if (presentRes === "manual") flagManual(rid, "field", "opinion_present");
          reviews.push(clone(presentRec));
        }
        continue;
      }

      // 两侧都有：targetKey 必须一致，否则同一意见标识指向不同目标——整批拒绝
      if (RR.targetKey(ra.target) !== RR.targetKey(rb.target)) {
        targetConflict = fail("correction_target_conflict",
          "意见 " + rid + " 在两个归档中指向不同的引用目标（目标标识冲突），整批拒绝",
          { reviewId: rid, aTargetKey: RR.targetKey(ra.target),
            bTargetKey: RR.targetKey(rb.target) });
        continue;
      }

      var fieldSides = Object.create(null);
      var anyDiff = false;
      Object.keys(OPINION_FIELDS).forEach(function (f) {
        var res = resOf("locked_opinion", rid, "opinion_" + f);
        if (res) {
          anyDiff = true;
          if (res === "manual") { flagManual(rid, "field", f); fieldSides[f] = baseSide; }
          else fieldSides[f] = chooseSide(res, baseSide);
        }
      });
      if (!anyDiff) { reviews.push(clone(ra)); continue; }

      var base = baseSide === "a" ? ra : rb;
      var merged = clone(base);
      Object.keys(OPINION_FIELDS).forEach(function (f) {
        var side = fieldSides[f] || baseSide;
        var src = side === "a" ? ra : rb;
        if (src[f] !== undefined) merged[f] = clone(src[f]);
      });
      // target 两侧同 key；具体形状取基线侧（基线锁定内容可解析它）
      merged.target = clone(base.target);
      merged.targetKey = base.targetKey;
      reviews.push(merged);
    }
    if (targetConflict) return targetConflict;

    /* ---- 合并会话条目（锁定三元组 / 结论 / 冲突，逐项按裁决合成） ---- */
    var itemA = Object.create(null), itemB = Object.create(null);
    A.items.forEach(function (it) { itemA[it.reviewId] = it; });
    B.items.forEach(function (it) { itemB[it.reviewId] = it; });
    var itemRids = sortedUnique(A.items.map(function (it) { return it.reviewId; })
      .concat(B.items.map(function (it) { return it.reviewId; })));

    var mergedItems = [];
    itemRids.forEach(function (rid) {
      var ia = itemA[rid] || null, ib = itemB[rid] || null;
      var itemPresence = resOf("locked_opinion", rid, "item_present");

      if (!ia || !ib) {
        var presentSide = ia ? "a" : "b";
        var present = ia || ib;
        if (itemPresence === "keep_a" || itemPresence === "keep_b") {
          var keepSide = itemPresence === "keep_a" ? "a" : "b";
          if (keepSide !== presentSide) return; // 整条剔除
        } else if (itemPresence === "manual") {
          flagManual(rid, "field", "item_present");
        }
        mergedItems.push(cloneItem(present));
        return;
      }

      var out = { reviewId: rid, lockedVersion: null, lockedStatus: null,
        targetSummary: null, conclusion: null, conflict: null };

      // 锁定三元组：逐字段选边（未变化字段取基线侧）
      ["lockedVersion", "lockedStatus", "targetSummary"].forEach(function (f) {
        var res = resOf("locked_opinion", rid, f);
        var side = res ? chooseSide(res, baseSide) : baseSide;
        if (res === "manual") flagManual(rid, "field", f);
        out[f] = clone((side === "a" ? ia : ib)[f]);
      });

      // 结论 / 冲突：存在性 + 逐字段
      ["conclusion", "conflict"].forEach(function (part) {
        var pa = ia[part], pb = ib[part];
        if (!pa && !pb) return;
        var presentField = "present";
        var presRes = (function () {
          var id = makeItemId(part, { reviewId: rid, field: presentField });
          return resById[id] ? resById[id].resolution : null;
        })();
        var chosenPart;
        if (!pa || !pb) {
          var pSide = pa ? "a" : "b";
          if (presRes === "keep_a" || presRes === "keep_b") {
            var kSide = presRes === "keep_a" ? "a" : "b";
            if (kSide !== pSide) return; // 不采用该结论/冲突
            chosenPart = (kSide === "a" ? pa : pb);
          } else {
            if (presRes === "manual") flagManual(rid, "part", part);
            chosenPart = pa || pb;
          }
        } else {
          var fieldMap = part === "conclusion" ? CONCLUSION_FIELDS : CONFLICT_FIELDS;
          var baseP = baseSide === "a" ? pa : pb;
          chosenPart = clone(baseP);
          Object.keys(fieldMap).forEach(function (f) {
            var res = resOf(part, rid, f);
            if (!res) { chosenPart[f] = clone(baseP[f]); return; }
            if (res === "manual") {
              flagManual(rid, "part", part + "." + f);
              chosenPart[f] = clone(baseP[f]);
              return;
            }
            var side = chooseSide(res, baseSide);
            chosenPart[f] = clone((side === "a" ? pa : pb)[f]);
          });
        }
        out[part] = chosenPart ? clone(chosenPart) : null;
      });

      mergedItems.push(out);
    });

    // 条目引用的每条意见必须存在于合并意见集合（缺引用 -> 整批拒绝）
    var mergedRvMap = Object.create(null);
    reviews.forEach(function (r) { mergedRvMap[r.id] = r; });
    var missing = null;
    mergedItems.forEach(function (it) {
      if (!mergedRvMap[it.reviewId] && !missing) missing = it.reviewId;
    });
    if (missing) {
      return fail("correction_missing_reference",
        "纠错结果中会话条目引用的意见缺失：" + missing +
        "（条目与意见的存在性裁决不一致），整批拒绝", { reviewId: missing });
    }

    /* ---- 新标识审计包：以基线归档内嵌包为底，锁定内容一字不动 ---- */
    var pkg = clone(baseRec.payload.embeddedPackage);
    var originPackageId = pkg.packageId, originProducerId = pkg.producerId;
    var now0 = args.now || new Date().toISOString();

    /* ---- 时间线：两侧并集，按规范化内容去重，条目 id 按来源归档命名空间化 ----
     * 两个不同源会话都可能产生同 id 日志（如各自的 "sl-create"），直接合并会造成
     * 时间线 id 重复；统一改写为 <归档序号>:<原id>，去重按规范化内容判定。
     */
    var tlSeen = Object.create(null);
    var timeline = [];
    function absorbTimeline(side, sideNo, list) {
      list.forEach(function (e0) {
        var shape = timelineShape(e0);
        var key = stableStringify(shape);
        if (tlSeen[key]) return;
        tlSeen[key] = true;
        var e = clone(e0);
        e.id = sideNo + ":" + e0.id;
        e.sourceSide = side;
        timeline.push(e);
      });
    }
    absorbTimeline("a", "1", A.timeline);
    absorbTimeline("b", "2", B.timeline);
    timeline.sort(timelineCompare);

    // 参与人并集（去重排序，确定性）；会话名/截止等头部取基线侧并加纠错标记
    var participants = sortedUnique(
      (baseRec.payload.session.participants || [])
        .concat(otherRec.payload.session.participants || []));

    var sessionSnapshot = {
      id: "correction-" + baseRec.payload.session.id,
      version: 1,
      name: batch.name,
      participants: participants,
      deadline: batch.deadline,
      filters: baseRec.payload.session.filters || null,
      createdBy: batch.owner,
      createdAt: now0,
      corrected: true,
      baseSessionIds: [A.sourceSessionId, B.sourceSessionId],
      items: mergedItems.map(function (it) {
        var copy = clone(it);
        if (manualFlags[it.reviewId]) {
          copy.manual = {
            fields: manualFlags[it.reviewId].fields.slice().sort(),
            parts: manualFlags[it.reviewId].parts.slice().sort()
          };
        }
        return copy;
      })
    };

    // 当前意见摘要（锚点取时间线末条确定时间，不引入额外墙钟）
    var anchorAt = timeline.length ? timeline[timeline.length - 1].at
      : (baseRec.payload.session.createdAt || now0);
    var opinionSummary = buildOpinionSummaryFallback(reviews, anchorAt);

    var manualCount = mergedItems.filter(function (it) {
      return manualFlags[it.reviewId];
    }).length;
    var concluded = mergedItems.filter(function (it) { return it.conclusion; }).length;
    var conflicted = mergedItems.filter(function (it) {
      return !it.conclusion && it.conflict;
    }).length;
    var progress = {
      total: mergedItems.length,
      concluded: concluded,
      conflicts: conflicted,
      pending: mergedItems.length - concluded - conflicted,
      percent: mergedItems.length
        ? Math.round((concluded / mergedItems.length) * 100) : 0,
      expired: false,
      manual: manualCount
    };

    // 锁定内容来自基线：指纹必须与基线一致（稍后强校验）
    var contentHash = Core.hashCanonical(pkg.content);
    var chain = Core.chainHashes(pkg.content.events);
    var fingerprint = {
      packageId: null, // 新包标识分配后回填
      producerId: pkg.producerId,
      contentHash: contentHash,
      contentHashSha256: Core.sha256Canonical(pkg.content),
      chainHead: chain.head,
      chainHeadId: chain.headId,
      eventCount: pkg.content.events.length
    };
    if (fingerprint.contentHash !== baseRec.payload.fingerprint.contentHash) {
      return fail("restore_fingerprint_mismatch",
        "基线锁定内容指纹在合成后发生变化，拒绝生成纠错归档");
    }

    var resolutions = batch.items.map(function (r) {
      return { diffItemId: r.id, type: r.type, locator: clone(r.locator),
        resolution: r.resolution,
        resolutionLabel: RESOLUTION_LABELS[r.resolution] || r.resolution };
    });

    var payloadBase = {
      format: CORRECTION_FORMAT,
      correctionVersion: CORRECTION_VERSION,
      source: {
        kind: "correction",
        diffId: diff.id,
        batchId: batch.id,
        batchVersion: batch.version,
        owner: batch.owner,
        deadline: batch.deadline,
        approvers: batch.approvers.slice(),
        a: { archiveId: A.archiveId, payloadHash: A.payloadHash,
             sourceSpaceId: A.sourceSpaceId, sourceSessionId: A.sourceSessionId },
        b: { archiveId: B.archiveId, payloadHash: B.payloadHash,
             sourceSpaceId: B.sourceSpaceId, sourceSessionId: B.sourceSessionId },
        baseArchiveId: baseId,
        originPackageId: originPackageId,
        originProducerId: originProducerId
      },
      session: sessionSnapshot,
      reviews: reviews.map(function (r) {
        var copy = clone(r);
        delete copy.statusLabel;
        return copy;
      }),
      timeline: timeline,
      progress: progress,
      opinionSummary: opinionSummary,
      fingerprint: fingerprint,
      resolutions: resolutions
    };

    // 新包标识先由“批次 id + 不含包标识的 payload”确定性导出（崩溃重建也一致），
    // 再作为 fingerprint.packageId 回填进 payload；最后内容寻址得到纠错归档 id。
    // 不依赖墙钟，也不依赖新空间 id，因此同一批次内容重复执行得到同一标识。
    var pkgId = "car_" + hashHex({
      batchId: batch.id, base: payloadBase.fingerprint.contentHash,
      resolutions: resolutions,
      reviews: payloadBase.reviews.map(function (r) { return r.id; })
    });
    pkg.packageId = pkgId;
    fingerprint.packageId = pkgId;
    pkg.createdAt = now0;
    pkg.exportedAt = now0;
    pkg.manifest = Core.buildManifest(pkg);

    // 新包标识不得与任一原归档内嵌包标识相同（目标标识冲突）
    if (pkg.packageId === A.fingerprint.packageId ||
        pkg.packageId === B.fingerprint.packageId) {
      return fail("correction_target_conflict",
        "纠错包标识与原归档包标识冲突，整批拒绝");
    }

    var payload = payloadBase;
    payload.embeddedPackage = pkg;
    var payloadHash = hashCanonical(payload);
    var id = "crc_" + hashHex(payload);

    var manifest = {
      format: CORRECTION_FORMAT,
      correctionVersion: CORRECTION_VERSION,
      correctionId: id,
      diffId: diff.id,
      batchId: batch.id,
      payloadHash: payloadHash,
      payloadHashSha256: sha256Canonical(payload),
      baseArchiveId: baseId,
      sourceArchiveIds: [A.archiveId, B.archiveId],
      packageId: pkg.packageId,
      contentHash: fingerprint.contentHash,
      contentHashSha256: fingerprint.contentHashSha256,
      chainHead: fingerprint.chainHead,
      eventCount: fingerprint.eventCount,
      reviewCount: reviews.length,
      itemCount: mergedItems.length,
      manualCount: manualCount
    };

    var record = {
      id: id,
      format: CORRECTION_FORMAT,
      correctionVersion: CORRECTION_VERSION,
      status: "restored", // 审批通过即同时生成新空间
      createdAt: now0,
      createdBy: args.actor || batch.owner,
      approvedAt: now0,
      approvedBy: args.actor || batch.owner,
      diffId: diff.id,
      batchId: batch.id,
      owner: batch.owner,
      baseArchiveId: baseId,
      sourceArchiveIds: [A.archiveId, B.archiveId],
      anchors: { packageId: pkg.packageId, contentHash: fingerprint.contentHash,
        chainHead: fingerprint.chainHead },
      payload: payload,
      manifest: manifest,
      restoredSpaceId: args.spaceId || null,
      restoredAt: now0,
      restoredBy: args.actor || batch.owner
    };

    var verify = verifyCorrectionRecord(record);
    if (!verify.ok) return verify;

    return {
      ok: true,
      value: {
        record: record,
        package: pkg,
        originPackageId: originPackageId,
        originProducerId: originProducerId,
        merged: {
          reviews: reviews, items: sessionSnapshot.items,
          timeline: timeline, manualFlags: manualFlags
        }
      }
    };
  }

  function cloneItem(it) {
    return {
      reviewId: it.reviewId,
      lockedVersion: it.lockedVersion,
      lockedStatus: it.lockedStatus,
      targetSummary: it.targetSummary ? clone(it.targetSummary) : null,
      conclusion: it.conclusion ? clone(it.conclusion) : null,
      conflict: it.conflict ? clone(it.conflict) : null
    };
  }

  function buildOpinionSummaryFallback(reviews, atIso) {
    var byStatus = Object.create(null);
    RR.STATUSES.forEach(function (s) { byStatus[s] = 0; });
    var overdue = 0;
    reviews.forEach(function (r) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (r.status !== "closed" && Date.parse(r.dueAt) < Date.parse(atIso)) overdue++;
    });
    return {
      at: atIso,
      total: reviews.length,
      byStatus: byStatus,
      overdue: overdue,
      reviews: reviews.map(function (r0) {
        return {
          id: r0.id, version: r0.version, target: r0.target, targetKey: r0.targetKey,
          status: r0.status, statusLabel: RR.STATUS_LABELS[r0.status] || r0.status,
          reviewer: r0.reviewer, dueAt: r0.dueAt, content: r0.content,
          createdBy: r0.createdBy, createdAt: r0.createdAt,
          updatedAt: r0.updatedAt || null, updatedBy: r0.updatedBy || null,
          closedAt: r0.closedAt || null, closedBy: r0.closedBy || null,
          closeReason: r0.closeReason || null
        };
      })
    };
  }

  /* ================= 构造纠错后的新回放空间骨架（服务端分配 id 后落盘） ================= */

  function buildCorrectionSpace(built, batch, opts) {
    opts = opts || {};
    var rec = built.record, pkg = built.package, payload = rec.payload;
    var now = opts.now || rec.createdAt;
    var items = payload.session.items.map(function (it) {
      var copy = cloneItem(it);
      if (it.manual) copy.manual = clone(it.manual);
      return copy;
    });
    return {
      id: opts.id,
      rev: 1,
      packageId: pkg.packageId,
      producerId: pkg.producerId,
      name: opts.name || (batch.name + "（纠错空间）"),
      format: pkg.format,
      packageVersion: pkg.packageVersion,
      schemaVersion: pkg.schemaVersion,
      range: pkg.range,
      manifest: pkg.manifest,
      content: pkg.content, // 锁定历史，一字不动
      reviews: payload.reviews.map(clone),
      reviewLogs: [],
      sessions: [{
        id: payload.session.id,
        version: 1,
        name: payload.session.name,
        participants: payload.session.participants.slice(),
        deadline: payload.session.deadline,
        filters: payload.session.filters || null,
        createdBy: payload.session.createdBy,
        createdAt: payload.session.createdAt,
        archived: true,   // 纠错会话历史只读
        corrected: true,
        correctedFromDiffId: payload.source.diffId,
        correctedFromBatchId: payload.source.batchId,
        items: items
      }],
      sessionLogs: [],
      importedAt: now,
      importedBy: rec.approvedBy,
      exportedAt: pkg.exportedAt,
      verifiedAt: now,
      correctedFromCorrectionId: rec.id,
      correctedFromDiffId: rec.diffId,
      correctedFromBatchId: rec.batchId,
      correctedFromArchiveIds: rec.sourceArchiveIds.slice(),
      originSpaceId: null,
      originPackageId: built.originPackageId,
      originProducerId: built.originProducerId,
      restoredAt: now,
      restoredBy: rec.approvedBy,
      view: { taskId: "", category: "", action: "", annotationId: "" }
    };
  }

  /* ================= 纠错归档完整性校验 ================= */

  function verifyCorrectionRecord(rec) {
    var errors = [];
    function reject(code, message, extra) {
      return fail(code, message, Object.assign({ errors: errors }, extra || {}));
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      return reject("correction_invalid", "纠错归档不是 JSON 对象");
    }
    if (rec.format !== CORRECTION_FORMAT) {
      return reject("correction_invalid", "纠错归档格式标识不匹配：" + rec.format);
    }
    if (!Number.isInteger(rec.correctionVersion) || rec.correctionVersion < 1) {
      return reject("correction_invalid_version", "纠错归档版本号非法");
    }
    if (rec.correctionVersion > CORRECTION_VERSION) {
      return reject("correction_unsupported_version",
        "纠错归档来自更新的版本（" + rec.correctionVersion + "）");
    }
    var p = rec.payload, mf = rec.manifest;
    if (!p || typeof p !== "object") return reject("correction_invalid", "缺少 payload");
    if (!mf || typeof mf !== "object") {
      return reject("correction_manifest_mismatch", "缺少 manifest");
    }
    if (mf.format !== CORRECTION_FORMAT ||
        mf.correctionVersion !== rec.correctionVersion ||
        mf.correctionId !== rec.id ||
        mf.diffId !== rec.diffId || mf.batchId !== rec.batchId) {
      return reject("correction_manifest_mismatch", "manifest 与纠错归档标识不一致");
    }

    // payload 哈希（先 FNV，Node 端再 SHA-256）
    var recomputed = hashCanonical(p);
    if (mf.payloadHash !== recomputed) {
      return reject("correction_hash_mismatch",
        "纠错归档内容哈希不匹配：归档可能已被改动或损坏（期望 " + recomputed + "）");
    }
    if (mf.payloadHashSha256) {
      var expectSha = sha256Canonical(p);
      if (expectSha && mf.payloadHashSha256 !== expectSha) {
        return reject("correction_hash_mismatch", "纠错归档内容 SHA-256 不匹配");
      }
    }

    if (!p.session || !Array.isArray(p.session.items) || !Array.isArray(p.reviews) ||
        !Array.isArray(p.timeline)) {
      return reject("correction_invalid", "纠错归档缺少会话条目/意见/时间线");
    }

    // 重复标识
    var seenRv = Object.create(null);
    p.reviews.forEach(function (r) {
      if (!r || typeof r.id !== "string") { errors.push("存在缺 id 的意见"); return; }
      if (seenRv[r.id]) errors.push("意见 id 重复：" + r.id);
      seenRv[r.id] = true;
    });
    if (errors.length) return reject("correction_duplicate_id", errors[0]);
    var seenIt = Object.create(null);
    p.session.items.forEach(function (it) {
      if (!it || typeof it.reviewId !== "string") {
        errors.push("存在缺 reviewId 的条目"); return;
      }
      if (seenIt[it.reviewId]) errors.push("会话条目重复：" + it.reviewId);
      seenIt[it.reviewId] = true;
    });
    if (errors.length) return reject("correction_duplicate_id", errors[0]);
    var seenLog = Object.create(null), prevMs = null;
    p.timeline.forEach(function (e) {
      if (!e || typeof e.id !== "string") { errors.push("存在缺 id 的时间线条目"); return; }
      if (seenLog[e.id]) errors.push("时间线 id 重复：" + e.id);
      seenLog[e.id] = true;
      if (!isISODateString(e.at)) { errors.push("时间线条目 " + e.id + " 时间非法"); return; }
      var ms = Date.parse(e.at);
      if (prevMs !== null && ms < prevMs) errors.push("纠错时间线时间倒退：" + e.id);
      prevMs = ms;
    });
    if (errors.length) return reject("correction_invalid", errors[0]);

    // 缺失引用：条目 -> 意见；review 时间线 -> 意见；session 时间线只能来自两个源会话
    var srcSessions = Object.create(null);
    if (p.source.a.sourceSessionId) srcSessions[p.source.a.sourceSessionId] = true;
    if (p.source.b.sourceSessionId) srcSessions[p.source.b.sourceSessionId] = true;
    p.session.items.forEach(function (it) {
      if (!seenRv[it.reviewId]) {
        errors.push("会话条目引用的意见不在纠错归档内：" + it.reviewId);
      }
    });
    p.timeline.forEach(function (e) {
      if (e.kind === "review" && e.reviewId && !seenRv[e.reviewId]) {
        errors.push("时间线引用的意见不在纠错归档内：" + e.reviewId);
      }
      if (e.kind === "session" && e.sessionId && !srcSessions[e.sessionId]) {
        errors.push("时间线引用了非来源会话的记录：" + e.sessionId);
      }
    });
    if (errors.length) return reject("correction_broken_reference", errors[0]);

    // 时间线必须与“两侧并集、按内容去重、id 命名空间化、确定性排序”的重建一致
    var rebuilt = rebuildMergedTimeline(p);
    if (stableStringify(rebuilt) !== stableStringify(p.timeline)) {
      return reject("correction_timeline_mismatch",
        "纠错归档时间线与操作记录不一致（顺序或内容被改动）");
    }

    // 内嵌审计包全量校验 + 锁定内容指纹
    var pkg = p.embeddedPackage;
    if (!pkg) return reject("correction_invalid", "缺少内嵌审计包");
    var pkgCheck = Core.verifyPackage(pkg);
    if (!pkgCheck.ok) {
      return reject("embedded_package_invalid",
        "纠错归档内嵌审计包校验失败（" + pkgCheck.code + "）",
        { embeddedCode: pkgCheck.code, errors: pkgCheck.errors || [] });
    }
    if (p.fingerprint.contentHash !== hashCanonical(pkg.content)) {
      return reject("restore_fingerprint_mismatch", "锁定内容指纹与内嵌审计包不一致");
    }
    var chain = Core.chainHashes(pkg.content.events);
    if (p.fingerprint.chainHead !== chain.head) {
      return reject("restore_fingerprint_mismatch", "事件链头哈希不一致");
    }
    if (p.fingerprint.packageId !== pkg.packageId || mf.packageId !== pkg.packageId) {
      return reject("correction_manifest_mismatch", "包标识与 manifest 不一致");
    }
    if (mf.contentHash !== p.fingerprint.contentHash ||
        mf.chainHead !== p.fingerprint.chainHead) {
      return reject("correction_manifest_mismatch", "manifest 冗余锁定指纹不一致");
    }
    if (mf.sourceArchiveIds.indexOf(p.source.baseArchiveId) === -1) {
      return reject("correction_manifest_mismatch", "基线归档不在来源归档列表中");
    }

    // 每条意见的引用目标必须能在锁定内容中解析
    for (var i = 0; i < p.reviews.length; i++) {
      var r = p.reviews[i];
      if (!RR.findTarget(pkg.content, r.target)) {
        return reject("correction_broken_reference",
          "意见 " + r.id + " 的引用目标无法在纠错基线锁定内容中解析，整批拒绝",
          { reviewId: r.id });
      }
    }

    return { ok: true, value: rec };
  }

  /* ================= 恢复/目标冲突校验（审批通过写盘前） ================= */

  // existingSpaces：当前全部回放空间（查新包标识/新空间冲突）
  function validateCorrectionTarget(built, existingSpaces) {
    var own = verifyCorrectionRecord(built.record);
    if (!own.ok) return own;
    var pkgId = built.package.packageId;
    var spaces = existingSpaces || [];
    for (var i = 0; i < spaces.length; i++) {
      var s = spaces[i];
      if (s.correctedFromCorrectionId === built.record.id) {
        return fail("correction_target_conflict",
          "纠错归档 " + built.record.id + " 已生成过回放空间 " + s.id,
          { existingSpaceId: s.id });
      }
      if (s.packageId === pkgId && s.producerId === built.package.producerId) {
        return fail("correction_target_conflict",
          "纠错目标回放空间标识与已有空间冲突：" + s.id,
          { existingSpaceId: s.id });
      }
    }
    return { ok: true, value: built };
  }

  /* ================= 确定性校验摘要 ================= */

  function check(name, label, ok, detail) {
    return { name: name, label: label, ok: !!ok, detail: detail || null };
  }

  function correctionVerificationSummary(rec) {
    var checks = [];
    var p = rec && rec.payload, mf = rec && rec.manifest;
    checks.push(check("format", "纠错归档格式与版本",
      rec && rec.format === CORRECTION_FORMAT &&
      Number.isInteger(rec.correctionVersion) && rec.correctionVersion >= 1 &&
      rec.correctionVersion <= CORRECTION_VERSION));
    checks.push(check("payload_hash", "纠错内容哈希（FNV-1a64）",
      !!(p && mf && mf.payloadHash === hashCanonical(p)),
      mf ? mf.payloadHash : null));
    checks.push(check("payload_sha256", "纠错内容 SHA-256",
      !!(p && mf && mf.payloadHashSha256 &&
         (!sha256Canonical(p) || mf.payloadHashSha256 === sha256Canonical(p))),
      mf ? mf.payloadHashSha256 : null));
    var refsOk = false, uniqueOk = false;
    if (p && Array.isArray(p.reviews) && p.session && Array.isArray(p.session.items)) {
      var ids = Object.create(null);
      p.reviews.forEach(function (r) { ids[r.id] = true; });
      refsOk = p.session.items.every(function (it) { return ids[it.reviewId]; });
      var rvIds = p.reviews.map(function (r) { return r.id; });
      var itIds = p.session.items.map(function (it) { return it.reviewId; });
      var tlIds = Array.isArray(p.timeline) ? p.timeline.map(function (e) { return e.id; }) : [];
      uniqueOk = new Set(rvIds).size === rvIds.length &&
        new Set(itIds).size === itIds.length &&
        new Set(tlIds).size === tlIds.length;
    }
    checks.push(check("references", "引用目标完整（条目→意见→锁定内容）", refsOk));
    checks.push(check("unique_ids", "纠错归档内标识无重复", uniqueOk));
    var fpOk = false, chainOk = false, pkgOk = false;
    if (p && p.embeddedPackage) {
      fpOk = !!(p.fingerprint &&
        p.fingerprint.contentHash === hashCanonical(p.embeddedPackage.content));
      var ch = Core.chainHashes(p.embeddedPackage.content.events);
      chainOk = !!(p.fingerprint && p.fingerprint.chainHead === ch.head);
      pkgOk = Core.verifyPackage(p.embeddedPackage).ok;
    }
    checks.push(check("fingerprint", "基线锁定内容指纹", fpOk,
      p && p.fingerprint ? p.fingerprint.contentHash : null));
    checks.push(check("chain_head", "事件链头哈希", chainOk,
      p && p.fingerprint ? p.fingerprint.chainHead : null));
    checks.push(check("embedded_package", "内嵌审计包全量校验", pkgOk));
    var verified = checks.every(function (c) { return c.ok; });
    return {
      verified: verified,
      algorithm: "fnv1a64(canonical-json) + sha256 + event-chain",
      checks: checks
    };
  }

  /* ================= 对外视图 ================= */

  function publicDiff(diff) {
    return {
      id: diff.id,
      format: diff.format,
      diffVersion: diff.diffVersion,
      createdAt: diff.createdAt,
      createdBy: diff.createdBy,
      status: diff.status,
      a: diff.a, b: diff.b,
      counts: diff.counts,
      fingerprint: diff.fingerprint,
      items: (diff.items || []).map(function (it) {
        return {
          id: it.id, type: it.type, typeLabel: it.typeLabel, label: it.label,
          locator: it.locator, resolvable: it.resolvable, presence: it.presence,
          a: it.a, b: it.b, resolution: it.resolution || null
        };
      }),
      problems: diff.problems || null
    };
  }

  function publicBatch(batch) {
    return {
      id: batch.id,
      version: batch.version,
      name: batch.name,
      owner: batch.owner,
      note: batch.note || "",
      deadline: batch.deadline,
      approvers: (batch.approvers || []).slice(),
      baseArchiveId: batch.baseArchiveId || null,
      status: batch.status,
      statusLabel: BATCH_STATUS_LABELS[batch.status] || batch.status,
      diffId: batch.diffId,
      items: (batch.items || []).map(clone),
      approvals: (batch.approvals || []).map(clone),
      createdAt: batch.createdAt,
      createdBy: batch.createdBy,
      submittedAt: batch.submittedAt || null,
      decidedAt: batch.decidedAt || null,
      decidedBy: batch.decidedBy || null,
      rejectReason: batch.rejectReason || null,
      failureCode: batch.failureCode || null,
      failureMessage: batch.failureMessage || null,
      correctionId: batch.correctionId || null,
      newSpaceId: batch.newSpaceId || null
    };
  }

  function publicCorrection(rec) {
    var mf = rec.manifest || {}, p = rec.payload || {};
    return {
      id: rec.id,
      format: rec.format,
      correctionVersion: rec.correctionVersion,
      status: rec.status,
      createdAt: rec.createdAt,
      createdBy: rec.createdBy,
      approvedAt: rec.approvedAt,
      approvedBy: rec.approvedBy,
      diffId: rec.diffId,
      batchId: rec.batchId,
      owner: rec.owner,
      baseArchiveId: rec.baseArchiveId,
      sourceArchiveIds: (rec.sourceArchiveIds || []).slice(),
      restoredSpaceId: rec.restoredSpaceId,
      anchors: rec.anchors || null,
      manifest: {
        payloadHash: mf.payloadHash || null,
        payloadHashSha256: mf.payloadHashSha256 || null,
        packageId: mf.packageId || null,
        contentHash: mf.contentHash || null,
        chainHead: mf.chainHead || null,
        eventCount: mf.eventCount == null ? null : mf.eventCount,
        reviewCount: mf.reviewCount,
        itemCount: mf.itemCount,
        manualCount: mf.manualCount
      },
      progress: p.progress || null,
      verification: correctionVerificationSummary(rec)
    };
  }

  function publicCorrectionDetail(rec) {
    var pub = publicCorrection(rec);
    var p = rec.payload || {};
    pub.source = p.source || null;
    pub.session = p.session ? {
      id: p.session.id, version: p.session.version, name: p.session.name,
      participants: (p.session.participants || []).slice(),
      deadline: p.session.deadline, filters: p.session.filters || null,
      corrected: true,
      items: (p.session.items || []).map(function (it) {
        return {
          reviewId: it.reviewId, lockedVersion: it.lockedVersion,
          lockedStatus: it.lockedStatus, targetSummary: it.targetSummary || null,
          conclusion: it.conclusion || null, conflict: it.conflict || null,
          manual: it.manual || null
        };
      })
    } : null;
    pub.resolutions = (p.resolutions || []).map(clone);
    pub.opinionSummary = p.opinionSummary || null;
    pub.fingerprint = p.fingerprint || null;
    pub.timeline = p.timeline || [];
    return pub;
  }

  return {
    DIFF_FORMAT: DIFF_FORMAT,
    DIFF_VERSION: DIFF_VERSION,
    CORRECTION_FORMAT: CORRECTION_FORMAT,
    CORRECTION_VERSION: CORRECTION_VERSION,
    DIFF_TYPES: DIFF_TYPES,
    RESOLUTIONS: RESOLUTIONS,
    RESOLUTION_LABELS: RESOLUTION_LABELS,
    BATCH_STATUSES: BATCH_STATUSES,
    BATCH_STATUS_LABELS: BATCH_STATUS_LABELS,
    LIMITS: LIMITS,
    isISODateString: isISODateString,
    stableStringify: stableStringify,
    hashCanonical: hashCanonical,
    sha256Canonical: sha256Canonical,
    makeItemId: makeItemId,
    buildDiff: buildDiff,
    buildInvalidDiff: buildInvalidDiff,
    validateBatchInput: validateBatchInput,
    recheckDiff: recheckDiff,
    buildCorrection: buildCorrection,
    buildCorrectionSpace: buildCorrectionSpace,
    verifyCorrectionRecord: verifyCorrectionRecord,
    validateCorrectionTarget: validateCorrectionTarget,
    correctionVerificationSummary: correctionVerificationSummary,
    publicDiff: publicDiff,
    publicBatch: publicBatch,
    publicCorrection: publicCorrection,
    publicCorrectionDetail: publicCorrectionDetail
  };
});
