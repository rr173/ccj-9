/* replay-archive-core.js
 * 回放空间“复核会话归档中心”的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API
 * （仅通过 ReplayCore 复用哈希工具，Node 端另可用其 sha256），
 * 浏览器以 <script> 引入（window.ReplayArchiveCore），Node 下可直接 require 单测。
 *
 * 归档中心解决什么：
 *   负责人从一个回放空间里选择“已完成或已过期”的复核会话生成不可变归档。
 *   归档同时保存会话的锁定意见（lockedVersion/lockedStatus/targetSummary）、
 *   逐条结论、冲突记录、操作日志（会话日志 + 相关意见的状态变化记录）、
 *   当前意见摘要与回放空间内容指纹（contentHash/chainHead/eventCount），
 *   并内嵌完整审计包，使归档自洽、可脱离源空间恢复。
 *
 * 不变量：
 *   - 归档一经生成不可修改；归档 id 与全部哈希由内容确定性决定；
 *   - 同一会话相同内容重复生成幂等（返回同一归档）；内容或版本不同明确冲突；
 *   - 归档生成只读取源回放空间，绝不修改源空间、源会话与线上四集合；
 *   - 恢复前必须通过完整性、重复标识、缺失引用、锁定内容指纹、目标空间冲突
 *     全部校验，任一失败整次拒绝；恢复出的新空间有独立标识，历史内容只读。
 *
 * 本模块只做纯计算与校验，不做任何持久化。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./replay-core"),
                           require("./replay-review-core"),
                           require("./replay-session-core"));
  } else {
    root.ReplayArchiveCore = factory(root.ReplayCore,
                                     root.ReplayReviewCore,
                                     root.ReplaySessionCore);
  }
})(typeof self !== "undefined" ? self : this, function (Core, RR, SC) {
  "use strict";

  var ARCHIVE_FORMAT = "bidi-replay-review-session-archive";
  var ARCHIVE_VERSION = 1;
  // 恢复时重建的回放包格式（与审计包同格式，仅标识不同，锁定内容不变）
  var RESTORED_PACKAGE_FORMAT = Core.PACKAGE_FORMAT;

  // 归档生命周期：active 可恢复 / restored 已恢复（不可再次恢复）
  var STATUSES = ["active", "restored"];
  var STATUS_LABELS = { active: "可恢复", restored: "已恢复" };

  var LIMITS = {
    ARCHIVES_MAX: 500,
    ARCHIVE_LOGS_MAX: 5000,
    NAME_MAX_CHARS: 200,
    PARTICIPANT_MAX_CHARS: 50
  };

  function fail(code, message, extra) {
    var f = { ok: false, code: code, message: message };
    if (extra) { for (var k in extra) { f[k] = extra[k]; } }
    return f;
  }

  function trimmed(v) { return typeof v === "string" ? v.trim() : ""; }

  function isISODateString(s) { return Core.isISODateString(s); }

  /* ================= 工具：确定性哈希（复用审计包同一算法） ================= */

  function stableStringify(value) { return Core.stableStringify(value); }
  function hashCanonical(value) { return Core.hashCanonical(value); }
  function sha256Canonical(value) { return Core.sha256Canonical(value); }

  function makeArchiveId(payloadHash) {
    // 归档 id 完全由内容决定（fnv1a64 为 16 位十六进制），同内容天然同 id
    return "arc_" + payloadHash.replace(/^fnv1a64:/, "");
  }

  /* ================= 归档资格：仅已完成或已过期的会话 =================
   * 理由优先级 completed > expired：“全部条目已有结论或冲突”由数据决定，
   * 与墙钟无关，保证一个完成的会话在截止前后重复归档得到相同归档（幂等）。
   */
  function canArchive(session, nowIso) {
    if (!session) return { archivable: false, reason: "session_not_found" };
    var expired = SC.isExpired(session, nowIso);
    var p = SC.sessionProgress(session, nowIso);
    if (p.total > 0 && p.pending === 0) {
      // 进度快照里的 expired 也固定为 false（completed 优先），保持内容确定性
      p.expired = false;
      return { archivable: true, reason: "completed", progress: p };
    }
    if (expired) {
      p.expired = true;
      return { archivable: true, reason: "expired", progress: p };
    }
    return {
      archivable: false,
      reason: "session_not_archivable",
      progress: p,
      message: p.total === 0
        ? "会话没有任何条目，不能归档"
        : "会话尚有 " + p.pending + " 条意见既无结论也无冲突标记；" +
          "只有已完成（全部有结论或冲突）或已过期的会话才能归档"
    };
  }

  /* ================= 意见快照与“当前意见摘要” ================= */

  // 单条意见在归档瞬间的完整快照（归档内的意见不随后续变化而变）
  function snapshotReview(r) {
    return {
      id: r.id,
      version: r.version,
      target: r.target,
      targetKey: r.targetKey,
      status: r.status,
      statusLabel: RR.STATUS_LABELS[r.status] || r.status,
      reviewer: r.reviewer,
      dueAt: r.dueAt,
      content: r.content,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt || null,
      updatedBy: r.updatedBy || null,
      closedAt: r.closedAt || null,
      closedBy: r.closedBy || null,
      closeReason: r.closeReason || null
    };
  }

  function buildOpinionSummary(reviews, atIso) {
    var byStatus = Object.create(null);
    RR.STATUSES.forEach(function (s) { byStatus[s] = 0; });
    var overdue = 0;
    reviews.forEach(function (r) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (r.status !== "closed" && Date.parse(r.dueAt) < Date.parse(atIso)) overdue++;
    });
    return {
      // at 是“摘要锚点”而非墙钟：由调用方传入数据内确定性时间，
      // 保证同一内容重复归档得到相同哈希（幂等）
      at: atIso,
      total: reviews.length,
      byStatus: byStatus,
      overdue: overdue,
      reviews: reviews.map(snapshotReview)
    };
  }

  /* ================= 完整时间线（会话日志 + 相关意见记录合并，确定性排序） ================= */

  function timelineEntry(kind, l) {
    // 统一两种日志的形状，kind 标明来源；只拷贝不修改原对象
    var e = {
      kind: kind, // "session" | "review"
      id: l.id,
      at: l.at,
      actor: l.actor,
      action: l.action,
      from: l.from || null,
      to: l.to || null,
      reviewId: l.reviewId || null,
      detail: l.detail || null
    };
    if (kind === "session") e.sessionId = l.sessionId;
    return e;
  }

  function buildTimeline(sessionLogs, reviewLogs, session) {
    var reviewIds = Object.create(null);
    (session.items || []).forEach(function (it) { reviewIds[it.reviewId] = true; });
    var entries = [];
    (sessionLogs || []).forEach(function (l) {
      if (l.sessionId === session.id) entries.push(timelineEntry("session", l));
    });
    (reviewLogs || []).forEach(function (l) {
      // 只纳入与本会话条目相关的意见状态变化记录
      if (reviewIds[l.reviewId]) entries.push(timelineEntry("review", l));
    });
    entries.sort(function (a, b) {
      var d = Date.parse(a.at) - Date.parse(b.at);
      if (d) return d;
      // 同毫秒：先会话自身事件，再按 id，保证确定性
      if (a.kind !== b.kind) return a.kind === "session" ? -1 : 1;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return entries;
  }

  /* ================= 从回放空间构造内嵌审计包（恢复用，内容与源锁定内容一致） ================= */

  // 归档必须自洽：用空间导入时锁定的同一份 content + 锚点重建一个标准审计包，
  // 恢复时对其跑完整 verifyPackage；恢复时再赋予新的包标识（见 makeRestorePackage）。
  function buildEmbeddedPackage(space) {
    var m = space.manifest || {};
    return {
      format: Core.PACKAGE_FORMAT,
      packageVersion: space.packageVersion || Core.PACKAGE_VERSION,
      schemaVersion: space.schemaVersion || Core.SCHEMA_VERSION,
      packageId: space.packageId,
      producerId: space.producerId,
      name: space.name,
      createdAt: space.importedAt || m.createdAt || space.exportedAt || new Date(0).toISOString(),
      createdBy: space.importedBy || "归档中心",
      exportedAt: space.exportedAt || space.importedAt,
      range: space.range || { from: null, to: null },
      content: space.content,
      // 原 manifest（含 contentHash/chainHead）；构建时会重新计算核对
      manifest: m
    };
  }

  /* ================= 构建归档（纯函数，不修改任何输入） =================
   * args: { space, session, actor, now }
   * 前置：调用方已做空间版本（If-Match）校验；这里只校验会话状态与内容自洽。
   */
  function buildArchive(args) {
    args = args || {};
    var sp = args.space;
    var session = args.session;
    if (!sp) return fail("replay_space_not_found", "回放空间不存在，不能生成归档");
    if (!session) return fail("session_not_found", "复核会话不存在，不能生成归档");

    var now = args.now || new Date().toISOString();
    var actor = trimmed(args.actor) || "负责人";
    if (actor.length > LIMITS.NAME_MAX_CHARS) {
      return fail("actor_too_long", "操作人名称超长");
    }

    var gate = canArchive(session, now);
    if (!gate.archivable) {
      return fail(gate.reason || "session_not_archivable",
        gate.message || "会话既未完成也未过期，不能归档",
        { progress: gate.progress || null });
    }

    var reviewsById = Object.create(null);
    (sp.reviews || []).forEach(function (r) { reviewsById[r.id] = r; });

    // 引用目标：每条会话条目对应的意见必须仍在空间内（防御性；锁定内容不可变，
    // 正常情况下恒成立），缺失引用在生成阶段即拒绝，绝不产出残缺归档。
    var items = (session.items || []).map(function (it) {
      var rv = reviewsById[it.reviewId];
      if (!rv) {
        return { missing: it.reviewId };
      }
      return {
        reviewId: it.reviewId,
        // 会话创建瞬间锁定的意见（版本/状态/引用摘要），此后不再变化
        lockedVersion: it.lockedVersion,
        lockedStatus: it.lockedStatus,
        targetSummary: it.targetSummary || null,
        // 逐条结论（确认/驳回/需补证据 + 备注 + 提交人/时间/意见版本）
        conclusion: it.conclusion ? JSON.parse(JSON.stringify(it.conclusion)) : null,
        // 冲突记录（原因/标记人/时间），结论被拒绝覆盖时留下
        conflict: it.conflict ? JSON.parse(JSON.stringify(it.conflict)) : null
      };
    });
    for (var i = 0; i < items.length; i++) {
      if (items[i].missing) {
        return fail("archive_broken_reference",
          "会话条目引用的意见 " + items[i].missing +
          " 已不在源回放空间内，不能生成归档（拒绝产出残缺归档）",
          { reviewId: items[i].missing });
      }
    }

    // 归档涉及的意见全集（即会话条目；每条都必须存在）
    var reviews = (session.items || []).map(function (it) { return reviewsById[it.reviewId]; });

    var sessionSnapshot = {
      id: session.id,
      version: session.version,
      name: session.name,
      participants: (session.participants || []).slice(),
      deadline: session.deadline,
      filters: session.filters || null,
      createdBy: session.createdBy,
      createdAt: session.createdAt,
      items: items
    };

    var timeline = buildTimeline(sp.sessionLogs || [], sp.reviewLogs || [], session);
    // 摘要锚点取数据内最后一个确定时间（时间线末条或会话创建时间），
    // 不引入墙钟——同一内容重复归档的哈希必须一致（幂等）。
    var anchorAt = timeline.length ? timeline[timeline.length - 1].at
      : (session.createdAt || sp.importedAt || now);
    var opinionSummary = buildOpinionSummary(reviews, anchorAt);
    var embedded = buildEmbeddedPackage(sp);
    var mf = sp.manifest || {};

    var fingerprint = {
      // 回放空间“锁定内容”指纹（与导入校验时一致，可独立复核）
      packageId: sp.packageId,
      producerId: sp.producerId,
      contentHash: mf.contentHash || null,
      contentHashSha256: mf.contentHashSha256 || null,
      chainHead: mf.chainHead || null,
      chainHeadId: mf.chainHeadId || null,
      eventCount: mf.eventCount == null ? null : mf.eventCount
    };

    // 注意：payload 不含 manifest/归档 id/状态——这些由 payload 确定性导出
    var payload = {
      format: ARCHIVE_FORMAT,
      archiveVersion: ARCHIVE_VERSION,
      source: {
        spaceId: sp.id,
        spaceName: sp.name || null,
        packageId: sp.packageId,
        producerId: sp.producerId,
        range: sp.range || { from: null, to: null },
        // 生成归档瞬间的空间版本与会话版本（并发/版本冲突判定锚点）
        spaceRev: sp.rev,
        sessionId: session.id,
        sessionVersion: session.version
      },
      archivedReason: gate.reason, // completed | expired
      session: sessionSnapshot,
      reviews: reviews.map(snapshotReview),
      // 完整操作日志（会话 create/conclusion/conflict + 相关意见 create/update/close/reassign）
      timeline: timeline,
      // 进度快照（归档瞬间冻结，不再实时计算）
      progress: gate.progress,
      opinionSummary: opinionSummary,
      fingerprint: fingerprint,
      embeddedPackage: embedded
    };

    var payloadHash = hashCanonical(payload);
    var id = makeArchiveId(payloadHash);
    var conclusionCount = items.filter(function (it) { return !!it.conclusion; }).length;
    var conflictCount = items.filter(function (it) { return !!it.conflict; }).length;

    var manifest = {
      format: ARCHIVE_FORMAT,
      archiveVersion: ARCHIVE_VERSION,
      archiveId: id,
      sourceSpaceId: sp.id,
      sourceSessionId: session.id,
      payloadHash: payloadHash,
      payloadHashSha256: sha256Canonical(payload),
      // 冗余锁定内容指纹，列表/详情无需读全文即可展示与比对
      contentHash: fingerprint.contentHash,
      contentHashSha256: fingerprint.contentHashSha256,
      chainHead: fingerprint.chainHead,
      eventCount: fingerprint.eventCount,
      reviewCount: reviews.length,
      itemCount: items.length,
      conclusionCount: conclusionCount,
      conflictCount: conflictCount,
      createdAt: now,
      createdBy: actor
    };

    var record = {
      id: id,
      format: ARCHIVE_FORMAT,
      archiveVersion: ARCHIVE_VERSION,
      status: "active",
      createdAt: now,
      createdBy: actor,
      archivedAt: now,
      archivedReason: gate.reason,
      sourceSpaceId: sp.id,
      sourceSpaceName: sp.name || null,
      sourceSessionId: session.id,
      sessionName: session.name || null,
      participants: (session.participants || []).slice(),
      deadline: session.deadline,
      anchors: {
        packageId: sp.packageId,
        producerId: sp.producerId,
        contentHash: fingerprint.contentHash,
        chainHead: fingerprint.chainHead
      },
      payload: payload,
      manifest: manifest,
      restoredAt: null,
      restoredSpaceId: null
    };

    return { ok: true, value: record };
  }

  /* ================= 归档完整性校验（打开/预览/恢复共用） =================
   * 逐层：结构 -> manifest 一致 -> payload 哈希 -> 内嵌审计包 -> 引用/重复标识
   * -> 时间线确定性 -> 锁定内容指纹。任一失败返回明确错误码与明细。
   */
  function verifyArchiveRecord(rec) {
    var errors = [];
    function reject(code, message) {
      return fail(code, message, { errors: errors });
    }

    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      return reject("archive_invalid", "归档不是 JSON 对象");
    }
    if (rec.format !== ARCHIVE_FORMAT) {
      return reject("archive_invalid", "归档格式标识不匹配：" + rec.format);
    }
    if (!Number.isInteger(rec.archiveVersion) || rec.archiveVersion < 1) {
      return reject("archive_invalid_version", "归档版本号非法");
    }
    if (rec.archiveVersion > ARCHIVE_VERSION) {
      return reject("archive_unsupported_version",
        "归档来自更新的版本（" + rec.archiveVersion + "），当前服务仅支持到 " +
        ARCHIVE_VERSION);
    }

    var p = rec.payload;
    if (!p || typeof p !== "object") {
      return reject("archive_invalid", "归档缺少 payload");
    }
    var mf = rec.manifest;
    if (!mf || typeof mf !== "object") {
      return reject("archive_manifest_mismatch", "归档缺少 manifest");
    }

    // ---- manifest 与顶层/源锚点一致 ----
    if (mf.format !== ARCHIVE_FORMAT ||
        mf.archiveVersion !== rec.archiveVersion ||
        mf.archiveId !== rec.id ||
        mf.sourceSpaceId !== rec.sourceSpaceId ||
        mf.sourceSessionId !== rec.sourceSessionId) {
      return reject("archive_manifest_mismatch", "归档 manifest 与归档标识不一致");
    }
    if (p.source &&
        (mf.sourceSpaceId !== p.source.spaceId ||
         mf.sourceSessionId !== p.source.sessionId)) {
      return reject("archive_manifest_mismatch", "manifest 与 payload 源锚点不一致");
    }

    // ---- payload 内容哈希（FNV，浏览器可复核；Node 端再比 SHA-256） ----
    var recomputed = hashCanonical(p);
    if (mf.payloadHash !== recomputed) {
      return reject("archive_hash_mismatch",
        "归档内容哈希不匹配：归档可能已被改动或损坏（期望 " + recomputed + "）");
    }
    if (mf.payloadHashSha256) {
      var expectSha = sha256Canonical(p);
      if (expectSha && mf.payloadHashSha256 !== expectSha) {
        return reject("archive_hash_mismatch", "归档内容 SHA-256 哈希不匹配");
      }
    }

    // ---- 基本结构 ----
    if (!p.session || !Array.isArray(p.session.items)) {
      return reject("archive_invalid", "归档缺少会话或会话条目");
    }
    if (!Array.isArray(p.reviews) || !Array.isArray(p.timeline)) {
      return reject("archive_invalid", "归档缺少意见集合或时间线");
    }

    // ---- 重复标识：意见 id / 条目 reviewId / 时间线 id ----
    var seenReview = Object.create(null);
    p.reviews.forEach(function (r) {
      if (!r || typeof r.id !== "string") { errors.push("存在缺 id 的意见条目"); return; }
      if (seenReview[r.id]) errors.push("归档内意见 id 重复：" + r.id);
      seenReview[r.id] = true;
    });
    if (errors.length) return reject("archive_duplicate_id", errors[0]);

    var seenItem = Object.create(null);
    p.session.items.forEach(function (it) {
      if (!it || typeof it.reviewId !== "string") {
        errors.push("存在缺 reviewId 的会话条目"); return;
      }
      if (seenItem[it.reviewId]) {
        errors.push("归档内会话条目重复：" + it.reviewId);
      }
      seenItem[it.reviewId] = true;
    });
    if (errors.length) return reject("archive_duplicate_id", errors[0]);

    var seenLog = Object.create(null);
    var prevAt = null;
    p.timeline.forEach(function (e) {
      if (!e || typeof e.id !== "string") { errors.push("存在缺 id 的时间线条目"); return; }
      if (seenLog[e.id]) errors.push("归档内时间线 id 重复：" + e.id);
      seenLog[e.id] = true;
      if (!isISODateString(e.at)) { errors.push("时间线条目 " + e.id + " 时间非法"); return; }
      var ms = Date.parse(e.at);
      if (prevAt !== null && ms < prevAt) errors.push("归档时间线时间倒退：" + e.id);
      prevAt = ms;
    });
    if (errors.length) return reject("archive_invalid", errors[0]);

    // ---- 缺失引用：每条条目必须能在归档意见集合中解析 ----
    p.session.items.forEach(function (it) {
      if (!seenReview[it.reviewId]) {
        errors.push("会话条目引用的意见不在归档内：" + it.reviewId);
      }
    });
    p.timeline.forEach(function (e) {
      if (e.kind === "review" && e.reviewId && !seenReview[e.reviewId]) {
        errors.push("时间线引用的意见不在归档内：" + e.reviewId);
      }
      if (e.kind === "session" && e.sessionId !== p.session.id) {
        errors.push("时间线引用了其他会话的记录：" + e.sessionId);
      }
    });
    if (errors.length) return reject("archive_broken_reference", errors[0]);

    // ---- 时间线必须可由日志确定性重建（防重排/漏项） ----
    var rebuilt = buildTimeline(
      // 从合并时间线拆回两类日志做重建校验
      p.timeline.filter(function (e) { return e.kind === "session"; }).map(function (e) {
        return { id: e.id, sessionId: e.sessionId, at: e.at, actor: e.actor,
          action: e.action, from: e.from, to: e.to, reviewId: e.reviewId, detail: e.detail };
      }),
      p.timeline.filter(function (e) { return e.kind === "review"; }).map(function (e) {
        return { id: e.id, at: e.at, actor: e.actor, action: e.action,
          from: e.from, to: e.to, reviewId: e.reviewId };
      }),
      p.session
    );
    if (stableStringify(rebuilt) !== stableStringify(p.timeline)) {
      return reject("archive_timeline_mismatch",
        "归档时间线与操作记录不一致（顺序或内容被改动）");
    }

    // ---- 内嵌审计包：跑与导入完全相同的全量校验
    //     （格式/版本/数量上限/事件重复/哈希/事件链/跨任务引用…）
    var pkg = p.embeddedPackage;
    if (!pkg || typeof pkg !== "object") {
      return reject("archive_invalid", "归档缺少内嵌审计包");
    }
    var pkgCheck = Core.verifyPackage(pkg);
    if (!pkgCheck.ok) {
      return fail("embedded_package_invalid",
        "归档内嵌审计包校验失败（" + pkgCheck.code + "）：" + pkgCheck.message,
        { errors: pkgCheck.errors || [], embeddedCode: pkgCheck.code });
    }
    // ---- 锁定内容指纹：内嵌包内容哈希必须与归档指纹一致 ----
    var contentHash = hashCanonical(pkg.content);
    if (p.fingerprint.contentHash !== contentHash) {
      return reject("restore_fingerprint_mismatch",
        "锁定内容指纹与内嵌审计包内容不一致（期望 " + contentHash + "）");
    }
    var chain = Core.chainHashes(pkg.content.events);
    if (p.fingerprint.chainHead !== chain.head) {
      return reject("restore_fingerprint_mismatch", "锁定内容事件链头哈希不一致");
    }
    // manifest 冗余指纹也要一致
    if (mf.contentHash !== p.fingerprint.contentHash ||
        mf.chainHead !== p.fingerprint.chainHead) {
      return reject("archive_manifest_mismatch", "manifest 冗余锁定指纹与 payload 不一致");
    }
    // 内嵌包必须确实来自源空间锚点（包标识即源空间导入时的标识）
    if (pkg.packageId !== p.source.packageId ||
        pkg.producerId !== p.source.producerId) {
      return reject("archive_broken_reference",
        "内嵌审计包标识与归档源锚点不一致");
    }

    return { ok: true, value: rec };
  }

  /* ================= 确定性校验摘要（打开归档即可见） ================= */

  function check(name, label, ok, detail) {
    return { name: name, label: label, ok: !!ok, detail: detail || null };
  }

  // 不抛异常的摘要：结构损坏时尽量给出逐项结果，供前端展示
  function verificationSummary(rec) {
    var checks = [];
    var p = rec && rec.payload;
    var mf = rec && rec.manifest;

    checks.push(check("format", "归档格式与版本",
      rec && rec.format === ARCHIVE_FORMAT &&
      Number.isInteger(rec.archiveVersion) && rec.archiveVersion >= 1 &&
      rec.archiveVersion <= ARCHIVE_VERSION));

    var payloadOk = !!(p && mf && mf.payloadHash === hashCanonical(p));
    checks.push(check("payload_hash", "归档内容哈希（FNV-1a64）", payloadOk,
      mf ? mf.payloadHash : null));

    checks.push(check("payload_sha256", "归档内容 SHA-256",
      !!(p && mf && mf.payloadHashSha256 &&
         (!sha256Canonical(p) || mf.payloadHashSha256 === sha256Canonical(p))),
      mf ? mf.payloadHashSha256 : null));

    var refsOk = false;
    if (p && Array.isArray(p.reviews) && p.session && Array.isArray(p.session.items)) {
      var ids = Object.create(null);
      p.reviews.forEach(function (r) { ids[r.id] = true; });
      refsOk = p.session.items.every(function (it) { return ids[it.reviewId]; });
    }
    checks.push(check("references", "引用目标完整（条目→意见）", refsOk));

    var uniqueOk = false;
    if (p && Array.isArray(p.reviews) && p.session && Array.isArray(p.session.items)) {
      var reviewIds = p.reviews.map(function (r) { return r.id; });
      var itemIds = p.session.items.map(function (it) { return it.reviewId; });
      var logIds = Array.isArray(p.timeline) ? p.timeline.map(function (e) { return e.id; }) : [];
      uniqueOk = new Set(reviewIds).size === reviewIds.length &&
        new Set(itemIds).size === itemIds.length &&
        new Set(logIds).size === logIds.length;
    }
    checks.push(check("unique_ids", "归档内标识无重复", uniqueOk));

    var fpOk = false;
    var fpDetail = null;
    if (p && p.embeddedPackage && p.embeddedPackage.content) {
      fpOk = p.fingerprint &&
        p.fingerprint.contentHash === hashCanonical(p.embeddedPackage.content);
      fpDetail = p.fingerprint ? p.fingerprint.contentHash : null;
    }
    checks.push(check("fingerprint", "回放空间内容指纹", fpOk, fpDetail));

    var chainOk = false;
    if (p && p.embeddedPackage && p.embeddedPackage.content) {
      var ch = Core.chainHashes(p.embeddedPackage.content.events);
      chainOk = !!(p.fingerprint && p.fingerprint.chainHead === ch.head);
    }
    checks.push(check("chain_head", "事件链头哈希", chainOk,
      p && p.fingerprint ? p.fingerprint.chainHead : null));

    var pkgOk = false;
    if (p && p.embeddedPackage) {
      pkgOk = Core.verifyPackage(p.embeddedPackage).ok;
    }
    checks.push(check("embedded_package", "内嵌审计包全量校验", pkgOk));

    var verified = checks.every(function (c) { return c.ok; });
    return {
      verified: verified,
      algorithm: "fnv1a64(canonical-json) + sha256 + event-chain",
      checks: checks
    };
  }

  /* ================= 恢复包（新标识，锁定内容不变） ================= */

  // 恢复到“新的”回放空间：不能沿用源审计包标识（否则与源空间冲突），
  // 但 content 一字不动——重新计算 manifest 后 contentHash/chainHead 完全一致，
  // 归档指纹仍可在新空间上复核。
  function makeRestorePackage(rec, now) {
    var pkg = JSON.parse(JSON.stringify(rec.payload.embeddedPackage));
    var originPackageId = pkg.packageId;
    var originProducerId = pkg.producerId;
    // 新标识：恢复来源（归档 id 已由内容决定）+ 恢复时间，保证唯一且可追溯
    pkg.packageId = "rar_" + rec.id.replace(/^arc_/, "") +
      "_" + Core.hashCanonical(rec.id + "|" + now).replace(/^fnv1a64:/, "").slice(0, 12);
    pkg.createdAt = now;
    pkg.exportedAt = now;
    pkg.manifest = Core.buildManifest(pkg);
    return {
      pkg: pkg,
      originPackageId: originPackageId,
      originProducerId: originProducerId
    };
  }

  /* ================= 恢复前校验（损坏/重复标识/缺失引用/目标空间冲突） =================
   * existingSpaces：当前全部回放空间（查目标冲突）。
   *
   * “目标空间冲突”只针对恢复将要创建的目标：
   *   - 同一归档已恢复过（restoredFromArchiveId 占用）：重复恢复，拒绝；
   *   - 新包标识撞上已有空间（正常不可能，防御性）：拒绝。
   * 不因为“源空间或同内容空间仍存在”而拒绝——恢复的语义就是用新标识生成一份
   * 新的回放空间，锁定内容相同是预期且被内容指纹证明的。
   */
  function validateRestore(rec, existingSpaces) {
    var own = verifyArchiveRecord(rec);
    if (!own.ok) return own;

    var now = new Date().toISOString();
    var made = makeRestorePackage(rec, now);
    var pkg = made.pkg;

    var spaces = existingSpaces || [];
    for (var i = 0; i < spaces.length; i++) {
      var s = spaces[i];
      if (s.restoredFromArchiveId === rec.id) {
        return fail("restore_target_conflict",
          "归档 " + rec.id + " 已恢复为回放空间 " + s.id + "，不能重复恢复",
          { existingSpaceId: s.id });
      }
      if (s.packageId === pkg.packageId && s.producerId === pkg.producerId) {
        return fail("restore_target_conflict",
          "目标回放空间标识与已有空间冲突：" + s.id,
          { existingSpaceId: s.id });
      }
    }

    return {
      ok: true,
      value: {
        pkg: pkg,
        originPackageId: made.originPackageId,
        originProducerId: made.originProducerId
      }
    };
  }

  /* ================= 构造恢复后的新回放空间对象（纯函数） =================
   * 调用方必须先通过 validateRestore，并分配新 id / 落盘。
   * 历史内容（content）只读；归档内的意见与会话以 restored 标记原样带入，
   * 归档会话在新空间中永久只读（不能再提交结论）；新空间内可继续创建新会话。
   */
  function buildRestoredSpace(rec, restorePkg, opts) {
    opts = opts || {};
    var now = opts.now || new Date().toISOString();
    var p = rec.payload;
    var reviews = p.reviews.map(function (r) {
      var copy = JSON.parse(JSON.stringify(r));
      delete copy.statusLabel; // 存储形状与线上一致（标签由展示层推导）
      copy.restoredFromArchive = true;
      return copy;
    });
    var sessions = [{
      // 归档会话：只读的历史会话
      id: p.session.id,
      version: p.session.version,
      name: p.session.name,
      participants: p.session.participants.slice(),
      deadline: p.session.deadline,
      filters: p.session.filters || null,
      createdBy: p.session.createdBy,
      createdAt: p.session.createdAt,
      archived: true,                    // 历史会话只读标记
      restoredFromArchive: true,
      items: p.session.items.map(function (it) {
        return {
          reviewId: it.reviewId,
          lockedVersion: it.lockedVersion,
          lockedStatus: it.lockedStatus,
          targetSummary: it.targetSummary || null,
          conclusion: it.conclusion ? JSON.parse(JSON.stringify(it.conclusion)) : null,
          conflict: it.conflict ? JSON.parse(JSON.stringify(it.conflict)) : null
        };
      })
    }];

    return {
      id: opts.id,
      rev: 1,
      packageId: restorePkg.pkg.packageId,
      producerId: restorePkg.pkg.producerId,
      name: opts.name || (rec.sessionName ? rec.sessionName + "（归档恢复）" : "归档恢复空间"),
      format: restorePkg.pkg.format,
      packageVersion: restorePkg.pkg.packageVersion,
      schemaVersion: restorePkg.pkg.schemaVersion,
      range: restorePkg.pkg.range,
      manifest: restorePkg.pkg.manifest,
      content: restorePkg.pkg.content, // 锁定历史，导入后永不变更
      reviews: reviews,
      reviewLogs: [], // 归档内的逐条状态变化已在归档时间线中；新空间从空记录继续
      sessions: sessions,
      sessionLogs: [],
      importedAt: now,
      importedBy: opts.actor || rec.createdBy,
      exportedAt: restorePkg.pkg.exportedAt,
      verifiedAt: now,
      restoredFromArchiveId: rec.id,
      originSpaceId: p.source.spaceId,
      originPackageId: restorePkg.originPackageId,
      originProducerId: restorePkg.originProducerId,
      restoredAt: now,
      restoredBy: opts.actor || rec.createdBy,
      view: { taskId: "", category: "", action: "", annotationId: "" }
    };
  }

  /* ================= 归档列表筛选（空间 / 参与人 / 时间范围 / 状态） ================= */

  function normalizeArchiveFilters(f) {
    f = f || {};
    var out = { spaceId: "", participant: "", from: "", to: "", status: "" };
    if (f.spaceId != null) out.spaceId = String(f.spaceId).trim();
    if (f.participant != null) {
      out.participant = String(f.participant).trim();
      if (out.participant.length > LIMITS.PARTICIPANT_MAX_CHARS) {
        return fail("invalid_participant", "参与人筛选超长");
      }
    }
    if (f.from) {
      if (!isISODateString(f.from)) return fail("invalid_from", "起始时间不是合法 ISO 时间");
      out.from = f.from;
    }
    if (f.to) {
      if (!isISODateString(f.to)) return fail("invalid_to", "结束时间不是合法 ISO 时间");
      out.to = f.to;
    }
    if (out.from && out.to && Date.parse(out.from) > Date.parse(out.to)) {
      return fail("invalid_range", "起始时间晚于结束时间");
    }
    if (f.status) {
      if (STATUSES.indexOf(f.status) === -1) {
        return fail("invalid_status", "归档状态筛选非法：" + f.status);
      }
      out.status = f.status;
    }
    return { ok: true, value: out };
  }

  function filterArchives(records, opts, nowIso) {
    var n = normalizeArchiveFilters(opts);
    var f = n.ok ? n.value : {};
    return (records || []).filter(function (r) {
      if (f.spaceId && r.sourceSpaceId !== f.spaceId) return false;
      if (f.participant &&
          (r.participants || []).indexOf(f.participant) === -1 &&
          r.createdBy !== f.participant) return false;
      if (f.status && r.status !== f.status) return false;
      if (f.from && Date.parse(r.archivedAt) < Date.parse(f.from)) return false;
      if (f.to && Date.parse(r.archivedAt) > Date.parse(f.to)) return false;
      return true;
    });
  }

  /* ================= 归档对外视图 ================= */

  function publicArchive(rec, nowIso) {
    var p = rec.payload || {};
    var mf = rec.manifest || {};
    var progress = p.progress || null;
    return {
      id: rec.id,
      format: rec.format,
      archiveVersion: rec.archiveVersion,
      status: rec.status,
      statusLabel: STATUS_LABELS[rec.status] || rec.status,
      createdAt: rec.createdAt,
      createdBy: rec.createdBy,
      archivedAt: rec.archivedAt,
      archivedReason: rec.archivedReason || p.archivedReason || null,
      sourceSpaceId: rec.sourceSpaceId,
      sourceSpaceName: rec.sourceSpaceName,
      sourceSessionId: rec.sourceSessionId,
      sessionName: rec.sessionName,
      participants: (rec.participants || []).slice(),
      deadline: rec.deadline,
      anchors: rec.anchors || null,
      manifest: {
        payloadHash: mf.payloadHash || null,
        payloadHashSha256: mf.payloadHashSha256 || null,
        contentHash: mf.contentHash || null,
        chainHead: mf.chainHead || null,
        eventCount: mf.eventCount == null ? null : mf.eventCount,
        reviewCount: mf.reviewCount == null ? null : mf.reviewCount,
        itemCount: mf.itemCount == null ? null : mf.itemCount,
        conclusionCount: mf.conclusionCount == null ? null : mf.conclusionCount,
        conflictCount: mf.conflictCount == null ? null : mf.conflictCount
      },
      progress: progress,
      restoredAt: rec.restoredAt || null,
      restoredSpaceId: rec.restoredSpaceId || null,
      verification: verificationSummary(rec)
    };
  }

  // 归档详情：含完整时间线、进度快照、逐条结论/冲突、当前意见摘要与校验摘要
  function publicArchiveDetail(rec) {
    var pub = publicArchive(rec);
    var p = rec.payload || {};
    pub.source = p.source || null;
    pub.session = p.session ? {
      id: p.session.id,
      version: p.session.version,
      name: p.session.name,
      participants: (p.session.participants || []).slice(),
      deadline: p.session.deadline,
      filters: p.session.filters || null,
      createdBy: p.session.createdBy,
      createdAt: p.session.createdAt,
      items: (p.session.items || []).map(function (it) {
        return {
          reviewId: it.reviewId,
          lockedVersion: it.lockedVersion,
          lockedStatus: it.lockedStatus,
          targetSummary: it.targetSummary || null,
          conclusion: it.conclusion || null,
          conflict: it.conflict || null
        };
      })
    } : null;
    pub.opinionSummary = p.opinionSummary || null;
    pub.fingerprint = p.fingerprint || null;
    pub.timeline = p.timeline || [];
    return pub;
  }

  return {
    ARCHIVE_FORMAT: ARCHIVE_FORMAT,
    ARCHIVE_VERSION: ARCHIVE_VERSION,
    STATUSES: STATUSES,
    STATUS_LABELS: STATUS_LABELS,
    LIMITS: LIMITS,
    isISODateString: isISODateString,
    stableStringify: stableStringify,
    hashCanonical: hashCanonical,
    sha256Canonical: sha256Canonical,
    makeArchiveId: makeArchiveId,
    canArchive: canArchive,
    buildTimeline: buildTimeline,
    buildArchive: buildArchive,
    verifyArchiveRecord: verifyArchiveRecord,
    verificationSummary: verificationSummary,
    makeRestorePackage: makeRestorePackage,
    validateRestore: validateRestore,
    buildRestoredSpace: buildRestoredSpace,
    normalizeArchiveFilters: normalizeArchiveFilters,
    filterArchives: filterArchives,
    publicArchive: publicArchive,
    publicArchiveDetail: publicArchiveDetail
  };
});
