/* node --test test/replay-reconcile-core.test.js
 * 归档差异与纠错对账中心纯逻辑测试：
 *   两侧完整性校验（篡改/缺引用/摘要不一致明确失败不合并）、六维差异项可定位、
 *   交换入参顺序结果一致、差异指纹确定性、纠错批次输入校验（负责人/截止/审批人/
 *   基线归档/逐条裁决）、提交前重校验（归档替换/指纹变化）、纠错合成
 *   （keep_a/keep_b/manual、缺引用整批拒绝、目标标识冲突、新标识同内容指纹、
 *   新空间历史会话只读）、纠错归档完整性校验、目标冲突与列表视图。
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const Core = require("../replay-core");
const RR = require("../replay-review-core");
const SC = require("../replay-session-core");
const AC = require("../replay-archive-core");
const RC = require("../replay-reconcile-core");

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms) => new Date(T0 + ms).toISOString();

function buildPackageFixture(producerId) {
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
    producerId: producerId || "unit-test", range: {}, tasks: [task],
    decisionLogs: logs, executions: {}, snapshots: [], decisions: []
  });
  assert.ok(built.ok, built.message);
  return built.value;
}

function buildSpace(pkg, id) {
  return {
    id: id || "space-1", rev: 1, packageId: pkg.packageId, producerId: pkg.producerId,
    name: pkg.name, format: pkg.format, packageVersion: pkg.packageVersion,
    schemaVersion: pkg.schemaVersion, range: pkg.range, manifest: pkg.manifest,
    content: pkg.content, reviews: [], reviewLogs: [], sessions: [], sessionLogs: [],
    importedAt: iso(500), importedBy: "负责人", exportedAt: pkg.exportedAt,
    verifiedAt: iso(500), view: {}
  };
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

function addSession(space, reviews, opts) {
  opts = opts || {};
  const createInput = {
    name: opts.name || "会话A",
    participants: opts.participants || ["参与人甲", "参与人乙"],
    deadline: opts.deadline || iso(90000000),
    reviewIds: reviews.map(function (r) { return r.id; }),
    filters: opts.filters || null
  };
  const checked = SC.validateCreate(createInput, space.reviews,
    space.sessions.filter(function (s) { return !s.archived; }), iso(1000000));
  assert.ok(checked.ok, checked.message);
  const s = {
    id: opts.id || "sess-1", version: 1, name: checked.value.name,
    participants: checked.value.participants, deadline: checked.value.deadline,
    filters: checked.value.filters, createdBy: "负责人", createdAt: iso(900000),
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

function conclude(space, s, itemIdx, result, actor, note) {
  const it = s.items[itemIdx];
  const rv = space.reviews.find(function (x) { return x.id === it.reviewId; });
  const at = iso(2000000 + itemIdx);
  it.conclusion = { result: result, note: note != null ? note : ("备注 " + result),
    by: actor, at: at, reviewVersion: rv.version };
  s.version++;
  space.sessionLogs.push({
    id: "sl-conc-" + it.reviewId, sessionId: s.id, at: at, action: "conclusion",
    actor: actor, reviewId: it.reviewId, detail: { result: result }
  });
}

function makeArchive(space, session, overrides) {
  const built = AC.buildArchive({
    space: space, session: session, actor: "负责人", now: iso(3000000)
  });
  assert.ok(built.ok, built.message);
  const rec = built.value;
  Object.assign(rec, overrides || {});
  return rec;
}

/* 两份“同锁定内容”的归档：A rv-1 confirm / rv-2 reject；B rv-1 need_evidence / rv-2 reject，
 * 且 rv-2 在 B 中被会话外更新（lockedVersion 不同）。 */
