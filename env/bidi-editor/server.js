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
const REQUEST_BODY_LIMIT = 4 * 1024 * 1024; // 传输字节上限（校验逻辑另有字符上限）

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
    decisionRev: Number.isInteger(s.decisionRev) ? s.decisionRev : null
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

const decisionStore = { rev: 0, decisions: [], logs: [] };

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
  }
} catch (e) {
  // 文件不存在/损坏：以空存储启动，损坏文件不覆盖
}

function findDecision(id) {
  return decisionStore.decisions.find(function (d) { return d.id === id; });
}

function decisionIndexOfBatch(batchId) {
  return decisionStore.decisions
    .filter(function (d) { return d.batchId === batchId; })
    .map(function (d) { return d.id; });
}

// 决策审阅记录：草案创建/方案修改/投票/提交/执行/撤销全部留痕，可按时间查看。
function addDecisionLog(entry) {
  decisionStore.logs.push({
    id: entry.id || crypto.randomUUID(),
    decisionId: entry.decisionId || null,
    decisionName: entry.decisionName || null,
    batchId: entry.batchId || null,
    batchName: entry.batchName || null,
    at: entry.at || new Date().toISOString(),
    actor: entry.actor || "匿名",
    action: entry.action,
    detail: entry.detail || null,
    annotationId: entry.annotationId || null
  });
  if (decisionStore.logs.length > decision.LIMITS.LOG_MAX) {
    decisionStore.logs.splice(0, decisionStore.logs.length - decision.LIMITS.LOG_MAX);
  }
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

function decisionSummary(d) {
  const p = decision.decisionProgress(d);
  const batch = findBatch(d.batchId);
  return {
    id: d.id, batchId: d.batchId, batchName: d.batchName,
    name: d.name, status: d.status, threshold: d.threshold,
    createdAt: d.createdAt, updatedAt: d.updatedAt,
    submittedAt: d.submittedAt || null, readyAt: d.readyAt || null,
    deadline: d.deadline || null,
    itemCount: d.items.length,
    progress: p,
    frozen: !!(batch && batch.status === "archived"),
    overdue: decision.isOverdue(d.deadline) && d.status !== "executed",
    executed: d.status === "executed",
    lastExecutionId: d.lastExecutionId || null
  };
}

function publicDecisions(batchId) {
  var list = decisionStore.decisions.slice()
    .filter(function (d) { return !batchId || d.batchId === batchId; })
    .sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); })
    .map(decisionSummary);
  return { rev: decisionStore.rev, decisions: list };
}

function publicDecisionFull(d) {
  const batch = findBatch(d.batchId);
  return {
    rev: decisionStore.rev,
    decision: decisionSummary(d),
    batchFrozen: !!(batch && batch.status === "archived"),
    batchStatus: batch ? batch.status : null,
    annotationRev: d.annotationRev,
    batchRev: d.batchRev,
    textRev: d.textRev,
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
        undone: !!ex.undone, undoneAt: ex.undoneAt || null,
        counts: ex.counts,
        resultCount: (ex.results || []).length
      };
    })
  };
}

/* ================= HTTP 工具 ================= */

