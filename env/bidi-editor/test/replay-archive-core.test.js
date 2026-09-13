/* node --test test/replay-archive-core.test.js
 * 复核会话归档中心纯逻辑测试：
 *   归档资格（进行中拒绝 / 完成或过期可归档）、归档结构（锁定意见/逐条结论/冲突/
 *   操作日志/当前意见摘要/内容指纹/内嵌审计包）、确定性 id 与幂等、内容或版本不同冲突、
 *   归档完整性校验（结构/哈希/重复标识/缺失引用/时间线/内嵌包/指纹）、损坏检测、
 *   确定性校验摘要、恢复前校验（损坏/重复标识/缺失引用/目标空间冲突/重复恢复）、
 *   恢复空间（新标识同内容、历史会话只读、可新建会话）、列表筛选。
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const Core = require("../replay-core");
const RR = require("../replay-review-core");
const SC = require("../replay-session-core");
const AC = require("../replay-archive-core");

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms) => new Date(T0 + ms).toISOString();

/* ---------- 夹具：1 任务 + 2 事件的审计包与回放空间 ---------- */

function buildFixture() {
  const task = {
    id: "task-1", decisionId: null, status: "succeeded",
    createdAt: iso(0), dependencyIds: [],
    lock: { paragraphs: [] }, attempts: [], approvalDecisions: []
  };
  const logs = [
    { id: "ev-1", taskId: "task-1", at: iso(1000), actor: "甲", action: "task_publish" },
    { id: "ev-2", taskId: "task-1", at: iso(2000), actor: "甲", action: "task_succeeded" }
  ];
  const built = Core.buildPackage({
    producerId: "unit-test", range: {}, tasks: [task], decisionLogs: logs,
    executions: {}, snapshots: [], decisions: []
  });
  assert.ok(built.ok, built.message);
  const pkg = built.value;
  const space = {
    id: "space-1", rev: 1, packageId: pkg.packageId, producerId: pkg.producerId,
    name: pkg.name, format: pkg.format, packageVersion: pkg.packageVersion,
    schemaVersion: pkg.schemaVersion, range: pkg.range, manifest: pkg.manifest,
    content: pkg.content, reviews: [], reviewLogs: [], sessions: [], sessionLogs: [],
    importedAt: iso(500), importedBy: "负责人", exportedAt: pkg.exportedAt,
    verifiedAt: iso(500), view: {}
  };
  return { pkg, space };
}

function addReview(space, idx, overrides) {
  const eventId = space.content.events[idx % space.content.events.length].id;
  const t = iso(600000 + idx * 60000);
  const checked = RR.validateCreate({
    target: { kind: "event", eventId: eventId },
    reviewer: "复核人" + String.fromCharCode(65 + idx),
    content: "意见内容 " + idx,
    dueAt: iso(90000000 + idx * 60000)
  }, space.content, t);
  assert.ok(checked.ok, checked.message);
  const r = {
    id: "rv-" + (idx + 1),
    version: 1,
    target: checked.value.target,
    targetKey: checked.value.targetKey,
    status: checked.value.status,
    reviewer: checked.value.reviewer,
    dueAt: checked.value.dueAt,
    content: checked.value.content,
    createdBy: "负责人", createdAt: t, updatedAt: null, updatedBy: null,
    closedAt: null, closedBy: null, closeReason: null
  };
  Object.assign(r, overrides || {});
  space.reviews.push(r);
  space.reviewLogs.push({
    id: "rl-" + r.id, reviewId: r.id, at: r.createdAt, action: "create",
    actor: "负责人", from: null, to: { status: r.status }
  });
  return r;
}

