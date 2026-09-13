/* node --test test/replay-session-core.test.js
 * 复核会话核心纯逻辑测试：创建校验（空选集/重复加入/截止时间/参与人）、
 * 结论校验、冲突检测（已关闭/会话外更新/引用目标缺失/意见缺失）、
 * 实时进度计算、会话报告构建（纯只读、不改输入）。
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../replay-core");
const RS = require("../replay-session-core");

function iso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + (offsetMs || 0)).toISOString();
}
const NOW = iso(60000);

// 与 replay-review-core.test.js 相同的锁定内容构建链路
function builtContent() {
  const task = {
    id: "t1", decisionId: "d1", decisionName: "决策一", batchId: "b1", batchName: "批次一",
    status: "succeeded", publishedAt: iso(0), publishedBy: "负责人",
    scheduledAt: iso(1000), pausedAt: null, resumedAt: null, finishedAt: iso(5000),
    cancelledAt: null, cancelReason: null, blockReason: null,
    createdAt: iso(0), updatedAt: iso(5000),
    lock: { at: iso(0), paragraphs: [{ text: "原文abc", dir: "ltr" }],
            textRev: "lockrev", annotationRev: 3, batchRev: 2, decisionRev: 4 },
    dependencyIds: [], approval: null, approvalDecisions: [],
    gateState: "ready", gateReason: null,
    snapshotId: "s1", approvalSnapshotId: null,
    attempts: [{ at: iso(5000), kind: "auto", scheduledAt: iso(1000),
      status: "succeeded", reason: null,
      counts: { success: 1, conflict: 1, skipped: 0 }, executionId: "ex1" }],
    successAnnotationIds: ["an1"], lastCounts: { success: 1, conflict: 1, skipped: 0 }
  };
  const logs = [
    { id: "ev-pub", taskId: "t1", decisionId: "d1", at: iso(0), actor: "负责人",
      action: "task_publish", detail: "发布", annotationId: null, snapshotId: null },
    { id: "ev-auto", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
      action: "task_auto_execute", detail: "自动执行", annotationId: null, snapshotId: "s1" },
    { id: "ev-item-ok", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
      action: "task_auto_execute_item_success", detail: "删除成功",
      annotationId: "an1", executionId: "ex1", snapshotId: null },
    { id: "ev-ok", taskId: "t1", decisionId: "d1", at: iso(5001), actor: "系统定时执行",
      action: "task_succeeded", detail: "成功", annotationId: null, snapshotId: "s1" }
  ];
  const executions = { d1: [{
    id: "ex1", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
    trigger: "scheduled", applied: true, undone: false, snapshotId: "s1",
    counts: { success: 1, conflict: 0, skipped: 0 },
    results: [
      { annotationId: "an1", disposition: "delete", replacement: null,
        result: "success", reason: null, paraIndex: 0, currentParaIndex: 0,
        start: 2, end: 5, at: iso(5000) }
    ]
  }] };
  const built = R.buildPackage({
    name: "会话用回放", producerId: "team-a", actor: "负责人",
    range: { from: null, to: null },
    tasks: [task], decisionLogs: logs, executions: executions,
    snapshots: [], decisions: []
  });
  assert.ok(built.ok, built.message);
  return built.value.content;
}

function review(over) {
  return Object.assign({
    id: "rv1", version: 1, status: "open", reviewer: "甲",
    dueAt: iso(90000), content: "请核对该事件", createdBy: "负责人",
    createdAt: NOW, updatedAt: null, closedAt: null, closedBy: null,
    closeReason: null, targetKey: "event:ev-pub",
    target: { kind: "event", eventId: "ev-pub" }
  }, over || {});
}

function threeReviews() {
  return [
    review({ id: "rv1", target: { kind: "event", eventId: "ev-pub" },
      targetKey: "event:ev-pub" }),
    review({ id: "rv2", version: 3, reviewer: "乙",
      target: { kind: "event", eventId: "ev-auto" }, targetKey: "event:ev-auto" }),
    review({ id: "rv3", reviewer: "丙",
      target: { kind: "result", executionId: "ex1", annotationId: "an1" },
      targetKey: "result:ex1:an1" })
  ];
}

function session(over) {
  return Object.assign({
    id: "ss1", version: 1, name: "会话一",
    participants: ["张三", "李四"], deadline: iso(120000),
    createdBy: "负责人", createdAt: NOW, filters: null,
    items: [
      { reviewId: "rv1", lockedVersion: 1, lockedStatus: "open",
        targetSummary: null, conclusion: null, conflict: null },
      { reviewId: "rv2", lockedVersion: 3, lockedStatus: "open",
        targetSummary: null, conclusion: null, conflict: null }
    ]
  }, over || {});
}

describe("会话核心：创建校验", function () {
  const reviews = threeReviews();

  it("合法创建通过（名称/参与人/截止/选集规范化）", function () {
    const v = RS.validateCreate({
      name: "  九月集中复核  ", participants: [" 张三 ", "李四"],
      deadline: iso(120000), reviewIds: ["rv1", "rv3"],
      filters: { status: "open" }
    }, reviews, [], NOW);
    assert.ok(v.ok, v.message);
    assert.equal(v.value.name, "九月集中复核");
    assert.deepEqual(v.value.participants, ["张三", "李四"]);
    assert.deepEqual(v.value.reviewIds, ["rv1", "rv3"]);
    assert.equal(v.value.reviews.length, 2);
    assert.equal(v.value.filters.status, "open");
  });

  it("空选集明确拒绝 empty_selection", function () {
    assert.equal(RS.validateCreate({
      participants: ["张三"], deadline: iso(120000), reviewIds: []
    }, reviews, [], NOW).code, "empty_selection");
    assert.equal(RS.validateCreate({
      participants: ["张三"], deadline: iso(120000)
    }, reviews, [], NOW).code, "empty_selection");
  });

  it("选集内重复加入明确拒绝 duplicate_review_id", function () {
    const v = RS.validateCreate({
      participants: ["张三"], deadline: iso(120000), reviewIds: ["rv1", "rv1"]
    }, reviews, [], NOW);
    assert.equal(v.code, "duplicate_review_id");
    assert.equal(v.reviewId, "rv1");
  });

  it("选集含空间外意见 -> review_not_found", function () {
    const v = RS.validateCreate({
      participants: ["张三"], deadline: iso(120000), reviewIds: ["rv1", "ghost"]
    }, reviews, [], NOW);
    assert.equal(v.code, "review_not_found");
    assert.equal(v.reviewId, "ghost");
  });

  it("已加入其他未过期会话的意见拒绝 already_in_session；过期会话可重选", function () {
    const active = session({ items: [
      { reviewId: "rv2", lockedVersion: 3, lockedStatus: "open",
        targetSummary: null, conclusion: null, conflict: null }
    ] });
    const v = RS.validateCreate({
      participants: ["张三"], deadline: iso(120000), reviewIds: ["rv1", "rv2"]
    }, reviews, [active], NOW);
    assert.equal(v.code, "already_in_session");
    assert.equal(v.reviewId, "rv2");
    assert.equal(v.existingSessionId, "ss1");

    // 该会话已过期 -> 同一条意见可重新加入新会话
    const expired = session({ deadline: iso(1000) });
    const v2 = RS.validateCreate({
      participants: ["张三"], deadline: iso(120000), reviewIds: ["rv2"]
    }, reviews, [expired], NOW);
    assert.ok(v2.ok, v2.message);
  });

  it("截止时间：缺失/非法/过去都明确拒绝", function () {
    const base = { participants: ["张三"], reviewIds: ["rv1"] };
    assert.equal(RS.validateCreate(base, reviews, [], NOW).code, "missing_deadline");
    assert.equal(RS.validateCreate(
      Object.assign({}, base, { deadline: "下周" }), reviews, [], NOW)
      .code, "invalid_deadline");
    assert.equal(RS.validateCreate(
      Object.assign({}, base, { deadline: iso(0) }), reviews, [], NOW)
      .code, "deadline_in_past");
  });

  it("参与人：缺失/重复/超长明确拒绝", function () {
    const base = { deadline: iso(120000), reviewIds: ["rv1"] };
    assert.equal(RS.validateCreate(
      Object.assign({}, base, { participants: [] }), reviews, [], NOW)
      .code, "missing_participant");
    assert.equal(RS.validateCreate(
      Object.assign({}, base, { participants: ["张三", " 张三 "] }), reviews, [], NOW)
      .code, "duplicate_participant");
    assert.equal(RS.validateCreate(
      Object.assign({}, base, { participants: ["x".repeat(51)] }), reviews, [], NOW)
      .code, "participant_too_long");
  });

  it("名称超长 / 选集超限 / 非法筛选条件拒绝", function () {
    const base = { participants: ["张三"], deadline: iso(120000), reviewIds: ["rv1"] };
    assert.equal(RS.validateCreate(
      Object.assign({}, base, { name: "n".repeat(101) }), reviews, [], NOW)
      .code, "session_name_too_long");
    const tooMany = Object.assign({}, base, {
      reviewIds: Array.from({ length: 201 }, function (_, i) { return "x" + i; })
    });
    assert.equal(RS.validateCreate(tooMany, reviews, [], NOW).code, "session_too_large");
    assert.equal(RS.validateCreate(
      Object.assign({}, base, { filters: { status: "bogus" } }), reviews, [], NOW)
      .code, "invalid_status");
  });
});

describe("会话核心：结论校验", function () {
  it("合法结论通过（备注可空）", function () {
    const v = RS.validateConclusion({
      reviewId: "rv1", result: "confirm", note: "  证据一致  ", actor: " 张三 "
    });
    assert.ok(v.ok, v.message);
    assert.equal(v.value.actor, "张三");
    assert.equal(v.value.note, "证据一致");
  });

  it("缺参与人 / 非法结论 / 缺意见 / 备注超长明确拒绝", function () {
    assert.equal(RS.validateConclusion({
      reviewId: "rv1", result: "confirm" }).code, "missing_participant");
    assert.equal(RS.validateConclusion({
      reviewId: "rv1", result: "maybe", actor: "张三" }).code, "invalid_result");
    assert.equal(RS.validateConclusion({
      result: "confirm", actor: "张三" }).code, "missing_review_id");
    assert.equal(RS.validateConclusion({
      reviewId: "rv1", result: "confirm", actor: "张三",
      note: "n".repeat(1001) }).code, "note_too_large");
  });
});

describe("会话核心：冲突检测", function () {
  const content = builtContent();
  const item = { reviewId: "rv1", lockedVersion: 2, lockedStatus: "open" };

  it("意见已关闭 -> review_closed", function () {
    const c = RS.checkItemConflict(item,
      review({ version: 2, status: "closed" }), content);
    assert.equal(c.code, "review_closed");
  });

  it("意见版本偏离锁定值（会话外更新）-> updated_outside", function () {
    const c = RS.checkItemConflict(item, review({ version: 3 }), content);
    assert.equal(c.code, "updated_outside");
    assert.match(c.message, /v2/);
    assert.match(c.message, /v3/);
  });

  it("引用目标不再存在 -> target_missing", function () {
    const c = RS.checkItemConflict(item,
      review({ version: 2, target: { kind: "event", eventId: "ghost" } }), content);
    assert.equal(c.code, "target_missing");
  });

  it("意见本身不存在 -> review_missing", function () {
    const c = RS.checkItemConflict(item, null, content);
    assert.equal(c.code, "review_missing");
  });

  it("版本一致且目标存在 -> 无冲突", function () {
    const c = RS.checkItemConflict(item, review({ version: 2 }), content);
    assert.equal(c, null);
  });
});

describe("会话核心：实时进度", function () {
  it("完成/冲突/待处理/百分比即时计算", function () {
    const s = session({ items: [
      { reviewId: "rv1", lockedVersion: 1,
        conclusion: { result: "confirm", by: "张三", at: NOW }, conflict: null },
      { reviewId: "rv2", lockedVersion: 3,
        conclusion: null, conflict: { code: "review_closed", at: NOW } },
      { reviewId: "rv3", lockedVersion: 1, conclusion: null, conflict: null }
    ] });
    const p = RS.sessionProgress(s, NOW);
    assert.equal(p.total, 3);
    assert.equal(p.concluded, 1);
    assert.equal(p.conflicts, 1);
    assert.equal(p.pending, 1);
    assert.equal(p.percent, 33);
    assert.equal(p.expired, false);
  });

  it("过期判定：到点即过期", function () {
    const s = session({ deadline: iso(120000) });
    assert.equal(RS.isExpired(s, iso(119999)), false);
    assert.equal(RS.isExpired(s, iso(120000)), true);
    assert.equal(RS.sessionProgress(s, iso(120001)).expired, true);
  });
});

describe("会话核心：会话报告", function () {
  it("报告结构完整（空间锚点/进度/条目/记录升序），且不修改输入", function () {
    const content = builtContent();
    const reviews = threeReviews();
    const s = session({ items: [
      { reviewId: "rv1", lockedVersion: 1, lockedStatus: "open",
        targetSummary: { kind: "event", event: { id: "ev-pub", action: "task_publish" } },
        conclusion: { result: "confirm", note: "一致", by: "张三", at: iso(70000),
          reviewVersion: 1 },
        conflict: null },
      { reviewId: "rv2", lockedVersion: 3, lockedStatus: "open",
        targetSummary: null, conclusion: null,
        conflict: { code: "updated_outside", message: "m", at: iso(71000), by: "李四" } }
    ] });
    const logs = [
      { id: "l2", sessionId: "ss1", at: iso(70000), action: "conclusion",
        actor: "张三", reviewId: "rv1" },
      { id: "l1", sessionId: "ss1", at: iso(60000), action: "create",
        actor: "负责人", reviewId: null },
      { id: "lX", sessionId: "other", at: iso(65000), action: "create",
        actor: "负责人", reviewId: null }
    ];
    const spaceJson = JSON.stringify({ s: s, reviews: reviews, logs: logs });
    const built = RS.buildReport({
      space: { id: "sp1", name: "空间一", packageId: "pkg",
        manifest: { contentHash: "h", chainHead: "c", eventCount: 4 } },
      session: s, reviews: reviews, logs: logs,
      generatedAt: iso(80000), generatedBy: "负责人"
    });
    assert.ok(built.ok, built.message);
    const rep = built.value;
    assert.equal(rep.format, "bidi-replay-review-session-report");
    assert.equal(rep.space.id, "sp1");
    assert.equal(rep.space.contentHash, "h");
    assert.equal(rep.session.id, "ss1");
    assert.equal(rep.session.progress.concluded, 1);
    assert.equal(rep.session.progress.conflicts, 1);
    assert.equal(rep.session.items.length, 2);
    assert.equal(rep.session.items[0].conclusion.resultLabel, "确认");
    assert.equal(rep.session.items[0].targetSummary.event.id, "ev-pub");
    assert.equal(rep.session.items[1].conflict.label, "意见已被会话外更新");
    assert.equal(rep.session.items[1].current.version, 3);
    // 只含本会话记录，按时间升序
    assert.deepEqual(rep.logs.map(function (l) { return l.id; }), ["l1", "l2"]);
    // 纯函数：输入未被修改
    assert.equal(JSON.stringify({ s: s, reviews: reviews, logs: logs }), spaceJson);
  });

  it("缺会话 -> session_not_found", function () {
    const built = RS.buildReport({ space: {}, session: null });
    assert.equal(built.ok, false);
    assert.equal(built.code, "session_not_found");
  });
});
