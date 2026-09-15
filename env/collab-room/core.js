'use strict';
/*
 * 双向文本多人协作编辑房间 —— 纯逻辑核心（无依赖，服务端与浏览器共用）
 *
 * 模型：
 *   文档是「字素簇原子」数组（Intl.Segmenter），emoji ZWJ 序列（👨‍👩‍👧）、
 *   组合音标等永远作为一个整体被插入/删除/定位，光标因此不会劈开集群；
 *   偏移全部按逻辑集群计算、与渲染方向无关，RTL（阿拉伯文等）由浏览器
 *   原生 bidi 引擎负责呈现，本模块不读屏幕布局。
 *
 * 操作（changeset = ops 数组）：
 *   {t:'ins', gap, text}   在父文档第 gap 个集群边界（0..len）插入 text
 *   {t:'del', start, len}  删除父文档 [start, start+len) 个集群
 *
 * 并发合并 mergeChangeset(parent, A, B, opIdA, opIdB) 基于「原子身份 +
 * 父集群线性扫描」，纯确定性（opId 字典序定胜负），产出：
 *   doc    合并后的原子数组
 *   opsA   从「只应用 B 的文档」变成 doc 需要的 changeset（发给 A）
 *   opsB   从「只应用 A 的文档」变成 doc 需要的 changeset（发给 B）
 *   conflicts 硬冲突区（同位置双插 / 插入撞上对方删除 / 单方删除对方保留）
 */

const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
let _segmenter = null;
function segmenter() {
  if (!_segmenter) _segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return _segmenter;
}

/* ---------- 字素簇 ---------- */

function graphemes(text) {
  if (text == null) return [];
  text = String(text);
  if (HAS_SEGMENTER) {
    const out = [];
    for (const seg of segmenter().segment(text)) out.push(seg.segment);
    return out;
  }
  return Array.from(text); // 极端降级：按码点拆
}
function gLen(text) { return graphemes(text).length; }

function clusterOffsets(text) {
  // 每个字素簇在字符串中的 UTF-16 边界：返回长度 n+1 的起点数组
  const starts = [0];
  let acc = 0;
  for (const g of graphemes(text)) { acc += g.length; starts.push(acc); }
  return starts;
}

function codeUnitToCluster(text, codeUnitOffset) {
  // textarea 用 UTF-16 偏移，映射到最近的字素簇边界（不劈开集群）
  const starts = clusterOffsets(text);
  const off = Math.max(0, Math.min(codeUnitOffset, text.length));
  let lo = 0, hi = starts.length - 1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= off) lo = i;
    if (starts[i] >= off) { hi = i; break; }
  }
  return (off - starts[lo] <= starts[hi] - off) ? lo : hi;
}
function clusterToCodeUnit(text, clusterIndex) {
  const starts = clusterOffsets(text);
  return starts[Math.max(0, Math.min(clusterIndex, starts.length - 1))];
}

/* ---------- 原子（带稳定身份的字素簇） ---------- */

function atomsText(atoms) {
  let s = '';
  for (const a of atoms) s += a.ch;
  return s;
}

function normalizeOps(ops) {
  if (!Array.isArray(ops)) return [];
  const out = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'ins') {
      if (typeof op.gap !== 'number' || typeof op.text !== 'string') continue;
      const gs = graphemes(op.text);
      if (!gs.length) continue;
      out.push({ t: 'ins', gap: Math.floor(op.gap), gs: gs });
    } else if (op.t === 'del') {
      if (typeof op.start !== 'number' || typeof op.len !== 'number') continue;
      const len = Math.floor(op.len);
      if (len <= 0) continue;
      out.push({ t: 'del', start: Math.floor(op.start), len: len });
    }
  }
  return out;
}
// 对外（线路格式）使用 text 而非 gs
function wireOps(ops) {
  return normalizeOps(ops).map(function (op) {
    return op.t === 'ins'
      ? { t: 'ins', gap: op.gap, text: op.gs.join('') }
      : { t: 'del', start: op.start, len: op.len };
  });
}

/* ---------- 把 changeset 规范化成「每个父集群一条决策 + 每 gap 一条插入」 ----------
 * { deletes: Set<parentIndex>, inserts: Map<gap, gs[]> }（同 gap 多插入按顺序归并）
 */
