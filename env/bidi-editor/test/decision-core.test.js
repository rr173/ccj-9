/* node --test test/decision-core.test.js
 * 审阅决策纯逻辑测试：方案校验、逐条投票统计与状态流转、改方案清票、
 * 文本/批注/批次三版本逐条校验、按段预览、同段多条从后向前应用、
 * 部分成功执行、过期判定与快照摘要。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dc = require("../decision-core");

function ann(overrides) {
  return Object.assign({
    id: "a1", paraIndex: 0, start: 0, end: 2, quote: "中文",
    paraDir: "ltr", updatedAt: "t0"
  }, overrides || {});
}

function item(overrides) {
  return Object.assign({
    annotationId: "a1", paraIndex: 0, start: 0, end: 2, quote: "中文",
    paraDir: "ltr", annotationUpdatedAt: "t0",
    disposition: "replace", replacement: "英文",
    votes: [], voteHistory: []
  }, overrides || {});
}

function decision(overrides) {
  return Object.assign({
    id: "d1", batchId: "b1", batchName: "批", name: "草案",
    status: "voting", threshold: 1,
    textRev: dc.textContentRev([{ dir: "ltr", text: "中文示例文本" }]),
    baselineParagraphs: [{ dir: "ltr", text: "中文示例文本" }],
    items: [item()]
  }, overrides || {});
}

// 一条已获甲 approve 的条目（threshold=1 时即通过）
function approvedItem(overrides) {
  const base = Object.assign(item(), {
    votes: [{ voter: "甲", vote: "approve", at: "t" }]
  });
  return Object.assign(base, overrides || {});
}

/* ---------- 载荷校验 ---------- */

test("创建载荷：空批次/空成员 → empty_draft", function () {
  const r = dc.validateCreatePayload({}, []);
  assert.equal(r.ok, false);
  assert.equal(r.code, "empty_draft");
});

test("创建载荷：非法方案/空替换文本/超长替换被拒", function () {
  const members = [ann()];
  let r = dc.validateCreatePayload(
    { items: [{ annotationId: "a1", disposition: "bogus" }] }, members);
  assert.equal(r.code, "invalid_disposition");
  r = dc.validateCreatePayload(
    { items: [{ annotationId: "a1", disposition: "replace", replacement: "" }] }, members);
  assert.equal(r.code, "empty_replacement");
  r = dc.validateCreatePayload(
    { items: [{ annotationId: "a1", disposition: "replace",
               replacement: "x".repeat(dc.LIMITS.REPLACEMENT_MAX_CHARS + 1) }] }, members);
  assert.equal(r.status, 413);
  assert.equal(r.code, "replacement_too_long");
});

test("创建载荷：重复 annotationId → duplicate_item；非成员 id → not_batch_member", function () {
  const members = [ann({ id: "a1" }), ann({ id: "a2", quote: "文" })];
  let r = dc.validateCreatePayload({ items: [
    { annotationId: "a1", disposition: "keep" },
    { annotationId: "a1", disposition: "delete" }
  ] }, members);
  assert.equal(r.ok, false);
  assert.equal(r.code, "duplicate_item");

  r = dc.validateCreatePayload({ items: [
    { annotationId: "ghost", disposition: "keep" }
  ] }, members);
  assert.equal(r.code, "not_batch_member");
});

test("创建载荷：按成员顺序展开，未给方案的条目留空；默认门槛 1", function () {
  const members = [ann({ id: "a1" }), ann({ id: "a2", quote: "文" })];
  const r = dc.validateCreatePayload({
    items: [{ annotationId: "a2", disposition: "delete" }]
  }, members);
  assert.equal(r.ok, true);
  assert.equal(r.value.threshold, 1);
  assert.equal(r.value.items.length, 2);
  assert.equal(r.value.items[0].annotationId, "a1");
  assert.equal(r.value.items[0].disposition, null);
  assert.equal(r.value.items[1].disposition, "delete");
});

test("门槛：缺省/空为 1，越界非法", function () {
  assert.equal(dc.validateThreshold(undefined).value, 1);
  assert.equal(dc.validateThreshold(3).value, 3);
  assert.equal(dc.validateThreshold(0).ok, false);
  assert.equal(dc.validateThreshold(dc.LIMITS.THRESHOLD_MAX + 1).ok, false);
});