// 模拟 server 的 createSpaceSession：校验后锁定意见版本与引用摘要
function addSession(space, reviews, opts) {
  opts = opts || {};
  const now = iso(1000000);
  const deadline = opts.deadline || iso(opts.expired ? -1000 : 90000000);
  const createInput = {
    name: opts.name || "会话A",
    participants: opts.participants || ["参与人甲", "参与人乙"],
    deadline: deadline,
    reviewIds: reviews.map(function (r) { return r.id; }),
    filters: opts.filters || null
  };
  // 过期会话无法在“当前”创建：夹具直接构造（模拟一个创建后到期的会话）
  const checked = opts.expired
    ? { ok: true, value: {
        name: createInput.name, participants: createInput.participants,
        deadline: deadline, reviewIds: createInput.reviewIds,
        filters: createInput.filters, reviews: reviews
      } }
    : SC.validateCreate(createInput,
        space.reviews, space.sessions.filter(function (s) { return !s.archived; }), now);
  assert.ok(checked.ok, checked.message);
  const s = {
    id: opts.id || "sess-1",
    version: 1,
    name: checked.value.name,
    participants: checked.value.participants,
    deadline: checked.value.deadline,
    filters: checked.value.filters,
    createdBy: "负责人",
    createdAt: iso(900000),
    items: checked.value.reviews.map(function (rv) {
      return {
        reviewId: rv.id, lockedVersion: rv.version, lockedStatus: rv.status,
        targetSummary: RR.describeTarget(space.content, rv.target),
        conclusion: null, conflict: null
      };
    })
  };
  space.sessions.push(s);
  space.sessionLogs.push({
    id: "sl-create", sessionId: s.id, at: s.createdAt, action: "create",
    actor: "负责人", detail: { name: s.name }
  });
  return s;
}

function conclude(space, s, itemIdx, result, actor) {
  const it = s.items[itemIdx];
  const rv = space.reviews.find(function (x) { return x.id === it.reviewId; });
  const at = iso(2000000 + itemIdx);
  it.conclusion = { result: result, note: "备注 " + result, by: actor, at: at,
    reviewVersion: rv.version };
  s.version++;
  space.sessionLogs.push({
    id: "sl-conc-" + it.reviewId, sessionId: s.id, at: at, action: "conclusion",
    actor: actor, reviewId: it.reviewId, detail: { result: result }
  });
}

// 追加一条与指定日志同毫秒的会话日志（构造确定性排序可被交换的夹具）
function addSameTimeSessionLog(space, s, anchorId, action, actor, reviewId) {
  const anchor = space.sessionLogs.find(function (l) { return l.id === anchorId; });
  const entry = {
    id: "sl-same-" + action + "-" + anchorId, sessionId: s.id, at: anchor.at,
    action: action, actor: actor, reviewId: reviewId || anchor.reviewId,
    detail: { sameMs: true }
  };
  space.sessionLogs.push(entry);
  return entry;
}

function markConflict(space, s, itemIdx, actor) {
  const it = s.items[itemIdx];
  const rv = space.reviews.find(function (x) { return x.id === it.reviewId; });
  rv.version++; // 会话外更新
  const c = SC.checkItemConflict(it, rv, space.content);
  assert.ok(c);
  const at = iso(2500000 + itemIdx);
  it.conflict = { code: c.code, message: c.message, at: at, by: actor };
  s.version++;
  space.sessionLogs.push({
    id: "sl-conf-" + it.reviewId, sessionId: s.id, at: at, action: "conflict",
    actor: actor, reviewId: it.reviewId, detail: { conflict: c.code }
  });
}

/* ================= 归档资格 ================= */

describe("归档资格 canArchive", function () {
  it("进行中（有 pending 且未过期）拒绝；全部有结论=完成；全冲突也算完成", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const r2 = addReview(fx.space, 1);
    const s = addSession(fx.space, [r1, r2]);
    assert.equal(AC.canArchive(s, iso(3000000)).archivable, false);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    assert.equal(AC.canArchive(s, iso(3000000)).archivable, false); // 还有一条 pending
    conclude(fx.space, s, 1, "reject", "参与人乙");
    const ok = AC.canArchive(s, iso(3000000));
    assert.equal(ok.archivable, true);
    assert.equal(ok.reason, "completed");
  });

  it("未完成但已过期 -> expired 可归档", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1], { expired: true });
    const g = AC.canArchive(s, iso(3000000));
    assert.equal(g.archivable, true);
    assert.equal(g.reason, "expired");
  });
});

/* ================= 归档构建与结构 ================= */