function planChangeset(parentLen, ops) {
  const norm = normalizeOps(ops);
  const deletes = new Set();
  const inserts = new Map();
  for (const op of norm) {
    if (op.t === 'del') {
      const end = Math.min(parentLen, op.start + op.len);
      for (let i = Math.max(0, op.start); i < end; i++) deletes.add(i);
    } else {
      const gap = Math.max(0, Math.min(op.gap, parentLen));
      const list = inserts.get(gap) || [];
      list.push.apply(list, op.gs);
      inserts.set(gap, list);
    }
  }
  return { deletes: deletes, inserts: inserts };
}

/* ---------- 核心：线性三方合并（「全保留」模型） ----------
 *
 * 硬冲突不丢任何一方的文字：双方内容都进合并文档（相邻集群），
 * 用 conflict zone（aStart/aEnd/bStart/bEnd 两段相邻集群区间）标注，
 * 由用户在页面上选择保留哪一侧；resolve 时删除败方区间即可。
 * 因为两侧内容都在 doc 里，收敛只需常规 ins/del 变换，天然一致。
 *
 *   same_gap_insert ：同位置双插，按 opId 字典序排列两段（a 侧在前）
 *   insert_in_delete：插入落在对方删除游程内/左边界，被删簇保留、
 *                     与插入文本共同组成冲突区（删除整段在前、插入在后）
 * 单方删除（对方没动同簇）按常规 OT 生效，不产生冲突。
 */
