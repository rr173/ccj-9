'use strict';
/*
 * 双向文本多人协作编辑房间 —— HTTP + WebSocket 服务
 *
 * 运行：node server.js [port]   （默认 8080，PORT 环境变量同效）
 *
 * 页面：
 *   /              房间列表 / 创建房间
 *   /room.html?id= 房间编辑页（两个页面打开同一房间即可协作）
 *
 * HTTP API：
 *   GET    /api/rooms                 房间列表
 *   POST   /api/rooms                 {name}            创建房间
 *   GET    /api/rooms/:id             房间快照（文本/版本/冲突/成员）
 *   POST   /api/rooms/:id/resolve     {conflictId, choice, member} 冲突裁决
 *   GET    /healthz                   健康检查（Docker HEALTHCHECK）
 *
 * WebSocket（/ws?room=<id>）：
 *   客户端 -> 服务端
 *     {type:"hello", member:{memberId,name,color}}
 *     {type:"commit", opId, baseRev, ops}
 *     {type:"cursor", anchor, selStart, selEnd}
 *     {type:"ping"}
 *   服务端 -> 客户端
 *     {type:"hello", you, rev, text, conflicts, members}
 *     {type:"ack", opId, result:"ok"|"duplicate"|"resync"|"error", rev, text, conflicts, error?}
 *     {type:"op", rev, by:{memberId,name,color}, text, conflicts, conflictsOnly?}
 *     {type:"presence", members}
 *     {type:"cursor", memberId, name, color, anchor, selStart, selEnd}
 *     {type:"pong"}
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const core = require("./core");
const { RoomManager } = require("./rooms");
const ws = require("./ws-protocol");

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DATA_FILE = process.env.COLLAB_ROOMS_FILE ||
  path.join(ROOT, "data", "rooms.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const manager = new RoomManager(DATA_FILE);
// 每 5 秒兜底落盘 + 进程退出前同步落盘，保证重启恢复
const saveTimer = setInterval(() => manager.flushSync(), 5000);
if (saveTimer.unref) saveTimer.unref();
function shutdown() {
  try { manager.flushSync(); } catch (e) {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/* ---------------- HTTP ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", d => {
      size += d.length;
      if (size > (limit || 256 * 1024)) { reject(new Error("body_too_large")); req.destroy(); }
      else chunks.push(d);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("bad_json")); }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  let file = pathname === "/" ? "/index.html" : pathname;
  // /room/xyz 之类的美化路径也交给 room.html
  if (file.startsWith("/room/")) file = "/room.html";
  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404"); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if (p === "/healthz") { res.writeHead(200); res.end("ok"); return; }
    if (p === "/api/rooms" && req.method === "GET") {
      sendJson(res, 200, { rooms: manager.list() });
      return;
    }
    if (p === "/api/rooms" && req.method === "POST") {
      const body = await readJson(req);
      const r = manager.create(body.name);
      if (r.error) { sendJson(res, r.status, { error: r.error }); return; }
      manager.flushSync();
      sendJson(res, 201, { room: { id: r.room.id, name: r.room.name, rev: 0 } });
      return;
    }
    const mRoom = /^\/api\/rooms\/([A-Za-z0-9_-]+)$/.exec(p);
    if (mRoom && req.method === "GET") {
      const room = manager.get(mRoom[1]);
      if (!room) { sendJson(res, 404, { error: "room_not_found" }); return; }
      sendJson(res, 200, manager.snapshot(room));
      return;
    }
    const mResolve = /^\/api\/rooms\/([A-Za-z0-9_-]+)\/resolve$/.exec(p);
    if (mResolve && req.method === "POST") {
      const room = manager.get(mResolve[1]);
      if (!room) { sendJson(res, 404, { error: "room_not_found" }); return; }
      const body = await readJson(req);
      const member = manager.touchMember(room, body.member || { memberId: body.memberId, name: body.name });
      const r = manager.resolveConflict(room, body.conflictId, body.choice, member || { memberId: "anon" });
      if (r.result === "error") { sendJson(res, r.status || 400, { error: r.error, rev: r.rev, text: r.text, conflicts: r.conflicts }); return; }
      manager.flushSync();
      broadcastRoom(room, {
        type: "op", rev: r.rev,
        by: member, text: r.text, conflicts: r.conflicts,
        note: "conflict_resolved"
      });
      sendJson(res, 200, r);
      return;
    }
    if (p.startsWith("/api/")) { sendJson(res, 404, { error: "not_found" }); return; }
    serveStatic(req, res, p);
  } catch (e) {
    sendJson(res, 400, { error: e.message || "bad_request" });
  }
});

/* ---------------- WebSocket ---------------- */

