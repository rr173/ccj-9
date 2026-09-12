/* snapshots.js
 * 审阅快照 UI：保存 / 列表 / 两两比较 / 恢复前预览二次确认 / 版本冲突处理。
 *
 * 并发模型：本地缓存集合版本 rev，所有修改（PUT 覆盖保存、DELETE）带
 * If-Match: <rev>；服务端发现 rev 落后即 409 version_conflict，本地
 * 内容绝不覆盖服务端较新数据，转而提示冲突并刷新列表。
 *
 * ★ 差异渲染的方向安全（中阿混排关键）★
 *   - 位置数字全部来自 SnapshotCore 按“逻辑码点顺序”算好的偏移，
 *     UI 不做任何视觉反算，所以 RTL 显示不会把增删位置标反；
 *   - 文本片段一律放入 <bdi>（unicode-bidi: isolate），片段之间互不串向；
 *   - 位置标签容器固定 dir="ltr"，阿拉伯数字/区间写法在 RTL 段中也不翻转。
 */
(function () {
  "use strict";

  var core = window.SnapshotCore;
  var Editor = window.Editor;

  var state = {
    rev: null,
    items: [],            // 摘要列表
    fullCache: Object.create(null), // id -> 完整快照（含 paragraphs）
    pendingAction: null   // 冲突后供用户重试的动作
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

  function formatTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
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

  /* ---------- 模态框 ---------- */

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
    var defaultClose = el("button", null, "关闭");
    var buttons = opts.buttons || [defaultClose];
    buttons.forEach(function (b) { foot.appendChild(b); });
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      // 关闭弹窗永远不会修改编辑区；只有显式确认回调才可能触发恢复
      if (opts.onCancel) opts.onCancel();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }

    closeBtn.addEventListener("click", close);
    defaultClose.addEventListener("click", close);
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
    b.addEventListener("click", onClick);
    return b;
  }

  /* ---------- 网络层：任何失败都只弹提示，不影响编辑区 ---------- */

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
      var rev = res.headers.get("X-Snapshot-Rev");
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

  /* ---------- 列表渲染 ---------- */

  var rowsBody = $("snapshot-rows");
  var note = $("snapshot-note");
  var selOld = $("compare-old");
  var selNew = $("compare-new");
  var compareBtn = $("snapshot-compare");
  var revLabel = $("snapshot-rev");

  function setNote(text, isError) {
    note.textContent = text || "";
    note.className = "snap-note" + (isError ? " is-error" : "");
  }

  function loadList(silent) {
    if (!silent) setNote("正在加载快照列表……");
    return api("GET", "/api/snapshots").then(function (r) {
      var newRev = r.rev != null ? r.rev : (r.data && r.data.rev);
      // 集合已被其他页面改动：详情缓存全部作废，避免拿旧内容比较/恢复
      if (state.rev != null && newRev != null && newRev !== state.rev) {
        state.fullCache = Object.create(null);
      }
      state.items = (r.data && r.data.snapshots) || [];
      state.rev = newRev;
      render();
      setNote("");
    }).catch(function (err) {
      setNote("无法加载快照列表（" + err.message + "），编辑功能不受影响，可继续编辑后重试。", true);
    });
  }

  function render() {
    revLabel.textContent = "版本 " + (state.rev == null ? "—" : state.rev);
    renderRows();
    renderCompareSelects();
  }

  function renderRows() {
    rowsBody.innerHTML = "";
    if (!state.items.length) {
      var tr = el("tr", "snap-empty");
      var td = el("td");
      td.colSpan = 7;
      td.textContent = "尚无快照。输入名称后点击“保存当前内容”。";
      tr.appendChild(td);
      rowsBody.appendChild(tr);
      return;
    }
    // 按更新时间倒序
    var sorted = state.items.slice().sort(function (a, b) {
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    });
    sorted.forEach(function (s) {
      var tr = el("tr");
      tr.dataset.id = s.id;

      var tdCheck = el("td", "c-check");
      var radio = document.createElement("input");
      radio.type = "checkbox";
      radio.className = "snap-pick";
      radio.dataset.id = s.id;
      radio.checked = selOld.value === s.id || selNew.value === s.id;
      tdCheck.appendChild(radio);
      tr.appendChild(tdCheck);

      var tdName = el("td", "snap-name-cell");
      tdName.appendChild(bdi(s.name));
      tr.appendChild(tdName);

      tr.appendChild(el("td", "c-num", String(s.paragraphCount)));
      tr.appendChild(el("td", "c-num", String(s.charCount)));
      // 快照保存时刻关联的批注数（未解决/总数）
      var annText = (s.annotationCount == null) ? "—"
        : (s.openAnnotationCount + "/" + s.annotationCount);
      tr.appendChild(el("td", "c-num", annText));
      tr.appendChild(el("td", "c-time", formatTime(s.updatedAt)));

      var tdAct = el("td", "snap-actions");
      tdAct.appendChild(button("覆盖保存", "btn-mini", function () { overwriteSnapshot(s); }));
      tdAct.appendChild(button("恢复…", "btn-mini", function () { beginRestore(s); }));
      tdAct.appendChild(button("批注", "btn-mini", function () {
        if (window.ReviewUI) window.ReviewUI.openSnapshotAnnotations(s.id, s.name);
      }));
      tdAct.appendChild(button("删除", "btn-mini danger", function () { deleteSnapshot(s); }));
      tr.appendChild(tdAct);
      rowsBody.appendChild(tr);
    });
  }

  function renderCompareSelects() {
    var prevOld = selOld.value, prevNew = selNew.value;
    [selOld, selNew].forEach(function (select, idx) {
      select.innerHTML = "";
      select.appendChild(el("option", null, "请选择…"));
      select.firstChild.value = "";
      state.items.forEach(function (s) {
        var o = el("option");
        o.value = s.id;
        o.textContent = s.name + "（" + formatTime(s.updatedAt) + "）";
        select.appendChild(o);
      });
    });
    selOld.value = state.items.some(function (s) { return s.id === prevOld; }) ? prevOld : "";
    selNew.value = state.items.some(function (s) { return s.id === prevNew; }) ? prevNew : "";
    updateCompareButton();
    syncRowCheckboxes();
  }

  function syncRowCheckboxes() {
    rowsBody.querySelectorAll(".snap-pick").forEach(function (cb) {
      cb.checked = cb.dataset.id === selOld.value || cb.dataset.id === selNew.value;
    });
  }

  function updateCompareButton() {
    compareBtn.disabled = !(selOld.value && selNew.value && selOld.value !== selNew.value);
  }

  // 行内复选框：按点击顺序依次作为“较旧 / 较新”，再点取消
  rowsBody.addEventListener("change", function (e) {
    var cb = e.target.closest && e.target.closest(".snap-pick");
    if (!cb) return;
    var id = cb.dataset.id;
    if (cb.checked) {
      if (!selOld.value) selOld.value = id;
      else if (!selNew.value && selOld.value !== id) selNew.value = id;
      else if (selOld.value !== id && selNew.value !== id) { selOld.value = selNew.value; selNew.value = id; }
    } else {
      if (selOld.value === id) selOld.value = "";
      if (selNew.value === id) selNew.value = "";
    }
    updateCompareButton();
    syncRowCheckboxes();
  });

  [selOld, selNew].forEach(function (s) {
    s.addEventListener("change", function () { updateCompareButton(); syncRowCheckboxes(); });
  });

  /* ---------- 保存（新建） ---------- */

  function currentName() { return $("snapshot-name").value; }

  function validateBeforeSend() {
    var nameCheck = core.validateName(currentName());
    if (!nameCheck.ok) { toast(nameCheck.message, "error"); return null; }
    var payload = Editor.serialize();
    var check = core.validateSnapshotPayload({ name: nameCheck.value, paragraphs: payload.paragraphs });
    if (!check.ok) { toast(check.message, "error"); return null; }
    return { name: check.value.name, paragraphs: check.value.paragraphs };
  }

  function saveNew() {
    var body = validateBeforeSend();
    if (!body) return;
    // 本地快速查重，权威判定仍在服务端
    if (state.items.some(function (s) { return s.name === body.name; })) {
      toast("已存在同名快照，请换一个名称，或在列表中使用“覆盖保存”。", "error");
      return;
    }
    var btn = $("snapshot-save");
    btn.disabled = true;
    api("POST", "/api/snapshots", { body: body }).then(function (r) {
      toast("快照“" + body.name + "”已保存");
      $("snapshot-name").value = "";
      state.fullCache[r.data.id] = r.data;
      return loadList(true);
    }).catch(function (err) {
      handleSaveError(err, body, null);
    }).then(function () { btn.disabled = false; });
  }

  // 覆盖保存到已有快照（PUT + If-Match 乐观锁）。
  // 名称框留空时沿用该快照原名。
  function overwriteSnapshot(summary) {
    var rawName = currentName();
    var nameToUse = rawName.trim() ? core.validateName(rawName)
      : { ok: true, value: summary.name };
    if (!nameToUse.ok) { toast(nameToUse.message, "error"); return; }
    var serialized = Editor.serialize();
    var check = core.validateSnapshotPayload({
      name: nameToUse.value, paragraphs: serialized.paragraphs
    });
    if (!check.ok) { toast(check.message, "error"); return; }
    var body = { name: check.value.name, paragraphs: check.value.paragraphs };

    api("PUT", "/api/snapshots/" + summary.id, { body: body, ifMatch: state.rev })
      .then(function (r) {
        if (r.rev != null) state.rev = r.rev; // 立即更新，避免列表刷新前的小竞态
        toast("快照“" + summary.name + "”已更新");
        state.fullCache[summary.id] = r.data;
        return loadList(true);
      })
      .catch(function (err) {
        handleSaveError(err, body, summary);
      });
  }

  function handleSaveError(err, body, summary) {
    if (err.status === 409 && err.code === "version_conflict") {
      showConflict(err, "保存", summary, function () {
        if (summary) overwriteSnapshot(summary); else saveNew();
      });
    } else if (err.status === 409 && err.code === "duplicate_name") {
      toast(err.message || "快照名称重复，请换一个名称", "error");
    } else {
      toast("保存失败：" + err.message + "（编辑内容完好，可重试）", "error");
    }
    // 任何冲突都以服务端为准刷新列表
    if (err.status === 409) loadList(true);
  }

  /* ---------- 删除 ---------- */

  function deleteSnapshot(summary) {
    var box = el("div", "confirm-box");
    box.appendChild(el("p", null, "确定删除快照 “" + summary.name + "” 吗？"));
    box.appendChild(el("p", "muted", "删除使用版本校验：若其他页面已改动过快照集合，将提示版本冲突而不会删除。"));
    var cancelBtn = button("取消", null, function () { close(); });
    var okBtn = button("确认删除", "danger", function () {
      okBtn.disabled = true;
      api("DELETE", "/api/snapshots/" + summary.id, { ifMatch: state.rev })
        .then(function () {
          close();
          delete state.fullCache[summary.id];
          toast("快照已删除");
          loadList(true);
        })
        .catch(function (err) {
          close();
          if (err.status === 409 && err.code === "version_conflict") {
            showConflict(err, "删除", summary, function () { deleteSnapshot(summary); });
          } else {
            toast("删除失败：" + err.message, "error");
          }
          if (err.status === 409) loadList(true);
        });
    });
    var close = openModal("删除快照", box, { buttons: [cancelBtn, okBtn] });
  }

  /* ---------- 版本冲突提示 ---------- */

  function showConflict(err, action, summary, retry) {
    var box = el("div", "conflict-box");
    box.appendChild(el("p", "conflict-title", "⚠ 版本冲突"));
    box.appendChild(el("p", null,
      (summary ? "快照“" + summary.name + "”" : "快照集合") +
      " 已被其他页面或其他人更新。本次" + action + "已被拒绝，" +
      "较旧页面的内容没有覆盖任何新数据。"));
    box.appendChild(el("p", "muted",
      "服务端当前版本：" + ((err.data && err.data.currentRev) != null ? err.data.currentRev : "—") +
      "；本地版本：" + state.rev + "。列表已自动刷新。"));
    var retryBtn = button("我已了解，用最新列表重试" + action, "primary", function () {
      close();
      retry();
    });
    var close = openModal("操作被拒绝：版本冲突", box,
      { buttons: [button("关闭", null, function () { close(); }), retryBtn] });
  }

  /* ---------- 取完整快照（带缓存） ---------- */

  function fetchFull(id) {
    if (state.fullCache[id]) return Promise.resolve(state.fullCache[id]);
    return api("GET", "/api/snapshots/" + id).then(function (r) {
      state.fullCache[id] = r.data;
      return r.data;
    });
  }

  /* ---------- 比较两个快照 ---------- */

  compareBtn.addEventListener("click", function () {
    var oldId = selOld.value, newId = selNew.value;
    if (!oldId || !newId || oldId === newId) return;
    compareBtn.disabled = true;
    Promise.all([fetchFull(oldId), fetchFull(newId)]).then(function (pair) {
      openDiffModal(pair[0], pair[1]);
    }).catch(function (err) {
      toast("读取快照失败：" + err.message, "error");
    }).then(function () { compareBtn.disabled = false; });
  });

  function posLabel(seg) {
    // 位置标签固定 LTR；区间为半开 [start,end)，均为逻辑码点偏移
    var s = el("span", "diff-pos");
    s.setAttribute("dir", "ltr");
    if (seg.type === "ins") {
      s.textContent = "[新 " + seg.newStart + "–" + seg.newEnd + "] ";
    } else if (seg.type === "del") {
      s.textContent = "[旧 " + seg.oldStart + "–" + seg.oldEnd + "] ";
    }
    return s;
  }

  function renderChars(container, segs) {
    var line = el("div", "diff-chars");
    line.setAttribute("dir", "ltr"); // 片段排列按逻辑顺序，片段内部各自隔离
    segs.forEach(function (seg) {
      if (seg.type === "equal") {
        line.appendChild(bdi(seg.text));
      } else {
        var wrap = el("span", "seg seg-" + seg.type);
        wrap.appendChild(posLabel(seg));
        wrap.appendChild(bdi(seg.text));
        line.appendChild(wrap);
      }
    });
    return container.appendChild(line);
  }

  function dirBadge(dir) {
    var b = el("span", "dir-badge dir-" + dir, dirLabel(dir));
    return b;
  }

  function paraMeta(p) {
    var m = el("div", "para-meta");
    m.setAttribute("dir", "ltr");
    m.appendChild(dirBadge(p.dir));
    var t = el("span", "muted", "编辑于 " + formatTime(p.editedAt));
    m.appendChild(t);
    return m;
  }

  function openDiffModal(oldSnap, newSnap) {
    var result = core.diffSnapshots(oldSnap, newSnap);
    var box = el("div", "diff-box");

    var head = el("div", "diff-head");
    head.setAttribute("dir", "ltr");
    head.appendChild(el("span", "diff-tag tag-old", "较旧："));
    var oldN = el("span", "diff-snapname"); oldN.appendChild(bdi(oldSnap.name));
    head.appendChild(oldN);
    head.appendChild(el("span", "muted", " " + formatTime(oldSnap.updatedAt)));
    head.appendChild(el("br"));
    head.appendChild(el("span", "diff-tag tag-new", "较新："));
    var newN = el("span", "diff-snapname"); newN.appendChild(bdi(newSnap.name));
    head.appendChild(newN);
    head.appendChild(el("span", "muted", " " + formatTime(newSnap.updatedAt)));
    box.appendChild(head);

    var st = result.stats;
    var summary = el("p", "diff-summary");
    summary.setAttribute("dir", "ltr");
    summary.textContent =
      "段落：未变 " + st.same + " · 修改 " + st.changed +
      " · 删除 " + st.removed + " · 新增 " + st.added +
      "　字符：新增 " + st.insertedChars + " · 删除 " + st.deletedChars;
    box.appendChild(summary);

    var legend = el("p", "diff-legend");
    legend.setAttribute("dir", "ltr");
    var li1 = el("span", "seg seg-ins legend-sample"); li1.appendChild(bdi("新增"));
    var li2 = el("span", "seg seg-del legend-sample"); li2.appendChild(bdi("删除"));
    legend.appendChild(li1);
    legend.appendChild(document.createTextNode(" "));
    legend.appendChild(li2);
    legend.appendChild(document.createTextNode(" 位置为逻辑字符偏移（半开区间，从 0 计），与 RTL 视觉方向无关。"));
    box.appendChild(legend);

    var scroll = el("div", "diff-scroll");
    result.rows.forEach(function (row) {
      var d = el("div", "diff-row row-" + row.kind);
      var h = el("div", "diff-row-head");
      h.setAttribute("dir", "ltr");
      if (row.kind === "same") {
        h.textContent = "段落 旧#" + row.aNo + " / 新#" + row.bNo + " · 未变";
      } else if (row.kind === "changed") {
        h.textContent = "段落 旧#" + row.aNo + " → 新#" + row.bNo + " · 修改";
      } else if (row.kind === "removed") {
        h.textContent = "段落 旧#" + row.aNo + " · 整段删除";
      } else {
        h.textContent = "段落 新#" + row.bNo + " · 整段新增";
      }
      d.appendChild(h);

      if (row.kind === "same") {
        var pre = el("div", "para-text para-same");
        pre.appendChild(bdi(row.a.text));
        d.appendChild(pre);
      } else if (row.kind === "removed") {
        d.appendChild(paraMeta(row.a));
        var del = el("div", "para-text para-removed");
        del.appendChild(posLabel({ type: "del", oldStart: 0, oldEnd: core.cpLen(row.a.text) }));
        del.appendChild(bdi(row.a.text));
        d.appendChild(del);
      } else if (row.kind === "added") {
        d.appendChild(paraMeta(row.b));
        var add = el("div", "para-text para-added");
        add.appendChild(posLabel({ type: "ins", newStart: 0, newEnd: core.cpLen(row.b.text) }));
        add.appendChild(bdi(row.b.text));
        d.appendChild(add);
      } else {
        var meta = el("div", "para-meta");
        meta.setAttribute("dir", "ltr");
        var od = dirBadge(row.a.dir), nd = dirBadge(row.b.dir);
        meta.appendChild(od);
        meta.appendChild(document.createTextNode(" → "));
        meta.appendChild(nd);
        if (row.dirChanged) meta.appendChild(el("span", "dir-changed", " 方向已改变"));
        d.appendChild(meta);
        if (row.chars.length) renderChars(d, row.chars);
        else {
          var same = el("div", "para-text para-same");
          same.appendChild(bdi(row.a.text));
          d.appendChild(same);
        }
      }
      scroll.appendChild(d);
    });
    box.appendChild(scroll);

    var closeDiff = openModal("快照比较", box,
      { buttons: [button("关闭", null, function () { closeDiff(); })] });
  }

  /* ---------- 恢复：先预览将被覆盖的内容，再二次确认 ---------- */

  function beginRestore(summary) {
    fetchFull(summary.id).then(function (snap) {
      openRestorePreview(summary, snap);
    }).catch(function (err) {
      toast("读取快照失败：" + err.message, "error");
    });
  }

  // 用核心对齐逻辑生成“当前编辑区 vs 快照”的逐段预览
  function buildPreview(snap) {
    var current = Editor.serialize();
    // 借用段落对齐（方向差异在 changed 行内单独标）
    var fakeOld = { name: "current", paragraphs: current.paragraphs };
    var fakeNew = { name: snap.name, paragraphs: snap.paragraphs };
    var diff = core.diffSnapshots(fakeOld, fakeNew);

    var box = el("div", "restore-box");
    box.appendChild(el("p", "restore-warn",
      "恢复会用快照逐段覆盖当前编辑区：包括每段文本、段落方向（dir）和段落编辑时间。" +
      "请逐段核对后勾选确认；取消或关闭本窗口，编辑区不会发生任何变化。"));

    var st = diff.stats;
    var summaryLine = el("p", "diff-summary");
    summaryLine.setAttribute("dir", "ltr");
    summaryLine.textContent =
      "影响：修改 " + st.changed + " 段 · 删除 " + st.removed +
      " 段 · 新增 " + st.added + " 段；未变 " + st.same + " 段。";
    box.appendChild(summaryLine);

    var table = el("table", "restore-table");
    var thead = el("thead");
    var hr = el("tr");
    ["段落", "当前编辑区（将被覆盖）", "快照恢复后"].forEach(function (h, i) {
      var th = el("th", i === 0 ? "c-idx" : null, h);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    var affected = 0;
    diff.rows.forEach(function (row) {
      var tr = el("tr", "rp-" + row.kind);
      var idxTd = el("td", "c-idx");
      idxTd.setAttribute("dir", "ltr");
      if (row.kind === "same") idxTd.textContent = "#" + row.aNo;
      else if (row.kind === "removed") idxTd.textContent = "旧#" + row.aNo;
      else if (row.kind === "added") idxTd.textContent = "新#" + row.bNo;
      else idxTd.textContent = "#" + row.aNo + "→" + row.bNo;
      tr.appendChild(idxTd);

      function cellOf(kind, p) {
        var td = el("td", "rp-cell rp-" + kind);
        var m = el("div", "para-meta");
        m.setAttribute("dir", "ltr");
        if (p) m.appendChild(dirBadge(p.dir));
        else m.appendChild(el("span", "muted", "—"));
        td.appendChild(m);
        var txt = el("div", "para-text");
        if (p) txt.appendChild(bdi(p.text || "（空段落）"));
        else txt.appendChild(el("span", "muted", "—"));
        td.appendChild(txt);
        return td;
      }

      if (row.kind === "same") {
        tr.appendChild(cellOf("same", row.a));
        tr.appendChild(cellOf("same", row.b));
      } else if (row.kind === "changed") {
        affected++;
        tr.appendChild(cellOf("old", row.a));
        tr.appendChild(cellOf("new", row.b));
      } else if (row.kind === "removed") {
        affected++;
        tr.appendChild(cellOf("old", row.a));
        var tdEmpty = el("td", "rp-cell rp-gone");
        var goneMeta = el("div", "para-meta");
        goneMeta.setAttribute("dir", "ltr");
        goneMeta.appendChild(el("span", "muted", "整段删除"));
        tdEmpty.appendChild(goneMeta);
        tdEmpty.appendChild(el("div", "para-text muted", "—"));
        tr.appendChild(tdEmpty);
      } else {
        affected++;
        var tdGap = el("td", "rp-cell rp-gone");
        var gapMeta = el("div", "para-meta");
        gapMeta.setAttribute("dir", "ltr");
        gapMeta.appendChild(el("span", "muted", "新增段落"));
        tdGap.appendChild(gapMeta);
        tr.appendChild(tdGap);
        tr.appendChild(cellOf("new", row.b));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var scroll = el("div", "diff-scroll");
    scroll.appendChild(table);
    box.appendChild(scroll);
    return { box: box, affected: affected };
  }

  function openRestorePreview(summary, snap) {
    var built = buildPreview(snap);

    var agree = document.createElement("input");
    agree.type = "checkbox";
    agree.id = "restore-agree";
    var agreeLabel = el("label", "restore-agree");
    agreeLabel.setAttribute("for", "restore-agree");
    agreeLabel.appendChild(agree);
    agreeLabel.appendChild(document.createTextNode(
      "我已逐段核对，确认用快照覆盖当前编辑区（文本、方向与编辑时间）"));
    built.box.appendChild(agreeLabel);

    var cancelBtn = button("取消", null, function () { close(); });
    var okBtn = button("确认恢复", "primary");
    okBtn.disabled = true;
    agree.addEventListener("change", function () { okBtn.disabled = !agree.checked; });

    var restored = false;
    okBtn.addEventListener("click", function () {
      if (!agree.checked || restored) return;
      // Editor.restore 内部先整体校验，通过后才动 DOM
      var r = Editor.restore({ paragraphs: snap.paragraphs });
      if (!r.ok) { toast("恢复失败：" + r.message, "error"); return; }
      restored = true;
      close();
      toast("已恢复快照“" + snap.name + "”，共 " + r.paragraphCount + " 段；光标位于首段开头");
      // 状态栏与光标已在 Editor.restore 内同步，这里再兜底刷新一次
      Editor.updateStatus();
    });

    var close = openModal("恢复预览：" + snap.name, built.box,
      { buttons: [cancelBtn, okBtn], onCancel: function () {
        // 取消：编辑区从未被触碰（恢复只在确认回调里执行）
      }});
  }

  /* ---------- 绑定顶部按钮 ---------- */

  $("snapshot-save").addEventListener("click", saveNew);
  $("snapshot-save-quick").addEventListener("click", function () {
    var nameInput = $("snapshot-name");
    if (!currentName().trim()) {
      // 快捷保存：默认名称 = 时间戳，仍然保证非空且唯一
      var d = new Date();
      var p = function (n) { return String(n).padStart(2, "0"); };
      nameInput.value = "快照 " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" +
        p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      nameInput.focus();
      toast("已按当前时间生成快照名称，点击“保存当前内容”确认（可改名）", "info");
      nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    saveNew();
  });
  $("snapshot-refresh").addEventListener("click", function () { loadList(); });
  $("snapshot-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); saveNew(); }
  });

  // 其他页面改动后切回本页面：静默刷新，降低冲突概率
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadList(true);
  });
  window.addEventListener("focus", function () { loadList(true); });

  /* ---------- 启动 ---------- */
  loadList();
})();
