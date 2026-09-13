/* 零依赖开发服务器：静态文件 + 审阅快照 JSON API + 协作批注 JSON API
 * 运行：node server.js [port]
 *
 * 存储：
 *   快照 data/snapshots.json   （SNAPSHOTS_FILE 覆盖）
 *   批注 data/annotations.json （ANNOTATIONS_FILE 覆盖）
 *   批次 data/review-batches.json（REVIEW_BATCHES_FILE 覆盖）
 *
 * 乐观并发（多页面/多人同时操作）：
 *   快照集合、批注集合、审阅批次集合、审阅决策集合各有单调递增的 rev；
 *   快照响应带 X-Snapshot-Rev，批注响应带 X-Annotation-Rev，
 *   批次响应带 X-Batch-Rev，决策响应带 X-Decision-Rev；
 *   所有变更类请求必须带 If-Match: <对应集合 rev>，服务端要求严格相等，
 *   否则 409 version_conflict 且不写盘——旧页面无法覆盖别人的新状态。
 *   批次内成员状态变更同时推进“批注 rev”和“批次 rev”，因此批次页面
 *   持旧批次版本做批量更新时，只要期间任何人改过成员状态都会被拒绝。
 *
 * 审阅决策（草案/投票/执行）：
 *   决策集合有独立 rev（X-Decision-Rev）。执行前按条目同时校验文本版本
 *   （客户端回传当前段落，服务端比对草案文本指纹）、批注版本（updatedAt）
 *   与批次版本（成员归属），只把受影响条目标为冲突，一次执行可部分成功。
 *   决策状态、投票与执行结果在保存快照时整体嵌入，历史快照可见当时草案。
 *
 * 批次约束：
 *   同一条批注最多属于一个“未归档”批次；归档批次的成员状态永久冻结
 *   （不能改状态、不能删除、不能移出），完整历史可在审阅记录中查看。
 *
 * 快照与批注的关联：
 *   保存/覆盖快照时，服务端把当前批注集合（含解决状态与回复）整体嵌入
 *   快照记录（annotations 字段 + annotationRev），查看历史快照即可看到
 *   当时存在的批注及其状态。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./snapshot-core");
const review = require("./review-core");
const decision = require("./decision-core");
const replay = require("./replay-core");
const replayReview = require("./replay-review-core");

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DATA_FILE = process.env.SNAPSHOTS_FILE ||
  path.join(ROOT, "data", "snapshots.json");
const ANN_FILE = process.env.ANNOTATIONS_FILE ||
  path.join(ROOT, "data", "annotations.json");
const BATCH_FILE = process.env.REVIEW_BATCHES_FILE ||
  path.join(ROOT, "data", "review-batches.json");
const DECISION_FILE = process.env.REVIEW_DECISIONS_FILE ||
  path.join(ROOT, "data", "review-decisions.json");
const REPLAY_FILE = process.env.REPLAY_SPACES_FILE ||
  path.join(ROOT, "data", "replay-spaces.json");
const REQUEST_BODY_LIMIT = 4 * 1024 * 1024; // 传输字节上限（校验逻辑另有字符上限）
// 审计包内含锁定文本，允许更大的导入请求体（可用环境变量覆盖）
const REPLAY_BODY_LIMIT = Number(process.env.REPLAY_BODY_LIMIT_BYTES) ||
  32 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

/* ================= 快照存储 ================= */

const store = { rev: 0, snapshots: [] };

function persist(cb) {
  const tmp = DATA_FILE + ".tmp";
  fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, function () {
    fs.writeFile(tmp, JSON.stringify(store), function (err) {
      if (err) { cb(err); return; }
      fs.rename(tmp, DATA_FILE, cb); // 同目录原子替换
    });
  });
}

try {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const data = JSON.parse(raw);
  if (Number.isInteger(data.rev) && Array.isArray(data.snapshots)) {
    store.rev = data.rev;
    store.snapshots = data.snapshots;
  }
} catch (e) {
  // 文件不存在/损坏：以空存储启动（损坏文件不覆盖，首次保存才写盘）
}

function summary(s) {
  const anns = Array.isArray(s.annotations) ? s.annotations : [];
  return {
    id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt,
    paragraphCount: s.paragraphs.length,
    charCount: s.paragraphs.reduce(function (n, p) { return n + core.cpLen(p.text); }, 0),
    annotationCount: anns.length,
    openAnnotationCount: anns.filter(function (a) { return a.status !== "resolved"; }).length
  };
}
function publicStore() {
  return { rev: store.rev, snapshots: store.snapshots.map(summary) };
}
function publicFull(s) {
  return {
    id: s.id, name: s.name, rev: store.rev,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    paragraphs: s.paragraphs,
    // 快照保存时刻的批注集合（可能为 null：该快照创建于批注功能上线前）
    annotations: Array.isArray(s.annotations) ? s.annotations : null,
    annotationRev: Number.isInteger(s.annotationRev) ? s.annotationRev : null,
    // 快照保存时刻的决策草案（可能为 null：该快照创建于决策功能上线前）
    decisions: Array.isArray(s.decisions) ? s.decisions : null,
    decisionRev: Number.isInteger(s.decisionRev) ? s.decisionRev : null,
    // 快照保存时刻的执行队列（可能为 null：该快照创建于定时执行功能上线前）
    executionTasks: Array.isArray(s.executionTasks) ? s.executionTasks : null,
    taskId: s.taskId || null,
    executionId: s.executionId || null
  };
}

function findId(id) {
  return store.snapshots.find(function (s) { return s.id === id; });
}
function findName(name, exceptId) {
  return store.snapshots.find(function (s) {
    return s.name === name && s.id !== exceptId;
  });
}

/* ================= 批注存储 ================= */

const annStore = { rev: 0, annotations: [] };

function persistAnnotations(cb) {
  const tmp = ANN_FILE + ".tmp";
  fs.mkdir(path.dirname(ANN_FILE), { recursive: true }, function () {
    fs.writeFile(tmp, JSON.stringify(annStore), function (err) {
      if (err) { cb(err); return; }
      fs.rename(tmp, ANN_FILE, cb);
    });
  });
}

try {
  const rawAnn = fs.readFileSync(ANN_FILE, "utf8");
  const dataAnn = JSON.parse(rawAnn);
  if (Number.isInteger(dataAnn.rev) && Array.isArray(dataAnn.annotations)) {
    annStore.rev = dataAnn.rev;
    annStore.annotations = dataAnn.annotations;
  }
} catch (e) {
  // 同快照存储：损坏文件不覆盖
}

function findAnn(id) {
  return annStore.annotations.find(function (a) { return a.id === id; });
}

function publicAnnotations() {
  return { rev: annStore.rev, annotations: annStore.annotations };
}

/* ================= 审阅批次存储 ================= */

const batchStore = { rev: 0, batches: [], logs: [] };

function persistBatches(cb) {
  const tmp = BATCH_FILE + ".tmp";
  fs.mkdir(path.dirname(BATCH_FILE), { recursive: true }, function () {
    fs.writeFile(tmp, JSON.stringify(batchStore), function (err) {
      if (err) { cb(err); return; }
      fs.rename(tmp, BATCH_FILE, cb);
    });
  });
}

try {
  const rawBatch = fs.readFileSync(BATCH_FILE, "utf8");
  const dataBatch = JSON.parse(rawBatch);
  if (Number.isInteger(dataBatch.rev) && Array.isArray(dataBatch.batches)) {
    batchStore.rev = dataBatch.rev;
    batchStore.batches = dataBatch.batches;
    batchStore.logs = Array.isArray(dataBatch.logs) ? dataBatch.logs : [];
  }
} catch (e) {
  // 同其他存储：文件不存在/损坏时以空存储启动，不覆盖旧文件
}

function findBatch(id) {
  return batchStore.batches.find(function (b) { return b.id === id; });
}

// 批注 id -> 其当前所属批次（成员归属以批次的 memberIds 为准，
// 批注记录上的 batchId/batchName 仅作冗余展示并随此函数同步）。
function batchByMemberIndex() {
  const idx = Object.create(null);
  batchStore.batches.forEach(function (b) {
    (b.memberIds || []).forEach(function (id) {
      if (!idx[id]) idx[id] = b; // 理论唯一；防御性保留首个
    });
  });
  return idx;
}

// 批注记录上的批次冗余字段与批次成员表对账（启动与整库恢复后调用）
function syncAnnotationBatchFields() {
  const idx = batchByMemberIndex();
  annStore.annotations.forEach(function (a) {
    const b = idx[a.id];
    if (b) {
      a.batchId = b.id;
      a.batchName = b.name;
    } else {
      a.batchId = null;
      a.batchName = null;
    }
  });
}

// 批次审阅记录：负责人/截止时间/说明/成员/状态变化全部留痕，可按时间查看。
// logs 只增不改（归档后仍可查），超长后丢弃最旧记录。
function addBatchLog(entry) {
  batchStore.logs.push({
    id: entry.id || crypto.randomUUID(),
    batchId: entry.batchId || null,
    batchName: entry.batchName || null,
    at: entry.at || new Date().toISOString(),
    actor: entry.actor || "匿名",
    action: entry.action,
    detail: entry.detail || null,
    annotationId: entry.annotationId || null
  });
  if (batchStore.logs.length > review.LIMITS.BATCH_LOG_MAX) {
    batchStore.logs.splice(0, batchStore.logs.length - review.LIMITS.BATCH_LOG_MAX);
  }
}

function batchSummary(b) {
  const p = review.batchProgress(b, annMap());
  return {
    id: b.id,
    name: b.name,
    owner: b.owner,
    deadline: b.deadline,
    description: b.description,
    status: b.status,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    archivedAt: b.archivedAt || null,
    archivedBy: b.archivedBy || null,
    memberCount: b.memberIds.length,
    progress: p,
    overdue: review.batchOverdue(b)
  };
}

function annMap() {
  const m = Object.create(null);
  annStore.annotations.forEach(function (a) { m[a.id] = a; });
  return m;
}

function publicBatches() {
  return {
    rev: batchStore.rev,
    batches: batchStore.batches
      .slice()
      .sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); })
      .map(batchSummary)
  };
}

function publicBatchFull(b) {
  const map = annMap();
  // 活批次展示成员批注的实时状态；归档批次展示归档瞬间冻结的成员快照
  const source = b.status === "archived" && Array.isArray(b.memberSnapshot)
    ? b.memberSnapshot
    : b.memberIds.map(function (id) { return map[id]; }).filter(Boolean);
  const members = source.map(function (a) {
    return {
      id: a.id, author: a.author, body: a.body,
      paraIndex: a.paraIndex, start: a.start, end: a.end,
      quote: a.quote, paraDir: a.paraDir,
      status: review.validAnnStatus(a.status) ? a.status : "open",
      createdAt: a.createdAt, updatedAt: a.updatedAt,
      resolvedAt: a.resolvedAt || null, resolvedBy: a.resolvedBy || null,
      replyCount: Array.isArray(a.replies) ? a.replies.length : 0,
      exists: b.status === "archived" ? true : !!map[a.id]
    };
  });
  return {
    rev: batchStore.rev,
    batch: batchSummary(b),
    members: members,
    // 归档批次返回归档瞬间冻结的完整批注内容，供“查看完整历史”
    frozen: b.status === "archived",
    // 该批次关联的决策草案（只读概要，详情走 /api/review-decisions/:id）
    decisionIds: decisionIndexOfBatch(b.id)
  };
}

/* ================= 审阅决策存储 ================= */

const decisionStore = { rev: 0, decisions: [], logs: [], tasks: [] };

function persistDecisions(cb) {
  const tmp = DECISION_FILE + ".tmp";
  fs.mkdir(path.dirname(DECISION_FILE), { recursive: true }, function () {
    fs.writeFile(tmp, JSON.stringify(decisionStore), function (err) {
      if (err) { cb(err); return; }
      fs.rename(tmp, DECISION_FILE, cb);
    });
  });
}

try {
  const raw = fs.readFileSync(DECISION_FILE, "utf8");
  const data = JSON.parse(raw);
  if (Number.isInteger(data.rev) && Array.isArray(data.decisions)) {
    decisionStore.rev = data.rev;
    decisionStore.decisions = data.decisions;
    decisionStore.logs = Array.isArray(data.logs) ? data.logs : [];
    decisionStore.tasks = Array.isArray(data.tasks) ? data.tasks : [];
  }
} catch (e) {
  // 文件不存在/损坏：以空存储启动，损坏文件不覆盖
}

function findDecision(id) {
  return decisionStore.decisions.find(function (d) { return d.id === id; });
}

function findTask(id) {
  return decisionStore.tasks.find(function (t) { return t.id === id; });
}

function activeTaskOfDecision(decisionId) {
  return decisionStore.tasks.find(function (t) {
    return t.decisionId === decisionId && decision.taskIsActive(t);
  });
}

// 执行队列日志：发布/暂停/恢复/取消/自动执行/重试都进同一本决策日志，
// 带 taskId，既可按草案也可按时间统一筛选。
function addTaskLog(task, action, detail, extra) {
  const entry = Object.assign({
    decisionId: task.decisionId,
    decisionName: task.decisionName,
    batchId: task.batchId,
    batchName: task.batchName,
    action: action,
    detail: detail,
    annotationId: null,
    taskId: task.id
  }, extra || {});
  addDecisionLog(entry);
  return entry;
}

function decisionIndexOfBatch(batchId) {
  return decisionStore.decisions
    .filter(function (d) { return d.batchId === batchId; })
    .map(function (d) { return d.id; });
}

// 决策审阅记录：草案创建/方案修改/投票/提交/执行/撤销/执行队列全部留痕，可按时间查看。
function addDecisionLog(entry) {
  const rec = {
    id: entry.id || crypto.randomUUID(),
    decisionId: entry.decisionId || null,
    decisionName: entry.decisionName || null,
    batchId: entry.batchId || null,
    batchName: entry.batchName || null,
    at: entry.at || new Date().toISOString(),
    actor: entry.actor || "匿名",
    action: entry.action,
    detail: entry.detail || null,
    annotationId: entry.annotationId || null,
    // 执行队列任务关联（发布/暂停/恢复/取消/自动执行/重试/依赖/审批）
    taskId: entry.taskId || null,
    snapshotId: entry.snapshotId || null
  };
  decisionStore.logs.push(rec);
  if (decisionStore.logs.length > decision.LIMITS.LOG_MAX) {
    decisionStore.logs.splice(0, decisionStore.logs.length - decision.LIMITS.LOG_MAX);
  }
  return rec;
}

/* ---------- 决策集合统一提交（可带关联快照） ----------
 * 调用前所有内存改动（含 decisionStore.rev 之外的领域对象、日志）已完成；
 * 本函数负责 rev++、先快照落盘（若有）再决策落盘，失败时整体回滚。
 * 回滚由调用方提供 domainRollback：恢复领域对象并移除本次新增日志。
 */
function commitDecisionStore(opts, cb) {
  const domainRollback = opts.domainRollback || function () {};
  const pendingSnapshot = opts.snapshot || null;
  function restoreAll() {
    domainRollback();
    decisionStore.rev--;
    if (pendingSnapshot) {
      const i = store.snapshots.indexOf(pendingSnapshot);
      if (i !== -1) { store.snapshots.splice(i, 1); store.rev--; }
    }
  }
  function finish() {
    decisionStore.rev++;
    persistDecisions(function (err) {
      if (err) {
        restoreAll();
        if (cb) cb(false, err);
        return;
      }
      if (cb) cb(true);
    });
  }
  if (pendingSnapshot) {
    pendingSnapshot.decisions = decision.decisionDigest(decisionStore.decisions);
    pendingSnapshot.decisionRev = decisionStore.rev + 1;
    pendingSnapshot.executionTasks = decision.taskDigest(decisionStore.tasks);
    store.snapshots.push(pendingSnapshot);
    store.rev++;
    persist(function (serr) {
      if (serr) {
        const i = store.snapshots.indexOf(pendingSnapshot);
        if (i !== -1) { store.snapshots.splice(i, 1); store.rev--; }
        restoreAll();
        if (cb) cb(false, serr);
        return;
      }
      finish();
    });
    return;
  }
  finish();
}

/* ---------- 执行前审批快照 ----------
 * 配置审批的任务（发布时或之后配置时）自动保存一份“执行前审批”文本快照，
 * 之后的审批通过/拒绝/撤回记录都关联这份快照，满足“审批记录关联对应快照”。
 */
function buildApprovalSnapshot(task, now, reason) {
  const d = findDecision(task.decisionId);
  const paras = (task.lock && Array.isArray(task.lock.paragraphs))
    ? task.lock.paragraphs : (d && d.baselineParagraphs) || [];
  const batchLookup = new Map(
    batchStore.batches.map(function (b) {
      return [b.id, { id: b.id, name: b.name, status: b.status }];
    }));
  return {
    id: crypto.randomUUID(),
    name: "执行前审批 " + task.decisionName + "（" +
      now.replace(/[:T]/g, "-").slice(0, 19) + "）",
    createdAt: now,
    updatedAt: now,
    paragraphs: paras,
    annotations: review.snapshotDigest(annStore.annotations, batchLookup),
    annotationRev: annStore.rev,
    // decisions/executionTasks/decisionRev 在提交前一刻统一填充
    decisions: null,
    decisionRev: null,
    executionTasks: null,
    source: "task_approval",
    taskId: task.id,
    approvalReason: reason || "configured"
  };
}

/* ---------- 前置门控级联 ----------
 * 重新计算所有活动任务的门控，把变化写回任务（持久化，服务重启后据此恢复），
 * 并对“阻断 / 解除阻断 / 等待负责人确认继续”产生队列日志。
 *
 * 幂等：门控状态未变化时不写任何字段、不产生日志、不推进 rev；
 * 同一事务内可重复调用。返回 {changed, logs, prev} 供事务回滚。
 */
function reconcileTaskGates(actor) {
  const gates = decision.computeGates(decisionStore.tasks);
  const logs = [];
  const prev = [];
  let changed = false;
  const now = new Date().toISOString();

  decisionStore.tasks.forEach(function (t) {
    const gate = gates[t.id];
    if (!gate) return; // 终态任务不参与门控
    const oldState = t.gateState || null;
    const oldReason = t.gateReason || null;
    if (oldState === gate.state && oldReason === (gate.reason || null)) return;

    prev.push({
      task: t,
      gateState: t.gateState, gateReason: t.gateReason,
      gateDependencyState: t.gateDependencyState, gateAt: t.gateAt,
      gateDependencies: t.gateDependencies, gateBlockingDependency: t.gateBlockingDependency,
      gateContinueConfirmations: t.gateContinueConfirmations
    });
    decision.persistGateOnTask(t, gate);
    changed = true;

    const blocking = gate.blockingDependency;
    const snapRef = blocking
      ? (blocking.snapshotId || null)
      : (t.approvalSnapshotId || null);
    let le = null;
    if (gate.state === "blocked") {
      le = addTaskLog(t, "task_dependency_blocked",
        "前置条件未通过，任务被阻断：" + describeDependencyBlock(gate) +
        "；排除原因（重试/修改前置任务配置）后将自动解除阻断，不会在计划时间误执行",
        { snapshotId: snapRef, actor: actor || "系统" });
    } else if (oldState === "blocked" &&
               (gate.state === "waiting" || gate.state === "can_continue" ||
                gate.state === "approvals" || gate.state === "ready")) {
      le = addTaskLog(t, "task_dependency_unblocked",
        "前置阻断已解除，当前：" + (decision.GATE_STATE_LABELS[gate.state] || gate.state),
        { snapshotId: snapRef, actor: actor || "系统" });
    } else if (gate.state === "can_continue") {
      le = addTaskLog(t, "task_dependency_can_continue",
        "前置任务“" + (blocking ? blocking.decisionName : "—") +
        "”仅部分成功，任务暂不自动执行；请由负责人确认后继续（到点不会误执行）",
        { snapshotId: snapRef, actor: actor || "系统" });
    }
    // waiting/approvals/rejected/ready 的日常流转直接体现在任务门控字段与
    // 队列/详情的“等待原因”上，不逐条刷屏；审批通过/拒绝/撤回另有专门记录。
    if (le) logs.push(le);
  });

  return {
    changed: changed,
    logs: logs,
    prev: prev,
    rollback: function () {
      prev.forEach(function (p) {
        p.task.gateState = p.gateState;
        p.task.gateReason = p.gateReason;
        p.task.gateDependencyState = p.gateDependencyState;
        p.task.gateAt = p.gateAt;
        p.task.gateDependencies = p.gateDependencies;
        p.task.gateBlockingDependency = p.gateBlockingDependency;
        p.task.gateContinueConfirmations = p.gateContinueConfirmations;
      });
      logs.forEach(function (le) {
        const i = decisionStore.logs.indexOf(le);
        if (i !== -1) decisionStore.logs.splice(i, 1);
      });
    }
  };
}

function describeDependencyBlock(gate) {
  const b = gate.blockingDependency;
  if (!b) return "前置任务状态异常";
  const name = b.decisionName || b.taskId.slice(0, 8);
  if (b.reason === "dependency_cancelled" ||
      (b.via == null && b.status === "cancelled")) {
    return "前置任务“" + name + "”已取消";
  }
  if (b.reason === "dependency_blocked" ||
      (b.via == null && b.status === "blocked")) {
    return "前置任务“" + name + "”已阻断";
  }
  if (b.via) {
    return "前置链上的任务未通过（经 " + name + "）";
  }
  return "前置任务“" + name + "”状态为“" +
    (decision.TASK_STATUS_LABELS[b.status] || b.status) + "”";
}

// 门控状态 → 人类可读等待原因（日志与队列展示共用口径）
function describeGateForLog(gate) {
  if (gate.state === "ready") return "前置条件已满足";
  if (gate.state === "approvals") {
    return "等待执行前审批（已通过 " + gate.approval.approved + "/" +
      gate.approval.minApprovals + "）";
  }
  if (gate.state === "rejected") return "执行前审批被拒绝";
  if (gate.state === "can_continue") {
    return "前置任务“" + (gate.blockingDependency ? gate.blockingDependency.decisionName : "—") +
      "”仅部分成功，需负责人确认继续";
  }
  if (gate.state === "waiting") return describeDependencyBlock(gate) + "，等待其完成或重试";
  if (gate.state === "blocked") return describeDependencyBlock(gate);
  return gate.state;
}

function decisionItemSummary(it, threshold) {
  const tally = decision.tallyVotes(it.votes);
  return {
    annotationId: it.annotationId,
    paraIndex: it.paraIndex, start: it.start, end: it.end,
    quote: it.quote, paraDir: it.paraDir,
    disposition: it.disposition,
    replacement: it.replacement,
    state: decision.itemState(it, threshold),
    approve: tally.counts.approve,
    reject: tally.counts.reject,
    abstain: tally.counts.abstain,
    voters: tally.voters,
    annotationUpdatedAt: it.annotationUpdatedAt || null
  };
}

function decisionSummary(d, gates) {
  const p = decision.decisionProgress(d);
  const batch = findBatch(d.batchId);
  const task = activeTaskOfDecision(d.id);
  return {
    id: d.id, batchId: d.batchId, batchName: d.batchName,
    name: d.name, status: d.status, threshold: d.threshold,
    createdAt: d.createdAt, updatedAt: d.updatedAt,
    submittedAt: d.submittedAt || null, readyAt: d.readyAt || null,
    scheduledAt: d.scheduledAt || null,
    deadline: d.deadline || null,
    itemCount: d.items.length,
    progress: p,
    frozen: !!(batch && batch.status === "archived"),
    overdue: decision.isOverdue(d.deadline) && d.status !== "executed",
    executed: d.status === "executed",
    activeTaskId: d.activeTaskId || (task ? task.id : null) || null,
    task: task ? decision.taskSummary(task, gates ? gates[task.id] : null) : null,
    lastExecutionId: d.lastExecutionId || null
  };
}

function publicDecisions(batchId) {
  var gates = decision.computeGates(decisionStore.tasks);
  var list = decisionStore.decisions.slice()
    .filter(function (d) { return !batchId || d.batchId === batchId; })
    .sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); })
    .map(function (d) { return decisionSummary(d, gates); });
  return { rev: decisionStore.rev, decisions: list };
}

function publicDecisionFull(d) {
  const batch = findBatch(d.batchId);
  const task = activeTaskOfDecision(d.id);
  const gates = decision.computeGates(decisionStore.tasks);
  return {
    rev: decisionStore.rev,
    decision: decisionSummary(d, gates),
    batchFrozen: !!(batch && batch.status === "archived"),
    batchStatus: batch ? batch.status : null,
    annotationRev: d.annotationRev,
    batchRev: d.batchRev,
    textRev: d.textRev,
    activeTask: task ? decision.taskSummary(task, gates[task.id]) : null,
    items: d.items.map(function (it) {
      var s = decisionItemSummary(it, d.threshold);
      s.votes = (it.votes || []).slice().sort(function (a, b) {
        return (a.at || "").localeCompare(b.at || "");
      });
      return s;
    }),
    executions: (d.executions || []).map(function (ex) {
      return {
        id: ex.id, at: ex.at, actor: ex.actor, applied: ex.applied,
        trigger: ex.trigger || "manual",
        taskId: ex.taskId || null,
        snapshotId: ex.snapshotId || null,
        undone: !!ex.undone, undoneAt: ex.undoneAt || null,
        counts: ex.counts,
        resultCount: (ex.results || []).length
      };
    })
  };
}

/* ================= 决策执行引擎（手动执行与定时执行共用） =================
 *
 * runDecisionExecution 在调用前已完成：
 *   - 决策集合 rev 闸门（HTTP 请求由 If-Match 保证；调度器是服务端自身触发）；
 *   - 批次未归档、草案未过期、状态允许执行（ready）。
 * 本函数只做：三版本逐条校验 → 标记成功批注为已解决 → 写执行记录与逐条记录。
 * 不调用 persistDecisions：由调用方决定落盘时机（手动执行要能整体回滚；
 * 调度器要先持久化再异步处理批注/批次）。返回值包含所有变更前后状态，
 * 供调用方在写盘失败时精确回滚。
 */
