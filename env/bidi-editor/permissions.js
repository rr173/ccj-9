/* permissions.js
 * 角色委派与操作权限 UI：
 *   - 顶栏切换“当前成员身份”（X-Member 头），页面所有接口都带该身份，
 *     角色变更后刷新即使用最新权限（服务端每次请求实时判定）；
 *   - 负责人可对回放空间 / 复核会话 / 纠错批次授予四类角色
 *     （查看 view / 复核 review / 审批 approve / 执行 execute），
 *     设置成员、生效/失效时间；重复委派、职责冲突、负责人自审、
 *     旧页面并发提交都按服务端返回的错误码明确提示，绝不静默覆盖；
 *   - 可撤销委派（已撤销/已过期的记录保留供审计）、查询当前成员的
 *     生效角色、查看授予/撤销操作记录与全部拒绝原因（重启后仍可查）。
 */
(function () {
  "use strict";

  var PC = window.PermissionCore;
  var ROLE_LABELS = PC ? PC.ROLE_LABELS
    : { view: "查看", review: "复核", approve: "审批", execute: "执行" };
  var SCOPE_LABELS = PC ? PC.SCOPE_LABELS
    : { space: "回放空间", session: "复核会话", batch: "纠错批次" };

  var IDENTITY_KEY = "bidi.permission.member";

  // 供其他面板（replay/replay-archive/replay-reconcile）统一读取当前身份。
  // HTTP 头只能是 Latin-1，非 ASCII 成员名做百分号编码（服务端 decodeMember 还原）。
  window.PermissionIdentity = {
    get: function () { return localStorage.getItem(IDENTITY_KEY) || "负责人"; },
    header: function () {
      var name = this.get();
      return /^[\x20-\x7E]+$/.test(name) ? name : encodeURIComponent(name);
    }
  };

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

  // 当前成员身份（持久化到 localStorage）；缺省“负责人”
  function currentIdentity() { return window.PermissionIdentity.get(); }
  function setIdentity(name) { localStorage.setItem(IDENTITY_KEY, name); }

  function api(method, url, options) {
    options = options || {};
    var headers = { Accept: "application/json" };
    headers["X-Member"] = window.PermissionIdentity.header();
    if (options.ifMatch != null) headers["If-Match"] = String(options.ifMatch);
    var init = { method: method, headers: headers };
    if (options.body != null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      var permRev = res.headers.get("X-Permission-Rev");
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
        return { data: data, permRev: permRev };
      });
    });
  }

  function dtLocal(d) {
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  var state = {
    rev: "0",
    filter: { scope: "", resourceId: "", member: "" },
    delegations: []
  };

  /* ================= 主面板 ================= */

  function openCenter() {
    var box = el("div", "perm-center");

    var identityBar = el("div", "perm-identity-bar");
    identityBar.appendChild(el("span", null, "当前成员身份："));
    var identityInput = el("input");
    identityInput.type = "text";
    identityInput.maxLength = 50;
    identityInput.value = currentIdentity();
    identityInput.title = "以该成员身份访问所有接口（X-Member）；切换后立即按其有效角色判定权限";
    identityBar.appendChild(identityInput);
    identityBar.appendChild(button("切换身份", "primary", function () {
      var name = identityInput.value.trim();
      if (!name) { toast("成员身份不能为空", "error"); return; }
      setIdentity(name);
      toast("已切换为：" + name);
      refresh();
    }));
    var who = el("span", "perm-who");
    identityBar.appendChild(who);
    box.appendChild(identityBar);

    /* ---- 授予表单 ---- */
    var grantSection = el("div", "replay-section");
    grantSection.appendChild(el("h4", null, "① 授予角色（仅资源负责人）"));
    var form = el("div", "perm-form");

    var scopeSel = el("select");
    [["", "资源类型…"], ["space", "回放空间"], ["session", "复核会话"],
     ["batch", "纠错批次"]].forEach(function (p) {
      scopeSel.appendChild(new Option(p[1], p[0]));
    });
    var resourceInput = el("input");
    resourceInput.placeholder = "资源 id（空间/会话/批次 id）";
    var memberInput = el("input");
    memberInput.placeholder = "成员名称";
    var roleSel = el("select");
    [["view", "查看"], ["review", "复核"], ["approve", "审批"],
     ["execute", "执行"]].forEach(function (p) {
      roleSel.appendChild(new Option(p[1] + "（" + p[0] + "）", p[0]));
    });
    var effectiveInput = el("input");
    effectiveInput.type = "datetime-local";
    effectiveInput.step = "1";
    effectiveInput.title = "生效时间（留空=立即生效）";
    var expireInput = el("input");
    expireInput.type = "datetime-local";
    expireInput.step = "1";
    expireInput.value = dtLocal(new Date(Date.now() + 24 * 3600000));
    expireInput.title = "失效时间（必填，必须晚于当前）";
    var reasonInput = el("input");
    reasonInput.placeholder = "委派原因（可选）";

    function field(label, node) {
      var wrap = el("label", "perm-field");
      wrap.appendChild(el("span", null, label));
      wrap.appendChild(node);
      return wrap;
    }
    form.appendChild(field("资源", scopeSel));
    form.appendChild(field("资源 id", resourceInput));
    form.appendChild(field("成员", memberInput));
    form.appendChild(field("角色", roleSel));
    form.appendChild(field("生效", effectiveInput));
    form.appendChild(field("失效", expireInput));
    form.appendChild(field("原因", reasonInput));
    form.appendChild(button("授予", "primary", function () {
      var body = {
        scope: scopeSel.value,
        resourceId: resourceInput.value.trim(),
        role: roleSel.value,
        member: memberInput.value.trim(),
        expireAt: expireInput.value ? new Date(expireInput.value).toISOString() : "",
        reason: reasonInput.value.trim()
      };
      if (effectiveInput.value) {
        body.effectiveAt = new Date(effectiveInput.value).toISOString();
      }
      api("POST", "/api/permissions/delegations",
        { body: body, ifMatch: state.rev }).then(function (r) {
          state.rev = r.permRev;
          toast("已授予 " + (ROLE_LABELS[body.role]) + " 角色给 " + body.member);
          memberInput.value = ""; reasonInput.value = "";
          refresh();
        }).catch(function (e) { handleGrantError(e, refresh); });
    }));
    grantSection.appendChild(form);
    var grantHint = el("div", "snap-note",
      "重复委派（同成员同角色时间窗重叠）、approve/execute 同人时间窗冲突、" +
      "负责人自审都会被明确拒绝；旧页面用旧版本号提交会收到 409 冲突且不覆盖新配置。");
    grantSection.appendChild(grantHint);
    box.appendChild(grantSection);

    /* ---- 筛选 + 委派列表 ---- */
    var listSection = el("div", "replay-section");
    var listHead = el("div", "replay-section-head");
    listHead.appendChild(el("h4", null, "② 委派记录（撤销/过期后仍保留供审计）"));
    listHead.appendChild(button("刷新"));
    listHead.lastChild.addEventListener("click", refresh);
    listSection.appendChild(listHead);

    var filterBar = el("div", "perm-filter-bar");
    var fScope = el("select");
    [["", "全部类型"], ["space", "回放空间"], ["session", "复核会话"],
     ["batch", "纠错批次"]].forEach(function (p) {
      fScope.appendChild(new Option(p[1], p[0]));
    });
    var fResource = el("input");
    fResource.placeholder = "按资源 id 筛选";
    var fMember = el("input");
    fMember.placeholder = "按成员筛选";
    filterBar.appendChild(el("label", null, "类型 "));
    filterBar.appendChild(fScope);
    filterBar.appendChild(el("label", null, " 资源 "));
    filterBar.appendChild(fResource);
    filterBar.appendChild(el("label", null, " 成员 "));
    filterBar.appendChild(fMember);
    var btnFilter = button("筛选");
    filterBar.appendChild(btnFilter);
    listSection.appendChild(filterBar);

    var list = el("div", "perm-list");
    listSection.appendChild(list);
    box.appendChild(listSection);

    /* ---- 当前生效角色 / 操作记录 / 拒绝原因 ---- */
    var querySection = el("div", "replay-section");
    querySection.appendChild(el("h4", null, "③ 查询"));
    var qbar = el("div", "perm-filter-bar");
    var qResource = el("input");
    qResource.placeholder = "资源 id";
    var qScope = el("select");
    [["space", "回放空间"], ["session", "复核会话"], ["batch", "纠错批次"]]
      .forEach(function (p) { qScope.appendChild(new Option(p[1], p[0])); });
    qbar.appendChild(el("label", null, "类型 "));
    qbar.appendChild(qScope);
    qbar.appendChild(el("label", null, " 资源 "));
    qbar.appendChild(qResource);
    qbar.appendChild(button("我的生效角色", null, function () {
      var rid = qResource.value.trim();
      if (!rid) { toast("请输入资源 id", "error"); return; }
      api("GET", "/api/permissions/effective?scope=" +
        encodeURIComponent(qScope.value) + "&resourceId=" +
        encodeURIComponent(rid)).then(function (r) {
          var d = r.data;
          var roles = d.isOwner ? ["负责人（全部角色）"]
            : d.roles.map(function (x) { return ROLE_LABELS[x] + "(" + x + ")"; });
          toast("当前身份 “" + (d.member) + "” 在该资源的角色：" +
            (roles.length ? roles.join("、") : "（无生效角色）") +
            (d.configured ? "" : "（资源尚未启用权限管控）"),
            d.isOwner || roles.length ? "info" : "error");
        }).catch(function (e) { toast(e.message, "error"); });
    }));
    qbar.appendChild(button("操作记录", null, function () {
      openLogs("操作记录（授予/撤销）", "/api/permissions/logs", "logs");
    }));
    qbar.appendChild(button("拒绝原因", null, function () {
      openLogs("拒绝记录（未授权/过期/冲突/自审）",
        "/api/permissions/denials", "denials");
    }));
    querySection.appendChild(qbar);
    box.appendChild(querySection);

    var revLine = el("div", "snap-rev", "权限集合版本 —");
    box.appendChild(revLine);

    var modal = openModal("角色委派与操作权限", box, {
      buttons: [button("关闭", null, function () {})]
    });

    btnFilter.addEventListener("click", function () {
      state.filter = { scope: fScope.value,
        resourceId: fResource.value.trim(), member: fMember.value.trim() };
      loadList();
    });

    function refresh() {
      who.textContent = "（身份：" + currentIdentity() + "）";
      loadList();
    }

    function loadList() {
      var qs = [];
      if (state.filter.scope) qs.push("scope=" + encodeURIComponent(state.filter.scope));
      if (state.filter.resourceId) {
        qs.push("resourceId=" + encodeURIComponent(state.filter.resourceId));
      }
      if (state.filter.member) qs.push("member=" + encodeURIComponent(state.filter.member));
      api("GET", "/api/permissions/delegations" +
        (qs.length ? "?" + qs.join("&") : "")).then(function (r) {
          state.rev = r.permRev;
          state.delegations = r.data.delegations;
          revLine.textContent = "权限集合版本 " + r.data.rev +
            "（共 " + r.data.count + " 条）";
          renderList(list, state.delegations);
        }).catch(function (e) { toast(e.message, "error"); });
    }

    function renderList(container, delegations) {
      container.innerHTML = "";
      if (!delegations.length) {
        container.appendChild(el("div", "snap-empty", "暂无委派记录。"));
        return;
      }
      delegations.forEach(function (d) {
        var card = el("div", "perm-card perm-state-" + d.status);
        var head = el("div", "perm-card-head");
        head.appendChild(el("span", "perm-role",
          (ROLE_LABELS[d.role] || d.role) + " · " +
          (SCOPE_LABELS[d.scope] || d.scope)));
        var badge = el("span", "perm-badge perm-badge-" + d.status,
          statusLabel(d.status));
        head.appendChild(badge);
        card.appendChild(head);
        card.appendChild(el("div", null, "成员：" + d.member));
        card.appendChild(el("div", null, "资源：" + d.resourceId));
        card.appendChild(el("div", null,
          "有效期：" + formatTime(d.effectiveAt) + " 至 " + formatTime(d.expireAt)));
        card.appendChild(el("div", null,
          "授予：" + (d.grantedBy || "—") + " · " + formatTime(d.grantedAt)));
        if (d.status === "revoked") {
          card.appendChild(el("div", null,
            "撤销：" + (d.revokedBy || "—") + " · " + formatTime(d.revokedAt) +
            (d.revokeReason ? "（" + d.revokeReason + "）" : "")));
        }
        if (d.status === "active") {
          card.appendChild(button("撤销", "danger", function () {
            var reason = window.prompt("撤销原因（可留空）", "");
            if (reason === null) return;
            api("POST", "/api/permissions/delegations/" + d.id + "/revoke",
              { body: { reason: reason }, ifMatch: state.rev })
              .then(function (r) {
                state.rev = r.permRev;
                toast("已撤销 " + d.member + " 的" + (ROLE_LABELS[d.role]) + "角色");
                loadList();
              }).catch(function (e) {
                if (e.code === "version_conflict") {
                  toast("权限配置已被其他页面更新，请刷新后重试（本次未写入）", "error");
                } else {
                  toast(e.message, "error");
                }
              });
          }));
        }
        container.appendChild(card);
      });
    }

    refresh();
  }

  function statusLabel(s) {
    return { active: "生效中", expired: "已过期", revoked: "已撤销",
      pending: "未生效" }[s] || s;
  }

  function openLogs(title, url, key) {
    var box = el("div", "perm-logs");
    box.appendChild(el("div", "snap-note", "加载中…"));
    var m = openModal(title, box, { buttons: [button("关闭", null, function () {})] });
    api("GET", url).then(function (r) {
      box.innerHTML = "";
      var entries = r.data[key] || [];
      box.appendChild(el("div", "snap-note", "共 " + entries.length + " 条（时间倒序）"));
      if (!entries.length) {
        box.appendChild(el("div", "snap-empty", "暂无记录。"));
        return;
      }
      entries.slice(0, 500).forEach(function (x) {
        var line = el("div", "perm-logline perm-log-" + (x.ok === false ? "deny" : "ok"));
        if (key === "logs") {
          line.appendChild(el("span", null,
            formatTime(x.at) + " · " + (x.action === "grant" ? "授予" : "撤销") +
            " · " + (SCOPE_LABELS[x.scope] || x.scope) + " · " +
            (ROLE_LABELS[x.role] || x.role) + " · 成员 " + x.member +
            " · 操作人 " + x.actor));
        } else {
          line.appendChild(el("span", null,
            formatTime(x.at) + " · " + x.code + " · " +
            (x.member || "（无身份）") + " · " +
            (SCOPE_LABELS[x.scope] || x.scope || "") +
            (x.resourceId ? " " + x.resourceId : "") +
            (x.action ? " · " + x.action : "")));
          line.appendChild(el("div", "perm-log-msg", x.message || ""));
        }
        box.appendChild(line);
      });
    }).catch(function (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "snap-empty", "加载失败：" + e.message));
    });
    return m;
  }

  function handleGrantError(e, retry) {
    if (e.code === "version_conflict") {
      toast("权限配置已被其他页面更新（旧版本提交冲突），请刷新后重试，" +
        "本次提交未写入、未覆盖新配置", "error");
    } else if (e.code === "duplicate_delegation") {
      toast("重复委派被拒绝：该成员已有时间窗重叠的相同角色，" +
        "请先撤销原委派或调整时间窗", "error");
    } else if (e.code === "conflicting_roles") {
      toast("同一成员权限冲突：审批与执行角色的时间窗不能重叠（职责分离）", "error");
    } else if (e.code === "approver_is_owner" || e.code === "owner_self_approval") {
      toast("负责人自审被禁止：负责人不能担任自己批次的审批人", "error");
    } else if (e.code === "not_resource_owner") {
      toast("只有资源负责人才能配置角色委派", "error");
    } else if (e.code === "role_expired") {
      toast("该角色已过失效时间，请联系负责人重新委派", "error");
    } else if (e.code === "role_not_active") {
      toast("该角色尚未到生效时间", "error");
    } else if (e.code === "unauthorized") {
      toast("未授权：当前成员没有所需角色", "error");
    } else {
      toast(e.message, "error");
    }
  }

  /* ================= 挂载 ================= */

  function init() {
    var btn = $("permission-open-btn");
    if (!btn) return;
    btn.title = "为回放空间/复核会话/纠错批次配置查看、复核、审批、执行四类角色";
    btn.addEventListener("click", openCenter);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.PermissionUI = {
    openCenter: openCenter,
    currentIdentity: currentIdentity
  };
})();