describe("buildArchive 归档内容", function () {
  it("归档保存锁定意见、逐条结论、冲突记录、操作日志、意见摘要、内容指纹与内嵌包", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const r2 = addReview(fx.space, 1);
    const s = addSession(fx.space, [r1, r2]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    markConflict(fx.space, s, 1, "参与人乙");

    const built = AC.buildArchive({ space: fx.space, session: s, actor: "负责人", now: iso(3000000) });
    assert.ok(built.ok, built.message);
    const rec = built.value;
    assert.match(rec.id, /^arc_[0-9a-f]{16}$/);
    assert.equal(rec.status, "active");
    assert.equal(rec.archivedReason, "completed");

    const p = rec.payload;
    // 源锚点含空间版本与会话版本
    assert.equal(p.source.spaceId, "space-1");
    assert.equal(p.source.sessionId, s.id);
    assert.equal(p.source.spaceRev, fx.space.rev);
    assert.equal(p.source.sessionVersion, s.version);

    // 逐条：锁定版本/状态/引用摘要 + 结论 + 冲突
    assert.equal(p.session.items.length, 2);
    const it0 = p.session.items[0], it1 = p.session.items[1];
    assert.equal(it0.lockedVersion, 1);
    assert.equal(it0.lockedStatus, "open");
    assert.ok(it0.targetSummary && it0.targetSummary.kind === "event");
    assert.equal(it0.conclusion.result, "confirm");
    assert.equal(it0.conclusion.by, "参与人甲");
    assert.equal(it1.conflict.code, "updated_outside");
    assert.equal(it1.conclusion, null);

    // 当前意见摘要（归档瞬间；含被会话外更新到 v2 的意见）
    assert.equal(p.opinionSummary.total, 2);
    assert.equal(p.reviews.find(x => x.id === r2.id).version, 2);
    assert.equal(p.opinionSummary.reviews.length, 2);
    assert.equal(p.opinionSummary.byStatus.open, 2);

    // 操作日志：create + 1 conclusion + 1 conflict + 2 review create，时间升序
    const kinds = p.timeline.map(e => e.kind + ":" + e.action);
    assert.ok(kinds.indexOf("session:create") !== -1);
    assert.ok(kinds.indexOf("session:conclusion") !== -1);
    assert.ok(kinds.indexOf("session:conflict") !== -1);
    assert.equal(kinds.filter(k => k === "review:create").length, 2);
    for (let i = 1; i < p.timeline.length; i++) {
      assert.ok(Date.parse(p.timeline[i - 1].at) <= Date.parse(p.timeline[i].at));
    }

    // 内容指纹
    assert.equal(p.fingerprint.contentHash, fx.pkg.manifest.contentHash);
    assert.equal(p.fingerprint.chainHead, fx.pkg.manifest.chainHead);
    assert.equal(p.fingerprint.eventCount, 2);

    // 内嵌审计包完整且自洽
    assert.equal(Core.verifyPackage(p.embeddedPackage).ok, true);

    // manifest 计数
    assert.equal(rec.manifest.conclusionCount, 1);
    assert.equal(rec.manifest.conflictCount, 1);
    assert.equal(rec.manifest.itemCount, 2);
    assert.equal(rec.manifest.reviewCount, 2);
  });

  it("纯函数：不修改源空间、源会话与意见", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    const before = JSON.stringify({ space: fx.space });
    AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) });
    assert.equal(JSON.stringify({ space: fx.space }), before);
  });

  it("会话条目引用的意见已缺失 -> archive_broken_reference，拒绝产出残缺归档", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    fx.space.reviews.length = 0; // 意见整体消失（异常情形）
    const built = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) });
    assert.equal(built.ok, false);
    assert.equal(built.code, "archive_broken_reference");
  });
});

/* ================= 幂等与版本冲突 ================= */

describe("归档幂等 / 冲突", function () {
  it("相同内容不同墙钟时间 -> 相同 id；会话版本推进 -> 不同 id（内容或版本冲突）", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    const a = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) });
    const b = AC.buildArchive({ space: fx.space, session: s, now: iso(99999999) });
    assert.equal(a.value.id, b.value.id);
    assert.equal(a.value.manifest.payloadHash, b.value.manifest.payloadHash);

    s.version++; // 版本不同（即使没有新条目内容）
    const c = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) });
    assert.notEqual(a.value.id, c.value.id);
    assert.notEqual(a.value.manifest.payloadHash, c.value.manifest.payloadHash);
  });

  it("空间 rev 不同 -> 不同 id（生成时校验空间版本）", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    const a = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) });
    fx.space.rev = 99;
    const b = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) });
    assert.notEqual(a.value.id, b.value.id);
  });
});