test("方案更新：空数组/重复 id/非草案成员被拒；非替换方案清空 replacement", function () {
  const d = decision({ items: [item(), item(Object.assign(item(),
    { annotationId: "a2" }))] });
  assert.equal(dc.validateItemsUpdate({ items: [] }, d).code, "empty_draft");
  assert.equal(dc.validateItemsUpdate({ items: [
    { annotationId: "a1", disposition: "keep" },
    { annotationId: "a1", disposition: "keep" }
  ] }, d).code, "duplicate_item");
  assert.equal(dc.validateItemsUpdate({ items: [
    { annotationId: "ghost", disposition: "keep" }
  ] }, d).code, "not_batch_member");
  const ok = dc.validateItemsUpdate({ items: [
    { annotationId: "a1", disposition: "keep", replacement: "残留" }
  ] }, d);
  assert.equal(ok.value.items[0].replacement, null);
});

test("投票：必须记名；票值只能是 approve/reject/abstain", function () {
  assert.equal(dc.validateVotePayload({ annotationId: "a1", vote: "approve" }).code,
    "missing_voter");
  assert.equal(dc.validateVotePayload({ annotationId: "a1", vote: "approve", voter: " " }).code,
    "missing_voter");
  assert.equal(dc.validateVotePayload({ annotationId: "a1", vote: "maybe", voter: "甲" }).code,
    "invalid_vote");
  const ok = dc.validateVotePayload({ annotationId: "a1", vote: "approve", voter: " 甲 " });
  assert.equal(ok.value.voter, "甲");
});

/* ---------- 投票统计与状态 ---------- */

test("同一投票人改票以最后一次为准；弃权计入参与人数但不计通过", function () {
  let it = item();
  let v = dc.applyVote(it, "甲", "approve", "t1");
  it.votes = v.votes; it.voteHistory = v.voteHistory;
  v = dc.applyVote(it, "甲", "abstain", "t2");
  it.votes = v.votes; it.voteHistory = v.voteHistory;
  const t = dc.tallyVotes(it.votes);
  assert.deepEqual(t.counts, { approve: 0, reject: 0, abstain: 1 });
  assert.equal(t.voters, 1);
  // 流水保留两次（改票有迹可循）
  assert.equal(it.voteHistory.length, 2);
  assert.equal(dc.itemState(it, 2), "waiting");
});

test("条目状态：未定/待投票/驳回/通过", function () {
  const it = item();
  it.disposition = null;
  assert.equal(dc.itemState(it, 1), "pending");
  it.disposition = "keep";
  assert.equal(dc.itemState(it, 1), "waiting");
  let v = dc.applyVote(it, "甲", "reject", "t");
  it.votes = v.votes;
  assert.equal(dc.itemState(it, 1), "rejected");
  v = dc.applyVote(it, "甲", "approve", "t2");
  it.votes = v.votes;
  assert.equal(dc.itemState(it, 1), "approved");
});

test("草案进度：全部条目通过才 ready；一条驳回则仍 voting", function () {
  const d = decision({ threshold: 1, items: [
    item({ annotationId: "a1" }),
    item(Object.assign(item(), { annotationId: "a2", quote: "文" }))
  ] });
  d.items[0].votes = [{ voter: "甲", vote: "approve", at: "t" }];
  let p = dc.decisionProgress(d);
  assert.equal(p.ready, false);
  assert.equal(p.counts.waiting, 1);
  d.items[1].votes = [{ voter: "甲", vote: "reject", at: "t" }];
  assert.equal(dc.recomputeStatus(d), "voting");
  d.items[1].votes = [{ voter: "甲", vote: "approve", at: "t" }];
  assert.equal(dc.recomputeStatus(d), "ready");
});

test("修改方案：内容不变 no-op；变化则作废已有投票并记录时间", function () {
  const it = item({ disposition: "keep", replacement: null,
    votes: [{ voter: "甲", vote: "approve", at: "t" }] });
  assert.equal(dc.reviseItem(it, { disposition: "keep", replacement: null }, "t2").changed, false);
  const rev = dc.reviseItem(it, { disposition: "delete", replacement: null }, "t3");
  assert.equal(rev.changed, true);
  assert.equal(rev.disposition, "delete");
  assert.deepEqual(rev.votes, []);
  assert.equal(rev.voteClearedAt, "t3");
});

test("过期判定", function () {
  assert.equal(dc.isOverdue(null), false);
  assert.equal(dc.isOverdue("2030-01-01T00:00:00Z", Date.parse("2026-09-12T00:00:00Z")), false);
  assert.equal(dc.isOverdue("2020-01-01T00:00:00Z", Date.parse("2026-09-12T00:00:00Z")), true);
});

/* ---------- 文本版本指纹 ---------- */

