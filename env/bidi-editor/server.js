/* 零依赖开发服务器：静态文件 + 审阅快照 JSON API + 协作批注 JSON API
 * 运行：node server.js [port]
 *
 * 存储：
 *   快照 data/snapshots.json   （SNAPSHOTS_FILE 覆盖）
 *   批注 data/annotations.json （ANNOTATIONS_FILE 覆盖）
 *
 * 乐观并发（多页面/多人同时操作）：
 *   快照集合与批注集合各有单调递增的 rev；
 *   快照响应带 X-Snapshot-Rev，批注响应带 X-Annotation-Rev；
 *   所有变更类请求（含新建/回复/解决批注）必须带 If-Match: <对应集合 rev>，
 *   服务端要求严格相等，否则 409 version_conflict 且不写盘 ——
 *   旧页面无法覆盖别人新提交的批注、回复或文字。
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

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DATA_FILE = process.env.SNAPSHOTS_FILE ||
  path.join(ROOT, "data", "snapshots.json");
const ANN_FILE = process.env.ANNOTATIONS_FILE ||
  path.join(ROOT, "data", "annotations.json");
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
    annotationRev: Number.isInteger(s.annotationRev) ? s.annotationRev : null
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

/* ================= HTTP 工具 ================= */

function sendJSON(res, status, body, headers) {
  const payload = JSON.stringify(body);
  const h = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "X-Snapshot-Rev": String(store.rev),
    "X-Annotation-Rev": String(annStore.rev),
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

      const backup = annStore.annotations;
      annStore.annotations = normalized;
      annStore.rev++;
      persistAnnotations(function (err) {
        if (err) { annStore.annotations = backup; annStore.rev--;
          apiError(res, 500, "persist_failed", "批注恢复失败，请重试"); return; }
        sendJSON(res, 200, publicAnnotations());
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

  /* ---- PUT /api/annotations/:id：标记已解决 / 重新打开 ---- */
  if (req.method === "PUT") {
    if (checkLock(res, req.headers["if-match"], annStore.rev,
      "批注集合")) return;
    readBody(req, function (err, raw) {
      if (err) { apiError(res, 413, "body_too_large", "请求体超过大小上限"); return; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { apiError(res, 400, "invalid_json", "请求不是合法 JSON"); return; }

      if (!payload || (payload.status !== "resolved" && payload.status !== "open")) {
        apiError(res, 400, "invalid_status",
          "状态必须是 resolved（已解决）或 open（重新打开）");
        return;
      }
      const ann = findAnn(id);
      if (!ann) { apiError(res, 404, "annotation_not_found", "批注不存在或已被删除"); return; }

      const backup = {
        status: ann.status, resolvedAt: ann.resolvedAt,
        resolvedBy: ann.resolvedBy, updatedAt: ann.updatedAt
      };
      const now = new Date().toISOString();
      ann.status = payload.status;
      if (payload.status === "resolved") {
        ann.resolvedAt = now;
        const who = review.validateAuthor(payload.resolvedBy);
        ann.resolvedBy = who.ok ? who.value : "匿名";
      } else {
        ann.resolvedAt = null;
        ann.resolvedBy = null;
      }
      ann.updatedAt = now;
      annStore.rev++;
      persistAnnotations(function (err) {
        if (err) {
          ann.status = backup.status; ann.resolvedAt = backup.resolvedAt;
          ann.resolvedBy = backup.resolvedBy; ann.updatedAt = backup.updatedAt;
          annStore.rev--;
          apiError(res, 500, "persist_failed", "状态更新失败，请重试");
          return;
        }
        sendJSON(res, 200, { rev: annStore.rev, annotation: ann });
      });
    });
    return;
  }

  /* ---- DELETE /api/annotations/:id ---- */
  if (req.method === "DELETE") {
    if (checkLock(res, req.headers["if-match"], annStore.rev,
      "批注集合")) return;
    const idx = annStore.annotations.findIndex(function (a) { return a.id === id; });
    if (idx === -1) {
      apiError(res, 404, "annotation_not_found", "批注不存在或已被删除");
      return;
    }
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
      const snap = {
        id: crypto.randomUUID(),
        name: check.value.name,
        createdAt: now,
        updatedAt: now,
        paragraphs: check.value.paragraphs,
        // 关联当前批注集合：查看该历史快照时能看到当时的批注及解决状态
        annotations: review.snapshotDigest(annStore.annotations),
        annotationRev: annStore.rev
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
                       annotations: s.annotations, annotationRev: s.annotationRev };
      s.name = check.value.name;
      s.paragraphs = check.value.paragraphs;
      s.updatedAt = new Date().toISOString();
      // 覆盖保存同样刷新快照关联的批注状态
      s.annotations = review.snapshotDigest(annStore.annotations);
      s.annotationRev = annStore.rev;
      store.rev++;
      const newRev = store.rev;
      persist(function (err) {
        if (err) {
          s.name = backup.name; s.paragraphs = backup.paragraphs;
          s.updatedAt = backup.updatedAt;
          s.annotations = backup.annotations; s.annotationRev = backup.annotationRev;
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

/* ================= 路由 ================= */

function handleAPI(req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  if (parts[1] === "snapshots" && parts.length <= 3) {
    handleSnapshots(req, res, parts);
    return;
  }
  if (parts[1] === "annotations" && parts.length <= 4) {
    handleAnnotations(req, res, parts);
    return;
  }
  apiError(res, 404, "not_found", "接口不存在");
}

/* ================= 静态文件 ================= */

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("400 Bad Request: malformed URL encoding");
    return;
  }

  if (urlPath === "/api" || urlPath.indexOf("/api/") === 0) {
    handleAPI(req, res, urlPath.replace(/\/+$/, "") || "/api");
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

module.exports = { core, review, store: store, annStore: annStore };