function runDecisionExecution(d, currentParas, opts) {
  opts = opts || {};
  const batch = findBatch(d.batchId);
  const now = (opts.at) || new Date().toISOString();
  const actor = opts.actor || "系统定时执行";
  const trigger = opts.trigger || "manual"; // manual | scheduled | retry
  const selected = opts.selectedIds || null;
  const skipIds = opts.skipAnnotationIds
    ? new Set(opts.skipAnnotationIds) : null;

  let selectedIds = selected;
  if (skipIds) {
    // 幂等重试：已在之前尝试中成功的条目不再参与执行（绝不重复处理成功条目）
    selectedIds = d.items
      .map(function (it) { return it.annotationId; })
      .filter(function (id) { return !skipIds.has(id); });
  }

  const plan = decision.planExecution(d, currentParas, annMap(),
    batch ? batch.memberIds : [], selectedIds);
  // 幂等重试：之前已经成功的条目不再算“本次成功”，标记 already_done 跳过，
  // 不重复解决批注、不重复合成文本。
  if (skipIds) {
    plan.results.forEach(function (r) {
      if (skipIds.has(r.annotationId)) {
        r.result = "skipped";
        r.reason = "already_done";
        if (r.currentParaIndex === undefined) r.currentParaIndex = null;
      }
    });
    plan.counts = { success: 0, conflict: 0, skipped: 0 };
    plan.results.forEach(function (r) { plan.counts[r.result]++; });
  }
  const afterParas = decision.applyPlan(currentParas, plan.results);

  const successIds = plan.results.filter(function (r) { return r.result === "success"; })
    .map(function (r) { return r.annotationId; });
  const annBackups = successIds.map(function (aid) {
    const a = findAnn(aid);
    return { ann: a, status: a.status, resolvedAt: a.resolvedAt,
             resolvedBy: a.resolvedBy, updatedAt: a.updatedAt };
  });
  successIds.forEach(function (aid) {
    const a = findAnn(aid);
    a.status = "resolved";
    a.resolvedAt = now;
    a.resolvedBy = actor;
    a.updatedAt = now;
  });
  if (successIds.length) annStore.rev++;
  let batchRevBumped = false;
  if (batch && successIds.some(function (aid) {
    return batch.memberIds.indexOf(aid) !== -1;
  })) {
    batch.updatedAt = now;
    batchStore.rev++;
    batchRevBumped = true;
  }

  const applied = successIds.length > 0;
  const ex = {
    id: crypto.randomUUID(),
    at: now,
    actor: actor,
    trigger: trigger,
    taskId: opts.taskId || null,
    snapshotId: null, // 定时执行成功后由调用方关联自动保存的快照
    applied: applied,
    undone: false,
    undoneAt: null,
    textRevBefore: plan.currentTextRev,
    textRevAfter: decision.textContentRev(afterParas),
    annotationRevBefore: d.annotationRev,
    batchRevBefore: d.batchRev,
    // 成功执行前的段落（供撤销时把编辑区恢复回来）
    beforeParagraphs: applied ? currentParas : null,
    counts: plan.counts,
    results: plan.results.map(function (r) {
      return {
        annotationId: r.annotationId,
        disposition: r.disposition,
        replacement: r.replacement,
        result: r.result,
        reason: r.reason,
        paraIndex: r.paraIndex,
        currentParaIndex: r.currentParaIndex == null ? null : r.currentParaIndex,
        start: r.start, end: r.end,
        at: now
      };
    }),
    undo: null
  };

  const prevStatus = d.status;
  const prevLastExec = d.lastExecutionId;
  const prevUpdated = d.updatedAt;
  d.executions.push(ex);
  d.lastExecutionId = ex.id;
  d.updatedAt = now;
  if (applied && opts.markExecuted !== false) {
    // 一次部分成功也视为该草案已执行：成功部分固化，冲突/跳过条目记录在案
    d.status = "executed";
  }

  // 总记录 + 逐条记录；定时执行/重试携带 taskId，可按任务筛选
  const logEntries = [];
  const taskIdForLog = trigger === "manual" ? null : (opts.taskId || null);
  const logAction = trigger === "manual" ? "execute"
    : trigger === "retry" ? "task_retry_execute" : "task_auto_execute";
  logEntries.push({
    decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
    at: now, actor: actor,
    action: logAction,
    detail: (trigger === "manual" ? "执行决策" :
             trigger === "retry" ? "失败重试执行" : "到达生效时间，服务端自动执行") +
      "：成功 " + plan.counts.success + " 条、冲突 " + plan.counts.conflict +
      " 条、跳过 " + plan.counts.skipped + " 条" +
      (plan.textChanged ? "；检测到文本版本已变化（" +
        plan.baselineTextRev.slice(0, 8) + " → " + plan.currentTextRev.slice(0, 8) + "）" : "") +
      (applied ? "" : "（没有可成功执行的条目）") +
      (opts.taskId ? "；执行队列任务 " + opts.taskId.slice(0, 8) : ""),
    annotationId: null,
    taskId: taskIdForLog
  });
  plan.results.forEach(function (r) {
    logEntries.push({
      decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
      at: now, actor: actor,
      action: logAction + "_item_" + r.result,
      detail: decision.DISPOSITION_LABELS[r.disposition] || r.disposition + "：" +
        (r.result === "success" ? "执行成功"
         : r.result === "conflict" ? "冲突（" + (decision.REASON_LABELS[r.reason] || r.reason) + "）"
         : "跳过（" + (decision.REASON_LABELS[r.reason] || r.reason) + "）"),
      annotationId: r.annotationId,
      taskId: taskIdForLog
    });
  });
  logEntries.forEach(addDecisionLog);

  return {
    ex: ex,
    plan: plan,
    afterParas: afterParas,
    successIds: successIds,
    annBackups: annBackups,
    batchRevBumped: batchRevBumped,
    logEntries: logEntries,
    rollback: function () {
      annBackups.forEach(function (bk) {
        bk.ann.status = bk.status; bk.ann.resolvedAt = bk.resolvedAt;
        bk.ann.resolvedBy = bk.resolvedBy; bk.ann.updatedAt = bk.updatedAt;
      });
      if (successIds.length) annStore.rev--;
      if (batchRevBumped) batchStore.rev--;
      d.status = prevStatus; d.lastExecutionId = prevLastExec;
      d.updatedAt = prevUpdated;
      const i = d.executions.indexOf(ex);
      if (i !== -1) d.executions.splice(i, 1);
      logEntries.forEach(function (le) {
        const li = decisionStore.logs.indexOf(le);
        if (li !== -1) decisionStore.logs.splice(li, 1);
      });
    }
  };
}

/* ================= 执行回放：审计包导出 / 导入 / 回放空间 =================
 *
 * 回放模块与线上批次、决策、执行队列完全隔离：
 *   - 导出（POST /api/replay/export）只读取线上数据生成自洽审计包，绝不写线上数据；
 *   - 导入只把通过全部校验的审计包写入独立的 replayStore（data/replay-spaces.json），
 *     绝不触碰 batchStore / decisionStore / annStore / store；
 *   - 回放视图只有 GET 接口与筛选条件保存，没有任何暂停 / 审批 / 执行入口；
 *   - 导入校验全部在写盘之前完成，失败时记录失败原因，空间不会被部分写入；
 *   - 同一审计包导入两次幂等；不同包但 packageId 相同返回 409 replay_conflict。
 */

const replayStore = {
  rev: 0,
  spaces: [],     // 已导入的回放空间（锁定的审计包 + 视图状态）
  failures: []    // 导入失败记录（保留失败原因，重启后仍可查）
};

function persistReplay(cb) {
  const tmp = REPLAY_FILE + ".tmp";
  fs.mkdir(path.dirname(REPLAY_FILE), { recursive: true }, function () {
    fs.writeFile(tmp, JSON.stringify(replayStore), function (err) {
      if (err) { cb(err); return; }
      fs.rename(tmp, REPLAY_FILE, cb); // 同目录原子替换
    });
  });
}

try {
  const rawReplay = fs.readFileSync(REPLAY_FILE, "utf8");
  const dataReplay = JSON.parse(rawReplay);
  if (Number.isInteger(dataReplay.rev) && Array.isArray(dataReplay.spaces)) {
    replayStore.rev = dataReplay.rev;
    replayStore.spaces = dataReplay.spaces;
    replayStore.failures = Array.isArray(dataReplay.failures) ? dataReplay.failures : [];
    // 历史证据复核（旧版数据文件缺这些字段，启动时补齐，锁定内容 content 永不变更）
    replayStore.spaces.forEach(function (sp) {
      if (!Array.isArray(sp.reviews)) sp.reviews = [];
      if (!Array.isArray(sp.reviewLogs)) sp.reviewLogs = [];
    });
  }
} catch (e) {
  // 文件不存在/损坏：以空存储启动，损坏文件不覆盖
}

function findReplaySpace(id) {
  return replayStore.spaces.find(function (s) { return s.id === id; });
}

function addReplayFailure(record) {
  replayStore.failures.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actor: record.actor || "匿名",
    name: record.name || null,
    packageId: record.packageId || null,
    producerId: record.producerId || null,
    code: record.code,
    message: record.message,
    errors: Array.isArray(record.errors) ? record.errors.slice(0, 50) : []
  });
  if (replayStore.failures.length > 200) {
    replayStore.failures.splice(0, replayStore.failures.length - 200);
  }
}

// 回放空间对外视图：包内容是锁定的历史；view 是该空间保存的筛选条件
function publicReplaySpace(sp) {
  return {
    id: sp.id,
    rev: sp.rev,
    packageId: sp.packageId,
    producerId: sp.producerId,
    name: sp.name,
    format: sp.format,
    packageVersion: sp.packageVersion,
    schemaVersion: sp.schemaVersion,
    importedAt: sp.importedAt,
    importedBy: sp.importedBy,
    exportedAt: sp.exportedAt,
    range: sp.range,
    manifest: sp.manifest,
    view: sp.view || { taskId: "", category: "", action: "", annotationId: "" },
    validation: {
      verified: true,
      contentHash: sp.manifest && sp.manifest.contentHash,
      chainHead: sp.manifest && sp.manifest.chainHead,
      eventCount: sp.manifest && sp.manifest.eventCount,
      verifiedAt: sp.verifiedAt
    },
    counts: {
      tasks: sp.content.tasks.length,
      decisions: sp.content.decisions.length,
      executions: sp.content.executions.length,
      events: sp.content.events.length,
      snapshots: sp.content.snapshots.length,
      reviews: (sp.reviews || []).length,
      openReviews: (sp.reviews || []).filter(function (r) {
        return r.status !== "closed";
      }).length
    },
    reviews: (sp.reviews || []).map(publicReview),
    content: sp.content // 锁定的完整历史内容
  };
}

function publicReplaySummary(sp) {
  const c = sp.content;
  return {
    id: sp.id,
    rev: sp.rev,
    packageId: sp.packageId,
    producerId: sp.producerId,
    name: sp.name,
    packageVersion: sp.packageVersion,
    importedAt: sp.importedAt,
    importedBy: sp.importedBy,
    exportedAt: sp.exportedAt,
    range: sp.range,
    view: sp.view || { taskId: "", category: "", action: "", annotationId: "" },
    manifest: {
      contentHash: sp.manifest.contentHash,
      chainHead: sp.manifest.chainHead,
      eventCount: sp.manifest.eventCount
    },
    counts: {
      tasks: c.tasks.length,
      decisions: c.decisions.length,
      executions: c.executions.length,
      events: c.events.length,
      snapshots: c.snapshots.length,
      reviews: (sp.reviews || []).length,
      openReviews: (sp.reviews || []).filter(function (r) {
        return r.status !== "closed";
      }).length
    }
  };
}

/* ================= 历史证据复核 =================
 *
 * 复核意见挂在回放空间上（reviews + reviewLogs），与审计包锁定内容严格隔离：
 *   - content（事件/结果/快照）导入后永不被任何复核操作改动；
 *   - 意见必须引用空间内锁定的事件（kind=event）或逐条结果（kind=result），
 *     每次写入都重新对锁定内容解析，目标不存在一律拒绝；
 *   - 双重乐观并发：空间 rev（If-Match）+ 意见 version（expectedVersion），
 *     已关闭意见拒绝修改/转派，旧页面无法覆盖关闭结论；
 *   - 所有写操作先校验、再改内存、最后原子落盘，失败回滚；
 *   - 复核流程只读写 replayStore，绝不调用线上暂停/审批/执行接口；
 *   - 复核清单导出是纯只读计算，失败不触碰意见与空间。
 */

function publicReview(r) {
  return {
    id: r.id,
    version: r.version,
    target: r.target,
    targetKey: r.targetKey,
    status: r.status,
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

function findSpaceReview(sp, reviewId) {
  return (sp.reviews || []).find(function (r) { return r.id === reviewId; }) || null;
}

function addReviewLogs(sp, entries) {
  entries.forEach(function (e) { sp.reviewLogs.push(e); });
  if (sp.reviewLogs.length > replayReview.LIMITS.REVIEW_LOGS_PER_SPACE_MAX) {
    sp.reviewLogs.splice(0,
      sp.reviewLogs.length - replayReview.LIMITS.REVIEW_LOGS_PER_SPACE_MAX);
  }
}

function reviewLogEntry(reviewId, action, actor, from, to) {
  return {
    id: crypto.randomUUID(),
    reviewId: reviewId,
    at: new Date().toISOString(),
    action: action, // create/update/close/reassign
    actor: actor,
    from: from || null,
    to: to || null
  };
}

// 从查询参数/已保存视图提取复核筛选条件（空串表示不过滤）
function reviewFiltersFrom(source) {
  source = source || {};
  return {
    status: source.rvStatus || "",
    reviewer: source.rvReviewer || "",
    dueFrom: source.rvDueFrom || "",
    dueTo: source.rvDueTo || "",
    targetKind: source.rvTargetKind || ""
  };
}

// 原子写盘 + 回滚的通用骨架：snapshot/rollback 在同步阶段准备，
// 落盘失败时恢复内存（空间 rev/意见/记录都不留下半截状态）。
function mutateReplaySpace(sp, mutator, cb) {
  const storeSnapshot = {
    rev: replayStore.rev,
    spaces: replayStore.spaces,
    failures: replayStore.failures
  };
  const spaceIndex = replayStore.spaces.indexOf(sp);
  // 深拷贝空间，失败时整对象还原（含 reviews/reviewLogs/view 等全部字段）
  const spaceBackup = JSON.parse(JSON.stringify(sp));
  let result;
  try {
    result = mutator();
  } catch (e) {
    if (spaceIndex !== -1) replayStore.spaces[spaceIndex] = spaceBackup;
    replayStore.rev = storeSnapshot.rev;
    cb({ status: 500, code: "internal_error", message: e.message });
    return;
  }
  persistReplay(function (err) {
    if (err) {
      if (spaceIndex !== -1) replayStore.spaces[spaceIndex] = spaceBackup;
      replayStore.rev = storeSnapshot.rev;
      cb({ status: 500, code: "persist_failed",
        message: "复核操作落盘失败，已回滚，意见与回放空间均未被改动" });
      return;
    }
    cb(null, result);
  });
}

function createSpaceReview(sp, body, actor, cb) {
  const now = new Date().toISOString();
  const checked = replayReview.validateCreate(body, sp.content, now);
  if (!checked.ok) {
    const status = (checked.code === "review_target_not_found") ? 404
      : (checked.code === "review_too_large") ? 413 : 400;
    cb({ status: status, code: checked.code, message: checked.message });
    return;
  }
  if ((sp.reviews || []).length >= replayReview.LIMITS.REVIEWS_PER_SPACE_MAX) {
    cb({ status: 413, code: "review_too_large",
      message: "该回放空间的复核意见已达上限 " +
        replayReview.LIMITS.REVIEWS_PER_SPACE_MAX });
    return;
  }
  const v = checked.value;
  // 同一锁定目标的重复意见：目标上已有未关闭意见时明确拒绝并指出既有意见
  const dup = replayReview.findDuplicate(sp.reviews, v.targetKey);
  if (dup) {
    cb({ status: 409, code: "duplicate_review",
      message: "该事件/结果上已有一条未关闭的复核意见（" + dup.id +
        "，状态：" + (replayReview.STATUS_LABELS[dup.status] || dup.status) +
        "）。请在原意见上更新或关闭后再提，或先将其转派。",
      existingReviewId: dup.id });
    return;
  }
  mutateReplaySpace(sp, function () {
    const r = {
      id: crypto.randomUUID(),
      version: 1,
      target: v.target,
      targetKey: v.targetKey,
      status: v.status,
      reviewer: v.reviewer,
      dueAt: v.dueAt,
      content: v.content,
      createdBy: actor,
      createdAt: now,
      updatedAt: null,
      updatedBy: null,
      closedAt: null,
      closedBy: null,
      closeReason: null
    };
    sp.reviews.push(r);
    addReviewLogs(sp, [reviewLogEntry(r.id, "create", actor, null, {
      status: r.status, reviewer: r.reviewer, dueAt: r.dueAt
    })]);
    sp.rev++;
    replayStore.rev++;
    return r;
  }, function (failure, r) {
    if (failure) { cb(failure); return; }
    cb(null, { status: 201, review: publicReview(r) });
  });
}

function updateSpaceReview(sp, rv, body, actor, cb) {
  const now = new Date().toISOString();
  const checked = replayReview.validatePatch(body, now);
  if (!checked.ok) {
    cb({ status: checked.code === "review_too_large" ? 413 : 400,
      code: checked.code, message: checked.message });
    return;
  }
  mutateReplaySpace(sp, function () {
    const changes = checked.value;
    const from = {};
    const to = {};
    if (changes.content !== undefined) { from.content = rv.content; to.content = changes.content; rv.content = changes.content; }
    if (changes.status !== undefined && changes.status !== rv.status) {
      from.status = rv.status; to.status = changes.status; rv.status = changes.status;
    }
    if (changes.dueAt !== undefined && changes.dueAt !== rv.dueAt) {
      from.dueAt = rv.dueAt; to.dueAt = changes.dueAt; rv.dueAt = changes.dueAt;
    }
    if (!Object.keys(to).length) {
      // 没有实质变化：不产生记录、不推进版本（幂等）
      return { unchanged: true, review: rv };
    }
    rv.version++;
    rv.updatedAt = now;
    rv.updatedBy = actor;
    addReviewLogs(sp, [reviewLogEntry(rv.id, "update", actor, from, to)]);
    sp.rev++;
    replayStore.rev++;
    return { unchanged: false, review: rv };
  }, function (failure, out) {
    if (failure) { cb(failure); return; }
    cb(null, { status: 200, review: publicReview(out.review), unchanged: out.unchanged });
  });
}

function closeSpaceReview(sp, rv, body, actor, cb) {
  const checked = replayReview.validateCloseReason(body && body.reason);
  if (!checked.ok) {
    cb({ status: 400, code: checked.code, message: checked.message });
    return;
  }
  mutateReplaySpace(sp, function () {
    const prev = { status: rv.status };
    rv.status = "closed";
    rv.version++;
    rv.closedAt = new Date().toISOString();
    rv.closedBy = actor;
    rv.closeReason = checked.value;
    addReviewLogs(sp, [reviewLogEntry(rv.id, "close", actor, prev, {
      status: "closed", closeReason: rv.closeReason
    })]);
    sp.rev++;
    replayStore.rev++;
    return rv;
  }, function (failure, r) {
    if (failure) { cb(failure); return; }
    cb(null, { status: 200, review: publicReview(r) });
  });
}

function reassignSpaceReview(sp, rv, body, actor, cb) {
  const checked = replayReview.validateReassign(body);
  if (!checked.ok) {
    cb({ status: 400, code: checked.code, message: checked.message });
    return;
  }
  mutateReplaySpace(sp, function () {
    if (rv.reviewer === checked.value.reviewer) {
      return { unchanged: true, review: rv };
    }
    const from = { reviewer: rv.reviewer };
    rv.reviewer = checked.value.reviewer;
    rv.version++;
    rv.updatedAt = new Date().toISOString();
    rv.updatedBy = actor;
    addReviewLogs(sp, [reviewLogEntry(rv.id, "reassign", actor, from,
      { reviewer: rv.reviewer })]);
    sp.rev++;
    replayStore.rev++;
    return { unchanged: false, review: rv };
  }, function (failure, out) {
    if (failure) { cb(failure); return; }
    cb(null, { status: 200, review: publicReview(out.review),
               unchanged: out.unchanged });
  });
}

/* ---------- 导出：从线上数据只读构建审计包 ---------- */

function buildReplayExport(payload) {
  const range = {
    from: payload.from || null,
    to: payload.to || null
  };
  if (range.from && !replay.isISODateString(range.from)) {
    return { status: 400, code: "invalid_from", message: "起始时间不是合法 ISO 时间" };
  }
  if (range.to && !replay.isISODateString(range.to)) {
    return { status: 400, code: "invalid_to", message: "结束时间不是合法 ISO 时间" };
  }
  if (range.from && range.to && Date.parse(range.from) > Date.parse(range.to)) {
    return { status: 400, code: "invalid_range", message: "起始时间晚于结束时间" };
  }

  // 执行记录按草案分组（线上 d.executions 是完整结构，逐条结果含冲突原因）
  const executionsMap = Object.create(null);
  decisionStore.decisions.forEach(function (d) {
    if (Array.isArray(d.executions) && d.executions.length) {
      executionsMap[d.id] = d.executions;
    }
  });

  const built = replay.buildPackage({
    name: payload.name,
    producerId: payload.producerId,
    packageId: payload.packageId,
    actor: payload.actor,
    range: range,
    tasks: decisionStore.tasks,
    decisionLogs: decisionStore.logs,
    executions: executionsMap,
    snapshots: store.snapshots,
    decisions: decisionStore.decisions
  });
  if (!built.ok) {
    const status = built.code === "package_too_large" ? 413 : 400;
    return { status: status, code: built.code, message: built.message };
  }
  if (!built.value.content.events.length) {
    return { status: 404, code: "empty_export",
      message: "指定时间范围内没有任何执行队列事件（任务等待/审批/执行/重试），未生成审计包" };
  }
  return { status: 200, value: built.value };
}

/* ---------- 导入：全量校验通过后一次性原子写入（cb 风格，落盘结果决定响应） ---------- */

function recordReplayFailure(rec, cb) {
  addReplayFailure(rec);
  // 失败记录落盘是尽力而为：即使再失败也不改变“空间未写入”的事实
  persistReplay(function () { if (cb) cb(); });
}

function importReplayPackage(payload, actor, cb) {
  // 1) 格式与内容哈希、事件链、引用、数量上限全部校验（先于任何写入）
  const verified = replay.verifyPackage(payload);
  if (!verified.ok) {
    recordReplayFailure({
      actor: actor,
      name: payload && payload.name,
      packageId: payload && payload.packageId,
      producerId: payload && payload.producerId,
      code: verified.code,
      message: verified.message,
      errors: verified.errors
    }, function () {
      const status = (verified.code === "package_too_large") ? 413 : 400;
      cb({ status: status, code: verified.code, message: verified.message,
           errors: verified.errors });
    });
    return;
  }
  const pkg = verified.value;

  // 2) 同包幂等 / 同标识不同包冲突
  const existing = replayStore.spaces.find(function (s) {
    return s.packageId === pkg.packageId && s.producerId === pkg.producerId;
  });
  if (existing) {
    if (existing.manifest.contentHash === pkg.manifest.contentHash &&
        existing.manifest.chainHead === pkg.manifest.chainHead) {
      // 同一审计包再次导入：幂等返回已有空间，不新建、不部分写入
      cb(null, { status: 200, value: existing, idempotent: true });
      return;
    }
    recordReplayFailure({
      actor: actor, name: pkg.name, packageId: pkg.packageId, producerId: pkg.producerId,
      code: "replay_conflict",
      message: "已存在相同标识（" + pkg.packageId + "）但内容哈希不同的审计包；" +
        "为避免覆盖锁定历史，本次导入已拒绝。已有空间：" + existing.id
    }, function () {
      cb({ status: 409, code: "replay_conflict",
        message: "审计包标识 " + pkg.packageId + " 已被另一份不同内容的包占用（" +
          existing.name + "）。同一标识只能导入同一内容；如需导入新包请重新导出以获得新标识。",
        existingSpaceId: existing.id });
    });
    return;
  }

  // 3) 构造空间（校验已过，下面不再改任何线上对象）
  const now = new Date().toISOString();
  const sp = {
    id: crypto.randomUUID(),
    rev: 1,
    packageId: pkg.packageId,
    producerId: pkg.producerId,
    name: pkg.name,
    format: pkg.format,
    packageVersion: pkg.packageVersion,
    schemaVersion: pkg.schemaVersion,
    range: pkg.range,
    manifest: pkg.manifest,
    content: pkg.content,        // 锁定的历史内容（导入后永不变更）
    // 历史证据复核：导入后在空间内产生，不属于审计包、不改变锁定内容
    reviews: [],
    reviewLogs: [],
    importedAt: now,
    importedBy: actor,
    exportedAt: pkg.exportedAt,
    verifiedAt: now,
    // 筛选条件随空间持久化：服务重启后恢复
    view: { taskId: "", category: "", action: "", annotationId: "" }
  };

  // 4) 先在内存追加，再原子落盘；落盘失败整体移除（绝不留下部分写入）
  replayStore.spaces.push(sp);
  replayStore.rev++;
  persistReplay(function (err) {
    if (err) {
      const i = replayStore.spaces.indexOf(sp);
      if (i !== -1) replayStore.spaces.splice(i, 1);
      replayStore.rev--;
      recordReplayFailure({
        actor: actor, name: pkg.name, packageId: pkg.packageId, producerId: pkg.producerId,
        code: "persist_failed", message: "回放空间落盘失败，已整体回滚：" + err.message
      }, function () {
        cb({ status: 500, code: "persist_failed",
             message: "回放空间保存失败，已整体回滚，原回放空间未被改动" });
      });
      return;
    }
    cb(null, { status: 201, value: sp, idempotent: false });
  });
}

/* ---------- 回放视图筛选条件（只影响回放空间自身，随空间持久化） ---------- */

function saveReplayView(sp, view, cb) {
  const next = {
    taskId: typeof view.taskId === "string" ? view.taskId : "",
    category: typeof view.category === "string" ? view.category : "",
    action: typeof view.action === "string" ? view.action : "",
    annotationId: typeof view.annotationId === "string" ? view.annotationId : ""
  };
  if (next.taskId &&
      !sp.content.tasks.some(function (t) { return t.id === next.taskId; })) {
    return { error: { status: 400, code: "task_not_in_package",
      message: "筛选的任务不在该审计包内" } };
  }
  if (next.category && replay.EVENT_CATEGORIES.indexOf(next.category) === -1) {
    return { error: { status: 400, code: "invalid_category",
      message: "事件类型筛选非法：" + next.category } };
  }
  if (next.action && typeof next.action !== "string") {
    return { error: { status: 400, code: "invalid_action", message: "事件动作筛选非法" } };
  }
  // 复核筛选（状态/复核人/截止时间/引用类型）同样随空间持久化，重启恢复
  const rf = replayReview.normalizeFilters({
    status: view.rvStatus, reviewer: view.rvReviewer,
    dueFrom: view.rvDueFrom, dueTo: view.rvDueTo, targetKind: view.rvTargetKind
  });
  if (!rf.ok) {
    return { error: { status: 400, code: rf.code, message: rf.message } };
  }
  next.rvStatus = rf.value.status;
  next.rvReviewer = rf.value.reviewer;
  next.rvDueFrom = rf.value.dueFrom;
  next.rvDueTo = rf.value.dueTo;
  next.rvTargetKind = rf.value.targetKind;
  sp.view = next;
  sp.rev++;
  replayStore.rev++;
  persistReplay(function (err) {
    if (err) { cb(err); return; }
    cb(null);
  });
  return null;
}

function deleteReplaySpace(sp, cb) {
  const i = replayStore.spaces.indexOf(sp);
  if (i !== -1) replayStore.spaces.splice(i, 1);
  replayStore.rev++;
  persistReplay(function (err) {
    if (err) {
      if (i !== -1) replayStore.spaces.splice(i, 0, sp);
      replayStore.rev--;
      cb(err);
      return;
    }
    cb(null);
  });
}

/* ---------- 回放 API 路由 ---------- */

function handleReplay(req, res, parts, urlObj) {
  // /api/replay/export | /api/replay/imports/import | /api/replay/spaces[/:id[/view|timeline|snapshots/:sid]] | /api/replay/failures
  const seg = parts.slice(2); // ["replay", ...] -> 去掉 "api"
  // seg[0] === "replay"

  /* ---- GET /api/replay/preview?from=&to=：导出前预览（命中任务/事件数，只读） ---- */
  if (seg[0] === "preview" && req.method === "GET") {
    const params = urlObj.searchParams;
    const from = params.get("from");
    const to = params.get("to");
    if (from && !replay.isISODateString(from)) {
      apiError(res, 400, "invalid_from", "起始时间不是合法 ISO 时间"); return;
    }
    if (to && !replay.isISODateString(to)) {
      apiError(res, 400, "invalid_to", "结束时间不是合法 ISO 时间"); return;
    }
    if (from && to && Date.parse(from) > Date.parse(to)) {
      apiError(res, 400, "invalid_range", "起始时间晚于结束时间"); return;
    }
    const taskHits = Object.create(null);
    let eventCount = 0;
    decisionStore.logs.forEach(function (l) {
      if (!l.taskId) return;
      if (!replay.inRange(l.at, from || null, to || null)) return;
      taskHits[l.taskId] = true;
      eventCount++;
    });
    // 关联的前置任务也算入预览任务数
    Object.keys(taskHits).forEach(function (tid) {
      const t = findTask(tid);
      if (t) (t.dependencyIds || []).forEach(function (d) { taskHits[d] = true; });
    });
    sendJSON(res, 200, {
      range: { from: from || null, to: to || null },
      taskCount: Object.keys(taskHits).length,
      eventCount: eventCount
    });
    return;
  }

  /* ---- POST /api/replay/export：构建并下载审计包（只读线上数据，带 ?download=1 时给附件头） ---- */
  if (seg[0] === "export" && req.method === "POST") {
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      const actor = review.validateAuthor(payload.actor).value;
      const result = buildReplayExport({
        from: payload.from, to: payload.to, name: payload.name,
        producerId: payload.producerId, actor: actor
      });
      if (result.status !== 200) {
        apiError(res, result.status, result.code, result.message);
        return;
      }
      const body = JSON.stringify(result.value, null, 2);
      const download = urlObj.searchParams.get("download") === "1";
      const headers = { "Content-Type": "application/json; charset=utf-8" };
      if (download) {
        const fname = encodeURIComponent(result.value.packageId + ".replay.json");
        headers["Content-Disposition"] =
          "attachment; filename=\"replay.json\"; filename*=UTF-8''" + fname;
      }
      res.writeHead(200, headers);
      res.end(body);
    });
    return;
  }

  /* ---- POST /api/replay/import：导入审计包到空白回放空间 ---- */
  if (seg[0] === "import" && req.method === "POST") {
    readReplayBody(req, function (err, raw) {
      if (err) {
        if (err.message === "body_too_large") {
          apiError(res, 413, "body_too_large", "审计包超过请求体大小上限");
        } else {
          apiError(res, 400, "invalid_json", "读取请求体失败");
        }
        return;
      }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) {
        recordReplayFailure({
          actor: "匿名", code: "invalid_format",
          message: "审计包不是合法 JSON：" + e.message
        }, function () {
          apiError(res, 400, "invalid_format", "审计包不是合法 JSON 文件");
        });
        return;
      }
      const actor = (payload && typeof payload.importedBy === "string")
        ? review.validateAuthor(payload.importedBy).value
        : "负责人";
      // 允许 {space: pkg} 包裹或直接提交包本体
      const pkg = (payload && payload.format === undefined && payload.package)
        ? payload.package : payload;
      importReplayPackage(pkg, actor, function (failure, outcome) {
        if (failure) {
          const extra = failure.errors ? { errors: failure.errors } : {};
          if (failure.existingSpaceId) extra.existingSpaceId = failure.existingSpaceId;
          apiError(res, failure.status, failure.code, failure.message, extra);
          return;
        }
        sendJSON(res, outcome.status, {
          space: publicReplaySummary(outcome.value),
          idempotent: outcome.idempotent
        });
      });
    });
    return;
  }

  /* ---- GET /api/replay/failures：导入失败记录（保留失败原因） ---- */
  if (seg[0] === "failures" && req.method === "GET") {
    sendJSON(res, 200, { rev: replayStore.rev,
      failures: replayStore.failures.slice().reverse() });
    return;
  }

  /* ---- 回放空间集合 / 单项 ---- */
  if (seg[0] === "spaces") {
    handleReplaySpaces(req, res, seg.slice(1), urlObj);
    return;
  }

  apiError(res, 404, "not_found", "回放接口不存在");
}

function readReplayBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on("data", function (c) {
    size += c.length;
    if (size > REPLAY_BODY_LIMIT) {
      req.destroy();
      cb(new Error("body_too_large"));
      cb = function () {};
      return;
    }
    chunks.push(c);
  });
  req.on("end", function () { cb(null, Buffer.concat(chunks).toString("utf8")); });
  req.on("error", cb);
}

function handleReplaySpaces(req, res, seg, urlObj) {
  // seg: [] | [":id"] | [":id", "view"] | [":id", "timeline"] |
  //      [":id", "snapshots", ":sid"] | [":id", "conflicts"] | [":id", "tasks"]
  if (!seg.length) {
    /* GET 列表（只含摘要，不含锁定全文，便于首屏） */
    if (req.method === "GET") {
      const list = replayStore.spaces
        .slice()
        .sort(function (a, b) { return b.importedAt.localeCompare(a.importedAt); })
        .map(publicReplaySummary);
      sendJSON(res, 200, { rev: replayStore.rev, spaces: list });
      return;
    }
    apiError(res, 405, "method_not_allowed", "仅支持 GET");
    return;
  }

  const sp = findReplaySpace(seg[0]);
  if (!sp) {
    apiError(res, 404, "replay_space_not_found", "回放空间不存在或已删除");
    return;
  }

  if (seg.length === 1 && req.method === "GET") {
    sendJSON(res, 200, { rev: replayStore.rev, space: publicReplaySpace(sp) });
    return;
  }

  if (seg.length === 1 && req.method === "DELETE") {
    deleteReplaySpace(sp, function (err) {
      if (err) { apiError(res, 500, "persist_failed", "删除失败，回放空间未被改动"); return; }
      sendJSON(res, 200, { ok: true, id: sp.id });
    });
    return;
  }

  /* PUT /spaces/:id/view：保存筛选条件（If-Match: 空间 rev） */
  if (seg.length === 2 && seg[1] === "view" && req.method === "PUT") {
    if (checkLock(res, req.headers["if-match"], sp.rev, "回放空间视图")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let view;
      try { view = JSON.parse(raw) || {}; }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      const attempt = saveReplayView(sp, view, function (perr) {
        if (perr) {
          apiError(res, 500, "persist_failed", "筛选条件保存失败，未生效");
          return;
        }
        sendJSON(res, 200, { rev: replayStore.rev,
          spaceId: sp.id, spaceRev: sp.rev, view: sp.view });
      });
      if (attempt && attempt.error) {
        const e = attempt.error;
        apiError(res, e.status, e.code, e.message);
      }
    });
    return;
  }

  /* GET /spaces/:id/timeline：按时间线返回（可 ?taskId=&category= 实时筛选，
     不带参数时回退到空间已保存的筛选条件）；复核意见按复核筛选挂标记 */
  if (seg.length === 2 && seg[1] === "timeline" && req.method === "GET") {
    const params = urlObj.searchParams;
    const saved = sp.view || {};
    const opts = {
      taskId: params.get("taskId") !== null ? params.get("taskId") : saved.taskId,
      category: params.get("category") !== null ? params.get("category") : saved.category,
      action: params.get("action") !== null ? params.get("action") : saved.action,
      annotationId: params.get("annotationId") !== null
        ? params.get("annotationId") : saved.annotationId,
      from: params.get("from"),
      to: params.get("to")
    };
    Object.keys(opts).forEach(function (k) { if (!opts[k]) opts[k] = ""; });
    if (opts.category && replay.EVENT_CATEGORIES.indexOf(opts.category) === -1) {
      apiError(res, 400, "invalid_category", "事件类型筛选非法：" + opts.category);
      return;
    }
    // 复核筛选：显式查询参数优先，否则回退已保存复核筛选
    const rfInput = {
      rvStatus: params.get("rvStatus") !== null ? params.get("rvStatus") : saved.rvStatus,
      rvReviewer: params.get("rvReviewer") !== null ? params.get("rvReviewer") : saved.rvReviewer,
      rvDueFrom: params.get("rvDueFrom") !== null ? params.get("rvDueFrom") : saved.rvDueFrom,
      rvDueTo: params.get("rvDueTo") !== null ? params.get("rvDueTo") : saved.rvDueTo,
      rvTargetKind: params.get("rvTargetKind") !== null
        ? params.get("rvTargetKind") : saved.rvTargetKind
    };
    const rfNorm = replayReview.normalizeFilters(reviewFiltersFrom(rfInput));
    if (!rfNorm.ok) { apiError(res, 400, rfNorm.code, rfNorm.message); return; }
    const marked = replayReview.filterReviews(sp.reviews || [], rfNorm.value);
    const timeline = replay.timelineByTask(sp.content, opts);
    replayReview.attachTimelineReviews(timeline, marked, sp.content);
    sendJSON(res, 200, {
      rev: sp.rev,
      view: saved,
      applied: opts,
      reviewFilters: rfNorm.value,
      timeline: timeline.map(function (g) {
        return {
          taskId: g.taskId,
          task: g.task,
          events: g.events
        };
      })
    });
    return;
  }

  /* GET /spaces/:id/conflicts：冲突原因汇总（逐条结果，挂复核标记） */
  if (seg.length === 2 && seg[1] === "conflicts" && req.method === "GET") {
    const params = urlObj.searchParams;
    const saved = sp.view || {};
    const rfInput = {
      rvStatus: params.get("rvStatus") !== null ? params.get("rvStatus") : saved.rvStatus,
      rvReviewer: params.get("rvReviewer") !== null ? params.get("rvReviewer") : saved.rvReviewer,
      rvDueFrom: params.get("rvDueFrom") !== null ? params.get("rvDueFrom") : saved.rvDueFrom,
      rvDueTo: params.get("rvDueTo") !== null ? params.get("rvDueTo") : saved.rvDueTo,
      rvTargetKind: params.get("rvTargetKind") !== null
        ? params.get("rvTargetKind") : saved.rvTargetKind
    };
    const rfNorm = replayReview.normalizeFilters(reviewFiltersFrom(rfInput));
    if (!rfNorm.ok) { apiError(res, 400, rfNorm.code, rfNorm.message); return; }
    const marked = replayReview.filterReviews(sp.reviews || [], rfNorm.value);
    const summary = replay.conflictSummary(sp.content);
    replayReview.attachConflictReviews(summary, marked);
    // 汇总中另附筛选后的全部结果类复核意见，供冲突面板统一展示与导出
    summary.resultReviews = marked
      .filter(function (r) { return r.target.kind === "result"; })
      .map(publicReview);
    sendJSON(res, 200, { rev: sp.rev, reviewFilters: rfNorm.value, summary: summary });
    return;
  }

  /* ---- 历史证据复核：意见集合 / 单条 / 关闭 / 转派 / 状态变化记录 / 清单导出 ---- */
  if (seg[1] === "reviews") {
    handleReplayReviews(req, res, sp, seg.slice(2), urlObj);
    return;
  }

  /* GET /spaces/:id/tasks/:taskId：包内锁定的单个任务（只读） */
  if (seg.length === 3 && seg[1] === "tasks" && req.method === "GET") {
    const t = sp.content.tasks.find(function (x) { return x.id === seg[2]; });
    if (!t) { apiError(res, 404, "task_not_in_package", "该任务不在审计包内"); return; }
    sendJSON(res, 200, { rev: sp.rev, task: t });
    return;
  }

  /* GET /spaces/:id/snapshots/:sid：包内锁定的单个快照（只读） */
  if (seg.length === 3 && seg[1] === "snapshots" && req.method === "GET") {
    const snap = sp.content.snapshots.find(function (x) { return x.id === seg[2]; });
    if (!snap) { apiError(res, 404, "snapshot_not_in_package", "该快照不在审计包内"); return; }
    sendJSON(res, 200, { rev: sp.rev, snapshot: snap });
    return;
  }

  apiError(res, 404, "not_found", "回放接口不存在");
}

/* ---------- 历史证据复核 API ---------- */

// 读取复核意见集合的查询参数（显式参数优先，否则回退空间已保存筛选）
function reviewQueryFilters(sp, params) {
  const saved = sp.view || {};
  const pick = function (name, savedVal) {
    const v = params.get(name);
    return v !== null ? v : (savedVal || "");
  };
  return {
    status: pick("status", saved.rvStatus),
    reviewer: pick("reviewer", saved.rvReviewer),
    dueFrom: pick("dueFrom", saved.rvDueFrom),
    dueTo: pick("dueTo", saved.rvDueTo),
    targetKind: pick("targetKind", saved.rvTargetKind)
  };
}

// 复核写操作的双重版本检查：先空间 rev（If-Match），再意见 version
// （expectedVersion）。任一不匹配都 409 且绝不写盘——旧页面无法覆盖
// 别人的新意见，尤其无法覆盖“已关闭”的结论。
function checkReviewVersions(res, req, sp, rv) {
  if (checkLock(res, req.headers["if-match"], sp.rev, "回放空间")) return true;
  const expected = parseInt((req.headers["x-review-version"] != null
    ? req.headers["x-review-version"] : ""), 10);
  // 创建（rv 为空）不需要意见版本
  if (!rv) return false;
  if (!Number.isInteger(expected)) {
    apiError(res, 428, "precondition_required",
      "修改/关闭/转派复核意见必须携带 X-Review-Version: <意见版本号>");
    return true;
  }
  if (expected !== rv.version) {
    apiError(res, 409, "review_version_conflict",
      "该复核意见已被其他页面更新（当前版本 " + rv.version +
      "），本次操作已取消，请刷新后重试，避免覆盖较新内容",
      { currentVersion: rv.version, currentStatus: rv.status });
    return true;
  }
  if (rv.status === "closed") {
    apiError(res, 409, "review_closed",
      "该复核意见已关闭（关闭人 " + (rv.closedBy || "—") +
      "），关闭结论不能再被修改或转派",
      { currentVersion: rv.version });
    return true;
  }
  return false;
}

function handleReplayReviews(req, res, sp, seg, urlObj) {
  // seg: [] | [":rid"] | [":rid", "close"] | [":rid", "reassign"] |
  //      [":rid", "logs"] | ["export"] | ["reviewers"]
  const params = urlObj.searchParams;

  /* GET /spaces/:id/reviews/reviewers：复核人名单（供筛选下拉，只读） */
  if (seg.length === 1 && seg[0] === "reviewers" && req.method === "GET") {
    const set = Object.create(null);
    (sp.reviews || []).forEach(function (r) { set[r.reviewer] = true; });
    sendJSON(res, 200, { rev: sp.rev, reviewers: Object.keys(set).sort() });
    return;
  }

  /* POST /spaces/:id/reviews/export：构建独立复核清单（纯只读，不写盘、不推 rev；
     ?download=1 给附件下载头；导出失败不触碰任何意见或空间） */
  if (seg.length === 1 && seg[0] === "export" && req.method === "POST") {
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw) || {}; }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      }
      // 显式筛选优先；未给的字段回退空间已保存筛选
      const saved = sp.view || {};
      const pick = function (v, s) { return v !== undefined && v !== null ? v : (s || ""); };
      const filters = {
        status: pick(body.status, saved.rvStatus),
        reviewer: pick(body.reviewer, saved.rvReviewer),
        dueFrom: pick(body.dueFrom, saved.rvDueFrom),
        dueTo: pick(body.dueTo, saved.rvDueTo),
        targetKind: pick(body.targetKind, saved.rvTargetKind)
      };
      const built = replayReview.buildChecklist({
        space: sp,
        content: sp.content,
        reviews: sp.reviews || [],
        reviewLogs: sp.reviewLogs || [],
        filters: filters,
        generatedBy: review.validateAuthor(body.actor).value
      });
      if (!built.ok) {
        apiError(res, 400, built.code, built.message);
        return;
      }
      const payload = JSON.stringify(built.value, null, 2);
      const headers = { "Content-Type": "application/json; charset=utf-8" };
      if (params.get("download") === "1") {
        const fname = encodeURIComponent(
          "review-checklist-" + sp.id.slice(0, 8) + ".json");
        headers["Content-Disposition"] =
          "attachment; filename=\"review-checklist.json\"; filename*=UTF-8''" + fname;
      }
      res.writeHead(200, headers);
      res.end(payload);
    });
    return;
  }

  /* GET /spaces/:id/reviews：复核清单列表（按状态/复核人/截止时间/引用类型筛选） */
  if (seg.length === 0 && req.method === "GET") {
    const filters = reviewQueryFilters(sp, params);
    const norm = replayReview.normalizeFilters(filters);
    if (!norm.ok) { apiError(res, 400, norm.code, norm.message); return; }
    const nowMs = Date.now();
    const list = replayReview.filterReviews(sp.reviews || [], norm.value)
      .map(function (r) {
        const pub = publicReview(r);
        pub.overdue = r.status !== "closed" && Date.parse(r.dueAt) < nowMs;
        return pub;
      })
      .sort(function (a, b) {
        // 未关闭在前，再按截止时间升序、创建时间升序
        if ((a.status === "closed") !== (b.status === "closed")) {
          return a.status === "closed" ? 1 : -1;
        }
        var da = Date.parse(a.dueAt), db = Date.parse(b.dueAt);
        if (da !== db) return da - db;
        return a.createdAt < b.createdAt ? -1 : 1;
      });
    sendJSON(res, 200, {
      rev: replayStore.rev, spaceRev: sp.rev,
      filters: norm.value,
      count: list.length,
      total: (sp.reviews || []).length,
      reviews: list
    });
    return;
  }

  /* POST /spaces/:id/reviews：新增复核意见（If-Match: 空间 rev） */
  if (seg.length === 0 && req.method === "POST") {
    if (checkLock(res, req.headers["if-match"], sp.rev, "回放空间")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let body;
      try { body = JSON.parse(raw) || {}; }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      const actor = review.validateAuthor(body.actor).value;
      createSpaceReview(sp, body, actor, function (failure, out) {
        if (failure) {
          const extra = failure.existingReviewId
            ? { existingReviewId: failure.existingReviewId } : {};
          apiError(res, failure.status, failure.code, failure.message, extra);
          return;
        }
        sendJSON(res, out.status, {
          rev: replayStore.rev, spaceRev: sp.rev, review: out.review
        });
      });
    });
    return;
  }

  if (!seg.length) {
    apiError(res, 405, "method_not_allowed", "仅支持 GET/POST");
    return;
  }

  const rv = findSpaceReview(sp, seg[0]);
  if (!rv) {
    apiError(res, 404, "review_not_found", "复核意见不存在或已随空间删除");
    return;
  }

  /* GET /spaces/:id/reviews/:rid：意见详情（含引用目标快照） */
  if (seg.length === 1 && req.method === "GET") {
    const pub = publicReview(rv);
    pub.target = replayReview.describeTarget(sp.content, rv.target) ||
      { kind: rv.target.kind, missing: true };
    sendJSON(res, 200, { rev: sp.rev, review: pub });
    return;
  }

  /* PUT /spaces/:id/reviews/:rid：修改内容/状态/截止时间
     （If-Match: 空间 rev + X-Review-Version: 意见版本） */
  if (seg.length === 1 && req.method === "PUT") {
    if (checkReviewVersions(res, req, sp, rv)) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let body;
      try { body = JSON.parse(raw) || {}; }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      const actor = review.validateAuthor(body.actor).value;
      updateSpaceReview(sp, rv, body, actor, function (failure, out) {
        if (failure) {
          apiError(res, failure.status, failure.code, failure.message);
          return;
        }
        sendJSON(res, 200, {
          rev: replayStore.rev, spaceRev: sp.rev,
          review: out.review, unchanged: !!out.unchanged
        });
      });
    });
    return;
  }

  /* POST /spaces/:id/reviews/:rid/close：关闭（终态，双重版本检查） */
  if (seg.length === 2 && seg[1] === "close" && req.method === "POST") {
    if (checkReviewVersions(res, req, sp, rv)) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw) || {}; }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      }
      const actor = review.validateAuthor(body.actor).value;
      closeSpaceReview(sp, rv, body, actor, function (failure, out) {
        if (failure) {
          apiError(res, failure.status, failure.code, failure.message);
          return;
        }
        sendJSON(res, 200, {
          rev: replayStore.rev, spaceRev: sp.rev, review: out.review
        });
      });
    });
    return;
  }

  /* POST /spaces/:id/reviews/:rid/reassign：转派给新复核人（终态意见拒绝） */
  if (seg.length === 2 && seg[1] === "reassign" && req.method === "POST") {
    if (checkReviewVersions(res, req, sp, rv)) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let body;
      try { body = JSON.parse(raw) || {}; }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      const actor = review.validateAuthor(body.actor).value;
      reassignSpaceReview(sp, rv, body, actor, function (failure, out) {
        if (failure) {
          apiError(res, failure.status, failure.code, failure.message);
          return;
        }
        sendJSON(res, 200, {
          rev: replayStore.rev, spaceRev: sp.rev, review: out.review
        });
      });
    });
    return;
  }

  /* GET /spaces/:id/reviews/:rid/logs：该意见的状态变化记录，支持 ?from=&to= */
  if (seg.length === 2 && seg[1] === "logs" && req.method === "GET") {
    const from = params.get("from");
    const to = params.get("to");
    if (from && !replay.isISODateString(from)) {
      apiError(res, 400, "invalid_from", "起始时间不是合法 ISO 时间"); return;
    }
    if (to && !replay.isISODateString(to)) {
      apiError(res, 400, "invalid_to", "结束时间不是合法 ISO 时间"); return;
    }
    const logs = (sp.reviewLogs || [])
      .filter(function (l) {
        if (l.reviewId !== rv.id) return false;
        if (from && Date.parse(l.at) < Date.parse(from)) return false;
        if (to && Date.parse(l.at) > Date.parse(to)) return false;
        return true;
      })
      .sort(function (a, b) {
        // 时间倒序（与线上批次/决策记录一致），同毫秒按 id 稳定排序
        var d = Date.parse(b.at) - Date.parse(a.at);
        if (d) return d;
        return a.id < b.id ? 1 : -1;
      });
    sendJSON(res, 200, { rev: sp.rev, reviewId: rv.id, logs: logs });
    return;
  }

  apiError(res, 404, "not_found", "复核接口不存在");
}


function sendJSON(res, status, body, headers) {
  const payload = JSON.stringify(body);
  const h = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "X-Snapshot-Rev": String(store.rev),
    "X-Annotation-Rev": String(annStore.rev),
    "X-Batch-Rev": String(batchStore.rev),
    "X-Decision-Rev": String(decisionStore.rev),
    "X-Replay-Rev": String(replayStore.rev),
    "Cache-Control": "no-store"
  }, headers || {});
  res.writeHead(status, h);
  res.end(payload);
}

function apiError(res, status, code, message, extra) {
  sendJSON(res, status, Object.assign({ error: code, message: message }, extra || {}));
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on("data", function (c) {
    size += c.length;
    if (size > REQUEST_BODY_LIMIT) {
      req.destroy();
      cb(new Error("body_too_large"));
      cb = function () {};
      return;
    }
    chunks.push(c);
  });
  req.on("end", function () {
    cb(null, Buffer.concat(chunks).toString("utf8"));
  });
  req.on("error", cb);
}

// 乐观锁检查：返回 null 表示通过；否则已发送错误响应并返回 true
function checkLock(res, expected, currentRev, label) {
  if (expected === undefined) {
    apiError(res, 428, "precondition_required",
      label + "必须携带 If-Match 版本号");
    return true;
  }
  const their = parseInt(expected, 10);
  if (!Number.isInteger(their) || their !== currentRev) {
    apiError(res, 409, "version_conflict",
      label + "已被其他页面更新（当前版本 " + currentRev +
      "），本次操作已取消，请刷新后重试，避免覆盖较新内容",
      { currentRev: currentRev });
    return true;
  }
  return false;
}

/* ================= 批注 API ================= */