function mergeChangeset(parent, opsA, opsB, idA, idB) {
  const planA = planChangeset(parent.length, opsA);
  const planB = planChangeset(parent.length, opsB);
  const conflicts = [];
  let cseq = 0;
  function addConflict(c) {
    cseq++;
    c.id = 'c' + Date.now().toString(36) + '-' + cseq + '-' + Math.random().toString(36).slice(2, 6);
    c.createdAt = new Date().toISOString();
    conflicts.push(c);
  }

  function rangesOf(set) {
    const ranges = [];
    let s = -1;
    for (let i = 0; i <= parent.length; i++) {
      if (i < parent.length && set.has(i)) { if (s < 0) s = i; }
      else if (s >= 0) { ranges.push([s, i]); s = -1; }
    }
    return ranges;
  }
  const rangesA = rangesOf(planA.deletes);
  const rangesB = rangesOf(planB.deletes);

  /* ---- 冲突 1：同位置（同 gap）双方都插入 ---- */
  const sameGapSet = new Set();
  for (const [gap, gsA] of planA.inserts) {
    const gsB = planB.inserts.get(gap);
    if (gsB && gsB.length) {
      sameGapSet.add(gap);
      addConflict({
        kind: 'same_gap_insert', pGap: gap,
        winner: idA < idB ? 'a' : 'b', aOpId: idA, bOpId: idB
      });
    }
  }

  /* ---- 冲突 2：插入撞对方删除游程 ----
   * 命中的删除簇「挽救保留」；gap==游程末端的插入也并入（作为游程后插入，
   * 两段相邻）。每个删除游程至多一条冲突，插入碎片按 gap 顺序归并。
   * rescue 计划（父坐标，doc 构建前一次性算好）：
   *   { start, delEnd, delSide, insSide, idDel, idIns,
   *     parts: [{gap, gs, side}], suppressed:Set<parentIndex> }
   */
  const rescuePlans = []; // 顺序与 conflicts 中 insert_in_delete 一一对应
  function buildRescue(ranges, delSide) {
    const insPlan = delSide === 'a' ? planB : planA;
    const otherDel = delSide === 'a' ? planB.deletes : planA.deletes;
    for (const [s, e] of ranges) {
      const parts = [];
      for (const [gap, gs] of insPlan.inserts) {
        if (gap >= s && gap < e) parts.push({ gap: gap, gs: gs.slice() });
      }
      if (!parts.length) continue;
      parts.sort(function (x, y) { return x.gap - y.gap; });
      // 游程中「对方也要删」的簇不挽救（双方删除一致生效）
      const suppressed = new Set();
      for (let p = s; p < e; p++) if (otherDel.has(p)) suppressed.add(p);
      rescuePlans.push({
        start: s, delEnd: e,
        delSide: delSide, insSide: delSide === 'a' ? 'b' : 'a',
        idDel: delSide === 'a' ? idA : idB,
        idIns: delSide === 'a' ? idB : idA,
        parts: parts, suppressed: suppressed
      });
    }
  }
  buildRescue(rangesA, 'a');
  buildRescue(rangesB, 'b');
  rescuePlans.sort(function (x, y) { return x.start - y.start || x.delEnd - y.delEnd; });
  // 同一起点的重叠游程（双方删除重叠且各自被撞）确定性去重，保留第一条
  const dedupPlans = [];
  for (const rp of rescuePlans) {
    if (!dedupPlans.some(function (q) { return q.start === rp.start; })) dedupPlans.push(rp);
  }
  const rescueByStart = new Map();
  for (const rp of dedupPlans) {
    rescueByStart.set(rp.start, rp);
    rp._conflict = {
      kind: 'insert_in_delete', insSide: rp.insSide,
      aOpId: idA, bOpId: idB
    };
    addConflict(rp._conflict);
    rp._conflict._rp = rp;
  }
  // 被任一 rescue 覆盖（且未被双方共删抑制）的父簇
  const rescuedCover = new Map(); // parentIndex -> rescue
  for (const rp of rescueByStart.values()) {
    for (let p = rp.start; p < rp.delEnd; p++) {
      if (!rp.suppressed.has(p)) rescuedCover.set(p, rp);
    }
  }

  /* ---- 构造合并 doc：逐父集群扫描 ---- */
  const doc = [];
  // 原子 id 规则：插入簇 id = opId + '-' + gap + '-' + 同 gap 序号。
  // gap-局部编号不受其他 gap 插入是否被移动影响，合并 doc 与单方世界永远一致，
  // 重连重放不会变成重复内容。
  function emitInsert(side, gap, gs, id) {
    const start = doc.length;
    for (let i = 0; i < gs.length; i++) {
      doc.push({ id: id + '-' + gap + '-' + i, ch: gs[i] });
    }
    return { start: start, end: doc.length };
  }
  const sameGapAnchor = new Map(); // gap -> {a,b:{start,end}}
  for (let p = 0; p <= parent.length; p++) {
    if (rescueByStart.has(p)) {
      const rp = rescueByStart.get(p);
      // 插入碎片在前（按 gap 顺序），挽救的删除簇在后，两段相邻构成冲突区
      const insStart = doc.length;
      for (const part of rp.parts) {
        emitInsert(rp.insSide, part.gap, part.gs, rp.idIns);
      }
      const insEnd = doc.length;
      const delStart = doc.length;
      for (let q = p; q < rp.delEnd; q++) {
        if (!rp.suppressed.has(q)) doc.push(parent[q]);
      }
      const delEnd = doc.length;
      rp._anchor = {
        del: { start: delStart, end: delEnd },
        ins: { start: insStart, end: insEnd }
      };
    }
    const gsA = planA.inserts.get(p);
    const gsB = planB.inserts.get(p);
    if (sameGapSet.has(p)) {
      const first = idA < idB ? 'a' : 'b';
      const r1 = emitInsert(first, p, first === 'a' ? gsA : gsB, first === 'a' ? idA : idB);
      const r2 = emitInsert(first === 'a' ? 'b' : 'a', p, first === 'a' ? gsB : gsA,
        first === 'a' ? idB : idA);
      sameGapAnchor.set(p, { a: first === 'a' ? r1 : r2, b: first === 'a' ? r2 : r1 });
    } else if (!rescueByStart.has(p)) {
      const entries = [];
      if (gsA) entries.push({ side: 'a', id: idA, gs: gsA });
      if (gsB) entries.push({ side: 'b', id: idB, gs: gsB });
      entries.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
      for (const en of entries) emitInsert(en.side, p, en.gs, en.id);
    }
    if (p < parent.length) {
      const inA = planA.deletes.has(p), inB = planB.deletes.has(p);
      if (inA && inB) continue;                 // 双方删除：生效
      if (rescuedCover.has(p)) continue;        // 已随 rescue 游程输出
      if (inA || inB) continue;                 // 单方删除：OT 常规生效
      doc.push(parent[p]);
    }
  }

  /* 单方世界（用于推导变换 ops），插入原子复用同一套 gap-局部 id */
  function oneSide(plan, side, id) {
    const out = [];
    for (let p = 0; p <= parent.length; p++) {
      const gs = plan.inserts.get(p);
      if (gs) {
        for (let i = 0; i < gs.length; i++) {
          out.push({ id: id + '-' + p + '-' + i, ch: gs[i] });
        }
      }
      if (p < parent.length && !plan.deletes.has(p)) out.push(parent[p]);
    }
    return out;
  }
  const docA = oneSide(planA, 'a', idA);
  const docB = oneSide(planB, 'b', idB);

  // A 的本地世界是 docA：它需要「docA -> doc」；B 同理需要「docB -> doc」
  const opsForA = diffToOps(docA, doc);
  const opsForB = diffToOps(docB, doc);

  /* 冲突区映射为最终结构（两段相邻集群区间）。 */
  for (const c of conflicts) {
    if (c.kind === 'same_gap_insert') {
      const a = sameGapAnchor.get(c.pGap).a;
      const b = sameGapAnchor.get(c.pGap).b;
      c.aStart = a.start; c.aEnd = a.end; c.bStart = b.start; c.bEnd = b.end;
      c.aText = atomsText(doc.slice(a.start, a.end));
      c.bText = atomsText(doc.slice(b.start, b.end));
      delete c.pGap;
    } else {
      // insert_in_delete：锚点在构建 doc 时直接挂在 rescue 计划上
      const anc = c._rp._anchor;
      let spanA, spanB;
      if (c.insSide === 'a') { spanA = anc.ins; spanB = anc.del; }
      else { spanA = anc.del; spanB = anc.ins; }
      c.aStart = spanA.start; c.aEnd = spanA.end;
      c.bStart = spanB.start; c.bEnd = spanB.end;
      c.aText = atomsText(doc.slice(spanA.start, spanA.end));
      c.bText = atomsText(doc.slice(spanB.start, spanB.end));
      // 默认建议：接受删除（删除方对侧获胜）
      c.winner = c.insSide === 'a' ? 'b' : 'a';
      delete c.insSide;
      delete c._rp;
    }
  }

  return { doc: doc, opsForA: wireOps(opsForA), opsForB: wireOps(opsForB), conflicts: conflicts };
}

