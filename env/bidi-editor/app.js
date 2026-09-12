/* 双向文本编辑器
 *
 * 设计原则：光标移动、选区删除、插入位置、折行后的光标附着，
 * 全部交给浏览器原生的双向文本引擎（UAX #9 + 原生 caret/selection）。
 * 本文件只负责：段落方向管理、纯文本粘贴、状态栏显示。
 */
(function () {
  "use strict";

  var editor = document.getElementById("editor");

  /* ---------- 初始示例内容：同段中阿混排 ---------- */
  var SAMPLES = [
    { dir: "auto", text: "中文与阿拉伯文混排：我喜欢学习 العربية 语言，每天练习。" },
    { dir: "auto", text: "أنا أحب 学习中文 واللغة العربية معاً في سطر واحد." },
    { dir: "ltr",  text: "强制左到右段落：价格是 ٣٥٠ 元，ممتاز!" },
    { dir: "rtl",  text: "فقرة عربية كاملة مع كلمة 中文 في المنتصف." }
  ];

  function makePara(dir, text) {
    var p = document.createElement("div");
    p.className = "para";
    p.setAttribute("dir", dir);
    p.textContent = text;
    return p;
  }

  function loadSamples() {
    editor.innerHTML = "";
    SAMPLES.forEach(function (s) { editor.appendChild(makePara(s.dir, s.text)); });
  }

  /* ---------- 段落编辑时间 ----------
   * 每段记录最后编辑时刻（ISO 字符串，存 data-edited-at）。
   * 改方向也算编辑；快照会随文本、方向一起保存它。
   * 用 WeakMap 缓存上一次文本，避免每次 input 都全量重算。
   */
  var textCache = new WeakMap();

  function stampBlock(block, time) {
    block.setAttribute("data-edited-at", time || new Date().toISOString());
  }

  function stampEdited(block) {
    if (!block) return;
    var now = new Date().toISOString();
    stampBlock(block, now);
    textCache.set(block, block.textContent);
  }

  function blockFromEventTarget(target) {
    var node = target && target.nodeType ? target : null;
    if (!node) return null;
    return blockOf(node);
  }

  /* ---------- 结构规整：保证每个段落都是 div.para[dir] ---------- */
  function normalize() {
    // 裸文本节点包进段落
    Array.prototype.slice.call(editor.childNodes).forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.length) {
        var p = makePara("auto", "");
        editor.replaceChild(p, node);
        p.appendChild(node);
        stampBlock(p);
      } else if (node.nodeType === Node.TEXT_NODE) {
        editor.removeChild(node);
      }
    });
    // 回车新产生的块：补上 class 与 dir（继承上一段方向，体验更顺）
    Array.prototype.forEach.call(editor.children, function (el) {
      if (el.tagName === "DIV" && !el.classList.contains("para")) {
        el.classList.add("para");
        if (!el.getAttribute("dir")) {
          var prev = el.previousElementSibling;
          el.setAttribute("dir", prev ? prev.getAttribute("dir") || "auto" : "auto");
        }
        if (!el.getAttribute("data-edited-at")) stampBlock(el);
      } else if (el.tagName !== "DIV") {
        // 浏览器偶尔产生 <p>/<br> 等，统一换成 div.para
        var p = makePara("auto", "");
        while (el.firstChild) p.appendChild(el.firstChild);
        editor.replaceChild(p, el);
        stampBlock(p);
      }
    });
    // 永远保留至少一个可落光标的段落
    if (!editor.children.length) {
      var empty = makePara("auto", "");
      editor.appendChild(empty);
      stampBlock(empty);
    }
  }

  /* ---------- 选区工具 ---------- */
  function getSelection() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    return sel;
  }

  function blockOf(node) {
    while (node && node.parentNode !== editor) node = node.parentNode;
    return node && node.nodeType === Node.ELEMENT_NODE ? node : null;
  }

  function blocksInSelection() {
    var sel = getSelection();
    if (!sel) return [];
    var range = sel.getRangeAt(0);
    var blocks = [];
    Array.prototype.forEach.call(editor.children, function (el) {
      if (range.intersectsNode(el)) blocks.push(el);
    });
    return blocks;
  }

  /* ---------- 段落方向 ---------- */
  function setDir(dir) {
    normalize();
    var blocks = blocksInSelection();
    if (!blocks.length) {
      var sel = getSelection();
      var b = sel && blockOf(sel.anchorNode);
      blocks = b ? [b] : [editor.children[0]];
    }
    blocks.forEach(function (b) {
      b.setAttribute("dir", dir);
      stampEdited(b); // 改方向也是一次编辑
    });
    updateStatus();
    emitChange(); // 方向切换不改变文本，但批注面板要刷新段落方向显示
    editor.focus();
  }

  /* ---------- 变更订阅：批注模块据此重定位锚点 ---------- */
  var changeListeners = [];
  function subscribe(fn) { changeListeners.push(fn); }
  function emitChange() {
    changeListeners.forEach(function (f) {
      try { f(); } catch (e) { /* 监听器异常不影响编辑 */ }
    });
  }

  /* ---------- 状态栏 ---------- */
  var stBlock = document.getElementById("st-block");
  var stDir = document.getElementById("st-dir");
  var stPos = document.getElementById("st-pos");
  var stSel = document.getElementById("st-sel");

  function logicalOffset(block, node, offset) {
    // 计算 (node, offset) 在 block 内拼接文本中的逻辑偏移
    var total = 0;
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + offset;
      total += n.textContent.length;
    }
    return total; // 落在非文本节点上时退化为块尾
  }

  function updateStatus() {
    var sel = getSelection();
    if (!sel || !editor.contains(sel.anchorNode)) {
      stBlock.textContent = "段落: —";
      stDir.textContent = "基准方向: —";
      stPos.textContent = "逻辑偏移: —";
      stSel.textContent = "选区: 0 字符";
      markActiveDir(null);
      return;
    }
    var block = blockOf(sel.anchorNode);
    var idx = Array.prototype.indexOf.call(editor.children, block);
    var resolved = block ? getComputedStyle(block).direction : "—";
    var declared = block ? block.getAttribute("dir") : "—";

    stBlock.textContent = "段落: #" + (idx + 1) + "（dir=" + declared + "）";
    stDir.textContent = "基准方向: " + (resolved === "rtl" ? "从右到左" : "从左到右");
    stPos.textContent = block
      ? "逻辑偏移: " + logicalOffset(block, sel.anchorNode, sel.anchorOffset) +
        " / " + block.textContent.length
      : "逻辑偏移: —";
    stSel.textContent = "选区: " + sel.toString().length + " 字符";
    markActiveDir(declared);
  }

  function markActiveDir(dir) {
    document.querySelectorAll(".toolbar button[data-dir]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-dir") === dir);
    });
  }

  /* ---------- 在光标处插入文本（保留撤销栈） ---------- */
  function insertTextAtCaret(text) {
    editor.focus();
    // execCommand 虽已废弃，但仍是唯一能把插入并入原生撤销栈的接口
    if (!document.execCommand("insertText", false, text)) {
      var sel = getSelection();
      if (!sel) return;
      var range = sel.getRangeAt(0);
      range.deleteContents();
      var node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    normalize();
    updateStatus();
  }

  /* ---------- 事件 ---------- */
  document.querySelectorAll(".toolbar button[data-dir]").forEach(function (btn) {
    btn.addEventListener("click", function () { setDir(btn.getAttribute("data-dir")); });
  });

  document.getElementById("insert-zh").addEventListener("click", function () {
    insertTextAtCaret("中文示例文本");
  });
  document.getElementById("insert-ar").addEventListener("click", function () {
    insertTextAtCaret("نص عربي تجريبي");
  });
  document.getElementById("clear").addEventListener("click", function () {
    editor.innerHTML = "";
    var p = makePara("auto", "");
    editor.appendChild(p);
    stampEdited(p);
    editor.focus();
    updateStatus();
    emitChange();
  });

  // 快捷键：Ctrl/Cmd+Shift+A/L/R
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    var map = { A: "auto", L: "ltr", R: "rtl" };
    var dir = map[e.key.toUpperCase()];
    if (dir) { e.preventDefault(); setDir(dir); }
  });

  // 粘贴一律按纯文本处理，避免带入会破坏段落结构的 HTML
  editor.addEventListener("paste", function (e) {
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData("text/plain");
    insertTextAtCaret(text.replace(/\r\n?/g, "\n"));
  });

  editor.addEventListener("input", function (e) {
    normalize();
    // 只更新真正发生文本变化的段落；跨段输入（如回车）覆盖涉及的块
    var blocks = [];
    var hit = blockFromEventTarget(e.target);
    if (hit) blocks.push(hit);
    blocksInSelection().forEach(function (b) { if (blocks.indexOf(b) === -1) blocks.push(b); });
    blocks.forEach(function (b) {
      var text = b.textContent;
      if (textCache.get(b) !== text) {
        stampBlock(b);
        textCache.set(b, text);
      }
    });
    updateStatus();
    emitChange(); // 文本/结构变化：批注锚点需要重定位
  });
  document.addEventListener("selectionchange", function () {
    if (document.activeElement === editor) updateStatus();
  });

  /* ---------- 对外 API：供 snapshots.js / annotations.js 调用 ---------- */

  // 码点（逻辑字符）工具：与 snapshot-core / review-core 的计数方式一致，
  // 完全不读屏幕布局，RTL 段落下位置依然按内存顺序计算。
  function cpOf(s) { return Array.from(s); }

  // (node, offset) 在 block 拼接文本中的码点逻辑偏移
  function logicalCpOffset(block, node, offset) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // offset 是子节点下标：累加其前面所有子节点的文本
      var sum = 0;
      for (var i = 0; i < offset && i < node.childNodes.length; i++) {
        sum += cpOf(node.childNodes[i].textContent).length;
      }
      return sum;
    }
    var total = 0;
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = walker.nextNode())) {
      if (n === node) {
        return total + cpOf(n.textContent.slice(0, offset)).length;
      }
      total += cpOf(n.textContent).length;
    }
    return total;
  }

  // 码点偏移 → DOM (文本节点, UTF-16 偏移)
  function locateCp(block, cpIndex) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var n, remain = cpIndex;
    while ((n = walker.nextNode())) {
      var cps = cpOf(n.textContent);
      if (remain <= cps.length) {
        var u16 = 0;
        for (var i = 0; i < remain; i++) u16 += cps[i].length;
        return { node: n, offset: u16 };
      }
      remain -= cps.length;
    }
    return { node: block, offset: block.childNodes.length };
  }

  // 当前段落数组：[{dir, text, el}]
  function getParagraphs() {
    normalize();
    return Array.prototype.map.call(editor.children, function (el) {
      return { dir: el.getAttribute("dir") || "auto", text: el.textContent, el: el };
    });
  }

  // 把当前选区读成批注锚点（码点逻辑位置）。
  // 返回 {paraIndex, start, end, quote, paraDir}；
  // 选区不在编辑器内返回 null；跨段落返回 {error:"cross_paragraph"}。
  function getSelectionAnchor() {
    var sel = getSelection();
    if (!sel || !editor.contains(sel.anchorNode) || !editor.contains(sel.focusNode)) {
      return null;
    }
    var b1 = blockOf(sel.anchorNode);
    var b2 = blockOf(sel.focusNode);
    if (!b1) return null; // 落点不在任何段落内：视为无有效选区
    if (b1 !== b2) return { error: "cross_paragraph" };
    var range = sel.getRangeAt(0);
    var start = logicalCpOffset(b1, range.startContainer, range.startOffset);
    var end = logicalCpOffset(b1, range.endContainer, range.endOffset);
    if (end < start) { var t = start; start = end; end = t; }
    var idx = Array.prototype.indexOf.call(editor.children, b1);
    var quote = cpOf(b1.textContent).slice(start, end).join("");
    return {
      paraIndex: idx,
      start: start,
      end: end,
      quote: quote,
      paraDir: b1.getAttribute("dir") || "auto"
    };
  }

  // 由码点逻辑范围构造 DOM Range（不改动当前选区）
  function rangeFor(paraIndex, start, end) {
    var block = editor.children[paraIndex];
    if (!block) return null;
    var len = cpOf(block.textContent).length;
    start = Math.max(0, Math.min(start, len));
    end = Math.max(start, Math.min(end, len));
    var s = locateCp(block, start);
    var e = locateCp(block, end);
    var range = document.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  }

  // 把选区移动到指定段落的码点逻辑范围（批注“定位到原文”）
  function selectRange(paraIndex, start, end) {
    var range = rangeFor(paraIndex, start, end);
    if (!range) return false;
    var block = editor.children[paraIndex];
    editor.focus();
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (block && block.scrollIntoView) {
      block.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    updateStatus();
    return true;
  }

  // 序列化为快照载荷：{name? , paragraphs:[{dir,text,editedAt}]}
  function serialize() {
    normalize();
    var paragraphs = [];
    Array.prototype.forEach.call(editor.children, function (el) {
      var dir = el.getAttribute("dir") || "auto";
      paragraphs.push({
        dir: dir,
        text: el.textContent,
        editedAt: el.getAttribute("data-edited-at") || new Date().toISOString()
      });
      textCache.set(el, el.textContent);
    });
    return { paragraphs: paragraphs };
  }

  function setCaretAtFirstBlockStart() {
    var block = editor.children[0];
    var range = document.createRange();
    // 直接定位到块首（空块/复杂内联节点都成立）
    range.setStart(block, 0);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 用快照内容整体替换编辑区。
  // 返回 {ok:true, paragraphCount} 或 {ok:false, message}。
  // ★ 校验不通过时绝不触碰 DOM，取消确认走的是根本不调用本函数，
  //   因此“取消时编辑区不能变化”在两层都有保证。
  function restore(payload) {
    if (window.SnapshotCore) {
      var check = window.SnapshotCore.validateSnapshotPayload(
        Object.assign({ name: "restore-check" }, payload));
      if (!check.ok) return { ok: false, message: check.message };
    } else if (!payload || !Array.isArray(payload.paragraphs) || !payload.paragraphs.length) {
      return { ok: false, message: "快照内容无效" };
    }

    var frag = document.createDocumentFragment();
    payload.paragraphs.forEach(function (p) {
      frag.appendChild(makePara(p.dir, p.text));
      var b = frag.lastChild;
      stampBlock(b, p.editedAt);
    });
    editor.innerHTML = "";
    editor.appendChild(frag);
    normalize();
    Array.prototype.forEach.call(editor.children, function (el) {
      textCache.set(el, el.textContent);
    });

    // 光标同步到恢复结果：第一块开头（确定且可预期的位置）
    editor.focus();
    setCaretAtFirstBlockStart();
    updateStatus();
    emitChange(); // 恢复后批注锚点需要按新文本重定位
    return { ok: true, paragraphCount: editor.children.length };
  }

  window.Editor = {
    serialize: serialize,
    restore: restore,
    focus: function () { editor.focus(); },
    updateStatus: updateStatus,
    // —— 协作审阅（annotations.js）使用的锚点接口 ——
    getParagraphs: getParagraphs,
    getSelectionAnchor: getSelectionAnchor,
    rangeFor: rangeFor,
    selectRange: selectRange,
    subscribe: subscribe,
    cpLen: function (s) { return cpOf(s).length; }
  };

  /* ---------- 启动 ---------- */
  loadSamples();
  normalize();
  var bootTime = new Date().toISOString();
  Array.prototype.forEach.call(editor.children, function (el) {
    stampBlock(el, bootTime);
    textCache.set(el, el.textContent);
  });
  updateStatus();
})();
