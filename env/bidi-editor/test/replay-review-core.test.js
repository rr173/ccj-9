/* node --test test/replay-review-core.test.js
 * 历史证据复核核心纯逻辑测试：引用目标解析（锁定事件/逐条结果）、
 * 新建/修改/转派/关闭校验、重复意见判定、截止时间与状态枚举、
 * 按状态/复核人/截止时间筛选、时间线与冲突项标记挂载、复核清单构建。
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../replay-core");
const RR = require("../replay-review-core");

function iso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + (offsetMs || 0)).toISOString();
}

// 复用 replay-core 的构建链路得到一份“已导入锁定内容”
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
    { id: "ev-item-cf", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
      action: "task_auto_execute_item_conflict", detail: "冲突",
      annotationId: "an2", executionId: "ex1", snapshotId: null },
    { id: "ev-ok", taskId: "t1", decisionId: "d1", at: iso(5001), actor: "系统定时执行",
      action: "task_succeeded", detail: "部分成功", annotationId: null, snapshotId: "s1" }
  ];
  const executions = { d1: [{
    id: "ex1", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
    trigger: "scheduled", applied: true, undone: false, snapshotId: "s1",
    counts: { success: 1, conflict: 1, skipped: 0 },
    results: [
      { annotationId: "an1", disposition: "delete", replacement: null,
        result: "success", reason: null, paraIndex: 0, currentParaIndex: 0,
        start: 2, end: 5, at: iso(5000) },
      { annotationId: "an2", disposition: "keep", replacement: null,
        result: "conflict", reason: "quote_mismatch", paraIndex: 1,
        currentParaIndex: 1, start: 0, end: 1, at: iso(5000) }
    ]
  }] };
  const snapshots = [{ id: "s1", name: "执行后文本", createdAt: iso(5000), rev: 9,
    kind: "execution", paragraphs: [{ text: "原文", dir: "ltr" }],
    textRev: "r", annotationRev: 4, batchRev: 2, decisionRev: 5,
    taskId: "t1", executionId: "ex1" }];
  const decisions = [{ id: "d1", name: "决策一", batchId: "b1", status: "executed",
    threshold: 1, createdAt: iso(-10000), deadline: iso(90000),
    textRev: "lockrev", annotationRev: 3, batchRev: 2,
    items: [
      { annotationId: "an1", disposition: "delete", replacement: null },
      { annotationId: "an2", disposition: "keep", replacement: null }
    ] }];
  const built = R.buildPackage({
    name: "复核用回放", producerId: "team-a", actor: "负责人",
    range: { from: null, to: null },
    tasks: [task], decisionLogs: logs, executions: executions,
    snapshots: snapshots, decisions: decisions
  });
  assert.ok(built.ok, built.message);
  return built.value.content;
}

const NOW = iso(60000);

function review(over) {
  return Object.assign({
    id: "rv1", version: 1, status: "open", reviewer: "甲",
    dueAt: iso(90000), content: "请核对该事件", createdBy: "负责人",
    createdAt: NOW, updatedAt: null, closedAt: null, closedBy: null,
    closeReason: null, targetKey: "event:ev-pub",
    target: { kind: "event", eventId: "ev-pub" }
  }, over || {});
}

describe("复核核心：引用目标解析", function () {
  const content = builtContent();

  it("锁定事件引用可解析", function () {
    const f = RR.findTarget(content, { kind: "event", eventId: "ev-auto" });
    assert.ok(f);
    assert.equal(f.kind, "event");
    assert.equal(f.event.action, "task_auto_execute");
  });

  it("事件不存在 -> 校验拒绝 review_target_not_found", function () {
    const v = RR.validateCreate({
      target: { kind: "event", eventId: "ghost" },
      reviewer: "甲", content: "x", dueAt: iso(90000)
    }, content, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.code, "review_target_not_found");
  });

  it("逐条结果引用按 executionId+annotationId 解析", function () {
    const f = RR.findTarget(content,
      { kind: "result", executionId: "ex1", annotationId: "an2" });
    assert.ok(f);
    assert.equal(f.kind, "result");
    assert.equal(f.result.result, "conflict");
    assert.equal(f.result.reason, "quote_mismatch");
  });

  it("结果不存在 / 执行记录不存在 -> 拒绝", function () {
    const v1 = RR.validateCreate({
      target: { kind: "result", executionId: "ex1", annotationId: "nope" },
      reviewer: "甲", content: "x", dueAt: iso(90000)
    }, content, NOW);
    assert.equal(v1.ok, false);
    assert.equal(v1.code, "review_target_not_found");
    const v2 = RR.validateCreate({
      target: { kind: "result", executionId: "exX", annotationId: "an1" },
      reviewer: "甲", content: "x", dueAt: iso(90000)
    }, content, NOW);
    assert.equal(v2.code, "review_target_not_found");
  });

  it("非法引用类型或缺字段明确拒绝", function () {
    assert.equal(RR.validateCreate({
      target: { kind: "snapshot", id: "s1" },
      reviewer: "甲", content: "x", dueAt: iso(90000)
    }, content, NOW).code, "invalid_target");
    assert.equal(RR.validateCreate({
      target: { kind: "event" },
      reviewer: "甲", content: "x", dueAt: iso(90000)
    }, content, NOW).code, "invalid_target");
    assert.equal(RR.validateCreate({
      target: { kind: "result", executionId: "ex1" },
      reviewer: "甲", content: "x", dueAt: iso(90000)
    }, content, NOW).code, "invalid_target");
    assert.equal(RR.validateCreate({
      reviewer: "甲", content: "x", dueAt: iso(90000)
    }, content, NOW).code, "missing_target");
  });

  it("targetKey 对 event/result 稳定生成", function () {
    assert.equal(RR.targetKey({ kind: "event", eventId: "e1" }), "event:e1");
    assert.equal(RR.targetKey({ kind: "result", executionId: "ex1", annotationId: "a1" }),
      "result:ex1:a1");
    assert.equal(RR.targetKey({ kind: "event" }), null);
  });
});

describe("复核核心：新建输入校验", function () {
  const content = builtContent();

  it("合法事件意见通过", function () {
    const v = RR.validateCreate({
      target: { kind: "event", eventId: "ev-pub" },
      reviewer: "  甲  ", content: "  请复核发布时间  ",
      dueAt: iso(90000)
    }, content, NOW);
    assert.ok(v.ok, v.message);
    assert.equal(v.value.reviewer, "甲");
    assert.equal(v.value.content, "请复核发布时间");
    assert.equal(v.value.status, "open");
    assert.equal(v.value.targetKey, "event:ev-pub");
  });

  it("缺复核人 / 空内容 / 缺截止时间", function () {
    const base = { target: { kind: "event", eventId: "ev-pub" },
      reviewer: "甲", content: "x", dueAt: iso(90000) };
    assert.equal(RR.validateCreate(
      Object.assign({}, base, { reviewer: "  " }), content, NOW).code, "missing_reviewer");
    assert.equal(RR.validateCreate(
      Object.assign({}, base, { content: "" }), content, NOW).code, "missing_content");
    assert.equal(RR.validateCreate(
      Object.assign({}, base, { dueAt: null }), content, NOW).code, "missing_due");
  });

  it("截止时间必须合法且在未来", function () {
    const base = { target: { kind: "event", eventId: "ev-pub" },
      reviewer: "甲", content: "x" };
    assert.equal(RR.validateCreate(
      Object.assign({}, base, { dueAt: "tomorrow" }), content, NOW).code, "invalid_due");
    assert.equal(RR.validateCreate(
      Object.assign({}, base, { dueAt: iso(0) }), content, NOW).code, "due_in_past");
  });

  it("不能直接创建为 closed；非法状态拒绝", function () {
    const v = RR.validateCreate({
      target: { kind: "event", eventId: "ev-pub" },
      reviewer: "甲", content: "x", dueAt: iso(90000), status: "closed"
    }, content, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.code, "invalid_status");
    assert.equal(RR.validateCreate({
      target: { kind: "event", eventId: "ev-pub" },
      reviewer: "甲", content: "x", dueAt: iso(90000), status: "nope"
    }, content, NOW).code, "invalid_status");
  });

  it("超长复核人/内容拒绝", function () {
    const v = RR.validateCreate({
      target: { kind: "event", eventId: "ev-pub" },
      reviewer: new Array(RR.LIMITS.REVIEWER_MAX_CHARS + 2).join("x"),
      content: "x", dueAt: iso(90000)
    }, content, NOW);
    assert.equal(v.code, "reviewer_too_long");
    const v2 = RR.validateCreate({
      target: { kind: "event", eventId: "ev-pub" },
      reviewer: "甲",
      content: new Array(RR.LIMITS.CONTENT_MAX_CHARS + 2).join("x"),
      dueAt: iso(90000)
    }, content, NOW);
    assert.equal(v2.code, "review_too_large");
  });
});

describe("复核核心：修改/转派/关闭校验", function () {
  it("至少修改一项，空 patch 拒绝", function () {
    assert.equal(RR.validatePatch({}, NOW).code, "empty_patch");
    assert.equal(RR.validatePatch({ content: "  " }, NOW).code, "missing_content");
  });

  it("可改内容/状态/截止；不能经 patch 关闭；截止仍须未来", function () {
    const v = RR.validatePatch({
      content: "新内容", status: "in_review", dueAt: iso(120000)
    }, NOW);
    assert.ok(v.ok);
    assert.equal(v.value.content, "新内容");
    assert.equal(v.value.status, "in_review");
    assert.equal(RR.validatePatch({ status: "closed" }, NOW).code, "invalid_status");
    assert.equal(RR.validatePatch({ status: "bad" }, NOW).code, "invalid_status");
    assert.equal(RR.validatePatch({ dueAt: iso(0) }, NOW).code, "due_in_past");
  });

  it("转派必须给新复核人", function () {
    assert.equal(RR.validateReassign({ reviewer: " " }).code, "missing_reviewer");
    const v = RR.validateReassign({ reviewer: " 乙 " });
    assert.ok(v.ok);
    assert.equal(v.value.reviewer, "乙");
  });

  it("关闭说明超长拒绝", function () {
    assert.equal(RR.validateCloseReason(
      new Array(RR.LIMITS.CLOSE_REASON_MAX_CHARS + 2).join("x")).code,
      "review_too_large");
    assert.deepEqual(RR.validateCloseReason(undefined).value, null);
    assert.deepEqual(RR.validateCloseReason("  ").value, null);
  });
});

describe("复核核心：重复意见", function () {
  it("同一目标上的未关闭意见算重复；关闭后与排除自身都不算", function () {
    const key = "event:ev-pub";
    const open1 = review({ id: "rv1", status: "open", targetKey: key });
    const closed = review({ id: "rv2", status: "closed", targetKey: key });
    const other = review({ id: "rv3", status: "open", targetKey: "event:ev-auto" });
    const reviews = [open1, closed, other];
    assert.equal(RR.findDuplicate(reviews, key), open1);
    assert.equal(RR.findDuplicate(reviews, key, "rv1"), null);
    assert.equal(RR.findDuplicate(reviews, "event:ev-auto"), other);
    // 关闭意见不阻止在该目标上重新提复核
    assert.equal(RR.findDuplicate([closed], key), null);
  });
});

describe("复核核心：筛选", function () {
  const content = builtContent();
  const reviews = [
    review({ id: "rv1", status: "open", reviewer: "甲", dueAt: iso(70000),
      target: { kind: "event", eventId: "ev-pub" }, targetKey: "event:ev-pub" }),
    review({ id: "rv2", version: 2, status: "in_review", reviewer: "乙",
      dueAt: iso(120000), target: { kind: "event", eventId: "ev-auto" },
      targetKey: "event:ev-auto" }),
    review({ id: "rv3", status: "confirmed", reviewer: "甲", dueAt: iso(200000),
      target: { kind: "result", executionId: "ex1", annotationId: "an2" },
      targetKey: "result:ex1:an2" }),
    review({ id: "rv4", status: "closed", reviewer: "丙", dueAt: iso(80000),
      target: { kind: "result", executionId: "ex1", annotationId: "an1" },
      targetKey: "result:ex1:an1", closedAt: iso(65000) })
  ];

  it("按状态筛选", function () {
    assert.deepEqual(RR.filterReviews(reviews, { status: "open" }).map(function (r) {
      return r.id;
    }), ["rv1"]);
    assert.deepEqual(RR.filterReviews(reviews, { status: "closed" }).map(function (r) {
      return r.id;
    }), ["rv4"]);
  });

  it("按复核人精确筛选", function () {
    assert.deepEqual(RR.filterReviews(reviews, { reviewer: "甲" }).map(function (r) {
      return r.id;
    }).sort(), ["rv1", "rv3"]);
    assert.equal(RR.filterReviews(reviews, { reviewer: "不存在" }).length, 0);
  });

  it("按截止时间区间筛选", function () {
    assert.deepEqual(RR.filterReviews(reviews, {
      dueFrom: iso(100000), dueTo: iso(250000)
    }).map(function (r) { return r.id; }).sort(), ["rv2", "rv3"]);
    assert.deepEqual(RR.filterReviews(reviews, { dueTo: iso(80000) })
      .map(function (r) { return r.id; }).sort(), ["rv1", "rv4"]);
  });

  it("按引用类型筛选", function () {
    assert.deepEqual(RR.filterReviews(reviews, { targetKind: "result" })
      .map(function (r) { return r.id; }).sort(), ["rv3", "rv4"]);
  });

  it("非法筛选条件拒绝", function () {
    assert.equal(RR.normalizeFilters({ status: "x" }).code, "invalid_status");
    assert.equal(RR.normalizeFilters({ dueFrom: "x" }).code, "invalid_due");
    assert.equal(RR.normalizeFilters({ targetKind: "snapshot" }).code, "invalid_target");
    assert.equal(RR.normalizeFilters({
      dueFrom: iso(200000), dueTo: iso(100000)
    }).code, "invalid_range");
  });

  it("时间线标记：event 意见挂事件，result 意见挂对应逐条事件", function () {
    const groups = R.timelineByTask(content, {});
    RR.attachTimelineReviews(groups, reviews, content);
    const evs = groups[0].events;
    const byId = Object.create(null);
    evs.forEach(function (e) { byId[e.id] = e; });
    assert.deepEqual(byId["ev-pub"].reviews.map(function (r) { return r.id; }), ["rv1"]);
    assert.deepEqual(byId["ev-auto"].reviews.map(function (r) { return r.id; }), ["rv2"]);
    assert.deepEqual(byId["ev-item-cf"].reviews.map(function (r) { return r.id; }), ["rv3"]);
    assert.deepEqual(byId["ev-item-ok"].reviews.map(function (r) { return r.id; }), ["rv4"]);
    assert.equal(byId["ev-ok"].reviews.length, 0);
    // 标记是轻量结构
    assert.equal(byId["ev-pub"].reviews[0].status, "open");
    assert.equal(byId["ev-pub"].reviews[0].reviewer, "甲");
  });

  it("冲突汇总项挂复核标记", function () {
    const sum = R.conflictSummary(content);
    RR.attachConflictReviews(sum, reviews);
    assert.equal(sum.items.length, 1);
    assert.equal(sum.items[0].annotationId, "an2");
    assert.deepEqual(sum.items[0].reviews.map(function (r) { return r.id; }), ["rv3"]);
  });

  it("筛选同样作用于时间线/冲突挂载", function () {
    const groups = R.timelineByTask(content, {});
    RR.attachTimelineReviews(groups, RR.filterReviews(reviews, { status: "open" }), content);
    const byId = Object.create(null);
    groups[0].events.forEach(function (e) { byId[e.id] = e; });
    assert.equal(byId["ev-pub"].reviews.length, 1);
    assert.equal(byId["ev-auto"].reviews.length, 0);
  });
});

describe("复核核心：复核清单", function () {
  const content = builtContent();
  const space = {
    id: "sp1", name: "复核用回放", packageId: "rpk_x", producerId: "team-a",
    range: { from: null, to: null }, importedAt: iso(10000), importedBy: "负责人乙",
    manifest: { contentHash: "fnv1a64:abc", chainHead: "fnv1a64:def", eventCount: 5 }
  };
  const reviews = [
    review({ id: "rv1", status: "open", reviewer: "甲", dueAt: iso(70000),
      target: { kind: "event", eventId: "ev-pub" }, targetKey: "event:ev-pub" }),
    review({ id: "rv2", version: 3, status: "closed", reviewer: "乙",
      dueAt: iso(120000), closedAt: iso(65000), closedBy: "负责人",
      closeReason: "证据一致",
      target: { kind: "result", executionId: "ex1", annotationId: "an2" },
      targetKey: "result:ex1:an2" })
  ];
  const reviewLogs = [
    { id: "log1", reviewId: "rv2", at: iso(61000), action: "assign",
      actor: "负责人", from: { reviewer: "甲" }, to: { reviewer: "乙" } },
    { id: "log0", reviewId: "rv2", at: iso(60000), action: "create",
      actor: "负责人", to: { status: "open" } },
    { id: "log2", reviewId: "rv2", at: iso(65000), action: "close",
      actor: "负责人", to: { status: "closed", closeReason: "证据一致" } }
  ];

  it("清单含空间锚点、筛选条件、完整目标快照与按时间排序的状态变化记录", function () {
    const built = RR.buildChecklist({
      space: space, content: content, reviews: reviews, reviewLogs: reviewLogs,
      filters: {}, generatedAt: NOW, generatedBy: "负责人"
    });
    assert.ok(built.ok, built.message);
    const cl = built.value;
    assert.equal(cl.format, "bidi-replay-review-checklist");
    assert.equal(cl.count, 2);
    assert.equal(cl.space.contentHash, "fnv1a64:abc");
    assert.equal(cl.space.chainHead, "fnv1a64:def");
    const rv2 = cl.reviews.find(function (r) { return r.id === "rv2"; });
    assert.equal(rv2.target.kind, "result");
    assert.equal(rv2.target.result.reason, "quote_mismatch");
    assert.equal(rv2.target.execution.taskId, "t1");
    assert.deepEqual(rv2.history.map(function (h) { return h.action; }),
      ["create", "assign", "close"]);
    const rv1 = cl.reviews.find(function (r) { return r.id === "rv1"; });
    assert.equal(rv1.target.kind, "event");
    assert.equal(rv1.target.event.action, "task_publish");
  });

  it("逾期标记只对未关闭且过期的意见生效", function () {
    const built = RR.buildChecklist({
      space: space, content: content, reviews: reviews,
      filters: {}, generatedAt: iso(80000)
    });
    const byId = Object.create(null);
    built.value.reviews.forEach(function (r) { byId[r.id] = r; });
    assert.equal(byId.rv1.overdue, true);   // dueAt 70000 < now 80000 且未关闭
    assert.equal(byId.rv2.overdue, false);  // 已关闭
  });

  it("清单应用筛选且不改变输入", function () {
    const before = JSON.stringify(reviews);
    const built = RR.buildChecklist({
      space: space, content: content, reviews: reviews, reviewLogs: reviewLogs,
      filters: { status: "closed" }, generatedAt: NOW
    });
    assert.ok(built.ok);
    assert.equal(built.value.count, 1);
    assert.equal(built.value.reviews[0].id, "rv2");
    assert.equal(JSON.stringify(reviews), before);
  });

  it("引用目标在锁定内容中缺失时清单条目 target 为 null（空间内容不可变，防御性）", function () {
    const dangling = [review({ target: { kind: "event", eventId: "ghost" },
      targetKey: "event:ghost" })];
    const built = RR.buildChecklist({
      space: space, content: content, reviews: dangling, filters: {}, generatedAt: NOW
    });
    assert.ok(built.ok);
    assert.equal(built.value.reviews[0].target, null);
  });
});