/* ---------- 原子身份编辑脚本：生成 from -> to 的 changeset ----------
 * 不按字符做 LCS：相同字符（重复字母/emoji）属于不同原子，绝不能跨身份配对。
 * 规则：
 *   - 公共原子 = 同时出现在两边且身份唯一的原子，保持原有相对顺序（稳定排序）
 *   - 其余旧原子删除（连续删除合并）；新原子插入到最近的 gap（连续插入合并）
 */
function diffToOps(from, to) {
  const n = from.length, m = to.length;
  if (n > 100000 || m > 100000) {
    const ops = [];
    if (n) ops.push({ t: 'del', start: 0, len: n });
    if (m) ops.push({ t: 'ins', gap: 0, text: atomsText(to) });
    return ops;
  }
  const fromCount = new Map();
  for (const a of from) fromCount.set(a.id, (fromCount.get(a.id) || 0) + 1);
  const toCount = new Map();
  for (const a of to) toCount.set(a.id, (toCount.get(a.id) || 0) + 1);
  // 公共身份（按身份计数，重复 id 异常时退化为不匹配以免错乱）
  const commonIds = new Set();
  for (const [id, cnt] of fromCount) {
    if (cnt === 1 && toCount.get(id) === 1) commonIds.add(id);
  }
  // 公共原子在 from/to 中的索引序列（两边顺序天然一致；不一致则剔除冲突项）
  const fromIx = new Map();
  from.forEach(function (a, i) { if (commonIds.has(a.id)) fromIx.set(a.id, i); });
  // to 序列上公共 id 的 from 索引，取最长递增子序列 => 公共骨架（顺序一致）
  const seq = [];
  to.forEach(function (a, j) {
    if (commonIds.has(a.id)) seq.push({ id: a.id, fi: fromIx.get(a.id), ti: j });
  });
  const tails = [], prev = new Array(seq.length).fill(-1);
  let best = -1;
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]].fi < seq[i].fi) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
    if (lo === tails.length - 1) best = i;
  }
  const commonRev = [];
  for (let k = best; k >= 0; k = prev[k]) commonRev.push(seq[k]);
  const common = commonRev.reverse();

  const ops = [];
  // 扫描：以 from 为基线，在公共骨架之间产出 del（from 独有）与 ins（to 独有）
  let fp = 0, tp = 0, ci = 0;
  while (fp < n || tp < m) {
    const cf = ci < common.length ? common[ci].fi : n;
    const ct = ci < common.length ? common[ci].ti : m;
    // from 独有：删除
    if (fp < cf) {
      ops.push({ t: 'del', start: fp, len: cf - fp });
      fp = cf;
    }
    // to 独有：插入（gap 用当前 from 骨架位置；公共点处 gap == fp）
    if (tp < ct) {
      let text = '';
      for (let k = tp; k < ct; k++) text += to[k].ch;
      ops.push({ t: 'ins', gap: fp, text: text });
      tp = ct;
    }
    if (ci < common.length) { fp = cf + 1; tp = ct + 1; ci++; }
    else break;
  }
  return ops;
}

