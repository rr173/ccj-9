/* permissions.js
 * 角色委派与操作权限 UI：
 *   - 顶栏切换“当前成员身份”（X-Member 头），页面所有接口都带该身份，
 *     角色变更后刷新即使用最新权限（服务端每次请求实时判定）；
 *   - 负责人可对回放空间 / 复核会话 / 纠错批次授予四类角色
 *     （查看 view / 复核 review / 审批 approve / 执行 execute），
 *     设置成员、生效/失效时间；重复委派、职责冲突、负责人自审、
 *     旧页面并发提交都按服务端返回的错误码明确提示，绝不静默覆盖；
 *   - 可撤销委派（已撤销/已过期的记录保留供审计）、查询当前成员的
 *     生效角色、查看授予/撤销操作记录与全部拒绝原因（重启后仍可查）；
 *   - 普通成员可对三类资源提交“授予/撤销申请”，负责人逐项批准/拒绝
 *     （拒绝必须填原因、不能审批自己的申请、过期/旧版本审批明确拒绝），
 *     批准后才生成正式委派，双方都能看到状态/处理人/时间；
 *   - 按指定未来时刻预览某成员的有效角色（即将生效/即将失效/撤销/
 *     待处理申请四组），预览纯只读、绝不修改正式权限。
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
    if (options.requestVersion != null) {
      headers["X-Request-Version"] = String(options.requestVersion);
    }
    var init = { method: method, headers: headers };
    if (options.body != null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      var permRev = res.headers.get("X-Permission-Rev");
      var reqRev = res.headers.get("X-Permission-Request-Rev");
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
        return { data: data, permRev: permRev, reqRev: reqRev };
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
    requestRev: "0",
    filter: { scope: "", resourceId: "", member: "" },
    delegations: [],
    requests: []
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

    /* ---- ④ 权限变更申请（普通成员提交，负责人逐项审批） ---- */
    var requestSection = el("div", "replay-section");
    requestSection.appendChild(el("h4", null,
      "④ 权限变更申请（提交后等待负责人逐项批准；批准后才生成正式委派）"));
    var rform = el("div", "perm-form");
    var rKind = el("select");
    [["grant", "授予申请"], ["revoke", "撤销申请"]].forEach(function (p) {
      rKind.appendChild(new Option(p[1], p[0]));
    });
    var rScope = el("select");
    [["space", "回放空间"], ["session", "复核会话"], ["batch", "纠错批次"]]
      .forEach(function (p) { rScope.appendChild(new Option(p[1], p[0])); });
    var rResource = el("input");
    rResource.placeholder = "资源 id（空间/会话/批次 id）";
    var rRole = el("select");
    [["view", "查看"], ["review", "复核"], ["approve", "审批"],
     ["execute", "执行"]].forEach(function (p) {
      rRole.appendChild(new Option(p[1] + "（" + p[0] + "）", p[0]));
    });
    var rDelegation = el("input");
    rDelegation.placeholder = "撤销申请：正式委派 id（del_…）";
    var rEffective = el("input");
    rEffective.type = "datetime-local"; rEffective.step = "1";
    rEffective.title = "授予申请生效时间（留空=批准后立即生效）";
    var rExpire = el("input");
    rExpire.type = "datetime-local"; rExpire.step = "1";
    rExpire.value = dtLocal(new Date(Date.now() + 24 * 3600000));
    rExpire.title = "授予申请失效时间（必填）";
    var rNote = el("input");
    rNote.placeholder = "申请说明（可选，≤500 字）";
    function rfield(label, node) {
      var wrap = el("label", "perm-field");
      wrap.appendChild(el("span", null, label));
      wrap.appendChild(node);
      return wrap;
    }
    rform.appendChild(rfield("类型", rKind));
    rform.appendChild(rfield("资源", rScope));
    rform.appendChild(rfield("资源 id", rResource));
    rform.appendChild(rfield("角色", rRole));
    rform.appendChild(rfield("委派 id", rDelegation));
    rform.appendChild(rfield("生效", rEffective));
    rform.appendChild(rfield("失效", rExpire));
    rform.appendChild(rfield("说明", rNote));
    rform.appendChild(button("提交申请", "primary", function () {
      var body = {
        kind: rKind.value,
        scope: rScope.value,
        resourceId: rResource.value.trim(),
        role: rRole.value,
        note: rNote.value.trim()
      };
      if (rKind.value === "revoke") {
        body.delegationId = rDelegation.value.trim();
      } else {
        body.expireAt = rExpire.value ? new Date(rExpire.value).toISOString() : "";
        if (rEffective.value) {
          body.effectiveAt = new Date(rEffective.value).toISOString();
        }
      }
      api("POST", "/api/permissions/requests",
        { body: body, ifMatch: state.requestRev }).then(function (r) {
          state.requestRev = r.reqRev;
          toast("申请已提交，等待负责人审批（申请有效期 72 小时）");
          rNote.value = ""; rDelegation.value = "";
          loadRequests();
        }).catch(handleRequestError);
    }));
    requestSection.appendChild(rform);
    requestSection.appendChild(el("div", "snap-note",
      "重复申请（同成员同角色已有待处理申请）、与正式委派或其它待处理申请的" +
      "同一时间窗冲突、负责人自审、撤销已撤销/已过期委派都会被明确拒绝；" +
      "申请被拒绝不改变任何权限，可在调整后重新申请。"));
    box.appendChild(requestSection);

    /* ---- ⑤ 申请清单（我的申请 + 负责人待审批，逐项批准/拒绝） ---- */
    var reqListSection = el("div", "replay-section");
    var reqHead = el("div", "replay-section-head");
    reqHead.appendChild(el("h4", null, "⑤ 申请与审批（状态 / 处理人 / 处理时间 / 拒绝原因）"));
    reqHead.appendChild(button("刷新申请"));
    reqHead.lastChild.addEventListener("click", function () { loadRequests(); });
    reqListSection.appendChild(reqHead);

    var reqFilterBar = el("div", "perm-filter-bar");
    var rfScope = el("select");
    [["", "全部类型"], ["space", "回放空间"], ["session", "复核会话"],
     ["batch", "纠错批次"]].forEach(function (p) {
      rfScope.appendChild(new Option(p[1], p[0]));
    });
    var rfResource = el("input");
    rfResource.placeholder = "按资源 id 筛选";
    var rfMine = el("input");
    rfMine.type = "checkbox";
    rfMine.id = "perm-rf-mine";
    var rfMineLabel = el("label", null, "只看我的申请 ");
    rfMineLabel.appendChild(rfMine);
    var rfStatus = el("select");
    [["", "全部状态"], ["pending", "待处理"], ["approved", "已批准"],
     ["rejected", "已拒绝"], ["expired", "已过期"]].forEach(function (p) {
      rfStatus.appendChild(new Option(p[1], p[0]));
    });
    reqFilterBar.appendChild(el("label", null, "类型 "));
    reqFilterBar.appendChild(rfScope);
    reqFilterBar.appendChild(el("label", null, " 资源 "));
    reqFilterBar.appendChild(rfResource);
    reqFilterBar.appendChild(rfMineLabel);
    reqFilterBar.appendChild(el("label", null, " 状态 "));
    reqFilterBar.appendChild(rfStatus);
    var rfBtn = button("筛选申请");
    reqFilterBar.appendChild(rfBtn);
    reqListSection.appendChild(reqFilterBar);

    var reqList = el("div", "perm-list");
    reqListSection.appendChild(reqList);
    var reqLogsBtn = button("申请审计记录");
    reqLogsBtn.addEventListener("click", function () {
      openLogs("申请流审计记录（提交/批准/拒绝/过期）",
        "/api/permissions/requests/logs", "logs", true);
    });
    reqListSection.appendChild(reqLogsBtn);
    box.appendChild(reqListSection);

    /* ---- ⑥ 未来时刻生效预览（纯只读，不修改正式权限） ---- */
    var previewSection = el("div", "replay-section");
    previewSection.appendChild(el("h4", null,
      "⑥ 生效预览（指定未来时刻查看有效角色；预览绝不修改正式权限）"));
    var pbar = el("div", "perm-filter-bar");
    var pScope = el("select");
    [["space", "回放空间"], ["session", "复核会话"], ["batch", "纠错批次"]]
      .forEach(function (p) { pScope.appendChild(new Option(p[1], p[0])); });
    var pResource = el("input");
    pResource.placeholder = "资源 id";
    var pMember = el("input");
    pMember.placeholder = "成员（留空=当前身份）";
    var pAt = el("input");
    pAt.type = "datetime-local"; pAt.step = "1";
    pAt.title = "预览时刻（必填；可选择未来任意时刻）";
    pbar.appendChild(el("label", null, "类型 "));
    pbar.appendChild(pScope);
    pbar.appendChild(el("label", null, " 资源 "));
    pbar.appendChild(pResource);
    pbar.appendChild(el("label", null, " 成员 "));
    pbar.appendChild(pMember);
    pbar.appendChild(el("label", null, " 时刻 "));
    pbar.appendChild(pAt);
    var quick1h = button("+1小时");
    quick1h.addEventListener("click", function () {
      pAt.value = dtLocal(new Date(Date.now() + 3600000));
    });
    pbar.appendChild(quick1h);
    var quick7d = button("+7天");
    quick7d.addEventListener("click", function () {
      pAt.value = dtLocal(new Date(Date.now() + 7 * 24 * 3600000));
    });
    pbar.appendChild(quick7d);
    pbar.appendChild(button("预览", "primary", function () {
      var rid = pResource.value.trim();
      if (!rid) { toast("请输入资源 id", "error"); return; }
      if (!pAt.value) { toast("请选择预览时刻", "error"); return; }
      var qs = "scope=" + encodeURIComponent(pScope.value) +
        "&resourceId=" + encodeURIComponent(rid) +
        "&at=" + encodeURIComponent(new Date(pAt.value).toISOString());
      if (pMember.value.trim()) qs += "&member=" + encodeURIComponent(pMember.value.trim());
      api("GET", "/api/permissions/preview?" + qs).then(function (r) {
        renderPreview(r.data);
      }).catch(function (e) { toast(e.message, "error"); });
    }));
    previewSection.appendChild(pbar);
    var previewBox = el("div", "perm-preview");
    previewSection.appendChild(previewBox);
    box.appendChild(previewSection);

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
    rfBtn.addEventListener("click", loadRequests);

    function refresh() {
      who.textContent = "（身份：" + currentIdentity() + "）";
      loadList();
      loadRequests();
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

    function loadRequests() {
      var qs = [];
      if (rfScope.value) qs.push("scope=" + encodeURIComponent(rfScope.value));
      if (rfResource.value.trim()) {
        qs.push("resourceId=" + encodeURIComponent(rfResource.value.trim()));
      }
      if (rfMine.checked) qs.push("member=" + encodeURIComponent(currentIdentity()));
      if (rfStatus.value) qs.push("status=" + encodeURIComponent(rfStatus.value));
      api("GET", "/api/permissions/requests" +
        (qs.length ? "?" + qs.join("&") : "")).then(function (r) {
          state.requestRev = r.reqRev;
          state.requests = r.data.requests;
          renderRequests(reqList, r.data.requests);
        }).catch(function (e) {
          toast(e.message, "error");
        });
    }

    function renderRequests(container, list) {
      container.innerHTML = "";
      if (!list.length) {
        container.appendChild(el("div", "snap-empty", "暂无申请记录。"));
        return;
      }
      list.forEach(function (q) {
        var card = el("div", "perm-card perm-rq-" + q.displayState);
        var head = el("div", "perm-card-head");
        head.appendChild(el("span", "perm-role",
          (q.kind === "grant" ? "授予申请 · " : "撤销申请 · ") +
          (ROLE_LABELS[q.role] || q.role) + " · " +
          (SCOPE_LABELS[q.scope] || q.scope)));
        head.appendChild(el("span",
          "perm-badge perm-badge-" + q.displayState,
          requestStatusLabel(q.displayState)));
        card.appendChild(head);
        card.appendChild(el("div", null, "申请编号：" + q.id +
          "（v" + q.version + "）"));
        card.appendChild(el("div", null, "申请人：" + q.member));
        card.appendChild(el("div", null, "资源：" + q.resourceId));
        if (q.kind === "grant") {
          card.appendChild(el("div", null,
            "期望有效期：" + formatTime(q.effectiveAt) + " 至 " +
            formatTime(q.expireAt)));
        } else {
          card.appendChild(el("div", null, "目标委派：" + q.delegationId));
        }
        card.appendChild(el("div", null,
          "提交：" + (q.createdBy || "—") + " · " + formatTime(q.createdAt)));
        card.appendChild(el("div", null,
          "审批截止：" + formatTime(q.expiresAt)));
        if (q.decision) {
          card.appendChild(el("div", null,
            "处理：" +
            ({ approve: "批准", reject: "拒绝", expired: "过期" }[q.decision] ||
              q.decision) +
            " · " + (q.decidedBy || "—") + " · " + formatTime(q.decidedAt)));
          if (q.decisionReason) {
            card.appendChild(el("div", "perm-rq-reason",
              "原因：" + q.decisionReason));
          }
          if (q.generatedDelegationId) {
            card.appendChild(el("div", null,
              "已生成正式委派：" + q.generatedDelegationId));
          }
        }
        if (q.note) card.appendChild(el("div", "snap-note", "说明：" + q.note));
        if (q.displayState === "pending") {
          var actions = el("div", "perm-rq-actions");
          actions.appendChild(button("批准", "primary", function () {
            var reason = window.prompt(
              "批准原因（可留空；批准后立即生成正式委派/执行撤销）", "");
            if (reason === null) return;
            decideRequest(q, "approve", reason);
          }));
          actions.appendChild(button("拒绝", "danger", function () {
            var reason = window.prompt("拒绝原因（必填，申请人可见）", "");
            if (reason === null) return;
            if (!reason.trim()) {
              toast("拒绝必须填写原因", "error");
              return;
            }
            decideRequest(q, "reject", reason);
          }));
          card.appendChild(actions);
        }
        container.appendChild(card);
      });
    }

    function decideRequest(q, decision, reason) {
      api("POST", "/api/permissions/requests/" + q.id + "/decision",
        { body: { decision: decision, reason: reason },
          ifMatch: state.requestRev, requestVersion: q.version })
        .then(function (r) {
          state.requestRev = r.reqRev;
          state.rev = r.permRev || state.rev;
          toast(decision === "approve"
            ? "已批准申请 " + q.id + "，正式委派已即时生效"
            : "已拒绝申请 " + q.id + "（不改变任何权限）");
          loadRequests(); loadList();
        }).catch(handleRequestError);
    }

    refresh();
  }

  /* ================= 申请清单与审批 ================= */

  function requestStatusLabel(s) {
    return { pending: "待处理", approved: "已批准", rejected: "已拒绝",
      expired: "已过期", failed: "已失败" }[s] || s;
  }

  function renderPreview(d) {
    var box = document.querySelector(".perm-preview");
    if (!box) return;
    box.innerHTML = "";
    var head = el("div", "perm-preview-head");
    head.appendChild(el("span", null,
      "预览成员：" + d.member + " · 时刻：" + formatTime(d.at) +
      (d.isFuture ? "（未来）" : "（当前/过去）") +
      " · 依据 rev " + d.basedOn.permissionRev + "/" + d.basedOn.requestRev));
    box.appendChild(head);
    box.appendChild(el("div", "perm-preview-roles",
      "该时刻有效角色：" +
      (d.roles.length
        ? d.roles.map(function (r) { return ROLE_LABELS[r] + "(" + r + ")"; }).join("、")
        : "（无）") +
      "　当前有效角色：" +
      (d.currentRoles.length
        ? d.currentRoles.map(function (r) { return ROLE_LABELS[r]; }).join("、")
        : "（无）")));

    function group(title, items, mapper, kind) {
      var g = el("div", "perm-preview-group perm-pv-" + kind);
      g.appendChild(el("div", "perm-pv-title",
        title + "（" + items.length + "）"));
      if (!items.length) g.appendChild(el("div", "snap-empty", "无"));
      items.forEach(function (x) { g.appendChild(mapper(x)); });
      box.appendChild(g);
    }
    group("即将生效", d.activating, function (x) {
      return el("div", "perm-pv-line",
        ROLE_LABELS[x.role] + " · " + formatTime(x.effectiveAt) +
        " 起生效（正式委派 " + x.id + "）");
    }, "activating");
    group("即将失效", d.expiring, function (x) {
      return el("div", "perm-pv-line",
        ROLE_LABELS[x.role] + " · " + formatTime(x.expireAt) +
        " 到期（正式委派 " + x.id + "）");
    }, "expiring");
    group("已批准撤销（预览时刻前生效）", d.revoking, function (x) {
      return el("div", "perm-pv-line",
        ROLE_LABELS[x.role] + " · 因撤销申请 " + x.revokedByRequestId +
        " 已由 " + (x.revokedBy || "—") + " 于 " +
        formatTime(x.revokedAt) + " 撤销");
    }, "revoking");
    group("待处理申请（不改变预览角色）", d.pending, function (x) {
      if (x.kind === "grant") {
        return el("div", "perm-pv-line",
          "授予申请 " + x.id + "：" + ROLE_LABELS[x.role] + "（" +
          formatTime(x.effectiveAt) + " ~ " + formatTime(x.expireAt) +
          "），审批截止 " + formatTime(x.expiresAt) +
          (x.wouldActiveAt ? "；若批准，预览时刻将生效" : "；若批准，预览时刻也不在窗口内"));
      }
      return el("div", "perm-pv-line",
        "撤销申请 " + x.id + "：针对委派 " + x.delegationId +
        " 的" + ROLE_LABELS[x.role] + "角色，审批截止 " + formatTime(x.expiresAt));
    }, "pending");
    box.appendChild(el("div", "snap-note",
      "预览为纯只读计算：待处理申请一律不计入有效角色；本接口不写入、" +
      "不推进任何版本，也不改变正式权限。"));
  }

  function statusLabel(s) {
    return { active: "生效中", expired: "已过期", revoked: "已撤销",
      pending: "未生效" }[s] || s;
  }

  function openLogs(title, url, key, isRequestLog) {
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
        var line = el("div", "perm-logline perm-log-" +
          (isRequestLog && (x.action === "reject" || x.action === "expire")
            ? "deny" : "ok"));
        if (isRequestLog) {
          var actionLabel = {
            submit: "提交", approve_grant: "批准授予", approve_revoke: "批准撤销",
            reject: "拒绝", expire: "过期"
          }[x.action] || x.action;
          line.appendChild(el("span", null,
            formatTime(x.at) + " · " + actionLabel + " · " +
            (SCOPE_LABELS[x.scope] || x.scope) + " · " +
            (ROLE_LABELS[x.role] || x.role) + " · 申请人 " + x.member +
            " · 处理人 " + (x.actor || "—") + " · " + x.requestId +
            (x.version ? " v" + x.version : "")));
          if (x.detail && x.detail.reason) {
            line.appendChild(el("div", "perm-log-msg", "原因：" + x.detail.reason));
          }
          if (x.detail && x.detail.generatedDelegationId) {
            line.appendChild(el("div", "perm-log-msg",
              "正式委派：" + x.detail.generatedDelegationId));
          }
        } else if (key === "logs") {
          line.appendChild(el("span", null,
            formatTime(x.at) + " · " + (x.action === "grant" ? "授予" : "撤销") +
            " · " + (SCOPE_LABELS[x.scope] || x.scope) + " · " +
            (ROLE_LABELS[x.role] || x.role) + " · 成员 " + x.member +
            " · 操作人 " + x.actor +
            (x.requestId ? " · 经申请 " + x.requestId : "")));
        } else {
          line.appendChild(el("span", null,
            formatTime(x.at) + " · " + x.code + " · " +
            (x.member || "（无身份）") + " · " +
            (SCOPE_LABELS[x.scope] || x.scope || "") +
            (x.resourceId ? " " + x.resourceId : "") +
            (x.action ? " · " + x.action : "") +
            (x.requestId ? " · 申请 " + x.requestId : "")));
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

  function handleRequestError(e) {
    if (e.code === "version_conflict") {
      toast("申请集合已被其他页面更新（旧版本提交冲突），请刷新后重试，" +
        "本次提交未写入", "error");
    } else if (e.code === "request_version_conflict") {
      toast("该申请已被其他负责人页面处理（当前版本 " +
        (e.data && e.data.currentVersion) + "），旧版本审批被拒绝，" +
        "请刷新后查看最新状态", "error");
    } else if (e.code === "request_expired") {
      toast("申请已过审批截止时间，过期审批明确拒绝，不改变任何权限", "error");
    } else if (e.code === "self_approval") {
      toast("负责人不能审批自己提交的申请（申请与审批职责分离）", "error");
    } else if (e.code === "duplicate_request" ||
               e.code === "duplicate_request_window") {
      toast("重复申请被拒绝：已有同角色待处理申请或时间窗重叠，" +
        "请等待处理或先调整原申请", "error");
    } else if (e.code === "duplicate_revoke_request") {
      toast("该委派已有待处理的撤销申请，不能重复申请", "error");
    } else if (e.code === "conflicting_request_roles" ||
               e.code === "conflicting_roles") {
      toast("审批与执行角色时间窗冲突（职责分离），同一成员不能同时持有", "error");
    } else if (e.code === "request_not_pending") {
      toast("该申请已处理，只有待处理申请可以审批", "error");
    } else if (e.code === "reject_reason_required") {
      toast("拒绝申请必须填写原因", "error");
    } else if (e.code === "not_resource_owner") {
      toast("只有资源负责人才能审批权限变更申请", "error");
    } else if (e.code === "request_for_other_member") {
      toast("只能以自己的身份提交申请，不能替其他成员申请", "error");
    } else {
      handleGrantError(e, function () {});
    }
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
