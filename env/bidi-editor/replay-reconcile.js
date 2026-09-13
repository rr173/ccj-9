/* replay-reconcile.js
 * 归档差异与纠错对账中心 UI（独立于归档中心与线上数据）：
 *   - 选择两个已生成归档做确定性差异比较（损坏/缺引用/摘要不一致时明确标出原因）；
 *   - 差异详情按六个维度（锁定意见/逐条结论/冲突记录/操作时间线/空间内容指纹/
 *     恢复状态）展示可定位差异项，A/B 两侧对照，交换顺序结果一致；
 *   - 从差异结果创建纠错批次：为每条可裁决差异指定保留 A/采用 B/人工复核，
 *     填写负责人、截止时间、审批人；
 *   - 提交（重新校验归档未替换、差异指纹未变）、审批通过/驳回、执行；
 *   - 执行成功后查看只读纠错归档与新回放空间；失败批次显示整批拒绝原因；
 *   - 差异结果、批次、审批记录、失败原因与操作记录持久化，重启可续。
 */
(function () {
  "use strict";

  var RC = window.ReplayReconcileCore;

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(label, className, onClick) {
    var b = el("button", className || null);
    b.textContent = label;
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function fmt(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function toast(message, kind) {
    var box = $("toast-box");
    if (!box) return;
    var t = el("div", "toast toast-" + (kind || "info"));
    t.textContent = message;
    box.appendChild(t);
    setTimeout(function () {
      t.classList.add("toast-out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, kind === "error" ? 8000 : 3500);
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
    return { close: close, body: body, foot: foot, overlay: overlay };
  }

  function api(method, url, options) {
    options = options || {};
    var headers = { Accept: "application/json" };
    if (options.ifMatch != null) headers["If-Match"] = String(options.ifMatch);
    if (options.batchVersion != null) headers["X-Batch-Version"] = String(options.batchVersion);
    var init = { method: method, headers: headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body || {});
    }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.message) || ("请求失败：HTTP " + res.status));
          err.status = res.status;
          err.code = data && data.error;
          err.data = data;
          err.rev = res.headers.get("x-reconcile-rev");
          throw err;
        }
        return { data: data, status: res.status,
          rev: res.headers.get("x-reconcile-rev") };
      });
    });
  }

  var REV = { v: 0 };
  var TYPE_LABEL = {
    locked_opinion: "锁定意见", conclusion: "逐条结论", conflict: "冲突记录",
    timeline: "操作时间线", fingerprint: "空间内容指纹", restore: "恢复状态"
  };
  var RES_LABEL = {
    keep_a: "保留 A 侧", keep_b: "采用 B 侧", manual: "人工复核"
  };
  var STATUS_LABEL = RC.BATCH_STATUS_LABELS;

  /* ================= 主面板 ================= */

  function openCenter() {
    var box = el("div", "reconcile-center archive-center");

    var bar = el("div", "archive-filter-bar");
    var btnDiff = button("＋ 新建差异比较", "primary");
    var btnBatches = button("纠错批次");
    var btnCorrections = button("纠错归档");
    var btnLogs = button("操作记录");
    var btnRefresh = button("刷新");
    bar.appendChild(btnDiff);
    bar.appendChild(btnBatches);
    bar.appendChild(btnCorrections);
    bar.appendChild(btnLogs);
    bar.appendChild(btnRefresh);
    box.appendChild(bar);

    var revLine = el("div", "snap-note");
    box.appendChild(revLine);

    var lists = el("div", "reconcile-lists");
    box.appendChild(lists);

    var modal = openModal("归档差异与纠错对账中心", box, {
      buttons: [button("关闭", null, function () { modal.close(); })]
    });

    function render() {
      api("GET", "/api/replay/reconcile/diffs").then(function (r) {
        REV.v = Number(r.rev || 0);
        revLine.textContent = "对账中心版本 " + REV.v;
        lists.innerHTML = "";
        lists.appendChild(renderDiffSection(r.data.diffs || []));
      }).catch(function (e) { toast(e.message, "error"); });
    }

    btnDiff.addEventListener("click", function () { openDiffWizard(render); });
    btnBatches.addEventListener("click", function () { openBatchList(); });
    btnCorrections.addEventListener("click", function () { openCorrectionList(); });
    btnLogs.addEventListener("click", function () { openLogs(); });
    btnRefresh.addEventListener("click", render);
    render();
  }

  function sectionCard(title, node) {
    var card = el("div", "archive-card reconcile-section");
    var h = el("div", "archive-card-top");
    h.appendChild(el("strong", null, title));
    card.appendChild(h);
    card.appendChild(node);
    return card;
  }

  function renderDiffSection(diffs) {
    var wrap = el("div");
    var list = el("div", "archive-list");
    if (!diffs.length) {
      list.appendChild(el("div", "replay-empty", "尚无差异比较结果。点击“新建差异比较”选择两个归档。"));
    } else {
      diffs.slice(0, 30).forEach(function (d) {
        var item = el("div", "archive-card archive-list-item reconcile-diff-item");
        var top = el("div", "archive-card-top");
        var badge = d.status === "invalid"
          ? el("span", "archive-badge archive-badge-bad", "校验失败")
          : el("span", "archive-badge archive-badge-active", "可对账");
        top.appendChild(badge);
        top.appendChild(el("span", "archive-card-title",
          "差异 " + d.id.slice(0, 18) + "…"));
        top.appendChild(el("span", "archive-card-meta", fmt(d.createdAt)));
        item.appendChild(top);
        var meta = el("div", "archive-card-meta");
        meta.textContent = "A " + d.a.archiveId.slice(0, 14) + "…  ↔  B " +
          d.b.archiveId.slice(0, 14) + "…";
        item.appendChild(meta);
        if (d.status === "ok") {
          var counts = el("div", "archive-opinion-counts");
          counts.textContent = "差异 " + d.counts.total + " 项（可裁决 " +
            d.counts.resolvable + "）";
          item.appendChild(counts);
        } else if (d.problems) {
          item.appendChild(el("div", "archive-preview-bad",
            d.problems.map(function (p) {
              return p.side.toUpperCase() + " 侧：" + p.code;
            }).join("；")));
        }
        var actions = el("div", "archive-detail-actions");
        actions.appendChild(button("查看差异", null, function () { openDiffDetail(d.id); }));
        if (d.status === "ok") {
          actions.appendChild(button("创建纠错批次", "primary",
            function () { openBatchWizard(d.id); }));
        }
        item.appendChild(actions);
        list.appendChild(item);
      });
    }
    wrap.appendChild(list);
    return wrap;
  }

  /* ================= 新建差异比较向导 ================= */

  function openDiffWizard(onDone) {
    var body = el("div", "archive-create");
    var note = el("div", "snap-note");
    body.appendChild(note);

    var selA = el("select");
    var selB = el("select");
    var actorInp = el("input");
    actorInp.type = "text";
    actorInp.placeholder = "操作人（默认：负责人）";

    function row(label, node) {
      var r = el("div", "archive-create-row");
      r.appendChild(el("label", null, label));
      r.appendChild(node);
      body.appendChild(r);
    }
    row("归档 A（基准侧）", selA);
    row("归档 B（对照侧）", selB);
    row("操作人", actorInp);

    api("GET", "/api/replay/archives").then(function (r) {
      var arcs = r.data.archives || [];
      selA.innerHTML = ""; selB.innerHTML = "";
      selA.appendChild(new Option("— 请选择 —", ""));
      selB.appendChild(new Option("— 请选择 —", ""));
      arcs.forEach(function (a) {
        var text = (a.sessionName || a.sourceSessionId) + "（" + a.id.slice(0, 12) + "…/" +
          a.statusLabel + "）";
        selA.appendChild(new Option(text, a.id));
        selB.appendChild(new Option(text, a.id));
      });
    }).catch(function (e) { note.textContent = e.message; });

    var modal = openModal("新建差异比较", body, {
      buttons: [
        button("取消", null, function () { modal.close(); }),
        button("比较", "primary", function () {
          var aId = selA.value, bId = selB.value;
          if (!aId || !bId) { note.textContent = "请选择两个归档。"; return; }
          if (aId === bId) { note.textContent = "必须选择两个不同的归档。"; return; }
          api("POST", "/api/replay/reconcile/diff", {
            aId: aId, bId: bId, actor: actorInp.value.trim() || "负责人"
          }, { ifMatch: REV.v }).then(function (r) {
            REV.v = Number(r.rev || REV.v);
            modal.close();
            toast(r.status === 200 ? "同一对归档差异未变化（幂等返回）" : "差异比较完成");
            if (onDone) onDone();
            openDiffDetail(r.data.diff.id);
          }).catch(function (e) {
            if (e.rev) REV.v = Number(e.rev);
            if (e.code === "diff_archive_invalid" && e.data && e.data.diffId) {
              modal.close();
              toast("归档校验失败：已标出原因，未继续合并", "error");
              if (onDone) onDone();
              openDiffDetail(e.data.diffId);
            } else {
              note.textContent = e.message;
            }
          });
        })
      ]
    });
  }

  /* ================= 差异详情 ================= */

  function openDiffDetail(id) {
    api("GET", "/api/replay/reconcile/diffs/" + id).then(function (r) {
      var d = r.data.diff;
      var body = el("div");

      var summary = el("div", "archive-overview");
      summary.appendChild(kv("差异 id", d.id));
      summary.appendChild(kv("状态", d.status === "invalid" ? "校验失败（未合并）" : "可对账"));
      summary.appendChild(kv("生成时间", fmt(d.createdAt) + " · " + d.createdBy));
      summary.appendChild(kv("A 侧归档", d.a.archiveId + "（" + d.a.status + "）"));
      summary.appendChild(kv("B 侧归档", d.b.archiveId + "（" + d.b.status + "）"));
      if (d.fingerprint) summary.appendChild(kv("差异指纹", d.fingerprint));
      body.appendChild(summary);

      if (d.status === "invalid") {
        var bad = el("div", "archive-preview-bad");
        bad.appendChild(el("strong", null, "归档未通过完整性校验，未继续合并："));
        (d.problems || []).forEach(function (p) {
          bad.appendChild(el("div", null,
            "· " + p.side.toUpperCase() + " 侧 " + p.archiveId + "：" + p.code +
            (p.message ? "（" + p.message + "）" : "")));
        });
        body.appendChild(bad);
      } else {
        var counts = el("div", "archive-opinion-counts");
        counts.textContent = "共 " + d.counts.total + " 项差异（可裁决 " +
          d.counts.resolvable + " 项）" +
          (d.counts.contentHashMismatch ? "；注意：两侧锁定内容指纹不同，创建批次时须选择基线归档" : "");
        body.appendChild(counts);
        body.appendChild(renderDiffItems(d.items || []));
      }

      var modal = openModal("差异详情", body, {
        buttons: (d.status === "ok" ? [
          button("创建纠错批次", "primary", function () { modal.close(); openBatchWizard(d.id); })
        ] : []).concat([button("关闭", null, function () { modal.close(); })])
      });
    }).catch(function (e) { toast(e.message, "error"); });
  }

  function kv(k, v) {
    var row = el("div", "archive-grid");
    row.appendChild(el("span", "archive-cell-label", k));
    row.appendChild(el("span", "archive-cell-value", String(v == null ? "—" : v)));
    return row;
  }

  function renderSideVal(side) {
    if (!side) return el("span", "reconcile-side-empty", "—");
    if (!side.present) return el("span", "reconcile-side-absent", "（该侧不存在）");
    var text = side.value === null ? "null" : formatVal(side.value);
    return el("span", "reconcile-side-val", text);
  }

  function formatVal(v) {
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  function renderDiffItems(items) {
    var groups = {};
    ["locked_opinion", "conclusion", "conflict", "timeline", "fingerprint", "restore"]
      .forEach(function (t) { groups[t] = []; });
    items.forEach(function (it) { (groups[it.type] || []).push(it); });

    var wrap = el("div", "reconcile-items");
    Object.keys(groups).forEach(function (t) {
      if (!groups[t].length) return;
      var card = el("div", "archive-card");
      var head = el("div", "archive-card-top");
      head.appendChild(el("strong", null,
        TYPE_LABEL[t] + "（" + groups[t].length + "）" +
        (["timeline", "fingerprint", "restore"].indexOf(t) === -1 ? "" : "·信息性差异，不可逐条裁决")));
      card.appendChild(head);

      var table = el("table", "reconcile-table");
      var thead = el("thead");
      var hr = el("tr");
      ["定位", "A 侧", "B 侧"].forEach(function (h) {
        var th = el("th"); th.textContent = h; hr.appendChild(th);
      });
      thead.appendChild(hr); table.appendChild(thead);
      var tbody = el("tbody");
      groups[t].forEach(function (it) {
        var tr = el("tr");
        var tdLoc = el("td");
        tdLoc.appendChild(el("div", "reconcile-loc-label", it.label));
        tdLoc.appendChild(el("div", "reconcile-loc", JSON.stringify(it.locator)));
        tr.appendChild(tdLoc);
        var tdA = el("td"); tdA.appendChild(renderSideVal(it.a)); tr.appendChild(tdA);
        var tdB = el("td"); tdB.appendChild(renderSideVal(it.b)); tr.appendChild(tdB);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
      wrap.appendChild(card);
    });
    return wrap;
  }

  /* ================= 纠错批次向导 ================= */

  function openBatchWizard(diffId) {
    api("GET", "/api/replay/reconcile/diffs/" + diffId).then(function (r) {
      var d = r.data.diff;
      if (d.status !== "ok") { toast("差异结果无效，不能创建批次", "error"); return; }

      var body = el("div", "archive-create");
      var note = el("div", "snap-note");
      body.appendChild(note);

      var nameInp = el("input");
      nameInp.type = "text"; nameInp.value = "纠错批次 " + d.id.slice(4, 10);
      nameInp.maxLength = 100;
      var ownerInp = el("input");
      ownerInp.type = "text"; ownerInp.value = "负责人"; ownerInp.maxLength = 50;
      var dueInp = el("input");
      dueInp.type = "datetime-local";
      var dl = new Date(Date.now() + 7 * 86400000);
      dueInp.value = dl.toISOString().slice(0, 16);
      var apprInp = el("input");
      apprInp.type = "text"; apprInp.placeholder = "审批人（1~3 名，逗号分隔）";
      var baseSel = el("select");
      [["", "（同内容时自动选 A 侧）"], [d.a.archiveId, "以 A 侧归档为基线"],
        [d.b.archiveId, "以 B 侧归档为基线"]].forEach(function (o) {
        baseSel.appendChild(new Option(o[1], o[0]));
      });
      if (d.counts.contentHashMismatch) {
        baseSel.value = d.a.archiveId;
        note.textContent = "两侧锁定内容指纹不同，必须选择一个基线归档（其锁定内容作为纠错空间内容）。";
      }

      function row(label, node) {
        var rr = el("div", "archive-create-row");
        rr.appendChild(el("label", null, label)); rr.appendChild(node); body.appendChild(rr);
      }
      row("批次名称", nameInp);
      row("负责人", ownerInp);
      row("截止时间", dueInp);
      row("审批人", apprInp);
      row("锁定内容基线", baseSel);

      // 逐差异裁决（仅可裁决项）
      var resolvable = (d.items || []).filter(function (it) { return it.resolvable; });
      var decision = {}; // item id -> select
      var groups = {};
      resolvable.forEach(function (it) {
        (groups[it.type] = groups[it.type] || []).push(it);
      });
      var itemsBox = el("div", "reconcile-decide");
      body.appendChild(el("p", null, "为每条可裁决差异指定处理方式（" +
        resolvable.length + " 条）："));
      Object.keys(groups).forEach(function (t) {
        var card = el("div", "archive-card");
        card.appendChild(el("strong", null, TYPE_LABEL[t] + "（" + groups[t].length + "）"));
        groups[t].forEach(function (it) {
          var line = el("div", "reconcile-decide-line");
          var info = el("div", "reconcile-decide-info");
          info.appendChild(el("div", "reconcile-loc-label", it.label));
          info.appendChild(el("div", "reconcile-loc",
            (it.a.present ? "A:" + shortVal(it.a.value) : "（A 无）") + "  ↔  " +
            (it.b.present ? "B:" + shortVal(it.b.value) : "（B 无）")));
          line.appendChild(info);
          var sel = el("select");
          [["keep_a", "保留 A 侧"], ["keep_b", "采用 B 侧"], ["manual", "人工复核"]]
            .forEach(function (o) { sel.appendChild(new Option(o[1], o[0])); });
          sel.value = "keep_a";
          decision[it.id] = sel;
          line.appendChild(sel);
          card.appendChild(line);
        });
        itemsBox.appendChild(card);
      });
      body.appendChild(itemsBox);

      var modal = openModal("创建纠错批次", body, {
        buttons: [
          button("取消", null, function () { modal.close(); }),
          button("创建批次", "primary", function () {
            var dueVal = dueInp.value ? new Date(dueInp.value).toISOString() : "";
            var approvers = apprInp.value.split(/[,，]/).map(function (s) {
              return s.trim();
            }).filter(Boolean);
            var payload = {
              diffId: d.id,
              name: nameInp.value.trim(),
              owner: ownerInp.value.trim(),
              deadline: dueVal,
              approvers: approvers,
              baseArchiveId: baseSel.value || null,
              actor: ownerInp.value.trim() || "负责人",
              items: resolvable.map(function (it) {
                return { id: it.id, resolution: decision[it.id].value };
              })
            };
            api("POST", "/api/replay/reconcile/batches", payload, { ifMatch: REV.v })
              .then(function (r) {
                REV.v = Number(r.rev || REV.v);
                modal.close();
                toast("纠错批次已创建（拟定中）");
                openBatchDetail(r.data.batch.id);
              }).catch(function (e) {
                if (e.rev) REV.v = Number(e.rev);
                note.textContent = e.message;
              });
          })
        ]
      });
    }).catch(function (e) { toast(e.message, "error"); });
  }

  function shortVal(v) {
    var s = formatVal(v);
    return s.length > 40 ? s.slice(0, 40) + "…" : s;
  }

  /* ================= 批次列表 / 详情 / 审批 / 执行 ================= */

  function statusBadge(status) {
    var map = {
      draft: "archive-badge-active", submitted: "archive-badge-reason",
      approved: "archive-badge-conclusion", rejected: "archive-badge-bad",
      failed: "archive-badge-bad"
    };
    return el("span", "archive-badge " + (map[status] || ""),
      STATUS_LABEL[status] || status);
  }

  function openBatchList() {
    api("GET", "/api/replay/reconcile/batches").then(function (r) {
      var list = el("div", "archive-list");
      (r.data.batches || []).forEach(function (b) {
        var item = el("div", "archive-card archive-list-item");
        var top = el("div", "archive-card-top");
        top.appendChild(statusBadge(b.status));
        top.appendChild(el("span", "archive-card-title", b.name));
        top.appendChild(el("span", "archive-card-meta", fmt(b.createdAt)));
        item.appendChild(top);
        item.appendChild(el("div", "archive-card-meta",
          "负责人 " + b.owner + " · 截止 " + fmt(b.deadline) +
          " · 审批人 " + b.approvers.join("、") + " · 差异项 " + b.items.length));
        if (b.failureCode) {
          item.appendChild(el("div", "archive-preview-bad",
            "整批拒绝：" + b.failureCode + "（" + (b.failureMessage || "") + "）"));
        }
        var actions = el("div", "archive-detail-actions");
        actions.appendChild(button("查看", null, function () { openBatchDetail(b.id); }));
        item.appendChild(actions);
        list.appendChild(item);
      });
      if (!r.data.batches.length) list.appendChild(el("div", "replay-empty", "尚无纠错批次。"));
      var modal = openModal("纠错批次", list, {
        buttons: [button("关闭", null, function () { modal.close(); })]
      });
    }).catch(function (e) { toast(e.message, "error"); });
  }

  function openBatchDetail(id) {
    function load() {
      return api("GET", "/api/replay/reconcile/batches/" + id);
    }
    load().then(function (r) { showBatch(r.data.batch, null); });
  }

  function showBatch(b, modal) {
    var body = el("div");
    var top = el("div", "archive-overview");
    top.appendChild(kv("批次", b.name + "（v" + b.version + "）"));
    var badgeRow = el("div", "archive-grid");
    badgeRow.appendChild(el("span", "archive-cell-label", "状态"));
    badgeRow.appendChild(statusBadge(b.status));
    top.appendChild(badgeRow);
    top.appendChild(kv("负责人", b.owner));
    top.appendChild(kv("审批人", b.approvers.join("、")));
    top.appendChild(kv("截止时间", fmt(b.deadline)));
    top.appendChild(kv("差异结果", b.diffId));
    if (b.baseArchiveId) top.appendChild(kv("基线归档", b.baseArchiveId));
    if (b.correctionId) top.appendChild(kv("纠错归档", b.correctionId));
    if (b.newSpaceId) top.appendChild(kv("新回放空间", b.newSpaceId));
    body.appendChild(top);

    if (b.failureCode) {
      body.appendChild(el("div", "archive-preview-bad",
        "整批拒绝原因：" + b.failureCode + " — " + (b.failureMessage || "")));
    }
    if (b.rejectReason) {
      body.appendChild(el("div", "archive-preview-bad", "驳回原因：" + b.rejectReason));
    }

    // 审批记录
    if (b.approvals && b.approvals.length) {
      var ap = el("div", "archive-card");
      ap.appendChild(el("strong", null, "审批记录"));
      b.approvals.forEach(function (a) {
        ap.appendChild(el("div", "archive-card-meta",
          fmt(a.at) + " · " + a.by + " · " +
          (a.decision === "approve" ? "通过" : "驳回") +
          (a.reason ? "（" + a.reason + "）" : "") +
          (a.round ? " · 第" + a.round + "轮" : "")));
      });
      body.appendChild(ap);
    }

    // 裁决一览
    var table = el("table", "reconcile-table");
    var thr = el("tr");
    ["类型", "定位", "裁决"].forEach(function (h) {
      var th = el("th"); th.textContent = h; thr.appendChild(th);
    });
    table.appendChild(thr);
    b.items.forEach(function (it) {
      var tr = el("tr");
      var t1 = el("td"); t1.textContent = TYPE_LABEL[it.type] || it.type; tr.appendChild(t1);
      var t2 = el("td"); t2.textContent = JSON.stringify(it.locator); tr.appendChild(t2);
      var t3 = el("td"); t3.textContent = RES_LABEL[it.resolution] || it.resolution; tr.appendChild(t3);
      table.appendChild(tr);
    });
    body.appendChild(table);

    var actions = el("div", "archive-detail-actions");

    function refresh() {
      load().then(function (r) {
        modal.close();
        showBatch(r.data.batch, null);
      });
    }

    if (b.status === "draft") {
      actions.appendChild(button("提交审批", "primary", function () {
        api("POST", "/api/replay/reconcile/batches/" + b.id + "/submit",
          { actor: b.owner },
          { ifMatch: REV.v, batchVersion: b.version }).then(function (r) {
          REV.v = Number(r.rev || REV.v);
          toast("已提交审批"); refresh();
        }).catch(function (e) {
          if (e.rev) REV.v = Number(e.rev);
          toast(e.message, "error");
        });
      }));
    }
    if (b.status === "submitted") {
      ["approve", "reject"].forEach(function (dec) {
        actions.appendChild(button(dec === "approve" ? "审批通过" : "驳回",
          dec === "approve" ? "primary" : null, function () {
            var actor = window.prompt(dec === "approve" ? "审批人署名：" : "驳回人署名：",
              b.approvers[0] || "");
            if (actor === null) return;
            var payload = { decision: dec, actor: actor.trim() };
            if (dec === "reject") payload.reason = window.prompt("驳回原因（可留空）：", "") || "";
            api("POST", "/api/replay/reconcile/batches/" + b.id + "/approvals",
              payload, { ifMatch: REV.v, batchVersion: b.version }).then(function (r) {
              REV.v = Number(r.rev || REV.v);
              toast(dec === "approve" ? "审批已记录" : "已驳回"); refresh();
            }).catch(function (e) {
              if (e.rev) REV.v = Number(e.rev);
              toast(e.message, "error");
            });
          }));
      });
      actions.appendChild(button("执行（校验审批）", null, function () {
        doExecute(b, refresh);
      }));
    }
    if (b.status === "approved") {
      actions.appendChild(button("执行纠错（生成纠错归档与新空间）", "primary",
        function () { doExecute(b, refresh); }));
    }
    if (b.correctionId) {
      actions.appendChild(button("查看纠错归档", null, function () {
        openCorrectionDetail(b.correctionId);
      }));
    }
    body.appendChild(actions);

    if (modal) { modal.body.innerHTML = ""; modal.body.appendChild(body); }
    else {
      modal = openModal("纠错批次详情", body, {
        buttons: [button("关闭", null, function () { modal.close(); })]
      });
    }
  }

  function doExecute(b, refresh) {
    var actor = window.prompt("执行操作人署名：", b.approvers[0] || "审批人");
    if (actor === null) return;
    api("POST", "/api/replay/reconcile/batches/" + b.id + "/execute",
      { actor: actor.trim() },
      { ifMatch: REV.v, batchVersion: b.version }).then(function (r) {
      REV.v = Number(r.rev || REV.v);
      toast("纠错已执行：生成只读纠错归档与新回放空间");
      refresh();
      openCorrectionDetail(r.data.correction.id);
    }).catch(function (e) {
      if (e.rev) REV.v = Number(e.rev);
      toast(e.message, "error");
      refresh();
    });
  }

  /* ================= 纠错归档列表 / 详情 ================= */

  function openCorrectionList() {
    api("GET", "/api/replay/reconcile/corrections").then(function (r) {
      var list = el("div", "archive-list");
      (r.data.corrections || []).forEach(function (c) {
        var item = el("div", "archive-card archive-list-item");
        var top = el("div", "archive-card-top");
        top.appendChild(el("span", "archive-badge archive-badge-conclusion", "纠错归档"));
        top.appendChild(el("span", "archive-card-title", c.id.slice(0, 18) + "…"));
        top.appendChild(el("span", "archive-card-meta", fmt(c.createdAt)));
        item.appendChild(top);
        item.appendChild(el("div", "archive-card-meta",
          "批次 " + c.batchId + " · 条目 " + c.manifest.itemCount +
          " · 人工复核 " + c.manifest.manualCount));
        var actions = el("div", "archive-detail-actions");
        actions.appendChild(button("查看", null, function () { openCorrectionDetail(c.id); }));
        actions.appendChild(button("下载", null, function () {
          window.open("/api/replay/reconcile/corrections/" + c.id + "/download", "_blank");
        }));
        item.appendChild(actions);
        list.appendChild(item);
      });
      if (!r.data.corrections.length) {
        list.appendChild(el("div", "replay-empty", "尚无纠错归档（审批通过并执行后生成）。"));
      }
      var modal = openModal("纠错归档", list, {
        buttons: [button("关闭", null, function () { modal.close(); })]
      });
    }).catch(function (e) { toast(e.message, "error"); });
  }

  function openCorrectionDetail(id) {
    api("GET", "/api/replay/reconcile/corrections/" + id).then(function (r) {
      var c = r.data.correction;
      var body = el("div");
      var ov = el("div", "archive-overview");
      ov.appendChild(kv("纠错归档", c.id));
      ov.appendChild(kv("批次 / 差异", c.batchId + " / " + c.diffId));
      ov.appendChild(kv("来源归档", (c.sourceArchiveIds || []).join("，")));
      ov.appendChild(kv("基线归档", c.baseArchiveId));
      ov.appendChild(kv("审批通过", fmt(c.approvedAt) + " · " + c.approvedBy));
      ov.appendChild(kv("新回放空间", c.restoredSpaceId));
      ov.appendChild(kv("内容指纹", c.manifest.contentHash));
      ov.appendChild(kv("事件链头", c.manifest.chainHead));
      ov.appendChild(kv("事件数", c.manifest.eventCount));
      body.appendChild(ov);

      var checks = el("div", "archive-card");
      checks.appendChild(el("strong", null,
        "确定性校验摘要（" + (c.verification.verified ? "全部通过" : "存在失败项") + "）"));
      (c.verification.checks || []).forEach(function (k) {
        var line = el("div", "archive-card-meta");
        line.appendChild(el("span", k.ok ? "archive-badge archive-badge-active"
          : "archive-badge archive-badge-bad", k.ok ? "通过" : "失败"));
        line.appendChild(document.createTextNode(" " + k.label));
        checks.appendChild(line);
      });
      body.appendChild(checks);

      var prog = c.progress;
      if (prog) {
        body.appendChild(el("div", "archive-opinion-counts",
          "进度：" + prog.concluded + "/" + prog.total +
          " 结论，冲突 " + prog.conflicts + "，人工复核 " + (prog.manual || 0)));
      }

      // 纠错会话条目
      if (c.session && c.session.items) {
        var table = el("table", "reconcile-table");
        var thr = el("tr");
        ["意见", "锁定版本", "结论", "冲突", "人工复核"].forEach(function (h) {
          var th = el("th"); th.textContent = h; thr.appendChild(th);
        });
        table.appendChild(thr);
        c.session.items.forEach(function (it) {
          var tr = el("tr");
          [it.reviewId, it.lockedVersion,
            it.conclusion ? it.conclusion.result : "—",
            it.conflict ? it.conflict.code : "—",
            it.manual ? JSON.stringify(it.manual) : ""].forEach(function (v) {
            var td = el("td"); td.textContent = String(v); tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        body.appendChild(table);
      }

      var actions = el("div", "archive-detail-actions");
      actions.appendChild(button("下载纠错归档", null, function () {
        window.open("/api/replay/reconcile/corrections/" + c.id + "/download", "_blank");
      }));
      if (c.restoredSpaceId) {
        actions.appendChild(button("打开新回放空间（在执行回放面板）", null, function () {
          if (window.ReplayUI) window.ReplayUI.openCenter();
        }));
      }
      body.appendChild(actions);

      var modal = openModal("纠错归档详情", body, {
        buttons: [button("关闭", null, function () { modal.close(); })]
      });
    }).catch(function (e) { toast(e.message, "error"); });
  }

  /* ================= 操作记录 ================= */

  function openLogs() {
    api("GET", "/api/replay/reconcile/logs").then(function (r) {
      var list = el("div", "archive-logs-list");
      (r.data.logs || []).slice(0, 200).forEach(function (l) {
        var line = el("div", "archive-action-line " +
          (l.ok ? "archive-log-ok" : "archive-log-bad"));
        var parts = [fmt(l.at), l.action, l.actor || ""];
        if (l.code) parts.push("[" + l.code + "]");
        if (l.batchId) parts.push("批次 " + l.batchId.slice(0, 12));
        if (l.diffId) parts.push("差异 " + l.diffId.slice(0, 12));
        if (l.correctionId) parts.push("纠错 " + l.correctionId.slice(0, 12));
        if (l.message) parts.push(l.message);
        line.textContent = parts.filter(Boolean).join(" · ");
        list.appendChild(line);
      });
      if (!r.data.logs.length) list.appendChild(el("div", "replay-empty", "暂无操作记录。"));
      var modal = openModal("对账中心操作记录", list, {
        buttons: [button("关闭", null, function () { modal.close(); })]
      });
    }).catch(function (e) { toast(e.message, "error"); });
  }

  /* ================= 挂载 ================= */

  function init() {
    var btn = $("reconcile-open-btn");
    if (!btn) return;
    btn.title = "比较两个复核会话归档，创建纠错批次并在审批通过后生成只读纠错归档与新回放空间";
    btn.addEventListener("click", openCenter);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.ReplayReconcileUI = { openCenter: openCenter };
})();
