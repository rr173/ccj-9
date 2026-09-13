/* replay.js
 * 执行回放 UI（与线上批次/决策/队列完全隔离的只读视图）：
 *   - 导出：指定时间范围（+ 名称）→ 预览命中任务/事件数 → 下载审计包
 *     （POST /api/replay/export?download=1），导出只读线上数据；
 *   - 导入：选择审计包文件 → 服务端全量校验（格式/内容哈希/事件链/引用/
 *     数量上限）通过后写入空白回放空间；失败保留原因、不部分写入；
 *     同包再导幂等，同标识不同内容明确冲突；
 *   - 回放空间列表 + 详情：按时间线展示任务等待 / 审批 / 执行 / 重试事件，
 *     可按任务或事件类型筛选（筛选条件保存到服务端，重启恢复）；
 *     只显示包内锁定的历史内容，没有任何暂停/审批/执行按钮。
 */
(function () {
  "use strict";

  var Core = window.ReplayCore;
  var RC = window.ReplayReviewCore;

  var CATEGORY_LABELS = {
    wait: "等待",
    approval: "审批",
    execute: "执行",
    retry: "重试",
    config: "配置",
    cancel: "取消"
  };
  var CATEGORY_ORDER = ["wait", "approval", "config", "execute", "retry", "cancel"];
  var REVIEW_STATUS_LABELS = RC ? RC.STATUS_LABELS : {};
  var REVIEW_STATUS_ORDER = ["open", "in_review", "confirmed", "returned", "closed"];

  /* ---------- 基础工具 ---------- */

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  function bdi(text) {
    var b = document.createElement("bdi");
    b.textContent = text == null ? "—" : text;
    return b;
  }
  function button(label, className, onClick) {
    var b = el("button", className || null);
    b.textContent = label;
    if (onClick) b.addEventListener("click", onClick);
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
    }, kind === "error" ? 7000 : 3500);
  }

  function openModal(title, bodyNode, opts) {
    opts = opts || {};
    var overlay = el("div", "modal-overlay");
    var modal = el("div", "modal modal-xwide");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    var head = el("div", "modal-head");
    head.appendChild(el("h3", null, title));
    var closeBtn = el("button", "modal-close", "×");
    closeBtn.title = "关闭（不会修改任何数据）";
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
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    return { close: close, body: body, foot: foot, overlay: overlay,
             setTitle: function (t) { head.querySelector("h3").textContent = t; } };
  }

  function api(method, url, options) {
    options = options || {};
    var headers = { "Accept": "application/json" };
    if (options.ifMatch != null) headers["If-Match"] = String(options.ifMatch);
    if (options.rvVersion != null) headers["X-Review-Version"] = String(options.rvVersion);
    var init = { method: method, headers: headers };
    if (options.body != null) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      var replayRev = res.headers.get("X-Replay-Rev");
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.message) || ("请求失败：HTTP " + res.status));
          err.status = res.status;
          err.code = data && data.error;
          err.data = data;
          throw err;
        }
        return { data: data, replayRev: replayRev };
      });
    });
  }

  /* ================= 主导出/导入面板 ================= */

  var panelState = { rev: null, spaces: [] };

  function openReplayCenter() {
    var box = el("div", "replay-center");
    var modal = openModal("执行回放（审计包导出 / 导入 / 回放空间）", box, {
      buttons: [button("关闭", null, function () {})]
    });

    var exportSection = el("div", "replay-section");
    exportSection.appendChild(el("h4", null, "① 导出审计包（只读，不影响线上批次与决策）"));
    var form = el("div", "replay-export-form");

    var nameInput = el("input");
    nameInput.type = "text";
    nameInput.maxLength = 200;
    nameInput.placeholder = "审计包名称（可选，默认按时间范围命名）";
    nameInput.className = "replay-name-input";

    function dtLocal(d) {
      var p = function (n) { return String(n).padStart(2, "0"); };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
        "T" + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    var fromInput = el("input"); fromInput.type = "datetime-local"; fromInput.step = "1";
    var toInput = el("input"); toInput.type = "datetime-local"; toInput.step = "1";
    var now = new Date();
    toInput.value = dtLocal(now);
    fromInput.value = dtLocal(new Date(now.getTime() - 7 * 86400000));

    function rangeISO() {
      return {
        from: fromInput.value ? new Date(fromInput.value).toISOString() : null,
        to: toInput.value ? new Date(toInput.value).toISOString() : null
      };
    }

    var row1 = el("div", "replay-form-row");
    row1.appendChild(el("label", null, "名称 "));
    row1.appendChild(nameInput);
    var row2 = el("div", "replay-form-row");
    row2.appendChild(el("label", null, "自 "));
    row2.appendChild(fromInput);
    row2.appendChild(el("span", "replay-dash", " 至 "));
    row2.appendChild(toInput);
    row2.appendChild(button("清空时间（全部历史）", null, function () {
      fromInput.value = ""; toInput.value = "";
    }));

    var previewLine = el("div", "snap-note");
    var btnPreview = button("预览命中");
    var btnExport = button("导出并下载审计包", "primary");
    var row3 = el("div", "replay-form-row");
    row3.appendChild(btnPreview);
    row3.appendChild(btnExport);

    form.appendChild(row1);
    form.appendChild(row2);
    form.appendChild(row3);
    form.appendChild(previewLine);
    exportSection.appendChild(form);
    box.appendChild(exportSection);

    var importSection = el("div", "replay-section");
    importSection.appendChild(el("h4", null, "② 导入审计包到空白回放空间"));
    var fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    var importHint = el("div", "snap-note",
      "导入前服务端会校验格式、内容哈希与事件链顺序；缺字段、重复事件、哈希不匹配、" +
      "跨任务引用不存在或事件时间倒退都会被拒绝，且不会部分写入。");
    var btnImport = button("校验并导入", "primary");
    var irow = el("div", "replay-form-row");
    irow.appendChild(fileInput);
    irow.appendChild(btnImport);
    importSection.appendChild(irow);
    importSection.appendChild(importHint);
    box.appendChild(importSection);

    var failSection = el("div", "replay-section");
    var failHead = el("div", "replay-section-head");
    failHead.appendChild(el("h4", null, "③ 导入失败记录（保留失败原因）"));
    var btnRefreshFail = button("刷新失败记录");
    failHead.appendChild(btnRefreshFail);
    failSection.appendChild(failHead);
    var failList = el("div", "replay-fail-list");
    failSection.appendChild(failList);
    box.appendChild(failSection);

    var spacesSection = el("div", "replay-section");
    var spHead = el("div", "replay-section-head");
    spHead.appendChild(el("h4", null, "④ 回放空间（只读锁定历史）"));
    var revTag = el("span", "snap-rev replay-rev-tag", "版本 —");
    spHead.appendChild(revTag);
    var btnRefreshSpaces = button("刷新");
    spHead.appendChild(btnRefreshSpaces);
    spacesSection.appendChild(spHead);
    var spaceList = el("div", "replay-space-list");
    spacesSection.appendChild(spaceList);
    box.appendChild(spacesSection);

    /* --- 行为 --- */

    btnPreview.addEventListener("click", function () {
      var r = rangeISO();
      var q = [];
      if (r.from) q.push("from=" + encodeURIComponent(r.from));
      if (r.to) q.push("to=" + encodeURIComponent(r.to));
      previewLine.textContent = "统计中…";
      api("GET", "/api/replay/preview" + (q.length ? "?" + q.join("&") : ""))
        .then(function (r2) {
          var d = r2.data;
          previewLine.textContent = "时间范围内命中 " + d.eventCount + " 个队列事件、" +
            d.taskCount + " 个任务（含前置关联任务）。";
        })
        .catch(function (e) { previewLine.textContent = "预览失败：" + e.message; });
    });

    btnExport.addEventListener("click", function () {
      btnExport.disabled = true;
      var r = rangeISO();
      api("POST", "/api/replay/export", {
        from: r.from, to: r.to, name: nameInput.value || null, actor: "负责人"
      }).then(function (r2) {
        // 走下载接口拿附件（再次导出同样数据，包标识相同）
        return fetch("/api/replay/export?download=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: r.from, to: r.to, name: nameInput.value || null, actor: "负责人"
          })
        }).then(function (res) {
          if (!res.ok) return res.json().then(function (j) { throw new Error(j.message); });
          return res.blob().then(function (blob) {
            var pkg = r2.data;
            var fname = (pkg.packageId || "replay") + ".replay.json";
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            toast("已导出审计包：" + pkg.packageId + "（事件 " +
              pkg.manifest.eventCount + " 条，已锁定内容哈希）");
          });
        });
      }).catch(function (e) {
        toast("导出失败：" + e.message, "error");
      }).then(function () { btnExport.disabled = false; });
    });

    btnImport.addEventListener("click", function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) { toast("请先选择审计包 .json 文件", "error"); return; }
      if (file.size > 32 * 1024 * 1024) {
        toast("文件超过 32MB 请求上限", "error"); return;
      }
      btnImport.disabled = true;
      importHint.textContent = "读取并校验中…";
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || "");
        var parsed;
        try { parsed = JSON.parse(text); }
        catch (e) {
          importHint.textContent = "文件不是合法 JSON：" + e.message;
          btnImport.disabled = false;
          toast("导入失败：文件不是合法 JSON", "error");
          loadFailures(); refreshSpaces();
          return;
        }
        fetch("/api/replay/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ importedBy: "负责人" }, parsed))
        }).then(function (res) {
          return res.json().then(function (d) { return { ok: res.ok, status: res.status, d: d }; });
        }).then(function (r3) {
          btnImport.disabled = false;
          if (r3.ok) {
            if (r3.d.idempotent) {
              toast("该审计包此前已导入，幂等返回已有空间：" + r3.d.space.name);
            } else {
              toast("审计包已通过全部校验并导入回放空间：" + r3.d.space.name);
            }
            fileInput.value = "";
            importHint.textContent = "导入成功。回放内容为锁定历史，只可查看不可操作线上动作。";
            refreshSpaces();
          } else {
            var code = r3.d.error || "unknown";
            var msg = r3.d.message || ("HTTP " + r3.status);
            importHint.textContent = "导入被拒绝（" + code + "）：" + msg;
            toast("导入被拒绝：" + code, "error");
            loadFailures();
            refreshSpaces();
          }
        }).catch(function (e) {
          btnImport.disabled = false;
          importHint.textContent = "导入请求失败：" + e.message;
        });
      };
      reader.onerror = function () {
        btnImport.disabled = false;
        toast("读取文件失败", "error");
      };
      reader.readAsText(file);
    });

    btnRefreshSpaces.addEventListener("click", refreshSpaces);
    btnRefreshFail.addEventListener("click", loadFailures);

    function refreshSpaces() {
      api("GET", "/api/replay/spaces").then(function (r) {
        panelState.spaces = r.data.spaces;
        if (r.replayRev != null) {
          panelState.rev = parseInt(r.replayRev, 10);
          revTag.textContent = "版本 " + panelState.rev;
        }
        renderSpaces(spaceList, refreshSpaces);
      }).catch(function (e) { toast("加载回放空间失败：" + e.message, "error"); });
    }
    function loadFailures() {
      api("GET", "/api/replay/failures").then(function (r) {
        renderFailures(failList, r.data.failures || []);
      }).catch(function () {});
    }

    refreshSpaces();
    loadFailures();
  }

  function renderFailures(container, failures) {
    container.innerHTML = "";
    if (!failures.length) {
      container.appendChild(el("div", "replay-empty", "暂无导入失败记录。"));
      return;
    }
    failures.slice(0, 20).forEach(function (f) {
      var card = el("div", "replay-fail-card");
      var head = el("div", "replay-fail-head");
      var tag = el("span", "replay-badge replay-badge-danger", f.code);
      head.appendChild(tag);
      head.appendChild(el("span", "replay-fail-time", formatTime(f.at)));
      card.appendChild(head);
      card.appendChild(el("div", "replay-fail-msg", f.message));
      if (f.packageId) card.appendChild(el("div", "replay-fail-meta", "包标识：" + f.packageId));
      if (f.errors && f.errors.length) {
        var ul = el("ul", "replay-fail-errors");
        f.errors.slice(0, 5).forEach(function (m) { ul.appendChild(el("li", null, m)); });
        card.appendChild(ul);
      }
      container.appendChild(card);
    });
  }

  function renderSpaces(container, onChange) {
    container.innerHTML = "";
    if (!panelState.spaces.length) {
      container.appendChild(el("div", "replay-empty",
        "还没有回放空间。导出审计包后在另一环境（或此处）导入即可查看锁定历史。"));
      return;
    }
    panelState.spaces.forEach(function (sp) {
      var card = el("div", "replay-space-card");
      var head = el("div", "replay-space-head");
      head.appendChild(el("span", "replay-space-name", sp.name));
      head.appendChild(el("span", "snap-rev", "空间版本 " + sp.rev));
      card.appendChild(head);

      var meta = el("div", "replay-space-meta");
      meta.appendChild(el("span", null,
        "范围 " + formatTime(sp.range.from) + " 至 " + formatTime(sp.range.to)));
      meta.appendChild(el("span", null, "导入于 " + formatTime(sp.importedAt)));
      meta.appendChild(el("span", null,
        "任务 " + sp.counts.tasks + " · 事件 " + sp.counts.events +
        " · 执行 " + sp.counts.executions + " · 快照 " + sp.counts.snapshots));
      card.appendChild(meta);

      var hashLine = el("div", "replay-space-hash");
      hashLine.appendChild(el("span", "replay-badge", "v" + sp.packageVersion));
      hashLine.appendChild(el("code", null, sp.packageId));
      hashLine.appendChild(el("code", "replay-hash", (sp.manifest.contentHash || "").slice(0, 22) + "…"));
      card.appendChild(hashLine);

      var actions = el("div", "replay-space-actions");
      actions.appendChild(button("查看时间线", "primary", function () { openSpace(sp.id); }));
      actions.appendChild(button("删除空间", "danger", function () {
        if (!window.confirm("确定删除回放空间“" + sp.name + "”？\n" +
            "只删除这份回放副本，线上批次、决策与执行队列不受任何影响。")) return;
        api("DELETE", "/api/replay/spaces/" + sp.id).then(function () {
          toast("回放空间已删除");
          onChange();
        }).catch(function (e) { toast("删除失败：" + e.message, "error"); });
      }));
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  /* ================= 回放空间详情（时间线 + 历史证据复核） ================= */

  function openSpace(spaceId) {
    var box = el("div", "replay-space-view");
    var modal = openModal("回放空间加载中…", box, {
      buttons: [button("关闭", null, function () {})]
    });

    var header = el("div", "replay-detail-head");
    var note = el("div", "replay-locked-note",
      "🔒 以下为审计包锁定的历史内容（只读）。此处不会调用任何线上接口，" +
      "不能暂停、审批或执行。复核意见只挂在本回放空间上，不改变锁定内容。");
    var filters = el("div", "replay-filters");
    var taskSelect = el("select");
    taskSelect.appendChild(new Option("全部任务", ""));
    var catSelect = el("select");
    catSelect.appendChild(new Option("全部事件类型", ""));
    CATEGORY_ORDER.forEach(function (c) {
      catSelect.appendChild(new Option(CATEGORY_LABELS[c], c));
    });
    var actionSelect = el("select");
    actionSelect.appendChild(new Option("全部动作", ""));
    var btnApply = button("筛选");
    var btnSaveView = button("记住筛选条件");
    var spaceRevBox = el("span", "snap-rev");
    filters.appendChild(el("label", null, "任务："));
    filters.appendChild(taskSelect);
    filters.appendChild(el("label", null, "类型："));
    filters.appendChild(catSelect);
    filters.appendChild(el("label", null, "动作："));
    filters.appendChild(actionSelect);
    filters.appendChild(btnApply);
    filters.appendChild(btnSaveView);
    filters.appendChild(spaceRevBox);

    // —— 历史证据复核筛选条（状态 / 复核人 / 截止时间区间 / 引用类型） ——
    var rvFilters = el("div", "replay-rv-filters");
    var rvStatusSelect = el("select");
    rvStatusSelect.appendChild(new Option("全部复核状态", ""));
    REVIEW_STATUS_ORDER.forEach(function (s) {
      rvStatusSelect.appendChild(new Option(REVIEW_STATUS_LABELS[s], s));
    });
    var rvReviewerSelect = el("select");
    rvReviewerSelect.appendChild(new Option("全部复核人", ""));
    var rvDueFrom = el("input"); rvDueFrom.type = "datetime-local"; rvDueFrom.step = "1";
    var rvDueTo = el("input"); rvDueTo.type = "datetime-local"; rvDueTo.step = "1";
    var rvKindSelect = el("select");
    rvKindSelect.appendChild(new Option("全部引用", ""));
    rvKindSelect.appendChild(new Option("引用：时间线事件", "event"));
    rvKindSelect.appendChild(new Option("引用：逐条结果", "result"));
    var btnRvApply = button("应用复核筛选");
    var btnRvClear = button("清除复核筛选");
    var btnExportChecklist = button("⬇ 导出复核清单", "primary");
    rvFilters.appendChild(el("label", null, "复核："));
    rvFilters.appendChild(rvStatusSelect);
    rvFilters.appendChild(rvReviewerSelect);
    rvFilters.appendChild(el("label", null, "截止自"));
    rvFilters.appendChild(rvDueFrom);
    rvFilters.appendChild(el("label", null, "至"));
    rvFilters.appendChild(rvDueTo);
    rvFilters.appendChild(rvKindSelect);
    rvFilters.appendChild(btnRvApply);
    rvFilters.appendChild(btnRvClear);
    rvFilters.appendChild(btnExportChecklist);

    var summary = el("div", "replay-detail-summary");
    var rvSection = el("div", "replay-rv-section");
    var timeline = el("div", "replay-timeline");
    box.appendChild(header);
    box.appendChild(note);
    box.appendChild(filters);
    box.appendChild(rvFilters);
    box.appendChild(summary);
    box.appendChild(rvSection);
    box.appendChild(timeline);

    var view = { rev: 1, taskId: "", category: "", action: "" };
    var currentSpace = null;

    function rvQuery() {
      var q = {};
      if (rvStatusSelect.value) q.rvStatus = rvStatusSelect.value;
      if (rvReviewerSelect.value) q.rvReviewer = rvReviewerSelect.value;
      if (rvDueFrom.value) q.rvDueFrom = new Date(rvDueFrom.value).toISOString();
      if (rvDueTo.value) q.rvDueTo = new Date(rvDueTo.value).toISOString();
      if (rvKindSelect.value) q.rvTargetKind = rvKindSelect.value;
      return q;
    }
    function rvQueryString(prefix) {
      var q = rvQuery();
      return Object.keys(q).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(q[k]);
      }).join("&");
    }

    function loadDetail() {
      return api("GET", "/api/replay/spaces/" + spaceId).then(function (r) {
        var sp = r.data.space;
        currentSpace = sp;
        view.rev = sp.rev;
        spaceRevBox.textContent = "空间版本 " + sp.rev;
        modal.setTitle("回放：" + sp.name);
        header.innerHTML = "";
        var meta = el("div", "replay-detail-meta");
        meta.appendChild(el("span", null, "包 " ));
        meta.appendChild(el("code", null, sp.packageId));
        meta.appendChild(el("span", null, "　导出于 " + formatTime(sp.exportedAt)));
        meta.appendChild(el("span", null, "　导入于 " + formatTime(sp.importedAt) +
          "（" + sp.importedBy + "）"));
        header.appendChild(meta);

        var val = el("div", "replay-validation");
        val.appendChild(el("span", "replay-badge replay-badge-ok",
          "校验通过 ✓ 内容哈希 " + sp.validation.contentHash.slice(0, 20) + "…"));
        val.appendChild(el("span", "replay-badge",
          "事件链头 " + (sp.validation.chainHead || "").slice(0, 20) + "…"));
        val.appendChild(el("span", "replay-badge", "事件 " + sp.validation.eventCount));
        val.appendChild(el("span", "replay-badge",
          "复核意见 " + (sp.counts.reviews || 0) + "（未关闭 " +
          (sp.counts.openReviews || 0) + "）"));
        header.appendChild(val);

        // 任务下拉
        var prevTask = taskSelect.value;
        taskSelect.innerHTML = "";
        taskSelect.appendChild(new Option("全部任务（" + sp.counts.tasks + "）", ""));
        sp.content.tasks.forEach(function (t) {
          var label = (t.decisionName || t.id.slice(0, 8)) + " · " + t.status;
          taskSelect.appendChild(new Option(label, t.id));
        });
        taskSelect.value = prevTask;

        // 恢复已保存筛选（事件 + 复核）
        if (sp.view) {
          taskSelect.value = sp.view.taskId || "";
          catSelect.value = sp.view.category || "";
          rvStatusSelect.value = sp.view.rvStatus || "";
          rvKindSelect.value = sp.view.rvTargetKind || "";
        }
        return sp;
      });
    }

    function refreshReviewerOptions() {
      return api("GET", "/api/replay/spaces/" + spaceId + "/reviews/reviewers")
        .then(function (r) {
          var prev = rvReviewerSelect.value;
          rvReviewerSelect.innerHTML = "";
          rvReviewerSelect.appendChild(new Option("全部复核人", ""));
          (r.data.reviewers || []).forEach(function (name) {
            rvReviewerSelect.appendChild(new Option(name, name));
          });
          rvReviewerSelect.value = prev;
        }).catch(function () {});
    }

    function loadTimeline() {
      var q = [];
      if (taskSelect.value) q.push("taskId=" + encodeURIComponent(taskSelect.value));
      if (catSelect.value) q.push("category=" + encodeURIComponent(catSelect.value));
      if (actionSelect.value) q.push("action=" + encodeURIComponent(actionSelect.value));
      var rvq = rvQueryString();
      if (rvq) q.push(rvq);
      timeline.textContent = "加载时间线…";
      return api("GET", "/api/replay/spaces/" + spaceId + "/timeline" +
        (q.length ? "?" + q.join("&") : "")).then(function (r) {
        var d = r.data;
        // 动作下拉由当前数据派生
        var prevAction = actionSelect.value;
        actionSelect.innerHTML = "";
        actionSelect.appendChild(new Option("全部动作", ""));
        var actions = {};
        function collect(events) {
          events.forEach(function (e) { actions[e.action] = CATEGORY_LABELS[e.category] || e.category; });
        }
        d.timeline.forEach(function (g) { collect(g.events); });
        Object.keys(actions).sort().forEach(function (a) {
          actionSelect.appendChild(new Option(a, a));
        });
        actionSelect.value = prevAction;
        renderTimeline(timeline, d, spaceId, ui);
      });
    }

    function loadReviewsPanel() {
      var rvq = rvQueryString();
      return api("GET", "/api/replay/spaces/" + spaceId + "/reviews" +
        (rvq ? "?" + rvq : "")).then(function (r) {
        renderReviewsPanel(rvSection, r.data, function (id) { ui.openReview(id); });
      });
    }

    var ui = {
      spaceId: function () { return spaceId; },
      spaceRev: function () { return view.rev; },
      bumpSpaceRev: function (rev) {
        view.rev = rev;
        spaceRevBox.textContent = "空间版本 " + rev;
      },
      // 在指定锁定目标上新建复核意见
      addReview: function (target) { openReviewEditor(spaceId, target, ui, afterReviewChange); },
      openReview: function (id) { openReviewDetail(spaceId, id, ui, afterReviewChange); },
      reloadAll: function () { afterReviewChange(); }
    };

    function afterReviewChange() {
      // 详情先刷新（拿到最新空间 rev），再并行刷新三个视图；任何一个失败不影响其他
      return loadDetail().then(function () {
        return Promise.all([
          refreshReviewerOptions().catch(function () {}),
          loadTimeline().catch(function (e) { toast("时间线刷新失败：" + e.message, "error"); }),
          loadReviewsPanel().catch(function (e) { toast("复核列表刷新失败：" + e.message, "error"); }),
          loadConflicts().catch(function (e) { toast("冲突刷新失败：" + e.message, "error"); })
        ]);
      });
    }

    function loadConflicts() {
      var rvq = rvQueryString();
      return api("GET", "/api/replay/spaces/" + spaceId + "/conflicts" +
        (rvq ? "?" + rvq : "")).then(function (cr) {
        summary.innerHTML = "";
        var sum = cr.data.summary;
        if (sum.items && sum.items.length) {
          var cbox = el("div", "replay-conflict-box");
          cbox.appendChild(el("b", null, "冲突条目 " + sum.items.length + " 条（点击可对逐条结果复核）："));
          Object.keys(sum.counts).forEach(function (reason) {
            cbox.appendChild(el("span", "replay-badge replay-badge-danger",
              reason + " × " + sum.counts[reason]));
          });
          sum.items.forEach(function (item) {
            var row = el("div", "replay-conflict-item");
            row.appendChild(el("code", null, (item.annotationId || "").slice(0, 8)));
            row.appendChild(el("span", null, " " + item.reason));
            var addBtn = button("＋ 复核此结果", "replay-link", function () {
              ui.addReview({ kind: "result",
                executionId: item.executionId, annotationId: item.annotationId });
            });
            row.appendChild(addBtn);
            (item.reviews || []).forEach(function (m) {
              var tag = el("button", "replay-rv-mini replay-rv-status-" + m.status,
                REVIEW_STATUS_LABELS[m.status] + " · " + m.reviewer);
              tag.title = "查看复核意见 " + m.id;
              tag.addEventListener("click", function () { ui.openReview(m.id); });
              row.appendChild(tag);
            });
            cbox.appendChild(row);
          });
          summary.appendChild(cbox);
        }
      });
    }

    btnApply.addEventListener("click", function () {
      loadTimeline().catch(function (e) { toast(e.message, "error"); });
    });
    btnSaveView.addEventListener("click", function () {
      var body = {
        taskId: taskSelect.value, category: catSelect.value,
        action: actionSelect.value, annotationId: ""
      };
      var q = rvQuery();
      Object.keys(q).forEach(function (k) { body[k] = q[k]; });
      api("PUT", "/api/replay/spaces/" + spaceId + "/view", body,
        { ifMatch: view.rev }).then(function (r) {
        view.rev = r.data.spaceRev;
        spaceRevBox.textContent = "空间版本 " + view.rev;
        toast("筛选条件已保存，重启后仍恢复");
      }).catch(function (e) {
        if (e.code === "version_conflict") {
          toast("空间版本已变化，已自动刷新", "error");
          loadDetail().then(loadTimeline);
        } else toast("保存筛选失败：" + e.message, "error");
      });
    });
    btnRvApply.addEventListener("click", function () {
      Promise.all([loadTimeline(), loadReviewsPanel(), loadConflicts()])
        .catch(function (e) { toast(e.message, "error"); });
    });
    btnRvClear.addEventListener("click", function () {
      rvStatusSelect.value = ""; rvReviewerSelect.value = "";
      rvDueFrom.value = ""; rvDueTo.value = ""; rvKindSelect.value = "";
      Promise.all([loadTimeline(), loadReviewsPanel(), loadConflicts()]);
    });
    btnExportChecklist.addEventListener("click", function () {
      exportChecklist(spaceId, rvQuery());
    });

    loadDetail()
      .then(refreshReviewerOptions)
      .then(function () {
        // 恢复已保存的复核人筛选
        if (currentSpace && currentSpace.view && currentSpace.view.rvReviewer) {
          rvReviewerSelect.value = currentSpace.view.rvReviewer;
        }
        return Promise.all([loadTimeline(), loadReviewsPanel(), loadConflicts()]);
      })
      .catch(function (e) {
        timeline.textContent = "加载失败：" + e.message;
      });
  }

  /* ---------- 复核意见列表面板 ---------- */

  function renderReviewsPanel(container, data, onOpen) {
    container.innerHTML = "";
    var head = el("div", "replay-rv-head");
    var title = el("b", null, "📝 历史证据复核");
    head.appendChild(title);
    head.appendChild(el("span", "snap-note",
      "命中 " + data.count + " / 共 " + data.total + " 条（按状态/复核人/截止时间筛选）"));
    container.appendChild(head);

    if (!data.reviews.length) {
      container.appendChild(el("div", "replay-empty",
        "当前筛选下没有复核意见。可在时间线事件或冲突结果上点击“＋ 复核”添加。"));
      return;
    }
    data.reviews.forEach(function (rv) {
      var card = el("div", "replay-rv-card replay-rv-status-" + rv.status);
      var top = el("div", "replay-rv-card-top");
      top.appendChild(el("span", "replay-badge replay-rv-badge replay-rv-badge-" + rv.status,
        REVIEW_STATUS_LABELS[rv.status] || rv.status));
      top.appendChild(el("span", null, "复核人：" + rv.reviewer));
      top.appendChild(el("span", null, "截止 " + formatTime(rv.dueAt) +
        (rv.overdue ? "（已逾期）" : "")));
      top.appendChild(el("span", "snap-rev", "v" + rv.version));
      if (rv.status === "closed") {
        top.appendChild(el("span", null, "关闭于 " + formatTime(rv.closedAt)));
      }
      var targetTag = rv.target.kind === "event"
        ? "事件 " + rv.target.eventId.slice(0, 8)
        : "结果 " + rv.target.executionId.slice(0, 8) + "/" +
          (rv.target.annotationId || "").slice(0, 8);
      top.appendChild(el("code", "replay-rv-target", targetTag));
      card.appendChild(top);
      card.appendChild(el("div", "replay-rv-content", rv.content));
      if (rv.closeReason) card.appendChild(el("div", "replay-rv-close-reason",
        "关闭说明：" + rv.closeReason));
      var actions = el("div", "replay-rv-card-actions");
      actions.appendChild(button("查看/处理", "replay-link", function () {
        onOpen(rv.id);
      }));
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  function renderTimeline(container, d, spaceId, ui) {
    container.innerHTML = "";
    var total = 0;
    d.timeline.forEach(function (g) { total += g.events.length; });
    var info = el("div", "replay-timeline-info");
    info.textContent = "共 " + d.timeline.length + " 个任务分组、" + total + " 个事件（按事件链顺序）";
    container.appendChild(info);

    if (!d.timeline.length) {
      container.appendChild(el("div", "replay-empty", "当前筛选条件下没有事件。"));
      return;
    }

    d.timeline.forEach(function (g) {
      var group = el("div", "replay-tl-group");
      var t = g.task || {};
      var ghead = el("div", "replay-tl-group-head");
      ghead.appendChild(el("span", "replay-tl-task-name", t.decisionName || g.taskId.slice(0, 8)));
      ghead.appendChild(el("span", "replay-badge", "任务 " + (t.status || "未知")));
      if (t.gateState) ghead.appendChild(el("span", "replay-badge", "门控 " + t.gateState));
      if ((t.dependencyIds || []).length) {
        ghead.appendChild(el("span", "replay-badge", "前置 " + t.dependencyIds.length));
      }
      ghead.appendChild(el("span", "replay-tl-task-id", g.taskId.slice(0, 8)));
      group.appendChild(ghead);

      var ul = el("ul", "replay-tl-events");
      g.events.forEach(function (ev) {
        var li = el("li", "replay-tl-event replay-cat-" + ev.category);
        var top = el("div", "replay-tl-event-top");
        top.appendChild(el("span", "replay-tl-time", formatTime(ev.at)));
        top.appendChild(el("span", "replay-badge replay-cat-badge replay-cat-badge-" + ev.category,
          CATEGORY_LABELS[ev.category] || ev.category));
        top.appendChild(el("span", "replay-tl-action", ev.action));
        top.appendChild(el("span", "replay-tl-actor", ev.actor || "—"));
        li.appendChild(top);
        if (ev.detail) li.appendChild(el("div", "replay-tl-detail", ev.detail));
        var refs = el("div", "replay-tl-refs");
        if (ev.annotationId) refs.appendChild(el("code", null, "批注 " + ev.annotationId.slice(0, 8)));
        if (ev.executionId) refs.appendChild(el("code", null, "执行 " + ev.executionId.slice(0, 8)));
        if (ev.snapshotId) {
          var sid = ev.snapshotId;
          var snapLink = el("button", "replay-link", "快照 " + sid.slice(0, 8));
          snapLink.title = "查看审计包内锁定的快照（只读）";
          snapLink.addEventListener("click", function () { openSnapshot(spaceId, sid); });
          refs.appendChild(snapLink);
        }
        if (refs.children.length) li.appendChild(refs);

        // —— 复核标记（已应用复核筛选，可能为空） ——
        var rvLine = el("div", "replay-tl-rvs");
        (ev.reviews || []).forEach(function (m) {
          var tag = el("button", "replay-rv-mini replay-rv-status-" + m.status,
            "🔍 " + (REVIEW_STATUS_LABELS[m.status] || m.status) + " · " + m.reviewer +
            (m.closedAt ? "（已关闭）" : ""));
          tag.title = "查看复核意见 " + m.id;
          tag.addEventListener("click", function () { ui.openReview(m.id); });
          rvLine.appendChild(tag);
        });
        var addBtn = el("button", "replay-link replay-rv-add", "＋ 复核此事件");
        addBtn.title = "针对此锁定事件新增复核意见（历史内容仍只读）";
        addBtn.addEventListener("click", function () {
          ui.addReview({ kind: "event", eventId: ev.id });
        });
        rvLine.appendChild(addBtn);
        li.appendChild(rvLine);

        ul.appendChild(li);
      });
      group.appendChild(ul);
      container.appendChild(group);
    });
  }

  /* ---------- 历史证据复核：新建/详情弹窗、清单导出 ---------- */

  function dtLocalNow(offsetMs) {
    var d = new Date(Date.now() + (offsetMs || 86400000));
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function targetLabel(target) {
    return target.kind === "event"
      ? "锁定事件 " + target.eventId.slice(0, 8)
      : "锁定逐条结果 " + target.executionId.slice(0, 8) + "/" +
        (target.annotationId || "").slice(0, 8);
  }

  // 新建复核意见（目标必须为空间内锁定事件/结果，表单内可见目标摘要）
  function openReviewEditor(spaceId, target, ui, onDone) {
    var box = el("div", "replay-rv-editor");
    box.appendChild(el("div", "replay-locked-note",
      "🔒 复核引用：" + targetLabel(target) +
      "。复核意见只属于本回放空间，不会改动锁定历史，也不会调用任何线上接口。"));

    var reviewerInput = el("input");
    reviewerInput.type = "text"; reviewerInput.maxLength = 50;
    reviewerInput.placeholder = "复核人（必填，最长 50 字符）";
    var contentInput = el("textarea");
    contentInput.rows = 4; contentInput.maxLength = 2000;
    contentInput.placeholder = "复核意见（必填，最长 2000 字符）";
    var dueInput = el("input");
    dueInput.type = "datetime-local"; dueInput.step = "1";
    dueInput.value = dtLocalNow(86400000);
    var statusSelect = el("select");
    [["open", "待复核"], ["in_review", "复核中"], ["confirmed", "已确认"],
     ["returned", "已退回"]].forEach(function (p) {
      statusSelect.appendChild(new Option(p[1], p[0]));
    });
    var errBox = el("div", "replay-rv-err");

    function field(label, input) {
      var row = el("div", "replay-rv-field");
      row.appendChild(el("label", null, label));
      row.appendChild(input);
      return row;
    }
    box.appendChild(field("复核人", reviewerInput));
    box.appendChild(field("复核意见", contentInput));
    box.appendChild(field("截止时间（必填，须晚于当前）", dueInput));
    box.appendChild(field("初始状态", statusSelect));
    box.appendChild(errBox);

    var modal2;
    var btnSubmit = button("提交复核意见", "primary", function () {
      errBox.textContent = "";
      var dueVal = dueInput.value ? new Date(dueInput.value).toISOString() : null;
      btnSubmit.disabled = true;
      api("POST", "/api/replay/spaces/" + spaceId + "/reviews", {
        target: target,
        reviewer: reviewerInput.value,
        content: contentInput.value,
        dueAt: dueVal,
        status: statusSelect.value,
        actor: "负责人"
      }, { ifMatch: ui.spaceRev() }).then(function (r) {
        ui.bumpSpaceRev(r.data.spaceRev);
        toast("复核意见已添加");
        modal2.close();
        onDone();
      }).catch(function (e) {
        btnSubmit.disabled = false;
        if (e.code === "version_conflict") {
          toast("空间版本已变化，已自动刷新", "error");
          modal2.close(); ui.reloadAll();
        } else if (e.code === "duplicate_review") {
          errBox.textContent = "该事件/结果上已有未关闭的复核意见" +
            (e.data && e.data.existingReviewId ? "（" + e.data.existingReviewId.slice(0, 8) + "）" : "") +
            "，请在原意见上更新或先关闭。";
          toast("重复复核意见已被拒绝", "error");
        } else {
          errBox.textContent = "提交失败：" + e.message;
        }
      });
    });
    modal2 = openModal("新增历史证据复核", box, {
      buttons: [btnSubmit, button("取消", null, function () {})]
    });
  }

  // 复核意见详情：查看引用目标、修改内容/状态/截止、转派、关闭、状态变化记录
  function openReviewDetail(spaceId, reviewId, ui, onDone) {
    api("GET", "/api/replay/spaces/" + spaceId + "/reviews/" + reviewId).then(function (r) {
      var rv = r.data.review;
      var closed = rv.status === "closed";
      var box = el("div", "replay-rv-detail");

      var top = el("div", "replay-rv-card-top");
      top.appendChild(el("span", "replay-badge replay-rv-badge replay-rv-badge-" + rv.status,
        REVIEW_STATUS_LABELS[rv.status] || rv.status));
      top.appendChild(el("span", null, "复核人：" + rv.reviewer));
      top.appendChild(el("span", "snap-rev", "版本 v" + rv.version));
      box.appendChild(top);
      box.appendChild(el("div", "snap-note",
        "引用：" + targetLabel(rv.target) +
        (rv.target && rv.target.missing ? "（目标缺失）" : "")));

      // 引用目标快照（只读）
      if (rv.target && rv.target.kind === "event" && rv.target.event) {
        var e = rv.target.event;
        var evBox = el("div", "replay-rv-target-box");
        evBox.appendChild(el("div", null, "锁定事件（只读）"));
        evBox.appendChild(el("code", null,
          formatTime(e.at) + " · " + e.action + " · " + (e.actor || "—")));
        if (e.detail) evBox.appendChild(el("div", "replay-tl-detail", e.detail));
        box.appendChild(evBox);
      } else if (rv.target && rv.target.kind === "result" && rv.target.result) {
        var res = rv.target.result;
        var resBox = el("div", "replay-rv-target-box");
        resBox.appendChild(el("div", null, "锁定逐条结果（只读）"));
        resBox.appendChild(el("code", null,
          "批注 " + (res.annotationId || "").slice(0, 8) + " · " + res.result +
          (res.reason ? " · " + res.reason : "")));
        box.appendChild(resBox);
      }

      if (closed) {
        box.appendChild(el("div", "replay-rv-content", rv.content));
        box.appendChild(el("div", "snap-note",
          "🔒 已关闭于 " + formatTime(rv.closedAt) + "（" + (rv.closedBy || "—") + "）" +
          (rv.closeReason ? "：" + rv.closeReason : "")));
        box.appendChild(el("div", "replay-locked-note",
          "已关闭的意见为终态，不能再修改或转派（旧页面提交会被服务端拒绝）。"));
      } else {
        var contentInput = el("textarea");
        contentInput.rows = 3; contentInput.maxLength = 2000;
        contentInput.value = rv.content;
        var statusSelect = el("select");
        [["open", "待复核"], ["in_review", "复核中"], ["confirmed", "已确认"],
         ["returned", "已退回"]].forEach(function (p) {
          var o = new Option(p[1], p[0]);
          if (p[0] === rv.status) o.selected = true;
          statusSelect.appendChild(o);
        });
        var dueInput = el("input");
        dueInput.type = "datetime-local"; dueInput.step = "1";
        // datetime-local 使用本地时间
        dueInput.value = (function () {
          var d = new Date(rv.dueAt); var p = function (n) { return String(n).padStart(2, "0"); };
          return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
            "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
        })();

        var row1 = el("div", "replay-rv-field");
        row1.appendChild(el("label", null, "意见内容")); row1.appendChild(contentInput);
        var row2 = el("div", "replay-rv-field");
        row2.appendChild(el("label", null, "状态")); row2.appendChild(statusSelect);
        var row3 = el("div", "replay-rv-field");
        row3.appendChild(el("label", null, "截止时间")); row3.appendChild(dueInput);
        box.appendChild(row1); box.appendChild(row2); box.appendChild(row3);
      }

      var errBox = el("div", "replay-rv-err");
      box.appendChild(errBox);

      // 状态变化记录
      var logBox = el("div", "replay-rv-logs");
      logBox.appendChild(el("b", null, "状态变化记录"));
      api("GET", "/api/replay/spaces/" + spaceId + "/reviews/" + reviewId + "/logs")
        .then(function (lr) {
          (lr.data.logs || []).forEach(function (l) {
            var line = el("div", "replay-rv-log");
            line.appendChild(el("span", null, formatTime(l.at) + " "));
            line.appendChild(el("code", null, l.action));
            line.appendChild(el("span", null, " " + l.actor));
            if (l.to) line.appendChild(el("span", "snap-note",
              " → " + JSON.stringify(l.to)));
            logBox.appendChild(line);
          });
        }).catch(function () {});
      box.appendChild(logBox);

      var modal2;
      function handleConflict(e, action) {
        if (e.code === "review_closed") {
          errBox.textContent = "该意见已被其他页面关闭，终态不能覆盖。窗口将自动刷新。";
          toast("意见已关闭，操作被拒绝", "error");
          setTimeout(function () { modal2.close(); onDone(); }, 900);
        } else if (e.code === "review_version_conflict") {
          errBox.textContent = "意见版本已变化（当前 v" +
            (e.data && e.data.currentVersion) + "），旧表单不能覆盖。窗口将自动刷新。";
          toast("复核意见版本冲突", "error");
          setTimeout(function () {
            modal2.close();
            openReviewDetail(spaceId, reviewId, ui, onDone);
            onDone();
          }, 900);
        } else if (e.code === "version_conflict") {
          toast("空间版本已变化，已自动刷新", "error");
          modal2.close(); ui.reloadAll();
        } else {
          errBox.textContent = action + "失败：" + e.message;
        }
      }
      function versions() {
        return { ifMatch: ui.spaceRev(), rvVersion: rv.version };
      }

      var buttons = [button("关闭窗口", null, function () {})];
      if (!closed) {
        var btnSave = button("保存修改");
        btnSave.addEventListener("click", function () {
          var body = { actor: "负责人" };
          var changed = false;
          if (contentInput.value.trim() !== rv.content) {
            body.content = contentInput.value; changed = true;
          }
          if (statusSelect.value !== rv.status) {
            body.status = statusSelect.value; changed = true;
          }
          var newDue = new Date(dueInput.value).toISOString();
          if (newDue !== rv.dueAt) { body.dueAt = newDue; changed = true; }
          if (!changed) { toast("内容没有变化"); return; }
          btnSave.disabled = true;
          api("PUT", "/api/replay/spaces/" + spaceId + "/reviews/" + reviewId, body,
            { ifMatch: versions().ifMatch, rvVersion: versions().rvVersion })
            .then(function (pr) {
              ui.bumpSpaceRev(pr.data.spaceRev);
              rv.version = pr.data.review.version;
              toast(pr.data.unchanged ? "内容无变化" : "复核意见已更新");
              modal2.close(); onDone();
            }).catch(function (e) { btnSave.disabled = false; handleConflict(e, "保存"); });
        });
        var btnReassign = button("转派…");
        btnReassign.addEventListener("click", function () {
          var name = window.prompt("转派给哪位复核人？", "");
          if (name === null) return;
          api("POST",
            "/api/replay/spaces/" + spaceId + "/reviews/" + reviewId + "/reassign",
            { reviewer: name, actor: "负责人" },
            { ifMatch: ui.spaceRev(), rvVersion: rv.version })
            .then(function (pr) {
              ui.bumpSpaceRev(pr.data.spaceRev);
              toast(pr.data.unchanged ? "复核人本就是 " + pr.data.review.reviewer
                                      : "已转派给 " + pr.data.review.reviewer);
              modal2.close(); onDone();
            }).catch(function (e) { handleConflict(e, "转派"); });
        });
        var btnClose = button("关闭意见", "danger", function () {
          var reason = window.prompt("关闭说明（可留空）：", "");
          if (reason === null) return;
          api("POST",
            "/api/replay/spaces/" + spaceId + "/reviews/" + reviewId + "/close",
            { reason: reason, actor: "负责人" },
            { ifMatch: ui.spaceRev(), rvVersion: rv.version })
            .then(function (pr) {
              ui.bumpSpaceRev(pr.data.spaceRev);
              toast("复核意见已关闭（终态）");
              modal2.close(); onDone();
            }).catch(function (e) { handleConflict(e, "关闭"); });
        });
        buttons = [btnSave, btnReassign, btnClose].concat(buttons);
      }
      modal2 = openModal("复核意见 " + reviewId.slice(0, 8), box, { buttons: buttons });
    }).catch(function (e) { toast("加载复核意见失败：" + e.message, "error"); });
  }

  // 导出独立复核清单：纯只读下载；服务端不写盘、失败不改变空间
  function exportChecklist(spaceId, filters) {
    fetch("/api/replay/spaces/" + spaceId + "/reviews/export?download=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ actor: "负责人" }, filters))
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error(j.message); });
      return res.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = "review-checklist-" + spaceId.slice(0, 8) + ".json";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast("已导出独立复核清单（只读，不改变回放空间与任何意见）");
      });
    }).catch(function (e) { toast("复核清单导出失败（已有意见未被改动）：" + e.message, "error"); });
  }

  // 快照详情（包内锁定，只读）
  function openSnapshot(spaceId, sid) {
    if (!spaceId || !sid) return;
    api("GET", "/api/replay/spaces/" + spaceId + "/snapshots/" + sid)
      .then(function (r) {
        var s = r.data.snapshot;
        var box = el("div", "replay-snapshot-view");
        box.appendChild(el("div", "replay-locked-note",
          "🔒 审计包内锁定快照（只读），与线上快照完全隔离。"));
        box.appendChild(el("h4", null, s.name + "（" + formatTime(s.createdAt) + "）"));
        var meta = el("div", "replay-detail-meta");
        meta.appendChild(el("code", null, s.id));
        if (s.taskId) meta.appendChild(el("span", null, "　关联任务 " + s.taskId.slice(0, 8)));
        if (s.executionId) meta.appendChild(el("span", null, "　执行 " + s.executionId.slice(0, 8)));
        box.appendChild(meta);
        (s.paragraphs || []).forEach(function (p, i) {
          var row = el("div", "replay-snap-para");
          row.appendChild(el("span", "replay-snap-idx", "#" + i + " [" + (p.dir || "auto") + "] "));
          row.appendChild(bdi(p.text));
          box.appendChild(row);
        });
        openModal("锁定快照：" + s.name, box, { buttons: [button("关闭", null, function () {})] });
      }).catch(function (e) { toast("快照不在包内：" + e.message, "error"); });
  }

  /* ---------- 挂载入口 ---------- */

  function init() {
    var btn = $("replay-open-btn");
    if (!btn) return;
    btn.title = "导出/导入执行审计包，在只读回放空间按时间线查看等待、审批、执行与重试";
    btn.addEventListener("click", openReplayCenter);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 供外部（调试/其他面板）打开回放中心
  window.ReplayUI = { openCenter: openReplayCenter };
})();