/* ---------- 服务端直接应用（基线即当前版本，无并发） ----------
 * 插入 id = opId + '-' + gap + '-' + 同 gap 序号，与 mergeChangeset 编号一致。
 */
function applyDirect(parent, ops, opId) {
  const plan = planChangeset(parent.length, ops);
  const out = [];
  for (let p = 0; p <= parent.length; p++) {
    const gs = plan.inserts.get(p);
    if (gs) {
      for (let i = 0; i < gs.length; i++) out.push({ id: opId + '-' + p + '-' + i, ch: gs[i] });
    }
    if (p < parent.length && !plan.deletes.has(p)) out.push(parent[p]);
  }
  return out;
}

/* ---------- 锚点位置变换（冲突区/光标跟随编辑移动） ---------- */

function transformRange(start, end, ops) {
  let s = start, e = end;
  const plan = planChangeset(Infinity, ops); // 仅用 inserts 部分
  for (const op of normalizeOps(ops)) {
    if (op.t !== 'del') continue;
    const ds = op.start, de = op.start + op.len;
    if (de <= s) { s -= (de - ds); e -= (de - ds); }
    else if (ds >= e) { /* 区间之后，无影响 */ }
    else {
      const removed = Math.min(e, de) - Math.max(s, ds);
      s = Math.min(s, ds); e -= removed;
    }
  }
  // 插入：边界相同的插入视为在光标之后（gap <= index 才推动）
  for (const [gap, gs] of plan.inserts) {
    const n = gs.length;
    if (gap <= s) { s += n; e += n; }
    else if (gap < e) { e += n; }
  }
  if (e < s) e = s;
  return [s, e];
}
function transformIndex(index, ops) {
  return transformRange(index, index, ops)[0];
}

/* 按原子身份把旧文档 [start,end) 区间映射到新文档：
 * 旧区间内仍存活的原子在新文档中的最小/最大位置；全部被删返回 null。
 * 用于冲突区锚点在任意 diff（parent -> new）下的精确重定位。 */
function remapSpanById(oldAtoms, newAtoms, start, end) {
  const index = new Map();
  newAtoms.forEach(function (a, i) { index.set(a.id, i); });
  let lo = -1, hi = -1;
  for (let p = start; p < end; p++) {
    const ix = index.get(oldAtoms[p].id);
    if (ix == null) continue;
    if (lo < 0 || ix < lo) lo = ix;
    if (ix + 1 > hi) hi = ix + 1;
  }
  if (lo < 0) return null;
  return [lo, hi];
}

/* 点（集群边界）映射：优先锚定边界前最后一个存活原子，否则用其后首个存活原子。 */
function remapIndexById(oldAtoms, newAtoms, i) {
  const index = new Map();
  newAtoms.forEach(function (a, k) { index.set(a.id, k); });
  for (let p = i - 1; p >= 0; p--) {
    const ix = index.get(oldAtoms[p].id);
    if (ix != null) return ix + 1;
  }
  for (let p = i; p < oldAtoms.length; p++) {
    const ix = index.get(oldAtoms[p].id);
    if (ix != null) return ix;
  }
  return 0;
}

/* ---------- 校验 ---------- */