function pairArchives() {
  const fx1 = { pkg: buildPackageFixture("p-1") };
  fx1.space = buildSpace(fx1.pkg, "space-1");
  const a1 = addReview(fx1.space, 0);
  const a2 = addReview(fx1.space, 1);
  const s1 = addSession(fx1.space, [a1, a2], { id: "sess-A", name: "会话甲" });
  conclude(fx1.space, s1, 0, "confirm", "参与人甲");
  conclude(fx1.space, s1, 1, "reject", "参与人乙", "共同备注");
  const arcA = makeArchive(fx1.space, s1);

  // 同一审计包内容复制成另一空间（同 contentHash），意见与结论不同
  const pkg2 = JSON.parse(JSON.stringify(fx1.pkg));
  pkg2.producerId = "p-1"; // 保持同内容；packageId 也会相同（由内容决定）——空间 id 不同即可
  const fx2 = { pkg: pkg2 };
  fx2.space = buildSpace(pkg2, "space-2");
  const b1 = addReview(fx2.space, 0);
  const b2 = addReview(fx2.space, 1);
  b2.version = 2; b2.updatedAt = iso(2600000); b2.updatedBy = "复核人B";
  const s2 = addSession(fx2.space, [b1, b2], { id: "sess-B", name: "会话乙" });
  // 锁定三元组按创建时锁定值；模拟创建于更新之后：
  s2.items[1].lockedVersion = 2;
  conclude(fx2.space, s2, 0, "need_evidence", "参与人甲", "需要补充");
  conclude(fx2.space, s2, 1, "reject", "参与人乙", "共同备注");
  const arcB = makeArchive(fx2.space, s2);

  return { arcA: arcA, arcB: arcB, fx1: fx1, fx2: fx2 };
}

/* ================= 六维差异 ================= */

describe("buildDiff 差异比较", function () {
  it("六个维度都产出可定位差异项；交换入参顺序结果完全一致", function () {
    const { arcA, arcB } = pairArchives();
    const d1 = RC.buildDiff({ a: arcA, b: arcB, now: iso(4000000) });
    const d2 = RC.buildDiff({ a: arcB, b: arcA, now: iso(4000000) });
    assert.ok(d1.ok, d1.message);
    assert.ok(d2.ok, d2.message);
    // A/B 按归档 id 归一化
    assert.equal(d1.value.a.archiveId, d2.value.a.archiveId);
    assert.equal(d1.value.b.archiveId, d2.value.b.archiveId);
    assert.equal(d1.value.id, d2.value.id);
    assert.equal(d1.value.fingerprint, d2.value.fingerprint);
    assert.deepEqual(d1.value.items, d2.value.items);
    assert.equal(d1.value.a.archiveId, [arcA.id, arcB.id].sort()[0]);

    const types = {};
    d1.value.items.forEach(function (it) {
      types[it.type] = (types[it.type] || 0) + 1;
      assert.ok(it.id && it.locator && it.typeLabel);
    });
    assert.ok(types.locked_opinion >= 1); // 会话头 + rv-1 结论涉及的锁定差异
    assert.ok(types.conclusion >= 1);    // rv-1 confirm vs need_evidence
    assert.ok(types.timeline >= 1);      // 源会话不同 -> create 日志不同
    // rv-1 的结论差异可定位到意见与字段
    const conc = d1.value.items.find(function (it) {
      return it.type === "conclusion" && it.locator.reviewId === "rv-1" &&
             it.locator.field === "result";
    });
    assert.ok(conc);
    // A/B 按归档 id 归一化：两侧取值集合必须是 confirm/need_evidence
    const sideOf = {};
    sideOf[d1.value.a.archiveId] = conc.a.value;
    sideOf[d1.value.b.archiveId] = conc.b.value;
    assert.equal(sideOf[arcA.id], "confirm");
    assert.equal(sideOf[arcB.id], "need_evidence");
    assert.deepEqual([conc.a.value, conc.b.value].sort(),
      ["confirm", "need_evidence"]);
    assert.equal(conc.resolvable, true);
    // 时间线/指纹/恢复为不可裁决
    d1.value.items.filter(function (it) {
      return ["timeline", "fingerprint", "restore"].indexOf(it.type) !== -1;
    }).forEach(function (it) { assert.equal(it.resolvable, false); });
  });

  it("同内容同状态：无差异项", function () {
    const { arcA } = pairArchives();
    const copy = JSON.parse(JSON.stringify(arcA));
    // 复制成不同 id 的归档不现实（id 由内容决定）；改为与自身比较 -> 明确报错
    const same = RC.buildDiff({ a: arcA, b: arcA });
    assert.equal(same.ok, false);
    assert.equal(same.code, "diff_same_archive");
  });

  it("恢复状态差异生成 restore 差异项，且纳入差异指纹（恢复后指纹变化）", function () {
    const { arcA, arcB } = pairArchives();
    const restored = JSON.parse(JSON.stringify(arcB));
    restored.status = "restored";
    restored.restoredSpaceId = "sp-new";
    restored.restoredAt = iso(9000000);
    restored.restoredBy = "审批人";
    const d1 = RC.buildDiff({ a: arcA, b: arcB });
    const d2 = RC.buildDiff({ a: arcA, b: restored });
    assert.ok(d1.ok && d2.ok);
    assert.ok(!d1.value.items.some(function (it) { return it.type === "restore"; }));
    assert.ok(d2.value.items.some(function (it) { return it.type === "restore"; }));
    assert.notEqual(d1.value.fingerprint, d2.value.fingerprint);
  });

  it("内容指纹不同：counts.contentHashMismatch=true 且产生 fingerprint 差异项", function () {
    const { arcA } = pairArchives();
    // 另造一个锁定内容不同的包与归档
    const pkg = buildPackageFixture("p-other");
    pkg.content.events[0].actor = "乙"; // 改内容后必须重建 manifest 才能通过校验
    pkg.manifest = Core.buildManifest(pkg);
    const sp = buildSpace(pkg, "space-9");
    const r = addReview(sp, 0);
    const s = addSession(sp, [r], { id: "sess-X" });
    conclude(sp, s, 0, "confirm", "参与人甲");
    const arcC = makeArchive(sp, s);
    const d = RC.buildDiff({ a: arcA, b: arcC });
    assert.ok(d.ok, d.message);
    assert.equal(d.value.counts.contentHashMismatch, true);
    assert.ok(d.value.items.some(function (it) {
      return it.type === "fingerprint" && it.locator.field === "contentHash";
    }));
  });
});