function sendJSON(res, status, body, headers) {
  const payload = JSON.stringify(body);
  const h = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "X-Snapshot-Rev": String(store.rev),
    "X-Annotation-Rev": String(annStore.rev),
    "X-Batch-Rev": String(batchStore.rev),
    "X-Decision-Rev": String(decisionStore.rev),
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
        decisionRev: decisionStore.rev
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
                       decisions: s.decisions, decisionRev: s.decisionRev };
      s.name = check.value.name;
      s.paragraphs = check.value.paragraphs;
      s.updatedAt = new Date().toISOString();
      // 覆盖保存同样刷新快照关联的批注状态与所属批次
      const batchLookup2 = new Map(
        batchStore.batches.map(function (b) { return [b.id, { id: b.id, name: b.name, status: b.status }]; }));
      s.annotations = review.snapshotDigest(annStore.annotations, batchLookup2);
      s.annotationRev = annStore.rev;
      // 覆盖保存同步刷新决策草案状态、投票与执行结果
      s.decisions = decision.decisionDigest(decisionStore.decisions);
      s.decisionRev = decisionStore.rev;
      store.rev++;
      const newRev = store.rev;
      persist(function (err) {
        if (err) {
          s.name = backup.name; s.paragraphs = backup.paragraphs;
          s.updatedAt = backup.updatedAt;
          s.annotations = backup.annotations; s.annotationRev = backup.annotationRev;
          s.decisions = backup.decisions; s.decisionRev = backup.decisionRev;
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

      const now = new Date().toISOString();
      const actor = review.validateAuthor(payload.actor).value;
      const plan = decision.planExecution(d, currentParas, annMap(),
        batch.memberIds, selected);

      // 合成执行后段落（只含成功条目；冲突/跳过条目不触碰）
      const afterParas = decision.applyPlan(currentParas, plan.results);

      // 成功条目对应的批注：标记已解决（保留/替换/删除都表示该批注处理完成）
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
      // 批次进度随成员状态变化推进批次 rev
      if (successIds.some(function (aid) { return batch.memberIds.indexOf(aid) !== -1; })) {
        batch.updatedAt = now;
        batchStore.rev++;
      }

      const applied = successIds.length > 0;
      const ex = {
        id: crypto.randomUUID(),
        at: now,
        actor: actor,
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
      if (applied) {
        // 一次部分成功也视为该草案已执行：成功部分固化，冲突/跳过条目记录在案
        d.status = "executed";
      }

      const le = {
        decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
        at: now, actor: actor,
        action: "execute",
        detail: "执行决策：成功 " + plan.counts.success + " 条、冲突 " +
          plan.counts.conflict + " 条、跳过 " + plan.counts.skipped + " 条" +
          (plan.textChanged ? "；执行前检测到文本版本已变化（" +
            plan.baselineTextRev.slice(0, 8) + " → " + plan.currentTextRev.slice(0, 8) + "）" : "") +
          (applied ? "" : "（没有可成功执行的条目，草案仍为待执行）"),
        annotationId: null
      };
      addDecisionLog(le);
      // 逐条结果也进记录，可按时间查看每条批注为何成功/冲突/跳过
      plan.results.forEach(function (r) {
        addDecisionLog({
          decisionId: d.id, decisionName: d.name, batchId: d.batchId, batchName: d.batchName,
          at: now, actor: actor,
          action: "execute_item_" + r.result,
          detail: decision.DISPOSITION_LABELS[r.disposition] || r.disposition + "：" +
            (r.result === "success" ? "执行成功"
             : r.result === "conflict" ? "冲突（" + (decision.REASON_LABELS[r.reason] || r.reason) + "）"
             : "跳过（" + (decision.REASON_LABELS[r.reason] || r.reason) + "）"),
          annotationId: r.annotationId
        });
      });
      decisionStore.rev++;

      function rollbackAll() {
        annBackups.forEach(function (bk) {
          bk.ann.status = bk.status; bk.ann.resolvedAt = bk.resolvedAt;
          bk.ann.resolvedBy = bk.resolvedBy; bk.ann.updatedAt = bk.updatedAt;
        });
        if (successIds.length) annStore.rev--;
        if (successIds.some(function (aid) { return batch.memberIds.indexOf(aid) !== -1; })) {
          batchStore.rev--;
        }
        d.status = prevStatus; d.lastExecutionId = prevLastExec;
        d.updatedAt = prevUpdated;
        const i = d.executions.indexOf(ex);
        if (i !== -1) d.executions.splice(i, 1);
        decisionStore.rev--;
        const logStart = decisionStore.logs.findIndex(function (x) {
          return x.decisionId === d.id && x.at === now &&
            (x.action === "execute" || x.action.indexOf("execute_item_") === 0);
        });
        if (logStart !== -1) decisionStore.logs.splice(logStart);
      }

      persistDecisions(function (derr) {
        if (derr) {
          rollbackAll();
          apiError(res, 500, "persist_failed", "决策执行记录保存失败，全部改动已回滚，请重试");
          return;
        }
        // 决策已落盘后再落批注/批次：失败也不回滚已成功的执行（与批次状态接口同策略），
        // 仅回滚内存中的 rev 推进，刷新后以批注存储为准；执行记录保留。
        if (successIds.length) {
          persistAnnotations(function (aerr) {
            if (aerr) console.error("decision execute annotation persist failed:", aerr);
            persistBatches(function (berr) {
              if (berr) console.error("decision execute batch persist failed:", berr);
              sendJSON(res, 200, executionResponse(ex, afterParas));
            });
          });
        } else {
          sendJSON(res, 200, executionResponse(ex, afterParas));
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

module.exports = {
  core, review, decision,
  store: store, annStore: annStore, batchStore: batchStore,
  decisionStore: decisionStore
};