test("textContentRev：dir/text 相同即一致；editedAt 不影响版本", function () {
  const a = [{ dir: "ltr", text: "中文", editedAt: "t1" }];
  const b = [{ dir: "ltr", text: "中文", editedAt: "t2" }];
  assert.equal(dc.textContentRev(a), dc.textContentRev(b));
  assert.notEqual(dc.textContentRev(a),
    dc.textContentRev([{ dir: "ltr", text: "中文2" }]));
  assert.notEqual(dc.textContentRev(a),
    dc.textContentRev([{ dir: "rtl", text: "中文" }]));
});

/* ---------- 三版本逐条校验 ---------- */

test("文本未变、批注未变、成员仍在批次：成功（keep/replace/delete）", function () {
  const paras = [{ dir: "ltr", text: "中文示例文本" }];
  const d = decision({ items: [approvedItem()] });
  const plan = dc.planExecution(d, paras, { a1: ann() }, ["a1"]);
  assert.deepEqual(plan.counts, { success: 1, conflict: 0, skipped: 0 });
  assert.equal(plan.textChanged, false);
});

test("文本版本变化但改动在段尾：引文位置不变，条目不受影响（逐条隔离）", function () {
  const d = decision({ items: [approvedItem()] });
  const cur = [{ dir: "ltr", text: "中文示例文本X" }];
  const plan = dc.planExecution(d, cur, { a1: ann() }, ["a1"]);
  assert.equal(plan.textChanged, true);
  assert.equal(plan.results[0].result, "success");
});

test("引文前插入文字 → quote_mismatch；整段删除 → paragraph_deleted；方向变化 → 冲突", function () {
  const d = decision({ items: [approvedItem()] });
  let plan = dc.planExecution(d, [{ dir: "ltr", text: "新中文示例文本" }],
    { a1: ann() }, ["a1"]);
  assert.equal(plan.results[0].result, "conflict");
  assert.equal(plan.results[0].reason, "quote_mismatch");

  plan = dc.planExecution(d, [], { a1: ann() }, ["a1"]);
  assert.equal(plan.results[0].reason, "paragraph_deleted");

  plan = dc.planExecution(d, [{ dir: "rtl", text: "中文示例文本" }],
    { a1: ann() }, ["a1"]);
  assert.equal(plan.results[0].reason, "paragraph_dir_changed");
});

test("段落被改写（del+ins 配对）：引文仍在原位可成功，位置变化则 quote_mismatch", function () {
  const baseline = [
    { dir: "ltr", text: "中文示例文本" },
    { dir: "rtl", text: "أحب العربية" }
  ];
  const d = decision({ items: [approvedItem()], baselineParagraphs: baseline });
  // 第二段改写：不影响第一段条目
  const cur = [
    { dir: "ltr", text: "中文示例文本" },
    { dir: "rtl", text: "أحب اللغة" }
  ];
  const plan = dc.planExecution(d, cur, { a1: ann() }, ["a1"]);
  assert.equal(plan.results[0].result, "success");
});

test("批注版本：updatedAt 变化 → annotation_changed；批注删除/移出批次各自标记", function () {
  const d = decision({ items: [approvedItem()] });
  const paras = d.baselineParagraphs;
  let plan = dc.planExecution(d, paras,
    { a1: ann({ updatedAt: "t9" }) }, ["a1"]);
  assert.equal(plan.results[0].reason, "annotation_changed");
  plan = dc.planExecution(d, paras, {}, ["a1"]);
  assert.equal(plan.results[0].reason, "annotation_deleted");
  plan = dc.planExecution(d, paras, { a1: ann() }, []);
  assert.equal(plan.results[0].reason, "member_removed");
});

test("一段的变化不影响另一段条目（部分成功的逐条隔离）", function () {
  const baseline = [
    { dir: "ltr", text: "中文示例文本" },
    { dir: "rtl", text: "أحب العربية" }
  ];
  const d = decision({ threshold: 1, items: [
    item({ annotationId: "a1" }),
    item(Object.assign(item(), {
      annotationId: "a2", paraIndex: 1, start: 0, end: 3,
      quote: "أحب", paraDir: "rtl",
      votes: [{ voter: "甲", vote: "approve", at: "t" }]
    }))
  ], baselineParagraphs: baseline });
  d.items[0].votes = [{ voter: "甲", vote: "approve", at: "t" }];
  const cur = [
    { dir: "ltr", text: "被完全改写的第一段XYZ" },
    { dir: "rtl", text: "أحب العربية" }
  ];
  const plan = dc.planExecution(d, cur,
    { a1: ann(), a2: ann({ id: "a2", paraIndex: 1, start: 0, end: 3,
      quote: "أحب", paraDir: "rtl" }) },
    ["a1", "a2"]);
  assert.deepEqual(plan.counts, { success: 1, conflict: 1, skipped: 0 });
  const byId = Object.fromEntries(plan.results.map(r => [r.annotationId, r]));
  assert.equal(byId.a1.result, "conflict");
  assert.equal(byId.a2.result, "success");
});