function handleAnnotations(req, res, parts) {
  // parts: ["api", "annotations", ":id?", "replies"?]
  const id = parts[2];
  const sub = parts[3];

  if (sub && !(id && sub === "replies" && parts.length === 4)) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }
  if (parts.length > 4) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }

  /* ---- GET /api/annotations：全量列表（含回复），读不需要锁 ---- */
  if (!id && req.method === "GET") {
    sendJSON(res, 200, publicAnnotations());
    return;
  }

  /* ---- POST /api/annotations：新建批注（必须 If-Match） ---- */
  if (!id && req.method === "POST") {
    if (checkLock(res, req.headers["if-match"], annStore.rev,
      "批注集合")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      const check = review.validateNewAnnotation(payload);
      if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }
      if (annStore.annotations.length >= review.LIMITS.ANNOTATION_MAX_COUNT) {
        apiError(res, 413, "too_many_annotations",
          "批注总数已达 " + review.LIMITS.ANNOTATION_MAX_COUNT + " 条上限");
        return;
      }

      const now = new Date().toISOString();
      const ann = Object.assign(check.value, {
        id: crypto.randomUUID(),
        status: "open",
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
        batchId: null,
        batchName: null,
        replies: []
      });
      annStore.annotations.push(ann);
      annStore.rev++;
      persistAnnotations(function (err) {
        if (err) { annStore.annotations.pop(); annStore.rev--;
          apiError(res, 500, "persist_failed", "批注保存失败，请重试"); return; }
        sendJSON(res, 201, { rev: annStore.rev, annotation: ann });
      });
    });
    return;
  }

  /* ---- PUT /api/annotations：整体替换（从快照恢复批注集合） ---- */
  if (!id && req.method === "PUT") {
    if (checkLock(res, req.headers["if-match"], annStore.rev,
      "批注集合")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (!payload || !Array.isArray(payload.annotations)) {
        apiError(res, 400, "invalid_body", "请求必须包含 annotations 数组");
        return;
      }
      if (payload.annotations.length > review.LIMITS.ANNOTATION_MAX_COUNT) {
        apiError(res, 413, "too_many_annotations",
          "批注总数超过 " + review.LIMITS.ANNOTATION_MAX_COUNT + " 条上限");
        return;
      }
      // 全部校验通过后才替换：任何一条非法都不写存储
      const normalized = [];
      const seen = new Set();
      for (let i = 0; i < payload.annotations.length; i++) {
        const c = review.normalizeAnnotationRecord(payload.annotations[i], i);
        if (!c.ok) { apiError(res, c.status, c.code, c.message); return; }
        const rec = c.value;
        // id 缺失或重复：重新生成，保证集合内唯一
        if (!rec.id || seen.has(rec.id)) rec.id = crypto.randomUUID();
        seen.add(rec.id);
        const now = new Date().toISOString();
        if (!rec.createdAt) rec.createdAt = now;
        if (!rec.updatedAt) rec.updatedAt = rec.createdAt;
        rec.replies.forEach(function (r) {
          if (!r.id) r.id = crypto.randomUUID();
          if (!r.createdAt) r.createdAt = rec.createdAt;
        });
        normalized.push(rec);
      }

      const backupAnn = annStore.annotations;
      const backupBatchRev = batchStore.rev;
      const backupBatches = batchStore.batches.map(function (b) {
        return { b: b, memberIds: b.memberIds.slice(), updatedAt: b.updatedAt };
      });
      const backupLogs = batchStore.logs.slice();

      // —— 批次对账预检（恢复是“整体替换批注集合”）——
      // 已归档批次的冻结成员若不在恢复集中：整次恢复拒绝（归档历史不可破坏）。
      const liveIds = Object.create(null);
      normalized.forEach(function (a) { liveIds[a.id] = true; });
      for (let bi = 0; bi < batchStore.batches.length; bi++) {
        const bb0 = batchStore.batches[bi];
        if (bb0.status !== "archived") continue;
        const missing0 = bb0.memberIds.filter(function (id) { return !liveIds[id]; });
        if (missing0.length) {
          apiError(res, 409, "archived_members_lost",
            "恢复集中缺少已归档批次“" + bb0.name + "”中的 " + missing0.length +
            " 条批注：归档批次的批注不能被移除，恢复已取消，当前批注集合未改动",
            { batchId: bb0.id, missing: missing0 });
          return;
        }
      }

      annStore.annotations = normalized;
      annStore.rev++;

      // 未归档批次：成员 id 不在恢复集中则移出（留审阅记录、推进批次 rev）。
      // 恢复记录上的 batchId 不重建活归属（防止同批注进入两个未归档批次），
      // 仅保留 batchInfo 冗余供快照式展示；若恢复出的 id 命中归档批次冻结成员，
      // 重新挂回该归档批次（其状态仍受冻结保护）。
      var removedFromBatches = [];
      var batchMutated = false;
      batchStore.batches.forEach(function (bb) {
        if (bb.status !== "pending") return;
        var gone = bb.memberIds.filter(function (id) { return !liveIds[id]; });
        if (!gone.length) return;
        bb.memberIds = bb.memberIds.filter(function (id) { return liveIds[id]; });
        bb.updatedAt = new Date().toISOString();
        batchMutated = true;
        removedFromBatches.push({ batch: bb, ids: gone });
      });
      if (batchMutated) batchStore.rev++;

      // 恢复集记录：剥离活归属字段；若其 id 恰好命中归档批次冻结成员，
      // 重新挂回该归档批次（状态仍受冻结保护）。
      const frozenIdx = batchByMemberIndex();
      normalized.forEach(function (a) {
        const holder = frozenIdx[a.id];
        if (holder && holder.status === "archived") {
          a.batchId = holder.id;
          a.batchName = holder.name;
        } else {
          a.batchId = null;
          a.batchName = null;
        }
      });

      function rollbackBatchSide() {
        batchStore.rev = backupBatchRev;
        backupBatches.forEach(function (x) {
          x.b.memberIds = x.memberIds;
          x.b.updatedAt = x.updatedAt;
        });
        batchStore.logs = backupLogs;
      }

      persistAnnotations(function (err) {
        if (err) {
          annStore.annotations = backupAnn; annStore.rev--;
          rollbackBatchSide();
          apiError(res, 500, "persist_failed", "批注恢复失败，请重试");
          return;
        }
        if (!batchMutated) {
          sendJSON(res, 200, publicAnnotations());
          return;
        }
        const nowLog = new Date().toISOString();
        removedFromBatches.forEach(function (x) {
          addBatchLog({
            batchId: x.batch.id, batchName: x.batch.name, at: nowLog,
            actor: "系统（从快照恢复批注）", action: "members_restore_pruned",
            detail: "从快照整体恢复批注集合，" + x.ids.length +
                    " 条原成员不在恢复集中，已自动移出批次",
            annotationId: null
          });
        });
        persistBatches(function (err2) {
          if (err2) {
            // 批注已落盘（恢复本身成功），批次侧回滚内存；列表刷新即可一致
            rollbackBatchSide();
            console.error("batch reconcile persist failed:", err2);
          }
          sendJSON(res, 200, publicAnnotations());
        });
      });
    });
    return;
  }

  if (!id) {
    apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
    return;
  }

  /* ---- POST /api/annotations/:id/replies：追加回复 ---- */
  if (sub === "replies") {
    if (req.method !== "POST") {
      apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
      return;
    }
    if (checkLock(res, req.headers["if-match"], annStore.rev,
      "批注集合")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      const check = review.validateReply(payload);
      if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }

      const ann = findAnn(id);
      if (!ann) { apiError(res, 404, "annotation_not_found", "批注不存在或已被删除"); return; }
      const holder0 = batchByMemberIndex()[ann.id];
      if (holder0 && holder0.status === "archived") {
        apiError(res, 409, "annotation_frozen",
          "该批注属于已归档批次“" + holder0.name + "”，归档后不能再回复或改动状态",
          { batchId: holder0.id });
        return;
      }
      if (ann.replies.length >= review.LIMITS.REPLY_MAX_COUNT) {
        apiError(res, 413, "too_many_replies",
          "该批注的回复数已达 " + review.LIMITS.REPLY_MAX_COUNT + " 条上限");
        return;
      }
      const now = new Date().toISOString();
      const reply = {
        id: crypto.randomUUID(),
        author: check.value.author,
        body: check.value.body,
        createdAt: now
      };
      const prevUpdated = ann.updatedAt;
      ann.replies.push(reply);
      ann.updatedAt = now;
      annStore.rev++;
      persistAnnotations(function (err) {
        if (err) { ann.replies.pop(); ann.updatedAt = prevUpdated; annStore.rev--;
          apiError(res, 500, "persist_failed", "回复保存失败，请重试"); return; }
        sendJSON(res, 201, { rev: annStore.rev, annotation: ann });
      });
    });
    return;
  }

  /* ---- PUT /api/annotations/:id：工作流状态（待处理/处理中/需复核/已解决） ---- */
  if (req.method === "PUT") {
    if (checkLock(res, req.headers["if-match"], annStore.rev,
      "批注集合")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (!payload || !review.validAnnStatus(payload.status)) {
        apiError(res, 400, "invalid_status",
          "状态必须是 open（待处理）、in_progress（处理中）、needs_review（需复核）或 resolved（已解决）");
        return;
      }
      const ann = findAnn(id);
      if (!ann) { apiError(res, 404, "annotation_not_found", "批注不存在或已被删除"); return; }

      const holder = batchByMemberIndex()[ann.id];
      if (holder && holder.status === "archived") {
        apiError(res, 409, "annotation_frozen",
          "该批注属于已归档批次“" + holder.name +
          "”，批次归档后其中批注状态不能再改动，可在批次详情中查看完整历史",
          { batchId: holder.id });
        return;
      }

      const who = review.validateAuthor(
        payload.actor != null ? payload.actor : payload.resolvedBy);
      const actor = who.ok ? who.value : "匿名";
      const backup = {
        status: ann.status, resolvedAt: ann.resolvedAt,
        resolvedBy: ann.resolvedBy, updatedAt: ann.updatedAt
      };
      const prevStatus = ann.status;
      const now = new Date().toISOString();
      ann.status = payload.status;
      if (payload.status === "resolved") {
        ann.resolvedAt = now;
        ann.resolvedBy = actor;
      } else {
        ann.resolvedAt = null;
        ann.resolvedBy = null;
      }
      ann.updatedAt = now;
      annStore.rev++;

      // 属于未归档批次：状态变化写入批次审阅记录并推进批次 rev，
      // 这样任何人改过成员状态后，旧批次页面的批量更新都会因版本不符被拒绝。
      let batchTouched = false;
      let logEntry = null;
      let prevBatchUpdated = null;
      if (holder) {
        prevBatchUpdated = holder.updatedAt;
        holder.updatedAt = now;
        batchStore.rev++;
        batchTouched = true;
        logEntry = {
          batchId: holder.id, batchName: holder.name, at: now,
          actor: actor, action: "status_change",
          detail: "批注状态：" + review.annStatusLabel(prevStatus) +
                  " → " + review.annStatusLabel(payload.status),
          annotationId: ann.id
        };
        addBatchLog(logEntry);
      }

      function rollbackBatchSide() {
        if (!batchTouched) return;
        holder.updatedAt = prevBatchUpdated;
        batchStore.rev--;
        const li = batchStore.logs.indexOf(logEntry);
        if (li !== -1) batchStore.logs.splice(li, 1);
      }

      persistAnnotations(function (perr) {
        if (perr) {
          ann.status = backup.status; ann.resolvedAt = backup.resolvedAt;
          ann.resolvedBy = backup.resolvedBy; ann.updatedAt = backup.updatedAt;
          annStore.rev--;
          rollbackBatchSide();
          apiError(res, 500, "persist_failed", "状态更新失败，请重试");
          return;
        }
        if (!batchTouched) {
          sendJSON(res, 200, { rev: annStore.rev, annotation: ann });
          return;
        }
        persistBatches(function (berr) {
          if (berr) {
            // 批注状态已落盘：批次日志失败时以批注为准，回滚内存中的批次侧
            rollbackBatchSide();
            console.error("batch log persist failed:", berr);
          }
          sendJSON(res, 200, { rev: annStore.rev, annotation: ann });
        });
      });
    });
    return;
  }

  /* ---- DELETE /api/annotations/:id ----
   * 属于批次的批注不能直接删除：先在未归档批次中“移出批次”，
   * 已归档批次的批注永久保留（完整历史）。
   */
  if (req.method === "DELETE") {
    if (checkLock(res, req.headers["if-match"], annStore.rev,
      "批注集合")) return;
    const victim = findAnn(id);
    if (!victim) {
      apiError(res, 404, "annotation_not_found", "批注不存在或已被删除");
      return;
    }
    const holderDel = batchByMemberIndex()[victim.id];
    if (holderDel) {
      apiError(res, 409,
        holderDel.status === "archived" ? "annotation_frozen" : "annotation_in_batch",
        holderDel.status === "archived"
          ? "该批注属于已归档批次“" + holderDel.name + "”，归档批注不能删除"
          : "该批注属于审阅批次“" + holderDel.name +
            "”，请先在批次详情中把它移出批次，再删除",
        { batchId: holderDel.id, batchStatus: holderDel.status });
      return;
    }
    const idx = annStore.annotations.indexOf(victim);
    const removed = annStore.annotations.splice(idx, 1)[0];
    annStore.rev++;
    persistAnnotations(function (err) {
      if (err) { annStore.annotations.splice(idx, 0, removed); annStore.rev--;
        apiError(res, 500, "persist_failed", "删除失败，请重试"); return; }
      sendJSON(res, 200, { ok: true, rev: annStore.rev });
    });
    return;
  }

  apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
}

/* ================= 快照 API ================= */

function handleSnapshots(req, res, parts) {
  const id = parts[2];

  if (!id && req.method === "GET") {
    sendJSON(res, 200, publicStore());
    return;
  }

  if (!id && req.method === "POST") {
    // 新建快照
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      const check = core.validateSnapshotPayload(payload);
      if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }

      // 名称唯一性（不区分大小写折叠会误伤阿拉伯文，这里按精确匹配）
      if (findName(check.value.name)) {
        apiError(res, 409, "duplicate_name",
          "已存在同名快照，请换一个名称",
          { existing: summary(findName(check.value.name)) });
        return;
      }
      const now = new Date().toISOString();
      const batchLookup = new Map(
        batchStore.batches.map(function (b) { return [b.id, { id: b.id, name: b.name, status: b.status }]; }));
      const snap = {
        id: crypto.randomUUID(),
        name: check.value.name,
        createdAt: now,
        updatedAt: now,
        paragraphs: check.value.paragraphs,
        // 关联当前批注集合：查看该历史快照时能看到当时的批注、工作流状态与所属批次
        annotations: review.snapshotDigest(annStore.annotations, batchLookup),
        annotationRev: annStore.rev,
        // 关联当前决策草案（状态/投票/执行结果）：历史快照可见当时的决策情况
        decisions: decision.decisionDigest(decisionStore.decisions),
        decisionRev: decisionStore.rev,
        // 关联执行队列：发布锁定文本、计划时间、任务状态与成功条目一并留档
        executionTasks: decision.taskDigest(decisionStore.tasks)
      };
      store.snapshots.push(snap);
      store.rev++;
      persist(function (err) {
        if (err) { store.snapshots.pop(); store.rev--;
          apiError(res, 500, "persist_failed", "快照保存失败，请重试"); return; }
        sendJSON(res, 201, publicFull(snap));
      });
    });
    return;
  }

  if (!id) {
    apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
    return;
  }

  // —— 单快照操作 ——
  if (req.method === "GET") {
    // 读取不需要乐观锁
    const s = findId(id);
    if (!s) { apiError(res, 404, "snapshot_not_found", "快照不存在或已被删除"); return; }
    sendJSON(res, 200, publicFull(s));
    return;
  }

  // 修改/删除必须携带集合版本，做乐观并发校验
  const expected = req.headers["if-match"];
  if (expected === undefined) {
    apiError(res, 428, "precondition_required",
      "修改或删除快照必须携带 If-Match 版本号");
    return;
  }
  // 必须严格等于当前版本：旧页面、缺失或非法版本号一律拒绝
  const their = parseInt(expected, 10);
  const conflict = !Number.isInteger(their) || their !== store.rev;

  if (req.method === "PUT") {
    if (conflict) {
      apiError(res, 409, "version_conflict",
        "快照集合已被其他页面更新（当前版本 " + store.rev +
        "），请刷新列表后重试，避免覆盖较新内容",
        { currentRev: store.rev });
      return;
    }
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      const check = core.validateSnapshotPayload(payload);
      if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }

      const s = findId(id);
      if (!s) { apiError(res, 404, "snapshot_not_found", "快照不存在或已被删除"); return; }
      const dup = findName(check.value.name, id);
      if (dup) {
        apiError(res, 409, "duplicate_name", "已存在同名快照，请换一个名称",
          { existing: summary(dup) });
        return;
      }
      const backup = { name: s.name, updatedAt: s.updatedAt, paragraphs: s.paragraphs,
                       annotations: s.annotations, annotationRev: s.annotationRev,
                       decisions: s.decisions, decisionRev: s.decisionRev,
                       executionTasks: s.executionTasks };
      s.name = check.value.name;
      s.paragraphs = check.value.paragraphs;
      s.updatedAt = new Date().toISOString();
      // 覆盖保存同样刷新快照关联的批注状态与所属批次
      const batchLookup2 = new Map(
        batchStore.batches.map(function (b) { return [b.id, { id: b.id, name: b.name, status: b.status }]; }));
      s.annotations = review.snapshotDigest(annStore.annotations, batchLookup2);
      s.annotationRev = annStore.rev;
      // 覆盖保存同步刷新决策草案状态、投票、执行结果与执行队列
      s.decisions = decision.decisionDigest(decisionStore.decisions);
      s.decisionRev = decisionStore.rev;
      s.executionTasks = decision.taskDigest(decisionStore.tasks);
      store.rev++;
      const newRev = store.rev;
      persist(function (err) {
        if (err) {
          s.name = backup.name; s.paragraphs = backup.paragraphs;
          s.updatedAt = backup.updatedAt;
          s.annotations = backup.annotations; s.annotationRev = backup.annotationRev;
          s.decisions = backup.decisions; s.decisionRev = backup.decisionRev;
          s.executionTasks = backup.executionTasks;
          store.rev--;
          apiError(res, 500, "persist_failed", "快照保存失败，请重试");
          return;
        }
        sendJSON(res, 200, publicFull(s), { ETag: '"' + newRev + '"' });
      });
    });
    return;
  }

  if (req.method === "DELETE") {
    if (conflict) {
      apiError(res, 409, "version_conflict",
        "快照集合已被其他页面更新（当前版本 " + store.rev +
        "），删除已取消，请刷新列表确认后再操作",
        { currentRev: store.rev });
      return;
    }
    const realIdx = store.snapshots.findIndex(function (s) { return s.id === id; });
    if (realIdx === -1) { apiError(res, 404, "snapshot_not_found", "快照不存在或已被删除"); return; }
    const removed = store.snapshots.splice(realIdx, 1)[0];
    store.rev++;
    persist(function (err) {
      if (err) { store.snapshots.splice(realIdx, 0, removed); store.rev--;
        apiError(res, 500, "persist_failed", "删除失败，请重试"); return; }
      sendJSON(res, 200, { ok: true, rev: store.rev });
    });
    return;
  }

  apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
}

/* ================= 审阅批次 API ================= */