// roomId -> Set<session>
const sessions = new Map();
function roomSessions(roomId) {
  if (!sessions.has(roomId)) sessions.set(roomId, new Set());
  return sessions.get(roomId);
}
function broadcastRoom(room, msg) {
  const data = JSON.stringify(msg);
  const set = sessions.get(room.id);
  if (!set) return;
  for (const sess of set) {
    try { sess.ws.send(data); } catch (e) {}
  }
}
function broadcastPresence(room) {
  broadcastRoom(room, { type: "presence", members: manager.snapshot(room).members });
}
function broadcastPresentation(room, event, extra) {
  broadcastRoom(room, Object.assign({
    type: "presentation_state",
    event: event,
    presentation: manager.publicPresentation(room)
  }, extra || {}));
}

ws.attachServer(server, {
  onConnection(sock) {
    const sess = { ws: sock, room: null, member: null, lastCursor: 0 };
    sock.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.type === "ping") { try { sock.send(JSON.stringify({ type: "pong" })); } catch (e) {} return; }
      if (msg.type === "hello") return handleHello(sess, sock, msg);
      if (!sess.room || !sess.member) return;
      if (msg.type === "commit") return handleCommit(sess, msg);
      if (msg.type === "cursor") return handleCursor(sess, msg);
      if (msg.type === "presentation_start") return handlePresentationStart(sess, msg);
      if (msg.type === "presentation_join") return handlePresentationJoin(sess);
      if (msg.type === "presentation_leave") return handlePresentationLeave(sess, msg.reason);
      if (msg.type === "presentation_update") return handlePresentationUpdate(sess, msg);
      if (msg.type === "presentation_end") return handlePresentationEnd(sess);
    });
    sock.on("close", () => {
      if (sess.room) {
        const set = sessions.get(sess.room.id);
        if (set) set.delete(sess);
        const stillConnected = set && Array.from(set).some(other =>
          other.member && other.member.memberId === sess.member.memberId);
        if (!stillConnected) {
          const presentation = manager.presenterDisconnected(
            sess.room, sess.member.memberId);
          if (presentation) broadcastPresentation(sess.room, "presenter_disconnected");
        }
        // 不立即删除成员（离线重连窗口）；只广播在线状态，60s 后 prune
        setTimeout(() => {
          if (sess.room) {
            manager.pruneStale(sess.room);
            broadcastPresence(sess.room);
          }
        }, 61000).unref?.();
        broadcastPresence(sess.room);
      }
    });
  }
});

function handleHello(sess, sock, msg) {
  const u = new URL(sock.url, "http://localhost");
  const roomId = msg.room || u.searchParams.get("room");
  const room = manager.get(roomId);
  if (!room) { sock.send(JSON.stringify({ type: "error", error: "room_not_found" })); sock.close(1008, "room_not_found"); return; }
  const member = manager.touchMember(room, msg.member || {});
  if (!member) { sock.send(JSON.stringify({ type: "error", error: "missing_member" })); sock.close(1008, "missing_member"); return; }
  sess.room = room;
  sess.member = member;
  roomSessions(room.id).add(sess);
  const resumedPresentation = manager.presenterReconnected(room, member.memberId);
  const snap = manager.snapshot(room);
  sock.send(JSON.stringify({
    type: "hello", you: member, room: { id: room.id, name: room.name },
    rev: snap.rev,
    text: snap.text, conflicts: snap.conflicts, members: snap.members,
    presentation: snap.presentation
  }));
  broadcastPresence(room);
  if (resumedPresentation) broadcastPresentation(room, "presenter_reconnected");
}