function validateChangeset(parentLen, ops, maxDocClusters) {
  const norm = wireOps(ops);
  if (norm.length === 0) return { ok: false, code: 'empty_changeset' };
  let delta = 0;
  for (const op of norm) {
    if (op.t === 'ins') {
      if (op.gap < 0 || op.gap > parentLen) return { ok: false, code: 'position_out_of_range' };
      const n = gLen(op.text);
      if (n > 100000) return { ok: false, code: 'changeset_too_large', status: 413 };
      delta += n;
    } else {
      if (op.start < 0 || op.start >= parentLen) return { ok: false, code: 'position_out_of_range' };
      if (op.start + op.len > parentLen) return { ok: false, code: 'delete_out_of_range' };
      delta -= op.len;
    }
  }
  if (parentLen + delta < 0) return { ok: false, code: 'delete_out_of_range' };
  if (parentLen + delta > (maxDocClusters || 200000)) {
    return { ok: false, code: 'document_too_large', status: 413 };
  }
  return { ok: true, ops: norm };
}

/* ---------- 身份三方合并（多跳 OT 折叠用） ----------
 *
 * base / a / b 都是原子数组；a、b 是从 base 各自演化（再被逐跳补齐上下文）
 * 的两个世界。合并纯按原子身份处理，与字符是否重复无关：
 *   上下文 C = base 中同时存在于 b 的原子（多跳时更早旧提交在两边同 id）
 *   - C 原子：a 或 b 任一方删除即删除（单方删除确定性生效）
 *   - a、b 新插入的原子全部保留；按各自序列里相对 C 邻居的锚点（before/after）
 *     挂到上下文骨架
 *   - 同一锚点侧双方都插入 => same_gap_insert 冲突（两段相邻、按 id 排序）
 *   - 新插入的锚点被对方删除 => insert_in_delete 冲突（文本放文末，
 *     坐标由调用方按 id 定位）
 */