/* ================= 损坏归档：明确标出原因，不继续合并 ================= */

describe("buildDiff 损坏归档", function () {
  function forge(rec, mutator) {
    mutator(rec.payload);
    rec.manifest.payloadHash = AC.hashCanonical(rec.payload);
    rec.manifest.payloadHashSha256 = AC.sha256Canonical(rec.payload);
    return rec;
  }

  it("直接篡改 payload（不伪造哈希）-> diff_archive_invalid + archive_hash_mismatch", function () {
    const { arcA, arcB } = pairArchives();
    arcA.payload.session.name = "被篡改";
    const d = RC.buildDiff({ a: arcA, b: arcB });
    assert.equal(d.ok, false);
    assert.equal(d.code, "diff_archive_invalid");
    assert.equal(d.problems.length, 1);
    assert.equal(d.problems[0].code, "archive_hash_mismatch");
  });

  it("伪造哈希但删意见造成缺引用 -> archive_broken_reference，明确失败不产出差异", function () {
    const { arcA, arcB } = pairArchives();
    forge(arcA, function (p) { p.reviews.pop(); });
    const d = RC.buildDiff({ a: arcA, b: arcB });
    assert.equal(d.ok, false);
    assert.equal(d.code, "diff_archive_invalid");
    assert.equal(d.problems[0].code, "archive_broken_reference");
  });

  it("内嵌包指纹被伪造 -> restore_fingerprint_mismatch；两侧都坏时两个原因都返回", function () {
    const { arcA, arcB } = pairArchives();
    forge(arcA, function (p) {
      p.fingerprint.contentHash = "fnv1a64:deadbeefdeadbeef";
    });
    let d = RC.buildDiff({ a: arcA, b: arcB });
    assert.equal(d.ok, false);
    assert.equal(d.problems[0].code, "restore_fingerprint_mismatch");

    forge(arcB, function (p) {
      p.fingerprint.chainHead = "0000000000000000";
    });
    d = RC.buildDiff({ a: arcB, b: arcA });
    assert.equal(d.problems.length, 2);
  });

  it("损坏归档的失败差异记录可确定性构建（供持久化查询）", function () {
    const { arcA, arcB } = pairArchives();
    arcA.payload.session.name = "x";
    const failed = RC.buildDiff({ a: arcA, b: arcB });
    const rec = RC.buildInvalidDiff({ a: arcA, b: arcB, actor: "负责人" },
      failed.problems);
    assert.equal(rec.status, "invalid");
    assert.equal(rec.items.length, 0);
    assert.equal(rec.problems.length, 1);
    // 交换顺序仍得到同一确定性 id
    const rec2 = RC.buildInvalidDiff({ a: arcB, b: arcA, actor: "负责人" },
      failed.problems);
    assert.equal(rec.id, rec2.id);
  });
});