function handleCommit(sess, msg) {
  const room = sess.room;
  const r = manager.commit(room, msg, sess.member);
  // 应答作者（重复操作返回 duplicate，绝不重复应用）
  sess.ws.send(JSON.stringify({
    type: "ack", opId: r.opId, result: r.result,
    error: r.error || null, status: r.status || 200,
    rev: r.rev, text: r.text,
    resync: r.result === "resync",
    conflicts: r.conflicts || []
  }));
  if (r.result === "ok") {
    // 广播其他在线成员：以服务器快照为权威文本，保证收敛
    broadcastRoom(room, {
      type: "op", rev: r.rev,
      by: sess.member,
      ops: r.deltaOps,           // 增量（参考用）
      text: r.text,              // 权威全文（客户端以此收敛）
      conflicts: r.conflicts
    });
  }
}

function handleCursor(sess, msg) {
  const room = sess.room;
  manager.setCursor(room, sess.member.memberId, msg);
  const rec = room.cursors[sess.member.memberId];
  broadcastRoom(room, {
    type: "cursor",
    memberId: sess.member.memberId, name: sess.member.name, color: sess.member.color,
    anchor: rec.anchor, selStart: rec.selStart, selEnd: rec.selEnd
  });
}

function handlePresentationStart(sess, msg) {
  const result = manager.startPresentation(sess.room, sess.member, msg);
  manager.flushSync();
  broadcastPresentation(sess.room,
    result.result === "started" ? "started" : "start_rejected", {
      requestId: msg.requestId || null,
      requesterId: sess.member.memberId,
      result: result.result,
      error: result.error || null
    });
}

function handlePresentationJoin(sess) {
  const result = manager.joinPresentation(sess.room, sess.member);
  if (result.result === "joined") manager.flushSync();
  broadcastPresentation(sess.room,
    result.result === "joined" ? "follower_joined" : "join_rejected", {
      requesterId: sess.member.memberId,
      result: result.result,
      error: result.error || null
    });
}

function handlePresentationLeave(sess, reason) {
  const result = manager.leavePresentation(
    sess.room, sess.member.memberId, reason || "manual");
  if (result.result === "left") manager.flushSync();
  broadcastPresentation(sess.room, "follower_left", {
    requesterId: sess.member.memberId,
    result: result.result,
    reason: result.reason || reason || "manual"
  });
}

function handlePresentationUpdate(sess, msg) {
  const result = manager.updatePresentation(sess.room, sess.member, msg);
  if (result.result !== "updated") {
    sess.ws.send(JSON.stringify({ type: "presentation_error", error: result.error }));
    return;
  }
  broadcastPresentation(sess.room, "view_updated", {
    requesterId: sess.member.memberId,
    result: result.result
  });
}

function handlePresentationEnd(sess) {
  const result = manager.endPresentation(sess.room, sess.member.memberId, "ended");
  if (result.result === "ended") manager.flushSync();
  broadcastPresentation(sess.room,
    result.result === "ended" ? "ended" : "end_rejected", {
      requesterId: sess.member.memberId,
      result: result.result,
      error: result.error || null,
      endedPresentationId: result.id || null,
      reason: result.reason || null
    });
}

// 定期清理离线成员并广播
setInterval(() => {
  for (const room of manager.rooms.values()) {
    const before = Object.keys(room.cursors).length;
    manager.pruneStale(room);
    if (Object.keys(room.cursors).length !== before) broadcastPresence(room);
    const ended = manager.expirePresentation(room);
    if (ended) {
      manager.flushSync();
      broadcastPresentation(room, "ended", {
        endedPresentationId: ended.id,
        reason: ended.reason
      });
    }
  }
}, 1000).unref?.();

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log("collab-room server: http://127.0.0.1:" + PORT + "  data=" + DATA_FILE);
});

module.exports = { server: server, manager: manager };
