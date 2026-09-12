/* 零依赖开发服务器：静态文件 + 审阅快照 JSON API
 * 运行：node server.js [port]
 *
 * 快照存储：同目录 data/snapshots.json（可用 SNAPSHOTS_FILE 覆盖）。
 *
 * 乐观并发（多页面/多人同时操作同一快照）：
 *   集合有单调递增的 rev；所有响应带 X-Snapshot-Rev。
 *   PUT/DELETE /api/snapshots/:id 必须带 If-Match: <rev>，
 *   服务端 rev 已大于该值 -> 409 version_conflict，拒绝覆盖/删除。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./snapshot-core");

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DATA_FILE = process.env.SNAPSHOTS_FILE ||
  path.join(ROOT, "data", "snapshots.json");
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
  return {
    id: s.id, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt,
    paragraphCount: s.paragraphs.length,
    charCount: s.paragraphs.reduce(function (n, p) { return n + core.cpLen(p.text); }, 0)
  };
}
function publicStore() {
  return { rev: store.rev, snapshots: store.snapshots.map(summary) };
}
function publicFull(s) {
  return {
    id: s.id, name: s.name, rev: store.rev,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    paragraphs: s.paragraphs
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

/* ================= HTTP 工具 ================= */

function sendJSON(res, status, body, headers) {
  const payload = JSON.stringify(body);
  const h = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "X-Snapshot-Rev": String(store.rev),
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

/* ================= API 处理 ================= */

function handleAPI(req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["api", "snapshots", ":id?"]
  if (parts[1] !== "snapshots" || parts.length > 3) {
    apiError(res, 404, "not_found", "接口不存在");
    return;
  }
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
        paragraphs: check.value.paragraphs
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
      const backup = { name: s.name, updatedAt: s.updatedAt, paragraphs: s.paragraphs };
      s.name = check.value.name;
      s.paragraphs = check.value.paragraphs;
      s.updatedAt = new Date().toISOString();
      store.rev++;
      const newRev = store.rev;
      persist(function (err) {
        if (err) {
          s.name = backup.name; s.paragraphs = backup.paragraphs;
          s.updatedAt = backup.updatedAt; store.rev--;
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
  console.log(`Bidi editor running at http://localhost:${PORT} (snapshots: ${DATA_FILE})`);
});

module.exports = { core, store: store };