/* ================= 批次输入校验 ================= */

describe("validateBatchInput", function () {
  function baseInput(diff) {
    return {
      diff: diff, name: "纠错批次一", owner: "负责人",
      deadline: iso(99000000), approvers: ["审批人甲"],
      baseArchiveId: null, note: "",
      items: diff.items.filter(function (it) { return it.resolvable; })
        .map(function (it) { return { id: it.id, resolution: "keep_a" }; })
    };
  }

  it("合法输入通过；全部可裁决项必须有裁决", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const inp = baseInput(diff);
    const ok = RC.validateBatchInput(inp, iso(4000000));
    assert.ok(ok.ok, ok.message);
    assert.equal(ok.value.items.length, diff.counts.resolvable);

    inp.items.pop();
    const bad = RC.validateBatchInput(inp, iso(4000000));
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "unresolved_items");
    assert.ok(bad.unresolved.length >= 1);
  });

  it("负责人/截止时间/审批人校验", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    let inp = baseInput(diff);
    inp.owner = "";
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "missing_owner");
    inp = baseInput(diff); inp.deadline = iso(1);
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "deadline_in_past");
    inp = baseInput(diff); inp.approvers = [];
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "missing_approver");
    inp = baseInput(diff); inp.approvers = ["甲", "甲"];
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "duplicate_approver");
    inp = baseInput(diff); inp.approvers = ["负责人"];
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "approver_is_owner");
    inp = baseInput(diff); inp.approvers = ["1", "2", "3", "4"];
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "too_many_approvers");
  });

  it("内容指纹不同必须指定基线归档，且必须是参与比较的归档之一", function () {
    const { arcA } = pairArchives();
    const pkg = buildPackageFixture("p-other");
    pkg.content.events[0].actor = "乙";
    pkg.manifest = Core.buildManifest(pkg);
    const sp = buildSpace(pkg, "space-9");
    const r = addReview(sp, 0);
    const s = addSession(sp, [r], { id: "sess-X" });
    conclude(sp, s, 0, "confirm", "参与人甲");
    const arcC = makeArchive(sp, s);
    const diff = RC.buildDiff({ a: arcA, b: arcC }).value;
    const inp = baseInput(diff);
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "missing_base_archive");
    inp.baseArchiveId = "arc_nope";
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "invalid_base_archive");
    inp.baseArchiveId = arcC.id;
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).ok, true);
  });

  it("非法/重复/不可裁决项的裁决被拒绝", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const inp = baseInput(diff);
    inp.items[0].resolution = "nope";
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "invalid_resolution");
    inp.items[0].resolution = "keep_a";
    inp.items.push(JSON.parse(JSON.stringify(inp.items[0])));
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "duplicate_resolution");
    const tl = diff.items.find(function (it) { return it.type === "timeline"; });
    inp.items = baseInput(diff).items;
    inp.items.push({ id: tl.id, resolution: "keep_a" });
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "item_not_resolvable");
    inp.items = baseInput(diff).items;
    inp.items[0].id = "dit_0000000000000000";
    assert.equal(RC.validateBatchInput(inp, iso(4000000)).code, "diff_item_not_found");
  });
});

/* ================= 提交/执行前重校验 ================= */

