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

  // 关闭最上层弹窗（批量详情内逐项处理后重开前先关掉旧弹窗，避免叠加）
  function closeTopModal() {
    var overlays = document.querySelectorAll(".modal-overlay");
    if (overlays.length) overlays[overlays.length - 1].remove();
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
      var grpRev = res.headers.get("X-Permission-Group-Rev");
      var tplRev = res.headers.get("X-Permission-Template-Rev");
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
        return { data: data, permRev: permRev, reqRev: reqRev,
          grpRev: grpRev, tplRev: tplRev };
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
    groupRev: "0",
    templateRev: "0",
    filter: { scope: "", resourceId: "", member: "" },
    delegations: [],
    requests: [],
    groups: [],
    templates: []
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

    /* ---- ⑤b 申请分组与批量处理（负责人按资源/类型/成员/状态归组、整批审批） ---- */
    var groupSection = el("div", "replay-section");
    var groupHead = el("div", "replay-section-head");
    groupHead.appendChild(el("h4", null,
      "⑤b 申请分组与批量处理（命名 / 处理截止 / 备注；整批原子，任一条冲突全批不改）"));
    groupHead.appendChild(button("刷新分组"));
    groupHead.lastChild.addEventListener("click", loadGroups);
    groupSection.appendChild(groupHead);

    var gCreateBar = el("div", "perm-form");
    var gcScope = el("select");
    [["space", "回放空间"], ["session", "复核会话"], ["batch", "纠错批次"]]
      .forEach(function (p) { gcScope.appendChild(new Option(p[1], p[0])); });
    var gcResource = el("input");
    gcResource.placeholder = "资源 id（分组锁定单一资源）";
    var gcName = el("input");
    gcName.placeholder = "分组名称（必填，≤100 字）";
    var gcDeadline = el("input");
    gcDeadline.type = "datetime-local"; gcDeadline.step = "1";
    gcDeadline.title = "处理截止时间（可选）；到点/逾期写截止提醒审计";
    var gcNote = el("input");
    gcNote.placeholder = "分组备注（可选，≤500 字）";
    function gcField(label, node) {
      var wrap = el("label", "perm-field");
      wrap.appendChild(el("span", null, label));
      wrap.appendChild(node);
      return wrap;
    }
    gCreateBar.appendChild(gcField("资源", gcScope));
    gCreateBar.appendChild(gcField("资源 id", gcResource));
    gCreateBar.appendChild(gcField("名称", gcName));
    gCreateBar.appendChild(gcField("处理截止", gcDeadline));
    gCreateBar.appendChild(gcField("备注", gcNote));
    gCreateBar.appendChild(button("新建分组", "primary", function () {
      var body = {
        scope: gcScope.value,
        resourceId: gcResource.value.trim(),
        name: gcName.value.trim(),
        note: gcNote.value.trim()
      };
      if (gcDeadline.value) body.deadline = new Date(gcDeadline.value).toISOString();
      api("POST", "/api/permissions/request-groups",
        { body: body, ifMatch: state.groupRev }).then(function (r) {
          state.groupRev = r.grpRev;
          toast("已创建分组：" + body.name);
          gcName.value = ""; gcNote.value = ""; gcDeadline.value = "";
          loadGroups();
        }).catch(handleGroupError);
    }));
    groupSection.appendChild(gCreateBar);

    var groupList = el("div", "perm-list");
    groupSection.appendChild(groupList);
    var groupLogsBtn = button("分组独立审计记录");
    groupLogsBtn.addEventListener("click", function () {
      openGroupLogs("分组审计（分组变更 / 批量审批 / 截止提醒）",
        "/api/permissions/request-groups/logs");
    });
    groupSection.appendChild(groupLogsBtn);
    box.appendChild(groupSection);

    /* ---- ⑤c 申请模板与条件校验（负责人保存可复用模板；成员按模板发起） ---- */
    var tplSection = el("div", "replay-section");
    var tplHead = el("div", "replay-section-head");
    tplHead.appendChild(el("h4", null,
      "⑤c 申请模板（角色 / 申请类型 / 默认有效期 / 说明 / 适用成员范围；停用与旧版本不能再发起）"));
    tplHead.appendChild(button("刷新模板"));
    tplHead.lastChild.addEventListener("click", loadTemplates);
    tplSection.appendChild(tplHead);

    // 负责人新建模板表单
    var tCreateBar = el("div", "perm-form");
    var tcScope = el("select");
    [["space", "回放空间"], ["session", "复核会话"], ["batch", "纠错批次"]]
      .forEach(function (p) { tcScope.appendChild(new Option(p[1], p[0])); });
    var tcResource = el("input");
    tcResource.placeholder = "资源 id（模板锁定单一资源）";
    var tcName = el("input");
    tcName.placeholder = "模板名称（必填，≤100 字）";
    var tcKind = el("select");
    [["grant", "授予申请"], ["revoke", "撤销申请"]]
      .forEach(function (p) { tcKind.appendChild(new Option(p[1], p[0])); });
    var tcRole = el("select");
    [["view", "查看"], ["review", "复核"], ["approve", "审批"],
     ["execute", "执行"]].forEach(function (p) {
      tcRole.appendChild(new Option(p[1] + "（" + p[0] + "）", p[0]));
    });
    var tcDuration = el("input");
    tcDuration.type = "number";
    tcDuration.min = "60000";
    tcDuration.value = String(24 * 3600 * 1000);
    tcDuration.title = "默认有效期（毫秒）；授予模板必填，1 分钟 ~ 366 天";
    var tcDesc = el("input");
    tcDesc.placeholder = "模板说明（可选，≤500 字，对成员可见）";
    var tcScopeMode = el("select");
    [["all", "全体成员"], ["members", "指定成员"]]
      .forEach(function (p) { tcScopeMode.appendChild(new Option(p[1], p[0])); });
    var tcMembers = el("input");
    tcMembers.placeholder = "适用成员（逗号分隔；仅“指定成员”时生效）";
    function tcField(label, node) {
      var wrap = el("label", "perm-field");
      wrap.appendChild(el("span", null, label));
      wrap.appendChild(node);
      return wrap;
    }
    tCreateBar.appendChild(tcField("资源", tcScope));
    tCreateBar.appendChild(tcField("资源 id", tcResource));
    tCreateBar.appendChild(tcField("名称", tcName));
    tCreateBar.appendChild(tcField("类型", tcKind));
    tCreateBar.appendChild(tcField("角色", tcRole));
    tCreateBar.appendChild(tcField("默认有效期ms", tcDuration));
    tCreateBar.appendChild(tcField("说明", tcDesc));
    tCreateBar.appendChild(tcField("适用范围", tcScopeMode));
    tCreateBar.appendChild(tcField("成员名单", tcMembers));
    tCreateBar.appendChild(button("新建模板", "primary", function () {
      var body = {
        name: tcName.value.trim(),
        scope: tcScope.value,
        resourceId: tcResource.value.trim(),
        kind: tcKind.value,
        role: tcRole.value,
        description: tcDesc.value.trim(),
        memberScope: tcScopeMode.value === "all"
          ? { mode: "all" }
          : { mode: "members",
              members: tcMembers.value.split(/[,，]/).map(function (s) {
                return s.trim();
              }).filter(Boolean) }
      };
      if (tcKind.value === "grant") {
        body.defaultDurationMs = Number(tcDuration.value);
      }
      api("POST", "/api/permissions/request-templates",
        { body: body, ifMatch: state.templateRev }).then(function (r) {
          state.templateRev = r.tplRev;
          toast("已创建模板：" + body.name);
          tcName.value = ""; tcDesc.value = ""; tcMembers.value = "";
          loadTemplates();
        }).catch(handleTemplateError);
    }));
    tplSection.appendChild(tCreateBar);

    var tplList = el("div", "perm-list");
    tplSection.appendChild(tplList);
    var tplLogsBtn = button("模板审计记录（变更 / 使用 / 拒绝原因）");
    tplLogsBtn.addEventListener("click", function () {
      openTemplateLogs();
    });
    tplSection.appendChild(tplLogsBtn);
    box.appendChild(tplSection);

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
      loadGroups();
      loadTemplates();
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
        if (q.templateId) {
          card.appendChild(el("div", null,
            "来源模板：" + q.templateName + "（v" + q.templateVersion +
            " · " + q.templateId + "，模板日后修改不影响本申请）"));
        }
        card.appendChild(el("div", null,
          "所属分组：" + (q.groupName
            ? q.groupName + "（" + groupDeadlineLabel(q.groupDeadlineState) +
              " · 待处理 " + (q.groupPendingCount == null ? "—" : q.groupPendingCount) + "）"
            : "未分组")));
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

    /* ---------------- 申请分组 ---------------- */

    function loadGroups() {
      api("GET", "/api/permissions/request-groups").then(function (r) {
        state.groupRev = r.grpRev;
        state.groups = r.data.groups || [];
        renderGroups(groupList, state.groups);
      }).catch(function (e) {
        groupList.innerHTML = "";
        groupList.appendChild(el("div", "snap-empty",
          "分组加载失败：" + e.message));
      });
    }

    function isGroupOwnerView(g) {
      // 负责人视图含 pendingCount；普通成员摘要只含 myPendingCount
      return g.pendingCount !== undefined;
    }

    function renderGroups(container, groups) {
      container.innerHTML = "";
      if (!groups.length) {
        container.appendChild(el("div", "snap-empty",
          "暂无分组。负责人可新建分组并按资源/类型/成员/状态归组。"));
        return;
      }
      groups.forEach(function (g) {
        var card = el("div", "perm-card perm-group-card perm-dl-" +
          (g.deadlineState || "none"));
        var head = el("div", "perm-card-head");
        head.appendChild(el("span", "perm-role",
          "分组 · " + g.name + " · " + (SCOPE_LABELS[g.scope] || g.scope)));
        head.appendChild(el("span",
          "perm-badge perm-badge-group perm-dl-badge-" +
          (g.deadlineState || "none"),
          groupDeadlineLabel(g.deadlineState)));
        card.appendChild(head);
        card.appendChild(el("div", null, "资源：" + g.resourceId + "（v" + g.version + "）"));
        card.appendChild(el("div", null,
          "处理截止：" + (g.deadline ? formatTime(g.deadline) : "未设置")));
        if (g.note) card.appendChild(el("div", "snap-note", "备注：" + g.note));
        if (isGroupOwnerView(g)) {
          card.appendChild(el("div", null,
            "申请 " + g.totalCount + " 条 · 待处理 " + g.pendingCount +
            "（授予 " + g.grantCount + " / 撤销 " + g.revokeCount + "）"));
          var acts = el("div", "perm-rq-actions");
          acts.appendChild(button("打开/批量处理", "primary", function () {
            openGroupDetail(g.id);
          }));
          acts.appendChild(button("改名/截止/备注", null, function () {
            editGroup(g.id);
          }));
          acts.appendChild(button("删除分组", "danger", function () {
            deleteGroup(g.id);
          }));
          card.appendChild(acts);
        } else {
          // 普通成员摘要：只显示本人相关数量
          card.appendChild(el("div", null,
            "我的申请 " + (g.myTotalCount == null ? "—" : g.myTotalCount) +
            " 条 · 我的待处理 " + (g.myPendingCount == null ? "—" : g.myPendingCount)));
          card.appendChild(el("div", "snap-note",
            "普通成员仅可见本人申请所在分组的摘要"));
        }
        container.appendChild(card);
      });
    }

    function editGroup(id) {
      var g = state.groups.find(function (x) { return x.id === id; });
      if (!g) return;
      var box = el("div", "perm-form");
      var n = el("input"); n.value = g.name;
      var d = el("input"); d.type = "datetime-local"; d.step = "1";
      if (g.deadline) d.value = dtLocal(new Date(g.deadline));
      var note = el("input"); note.value = g.note || "";
      function f(label, node) {
        var wrap = el("label", "perm-field");
        wrap.appendChild(el("span", null, label)); wrap.appendChild(node);
        return wrap;
      }
      box.appendChild(f("名称", n));
      box.appendChild(f("处理截止（留空=取消截止；可改成过去以标记逾期）", d));
      box.appendChild(f("备注", note));
      var m = openModal("修改分组：" + g.name, box, { buttons: [] });
      var save = button("保存", "primary", function () {
        var body = { name: n.value.trim(), note: note.value.trim(),
          deadline: d.value ? new Date(d.value).toISOString() : null };
        api("PATCH", "/api/permissions/request-groups/" + id,
          { body: body, ifMatch: state.groupRev }).then(function (r) {
            state.groupRev = r.grpRev;
            toast("分组已更新");
            m.close(); loadGroups();
          }).catch(function (e) { handleGroupError(e); });
      });
      var cancel = button("取消", null, function () { m.close(); });
      m.foot.appendChild(save); m.foot.appendChild(cancel);
    }

    function deleteGroup(id) {
      var g = state.groups.find(function (x) { return x.id === id; });
      if (!g) return;
      if (!window.confirm("确认删除分组 “" + g.name +
          "”？分组内申请将解除归属（申请与权限不变）。")) return;
      api("DELETE", "/api/permissions/request-groups/" + id,
        { ifMatch: state.groupRev }).then(function (r) {
          state.groupRev = r.grpRev;
          state.requestRev = r.reqRev || state.requestRev;
          toast("分组已删除，解除归属 " + r.data.detachedRequests + " 条申请");
          loadGroups(); loadRequests();
        }).catch(handleGroupError);
    }

    /* ---------------- 申请模板 ---------------- */

    function loadTemplates() {
      api("GET", "/api/permissions/request-templates").then(function (r) {
        state.templateRev = r.tplRev;
        state.templates = r.data.templates || [];
        renderTemplates(tplList, state.templates);
      }).catch(function (e) {
        tplList.innerHTML = "";
        tplList.appendChild(el("div", "snap-empty",
          "模板加载失败：" + e.message));
      });
    }

    function isTemplateOwnerView(t) {
      // 负责人视图含 history；普通成员视图是裁剪版
      return Array.isArray(t.history);
    }

    function scopeText(t) {
      var ms = t.memberScope || { mode: "all" };
      return ms.mode === "all"
        ? "全体成员"
        : ("指定成员 " + (ms.memberCount == null ? ms.members.length : ms.memberCount) +
           " 名");
    }

    function renderTemplates(container, templates) {
      container.innerHTML = "";
      if (!templates.length) {
        container.appendChild(el("div", "snap-empty",
          "暂无模板。负责人可在上方为某个资源保存可复用的申请模板。"));
        return;
      }
      templates.forEach(function (t) {
        var card = el("div", "perm-card perm-tpl-card perm-tpl-" +
          (t.status || "active"));
        var head = el("div", "perm-card-head");
        head.appendChild(el("span", "perm-role",
          "模板 · " + t.name + " · " +
          (t.kind === "grant" ? "授予申请" : "撤销申请") + " · " +
          (ROLE_LABELS[t.role] || t.role) + " · " +
          (SCOPE_LABELS[t.scope] || t.scope)));
        var published = t.currentVersion ? "已发布 v" + t.currentVersion : "未发布";
        var stateText = t.status === "disabled" ? "已停用" : published;
        head.appendChild(el("span",
          "perm-badge perm-badge-" + (t.status === "disabled" ? "expired" : "approved"),
          stateText));
        card.appendChild(head);
        card.appendChild(el("div", null, "资源：" + t.resourceId));
        card.appendChild(el("div", null,
          "适用范围：" + scopeText(t)));
        if (isTemplateOwnerView(t)) {
          var draftLine = "草稿：无";
          if (t.draftStatus === "unpublished") {
            draftLine = "草稿：未发布（草稿 v" + (t.draft && t.draft.draftVersion) + "）";
          } else if (t.draftStatus === "scheduled") {
            draftLine = "草稿：计划 " + formatTime(t.scheduledAt) + " 发布";
          }
          card.appendChild(el("div", "snap-note", draftLine));
          card.appendChild(el("div", "snap-note",
            "当前已发布：" + (t.publishedVersion ? "v" + t.publishedVersion : "无") +
            (t.publishedAt ? " · " + formatTime(t.publishedAt) : "") +
            (t.publishedBy ? " · " + t.publishedBy : "")));
        }
        if (t.kind === "grant") {
          card.appendChild(el("div", null,
            "默认有效期：" + (t.defaultDurationMs != null
              ? Math.round(t.defaultDurationMs / 3600000) + " 小时" : "—")));
        }
        if (t.description) {
          card.appendChild(el("div", "snap-note", "说明：" + t.description));
        }
        var acts = el("div", "perm-rq-actions");
        acts.appendChild(button("用此模板发起申请", "primary", function () {
          submitFromTemplate(t);
        }));
        if (isTemplateOwnerView(t)) {
          acts.appendChild(button("修改草稿", null, function () { editTemplate(t.id); }));
          if (t.draftStatus === "unpublished") {
            acts.appendChild(button("立即发布", "primary", function () {
              publishTemplate(t.id, null);
            }));
            acts.appendChild(button("计划发布", null, function () {
              scheduleTemplatePublish(t.id);
            }));
            acts.appendChild(button("丢弃草稿", "danger", function () {
              discardTemplateDraft(t.id);
            }));
          }
          if (t.draftStatus === "scheduled" && t.draft) {
            acts.appendChild(button("取消计划发布", "danger", function () {
              cancelScheduledTemplate(t.id, t.draft.planId);
            }));
          }
          acts.appendChild(button("回滚", null, function () {
            rollbackTemplate(t.id);
          }));
          acts.appendChild(button("发布记录", null, function () {
            openTemplateVersions(t.id);
          }));
          if (t.status !== "disabled") {
            acts.appendChild(button("停用", "danger", function () {
              disableTemplate(t.id);
            }));
          }
        }
        card.appendChild(acts);
        container.appendChild(card);
      });
    }

    function editTemplate(id) {
      var t = state.templates.find(function (x) { return x.id === id; });
      if (!t) return;
      var box = el("div", "perm-form");
      var n = el("input"); n.value = t.name;
      var dur = el("input"); dur.type = "number"; dur.min = "60000";
      dur.value = t.defaultDurationMs != null ? String(t.defaultDurationMs) : "";
      var desc = el("input"); desc.value = t.description || "";
      var mode = el("select");
      [["all", "全体成员"], ["members", "指定成员"]].forEach(function (p) {
        mode.appendChild(new Option(p[1], p[0]));
      });
      mode.value = (t.memberScope && t.memberScope.mode) || "all";
      var members = el("input");
      members.value = (t.memberScope && t.memberScope.members || []).join("，");
      function f(label, node) {
        var wrap = el("label", "perm-field");
        wrap.appendChild(el("span", null, label));
        wrap.appendChild(node);
        return wrap;
      }
      box.appendChild(f("名称", n));
      if (t.kind === "grant") box.appendChild(f("默认有效期（毫秒）", dur));
      box.appendChild(f("说明", desc));
      box.appendChild(f("适用范围", mode));
      box.appendChild(f("成员名单（逗号分隔）", members));
      var m = openModal("修改模板草稿：" + t.name + "（已发布 v" +
        (t.publishedVersion || "无") + "；保存后普通成员仍只见已发布版本）", box,
        { buttons: [] });
      var save = button("保存未发布草稿", "primary", function () {
        var body = {
          name: n.value.trim(),
          description: desc.value.trim(),
          memberScope: mode.value === "all"
            ? { mode: "all" }
            : { mode: "members",
                members: members.value.split(/[,，]/).map(function (s) {
                  return s.trim();
                }).filter(Boolean) }
        };
        if (t.kind === "grant" && dur.value) {
          body.defaultDurationMs = Number(dur.value);
        }
        api("PATCH", "/api/permissions/request-templates/" + id,
          { body: body, ifMatch: state.templateRev }).then(function (r) {
            state.templateRev = r.tplRev;
            toast(r.data.unchanged
              ? "草稿内容无变化"
              : "已保存未发布草稿（草稿 v" +
                (r.data.template.draft && r.data.template.draft.draftVersion) +
                "），需发布后成员才能看到");
            m.close(); loadTemplates(); loadRequests();
          }).catch(function (e) { handleTemplateError(e); });
      });
      var cancel = button("取消", null, function () { m.close(); });
      m.foot.appendChild(save); m.foot.appendChild(cancel);
    }

    function publishTemplate(id, scheduledAt, draftVersion) {
      var t = state.templates.find(function (x) { return x.id === id; });
      if (!t || !t.draft) { toast("没有未发布草稿", "error"); return; }
      var body = { draftVersion: draftVersion != null ? draftVersion
        : t.draft.draftVersion };
      if (scheduledAt) body.scheduledAt = scheduledAt;
      api("POST", "/api/permissions/request-templates/" + id + "/publish",
        { body: body, ifMatch: state.templateRev }).then(function (r) {
          state.templateRev = r.tplRev;
          toast(r.data.scheduled
            ? "已计划于 " + formatTime(r.data.plan.scheduledAt) + " 发布"
            : "已发布 v" + r.data.release.version);
          loadTemplates();
        }).catch(handleTemplateError);
      }

    function scheduleTemplatePublish(id) {
      var input = el("input");
      input.type = "datetime-local";
      input.step = "1";
      var box = el("div", "perm-form");
      var wrap = el("label", "perm-field");
      wrap.appendChild(el("span", null, "计划发布时间"));
      wrap.appendChild(input);
      box.appendChild(wrap);
      box.appendChild(el("div", "snap-note",
        "到点后发布当前草稿；在执行前可以取消。"));
      var m = openModal("计划发布模板", box, { buttons: [] });
      var save = button("创建发布计划", "primary", function () {
        if (!input.value) { toast("请选择未来时间", "error"); return; }
        publishTemplate(id, new Date(input.value).toISOString());
        m.close();
      });
      m.foot.appendChild(save);
      m.foot.appendChild(button("取消", null, function () { m.close(); }));
    }

    function cancelScheduledTemplate(id, planId) {
      var t = state.templates.find(function (x) { return x.id === id; });
      if (!t) return;
      // 取消请求必须携带计划锁定的 templateVersion/draftVersion（服务端严格校验），
      // 从负责人视图 publishPlans 里按 planId 取待执行计划，不能用草稿/发布版本现凑。
      var plan = (t.publishPlans || []).find(function (p) {
        return p.planId === planId && p.status === "pending";
      });
      if (!plan) {
        toast("未找到待执行的发布计划，已刷新为最新状态", "error");
        loadTemplates();
        return;
      }
      if (!window.confirm("确认取消该计划发布？草稿会保留为未发布状态。")) return;
      api("POST", "/api/permissions/request-templates/" + id +
          "/publish-plans/" + planId + "/cancel",
        { body: { templateVersion: plan.templateVersion,
          draftVersion: plan.draftVersion },
          ifMatch: state.templateRev }).then(function (r) {
          state.templateRev = r.tplRev;
          toast("计划发布已取消");
          loadTemplates();
        }).catch(handleTemplateError);
    }

    function discardTemplateDraft(id) {
      var t = state.templates.find(function (x) { return x.id === id; });
      if (!t) return;
      if (!window.confirm("确认丢弃未发布草稿？已发布版本不会改变。")) return;
      api("DELETE", "/api/permissions/request-templates/" + id + "/draft",
        { ifMatch: state.templateRev }).then(function (r) {
          state.templateRev = r.tplRev;
          toast(r.data.unchanged ? "没有未发布草稿" : "草稿已丢弃");
          loadTemplates();
        }).catch(handleTemplateError);
    }

    function rollbackTemplate(id) {
      api("GET", "/api/permissions/request-templates/" + id + "/versions")
        .then(function (r) {
          var releases = r.data.releases || [];
          var box = el("div", "perm-logs");
          box.appendChild(el("div", "snap-note",
            "回滚会复制所选发布内容并生成一个新发布版本，不会覆盖历史。" +
            "如有未发布草稿，请先发布或丢弃。"));
          releases.forEach(function (rel) {
            var line = el("div", "perm-logline");
            line.appendChild(el("span", null,
              "v" + rel.version + " · " + formatTime(rel.publishedAt) +
              " · " + (rel.source === "rollback" ? "回滚产生" : "发布") +
              " · " + rel.publishedBy));
            line.appendChild(el("div", "perm-log-msg",
              rel.snapshot.name + " · " +
              (ROLE_LABELS[rel.snapshot.role] || rel.snapshot.role)));
          if (rel.version !== r.data.currentVersion) {
              line.appendChild(button("回滚到此版本", null, function () {
                var reason = window.prompt("回滚原因（可留空）", "");
                if (reason === null) return;
                api("POST", "/api/permissions/request-templates/" + id +
                    "/rollback",
                  { body: { releaseVersion: rel.version, reason: reason },
                    ifMatch: state.templateRev }).then(function (rr) {
                    state.templateRev = rr.tplRev;
                    toast("已回滚并发布为 v" + rr.data.release.version);
                    m.close(); loadTemplates();
                  }).catch(handleTemplateError);
              }));
            } else {
              line.appendChild(el("span", "snap-note", "当前版本"));
            }
            box.appendChild(line);
          });
          var m = openModal("模板发布历史与回滚", box,
            { buttons: [button("关闭", null, function () {})] });
        }).catch(handleTemplateError);
    }

    function disableTemplate(id) {
      var t = state.templates.find(function (x) { return x.id === id; });
      if (!t) return;
      var reason = window.prompt(
        "停用原因（可留空）。停用是终态：停用后不能再用该模板发起新申请，" +
        "已提交申请与版本历史保留。", "");
      if (reason === null) return;
      api("POST", "/api/permissions/request-templates/" + id + "/disable",
        { body: { reason: reason }, ifMatch: state.templateRev })
        .then(function (r) {
          state.templateRev = r.tplRev;
          toast("模板 “" + t.name + "” 已停用");
          loadTemplates();
        }).catch(handleTemplateError);
    }

    // 成员用模板发起申请；提交瞬间服务端按当前角色配置/委派/待处理申请重新校验
    function submitFromTemplate(t) {
      var box = el("div", "perm-form");
      box.appendChild(el("div", "snap-note",
        (SCOPE_LABELS[t.scope] || t.scope) + " " + t.resourceId + " · " +
        (t.kind === "grant" ? "授予" : "撤销") + " · " +
        (ROLE_LABELS[t.role] || t.role) + " · 依据版本 v" + t.currentVersion));
      var delegationId = el("input");
      delegationId.placeholder = "撤销申请：本人正式委派 id（del_…）";
      var effective = el("input");
      effective.type = "datetime-local"; effective.step = "1";
      effective.title = "生效时间（留空=立即生效）";
      var expire = el("input");
      expire.type = "datetime-local"; expire.step = "1";
      if (t.kind === "grant" && t.defaultDurationMs) {
        expire.value = dtLocal(new Date(Date.now() + t.defaultDurationMs));
      }
      expire.title = "失效时间（留空=使用模板默认有效期）";
      var note = el("input");
      note.placeholder = "申请说明（可选，≤500 字）";
      function f(label, node) {
        var wrap = el("label", "perm-field");
        wrap.appendChild(el("span", null, label));
        wrap.appendChild(node);
        return wrap;
      }
      if (t.kind === "revoke") box.appendChild(f("目标委派 id", delegationId));
      if (t.kind === "grant") {
        box.appendChild(f("生效（留空=立即）", effective));
        box.appendChild(f("失效（留空=模板默认）", expire));
      }
      box.appendChild(f("说明", note));
      var m = openModal("用模板发起申请：" + t.name, box, { buttons: [] });
      var submit = button("提交申请", "primary", function () {
        var body = { templateVersion: t.currentVersion,
          note: note.value.trim() };
        if (t.kind === "revoke") {
          body.delegationId = delegationId.value.trim();
        } else {
          if (expire.value) body.expireAt = new Date(expire.value).toISOString();
          if (effective.value) {
            body.effectiveAt = new Date(effective.value).toISOString();
          }
        }
        api("POST", "/api/permissions/request-templates/" + t.id + "/submit",
          { body: body, ifMatch: state.requestRev }).then(function (r) {
            state.requestRev = r.reqRev;
            toast("申请已提交：" + r.data.request.id +
              "（模板 " + t.name + " v" + t.currentVersion + "）");
            m.close(); loadRequests();
          }).catch(function (e) { handleTemplateSubmitError(e); });
      });
      m.foot.appendChild(submit);
      m.foot.appendChild(button("取消", null, function () { m.close(); }));
    }

    function openTemplateVersions(id) {
      api("GET", "/api/permissions/request-templates/" + id + "/versions")
        .then(function (r) {
          var box = el("div", "perm-logs");
          box.appendChild(el("div", "snap-note",
            "当前已发布 v" + r.data.currentVersion +
            "；下方是完整版本历史，发布记录可在上方卡片使用“回滚”操作"));
          (r.data.publishPlans || []).forEach(function (p) {
            if (p.status !== "pending") return;
            box.appendChild(el("div", "perm-logline",
              "计划发布：" + formatTime(p.scheduledAt) +
              " · 草稿 v" + p.draftVersion + " · " + p.status));
          });
          r.data.versions.forEach(function (v) {
            var line = el("div", "perm-logline");
            line.appendChild(el("span", null,
              formatTime(v.at) + " · " +
              ({ create: "创建", update: "保存草稿", disable: "停用",
                 publish: "发布", schedule_publish: "计划发布",
                 cancel_publish: "取消计划", rollback: "回滚",
                 discard_draft: "丢弃草稿",
                 schedule_publish_failed: "计划发布失败" }[v.action] ||
                v.action) + " · v" + v.version + " · " + (v.by || "—")));
            line.appendChild(el("div", "perm-log-msg",
              v.name + " · " + (ROLE_LABELS[v.role] || v.role) + " · " +
              (v.kind === "grant" ? "授予" : "撤销") +
              (v.defaultDurationMs != null
                ? " · 默认有效期 " + Math.round(v.defaultDurationMs / 3600000) + " 小时"
                : "") + " · " +
              (v.memberScope && v.memberScope.mode === "all"
                ? "全体成员"
                : "指定成员 " + ((v.memberScope && v.memberScope.members) || [])
                    .join("、"))));
            if (v.description) {
              line.appendChild(el("div", "perm-log-msg", "说明：" + v.description));
            }
            if (v.action === "update" && v.changes) {
              line.appendChild(el("div", "perm-log-msg",
                "变更字段：" + Object.keys(v.changes).join("、")));
            }
            box.appendChild(line);
          });
          openModal("模板版本历史", box,
            { buttons: [button("关闭", null, function () {})] });
        }).catch(handleTemplateError);
    }

    function openTemplateLogs() {
      var box = el("div", "perm-logs");
      box.appendChild(el("div", "snap-note", "加载中…"));
      var m = openModal("模板审计（变更 / 使用 / 拒绝原因）", box,
        { buttons: [button("关闭", null, function () {})] });
      api("GET", "/api/permissions/request-templates/logs").then(function (r) {
        state.templateRev = r.tplRev || state.templateRev;
        box.innerHTML = "";
        var entries = r.data.logs || [];
        box.appendChild(el("div", "snap-note", "共 " + entries.length +
          " 条（时间倒序；只增不改，重启可查）"));
        if (!entries.length) {
          box.appendChild(el("div", "snap-empty", "暂无记录。"));
          return;
        }
        var ACTIONS = {
          template_create: "创建模板", template_update: "保存草稿",
          template_publish: "发布模板",
          template_publish_scheduled: "计划模板发布",
          template_publish_cancelled: "取消模板计划发布",
          template_scheduled_publish_failed: "计划发布失败",
          template_rollback: "回滚模板",
          template_draft_discarded: "丢弃草稿",
          template_disable: "停用模板", template_submit: "用模板发起申请",
          template_submit_rejected: "模板发起被拒绝"
        };
        entries.slice(0, 500).forEach(function (x) {
          var deny = x.action === "template_submit_rejected";
          var line = el("div", "perm-logline perm-log-" + (deny ? "deny" : "ok"));
          line.appendChild(el("span", null,
            formatTime(x.at) + " · " + (ACTIONS[x.action] || x.action) +
            " · " + (SCOPE_LABELS[x.scope] || x.scope) + " " +
            (x.resourceId || "") + " · 操作人 " + (x.actor || "—") +
            " · " + x.templateId +
            (x.requestId ? " · 申请 " + x.requestId : "")));
          var d = x.detail || {};
          if (deny) {
            line.appendChild(el("div", "perm-log-msg",
              "拒绝原因：" + d.code + " — " + d.message));
          }
          if (x.action === "template_create" || x.action === "template_update") {
            if (d.name) line.appendChild(el("div", "perm-log-msg", "名称：" + d.name));
          }
          box.appendChild(line);
        });
      }).catch(function (e) {
        box.innerHTML = "";
        box.appendChild(el("div", "snap-empty", "加载失败：" + e.message));
      });
      return m;
    }

    function handleTemplateError(e) {
      if (e.code === "version_conflict") {
        toast("模板集合已被其他页面更新（旧 templateRev 冲突），本次未写入，请刷新",
          "error");
        loadTemplates();
      } else if (e.code === "template_disabled") {
        toast("模板已停用，不能再修改或发起新申请", "error");
        loadTemplates();
      } else if (e.code === "template_version_changed" ||
                 e.code === "publish_plan_not_pending" ||
                 e.code === "publish_plan_not_found") {
        // 本地模板/计划状态已过期（如计划到点已执行）：提示后刷新出最新草稿与计划状态
        toast(e.message, "error");
        loadTemplates();
      } else {
        toast(e.message, "error");
      }
    }

    function handleTemplateSubmitError(e) {
      if (e.code === "version_conflict") {
        toast("申请集合已被其他页面更新，本次未提交，请刷新后重试", "error");
        loadRequests();
      } else if (e.code === "template_version_changed") {
        toast("模板已被负责人修改到 v" +
          (e.data && e.data.currentVersion) +
          "，旧版本不能创建申请，请关闭窗口后用新版本发起", "error");
        loadTemplates();
      } else if (e.code === "template_disabled") {
        toast("模板已停用，不能继续创建申请", "error");
        loadTemplates();
      } else if (e.code === "member_not_in_template_scope") {
        toast("你不在该模板的适用成员范围内，不能使用此模板", "error");
      } else if (e.code === "duplicate_request") {
        toast("你已有一条待处理的同角色申请（" +
          (e.data && e.data.existingRequestId) + "），不能重复提交", "error");
      } else if (e.code === "duplicate_delegation") {
        toast("你已持有时间窗重叠的正式委派，无需重复申请", "error");
      } else if (e.code === "conflicting_roles" ||
                 e.code === "conflicting_request_roles") {
        toast("时间窗内存在 approve/execute 职责冲突，已拒绝创建", "error");
      } else {
        handleRequestError(e);
      }
    }

    // 组详情：列出组内申请，支持勾选加入/移除与整批批量决定
    function openGroupDetail(id) {
      api("GET", "/api/permissions/request-groups/" + id).then(function (r) {
        state.groupRev = r.grpRev || state.groupRev;
        state.requestRev = r.reqRev || state.requestRev;
        renderGroupDetail(id, r.data);
      }).catch(handleGroupError);
    }

    function renderGroupDetail(id, data) {
      var g = data.group;
      var box = el("div", "perm-group-detail");
      var info = el("div", "snap-note",
        (SCOPE_LABELS[g.scope] || g.scope) + " " + g.resourceId +
        " · 处理截止 " + (g.deadline ? formatTime(g.deadline) : "未设置") +
        " · 待处理 " + g.pendingCount + " 条 · 集合 requestRev " +
        state.requestRev + "（批量时双重校验集合版本与每条版本）");
      box.appendChild(info);

      // 加入申请：粘贴/勾选当前筛选中的 pending 申请 id
      var addBar = el("div", "perm-filter-bar");
      var addIds = el("input");
      addIds.placeholder = "要加入本组的申请 id（逗号分隔，按资源/类型/成员/状态选取）";
      addIds.style.flex = "1";
      var reassignChk = el("input"); reassignChk.type = "checkbox";
      var rl = el("label", null, " 允许移动已在别组的申请 ");
      rl.appendChild(reassignChk);
      addBar.appendChild(addIds); addBar.appendChild(rl);
      addBar.appendChild(button("加入分组", null, function () {
        var ids = addIds.value.split(/[,，\s]+/).filter(Boolean);
        if (!ids.length) { toast("请填写至少一个申请 id", "error"); return; }
        api("POST", "/api/permissions/request-groups/" + id + "/requests",
          { body: { requestIds: ids, reassign: reassignChk.checked },
            ifMatch: state.groupRev }).then(function (r) {
            state.groupRev = r.grpRev;
            state.requestRev = r.reqRev || state.requestRev;
            toast("已加入 " + r.data.added.length + " 条申请");
            m.close(); openGroupDetail(id); loadRequests(); loadGroups();
          }).catch(handleGroupError);
      }));
      box.appendChild(addBar);

      var checks = {};
      var listBox = el("div", "perm-list");
      data.requests.forEach(function (q) {
        var card = el("div", "perm-card perm-rq-" + q.displayState);
        var line = el("div");
        var cb = el("input"); cb.type = "checkbox"; cb.checked = q.displayState === "pending";
        checks[q.id] = { cb: cb, q: q };
        line.appendChild(cb);
        line.appendChild(el("span", null,
          " " + (q.kind === "grant" ? "授予" : "撤销") + "申请 " + q.id +
          "（v" + q.version + "）· " + (ROLE_LABELS[q.role] || q.role) +
          " · " + q.member + " · " + requestStatusLabel(q.displayState)));
        card.appendChild(line);
        card.appendChild(el("div", "snap-note",
          "审批截止 " + formatTime(q.expiresAt) +
          (q.decisionReason ? "；处理原因：" + q.decisionReason : "")));
        // 逐项批准/拒绝（同组内逐条处理）
        if (q.displayState === "pending") {
          var one = el("div", "perm-rq-actions");
          one.appendChild(button("逐项批准", "primary", function () {
            var reason = window.prompt("批准原因（可留空）", "");
            if (reason === null) return;
            decideInGroup(id, q, "approve", reason);
          }));
          one.appendChild(button("逐项拒绝", "danger", function () {
            var reason = window.prompt("拒绝原因（必填，申请人可见）", "");
            if (reason === null) return;
            if (!reason.trim()) { toast("拒绝必须填写原因", "error"); return; }
            decideInGroup(id, q, "reject", reason);
          }));
          card.appendChild(one);
        }
        listBox.appendChild(card);
      });
      box.appendChild(listBox);

      var m = openModal("分组批量处理：" + g.name, box, { buttons: [] });

      function collect(decision) {
        return Object.keys(checks).map(function (rid) {
          var it = checks[rid];
          return it;
        }).filter(function (it) {
          return it.cb.checked && it.q.displayState === "pending";
        }).map(function (it) {
          return { id: it.q.id, version: it.q.version, decision: decision,
            reason: decision === "reject" ? (rejectReason.value.trim()) : "" };
        });
      }
      var rejectReason = el("input");
      rejectReason.placeholder = "批量拒绝统一原因（勾选拒绝时必填，申请人可见）";

      var footBar = el("div", "perm-filter-bar");
      footBar.style.width = "100%";
      footBar.appendChild(rejectReason);
      m.foot.appendChild(footBar);
      m.foot.appendChild(button("批量批准勾选项", "primary", function () {
        var items = collect("approve");
        if (!items.length) { toast("请勾选至少一条待处理申请", "error"); return; }
        submitBatch(id, items, m);
      }));
      m.foot.appendChild(button("批量拒绝勾选项", "danger", function () {
        var items = collect("reject");
        if (!items.length) { toast("请勾选至少一条待处理申请", "error"); return; }
        if (!rejectReason.value.trim()) {
          toast("批量拒绝必须填写统一原因", "error"); return;
        }
        submitBatch(id, items, m);
      }));
      m.foot.appendChild(button("移出分组", null, function () {
        var ids = Object.keys(checks).filter(function (rid) {
          return checks[rid].cb.checked;
        });
        if (!ids.length) { toast("请勾选要移出的申请", "error"); return; }
        api("POST", "/api/permissions/request-groups/" + id + "/requests/remove",
          { body: { requestIds: ids }, ifMatch: state.groupRev }).then(function (r) {
            state.groupRev = r.grpRev;
            state.requestRev = r.reqRev || state.requestRev;
            toast("已移出 " + r.data.removed.length + " 条");
            m.close(); openGroupDetail(id); loadRequests(); loadGroups();
          }).catch(handleGroupError);
      }));
      m.foot.appendChild(button("关闭", null, function () { m.close(); }));
    }

    function decideInGroup(groupId, q, decision, reason) {
      api("POST", "/api/permissions/requests/" + q.id + "/decision",
        { body: { decision: decision, reason: reason },
          ifMatch: state.requestRev, requestVersion: q.version })
        .then(function (r) {
          state.requestRev = r.reqRev;
          state.rev = r.permRev || state.rev;
          toast(decision === "approve"
            ? "已逐项批准 " + q.id + "，正式委派即时生效"
            : "已逐项拒绝 " + q.id + "（不改变权限）");
          closeTopModal();
          loadRequests(); loadList(); loadGroups(); openGroupDetail(groupId);
        }).catch(handleRequestError);
    }

    function submitBatch(groupId, items, modal) {
      api("POST",
        "/api/permissions/request-groups/" + groupId + "/batch-decide",
        { body: { items: items }, ifMatch: state.requestRev })
        .then(function (r) {
          state.requestRev = r.reqRev;
          state.rev = r.permRev || state.rev;
          toast("批量处理完成：" + r.data.count + " 条（整批一次事务）");
          modal.close();
          loadRequests(); loadList(); loadGroups(); openGroupDetail(groupId);
        }).catch(function (e) {
          handleBatchError(e, groupId);
        });
    }

    refresh();
  }

  /* ================= 申请清单与审批 ================= */

  function requestStatusLabel(s) {
    return { pending: "待处理", approved: "已批准", rejected: "已拒绝",
      expired: "已过期", failed: "已失败" }[s] || s;
  }

  function groupDeadlineLabel(s) {
    return { none: "未设截止", pending: "未到截止", overdue: "已过截止" }[s] || s;
  }

  function openGroupLogs(title, url) {
    var box = el("div", "perm-logs");
    box.appendChild(el("div", "snap-note", "加载中…"));
    var m = openModal(title, box, { buttons: [button("关闭", null, function () {})] });
    api("GET", url).then(function (r) {
      box.innerHTML = "";
      state.groupRev = r.grpRev || state.groupRev;
      var entries = r.data.logs || [];
      box.appendChild(el("div", "snap-note", "共 " + entries.length +
        " 条（时间倒序；分组变更/批量审批/截止提醒独立审计）"));
      if (!entries.length) {
        box.appendChild(el("div", "snap-empty", "暂无记录。"));
        return;
      }
      var ACTIONS = {
        group_create: "创建分组", group_update: "修改分组",
        group_delete: "删除分组", group_requests_add: "加入申请",
        group_requests_remove: "移出申请",
        batch_decide: "批量审批成功", batch_decide_failed: "批量审批整批拒绝",
        deadline_reminder: "截止提醒"
      };
      entries.slice(0, 500).forEach(function (x) {
        var deny = x.action === "batch_decide_failed" ||
          (x.action === "deadline_reminder" &&
           x.detail && x.detail.kind === "overdue");
        var line = el("div", "perm-logline perm-log-" + (deny ? "deny" : "ok"));
        line.appendChild(el("span", null,
          formatTime(x.at) + " · " + (ACTIONS[x.action] || x.action) +
          " · " + (SCOPE_LABELS[x.scope] || x.scope) + " " + (x.resourceId || "") +
          " · 操作人 " + (x.actor || "—") + " · " + x.groupId));
        var d = x.detail || {};
        if (d.name) line.appendChild(el("div", "perm-log-msg", "分组：" + d.name));
        if (x.action === "deadline_reminder") {
          line.appendChild(el("div", "perm-log-msg",
            (d.kind === "overdue" ? "已过处理截止 " : "临近处理截止 ") +
            formatTime(d.deadline) + "；组内待处理 " + d.pendingCount + " 条"));
        }
        if (x.action === "batch_decide") {
          line.appendChild(el("div", "perm-log-msg",
            "共 " + d.count + " 条（批准 " + d.approved + " / 拒绝 " +
            d.rejected + "），整批一次事务"));
        }
        if (x.action === "batch_decide_failed") {
          (d.results || []).forEach(function (row) {
            if (row.ok) return;
            line.appendChild(el("div", "perm-log-msg",
              "· " + row.id + "：" + row.code + " — " + row.message));
          });
        }
        if (x.action === "group_requests_add") {
          line.appendChild(el("div", "perm-log-msg",
            "加入 " + (d.added || []).length + " 条" +
            (d.reassign ? "（允许跨组移动）" : "")));
        }
        if (x.action === "group_delete") {
          line.appendChild(el("div", "perm-log-msg",
            "解除归属 " + d.detachedRequests + " 条申请（申请与权限不变）"));
        }
        box.appendChild(line);
      });
    }).catch(function (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "snap-empty", "加载失败：" + e.message));
    });
    return m;
  }

  function handleGroupError(e) {
    if (e.code === "version_conflict") {
      toast("分组集合已被其他页面更新（旧 groupRev 冲突），请刷新后重试，本次未写入",
        "error");
      loadGroups();
    } else if (e.code === "group_members_conflict") {
      var rows = (e.data && e.data.results) || [];
      var msg = rows.map(function (x) {
        return x.id + "：" + x.code;
      }).join("；");
      toast("加入分组整批失败（未改变归属）：" + msg, "error");
    } else if (e.code === "deadline_in_past" || e.code === "invalid_deadline") {
      toast("处理截止时间非法：创建时必须是未来时刻", "error");
    } else if (e.code === "missing_group_name") {
      toast("分组名称不能为空", "error");
    } else if (e.code === "not_resource_owner") {
      toast("只有资源负责人才能管理该申请分组", "error");
    } else {
      toast(e.message, "error");
    }
  }

  function handleBatchError(e, groupId) {
    if (e.code === "precondition_required") {
      toast("批量审批必须携带申请集合版本（请刷新后重试）", "error");
    } else if (e.code === "version_conflict") {
      toast("申请集合已被其他页面更新，整批未改变任何权限，请刷新分组后重试",
        "error");
      state.requestRev = e.data && String(e.data.currentRev);
      loadRequests(); loadGroups();
      if (groupId) openGroupDetail(groupId);
    } else if (e.code === "batch_conflict" || e.code === "batch_invalid") {
      var rows = (e.data && e.data.results) || [];
      var failed = rows.filter(function (x) { return !x.ok; });
      var detail = failed.slice(0, 5).map(function (x) {
        return x.id + "：" + batchRowReason(x.code);
      }).join("\n");
      toast("整批未改变任何权限（" + failed.length + " 条失败）：\n" + detail +
        (failed.length > 5 ? "\n…" : ""), "error");
      // 刷新版本与状态，再重开弹窗展示最新 version
      loadRequests(); loadGroups();
      if (groupId) openGroupDetail(groupId);
    } else {
      handleRequestError(e);
    }
  }

  function batchRowReason(code) {
    return {
      request_version_conflict: "申请版本过期（已被其他处理推进）",
      request_not_pending: "申请已被处理（历史只读）",
      request_expired: "已过审批截止",
      self_approval: "负责人不能审批自己的申请",
      not_resource_owner: "非资源负责人",
      reject_reason_required: "拒绝必须填写原因",
      not_in_group: "申请不属于该分组",
      duplicate_delegation: "与正式委派重复",
      conflicting_roles: "职责角色冲突",
      duplicate_in_batch: "批内重复提交",
      request_not_found: "申请不存在"
    }[code] || code;
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