// parts: ["api", "review-batches", ":id?", "members"|"status"|"archive"|"logs"?]
function handleReviewBatches(req, res, parts, urlObj) {
  const id = parts[2];
  const sub = parts[3];
  const validSubs = { members: true, status: true, archive: true, logs: true };
  if (sub && !(id && validSubs[sub] && parts.length === 4)) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }
  if (parts.length > 4) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }

  // 集合级操作：GET 列表、POST 新建
  if (!id) {
    if (req.method === "GET") {
      sendJSON(res, 200, publicBatches());
      return;
    }
    if (req.method === "POST") {
      if (checkLock(res, req.headers["if-match"], batchStore.rev, "审阅批次集合")) return;
      readBody(req, function (err, raw) {
        if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
        let payload;
        try { payload = JSON.parse(raw); }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

        if (batchStore.batches.length >= review.LIMITS.BATCH_MAX_COUNT) {
          apiError(res, 413, "too_many_batches",
            "审阅批次总数已达 " + review.LIMITS.BATCH_MAX_COUNT + " 个上限");
          return;
        }
        const check = review.validateBatchPayload(payload, false);
        if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }
        const v = check.value;

        // 成员必须存在
        const missing = v.annotationIds.filter(function (aid) { return !findAnn(aid); });
        if (missing.length) {
          apiError(res, 404, "annotation_not_found",
            (missing.length === 1 ? "所选批注不存在或已被删除"
                                 : "有 " + missing.length + " 条所选批注不存在或已被删除") +
            "，请刷新批注列表后重新选择，当前页面内容已保留",
            { missing: missing });
          return;
        }
        // 同一条批注不能同时属于两个未归档批次；归档成员也不能再进新批次
        const idx = batchByMemberIndex();
        const conflicts = v.annotationIds.filter(function (aid) { return idx[aid]; });
        if (conflicts.length) {
          const other = idx[conflicts[0]];
          apiError(res, 409, "annotation_already_in_batch",
            "有 " + conflicts.length + " 条批注已属于审阅批次“" + other.name +
            (other.status === "archived" ? "”（已归档），归档批注不能再加入其他批次"
                                         : "”，同一条批注不能同时属于两个未归档批次") +
            "，请先把它们从原批次移出后再试",
            { conflictIds: conflicts, otherBatchId: other.id, otherBatchStatus: other.status });
          return;
        }

        const now = new Date().toISOString();
        const batch = {
          id: crypto.randomUUID(),
          name: v.name,
          owner: v.owner,
          deadline: v.deadline,
          description: v.description,
          status: "pending",
          memberIds: v.annotationIds.slice(),
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          archivedBy: null,
          memberSnapshot: null,
          createdBy: review.validateAuthor(
            payload.actor != null ? payload.actor : payload.author).value
        };
        batchStore.batches.push(batch);
        v.annotationIds.forEach(function (aid) {
          const a = findAnn(aid);
          a.batchId = batch.id;
          a.batchName = batch.name;
        });
        batchStore.rev++;
        addBatchLog({
          batchId: batch.id, batchName: batch.name, at: now,
          actor: batch.createdBy, action: "batch_create",
          detail: "创建批次，负责人：" + batch.owner +
                  (batch.deadline ? "；截止：" + batch.deadline : "") +
                  "；成员 " + batch.memberIds.length + " 条",
          annotationId: null
        });
        persistBatches(function (perr) {
          if (perr) {
            batchStore.batches.pop();
            v.annotationIds.forEach(function (aid) {
              const a = findAnn(aid);
              if (a) { a.batchId = null; a.batchName = null; }
            });
            batchStore.rev--;
            batchStore.logs.pop();
            apiError(res, 500, "persist_failed", "批次创建失败，请重试");
            return;
          }
          // 成员冗余字段写在批注集合上：同步落盘（失败不影响批次成立，刷新后对账即可）
          annStore.rev++;
          persistAnnotations(function () {
            sendJSON(res, 201, { rev: batchStore.rev, batch: batchSummary(batch) });
          });
        });
      });
      return;
    }
    apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
    return;
  }

  // —— 单个批次的操作都先解析批次并校验批次版本锁 ——
  const batch = findBatch(id);
  if (!batch) {
    if (req.method === "GET") {
      apiError(res, 404, "batch_not_found", "审阅批次不存在或已被删除");
      return;
    }
    // 非 GET 先做锁检查以保持 428/409 语义一致
    if (checkLock(res, req.headers["if-match"], batchStore.rev, "审阅批次集合")) return;
    apiError(res, 404, "batch_not_found", "审阅批次不存在或已被删除");
    return;
  }
  if (req.method === "GET" && !sub) {
    sendJSON(res, 200, publicBatchFull(batch));
    return;
  }
  if (sub === "logs" && req.method === "GET") {
    const params = urlObj.searchParams;
    let logs = batchStore.logs.filter(function (l) { return l.batchId === id; });
    const from = params.get("from");
    const to = params.get("to");
    if (from && !isNaN(Date.parse(from))) {
      logs = logs.filter(function (l) { return Date.parse(l.at) >= Date.parse(from); });
    }
    if (to && !isNaN(Date.parse(to))) {
      logs = logs.filter(function (l) { return Date.parse(l.at) <= Date.parse(to); });
    }
    // 时间倒序（新的在前）
    logs = logs.slice().sort(function (a, b) { return b.at.localeCompare(a.at); });
    sendJSON(res, 200, { rev: batchStore.rev, batchId: id, logs: logs });
    return;
  }

  // 以下均为变更类：必须携带当前批次版本
  if (checkLock(res, req.headers["if-match"], batchStore.rev, "审阅批次集合")) return;

  function rejectArchived() {
    if (batch.status !== "archived") return false;
    apiError(res, 409, "batch_archived",
      "批次“" + batch.name + "”已归档，归档后不能再改动其中批注或批次设置，" +
      "但可以查看完整历史与审阅记录",
      { batchId: batch.id });
    return true;
  }

  /* ---- PUT /api/review-batches/:id：改负责人/截止/说明（可改名） ---- */
  if (!sub && req.method === "PUT") {
    if (rejectArchived()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      // 截止时间保持为批次当前值（例如该批次已过期后只改负责人）：视为“不变更”，
      // 避免被“不能设为过去时间”的规则误伤。
      if (payload && typeof payload.deadline === "string" && batch.deadline &&
          Date.parse(payload.deadline) === Date.parse(batch.deadline)) {
        delete payload.deadline;
      }

      const check = review.validateBatchPayload(payload, true);
      if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }
      const v = check.value;
      const actor = review.validateAuthor(payload.actor).value;
      const now = new Date().toISOString();
      const backup = {
        name: batch.name, owner: batch.owner, deadline: batch.deadline,
        description: batch.description, updatedAt: batch.updatedAt
      };
      const changes = [];
      if (v.name !== undefined && v.name !== batch.name) {
        changes.push("名称：“" + batch.name + "”→“" + v.name + "”");
        batch.name = v.name;
      }
      if (v.owner !== undefined && v.owner !== batch.owner) {
        changes.push("负责人：" + batch.owner + " → " + v.owner);
        batch.owner = v.owner;
      }
      if (v.deadline !== undefined) {
        const oldDl = batch.deadline || "（无）";
        const newDl = v.deadline || "（无）";
        if (oldDl !== newDl) changes.push("截止时间：" + oldDl + " → " + newDl);
        batch.deadline = v.deadline;
      }
      if (v.description !== undefined && v.description !== batch.description) {
        changes.push("说明已更新");
        batch.description = v.description;
      }
      if (!changes.length) {
        apiError(res, 400, "no_change", "没有需要更新的字段");
        return;
      }
      batch.updatedAt = now;
      let logEntry = null;
      batchStore.rev++;
      logEntry = {
        batchId: batch.id, batchName: batch.name, at: now,
        actor: actor, action: "batch_update",
        detail: changes.join("；"), annotationId: null
      };
      addBatchLog(logEntry);

      // 改名要同步批注冗余字段
      const renamed = backup.name !== batch.name;
      if (renamed) {
        batch.memberIds.forEach(function (aid) {
          const a = findAnn(aid);
          if (a) a.batchName = batch.name;
        });
      }

      persistBatches(function (perr) {
        if (perr) {
          batch.name = backup.name; batch.owner = backup.owner;
          batch.deadline = backup.deadline; batch.description = backup.description;
          batch.updatedAt = backup.updatedAt;
          batchStore.rev--;
          const li = batchStore.logs.indexOf(logEntry);
          if (li !== -1) batchStore.logs.splice(li, 1);
          apiError(res, 500, "persist_failed", "批次更新失败，请重试");
          return;
        }
        if (renamed) {
          annStore.rev++;
          persistAnnotations(function () {
            sendJSON(res, 200, { rev: batchStore.rev, batch: batchSummary(batch) });
          });
        } else {
          sendJSON(res, 200, { rev: batchStore.rev, batch: batchSummary(batch) });
        }
      });
    });
    return;
  }

  /* ---- POST /api/review-batches/:id/members：加入 / 移出批注 ---- */
  if (sub === "members" && req.method === "POST") {
    if (rejectArchived()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      const mode = payload && payload.mode === "remove" ? "remove" : "add";
      const idsCheck = review.validateAnnotationIds(payload && payload.annotationIds);
      if (!idsCheck.ok) { apiError(res, idsCheck.status, idsCheck.code, idsCheck.message); return; }
      const ids = idsCheck.value;
      const actor = review.validateAuthor(payload && payload.actor).value;
      const now = new Date().toISOString();

      const memberSet = new Set(batch.memberIds);
      let missing, conflicts, notMembers;
      if (mode === "add") {
        missing = ids.filter(function (aid) { return !findAnn(aid); });
        if (missing.length) {
          apiError(res, 404, "annotation_not_found",
            (missing.length === 1 ? "所选批注不存在或已被删除"
                                 : "有 " + missing.length + " 条所选批注不存在或已被删除") +
            "，本次未改动任何成员，当前页面内容已保留",
            { missing: missing });
          return;
        }
        const idxAll = batchByMemberIndex();
        conflicts = ids.filter(function (aid) {
          return idxAll[aid] && idxAll[aid].id !== batch.id;
        });
        if (conflicts.length) {
          const other = batchByMemberIndex()[conflicts[0]];
          apiError(res, 409, "annotation_already_in_batch",
            "有 " + conflicts.length + " 条批注已属于其他审阅批次“" + other.name +
            (other.status === "archived" ? "”（已归档），不能重复加入" : "”，不能重复加入") +
            "，本次未改动任何成员",
            { conflictIds: conflicts, otherBatchId: other.id });
          return;
        }
      } else {
        notMembers = ids.filter(function (aid) { return !memberSet.has(aid); });
        if (notMembers.length) {
          // 移出时给出明确提示；不存在的批注单独报 404
          const absent = notMembers.filter(function (aid) { return !findAnn(aid); });
          if (absent.length) {
            apiError(res, 404, "annotation_not_found",
              "有 " + absent.length + " 条批注不存在或已被删除，本次未改动任何成员",
              { missing: absent });
            return;
          }
          apiError(res, 409, "not_batch_member",
            "有 " + notMembers.length + " 条批注不在批次“" + batch.name +
            "”中，本次未改动任何成员，当前页面内容已保留",
            { notMembers: notMembers });
          return;
        }
      }

      const backupIds = batch.memberIds.slice();
      const backupUpdated = batch.updatedAt;
      let logEntry;
      // 记录被改批注的原归属字段，供写盘失败时精确回滚
      const touchedAnns = [];
      const touchedPrev = [];
      function touch(a) {
        touchedPrev.push({ a: a, batchId: a.batchId, batchName: a.batchName });
        touchedAnns.push(a);
      }
      if (mode === "add") {
        ids.forEach(function (aid) {
          if (!memberSet.has(aid)) {
            batch.memberIds.push(aid);
            memberSet.add(aid);
            const a = findAnn(aid);
            touch(a);
            a.batchId = batch.id; a.batchName = batch.name;
          }
        });
        logEntry = {
          batchId: batch.id, batchName: batch.name, at: now, actor: actor,
          action: "members_add", detail: "加入 " + touchedAnns.length + " 条批注",
          annotationId: null
        };
      } else {
        const removeSet = new Set(ids);
        ids.forEach(function (aid) {
          const a = findAnn(aid);
          if (a) { touch(a); a.batchId = null; a.batchName = null; }
        });
        batch.memberIds = batch.memberIds.filter(function (mid) { return !removeSet.has(mid); });
        logEntry = {
          batchId: batch.id, batchName: batch.name, at: now, actor: actor,
          action: "members_remove", detail: "移出 " + ids.length + " 条批注",
          annotationId: null
        };
      }
      batch.updatedAt = now;
      batchStore.rev++;
      addBatchLog(logEntry);

      persistBatches(function (perr) {
        if (perr) {
          batch.memberIds = backupIds;
          batch.updatedAt = backupUpdated;
          batchStore.rev--;
          const li = batchStore.logs.indexOf(logEntry);
          if (li !== -1) batchStore.logs.splice(li, 1);
          touchedPrev.forEach(function (x) {
            x.a.batchId = x.batchId; x.a.batchName = x.batchName;
          });
          apiError(res, 500, "persist_failed", "成员更新失败，请重试");
          return;
        }
        annStore.rev++;
        persistAnnotations(function () {
          sendJSON(res, 200, { rev: batchStore.rev, batch: batchSummary(batch) });
        });
      });
    });
    return;
  }

  /* ---- POST /api/review-batches/:id/status：批量改成员状态（逐条/批量同一入口） ---- */
  if (sub === "status" && req.method === "POST") {
    if (rejectArchived()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (!payload || !review.validAnnStatus(payload.status)) {
        apiError(res, 400, "invalid_status",
          "状态必须是 open（待处理）、in_progress（处理中）、needs_review（需复核）或 resolved（已解决）");
        return;
      }
      const idsCheck = review.validateAnnotationIds(payload.annotationIds);
      if (!idsCheck.ok) { apiError(res, idsCheck.status, idsCheck.code, idsCheck.message); return; }
      const ids = idsCheck.value;
      const actor = review.validateAuthor(payload.actor).value;

      // —— 全部前置校验：任何一个成员不存在/不属于本批次/被冻结，整批拒绝，不改任何状态 ——
      const missing = ids.filter(function (aid) { return !findAnn(aid); });
      if (missing.length) {
        apiError(res, 404, "annotation_not_found",
          (missing.length === 1 ? "所选批注不存在或已被删除"
                               : "有 " + missing.length + " 条所选批注不存在或已被删除") +
          "，本次批量更新未改动任何状态，当前页面内容已保留",
          { missing: missing });
        return;
      }
      const foreign = ids.filter(function (aid) { return batch.memberIds.indexOf(aid) === -1; });
      if (foreign.length) {
        // 属于已归档批次的成员给出更明确的提示
        const idxAll = batchByMemberIndex();
        const frozenOne = foreign.map(function (aid) { return idxAll[aid]; })
          .find(function (b2) { return b2 && b2.status === "archived"; });
        apiError(res, 409,
          frozenOne ? "annotation_frozen" : "not_batch_member",
          frozenOne
            ? "所选批注属于已归档批次“" + frozenOne.name + "”，其状态已冻结，批量更新已全部取消"
            : "有 " + foreign.length + " 条批注不在批次“" + batch.name +
              "”中，批量更新已全部取消，未覆盖任何状态",
          { foreignIds: foreign });
        return;
      }

      const now = new Date().toISOString();
      const backups = ids.map(function (aid) {
        const a = findAnn(aid);
        return {
          ann: a, status: a.status, resolvedAt: a.resolvedAt,
          resolvedBy: a.resolvedBy, updatedAt: a.updatedAt
        };
      });
      const prevBatchUpdated = batch.updatedAt;
      const logCountBefore = batchStore.logs.length; // 新增日志前的长度，供失败回滚
      let changed = 0;
      ids.forEach(function (aid) {
        const a = findAnn(aid);
        if (a.status !== payload.status) {
          changed++;
          addBatchLog({
            batchId: batch.id, batchName: batch.name, at: now, actor: actor,
            action: "status_change",
            detail: "批注状态：" + review.annStatusLabel(a.status) +
                    " → " + review.annStatusLabel(payload.status),
            annotationId: a.id
          });
        }
        a.status = payload.status;
        if (payload.status === "resolved") {
          a.resolvedAt = now;
          a.resolvedBy = actor;
        } else {
          a.resolvedAt = null;
          a.resolvedBy = null;
        }
        a.updatedAt = now;
      });
      batch.updatedAt = now;
      annStore.rev++;
      batchStore.rev++; // 成员状态变化推进批次 rev：旧批次页面的批量更新必被版本锁拒绝

      persistAnnotations(function (perr) {
        if (perr) {
          backups.forEach(function (bk) {
            bk.ann.status = bk.status; bk.ann.resolvedAt = bk.resolvedAt;
            bk.ann.resolvedBy = bk.resolvedBy; bk.ann.updatedAt = bk.updatedAt;
          });
          annStore.rev--; batchStore.rev--;
          batch.updatedAt = prevBatchUpdated;
          batchStore.logs.splice(logCountBefore);
          apiError(res, 500, "persist_failed", "批量状态更新失败，请重试");
          return;
        }
        persistBatches(function (berr) {
          if (berr) {
            backups.forEach(function (bk) {
              bk.ann.status = bk.status; bk.ann.resolvedAt = bk.resolvedAt;
              bk.ann.resolvedBy = bk.resolvedBy; bk.ann.updatedAt = bk.updatedAt;
            });
            annStore.rev--; batchStore.rev--;
            batch.updatedAt = prevBatchUpdated;
            batchStore.logs.splice(logCountBefore);
            console.error("batch status persist failed:", berr);
            apiError(res, 500, "persist_failed", "批量状态更新失败，请重试");
            return;
          }
          sendJSON(res, 200, {
            rev: batchStore.rev,
            annotationRev: annStore.rev,
            batch: batchSummary(batch),
            changed: changed,
            unchanged: ids.length - changed
          });
        });
      });
    });
    return;
  }

  /* ---- POST /api/review-batches/:id/archive：归档（冻结成员状态，留完整历史） ---- */
  if (sub === "archive" && req.method === "POST") {
    if (rejectArchived()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload = {};
      if (raw) {
        try { payload = JSON.parse(raw) || {}; }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      }
      const actor = review.validateAuthor(payload.actor).value;
      const now = new Date().toISOString();

      // 归档瞬间冻结成员批注的完整内容（之后批注状态变化与成员列表都不再影响该批次）
      const snapshot = batch.memberIds.map(function (aid) {
        return review.snapshotDigest([findAnn(aid)])[0];
      }).filter(Boolean);
      if (snapshot.length !== batch.memberIds.length) {
        apiError(res, 409, "member_missing",
          "批次中有批注已不存在，无法归档；请刷新后核对成员列表");
        return;
      }
      const prev = {
        status: batch.status, archivedAt: batch.archivedAt,
        archivedBy: batch.archivedBy, memberSnapshot: batch.memberSnapshot,
        updatedAt: batch.updatedAt
      };
      batch.status = "archived";
      batch.archivedAt = now;
      batch.archivedBy = actor;
      batch.memberSnapshot = snapshot;
      batch.updatedAt = now;
      batchStore.rev++;
      const logEntry = {
        batchId: batch.id, batchName: batch.name, at: now, actor: actor,
        action: "batch_archive",
        detail: "批次归档：" + batch.memberIds.length +
                " 条批注状态已冻结，归档后仅可查看完整历史",
        annotationId: null
      };
      addBatchLog(logEntry);
      persistBatches(function (perr) {
        if (perr) {
          batch.status = prev.status; batch.archivedAt = prev.archivedAt;
          batch.archivedBy = prev.archivedBy; batch.memberSnapshot = prev.memberSnapshot;
          batch.updatedAt = prev.updatedAt;
          batchStore.rev--;
          const li = batchStore.logs.indexOf(logEntry);
          if (li !== -1) batchStore.logs.splice(li, 1);
          apiError(res, 500, "persist_failed", "归档失败，请重试");
          return;
        }
        sendJSON(res, 200, { rev: batchStore.rev, batch: batchSummary(batch) });
      });
    });
    return;
  }

  apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
}

/* ================= 审阅决策 API =================
 * parts: ["api", "review-decisions", ":id?", "submit"|"items"|"votes"|
 *          "preview"|"execute"|"undo"|"logs"?]
 * 锁模型：
 *   - 所有变更必须 If-Match 当前 X-Decision-Rev；决策集合 rev 是权威并发闸门，
 *     “多人同时修改草案时旧页面提交必被版本冲突拒绝”；
 *   - 创建额外校验批次未归档/未过期/同批次无活草案；
 *   - execute/undo 再逐条核对文本版本（请求回传当前段落）、批注版本
 *     （创建时记录的 updatedAt）、批次版本（成员归属），冲突只落在具体条目。
 */