describe("recheckDiff", function () {
  it("归档未变化 -> 通过；归档载荷被替换 -> diff_archive_replaced", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const map = {}; map[arcA.id] = arcA; map[arcB.id] = arcB;
    assert.ok(RC.recheckDiff(diff, map).ok);

    const replaced = JSON.parse(JSON.stringify(arcB));
    replaced.payload.session.name = "新版本";
    replaced.manifest.payloadHash = AC.hashCanonical(replaced.payload);
    replaced.manifest.payloadHashSha256 = AC.sha256Canonical(replaced.payload);
    const map2 = {}; map2[arcA.id] = arcA; map2[arcB.id] = replaced;
    assert.equal(RC.recheckDiff(diff, map2).code, "diff_archive_replaced");

    const map3 = {}; map3[arcA.id] = arcA;
    assert.equal(RC.recheckDiff(diff, map3).code, "diff_archive_replaced");
  });

  it("归档恢复状态变化 -> diff_fingerprint_changed", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const restored = JSON.parse(JSON.stringify(arcB));
    restored.status = "restored";
    restored.restoredSpaceId = "sp-x";
    const map = {}; map[arcA.id] = arcA; map[arcB.id] = restored;
    assert.equal(RC.recheckDiff(diff, map).code, "diff_fingerprint_changed");
  });
});

/* ================= 纠错合成 ================= */

// 生成裁决：rv-1 的结论结果采用 arcB（need_evidence），其余采用 arcA。
// A/B 由归档 id 归一化，因此按差异项“持有某值的一侧”映射 keep_a/keep_b。
function resolutionFor(it, diff, arcAId, arcBId) {
  function sideOf(archiveId) {
    return diff.a.archiveId === archiveId ? "a" : "b";
  }
  if (it.type === "conclusion" && it.locator.reviewId === "rv-1" &&
      it.locator.field === "result") {
    // arcB 的 rv-1 结论是 need_evidence
    return "keep_" + sideOf(arcBId);
  }
  return "keep_" + sideOf(arcAId);
}

function makeBatch(diff, arcAId, arcBId, overrides) {
  const checked = RC.validateBatchInput({
    diff: diff, name: "纠错批次一", owner: "负责人",
    deadline: iso(99000000), approvers: ["审批人甲"],
    // 基线固定为 arcA（语义清晰；同内容时也可省略，但显式更确定）
    baseArchiveId: arcAId,
    items: diff.items.filter(function (it) { return it.resolvable; })
      .map(function (it) {
        return { id: it.id, resolution: resolutionFor(it, diff, arcAId, arcBId) };
      })
  }, iso(4000000));
  assert.ok(checked.ok, checked.message);
  const batch = Object.assign({
    id: "btc-test-1", version: 1, owner: "负责人",
    deadline: checked.value.deadline, approvers: checked.value.approvers,
    baseArchiveId: checked.value.baseArchiveId, items: checked.value.items,
    status: "submitted"
  }, overrides || {});
  return batch;
}

