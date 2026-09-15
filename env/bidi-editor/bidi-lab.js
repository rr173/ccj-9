/* bidi-lab.js
 * 双向文本安全诊断与修复实验室 UI。
 *
 * 与正文安全相关的核心约定：
 *   - 诊断全过程只读：BidiLabCore.diagnose 不在编辑器 DOM 上做任何修改；
 *   - 所有位置都是逻辑码点偏移（半开 [start,end)，按字素簇聚合），
 *     阿拉伯文 RTL 显示时位置仍以原始逻辑文本为准，UI 不做视觉反算；
 *   - 双视图（逻辑序列 / 实际渲染序列）通过字素簇下标互相定位，
 *     点击任一视图或问题项，另一视图与原编辑器都定位到同一个字素簇；
 *   - 段落方向、容器宽度、缩放、字体任一改变 → 重新测量映射，
 *     并把旧诊断标记为“已过期”，禁止拿旧位置执行修复；
 *   - 批量应用时由 BidiLabCore 做内容指纹 + 渲染条件指纹双重校验，
 *     任一变化整次拒绝、不改任何文字；
 *   - 应用成功生成一次性撤销记录（文本/方向/选区/滚动精确还原），
 *     重复撤销明确拒绝；样例回归只读，绝不改正文。
 */