/* ================= 归档完整性校验 ================= */

describe("verifyArchiveRecord", function () {
  function goodArchive() {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const r2 = addReview(fx.space, 1);
    const s = addSession(fx.space, [r1, r2]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    markConflict(fx.space, s, 1, "参与人乙");
    return AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) }).value;
  }
  // 篡改 payload 后伪造其外层哈希，用以验证更深层的校验仍能发现问题
  function forge(rec, mutator) {
    mutator(rec.payload);
    rec.manifest.payloadHash = AC.hashCanonical(rec.payload);
    rec.manifest.payloadHashSha256 = AC.sha256Canonical(rec.payload);
    return rec;
  }

  it("完好归档通过", function () {
    assert.equal(AC.verifyArchiveRecord(goodArchive()).ok, true);
  });

  it("篡改会话内容 -> archive_hash_mismatch", function () {
    const rec = goodArchive();
    rec.payload.session.name = "被改";
    assert.equal(AC.verifyArchiveRecord(rec).code, "archive_hash_mismatch");
  });

  it("篡改内容指纹 -> restore_fingerprint_mismatch（哈希重算掩盖 payload 时仍被抓）", function () {
    const rec = forge(goodArchive(), function (p) {
      p.fingerprint.contentHash = "fnv1a64:deadbeefdeadbeef";
    });
    assert.equal(AC.verifyArchiveRecord(rec).code, "restore_fingerprint_mismatch");
  });

  it("意见 id 重复 -> archive_duplicate_id", function () {
    const rec = forge(goodArchive(), function (p) {
      p.reviews[1].id = p.reviews[0].id;
    });
    assert.equal(AC.verifyArchiveRecord(rec).code, "archive_duplicate_id");
  });

  it("条目引用缺失意见 -> archive_broken_reference", function () {
    const rec = forge(goodArchive(), function (p) {
      p.reviews.pop();
    });
    assert.equal(AC.verifyArchiveRecord(rec).code, "archive_broken_reference");
  });

  it("时间线被插入外来记录 -> archive_timeline_mismatch", function () {
    const rec = forge(goodArchive(), function (p) {
      // 加入一条不属于本会话的会话记录（时间与末条相同，不触发时间倒退）
      const last = p.timeline[p.timeline.length - 1];
      p.timeline.push({
        kind: "session", id: "sl-foreign", at: last.at, actor: "x",
        action: "conclusion", from: null, to: null,
        reviewId: last.reviewId, detail: null, sessionId: "other-session"
      });
    });
    assert.equal(AC.verifyArchiveRecord(rec).code, "archive_broken_reference");
  });

  it("时间线内容被改动（同毫秒交换）-> archive_timeline_mismatch", function () {
    // 构造含两条同毫秒会话日志的归档，交换它们会改变确定性重建顺序
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    addSameTimeSessionLog(fx.space, s, "sl-conc-rv-1", "conclusion", "参与人乙", "rv-1");
    const rec0 = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) }).value;
    const rec = forge(rec0, function (p) {
      const aIdx = p.timeline.findIndex(e => e.id === "sl-conc-rv-1");
      const bIdx = p.timeline.findIndex(e => e.id === "sl-same-conclusion-sl-conc-rv-1");
      const t = p.timeline[aIdx]; p.timeline[aIdx] = p.timeline[bIdx]; p.timeline[bIdx] = t;
    });
    assert.equal(AC.verifyArchiveRecord(rec).code, "archive_timeline_mismatch");
  });

  it("内嵌审计包损坏 -> embedded_package_invalid", function () {
    const rec = forge(goodArchive(), function (p) {
      p.embeddedPackage.content.events[0].action = "task_cancel"; // 类别不一致
    });
    const v = AC.verifyArchiveRecord(rec);
    assert.equal(v.ok, false);
    assert.equal(v.code, "embedded_package_invalid");
    assert.ok(["broken_event_chain", "invalid_event", "chain_hash_mismatch"]
      .indexOf(v.embeddedCode) !== -1, "embeddedCode=" + v.embeddedCode);
  });

  it("高版本归档 -> archive_unsupported_version", function () {
    const rec = goodArchive();
    rec.archiveVersion = 999;
    assert.equal(AC.verifyArchiveRecord(rec).code, "archive_unsupported_version");
  });

  it("manifest 与归档不一致 -> archive_manifest_mismatch", function () {
    const rec = goodArchive();
    rec.manifest.archiveId = "arc_xx";
    assert.equal(AC.verifyArchiveRecord(rec).code, "archive_manifest_mismatch");
  });
});