function handleReviewDecisions(req, res, parts, urlObj) {
  const id = parts[2];
  const sub = parts[3];
  const validSubs = { submit: true, items: true, votes: true, preview: true,
                      execute: true, undo: true, logs: true };
  if (sub && !(id && validSubs[sub] && parts.length === 4)) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }
  if (parts.length > 4) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }

  /* ---- 集合级：GET 列表（可 ?batchId= 过滤）、POST 创建 ---- */
  if (!id) {
    if (req.method === "GET") {
      const bId = urlObj.searchParams.get("batchId");
      sendJSON(res, 200, publicDecisions(bId));
      return;
    }
    if (req.method === "POST") {
      if (checkLock(res, req.headers["if-match"], decisionStore.rev, "审阅决策集合")) return;
      readBody(req, function (err, raw) {
        if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
        let payload;
        try { payload = JSON.parse(raw); }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

        if (!payload || typeof payload.batchId !== "string") {
          apiError(res, 400, "invalid_body", "必须指定要派生决策草案的审阅批次");
          return;
        }
        const batch = findBatch(payload.batchId);
        if (!batch) {
          apiError(res, 404, "batch_not_found", "审阅批次不存在或已被删除");
          return;
        }
        if (batch.status === "archived") {
          apiError(res, 409, "batch_archived",
            "批次“" + batch.name + "”已归档，归档批次不能创建决策草案",
            { batchId: batch.id });
          return;
        }
        if (review.batchOverdue(batch)) {
          apiError(res, 409, "deadline_passed",
            "批次“" + batch.name + "”已过截止时间，不能再创建决策草案；" +
            "如需继续，请先在批次信息中调整截止时间（当前页面内容已保留）",
            { batchId: batch.id, deadline: batch.deadline });
          return;
        }
        if (decisionStore.decisions.length >= decision.LIMITS.DECISION_MAX_COUNT) {
          apiError(res, 413, "too_many_decisions",
            "决策草案总数已达 " + decision.LIMITS.DECISION_MAX_COUNT + " 个上限");
          return;
        }
        // 同一批次最多保留一个未结束（非已执行）的草案，避免方案分叉重复
        const dup = decisionStore.decisions.find(function (d) {
          return d.batchId === batch.id && d.status !== "executed";
        });
        if (dup) {
          apiError(res, 409, "duplicate_decision",
            "批次“" + batch.name + "”已有决策草案“" + dup.name +
            "”：请在原草案上继续投票/执行，或等其执行完成后再建新草案",
            { existingId: dup.id });
          return;
        }

        // 成员批注：活批次以 memberIds 的实时记录为准；成员缺失不能建草案
        const members = batch.memberIds.map(function (aid) { return findAnn(aid); });
        const missing = members.filter(function (a) { return !a; })
          .map(function (_, i) { return batch.memberIds[i]; });
        if (missing.length || !members.length) {
          apiError(res, 409, "member_missing",
            members.length
              ? "批次中有 " + missing.length + " 条批注已不存在，无法创建决策草案，请先核对批次成员"
              : "批次中没有批注，不能创建空的决策草案",
            { missing: missing });
          return;
        }
        const nameCheck = decision.validateName(payload.name, batch.name);
        if (!nameCheck.ok) { apiError(res, nameCheck.status, nameCheck.code, nameCheck.message); return; }
        const check = decision.validateCreatePayload(payload, members);
        if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }

        const now = new Date().toISOString();
        const actor = review.validateAuthor(payload.actor).value;
        // 基线文本：客户端回传创建草案时编辑区的当前段落
        const paragraphsCheck = core.validateSnapshotPayload(
          Object.assign({ name: "decision-baseline" },
            { paragraphs: payload.paragraphs || [] }));
        if (!paragraphsCheck.ok) {
          apiError(res, paragraphsCheck.status, paragraphsCheck.code,
            "当前文本快照无效：" + paragraphsCheck.message);
          return;
        }
        const baseline = paragraphsCheck.value.paragraphs;

        const d = {
          id: crypto.randomUUID(),
          batchId: batch.id,
          batchName: batch.name,
          name: nameCheck.value,
          status: "drafting",
          threshold: check.value.threshold,
          createdAt: now,
          updatedAt: now,
          submittedAt: null,
          readyAt: null,
          deadline: batch.deadline || null,
          createdBy: actor,
          // 三版本基线
          textRev: decision.textContentRev(baseline),
          annotationRev: annStore.rev,
          batchRev: batchStore.rev,
          baselineParagraphs: baseline,
          items: check.value.items.map(function (g) {
            const a = members.find(function (m) { return m.id === g.annotationId; });
            return {
              annotationId: a.id,
              paraIndex: a.paraIndex,
              start: a.start, end: a.end, quote: a.quote, paraDir: a.paraDir,
              annotationUpdatedAt: a.updatedAt || a.createdAt || now,
              disposition: g.disposition,
              replacement: g.replacement,
              updatedAt: g.disposition ? now : null,
              voteClearedAt: null,
              votes: [],
              voteHistory: []
            };
          }),
          executions: [],
          lastExecutionId: null
        };
        decisionStore.decisions.push(d);
        decisionStore.rev++;
        addDecisionLog({
          decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
          at: now, actor: actor, action: "decision_create",
          detail: "创建决策草案，通过人数门槛 " + d.threshold +
                  "；条目 " + d.items.length + " 条；文本版本 " + d.textRev.slice(0, 8) +
                  "、批注版本 " + d.annotationRev + "、批次版本 " + d.batchRev,
          annotationId: null
        });
        persistDecisions(function (perr) {
          if (perr) {
            decisionStore.decisions.pop();
            decisionStore.rev--;
            decisionStore.logs.pop();
            apiError(res, 500, "persist_failed", "决策草案创建失败，请重试");
            return;
          }
          sendJSON(res, 201, { rev: decisionStore.rev, decision: decisionSummary(d) });
        });
      });
      return;
    }
    apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
    return;
  }

  const d = findDecision(id);
  if (!d) {
    if (req.method === "GET") {
      apiError(res, 404, "decision_not_found", "决策草案不存在或已被删除");
      return;
    }
    if (checkLock(res, req.headers["if-match"], decisionStore.rev, "审阅决策集合")) return;
    apiError(res, 404, "decision_not_found", "决策草案不存在或已被删除");
    return;
  }
  const batch = findBatch(d.batchId);

  /* ---- 只读：详情 / 审阅记录 ---- */
  if (req.method === "GET" && !sub) {
    sendJSON(res, 200, publicDecisionFull(d));
    return;
  }
  if (sub === "logs" && req.method === "GET") {
    const params = urlObj.searchParams;
    let logs = decisionStore.logs.filter(function (l) { return l.decisionId === id; });
    const from = params.get("from");
    const to = params.get("to");
    if (from && !isNaN(Date.parse(from))) {
      logs = logs.filter(function (l) { return Date.parse(l.at) >= Date.parse(from); });
    }
    if (to && !isNaN(Date.parse(to))) {
      logs = logs.filter(function (l) { return Date.parse(l.at) <= Date.parse(to); });
    }
    logs = logs.slice().sort(function (a, b) { return b.at.localeCompare(a.at); });
    sendJSON(res, 200, { rev: decisionStore.rev, decisionId: id, logs: logs });
    return;
  }

  // 以下除 preview（只读计算）外均为变更类：必须带决策集合版本
  if (!(sub === "preview" && req.method === "POST")) {
    if (checkLock(res, req.headers["if-match"], decisionStore.rev, "审阅决策集合")) return;
  }

  function rejectFrozenOrExpired() {
    if (batch && batch.status === "archived") {
      apiError(res, 409, "batch_archived",
        "批次“" + batch.name + "”已归档，其决策草案只读，不能再改动或执行",
        { batchId: batch.id });
      return true;
    }
    if (d.status === "scheduled") {
      apiError(res, 409, "decision_scheduled",
        "草案“" + d.name + "”已发布到执行队列等待定时执行，方案与投票已锁定，" +
        "不能再修改或投票；请先在执行队列暂停后取消，再调整草案",
        { activeTaskId: d.activeTaskId || null });
      return true;
    }
    if (decision.isOverdue(d.deadline) && d.status !== "executed") {
      apiError(res, 409, "decision_expired",
        "批次已过截止时间（" + d.deadline + "），草案“" + d.name +
        "”已过期，不能再修改、投票或执行；请先调整批次截止时间后再试",
        { deadline: d.deadline });
      return true;
    }
    return false;
  }

  function persistDecision(backup, logEntries, ok, fail) {
    persistDecisions(function (perr) {
      if (perr) {
        backup();
        decisionStore.rev--;
        (logEntries || []).forEach(function (le) {
          const i = decisionStore.logs.indexOf(le);
          if (i !== -1) decisionStore.logs.splice(i, 1);
        });
        apiError(res, 500, "persist_failed", "决策保存失败，请重试");
        return;
      }
      ok();
    });
  }

  /* ---- PUT /api/review-decisions/:id：改名 / 调整通过人数（仅拟定中） ---- */
  if (!sub && req.method === "PUT") {
    if (rejectFrozenOrExpired()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (d.status !== "drafting") {
        apiError(res, 409, "decision_not_editable",
          "草案已进入投票，名称与通过人数不能再修改（当前页面内容已保留）");
        return;
      }
      const backup = {
        name: d.name, threshold: d.threshold, updatedAt: d.updatedAt
      };
      let changed = false;
      if (payload.name !== undefined) {
        const nc = decision.validateName(payload.name, batch.name);
        if (!nc.ok) { apiError(res, nc.status, nc.code, nc.message); return; }
        if (nc.value !== d.name) {
          d.name = nc.value; changed = true;
        }
      }
      if (payload.threshold !== undefined) {
        const tc = decision.validateThreshold(payload.threshold);
        if (!tc.ok) { apiError(res, tc.status, tc.code, tc.message); return; }
        if (tc.value !== d.threshold) {
          d.threshold = tc.value; changed = true;
        }
      }
      if (!changed) {
        apiError(res, 400, "no_change", "没有需要更新的字段");
        return;
      }
      const now = new Date().toISOString();
      d.updatedAt = now;
      const le = {
        decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
        at: now, actor: review.validateAuthor(payload.actor).value,
        action: "decision_update",
        detail: "草案更新：" +
          (backup.name !== d.name ? "名称“" + backup.name + "”→“" + d.name + "”；" : "") +
          (backup.threshold !== d.threshold ? "通过人数 " + backup.threshold + " → " + d.threshold : ""),
        annotationId: null
      };
      addDecisionLog(le);
      decisionStore.rev++;
      persistDecision(function () {
        d.name = backup.name; d.threshold = backup.threshold; d.updatedAt = backup.updatedAt;
      }, [le], function () {
        sendJSON(res, 200, { rev: decisionStore.rev, decision: decisionSummary(d) });
      });
    });
    return;
  }

  /* ---- PUT /api/review-decisions/:id/items：逐条填写/修改方案 ---- */
  if (sub === "items" && req.method === "PUT") {
    if (rejectFrozenOrExpired()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (d.status !== "drafting" && d.status !== "voting") {
        apiError(res, 409, "decision_not_editable",
          d.status === "executed" ? "草案已执行，方案不能再修改"
                                  : "草案当前状态不能修改方案");
        return;
      }
      const check = decision.validateItemsUpdate(payload, d);
      if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }
      const now = new Date().toISOString();
      const backup = d.items.map(function (it) {
        return {
          annotationId: it.annotationId, disposition: it.disposition,
          replacement: it.replacement, votes: it.votes.slice(),
          voteClearedAt: it.voteClearedAt, updatedAt: it.updatedAt
        };
      });
      const logEntries = [];
      let cleared = 0;
      check.value.items.forEach(function (patch) {
        const it = d.items.find(function (x) { return x.annotationId === patch.annotationId; });
        const rev = decision.reviseItem(it, patch, now);
        if (rev.changed) {
          it.disposition = rev.disposition;
          it.replacement = rev.replacement;
          it.votes = rev.votes;
          it.voteClearedAt = rev.voteClearedAt;
          it.updatedAt = rev.updatedAt;
          if (backup.find(function (b) {
            return b.annotationId === it.annotationId && b.votes.length;
          })) cleared++;
          logEntries.push({
            decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
            at: now, actor: review.validateAuthor(payload.actor).value,
            action: "items_update",
            detail: "方案更新为“" + decision.DISPOSITION_LABELS[patch.disposition] + "”" +
              (patch.disposition === "replace" ? "，替换文本 " + decision.cpLen(patch.replacement) + " 字符" : "") +
              (rev.changed && backup.find(function (b) {
                return b.annotationId === it.annotationId && b.votes.length;
              }) ? "（该条已有投票已作废，需重新投票）" : ""),
            annotationId: it.annotationId
          });
        }
      });
      if (!logEntries.length) {
        apiError(res, 400, "no_change", "方案没有变化");
        return;
      }
      d.updatedAt = now;
      logEntries.forEach(addDecisionLog);
      decisionStore.rev++;
      persistDecision(function () {
        d.items.forEach(function (it) {
          const b = backup.find(function (x) { return x.annotationId === it.annotationId; });
          if (!b) return;
          it.disposition = b.disposition; it.replacement = b.replacement;
          it.votes = b.votes; it.voteClearedAt = b.voteClearedAt; it.updatedAt = b.updatedAt;
        });
      }, logEntries, function () {
        sendJSON(res, 200, publicDecisionFull(d));
      });
    });
    return;
  }

  /* ---- POST /api/review-decisions/:id/submit：方案完成，进入投票 ---- */
  if (sub === "submit" && req.method === "POST") {
    if (rejectFrozenOrExpired()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload = {};
      if (raw) {
        try { payload = JSON.parse(raw) || {}; }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      }
      if (d.status !== "drafting") {
        apiError(res, 409, "decision_not_editable",
          d.status === "voting" ? "草案已在投票中" :
          d.status === "ready" ? "草案已达到通过门槛，等待执行" : "草案已执行");
        return;
      }
      const unfilled = d.items.filter(function (it) { return !it.disposition; })
        .map(function (it) { return it.annotationId; });
      if (unfilled.length) {
        apiError(res, 400, "empty_items",
          "还有 " + unfilled.length + " 条批注没有处理方案：每条都必须选择保留、替换或删除后才能提交投票（当前页面内容已保留）",
          { unfilled: unfilled });
        return;
      }
      const now = new Date().toISOString();
      const backup = { status: d.status, submittedAt: d.submittedAt, updatedAt: d.updatedAt };
      d.status = "voting";
      d.submittedAt = now;
      d.updatedAt = now;
      const le = {
        decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
        at: now, actor: review.validateAuthor(payload.actor).value,
        action: "decision_submit",
        detail: "方案填写完成并提交投票，通过人数门槛 " + d.threshold,
        annotationId: null
      };
      addDecisionLog(le);
      decisionStore.rev++;
      persistDecision(function () {
        d.status = backup.status; d.submittedAt = backup.submittedAt;
        d.updatedAt = backup.updatedAt;
      }, [le], function () {
        sendJSON(res, 200, publicDecisionFull(d));
      });
    });
    return;
  }

  /* ---- POST /api/review-decisions/:id/votes：逐条投票 ---- */
  if (sub === "votes" && req.method === "POST") {
    if (rejectFrozenOrExpired()) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (d.status === "drafting") {
        apiError(res, 409, "decision_not_voting",
          "草案尚未提交投票：请先为每条批注填写处理方案并提交（当前页面内容已保留）");
        return;
      }
      if (d.status === "executed") {
        apiError(res, 409, "decision_executed", "草案已执行，投票已关闭");
        return;
      }
      const check = decision.validateVotePayload(payload);
      if (!check.ok) { apiError(res, check.status, check.code, check.message); return; }
      const it = d.items.find(function (x) { return x.annotationId === check.value.annotationId; });
      if (!it) {
        apiError(res, 404, "item_not_found", "该批注不在此决策草案中");
        return;
      }
      if (!it.disposition) {
        apiError(res, 409, "item_has_no_disposition",
          "该条批注还没有处理方案，不能投票；请先补充方案");
        return;
      }
      const prev = d.status;
      const tallyBefore = decision.tallyVotes(it.votes).byVoter[check.value.voter];
      const now = new Date().toISOString();
      const backupItem = {
        votes: it.votes.slice(), voteHistory: it.voteHistory.slice(),
        status: d.status, readyAt: d.readyAt, updatedAt: d.updatedAt
      };
      const applied = decision.applyVote(it, check.value.voter, check.value.vote, now);
      it.votes = applied.votes;
      it.voteHistory = applied.voteHistory;
      d.updatedAt = now;
      const newStatus = decision.recomputeStatus(d);
      if (newStatus !== d.status) {
        d.status = newStatus;
        if (newStatus === "ready") d.readyAt = now;
      }
      const le = {
        decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
        at: now, actor: check.value.voter,
        action: "vote",
        detail: "投票“" + decision.VOTE_LABELS[check.value.vote] + "”" +
          (tallyBefore ? "（改票，原投票：" + decision.VOTE_LABELS[tallyBefore] + "）" : "") +
          (newStatus === "ready" && prev !== "ready" ? "；全部条目达标，草案进入待执行" : ""),
        annotationId: it.annotationId
      };
      addDecisionLog(le);
      decisionStore.rev++;
      persistDecision(function () {
        it.votes = backupItem.votes; it.voteHistory = backupItem.voteHistory;
        d.status = backupItem.status; d.readyAt = backupItem.readyAt;
        d.updatedAt = backupItem.updatedAt;
      }, [le], function () {
        sendJSON(res, 200, publicDecisionFull(d));
      });
    });
    return;
  }

  /* ---- POST /api/review-decisions/:id/preview：按段执行前预览（纯计算，不写盘） ---- */
  if (sub === "preview" && req.method === "POST") {
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      const vCheck = core.validateSnapshotPayload(
        Object.assign({ name: "decision-current" }, { paragraphs: payload.paragraphs || [] }));
      if (!vCheck.ok) { apiError(res, vCheck.status, vCheck.code, "当前文本快照无效：" + vCheck.message); return; }
      let selected = null;
      if (payload.annotationIds !== undefined) {
        const ic = review.validateAnnotationIds(payload.annotationIds);
        if (!ic.ok) { apiError(res, ic.status, ic.code, ic.message); return; }
        const foreign = ic.value.filter(function (aid) {
          return !d.items.some(function (it) { return it.annotationId === aid; });
        });
        if (foreign.length) {
          apiError(res, 409, "not_batch_member",
            "有 " + foreign.length + " 条批注不在该决策草案中", { foreignIds: foreign });
          return;
        }
        selected = ic.value;
      }
      const preview = decision.buildPreview(d, vCheck.value.paragraphs,
        annMap(), batch && batch.status !== "archived" ? batch.memberIds : [], selected);
      sendJSON(res, 200, {
        rev: decisionStore.rev,
        decision: decisionSummary(d),
        textChanged: preview.textChanged,
        baselineTextRev: preview.baselineTextRev,
        currentTextRev: preview.currentTextRev,
        counts: preview.counts,
        // 逐条判定（不分段），与执行结果结构一致，便于冲突汇总与勾选执行
        results: preview.results.map(function (r) {
          return {
            annotationId: r.annotationId, disposition: r.disposition,
            result: r.result, reason: r.reason,
            paraIndex: r.paraIndex, currentParaIndex: r.currentParaIndex
          };
        }),
        rows: preview.rows.map(function (row) {
          return {
            paraIndex: row.paraIndex,
            currentParaIndex: row.currentParaIndex,
            dirChanged: row.dirChanged,
            deleted: row.deleted,
            paraChanged: row.paraChanged,
            baseline: row.baseline,
            current: row.current,
            afterText: row.afterText,
            items: row.items.map(function (it) {
              return {
                annotationId: it.annotationId, quote: it.quote,
                start: it.start, end: it.end, paraDir: it.paraDir,
                disposition: it.disposition, replacement: it.replacement,
                afterText: it.afterText,
                voteState: it.voteState,
                approve: it.tally.counts.approve, reject: it.tally.counts.reject,
                abstain: it.tally.counts.abstain,
                result: it.result, reason: it.reason, selected: it.selected
              };
            })
          };
        })
      });
    });
    return;
  }

  /* ---- POST /api/review-decisions/:id/execute：三版本逐条校验 + 部分成功 ---- */
  if (sub === "execute" && req.method === "POST") {
    // 并发闸门用决策集合 rev：客户端必须带预览/详情时看到的版本
    if (checkLock(res, req.headers["if-match"], decisionStore.rev, "审阅决策集合")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (batch && batch.status === "archived") {
        apiError(res, 409, "batch_archived",
          "批次已归档，决策草案只读，不能执行");
        return;
      }
      if (decision.isOverdue(d.deadline)) {
        apiError(res, 409, "decision_expired",
          "批次已过截止时间，草案已过期，不能执行；请先调整批次截止时间");
        return;
      }
      if (d.status === "executed") {
        apiError(res, 409, "decision_executed",
          "该草案已经执行过，同一草案不能重复执行；如需恢复请使用“撤销最近一次执行”",
          { lastExecutionId: d.lastExecutionId });
        return;
      }
      if (d.status === "scheduled") {
        apiError(res, 409, "decision_scheduled",
          "草案已发布到执行队列，将由服务端在计划时间自动执行，不能再手动执行；" +
          "如需立即手动执行，请先在执行队列取消该任务",
          { activeTaskId: d.activeTaskId || null });
        return;
      }
      if (d.status !== "ready") {
        const p = decision.decisionProgress(d);
        apiError(res, 409, "decision_not_ready",
          "草案尚未达到执行条件：" + p.approved + "/" + p.total +
          " 条通过投票（有驳回或缺票时不能执行），当前状态：" +
          decision.STATUS_LABELS[d.status],
          { progress: p });
        return;
      }
      if (!batch) {
        apiError(res, 404, "batch_not_found", "草案所属批次已不存在，无法执行");
        return;
      }
      const vCheck = core.validateSnapshotPayload(
        Object.assign({ name: "decision-current" }, { paragraphs: payload.paragraphs || [] }));
      if (!vCheck.ok) { apiError(res, vCheck.status, vCheck.code, "当前文本快照无效：" + vCheck.message); return; }
      const currentParas = vCheck.value.paragraphs;

      let selected;
      if (payload.annotationIds != null) {
        const ic = review.validateAnnotationIds(payload.annotationIds);
        if (!ic.ok) { apiError(res, ic.status, ic.code, ic.message); return; }
        const foreign = ic.value.filter(function (aid) {
          return !d.items.some(function (it) { return it.annotationId === aid; });
        });
        if (foreign.length) {
          apiError(res, 409, "not_batch_member", "有批注不在该决策草案中", { foreignIds: foreign });
          return;
        }
        selected = ic.value;
      }

      const actor = review.validateAuthor(payload.actor).value;
      const result = runDecisionExecution(d, currentParas, {
        actor: actor, trigger: "manual", selectedIds: selected
      });
      decisionStore.rev++;

      persistDecisions(function (derr) {
        if (derr) {
          result.rollback();
          decisionStore.rev--;
          apiError(res, 500, "persist_failed", "决策执行记录保存失败，全部改动已回滚，请重试");
          return;
        }
        // 决策已落盘后再落批注/批次：失败也不回滚已成功的执行（与批次状态接口同策略），
        // 仅回滚内存中的 rev 推进，刷新后以批注存储为准；执行记录保留。
        if (result.successIds.length) {
          persistAnnotations(function (aerr) {
            if (aerr) console.error("decision execute annotation persist failed:", aerr);
            persistBatches(function (berr) {
              if (berr) console.error("decision execute batch persist failed:", berr);
              sendJSON(res, 200, executionResponse(result.ex, result.afterParas));
            });
          });
        } else {
          sendJSON(res, 200, executionResponse(result.ex, result.afterParas));
        }
      });

      function executionResponse(exRec, afterParas2) {
        return {
          rev: decisionStore.rev,
          decision: decisionSummary(d),
          executionId: exRec.id,
          applied: exRec.applied,
          counts: exRec.counts,
          status: d.status,
          // 服务端校验通过后合成的执行后段落：由客户端在确认后写入编辑区
          afterParagraphs: afterParas2,
          results: exRec.results,
          annotationRev: annStore.rev,
          batchRev: batchStore.rev
        };
      }
    });
    return;
  }

  /* ---- POST /api/review-decisions/:id/undo：撤销最近一次成功执行 ---- */
  if (sub === "undo" && req.method === "POST") {
    if (checkLock(res, req.headers["if-match"], decisionStore.rev, "审阅决策集合")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload = {};
      if (raw) {
        try { payload = JSON.parse(raw) || {}; }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      }
      if (batch && batch.status === "archived") {
        apiError(res, 409, "batch_archived", "批次已归档，不能撤销执行");
        return;
      }
      if (decision.isOverdue(d.deadline)) {
        apiError(res, 409, "decision_expired", "批次已过截止时间，不能撤销执行");
        return;
      }
      if (d.status !== "executed" || !d.lastExecutionId) {
        apiError(res, 409, "nothing_to_undo", "该草案没有可撤销的执行");
        return;
      }
      const ex = d.executions.find(function (x) { return x.id === d.lastExecutionId; });
      if (!ex || !ex.applied || ex.undone) {
        apiError(res, 409, "nothing_to_undo", "最近一次执行没有成功条目，或已经撤销过");
        return;
      }
      // 全局只允许撤销“最近一次成功执行”
      const latestApplied = decisionStore.decisions
        .reduce(function (acc, x) {
          const le2 = (x.executions || []).filter(function (e) {
            return e.applied && !e.undone;
          }).sort(function (a, b) { return b.at.localeCompare(a.at); })[0];
          if (le2 && (!acc || le2.at > acc.at)) return le2;
          return acc;
        }, null);
      if (!latestApplied || latestApplied.id !== ex.id) {
        apiError(res, 409, "not_latest_execution",
          "这不是最近一次成功执行：其后已有其他草案执行，请先撤销更新的执行",
          { latestExecutionId: latestApplied ? latestApplied.id : null });
        return;
      }

      const now = new Date().toISOString();
      const actor = review.validateAuthor(payload.actor).value;
      // 成功条目的批注：仅当执行后未再被改动时回滚为待处理；
      // 已被别人更新/删除的保留现状（不能覆盖新的批注）。
      // 回滚会产生新的 updatedAt：同步更新该条目的批注版本基线，
      // 否则重新执行时会被“批注版本已变化”误判为冲突而无法再次执行。
      const undoResults = ex.results.filter(function (r) {
        return r.result === "success";
      }).map(function (r) {
        const a = findAnn(r.annotationId);
        const it = d.items.find(function (x) { return x.annotationId === r.annotationId; });
        if (!a) return { annotationId: r.annotationId, reverted: false, reason: "annotation_deleted" };
        if (a.updatedAt !== ex.at || a.status !== "resolved") {
          // 执行后又被别人修改/删除：保留现状（不覆盖新批注），但把该条目的
          // 批注版本基线推进到撤销时刻的最新 updatedAt，否则重新执行时会被
          // 永远误判为 annotation_changed。
          if (it) it.annotationUpdatedAt = a.updatedAt || now;
          return { annotationId: r.annotationId, reverted: false, reason: "changed_since_execution" };
        }
        a.status = "open";
        a.resolvedAt = null;
        a.resolvedBy = null;
        a.updatedAt = now;
        if (it) it.annotationUpdatedAt = now;
        return { annotationId: r.annotationId, reverted: true };
      });
      const revertedIds = undoResults.filter(function (u) { return u.reverted; })
        .map(function (u) { return u.annotationId; });
      if (revertedIds.length) annStore.rev++;
      if (revertedIds.some(function (aid) { return batch && batch.memberIds.indexOf(aid) !== -1; })) {
        batch.updatedAt = now;
        batchStore.rev++;
      }

      const backupUndo = { status: d.status, updatedAt: d.updatedAt,
                           undone: ex.undone, undoneAt: ex.undoneAt, undo: ex.undo };
      ex.undone = true;
      ex.undoneAt = now;
      ex.undo = { at: now, actor: actor, results: undoResults };
      d.status = "ready"; // 撤销后草案回到待执行，允许再次执行
      d.updatedAt = now;

      const le = {
        decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
        at: now, actor: actor,
        action: "execute_undo",
        detail: "撤销最近一次执行：回滚批注 " + revertedIds.length + " 条；" +
          (undoResults.length - revertedIds.length) +
          " 条因执行后又被修改/删除而未回滚",
        annotationId: null
      };
      addDecisionLog(le);
      decisionStore.rev++;

      function rollbackAll() {
        undoResults.forEach(function (u) {
          if (!u.reverted) return;
          const a = findAnn(u.annotationId);
          if (!a) return;
          a.status = "resolved"; a.resolvedAt = ex.at; a.resolvedBy = ex.actor; a.updatedAt = ex.at;
          const it = d.items.find(function (x) { return x.annotationId === u.annotationId; });
          if (it) it.annotationUpdatedAt = ex.at;
        });
        if (revertedIds.length) annStore.rev--;
        if (revertedIds.some(function (aid) { return batch && batch.memberIds.indexOf(aid) !== -1; })) {
          batchStore.rev--;
        }
        d.status = backupUndo.status; d.updatedAt = backupUndo.updatedAt;
        ex.undone = backupUndo.undone; ex.undoneAt = backupUndo.undoneAt; ex.undo = backupUndo.undo;
        decisionStore.rev--;
        const li = decisionStore.logs.indexOf(le);
        if (li !== -1) decisionStore.logs.splice(li, 1);
      }

      persistDecisions(function (derr) {
        if (derr) {
          rollbackAll();
          apiError(res, 500, "persist_failed", "撤销记录保存失败，已回滚，请重试");
          return;
        }
        if (revertedIds.length) {
          persistAnnotations(function (aerr) {
            if (aerr) console.error("decision undo annotation persist failed:", aerr);
            persistBatches(function () {
              sendJSON(res, 200, {
                rev: decisionStore.rev,
                decision: decisionSummary(d),
                reverted: revertedIds.length,
                notReverted: undoResults.length - revertedIds.length,
                undoResults: undoResults,
                // 执行前的段落：由客户端确认后写回编辑区
                beforeParagraphs: ex.beforeParagraphs,
                annotationRev: annStore.rev,
                batchRev: batchStore.rev
              });
            });
          });
        } else {
          sendJSON(res, 200, {
            rev: decisionStore.rev,
            decision: decisionSummary(d),
            reverted: 0,
            notReverted: undoResults.length,
            undoResults: undoResults,
            beforeParagraphs: ex.beforeParagraphs,
            annotationRev: annStore.rev,
            batchRev: batchStore.rev
          });
        }
      });
    });
    return;
  }

  apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
}

/* ================= 执行前审批（通过 / 拒绝 / 撤回） =================
 * 记名、同审批人最后一次未撤回决定为准（并发模型与草案逐条投票一致，
 * 不需要 If-Match）；任一审批人拒绝即否决，撤回拒绝后自动恢复审批进度。
 */
function taskApprovalResp(task) {
  const g = decision.computeGates(decisionStore.tasks);
  return {
    rev: decisionStore.rev,
    task: decision.taskSummary(task, g[task.id]),
    decision: findDecision(task.decisionId)
      ? decisionSummary(findDecision(task.decisionId), g) : null
  };
}

// 记录审批动作并在“达到门槛/被拒绝”切换时补充一条门控记录；全部关联审批快照。
function commitApproval(task, actorName, decisionVote, res, existingDecision) {
  const now = new Date().toISOString();
  const tallyBefore = decision.approvalTally(task.approval, task.approvalDecisions);
  const backup = (task.approvalDecisions || []).slice();
  let rec;
  if (existingDecision && existingDecision.withdrawnAt) {
    // 撤回后再次决定：复用该条，清空撤回时间（保留完整动作流水）
    rec = existingDecision;
    rec.decision = decisionVote;
    rec.at = now;
    rec.withdrawnAt = null;
  } else if (existingDecision && existingDecision.decision === decisionVote) {
    // 幂等：同一审批人重复相同决定，不写流水不推进版本
    sendJSON(res, 200, taskApprovalResp(task));
    return;
  } else {
    rec = { approver: actorName, decision: decisionVote, at: now, withdrawnAt: null };
    task.approvalDecisions.push(rec);
  }
  task.updatedAt = now;

  const logs = [];
  logs.push(addTaskLog(task,
    decisionVote === "approve" ? "task_approved" : "task_rejected",
    decisionVote === "approve"
      ? "审批人“" + actorName + "”通过执行前审批（当前 " +
        (tallyBefore.approved + (decisionVote === "approve" ? 1 : 0)) +
        "/" + task.approval.minApprovals + "）"
      : "审批人“" + actorName + "”拒绝执行前审批：任务在计划时间不会执行",
    { actor: actorName, snapshotId: task.approvalSnapshotId || null }));

  const tallyAfter = decision.approvalTally(task.approval, task.approvalDecisions);
  if (tallyBefore.state !== tallyAfter.state) {
    if (tallyAfter.state === "approved") {
      logs.push(addTaskLog(task, "task_approval_met",
        "执行前审批已达门槛（" + tallyAfter.approved + "/" +
        task.approval.minApprovals + "，无拒绝）；前置依赖满足后任务将在计划时间执行",
        { actor: actorName, snapshotId: task.approvalSnapshotId || null }));
    } else if (tallyAfter.state === "rejected") {
      logs.push(addTaskLog(task, "task_approval_rejected",
        "执行前审批被拒绝，任务已被审批门控阻断（撤回拒绝并补足通过后可继续）",
        { actor: actorName, snapshotId: task.approvalSnapshotId || null }));
    } else if (tallyBefore.state === "rejected" && tallyAfter.state === "pending") {
      logs.push(addTaskLog(task, "task_approval_reopened",
        "拒绝已撤回，执行前审批重新进入等待状态",
        { actor: actorName, snapshotId: task.approvalSnapshotId || null }));
    }
  }
  const gatesRes = reconcileTaskGates(actorName);

  decisionStore.rev++;
  persistDecisions(function (err) {
    if (err) {
      task.approvalDecisions = backup;
      gatesRes.rollback();
      decisionStore.rev--;
      apiError(res, 500, "persist_failed", "审批结果保存失败，已回滚，请重试");
      return;
    }
    sendJSON(res, 200, taskApprovalResp(task));
  });
}

function handleApprovalDecision(req, res, task, payload, now, actorField) {
  if (!task.approval) {
    apiError(res, 409, "approval_not_configured",
      "该任务没有配置执行前审批，无需审批；可在任务配置中添加审批人");
    return;
  }
  if (task.status !== "scheduled" && task.status !== "paused") {
    apiError(res, 409, "task_not_pending_approval",
      decision.taskIsTerminal(task)
        ? "任务已经" + (decision.TASK_STATUS_LABELS[task.status] || task.status) +
          "，不能再审批"
        : "任务正在执行中，不能再审批");
    return;
  }
  const vote = payload && payload.decision;
  if (vote !== "approve" && vote !== "reject") {
    apiError(res, 400, "invalid_approval_decision",
      "审批决定必须是 approve（通过）或 reject（拒绝）");
    return;
  }
  const nameChk = decision.validateApproverName(
    payload && payload.approver != null ? payload.approver : actorField);
  if (!nameChk.ok) { apiError(res, nameChk.status, nameChk.code, nameChk.message); return; }
  const name = nameChk.value;
  if (task.approval.approvers.indexOf(name) === -1) {
    apiError(res, 403, "not_approver",
      "“" + name + "”不是该任务的指定审批人；审批人：" +
      task.approval.approvers.join("、"));
    return;
  }
  const mine = (task.approvalDecisions || []).filter(function (x) {
    return x.approver === name;
  }).pop();
  if (mine && !mine.withdrawnAt && mine.decision === vote) {
    sendJSON(res, 200, taskApprovalResp(task)); // 幂等：重复相同审批
    return;
  }
  commitApproval(task, name, vote, res, mine);
}

// 撤回本人最近一次审批决定（approve/reject 都可撤回）
function handleApprovalWithdraw(req, res, taskId, rawApprover) {
  const task = findTask(taskId);
  if (!task) { apiError(res, 404, "task_not_found", "执行队列任务不存在或已被清理"); return; }
  readBody(req, function (err, raw) {
    if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
    let payload = {};
    if (raw) {
      try { payload = JSON.parse(raw) || {}; }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
    }
    if (!task.approval) {
      apiError(res, 409, "approval_not_configured", "该任务没有配置执行前审批");
      return;
    }
    if (task.status !== "scheduled" && task.status !== "paused") {
      apiError(res, 409, "task_not_pending_approval",
        "任务已经开始或结束，审批不能撤回");
      return;
    }
    const nameChk = decision.validateApproverName(
      payload.approver != null ? payload.approver : rawApprover);
    if (!nameChk.ok) { apiError(res, nameChk.status, nameChk.code, nameChk.message); return; }
    const name = nameChk.value;
    if (task.approval.approvers.indexOf(name) === -1) {
      apiError(res, 403, "not_approver",
        "“" + name + "”不是该任务的指定审批人；审批人：" +
        task.approval.approvers.join("、"));
      return;
    }
    const mine = (task.approvalDecisions || []).filter(function (x) {
      return x.approver === name;
    }).pop();
    if (!mine || mine.withdrawnAt) {
      apiError(res, 409, "approval_not_found",
        "“" + name + "”当前没有可撤回的审批决定");
      return;
    }
    const tallyBefore = decision.approvalTally(task.approval, task.approvalDecisions);
    const backupDecisions = (task.approvalDecisions || []).slice();
    const now = new Date().toISOString();
    const prevWithdrawn = mine.withdrawnAt;
    const prevAt = mine.at;
    mine.withdrawnAt = now;
    task.updatedAt = now;

    const logs = [];
    logs.push(addTaskLog(task, "task_approval_withdrawn",
      "审批人“" + name + "”撤回" +
      (mine.decision === "approve" ? "通过" : "拒绝") + "决定",
      { actor: name, snapshotId: task.approvalSnapshotId || null }));
    const tallyAfter = decision.approvalTally(task.approval, task.approvalDecisions);
    if (tallyBefore.state !== tallyAfter.state) {
      if (tallyAfter.state === "pending") {
        logs.push(addTaskLog(task,
          tallyBefore.state === "rejected" ? "task_approval_reopened" : "task_approval_reset",
          tallyBefore.state === "rejected"
            ? "拒绝已撤回，执行前审批重新进入等待状态"
            : "撤回后通过人数不足门槛，继续等待执行前审批",
          { actor: name, snapshotId: task.approvalSnapshotId || null }));
      }
    }
    const gatesRes = reconcileTaskGates(name);
    decisionStore.rev++;
    persistDecisions(function (perr) {
      if (perr) {
        mine.withdrawnAt = prevWithdrawn;
        mine.at = prevAt;
        task.approvalDecisions = backupDecisions;
        gatesRes.rollback();
        decisionStore.rev--;
        apiError(res, 500, "persist_failed", "撤回保存失败，已回滚，请重试");
        return;
      }
      sendJSON(res, 200, taskApprovalResp(task));
    });
  });
}

/* ================= 决策执行队列 API =================
 * parts: ["api", "execution-tasks", ":id?",
 *         "pause"|"resume"|"cancel"|"retry"|"logs"|"config"|"approvals"|"continue"?]
 * 另有 ["api","execution-tasks",":id","approvals",":approver","withdraw"]（撤回审批）。
 * 锁模型与决策一致：配置/暂停/恢复/取消/重试等变更必须 If-Match 当前
 * X-Decision-Rev（任务与草案共用决策集合 rev），多人用旧页面操作一律
 * 409 version_conflict 且不写盘；逐条审批/撤回按“审批人最后一次决定”
 * 收敛（与草案投票同一并发模型），不需要 If-Match。
 */
