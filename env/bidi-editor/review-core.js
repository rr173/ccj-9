/* review-core.js
 * 协作审阅（批注）的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.ReviewCore），Node 下可直接 require 单测。
 *
 * 包含：
 *   1) 批注 / 回复载荷校验（空内容、超长、空范围、引文与范围不一致等）
 *   2) 批注记录规范化（从快照恢复时逐条校验）
 *   3) 锚点重定位：文本被编辑、折行、方向切换后，批注仍指向原来的字符
 *
 * ★ 与阿拉伯文 RTL 显示相关的关键约定 ★
 *   锚点的 start/end 是“逻辑字符位置”：段落文本在内存中的 Unicode 码点顺序，
 *   半开区间 [start, end)，从 0 计。重定位只在码点数组上做查找，
 *   完全不读取屏幕布局，因此阿拉伯文从右向左显示时位置依然正确。
 *   渲染层必须把引文放进 <bdi> 隔离，位置标签固定 dir=ltr。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ReviewCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LIMITS = {
    AUTHOR_MAX_CHARS: 50,       // 作者名上限（码点）
    BODY_MAX_CHARS: 1000,       // 批注正文上限（码点）
    REPLY_MAX_CHARS: 1000,      // 单条回复上限（码点）
    QUOTE_MAX_CHARS: 5000,      // 引文（被批注原文）上限（码点）
    ANNOTATION_MAX_COUNT: 500,  // 批注总数上限
    REPLY_MAX_COUNT: 100,       // 单条批注的回复数上限
    ID_MAX_CHARS: 64            // 记录 id 长度上限
  };

  var DIRS = { auto: true, ltr: true, rtl: true };
  var STATUS = { open: true, resolved: true };

  function nowISO() { return new Date().toISOString(); }

  function cpLen(s) {
    // Array.from 按 Unicode 码点切分（代理对算 1 个逻辑字符）
    return s ? Array.from(s).length : 0;
  }

  function cpSlice(s, start, end) {
    return Array.from(s).slice(start, end).join("");
  }

  function validISO(v) {
    return typeof v === "string" && v.length <= 64 && !isNaN(Date.parse(v));
  }

  function isInt(v) {
    return typeof v === "number" && isFinite(v) && Math.floor(v) === v;
  }

  function err(status, code, message) {
    return { ok: false, status: status, code: code, message: message };
  }

  /* ---------- 基础字段校验 ---------- */

  function validateAuthor(v) {
    if (v == null || v === "") return { ok: true, value: "匿名" };
    if (typeof v !== "string") {
      return err(400, "invalid_author", "作者必须是文本");
    }
    var name = v.trim();
    if (!name) return { ok: true, value: "匿名" };
    if (cpLen(name) > LIMITS.AUTHOR_MAX_CHARS) {
      return err(400, "author_too_long",
        "作者名不能超过 " + LIMITS.AUTHOR_MAX_CHARS + " 个字符");
    }
    return { ok: true, value: name };
  }

  // 正文类文本（批注正文 / 回复）共用校验：非空 + 上限
  function validateText(v, kind) {
    var label = kind === "reply" ? "回复内容" : "批注内容";
    var max = kind === "reply" ? LIMITS.REPLY_MAX_CHARS : LIMITS.BODY_MAX_CHARS;
    if (typeof v !== "string") {
      return err(400, "invalid_body", label + "必须是文本");
    }
    var value = v.trim();
    if (!value) {
      return err(400, "empty_body", label + "不能为空");
    }
    if (cpLen(value) > max) {
      return err(413, "body_too_large", label + "不能超过 " + max + " 个字符");
    }
    return { ok: true, value: value };
  }

  /* ---------- 锚点校验 ----------
   * anchor: {paraIndex, start, end, quote, paraDir}
   * 约定：quote 必须恰好等于原文在 [start,end) 的切片，
   * 即 end - start === cpLen(quote)，否则说明客户端位置已失真。
   */
  function validateAnchor(a) {
    if (!a || typeof a !== "object") {
      return err(400, "invalid_anchor", "批注锚点缺失或结构错误");
    }
    if (!isInt(a.paraIndex) || a.paraIndex < 0) {
      return err(400, "invalid_para_index", "段落编号必须是非负整数");
    }
    if (!isInt(a.start) || !isInt(a.end)) {
      return err(400, "invalid_range", "字符起止位置必须是整数");
    }
    if (a.start < 0 || a.end <= a.start) {
      return err(400, "empty_range", "批注范围为空：请先选中要批注的文字");
    }
    if (typeof a.quote !== "string" || !a.quote) {
      return err(400, "empty_quote", "批注引文不能为空");
    }
    var qlen = cpLen(a.quote);
    if (qlen > LIMITS.QUOTE_MAX_CHARS) {
      return err(413, "quote_too_large",
        "引文超过 " + LIMITS.QUOTE_MAX_CHARS + " 字符上限，请缩小选中范围");
    }
    if (a.end - a.start !== qlen) {
      return err(400, "range_quote_mismatch",
        "引文长度与字符起止位置不一致，请重新选择批注范围");
    }
    return {
      ok: true,
      value: {
        paraIndex: a.paraIndex,
        start: a.start,
        end: a.end,
        quote: a.quote,
        paraDir: DIRS.hasOwnProperty(a.paraDir) ? a.paraDir : "auto"
      }
    };
  }

  // 新批注载荷：{author?, body, paraIndex, start, end, quote, paraDir}
  function validateNewAnnotation(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return err(400, "invalid_body", "请求内容必须是批注对象");
    }
    var author = validateAuthor(payload.author);
    if (!author.ok) return author;
    var body = validateText(payload.body, "body");
    if (!body.ok) return body;
    var anchor = validateAnchor(payload);
    if (!anchor.ok) return anchor;
    return {
      ok: true,
      value: {
        author: author.value,
        body: body.value,
        paraIndex: anchor.value.paraIndex,
        start: anchor.value.start,
        end: anchor.value.end,
        quote: anchor.value.quote,
        paraDir: anchor.value.paraDir
      }
    };
  }

  // 回复载荷：{author?, body}
  function validateReply(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return err(400, "invalid_body", "请求内容必须是回复对象");
    }
    var author = validateAuthor(payload.author);
    if (!author.ok) return author;
    var body = validateText(payload.body, "reply");
    if (!body.ok) return body;
    return { ok: true, value: { author: author.value, body: body.value } };
  }

  /* ---------- 记录规范化（从快照恢复批注集合时逐条校验） ---------- */

  function validId(v) {
    return typeof v === "string" && v.length > 0 && v.length <= LIMITS.ID_MAX_CHARS;
  }

  // 返回 {ok:true, value:记录} 或 {ok:false, status, code, message}
  // 记录缺 id / 时间戳不合法时由调用方补齐，这里只保证结构与内容合法。
  function normalizeAnnotationRecord(rec, index) {
    var where = "第 " + (index + 1) + " 条批注";
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      return err(400, "invalid_record", where + "：结构错误");
    }
    if (rec.id != null && !validId(rec.id)) {
      return err(400, "invalid_id", where + "：id 非法");
    }
    var base = validateNewAnnotation(rec);
    if (!base.ok) {
      return err(base.status, base.code, where + "：" + base.message);
    }
    var status = STATUS.hasOwnProperty(rec.status) ? rec.status : "open";

    var replies = [];
    if (rec.replies != null) {
      if (!Array.isArray(rec.replies)) {
        return err(400, "invalid_replies", where + "：回复列表结构错误");
      }
      if (rec.replies.length > LIMITS.REPLY_MAX_COUNT) {
        return err(413, "too_many_replies",
          where + "：回复数超过 " + LIMITS.REPLY_MAX_COUNT + " 条上限");
      }
      for (var i = 0; i < rec.replies.length; i++) {
        var r = rec.replies[i];
        if (!r || typeof r !== "object") {
          return err(400, "invalid_reply", where + "：第 " + (i + 1) + " 条回复结构错误");
        }
        if (r.id != null && !validId(r.id)) {
          return err(400, "invalid_id", where + "：第 " + (i + 1) + " 条回复 id 非法");
        }
        var rv = validateReply(r);
        if (!rv.ok) {
          return err(rv.status, rv.code, where + "：第 " + (i + 1) + " 条回复" + rv.message);
        }
        replies.push({
          id: validId(r.id) ? r.id : null,
          author: rv.value.author,
          body: rv.value.body,
          createdAt: validISO(r.createdAt) ? r.createdAt : null
        });
      }
    }

    var resolvedBy = null;
    if (status === "resolved" && rec.resolvedBy != null) {
      var rb = validateAuthor(rec.resolvedBy);
      if (!rb.ok) return err(rb.status, rb.code, where + "：" + rb.message);
      resolvedBy = rb.value;
    }

    return {
      ok: true,
      value: {
        id: validId(rec.id) ? rec.id : null,
        author: base.value.author,
        body: base.value.body,
        paraIndex: base.value.paraIndex,
        start: base.value.start,
        end: base.value.end,
        quote: base.value.quote,
        paraDir: base.value.paraDir,
        status: status,
        createdAt: validISO(rec.createdAt) ? rec.createdAt : null,
        updatedAt: validISO(rec.updatedAt) ? rec.updatedAt : null,
        resolvedAt: status === "resolved" && validISO(rec.resolvedAt) ? rec.resolvedAt : null,
        resolvedBy: resolvedBy,
        replies: replies
      }
    };
  }

  /* ---------- 锚点重定位 ----------
   * 输入：批注记录 + 当前段落数组 [{text, dir, ...}]
   * 输出：
   *   {ok:true, paraIndex, start, end, moved, paraMoved} —— 仍指向原字符
   *   {ok:false, reason} —— 锚点失效（引文已不在文档中）
   *
   * 策略（全部在码点数组上进行，与视觉方向无关）：
   *   1. 原段落原位置切片仍等于引文 → 未动；
   *   2. 否则在原段落内查找引文，取离旧 start 最近的出现位置；
   *   3. 原段落找不到（整段删除/合并等）→ 全文档查找，取离原锚点最近者；
   *   4. 都找不到 → 失效。
   */
  function findOccurrences(text, quote) {
    var hits = [];
    if (!quote) return hits;
    var from = 0;
    var idx;
    while ((idx = text.indexOf(quote, from)) !== -1) {
      // indexOf 返回 UTF-16 下标，换算成码点下标
      hits.push(cpLen(text.slice(0, idx)));
      from = idx + quote.length;
    }
    return hits;
  }

  function reanchor(ann, paragraphs) {
    var quote = ann.quote;
    var qlen = cpLen(quote);
    if (!qlen) return { ok: false, reason: "empty_quote" };
    if (!Array.isArray(paragraphs)) return { ok: false, reason: "no_document" };

    var p = paragraphs[ann.paraIndex];
    if (p && typeof p.text === "string") {
      if (cpSlice(p.text, ann.start, ann.end) === quote) {
        return { ok: true, paraIndex: ann.paraIndex, start: ann.start, end: ann.end,
                 moved: false, paraMoved: false };
      }
      var hits = findOccurrences(p.text, quote);
      if (hits.length) {
        var best = hits[0];
        for (var i = 1; i < hits.length; i++) {
          if (Math.abs(hits[i] - ann.start) < Math.abs(best - ann.start)) best = hits[i];
        }
        return { ok: true, paraIndex: ann.paraIndex, start: best, end: best + qlen,
                 moved: true, paraMoved: false };
      }
    }

    // 原段落已删除或引文被移动：全文档查找
    var found = [];
    for (var j = 0; j < paragraphs.length; j++) {
      var t = paragraphs[j] && paragraphs[j].text;
      if (typeof t !== "string") continue;
      var hs = findOccurrences(t, quote);
      for (var k = 0; k < hs.length; k++) {
        found.push({ paraIndex: j, start: hs[k] });
      }
    }
    if (found.length) {
      found.sort(function (a, b) {
        var da = Math.abs(a.paraIndex - ann.paraIndex) * 1000000 + Math.abs(a.start - ann.start);
        var db = Math.abs(b.paraIndex - ann.paraIndex) * 1000000 + Math.abs(b.start - ann.start);
        return da - db;
      });
      var f = found[0];
      return { ok: true, paraIndex: f.paraIndex, start: f.start, end: f.start + qlen,
               moved: true, paraMoved: f.paraIndex !== ann.paraIndex };
    }
    return { ok: false, reason: "quote_not_found" };
  }

  /* ---------- 快照嵌入 ----------
   * 保存快照时把当前批注集合（含解决状态与回复）整体拷贝进去，
   * 之后查看该历史快照即可看到当时存在的批注及其状态。
   */
  function snapshotDigest(annotations) {
    return (annotations || []).map(function (a) {
      return {
        id: a.id,
        author: a.author,
        body: a.body,
        paraIndex: a.paraIndex,
        start: a.start,
        end: a.end,
        quote: a.quote,
        paraDir: a.paraDir,
        status: a.status,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        resolvedAt: a.resolvedAt || null,
        resolvedBy: a.resolvedBy || null,
        replies: (a.replies || []).map(function (r) {
          return { id: r.id, author: r.author, body: r.body, createdAt: r.createdAt };
        })
      };
    });
  }

  return {
    LIMITS: LIMITS,
    cpLen: cpLen,
    cpSlice: cpSlice,
    validateAuthor: validateAuthor,
    validateNewAnnotation: validateNewAnnotation,
    validateReply: validateReply,
    validateAnchor: validateAnchor,
    normalizeAnnotationRecord: normalizeAnnotationRecord,
    reanchor: reanchor,
    snapshotDigest: snapshotDigest
  };
});