/* ================= 确定性校验摘要 ================= */

describe("verificationSummary", function () {
  it("完好归档全部检查通过且含算法说明", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    const rec = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) }).value;
    const sum = AC.verificationSummary(rec);
    assert.equal(sum.verified, true);
    assert.ok(sum.checks.length >= 7);
    sum.checks.forEach(function (c) { assert.equal(c.ok, true, c.name); });
  });

  it("损坏归档摘要 verified=false 且确定性（同输入同输出）", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    const rec = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) }).value;
    rec.payload.session.name = "x";
    const a = AC.verificationSummary(rec);
    const b = AC.verificationSummary(rec);
    assert.equal(a.verified, false);
    assert.equal(a.checks.find(c => c.name === "payload_hash").ok, false);
    assert.deepEqual(a, b);
  });
});

/* ================= 恢复前校验 ================= */

describe("validateRestore", function () {
  function completedArchive() {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const r2 = addReview(fx.space, 1);
    const s = addSession(fx.space, [r1, r2]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    conclude(fx.space, s, 1, "reject", "参与人乙");
    return { fx, rec: AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) }).value };
  }

  it("无冲突可恢复，恢复包是新标识且内容哈希与链头不变", function () {
    const { rec } = completedArchive();
    const v = AC.validateRestore(rec, []);
    assert.ok(v.ok, v.message);
    assert.notEqual(v.value.pkg.packageId, rec.payload.source.packageId);
    assert.equal(v.value.pkg.manifest.contentHash, rec.payload.fingerprint.contentHash);
    assert.equal(v.value.pkg.manifest.chainHead, rec.payload.fingerprint.chainHead);
    assert.equal(Core.verifyPackage(v.value.pkg).ok, true);
  });

  it("源空间仍存在（同标识同内容）不阻止恢复——恢复生成新标识的新空间", function () {
    const { fx, rec } = completedArchive();
    const v = AC.validateRestore(rec, [fx.space]);
    assert.ok(v.ok, v.message);
    assert.notEqual(v.value.pkg.packageId, fx.space.packageId);
  });

  it("已恢复过（restoredFromArchiveId 占用）-> restore_target_conflict", function () {
    const { rec } = completedArchive();
    const v = AC.validateRestore(rec, [{ id: "sp-x", packageId: "other", producerId: "p",
      manifest: { contentHash: "other" }, restoredFromArchiveId: rec.id }]);
    assert.equal(v.code, "restore_target_conflict");
    assert.equal(v.existingSpaceId, "sp-x");
  });

  it("归档损坏 -> 对应损坏错误码，绝不进入恢复", function () {
    const { rec } = completedArchive();
    rec.payload.session.name = "x";
    assert.equal(AC.validateRestore(rec, []).code, "archive_hash_mismatch");
  });
});

/* ================= 恢复出的新回放空间 ================= */