(function () {
  "use strict";

  var core = window.BidiLabCore;
  var geom = window.BidiLabGeometry;
  var Editor = window.Editor;

  /* ---------- 状态 ---------- */

  var state = {
    source: null,           // "editor" | "manual"
    paragraphs: [],         // 诊断用段落 [{dir,text}]（正文快照副本）
    editorSnapshot: null,   // source=editor 时的编辑器状态（回到定位用）
    conditions: { width: 800, fontSize: 20, zoom: 1, font: "" },
    report: null,           // 诊断报告
    plan: null,             // 修复计划
    planMeta: null,         // {contentFp, renderFp}
    geometry: [],           // 每段几何测量结果
    selected: {},           // suggestionId -> true
    stale: false,           // 旧诊断是否已过期
    staleReason: "",
    lastRepair: null,       // {undo:{...state}, recordId}
    appliedRepairIds: {},   // 已撤销的修复记录 id
    // 样例与记录（服务端持久化）
    rev: null,
    samples: [],
    records: [],
    activeTab: "diagnose",  // diagnose | samples | records
    activePara: 0,
    activeCluster: null,    // {para, gi} 当前高亮簇
    note: ""
  };

  /* ---------- 小工具 ---------- */

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
  function esc(s) { return String(s == null ? "" : s); }

  function toast(message, kind) {
    var box = $("toast-box");
    if (!box) return;
    var t = el("div", "toast toast-" + (kind || "info"));
    t.textContent = message;
    box.appendChild(t);
    setTimeout(function () {
      t.classList.add("toast-out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, kind === "error" ? 6000 : 3500);
  }

  function dirLabel(dir) {
    return { auto: "自动", ltr: "LTR 强制左→右", rtl: "RTL 强制右→左" }[dir] || dir;
  }
  function typeLabel(t) { return core.TYPE_LABELS_ZH[t] || t; }
  function fixLabel(k) { return core.FIX_LABELS_ZH[k] || k; }

  // 取段落字素簇：诊断后用缓存（与诊断一致的切分），未诊断时即时计算
  function clustersFor(pi) {
    if (state.clusterCache && state.clusterCache[pi]) return state.clusterCache[pi];
    return core.segmentGraphemes(state.paragraphs[pi].text);
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
      var rev = res.headers.get("X-Bidi-Lab-Rev");
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var e2 = new Error((data && data.message) || ("请求失败：HTTP " + res.status));
          e2.status = res.status; e2.code = data && data.error; e2.data = data;
          throw e2;
        }
        return { data: data, rev: rev != null ? parseInt(rev, 10) : null };
      });
    });
  }

  /* ---------- 模态框 ---------- */

  var closeModal = null;
  function openLab() {
    if (closeModal) return;
    var overlay = el("div", "modal-overlay blab-overlay");
    var modal = el("div", "modal blab-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    var head = el("div", "modal-head blab-head");
    head.appendChild(el("h3", null, "双向文本安全诊断与修复实验室"));
    var closeBtn = el("button", "modal-close", "×");
    closeBtn.title = "关闭实验室（不会修改编辑器正文）";
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = el("div", "modal-body blab-body");
    body.appendChild(buildTabs());
    body.appendChild(buildDiagnoseView());
    body.appendChild(buildSamplesView());
    body.appendChild(buildRecordsView());
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      closeModal = null;
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }
    function onResize() {
      // 浏览器窗口变化只影响实验室舞台，不影响“诊断时锁定的宽度”；
      // 不自动改条件，但提示重新测量
      if (state.report) markStale("窗口尺寸已变化，请重新计算映射后再修复");
    }
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    closeModal = close;

    switchTab("diagnose");
    refreshSamples();
    refreshRecords();
  }

  /* ---------- 标签页 ---------- */

  function buildTabs() {
    var bar = el("div", "blab-tabs");
    [["diagnose", "诊断与修复"], ["samples", "诊断样例与回归"], ["records", "历史记录"]]
      .forEach(function (t) {
        var b = el("button", "blab-tab", t[1]);
        b.dataset.tab = t[0];
        b.addEventListener("click", function () { switchTab(t[0]); });
        bar.appendChild(b);
      });
    return bar;
  }

  function switchTab(name) {
    state.activeTab = name;
    document.querySelectorAll(".blab-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    ["diagnose", "samples", "records"].forEach(function (n) {
      var v = $("blab-view-" + n);
      if (v) v.style.display = (n === name) ? "" : "none";
    });
    if (name === "samples") refreshSamples();
    if (name === "records") refreshRecords();
  }

  /* ================= 诊断视图 ================= */

  function buildDiagnoseView() {
    var v = el("div", "blab-view");
    v.id = "blab-view-diagnose";

    // —— 载入区 ——
    var load = el("div", "blab-section blab-load");
    var bEditor = el("button", "primary", "① 载入当前编辑内容");
    bEditor.title = "把编辑器当前全部段落复制进实验室（不改动原文）";
    bEditor.addEventListener("click", loadFromEditor);
    var bManual = el("button", null, "载入手动样例");
    bManual.addEventListener("click", loadManual);
    var manualBox = el("textarea", "blab-manual");
    manualBox.placeholder = "粘贴独立样例：每行一段；行首加 [rtl] / [ltr] / [auto] 指定方向，缺省为 auto";
    manualBox.rows = 3;
    var srcInfo = el("div", "blab-srcinfo");
    load.appendChild(bEditor);
    load.appendChild(bManual);
    load.appendChild(manualBox);
    load.appendChild(srcInfo);
    v.appendChild(load);

    // —— 渲染条件 ——
    var cond = el("div", "blab-section blab-cond");
    cond.appendChild(el("b", null, "② 渲染条件（任一改变都会使旧诊断过期）"));
    var grid = el("div", "blab-cond-grid");

    var widthInput = numInput("width", "容器宽度 px", 200, 4000, 800);
    var zoomInput = numInput("zoom", "缩放比例", 0.5, 3, 1, 0.1);
    var fontSizeInput = numInput("fontSize", "字号 px", 10, 60, 20);

    var fontWrap = el("label", null, "字体 ");
    var fontInput = el("input", "blab-font");
    fontInput.type = "text";
    fontInput.placeholder = "留空=编辑器字体，如 Noto Naskh Arabic";
    fontInput.addEventListener("change", function () {
      if (state.report) markStale("字体已改变为 “" + fontInput.value.trim() + "”");
    });
    fontWrap.appendChild(fontInput);

    [widthInput.wrap, zoomInput.wrap, fontSizeInput.wrap, fontWrap].forEach(function (w) {
      grid.appendChild(w);
    });
    cond.appendChild(grid);

    var fontWarn = el("div", "blab-fontwarn snap-note is-error");
    fontWarn.style.display = "none";
    cond.appendChild(fontWarn);

    var bDiag = el("button", "primary", "③ 诊断并计算双视图映射");
    bDiag.addEventListener("click", function () {
      runDiagnosis({ width: widthInput.get(), zoom: zoomInput.get(),
        fontSize: fontSizeInput.get(), font: fontInput.value.trim() });
    });
    cond.appendChild(bDiag);
    v.appendChild(cond);

    // —— 过期横幅 ——
    var stale = el("div", "blab-stale");
    stale.style.display = "none";
    v.appendChild(stale);

    // —— 警告条（超长/字体等）——
    var warnBox = el("div", "blab-warnings");
    v.appendChild(warnBox);

    // —— 段落选择 + 双视图 ——
    var views = el("div", "blab-section blab-views");
    var paraBar = el("div", "blab-parabar");
    views.appendChild(paraBar);
    var cols = el("div", "blab-cols");
    var logical = buildViewColumn("逻辑序列（内存中码点顺序）", "logical");
    var visual = buildViewColumn("实际渲染序列（浏览器测量）", "visual");
    cols.appendChild(logical.wrap);
    cols.appendChild(visual.wrap);
    views.appendChild(cols);
    v.appendChild(views);

    // —— 问题列表 ——
    var issues = el("div", "blab-section");
    issues.appendChild(el("b", null, "问题清单（位置均为逻辑码点；点击任一条在双视图与原文定位）"));
    var issueList = el("div", "blab-issues");
    issues.appendChild(issueList);
    v.appendChild(issues);

    // —— 修复建议 ——
    var fixes = el("div", "blab-section");
    var fixHead = el("div", "blab-fixhead");
    fixHead.appendChild(el("b", null, "修复建议（可组合后一次应用）"));
    var selectAll = el("button", null, "全选/全不选");
    selectAll.addEventListener("click", toggleAllFixes);
    fixHead.appendChild(selectAll);
    fixes.appendChild(fixHead);
    var fixList = el("div", "blab-fixes");
    fixes.appendChild(fixList);

    var applyBar = el("div", "blab-applybar");
    var bApply = el("button", "primary danger-main", "④ 批量应用所选建议");
    bApply.title = "正文、段落方向或渲染条件变化时将整次拒绝、不改任何文字";
    bApply.addEventListener("click", applySelected);
    var bUndo = el("button", null, "撤销上次应用（一次性）");
    bUndo.addEventListener("click", undoLast);
    var undoMsg = el("span", "blab-undo-msg");
    applyBar.appendChild(bApply);
    applyBar.appendChild(bUndo);
    applyBar.appendChild(undoMsg);
    fixes.appendChild(applyBar);
    v.appendChild(fixes);

    // 保存节点引用，供重渲染
    state.ui = {
      srcInfo: srcInfo, fontWarn: fontWarn, stale: stale, warnBox: warnBox,
      paraBar: paraBar, logical: logical, visual: visual,
      issueList: issueList, fixList: fixList, undoMsg: undoMsg,
      inputs: { width: widthInput, zoom: zoomInput, fontSize: fontSizeInput,
                font: fontInput }
    };
    return v;
  }

  function numInput(key, label, min, max, def, step) {
    var wrap = el("label", null, label + " ");
    var input = el("input");
    input.type = "number";
    input.min = min; input.max = max; input.step = step || 1;
    input.value = def;
    wrap.appendChild(input);
    // 条件改变 → 标记旧诊断过期（不自动重算，避免覆盖选择）
    input.addEventListener("change", function () {
      if (state.report) markStale("渲染条件已改变：" + label + " → " + input.value);
    });
    return {
      wrap: wrap, input: input,
      get: function () {
        var n = parseFloat(input.value);
        if (!isFinite(n)) n = def;
        return Math.max(min, Math.min(max, n));
      }
    };
  }

  function buildViewColumn(title, kind) {
    var wrap = el("div", "blab-col blab-col-" + kind);
    var h = el("div", "blab-col-head");
    h.textContent = title + (kind === "visual" ? "（行自上而下、行内按 x）" : "");
    wrap.appendChild(h);
    var body = el("div", "blab-col-body");
    wrap.appendChild(body);
    var info = el("div", "blab-col-info");
    wrap.appendChild(info);
    return { wrap: wrap, body: body, info: info, kind: kind };
  }

  /* ---------- 载入 ---------- */

  function parseManual(raw) {
    var lines = raw.replace(/\r\n?/g, "\n").split("\n");
    var paras = [];
    lines.forEach(function (line) {
      var m = /^\s*\[(auto|ltr|rtl)\]\s?/i.exec(line);
      var dir = "auto", text = line;
      if (m) { dir = m[1].toLowerCase(); text = line.slice(m[0].length); }
      paras.push({ dir: dir, text: text });
    });
    while (paras.length && paras[paras.length - 1].text === "" &&
           paras[paras.length - 1].dir === "auto") paras.pop();
    if (!paras.length) paras.push({ dir: "auto", text: "" });
    return paras;
  }

  function loadFromEditor() {
    var ps = Editor.getParagraphs().map(function (p) {
      return { dir: p.dir, text: p.text };
    });
    if (!ps.length) { toast("编辑器中没有可载入的段落", "error"); return; }
    var oversize = ps.some(function (p) { return core.cpLen(p.text) > core.LIMITS.PARA_MAX_CHARS; });
    if (oversize) {
      toast("有段落超过 " + core.LIMITS.PARA_MAX_CHARS + " 码点上限，无法载入实验室，请先拆分。", "error");
      return;
    }
    state.source = "editor";
    state.paragraphs = ps;
    state.editorSnapshot = Editor.captureState();
    state.report = null; state.plan = null; state.planMeta = null;
    state.geometry = []; state.selected = {}; state.lastRepair = null;
    state.ui.srcInfo.textContent = "已载入编辑器 " + ps.length + " 段（" +
      ps.reduce(function (n, p) { return n + core.cpLen(p.text); }, 0) +
      " 码点）；诊断不会改动原文。";
    state.ui.srcInfo.className = "blab-srcinfo ok";
    state.activePara = 0;
    renderAfterLoad();
    toast("已载入当前编辑内容，可以开始诊断");
  }

  function loadManual() {
    var box = document.querySelector(".blab-manual");
    var raw = box.value || "";
    if (!raw.trim()) { toast("请先在文本框中输入样例（每行一段）", "error"); return; }
    var paras = parseManual(raw);
    var oversize = paras.some(function (p) { return core.cpLen(p.text) > core.LIMITS.PARA_MAX_CHARS; });
    if (oversize) {
      toast("有段落超过 " + core.LIMITS.PARA_MAX_CHARS + " 码点上限，无法载入。", "error");
      return;
    }
    state.source = "manual";
    state.paragraphs = paras;
    state.editorSnapshot = null;
    state.report = null; state.plan = null; state.planMeta = null;
    state.geometry = []; state.selected = {}; state.lastRepair = null;
    state.ui.srcInfo.textContent = "已载入手动样例 " + paras.length + " 段（独立内容，不接触正文）。";
    state.ui.srcInfo.className = "blab-srcinfo ok";
    state.activePara = 0;
    renderAfterLoad();
    toast("已载入手动样例，可以开始诊断");
  }

  function renderAfterLoad() {
    state.ui.stale.style.display = "none";
    state.ui.warnBox.innerHTML = "";
    state.ui.issueList.innerHTML = "";
    state.ui.fixList.innerHTML = "";
    state.ui.undoMsg.textContent = "";
    renderParaBar();
    renderColumns();
  }

  /* ---------- 过期 ---------- */

  function markStale(reason) {
    if (!state.report) return;
    state.stale = true;
    state.staleReason = reason || "诊断条件已变化";
    var s = state.ui.stale;
    s.style.display = "";
    s.innerHTML = "";
    s.appendChild(el("b", null, "⚠ 旧诊断已过期：" + state.staleReason));
    s.appendChild(document.createTextNode("　双视图映射必须重新计算；禁止继续拿旧位置执行修复。"));
    var b = el("button", null, "重新诊断并重算映射");
    b.addEventListener("click", function () {
      runDiagnosis(state.conditions);
    });
    s.appendChild(b);
    // 禁用应用按钮
    var applyBtn = document.querySelector(".blab-applybar .danger-main");
    if (applyBtn) applyBtn.disabled = true;
    // 编辑器正文变化（订阅）→ 同样过期
  }

  function clearStale() {
    state.stale = false; state.staleReason = "";
    var s = state.ui.stale;
    s.style.display = "none"; s.innerHTML = "";
    var applyBtn = document.querySelector(".blab-applybar .danger-main");
    if (applyBtn) applyBtn.disabled = false;
  }

  /* ---------- 诊断 ---------- */

  function currentRenderFp() {
    var dirs = state.paragraphs.map(function (p) { return p.dir; });
    return core.renderFingerprint({
      dirs: dirs,
      width: state.conditions.width,
      zoom: state.conditions.zoom,
      font: state.conditions.font
    });
  }

  function runDiagnosis(conditions) {
    if (!state.paragraphs || !state.paragraphs.length) {
      toast("请先载入编辑内容或手动样例", "error"); return;
    }
    state.conditions = conditions;

    // 字体可用性检测：缺失时明确提示，但仍允许诊断（浏览器会回退字体）
    state.ui.fontWarn.style.display = "none";
    if (conditions.font && geom && geom.fontAvailable) {
      if (!geom.fontAvailable(conditions.font)) {
        state.ui.fontWarn.textContent =
          "⚠ 字体 “" + conditions.font + "” 在本环境不可用，浏览器会静默回退，" +
          "实际渲染宽度可能与预期不同；建议改用可用字体后重新计算映射。";
        state.ui.fontWarn.style.display = "";
      }
    }

    // 1) 纯逻辑诊断（只读，不改原文）
    var report = core.diagnose(state.paragraphs);
    state.report = report;

    // 2) 逐段几何测量（实际渲染序列）
    state.geometry = state.paragraphs.map(function (p) {
      try {
        return geom.measureParagraph(p.text, p.dir, {
          width: conditions.width,
          fontSize: conditions.fontSize,
          fontFamily: conditions.font,
          zoom: conditions.zoom
        });
      } catch (e) {
        return null;
      }
    });

    // 3) 修复计划与条件元数据
    state.plan = core.buildPlan({ paragraphs: state.paragraphs }, report);
    // 字素簇缓存：双视图与问题高亮共用，长段落不重复切分
    state.clusterCache = state.paragraphs.map(function (p) {
      return core.segmentGraphemes(p.text);
    });
    state.planMeta = {
      contentFp: report.contentFp,
      renderFp: currentRenderFp()
    };
    state.selected = {};

    clearStale();
    renderWarnings(report);
    renderParaBar();
    renderColumns();
    renderIssues(report);
    renderFixes();
    state.ui.undoMsg.textContent = "";
    toast("诊断完成：" + report.issues.length + " 个问题、" +
      state.plan.suggestions.length + " 条修复建议");
  }

  function renderWarnings(report) {
    var box = state.ui.warnBox;
    box.innerHTML = "";
    (report.warnings || []).forEach(function (w) {
      var d = el("div", "blab-warning");
      d.textContent = "⚠ " + w.message;
      box.appendChild(d);
    });
  }

  /* ---------- 段落切换 ---------- */

  function renderParaBar() {
    var bar = state.ui.paraBar;
    bar.innerHTML = "";
    state.paragraphs.forEach(function (p, idx) {
      var b = el("button", "blab-para");
      b.textContent = "第 " + (idx + 1) + " 段 · " + dirLabel(p.dir) +
        " · " + core.cpLen(p.text) + " 码点";
      if (idx === state.activePara) b.classList.add("active");
      b.addEventListener("click", function () {
        state.activePara = idx;
        renderParaBar();
        renderColumns();
      });
      bar.appendChild(b);
    });

    // 当前段落的方向切换：在实验室内直接改段落方向（立即标记旧诊断过期）
    if (state.paragraphs.length) {
      var wrap = el("span", "blab-dirswitch");
      wrap.textContent = "当前段方向：";
      ["auto", "ltr", "rtl"].forEach(function (d) {
        var db = el("button", "blab-mini blab-dirb");
        db.textContent = d;
        if (state.paragraphs[state.activePara].dir === d) db.classList.add("active");
        db.addEventListener("click", function () {
          var pi = state.activePara;
          if (state.paragraphs[pi].dir === d) return;
          state.paragraphs[pi].dir = d;
          if (state.report) markStale("段落方向已改为 " + d + "（实验室切换）");
          renderParaBar();
          renderColumns();
        });
        wrap.appendChild(db);
      });
      bar.appendChild(wrap);
    }
  }

  /* ---------- 双视图 ---------- */

  function clusterCells(paraIdx, mode) {
    var p = state.paragraphs[paraIdx];
    var g = state.geometry[paraIdx];
    var seq; // 字素簇下标序列
    if (mode === "logical") {
      var gs = core.segmentGraphemes(p.text);
      seq = gs.map(function (_, i) { return i; });
    } else {
      seq = g ? g.visualOrder : [];
    }
    return seq;
  }

  function renderColumns() {
    var pi = state.activePara;
    var p = state.paragraphs[pi];
    if (!p) return;
    var clusters = clustersFor(pi);
    var g = state.geometry[pi];

    renderOneColumn(state.ui.logical, "logical", pi, p, clusters, null);
    renderOneColumn(state.ui.visual, "visual", pi, p, clusters, g);
  }

  function renderOneColumn(col, mode, pi, para, clusters, geo) {
    col.body.innerHTML = "";
    col.body.setAttribute("dir", para.dir === "auto" ? "auto" : para.dir);

    var seq;
    if (mode === "logical") {
      seq = clusters.map(function (_, i) { return i; });
    } else {
      seq = geo ? geo.visualOrder : [];
    }

    if (mode === "visual" && !state.report) {
      col.info.textContent = "诊断后在此显示浏览器实际测量的渲染序列（含折行）。";
    } else if (mode === "visual" && !geo) {
      col.info.textContent = "本段几何测量失败，请检查字体/宽度后重新计算。";
    } else {
      var curLine = 0, lineEl = null;
      var rows = [];
      if (mode === "visual" && geo) {
        geo.clusters.forEach(function (c) { rows[c.gi] = c; });
      }
      seq.forEach(function (gi, visualIdx) {
        var cluster = clusters[gi];
        var lineNo = mode === "visual" && rows[gi] ? rows[gi].line : 0;
        if (mode === "visual") {
          if (!lineEl || lineNo !== curLine) {
            lineEl = el("div", "blab-vline");
            lineEl.dataset.line = lineNo;
            var tag = el("span", "blab-linetag", "行" + (lineNo + 1));
            lineEl.appendChild(tag);
            col.body.appendChild(lineEl);
            curLine = lineNo;
          }
        } else {
          if (!lineEl) { lineEl = el("div", "blab-vline blab-lline"); col.body.appendChild(lineEl); }
        }
        var cell = buildClusterCell(pi, gi, cluster, mode, visualIdx);
        lineEl.appendChild(cell);
      });
      col.info.textContent = mode === "logical"
        ? "共 " + clusters.length + " 个字素簇；位置以内存中的逻辑码点顺序为准（RTL 也不反转编号）。"
        : "共 " + (geo ? geo.clusters.length : 0) + " 簇、" +
          (geo ? geo.lineCount : 0) + " 个视觉行；按浏览器实际字形位置测量。";
    }
  }

  function issueHitsCluster(pi, gi) {
    if (!state.report) return [];
    var clusters = clustersFor(pi);
    var cl = clusters[gi];
    return state.report.issues.filter(function (i) {
      return i.para === pi + 1 && cl.start >= i.start && cl.start < i.end;
    });
  }

  function buildClusterCell(pi, gi, cluster, mode, visualIdx) {
    var cell = el("span", "blab-cell");
    cell.dataset.para = pi;
    cell.dataset.gi = gi;
    var txt = el("span", "blab-cell-text");
    var isInvis = cluster.cps.every(function (c) {
      return /MARK|EMBEDDING|OVERRIDE|ISOLATE|POP|ZERO WIDTH|JOINER|SEPARATOR|SOFT HYPHEN|VARIATION|ANCHOR|TERMINATOR|TAG|NULL|LINE FEED|FORM FEED|CARRIAGE RETURN|TABULATION|NEXT LINE|DELETE|SURROGATE/.test(c.name);
    });
    var isSpaceCluster = cluster.cps.every(function (c) {
      return /SPACE/.test(c.name) || c.name === "CHARACTER TABULATION";
    });
    if (isSpaceCluster) {
      txt.textContent = "␠";
      txt.classList.add("blab-space");
    } else if (isInvis) {
      txt.textContent = "◌";
      txt.classList.add("blab-invis");
      txt.title = cluster.cps.map(function (c) { return c.cp + " " + c.name; }).join("\n");
    } else {
      txt.textContent = cluster.text;
    }
    cell.appendChild(txt);

    var sub = el("span", "blab-cell-sub");
    sub.textContent = cluster.start; // 逻辑起始码点
    sub.setAttribute("dir", "ltr");
    cell.appendChild(sub);

    var hits = issueHitsCluster(pi, gi);
    if (hits.length) {
      cell.classList.add("issue-" + hits[0].severity);
      cell.title = hits.map(function (h) { return typeLabel(h.type) + "：" + h.reason; }).join("\n");
    }
    if (state.activeCluster &&
        state.activeCluster.para === pi && state.activeCluster.gi === gi) {
      cell.classList.add("active-cluster");
    }

    cell.addEventListener("click", function () {
      locateCluster(pi, gi, mode);
    });
    return cell;
  }

  // 双视图 + 原编辑器三向定位到同一个字素簇
  function locateCluster(pi, gi, fromMode) {
    var clusters = clustersFor(pi);
    var cl = clusters[gi];
    state.activeCluster = { para: pi, gi: gi };
    state.activePara = pi;
    renderParaBar();
    renderColumns();

    // 两个视图都把同一字素簇滚动到可视区（双视图定位）
    [".blab-col-logical", ".blab-col-visual"].forEach(function (sel) {
      var col = document.querySelector(sel + " .blab-col-body");
      if (!col) return;
      var target = col.querySelector(
        ".blab-cell[data-para='" + pi + "'][data-gi='" + gi + "']");
      if (target) {
        var cTop = target.offsetTop - col.offsetTop -
          col.clientHeight / 2 + target.clientHeight / 2;
        col.scrollTop = Math.max(0, cTop);
      }
    });

    // 在另一视图的信息栏给出对应视觉/逻辑序号
    var g = state.geometry[pi];
    if (g) {
      var vi = g.visualOrder.indexOf(gi);
      state.ui.visual.info.textContent =
        "逻辑簇 #" + gi + "（码点 " + cl.start + "–" + cl.end +
        "）位于渲染序列第 " + (vi + 1) + " 位、视觉行 " +
        ((g.clusters[gi] && g.clusters[gi].line + 1) || "-");
      state.ui.logical.info.textContent =
        "逻辑簇 #" + gi + "（码点 " + cl.start + "–" + cl.end +
        "）；渲染序列位置：第 " + (vi + 1) + " 位。";
    }

    // 联动原编辑器：仅当实验室段落来自编辑器且段落文本仍一致时定位
    if (state.source === "editor" && Editor.getParagraphs()[pi]) {
      var cur = Editor.getParagraphs()[pi];
      if (cur.dir === state.paragraphs[pi].dir &&
          cur.text === state.paragraphs[pi].text) {
        Editor.locateGrapheme(pi, cl.start, cl.end);
      } else {
        toast("编辑器正文已变化，无法在原文中定位该字素簇（实验室视图不受影响）。", "error");
      }
    }
  }

  /* ---------- 问题清单 ---------- */

  function renderIssues(report) {
    var box = state.ui.issueList;
    box.innerHTML = "";
    if (!report.issues.length) {
      box.appendChild(el("div", "blab-empty", "未发现双向安全问题。"));
      return;
    }
    // 按段落、逻辑位置排序
    var sorted = report.issues.slice().sort(function (a, b) {
      return a.para - b.para || a.start - b.start || a.end - b.end;
    });
    sorted.forEach(function (issue) {
      box.appendChild(buildIssueRow(issue));
    });
  }

  function buildIssueRow(issue) {
    var row = el("div", "blab-issue sev-" + issue.severity);
    var head = el("div", "blab-issue-head");
    var badge = el("span", "blab-badge sev-" + issue.severity,
      { high: "高风险", medium: "中风险", low: "低风险" }[issue.severity]);
    head.appendChild(badge);
    head.appendChild(el("b", null, typeLabel(issue.type)));
    var where = el("span", "blab-where");
    where.setAttribute("dir", "ltr");
    where.textContent = "段落 #" + issue.para + " · 逻辑码点 [" +
      issue.start + "," + issue.end + ") · 字素簇 " +
      issue.graphemeStart + "–" + (issue.graphemeEnd - 1);
    head.appendChild(where);
    row.appendChild(head);

    var cl = el("div", "blab-issue-cluster");
    cl.appendChild(el("span", "blab-k", "所属字素簇："));
    var cb = el("bdi", "blab-cluster-sample");
    cb.textContent = visibleClusterLabel(issue.cluster);
    cl.appendChild(cb);
    row.appendChild(cl);

    var cps = el("div", "blab-issue-cps");
    cps.appendChild(el("span", "blab-k", "码点："));
    issue.codepoints.forEach(function (c) {
      var tag = el("code", "blab-cp");
      tag.setAttribute("dir", "ltr");
      tag.textContent = c.cp + " " + c.name;
      cps.appendChild(tag);
    });
    row.appendChild(cps);

    row.appendChild(el("div", "blab-issue-reason", issue.reason));

    row.addEventListener("click", function () {
      state.activePara = issue.para - 1;
      renderParaBar();
      renderColumns();
      locateCluster(issue.para - 1, issue.graphemeStart, "issue");
      // 滚动到对应格子
      var pi = issue.para - 1;
      var targets = document.querySelectorAll(
        ".blab-col .blab-cell[data-para='" + pi + "'][data-gi='" +
        issue.graphemeStart + "']");
      if (targets.length) targets[0].scrollIntoView({ block: "nearest" });
    });
    return row;
  }

  function visibleClusterLabel(text) {
    if (text == null) return "";
    var clusters = core.segmentGraphemes(text);
    var parts = clusters.map(function (g) {
      var allInvis = g.cps.every(function (c) {
        return /MARK|EMBEDDING|OVERRIDE|ISOLATE|POP|ZERO WIDTH|JOINER|SEPARATOR|SOFT HYPHEN|VARIATION|TAG|ANCHOR|TERMINATOR|NULL|TABULATION|LINE FEED|FORM FEED|CARRIAGE RETURN|NEXT LINE|DELETE|SURROGATE|SPACE/.test(c.name);
      });
      return allInvis
        ? g.cps.map(function (c) { return c.cp; }).join(" ")
        : g.text;
    });
    return parts.join("") || "（空）";
  }

  /* ---------- 修复建议 ---------- */

  function renderFixes() {
    var box = state.ui.fixList;
    box.innerHTML = "";
    if (!state.plan) return;
    if (!state.plan.suggestions.length) {
      box.appendChild(el("div", "blab-empty", "没有可安全自动处理的建议；高风险片段请人工确认。"));
      return;
    }
    state.plan.suggestions.forEach(function (s) {
      box.appendChild(buildFixRow(s));
    });
  }

  function buildFixRow(s) {
    var row = el("div", "blab-fix");
    var top = el("div", "blab-fix-top");
    var cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!state.selected[s.id];
    cb.addEventListener("click", function (e) { e.stopPropagation(); });
    cb.addEventListener("change", function () {
      if (state.stale) {
        cb.checked = false;
        toast("旧诊断已过期，请重新诊断后再选择修复", "error");
        return;
      }
      state.selected[s.id] = cb.checked;
    });
    top.appendChild(cb);
    top.appendChild(el("b", null, fixLabel(s.kind)));
    var where = el("span", "blab-where");
    where.setAttribute("dir", "ltr");
    where.textContent = s.kind === core.FK.SET_DIR
      ? "段落 #" + s.para + " " + s.fromDir + " → " + s.toDir
      : "段落 #" + s.para + " · 逻辑码点 [" + s.start + "," + s.end + ")";
    top.appendChild(where);
    var previewBtn = el("button", "blab-mini", "预览前后与视觉范围");
    previewBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openFixPreview(s);
    });
    top.appendChild(previewBtn);
    row.appendChild(top);
    row.appendChild(el("div", "blab-fix-label", s.label));
    return row;
  }

  function toggleAllFixes() {
    if (state.stale) { toast("旧诊断已过期，请重新诊断", "error"); return; }
    var anyUnchecked = state.plan.suggestions.some(function (s) {
      return !state.selected[s.id];
    });
    var next = {};
    state.plan.suggestions.forEach(function (s) { next[s.id] = anyUnchecked; });
    state.selected = next;
    renderFixes();
  }

  // 修复预览：修复前后逻辑码点、同宽度渲染预览、可能改变的视觉范围
  function openFixPreview(s) {
    var overlay = el("div", "modal-overlay");
    var modal = el("div", "modal blab-preview-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    var head = el("div", "modal-head");
    head.appendChild(el("h3", null, "修复预览 · " + fixLabel(s.kind)));
    var x = el("button", "modal-close", "×");
    head.appendChild(x);
    modal.appendChild(head);

    var body = el("div", "modal-body");
    var pi = s.para - 1;
    var para = state.paragraphs[pi];

    var where = el("p", "blab-preview-where");
    where.setAttribute("dir", "ltr");
    var ranges = "段落 #" + s.para + " · 逻辑码点 [" + s.start + "," + s.end + ")";
    if (s.extraEdits && s.extraEdits.length) {
      ranges += "（联动修改配对控制符 " +
        s.extraEdits.map(function (e) { return "[" + e.start + "," + e.end + ")"; }).join("、") + "）";
    }
    where.textContent = ranges +
      (s.kind === core.FK.SET_DIR ? "（仅方向元数据，不改正文码点）" : "");
    body.appendChild(where);

    // 逻辑码点前后
    var table = el("table", "blab-cp-table");
    var trh = el("tr");
    trh.appendChild(el("th", null, "修复前逻辑码点"));
    trh.appendChild(el("th", null, "修复后逻辑码点"));
    table.appendChild(trh);
    var tr = el("tr");
    var tdA = el("td");
    (s.before.length ? s.before : [{ cp: "—", name: "无（不改码点）" }]).forEach(function (c) {
      var d = el("div"); d.setAttribute("dir", "ltr");
      d.textContent = c.cp + " " + c.name;
      tdA.appendChild(d);
    });
    var tdB = el("td");
    (s.after.length ? s.after : [{ cp: "—", name: "无（不改码点）" }]).forEach(function (c) {
      var d = el("div"); d.setAttribute("dir", "ltr");
      d.textContent = c.cp + " " + c.name;
      tdB.appendChild(d);
    });
    tr.appendChild(tdA); tr.appendChild(tdB);
    table.appendChild(tr);
    body.appendChild(table);

    // 同宽度渲染预览（用核心 UAX #9 重排得到逻辑→视觉顺序）
    var prev = el("div", "blab-render-preview");
    prev.appendChild(el("b", null, "同宽度（" + state.conditions.width +
      "px）实际渲染预览，黄色为可能改变的视觉范围："));
    var span = core.visualSpanFor(para, s);
    var afterPara = computeAfterPara(para, s);
    var boxA = renderPreviewLine(para, "修复前",
      span && span.beforeOrder, span && span.changedVisualIndices);
    // 修复后独立重排，视觉范围用同长度差集近似（标注重心在“哪些簇移动了”）
    var afterSpan = null;
    if (s.kind === core.FK.SET_DIR) {
      afterSpan = { changedVisualIndices: span && span.changedVisualIndices };
    }
    var boxB = renderPreviewLine(afterPara, "修复后", null,
      afterSpan && afterSpan.changedVisualIndices);
    prev.appendChild(boxA);
    prev.appendChild(boxB);
    body.appendChild(prev);

    var foot = el("div", "modal-foot");
    var closeb = el("button", null, "关闭");
    foot.appendChild(closeb);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", esc);
    }
    function esc(e) { if (e.key === "Escape") close(); }
    x.addEventListener("click", close);
    closeb.addEventListener("click", close);
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", esc);
  }

  function computeAfterPara(para, s) {
    if (s.kind === core.FK.SET_DIR) return { dir: s.toDir, text: para.text };
    var repl = "";
    if (s.kind === core.FK.LEGACY_TO_ISOLATE) {
      repl = String.fromCodePoint(parseInt(s.replacementCp.slice(2), 16));
    }
    if (s.kind === core.FK.ISOLATE_NUMBER) {
      repl = String.fromCodePoint(0x2068) + s.clusterText + String.fromCodePoint(0x2069);
    }
    // 主编辑之外，还要应用与配对闭符联动的附加编辑（降序，避免偏移漂移）
    var edits = [{ start: s.start, end: s.end, repl: repl }]
      .concat((s.extraEdits || []).map(function (e) {
        return {
          start: e.start, end: e.end,
          repl: e.replacementCp
            ? String.fromCodePoint(parseInt(e.replacementCp.slice(2), 16))
            : ""
        };
      }))
      .sort(function (a, b) { return b.start - a.start; });
    var cps = Array.from(para.text);
    edits.forEach(function (e) { cps.splice(e.start, e.end - e.start, e.repl); });
    return { dir: para.dir, text: cps.join("") };
  }

  function renderPreviewLine(para, title, order, changed) {
    var wrap = el("div", "blab-prev-line");
    wrap.appendChild(el("div", "blab-prev-title", title + "（dir=" + para.dir + "）"));
    var line = el("div", "blab-prev-text");
    line.setAttribute("dir", para.dir === "auto" ? "auto" : para.dir);
    var clusters = core.segmentGraphemes(para.text);
    var seq = order;
    if (!seq) {
      // 修复后：独立按 UAX #9 重排
      var res = core.resolveParagraph(para.text, para.dir);
      seq = res.order.map(function (o) { return o.gi; });
    }
    seq.forEach(function (gi, vi) {
      var c = el("span", "blab-prev-cell");
      c.textContent = displayText(clusters[gi]);
      if (changed && vi >= changed.start && vi < changed.end) c.classList.add("changed-range");
      line.appendChild(c);
    });
    wrap.appendChild(line);
    return wrap;
  }

  function displayText(cluster) {
    var hasVis = cluster.cps.some(function (c) {
      return !/MARK|EMBEDDING|OVERRIDE|ISOLATE|POP|ZERO WIDTH|JOINER|SEPARATOR|SOFT HYPHEN|VARIATION|TAG|ANCHOR|TERMINATOR|NULL|TABULATION|LINE FEED|FORM FEED|CARRIAGE RETURN|NEXT LINE|DELETE|SURROGATE|SPACE/.test(c.name);
    });
    return hasVis ? cluster.text : "◌";
  }

  /* ---------- 批量应用 ---------- */

  function applySelected() {
    if (state.stale) {
      toast("旧诊断已过期，必须重新诊断后才能应用修复；本次未改动任何文字。", "error");
      return;
    }
    var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
    if (!ids.length) { toast("请先勾选至少一条修复建议", "error"); return; }

    // 取“当前”正文与条件（而不是诊断副本），让核心层做指纹门禁
    var currentDoc, currentConditions;
    if (state.source === "editor") {
      var ps = Editor.getParagraphs();
      currentDoc = { paragraphs: ps.map(function (p) { return { dir: p.dir, text: p.text }; }) };
      // 实验室内部的“假设方向”未写回编辑器：不允许拿它的修复位置应用，
      // 必须先把方向写回编辑器或重新载入后重新诊断。
      var dirDesync = currentDoc.paragraphs.some(function (p, i) {
        return state.paragraphs[i] && p.dir !== state.paragraphs[i].dir;
      });
      if (dirDesync) {
        toast("段落方向已在实验室内改变但未写回编辑器；请先在编辑器中切换方向后重新载入诊断，本次未改动任何文字。", "error");
        markStale("段落方向（实验室假设）与编辑器不一致");
        return;
      }
    } else {
      currentDoc = { paragraphs: state.paragraphs };
    }
    currentConditions = {
      dirs: currentDoc.paragraphs.map(function (p) { return p.dir; }),
      width: state.conditions.width, zoom: state.conditions.zoom,
      font: state.conditions.font
    };

    var result = core.applySuggestions(currentDoc, currentConditions, ids,
      state.plan, state.planMeta);
    if (!result.ok) {
      // 失败：保留当前选择与预览内容，不改任何文字
      toast("整次拒绝：" + result.message, "error");
      if (result.code === "content_changed" || result.code === "render_condition_changed") {
        markStale(result.code === "content_changed"
          ? "正文或段落方向已变化" : "渲染条件已变化");
      }
      return;
    }

    if (state.source === "editor") {
      // 捕获撤销状态（在改动之前）
      var undoState = Editor.captureState();
      state.applyingSelf = true; // 抑制自己写入触发的“过期”标记
      var applied = Editor.applyLabDocument(result.paragraphs);
      state.applyingSelf = false;
      if (!applied.ok) {
        toast("写入编辑器被拒绝：" + applied.message + "（实验室诊断内容保留）", "error");
        return;
      }
      // 一次性撤销记录（postContentFp 同步设置，撤销前置校验不依赖网络完成）
      state.lastRepair = {
        undo: undoState, appliedAt: result.at, ids: ids,
        summary: result.applied, recordId: null,
        postContentFp: result.contentFp
      };
      saveRepairRecord(result, ids, undoState);
      toast("已应用 " + result.applied.length + " 项修复；可一次性撤销。");
    } else {
      // 手动样例：在实验室内更新副本并立即重新诊断
      state.paragraphs = result.paragraphs;
      state.lastRepair = null;
      toast("已在实验室样例上应用 " + result.applied.length +
        " 项修复（手动样例不会触碰编辑器正文），重新诊断中…");
    }

    // 编辑器来源：实验室副本与渲染条件同步到修复后的正文
    if (state.source === "editor") {
      state.paragraphs = result.paragraphs.map(function (p) {
        return { dir: p.dir, text: p.text };
      });
    }

    // 应用后旧诊断必然失效：立即重算
    runDiagnosis(state.conditions);
    if (state.source === "editor") {
      // 回到原编辑器中“对应位置”：第一项修复所在段落与簇
      var first = result.applied[0];
      if (first) {
        var cl = core.segmentGraphemes(result.paragraphs[first.para - 1].text);
        var gi = core.clusterIndexAt(cl, Math.min(first.start, cl.length - 1));
        locateCluster(first.para - 1, cl[gi] ? gi : 0, "repair");
      }
    }
  }

  /* ---------- 撤销 ---------- */

  function undoLast() {
    if (!state.lastRepair) {
      toast("没有可撤销的实验室修复（撤销仅对最近一次应用有效，且只有一次）。", "error");
      return;
    }
    if (state.source !== "editor") {
      toast("手动样例不提供撤销（正文从未被修改）。", "error");
      return;
    }
    var repair = state.lastRepair;
    // 一次性：重复撤销明确拒绝
    var now = Editor.captureState();
    // 撤销前置条件：当前内容必须等于修复后的快照（即修复后没有别的编辑）。
    // 用段落文本+方向指纹比对撤销记录中保存的“修复后内容”。
    var expectFp = repair.postContentFp;
    var curFp = core.contentFingerprint(now.paragraphs);
    if (expectFp && curFp !== expectFp) {
      toast("修复之后正文又被修改过，为避免覆盖新编辑，本次撤销被拒绝。", "error");
      return;
    }
    state.applyingSelf = true;
    var restored = Editor.restoreLabState(repair.undo);
    state.applyingSelf = false;
    if (!restored.ok) { toast("撤销失败：" + restored.message, "error"); return; }

    // 实验室副本同步回撤销后的原始正文
    state.paragraphs = repair.undo.paragraphs.map(function (p) {
      return { dir: p.dir, text: p.text };
    });
    saveUndoRecord(repair);
    state.lastRepair = null; // 一次性：立即清空，重复撤销被拒绝
    runDiagnosis(state.conditions);
    toast("已精确还原文本、段落方向、选区与滚动位置。");
  }

  /* ---------- 服务端记录 ---------- */

  function saveRepairRecord(result, ids, undoState) {
    var record = {
      kind: "repair",
      paraCount: result.paragraphs.length,
      issueCount: state.report ? state.report.issues.length : 0,
      applied: result.applied,
      contentFp: state.planMeta.contentFp,
      renderFp: state.planMeta.renderFp,
      note: "应用 " + result.applied.length + " 项建议"
    };
    api("POST", "/api/bidi-lab/records", { ifMatch: state.rev, body: record })
      .then(function (r) {
        state.rev = r.rev;
        // 把修复后内容指纹挂到 lastRepair，供撤销前置校验
        if (state.lastRepair) state.lastRepair.recordId = r.data.record.id;
        if (state.lastRepair) {
          state.lastRepair.postContentFp = core.contentFingerprint(
            Editor.getParagraphs().map(function (p) { return { dir: p.dir, text: p.text }; }));
        }
        refreshRecords();
      })
      .catch(function (e) {
        toast("修复已应用，但修复记录保存失败（" + e.message + "）；不影响撤销功能。", "error");
      });
  }

  function saveUndoRecord(repair) {
    var record = {
      kind: "undo", undoOf: repair.recordId || null,
      paraCount: repair.undo.paragraphs.length,
      applied: repair.summary || [],
      contentFp: core.contentFingerprint(repair.undo.paragraphs),
      undoResult: { restoredSelection: !!repair.undo.selection,
        scrollY: repair.undo.scrollY },
      note: "一次性撤销，精确还原文本/方向/选区/滚动"
    };
    api("POST", "/api/bidi-lab/records", { ifMatch: state.rev, body: record })
      .then(function (r) {
        state.rev = r.rev;
        if (repair.recordId) state.appliedRepairIds[repair.recordId] = true;
        refreshRecords();
      })
      .catch(function (e) {
        toast("撤销已完成，但撤销结果保存失败（" + e.message + "）。", "error");
      });
  }

  function saveReportRecord() {
    if (!state.report) { toast("还没有诊断报告", "error"); return; }
    var record = {
      kind: "report",
      paraCount: state.paragraphs.length,
      issueCount: state.report.issues.length,
      contentFp: state.report.contentFp,
      renderFp: currentRenderFp(),
      report: {
        generatedAt: state.report.generatedAt,
        warnings: state.report.warnings,
        issues: state.report.issues.map(function (i) {
          return { para: i.para, start: i.start, end: i.end,
            type: i.type, severity: i.severity, reason: i.reason,
            cluster: i.cluster };
        }),
        conditions: {
          width: state.conditions.width, zoom: state.conditions.zoom,
          fontSize: state.conditions.fontSize, font: state.conditions.font
        }
      },
      note: "诊断报告"
    };
    api("POST", "/api/bidi-lab/records", { ifMatch: state.rev, body: record })
      .then(function (r) { state.rev = r.rev; toast("诊断报告已保存，刷新后仍可查看"); refreshRecords(); })
      .catch(function (e) { toast("报告保存失败：" + e.message, "error"); });
  }

  /* ================= 样例视图 ================= */

  function buildSamplesView() {
    var v = el("div", "blab-view");
    v.id = "blab-view-samples";
    v.style.display = "none";

    var intro = el("p", "snap-note",
      "把典型段落保存为诊断样例（记录预期问题类型、逻辑位置与视觉锚点）；以后批量回归会报告新增、消失、位置变化与渲染顺序变化。回归全程只读，绝不改动编辑器正文。");
    v.appendChild(intro);

    // 保存当前载入内容为样例
    var saveBox = el("div", "blab-section");
    saveBox.appendChild(el("b", null, "把当前实验室内容存为样例"));
    var nameRow = el("div", "blab-sample-name");
    var nameInput = el("input");
    nameInput.type = "text"; nameInput.placeholder = "样例名称（必填，最长 100 字符）";
    nameRow.appendChild(nameInput);
    saveBox.appendChild(nameRow);
    var hint = el("div", "snap-note",
      "预期问题可在保存后编辑补充；视觉锚点请在样例编辑中给出 {段落, 标签, 码点起, 止}。");
    saveBox.appendChild(hint);
    var bSave = el("button", "primary", "保存当前诊断内容为样例");
    bSave.addEventListener("click", function () {
      if (!state.paragraphs || !state.paragraphs.length) {
        toast("请先在“诊断与修复”页载入内容", "error"); return;
      }
      saveSampleFromCurrent(nameInput.value);
    });
    saveBox.appendChild(bSave);
    var bSaveReport = el("button", null, "把最近诊断报告存入历史记录");
    bSaveReport.addEventListener("click", saveReportRecord);
    saveBox.appendChild(bSaveReport);
    v.appendChild(saveBox);

    var bar = el("div", "blab-sample-bar");
    var bRecheck = el("button", "primary", "批量重新检查全部样例");
    bRecheck.addEventListener("click", recheckAll);
    var bRefresh = el("button", null, "刷新样例列表");
    bRefresh.addEventListener("click", refreshSamples);
    bar.appendChild(bRecheck); bar.appendChild(bRefresh);
    v.appendChild(bar);

    var resultBox = el("div", "blab-recheck-summary");
    v.appendChild(resultBox);
    var list = el("div", "blab-sample-list");
    v.appendChild(list);

    state.samplesUI = { list: list, resultBox: resultBox, nameInput: nameInput };
    return v;
  }

  function saveSampleFromCurrent(name) {
    var payload = {
      name: name,
      paragraphs: state.paragraphs.map(function (p) { return { dir: p.dir, text: p.text }; }),
      // 自动带上当前诊断到的问题作为“预期”
      expected: state.report ? state.report.issues.map(function (i) {
        return { type: i.type, para: i.para, start: i.start, end: i.end };
      }) : [],
      anchors: currentAnchorsFromReport()
    };
    api("POST", "/api/bidi-lab/samples", { ifMatch: state.rev, body: payload })
      .then(function (r) {
        state.rev = r.rev;
        state.samplesUI.nameInput.value = "";
        toast("样例已保存，刷新后仍可用");
        refreshSamples();
      })
      .catch(function (e) {
        toast("样例保存失败：" + e.message + "（当前选择与预览已保留）", "error");
      });
  }

  // 从当前几何测量中为每段生成少量视觉锚点（问题簇作为锚点）
  function currentAnchorsFromReport() {
    if (!state.report || !state.geometry.length) return [];
    var anchors = [];
    state.report.issues.forEach(function (i) {
      anchors.push({
        para: i.para, label: typeLabel(i.type) + "@" + i.start,
        start: i.start, end: i.end
      });
    });
    return anchors.slice(0, 20);
  }

  function refreshSamples() {
    api("GET", "/api/bidi-lab/samples")
      .then(function (r) {
        state.rev = r.rev;
        state.samples = r.data.samples;
        renderSamples();
      })
      .catch(function (e) {
        if (state.samplesUI) {
          state.samplesUI.list.innerHTML = "";
          state.samplesUI.list.appendChild(el("div", "blab-empty is-error",
            "样例加载失败：" + e.message));
        }
      });
  }

  function renderSamples() {
    if (!state.samplesUI) return;
    var box = state.samplesUI.list;
    box.innerHTML = "";
    if (!state.samples.length) {
      box.appendChild(el("div", "blab-empty", "尚无样例。"));
      return;
    }
    state.samples.forEach(function (s) {
      box.appendChild(buildSampleRow(s));
    });
  }

  function buildSampleRow(s) {
    var row = el("div", "blab-sample");
    var top = el("div", "blab-sample-top");
    top.appendChild(el("b", null, s.name));
    var meta = el("span", "blab-where");
    meta.setAttribute("dir", "ltr");
    meta.textContent = s.paragraphs.length + " 段 · 预期 " +
      (s.expected || []).length + " 项 · 锚点 " + (s.anchors || []).length +
      " · 更新 " + (s.updatedAt || s.createdAt || "");
    top.appendChild(meta);
    row.appendChild(top);

    var btns = el("div", "blab-sample-btns");
    var bLoad = el("button", "blab-mini", "载入实验室");
    bLoad.addEventListener("click", function () {
      state.source = "sample:" + s.id;
      state.paragraphs = s.paragraphs.map(function (p) { return { dir: p.dir, text: p.text }; });
      state.editorSnapshot = null;
      state.report = null; state.plan = null; state.geometry = []; state.selected = {};
      state.ui.srcInfo.textContent = "已载入样例 “" + s.name + "”（只读回归，不触碰正文）。";
      state.ui.srcInfo.className = "blab-srcinfo ok";
      switchTab("diagnose");
      renderAfterLoad();
      toast("已载入样例 “" + s.name + "”");
    });
    var bCheck = el("button", "blab-mini", "重新检查此样例");
    bCheck.addEventListener("click", function () { recheckOne(s.id); });
    var bDel = el("button", "blab-mini danger", "删除");
    bDel.addEventListener("click", function () { deleteSample(s.id, s.name); });
    btns.appendChild(bLoad); btns.appendChild(bCheck); btns.appendChild(bDel);
    row.appendChild(btns);

    if (s.lastRecheck) {
      var rc = el("div", "blab-recheck-line rc-" + s.lastRecheck.status);
      rc.textContent = "上次回归：" + recheckText(s.lastRecheck);
      row.appendChild(rc);
    }
    return row;
  }

  function recheckText(r) {
    var map = {
      unchanged: "无变化", new: "出现新增问题 " + r.added.length + " 项",
      disappeared: "有问题消失 " + r.disappeared.length + " 项",
      moved: "问题位置变化 " + r.moved.length + " 处",
      mixed: "新增/消失/移动并存",
      render_changed: "问题集合一致，但渲染顺序发生变化",
      invalid_sample: "样例无效：" + (r.error || "")
    };
    return map[r.status] || r.status;
  }

  function recheckOne(id) {
    api("POST", "/api/bidi-lab/samples/recheck", { body: { ids: [id] } })
      .then(function (r) {
        renderRecheckResults(r.data);
        // 单样例结果更新到行内（服务端 recheck 不落 lastRecheck，前端即时展示）
        toast("回归完成：" + recheckText(r.data.results[0]));
      })
      .catch(function (e) { toast("回归失败：" + e.message, "error"); });
  }

  function recheckAll() {
    api("POST", "/api/bidi-lab/samples/recheck", { body: {} })
      .then(function (r) {
        renderRecheckResults(r.data);
        toast("批量回归完成：" + r.data.summary.total + " 个样例，" +
          r.data.summary.new + " 新增 / " + r.data.summary.disappeared +
          " 消失 / " + r.data.summary.moved + " 移位 / " +
          r.data.summary.render_changed + " 渲染顺序变化");
      })
      .catch(function (e) {
        toast("批量回归失败：" + e.message + "（样例与正文均未改动）", "error");
      });
  }

  function renderRecheckResults(data) {
    var box = state.samplesUI.resultBox;
    box.innerHTML = "";
    var sum = data.summary;
    var head = el("div", "blab-recheck-head");
    head.textContent = "回归汇总（共 " + sum.total + "）：无变化 " + sum.unchanged +
      " · 新增 " + sum.new + " · 消失 " + sum.disappeared +
      " · 位置变化 " + sum.moved + " · 渲染顺序变化 " + sum.render_changed +
      " · 混合 " + (sum.mixed || 0) + " · 无效 " + (sum.invalid_sample || 0);
    box.appendChild(head);
    data.results.forEach(function (r) {
      var row = el("div", "blab-recheck-row rc-" + r.status);
      row.appendChild(el("b", null, r.name + "：" + recheckText(r)));
      (r.added || []).forEach(function (a) {
        row.appendChild(el("div", "rc-item rc-added",
          "＋ 新增 " + typeLabel(a.type) + "（段#" + a.para + " 码点 " + a.start + "）"));
      });
      (r.disappeared || []).forEach(function (d) {
        row.appendChild(el("div", "rc-item rc-disappeared",
          "－ 消失 " + typeLabel(d.type) + "（原段#" + d.para + " 码点 " + d.start + "）"));
      });
      (r.moved || []).forEach(function (m) {
        row.appendChild(el("div", "rc-item rc-moved",
          "→ 移位 " + typeLabel(m.type) + "（段#" + m.para + "：" +
          m.oldStart + " → " + m.newStart + "）"));
      });
      if (r.orderChanged) {
        row.appendChild(el("div", "rc-item rc-order",
          "◈ 视觉锚点的渲染顺序与保存时不同（逻辑码点未变，但屏幕阅读顺序变了）"));
      }
      box.appendChild(row);
    });
  }

  function deleteSample(id, name) {
    if (!window.confirm("确认删除样例 “" + name + "”？此操作不影响编辑器正文。")) return;
    api("DELETE", "/api/bidi-lab/samples/" + encodeURIComponent(id), { ifMatch: state.rev })
      .then(function (r) { state.rev = r.rev; toast("样例已删除"); refreshSamples(); })
      .catch(function (e) { toast("删除失败：" + e.message, "error"); });
  }

  /* ================= 历史记录视图 ================= */

  function buildRecordsView() {
    var v = el("div", "blab-view");
    v.id = "blab-view-records";
    v.style.display = "none";
    var bar = el("div", "blab-sample-bar");
    var bRefresh = el("button", null, "刷新记录");
    bRefresh.addEventListener("click", refreshRecords);
    bar.appendChild(bRefresh);
    v.appendChild(bar);
    var list = el("div", "blab-record-list");
    v.appendChild(list);
    state.recordsUI = { list: list };
    return v;
  }

  function refreshRecords() {
    api("GET", "/api/bidi-lab/records")
      .then(function (r) {
        state.rev = r.rev;
        state.records = r.data.records;
        renderRecords();
      })
      .catch(function (e) {
        if (state.recordsUI) {
          state.recordsUI.list.innerHTML = "";
          state.recordsUI.list.appendChild(el("div", "blab-empty is-error",
            "记录加载失败：" + e.message));
        }
      });
  }

  function renderRecords() {
    if (!state.recordsUI) return;
    var box = state.recordsUI.list;
    box.innerHTML = "";
    if (!state.records.length) {
      box.appendChild(el("div", "blab-empty",
        "尚无记录。诊断报告、修复应用与撤销结果在保存后刷新仍可查看。"));
      return;
    }
    state.records.forEach(function (r) {
      var row = el("div", "blab-record blab-record-" + r.kind);
      var title = { report: "📋 诊断报告", repair: "🛠 修复应用", undo: "↩ 撤销结果" }[r.kind] || r.kind;
      row.appendChild(el("b", null, title + " · " + (r.at || "")));
      row.appendChild(el("div", null,
        r.paraCount + " 段 · " + r.issueCount + " 问题" +
        (r.applied && r.applied.length ? " · " + r.applied.length + " 项操作" : "") +
        (r.undoOf ? " · 对应修复 " + r.undoOf.slice(0, 8) : "")));
      if (r.note) row.appendChild(el("div", "snap-note", r.note));
      if (r.kind === "report" && r.report) {
        var det = el("details");
        var sum = el("summary", null, "查看问题清单（" + r.issueCount + "）");
        det.appendChild(sum);
        (r.report.issues || []).forEach(function (i) {
          var line = el("div", "blab-record-issue");
          line.setAttribute("dir", "ltr");
          line.textContent = "段#" + i.para + " [" + i.start + "," + i.end + ") " +
            typeLabel(i.type) + "（" + i.severity + "）";
          det.appendChild(line);
        });
        row.appendChild(det);
      }
      box.appendChild(row);
    });
  }

  /* ---------- 编辑器变化订阅：载入实验室后，正文被改动即过期 ---------- */

  if (window.Editor && Editor.subscribe) {
    Editor.subscribe(function () {
      if (!state.report || state.source !== "editor") return;
      // 实验室自己应用修复/撤销会同步触发编辑器变更，不算外部改动
      if (state.applyingSelf) return;
      // 指纹比对由修复应用门禁兜底，这里只负责 UI 过期标记。
      var ps = Editor.getParagraphs();
      var fp = core.contentFingerprint(ps.map(function (p) {
        return { dir: p.dir, text: p.text };
      }));
      if (fp !== state.planMeta.contentFp && !state.stale) {
        markStale("编辑器正文或段落方向已变化");
      }
    });
  }

  /* ---------- 入口按钮 ---------- */
  function init() {
    var btn = document.createElement("button");
    btn.id = "bidi-lab-open";
    btn.className = "lab";
    btn.title = "打开双向文本安全诊断与修复实验室（只读诊断，修复需显式应用）";
    btn.textContent = "🧪 双向安全实验室";
    btn.addEventListener("click", openLab);
    var toolbar = document.querySelector(".topbar .toolbar");
    if (toolbar) {
      var sep = document.createElement("span");
      sep.className = "sep";
      toolbar.appendChild(sep);
      toolbar.appendChild(btn);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