test("未投票通过的条目 → skipped(not_approved)；未勾选执行 → skipped(not_selected)", function () {
  const d = decision(); // threshold=2，无投票
  const paras = d.baselineParagraphs;
  let plan = dc.planExecution(d, paras, { a1: ann() }, ["a1"]);
  assert.equal(plan.results[0].result, "skipped");
  assert.equal(plan.results[0].reason, "not_approved");

  const d2 = decision({
    items: [approvedItem()]
  });
  // 参数顺序：(decision, paragraphs, annotationMap, memberIds, selectedIds)
  plan = dc.planExecution(d2, paras, { a1: ann() }, ["a1"], []);
  assert.equal(plan.results[0].reason, "not_selected");
});

/* ---------- 应用与预览 ---------- */

test("applyRange 按码点处理；emoji 代理对按 1 个逻辑字符", function () {
  assert.equal(dc.applyRange("012345", 1, 3, "AB"), "0AB345");
  assert.equal(dc.applyRange("012345", 1, 3, ""), "0345");
  assert.equal(dc.applyRange("a😀b", 1, 2, "X"), "aXb");
});

test("同段多条 replace/delete 从后向前应用，偏移互不影响", function () {
  const paras = [{ dir: "ltr", text: "0123456789" }];
  const d = decision({ threshold: 1, baselineParagraphs: paras, items: [
    item({ annotationId: "x", start: 1, end: 3, quote: "12",
      disposition: "replace", replacement: "AB",
      votes: [{ voter: "甲", vote: "approve", at: "t" }] }),
    item(Object.assign(item(), { annotationId: "y", start: 5, end: 7,
      quote: "56", disposition: "delete",
      votes: [{ voter: "甲", vote: "approve", at: "t" }] }))
  ] });
  const plan = dc.planExecution(d, paras, { x: ann({ id: "x" }), y: ann({ id: "y" }) },
    ["x", "y"]);
  assert.deepEqual(plan.counts, { success: 2, conflict: 0, skipped: 0 });
  assert.equal(dc.applyPlan(paras, plan.results)[0].text, "0AB34789");
});

test("applyPlan 不修改输入段落；keep 不改动文字", function () {
  const paras = [{ dir: "ltr", text: "0123456789" }];
  const d = decision({ threshold: 1, baselineParagraphs: paras, items: [
    item({ annotationId: "x", start: 1, end: 3, quote: "12", disposition: "keep",
      votes: [{ voter: "甲", vote: "approve", at: "t" }] })
  ] });
  const plan = dc.planExecution(d, paras, { x: ann({ id: "x" }) }, ["x"]);
  const out = dc.applyPlan(paras, plan.results);
  assert.equal(out[0].text, "0123456789");
  assert.equal(paras[0].text, "0123456789");
  assert.notEqual(out[0], paras[0]);
});

test("buildPreview 按段聚合：含执行后整段文本与逐条判定", function () {
  const paras = [{ dir: "ltr", text: "中文示例文本" }];
  const d = decision({ items: [approvedItem()] });
  const pv = dc.buildPreview(d, paras, { a1: ann() }, ["a1"]);
  assert.equal(pv.rows.length, 1);
  assert.equal(pv.rows[0].afterText, "英文示例文本");
  assert.equal(pv.rows[0].items[0].result, "success");
  assert.equal(pv.counts.success, 1);
});

/* ---------- 快照摘要 ---------- */

test("decisionDigest 保留状态/投票/执行结果，不含投票流水等冗余", function () {
  const d = decision();
  d.items[0].votes = [{ voter: "甲", vote: "approve", at: "t" }];
  d.items[0].voteHistory = [{ voter: "甲", vote: "approve", at: "t" }];
  d.status = "ready";
  d.executions = [{
    id: "e1", at: "t9", actor: "甲", applied: true, undone: false,
    textRevBefore: "x", counts: { success: 1, conflict: 0, skipped: 0 },
    results: [{ annotationId: "a1", disposition: "replace",
      result: "success", reason: null, paraIndex: 0, at: "t9" }],
    undo: null
  }];
  d.lastExecutionId = "e1";
  const dg = dc.decisionDigest([d])[0];
  assert.equal(dg.status, "ready");
  assert.equal(dg.items[0].votes.length, 1);
  assert.equal(dg.executions[0].id, "e1");
  assert.equal(dg.executions[0].results[0].result, "success");
  // 摘要里不含 voteHistory
  assert.equal(dg.items[0].voteHistory, undefined);
});