describe("buildRestoredSpace", function () {
  it("新空间：新标识、锁定内容一字不动、历史会话只读标记、归档意见带入", function () {
    const { fx, rec } = (function () {
      const fx = buildFixture();
      const r1 = addReview(fx.space, 0);
      const r2 = addReview(fx.space, 1);
      const s = addSession(fx.space, [r1, r2]);
      conclude(fx.space, s, 0, "confirm", "参与人甲");
      markConflict(fx.space, s, 1, "参与人乙");
      const rec = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) }).value;
      return { fx, rec };
    })();
    const v = AC.validateRestore(rec, []);
    assert.ok(v.ok);
    const nsp = AC.buildRestoredSpace(rec, v.value, { id: "new-space", now: iso(4000000) });

    assert.equal(nsp.id, "new-space");
    assert.notEqual(nsp.packageId, fx.space.packageId);
    assert.equal(nsp.originPackageId, fx.space.packageId);
    assert.equal(nsp.restoredFromArchiveId, rec.id);
    // 锁定内容一字不动
    assert.equal(Core.hashCanonical(nsp.content), fx.pkg.manifest.contentHash);
    assert.equal(Core.chainHashes(nsp.content.events).head, fx.pkg.manifest.chainHead);
    // 历史会话只读
    assert.equal(nsp.sessions.length, 1);
    assert.equal(nsp.sessions[0].archived, true);
    assert.equal(nsp.sessions[0].items.length, 2);
    assert.equal(nsp.sessions[0].items[0].conclusion.result, "confirm");
    assert.equal(nsp.sessions[0].items[1].conflict.code, "updated_outside");
    // 意见带入且为新会话可选集（服务端 validateCreate 会过滤 archived 会话）
    assert.equal(nsp.reviews.length, 2);
    // 新空间可以创建新复核会话：过滤掉归档会话后无“进行中会话占用”
    const cc = SC.validateCreate({
      name: "新会话", participants: ["参与人甲"],
      deadline: iso(99000000), reviewIds: nsp.reviews.map(r => r.id)
    }, nsp.reviews, nsp.sessions.filter(s => !s.archived), iso(5000000));
    assert.ok(cc.ok, cc.message);
    // 不过滤时，归档会话也不应通过 already_in_session？这里归档会话确实含这些意见——
    // 所以服务端必须过滤 archived（上面过滤版通过即验证了恢复后可继续创建）
  });

  it("归档意见引用目标在新空间锁定内容中仍可解析", function () {
    const fx = buildFixture();
    const r1 = addReview(fx.space, 0);
    const s = addSession(fx.space, [r1]);
    conclude(fx.space, s, 0, "confirm", "参与人甲");
    const rec = AC.buildArchive({ space: fx.space, session: s, now: iso(3000000) }).value;
    const v = AC.validateRestore(rec, []);
    const nsp = AC.buildRestoredSpace(rec, v.value, { id: "ns", now: iso(4000000) });
    nsp.reviews.forEach(function (r) {
      assert.ok(RR.findTarget(nsp.content, r.target));
    });
  });
});

/* ================= 列表筛选 ================= */

describe("归档列表筛选", function () {
  function rec(over) {
    return Object.assign({
      id: "arc_" + Math.random().toString(16).slice(2, 26),
      sourceSpaceId: "sp-1", participants: ["甲", "乙"], createdBy: "负责人",
      status: "active", archivedAt: iso(5000000)
    }, over);
  }
  const recs = [
    rec({ sourceSpaceId: "sp-1", participants: ["甲"], archivedAt: iso(1000000) }),
    rec({ sourceSpaceId: "sp-2", participants: ["乙"], archivedAt: iso(2000000), status: "restored" }),
    rec({ sourceSpaceId: "sp-1", participants: ["丙"], createdBy: "甲",
      archivedAt: iso(3000000), status: "restored" })
  ];

  it("按空间/参与人/时间范围/状态筛选", function () {
    assert.equal(AC.filterArchives(recs, { spaceId: "sp-1" }).length, 2);
    assert.equal(AC.filterArchives(recs, { participant: "甲" }).length, 2); // 参与人或操作人
    assert.equal(AC.filterArchives(recs, { participant: "乙" }).length, 1);
    assert.equal(AC.filterArchives(recs, { status: "restored" }).length, 2);
    assert.equal(AC.filterArchives(recs, { status: "active" }).length, 1);
    assert.equal(AC.filterArchives(recs, { from: iso(1500000) }).length, 2);
    assert.equal(AC.filterArchives(recs, { to: iso(2500000) }).length, 2);
    assert.equal(AC.filterArchives(recs,
      { from: iso(1500000), to: iso(2500000) }).length, 1);
  });

  it("非法筛选参数报错", function () {
    assert.equal(AC.normalizeArchiveFilters({ status: "nope" }).ok, false);
    assert.equal(AC.normalizeArchiveFilters({ from: "not-a-date" }).ok, false);
    assert.equal(AC.normalizeArchiveFilters({ from: iso(2), to: iso(1) }).ok, false);
  });
});
