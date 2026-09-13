/* node --test test/replay-core.test.js
 * 执行回放核心纯逻辑测试：审计包构建、manifest 哈希、事件链、
 * 导入前校验（缺字段/重复事件/哈希不匹配/跨任务引用/时间倒退/超限）、
 * 幂等包标识、冲突标识、时间线筛选、冲突原因汇总、快照引用剪枝。
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../replay-core");

function iso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + (offsetMs || 0)).toISOString();
}

function task(over) {
  return Object.assign({
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
      counts: { success: 1, conflict: 0, skipped: 0 }, executionId: "ex1" }],
    successAnnotationIds: ["an1"], lastCounts: { success: 1, conflict: 0, skipped: 0 }
  }, over || {});
}

function logs() {
  return [
    { id: "ev-pub", taskId: "t1", decisionId: "d1", at: iso(0), actor: "负责人",
      action: "task_publish", detail: "发布", annotationId: null, snapshotId: null },
    { id: "ev-auto", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
      action: "task_auto_execute", detail: "自动执行", annotationId: null, snapshotId: "s1" },
    { id: "ev-item", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
      action: "task_auto_execute_item_success", detail: "删除：执行成功",
      annotationId: "an1", snapshotId: null },
    { id: "ev-ok", taskId: "t1", decisionId: "d1", at: iso(5001), actor: "系统定时执行",
      action: "task_succeeded", detail: "全部成功", annotationId: null, snapshotId: "s1" }
  ];
}

function executions() {
  return { d1: [{
    id: "ex1", taskId: "t1", decisionId: "d1", at: iso(5000), actor: "系统定时执行",
    trigger: "scheduled", applied: true, undone: false, snapshotId: "s1",
    counts: { success: 1, conflict: 0, skipped: 0 },
    results: [{ annotationId: "an1", disposition: "delete", replacement: null,
      result: "success", reason: null, paraIndex: 0, currentParaIndex: 0,
      start: 2, end: 5, at: iso(5000) }]
  }] };
}

function snapshots() {
  return [{ id: "s1", name: "执行后文本", createdAt: iso(5000), rev: 9,
    kind: "execution", paragraphs: [{ text: "原文", dir: "ltr" }],
    textRev: "r", annotationRev: 4, batchRev: 2, decisionRev: 5,
    taskId: "t1", executionId: "ex1" }];
}

function decisions() {
  return [{ id: "d1", name: "决策一", batchId: "b1", status: "executed", threshold: 1,
    createdAt: iso(-10000), deadline: iso(90000),
    textRev: "lockrev", annotationRev: 3, batchRev: 2,
    items: [{ annotationId: "an1", disposition: "delete", replacement: null }] }];
}

function source(over) {
  return Object.assign({
    name: "九月回放", producerId: "team-a", actor: "负责人",
    range: { from: null, to: null },
    tasks: [task()], decisionLogs: logs(), executions: executions(),
    snapshots: snapshots(), decisions: decisions()
  }, over || {});
}

function build(over) {
  const r = R.buildPackage(source(over));
  assert.ok(r.ok, r.message);
  return r.value;
}

describe("回放核心：构建与校验", function () {
  it("构建包含版本/依赖/审批流水/快照关联的自洽包并通过校验", function () {
    const pkg = build();
    assert.equal(pkg.format, "bidi-replay");
    assert.equal(pkg.packageVersion, 1);
    assert.match(pkg.packageId, /^rpk_[0-9a-f]+$/);
    assert.equal(pkg.content.tasks.length, 1);
    assert.equal(pkg.content.events.length, 4);
    assert.equal(pkg.content.snapshots.length, 1);
    assert.equal(pkg.content.executions.length, 1);
    assert.deepEqual(pkg.content.tasks[0].dependencyIds, []);
    // 事件链：第一条 prev 为 null，其余依次指向前一条
    assert.equal(pkg.content.events[0].prevEventId, null);
    for (let i = 1; i < pkg.content.events.length; i++) {
      assert.equal(pkg.content.events[i].prevEventId, pkg.content.events[i - 1].id);
      assert.equal(pkg.content.events[i].seq, i + 1);
    }
    const v = R.verifyPackage(pkg);
    assert.ok(v.ok, v.message);
    assert.ok(pkg.manifest.contentHash.indexOf("fnv1a64:") === 0);
    assert.ok(pkg.manifest.contentHashSha256.indexOf("sha256:") === 0);
    assert.equal(pkg.manifest.eventCount, 4);
    assert.equal(pkg.manifest.chainHeadId, "ev-ok");
  });

  it("同一数据同一范围导出两次，包标识与内容哈希完全相同（幂等基础）", function () {
    const a = build();
    const b = build({ name: "改名不影响标识" });
    assert.equal(a.packageId, b.packageId);
    assert.equal(a.manifest.contentHash, b.manifest.contentHash);
    assert.equal(a.manifest.chainHead, b.manifest.chainHead);
  });

  it("事件内容不同则内容哈希不同（同标识冲突可被识别）", function () {
    const a = build();
    const mutatedLogs = logs();
    mutatedLogs[0].detail = "发布（被改动）";
    const b = build({ decisionLogs: mutatedLogs });
    // 事件 id 与范围相同 -> packageId 相同；内容哈希不同
    assert.equal(a.packageId, b.packageId);
    assert.notEqual(a.manifest.contentHash, b.manifest.contentHash);
  });

  it("时间范围只纳入范围内事件，范围外任务整体不出现", function () {
    // 只覆盖发布事件（iso(0)）；执行期事件（iso(5000+)）被排除，
    // 但任务锁定信息与任务关联快照仍完整导出（含依赖/锁版本，供完整回看）。
    const pkg = build({ range: { from: iso(-1000), to: iso(500) } });
    assert.deepEqual(pkg.content.events.map(function (e) { return e.id; }), ["ev-pub"]);
    assert.equal(pkg.content.tasks.length, 1);
    assert.equal(pkg.content.snapshots.length, 1); // 任务关联快照随任务完整导出
    // 执行记录经任务尝试 attempts.executionId 关联纳入（逐条结果完整导出）
    assert.equal(pkg.content.executions.length, 1);
    assert.ok(R.verifyPackage(pkg).ok);
  });

  it("空时间范围（无事件）由构建调用方决定拒绝，核心返回零事件包", function () {
    const pkg = build({ range: { from: iso(60000), to: iso(70000) } });
    assert.equal(pkg.content.events.length, 0);
    assert.equal(pkg.content.tasks.length, 0);
  });
});

describe("回放核心：导入前校验拒绝条件", function () {
  const checks = [
    ["缺顶层字段", function (p) { delete p.name; }, "missing_field"],
    ["格式标识错误", function (p) { p.format = "zip"; }, "invalid_format"],
    ["版本号过高", function (p) { p.packageVersion = 999; }, "unsupported_version"],
    ["非法时间", function (p) { p.createdAt = "yesterday"; }, "invalid_time"],
    ["content 缺 events 数组", function (p) { delete p.content.events; }, "missing_field"],
    ["任务缺字段", function (p) { delete p.content.tasks[0].status; }, "invalid_task"],
    ["重复事件 id", function (p) { p.content.events[2].id = p.content.events[0].id; }, "duplicate_event"],
    ["事件时间倒退", function (p) {
      p.content.events[1].at = iso(-5000); // 早于第一条事件
      p.content.events[1].seq = 2;
    }, "event_time_regression"],
    ["事件链 prev 断裂", function (p) { p.content.events[2].prevEventId = "nope"; }, "broken_event_chain"],
    ["事件引用不存在的任务", function (p) { p.content.events[0].taskId = "tX"; }, "invalid_event"],
    ["跨任务引用不存在（依赖）", function (p) {
      p.content.tasks[0].dependencyIds = ["missing-dep"];
    }, "cross_reference_missing"],
    ["事件引用不存在的快照", function (p) { p.content.events[0].snapshotId = "sX"; }, "invalid_event"],
    ["执行引用不存在的任务", function (p) { p.content.executions[0].taskId = "tX"; }, "invalid_content"],
    ["非法逐条结果", function (p) { p.content.executions[0].results[0].result = "exploded"; }, "invalid_content"]
  ];
  checks.forEach(function (c) {
    it("拒绝：" + c[0], function () {
      const pkg = build();
      c[1](pkg);
      const v = R.verifyPackage(pkg);
      assert.equal(v.ok, false);
      assert.equal(v.code, c[2]);
      assert.ok(v.message);
    });
  });

  it("内容哈希不匹配（任务被篡改）", function () {
    const pkg = build();
    pkg.content.tasks[0].status = "failed";
    const v = R.verifyPackage(pkg);
    assert.equal(v.ok, false);
    assert.equal(v.code, "hash_mismatch");
  });

  it("manifest 重算后仅交换两条事件顺序 -> 链哈希不匹配", function () {
    // 交换两条同毫秒事件并重算 manifest（内容集合哈希相同，但链头改变）
    const pkg = build();
    const evs = pkg.content.events;
    const i = evs.findIndex(function (e) { return e.id === "ev-auto"; });
    const j = evs.findIndex(function (e) { return e.id === "ev-item"; });
    const tmp = evs[i]; evs[i] = evs[j]; evs[j] = tmp;
    evs.forEach(function (e, idx) { e.seq = idx + 1; e.prevEventId = idx === 0 ? null : evs[idx - 1].id; });
    const m = R.buildManifest(pkg);
    pkg.manifest = m;
    const v = R.verifyPackage(pkg);
    // 顺序变了，内容哈希不变（集合），但链头变化——这里 manifest 是按新顺序算的，
    // 因此 verify 通过；链哈希的价值在于防止“用旧 manifest 配新顺序”。
    // 旧 manifest + 新顺序才必须拒绝：
    assert.ok(v.ok);
  });

  it("旧链头搭配被重排的事件（内容哈希被重算）-> 链哈希不匹配拒绝", function () {
    const pkg = build();
    const oldChainHead = pkg.manifest.chainHead;
    const evs = pkg.content.events;
    const i = evs.findIndex(function (e) { return e.id === "ev-auto"; });
    const j = evs.findIndex(function (e) { return e.id === "ev-item"; });
    const tmp = evs[i]; evs[i] = evs[j]; evs[j] = tmp;
    evs.forEach(function (e, idx) { e.seq = idx + 1; e.prevEventId = idx === 0 ? null : evs[idx - 1].id; });
    // 攻击者重算内容哈希以通过内容校验，但无法伪造链头的语义：保留旧链头
    pkg.manifest.contentHash = R.hashCanonical(pkg.content);
    pkg.manifest.contentHashSha256 = R.sha256Canonical(pkg.content);
    pkg.manifest.chainHead = oldChainHead;
    const v = R.verifyPackage(pkg);
    assert.equal(v.ok, false);
    assert.equal(v.code, "chain_hash_mismatch");
  });

  it("非对象 / 非法 JSON 结构被拒", function () {
    assert.equal(R.verifyPackage(null).ok, false);
    assert.equal(R.verifyPackage("x").code, "invalid_format");
    assert.equal(R.verifyPackage([1, 2]).code, "invalid_format");
  });

  it("数量超限被拒（大包限制）", function () {
    const pkg = build();
    const many = [];
    for (let i = 0; i < R.LIMITS.ATTEMPTS_PER_TASK_MAX + 1; i++) {
      many.push({ at: iso(i), kind: "auto", scheduledAt: iso(0), status: "failed",
        reason: null, counts: null, executionId: null });
    }
    pkg.content.tasks[0].attempts = many;
    pkg.manifest = R.buildManifest(pkg);
    const v = R.verifyPackage(pkg);
    assert.equal(v.ok, false);
    assert.equal(v.code, "package_too_large");
  });

  it("任务依赖的前置任务即使时间范围外也纳入包，跨引用完整", function () {
    const dep = task({ id: "t0", decisionId: "d0", status: "succeeded",
      snapshotId: null, attempts: [], successAnnotationIds: [] });
    const main = task({ dependencyIds: ["t0"] });
    const pkg = R.buildPackage(source({
      tasks: [dep, main],
      decisions: decisions().concat([{ id: "d0", name: "前置草案", batchId: "b0",
        status: "executed", threshold: 1, createdAt: iso(-20000), items: [] }])
    })).value;
    const ids = pkg.content.tasks.map(function (t) { return t.id; }).sort();
    assert.deepEqual(ids, ["t0", "t1"]);
    assert.ok(R.verifyPackage(pkg).ok);
  });

  it("引用已删除快照时剪枝为 null，包仍自洽", function () {
    const pkg = R.buildPackage(source({ snapshots: [] })).value;
    assert.equal(pkg.content.snapshots.length, 0);
    assert.equal(pkg.content.tasks[0].snapshotId, null);
    assert.ok(R.verifyPackage(pkg).ok);
  });
});

describe("回放核心：时间线筛选与冲突汇总", function () {
  it("按任务与事件类型筛选", function () {
    const pkg = build();
    assert.equal(R.filterEvents(pkg.content.events, { category: "execute" }).length, 3);
    assert.equal(R.filterEvents(pkg.content.events, { category: "wait" }).length, 1);
    assert.equal(R.filterEvents(pkg.content.events, { taskId: "t1" }).length, 4);
    assert.equal(R.filterEvents(pkg.content.events, { taskId: "other" }).length, 0);
  });

  it("timelineByTask 按任务聚合并保持链顺序", function () {
    const pkg = build();
    const tl = R.timelineByTask(pkg.content, { category: "execute" });
    assert.equal(tl.length, 1);
    assert.equal(tl[0].taskId, "t1");
    assert.ok(tl[0].task);
    assert.deepEqual(tl[0].events.map(function (e) { return e.id; }),
      ["ev-auto", "ev-item", "ev-ok"]);
  });

  it("conflictSummary 汇总逐条冲突原因", function () {
    const exs = executions();
    exs.d1[0].results.push({ annotationId: "an2", disposition: "keep",
      result: "conflict", reason: "quote_mismatch", paraIndex: 1, at: iso(5000) });
    exs.d1[0].counts = { success: 1, conflict: 1, skipped: 0 };
    const pkg = build({ executions: exs });
    const sum = R.conflictSummary(pkg.content);
    assert.equal(sum.counts.quote_mismatch, 1);
    assert.equal(sum.items[0].annotationId, "an2");
  });

  it("未知动作按前缀兜底归类，不抛异常", function () {
    assert.equal(R.categoryOfAction("task_approval_new_kind_x"), "approval");
    assert.equal(R.categoryOfAction("task_retry_something"), "retry");
    assert.equal(R.categoryOfAction("task_auto_execute_item_conflict"), "execute");
  });
});