function handleExecutionTasks(req, res, parts, urlObj) {
  const id = parts[2];
  const sub = parts[3];
  const validSubs = {
    pause: true, resume: true, cancel: true, retry: true, logs: true,
    config: true, approvals: true, continue: true
  };
  // 审批撤回：…/:id/approvals/:approver/withdraw（parts 共 6 段）
  if (parts.length === 6 && id && parts[3] === "approvals" &&
      parts[5] === "withdraw" && req.method === "POST") {
    handleApprovalWithdraw(req, res, id, parts[4], urlObj);
    return;
  }
  if (sub && !(id && validSubs[sub] && parts.length === 4)) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }
  if (parts.length > 4) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }

  /* ---- 集合级：GET 队列（可 ?status= 过滤） ---- */
  if (!id) {
    if (req.method === "GET") {
      const st = urlObj.searchParams.get("status");
      sendJSON(res, 200, publicTasks(st));
      return;
    }
    if (req.method === "POST") {
      // 发布决策草案到执行队列
      if (checkLock(res, req.headers["if-match"], decisionStore.rev, "审阅决策集合")) return;
      readBody(req, function (err, raw) {
        if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
        let payload;
        try { payload = JSON.parse(raw); }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

        if (!payload || typeof payload.decisionId !== "string") {
          apiError(res, 400, "invalid_body",
            "发布到执行队列必须指定 decisionId（当前表单内容已保留）");
          return;
        }
        // 生效时间：缺省/过去时间都明确拒绝（错误信息里说明表单已保留）
        const when = decision.validateScheduledAt(payload.scheduledAt);
        if (!when.ok) { apiError(res, when.status, when.code, when.message); return; }

        // 执行前审批配置（可选）：1~3 名互不重复的审批人 + 最少通过人数
        const apChk = decision.validateApprovalConfig(payload);
        if (!apChk.ok) { apiError(res, apChk.status, apChk.code, apChk.message); return; }
        // 前置任务（可选）：先归一化，再在完整任务图上拒绝自依赖/循环/不存在
        const depChk0 = decision.normalizeDependencyIds(payload.dependencies);
        if (!depChk0.ok) { apiError(res, depChk0.status, depChk0.code, depChk0.message); return; }
        const depChk = decision.validateTaskDependencies(null, depChk0.value, decisionStore.tasks);
        if (!depChk.ok) { apiError(res, depChk.status, depChk.code, depChk.message); return; }

        if (decisionStore.tasks.length >= decision.LIMITS.TASK_MAX_COUNT) {
          apiError(res, 413, "too_many_tasks",
            "执行队列任务已达 " + decision.LIMITS.TASK_MAX_COUNT + " 个上限");
          return;
        }

        const d = findDecision(payload.decisionId);
        if (!d) {
          apiError(res, 404, "decision_not_found", "决策草案不存在或已被删除");
          return;
        }
        const batch = findBatch(d.batchId);
        if (!batch) {
          apiError(res, 404, "batch_not_found", "草案所属批次已不存在，不能发布");
          return;
        }
        if (batch.status === "archived") {
          apiError(res, 409, "batch_archived",
            "批次“" + batch.name + "”已归档，不能发布定时执行");
          return;
        }
        if (decision.isOverdue(d.deadline)) {
          apiError(res, 409, "decision_expired",
            "批次已过截止时间，草案已过期，不能发布；请先调整批次截止时间（当前表单内容已保留）");
          return;
        }
        // 只有“待执行”草案可发布；重复发布明确拒绝
        const existing = activeTaskOfDecision(d.id);
        if (existing) {
          apiError(res, 409, "task_already_scheduled",
            "草案“" + d.name + "”已在执行队列中（状态：" +
            (decision.TASK_STATUS_LABELS[existing.status] || existing.status) +
            "），不能重复发布；请先暂停/恢复/取消该任务",
            { existingTaskId: existing.id, taskStatus: existing.status });
          return;
        }
        if (d.status === "executed") {
          apiError(res, 409, "decision_executed",
            "草案已经执行完成，不能再发布到执行队列");
          return;
        }
        if (d.status !== "ready") {
          const p = decision.decisionProgress(d);
          apiError(res, 409, "decision_not_ready",
            "只有达到执行条件的“待执行”草案可以发布，当前状态：" +
            decision.STATUS_LABELS[d.status] + "（" + p.approved + "/" + p.total +
            " 条通过投票，当前表单内容已保留）",
            { progress: p });
          return;
        }
        // 生效时间不得晚于批次截止时间，否则任务到点必被过期阻断
        if (d.deadline && Date.parse(d.deadline) <= when.ms) {
          apiError(res, 409, "scheduled_after_deadline",
            "生效时间晚于批次截止时间（" + d.deadline +
            "），任务到点会因草案过期被阻断；请选择更早的时间或先调整批次截止时间（当前表单内容已保留）");
          return;
        }

        // 锁定发布时刻的文本（客户端回传当前编辑区）、批注与批次版本
        const vCheck = core.validateSnapshotPayload(
          Object.assign({ name: "task-lock" }, { paragraphs: payload.paragraphs || [] }));
        if (!vCheck.ok) {
          apiError(res, vCheck.status, vCheck.code,
            "发布时锁定文本无效：" + vCheck.message);
          return;
        }
        const lockParas = vCheck.value.paragraphs;
        const now = new Date().toISOString();
        const actor = review.validateAuthor(payload.actor).value;
        const task = {
          id: crypto.randomUUID(),
          decisionId: d.id,
          decisionName: d.name,
          batchId: d.batchId,
          batchName: d.batchName,
          status: "scheduled",
          publishedAt: now,
          publishedBy: actor,
          scheduledAt: when.value,
          scheduledAtMs: when.ms,
          pausedAt: null,
          pausedBy: null,
          pauseScheduledAt: null,
          resumedAt: null,
          finishedAt: null,
          cancelledAt: null,
          cancelReason: null,
          cancelBy: null,
          blockReason: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
          // 发布即锁定：文本/批注/批次/决策四个版本与当时文本
          lock: {
            at: now,
            paragraphs: lockParas,
            textRev: decision.textContentRev(lockParas),
            annotationRev: annStore.rev,
            batchRev: batchStore.rev,
            decisionRev: decisionStore.rev
          },
          // 定时执行基线更新为锁定文本：执行时按锁定文本对齐并逐条校验
          textRevBeforePublish: d.textRev,
          annotationRevBeforePublish: d.annotationRev,
          batchRevBeforePublish: d.batchRev,
          baselineParagraphsBeforePublish: d.baselineParagraphs,
          attempts: [],
          successAnnotationIds: [],
          lastCounts: null,
          lastExecutionId: null,
          snapshotId: null,
          // 前置任务与执行前审批
          dependencyIds: depChk.value,
          approval: apChk.value,
          approvalDecisions: [],
          continueConfirmed: Object.create(null),
          approvalSnapshotId: null,
          gateState: null,
          gateReason: null
        };

        // 草案三版本基线推进到发布时刻；baselineParagraphs 换成锁定文本
        d.baselineParagraphs = lockParas;
        d.textRev = task.lock.textRev;
        d.annotationRev = annStore.rev;
        d.batchRev = batchStore.rev;
        d.items.forEach(function (it) {
          const a = findAnn(it.annotationId);
          if (a) it.annotationUpdatedAt = a.updatedAt || a.createdAt || it.annotationUpdatedAt;
        });
        const prevStatus = d.status;
        d.status = "scheduled";
        d.scheduledAt = now;
        d.activeTaskId = task.id;
        d.updatedAt = now;

        decisionStore.tasks.push(task);

        // 发布瞬间计算门控（依赖/审批），并把级联结果写入相关活动任务
        const gatesPub = reconcileTaskGates(actor);

        // 配置了执行前审批：自动保存“执行前审批”快照，审批动作都关联它
        let approvalSnapshot = null;
        if (apChk.value) {
          approvalSnapshot = buildApprovalSnapshot(task, now, "publish");
          task.approvalSnapshotId = approvalSnapshot.id;
        }

        const depNames = depChk.value.map(function (pid) {
          const dt = findTask(pid);
          return "“" + (dt ? dt.decisionName : pid.slice(0, 8)) + "”";
        });
        const le = addTaskLog(task, "task_publish",
          "发布到执行队列：计划生效时间 " + when.value +
          "；锁定文本 " + lockParas.length + " 段（版本 " +
          task.lock.textRev.slice(0, 8) + "）、批注版本 " + task.lock.annotationRev +
          "、批次版本 " + task.lock.batchRev + "、决策版本 " + task.lock.decisionRev +
          (depNames.length ? "；前置任务 " + depNames.join("、") : "；无前置任务") +
          (apChk.value ? "；执行前审批 " + apChk.value.approvers.join("、") +
            "（至少 " + apChk.value.minApprovals + " 人通过）" : ""),
          approvalSnapshot ? { snapshotId: approvalSnapshot.id } : null);

        // 门控不是 ready 时，日志立即说明等待原因（到点未满足前置条件不会误执行）
        const tg = decision.taskGate(task, decisionStore.tasks);
        let glePub = null;
        if (tg.state !== "ready") {
          glePub = addTaskLog(task, "task_gate_waiting",
            "任务已排期但前置条件未满足，当前等待原因：" +
            describeGateForLog(tg) + "；条件满足后只自动放行一次",
            { snapshotId: task.approvalSnapshotId || null, actor: actor });
        }

        commitDecisionStore({
          snapshot: approvalSnapshot,
          domainRollback: function () {
            d.baselineParagraphs = task.baselineParagraphsBeforePublish;
            d.textRev = task.textRevBeforePublish;
            d.annotationRev = task.annotationRevBeforePublish;
            d.batchRev = task.batchRevBeforePublish;
            d.status = prevStatus;
            d.scheduledAt = null;
            d.activeTaskId = null;
            d.updatedAt = now;
            const idx = decisionStore.tasks.indexOf(task);
            if (idx !== -1) decisionStore.tasks.splice(idx, 1);
            gatesPub.rollback();
            [le, glePub].forEach(function (x) {
              if (!x) return;
              const li = decisionStore.logs.indexOf(x);
              if (li !== -1) decisionStore.logs.splice(li, 1);
            });
          }
        }, function (ok) {
          if (!ok) {
            apiError(res, 500, "persist_failed", "发布失败，请重试（表单内容已保留）");
            return;
          }
          sendJSON(res, 201, {
            rev: decisionStore.rev,
            task: decision.taskSummary(task, decision.taskGate(task, decisionStore.tasks)),
            decision: decisionSummary(d, decision.computeGates(decisionStore.tasks))
          });
        });
      });
      return;
    }
    apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
    return;
  }

  const task = findTask(id);
  if (!task) {
    apiError(res, 404, "task_not_found", "执行队列任务不存在或已被清理");
    return;
  }
  const d = findDecision(task.decisionId);
  const batch = d ? findBatch(d.batchId) : null;

  /* ---- 只读：任务详情 / 任务记录（按时间筛选） ---- */
  if (req.method === "GET" && !sub) {
    const g = decision.computeGates(decisionStore.tasks);
    sendJSON(res, 200, {
      rev: decisionStore.rev,
      task: decision.taskSummary(task, g[task.id]),
      decision: d ? decisionSummary(d, g) : null
    });
    return;
  }
  if (sub === "logs" && req.method === "GET") {
    const params = urlObj.searchParams;
    let logs = decisionStore.logs.filter(function (l) { return l.taskId === id; });
    const from = params.get("from");
    const to = params.get("to");
    if (from && !isNaN(Date.parse(from))) {
      logs = logs.filter(function (l) { return Date.parse(l.at) >= Date.parse(from); });
    }
    if (to && !isNaN(Date.parse(to))) {
      logs = logs.filter(function (l) { return Date.parse(l.at) <= Date.parse(to); });
    }
    logs = logs.slice().sort(function (a, b) { return b.at.localeCompare(a.at); });
    sendJSON(res, 200, { rev: decisionStore.rev, taskId: id, logs: logs });
    return;
  }

  // 执行前审批（通过/拒绝）按审批人记名，同草案投票：不要求 If-Match，
  // 同一审批人重复操作以最后一次决定为准，与配置修改的清空语义各自收敛。
  if (sub === "approvals" && req.method === "POST") {
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload = {};
      if (raw) {
        try { payload = JSON.parse(raw) || {}; }
        catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
      }
      handleApprovalDecision(req, res, task, payload,
        new Date().toISOString(), review.validateAuthor(payload.actor).value);
    });
    return;
  }

  // 以下均为变更类：必须带决策集合版本
  if (checkLock(res, req.headers["if-match"], decisionStore.rev, "审阅决策集合")) return;

  readBody(req, function (err, raw) {
    if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
    let payload = {};
    if (raw) {
      try { payload = JSON.parse(raw) || {}; }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }
    }
    const now = new Date().toISOString();
    const actor = review.validateAuthor(payload.actor).value;

    // 变更类通用提交：先把级联门控（依赖状态变化可能影响其他任务）写回，
    // 再统一 rev++ 落盘；失败时调用方回滚业务字段、门控字段并移除日志。
    function save(ok, rollback, gateRec) {
      const gatesRes = gateRec || reconcileTaskGates(actor);
      decisionStore.rev++;
      persistDecisions(function (perr) {
        if (perr) {
          rollback();
          gatesRes.rollback();
          decisionStore.rev--;
          apiError(res, 500, "persist_failed", "任务状态保存失败，已回滚，请重试");
          return;
        }
        ok();
      });
    }
    function okResp() {
      const g = decision.computeGates(decisionStore.tasks);
      sendJSON(res, 200, {
        rev: decisionStore.rev,
        task: decision.taskSummary(task, g[task.id]),
        decision: d ? decisionSummary(d, g) : null
      });
    }

    /* ---- POST .../:id/pause：暂停尚未开始的任务 ---- */
    if (sub === "pause" && req.method === "POST") {
      if (task.status === "paused") {
        apiError(res, 409, "task_not_active", "任务已经是暂停状态");
        return;
      }
      if (task.status !== "scheduled") {
        apiError(res, 409, "task_not_active",
          decision.taskIsTerminal(task)
            ? "任务已经" + (decision.TASK_STATUS_LABELS[task.status] || task.status) +
              "，不能再暂停"
            : "任务正在执行中，不能暂停");
        return;
      }
      const backup = {
        status: task.status, pausedAt: task.pausedAt, pausedBy: task.pausedBy,
        pauseScheduledAt: task.pauseScheduledAt, updatedAt: task.updatedAt
      };
      task.status = "paused";
      task.pausedAt = now;
      task.pausedBy = actor;
      task.pauseScheduledAt = task.scheduledAt;
      task.updatedAt = now;
      const le = addTaskLog(task, "task_pause",
        "暂停任务：原计划生效时间 " + task.scheduledAt + "，恢复后重新计时");
      save(okResp, function () {
        task.status = backup.status; task.pausedAt = backup.pausedAt;
        task.pausedBy = backup.pausedBy;
        task.pauseScheduledAt = backup.pauseScheduledAt;
        task.updatedAt = backup.updatedAt;
        const i = decisionStore.logs.indexOf(le);
        if (i !== -1) decisionStore.logs.splice(i, 1);
      });
      return;
    }

    /* ---- POST .../:id/resume：恢复暂停的任务（可给新时间） ---- */
    if (sub === "resume" && req.method === "POST") {
      if (task.status !== "paused") {
        apiError(res, 409, "task_not_paused",
          task.status === "scheduled" ? "任务正在等待生效，无需恢复"
          : "只有已暂停的任务可以恢复（当前：" +
            (decision.TASK_STATUS_LABELS[task.status] || task.status) + "）");
        return;
      }
      // 给了新生效时间就必须是未来；没给：原时间仍在未来则沿用，已过则立即（下轮询）执行
      let nextAt = null;
      if (payload.scheduledAt != null && payload.scheduledAt !== "") {
        const wc = decision.validateScheduledAt(payload.scheduledAt);
        if (!wc.ok) { apiError(res, wc.status, wc.code, wc.message); return; }
        nextAt = wc;
      } else if (Date.parse(task.pauseScheduledAt || task.scheduledAt) > Date.now()) {
        nextAt = { value: task.pauseScheduledAt || task.scheduledAt,
                   ms: Date.parse(task.pauseScheduledAt || task.scheduledAt) };
      }
      if (nextAt && d && d.deadline && Date.parse(d.deadline) <= nextAt.ms) {
        apiError(res, 409, "scheduled_after_deadline",
          "恢复后的生效时间晚于批次截止时间（" + d.deadline + "），请选择更早的时间");
        return;
      }
      const backup = {
        status: task.status, scheduledAt: task.scheduledAt,
        scheduledAtMs: task.scheduledAtMs, resumedAt: task.resumedAt,
        pauseScheduledAt: task.pauseScheduledAt, updatedAt: task.updatedAt
      };
      task.status = "scheduled";
      task.resumedAt = now;
      task.updatedAt = now;
      let detail;
      if (nextAt) {
        task.scheduledAt = nextAt.value;
        task.scheduledAtMs = nextAt.ms;
        detail = "恢复任务：新生效时间 " + nextAt.value;
      } else {
        // 原计划时间已过：立即进入待执行（scheduledAt 保持过去时间，下轮询即触发）
        task.scheduledAtMs = Date.now();
        detail = "恢复任务：原计划时间已过，将立即执行";
      }
      const le = addTaskLog(task, "task_resume", detail);
      save(okResp, function () {
        task.status = backup.status; task.scheduledAt = backup.scheduledAt;
        task.scheduledAtMs = backup.scheduledAtMs; task.resumedAt = backup.resumedAt;
        task.pauseScheduledAt = backup.pauseScheduledAt;
        task.updatedAt = backup.updatedAt;
        const i = decisionStore.logs.indexOf(le);
        if (i !== -1) decisionStore.logs.splice(i, 1);
      });
      return;
    }

    /* ---- POST .../:id/cancel：取消尚未开始的任务 ---- */
    if (sub === "cancel" && req.method === "POST") {
      if (task.status !== "scheduled" && task.status !== "paused") {
        apiError(res, 409, "task_not_cancellable",
          decision.taskIsTerminal(task)
            ? "任务已经" + (decision.TASK_STATUS_LABELS[task.status] || task.status) +
              "，不能取消"
            : "任务正在执行中，不能取消");
        return;
      }
      if (!d) {
        apiError(res, 404, "decision_gone", "任务对应的草案已不存在，无法取消");
        return;
      }
      const backup = {
        status: task.status, cancelledAt: task.cancelledAt,
        cancelReason: task.cancelReason, cancelBy: task.cancelBy,
        finishedAt: task.finishedAt, updatedAt: task.updatedAt,
        dStatus: d.status, dActive: d.activeTaskId, dUpdated: d.updatedAt
      };
      task.status = "cancelled";
      task.cancelledAt = now;
      task.finishedAt = now;
      task.cancelReason = typeof payload.reason === "string" ? payload.reason.slice(0, 500) : null;
      task.cancelBy = actor;
      task.updatedAt = now;
      // 取消后草案退回待执行：可重新发布或手动执行
      d.status = "ready";
      d.activeTaskId = null;
      d.updatedAt = now;
      const le = addTaskLog(task, "task_cancel",
        "取消尚未开始的定时任务" +
        (task.cancelReason ? "：" + task.cancelReason : "") +
        "（草案退回待执行，可重新发布）");
      save(okResp, function () {
        task.status = backup.status; task.cancelledAt = backup.cancelledAt;
        task.cancelReason = backup.cancelReason; task.cancelBy = backup.cancelBy;
        task.finishedAt = backup.finishedAt; task.updatedAt = backup.updatedAt;
        d.status = backup.dStatus; d.activeTaskId = backup.dActive;
        d.updatedAt = backup.dUpdated;
        const i = decisionStore.logs.indexOf(le);
        if (i !== -1) decisionStore.logs.splice(i, 1);
      });
      return;
    }

    /* ---- PUT/POST .../:id/config：修改前置任务与审批配置 ----
     * 仅 scheduled/paused（尚未开始）可改；改审批人/门槛清空已有审批决定，
     * 改依赖在完整任务图上拒绝自依赖/循环/不存在；全部按当前决策版本并发校验。
     */
    if (sub === "config" && (req.method === "POST" || req.method === "PUT")) {
      if (task.status !== "scheduled" && task.status !== "paused") {
        apiError(res, 409, "task_config_locked",
          decision.taskIsTerminal(task)
            ? "任务已经" + (decision.TASK_STATUS_LABELS[task.status] || task.status) +
              "，前置任务与审批配置不能再修改"
            : "任务正在执行中，配置不能再修改");
        return;
      }
      // 依赖配置（字段缺省表示不改；显式 null/[] 表示清空）
      let nextDeps = null;
      if (payload.dependencies !== undefined) {
        const dn = decision.normalizeDependencyIds(payload.dependencies);
        if (!dn.ok) { apiError(res, dn.status, dn.code, dn.message); return; }
        const dc2 = decision.validateTaskDependencies(task.id, dn.value,
          decisionStore.tasks);
        if (!dc2.ok) { apiError(res, dc2.status, dc2.code, dc2.message); return; }
        nextDeps = dc2.value;
      }
      // 审批配置（字段缺省表示不改；显式 null 表示取消审批要求）
      let nextApproval;
      let approvalTouched = false;
      if (payload.approval !== undefined) {
        const ac = decision.validateApprovalConfig(payload);
        if (!ac.ok) { apiError(res, ac.status, ac.code, ac.message); return; }
        nextApproval = ac.value;
        approvalTouched = true;
      }

      const prevDeps = (task.dependencyIds || []).slice();
      const prevApproval = task.approval
        ? { approvers: task.approval.approvers.slice(),
            minApprovals: task.approval.minApprovals } : null;
      const prevDecisions = (task.approvalDecisions || []).slice();
      const prevSnapId = task.approvalSnapshotId || null;
      let prevContinue = null;
      const depsChanged = nextDeps &&
        (nextDeps.length !== prevDeps.length ||
         nextDeps.some(function (x, i) { return x !== prevDeps[i]; }));
      const approvalSame = approvalTouched &&
        JSON.stringify(nextApproval || null) === JSON.stringify(prevApproval);
      if (!depsChanged && (!approvalTouched || approvalSame)) {
        // 幂等：配置与当前一致，不写盘不推进版本
        okResp();
        return;
      }
      // 改审批配置：旧审批人名单/门槛作废，已有审批决定全部清空（重新审批）
      let approvalSnapshot = null;
      if (approvalTouched && !approvalSame) {
        task.approval = nextApproval;
        task.approvalDecisions = [];
        if (nextApproval) {
          approvalSnapshot = buildApprovalSnapshot(task, now,
            prevApproval ? "config_change" : "configured");
          task.approvalSnapshotId = approvalSnapshot.id;
        } else {
          task.approvalSnapshotId = null;
        }
      }
      if (depsChanged) {
        task.dependencyIds = nextDeps;
        // 前置关系整体重设：旧的“确认继续”记录不再适用，避免对新前置生效
        prevContinue = Object.assign({}, task.continueConfirmed || {});
        task.continueConfirmed = Object.create(null);
      }
      task.updatedAt = now;

      function depNames(ids) {
        return ids.map(function (pid) {
          const dt = findTask(pid);
          return "“" + (dt ? dt.decisionName : pid.slice(0, 8)) + "”";
        }).join("、");
      }
      const logsCfg = [];
      if (depsChanged) {
        logsCfg.push(addTaskLog(task, "task_dependencies_changed",
          "前置任务配置修改：" +
          (nextDeps.length ? depNames(nextDeps) : "无前置任务") +
          "（原配置：" + (prevDeps.length ? depNames(prevDeps) : "无前置任务") + "）"));
      }
      if (approvalTouched && !approvalSame) {
        logsCfg.push(addTaskLog(task, "task_approval_configured",
          nextApproval
            ? "执行前审批配置：审批人 " + nextApproval.approvers.join("、") +
              "，至少 " + nextApproval.minApprovals + " 人通过；此前审批记录已重置"
            : "已取消执行前审批要求",
          approvalSnapshot ? { snapshotId: approvalSnapshot.id } : null));
      }
      const gatesRes = reconcileTaskGates(actor);
      const tg = decision.taskGate(task, decisionStore.tasks);
      if (tg.state !== "ready") {
        logsCfg.push(addTaskLog(task, "task_gate_waiting",
          "配置修改后前置条件尚未满足，当前等待原因：" + describeGateForLog(tg),
          { snapshotId: task.approvalSnapshotId || null, actor: actor }));
      }

      commitDecisionStore({
        snapshot: approvalSnapshot,
        domainRollback: function () {
          task.dependencyIds = prevDeps;
          task.approval = prevApproval;
          task.approvalDecisions = prevDecisions;
          task.approvalSnapshotId = prevSnapId;
          if (depsChanged) task.continueConfirmed = prevContinue || Object.create(null);
          task.updatedAt = now;
          gatesRes.rollback();
          logsCfg.forEach(function (le) {
            const i = decisionStore.logs.indexOf(le);
            if (i !== -1) decisionStore.logs.splice(i, 1);
          });
        }
      }, function (ok) {
        if (!ok) {
          apiError(res, 500, "persist_failed", "配置保存失败，已回滚，请重试");
          return;
        }
        okResp();
      });
      return;
    }

    /* ---- POST .../:id/continue：负责人确认“前置部分成功”后继续 ---- */
    if (sub === "continue" && req.method === "POST") {
      if (task.status !== "scheduled") {
        apiError(res, 409, "task_not_active",
          "只有等待生效的任务可以确认继续（当前：" +
          (decision.TASK_STATUS_LABELS[task.status] || task.status) + "）");
        return;
      }
      const gate = decision.taskGate(task, decisionStore.tasks);
      const partials = gate.dependencies.filter(function (r) {
        return r.gate === "can_continue";
      });
      if (!partials.length) {
        apiError(res, 409, "gate_not_needs_continue",
          gate.state === "ready" ? "前置条件已满足，任务会按计划时间自动执行，无需确认"
          : "当前没有需要确认的部分成功前置（等待原因：" +
            (decision.GATE_STATE_LABELS[gate.state] || gate.state) + "）");
        return;
      }
      const prevConfirmed = Object.assign({}, task.continueConfirmed || {});
      const doneNow = [];
      partials.forEach(function (r) {
        if (!(task.continueConfirmed || {})[r.taskId]) {
          task.continueConfirmed = task.continueConfirmed || Object.create(null);
          task.continueConfirmed[r.taskId] = { at: now, by: actor };
          doneNow.push(r);
        }
      });
      task.updatedAt = now;
      const le = addTaskLog(task, "task_dependency_continue",
        "负责人确认继续：接受前置任务部分成功的结果" +
        (doneNow.map(function (r) {
          return "“" + (r.decisionName || r.taskId.slice(0, 8)) + "”";
        }).join("、")) +
        "；其余前置条件满足后任务将在计划时间执行（仅放行一次）");
      const gatesRes = reconcileTaskGates(actor);
      save(function () {
        okResp();
      }, function () {
        task.continueConfirmed = prevConfirmed;
        task.updatedAt = now;
        const i = decisionStore.logs.indexOf(le);
        if (i !== -1) decisionStore.logs.splice(i, 1);
      }, gatesRes);
      return;
    }

    /* ---- POST .../:id/retry：失败/部分成功/阻断任务的失败重试 ---- */
    if (sub === "retry" && req.method === "POST") {
      if (task.status === "scheduled" || task.status === "paused" ||
          task.status === "running") {
        apiError(res, 409, "task_not_finished",
          "任务尚未结束（" + (decision.TASK_STATUS_LABELS[task.status] || task.status) +
          "），不能重试；可暂停或取消");
        return;
      }
      if (task.status === "succeeded") {
        apiError(res, 409, "task_succeeded",
          "任务已全部成功，无需也不能重试（执行过程幂等，成功条目不会重复处理）");
        return;
      }
      if (task.status === "cancelled") {
        apiError(res, 409, "task_cancelled",
          "任务已被取消，不能重试；请在草案上重新发布");
        return;
      }
      if (!d) {
        apiError(res, 404, "decision_gone", "任务对应的草案已不存在，无法重试");
        return;
      }
      if (!batch) {
        apiError(res, 404, "batch_gone", "所属审阅批次已不存在，无法重试");
        return;
      }
      if (batch.status === "archived") {
        apiError(res, 409, "batch_archived", "批次已归档，不能重试执行");
        return;
      }
      if (decision.isOverdue(d.deadline)) {
        apiError(res, 409, "decision_expired",
          "批次已过截止时间，草案已过期，不能重试；请先调整批次截止时间");
        return;
      }
      if (d.status !== "ready") {
        apiError(res, 409, "decision_not_ready",
          "草案当前不是待执行状态（" + decision.STATUS_LABELS[d.status] + "），不能重试");
        return;
      }
      // 可选：用当前编辑区文本重新锁定；不给则沿用发布时锁定的文本。
      // 只有重新锁定（用户确认以当前文本/批注/批次版本为准）时才推进版本基线；
      // 普通“立即重试”沿用发布锁，因此仍冲突的条目会继续被判冲突，不会被误执行。
      const relock = payload.paragraphs != null;
      let lockParas = task.lock.paragraphs;
      let lockTextRev = task.lock.textRev;
      if (relock) {
        const vc = core.validateSnapshotPayload(
          Object.assign({ name: "task-retry-lock" }, { paragraphs: payload.paragraphs }));
        if (!vc.ok) { apiError(res, vc.status, vc.code, "重试锁定文本无效：" + vc.message); return; }
        lockParas = vc.value.paragraphs;
        lockTextRev = decision.textContentRev(lockParas);
      }
      // 重试时间：不给 → 立即（下轮询）；给了 → 必须未来且不晚于截止
      let runAt = { value: now, ms: Date.now() };
      if (payload.scheduledAt != null && payload.scheduledAt !== "") {
        const wc = decision.validateScheduledAt(payload.scheduledAt);
        if (!wc.ok) { apiError(res, wc.status, wc.code, wc.message); return; }
        runAt = wc;
      }
      if (d.deadline && Date.parse(d.deadline) <= runAt.ms) {
        apiError(res, 409, "scheduled_after_deadline",
          "重试生效时间晚于批次截止时间（" + d.deadline + "），请选择更早的时间");
        return;
      }

      const backup = {
        status: task.status, scheduledAt: task.scheduledAt,
        scheduledAtMs: task.scheduledAtMs, finishedAt: task.finishedAt,
        blockReason: task.blockReason, lastError: task.lastError,
        attemptsLen: task.attempts.length, updatedAt: task.updatedAt,
        lockParas: task.lock.paragraphs, lockTextRev: task.lock.textRev,
        lockAnnRev: task.lock.annotationRev, lockBatchRev: task.lock.batchRev,
        lockAt: task.lock.at,
        dStatus: d.status, dActive: d.activeTaskId, dUpdated: d.updatedAt,
        dBaseline: d.baselineParagraphs, dTextRev: d.textRev,
        dAnnRev: d.annotationRev, dBatchRev: d.batchRev,
        itemUpdated: d.items.map(function (it) {
          return { id: it.annotationId, t: it.annotationUpdatedAt };
        })
      };
      task.lock.paragraphs = lockParas;
      task.lock.textRev = lockTextRev;
      task.lock.at = now;
      if (relock) {
        // 重新锁定：批注/批次版本基线推进到当前（用户已核对当前内容）
        task.lock.annotationRev = annStore.rev;
        task.lock.batchRev = batchStore.rev;
      }
      task.lock.decisionRev = decisionStore.rev;
      task.status = "scheduled";
      task.scheduledAt = runAt.value;
      task.scheduledAtMs = runAt.ms;
      task.finishedAt = null;
      task.blockReason = null;
      task.updatedAt = now;
      task.attempts.push({
        at: now, kind: "retry", scheduledAt: runAt.value,
        status: "scheduled", reason: null,
        message: relock ? "用最新文本重新锁定后重试" : "沿用发布时锁定文本重试"
      });
      if (task.attempts.length > decision.LIMITS.TASK_ATTEMPT_MAX) {
        task.attempts.splice(0, task.attempts.length - decision.LIMITS.TASK_ATTEMPT_MAX);
      }
      // 执行引擎以草案自身的 baseline/版本为权威：重新锁定时一并推进，
      // 普通重试保持发布锁不动，仍冲突的条目会继续标冲突。
      d.baselineParagraphs = lockParas;
      d.textRev = lockTextRev;
      if (relock) {
        d.annotationRev = annStore.rev;
        d.batchRev = batchStore.rev;
        d.items.forEach(function (it) {
          const a = findAnn(it.annotationId);
          if (a) it.annotationUpdatedAt = a.updatedAt || a.createdAt || it.annotationUpdatedAt;
        });
      }
      d.status = "scheduled";
      d.activeTaskId = task.id;
      d.updatedAt = now;

      const remaining = d.items.length - (task.successAnnotationIds || []).length;
      const le = addTaskLog(task, "task_retry",
        (runAt.ms <= Date.now() + 1500 ? "立即重试" : "重新排期至 " + runAt.value) +
        "：剩余 " + remaining + " 条未成功条目将继续执行，已成功的 " +
        (task.successAnnotationIds || []).length + " 条不会重复处理" +
        (relock ? "；已用最新文本/批注/批次版本重新锁定（文本版本 " +
          lockTextRev.slice(0, 8) + "）" : "；沿用发布时锁定文本与版本"));
      save(okResp, function () {
        task.lock.paragraphs = backup.lockParas;
        task.lock.textRev = backup.lockTextRev;
        task.lock.annotationRev = backup.lockAnnRev;
        task.lock.batchRev = backup.lockBatchRev;
        task.lock.at = backup.lockAt;
        task.status = backup.status; task.scheduledAt = backup.scheduledAt;
        task.scheduledAtMs = backup.scheduledAtMs;
        task.finishedAt = backup.finishedAt;
        task.blockReason = backup.blockReason;
        task.lastError = backup.lastError;
        task.attempts.length = backup.attemptsLen;
        task.updatedAt = backup.updatedAt;
        d.status = backup.dStatus; d.activeTaskId = backup.dActive;
        d.updatedAt = backup.dUpdated;
        d.baselineParagraphs = backup.dBaseline;
        d.textRev = backup.dTextRev;
        d.annotationRev = backup.dAnnRev;
        d.batchRev = backup.dBatchRev;
        backup.itemUpdated.forEach(function (b) {
          const it = d.items.find(function (x) { return x.annotationId === b.id; });
          if (it) it.annotationUpdatedAt = b.t;
        });
        const i = decisionStore.logs.indexOf(le);
        if (i !== -1) decisionStore.logs.splice(i, 1);
      });
      return;
    }

    apiError(res, 405, "method_not_allowed", "该路径不支持此方法");
  });
}

