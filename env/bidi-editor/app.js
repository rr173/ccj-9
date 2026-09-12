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

  /* ---------- 结构规整：保证每个段落都是 div.para[dir] ---------- */
  function normalize() {
    // 裸文本节点包进段落
    Array.prototype.slice.call(editor.childNodes).forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.length) {
        var p = makePara("auto", "");
        editor.replaceChild(p, node);
        p.appendChild(node);
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
      } else if (el.tagName !== "DIV") {
        // 浏览器偶尔产生 <p>/<br> 等，统一换成 div.para
        var p = makePara("auto", "");
        while (el.firstChild) p.appendChild(el.firstChild);
        editor.replaceChild(p, el);
      }
    });
    // 永远保留至少一个可落光标的段落
    if (!editor.children.length) editor.appendChild(makePara("auto", ""));
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
    blocks.forEach(function (b) { b.setAttribute("dir", dir); });
    updateStatus();
    editor.focus();
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
    editor.appendChild(makePara("auto", ""));
    editor.focus();
    updateStatus();
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

  editor.addEventListener("input", function () { normalize(); updateStatus(); });
  document.addEventListener("selectionchange", function () {
    if (document.activeElement === editor) updateStatus();
  });

  /* ---------- 启动 ---------- */
  loadSamples();
  updateStatus();
})();