function merge3(base, a, b, idA, idB) {
  const baseIds = new Set(base.map(x => x.id));
  const aIds = new Set(a.map(x => x.id));
  const bIds = new Set(b.map(x => x.id));
  // 上下文 C = base 中双方都保留的原子（任一方删除即不在 C；单删按 OT 生效）
  const context = base.filter(x => bIds.has(x.id) && aIds.has(x.id));
  const cIds = new Set(context.map(x => x.id));
  // 真正的「新插入」= 不在 base 中（不能用 !cIds，否则会把「对方删除、本方保留」
  // 的 base 原子误当成新插入又带回文档）
  const aNew = a.filter(x => !baseIds.has(x.id));
  const bNew = b.filter(x => !baseIds.has(x.id));
  const aNewIds = new Set(aNew.map(x => x.id));
  const bNewIds = new Set(bNew.map(x => x.id));

  // 新原子相对「上下文序列」的锚点：before=前一个 C 原子，after=后一个 C 原子
  // （用于在输出骨架上定位）
  function anchors(seq, newSet, ctxSet) {
    const m = new Map();
    seq.forEach(function (x, i) {
      if (!newSet.has(x.id)) return;
      let before = null, after = null;
      for (let j = i - 1; j >= 0; j--) if (ctxSet.has(seq[j].id)) { before = seq[j].id; break; }
      for (let j = i + 1; j < seq.length; j++) if (ctxSet.has(seq[j].id)) { after = seq[j].id; break; }
      m.set(x.id, { before: before, after: after });
    });
    return m;
  }
  const aAnc = anchors(a, aNewIds, cIds);
  const bAnc = anchors(b, bNewIds, cIds);
  // base 邻居锚点（插入点相对原始 base；用于 insert_in_delete 检测）
  const aBaseAnc = anchors(a, aNewIds, baseIds);
  const bBaseAnc = anchors(b, bNewIds, baseIds);

  // 分组：key = "锚点id>before|after" 或 "__end__>after"
  // 优先 after（放在该上下文原子之前），否则 before（放其后），都没有 => 文末
  function groups(seq, newIds, anc, keepCtx) {
    const map = new Map();
    function push(key, x) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(x);
    }
    for (const x of seq) {
      if (!newIds.has(x.id)) continue;
      const an = anc.get(x.id);
      if (an.after != null && keepCtx.has(an.after)) push(an.after + '>before', x);
      else if (an.before != null && keepCtx.has(an.before)) push(an.before + '>after', x);
      else push('__end__>after', x);
    }
    return map;
  }
  const aGroups = groups(a, aNewIds, aAnc, cIds);
  const bGroups = groups(b, bNewIds, bAnc, cIds);

  const conflicts = [];
  let cseq = 0;
  function addConflict(c) {
    cseq++;
    c.id = 'c' + Date.now().toString(36) + '-' + cseq + '-' +
      Math.random().toString(36).slice(2, 6);
    c.createdAt = new Date().toISOString();
    c.aOpId = idA; c.bOpId = idB;
    conflicts.push(c);
  }
  const text = list => list.map(x => x.ch).join('');

  // 同位置双插
  for (const [key, bList] of bGroups) {
    const aList = aGroups.get(key);
    if (aList) {
      addConflict({
        kind: 'same_gap_insert',
        aIds: aList.map(x => x.id), bIds: bList.map(x => x.id),
        aText: text(aList), bText: text(bList),
        winner: idA < idB ? 'a' : 'b'
      });
    }
  }

  const doc = [];
  const emitted = new Set();
  function emitList(list) {
    if (!list) return;
    for (const x of list) {
      if (emitted.has(x.id)) continue;
      emitted.add(x.id);
      doc.push({ id: x.id, ch: x.ch });
    }
  }
  function emitSide(anchorId, side) {
    const aL = aGroups.get(anchorId + '>' + side);
    const bL = bGroups.get(anchorId + '>' + side);
    if (aL && bL) {
      if (idA < idB) { emitList(aL); emitList(bL); }
      else { emitList(bL); emitList(aL); }
    } else {
      if (aL) emitList(aL);
      if (bL) emitList(bL);
    }
  }

  // 按上下文顺序输出（上下文原子必须双方都保留；单方删除即不输出）
  for (const x of context) {
    if (!aIds.has(x.id) || !bIds.has(x.id)) continue;
    emitSide(x.id, 'before');
    if (!emitted.has(x.id)) { emitted.add(x.id); doc.push({ id: x.id, ch: x.ch }); }
    emitSide(x.id, 'after');
  }
  // 被单方删除的上下文原子旁若有对方新插入，这些插入已落入文末组（锚点失效）
  const aEnd = aGroups.get('__end__>after');
  const bEnd = bGroups.get('__end__>after');
  if (idA < idB) { emitList(aEnd); emitList(bEnd); }
  else { emitList(bEnd); emitList(aEnd); }

  // insert_in_delete 冲突：新原子的「after 锚点」是 base 原子且被对方删除
  // （插入点落在对方删除游程内/左边界）。文本仍按 before 锚点（或文末）保留。
  function flagInsDel(newList, anc, side) {
    for (const x of newList) {
      const an = anc.get(x.id);
      if (an.after != null && baseIds.has(an.after)) {
        const otherKeeps = side === 'a' ? bIds.has(an.after) : aIds.has(an.after);
        if (!otherKeeps) {
          addConflict(side === 'a'
            ? { kind: 'insert_in_delete', aIds: [x.id], bIds: [], aText: x.ch, bText: '', winner: 'b' }
            : { kind: 'insert_in_delete', aIds: [], bIds: [x.id], aText: '', bText: x.ch, winner: 'a' });
        }
      }
    }
  }
  flagInsDel(aNew, aBaseAnc, 'a');
  flagInsDel(bNew, bBaseAnc, 'b');

  return { doc: doc, conflicts: conflicts };
}

/* ---------- 导出 ---------- */

const api = {
  graphemes: graphemes,
  gLen: gLen,
  clusterOffsets: clusterOffsets,
  codeUnitToCluster: codeUnitToCluster,
  clusterToCodeUnit: clusterToCodeUnit,
  atomsText: atomsText,
  normalizeOps: wireOps,
  planChangeset: planChangeset,
  mergeChangeset: mergeChangeset,
  merge3: merge3,
  diffToOps: diffToOps,
  applyDirect: applyDirect,
  transformRange: transformRange,
  transformIndex: transformIndex,
  remapSpanById: remapSpanById,
  remapIndexById: remapIndexById,
  validateChangeset: validateChangeset
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.CollabCore = api;
