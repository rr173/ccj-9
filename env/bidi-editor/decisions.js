/* decisions.js
 * 审阅决策 UI：从未归档批次创建决策草案、逐条填写保留/替换/删除方案、
 * 按段落执行前预览、多人逐条投票（通过/驳回/弃权）、部分成功执行与撤销、
 * 按时间查看决策记录、查看历史快照中当时的草案状态。
 *
 * 并发模型：本地缓存决策集合版本 rev（X-Decision-Rev），所有变更带
 * If-Match: <rev>；服务端严格相等校验，多人同时修改草案时旧页面提交必被
 * 409 version_conflict 拒绝——弹窗内表单内容保留，按最新数据重绘后重试。
 *
 * 三版本校验在服务端：执行时把编辑区当前段落随请求回传，服务端比对草案
 * 创建时的文本指纹、每条批注的 updatedAt 与批次成员归属，只把受影响条目
 * 标为冲突；前端只负责展示冲突、绝不把冲突条目的新文字覆盖掉。
 *
 * ★ 中阿混排：引文/替换文本一律 <bdi> 隔离，位置标签固定 dir=ltr。
 */
(function () {
  "use strict";

  var core = window.DecisionCore;
  var Editor = window.Editor;

  var state = {
    rev: null,
    items: [],
    filterStatus: "",
    lastAnnRev: null,
    lastBatchRev: null,
    tasks: []
  };

  // 剩余时间（毫秒）；过去返回 0
  function remainMs(scheduledAtMs) {
    return Math.max(0, Number(scheduledAtMs) - Date.now());
  }
  function formatRemain(ms) {
    if (!ms || ms <= 0) return "即将执行";
    var s = Math.round(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return "剩余 " + d + " 天 " + h + " 小时";
    if (h > 0) return "剩余 " + h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return "剩余 " + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  // datetime-local 输入框初值：本地时区，step=1
  function localDTInputValue(d) {
    d = d || new Date(Date.now() + 60 * 1000);
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

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
    b.textContent = text == null ? "" : text;
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
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      var rev = res.headers.get("X-Decision-Rev");
      var annRev = res.headers.get("X-Annotation-Rev");
      var batchRev = res.headers.get("X-Batch-Rev");
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
        if (rev != null) state.rev = parseInt(rev, 10);
        // 执行/撤销会推进批注与批次集合：仅在版本确实变化时通知对应面板静默刷新，
        // 避免决策列表的轮询 GET 反复触发其他面板刷新。
        if (annRev != null && annRev !== String(state.lastAnnRev)) {
          state.lastAnnRev = annRev;
          if (window.ReviewUI) window.ReviewUI.reload(true);
        }
        if (batchRev != null && batchRev !== String(state.lastBatchRev)) {
          state.lastBatchRev = batchRev;
          if (window.ReviewBatchesUI) window.ReviewBatchesUI.reload(true);
        }
        return { data: data, rev: rev != null ? parseInt(rev, 10) : null };
      });
    });
  }

  /* ---------- 标签 ---------- */

  var STATUS_CLASS = {
    drafting: "dc-drafting", voting: "dc-voting",
    ready: "dc-ready", scheduled: "dc-scheduled", executed: "dc-executed"
  };
  var TASK_STATUS_CLASS = {
    scheduled: "tk-scheduled", paused: "tk-paused", running: "tk-running",
    succeeded: "tk-succeeded", partial: "tk-partial", failed: "tk-failed",
    blocked: "tk-blocked", cancelled: "tk-cancelled"
  };
  function statusLabel(s) { return core.STATUS_LABELS[s] || s; }
  function taskStatusLabel(s) { return core.TASK_STATUS_LABELS[s] || s; }
  function dispositionLabel(d) { return d ? core.DISPOSITION_LABELS[d] : "未定"; }
  function voteLabel(v) { return core.VOTE_LABELS[v] || v; }
  var ITEM_STATE_CLASS = {
    pending: "dc-it-pending", waiting: "dc-it-waiting",
    rejected: "dc-it-rejected", approved: "dc-it-approved"
  };
  function itemStateLabel(s) { return core.ITEM_STATE_LABELS[s] || s; }
  function reasonLabel(r) { return core.REASON_LABELS[r] || r; }
  function resultLabel(r) { return core.RESULT_LABELS[r] || r; }
  function savedActor() {
    try { return localStorage.getItem("review-author") || ""; } catch (e) { return ""; }
  }
  function rememberActor(name) {
    try { localStorage.setItem("review-author", name); } catch (e) {}
  }

  /* ---------- 列表 ---------- */

  var listBox = $("decision-list");
  var note = $("decision-note");
  var revLabel = $("decision-rev");
  var filterSel = $("decision-filter-status");

  function setNote(text, isError) {
    note.textContent = text || "";
    note.className = "snap-note" + (isError ? " is-error" : "");
  }

  function loadList(silent) {
    if (!silent) setNote("正在加载决策草案……");
    return Promise.all([
      api("GET", "/api/review-decisions"),
      api("GET", "/api/execution-tasks")
    ]).then(function (rs) {
      state.items = (rs[0].data && rs[0].data.decisions) || [];
      state.rev = rs[0].rev != null ? rs[0].rev : (rs[0].data && rs[0].data.rev);
      state.tasks = (rs[1].data && rs[1].data.tasks) || [];
      render();
      setNote("");
    }).catch(function (err) {
      setNote("无法加载决策草案（" + err.message + "），编辑与其他面板不受影响。", true);
    });
  }

  function render() {
    revLabel.textContent = "版本 " + (state.rev == null ? "—" : state.rev);
    listBox.innerHTML = "";
    var activeTasks = state.tasks.filter(function (t) {
      return t.status === "scheduled" || t.status === "paused" || t.status === "running";
    });
    if (activeTasks.length) listBox.appendChild(renderQueue(activeTasks));
    var items = state.items.filter(function (d) {
      return !state.filterStatus || d.status === state.filterStatus;
    });
    if (!items.length) {
      listBox.appendChild(el("div", "review-empty",
        state.items.length
          ? "当前筛选条件下没有决策草案。"
          : "尚无决策草案。在未归档批次中为每条批注填写保留/替换/删除方案，" +
            "投票达到通过人数后即可执行。"));
      return;
    }
    items.forEach(function (d) { listBox.appendChild(renderCard(d)); });
  }

  /* ---------- 执行队列 ---------- */

  function renderQueue(tasks) {
    var box = el("div", "task-queue");
    var head = el("div", "task-queue-head");
    head.appendChild(el("span", "task-queue-title", "⏰ 执行队列（" + tasks.length + "）"));
    head.appendChild(button("查看全部/记录…", "btn-mini", function () { openQueuePanel(); }));
    box.appendChild(head);
    tasks.forEach(function (t) { box.appendChild(renderTaskCard(t, true)); });
    return box;
  }

  // 前置门控：等待原因 + 审批进度（活动任务才有意义）
  var GATE_CLASS = {
    ready: "tk-gate-ready", waiting: "tk-gate-waiting",
    can_continue: "tk-gate-continue", blocked: "tk-gate-blocked",
    approvals: "tk-gate-approval", rejected: "tk-gate-rejected"
  };
  function gateLabel(g) { return core.GATE_STATE_LABELS[g] || g; }
  function describeGate(t) {
    var g = t.gate;
    if (!g || g.state === "ready") return "";
    var b = g.blockingDependency;
    if (g.state === "approvals") {
      return "等待执行前审批（已通过 " + g.approval.approved + "/" +
        g.approval.minApprovals + "，待审 " + g.approval.pending + " 人）";
    }
    if (g.state === "rejected") return "执行前审批已被拒绝（撤回拒绝并补足通过后可继续）";
    if (g.state === "can_continue") {
      return "前置任务“" + (b ? b.decisionName : "—") + "”仅部分成功，需负责人确认继续";
    }
    if (g.state === "waiting") {
      if (g.reason === "dependency_failed") {
        return "前置任务“" + (b ? b.decisionName : "—") + "”执行失败，等待其重试成功";
      }
      if (g.reason === "dependency_active") {
        return "等待前置任务“" + (b ? b.decisionName : "—") + "”执行完成";
      }
      return "等待前置任务满足条件";
    }
    if (g.state === "blocked") {
      if (g.reason === "dependency_cancelled") {
        return "前置任务“" + (b ? b.decisionName : "—") + "”已取消，任务被阻断";
      }
      if (g.reason === "dependency_blocked") {
        return "前置任务“" + (b ? b.decisionName : "—") + "”已阻断，任务被阻断";
      }
      if (g.reason === "approval_rejected" || b && b.via) {
        return "前置链上存在未通过条件（经“" + (b ? b.decisionName : "—") + "”），任务被阻断";
      }
      return "前置条件未通过，任务被阻断";
    }
    return gateLabel(g.state);
  }

  function renderTaskGate(t) {
    var box = el("div", "task-gate");
    var g = t.gate;
    if (!g || (t.status !== "scheduled" && t.status !== "paused")) return box;
    var line = el("div", "task-gate-line " + (GATE_CLASS[g.state] || ""));
    var dot = el("span", "task-gate-dot");
    line.appendChild(dot);
    line.appendChild(el("span", null,
      g.state === "ready" ? "前置条件已满足，到点自动执行" : describeGate(t)));
    box.appendChild(line);

    // 前置任务清单
    if ((t.dependencyIds || []).length) {
      var deps = el("div", "task-gate-deps");
      (g.dependencies || []).forEach(function (r) {
        var chip = el("span", "task-dep-chip dep-" + r.gate);
        chip.appendChild(bdi(r.decisionName || r.taskId.slice(0, 8)));
        chip.appendChild(document.createTextNode("：" +
          (core.GATE_STATE_LABELS[depGateLabel(r.gate)] || depGateLabel(r.gate)) +
          (r.confirmed ? "（已确认继续）" : "")));
        deps.appendChild(chip);
      });
      box.appendChild(deps);
    }
    // 审批进度（逐人）
    if (g.approval) {
      var ap = el("div", "task-gate-approvals");
      g.approval.approvers.forEach(function (name) {
        var v = g.approval.byApprover[name];
        var cls = "approver-pill ap-" + (v || "pending");
        var pill = el("span", cls);
        pill.appendChild(bdi(name));
        pill.appendChild(document.createTextNode(v === "approve" ? " ✓" :
          v === "reject" ? " ✗" : " 待审"));
        ap.appendChild(pill);
      });
      box.appendChild(ap);
    }
    return box;
  }
  // 依赖行门控枚举到中文标签（dep 行使用 gate 取值，含 ready）
  function depGateLabel(g) {
    return { ready: "可继续", waiting: "等待", can_continue: "部分成功待确认",
             blocked: "阻断", unknown: "未知" }[g] || g;
  }

  function renderTaskCard(t, compact) {
    var card = el("div", "task-card task-" + t.status);
    var row1 = el("div", "task-row task-row-main");
    var name = el("span", "task-name");
    name.appendChild(bdi(t.decisionName));
    row1.appendChild(name);
    row1.appendChild(el("span", "task-status " + TASK_STATUS_CLASS[t.status],
      taskStatusLabel(t.status)));
    if (t.status === "scheduled" || t.status === "paused") {
      var remain = el("span", "task-remain" + (t.status === "paused" ? " is-paused" : ""));
      remain.setAttribute("dir", "ltr");
      remain.dataset.taskRemain = String(t.scheduledAtMs);
      remain.dataset.taskStatus = t.status;
      remain.textContent = t.status === "paused" ? "已暂停" : formatRemain(remainMs(t.scheduledAtMs));
      row1.appendChild(remain);
    }
    card.appendChild(row1);

    var meta = el("div", "task-meta");
    meta.setAttribute("dir", "ltr");
    meta.textContent = "计划 " + formatTime(t.scheduledAt) +
      " · 发布 " + formatTime(t.publishedAt) +
      " · 发布人 " + (t.publishedBy || "匿名");
    card.appendChild(meta);

    if (t.lock) {
      var lock = el("div", "task-lock");
      lock.setAttribute("dir", "ltr");
      lock.textContent = "已锁定：文本 " + (t.lock.textRev || "—").slice(0, 8) +
        "（" + t.lock.paragraphCount + " 段）· 批注 v" + t.lock.annotationRev +
        " · 批次 v" + t.lock.batchRev;
      card.appendChild(lock);
    }
    card.appendChild(renderTaskGate(t));
    if (t.status === "partial" || t.status === "failed" || t.status === "blocked" ||
        t.status === "succeeded") {
      var r = el("div", "task-meta");
      r.textContent = (t.status === "succeeded" ? "全部成功" :
        t.status === "blocked" ? "阻断原因：" + (t.blockReason || "") :
        "结束于 " + formatTime(t.finishedAt)) +
        (t.lastCounts ? "（成功 " + t.lastCounts.success + " / 冲突 " +
          t.lastCounts.conflict + " / 跳过 " + t.lastCounts.skipped + "）" : "");
      card.appendChild(r);
    }

    var gate = t.gate;
    var needsContinue = gate && gate.state === "can_continue";
    if (!compact) {
      var acts = el("div", "task-actions");
      if (t.status === "scheduled") {
        acts.appendChild(button("暂停", "btn-mini", function () { taskPause(t); }));
        acts.appendChild(button("取消", "btn-mini danger", function () { taskCancel(t); }));
      } else if (t.status === "paused") {
        acts.appendChild(button("恢复…", "btn-mini primary", function () { taskResume(t); }));
        acts.appendChild(button("取消", "btn-mini danger", function () { taskCancel(t); }));
      }
      if (needsContinue) {
        acts.appendChild(button("确认继续", "btn-mini primary",
          function () { taskContinue(t); }));
      }
      if (gate && gate.approval) {
        acts.appendChild(button("审批…", "btn-mini primary",
          function () { openApprovalDialog(t); }));
      }
      if (t.status === "scheduled" || t.status === "paused") {
        acts.appendChild(button("前置/审批配置…", "btn-mini",
          function () { openTaskConfig(t); }));
      }
      if (t.status === "partial" || t.status === "failed" || t.status === "blocked") {
        acts.appendChild(button("失败重试…", "btn-mini primary", function () { taskRetry(t); }));
      }
      acts.appendChild(button("队列记录", "btn-mini", function () { openTaskLogs(t); }));
      acts.appendChild(button("打开草案", "btn-mini", function () { openDetail(t.decisionId); }));
      card.appendChild(acts);
    } else {
      var mini = el("div", "task-actions");
      if (t.status === "scheduled") {
        mini.appendChild(button("暂停", "btn-mini", function () { taskPause(t); }));
        mini.appendChild(button("取消", "btn-mini danger", function () { taskCancel(t); }));
      } else if (t.status === "paused") {
        mini.appendChild(button("恢复…", "btn-mini primary", function () { taskResume(t); }));
        mini.appendChild(button("取消", "btn-mini danger", function () { taskCancel(t); }));
      }
      if (needsContinue) {
        mini.appendChild(button("确认继续", "btn-mini primary",
          function () { taskContinue(t); }));
      }
      if (gate && gate.approval) {
        mini.appendChild(button("审批…", "btn-mini primary",
          function () { openApprovalDialog(t); }));
      }
      mini.appendChild(button("详情", "btn-mini", function () { openQueuePanel(t.id); }));
      card.appendChild(mini);
    }
    return card;
  }

  // 每秒刷新剩余时间，到点后静默重新加载（自动执行结果由服务端轮询拿到）
  setInterval(function () {
    var nodes = document.querySelectorAll("[data-task-remain]");
    var due = false;
    Array.prototype.forEach.call(nodes, function (n) {
      if (n.dataset.taskStatus === "paused") { n.textContent = "已暂停"; return; }
      var ms = remainMs(Number(n.dataset.taskRemain));
      n.textContent = formatRemain(ms);
      if (ms <= 0) due = true;
    });
    if (due && !document.hidden) loadList(true);
  }, 1000);

  function openQueuePanel(focusTaskId) {
    var box = el("div", "task-panel-box");
    var filterBar = el("div", "batch-log-filter");
    var sel = document.createElement("select");
    [["", "全部任务"], ["scheduled", "等待生效"], ["paused", "已暂停"],
     ["succeeded", "全部成功"], ["partial", "部分成功"],
     ["failed", "失败"], ["blocked", "已阻断"], ["cancelled", "已取消"]]
      .forEach(function (p) {
        var o = el("option", null, p[1]); o.value = p[0]; sel.appendChild(o);
      });
    filterBar.appendChild(sel);
    var refreshBtn = button("刷新", null, null);
    filterBar.appendChild(refreshBtn);
    box.appendChild(filterBar);
    var list = el("div", "task-full-list");
    box.appendChild(list);

    var m = openModal("决策执行队列", box, {
      buttons: [button("关闭", null, function () { m.close(); })]
    });
    function draw() {
      api("GET", "/api/execution-tasks" + (sel.value ? "?status=" + sel.value : ""))
        .then(function (r) {
          var tasks = (r.data && r.data.tasks) || [];
          list.innerHTML = "";
          if (!tasks.length) {
            list.appendChild(el("div", "review-empty", "该状态下没有执行队列任务。"));
            return;
          }
          tasks.forEach(function (t) {
            var c = renderTaskCard(t, false);
            if (t.id === focusTaskId) c.classList.add("is-focus");
            list.appendChild(c);
          });
        }).catch(function (e) {
          list.innerHTML = "";
          list.appendChild(el("div", "composer-error", "加载执行队列失败：" + e.message));
        });
    }
    sel.addEventListener("change", draw);
    refreshBtn.addEventListener("click", draw);
    draw();
  }

  /* ---------- 发布到执行队列 ---------- */

  function openPublishDialog(decisionId) {
    var box = el("div", "decision-composer");
    var errLine = el("div", "composer-error");
    errLine.setAttribute("role", "alert");

    // 先读草案详情，确保在最新数据上发布；同时读队列供选择前置任务
    Promise.all([
      api("GET", "/api/review-decisions/" + decisionId),
      api("GET", "/api/execution-tasks")
    ]).then(function (rs) {
      var data = rs[0].data;
      var allTasks = (rs[1].data && rs[1].data.tasks) || [];
      var d = data.decision;
      if (d.status !== "ready") {
        errLine.textContent = "只有“待执行”草案可以发布，当前状态：" + statusLabel(d.status);
      }
      box.appendChild(el("p", "muted",
        "发布后，草案的方案、批注与批次版本将被锁定，服务端会在你指定的生效时间自动执行。" +
        "到点时仍会逐条校验文本、批注和批次：冲突条目不会覆盖新内容，其余条目照常完成。" +
        "执行结果会自动保存快照并和任务关联。"));

      var timeInput = document.createElement("input");
      timeInput.type = "datetime-local";
      timeInput.step = "1";
      timeInput.className = "composer-author";
      timeInput.value = localDTInputValue();
      box.appendChild(labeled("生效时间（必须晚于现在）", timeInput));

      if (d.deadline) {
        box.appendChild(el("p", "muted", "批次截止时间：" + formatTime(d.deadline) +
          "（生效时间必须更早，否则到点会被过期阻断）"));
      }

      var actorInput = document.createElement("input");
      actorInput.type = "text";
      actorInput.className = "composer-author";
      actorInput.maxLength = 50;
      actorInput.placeholder = "发布者署名（可选，默认匿名/系统记录）";
      actorInput.value = savedActor();
      box.appendChild(labeled("发布负责人", actorInput));

      // 可选前置任务：只允许选择其他草案的任务
      var depChecks = Object.create(null);
      var depCandidates = allTasks.filter(function (x) {
        return x.decisionId !== decisionId;
      });
      if (depCandidates.length) {
        var depBox = el("div", "dc-dep-list");
        depCandidates.forEach(function (c) {
          var lab = el("label", "batch-field dc-dep-option");
          var cb = document.createElement("input");
          cb.type = "checkbox";
          depChecks[c.id] = cb;
          lab.appendChild(cb);
          var txt = el("span");
          txt.appendChild(bdi(c.decisionName));
          txt.appendChild(document.createTextNode("（" + taskStatusLabel(c.status) +
            "，计划 " + formatTime(c.scheduledAt) + "）"));
          lab.appendChild(txt);
          depBox.appendChild(lab);
        });
        box.appendChild(labeled("前置任务（可选；全部成功后才执行）", depBox));
      }
      var approversInput = document.createElement("input");
      approversInput.type = "text";
      approversInput.className = "composer-author";
      approversInput.placeholder = "1~3 名审批人，逗号分隔；留空表示发布即不需审批";
      box.appendChild(labeled("执行前审批人（可选）", approversInput));
      var minInput = document.createElement("input");
      minInput.type = "number";
      minInput.min = "1"; minInput.max = "3"; minInput.step = "1";
      minInput.className = "composer-author";
      minInput.placeholder = "最少通过人数，留空=全体审批人";
      box.appendChild(labeled("审批最少通过人数（可选）", minInput));

      box.appendChild(errLine);

      var okBtn;
      var m = openModal("发布到执行队列：" + d.name, box, {
        buttons: [
          button("取消", null, function () { m.close(); }),
          (okBtn = button("确认发布并锁定", "primary", function () {
            errLine.textContent = "";
            if (!timeInput.value) {
              errLine.textContent = "必须指定未来的生效时间（表单内容已保留）。";
              return;
            }
            var when = new Date(timeInput.value);
            if (isNaN(when.getTime())) {
              errLine.textContent = "生效时间格式无法识别。";
              return;
            }
            if (when.getTime() <= Date.now()) {
              errLine.textContent = "生效时间必须晚于当前时间，请重新选择（表单内容已保留）。";
              return;
            }
            okBtn.disabled = true;
            var body = {
              decisionId: decisionId,
              scheduledAt: when.toISOString(),
              paragraphs: Editor.serialize().paragraphs,
              actor: actorInput.value
            };
            var depIds = Object.keys(depChecks).filter(function (id) {
              return depChecks[id].checked;
            });
            if (depIds.length) body.dependencies = depIds;
            var approverNames = approversInput.value.split(/[,，;；]/)
              .map(function (s) { return s.trim(); }).filter(Boolean);
            if (approverNames.length) {
              if (approverNames.length > 3) {
                errLine.textContent = "审批人最多 3 名（表单内容已保留）。";
                okBtn.disabled = false;
                return;
              }
              var min = minInput.value === "" ? approverNames.length
                : parseInt(minInput.value, 10);
              if (!(min >= 1 && min <= approverNames.length)) {
                errLine.textContent = "最少通过人数必须在 1 到审批人数之间。";
                okBtn.disabled = false;
                return;
              }
              body.approval = { approvers: approverNames, minApprovals: min };
            }
            api("POST", "/api/execution-tasks", body, { ifMatch: state.rev })
              .then(function (rr) {
              rememberActor(actorInput.value.trim());
              m.close();
              var g = rr.data.task.gate;
              toast("已发布到执行队列，计划 " + formatTime(rr.data.task.scheduledAt) +
                " 自动执行；方案、批注与批次版本已锁定" +
                (g && g.state !== "ready" ? "（当前：" +
                  (core.GATE_STATE_LABELS[g.state] || g.state) + "）" : ""));
              return loadList(true).then(function () { openQueuePanel(rr.data.task.id); });
            }).catch(function (e) {
              okBtn.disabled = false;
              handleError(e, function (msg) { errLine.textContent = msg; }, "发布");
            });
          }))
        ]
      });
      if (d.status !== "ready") okBtn.disabled = true;
    }).catch(function (e) {
      box.appendChild(el("div", "composer-error", "读取草案失败：" + e.message));
      openModal("发布到执行队列", box, {
        buttons: [button("关闭", null, function () {})]
      });
    });
  }

  function taskAction(t, action, body, label) {
    return api("POST", "/api/execution-tasks/" + t.id + "/" + action,
      body || { actor: savedActor() || undefined },
      { ifMatch: state.rev }).then(function (r) {
        toast(label + "成功");
        return loadList(true).then(function () { return r; });
      });
  }

  function taskPause(t) {
    taskAction(t, "pause", null, "暂停").catch(function (e) {
      toast("暂停失败：" + e.message, "error");
    });
  }

  function taskCancel(t) {
    if (!window.confirm("取消该定时执行任务吗？\n取消后草案回到“待执行”，可重新发布或手动执行。")) return;
    api("POST", "/api/execution-tasks/" + t.id + "/cancel",
      { actor: savedActor() || undefined }, { ifMatch: state.rev })
      .then(function () {
        toast("任务已取消，草案回到待执行");
        return loadList(true);
      }).catch(function (e) {
        if (e.status === 409 && e.code === "version_conflict") {
          toast("版本冲突：队列已被其他人更新，已刷新，请重试", "error");
          loadList(true);
        } else toast("取消失败：" + e.message, "error");
      });
  }

  function taskResume(t) {
    var box = el("div", "decision-composer");
    var errLine = el("div", "composer-error");
    box.appendChild(el("p", "muted",
      "不填新时间：若原计划时间还在未来则按原时间执行，已过则立即执行。填写新时间则按新时间执行。"));
    var timeInput = document.createElement("input");
    timeInput.type = "datetime-local";
    timeInput.step = "1";
    timeInput.className = "composer-author";
    box.appendChild(labeled("新生效时间（可选）", timeInput));
    box.appendChild(errLine);
    var okBtn;
    var m = openModal("恢复任务：" + t.decisionName, box, {
      buttons: [
        button("取消", null, function () { m.close(); }),
        (okBtn = button("恢复", "primary", function () {
          errLine.textContent = "";
          var body = { actor: savedActor() || undefined };
          if (timeInput.value) {
            var when = new Date(timeInput.value);
            if (isNaN(when.getTime())) { errLine.textContent = "时间格式无法识别"; return; }
            if (when.getTime() <= Date.now()) {
              errLine.textContent = "新生效时间必须晚于当前时间（表单内容已保留）";
              return;
            }
            body.scheduledAt = when.toISOString();
          }
          okBtn.disabled = true;
          api("POST", "/api/execution-tasks/" + t.id + "/resume", body,
            { ifMatch: state.rev }).then(function () {
              m.close();
              toast(body.scheduledAt ? "任务已按新时间恢复" : "任务已恢复");
              return loadList(true);
            }).catch(function (e) {
              okBtn.disabled = false;
              handleError(e, function (msg) { errLine.textContent = msg; }, "恢复");
            });
        }))
      ]
    });
  }

  function taskRetry(t) {
    var box = el("div", "decision-composer");
    var errLine = el("div", "composer-error");
    box.appendChild(el("p", "muted",
      "失败重试幂等：之前已经成功的条目不会重复处理，只继续完成剩余条目。" +
      "不选新时间将立即重试；可选择用当前编辑区文本重新锁定。"));
    var timeInput = document.createElement("input");
    timeInput.type = "datetime-local";
    timeInput.step = "1";
    timeInput.className = "composer-author";
    box.appendChild(labeled("重新排期时间（可选，不填=立即重试）", timeInput));
    var relockCb = document.createElement("input");
    relockCb.type = "checkbox";
    var relockLabel = el("label", "batch-field");
    relockLabel.appendChild(relockCb);
    relockLabel.appendChild(document.createTextNode(" 用当前编辑区文本重新锁定（默认沿用发布时锁定文本）"));
    box.appendChild(relockLabel);
    box.appendChild(errLine);
    var okBtn;
    var m = openModal("失败重试：" + t.decisionName, box, {
      buttons: [
        button("取消", null, function () { m.close(); }),
        (okBtn = button("重试", "primary", function () {
          errLine.textContent = "";
          var body = { actor: savedActor() || undefined };
          if (timeInput.value) {
            var when = new Date(timeInput.value);
            if (isNaN(when.getTime())) { errLine.textContent = "时间格式无法识别"; return; }
            if (when.getTime() <= Date.now()) {
              errLine.textContent = "重新排期时间必须晚于当前时间（表单内容已保留）";
              return;
            }
            body.scheduledAt = when.toISOString();
          }
          if (relockCb.checked) body.paragraphs = Editor.serialize().paragraphs;
          okBtn.disabled = true;
          api("POST", "/api/execution-tasks/" + t.id + "/retry", body,
            { ifMatch: state.rev }).then(function () {
              m.close();
              toast("已提交失败重试，成功条目不会重复处理");
              return loadList(true);
            }).catch(function (e) {
              okBtn.disabled = false;
              handleError(e, function (msg) { errLine.textContent = msg; }, "失败重试");
            });
        }))
      ]
    });
  }

  function openTaskLogs(t) {
    var box = el("div", "batch-logs");
    box.appendChild(el("p", "muted",
      "发布、暂停、恢复、取消、自动执行与失败重试全部记录在案，可按时间筛选。"));
    var filterBar = el("div", "batch-log-filter");
    var fromInput = document.createElement("input");
    fromInput.type = "datetime-local";
    var toInput = document.createElement("input");
    toInput.type = "datetime-local";
    var fromLabel = el("label", "batch-field");
    fromLabel.appendChild(el("span", "batch-field-label", "从"));
    fromLabel.appendChild(fromInput);
    var toLabel = el("label", "batch-field");
    toLabel.appendChild(el("span", "batch-field-label", "到"));
    toLabel.appendChild(toInput);
    filterBar.appendChild(fromLabel);
    filterBar.appendChild(toLabel);
    var list = el("div", "batch-log-list");
    box.appendChild(filterBar);
    box.appendChild(list);

    function fetchLogs() {
      var qs = [];
      if (fromInput.value) qs.push("from=" + encodeURIComponent(new Date(fromInput.value).toISOString()));
      if (toInput.value) qs.push("to=" + encodeURIComponent(new Date(toInput.value).toISOString()));
      list.innerHTML = "";
      list.appendChild(el("div", "muted", "正在加载队列记录……"));
      api("GET", "/api/execution-tasks/" + t.id + "/logs" + (qs.length ? "?" + qs.join("&") : ""))
        .then(function (r) {
          list.innerHTML = "";
          var logs = (r.data && r.data.logs) || [];
          if (!logs.length) {
            list.appendChild(el("div", "review-empty", "该时间范围内没有队列记录。"));
            return;
          }
          logs.forEach(function (l) {
            var item = el("div", "log-item log-" + l.action);
            var h = el("div", "log-head");
            h.setAttribute("dir", "ltr");
            h.appendChild(el("span", "log-time", formatTime(l.at)));
            h.appendChild(document.createTextNode(" · "));
            h.appendChild(el("span", "log-action", TASK_ACTION_LABELS[l.action] || l.action));
            h.appendChild(document.createTextNode(" · "));
            var actor = el("span"); actor.appendChild(bdi(l.actor || "匿名"));
            h.appendChild(actor);
            item.appendChild(h);
            if (l.detail) {
              var det = el("div", "log-detail");
              det.appendChild(bdi(l.detail));
              item.appendChild(det);
            }
            list.appendChild(item);
          });
        }).catch(function (e) {
          list.innerHTML = "";
          list.appendChild(el("div", "composer-error", "读取队列记录失败：" + e.message));
        });
    }
    fromInput.addEventListener("change", fetchLogs);
    toInput.addEventListener("change", fetchLogs);
    var m = openModal("队列记录：" + t.decisionName, box, {
      buttons: [
        button("按时间筛选", null, fetchLogs),
        button("清除时间范围", null, function () { fromInput.value = ""; toInput.value = ""; fetchLogs(); }),
        button("关闭", null, function () { m.close(); })
      ]
    });
    fetchLogs();
  }

  /* ---------- 确认继续（前置部分成功） ---------- */

  function taskContinue(t) {
    if (!window.confirm(
        "前置任务仅部分成功。确认接受其结果并继续执行“" + t.decisionName +
        "”吗？\n其余前置条件满足后，任务将在计划时间执行（仅放行一次）。")) return;
    api("POST", "/api/execution-tasks/" + t.id + "/continue",
      { actor: savedActor() || "负责人" }, { ifMatch: state.rev })
      .then(function () {
        toast("已确认继续，前置条件全部满足后将自动执行");
        return loadList(true);
      }).catch(function (e) {
        if (e.status === 409 && e.code === "version_conflict") {
          toast("版本冲突：队列已被其他人更新，已刷新，请重试", "error");
          loadList(true);
        } else toast("确认继续失败：" + e.message, "error");
      });
  }

  /* ---------- 执行前审批 ---------- */

  function openApprovalDialog(t) {
    var box = el("div", "decision-composer");
    var errLine = el("div", "composer-error");
    api("GET", "/api/execution-tasks/" + t.id).then(function (r) {
      var cur = r.data.task;
      var g = cur.gate;
      box.appendChild(el("p", "muted",
        "该任务配置了执行前审批：至少 " + g.approval.minApprovals +
        " 名审批人通过，且没有拒绝，任务才会在计划时间执行。任一审批人拒绝即阻断，" +
        "拒绝可由本人撤回。"));

      var prog = el("div", "dc-approval-progress");
      prog.textContent = "当前：已通过 " + g.approval.approved + "/" +
        g.approval.minApprovals + " · 拒绝 " + g.approval.rejected +
        " · 待审 " + g.approval.pending;
      box.appendChild(prog);

      var rowsBox = el("div", "dc-approval-rows");
      g.approval.approvers.forEach(function (name) {
        var v = g.approval.byApprover[name];
        var row = el("div", "dc-approval-row");
        var who = el("span", "dc-approval-name");
        who.appendChild(bdi(name));
        row.appendChild(who);
        row.appendChild(el("span", "ap-state ap-state-" + (v || "pending"),
          v === "approve" ? "已通过" : v === "reject" ? "已拒绝" : "待审批"));
        rowsBox.appendChild(row);
      });
      box.appendChild(rowsBox);

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "composer-author";
      nameInput.maxLength = 50;
      nameInput.placeholder = "我的审批人署名（必须是指定审批人）";
      nameInput.value = savedActor();
      box.appendChild(labeled("审批人署名", nameInput));
      box.appendChild(errLine);

      function refresh() {
        return api("GET", "/api/execution-tasks/" + t.id).then(function (rr) {
          m.close();
          openApprovalDialog(rr.data.task);
          return loadList(true);
        });
      }
      function decide(decision, label) {
        errLine.textContent = "";
        if (!nameInput.value.trim()) {
          errLine.textContent = "必须填写审批人署名。";
          return;
        }
        api("POST", "/api/execution-tasks/" + t.id + "/approvals",
          { approver: nameInput.value.trim(), decision: decision })
          .then(function () {
            rememberActor(nameInput.value.trim());
            toast(label + "已记录");
            refresh();
          }).catch(function (e) {
            if (e.status === 409 && e.code === "version_conflict") loadList(true);
            errLine.textContent = e.message;
          });
      }
      function withdraw() {
        errLine.textContent = "";
        if (!nameInput.value.trim()) {
          errLine.textContent = "必须填写审批人署名。";
          return;
        }
        api("POST", "/api/execution-tasks/" + t.id + "/approvals/" +
            encodeURIComponent(nameInput.value.trim()) + "/withdraw", {})
          .then(function () {
            toast("已撤回审批决定");
            refresh();
          }).catch(function (e) { errLine.textContent = e.message; });
      }

      var m = openModal("执行前审批：" + cur.decisionName, box, {
        buttons: [
          button("通过", "primary", function () { decide("approve", "通过"); }),
          button("拒绝", "danger", function () { decide("reject", "拒绝"); }),
          button("撤回我的决定", null, withdraw),
          button("关闭", null, function () { m.close(); })
        ]
      });
    }).catch(function (e) {
      box.appendChild(el("div", "composer-error", "读取任务失败：" + e.message));
      openModal("执行前审批", box, { buttons: [button("关闭", null, function () {})] });
    });
  }

  /* ---------- 前置任务与审批配置 ---------- */

  function openTaskConfig(t) {
    var box = el("div", "decision-composer");
    var errLine = el("div", "composer-error");
    errLine.setAttribute("role", "alert");

    // 加载全部任务供选择前置（不能选自己）
    api("GET", "/api/execution-tasks").then(function (r) {
      var all = (r.data && r.data.tasks) || [];
      var candidates = all.filter(function (x) {
        return x.id !== t.id && x.status !== "running";
      });

      box.appendChild(el("p", "muted",
        "为尚未开始的任务配置前置任务（1 个或多个）与执行前审批（1~3 名审批人）。" +
        "只有全部前置任务已成功（部分成功需确认）且审批达到最少通过人数，任务才会在计划时间执行。" +
        "修改审批人或门槛会重置已有审批。"));

      var depBox = el("div", "dc-dep-list");
      var checks = Object.create(null);
      if (!candidates.length) {
        depBox.appendChild(el("div", "review-empty", "队列中没有可作为前置的其他任务。"));
      }
      candidates.forEach(function (c) {
        var lab = el("label", "batch-field dc-dep-option");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        if ((t.dependencyIds || []).indexOf(c.id) !== -1) cb.checked = true;
        checks[c.id] = cb;
        lab.appendChild(cb);
        var txt = el("span");
        txt.appendChild(bdi(c.decisionName));
        txt.appendChild(document.createTextNode("（" + taskStatusLabel(c.status) + "）"));
        lab.appendChild(txt);
        depBox.appendChild(lab);
      });
      box.appendChild(labeled("前置任务（不选表示无前置）", depBox));

      var approversInput = document.createElement("input");
      approversInput.type = "text";
      approversInput.className = "composer-author";
      approversInput.placeholder = "多个审批人用逗号分隔，留空表示不要求审批";
      approversInput.value = t.approval ? t.approval.approvers.join("，") : "";
      box.appendChild(labeled("审批人（1~3 名，逗号分隔）", approversInput));

      var minInput = document.createElement("input");
      minInput.type = "number";
      minInput.min = "1"; minInput.max = "3"; minInput.step = "1";
      minInput.className = "composer-author";
      minInput.placeholder = "最少通过人数";
      minInput.value = t.approval ? t.approval.minApprovals : "";
      box.appendChild(labeled("最少通过人数", minInput));
      box.appendChild(errLine);

      var m = openModal("前置与审批配置：" + t.decisionName, box, {
        buttons: [
          button("取消", null, function () { m.close(); }),
          button("保存配置", "primary", function () {
            errLine.textContent = "";
            var deps = Object.keys(checks).filter(function (id) {
              return checks[id].checked;
            });
            var names = approversInput.value.split(/[,，;；]/)
              .map(function (s) { return s.trim(); })
              .filter(Boolean);
            if (names.length > 3) {
              errLine.textContent = "审批人最多 3 名。";
              return;
            }
            var body = { actor: savedActor() || "负责人", dependencies: deps };
            if (approversInput.value.trim() === "" && !(t.approval)) {
              // 原本无审批且留空：不带 approval 字段（不改）
            } else if (approversInput.value.trim() === "") {
              body.approval = null; // 显式取消审批
            } else {
              var min = parseInt(minInput.value, 10);
              if (!(min >= 1 && min <= names.length)) {
                errLine.textContent = "最少通过人数必须在 1 到审批人数之间。";
                return;
              }
              body.approval = { approvers: names, minApprovals: min };
            }
            api("POST", "/api/execution-tasks/" + t.id + "/config", body,
              { ifMatch: state.rev }).then(function (rr) {
              m.close();
              toast("前置与审批配置已保存");
              return loadList(true).then(function () {
                var g = rr.data.task.gate;
                if (g && g.state !== "ready") {
                  toast("当前等待原因：" + (core.GATE_STATE_LABELS[g.state] || g.state), "info");
                }
              });
            }).catch(function (e) {
              handleError(e, function (msg) { errLine.textContent = msg; }, "保存配置");
            });
          })
        ]
      });
    }).catch(function (e) {
      box.appendChild(el("div", "composer-error", "读取队列失败：" + e.message));
      openModal("前置与审批配置", box,
        { buttons: [button("关闭", null, function () {})] });
    });
  }

  function renderCard(d) {
    var card = el("div", "decision-card" + (d.frozen ? " is-frozen" : ""));
    card.addEventListener("click", function () { openDetail(d.id); });

    var head = el("div", "batch-card-head");
    var name = el("div", "batch-name");
    name.appendChild(bdi(d.name));
    name.appendChild(el("span", "decision-status " + STATUS_CLASS[d.status], statusLabel(d.status)));
    if (d.executed) name.appendChild(el("span", "decision-done-flag", "已执行"));
    if (d.frozen) name.appendChild(el("span", "batch-archived-flag", "批次已归档"));
    if (d.overdue) name.appendChild(el("span", "batch-overdue-flag", "已过期"));
    head.appendChild(name);
    var meta = el("div", "batch-card-meta");
    meta.setAttribute("dir", "ltr");
    meta.textContent = "门槛 " + d.threshold + " 人 · " + d.itemCount + " 条批注";
    head.appendChild(meta);
    card.appendChild(head);

    var info = el("div", "batch-card-info");
    var bn = el("span");
    bn.appendChild(document.createTextNode("所属批次："));
    bn.appendChild(bdi(d.batchName));
    info.appendChild(bn);
    info.appendChild(el("span", "muted",
      " · 截止 " + (d.deadline ? formatTime(d.deadline) : "未设置") +
      " · 更新于 " + formatTime(d.updatedAt)));
    card.appendChild(info);

    var p = d.progress;
    var wrap = el("div", "batch-progress");
    var bar = el("div", "batch-progress-bar");
    var pct = p.total ? Math.round(p.approved / p.total * 100) : 0;
    var fill = el("div", "batch-progress-fill" + (p.ready ? " is-done" : ""));
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    wrap.appendChild(bar);
    var label = el("div", "batch-progress-label");
    label.setAttribute("dir", "ltr");
    label.textContent = "通过 " + p.approved + "/" + p.total + " · 待投票 " +
      p.counts.waiting + " · 驳回 " + p.counts.rejected + (p.counts.pending ? " · 未定 " + p.counts.pending : "");
    wrap.appendChild(label);
    card.appendChild(wrap);
    return card;
  }

  filterSel.addEventListener("change", function () {
    state.filterStatus = filterSel.value;
    render();
  });

  /* ---------- 新建草案 ---------- */

  function openComposer(preselectBatchId) {
    Promise.all([
      api("GET", "/api/review-batches"),
      window.ReviewUI ? window.ReviewUI.reload(true) : Promise.resolve()
    ]).then(function (rs) {
      var batches = (rs[0].data && rs[0].data.batches) || [];
      var pending = batches.filter(function (b) { return b.status === "pending"; });
      var box = el("div", "decision-composer");
      var errLine = el("div", "composer-error");
      errLine.setAttribute("role", "alert");

      if (!pending.length) {
        box.appendChild(el("div", "review-empty",
          "当前没有未归档批次。请先在“审阅批次”面板创建批次并加入批注。"));
        box.appendChild(errLine);
        var mEmpty = openModal("新建决策草案", box, {
          buttons: [button("关闭", null, function () { mEmpty.close(); })]
        });
        return;
      }

      var batchSel = document.createElement("select");
      pending.forEach(function (b) {
        var o = el("option", null, b.name + "（" + b.memberCount + " 条批注" +
          (b.overdue ? "，已过期" : "") + "）");
        o.value = b.id;
        if (preselectBatchId === b.id) o.selected = true;
        batchSel.appendChild(o);
      });
      box.appendChild(labeled("从未归档批次创建", batchSel));

      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "composer-author";
      nameInput.maxLength = core.LIMITS.DECISION_NAME_MAX_CHARS;
      nameInput.placeholder = "草案名称（可选，默认“批次名 + 决策草案”）";
      box.appendChild(labeled("草案名称", nameInput));

      var thresholdInput = document.createElement("input");
      thresholdInput.type = "number";
      thresholdInput.min = core.LIMITS.THRESHOLD_MIN;
      thresholdInput.max = core.LIMITS.THRESHOLD_MAX;
      thresholdInput.value = "1";
      thresholdInput.className = "composer-author dc-threshold";
      box.appendChild(labeled("通过人数门槛（1–" + core.LIMITS.THRESHOLD_MAX + "，每条需多少人投通过）",
        thresholdInput));

      var actorInput = document.createElement("input");
      actorInput.type = "text";
      actorInput.className = "composer-author";
      actorInput.maxLength = 50;
      actorInput.placeholder = "创建者署名（可选，默认匿名）";
      actorInput.value = savedActor();
      box.appendChild(labeled("创建者", actorInput));

      box.appendChild(el("p", "muted",
        "草案创建时会记录当前编辑区文本、批注集合与批次三个版本号；执行前若任一版本变化，" +
        "只会把受影响的条目标记为冲突，不会覆盖新的文字或批注。方案可在创建后逐条填写。"));
      box.appendChild(errLine);

      var okBtn = button("创建草案", "primary", function () {
        errLine.textContent = "";
        var batchId = batchSel.value;
        var payload = {
          batchId: batchId,
          name: nameInput.value,
          threshold: parseInt(thresholdInput.value, 10),
          paragraphs: Editor.serialize().paragraphs,
          actor: actorInput.value
        };
        var tc = core.validateThreshold(payload.threshold);
        if (!tc.ok) { errLine.textContent = tc.message; return; }
        okBtn.disabled = true;
        api("POST", "/api/review-decisions", { body: payload, ifMatch: state.rev })
          .then(function (r) {
            rememberActor(actorInput.value.trim());
            m.close();
            toast("决策草案已创建，请逐条填写处理方案");
            return loadList(true).then(function () { openDetail(r.data.decision.id); });
          })
          .catch(function (err) {
            okBtn.disabled = false;
            handleError(err, function (m2) { errLine.textContent = m2; }, "创建草案");
          });
      });
      var m = openModal("新建决策草案", box, {
        buttons: [button("取消", null, function () { m.close(); }), okBtn]
      });
    }).catch(function () {
      toast("批次列表尚未就绪，请稍后重试", "error");
    });
  }

  function labeled(text, input) {
    var wrap = el("label", "batch-field");
    wrap.appendChild(el("span", "batch-field-label", text));
    wrap.appendChild(input);
    return wrap;
  }

  /* ---------- 草案详情 ---------- */

  function findSummary(id) {
    return state.items.filter(function (d) { return d.id === id; })[0];
  }

  function openDetail(id) {
    var modal = openModal("决策草案", el("div"), { buttons: [] });
    modal.setTitle("草案加载中…");
    api("GET", "/api/review-decisions/" + id).then(function (r) {
      renderDetail(modal, r.data);
    }).catch(function (err) {
      modal.body.appendChild(el("div", "composer-error",
        "读取草案失败：" + err.message + "（当前页面内容未受影响）"));
      modal.foot.appendChild(button("关闭", null, function () { modal.close(); }));
    });
  }

  function refreshDetail(modal) {
    return api("GET", "/api/review-decisions/" + modal.decisionId).then(function (r) {
      renderDetail(modal, r.data);
    });
  }

  function renderDetail(modal, data) {
    var d = data.decision;
    modal.decisionId = d.id;
    var frozen = !!data.batchFrozen;
    modal.body.innerHTML = "";
    modal.foot.innerHTML = "";
    modal.setTitle((frozen ? "📦 只读草案：" : "决策草案：") + d.name);

    /* —— 元信息 —— */
    var meta = el("div", "batch-detail-meta");
    meta.setAttribute("dir", "ltr");
    function metaLine(labelText, node) {
      var line = el("div", "batch-meta-line");
      line.appendChild(el("span", "muted", labelText));
      line.appendChild(node);
      return line;
    }
    var statusNode = el("span", "decision-status " + STATUS_CLASS[d.status], statusLabel(d.status));
    meta.appendChild(metaLine("状态：", statusNode));
    var bn = el("span"); bn.appendChild(bdi(d.batchName));
    meta.appendChild(metaLine("所属批次：", bn));
    meta.appendChild(metaLine("通过门槛：", el("span", null, d.threshold + " 人/条")));
    meta.appendChild(metaLine("截止：", el("span", d.overdue ? "is-overdue" : null,
      (d.deadline ? formatTime(d.deadline) : "未设置") + (d.overdue ? "（已过期，草案锁定）" : ""))));
    meta.appendChild(metaLine("创建：", el("span", null, formatTime(d.createdAt))));
    meta.appendChild(metaLine("最近更新：", el("span", null, formatTime(d.updatedAt))));
    var ver = el("span", "muted");
    ver.setAttribute("dir", "ltr");
    ver.textContent = "文本 " + (data.textRev || "—").slice(0, 8) +
      " · 批注 v" + (data.annotationRev == null ? "—" : data.annotationRev) +
      " · 批次 v" + (data.batchRev == null ? "—" : data.batchRev);
    meta.appendChild(metaLine("执行前将校验的版本：", ver));
    modal.body.appendChild(meta);

    var p = d.progress;
    var progLine = el("div", "batch-progress-label dc-prog");
    progLine.setAttribute("dir", "ltr");
    progLine.textContent = "通过 " + p.approved + "/" + p.total + " · 待投票 " +
      p.counts.waiting + " · 已驳回 " + p.counts.rejected + " · 方案未定 " + p.counts.pending;
    modal.body.appendChild(progLine);

    if (frozen) {
      modal.body.appendChild(el("p", "composer-error",
        "所属批次已归档：草案只读，不能再修改方案、投票、执行或撤销；以下为归档时的完整状态。"));
    } else if (d.status === "scheduled") {
      var tInfo = data.activeTask;
      var schedP = el("p", "dc-scheduled-info");
      var line1 = el("div", "dc-sched-line");
      line1.setAttribute("dir", "ltr");
      line1.textContent = "已发布到执行队列，状态：" +
        (tInfo ? taskStatusLabel(tInfo.status) : "等待生效") +
        " · 计划生效 " + (tInfo ? formatTime(tInfo.scheduledAt) : "—");
      schedP.appendChild(line1);
      if (tInfo) {
        var rem = el("div", "dc-sched-remain");
        rem.setAttribute("dir", "ltr");
        rem.dataset.taskRemain = String(tInfo.scheduledAtMs);
        rem.dataset.taskStatus = tInfo.status;
        rem.textContent = tInfo.status === "paused" ? "任务已暂停" : formatRemain(remainMs(tInfo.scheduledAtMs));
        schedP.appendChild(rem);
        if (tInfo.lock) {
          var lk = el("div", "dc-sched-lock");
          lk.setAttribute("dir", "ltr");
          lk.textContent = "发布时已锁定：文本 " + tInfo.lock.textRev.slice(0, 8) +
            "（" + tInfo.lock.paragraphCount + " 段）· 批注 v" + tInfo.lock.annotationRev +
            " · 批次 v" + tInfo.lock.batchRev;
          schedP.appendChild(lk);
        }
        // 前置门控：等待原因 + 审批进度
        var gateNode = renderTaskGate(tInfo);
        if (gateNode && gateNode.childNodes.length) schedP.appendChild(gateNode);
        var btns = el("div", "dc-sched-actions");
        if (tInfo.status === "scheduled") {
          btns.appendChild(button("暂停任务", null, function () { taskPause(tInfo); }));
          btns.appendChild(button("取消任务", "danger", function () {
            taskCancel(tInfo).then(function () { refreshDetail(modal); });
          }));
        } else if (tInfo.status === "paused") {
          btns.appendChild(button("恢复任务…", "primary", function () { taskResume(tInfo); }));
          btns.appendChild(button("取消任务", "danger", function () {
            taskCancel(tInfo).then(function () { refreshDetail(modal); });
          }));
        } else if (tInfo.status === "partial" || tInfo.status === "failed" ||
                   tInfo.status === "blocked") {
          btns.appendChild(button("失败重试…", "primary", function () { taskRetry(tInfo); }));
        }
        if (tInfo.gate && tInfo.gate.state === "can_continue") {
          btns.appendChild(button("确认继续", "primary",
            function () { taskContinue(tInfo); }));
        }
        if (tInfo.gate && tInfo.gate.approval) {
          btns.appendChild(button("执行前审批…", "primary",
            function () { openApprovalDialog(tInfo); }));
        }
        if (tInfo.status === "scheduled" || tInfo.status === "paused") {
          btns.appendChild(button("前置/审批配置…", null,
            function () { openTaskConfig(tInfo); }));
        }
        btns.appendChild(button("队列记录", null, function () { openTaskLogs(tInfo); }));
        schedP.appendChild(btns);
      }
      modal.body.appendChild(schedP);
    } else if (d.status === "executed") {
      var exInfo = (data.executions || [])[data.executions.length - 1];
      modal.body.appendChild(el("p", "muted",
        "草案已执行（成功 " + (exInfo ? exInfo.counts.success : 0) + " · 冲突 " +
        (exInfo ? exInfo.counts.conflict : 0) + " · 跳过 " +
        (exInfo ? exInfo.counts.skipped : 0) + "）。同一草案不能重复执行，可撤销最近一次成功执行后重做。"));
    }

    var errLine = el("div", "composer-error detail-error");
    errLine.setAttribute("role", "alert");
    modal.body.appendChild(errLine);
    function showErr(m) { errLine.textContent = m; }

    /* —— 投票署名 —— */
    var voterBar = el("div", "dc-voter-bar");
    voterBar.appendChild(el("span", "muted", "我的署名："));
    var voterInput = document.createElement("input");
    voterInput.type = "text";
    voterInput.className = "composer-author";
    voterInput.maxLength = 50;
    voterInput.value = savedActor();
    voterInput.placeholder = "投票必须署名";
    if (frozen) voterInput.disabled = true;
    voterBar.appendChild(voterInput);
    modal.body.appendChild(voterBar);

    /* —— 条目表 —— */
    var rows = data.items.map(function (it) {
      return renderItemRow(modal, data, it, voterInput, frozen, showErr);
    });
    var tableWrap = el("div", "batch-members-wrap dc-items-wrap");
    var table = el("table", "batch-members dc-items");
    var thead = el("thead");
    var hr = el("tr");
    hr.appendChild(el("th", null, "批注 / 位置"));
    hr.appendChild(el("th", null, "处理方案"));
    hr.appendChild(el("th", null, "投票"));
    if (!frozen) hr.appendChild(el("th", null, "操作"));
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el("tbody");
    rows.forEach(function (r) { tbody.appendChild(r.tr); });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    modal.body.appendChild(tableWrap);

    /* —— 历史执行记录 —— */
    if (data.executions && data.executions.length) {
      var exBox = el("div", "dc-executions");
      exBox.appendChild(el("div", "snap-section-title", "执行记录（按时间）"));
      data.executions.slice().reverse().forEach(function (ex) {
        var item = el("div", "dc-exec-item" + (ex.undone ? " is-undone" : ""));
        var h = el("div", "ann-meta");
        h.setAttribute("dir", "ltr");
        h.appendChild(bdi(ex.actor || "匿名"));
        h.appendChild(document.createTextNode(" · " + formatTime(ex.at) +
          " · 成功 " + ex.counts.success + " / 冲突 " + ex.counts.conflict +
          " / 跳过 " + ex.counts.skipped + (ex.applied ? "" : "（无成功条目）") +
          (ex.undone ? " · 已撤销" + (ex.undoneAt ? " " + formatTime(ex.undoneAt) : "") : "")));
        item.appendChild(h);
        exBox.appendChild(item);
      });
      modal.body.appendChild(exBox);
    }

    /* —— 底部操作 —— */
    function addBtn(b) { modal.foot.appendChild(b); }
    addBtn(button("审阅记录", null, function () { openLogs(d); }));

    if (!frozen) {
      if (d.status === "drafting") {
        var saveBtn = button("保存方案", "primary", function () {
          saveItems(modal, data, rows, voterInput, showErr, saveBtn);
        });
        var submitBtn = button("提交投票…", null, function () {
          submitDraft(modal, data, rows, voterInput, showErr, submitBtn);
        });
        addBtn(saveBtn); addBtn(submitBtn);
      } else if (d.status === "voting" || d.status === "ready") {
        addBtn(button("保存方案修改", null, function () {
          saveItems(modal, data, rows, voterInput, showErr, null);
        }));
        addBtn(button("执行前预览…", null, function () {
          openPreview(modal, data, rows, showErr);
        }));
        if (d.status === "ready") {
          addBtn(button("发布到执行队列…", "primary", function () {
            openPublishDialog(d.id);
          }));
        }
      } else if (d.status === "scheduled") {
        if (data.activeTask) addBtn(button("队列记录", null, function () {
          openTaskLogs(data.activeTask);
        }));
      } else if (d.status === "executed") {
        var last = data.executions[data.executions.length - 1];
        var canUndo = last && last.applied && !last.undone;
        var undoBtn = button("撤销最近一次执行", "danger", function () {
          undoLast(modal, showErr, undoBtn);
        });
        if (!canUndo) { undoBtn.disabled = true; undoBtn.title = "最近一次执行没有成功条目或已撤销"; }
        addBtn(undoBtn);
      }
    }
    addBtn(button("关闭", null, function () { modal.close(); }));
  }

  function renderItemRow(modal, data, it, voterInput, frozen, showErr) {
    var tr = el("tr");
    // 已发布定时执行（scheduled）与已执行一样：方案与投票在服务端锁定
    var locked = frozen || data.decision.status === "executed" ||
                 data.decision.status === "scheduled";

    // 批注与位置
    var tdAnn = el("td");
    var pos = el("div", "ann-meta");
    pos.setAttribute("dir", "ltr");
    pos.textContent = "段落 #" + (it.paraIndex + 1) + " [" + it.start + "–" + it.end + ")";
    tdAnn.appendChild(pos);
    var q = el("div", "ann-quote batch-member-quote");
    q.appendChild(bdi(it.quote));
    tdAnn.appendChild(q);
    tr.appendChild(tdAnn);

    // 方案
    var tdPlan = el("td", "dc-plan-cell");
    var selWrap = el("div");
    var dispSel = document.createElement("select");
    [["", "未定方案"], ["keep", "保留原文"], ["replace", "替换为…"], ["delete", "删除原文"]]
      .forEach(function (pair) {
        var o = el("option", null, pair[1]);
        o.value = pair[0];
        if (it.disposition === pair[0] || (!it.disposition && pair[0] === "")) o.selected = true;
        dispSel.appendChild(o);
      });
    if (locked) dispSel.disabled = true;
    selWrap.appendChild(dispSel);
    tdPlan.appendChild(selWrap);

    var replBox = el("div", "dc-repl-box");
    var replInput = document.createElement("textarea");
    replInput.rows = 2;
    replInput.className = "composer-body dc-repl-input";
    replInput.maxLength = core.LIMITS.REPLACEMENT_MAX_CHARS;
    replInput.placeholder = "替换为的文本（中阿混排均可）";
    replInput.value = it.disposition === "replace" ? (it.replacement || "") : "";
    if (it.disposition !== "replace") replBox.style.display = "none";
    if (locked) replInput.disabled = true;
    replBox.appendChild(replInput);
    tdPlan.appendChild(replBox);
    dispSel.addEventListener("change", function () {
      replBox.style.display = dispSel.value === "replace" ? "" : "none";
    });
    tr.appendChild(tdPlan);

    // 投票状态
    var tdVote = el("td");
    var stateBadge = el("div", "decision-item-state " + ITEM_STATE_CLASS[it.state],
      itemStateLabel(it.state));
    tdVote.appendChild(stateBadge);
    var tally = el("div", "ann-meta");
    tally.setAttribute("dir", "ltr");
    tally.textContent = "通过 " + it.approve + " · 驳回 " + it.reject + " · 弃权 " + it.abstain;
    tdVote.appendChild(tally);
    var mine = (it.votes || []).filter(function (v) {
      return v.voter === (voterInput.value || savedActor());
    })[0];
    var mineLine = el("div", "dc-my-vote" + (mine ? "" : " is-empty"));
    mineLine.setAttribute("dir", "ltr");
    mineLine.textContent = mine ? ("我的一票：" + voteLabel(mine.vote)) : "我尚未投票";
    tdVote.appendChild(mineLine);
    voterInput.addEventListener("input", function () {
      var m2 = (it.votes || []).filter(function (v) { return v.voter === voterInput.value; })[0];
      mineLine.textContent = m2 ? ("我的一票：" + voteLabel(m2.vote)) : "我尚未投票";
      mineLine.classList.toggle("is-empty", !m2);
    });
    tr.appendChild(tdVote);

    var apiRow = {
      tr: tr, annotationId: it.annotationId,
      dispSel: dispSel, replInput: replInput,
      origDisposition: it.disposition, origReplacement: it.replacement || "",
      current: it
    };

    // 操作：保存本行 + 三个投票按钮
    if (!frozen) {
      var tdAct = el("td", "batch-row-actions dc-vote-actions");
      var saveOne = button("保存", "btn-mini", function () {
        saveItems(modal, data, [apiRow], voterInput, showErr, saveOne);
      });
      if (locked) saveOne.disabled = true;
      tdAct.appendChild(saveOne);
      [["approve", "通过", "dc-v-approve"],
       ["reject", "驳回", "dc-v-reject"],
       ["abstain", "弃权", "dc-v-abstain"]].forEach(function (cfg) {
        var b = button(cfg[1], "btn-mini " + cfg[2], function () {
          castVote(modal, data, it.annotationId, cfg[0], voterInput, showErr, b);
        });
        if (data.decision.status === "drafting" || locked) b.disabled = true;
        if (mine && mine.vote === cfg[0]) b.classList.add("is-mine");
        tdAct.appendChild(b);
      });
      tr.appendChild(tdAct);
    }
    return apiRow;
  }

  function collectItemPayload(rows) {
    return rows.map(function (r) {
      var disp = r.dispSel.value || null;
      return {
        annotationId: r.annotationId,
        disposition: disp,
        replacement: disp === "replace" ? r.replInput.value : null
      };
    }).filter(function (x) { return x.disposition; }); // 未定方案不下发
  }

  function saveItems(modal, data, rows, voterInput, showErr, btn) {
    showErr("");
    var payloadItems = collectItemPayload(rows);
    if (!payloadItems.length) {
      showErr("没有可保存的方案：请先为至少一条批注选择保留、替换或删除（当前页面内容已保留）。");
      return;
    }
    // 本地预检：替换文本非空/不超长；重复方案
    var seen = Object.create(null);
    for (var i = 0; i < payloadItems.length; i++) {
      var x = payloadItems[i];
      if (seen[x.annotationId]) { showErr("同一条批注出现了两个方案，请只保留一个。"); return; }
      seen[x.annotationId] = true;
      if (x.disposition === "replace") {
        var rc = core.validateReplacement("replace", x.replacement);
        if (!rc.ok) { showErr(rc.message); return; }
      }
    }
    if (btn) btn.disabled = true;
    api("PUT", "/api/review-decisions/" + data.decision.id + "/items",
      { items: payloadItems, actor: voterInput.value || undefined },
      { ifMatch: state.rev }).then(function () {
      rememberActor(voterInput.value.trim());
      toast("方案已保存" + (data.decision.status !== "drafting" ? "（改动条目的已有投票已作废，需重新投票）" : ""));
      return refreshDetail(modal);
    }).then(function () { return loadList(true); })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        handleDetailError(err, showErr, modal, "保存方案");
      });
  }

  function submitDraft(modal, data, rows, voterInput, showErr, btn) {
    showErr("");
    var unfilled = rows.filter(function (r) { return !r.dispSel.value; });
    if (unfilled.length) {
      showErr("还有 " + unfilled.length + " 条批注没有处理方案：每条都必须选择保留、替换或删除后才能提交投票。");
      return;
    }
    // 先保存全部方案，再提交
    btn.disabled = true;
    var payloadItems = collectItemPayload(rows);
    api("PUT", "/api/review-decisions/" + data.decision.id + "/items",
      { items: payloadItems, actor: voterInput.value || undefined },
      { ifMatch: state.rev }).catch(function (err) {
      if (err.code === "no_change") return { data: null }; // 方案无变化，继续提交
      throw err;
    }).then(function () {
      return api("POST", "/api/review-decisions/" + data.decision.id + "/submit",
        { actor: voterInput.value || undefined }, { ifMatch: state.rev });
    }).then(function () {
      rememberActor(voterInput.value.trim());
      toast("草案已提交投票，审阅者可逐条投票");
      return refreshDetail(modal);
    }).then(function () { return loadList(true); })
      .catch(function (err) {
        btn.disabled = false;
        handleDetailError(err, showErr, modal, "提交投票");
      });
  }

  function castVote(modal, data, annotationId, vote, voterInput, showErr, btn) {
    showErr("");
    var voter = (voterInput.value || "").trim();
    var vc = core.validateVoter(voter);
    if (!vc.ok) { showErr(vc.message); voterInput.focus(); return; }
    btn.disabled = true;
    api("POST", "/api/review-decisions/" + data.decision.id + "/votes",
      { annotationId: annotationId, vote: vote, voter: vc.value },
      { ifMatch: state.rev }).then(function () {
      rememberActor(vc.value);
      return refreshDetail(modal);
    }).then(function (r) {
      var dd = r && r.data;
      if (dd && dd.decision.status === "ready") {
        toast("全部条目已达通过门槛，草案进入待执行状态");
      } else {
        toast("投票“" + voteLabel(vote) + "”已记录");
      }
      return loadList(true);
    }).catch(function (err) {
      btn.disabled = false;
      handleDetailError(err, showErr, modal, "投票");
    });
  }

  /* ---------- 执行前预览 + 执行 ---------- */

  function openPreview(parentModal, data, rows, showErr) {
    var box = el("div", "dc-preview-box");
    box.appendChild(el("p", "muted", "正在按当前编辑区文本生成按段预览……"));
    var m = openModal("执行前预览：" + data.decision.name, box, { buttons: [] });

    api("POST", "/api/review-decisions/" + data.decision.id + "/preview",
      { paragraphs: Editor.serialize().paragraphs }).then(function (r) {
      renderPreview(parentModal, m, r.data);
    }).catch(function (err) {
      box.innerHTML = "";
      box.appendChild(el("div", "composer-error", "生成预览失败：" + err.message));
      m.foot.appendChild(button("关闭", null, function () { m.close(); }));
    });
  }

  function renderPreview(parentModal, modal, pv) {
    var d = pv.decision;
    modal.body.innerHTML = "";
    modal.foot.innerHTML = "";

    var warn = el("p", "restore-warn",
      "执行会把“成功”条目的保留/替换/删除合成后写入编辑区；“冲突”条目因文本、批注或批次版本变化而跳过，" +
      "“跳过”条目尚未通过投票或本次未勾选。一次执行可部分成功，成功、冲突、跳过都会逐条留痕，且可撤销最近一次成功执行。");
    modal.body.appendChild(warn);

    var sum = el("p", "diff-summary");
    sum.setAttribute("dir", "ltr");
    sum.textContent = "成功 " + pv.counts.success + " · 冲突 " + pv.counts.conflict +
      " · 跳过 " + pv.counts.skipped +
      (pv.textChanged ? "（检测到草案创建后文本版本已变化，受影响条目已逐条标出）" : "（文本版本未变化）");
    sum.classList.toggle("is-warn", pv.textChanged && pv.counts.conflict > 0);
    modal.body.appendChild(sum);

    // 勾选本次要执行的条目（默认勾选当前可成功的条目）
    var checkMap = Object.create(null);
    pv.results.forEach(function (r) {
      checkMap[r.annotationId] = r.result === "success";
    });

    var table = el("table", "restore-table dc-preview-table");
    var thead = el("thead");
    var hr = el("tr");
    ["执行", "段落", "当前文本（按段）", "执行后（仅成功条目）", "条目判定"].forEach(function (h, i) {
      hr.appendChild(el("th", i === 0 ? "c-check" : null, h));
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el("tbody");

    function recount() {
      var c = { success: 0, conflict: 0, skipped: 0 };
      pv.results.forEach(function (r) {
        if (!checkMap[r.annotationId]) { c.skipped++; return; }
        if (r.result === "success") c.success++;
        else if (r.result === "conflict") c.conflict++;
        else c.skipped++;
      });
      sum.textContent = "按当前勾选：成功 " + c.success + " · 冲突 " + c.conflict +
        " · 跳过 " + c.skipped;
      executeBtn.disabled = c.success === 0;
    }

    pv.rows.forEach(function (row) {
      var tr = el("tr", "dc-pv-row");
      var tdCheck = el("td", "c-check");
      var anySuccess = row.items.some(function (it) {
        return it.result === "success" && it.disposition;
      });
      row.items.forEach(function (it) {
        if (it.voteState !== "approved") return;
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checkMap[it.annotationId];
        cb.addEventListener("change", function () {
          checkMap[it.annotationId] = cb.checked;
          recount();
        });
        tdCheck.appendChild(cb);
      });
      tr.appendChild(tdCheck);

      var idxTd = el("td", "c-idx");
      idxTd.setAttribute("dir", "ltr");
      idxTd.textContent = "#" + (row.paraIndex + 1) +
        (row.currentParaIndex == null ? " ✖" :
          row.currentParaIndex === row.paraIndex ? "" : "→现#" + (row.currentParaIndex + 1));
      tr.appendChild(idxTd);

      var curTd = el("td", "rp-cell");
      var tag = null;
      if (row.deleted) tag = "整段已删除";
      else if (row.paraChanged) tag = "段落已改写";
      else if (row.dirChanged) tag = "段落方向已改变";
      if (tag) {
        var badge = el("div", "dc-conflict-tag", tag);
        curTd.appendChild(badge);
      }
      var curText = el("div", "para-text");
      curText.appendChild(bdi(row.current ? row.current.text : "—"));
      curTd.appendChild(curText);
      tr.appendChild(curTd);

      var afterTd = el("td", "rp-cell");
      var afterText = el("div", "para-text" + (anySuccess ? " para-added" : ""));
      afterText.appendChild(bdi(row.afterText == null ? "—" : row.afterText));
      afterTd.appendChild(afterText);
      tr.appendChild(afterTd);

      var itemsTd = el("td", "dc-pv-items");
      row.items.forEach(function (it) {
        var line = el("div", "dc-pv-item dc-pv-" + it.result);
        var st = el("span", "decision-item-state " + ITEM_STATE_CLASS[it.voteState],
          itemStateLabel(it.voteState));
        line.appendChild(st);
        line.appendChild(document.createTextNode(" "));
        line.appendChild(el("span", "dc-disp", dispositionLabel(it.disposition)));
        line.appendChild(document.createTextNode(" "));
        var q = el("span", "batch-pick-quote"); q.appendChild(bdi(it.quote));
        line.appendChild(q);
        if (it.disposition === "replace") {
          line.appendChild(document.createTextNode(" → "));
          var rp = el("span", "dc-repl-inline"); rp.appendChild(bdi(it.replacement));
          line.appendChild(rp);
        }
        var resultBadge = el("div", "dc-result dc-result-" + it.result,
          resultLabel(it.result) + (it.reason ? "：" + reasonLabel(it.reason) : ""));
        line.appendChild(resultBadge);
        itemsTd.appendChild(line);
      });
      tr.appendChild(itemsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var scroll = el("div", "diff-scroll");
    scroll.appendChild(table);
    modal.body.appendChild(scroll);

    var errLine = el("div", "composer-error");
    modal.body.appendChild(errLine);

    var executeBtn = button("确认执行所选条目", "primary", function () {
      var ids = Object.keys(checkMap).filter(function (k) { return checkMap[k]; });
      executeBtn.disabled = true;
      execute(parentModal, modal, d.id, ids, errLine, executeBtn, pv);
    });
    executeBtn.disabled = pv.counts.success === 0;
    modal.foot.appendChild(button("取消", null, function () { modal.close(); }));
    modal.foot.appendChild(executeBtn);
  }

  function execute(parentModal, modal, decisionId, ids, errLine, btn, previewData) {
    errLine.textContent = "";
    api("POST", "/api/review-decisions/" + decisionId + "/execute", {
      paragraphs: Editor.serialize().paragraphs,
      annotationIds: ids,
      actor: savedActor() || undefined
    }, { ifMatch: state.rev }).then(function (r) {
      var data = r.data;
      // 把服务端校验合成后的执行后段落写入编辑区（仅当确有条目成功）
      if (data.applied) {
        var restored = Editor.restore({ paragraphs: data.afterParagraphs });
        if (!restored.ok) {
          errLine.textContent = "执行已在服务端完成，但写入编辑区失败：" + restored.message +
            "（可从审阅记录或撤销接口核对，编辑区未被改动）";
          renderExecutionResult(modal, data, true);
          return;
        }
        Editor.updateStatus();
      }
      renderExecutionResult(modal, data, false);
      toast("执行完成：成功 " + data.counts.success + " · 冲突 " +
        data.counts.conflict + " · 跳过 " + data.counts.skipped);
      return loadList(true).then(function () {
        if (parentModal && parentModal.overlay && parentModal.overlay.parentNode) {
          return refreshDetail(parentModal);
        }
      });
    }).catch(function (err) {
      btn.disabled = false;
      if (err.status === 409 && err.code === "version_conflict") {
        errLine.textContent = "版本冲突：" + err.message + " 请关闭预览后在最新草案上重试。";
        loadList(true);
      } else {
        errLine.textContent = "执行失败：" + err.message;
      }
    });
  }

  function renderExecutionResult(modal, data, editorWriteFailed) {
    if (data.decision && data.decision.id) modal.decisionId = data.decision.id;
    modal.body.innerHTML = "";
    modal.foot.innerHTML = "";
    modal.setTitle("执行结果");
    var sum = el("p", "diff-summary" + (data.counts.conflict ? " is-warn" : ""));
    sum.setAttribute("dir", "ltr");
    sum.textContent = "成功 " + data.counts.success + " · 冲突 " +
      data.counts.conflict + " · 跳过 " + data.counts.skipped +
      (data.applied ? "（执行结果已写入编辑区，成功批注已标记为已解决）" : "（没有可成功执行的条目，草案仍为待执行）");
    modal.body.appendChild(sum);
    if (editorWriteFailed) {
      modal.body.appendChild(el("p", "composer-error",
        "注意：服务端已记录执行，但编辑区写入失败，当前编辑区文字未被替换。"));
    }
    var table = el("table", "batch-members");
    var thead = el("thead");
    var hr = el("tr");
    ["批注", "方案", "结果", "原因"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el("tbody");
    data.results.forEach(function (r) {
      var tr = el("tr", "dc-res-" + r.result);
      var tdQ = el("td");
      tdQ.setAttribute("dir", "ltr");
      tdQ.textContent = "段落 #" + (r.paraIndex + 1);
      tr.appendChild(tdQ);
      tr.appendChild(el("td", null, dispositionLabel(r.disposition)));
      tr.appendChild(el("td", null, resultLabel(r.result)));
      tr.appendChild(el("td", null, r.reason ? reasonLabel(r.reason) : "—"));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    modal.body.appendChild(el("div", "batch-members-wrap", table));

    var closeBtn = button("关闭", "primary", function () { modal.close(); });
    modal.foot.appendChild(closeBtn);
    var undoBtn = button("撤销最近一次执行", null, function () {
      undoLastById(modal, data.decisionId || null, closeBtn);
    });
    if (data.applied) modal.foot.appendChild(undoBtn);
    modal.decisionId = (data.decision && data.decision.id) || modal.decisionId;
  }

  /* ---------- 撤销 ---------- */

  function undoLast(modal, showErr, btn) {
    undoLastById(modal, modal.decisionId, btn, showErr);
  }

  function undoLastById(modal, decisionId, btn, showErr) {
    var id = decisionId || modal.decisionId;
    if (!window.confirm("撤销最近一次成功执行吗？\n" +
      "成功条目对应的批注会回滚为待处理（执行后又被修改/删除的批注不会被覆盖）；" +
      "确认后可把执行前的文本写回编辑区。")) return;
    if (btn) btn.disabled = true;
    api("POST", "/api/review-decisions/" + id + "/undo",
      { actor: savedActor() || undefined }, { ifMatch: state.rev })
      .then(function (r) {
        var data = r.data;
        if (data.beforeParagraphs &&
            window.confirm("已回滚 " + data.reverted + " 条批注状态。是否把执行前的文本写回编辑区？\n" +
              "（点“取消”则只回滚记录，编辑区保持当前文字）")) {
          var restored = Editor.restore({ paragraphs: data.beforeParagraphs });
          if (!restored.ok) toast("编辑区写回失败：" + restored.message, "error");
          else { Editor.updateStatus(); toast("编辑区已恢复为执行前文本"); }
        } else {
          toast("已撤销执行记录（回滚批注 " + data.reverted + " 条），编辑区未改动");
        }
        modal.close();
        return loadList(true).then(function () { openDetail(id); });
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        if (showErr) handleDetailError(err, showErr, modal, "撤销执行");
        else toast("撤销失败：" + err.message, "error");
      });
  }

  /* ---------- 审阅记录 ---------- */

  var ACTION_LABELS = {
    decision_create: "创建草案",
    decision_update: "修改草案设置",
    decision_submit: "提交投票",
    items_update: "修改方案",
    vote: "投票",
    execute: "执行决策",
    execute_item_success: "执行条目·成功",
    execute_item_conflict: "执行条目·冲突",
    execute_item_skipped: "执行条目·跳过",
    execute_undo: "撤销执行"
  };

  var TASK_ACTION_LABELS = {
    task_publish: "发布到队列",
    task_pause: "暂停任务",
    task_resume: "恢复任务",
    task_cancel: "取消任务",
    task_auto_execute: "自动执行",
    task_auto_execute_item_success: "自动执行·成功",
    task_auto_execute_item_conflict: "自动执行·冲突",
    task_auto_execute_item_skipped: "自动执行·跳过",
    task_retry_execute: "重试执行",
    task_retry_execute_item_success: "重试执行·成功",
    task_retry_execute_item_conflict: "重试执行·冲突",
    task_retry_execute_item_skipped: "重试执行·跳过",
    task_retry: "失败重试",
    task_succeeded: "全部成功",
    task_partial: "部分成功",
    task_failed: "执行失败",
    task_blocked: "任务阻断",
    task_interrupted: "重启中断",
    task_undo: "撤销自动执行",
    task_gate_waiting: "等待前置条件",
    task_dependency_blocked: "依赖阻断",
    task_dependency_unblocked: "依赖阻断解除",
    task_dependency_can_continue: "前置部分成功",
    task_dependency_continue: "确认继续",
    task_dependencies_changed: "修改前置任务",
    task_approval_configured: "审批配置",
    task_approved: "审批通过",
    task_rejected: "审批拒绝",
    task_approval_withdrawn: "撤回审批",
    task_approval_met: "审批达标",
    task_approval_rejected: "审批被否决",
    task_approval_reopened: "审批重新开放",
    task_approval_reset: "审批等待中"
  };

  function openLogs(d) {
    var box = el("div", "batch-logs");
    box.appendChild(el("p", "muted",
      "草案创建、方案修改、逐条投票、执行结果与撤销全部记录在案（批次归档后仍可查看）。"));
    var filterBar = el("div", "batch-log-filter");
    var fromInput = document.createElement("input");
    fromInput.type = "datetime-local";
    var toInput = document.createElement("input");
    toInput.type = "datetime-local";
    var fromLabel = el("label", "batch-field");
    fromLabel.appendChild(el("span", "batch-field-label", "从"));
    fromLabel.appendChild(fromInput);
    var toLabel = el("label", "batch-field");
    toLabel.appendChild(el("span", "batch-field-label", "到"));
    toLabel.appendChild(toInput);
    filterBar.appendChild(fromLabel);
    filterBar.appendChild(toLabel);
    var list = el("div", "batch-log-list");
    box.appendChild(filterBar);
    box.appendChild(list);

    function fetchLogs() {
      var qs = [];
      if (fromInput.value) qs.push("from=" + encodeURIComponent(new Date(fromInput.value).toISOString()));
      if (toInput.value) qs.push("to=" + encodeURIComponent(new Date(toInput.value).toISOString()));
      list.innerHTML = "";
      list.appendChild(el("div", "muted", "正在加载决策记录……"));
      api("GET", "/api/review-decisions/" + d.id + "/logs" + (qs.length ? "?" + qs.join("&") : ""))
        .then(function (r) {
          list.innerHTML = "";
          var logs = (r.data && r.data.logs) || [];
          if (!logs.length) {
            list.appendChild(el("div", "review-empty", "该时间范围内没有决策记录。"));
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
            var actor = el("span"); actor.appendChild(bdi(l.actor || "匿名"));
            h.appendChild(actor);
            item.appendChild(h);
            if (l.detail) {
              var det = el("div", "log-detail");
              det.appendChild(bdi(l.detail));
              item.appendChild(det);
            }
            list.appendChild(item);
          });
        }).catch(function (err) {
          list.innerHTML = "";
          list.appendChild(el("div", "composer-error", "读取决策记录失败：" + err.message));
        });
    }
    fromInput.addEventListener("change", fetchLogs);
    toInput.addEventListener("change", fetchLogs);
    var m = openModal("决策记录：" + d.name, box, {
      buttons: [
        button("按时间筛选", null, fetchLogs),
        button("清除时间范围", null, function () { fromInput.value = ""; toInput.value = ""; fetchLogs(); }),
        button("关闭", null, function () { m.close(); })
      ]
    });
    fetchLogs();
  }

  /* ---------- 历史快照中的决策草案 ---------- */

  function openSnapshotDecisions(snapshotId, snapshotName) {
    fetch("/api/snapshots/" + snapshotId).then(function (res) { return res.json(); }).then(function (snap) {
      var box = el("div", "snap-ann-box");
      var head = el("p", "muted");
      head.appendChild(document.createTextNode("快照 "));
      head.appendChild(bdi(snap.name));
      var ds = snap.decisions;
      if (!ds) {
        head.appendChild(document.createTextNode(" 创建于决策功能上线前，未记录决策数据。"));
        box.appendChild(head);
        openModal("快照决策：" + (snapshotName || snap.name), box, { buttons: [] });
        return;
      }
      head.appendChild(document.createTextNode(" 保存时共有 " + ds.length +
        " 个决策草案（决策集合版本 " + (snap.decisionRev == null ? "—" : snap.decisionRev) + "）。"));
      box.appendChild(head);

      if (!ds.length) box.appendChild(el("div", "review-empty", "该快照保存时不存在决策草案。"));
      ds.forEach(function (d) {
        var cardEl = el("div", "decision-card is-frozen dc-snap-card");
        var h = el("div", "batch-card-head");
        var nm = el("div", "batch-name");
        nm.appendChild(bdi(d.name));
        nm.appendChild(el("span", "decision-status " + (STATUS_CLASS[d.status] || ""),
          statusLabel(d.status)));
        h.appendChild(nm);
        cardEl.appendChild(h);
        var info = el("div", "batch-card-info");
        var bn = el("span"); bn.appendChild(document.createTextNode("批次："));
        bn.appendChild(bdi(d.batchName));
        info.appendChild(bn);
        info.appendChild(el("span", "muted",
          " · 门槛 " + d.threshold + " · " + formatTime(d.updatedAt)));
        cardEl.appendChild(info);

        var prog = decisionProgressOf(d);
        var pl = el("div", "batch-progress-label");
        pl.setAttribute("dir", "ltr");
        pl.textContent = "通过 " + prog.approved + "/" + prog.total +
          " · 待投票 " + prog.counts.waiting + " · 驳回 " + prog.counts.rejected +
          " · 未定 " + prog.counts.pending;
        cardEl.appendChild(pl);

        (d.items || []).forEach(function (it) {
          var line = el("div", "dc-snap-item");
          var tally = core.tallyVotes(it.votes);
          line.setAttribute("dir", "ltr");
          line.appendChild(el("span", "dc-disp", dispositionLabel(it.disposition)));
          line.appendChild(document.createTextNode(" · 段#" + (it.paraIndex + 1) + " "));
          var q = el("span"); q.appendChild(bdi(it.quote));
          line.appendChild(q);
          line.appendChild(document.createTextNode(" · 通过 " + tally.counts.approve +
            " / 驳回 " + tally.counts.reject + " / 弃权 " + tally.counts.abstain));
          cardEl.appendChild(line);
        });
        (d.executions || []).forEach(function (ex) {
          var exl = el("div", "ann-meta" + (ex.undone ? " is-undone" : ""));
          exl.setAttribute("dir", "ltr");
          exl.textContent = (ex.trigger === "scheduled" ? "定时自动执行 "
              : ex.trigger === "retry" ? "重试执行 " : "执行 ") +
            formatTime(ex.at) + " · 成功 " +
            ex.counts.success + " / 冲突 " + ex.counts.conflict + " / 跳过 " +
            ex.counts.skipped + (ex.undone ? " · 已撤销" : "");
          cardEl.appendChild(exl);
        });
        box.appendChild(cardEl);
      });

      // 快照保存时刻的执行队列
      var tasks = snap.executionTasks;
      if (Array.isArray(tasks) && tasks.length) {
        var tTitle = el("div", "snap-section-title",
          "执行队列（" + tasks.length + "）");
        box.appendChild(tTitle);
        tasks.forEach(function (t) {
          var tc = el("div", "task-card task-" + t.status + " dc-snap-task");
          var r1 = el("div", "task-row task-row-main");
          var nm = el("span", "task-name"); nm.appendChild(bdi(t.decisionName));
          r1.appendChild(nm);
          r1.appendChild(el("span", "task-status " + (TASK_STATUS_CLASS[t.status] || ""),
            taskStatusLabel(t.status)));
          tc.appendChild(r1);
          var meta = el("div", "task-meta");
          meta.setAttribute("dir", "ltr");
          meta.textContent = "计划 " + formatTime(t.scheduledAt) +
            " · 发布 " + formatTime(t.publishedAt) +
            (t.finishedAt ? " · 结束 " + formatTime(t.finishedAt) : "") +
            " · 成功条目 " + (t.successAnnotationIds || []).length;
          tc.appendChild(meta);
          box.appendChild(tc);
        });
      }

      var m = openModal("快照决策：" + (snapshotName || snap.name), box, {
        buttons: [button("关闭", null, function () { m.close(); })]
      });
    }).catch(function (err) {
      toast("读取快照决策失败：" + err.message, "error");
    });
  }

  // 快照摘要是纯数据（无 window.DecisionCore 的进度计算上下文），本地复刻一份
  function decisionProgressOf(d) {
    var counts = { pending: 0, waiting: 0, rejected: 0, approved: 0 };
    (d.items || []).forEach(function (it) {
      var st = core.itemState(it, d.threshold || 1);
      counts[st]++;
    });
    return { total: (d.items || []).length, counts: counts,
             approved: counts.approved };
  }

  /* ---------- 错误处理 ---------- */

  function handleError(err, showError, action) {
    var msg;
    if (err.status === 409 && err.code === "version_conflict") {
      msg = "版本冲突：决策集合已被其他页面更新（当前版本 " +
        ((err.data && err.data.currentRev) != null ? err.data.currentRev : "—") +
        "），本次" + action + "已被拒绝，没有覆盖较新内容。已按最新数据刷新，请重试。";
      loadList(true);
    } else if (err.status === 428) {
      msg = "缺少版本号，请刷新决策列表后重试。";
      loadList(true);
    } else {
      msg = action + "失败：" + err.message;
    }
    showError(msg);
  }

  function handleDetailError(err, showError, modal, action) {
    if (err.status === 409 && err.code === "version_conflict") {
      showError("版本冲突：" + err.message + " 已为你重新加载草案最新内容，请重试。");
      loadList(true);
      refreshDetail(modal);
    } else if (err.status === 428) {
      showError("缺少版本号，请刷新后重试。");
      loadList(true);
      refreshDetail(modal);
    } else {
      showError(action + "失败：" + err.message + "（当前页面内容已保留）");
    }
  }

  /* ---------- 绑定 ---------- */

  $("decision-add").addEventListener("click", openComposer);
  $("decision-refresh").addEventListener("click", function () { loadList(); });
  var tasksBtn = $("decision-tasks");
  if (tasksBtn) tasksBtn.addEventListener("click", function () { openQueuePanel(); });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) loadList(true);
  });
  window.addEventListener("focus", function () { loadList(true); });

  window.DecisionsUI = {
    reload: loadList,
    openDetail: openDetail,
    openComposerForBatch: function (batchId) { openComposer(batchId); },
    openQueue: function () { openQueuePanel(); },
    openSnapshotDecisions: openSnapshotDecisions
  };

  /* ---------- 启动 ---------- */
  loadList();
})();
