/* batches.js
 * 审阅批次 UI：新建批次（命名 + 负责人 + 截止时间 + 说明 + 勾选批注）、
 * 批次列表与实时进度、批次详情（逐条/批量设置四态、加/移成员、改名/负责人/
 * 截止/说明、归档）、按时间查看审阅记录。
 *
 * 并发模型：本地缓存批次集合版本 rev，所有批次变更带
 * If-Match: <batchRev>；成员状态变更同时推进批注 rev 与批次 rev，因此任何人
 * 改过成员状态后，旧批次页面的批量更新都会收到 409 version_conflict，
 * 绝不会覆盖较新状态。冲突时弹窗内给出明确提示并按服务端最新数据重绘，
 * 表单内容与当前页面不会被清空。
 *
 * 与 annotations.js 的协作：
 *   - 批次集合加载/变更后广播 review-batches-changed，批注列表据此显示批次徽标与筛选；
 *   - 批注模块在任意响应头中发现 X-Batch-Rev 变化时广播 review-batch-rev，
 *     本模块据此静默刷新。
 */
(function () {
  "use strict";

  var core = window.ReviewCore;
  var ReviewUI = window.ReviewUI;

  var state = {
    rev: null,
    items: [],                 // 批次摘要
    filterStatus: "",          // "" 全部 / pending / archived
    lastAnnRev: null
  };

  /* ---------- 小工具（与 annotations.js 同款约定：一律 textContent 防注入） ---------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function bdi(text) {
    var b = document.createElement("bdi");
    b.textContent = text;
    return b;
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

  function button(label, className, onClick) {
    var b = el("button", className || null);
    b.textContent = label;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function openModal(title, bodyNode, opts) {
    opts = opts || {};
    var overlay = el("div", "modal-overlay");
    var modal = el("div", "modal modal-wide");
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
    (opts.buttons || []).forEach(function (b) { foot.appendChild(b); });
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
    return { close: close, body: body, foot: foot, overlay: overlay,
             setTitle: function (t) { head.querySelector("h3").textContent = t; } };
  }

  /* ---------- 网络层 ---------- */

  function api(method, url, options) {
    options = options || {};
    var headers = { "Accept": "application/json" };
    if (options.ifMatch != null) headers["If-Match"] = String(options.ifMatch);
    var init = { method: method, headers: headers };
    if (options.body != null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      var rev = res.headers.get("X-Batch-Rev");
      var annRev = res.headers.get("X-Annotation-Rev");
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
        return {
          data: data,
          rev: rev != null ? parseInt(rev, 10) : null,
          annRev: annRev != null ? parseInt(annRev, 10) : null
        };
      });
    });
  }

  /* ---------- 列表 ---------- */

  var listBox = $("batch-list");
  var note = $("batch-note");
  var revLabel = $("batch-rev");
  var filterStatusSel = $("batch-filter-status");

  function setNote(text, isError) {
    note.textContent = text || "";
    note.className = "snap-note" + (isError ? " is-error" : "");
  }

  function loadList(silent) {
    if (!silent) setNote("正在加载审阅批次……");
    return api("GET", "/api/review-batches").then(function (r) {
      state.items = (r.data && r.data.batches) || [];
      state.rev = r.rev != null ? r.rev : (r.data && r.data.rev);
      broadcast();
      render();
      setNote("");
    }).catch(function (err) {
      setNote("无法加载审阅批次（" + err.message + "），编辑与批注功能不受影响。", true);
    });
  }

  function broadcast() {
    document.dispatchEvent(new CustomEvent(
      (ReviewUI && ReviewUI.batchEvent) || "review-batches-changed",
      { detail: { rev: state.rev, batches: state.items } }));
  }

  // 批次变更常伴随批注集合变更（成员状态/成员增减）：通知批注面板静默刷新
  function syncAnnotations(annRev) {
    if (!ReviewUI) return;
    if (annRev != null && state.lastAnnRev != null && annRev === state.lastAnnRev) return;
    if (annRev != null) state.lastAnnRev = annRev;
    ReviewUI.reload(true);
  }

  function render() {
    revLabel.textContent = "版本 " + (state.rev == null ? "—" : state.rev);
    listBox.innerHTML = "";
    var items = state.items.filter(function (b) {
      return !state.filterStatus || b.status === state.filterStatus;
    });
    if (!items.length) {
      listBox.appendChild(el("div", "review-empty",
        state.items.length
          ? "当前筛选条件下没有审阅批次。"
          : "尚无审阅批次。点击“新建审阅批次”，把一组批注组织起来并设置负责人与截止时间。"));
      return;
    }
    items.forEach(function (b) { listBox.appendChild(renderCard(b)); });
  }

  function progressBar(b) {
    var p = b.progress;
    var wrap = el("div", "batch-progress");
    var bar = el("div", "batch-progress-bar");
    var fill = el("div", "batch-progress-fill" + (p.done ? " is-done" : ""));
    fill.style.width = p.progress + "%";
    bar.appendChild(fill);
    wrap.appendChild(bar);
    var label = el("div", "batch-progress-label");
    label.setAttribute("dir", "ltr");
    label.textContent = p.resolved + "/" + p.total + " 已解决 · " + p.progress + "%";
    wrap.appendChild(label);
    return wrap;
  }

  function countChips(b) {
    var c = b.progress.counts;
    var wrap = el("div", "batch-counts");
    [["待处理", c.open, "st-open"], ["处理中", c.in_progress, "st-progress"],
     ["需复核", c.needs_review, "st-review"], ["已解决", c.resolved, "st-resolved"]]
      .forEach(function (pair) {
        var chip = el("span", "ann-status " + pair[2], pair[0] + " " + pair[1]);
        wrap.appendChild(chip);
      });
    return wrap;
  }

  function renderCard(b) {
    var card = el("div", "batch-card" + (b.status === "archived" ? " is-archived" : ""));
    card.addEventListener("click", function () { openDetail(b.id); });

    var head = el("div", "batch-card-head");
    var name = el("div", "batch-name");
    name.appendChild(bdi(b.name));
    if (b.status === "archived") name.appendChild(el("span", "batch-archived-flag", "已归档"));
    if (b.status === "pending" && b.overdue) {
      name.appendChild(el("span", "batch-overdue-flag", "已过期"));
    }
    head.appendChild(name);
    var meta = el("div", "batch-card-meta");
    meta.setAttribute("dir", "ltr");
    var dl = el("span", b.overdue ? "batch-deadline is-overdue" : "batch-deadline");
    dl.textContent = "截止 " + (b.deadline ? formatTime(b.deadline) : "未设置");
    meta.appendChild(dl);
    head.appendChild(meta);
    card.appendChild(head);

    var info = el("div", "batch-card-info");
    var owner = el("span");
    owner.appendChild(document.createTextNode("负责人："));
    owner.appendChild(bdi(b.owner || "未指派"));
    info.appendChild(owner);
    info.appendChild(el("span", "muted",
      " · " + b.memberCount + " 条批注 · 更新于 " + formatTime(b.updatedAt)));
    card.appendChild(info);

    if (b.description) {
      var d = el("div", "batch-desc");
      d.appendChild(bdi(b.description));
      card.appendChild(d);
    }

    card.appendChild(progressBar(b));
    card.appendChild(countChips(b));
    return card;
  }

  filterStatusSel.addEventListener("change", function () {
    state.filterStatus = filterStatusSel.value;
    render();
  });

  /* ---------- 新建批次 ---------- */

  function savedActor() {
    try { return localStorage.getItem("review-author") || ""; } catch (e) { return ""; }
  }

  function deadlineLocalValue(iso) {
    // ISO -> datetime-local 值（本地时区）
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function openComposer() {
    // 先拿最新批注与批次（选择项依赖它们），再弹窗
    var ready = ReviewUI ? ReviewUI.reload(true) : Promise.resolve();
    ready.then(function () {
      var anns = ReviewUI ? ReviewUI.getItems() : [];
      var box = el("div", "batch-composer");

      var errLine = el("div", "composer-error");
      errLine.setAttribute("role", "alert");

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = core.LIMITS.BATCH_NAME_MAX_CHARS;
      nameInput.className = "composer-author";
      nameInput.placeholder = "批次名称（必填，最长 " + core.LIMITS.BATCH_NAME_MAX_CHARS + " 字符）";
      box.appendChild(labeled("批次名称", nameInput));

      var ownerInput = document.createElement("input");
      ownerInput.type = "text";
      ownerInput.maxLength = core.LIMITS.AUTHOR_MAX_CHARS;
      ownerInput.className = "composer-author";
      ownerInput.placeholder = "负责人（可选，默认匿名）";
      ownerInput.value = savedActor();
      box.appendChild(labeled("负责人", ownerInput));

      var deadlineInput = document.createElement("input");
      deadlineInput.type = "datetime-local";
      deadlineInput.className = "composer-author batch-deadline-input";
      box.appendChild(labeled("截止时间（可选，必须晚于当前时间）", deadlineInput));

      var descInput = document.createElement("textarea");
      descInput.className = "composer-body";
      descInput.rows = 3;
      descInput.maxLength = core.LIMITS.BATCH_DESC_MAX_CHARS;
      descInput.placeholder = "批次说明（可选，最长 " + core.LIMITS.BATCH_DESC_MAX_CHARS + " 字符）";
      box.appendChild(labeled("说明", descInput));

      box.appendChild(el("div", "batch-pick-head",
        "选择批注（至少一条；已属于其他未归档批次或已归档批次的批注不可选）"));
      var pickTools = el("div", "batch-pick-tools");
      var selectableList = el("div", "batch-pick-list");
      var checks = [];

      function rowFor(ann, disabled, reason) {
        var row = el("label", "batch-pick-item" + (disabled ? " is-disabled" : ""));
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = ann.id;
        if (disabled) cb.disabled = true;
        row.appendChild(cb);
        var text = el("span", null);
        text.appendChild(el("span", "ann-status " + ReviewUI.statusClass(ann.status),
          ReviewUI.statusLabel(ann.status)));
        text.appendChild(document.createTextNode(" "));
        var q = el("span", "batch-pick-quote");
        q.appendChild(bdi(ann.quote));
        text.appendChild(q);
        if (reason) text.appendChild(el("span", "batch-pick-reason", reason));
        row.appendChild(text);
        checks.push({ cb: cb, id: ann.id });
        return row;
      }

      if (!anns.length) {
        selectableList.appendChild(el("div", "review-empty",
          "当前没有批注。请先在编辑器中选中文字添加批注，再来组建批次。"));
      } else {
        anns.slice().sort(function (a, b) {
          return (a.paraIndex - b.paraIndex) || a.start - b.start;
        }).forEach(function (ann) {
          var holder = ann.batchId
            ? state.items.filter(function (x) { return x.id === ann.batchId; })[0]
            : null;
          if (holder) {
            selectableList.appendChild(rowFor(ann, true,
              "（已属于批次“" + holder.name + "”" +
              (holder.status === "archived" ? "，已归档" : "") + "）"));
          } else {
            selectableList.appendChild(rowFor(ann, false, null));
          }
        });
      }

      var master = document.createElement("input");
      master.type = "checkbox";
      var masterLabel = el("label", "batch-master");
      masterLabel.appendChild(master);
      masterLabel.appendChild(document.createTextNode("全选可选批注"));
      master.addEventListener("change", function () {
        checks.forEach(function (x) { if (!x.cb.disabled) x.cb.checked = master.checked; });
      });
      pickTools.appendChild(masterLabel);
      box.appendChild(pickTools);
      box.appendChild(selectableList);
      box.appendChild(errLine);

      var cancelBtn = button("取消", null, function () { close(); });
      var okBtn = button("创建批次", "primary", function () {
        errLine.textContent = "";
        var ids = checks.filter(function (x) { return x.cb.checked; })
                       .map(function (x) { return x.id; });
        var payload = {
          name: nameInput.value,
          owner: ownerInput.value,
          description: descInput.value,
          annotationIds: ids,
          actor: ownerInput.value
        };
        if (deadlineInput.value) payload.deadline = new Date(deadlineInput.value).toISOString();

        var check = core.validateBatchPayload(payload, false);
        if (!check.ok) { showErr(check.message); return; }
        var body = Object.assign({}, check.value, { actor: ownerInput.value || undefined });
        okBtn.disabled = true;
        api("POST", "/api/review-batches", { body: body, ifMatch: state.rev })
          .then(function (r) {
            close();
            toast("审阅批次“" + check.value.name + "”已创建");
            return loadList(true).then(function () { syncAnnotations(r.annRev); });
          })
          .catch(function (err) {
            okBtn.disabled = false;
            handleBatchError(err, showErr, "创建批次");
          });
      });
      function showErr(m) { errLine.textContent = m; }

      var close = openModal("新建审阅批次", box, { buttons: [cancelBtn, okBtn] });
      nameInput.focus();
    }).catch(function () {
      toast("批注列表尚未就绪，请稍后重试", "error");
    });
  }

  function labeled(text, input) {
    var wrap = el("label", "batch-field");
    wrap.appendChild(el("span", "batch-field-label", text));
    wrap.appendChild(input);
    return wrap;
  }

  /* ---------- 批次详情 ---------- */

  function findSummary(id) {
    return state.items.filter(function (b) { return b.id === id; })[0];
  }

  function openDetail(id) {
    var summary = findSummary(id);
    var modal = openModal("审阅批次", el("div"), { buttons: [] });
    modal.setTitle("批次加载中…");

    api("GET", "/api/review-batches/" + id).then(function (r) {
      renderDetail(modal, r.data);
    }).catch(function (err) {
      modal.body.appendChild(el("div", "composer-error",
        "读取批次失败：" + err.message + "（当前页面内容未受影响）"));
      modal.foot.appendChild(button("关闭", null, function () { modal.close(); }));
    });
  }

  function detailErrorLine(modal) {
    var line = modal.overlay.querySelector(".detail-error");
    return line;
  }

  function renderDetail(modal, data) {
    var b = data.batch;
    var members = data.members;
    var frozen = b.status === "archived";
    modal.body.innerHTML = "";
    modal.foot.innerHTML = "";
    modal.setTitle((frozen ? "📦 已归档批次：" : "审阅批次：") + b.name);

    // —— 元信息 ——
    var meta = el("div", "batch-detail-meta");
    meta.setAttribute("dir", "ltr");
    function metaLine(labelText, node) {
      var line = el("div", "batch-meta-line");
      line.appendChild(el("span", "muted", labelText));
      line.appendChild(node);
      return line;
    }
    var ownerNode = el("span");
    ownerNode.appendChild(bdi(b.owner || "未指派"));
    meta.appendChild(metaLine("负责人：", ownerNode));
    var dlNode = el("span", b.overdue ? "is-overdue" : null);
    dlNode.textContent = (b.deadline ? formatTime(b.deadline) : "未设置") +
      (b.status === "pending" && b.overdue ? "（已过期）" : "");
    meta.appendChild(metaLine("截止时间：", dlNode));
    meta.appendChild(metaLine("创建：", el("span", null,
      formatTime(b.createdAt) + " · 最近更新 " + formatTime(b.updatedAt))));
    if (frozen) {
      meta.appendChild(metaLine("归档：", el("span", null,
        formatTime(b.archivedAt) + " · 由 " + (b.archivedBy || "匿名"))));
    }
    modal.body.appendChild(meta);

    if (b.description) {
      var d = el("div", "batch-desc batch-desc-detail");
      d.appendChild(bdi(b.description));
      modal.body.appendChild(d);
    }

    // —— 进度（实时计算；归档批次为冻结瞬间的状态）——
    var progWrap = el("div", "batch-detail-progress");
    var p = b.progress;
    var bar = el("div", "batch-progress-bar");
    var fill = el("div", "batch-progress-fill" + (p.done ? " is-done" : ""));
    fill.style.width = p.progress + "%";
    bar.appendChild(fill);
    progWrap.appendChild(bar);
    var pInfo = el("div", "batch-progress-label");
    pInfo.setAttribute("dir", "ltr");
    pInfo.textContent = "待处理 " + p.counts.open + " · 处理中 " + p.counts.in_progress +
      " · 需复核 " + p.counts.needs_review + " · 已解决 " + p.counts.resolved +
      "（共 " + p.total + " 条，" + p.progress + "%）";
    progWrap.appendChild(pInfo);
    if (frozen) {
      progWrap.appendChild(el("p", "muted",
        "批次已归档：以下批注状态冻结于归档时刻，不能再修改；这里展示的是完整历史。"));
    }
    modal.body.appendChild(progWrap);

    var errLine = el("div", "composer-error detail-error");
    errLine.setAttribute("role", "alert");
    modal.body.appendChild(errLine);
    function showErr(m) { errLine.textContent = m; }

    // —— 成员表 ——
    var tableWrap = el("div", "batch-members-wrap");
    var table = el("table", "batch-members");
    var thead = el("thead");
    var headRow = el("tr");
    if (!frozen) headRow.appendChild(el("th", "c-check"));
    headRow.appendChild(el("th", null, "批注"));
    headRow.appendChild(el("th", null, "段落/位置"));
    headRow.appendChild(el("th", null, "状态"));
    if (!frozen) headRow.appendChild(el("th", null, "操作"));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el("tbody");
    var rowCbs = [];
    members.forEach(function (m) {
      var tr = el("tr");
      if (!frozen) {
        var tdCheck = el("td", "c-check");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = m.id;
        tdCheck.appendChild(cb);
        tr.appendChild(tdCheck);
        rowCbs.push(cb);
      }
      var tdAnn = el("td");
      var quote = el("div", "ann-quote batch-member-quote");
      quote.appendChild(bdi(m.quote));
      tdAnn.appendChild(quote);
      var body = el("div", "ann-body-preview");
      body.appendChild(bdi(m.body));
      tdAnn.appendChild(body);
      var who = el("div", "ann-meta");
      who.setAttribute("dir", "ltr");
      who.appendChild(bdi(m.author));
      who.appendChild(document.createTextNode(" · " + formatTime(m.createdAt)));
      tdAnn.appendChild(who);
      tr.appendChild(tdAnn);

      var tdPos = el("td", "c-num");
      var pos = el("div");
      pos.setAttribute("dir", "ltr");
      pos.textContent = "段落 #" + (m.paraIndex + 1) + " [" + m.start + "–" + m.end + ")";
      tdPos.appendChild(pos);
      tr.appendChild(tdPos);

      var tdStatus = el("td");
      tdStatus.appendChild(el("span", "ann-status " + ReviewUI.statusClass(m.status),
        ReviewUI.statusLabel(m.status)));
      tr.appendChild(tdStatus);

      if (!frozen) {
        var tdAct = el("td", "batch-row-actions");
        var oneSel = document.createElement("select");
        core.ANN_STATUSES.forEach(function (s) {
          var o = el("option", null, ReviewUI.statusLabel(s));
          o.value = s;
          if (s === m.status) o.selected = true;
          oneSel.appendChild(o);
        });
        tdAct.appendChild(oneSel);
        tdAct.appendChild(button("应用", "btn-mini", function () {
          applyStatus([m.id], oneSel.value, modal, b);
        }));
        tdAct.appendChild(button("移出", "btn-mini danger", function () {
          if (!window.confirm("把这条批注移出批次“" + b.name + "”吗？移出后可加入其他批次。")) return;
          memberOp(b.id, "remove", [m.id], modal, "移出批注");
        }));
        tr.appendChild(tdAct);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    modal.body.appendChild(tableWrap);

    if (!frozen) {
      // —— 批量操作条 ——
      var bulk = el("div", "batch-bulkbar");
      var master = document.createElement("input");
      master.type = "checkbox";
      var masterLabel = el("label");
      masterLabel.appendChild(master);
      masterLabel.appendChild(document.createTextNode("全选"));
      master.addEventListener("change", function () {
        rowCbs.forEach(function (cb) { cb.checked = master.checked; });
      });
      bulk.appendChild(masterLabel);

      var bulkSel = document.createElement("select");
      core.ANN_STATUSES.forEach(function (s) {
        var o = el("option", null, "标记为：" + ReviewUI.statusLabel(s));
        o.value = s;
        bulkSel.appendChild(o);
      });
      bulk.appendChild(bulkSel);
      bulk.appendChild(button("批量更新状态", "primary", function () {
        var ids = rowCbs.filter(function (cb) { return cb.checked; })
                       .map(function (cb) { return cb.value; });
        if (!ids.length) { showErr("请先勾选要更新的批注（当前选择为空，未做任何改动）。"); return; }
        applyStatus(ids, bulkSel.value, modal, b);
      }));
      bulk.appendChild(button("移出所选", "danger", function () {
        var ids = rowCbs.filter(function (cb) { return cb.checked; })
                       .map(function (cb) { return cb.value; });
        if (!ids.length) { showErr("请先勾选要移出的批注（当前选择为空，未做任何改动）。"); return; }
        if (!window.confirm("把选中的 " + ids.length + " 条批注移出批次“" + b.name + "”吗？")) return;
        memberOp(b.id, "remove", ids, modal, "批量移出");
      }));
      bulk.appendChild(button("加入批注…", null, function () { openAddMembers(b, modal); }));
      modal.body.appendChild(bulk);

      modal.foot.appendChild(button("编辑信息…", null, function () { openEdit(b, modal); }));
      modal.foot.appendChild(button("决策草案…", null, function () {
        if (window.DecisionsUI) window.DecisionsUI.openComposerForBatch(b.id);
        else toast("决策模块未加载", "error");
      }));
      modal.foot.appendChild(button("审阅记录", null, function () { openLogs(b); }));
      modal.foot.appendChild(button("归档批次", "danger", function () {
        if (!window.confirm("归档批次“" + b.name + "”吗？\n归档后其中 " + b.memberCount +
          " 条批注的状态将永久冻结，不能再修改，但可随时查看完整历史与审阅记录。")) return;
        archiveBatch(b, modal);
      }));
    } else {
      modal.foot.appendChild(button("审阅记录", null, function () { openLogs(b); }));
    }
    modal.foot.appendChild(button("关闭", null, function () { modal.close(); }));
  }

  // 批量/逐条状态更新：服务端对“不存在/不属于本批次/已归档”的成员全部整批拒绝
  function applyStatus(ids, status, modal, b) {
    var line = detailErrorLine(modal);
    line.textContent = "";
    api("POST", "/api/review-batches/" + b.id + "/status", {
      body: { annotationIds: ids, status: status, actor: savedActor() },
      ifMatch: state.rev
    }).then(function (r) {
      if (state.rev !== r.rev) state.rev = r.rev;
      var msg = "已把 " + ids.length + " 条批注标记为“" + ReviewUI.statusLabel(status) + "”";
      if (r.data && r.data.unchanged) {
        msg += "（其中 " + r.data.unchanged + " 条原本就是该状态）";
      }
      toast(msg);
      return refreshDetail(modal, b.id).then(function () {
        return loadList(true).then(function () { syncAnnotations(r.annRev); });
      });
    }).catch(function (err) {
      handleDetailError(err, function (m) { line.textContent = m; }, modal, b.id, "批量更新状态");
    });
  }

  function memberOp(batchId, mode, ids, modal, action) {
    var line = detailErrorLine(modal);
    line.textContent = "";
    api("POST", "/api/review-batches/" + batchId + "/members", {
      body: { mode: mode, annotationIds: ids, actor: savedActor() },
      ifMatch: state.rev
    }).then(function (r) {
      if (state.rev !== r.rev) state.rev = r.rev;
      toast(action + "完成");
      return refreshDetail(modal, batchId).then(function () {
        return loadList(true).then(function () { syncAnnotations(r.annRev); });
      });
    }).catch(function (err) {
      handleDetailError(err, function (m) { line.textContent = m; }, modal, batchId, action);
    });
  }

  function refreshDetail(modal, id) {
    return api("GET", "/api/review-batches/" + id).then(function (r) {
      renderDetail(modal, r.data);
    });
  }

  /* ---------- 加入成员 ---------- */

  function openAddMembers(b, parentModal) {
    ReviewUI.reload(true).then(function () {
      var anns = ReviewUI.getItems();
      var candidates = anns.filter(function (a) { return !a.batchId; });
      var box = el("div");
      var errLine = el("div", "composer-error");
      box.appendChild(el("p", "muted",
        "只显示尚未属于任何批次的批注（同一条批注不能同时属于两个未归档批次）。"));
      var list = el("div", "batch-pick-list");
      var checks = [];
      if (!candidates.length) {
        list.appendChild(el("div", "review-empty", "没有可加入的批注：所有批注都已在批次中。"));
      }
      candidates.forEach(function (ann) {
        var row = el("label", "batch-pick-item");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = ann.id;
        row.appendChild(cb);
        var text = el("span");
        var q = el("span", "batch-pick-quote");
        q.appendChild(bdi(ann.quote));
        text.appendChild(q);
        row.appendChild(text);
        list.appendChild(row);
        checks.push(cb);
      });
      box.appendChild(list);
      box.appendChild(errLine);

      var addMembersBtn = button("加入所选", "primary", function () {
        var ids = checks.filter(function (cb) { return cb.checked; })
                        .map(function (cb) { return cb.value; });
        if (!ids.length) { errLine.textContent = "请先勾选要加入的批注（当前选择为空）。"; return; }
        addMembersBtn.disabled = true;
        api("POST", "/api/review-batches/" + b.id + "/members", {
          body: { mode: "add", annotationIds: ids, actor: savedActor() },
          ifMatch: state.rev
        }).then(function (r) {
          if (state.rev !== r.rev) state.rev = r.rev;
          m2.close();
          toast("已加入 " + ids.length + " 条批注");
          refreshDetail(parentModal, b.id);
          return loadList(true).then(function () { syncAnnotations(r.annRev); });
        }).catch(function (err) {
          addMembersBtn.disabled = false;
          handleBatchError(err, function (m) { errLine.textContent = m; }, "加入批注");
        });
      });

      var m2 = openModal("向批次加入批注", box, {
        buttons: [
          button("取消", null, function () { m2.close(); }),
          addMembersBtn
        ]
      });
    });
  }

  /* ---------- 编辑批次信息 ---------- */

  function openEdit(b, parentModal) {
    var box = el("div");
    var errLine = el("div", "composer-error");

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "composer-author";
    nameInput.maxLength = core.LIMITS.BATCH_NAME_MAX_CHARS;
    nameInput.value = b.name;
    box.appendChild(labeled("批次名称", nameInput));

    var ownerInput = document.createElement("input");
    ownerInput.type = "text";
    ownerInput.className = "composer-author";
    ownerInput.maxLength = core.LIMITS.AUTHOR_MAX_CHARS;
    ownerInput.value = b.owner || "";
    box.appendChild(labeled("负责人", ownerInput));

    var deadlineInput = document.createElement("input");
    deadlineInput.type = "datetime-local";
    deadlineInput.className = "composer-author batch-deadline-input";
    deadlineInput.value = deadlineLocalValue(b.deadline);
    box.appendChild(labeled("截止时间（留空表示不设截止；必须晚于当前时间）", deadlineInput));

    var descInput = document.createElement("textarea");
    descInput.className = "composer-body";
    descInput.rows = 3;
    descInput.maxLength = core.LIMITS.BATCH_DESC_MAX_CHARS;
    descInput.value = b.description || "";
    box.appendChild(labeled("说明", descInput));
    box.appendChild(errLine);

    var saveBtn = button("保存修改", "primary", function () {
      errLine.textContent = "";
      var payload = {
        name: nameInput.value,
        owner: ownerInput.value,
        description: descInput.value,
        actor: ownerInput.value
      };
      // 截止时间未改动就不下发（批次已过期时，保留原值不会被“不能设为过去时间”拒绝）
      var dlISO = deadlineInput.value ? new Date(deadlineInput.value).toISOString() : "";
      var origISO = b.deadline || "";
      if (dlISO !== origISO) payload.deadline = dlISO;
      var check = core.validateBatchPayload(payload, true);
      if (!check.ok) { errLine.textContent = check.message; return; }
      saveBtn.disabled = true;
      api("PUT", "/api/review-batches/" + b.id, {
        body: Object.assign({}, check.value, { actor: ownerInput.value || undefined }),
        ifMatch: state.rev
      }).then(function (r) {
        if (state.rev !== r.rev) state.rev = r.rev;
        m2.close();
        toast("批次信息已更新");
        refreshDetail(parentModal, b.id);
        return loadList(true).then(function () { syncAnnotations(r.annRev); });
      }).catch(function (err) {
        saveBtn.disabled = false;
        handleBatchError(err, function (m) { errLine.textContent = m; }, "更新批次信息");
      });
    });

    var m2 = openModal("编辑批次信息", box, {
      buttons: [
        button("取消", null, function () { m2.close(); }),
        saveBtn
      ]
    });
  }

  /* ---------- 归档 ---------- */

  function archiveBatch(b, modal) {
    var line = detailErrorLine(modal);
    line.textContent = "";
    api("POST", "/api/review-batches/" + b.id + "/archive", {
      body: { actor: savedActor() }, ifMatch: state.rev
    }).then(function (r) {
      if (state.rev !== r.rev) state.rev = r.rev;
      toast("批次已归档，成员状态已冻结");
      return refreshDetail(modal, b.id).then(function () { return loadList(true); });
    }).catch(function (err) {
      handleDetailError(err, function (m) { line.textContent = m; }, modal, b.id, "归档批次");
    });
  }

  /* ---------- 审阅记录（可按时间查看） ---------- */

  var ACTION_LABELS = {
    batch_create: "创建批次",
    batch_update: "修改批次信息",
    batch_archive: "归档批次",
    members_add: "加入批注",
    members_remove: "移出批注",
    status_change: "批注状态变化",
    members_restore_pruned: "恢复快照后自动移出"
  };

  function openLogs(b) {
    var box = el("div", "batch-logs");
    box.appendChild(el("p", "muted",
      "负责人、截止时间、说明、成员与批注状态的每一次变化都记录在案（归档后仍可查看）。"));

    var filterBar = el("div", "batch-log-filter");
    var fromInput = document.createElement("input");
    fromInput.type = "datetime-local";
    var toInput = document.createElement("input");
    toInput.type = "datetime-local";
    filterBar.appendChild(labeled("从", fromInput));
    filterBar.appendChild(labeled("到", toInput));
    var list = el("div", "batch-log-list");
    box.appendChild(filterBar);
    box.appendChild(list);

    function fetchLogs() {
      var qs = [];
      if (fromInput.value) qs.push("from=" + encodeURIComponent(new Date(fromInput.value).toISOString()));
      if (toInput.value) qs.push("to=" + encodeURIComponent(new Date(toInput.value).toISOString()));
      list.innerHTML = "";
      list.appendChild(el("div", "muted", "正在加载审阅记录……"));
      api("GET", "/api/review-batches/" + b.id + "/logs" + (qs.length ? "?" + qs.join("&") : ""))
        .then(function (r) {
          list.innerHTML = "";
          var logs = (r.data && r.data.logs) || [];
          if (!logs.length) {
            list.appendChild(el("div", "review-empty", "该时间范围内没有审阅记录。"));
            return;
          }
          logs.forEach(function (l) {
            var item = el("div", "log-item log-" + l.action);
            var h = el("div", "log-head");
            h.setAttribute("dir", "ltr");
            h.appendChild(el("span", "log-time", formatTime(l.at)));
            h.appendChild(document.createTextNode(" · "));
            h.appendChild(el("span", "log-action", ACTION_LABELS[l.action] || l.action));
            h.appendChild(document.createTextNode(" · "));
            var actor = el("span");
            actor.appendChild(bdi(l.actor || "匿名"));
            h.appendChild(actor);
            item.appendChild(h);
            if (l.detail) {
              var d = el("div", "log-detail");
              d.appendChild(bdi(l.detail));
              item.appendChild(d);
            }
            list.appendChild(item);
          });
        }).catch(function (err) {
          list.innerHTML = "";
          list.appendChild(el("div", "composer-error", "读取审阅记录失败：" + err.message));
        });
    }

    var queryBtn = button("按时间筛选", null, fetchLogs);
    var clearBtn = button("清除时间范围", null, function () {
      fromInput.value = ""; toInput.value = ""; fetchLogs();
    });
    fromInput.addEventListener("change", fetchLogs);
    toInput.addEventListener("change", fetchLogs);

    var m = openModal("审阅记录：" + b.name, box, {
      buttons: [queryBtn, clearBtn, button("关闭", null, function () { m.close(); })]
    });
    fetchLogs();
  }

  /* ---------- 错误处理 ---------- */

  function handleBatchError(err, showError, action) {
    var msg;
    if (err.status === 409 && err.code === "version_conflict") {
      msg = "版本冲突：批次集合已被其他页面更新（当前版本 " +
        ((err.data && err.data.currentRev) != null ? err.data.currentRev : "—") +
        "），本次" + action + "已被拒绝，没有覆盖任何较新内容。请按最新列表重试。";
      loadList(true);
    } else if (err.status === 428) {
      msg = "缺少版本号，请刷新批次列表后重试。";
      loadList(true);
    } else {
      msg = action + "失败：" + err.message;
    }
    showError(msg);
  }

  // 详情弹窗内的错误：冲突/冻结后用服务端最新数据重绘弹窗（不清空页面）
  function handleDetailError(err, showError, modal, batchId, action) {
    if (err.status === 409 || err.status === 428) {
      showError("版本冲突：" + err.message + " 已为你重新加载该批次的最新内容，请重试。");
      loadList(true);
      refreshDetail(modal, batchId);
    } else {
      showError(action + "失败：" + err.message);
    }
  }

  /* ---------- 绑定 ---------- */

  $("batch-add").addEventListener("click", openComposer);
  $("batch-refresh").addEventListener("click", function () { loadList(); });

  // 批注面板发现 X-Batch-Rev 变化时通知这里静默刷新（避免重复刷新抖动）
  var lastSignaledRev = null;
  document.addEventListener("review-batch-rev", function (e) {
    var rev = e.detail && e.detail.rev;
    if (rev == null || rev === lastSignaledRev || rev === state.rev) return;
    lastSignaledRev = rev;
    loadList(true);
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadList(true);
  });
  window.addEventListener("focus", function () { loadList(true); });

  window.ReviewBatchesUI = { reload: loadList };

  /* ---------- 启动 ---------- */
  loadList();
})();
