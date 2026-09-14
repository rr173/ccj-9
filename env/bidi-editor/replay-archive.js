/* replay-archive.js
 * 复核会话归档中心 UI（独立于线上批次/决策/队列，也不修改回放锁定内容）：
 *   - 从回放空间选择“已完成 / 已过期”的复核会话生成不可变归档
 *     （带空间版本 If-Match；同内容幂等；内容/版本不同明确冲突）；
 *   - 归档列表按空间 / 参与人 / 时间范围 / 归档状态筛选，筛选条件可保存（重启恢复）；
 *   - 打开归档：完整时间线、进度快照、逐条结论/冲突、当前意见摘要、
 *     回放空间内容指纹与确定性校验摘要；可下载归档 JSON；
 *   - 先预览再恢复到一个“新的”回放空间：预览跑完整校验（损坏/重复标识/缺失引用/
 *     目标空间冲突/内容指纹），恢复成功后可直接打开新空间；新空间历史只读、
 *     可继续创建新复核会话；
 *   - 归档 / 预览 / 恢复 / 筛选的操作记录可查看（服务端持久化，重启可续）。
 */
(function () {
  "use strict";

  var AC = window.ReplayArchiveCore;

  /* ---------- 基础工具（与 replay.js 同风格，独立实现避免耦合） ---------- */

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
    var pp = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pp(d.getMonth() + 1) + "-" + pp(d.getDate()) +
      " " + pp(d.getHours()) + ":" + pp(d.getMinutes()) + ":" + pp(d.getSeconds());
  }
  function toast(message, kind) {
    var box = $("toast-box");
    if (!box) { return; }
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
    var headers = { Accept: "application/json" };
    if (window.PermissionIdentity) {
      headers["X-Member"] = window.PermissionIdentity.header();
    }
    if (options.ifMatch != null) headers["If-Match"] = String(options.ifMatch);
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
          throw err;
        }
        return { data: data, status: res.status };
      });
    });
  }

  var RESULT_LABELS = { confirm: "确认", reject: "驳回", need_evidence: "需补证据" };
  var STATUS_LABELS = { active: "可恢复", restored: "已恢复" };
  var REASON_LABELS = { completed: "已完成", expired: "已过期" };

  /* ================= 归档中心主面板 ================= */

  function openArchiveCenter() {
    var box = el("div", "archive-center");

    var filterBar = el("div", "archive-filter-bar");
    var spaceSel = el("select");
    spaceSel.appendChild(new Option("全部回放空间", ""));
    var participantInp = el("input");
    participantInp.type = "text";
    participantInp.placeholder = "参与人";
    participantInp.maxLength = 50;
    var fromInp = el("input"); fromInp.type = "datetime-local";
    var toInp = el("input"); toInp.type = "datetime-local";
    var statusSel = el("select");
    [["", "全部状态"], ["active", "可恢复"], ["restored", "已恢复"]]
      .forEach(function (o) { statusSel.appendChild(new Option(o[0] ? STATUS_LABELS[o[0]] : "全部状态", o[0])); });
    var btnQuery = button("筛选", "primary");
    var btnReset = button("重置");
    var btnSave = button("记住筛选");
    var btnLogs = button("操作记录");
    var btnNew = button("＋ 生成归档", "primary");
    filterBar.appendChild(el("label", null, "空间 "));
    filterBar.appendChild(spaceSel);
    filterBar.appendChild(el("label", null, " 参与人 "));
    filterBar.appendChild(participantInp);
    filterBar.appendChild(el("label", null, " 归档时间 "));
    filterBar.appendChild(fromInp);
    filterBar.appendChild(el("span", null, " ~ "));
    filterBar.appendChild(toInp);
    filterBar.appendChild(statusSel);
    filterBar.appendChild(btnQuery);
    filterBar.appendChild(btnReset);
    filterBar.appendChild(btnSave);
    filterBar.appendChild(btnLogs);
    box.appendChild(filterBar);

    var actionLine = el("div", "archive-action-line");
    actionLine.appendChild(btnNew);
    box.appendChild(actionLine);

    var listBox = el("div", "archive-list");
    box.appendChild(listBox);

    var ui = openModal("🗄 复核会话归档中心", box, {
      buttons: [button("关闭", null, function () {})]
    });

    function toIso(v) {
      if (!v) return "";
      var d = new Date(v);
      return isNaN(d.getTime()) ? "" : d.toISOString();
    }

    function loadSpaces(preselect) {
      return api("GET", "/api/replay/spaces").then(function (r) {
        spaceSel.innerHTML = "";
        spaceSel.appendChild(new Option("全部回放空间", ""));
        r.data.spaces.forEach(function (sp) {
          var o = new Option(sp.name + "（" + sp.id.slice(0, 8) + "）", sp.id);
          spaceSel.appendChild(o);
        });
        if (preselect) spaceSel.value = preselect;
      });
    }

    function renderList() {
      // 用显式参数（空串也带上以清空已保存筛选）
      var params = new URLSearchParams();
      if (spaceSel.value) params.set("spaceId", spaceSel.value);
      if (participantInp.value.trim()) params.set("participant", participantInp.value.trim());
      if (toIso(fromInp.value)) params.set("from", toIso(fromInp.value));
      if (toIso(toInp.value)) params.set("to", toIso(toInp.value));
      if (statusSel.value) params.set("status", statusSel.value);
      var qs = params.toString();
      listBox.innerHTML = "";
      listBox.appendChild(el("div", "replay-empty", "加载中…"));
      return api("GET", "/api/replay/archives" + (qs ? "?" + qs : "")).then(function (r) {
        listBox.innerHTML = "";
        var head = el("div", "archive-list-head");
        head.appendChild(el("span", null, "共 " + r.data.count + " / " + r.data.total + " 份归档"));
        listBox.appendChild(head);
        if (!r.data.archives.length) {
          listBox.appendChild(el("div", "replay-empty",
            "暂无归档。点击「＋ 生成归档」，从已完成或已过期的复核会话生成不可变归档。"));
          return;
        }
        r.data.archives.forEach(function (a) {
          listBox.appendChild(archiveCard(a, function () {
            openArchiveDetail(a.id, renderList);
          }));
        });
      }).catch(function (e) {
        listBox.innerHTML = "";
        listBox.appendChild(el("div", "replay-empty", "归档加载失败：" + e.message));
      });
    }

    btnQuery.addEventListener("click", renderList);
    btnReset.addEventListener("click", function () {
      spaceSel.value = ""; participantInp.value = "";
      fromInp.value = ""; toInp.value = ""; statusSel.value = "";
      renderList();
    });
    btnSave.addEventListener("click", function () {
      api("PUT", "/api/replay/archives/view", {
        spaceId: spaceSel.value, participant: participantInp.value.trim(),
        from: toIso(fromInp.value), to: toIso(toInp.value), status: statusSel.value,
        actor: "负责人"
      }).then(function () {
        toast("已保存筛选条件（重启后仍生效）");
      }).catch(function (e) { toast("保存筛选失败：" + e.message, "error"); });
    });
    btnLogs.addEventListener("click", openLogs);
    btnNew.addEventListener("click", function () {
      openCreateArchive(spaceSel.value, function (spaceId) {
        loadSpaces(spaceId).then(renderList);
      });
    });

    // 初次加载：回填已保存筛选，再按其展示
    api("GET", "/api/replay/archives").then(function (r) {
      var f = r.data.filters || {};
      if (f.spaceId) spaceSel.value = f.spaceId;
      if (f.participant) participantInp.value = f.participant;
      if (f.status) statusSel.value = f.status;
      // datetime-local 需要本地时间
      if (f.from) { var df = new Date(f.from); if (!isNaN(df)) fromInp.value = toLocalInput(df); }
      if (f.to) { var dt = new Date(f.to); if (!isNaN(dt)) toInp.value = toLocalInput(dt); }
    }).then(loadSpaces).then(renderList)
      .catch(function (e) { toast("加载归档中心失败：" + e.message, "error"); });
  }

  function toLocalInput(d) {
    var pp = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pp(d.getMonth() + 1) + "-" + pp(d.getDate()) +
      "T" + pp(d.getHours()) + ":" + pp(d.getMinutes());
  }

  function archiveCard(a, onOpen) {
    var card = el("div", "archive-card archive-status-" + a.status);
    var top = el("div", "archive-card-top");
    var title = el("div", "archive-card-title");
    title.appendChild(el("strong", null, a.sessionName || a.id));
    var badge = el("span", "archive-badge archive-badge-" + a.status,
      STATUS_LABELS[a.status] || a.status);
    title.appendChild(badge);
    if (a.archivedReason) {
      title.appendChild(el("span", "archive-badge archive-badge-reason",
        REASON_LABELS[a.archivedReason] || a.archivedReason));
    }
    if (!a.verification || !a.verification.verified) {
      title.appendChild(el("span", "archive-badge archive-badge-bad", "校验异常"));
    }
    top.appendChild(title);
    var actions = el("div", "archive-card-actions");
    actions.appendChild(button("打开", "primary", onOpen));
    top.appendChild(actions);
    card.appendChild(top);

    var meta = el("div", "archive-card-meta");
    meta.appendChild(el("span", null, "归档时间：" + fmt(a.archivedAt)));
    meta.appendChild(el("span", null, "源空间：" + (a.sourceSpaceName || a.sourceSpaceId.slice(0, 8))));
    meta.appendChild(el("span", null, "参与人：" + (a.participants || []).join("、")));
    card.appendChild(meta);

    if (a.progress) {
      var pg = el("div", "archive-card-progress");
      pg.appendChild(el("span", null,
        "进度 " + (a.progress.concluded || 0) + " 结论 / " +
        (a.progress.conflicts || 0) + " 冲突 / 共 " + (a.progress.total || 0)));
      card.appendChild(pg);
    }
    var fp = el("div", "archive-card-fp");
    fp.textContent = "内容指纹 " + shortHash(a.anchors && a.anchors.contentHash) +
      " · 链头 " + shortHash(a.anchors && a.anchors.chainHead) +
      " · 事件 " + (a.manifest.eventCount == null ? "—" : a.manifest.eventCount);
    card.appendChild(fp);
    if (a.status === "restored") {
      card.appendChild(el("div", "archive-card-restored",
        "已于 " + fmt(a.restoredAt) + " 恢复为回放空间 " +
        (a.restoredSpaceId || "").slice(0, 8) + "（不可再次恢复）"));
    }
    card.style.cursor = "pointer";
    card.addEventListener("click", function (e) {
      if (e.target.tagName === "BUTTON") return;
      onOpen();
    });
    return card;
  }

  function shortHash(h) { return h ? String(h).replace(/^[a-z0-9]+:/, "").slice(0, 12) : "—"; }

  /* ================= 从回放空间选择会话生成归档 ================= */

  function openCreateArchive(preselectSpace, onChanged) {
    var box = el("div", "archive-create");
    var spaceSel = el("select");
    box.appendChild(el("p", "replay-hint",
      "只有已完成（全部条目有结论或冲突）或已过期的复核会话可以归档。" +
      "归档不可变：同一会话相同内容重复生成返回同一份归档；内容或版本不同会明确冲突。"));
    var row = el("div", "archive-create-row");
    row.appendChild(el("label", null, "回放空间："));
    row.appendChild(spaceSel);
    box.appendChild(row);
    var sessBox = el("div", "archive-create-sessions");
    box.appendChild(sessBox);
    var ui = openModal("生成复核会话归档", box, {
      buttons: [button("关闭", null, function () {})]
    });

    function loadSessions() {
      var spId = spaceSel.value;
      sessBox.innerHTML = "";
      if (!spId) {
        sessBox.appendChild(el("div", "replay-empty", "请先选择回放空间"));
        return;
      }
      Promise.all([
        api("GET", "/api/replay/spaces/" + spId),
        api("GET", "/api/replay/spaces/" + spId + "/sessions")
      ]).then(function (rs) {
        var detail = rs[0].data.space;
        var sessions = rs[1].data.sessions;
        sessBox.innerHTML = "";
        if (!sessions.length) {
          sessBox.appendChild(el("div", "replay-empty", "该空间暂无复核会话"));
          return;
        }
        var nowIso = new Date().toISOString();
        sessions.forEach(function (s) {
          var p = s.progress || {};
          var completed = p.total > 0 && p.pending === 0;
          var archivable = completed || p.expired || s.archived;
          var reason = s.archived ? "历史只读会话"
            : completed ? "已完成" : p.expired ? "已过期" : "进行中";
          var rowc = el("div", "archive-create-session" +
            (archivable && !s.archived ? "" : " is-disabled"));
          var info = el("div");
          info.appendChild(el("strong", null, s.name || s.id));
          info.appendChild(el("div", "archive-create-meta",
            reason + " · 截止 " + fmt(s.deadline) +
            " · " + (p.concluded || 0) + " 结论 / " + (p.conflicts || 0) +
            " 冲突 / " + (p.pending == null ? 0 : p.pending) + " 待处理 / 共 " + (p.total || 0) +
            (s.archived ? " · 归档恢复带入" : "")));
          rowc.appendChild(info);
          if (archivable && !s.archived) {
            var btn = button("生成归档", "primary", function () {
              btn.disabled = true;
              btn.textContent = "生成中…";
              api("POST",
                "/api/replay/spaces/" + spId + "/sessions/" + s.id + "/archive",
                { actor: "负责人" }, { ifMatch: detail.rev })
                .then(function (r) {
                  if (r.status === 200 && r.data.idempotent) {
                    toast("该归档已存在（相同内容，幂等返回同一份）");
                  } else {
                    toast("归档已生成（不可变）");
                  }
                  ui.close();
                  if (onChanged) onChanged(spId);
                  openArchiveDetail(r.data.archive.id, onChanged);
                })
                .catch(function (e) {
                  btn.disabled = false;
                  btn.textContent = "生成归档";
                  if (e.code === "archive_conflict") {
                    toast("冲突：该会话已有不同内容/版本的归档（" +
                      (e.data && e.data.existingArchiveId) + "），归档不可变、未覆盖", "error");
                  } else if (e.code === "version_conflict") {
                    toast("空间版本已变化，请刷新后重试（本次未写入）", "error");
                  } else {
                    toast("归档失败（原会话与空间均未改动）：" + e.message, "error");
                  }
                });
            });
            rowc.appendChild(btn);
          }
          sessBox.appendChild(rowc);
        });
      }).catch(function (e) {
        sessBox.innerHTML = "";
        sessBox.appendChild(el("div", "replay-empty", "加载会话失败：" + e.message));
      });
    }
    spaceSel.addEventListener("change", loadSessions);
    api("GET", "/api/replay/spaces").then(function (r) {
      spaceSel.innerHTML = "";
      var has = false;
      r.data.spaces.forEach(function (sp) {
        spaceSel.appendChild(new Option(sp.name + "（" + sp.id.slice(0, 8) + "）", sp.id));
        has = true;
      });
      if (preselectSpace) { spaceSel.value = preselectSpace; loadSessions(); }
      else if (has) loadSessions();
    });
  }

  /* ================= 归档详情（时间线 / 进度 / 校验摘要 / 预览 / 恢复） ================= */

  function openArchiveDetail(id, onChanged) {
    var box = el("div", "archive-detail");
    box.appendChild(el("div", "replay-empty", "加载中…"));
    var ui = openModal("归档详情", box, {
      buttons: [button("关闭", null, function () {})]
    });

    api("GET", "/api/replay/archives/" + id).then(function (r) {
      var a = r.data.archive;
      ui.setTitle("归档 · " + (a.sessionName || a.id));
      render(box, a, ui, onChanged);
    }).catch(function (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "replay-empty", "归档加载失败：" + e.message));
    });
  }

  function render(box, a, ui, onChanged) {
    box.innerHTML = "";

    // 概览
    var overview = el("div", "archive-overview");
    var badge = el("span", "archive-badge archive-badge-" + a.status,
      STATUS_LABELS[a.status] || a.status);
    overview.appendChild(el("h4", null, "")).appendChild(
      (function () { var s = el("span", null, (a.sessionName || a.id) + " "); s.appendChild(badge); return s; })());
    var grid = el("div", "archive-grid");
    function cell(label, value) {
      var c = el("div", "archive-cell");
      c.appendChild(el("div", "archive-cell-label", label));
      c.appendChild(el("div", "archive-cell-value", value == null ? "—" : String(value)));
      return c;
    }
    grid.appendChild(cell("归档时间", fmt(a.archivedAt)));
    grid.appendChild(cell("归档人", a.createdBy));
    grid.appendChild(cell("归档依据", REASON_LABELS[a.archivedReason] || a.archivedReason));
    grid.appendChild(cell("源回放空间", (a.sourceSpaceName || "") + " " +
      (a.sourceSpaceId || "").slice(0, 8)));
    grid.appendChild(cell("源会话版本", a.source ? a.source.sessionVersion : "—"));
    grid.appendChild(cell("生成时空间版本", a.source ? a.source.spaceRev : "—"));
    grid.appendChild(cell("会话截止", fmt(a.deadline)));
    grid.appendChild(cell("参与人", (a.participants || []).join("、")));
    overview.appendChild(grid);
    box.appendChild(overview);

    // 校验摘要（确定性）
    box.appendChild(verificationBlock(a.verification));

    // 内容指纹
    var fp = el("div", "archive-fingerprint");
    fp.appendChild(el("h4", null, "回放空间内容指纹"));
    var f = a.fingerprint || {};
    var fpg = el("div", "archive-grid");
    fpg.appendChild(cell("内容哈希 (FNV-1a64)", f.contentHash || "—"));
    fpg.appendChild(cell("事件链头 (chainHead)", f.chainHead || "—"));
    fpg.appendChild(cell("事件数", f.eventCount));
    fpg.appendChild(cell("源包标识", f.packageId));
    fp.appendChild(fpg);
    box.appendChild(fp);

    // 进度快照
    if (a.progress) {
      var ps = el("div", "archive-progress-block");
      ps.appendChild(el("h4", null, "进度快照（归档瞬间冻结）"));
      ps.appendChild(el("div", null,
        "共 " + a.progress.total + " 条：" +
        a.progress.concluded + " 条有结论，" + a.progress.conflicts + " 条冲突标记，" +
        a.progress.pending + " 条待处理；完成度 " + a.progress.percent + "%"));
      box.appendChild(ps);
    }

    // 逐条结论 / 冲突 + 锁定意见
    box.appendChild(itemsBlock(a));

    // 当前意见摘要
    box.appendChild(opinionSummaryBlock(a.opinionSummary));

    // 完整时间线
    box.appendChild(timelineBlock(a.timeline));

    // 操作按钮
    var actions = el("div", "archive-detail-actions");
    actions.appendChild(button("⬇ 下载归档 JSON", null, function () {
      downloadArchive(a.id, a.sessionName);
    }));
    if (a.status === "active") {
      actions.appendChild(button("① 恢复预览", "primary", function () {
        previewThenRestore(a, function () {
          if (onChanged) onChanged();
          ui.close();
          openArchiveDetail(a.id, onChanged);
        });
      }));
    } else {
      actions.appendChild(el("span", "archive-restored-note",
        "已恢复为 " + (a.restoredSpaceId || "").slice(0, 8) + " · " + fmt(a.restoredAt)));
    }
    box.appendChild(actions);
  }

  function verificationBlock(v) {
    var wrap = el("div", "archive-verify archive-verify-" + (v && v.verified ? "ok" : "bad"));
    wrap.appendChild(el("h4", null, "确定性校验摘要" +
      (v ? "（" + (v.verified ? "全部通过" : "存在问题") + "）" : "")));
    if (v && v.algorithm) wrap.appendChild(el("div", "archive-verify-algo", v.algorithm));
    var ul = el("ul", "archive-verify-list");
    (v && v.checks || []).forEach(function (c) {
      var li = el("li", c.ok ? "verify-ok" : "verify-bad");
      li.textContent = (c.ok ? "✓ " : "✗ ") + c.label +
        (c.detail != null && c.detail !== "" ? "：" + c.detail : "");
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    return wrap;
  }

  function itemsBlock(a) {
    var wrap = el("div", "archive-items");
    wrap.appendChild(el("h4", null, "逐条锁定意见 / 结论 / 冲突（" +
      ((a.session && a.session.items) || []).length + "）"));
    var items = (a.session && a.session.items) || [];
    items.forEach(function (it, idx) {
      var row = el("div", "archive-item");
      var head = el("div", "archive-item-head");
      head.appendChild(el("strong", null, "#" + (idx + 1) + " 意见 " + it.reviewId.slice(0, 8)));
      head.appendChild(el("span", "archive-item-lock",
        "锁定 v" + it.lockedVersion + " · " + it.lockedStatus));
      if (it.conclusion) {
        head.appendChild(el("span", "archive-badge archive-badge-conclusion",
          RESULT_LABELS[it.conclusion.result] || it.conclusion.result));
      }
      if (it.conflict) {
        head.appendChild(el("span", "archive-badge archive-badge-conflict", "冲突"));
      }
      row.appendChild(head);
      if (it.targetSummary) {
        var ts = el("div", "archive-item-target");
        if (it.targetSummary.kind === "event") {
          var ev = it.targetSummary.event || {};
          ts.textContent = "引用事件：" + (ev.action || "—") + " @ " + fmt(ev.at) +
            (ev.taskId ? "（任务 " + ev.taskId.slice(0, 8) + "）" : "");
        } else {
          var rr = it.targetSummary.result || {};
          ts.textContent = "引用逐条结果：" + (rr.result || "—") +
            (rr.reason ? "（" + rr.reason + "）" : "");
        }
        row.appendChild(ts);
      }
      if (it.conclusion) {
        row.appendChild(el("div", "archive-item-conclusion",
          (RESULT_LABELS[it.conclusion.result] || it.conclusion.result) +
          (it.conclusion.note ? "：" + it.conclusion.note : "") +
          " — " + it.conclusion.by + " @ " + fmt(it.conclusion.at)));
      }
      if (it.conflict) {
        row.appendChild(el("div", "archive-item-conflict",
          "冲突（" + it.conflict.code + "）：" + (it.conflict.message || "") +
          " — " + (it.conflict.by || "—") + " @ " + fmt(it.conflict.at)));
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  function opinionSummaryBlock(s) {
    if (!s) return el("div");
    var wrap = el("div", "archive-opinions");
    wrap.appendChild(el("h4", null, "当前意见摘要（归档瞬间，共 " + s.total + "）"));
    var counts = el("div", "archive-opinion-counts");
    Object.keys(s.byStatus || {}).forEach(function (k) {
      var n = s.byStatus[k];
      if (!n) return;
      var labelMap = { open: "待复核", in_review: "复核中", confirmed: "已确认",
        returned: "已退回", closed: "已关闭" };
      counts.appendChild(el("span", "archive-opinion-chip",
        (labelMap[k] || k) + " " + n));
    });
    if (s.overdue) counts.appendChild(el("span", "archive-opinion-chip overdue", "逾期 " + s.overdue));
    wrap.appendChild(counts);
    return wrap;
  }

  function timelineBlock(timeline) {
    var wrap = el("div", "archive-timeline");
    wrap.appendChild(el("h4", null, "完整时间线（" + (timeline || []).length + " 条，按时间升序）"));
    var ul = el("ul", "archive-timeline-list");
    (timeline || []).forEach(function (e) {
      var li = el("li", "tl-" + e.kind);
      var kindLabel = e.kind === "session" ? "会话" : "意见";
      var actMap = {
        create: "创建", conclusion: "提交结论", conflict: "冲突标记",
        update: "修改", close: "关闭", reassign: "转派"
      };
      var text = fmt(e.at) + " [" + kindLabel + "·" + (actMap[e.action] || e.action) + "] " +
        (e.actor || "—");
      if (e.reviewId) text += " → 意见 " + e.reviewId.slice(0, 8);
      li.textContent = text;
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    return wrap;
  }

  function downloadArchive(id, name) {
    var a = document.createElement("a");
    a.href = "/api/replay/archives/" + id + "/download";
    a.download = "session-archive-" + (name || id.slice(0, 8)) + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    toast("归档下载是只读操作，不改变归档、空间与线上数据");
  }

  /* ================= 先预览再恢复 ================= */

  function previewThenRestore(a, onDone) {
    var box = el("div");
    box.appendChild(el("div", "replay-empty", "正在校验归档完整性、重复标识、缺失引用、" +
      "锁定内容指纹与目标空间冲突…"));
    var modal = openModal("恢复预览 · " + (a.sessionName || a.id), box, {
      buttons: [button("取消", null, function () {})]
    });

    api("POST", "/api/replay/archives/" + a.id + "/preview", { actor: "负责人" })
      .then(function (r) {
        box.innerHTML = "";
        var d = r.data;
        box.appendChild(verificationBlock(d.checks));
        var t = d.target || {};
        var g = el("div", "archive-grid");
        function cell(label, value) {
          var c = el("div", "archive-cell");
          c.appendChild(el("div", "archive-cell-label", label));
          c.appendChild(el("div", "archive-cell-value", value == null ? "—" : String(value)));
          return c;
        }
        g.appendChild(cell("将创建的新空间名称", t.name));
        g.appendChild(cell("新包标识", t.packageId));
        g.appendChild(cell("源包标识", t.originPackageId));
        g.appendChild(cell("内容哈希", t.contentHash));
        g.appendChild(cell("事件链头", t.chainHead));
        g.appendChild(cell("事件数", t.eventCount));
        g.appendChild(cell("带入意见", (d.archive.manifest || {}).reviewCount));
        box.appendChild(g);
        box.appendChild(el("p", "replay-hint",
          "恢复会创建一个新的回放空间：锁定历史内容只读（内容哈希与事件链头不变），" +
          "归档带入的历史会话只读，但可以在新空间继续创建新的复核会话。" +
          "任何校验失败都会整次拒绝且不写入。"));

        var nameInp = el("input");
        nameInp.type = "text";
        nameInp.value = t.name || "";
        nameInp.maxLength = 200;
        nameInp.style.width = "70%";
        var nameRow = el("div");
        nameRow.appendChild(el("label", null, "新空间名称："));
        nameRow.appendChild(nameInp);
        box.appendChild(nameRow);

        var btnRestore = button("② 确认恢复到新回放空间", "primary", function () {
          btnRestore.disabled = true;
          btnRestore.textContent = "恢复中…";
          api("POST", "/api/replay/archives/" + a.id + "/restore",
            { actor: "负责人", name: nameInp.value.trim() })
            .then(function (rr) {
              modal.setTitle("恢复成功");
              box.innerHTML = "";
              box.appendChild(el("p", null,
                "已创建新回放空间：" + rr.data.space.name + "（" + rr.data.space.id.slice(0, 8) + "）"));
              box.appendChild(el("p", "replay-hint",
                "历史内容只读；归档会话只读；可继续创建新的复核会话。"));
              var openNew = button("打开新回放空间", "primary", function () {
                modal.close();
                if (window.ReplayUI) window.ReplayUI.openCenter();
              });
              var line = el("div");
              line.appendChild(openNew);
              box.appendChild(line);
              modal.foot.innerHTML = "";
              modal.foot.appendChild(button("关闭", null, function () {}));
              if (onDone) onDone(rr.data.space.id);
            })
            .catch(function (e) {
              btnRestore.disabled = false;
              btnRestore.textContent = "② 确认恢复到新回放空间";
              toast("恢复已整次拒绝（未写入任何空间/归档）：" + e.message, "error");
            });
        });
        modal.foot.innerHTML = "";
        modal.foot.appendChild(btnRestore);
        modal.foot.appendChild(button("取消", null, function () {}));
      })
      .catch(function (e) {
        box.innerHTML = "";
        var warn = el("div", "archive-preview-bad");
        warn.appendChild(el("strong", null, "预览未通过，恢复被整次拒绝（未写入任何数据）"));
        warn.appendChild(el("div", null, "错误：" + (e.code || "") + " " + e.message));
        if (e.data && e.data.existingSpaceId) {
          warn.appendChild(el("div", null, "冲突空间：" + e.data.existingSpaceId));
        }
        if (e.data && e.data.errors && e.data.errors.length) {
          var ul = el("ul");
          e.data.errors.slice(0, 10).forEach(function (m) { ul.appendChild(el("li", null, m)); });
          warn.appendChild(ul);
        }
        box.appendChild(warn);
      });
  }

  /* ================= 操作记录 ================= */

  function openLogs() {
    var box = el("div");
    box.appendChild(el("div", "replay-empty", "加载中…"));
    var ui = openModal("归档中心操作记录", box, {
      buttons: [button("关闭", null, function () {})]
    });
    api("GET", "/api/replay/archives/logs").then(function (r) {
      box.innerHTML = "";
      var ul = el("ul", "archive-logs-list");
      r.data.logs.forEach(function (l) {
        var li = el("li", l.ok ? "log-ok" : "log-bad");
        var labelMap = { create: "生成归档", preview: "恢复预览",
          restore: "恢复", filter: "保存筛选" };
        var parts = [fmt(l.at), "[" + (labelMap[l.action] || l.action) + "]",
          (l.ok ? "成功" : "失败"), l.actor || "—"];
        if (l.archiveId) parts.push("归档 " + l.archiveId.slice(0, 10));
        if (l.newSpaceId) parts.push("→ 新空间 " + l.newSpaceId.slice(0, 8));
        if (!l.ok && l.code) parts.push("（" + l.code + "）");
        li.textContent = parts.join(" ");
        if (!l.ok && l.message) li.appendChild(el("div", "log-detail", l.message));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }).catch(function (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "replay-empty", "操作记录加载失败：" + e.message));
    });
  }

  /* ---------- 挂载入口 ---------- */

  function init() {
    var btn = $("archive-open-btn");
    if (!btn) return;
    btn.title = "把已完成/已过期的复核会话生成不可变归档，并可先预览再恢复到新回放空间";
    btn.addEventListener("click", openArchiveCenter);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.ReplayArchiveUI = {
    openCenter: openArchiveCenter,
    openCreate: openCreateArchive,
    openDetail: openArchiveDetail
  };
})();
