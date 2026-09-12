/* annotations.js
 * 协作审阅（批注）UI：创建 / 列表筛选 / 详情与回复 / 解决与重开 /
 * 锚点重定位 / 版本冲突处理 / 快照批注查看与恢复。
 *
 *
 * 并发模型：本地缓存批注集合版本 rev，所有变更（新建、回复、解决、
 * 删除、从快照恢复）都带 If-Match: <rev>；服务端发现 rev 落后即
 * 409 version_conflict —— 本地绝不覆盖别人的新批注/新回复，
 * 转而提示冲突并刷新列表；输入中的批注/回复内容保留在表单里不丢失。
 *
 * ★ 中阿混排的方向安全 ★
 *   - 锚点位置全部是 ReviewCore 按“逻辑码点顺序”算出的偏移，
 *     UI 不做任何视觉反算，RTL 段落里位置不会镜像；
 *   - 引文与回复文本一律放入 <bdi>（unicode-bidi: isolate）；
 *   - 位置标签（如 [3–8)）容器固定 dir="ltr"，数字不随阿拉伯文翻转；
 *   - 回复列表按创建时间（逻辑顺序）排列，与段落显示方向无关。
 */
(function () {
  "use strict";

  var core = window.ReviewCore;
  var Editor = window.Editor;

  var state = {
    rev: null,                 // 批注集合版本（乐观锁）
    items: [],                 // 批注记录
    anchors: Object.create(null), // id -> reanchor 结果
    filterPara: "",            // 段落筛选（"" = 全部）
    filterStatus: ""           // 状态筛选（"" = 全部）
  };

  /* ---------- 小工具 ---------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text; // 一律 textContent，防注入
    return e;
  }

  function bdi(text) {
    var b = document.createElement("bdi");
    b.textContent = text;
    return b;
  }

  function dirLabel(dir) {
    return { auto: "自动", ltr: "LTR 左→右", rtl: "RTL 右→左" }[dir] || dir;
  }

  function dirBadge(dir) {
    return el("span", "dir-badge dir-" + dir, dirLabel(dir));
  }

  function formatTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // 位置标签：固定 LTR 的半开区间写法 [start–end)
  function posLabel(start, end) {
    var s = el("span", "ann-pos");
    s.setAttribute("dir", "ltr");
    s.textContent = "[" + start + "–" + end + ")";
    return s;
  }

  function toast(message, kind) {
    var box = $("toast-box");
    var t = el("div", "toast toast-" + (kind || "info"));
    t.textContent = message;
    box.appendChild(t);
    setTimeout(function () {
      t.classList.add("toast-out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, kind === "error" ? 6000 : 3500);
  }

  /* ---------- 模态框（与 snapshots.js 同款行为：关闭绝不触碰编辑区） ---------- */

  function openModal(title, bodyNode, opts) {
    opts = opts || {};
    var overlay = el("div", "modal-overlay");
    var modal = el("div", "modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    var head = el("div", "modal-head");
    head.appendChild(el("h3", null, title));
    var closeBtn = el("button", "modal-close", "×");
    closeBtn.title = "关闭（不做任何修改）";
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = el("div", "modal-body");
    body.appendChild(bodyNode);
    modal.appendChild(body);

    var foot = el("div", "modal-foot");
    var buttons = opts.buttons || [];
    buttons.forEach(function (b) { foot.appendChild(b); });
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      if (opts.onCancel) opts.onCancel();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }

    closeBtn.addEventListener("click", close);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    if (opts.onOpen) opts.onOpen(modal, close);
    return close;
  }

  function button(label, className, onClick) {
    var b = el("button", className || null);
    b.textContent = label;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  /* ---------- 网络层：失败只提示，绝不影响编辑区与表单内容 ---------- */

  function api(method, url, options) {
    options = options || {};
    var headers = { "Accept": "application/json" };
    if (options.ifMatch != null) headers["If-Match"] = String(options.ifMatch);
    var init = { method: method, headers: headers };
    if (options.body != null) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      var rev = res.headers.get("X-Annotation-Rev");
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.message) || ("请求失败：HTTP " + res.status));
          err.status = res.status;
          err.code = data && data.error;
          err.data = data;
          err.rev = rev;
          throw err;
        }
        return { data: data, rev: rev != null ? parseInt(rev, 10) : null };
      });
    });
  }

  /* ---------- 锚点重定位 + 编辑器内高亮 ---------- */

  function reanchorAll() {
    var paras = Editor.getParagraphs();
    state.anchors = Object.create(null);
    state.items.forEach(function (ann) {
      state.anchors[ann.id] = core.reanchor(ann, paras);
    });
    updateHighlights(paras);
  }

  // CSS Custom Highlight API：不改动 contenteditable DOM 就能画出高亮，
  // 因此不会破坏光标、选区与撤销栈；不支持时静默降级（列表功能不受影响）。
  function updateHighlights() {
    if (typeof CSS === "undefined" || !CSS.highlights ||
        typeof Highlight === "undefined") return;
    var openH = new Highlight();
    var doneH = new Highlight();
    state.items.forEach(function (ann) {
      var a = state.anchors[ann.id];
      if (!a || !a.ok) return;
      var range = Editor.rangeFor(a.paraIndex, a.start, a.end);
      if (!range) return;
      (ann.status === "resolved" ? doneH : openH).add(range);
    });
    CSS.highlights.set("review-open", openH);
    CSS.highlights.set("review-resolved", doneH);
  }

  var reanchorTimer = null;
  function scheduleReanchor() {
    if (reanchorTimer) clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(function () {
      reanchorTimer = null;
      reanchorAll();
      renderList();       // 位置/失效标记随编辑实时更新
      rebuildParaFilter();// 段落下拉随段落增减更新
    }, 250);
  }

  /* ---------- 列表加载与渲染 ---------- */

  var listBox = $("review-list");
  var note = $("review-note");
  var revLabel = $("review-rev");
  var filterParaSel = $("review-filter-para");
  var filterStatusSel = $("review-filter-status");

  function setNote(text, isError) {
    note.textContent = text || "";
    note.className = "snap-note" + (isError ? " is-error" : "");
  }

  function loadList(silent) {
    if (!silent) setNote("正在加载批注……");
    return api("GET", "/api/annotations").then(function (r) {
      state.items = (r.data && r.data.annotations) || [];
      state.rev = r.rev != null ? r.rev : (r.data && r.data.rev);
      reanchorAll();
      renderAll();
      setNote("");
    }).catch(function (err) {
      setNote("无法加载批注列表（" + err.message + "），编辑功能不受影响。", true);
    });
  }

  function renderAll() {
    revLabel.textContent = "版本 " + (state.rev == null ? "—" : state.rev);
    rebuildParaFilter();
    renderList();
  }

  function rebuildParaFilter() {
    var prev = state.filterPara;
    filterParaSel.innerHTML = "";
    var all = el("option", null, "全部段落");
    all.value = "";
    filterParaSel.appendChild(all);
    var paras = Editor.getParagraphs();
    paras.forEach(function (_, i) {
      var o = el("option", null, "段落 #" + (i + 1));
      o.value = String(i);
      filterParaSel.appendChild(o);
    });
    // 之前选的段落可能已被删除，回退为全部
    filterParaSel.value = (prev !== "" && Number(prev) < paras.length) ? prev : "";
    state.filterPara = filterParaSel.value;
  }

  function anchorOf(ann) { return state.anchors[ann.id]; }

  // 用于筛选与展示的段落号：锚点有效用实时位置，失效用记录的原位置
  function displayParaIndex(ann) {
    var a = anchorOf(ann);
    return a && a.ok ? a.paraIndex : ann.paraIndex;
  }

  function renderList() {
    listBox.innerHTML = "";
    var items = state.items.filter(function (ann) {
      if (state.filterStatus && ann.status !== state.filterStatus) return false;
      if (state.filterPara !== "" &&
          displayParaIndex(ann) !== Number(state.filterPara)) return false;
      return true;
    });
    if (!items.length) {
      var empty = el("div", "review-empty",
        state.items.length ? "当前筛选条件下没有批注。"
                           : "尚无批注。在编辑器中选中一段文字，点击“对选中文字添加批注”。");
      listBox.appendChild(empty);
      return;
    }
    // 新的在前
    items.slice().sort(function (a, b) {
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    }).forEach(function (ann) {
      listBox.appendChild(renderItem(ann));
    });
  }

  function renderItem(ann) {
    var a = anchorOf(ann);
    var anchored = a && a.ok;
    var row = el("div", "ann-item" +
      (ann.status === "resolved" ? " ann-resolved" : "") +
      (anchored ? "" : " ann-orphan"));
    row.dataset.id = ann.id;

    var head = el("div", "ann-item-head");
    head.setAttribute("dir", "ltr");
    head.appendChild(el("span", "ann-para-no", "段落 #" + (displayParaIndex(ann) + 1)));
    head.appendChild(document.createTextNode(" "));
    if (anchored) head.appendChild(posLabel(a.start, a.end));
    else head.appendChild(el("span", "ann-orphan-badge", "锚点失效"));
    head.appendChild(document.createTextNode(" "));
    head.appendChild(dirBadge(ann.paraDir));
    head.appendChild(document.createTextNode(" "));
    head.appendChild(el("span",
      "ann-status " + (ann.status === "resolved" ? "st-resolved" : "st-open"),
      ann.status === "resolved" ? "已解决" : "未解决"));
    row.appendChild(head);

    var quote = el("div", "ann-quote");
    quote.appendChild(bdi(ann.quote));
    row.appendChild(quote);

    var preview = el("div", "ann-body-preview");
    preview.appendChild(bdi(ann.body));
    row.appendChild(preview);

    var meta = el("div", "ann-meta");
    meta.setAttribute("dir", "ltr");
    meta.appendChild(bdi(ann.author));
    meta.appendChild(document.createTextNode(" · " + formatTime(ann.createdAt)));
    if (ann.replies.length) {
      meta.appendChild(document.createTextNode(" · 💬 " + ann.replies.length));
    }
    if (a && a.ok && a.moved) {
      meta.appendChild(document.createTextNode(" · 位置已跟随编辑移动"));
    }
    row.appendChild(meta);

    row.addEventListener("click", function () { openDetail(ann.id); });
    return row;
  }

  filterParaSel.addEventListener("change", function () {
    state.filterPara = filterParaSel.value;
    renderList();
  });
  filterStatusSel.addEventListener("change", function () {
    state.filterStatus = filterStatusSel.value;
    renderList();
  });

  /* ---------- 新建批注 ---------- */

  function savedAuthor() {
    try { return localStorage.getItem("review-author") || ""; } catch (e) { return ""; }
  }
  function rememberAuthor(name) {
    try { localStorage.setItem("review-author", name); } catch (e) {}
  }

  function openComposer() {
    var anchor = Editor.getSelectionAnchor();
    if (!anchor) {
      toast("请先在编辑器中选中要批注的文字", "error");
      return;
    }
    if (anchor.error === "cross_paragraph") {
      toast("批注范围不能跨段落，请只在单个段落内选择文字", "error");
      return;
    }
    if (!anchor.quote || anchor.end <= anchor.start) {
      toast("批注范围为空：请先选中要批注的文字", "error");
      return;
    }

    var box = el("div", "composer");

    var info = el("div", "ann-detail-head");
    info.setAttribute("dir", "ltr");
    info.appendChild(el("span", "ann-para-no", "段落 #" + (anchor.paraIndex + 1)));
    info.appendChild(document.createTextNode(" "));
    info.appendChild(posLabel(anchor.start, anchor.end));
    info.appendChild(document.createTextNode(" "));
    info.appendChild(dirBadge(anchor.paraDir));
    box.appendChild(info);

    var quoteBox = el("div", "ann-quote ann-quote-lg");
    quoteBox.appendChild(bdi(anchor.quote));
    box.appendChild(quoteBox);

    var errLine = el("div", "composer-error");
    errLine.setAttribute("role", "alert");
    box.appendChild(errLine);

    var authorInput = document.createElement("input");
    authorInput.type = "text";
    authorInput.maxLength = core.LIMITS.AUTHOR_MAX_CHARS;
    authorInput.placeholder = "署名（可选，默认匿名）";
    authorInput.value = savedAuthor();
    authorInput.className = "composer-author";
    box.appendChild(authorInput);

    var textarea = document.createElement("textarea");
    textarea.className = "composer-body";
    textarea.rows = 4;
    textarea.placeholder = "批注内容（必填，最长 " + core.LIMITS.BODY_MAX_CHARS + " 字符）";
    box.appendChild(textarea);

    function showError(msg) { errLine.textContent = msg; }

    var cancelBtn = button("取消", null, function () { close(); });
    var okBtn = button("提交批注", "primary", function () {
      errLine.textContent = "";
      var payload = {
        author: authorInput.value,
        body: textarea.value,
        paraIndex: anchor.paraIndex,
        start: anchor.start,
        end: anchor.end,
        quote: anchor.quote,
        paraDir: anchor.paraDir
      };
      // 先本地校验：失败时表单内容原样保留
      var check = core.validateNewAnnotation(payload);
      if (!check.ok) { showError(check.message); return; }
      // 提交前再确认锚点仍然有效（用户可能又改了文本）
      var live = core.reanchor(check.value, Editor.getParagraphs());
      if (!live.ok) {
        showError("批注锚点已失效：原文“" + check.value.quote.slice(0, 40) +
          "…”刚被修改或删除。请关闭后重新选择。");
        return;
      }
      okBtn.disabled = true;
      api("POST", "/api/annotations", { body: check.value, ifMatch: state.rev })
        .then(function () {
          rememberAuthor(authorInput.value.trim());
          close();
          toast("批注已提交");
          return loadList(true);
        })
        .catch(function (err) {
          okBtn.disabled = false;
          handleMutationError(err, showError, "提交批注");
        });
    });

    var close = openModal("新建批注", box, { buttons: [cancelBtn, okBtn] });
    textarea.focus();
  }

  // 变更类请求的统一错误处理：
  // 409 → 明确提示版本冲突并刷新列表；其余 → 原样展示服务端消息。
  // showError 存在时错误显示在弹窗内（表单内容保留），否则 toast。
  function handleMutationError(err, showError, action) {
    var msg;
    if (err.status === 409 && err.code === "version_conflict") {
      msg = "版本冲突：批注集合已被其他页面更新，本次" + action +
        "已取消，没有覆盖任何新内容。列表已刷新，请重试。";
      loadList(true);
    } else if (err.status === 428) {
      msg = "缺少版本号，请刷新列表后重试。";
      loadList(true);
    } else {
      msg = action + "失败：" + err.message;
    }
    if (showError) showError(msg);
    else toast(msg, "error");
  }

  /* ---------- 批注详情：回复 / 解决 / 重开 / 定位 / 删除 ---------- */

  function findAnn(id) {
    return state.items.filter(function (a) { return a.id === id; })[0];
  }

  function openDetail(id) {
    var ann = findAnn(id);
    if (!ann) { toast("批注已不存在，正在刷新列表……", "error"); loadList(true); return; }
    var a = anchorOf(ann);
    var anchored = a && a.ok;

    var box = el("div", "ann-detail");

    var head = el("div", "ann-detail-head");
    head.setAttribute("dir", "ltr");
    head.appendChild(el("span", "ann-para-no", "段落 #" + (displayParaIndex(ann) + 1)));
    head.appendChild(document.createTextNode(" "));
    if (anchored) head.appendChild(posLabel(a.start, a.end));
    else head.appendChild(el("span", "ann-orphan-badge", "锚点失效（原位置见下）"));
    head.appendChild(document.createTextNode(" "));
    head.appendChild(dirBadge(ann.paraDir));
    head.appendChild(document.createTextNode(" "));
    head.appendChild(el("span",
      "ann-status " + (ann.status === "resolved" ? "st-resolved" : "st-open"),
      ann.status === "resolved" ? "已解决" : "未解决"));
    box.appendChild(head);

    if (!anchored) {
      var orphanNote = el("p", "ann-orphan-note");
      orphanNote.appendChild(document.createTextNode(
        "原文已被修改或删除，批注仍保留创建时的记录：段落 #" + (ann.paraIndex + 1) + " "));
      orphanNote.appendChild(posLabel(ann.start, ann.end));
      box.appendChild(orphanNote);
    }

    var quoteBox = el("div", "ann-quote ann-quote-lg");
    quoteBox.appendChild(bdi(ann.quote));
    box.appendChild(quoteBox);

    var bodyLine = el("div", "ann-detail-body");
    bodyLine.appendChild(bdi(ann.body));
    box.appendChild(bodyLine);

    var meta = el("div", "ann-meta");
    meta.setAttribute("dir", "ltr");
    meta.appendChild(bdi(ann.author));
    meta.appendChild(document.createTextNode(" 创建于 " + formatTime(ann.createdAt)));
    if (ann.status === "resolved") {
      meta.appendChild(document.createTextNode(" · 由 "));
      meta.appendChild(bdi(ann.resolvedBy || "匿名"));
      meta.appendChild(document.createTextNode(" 解决于 " + formatTime(ann.resolvedAt)));
    }
    box.appendChild(meta);

    // —— 回复列表：按创建时间（逻辑顺序）排列 ——
    var replyList = el("div", "reply-list");
    ann.replies.forEach(function (r) {
      var item = el("div", "reply-item");
      var rmeta = el("div", "ann-meta");
      rmeta.setAttribute("dir", "ltr");
      rmeta.appendChild(bdi(r.author));
      rmeta.appendChild(document.createTextNode(" · " + formatTime(r.createdAt)));
      item.appendChild(rmeta);
      var rbody = el("div", "reply-body");
      rbody.appendChild(bdi(r.body));
      item.appendChild(rbody);
      replyList.appendChild(item);
    });
    if (!ann.replies.length) {
      replyList.appendChild(el("div", "muted", "暂无回复"));
    }
    box.appendChild(replyList);

    // —— 回复表单 ——
    var errLine = el("div", "composer-error");
    errLine.setAttribute("role", "alert");
    box.appendChild(errLine);

    var authorInput = document.createElement("input");
    authorInput.type = "text";
    authorInput.maxLength = core.LIMITS.AUTHOR_MAX_CHARS;
    authorInput.placeholder = "署名（可选，默认匿名）";
    authorInput.value = savedAuthor();
    authorInput.className = "composer-author";
    box.appendChild(authorInput);

    var replyInput = document.createElement("textarea");
    replyInput.className = "composer-body";
    replyInput.rows = 2;
    replyInput.placeholder = "回复（最长 " + core.LIMITS.REPLY_MAX_CHARS + " 字符）";
    box.appendChild(replyInput);

    function showError(msg) { errLine.textContent = msg; }

    var replyBtn = button("提交回复", null, function () {
      errLine.textContent = "";
      var payload = { author: authorInput.value, body: replyInput.value };
      var check = core.validateReply(payload);
      if (!check.ok) { showError(check.message); return; } // 内容保留在表单里
      replyBtn.disabled = true;
      api("POST", "/api/annotations/" + ann.id + "/replies",
          { body: check.value, ifMatch: state.rev })
        .then(function () {
          rememberAuthor(authorInput.value.trim());
          close();
          toast("回复已提交");
          return loadList(true);
        })
        .catch(function (err) {
          replyBtn.disabled = false;
          handleMutationError(err, showError, "提交回复");
        });
    });
    box.appendChild(replyBtn);

    // —— 底部操作 ——
    var locateBtn = button("定位到原文", null, function () {
      var live = anchorOf(ann);
      if (!live || !live.ok) {
        showError("锚点已失效，无法在文档中定位（原文已被修改或删除）。");
        return;
      }
      if (!Editor.selectRange(live.paraIndex, live.start, live.end)) {
        showError("定位失败：段落已不存在。");
        return;
      }
      close();
    });
    if (!anchored) locateBtn.disabled = true;

    var toggleBtn = button(
      ann.status === "resolved" ? "重新打开" : "标记已解决",
      ann.status === "resolved" ? null : "primary",
      function () {
        errLine.textContent = "";
        toggleBtn.disabled = true;
        var next = ann.status === "resolved" ? "open" : "resolved";
        api("PUT", "/api/annotations/" + ann.id, {
          body: { status: next, resolvedBy: authorInput.value || undefined },
          ifMatch: state.rev
        }).then(function () {
          close();
          toast(next === "resolved" ? "批注已标记为已解决" : "批注已重新打开");
          return loadList(true);
        }).catch(function (err) {
          toggleBtn.disabled = false;
          handleMutationError(err, showError,
            next === "resolved" ? "标记已解决" : "重新打开");
        });
      });

    var deleteBtn = button("删除", "danger", function () {
      errLine.textContent = "";
      if (!window.confirm("确定删除这条批注及其全部回复吗？")) return;
      deleteBtn.disabled = true;
      api("DELETE", "/api/annotations/" + ann.id, { ifMatch: state.rev })
        .then(function () {
          close();
          toast("批注已删除");
          return loadList(true);
        })
        .catch(function (err) {
          deleteBtn.disabled = false;
          handleMutationError(err, showError, "删除批注");
        });
    });

    var closeBtn = button("关闭", null, function () { close(); });
    var close = openModal("批注详情", box,
      { buttons: [locateBtn, deleteBtn, toggleBtn, closeBtn] });
  }

  /* ---------- 快照批注：查看历史状态 + 恢复到当前 ---------- */

  // 由快照列表行的“批注”按钮调用（snapshots.js）
  function openSnapshotAnnotations(snapshotId, snapshotName) {
    api("GET", "/api/snapshots/" + snapshotId).then(function (r) {
      var snap = r.data;
      var anns = snap.annotations;
      var box = el("div", "snap-ann-box");

      var head = el("p", "muted");
      head.appendChild(document.createTextNode("快照 "));
      head.appendChild(bdi(snap.name));
      if (anns == null) {
        head.appendChild(document.createTextNode(
          " 创建于批注功能上线前，未记录批注数据。"));
        box.appendChild(head);
        openModal("快照批注：" + (snapshotName || snap.name), box,
          { buttons: [] });
        return;
      }
      head.appendChild(document.createTextNode(
        " 保存时共有 " + anns.length + " 条批注（批注集合版本 " +
        (snap.annotationRev == null ? "—" : snap.annotationRev) + "）。"));
      box.appendChild(head);

      var list = el("div", "snap-ann-list");
      if (!anns.length) {
        list.appendChild(el("div", "review-empty", "该快照保存时不存在批注。"));
      }
      anns.forEach(function (ann) {
        var item = el("div", "ann-item" +
          (ann.status === "resolved" ? " ann-resolved" : ""));
        var h = el("div", "ann-item-head");
        h.setAttribute("dir", "ltr");
        h.appendChild(el("span", "ann-para-no", "段落 #" + (ann.paraIndex + 1)));
        h.appendChild(document.createTextNode(" "));
        h.appendChild(posLabel(ann.start, ann.end));
        h.appendChild(document.createTextNode(" "));
        h.appendChild(dirBadge(ann.paraDir));
        h.appendChild(document.createTextNode(" "));
        h.appendChild(el("span",
          "ann-status " + (ann.status === "resolved" ? "st-resolved" : "st-open"),
          ann.status === "resolved" ? "已解决" : "未解决"));
        item.appendChild(h);
        var q = el("div", "ann-quote");
        q.appendChild(bdi(ann.quote));
        item.appendChild(q);
        var b = el("div", "ann-body-preview");
        b.appendChild(bdi(ann.body));
        item.appendChild(b);
        var m = el("div", "ann-meta");
        m.setAttribute("dir", "ltr");
        m.appendChild(bdi(ann.author));
        m.appendChild(document.createTextNode(" · " + formatTime(ann.createdAt)));
        if (ann.replies && ann.replies.length) {
          m.appendChild(document.createTextNode(" · 💬 " + ann.replies.length));
        }
        item.appendChild(m);
        list.appendChild(item);
      });
      box.appendChild(list);

      var errLine = el("div", "composer-error");
      box.appendChild(errLine);

      var closeBtn = button("关闭", null, function () { close(); });
      var restoreBtn = button("恢复这些批注到当前文档", "primary", function () {
        errLine.textContent = "";
        var msg = "将用快照中的 " + anns.length +
          " 条批注整体替换当前批注集合（含解决状态与回复）。当前未保存进该快照的批注会被移除。确定继续吗？";
        if (!window.confirm(msg)) return;
        restoreBtn.disabled = true;
        api("PUT", "/api/annotations",
            { body: { annotations: anns }, ifMatch: state.rev })
          .then(function () {
            close();
            toast("已从快照恢复 " + anns.length + " 条批注");
            return loadList(true);
          })
          .catch(function (err) {
            restoreBtn.disabled = false;
            handleMutationError(err, function (m2) { errLine.textContent = m2; },
              "恢复批注");
          });
      });

      var close = openModal("快照批注：" + (snapshotName || snap.name), box,
        { buttons: [restoreBtn, closeBtn] });
    }).catch(function (err) {
      toast("读取快照批注失败：" + err.message, "error");
    });
  }

  /* ---------- 绑定 ---------- */

  // mousedown 阻止默认行为：点击按钮不把焦点/选区从编辑器夺走，
  // 这样 openComposer 才能读到用户刚选好的文字
  $("annotation-add").addEventListener("mousedown", function (e) { e.preventDefault(); });
  $("annotation-add-panel").addEventListener("mousedown", function (e) { e.preventDefault(); });
  $("annotation-add").addEventListener("click", openComposer);
  $("annotation-add-panel").addEventListener("click", openComposer);
  $("review-refresh").addEventListener("click", function () { loadList(); });

  // 文本编辑 / 换行 / 方向切换 / 快照恢复后：重定位锚点并刷新列表位置
  Editor.subscribe(scheduleReanchor);

  // 其他页面改动后切回本页面：静默刷新，降低冲突概率
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadList(true);
  });
  window.addEventListener("focus", function () { loadList(true); });

  window.ReviewUI = {
    openSnapshotAnnotations: openSnapshotAnnotations,
    reload: loadList
  };

  /* ---------- 启动 ---------- */
  loadList();
})();
