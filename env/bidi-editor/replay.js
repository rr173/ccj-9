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

  var CATEGORY_LABELS = {
    wait: "等待",
    approval: "审批",
    execute: "执行",
    retry: "重试",
    config: "配置",
    cancel: "取消"
  };
  var CATEGORY_ORDER = ["wait", "approval", "config", "execute", "retry", "cancel"];

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

  /* ================= 回放空间详情（时间线） ================= */

  function openSpace(spaceId) {
    var box = el("div", "replay-space-view");
    var modal = openModal("回放空间加载中…", box, {
      buttons: [button("关闭", null, function () {})]
    });

    var header = el("div", "replay-detail-head");
    var note = el("div", "replay-locked-note",
      "🔒 以下为审计包锁定的历史内容（只读）。此处不会调用任何线上接口，" +
      "不能暂停、审批或执行。");
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

    var summary = el("div", "replay-detail-summary");
    var timeline = el("div", "replay-timeline");
    box.appendChild(header);
    box.appendChild(note);
    box.appendChild(filters);
    box.appendChild(summary);
    box.appendChild(timeline);

    var view = { rev: 1, taskId: "", category: "", action: "" };

    function loadDetail() {
      return api("GET", "/api/replay/spaces/" + spaceId).then(function (r) {
        var sp = r.data.space;
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

        // 恢复已保存筛选
        if (sp.view) {
          taskSelect.value = sp.view.taskId || "";
          catSelect.value = sp.view.category || "";
        }
        return sp;
      });
    }

    function loadTimeline() {
      var q = [];
      if (taskSelect.value) q.push("taskId=" + encodeURIComponent(taskSelect.value));
      if (catSelect.value) q.push("category=" + encodeURIComponent(catSelect.value));
      if (actionSelect.value) q.push("action=" + encodeURIComponent(actionSelect.value));
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
        renderTimeline(timeline, d, spaceId);
      });
    }

    btnApply.addEventListener("click", function () {
      loadTimeline().catch(function (e) { toast(e.message, "error"); });
    });
    btnSaveView.addEventListener("click", function () {
      api("PUT", "/api/replay/spaces/" + spaceId + "/view", {
        taskId: taskSelect.value, category: catSelect.value,
        action: actionSelect.value, annotationId: ""
      }, { ifMatch: view.rev }).then(function (r) {
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

    loadDetail().then(function (sp) {
      // 默认载入已保存筛选对应的时间线
      return loadTimeline().then(function () {
        // 冲突摘要
        return api("GET", "/api/replay/spaces/" + spaceId + "/conflicts");
      }).then(function (cr) {
        var sum = cr.data.summary;
        if (sum.items && sum.items.length) {
          var cbox = el("div", "replay-conflict-box");
          cbox.appendChild(el("b", null, "冲突条目 " + sum.items.length + " 条："));
          Object.keys(sum.counts).forEach(function (reason) {
            cbox.appendChild(el("span", "replay-badge replay-badge-danger",
              reason + " × " + sum.counts[reason]));
          });
          summary.appendChild(cbox);
        }
        return sp;
      });
    }).catch(function (e) {
      timeline.textContent = "加载失败：" + e.message;
    });
  }

  function renderTimeline(container, d, spaceId) {
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
        ul.appendChild(li);
      });
      group.appendChild(ul);
      container.appendChild(group);
    });
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