describe("buildCorrection 纠错合成", function () {
  it("按裁决合成：rv-1 结论采用 arcB；新标识审计包通过全量校验；锁定内容指纹与基线一致", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const batch = makeBatch(diff, arcA.id, arcB.id);
    // 无内容指纹差异时基线默认取归一化 A 侧
    const baseRec = diff.a.archiveId === arcA.id ? arcA : arcB;
    const built = RC.buildCorrection({
      batch: batch, diff: diff, recA: arcA, recB: arcB,
      now: iso(5000000), actor: "审批人甲", spaceId: "sp-corr-1"
    });
    assert.ok(built.ok, built.message);
    const rec = built.value.record;
    assert.match(rec.id, /^crc_[0-9a-f]{16}$/);
    // 新包标识不同于原包
    assert.notEqual(built.value.package.packageId, arcA.payload.fingerprint.packageId);
    assert.notEqual(built.value.package.packageId, arcB.payload.fingerprint.packageId);
    assert.match(built.value.package.packageId, /^car_[0-9a-f]{16}$/);
    // 内嵌审计包通过全量校验，锁定内容指纹 = 基线
    assert.equal(Core.verifyPackage(built.value.package).ok, true);
    assert.equal(rec.payload.fingerprint.contentHash,
      baseRec.payload.fingerprint.contentHash);
    assert.equal(rec.payload.fingerprint.chainHead,
      baseRec.payload.fingerprint.chainHead);
    // rv-1 结论采用 arcB：need_evidence
    const rv1 = rec.payload.session.items.find(function (it) {
      return it.reviewId === "rv-1";
    });
    assert.equal(rv1.conclusion.result, "need_evidence");
    // rv-2 锁定版本采用 arcA（基线侧值 1）
    const rv2 = rec.payload.session.items.find(function (it) {
      return it.reviewId === "rv-2";
    });
    assert.equal(rv2.lockedVersion, 1);
    // 纠错归档自洽
    assert.equal(RC.verifyCorrectionRecord(rec).ok, true);
    // 时间线为两侧并集、id 带命名空间、确定性排序
    rec.payload.timeline.forEach(function (e) { assert.match(e.id, /^[12]:/); });
    for (let i = 1; i < rec.payload.timeline.length; i++) {
      assert.ok(Date.parse(rec.payload.timeline[i - 1].at) <=
                Date.parse(rec.payload.timeline[i].at));
    }
  });

  it("纯函数：不修改批次、差异与归档输入", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const batch = makeBatch(diff, arcA.id, arcB.id);
    const before = JSON.stringify({
      diff: diff, batch: batch, arcA: arcA, arcB: arcB
    });
    const built = RC.buildCorrection({
      batch: batch, diff: diff, recA: arcA, recB: arcB, now: iso(5000000)
    });
    assert.ok(built.ok);
    assert.equal(JSON.stringify({ diff: diff, batch: batch, arcA: arcA, arcB: arcB }),
      before);
  });

  it("manual：不自动合并，取基线值并在条目上打人工标记", function () {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const items = diff.items.filter(function (it) { return it.resolvable; })
      .map(function (it) { return { id: it.id, resolution: "manual" }; });
    const checked = RC.validateBatchInput({
      diff: diff, name: "批次", owner: "负责人", deadline: iso(99000000),
      approvers: ["审批人甲"], baseArchiveId: arcA.id, items: items
    }, iso(4000000));
    assert.ok(checked.ok, checked.message);
    const batch = { id: "btc-manual", version: 1, owner: "负责人",
      deadline: checked.value.deadline, approvers: checked.value.approvers,
      baseArchiveId: checked.value.baseArchiveId, items: checked.value.items,
      status: "submitted" };
    const built = RC.buildCorrection({
      batch: batch, diff: diff, recA: arcA, recB: arcB, now: iso(5000000)
    });
    assert.ok(built.ok, built.message);
    const rv1 = built.value.record.payload.session.items.find(function (it) {
      return it.reviewId === "rv-1";
    });
    // 基线（A）值，且带人工标记
    assert.equal(rv1.conclusion.result, "confirm");
    assert.ok(rv1.manual);
    assert.ok(rv1.manual.parts.indexOf("conclusion.result") !== -1);
    assert.equal(built.value.record.manifest.manualCount >= 1, true);
  });

  it("条目保留但意见被裁决剔除 -> correction_missing_reference，整批拒绝", function () {
    // 构造 B 侧多一条意见 rv-3 的归档对
    const pkg = buildPackageFixture("p-1");
    const sp1 = buildSpace(pkg, "space-1");
    const r1 = addReview(sp1, 0), r2 = addReview(sp1, 1);
    const s1 = addSession(sp1, [r1, r2], { id: "sess-A" });
    conclude(sp1, s1, 0, "confirm", "参与人甲");
    conclude(sp1, s1, 1, "reject", "参与人乙");
    const arcA = makeArchive(sp1, s1);

    const pkg2 = JSON.parse(JSON.stringify(pkg));
    const sp2 = buildSpace(pkg2, "space-2");
    const q1 = addReview(sp2, 0), q2 = addReview(sp2, 1), q3 = addReview(sp2, 0);
    q3.id = "rv-3"; q3.targetKey = q3.targetKey; // 同事件不同意见允许
    // addReview 已 push 一条 r3=rv-1 克隆？需手工保证唯一：上面 addReview(sp2,0) 第二次仍是 rv-1
    // 因此改为直接构造 rv-3：
    sp2.reviews.pop();
    sp2.reviewLogs.pop();
    const r3 = {
      id: "rv-3", version: 1, target: q1.target, targetKey: q1.targetKey,
      status: "open", reviewer: "复核人C", dueAt: iso(90000000), content: "第三条",
      createdBy: "负责人", createdAt: iso(650000), updatedAt: null, updatedBy: null,
      closedAt: null, closedBy: null, closeReason: null
    };
    sp2.reviews.push(r3);
    sp2.reviewLogs.push({
      id: "rl-rv-3", reviewId: "rv-3", at: r3.createdAt, action: "create",
      actor: "负责人", from: null, to: { status: "open" }
    });
    const s2 = addSession(sp2, [q1, q2, r3], { id: "sess-B" });
    conclude(sp2, s2, 0, "confirm", "参与人甲");
    conclude(sp2, s2, 1, "reject", "参与人乙");
    // rv-3 无结论（pending 会导致不能归档）：给一条冲突标记
    s2.items[2].conflict = { code: "target_missing", message: "目标缺失",
      at: iso(2600000), by: "参与人甲" };
    s2.version++;
    sp2.sessionLogs.push({
      id: "sl-conf-rv-3", sessionId: s2.id, at: iso(2600000), action: "conflict",
      actor: "参与人甲", reviewId: "rv-3", detail: { conflict: "target_missing" }
    });
    const arcB2 = makeArchive(sp2, s2);
    const diff = RC.buildDiff({ a: arcA, b: arcB2 }).value;
    // 裁决（侧别无关）：rv-3 的意见存在性选“缺失侧”（剔除意见）；
    // 其余（含 rv-3 条目与冲突存在性）选“存在侧”（保留条目+冲突）-> 缺引用。
    function side(archiveId) {
      return diff.a.archiveId === archiveId ? "a" : "b";
    }
    const items = diff.items.filter(function (it) { return it.resolvable; })
      .map(function (it) {
        if (it.locator.reviewId === "rv-3" &&
            it.locator.field === "opinion_present") {
          // 选“意见缺失侧”：该侧 present=false，按其裁决即剔除意见
          const sideName = !it.a.present ? "a" : "b";
          return { id: it.id, resolution: "keep_" + sideName };
        }
        // 其余保留：rv-3 相关项选 arcB2 侧；其它项默认 arcA 侧
        if (it.locator.reviewId === "rv-3") {
          return { id: it.id, resolution: "keep_" + side(arcB2.id) };
        }
        return { id: it.id, resolution: "keep_" + side(arcA.id) };
      });
    const checked = RC.validateBatchInput({
      diff: diff, name: "批次", owner: "负责人", deadline: iso(99000000),
      approvers: ["审批人甲"], items: items
    }, iso(4000000));
    assert.ok(checked.ok, checked.message);
    const batch = { id: "btc-miss", version: 1, owner: "负责人",
      deadline: checked.value.deadline, approvers: checked.value.approvers,
      baseArchiveId: checked.value.baseArchiveId, items: checked.value.items,
      status: "submitted" };
    const built = RC.buildCorrection({
      batch: batch, diff: diff, recA: arcA, recB: arcB2, now: iso(5000000)
    });
    assert.equal(built.ok, false);
    assert.equal(built.code, "correction_missing_reference");
    assert.equal(built.reviewId, "rv-3");
  });

  it("同一意见两侧 targetKey 不同 -> correction_target_conflict，整批拒绝", function () {
    const { arcA, arcB } = pairArchives();
    // 伪造：把 B 中 rv-1 的引用目标改成另一个事件，并重算哈希
    arcB.payload.reviews[0].target = { kind: "event", eventId: "ev-2" };
    arcB.payload.reviews[0].targetKey = "event:ev-2";
    arcB.manifest.payloadHash = AC.hashCanonical(arcB.payload);
    arcB.manifest.payloadHashSha256 = AC.sha256Canonical(arcB.payload);
    // 注意：这会使 verifyArchiveRecord 通过吗？归档校验不校验意见目标可解析性
    // （内嵌包内 ev-2 存在），时间线重建不受影响 -> 可通过，进入合成阶段抓冲突
    assert.equal(AC.verifyArchiveRecord(arcB).ok, true);
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const batch = makeBatch(diff, arcA.id, arcB.id);
    const built = RC.buildCorrection({
      batch: batch, diff: diff, recA: arcA, recB: arcB, now: iso(5000000)
    });
    assert.equal(built.ok, false);
    assert.equal(built.code, "correction_target_conflict");
  });
});