/* ================= 决策定时执行调度器 =================
 *
 * 轮询 decisionStore.tasks 中 status=scheduled 且到达 scheduledAt 的任务，
 * 服务端自动执行发布时锁定的文本（仍逐条校验文本/批注/批次版本，冲突条目
 * 不覆盖新内容，其余条目继续完成）。
 *
 * 幂等：
 *   - runningIds 内存守卫保证同一任务在本进程内不会被重复触发；
 *   - 每次尝试只处理“尚未成功”的条目（task.successAnnotationIds 之外），
 *     服务重启或重试都不会重复处理已成功条目；
 *   - 重启时遗留的 running 任务标记为 interrupted（failed 终态，可重试），
 *     绝不在启动时自动补跑，避免与落盘到一半的批注状态重复。
 */
const SCHEDULER_INTERVAL_MS = Number(process.env.DECISION_SCHEDULER_INTERVAL_MS) || 1000;
const runningTaskIds = new Set();
let schedulerTimer = null;

function publicTasks(statusFilter) {
  var list = decisionStore.tasks.slice()
    .filter(function (t) { return !statusFilter || t.status === statusFilter; })
    .sort(function (a, b) {
      // 未结束的按计划时间正序，其余按结束时间倒序
      if (decision.taskIsActive(a) !== decision.taskIsActive(b)) {
        return decision.taskIsActive(a) ? -1 : 1;
      }
      var ka = decision.taskIsActive(a) ? a.scheduledAtMs : Date.parse(a.finishedAt || a.updatedAt || 0);
      var kb = decision.taskIsActive(b) ? b.scheduledAtMs : Date.parse(b.finishedAt || b.updatedAt || 0);
      return decision.taskIsActive(a) ? ka - kb : kb - ka;
    });
  // 一次性计算整张任务图门控（含活动任务间的传递阻断）
  const gates = decision.computeGates(decisionStore.tasks);
  return {
    rev: decisionStore.rev,
    tasks: list.map(function (t) { return decision.taskSummary(t, gates[t.id]); })
  };
}

// 定时执行成功后构造一份“执行后文本”快照对象（不立即落盘），
// 与任务、执行记录关联；由调度器在同一事务内原子持久化。
function buildExecutionSnapshot(d, task, afterParas, ex, now) {
  const batchLookup = new Map(
    batchStore.batches.map(function (b) {
      return [b.id, { id: b.id, name: b.name, status: b.status }];
    }));
  return {
    id: crypto.randomUUID(),
    name: "定时执行 " + d.name + "（" + now.replace(/[:T]/g, "-").slice(0, 19) + "）",
    createdAt: now,
    updatedAt: now,
    paragraphs: afterParas,
    annotations: review.snapshotDigest(annStore.annotations, batchLookup),
    annotationRev: annStore.rev,
    // decisions/executionTasks/decisionRev 在决策落盘前一刻统一填充，
    // 保证快照里记录的就是执行后的决策集合
    decisions: null,
    decisionRev: null,
    executionTasks: null,
    // 与执行任务关联：任务记录与执行记录都能回溯到这份快照
    source: "decision_task",
    taskId: task.id,
    executionId: ex.id
  };
}

// 整体阻断（不产生执行记录）：批次归档/草案过期/草案或批次消失。
function blockTask(task, d, reasonCode, message, now) {
  task.status = "blocked";
  task.blockReason = reasonCode;
  task.lastError = message;
  task.finishedAt = now;
  task.updatedAt = now;
  if (d) {
    d.status = "ready";
    d.activeTaskId = null;
    d.updatedAt = now;
  }
  (task.attempts || (task.attempts = [])).push({
    at: now, kind: "auto", scheduledAt: task.scheduledAt,
    status: "blocked", reason: reasonCode, message: message
  });
  return addTaskLog(task, "task_blocked",
    "到达生效时间但任务被阻断：" + message + "（草案退回待执行，可处理后重试）");
}

// 执行到达生效时间的任务。只在任务仍为 scheduled 且未在执行中时触发。
function fireDueTask(task) {
  if (task.status !== "scheduled" || runningTaskIds.has(task.id)) return;
  // 到点未满足前置条件（依赖未成功/需确认继续/审批未达门槛/被拒绝）绝不执行；
  // 等待原因与审批进度由 schedulerTick 的门控对账提前持久化并展示。
  const gate = decision.taskGate(task, decisionStore.tasks);
  if (gate.state !== "ready") return;
  const d = findDecision(task.decisionId);
  const batch = d ? findBatch(d.batchId) : null;
  const now = new Date().toISOString();

  // 记录本函数可能改动的全部字段，落盘失败时整体回滚，下一轮重新触发
  const taskBackup = {
    status: task.status, finishedAt: task.finishedAt, updatedAt: task.updatedAt,
    blockReason: task.blockReason, lastError: task.lastError,
    lastCounts: task.lastCounts, lastExecutionId: task.lastExecutionId,
    successAnnotationIds: (task.successAnnotationIds || []).slice(),
    snapshotId: task.snapshotId,
    attemptsLen: Array.isArray(task.attempts) ? task.attempts.length : 0
  };
  const decisionBackup = d ? {
    status: d.status, activeTaskId: d.activeTaskId, updatedAt: d.updatedAt,
    executionsLen: d.executions.length, lastExecutionId: d.lastExecutionId
  } : null;
  let result = null;
  let gateRec = null; // 终态后的下游门控级联（随本事务一起回滚）
  let extraLogs = []; // 本函数通过 addTaskLog 追加的任务级记录

  function restoreAll() {
    task.status = taskBackup.status;
    task.finishedAt = taskBackup.finishedAt;
    task.updatedAt = taskBackup.updatedAt;
    task.blockReason = taskBackup.blockReason;
    task.lastError = taskBackup.lastError;
    task.lastCounts = taskBackup.lastCounts;
    task.lastExecutionId = taskBackup.lastExecutionId;
    task.successAnnotationIds = taskBackup.successAnnotationIds.slice();
    task.snapshotId = taskBackup.snapshotId;
    if (Array.isArray(task.attempts)) task.attempts.length = taskBackup.attemptsLen;
    if (d) {
      d.status = decisionBackup.status;
      d.activeTaskId = decisionBackup.activeTaskId;
      d.updatedAt = decisionBackup.updatedAt;
      d.lastExecutionId = decisionBackup.lastExecutionId;
      d.executions.length = decisionBackup.executionsLen;
    }
    // runDecisionExecution 自身的执行/逐条记录由 rollback 移除；
    // blockTask 与终态任务日志在这里按引用移除。
    extraLogs.forEach(function (le) {
      const i = decisionStore.logs.indexOf(le);
      if (i !== -1) decisionStore.logs.splice(i, 1);
    });
    if (gateRec) gateRec.rollback();
    if (result) result.rollback();
    decisionStore.rev--;
    if (pendingSnapshot) {
      const i = store.snapshots.indexOf(pendingSnapshot);
      if (i !== -1) { store.snapshots.splice(i, 1); store.rev--; }
      pendingSnapshot = null;
    }
  }

  // pendingSnapshot：本次执行有成功条目时，要随决策一起落盘的自动快照。
  // “先快照落盘、再决策落盘”串行完成：快照里嵌入执行后的决策集合
  // （含任务与执行记录对该快照 id 的引用）。任一步失败都整体回滚，
  // 下一轮幂等重试，不出现二次 rev 推进或关联缺失。
  let pendingSnapshot = null;
  function commit(cb) {
    function finish() {
      decisionStore.rev++;
      persistDecisions(function (err) {
        if (err) {
          console.error("scheduled decision persist failed:", err);
          restoreAll();
          if (pendingSnapshot) {
            const i = store.snapshots.indexOf(pendingSnapshot);
            if (i !== -1) { store.snapshots.splice(i, 1); store.rev--; }
            pendingSnapshot = null;
          }
          if (cb) cb(false);
          return;
        }
        // 决策已落盘后再落批注/批次：失败不回滚已成功执行（与手动执行同策略）
        persistAnnotations(function (aerr) {
          if (aerr) console.error("scheduled annotation persist failed:", aerr);
          persistBatches(function (berr) {
            if (berr) console.error("scheduled batch persist failed:", berr);
            if (cb) cb(true);
          });
        });
      });
    }

    if (pendingSnapshot) {
      // 先把执行后的决策集合嵌入快照（此时引用的快照 id 已确定）
      pendingSnapshot.decisions = decision.decisionDigest(decisionStore.decisions);
      pendingSnapshot.decisionRev = decisionStore.rev + 1;
      pendingSnapshot.executionTasks = decision.taskDigest(decisionStore.tasks);
      store.snapshots.push(pendingSnapshot);
      store.rev++;
      persist(function (serr) {
        if (serr) {
          console.error("scheduled execution snapshot persist failed:", serr);
          const i = store.snapshots.indexOf(pendingSnapshot);
          if (i !== -1) { store.snapshots.splice(i, 1); store.rev--; }
          pendingSnapshot = null;
          restoreAll();
          if (cb) cb(false);
          return;
        }
        finish();
      });
      return;
    }
    finish();
  }

  runningTaskIds.add(task.id);
  function release() { runningTaskIds.delete(task.id); }

  // —— 整体阻断检查（不产生执行记录，草案退回待执行）——
  function block(reasonCode, message) {
    const le = blockTask(task, d, reasonCode, message, now);
    if (le) extraLogs.push(le);
    // 阻断也是终态：下游任务必须随之进入阻断，级联随本事务一起落盘/回滚
    gateRec = reconcileTaskGates("系统定时执行");
    gateRec.logs.forEach(function (gle) { extraLogs.push(gle); });
    commit(release);
  }
  if (!d) { block("decision_gone", "决策草案已不存在"); return; }
  if (!batch) { block("batch_gone", "所属审阅批次已不存在"); return; }
  if (batch.status === "archived") {
    block("batch_archived", "批次“" + batch.name + "”已归档，定时任务不能执行");
    return;
  }
  if (decision.isOverdue(d.deadline)) {
    block("decision_expired", "批次截止时间 " + d.deadline + " 已过，草案过期");
    return;
  }
  if (d.status !== "scheduled" || d.activeTaskId !== task.id) {
    block("decision_state_changed",
      "草案当前状态为“" + (decision.STATUS_LABELS[d.status] || d.status) +
      "”，不再等待该任务执行");
    return;
  }
  if (!task.lock || !Array.isArray(task.lock.paragraphs)) {
    block("lock_missing", "发布时锁定的文本缺失，无法自动执行");
    return;
  }

  // —— 逐条三版本校验执行；已成功条目幂等跳过 ——
  result = runDecisionExecution(d, task.lock.paragraphs, {
    actor: "系统定时执行",
    trigger: "scheduled",
    taskId: task.id,
    skipAnnotationIds: task.successAnnotationIds || [],
    // 部分成功时不立即把草案置 executed：由任务终态统一决定，
    // 保证失败重试仍可继续处理剩余条目。
    markExecuted: false
  });
  const c = result.ex.counts;
  const successNow = result.successIds.filter(function (id) {
    return (task.successAnnotationIds || []).indexOf(id) === -1;
  });
  task.successAnnotationIds = (task.successAnnotationIds || []).concat(successNow);
  task.lastCounts = c;
  task.lastExecutionId = result.ex.id;
  task.updatedAt = now;

  const totalItems = d.items.length;
  // 全部条目都必须在本次或之前的尝试中成功，才算 succeeded；
  // 本次仍有冲突（即使其他条目早已成功）也只能是 partial。
  const successSet = new Set(task.successAnnotationIds);
  const allDone = c.conflict === 0 &&
    d.items.every(function (it) { return successSet.has(it.annotationId); });

  function setTerminal(status) {
    task.status = status;
    task.finishedAt = now;
    task.attempts.push({
      at: now, kind: "auto", scheduledAt: task.scheduledAt,
      status: status, counts: c, executionId: result.ex.id, reason: null
    });
  }
  function logTask(action, detail) {
    const le = {
      decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
      at: now, actor: "系统定时执行", action: action, detail: detail,
      annotationId: null, taskId: task.id
    };
    addDecisionLog(le);
    extraLogs.push(le);
  }

  if (allDone) {
    setTerminal("succeeded");
    d.status = "executed";
    d.activeTaskId = null;
    logTask("task_succeeded",
      "定时执行全部成功：共 " + task.successAnnotationIds.length + " 条；执行记录 " +
      result.ex.id.slice(0, 8));
  } else if (task.successAnnotationIds.length > 0) {
    setTerminal("partial");
    d.status = "ready";
    d.activeTaskId = null;
    logTask("task_partial",
      "定时执行部分成功：成功 " + task.successAnnotationIds.length + "/" + totalItems +
      "；本次冲突 " + c.conflict + "、跳过 " + c.skipped +
      "。冲突条目不覆盖新内容，可处理后失败重试（成功条目不会重复处理）");
  } else {
    setTerminal("failed");
    d.status = "ready";
    d.activeTaskId = null;
    logTask("task_failed",
      "定时执行没有成功条目：冲突 " + c.conflict + "、跳过 " + c.skipped +
      "（草案退回待执行，可失败重试）");
  }

  // 有成功条目：先构造自动快照（内存），随后“先快照落盘、再决策落盘”。
  if (result.ex.applied) {
    pendingSnapshot = buildExecutionSnapshot(d, task, result.afterParas, result.ex, now);
    result.ex.snapshotId = pendingSnapshot.id;
    task.snapshotId = pendingSnapshot.id;
  }

  // 任务进入终态后立即重算下游活动任务门控（可继续/等待/阻断），
  // 与本次执行同一事务落盘；级联日志纳入 extraLogs 以便失败回滚。
  gateRec = reconcileTaskGates("系统定时执行");
  gateRec.logs.forEach(function (le) { extraLogs.push(le); });

  commit(function afterCommit(ok) {
    release();
  });
}

let gatePersisting = false;
function schedulerTick() {
  if (runningTaskIds.size > 0) return; // 上一个任务仍在落盘，等下一轮
  const nowMs = Date.now();

  // 先对账门控：HTTP 与上一进程可能留下未持久化的依赖状态变化
  // （重启后按持久化 gateState 展示，但这里统一以当前任务图重算一次）。
  // 门控有变化时先落盘，下一轮再触发，保证“只放行一次”与日志不丢。
  if (!gatePersisting) {
    let rec = null;
    try { rec = reconcileTaskGates("系统定时执行"); }
    catch (e) { console.error("gate reconcile failed:", e); rec = null; }
    if (rec && rec.changed) {
      gatePersisting = true;
      decisionStore.rev++;
      persistDecisions(function (err) {
        gatePersisting = false;
        if (err) {
          rec.rollback();
          decisionStore.rev--;
          console.error("gate reconcile persist failed:", err);
        }
      });
      return; // 本轮不触发执行，待门控落盘后的下一轮
    }
  }

  // 每轮只触发最早到期且门控已满足的一个任务：多个任务同轮触发时其内存
  // 改动与 rev 推进会交叉，串行化后回滚与计数都互不影响（其余下轮再触发）。
  const due = decisionStore.tasks
    .filter(function (t) {
      if (t.status !== "scheduled" || Number(t.scheduledAtMs) > nowMs) return false;
      // 双重保险：到点未满足前置条件绝不能误执行
      return decision.taskGate(t, decisionStore.tasks).state === "ready";
    })
    .sort(function (a, b) { return Number(a.scheduledAtMs) - Number(b.scheduledAtMs); });
  if (!due.length) return;
  try {
    fireDueTask(due[0]);
  } catch (e) {
    console.error("scheduled decision fire failed:", e);
  }
}

// 重启恢复：running 是上一进程崩溃/被杀时未及落终态的任务，
// 不自动补跑（可能批注已落盘一半），标记 interrupted 等待人工重试。
// 随后按当前任务图重算全部门控：依赖/审批状态随重启完整恢复，
// 已到点且条件满足的任务由调度器幂等补触发（成功条目不会重复处理）。
function recoverInterruptedTasks() {
  let changed = false;
  decisionStore.tasks.forEach(function (t) {
    if (t.status === "running") {
      const now = new Date().toISOString();
      t.status = "failed";
      t.finishedAt = now;
      t.updatedAt = now;
      t.blockReason = "interrupted";
      t.lastError = "服务重启时该任务正在执行，已中断，请核对执行记录后失败重试（成功条目不会重复处理）";
      const d = findDecision(t.decisionId);
      if (d && d.status === "scheduled") { d.status = "ready"; d.activeTaskId = null; }
      addTaskLog(t, "task_interrupted",
        "服务重启时任务正在执行，已自动标记为失败，可失败重试（已成功条目不会重复处理）");
      changed = true;
    }
  });
  // 重启后重算门控：门控字段已随每次变更持久化，此处只补齐结构性差异，
  // 状态未变化时 reconcile 幂等、不产生重复日志。
  const gateRec = reconcileTaskGates("系统重启");
  if (changed || gateRec.changed) {
    decisionStore.rev++;
    persistDecisions(function (err) {
      if (err) {
        gateRec.rollback();
        decisionStore.rev--;
        console.error("recover interrupted tasks persist failed:", err);
      }
    });
  }
}

function startScheduler() {
  if (schedulerTimer) return;
  recoverInterruptedTasks();
  schedulerTimer = setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

/* ================= 路由 ================= */

function handleAPI(req, res, pathname, urlObj) {
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  if (parts[1] === "snapshots" && parts.length <= 3) {
    handleSnapshots(req, res, parts);
    return;
  }
  if (parts[1] === "annotations" && parts.length <= 4) {
    handleAnnotations(req, res, parts);
    return;
  }
  if (parts[1] === "review-batches" && parts.length <= 4) {
    handleReviewBatches(req, res, parts, urlObj);
    return;
  }
  if (parts[1] === "review-decisions" && parts.length <= 4) {
    handleReviewDecisions(req, res, parts, urlObj);
    return;
  }
  if (parts[1] === "execution-tasks" && parts.length <= 6) {
    handleExecutionTasks(req, res, parts, urlObj);
    return;
  }
  if (parts[1] === "replay" && parts.length <= 7) {
    handleReplay(req, res, parts, urlObj);
    return;
  }
  apiError(res, 404, "not_found", "接口不存在");
}

/* ================= 静态文件 ================= */

http.createServer((req, res) => {
  let urlPath;
  let urlObj;
  try {
    urlObj = new URL(req.url, "http://localhost");
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("400 Bad Request: malformed URL encoding");
    return;
  }

  if (urlPath === "/api" || urlPath.indexOf("/api/") === 0) {
    handleAPI(req, res, urlPath.replace(/\/+$/, "") || "/api", urlObj);
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";

  // 防目录穿越
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\]*\.\.[/\\]*)+/, ""));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Bidi editor running at http://localhost:${PORT} (snapshots: ${DATA_FILE}, annotations: ${ANN_FILE})`);
});

// 启动时按批次成员表对账批注上的冗余归属字段（兼容批次功能上线前的旧批注文件）
syncAnnotationBatchFields();

// 启动决策定时执行调度器：恢复中断任务后按 DECISION_SCHEDULER_INTERVAL_MS 轮询
startScheduler();

module.exports = {
  core, review, decision, replay,
  store: store, annStore: annStore, batchStore: batchStore,
  decisionStore: decisionStore, replayStore: replayStore
};
