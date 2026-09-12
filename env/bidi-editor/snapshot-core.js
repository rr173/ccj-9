/* snapshot-core.js
 * 审阅快照的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.SnapshotCore），Node 下可直接 require 单测。
 *
 * 包含：
 *   1) 快照载荷校验（名称非空 / 不超长、段落结构、总大小上限）
 *   2) 段落级对齐与字符级差异
 *
 * ★ 与阿拉伯文 RTL 显示相关的关键约定 ★
 *   所有差异偏移量都是“逻辑字符位置”：字符串在内存中的 Unicode 码点顺序，
 *   从 0 开始计数、区间为半开 [start, end)。计算时完全不读取屏幕布局、
 *   不做任何视觉反算，因此阿拉伯文从右向左显示也不会把增删位置标反。
 *   渲染层必须把文本放进 bidi isolate（<bdi>）中，位置标签固定 dir=ltr。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SnapshotCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LIMITS = {
    NAME_MAX_CHARS: 100,      // 快照名称上限（码点）
    PARA_MAX_CHARS: 50000,    // 单段文本上限（码点）
    TOTAL_MAX_CHARS: 100000,  // 全部段落文本总上限（码点）
    PARA_MAX_COUNT: 5000,     // 段落数上限
    LCS_CELL_LIMIT: 2000000   // LCS 动态规划格子上限，超出后退化策略
  };

  var DIRS = { auto: true, ltr: true, rtl: true };

  function nowISO() { return new Date().toISOString(); }

  function cpLen(s) {
    // Array.from 按 Unicode 码点切分（代理对算 1 个逻辑字符）
    return s ? Array.from(s).length : 0;
  }

  function validISO(v) {
    return typeof v === "string" && v.length <= 64 && !isNaN(Date.parse(v));
  }

  /* ---------- 校验 ---------- */

  function validateName(name) {
    if (typeof name !== "string") {
      return { ok: false, status: 400, code: "invalid_name", message: "快照名称必须是文本" };
    }
    var value = name.trim();
    if (!value) {
      return { ok: false, status: 400, code: "empty_name", message: "快照名称不能为空" };
    }
    if (cpLen(value) > LIMITS.NAME_MAX_CHARS) {
      return { ok: false, status: 400, code: "name_too_long",
               message: "快照名称不能超过 " + LIMITS.NAME_MAX_CHARS + " 个字符" };
    }
    return { ok: true, value: value };
  }

  // 返回 {ok:true, value:{name, paragraphs:[{dir,text,editedAt}]}}
  // 或   {ok:false, status, code, message}
  function validateSnapshotPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, status: 400, code: "invalid_body", message: "请求内容必须是快照对象" };
    }
    var nameCheck = validateName(payload.name);
    if (!nameCheck.ok) return nameCheck;

    var paras = payload.paragraphs;
    if (!Array.isArray(paras) || paras.length === 0) {
      return { ok: false, status: 400, code: "invalid_paragraphs", message: "至少要包含一个段落" };
    }
    if (paras.length > LIMITS.PARA_MAX_COUNT) {
      return { ok: false, status: 400, code: "too_many_paragraphs",
               message: "段落数量不能超过 " + LIMITS.PARA_MAX_COUNT };
    }

    var normalized = [];
    var total = 0;
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      if (!p || typeof p !== "object" || typeof p.text !== "string") {
        return { ok: false, status: 400, code: "invalid_paragraph",
                 message: "第 " + (i + 1) + " 段的文本必须是字符串" };
      }
      var len = cpLen(p.text);
      if (len > LIMITS.PARA_MAX_CHARS) {
        return { ok: false, status: 413, code: "paragraph_too_large",
                 message: "第 " + (i + 1) + " 段超过单段 " + LIMITS.PARA_MAX_CHARS + " 字符上限" };
      }
      total += len;
      if (total > LIMITS.TOTAL_MAX_CHARS) {
        return { ok: false, status: 413, code: "snapshot_too_large",
                 message: "快照总文本超过 " + LIMITS.TOTAL_MAX_CHARS + " 字符上限" };
      }
      normalized.push({
        dir: DIRS.hasOwnProperty(p.dir) ? p.dir : "auto", // 非法方向降级为 auto
        text: p.text,
        editedAt: validISO(p.editedAt) ? p.editedAt : nowISO()
      });
    }
    return { ok: true, value: { name: nameCheck.value, paragraphs: normalized } };
  }

  /* ---------- LCS 通用实现（码点数组 / 段落数组） ---------- */

  // 返回有序的类型段（已合并相邻同类），不做退化
  function lcsSegments(A, B) {
    var la = A.length, lb = B.length;
    if (la * lb > LIMITS.LCS_CELL_LIMIT) {
      // 极端输入：退化为“整段删除 + 整段插入”，位置仍然正确，只是粒度粗
      var fallback = [];
      if (la) fallback.push({ type: "del", text: A.join("") });
      if (lb) fallback.push({ type: "ins", text: B.join("") });
      return fallback;
    }
    var w = lb + 1;
    var dp = new Uint32Array((la + 1) * w);
    var i, j;
    for (i = 1; i <= la; i++) {
      var row = i * w, prev = (i - 1) * w;
      for (j = 1; j <= lb; j++) {
        dp[row + j] = A[i - 1] === B[j - 1]
          ? dp[prev + j - 1] + 1
          : Math.max(dp[prev + j], dp[row + j - 1]);
      }
    }
    var rev = [];
    i = la; j = lb;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && A[i - 1] === B[j - 1]) {
        rev.push({ type: "equal", text: A[i - 1] }); i--; j--;
      } else if (i > 0 && (j === 0 || dp[(i - 1) * w + j] >= dp[i * w + j - 1])) {
        rev.push({ type: "del", text: A[--i] });
      } else {
        rev.push({ type: "ins", text: B[--j] });
      }
    }
    rev.reverse();
    var merged = [];
    rev.forEach(function (s) {
      var last = merged[merged.length - 1];
      if (last && last.type === s.type) last.text += s.text;
      else merged.push({ type: s.type, text: s.text });
    });
    return merged;
  }

  // 给每个类型段标注逻辑字符位置（旧侧 oldStart/oldEnd，新侧 newStart/newEnd）
  function annotate(segments) {
    var oldPos = 0, newPos = 0;
    return segments.filter(function (s) { return s.text.length > 0; }).map(function (s) {
      var n = cpLen(s.text);
      var r = { type: s.type, text: s.text,
                oldStart: null, oldEnd: null, newStart: null, newEnd: null };
      if (s.type === "equal") {
        r.oldStart = oldPos; r.oldEnd = oldPos + n;
        r.newStart = newPos; r.newEnd = newPos + n;
        oldPos += n; newPos += n;
      } else if (s.type === "del") {
        r.oldStart = oldPos; r.oldEnd = oldPos + n;
        oldPos += n;
      } else {
        r.newStart = newPos; r.newEnd = newPos + n;
        newPos += n;
      }
      return r;
    });
  }

  // 字符级差异；先剥公共前后缀（常见编辑场景可大幅缩小 DP）
  function charDiff(oldText, newText) {
    var A = Array.from(oldText), B = Array.from(newText);
    var start = 0;
    while (start < A.length && start < B.length && A[start] === B[start]) start++;
    var ea = A.length, eb = B.length;
    while (ea > start && eb > start && A[ea - 1] === B[eb - 1]) { ea--; eb--; }

    var segs = [];
    if (start) segs.push({ type: "equal", text: A.slice(0, start).join("") });
    lcsSegments(A.slice(start, ea), B.slice(start, eb)).forEach(function (s) { segs.push(s); });
    if (ea < A.length) segs.push({ type: "equal", text: A.slice(ea).join("") });
    return annotate(segs);
  }

  /* ---------- 段落对齐 ---------- */

  // 对齐依据是段落文本（文本相同即视为同一段）；方向差异由 dirChanged 表达。
  // 返回操作序列：{op:"equal"|"del"|"ins", a:idx, b:idx}
  function alignParagraphs(aParas, bParas) {
    var la = aParas.length, lb = bParas.length;
    if (la * lb > LIMITS.LCS_CELL_LIMIT) {
      var all = [];
      aParas.forEach(function (_, i) { all.push({ op: "del", a: i }); });
      bParas.forEach(function (_, j) { all.push({ op: "ins", b: j }); });
      return all;
    }
    var w = lb + 1;
    var dp = new Uint32Array((la + 1) * w);
    var i, j;
    for (i = 1; i <= la; i++) {
      var row = i * w, prev = (i - 1) * w;
      for (j = 1; j <= lb; j++) {
        dp[row + j] = aParas[i - 1].text === bParas[j - 1].text
          ? dp[prev + j - 1] + 1
          : Math.max(dp[prev + j], dp[row + j - 1]);
      }
    }
    var rev = [];
    i = la; j = lb;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && aParas[i - 1].text === bParas[j - 1].text) {
        rev.push({ op: "equal", a: --i, b: --j });
      } else if (i > 0 && (j === 0 || dp[(i - 1) * w + j] >= dp[i * w + j - 1])) {
        rev.push({ op: "del", a: --i });
      } else {
        rev.push({ op: "ins", b: --j });
      }
    }
    rev.reverse();
    return rev;
  }

  // 计算两个快照的完整差异，返回行序列与统计。
  // row.kind: "same"（未变）/ "changed"（文本或方向变了）/ "removed" / "added"
  function diffSnapshots(oldSnap, newSnap) {
    var A = oldSnap.paragraphs, B = newSnap.paragraphs;
    var ops = alignParagraphs(A, B);
    var rows = [];
    var aNo = 0, bNo = 0;
    var stats = { same: 0, changed: 0, removed: 0, added: 0,
                  insertedChars: 0, deletedChars: 0 };

    function changedRow(pa, pb, an, bn) {
      var dirChanged = pa.dir !== pb.dir;
      var chars = pa.text === pb.text ? [] : charDiff(pa.text, pb.text);
      chars.forEach(function (s) {
        if (s.type === "ins") stats.insertedChars += cpLen(s.text);
        if (s.type === "del") stats.deletedChars += cpLen(s.text);
      });
      return { kind: "changed", a: pa, b: pb, aNo: an, bNo: bn,
               dirChanged: dirChanged, chars: chars };
    }
    function removedRow(pa, an) {
      stats.removed++;
      stats.deletedChars += cpLen(pa.text);
      rows.push({ kind: "removed", a: pa, aNo: an });
    }
    function addedRow(pb, bn) {
      stats.added++;
      stats.insertedChars += cpLen(pb.text);
      rows.push({ kind: "added", b: pb, bNo: bn });
    }

    var k = 0;
    while (k < ops.length) {
      var op = ops[k];
      if (op.op === "equal") {
        aNo++; bNo++;
        var pa = A[op.a], pb = B[op.b];
        if (pa.dir === pb.dir) {
          rows.push({ kind: "same", a: pa, b: pb, aNo: aNo, bNo: bNo });
          stats.same++;
        } else {
          rows.push(changedRow(pa, pb, aNo, bNo));
          stats.changed++;
        }
        k++;
        continue;
      }
      // 收集连续的 del/ins 区段（中间没有 equal）
      var dels = [], inss = [];
      while (k < ops.length && ops[k].op !== "equal") {
        if (ops[k].op === "del") dels.push(ops[k++]);
        else inss.push(ops[k++]);
      }
      dels.forEach(function (d) { d.aNo = ++aNo; });
      inss.forEach(function (d) { d.bNo = ++bNo; });

      // 同位置修改只在“单个 del 与单个 ins 相邻”时配对；
      // 数量不等或彼此跨过其他块时，保留为独立的整段新增/删除，
      // 避免把两个不相关的段落误报成“修改”。
      if (dels.length === 1 && inss.length === 1) {
        rows.push(changedRow(A[dels[0].a], B[inss[0].b], dels[0].aNo, inss[0].bNo));
        stats.changed++;
      } else {
        dels.forEach(function (d) { removedRow(A[d.a], d.aNo); });
        inss.forEach(function (d) { addedRow(B[d.b], d.bNo); });
      }
    }
    return { rows: rows, stats: stats,
             oldName: oldSnap.name, newName: newSnap.name };
  }

  return {
    LIMITS: LIMITS,
    cpLen: cpLen,
    validateSnapshotPayload: validateSnapshotPayload,
    validateName: validateName,
    charDiff: charDiff,
    alignParagraphs: alignParagraphs,
    diffSnapshots: diffSnapshots
  };
});