/* ================= 纠错归档校验 / 目标冲突 / 新空间 ================= */

describe("纠错归档校验与新空间", function () {
  function correction() {
    const { arcA, arcB } = pairArchives();
    const diff = RC.buildDiff({ a: arcA, b: arcB }).value;
    const batch = makeBatch(diff, arcA.id, arcB.id);
    const built = RC.buildCorrection({
      batch: batch, diff: diff, recA: arcA, recB: arcB,
      now: iso(5000000), actor: "审批人甲", spaceId: "sp-corr-1"
    });
    assert.ok(built.ok, built.message);
    return { built: built.value, arcA: arcA, arcB: arcB };
  }

  it("校验摘要全绿；篡改 payload -> correction_hash_mismatch", function () {
    const { built } = correction();
    assert.equal(RC.verifyCorrectionRecord(built.record).ok, true);
    const sum = RC.correctionVerificationSummary(built.record);
    assert.equal(sum.verified, true);
    const tampered = JSON.parse(JSON.stringify(built.record));
    tampered.payload.session.name = "改";
    assert.equal(RC.verifyCorrectionRecord(tampered).code, "correction_hash_mismatch");
  });

  it("validateCorrectionTarget：同包标识/同纠错归档重复 -> 冲突", function () {
    const { built } = correction();
    assert.ok(RC.validateCorrectionTarget(built, []).ok);
    const clash = [{ id: "sp-old", packageId: built.package.packageId,
      producerId: built.package.producerId }];
    assert.equal(RC.validateCorrectionTarget(built, clash).code,
      "correction_target_conflict");
    const done = [{ id: "sp-done", packageId: "other", producerId: "p",
      correctedFromCorrectionId: built.record.id }];
    assert.equal(RC.validateCorrectionTarget(built, done).code,
      "correction_target_conflict");
  });

  it("buildCorrectionSpace：新空间锁定内容不变、纠错会话只读但可新建会话、意见可解析", function () {
    const { built, arcA } = correction();
    const sp = RC.buildCorrectionSpace(built, { name: "纠错批次一" },
      { id: "sp-corr-9", now: iso(5100000), actor: "审批人甲",
        name: "纠错后的新空间" });
    assert.equal(sp.id, "sp-corr-9");
    assert.equal(sp.packageId, built.package.packageId);
    assert.equal(Core.hashCanonical(sp.content), arcA.payload.fingerprint.contentHash);
    assert.equal(sp.correctedFromCorrectionId, built.record.id);
    assert.equal(sp.sessions.length, 1);
    assert.equal(sp.sessions[0].archived, true);
    assert.equal(sp.sessions[0].corrected, true);
    sp.reviews.forEach(function (r) {
      assert.ok(RR.findTarget(sp.content, r.target), r.id);
    });
    // 历史纠错会话只读：服务端对 archived 会话拒绝结论；新会话可创建
    const cc = SC.validateCreate({
      name: "新会话", participants: ["参与人甲"], deadline: iso(99000000),
      reviewIds: sp.reviews.slice(0, 1).map(function (r) { return r.id; })
    }, sp.reviews, sp.sessions.filter(function (s) { return !s.archived; }),
      iso(6000000));
    assert.ok(cc.ok, cc.message);
  });

  it("原归档不被改写：合成后两个源归档校验仍通过且状态不变", function () {
    const { arcA, arcB } = correction();
    assert.equal(AC.verifyArchiveRecord(arcA).ok, true);
    assert.equal(AC.verifyArchiveRecord(arcB).ok, true);
    assert.equal(arcA.status, "active");
  });
});
