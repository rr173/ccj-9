'use strict';
/*
 * 房间管理：文档状态、操作折叠（OT 三方合并）、冲突区、幂等、持久化。
 *
 * 每个房间：
 *   id/name/createdAt/updatedAt
 *   rev            单调版本号，每次提交/裁决 +1
 *   atoms          当前文档（字素簇原子数组）
 *   conflicts      冲突区（open/resolved；open 段 start/end 为当前文档集群坐标）
 *   history        最近 N 次提交 {rev, opId, publicId, ops, opsForAuthor, member}
 *   seenOps        opId -> 提交 rev（重复操作幂等应答）
 *   checkpoints    { rev: 持久化的 rev 检查点 atoms 数组 }（重启后重建旧版本）
 *   cursors        memberId -> {name,color,anchor,selStart,selEnd,updatedAt}
 *
 * 并发折叠（服务端唯一裁决，确定性）：
 *   baseRev == head：直接 applyDirect。
 *   baseRev < head：取共同祖先 atomsAt(baseRev)，新操作与之后每条已提交操作
 *   依次 mergeChangeset（opId 字典序定胜负），冲突区累积，最后把各跳产生的
 *   冲突按双方文本在最终文档中重新定位。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');

const HISTORY_LIMIT = 500;       // 可接受的离线/滞后基线窗口
const SEEN_LIMIT = 2000;
const CHECKPOINT_EVERY = 25;     // 每 N 个 rev 持久化一个检查点
const MAX_ROOMS = 200;
const MAX_NAME = 100;
const PRESENTATION_MIN_MS = 10 * 1000;
const PRESENTATION_MAX_MS = 30 * 60 * 1000;
const PRESENTATION_DEFAULT_MS = 5 * 60 * 1000;
const PRESENTER_GRACE_MS = 15 * 1000;
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#469990', '#9A6324', '#800000'];

function rid() { return 'r' + crypto.randomBytes(6).toString('hex'); }
function fullOpId(clientOpId, memberId) {
  const id = clientOpId ? String(clientOpId).slice(0, 120)
    : 'op' + crypto.randomBytes(8).toString('hex');
  return id.indexOf(':') < 0 ? id + ':' + memberId : id;
}
function publicId(full) { return full.split(':')[0]; }

class RoomManager {
  constructor(file) {
    this.file = file;
    this.rooms = new Map();
    this._saveTimer = null;
    this._load();
  }

  /* ---------------- 持久化 ---------------- */

  _load() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { return; } // 不存在/损坏：空状态启动，首次变更才写盘
    if (!data || !Array.isArray(data.rooms)) return;
    for (const r of data.rooms) {
      if (!r || !r.id) continue;
      r.atoms = Array.isArray(r.atoms) ? r.atoms : [];
      r.conflicts = Array.isArray(r.conflicts) ? r.conflicts : [];
      r.history = Array.isArray(r.history) ? r.history.slice(-HISTORY_LIMIT) : [];
      r.seenOps = r.seenOps || {};
      r.cursors = r.cursors || {};
      r.checkpoints = r.checkpoints || {};
      r.presentation = this._normalizePresentation(r.presentation, Date.now());
      this.rooms.set(r.id, r);
    }
  }

  _serialize() {
    // 检查点只落盘每 CHECKPOINT_EVERY 个 rev（含 rev 0），控制文件体积
    const rooms = Array.from(this.rooms.values()).map(r => {
      const cps = {};
      for (const k of Object.keys(r.checkpoints)) {
        const rev = Number(k);
        if (rev === 0 || rev % CHECKPOINT_EVERY === 0 || rev === r.rev) cps[k] = r.checkpoints[k];
      }
      return {
        id: r.id, name: r.name, rev: r.rev, atoms: r.atoms,
        conflicts: r.conflicts, history: r.history, seenOps: r.seenOps,
        cursors: r.cursors, checkpoints: cps, presentation: r.presentation || null,
        createdAt: r.createdAt, updatedAt: r.updatedAt
      };
    });
    return { version: 1, savedAt: new Date().toISOString(), rooms: rooms };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._serialize()));
    fs.renameSync(tmp, this.file); // 同目录原子替换
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { this.save(); } catch (e) { /* 下次写盘重试 */ }
    }, 150);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  flushSync() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try { this.save(); } catch (e) {}
  }

  /* ---------------- 查询 ---------------- */

  list() {
    return Array.from(this.rooms.values())
      .map(r => ({
        id: r.id, name: r.name, rev: r.rev,
        members: Object.keys(r.cursors).length,
        openConflicts: r.conflicts.filter(c => c.status === 'open').length,
        clusterCount: r.atoms.length,
        createdAt: r.createdAt, updatedAt: r.updatedAt
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id) { return this.rooms.get(id) || null; }

  snapshot(room) {
    this.expirePresentation(room);
    return {
      id: room.id, name: room.name, rev: room.rev,
      text: core.atomsText(room.atoms),
      conflicts: room.conflicts
        .filter(c => c.status === 'open').map(c => this._publicConflict(room, c)),
      members: this._members(room),
      presentation: this.publicPresentation(room),
      createdAt: room.createdAt, updatedAt: room.updatedAt
    };
  }

  _members(room) {
    const now = Date.now();
    return Object.keys(room.cursors).map(mid => {
      const c = room.cursors[mid];
      return {
        memberId: mid, name: c.name, color: c.color,
        anchor: c.anchor, selStart: c.selStart, selEnd: c.selEnd,
        online: now - (c.updatedAt || 0) < 15000
      };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  _publicConflict(room, c) {
    // 用当前文档实时校验两段文本（裁决/重连时给出准确状态）
    const curA = core.atomsText(room.atoms.slice(c.aStart, c.aEnd));
    const curB = core.atomsText(room.atoms.slice(c.bStart, c.bEnd));
    return {
      id: c.id, kind: c.kind,
      start: c.start, end: c.end,
      aStart: c.aStart, aEnd: c.aEnd, bStart: c.bStart, bEnd: c.bEnd,
      aText: c.aText, bText: c.bText,
      aCurrent: curA, bCurrent: curB,
      aIntact: curA === c.aText, bIntact: curB === c.bText,
      status: c.status, winner: c.winner,
      resolvedChoice: c.resolvedChoice || null,
      createdAt: c.createdAt, resolvedAt: c.resolvedAt || null,
      resolvedBy: c.resolvedBy || null
    };
  }

  /* ---------------- 房间 ---------------- */

  create(name) {
    if (typeof name !== 'string') return { error: 'invalid_name', status: 400 };
    name = name.trim();
    if (!name) return { error: 'empty_name', status: 400 };
    if (name.length > MAX_NAME) return { error: 'name_too_long', status: 400 };
    if (this.rooms.size >= MAX_ROOMS) return { error: 'too_many_rooms', status: 413 };
    const now = new Date().toISOString();
    const room = {
      id: rid(), name: name, rev: 0,
      atoms: [], conflicts: [], history: [], seenOps: {}, cursors: {},
      checkpoints: { 0: [] }, presentation: null,
      createdAt: now, updatedAt: now
    };
    this.rooms.set(room.id, room);
    this.scheduleSave();
    return { room: room };
  }

  /* ---------------- 成员 / 光标 ---------------- */

  touchMember(room, member) {
    if (!member || !member.memberId) return null;
    const mid = String(member.memberId).slice(0, 80);
    const rawName = String(member.name == null ? '' : member.name).trim().slice(0, 40);
    const name = rawName || '匿名成员';
    let rec = room.cursors[mid];
    if (!rec) {
      let color = PALETTE[Object.keys(room.cursors).length % PALETTE.length];
      if (member.color && /^#[0-9a-fA-F]{6}$/.test(member.color)) color = member.color;
      rec = room.cursors[mid] = {
        name: name, color: color, anchor: 0, selStart: 0, selEnd: 0, updatedAt: 0
      };
    } else {
      rec.name = name;
    }
    rec.updatedAt = Date.now();
    return { memberId: mid, name: rec.name, color: rec.color };
  }

  setCursor(room, mid, msg) {
    const rec = room.cursors[mid];
    if (!rec) return;
    const n = room.atoms.length;
    const clamp = v => Math.max(0, Math.min(Number(v) || 0, n));
    rec.anchor = clamp(msg.anchor);
    let ss = clamp(msg.selStart != null ? msg.selStart : rec.anchor);
    let se = clamp(msg.selEnd != null ? msg.selEnd : rec.anchor);
    if (ss > se) { const t = ss; ss = se; se = t; }
    rec.selStart = ss; rec.selEnd = se;
    rec.updatedAt = Date.now();
  }

  pruneStale(room) {
    const now = Date.now();
    for (const mid of Object.keys(room.cursors)) {
      if (now - room.cursors[mid].updatedAt > 60000) delete room.cursors[mid];
    }
  }

  /* ---------------- 限时跟随演示 ---------------- */

  _normalizePresentation(value, now) {
    if (!value || typeof value !== 'object') return null;
    const expiresAt = Number(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
    const presenterId = String(value.presenterId || '').slice(0, 80);
    if (!presenterId) return null;
    const followers = {};
    const source = value.followers && typeof value.followers === 'object'
      ? value.followers : {};
    for (const mid of Object.keys(source).slice(0, 500)) followers[String(mid).slice(0, 80)] = true;
    const view = value.view && typeof value.view === 'object' ? value.view : {};
    const hasGrace = value.graceUntil != null;
    const graceUntil = Number(value.graceUntil);
    if (hasGrace && Number.isFinite(graceUntil) && graceUntil <= now) return null;
    return {
      id: String(value.id || ('p' + crypto.randomBytes(6).toString('hex'))).slice(0, 80),
      presenterId: presenterId,
      presenterName: String(value.presenterName || '匿名成员').slice(0, 40),
      startedAt: Number(value.startedAt) || now,
      expiresAt: expiresAt,
      graceUntil: hasGrace && Number.isFinite(graceUntil) ? graceUntil : null,
      followers: followers,
      view: {
        anchor: Math.max(0, Number(view.anchor) || 0),
        selStart: Math.max(0, Number(view.selStart) || 0),
        selEnd: Math.max(0, Number(view.selEnd) || 0),
        scrollTop: Math.max(0, Number(view.scrollTop) || 0),
        scrollLeft: Math.max(0, Number(view.scrollLeft) || 0),
        updatedAt: Number(view.updatedAt) || 0
      }
    };
  }

  publicPresentation(room, now) {
    now = Number.isFinite(now) ? now : Date.now();
    const p = room.presentation;
    if (!p) return null;
    return {
      id: p.id,
      presenterId: p.presenterId,
      presenterName: p.presenterName,
      startedAt: p.startedAt,
      expiresAt: p.expiresAt,
      remainingMs: Math.max(0, p.expiresAt - now),
      graceUntil: p.graceUntil,
      presenterConnected: !p.graceUntil,
      followers: Object.keys(p.followers),
      view: Object.assign({}, p.view)
    };
  }

  expirePresentation(room, now) {
    now = Number.isFinite(now) ? now : Date.now();
    const p = room.presentation;
    if (!p) return null;
    let reason = '';
    if (p.expiresAt <= now) reason = 'expired';
    else if (p.graceUntil && p.graceUntil <= now) reason = 'presenter_timeout';
    if (!reason) return null;
    room.presentation = null;
    room.updatedAt = new Date(now).toISOString();
    this.scheduleSave();
    return { id: p.id, reason: reason };
  }

  startPresentation(room, member, msg, now) {
    now = Number.isFinite(now) ? now : Date.now();
    this.expirePresentation(room, now);
    if (room.presentation) {
      return { result: 'rejected', error: 'presentation_already_active',
        presentation: this.publicPresentation(room, now) };
    }
    let durationMs = Number(msg && msg.durationMs);
    if (!Number.isFinite(durationMs)) durationMs = PRESENTATION_DEFAULT_MS;
    durationMs = Math.max(PRESENTATION_MIN_MS, Math.min(PRESENTATION_MAX_MS, Math.round(durationMs)));
    room.presentation = this._normalizePresentation({
      id: 'p' + crypto.randomBytes(8).toString('hex'),
      presenterId: member.memberId,
      presenterName: member.name,
      startedAt: now,
      expiresAt: now + durationMs,
      followers: {},
      view: {}
    }, now);
    room.updatedAt = new Date(now).toISOString();
    this.scheduleSave();
    return { result: 'started', presentation: this.publicPresentation(room, now) };
  }

  joinPresentation(room, member, now) {
    now = Number.isFinite(now) ? now : Date.now();
    this.expirePresentation(room, now);
    const p = room.presentation;
    if (!p) return { result: 'error', error: 'presentation_not_active' };
    if (p.presenterId === member.memberId) return { result: 'error', error: 'presenter_cannot_follow' };
    p.followers[member.memberId] = true;
    this.scheduleSave();
    return { result: 'joined', presentation: this.publicPresentation(room, now) };
  }

  leavePresentation(room, memberId, reason, now) {
    now = Number.isFinite(now) ? now : Date.now();
    this.expirePresentation(room, now);
    const p = room.presentation;
    if (!p || !p.followers[memberId]) return { result: 'not_following', presentation: this.publicPresentation(room, now) };
    delete p.followers[memberId];
    this.scheduleSave();
    return { result: 'left', reason: reason || 'manual', presentation: this.publicPresentation(room, now) };
  }

  updatePresentation(room, member, msg, now) {
    now = Number.isFinite(now) ? now : Date.now();
    this.expirePresentation(room, now);
    const p = room.presentation;
    if (!p) return { result: 'error', error: 'presentation_not_active' };
    if (p.presenterId !== member.memberId) return { result: 'error', error: 'not_presenter' };
    const n = room.atoms.length;
    const clamp = v => Math.max(0, Math.min(Number(v) || 0, n));
    let selStart = clamp(msg.selStart != null ? msg.selStart : msg.anchor);
    let selEnd = clamp(msg.selEnd != null ? msg.selEnd : msg.anchor);
    if (selStart > selEnd) { const tmp = selStart; selStart = selEnd; selEnd = tmp; }
    p.view = {
      anchor: clamp(msg.anchor), selStart: selStart, selEnd: selEnd,
      scrollTop: Math.max(0, Number(msg.scrollTop) || 0),
      scrollLeft: Math.max(0, Number(msg.scrollLeft) || 0),
      updatedAt: now
    };
    this.scheduleSave();
    return { result: 'updated', presentation: this.publicPresentation(room, now) };
  }

  presenterDisconnected(room, memberId, now) {
    now = Number.isFinite(now) ? now : Date.now();
    this.expirePresentation(room, now);
    const p = room.presentation;
    if (!p || p.presenterId !== memberId) return null;
    p.graceUntil = Math.min(p.expiresAt, now + PRESENTER_GRACE_MS);
    this.scheduleSave();
    return this.publicPresentation(room, now);
  }

  presenterReconnected(room, memberId, now) {
    now = Number.isFinite(now) ? now : Date.now();
    this.expirePresentation(room, now);
    const p = room.presentation;
    if (!p || p.presenterId !== memberId) return null;
    if (p.graceUntil) {
      p.graceUntil = null;
      this.scheduleSave();
    }
    return this.publicPresentation(room, now);
  }

  endPresentation(room, memberId, reason, now) {
    now = Number.isFinite(now) ? now : Date.now();
    this.expirePresentation(room, now);
    const p = room.presentation;
    if (!p) return { result: 'error', error: 'presentation_not_active' };
    if (p.presenterId !== memberId) return { result: 'error', error: 'not_presenter' };
    room.presentation = null;
    room.updatedAt = new Date(now).toISOString();
    this.scheduleSave();
    return { result: 'ended', id: p.id, reason: reason || 'ended' };
  }

  /* ---------------- 旧版本重建 ---------------- */

  atomsAt(room, rev) {
    if (rev === room.rev) return room.atoms;
    // 内存检查点（每次提交记录父版本，窗口内的 base 一定命中）
    if (room.checkpoints[rev]) return room.checkpoints[rev];
    // 持久化检查点 + history 前向重放
    const cpRevs = Object.keys(room.checkpoints).map(Number)
      .filter(r => r <= rev).sort((a, b) => b - a);
    if (cpRevs.length) {
      let atoms = room.checkpoints[cpRevs[0]].map(a => ({ id: a.id, ch: a.ch }));
      for (const h of room.history) {
        if (h.rev > cpRevs[0] && h.rev <= rev) {
          atoms = core.applyDirect(atoms, h.ops, h.publicId);
        }
      }
      return atoms;
    }
    return null;
  }

  _remember(room, rev, atoms) {
    // 只保留窗口内的内存检查点；0 与每 N rev 留作持久化
    room.checkpoints[rev] = atoms.map(a => ({ id: a.id, ch: a.ch }));
    const minRev = Math.max(0, room.rev - HISTORY_LIMIT);
    for (const r of Object.keys(room.checkpoints).map(Number)) {
      if (r < minRev && r !== 0 && r % CHECKPOINT_EVERY !== 0) delete room.checkpoints[r];
    }
  }

  /* ---------------- 提交操作 ---------------- */

  commit(room, msg, member) {
    const mid = member.memberId;
    const fid = fullOpId(msg.opId, mid);
    const fingerprint = crypto.createHash('sha1')
      .update(JSON.stringify(core.normalizeOps(msg.ops || []))).digest('hex');

    // 幂等：同 opId 已处理 => 回传当时结果，绝不重复应用
    if (room.seenOps[fid]) {
      if (room._fingerprints && room._fingerprints[fid] &&
          room._fingerprints[fid] !== fingerprint) {
        return { result: 'error', error: 'op_id_reused', status: 409,
          rev: room.rev, text: core.atomsText(room.atoms),
          conflicts: this._openConflicts(room) };
      }
      const seenRev = room.seenOps[fid];
      const h = room.history.find(x => x.rev === seenRev);
      return {
        result: 'duplicate',
        rev: room.rev, opId: fid,
        ops: h ? h.opsForAuthor : [],
        text: core.atomsText(room.atoms),
        conflicts: this._openConflicts(room)
      };
    }

    const baseRev = Number.isInteger(msg.baseRev) ? msg.baseRev : room.rev;
    if (baseRev < 0 || baseRev > room.rev) {
      return this._resync(room, 'bad_base_rev', 400);
    }
    const ancestor = this.atomsAt(room, baseRev);
    if (!ancestor) return this._resync(room, 'base_rev_too_old', 409);

    const check = core.validateChangeset(ancestor.length, msg.ops);
    if (!check.ok) {
      return { result: 'error', error: check.code, status: check.status || 400,
        rev: room.rev, text: core.atomsText(room.atoms),
        conflicts: this._openConflicts(room) };
    }
    const incomingOps = check.ops;

    // 同 opId 不同载荷的情况已在幂等分支拦截
    room._fingerprints = room._fingerprints || {};
    room._fingerprints[fid] = fingerprint;

    let doc, opsForAuthor, collectedConflicts, deltaOps;
    const parentAtoms = room.atoms.map(a => ({ id: a.id, ch: a.ch }));
    if (baseRev === room.rev) {
      doc = core.applyDirect(parentAtoms, incomingOps, publicId(fid));
      opsForAuthor = incomingOps;
      collectedConflicts = [];
      deltaOps = incomingOps; // 服务器视角：head -> 新 head 即本次操作
    } else {
      const olds = room.history.filter(h => h.rev > baseRev).sort((a, b) => a.rev - b.rev);
      // 多跳折叠，逐跳把「新操作世界」与「某条旧提交世界」做身份三方合并：
      //   s        当前共同上下文（第一跳 = baseRev 祖先，其后 = 上一跳结果）
      //   a 世界   s 应用新操作（删除祖先原子 + 插入新原子）
      //   b 世界   s 应用该条旧提交（删除其祖先原子 + 插入它引入的原子）
      // 更早旧提交的原子已在 s 中，两个世界都含它们（同 id），不会重复；
      // 两个世界各自的删除/插入只作用于「自己祖先中存在」的原子，互不越界。
      let s = ancestor.map(x => ({ id: x.id, ch: x.ch }));
      const authorInitial = core.applyDirect(s, incomingOps, publicId(fid));
      const authorIds = new Set(authorInitial.map(x => x.id));
      // 新操作相对共同祖先的删除（祖先 id 集合，跨跳复用，逐跳按当前 s 过滤）
      const aDeleteBase = new Set();
      for (const x of s) if (!authorIds.has(x.id)) aDeleteBase.add(x.id);
      const aIntroducedAll = authorInitial.filter(
        x => x.id.indexOf(publicId(fid) + '-') === 0);
      collectedConflicts = [];
      for (const old of olds) {
        const oldResult = this.atomsAt(room, old.rev);
        const oldBaseRev = Number.isInteger(old.baseRev) ? old.baseRev : old.rev - 1;
        const oldAncestor = this.atomsAt(room, oldBaseRev);
        const oldAncestorIds = new Set(oldAncestor.map(x => x.id));
        const resultIds = new Set(oldResult.map(x => x.id));
        const currentIds = new Set(s.map(x => x.id));
        // 删除集合只对当前 s 中仍存在、且确属该方祖先的原子生效
        const bDel = new Set();
        for (const x of oldAncestor) {
          if (!resultIds.has(x.id) && currentIds.has(x.id)) bDel.add(x.id);
        }
        const aDel = new Set();
        for (const id of aDeleteBase) if (currentIds.has(id)) aDel.add(id);
        // 引入原子：只取当前 s 还没有的（更早跳可能已合入），按 id 去重
        const introduced = [];
        const seenIntro = new Set();
        for (const x of oldResult) {
          if (oldAncestorIds.has(x.id) || seenIntro.has(x.id)) continue;
          if (x.id.indexOf(old.publicId + '-') === 0) {
            seenIntro.add(x.id);
            if (!currentIds.has(x.id)) introduced.push(x);
          }
        }
        const aIntro = aIntroducedAll.filter(x => !currentIds.has(x.id));
        const aWorld = this._applyToS(s, aDel, authorInitial, aIntro);
        const bWorld = this._applyToS(s, bDel, oldResult, introduced);
        const m3 = core.merge3(s, aWorld, bWorld,
          publicId(fid) + '-' + old.rev, old.publicId);
        s = m3.doc;
        for (const cf of m3.conflicts) collectedConflicts.push(cf);
      }
      doc = s;
      opsForAuthor = core.diffToOps(authorInitial, doc);
      deltaOps = core.diffToOps(parentAtoms, doc);
    }

    room.rev += 1;
    room.atoms = doc;
    room.seenOps[fid] = room.rev;
    room._fingerprints = room._fingerprints || {};
    room._fingerprints[fid] = fingerprint;
    room.history.push({
      rev: room.rev, opId: fid, publicId: publicId(fid),
      baseRev: baseRev,
      ops: deltaOps, delta: deltaOps, opsForAuthor: opsForAuthor,
      member: mid, at: new Date().toISOString()
    });
    if (room.history.length > HISTORY_LIMIT) {
      room.history = room.history.slice(-HISTORY_LIMIT);
    }
    this._trimSeen(room);
    this._remember(room, room.rev, doc);

    // 已有 open 冲突随本次服务器增量移动（按原子身份精确重定位）；
    // 任一侧文本被删除（区间失效）则自动关闭。
    for (const c of room.conflicts) {
      if (c.status !== 'open') continue;
      const remapA = core.remapSpanById(parentAtoms, doc, c.aStart, c.aEnd);
      const remapB = core.remapSpanById(parentAtoms, doc, c.bStart, c.bEnd);
      if (!remapA || !remapB) { c._expire = true; continue; }
      c.aStart = remapA[0]; c.aEnd = remapA[1];
      c.bStart = remapB[0]; c.bEnd = remapB[1];
      c.start = Math.min(c.aStart, c.bStart);
      c.end = Math.max(c.aEnd, c.bEnd);
    }
    room.conflicts = room.conflicts.filter(c => {
      if (c._expire && c.status === 'open') {
        c.status = 'auto_closed';
        c.resolvedAt = new Date().toISOString();
        c.resolvedBy = null;
        delete c._expire;
      }
      return true;
    });

    // 登记新冲突（merge3 冲突带 aIds/bIds，在最终 head 上按身份定位）
    const newPublic = [];
    for (const cf of this._rebaseConflictsByIds(collectedConflicts, doc)) {
      const rec = {
        id: cf.id, kind: cf.kind,
        start: Math.min(cf.aStart, cf.bStart),
        end: Math.max(cf.aEnd, cf.bEnd),
        aStart: cf.aStart, aEnd: cf.aEnd, bStart: cf.bStart, bEnd: cf.bEnd,
        aText: cf.aText, bText: cf.bText,
        startDoc: doc.map(a => ({ id: a.id, ch: a.ch })),
        status: 'open', winner: cf.winner || null,
        createdAt: cf.createdAt
      };
      room.conflicts.push(rec);
      newPublic.push(this._publicConflict(room, rec));
    }

    room.updatedAt = new Date().toISOString();
    this.scheduleSave();

    return {
      result: 'ok',
      rev: room.rev, opId: fid,
      ops: opsForAuthor, deltaOps: deltaOps,
      text: core.atomsText(room.atoms),
      newConflicts: newPublic,
      conflicts: this._openConflicts(room),
      member: member
    };
  }

  _openConflicts(room) {
    return room.conflicts.filter(c => c.status === 'open')
      .map(c => this._publicConflict(room, c));
  }

  _resync(room, error, status) {
    return { result: 'resync', error: error, status: status,
      rev: room.rev, text: core.atomsText(room.atoms),
      conflicts: this._openConflicts(room) };
  }

  _trimSeen(room) {
    const keys = Object.keys(room.seenOps);
    if (keys.length <= SEEN_LIMIT) return;
    keys.sort((a, b) => room.seenOps[a] - room.seenOps[b]);
    for (const k of keys.slice(0, keys.length - SEEN_LIMIT)) {
      delete room.seenOps[k];
      if (room._fingerprints) delete room._fingerprints[k];
    }
  }

  /* 在当前合并上下文 s 上应用某一方意图，得到该方世界：
   *   1) 从 s 删除 deleteIds 中的原子；
   *   2) 把 introduced 按其在该方结果序列 resultSeq 中的锚点（前/后最近的
   *      该方祖先原子）插入；锚点已被更早提交删除时沿序列就近回退，
   *      都没有则放文末。
   */
  _applyToS(s, deleteIds, resultSeq, introduced) {
    const skeleton = s.filter(x => !deleteIds.has(x.id));
    if (!introduced || !introduced.length) return skeleton;
    const introIds = new Set(introduced.map(x => x.id));
    const skeletonIds = new Set(skeleton.map(x => x.id));
    const anchorIds = new Set();
    for (const x of resultSeq) if (!introIds.has(x.id)) anchorIds.add(x.id);
    const beforeGroups = new Map();
    const afterGroups = new Map();
    const endList = [];
    for (const x of introduced) {
      const i = resultSeq.findIndex(y => y.id === x.id);
      let before = null, after = null;
      for (let j = i - 1; j >= 0; j--) if (anchorIds.has(resultSeq[j].id)) { before = resultSeq[j].id; break; }
      for (let j = i + 1; j < resultSeq.length; j++) if (anchorIds.has(resultSeq[j].id)) { after = resultSeq[j].id; break; }
      let target = null, mode;
      if (after != null && skeletonIds.has(after)) { target = after; mode = 'before'; }
      else if (before != null && skeletonIds.has(before)) { target = before; mode = 'after'; }
      else {
        for (let j = i + 1; j < resultSeq.length; j++) {
          if (anchorIds.has(resultSeq[j].id) && skeletonIds.has(resultSeq[j].id)) { target = resultSeq[j].id; mode = 'before'; break; }
        }
        if (target == null) {
          for (let j = i - 1; j >= 0; j--) {
            if (anchorIds.has(resultSeq[j].id) && skeletonIds.has(resultSeq[j].id)) { target = resultSeq[j].id; mode = 'after'; break; }
          }
        }
      }
      if (target == null) { endList.push(x); continue; }
      const map = mode === 'before' ? beforeGroups : afterGroups;
      if (!map.has(target)) map.set(target, []);
      map.get(target).push(x);
    }
    const out = [];
    for (const atom of skeleton) {
      for (const x of (beforeGroups.get(atom.id) || [])) out.push({ id: x.id, ch: x.ch });
      out.push({ id: atom.id, ch: atom.ch });
      for (const x of (afterGroups.get(atom.id) || [])) out.push({ id: x.id, ch: x.ch });
    }
    for (const x of endList) if (!out.some(y => y.id === x.id)) out.push({ id: x.id, ch: x.ch });
    return out;
  }

  /* merge3 产生的冲突只有原子 id 集合（aIds/bIds）；在最终 head 上按身份定位
   * 坐标。任一侧 id 在最终文档中已不存在（被后续跳删掉）则丢弃该冲突。 */
  _rebaseConflictsByIds(collected, finalDoc) {
    const index = new Map();
    finalDoc.forEach((x, i) => index.set(x.id, i));
    const out = [];
    for (const cf of collected) {
      const span = function (ids) {
        let lo = -1, hi = -1;
        for (const id of ids) {
          const ix = index.get(id);
          if (ix == null) continue;
          if (lo < 0 || ix < lo) lo = ix;
          if (ix + 1 > hi) hi = ix + 1;
        }
        return lo < 0 ? null : [lo, hi];
      };
      let a = span(cf.aIds), b = span(cf.bIds);
      // insert_in_delete：删除侧无新原子，bIds 是「被删 base」id（最终文档已无），
      // 锚点取插入侧紧邻位置（零宽挂在 a 段之后）
      if (cf.kind === 'insert_in_delete') {
        if (!a) continue;
        b = [a[1], a[1]];
      } else {
        if (!a || !b) continue;
      }
      cf.aStart = a[0]; cf.aEnd = a[1]; cf.bStart = b[0]; cf.bEnd = b[1];
      out.push(cf);
    }
    return out;
  }

  /* ---------------- 冲突裁决 ---------------- */

  resolveConflict(room, conflictId, choice, member) {
    const c = room.conflicts.find(x => x.id === conflictId && x.status === 'open');
    if (!c) return { result: 'error', error: 'conflict_not_found', status: 404,
      rev: room.rev, text: core.atomsText(room.atoms), conflicts: this._openConflicts(room) };
    if (choice !== 'a' && choice !== 'b') {
      return { result: 'error', error: 'invalid_choice', status: 400,
        rev: room.rev, text: core.atomsText(room.atoms), conflicts: this._openConflicts(room) };
    }
    const loseStart = choice === 'a' ? c.bStart : c.aStart;
    const loseEnd = choice === 'a' ? c.bEnd : c.aEnd;
    const expectLose = choice === 'a' ? c.bText : c.aText;
    const loseText = core.atomsText(room.atoms.slice(loseStart, loseEnd));
    if (loseText !== expectLose || loseStart === loseEnd && expectLose !== '') {
      return { result: 'error', error: 'conflict_text_changed', status: 409,
        rev: room.rev, text: core.atomsText(room.atoms), conflicts: this._openConflicts(room) };
    }

    const delStart = loseStart, delLen = loseEnd - loseStart;
    if (delLen > 0) room.atoms.splice(delStart, delLen);
    c.status = 'resolved';
    c.resolvedChoice = choice;
    c.resolvedAt = new Date().toISOString();
    c.resolvedBy = member.memberId;

    // 其余 open 冲突坐标随删除移动
    for (const other of room.conflicts) {
      if (other === c || other.status !== 'open') continue;
      const shift = ix => ix >= delStart + delLen ? ix - delLen :
        (ix >= delStart ? delStart : ix);
      other.aStart = shift(other.aStart); other.aEnd = shift(other.aEnd);
      other.bStart = shift(other.bStart); other.bEnd = shift(other.bEnd);
      other.start = Math.min(other.aStart, other.bStart);
      other.end = Math.max(other.aEnd, other.bEnd);
    }

    room.rev += 1;
    room.updatedAt = new Date().toISOString();
    const resolveOps = delLen > 0 ? [{ t: 'del', start: delStart, len: delLen }] : [];
    const resolveOpId = 'resolve-' + c.id;
    room.seenOps[resolveOpId + ':' + member.memberId] = room.rev;
    room.history.push({
      rev: room.rev, opId: resolveOpId + ':' + member.memberId, publicId: resolveOpId,
      ops: resolveOps, opsForAuthor: resolveOps, member: member.memberId,
      at: room.updatedAt
    });
    this._remember(room, room.rev, room.atoms);
    this.scheduleSave();

    return {
      result: 'ok', rev: room.rev,
      text: core.atomsText(room.atoms),
      appliedOps: resolveOps,
      conflict: this._publicConflict(room, c),
      conflicts: this._openConflicts(room),
      member: member
    };
  }
}

module.exports = { RoomManager: RoomManager,
  fullOpId: fullOpId, publicId: publicId,
  HISTORY_LIMIT: HISTORY_LIMIT, CHECKPOINT_EVERY: CHECKPOINT_EVERY };
