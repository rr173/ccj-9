"use strict";
/*
 * 房间编辑页客户端。
 *
 * 收敛模型（简单可靠）：服务器文本是唯一权威。
 *   - 本地编辑：记录「旧文本 -> 新文本」的字素簇 LCS diff，立刻乐观显示，
 *     带客户端 opId + baseRev 提交（单飞队列，保证顺序）。
 *   - 收到 ack/op：以服务器 text 为准重绘；若编辑期间又有新输入（队列未空），
 *     把未提交的本地改动重新 diff 到新文本继续提交。
 *   - 重连：hello 快照直接覆盖文本，重放未确认操作（同 opId，服务端幂等）。
 * 光标位置全部按字素簇换算（UTF-16 偏移 <-> 集群索引），不劈开 emoji ZWJ。
 */

(function () {
  const C = window.CollabCore;
  const params = new URLSearchParams(location.search);
  const roomId = params.get("id");

  const $ = id => document.getElementById(id);
  const editor = $("editor");
  const revEl = $("rev");
  const countEl = $("cluster-count");
  const connEl = $("conn");
  const membersEl = $("members");
  const memberCountEl = $("member-count");
  const conflictsEl = $("conflicts");
  const toastEl = $("toast");
  const nameInput = $("my-name");
  const cursorsLayer = $("cursors");

  if (!roomId) { location.href = "/"; return; }

  /* ---------- 本地身份（持久化） ---------- */
  let identity = loadIdentity();
  function loadIdentity() {
    try {
      const v = JSON.parse(localStorage.getItem("collab.identity") || "null");
      if (v && v.memberId) return v;
    } catch (e) {}
    const palette = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
      "#42d4f4", "#f032e6", "#469990", "#9A6324", "#800000"];
    const id = "u" + Math.random().toString(36).slice(2, 10);
    const v = { memberId: id, name: "成员-" + id.slice(2, 6),
      color: palette[Math.floor(Math.random() * palette.length)] };
    localStorage.setItem("collab.identity", JSON.stringify(v));
    return v;
  }
  nameInput.value = identity.name;
  nameInput.addEventListener("change", () => {
    identity.name = nameInput.value.trim() || identity.name;
    nameInput.value = identity.name;
    localStorage.setItem("collab.identity", JSON.stringify(identity));
    send({ type: "hello", room: roomId, member: identity }); // 重新打招呼更新名字
  });

  /* ---------- 状态 ---------- */
  let ws = null;
  let connected = false;
  let serverText = "";        // 最近一次服务器权威文本
  let rev = 0;
  let conflicts = [];
  let members = [];
  let remoteCursors = {};     // memberId -> cursor
  let queue = [];             // 待提交编辑 {opId, baseRev, oldText, newText}
  let inflight = null;
  let applyingRemote = false;
  let reconnectDelay = 300;
  let lastCursorSent = 0;

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  /* ---------- 字素簇 LCS diff（旧文本 -> 新文本，集群索引） ---------- */
  function diffClusters(before, after) {
    const a = C.graphemes(before);
    const b = C.graphemes(after);
    const n = a.length, m = b.length;
    // 相等字符用 LCS（协作规模内足够快）；身份信息在服务端原子层保证
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    function flushDel(s, e) { if (e > s) ops.push({ t: "del", start: s, len: e - s }); }
    function flushIns(gap, js, je) {
      if (je > js) { let t = ""; for (let k = js; k < je; k++) t += b[k]; ops.push({ t: "ins", gap: gap, text: t }); }
    }
    while (i < n && j < m) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (dp[i + 1][j] >= dp[i][j + 1]) {
        const s = i;
        while (i < n && (j >= m || a[i] !== b[j]) && dp[i + 1][j] >= dp[i][j + 1]) {
          i++;
          if (i < n && j < m && a[i] === b[j]) break;
        }
        flushDel(s, i);
      } else {
        const js = j;
        while (j < m && (i >= n || a[i] !== b[j]) && dp[i][j + 1] >= dp[i + 1][j]) {
          j++;
          if (i < n && j < m && a[i] === b[j]) break;
        }
        flushIns(i, js, j);
      }
    }
    flushDel(i, n);
    flushIns(n, j, m);
    return { ops: ops, beforeClusters: a.length };
  }

  /* ---------- 编辑事件 → 提交队列 ---------- */
  let lastKnownCaret = { cluster: 0, selStart: 0, selEnd: 0 };
  function captureCaret() {
    const cu = editor.selectionStart || 0;
    const cl = C.codeUnitToCluster(editor.value, cu);
    lastKnownCaret.cluster = cl;
    lastKnownCaret.selStart = C.codeUnitToCluster(editor.value, editor.selectionStart || 0);
    lastKnownCaret.selEnd = C.codeUnitToCluster(editor.value, editor.selectionEnd || 0);
  }
  editor.addEventListener("keydown", () => setTimeout(sendCursorSoon, 0));
  editor.addEventListener("keyup", () => { captureCaret(); sendCursorSoon(); });
  editor.addEventListener("click", () => { captureCaret(); sendCursorSoon(); });
  editor.addEventListener("select", () => { captureCaret(); sendCursorSoon(); });

  let cursorTimer = null;
  function sendCursorSoon() {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      captureCaret();
      const now = Date.now();
      if (now - lastCursorSent > 120) {
        lastCursorSent = now;
        send({ type: "cursor", anchor: lastKnownCaret.cluster,
          selStart: lastKnownCaret.selStart, selEnd: lastKnownCaret.selEnd });
      }
    }, 80);
  }

  editor.addEventListener("input", () => {
    if (applyingRemote) return;
    const newText = editor.value;
    const baseForDiff = queue.length
      ? queue[queue.length - 1].newText
      : (inflight ? inflight.newText : serverText);
    const { ops } = diffClusters(baseForDiff, newText);
    if (!ops.length) return;
    queue.push({
      opId: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + ":" + identity.memberId,
      baseRev: queue.length ? queue[queue.length - 1].baseRev
        : (inflight ? inflight.baseRev : rev),
      oldText: baseForDiff, newText: newText, ops: ops
    });
    pump();
  });

  function pump() {
    if (inflight || !queue.length || !connected) return;
    const item = queue.shift();
    inflight = item;
    send({ type: "commit", opId: item.opId, baseRev: item.baseRev, ops: item.ops });
  }

  /* ---------- 收敛：以服务器文本重绘，追赶本地未提交编辑 ----------
   * pending 保存「已提交未确认」+「排队中」的编辑意图；每次服务器文本变化，
   * 都在最新文本上重新计算第一个未确认编辑的 diff 显示（其余编辑意图通过
   * 它们各自的目标文本链式重放），保证显示与最终收敛一致。
   */
  function converge(newText, newRev, newConflicts) {
    serverText = newText;
    rev = newRev;
    if (newConflicts) conflicts = newConflicts;
    revEl.textContent = rev;
    countEl.textContent = C.gLen(serverText);

    const chain = (inflight ? [inflight] : []).concat(queue);
    let want = serverText;
    if (chain.length) {
      // 把每个编辑的「目标字符结果」依次对齐重放到当前服务器文本：
      // 用上一步结果做 LCS diff，得到该意图在当前文本上的坐标。
      let atoms = C.graphemes(serverText).map((ch, i) => ({ id: "s" + i, ch }));
      for (const it of chain) {
        const d = diffClusters(C.atomsText(atoms), it.newText).ops;
        atoms = C.applyDirect(atoms, d, it.opId.split(":")[0]);
        it.baseRev = rev; // 重发以最新 rev 为基线（opId 不变 => 幂等）
      }
      want = C.atomsText(atoms);
    }

    const hadFocus = document.activeElement === editor;
    const caretBefore = hadFocus
      ? C.codeUnitToCluster(editor.value, editor.selectionStart || 0) : null;
    applyingRemote = true;
    if (editor.value !== want) {
      editor.value = want;
      if (caretBefore != null) {
        const cu = C.clusterToCodeUnit(want, Math.min(caretBefore, C.gLen(want)));
        try { editor.setSelectionRange(cu, cu); } catch (e) {}
      }
    }
    applyingRemote = false;
    renderConflicts();
    renderCursors();
  }

  // 收到 ack：本操作已落库；清 inflight，后续队列按新 rev 继续
  function handleAck(m) {
    if (m.result === "duplicate") {
      // 重发命中幂等：等同于成功
      if (inflight && inflight.opId === m.opId) inflight = null;
      if (m.text != null) converge(m.text, m.rev, m.conflicts);
      pump();
      return;
    }
    if (m.result === "resync" || m.result === "error") {
      if (inflight && inflight.opId === m.opId) {
        // 放弃该乐观编辑，以服务器快照为准（队列其余编辑会在新文本上重算）
        const dropped = inflight;
        inflight = null;
        queue = queue.map(it => {
          if (it.oldText === dropped.newText) it.oldText = m.text;
          return it;
        });
        toast("编辑被拒绝（" + (m.error || m.result) + "），已与服务器同步", true);
      }
      converge(m.text, m.rev, m.conflicts);
      pump();
      return;
    }
    // ok
    if (inflight && inflight.opId === m.opId) inflight = null;
    converge(m.text, m.rev, m.conflicts);
    pump();
  }

  /* ---------- 渲染：成员 / 冲突 / 远程光标 ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function renderMembers() {
    memberCountEl.textContent = members.length ? "(" + members.length + ")" : "";
    membersEl.innerHTML = members.map(mm => {
      const me = mm.memberId === identity.memberId;
      return '<div class="member"><span class="dot' + (mm.online ? "" : " off") +
        '" style="background:' + esc(mm.color) + '"></span>' +
        "<span>" + esc(mm.name) + (me ? ' <span class="me">（我）</span>' : "") +
        (mm.online ? "" : ' <span class="muted">离线</span>') + "</span></div>";
    }).join("");
  }
  function renderConflicts() {
    if (!conflicts.length) { conflictsEl.innerHTML = ""; return; }
    conflictsEl.innerHTML =
      '<div class="card"><h2>待裁决冲突 <span class="badge warn">' + conflicts.length + '</span></h2>' +
      conflicts.map(cf => {
        const aMine = cf.aOpId && cf.aOpId.indexOf(identity.memberId) >= 0;
        return '<div class="conflict-item" data-id="' + esc(cf.id) + '">' +
          '<div class="kind">' + (cf.kind === "same_gap_insert" ? "同位置并发输入" : "编辑撞上对方删除") +
          " · " + esc(new Date(cf.createdAt).toLocaleTimeString()) + "</div>" +
          '<div class="conflict-side"><span class="muted">版本 A</span>' +
          (aMine ? ' <span class="me">（含我的输入）</span>' : "") +
          "<div>" + esc(cf.aText || "（空）").replace(/\n/g, "↵") + "</div>" +
          '<button class="small" data-choice="a">保留 A</button></div>' +
          '<div class="conflict-side"><span class="muted">版本 B</span><div>' +
          esc(cf.bText || "（空）").replace(/\n/g, "↵") + "</div>" +
          '<button class="small" data-choice="b">保留 B</button></div>' +
          "</div>";
      }).join("") + "</div>";
    conflictsEl.querySelectorAll(".conflict-item").forEach(item => {
      item.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => resolveConflict(item.dataset.id, btn.dataset.choice));
      });
    });
  }
  async function resolveConflict(conflictId, choice) {
    try {
      const res = await fetch("/api/rooms/" + encodeURIComponent(roomId) + "/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conflictId, choice, member: identity })
      });
      const data = await res.json();
      if (!res.ok) {
        toast("裁决失败：" + (data.error || res.status) + "，已刷新", true);
        hello();
        return;
      }
      toast("冲突已解决");
      converge(data.text, data.rev, data.conflicts);
    } catch (e) {
      toast("网络错误：" + e.message, true);
    }
  }

  /* ---------- 远程光标（mirror 定位） ---------- */
  function clusterToXY(clusterIndex) {
    // 用隐藏 mirror 计算第 clusterIndex 个集群的像素坐标（与 textarea 同字体/内边距）
    const gs = C.graphemes(editor.value);
    const text = gs.slice(0, Math.min(clusterIndex, gs.length)).join("");
    let mirror = clusterToXY._m;
    if (!mirror) {
      mirror = document.createElement("div");
      const cs = getComputedStyle(editor);
      ["font", "fontFamily", "fontSize", "fontWeight", "lineHeight",
        "letterSpacing", "paddingLeft", "paddingTop", "paddingRight",
        "borderLeftWidth", "borderTopWidth", "whiteSpace", "wordWrap",
        "overflowWrap", "boxSizing", "width"].forEach(p => mirror.style[p] = cs[p]);
      mirror.style.position = "absolute";
      mirror.style.visibility = "hidden";
      mirror.style.top = "0";
      mirror.style.left = "0";
      mirror.style.whiteSpace = "pre-wrap";
      mirror.style.overflowWrap = "normal";
      const wrap = editor.parentElement;
      wrap.style.position = "relative";
      wrap.appendChild(mirror);
      clusterToXY._m = mirror;
    }
    mirror.style.width = editor.clientWidth + "px";
    mirror.textContent = text;
    const probe = document.createElement("span");
    probe.textContent = "​";
    mirror.appendChild(probe);
    const x = probe.offsetLeft;
    const y = probe.offsetTop;
    probe.remove();
    // 抵消 textarea 滚动
    return { x: x - editor.scrollLeft, y: y - editor.scrollTop };
  }
  function renderCursors() {
    cursorsLayer.innerHTML = "";
    for (const mm of members) {
      if (mm.memberId === identity.memberId) continue;
      const cur = remoteCursors[mm.memberId];
      if (!cur || !mm.online) continue;
      const pos = clusterToXY(cur.anchor || 0);
      const bar = document.createElement("div");
      bar.className = "remote-cursor";
      bar.style.left = pos.x + "px";
      bar.style.top = pos.y + "px";
      bar.style.background = mm.color;
      const label = document.createElement("span");
      label.className = "label";
      label.style.background = mm.color;
      label.textContent = mm.name;
      bar.appendChild(label);
      cursorsLayer.appendChild(bar);
      // 选区高亮
      const ss = Math.min(cur.selStart || cur.anchor || 0, cur.selEnd || cur.anchor || 0);
      const se = Math.max(cur.selStart || cur.anchor || 0, cur.selEnd || cur.anchor || 0);
      if (se > ss) {
        const p1 = clusterToXY(ss), p2 = clusterToXY(se);
        const sel = document.createElement("div");
        sel.className = "remote-selection";
        sel.style.background = mm.color;
        sel.style.left = p1.x + "px";
        sel.style.top = p1.y + "px";
        sel.style.width = Math.max(2, p2.x - p1.x) + "px";
        sel.style.height = (parseFloat(getComputedStyle(editor).lineHeight) || 24) + "px";
        cursorsLayer.appendChild(sel);
      }
    }
  }
  editor.addEventListener("scroll", renderCursors);
  window.addEventListener("resize", renderCursors);

  /* ---------- WebSocket ---------- */
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(proto + "://" + location.host + "/ws?room=" + encodeURIComponent(roomId));
    ws.onopen = () => hello();
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case "hello":
          connected = true;
          reconnectDelay = 300;
          setConn(true, "已连接");
          rev = m.rev; serverText = m.text || ""; conflicts = m.conflicts || [];
          members = m.members || [];
          const roomName = m.room && m.room.name;
          document.title = roomName ? (roomName + " · 协作房间") : document.title;
          $("room-name").textContent = roomName || "";
          // 重连：以快照重绘，未确认编辑重新排队（同 opId 幂等）。
          // inflight 是「已发送但 ack 未返回」的编辑：直接丢弃会把用户刚输入的
          // 文字从页面抹掉且不再提交。重新排回队首，converge 会以最新 rev 为
          // 基线重放它，pump 用原 opId 重发；若服务器其实已应用过该 op，
          // seenOps 命中返回 duplicate，只生效一次，不会重复插入。
          if (inflight) queue.unshift(inflight);
          inflight = null;
          converge(serverText, rev, conflicts);
          renderMembers();
          pump();
          sendCursorSoon();
          break;
        case "ack": handleAck(m); break;
        case "op":
          // 其他成员的提交 / 冲突裁决广播：以权威文本收敛
          converge(m.text, m.rev, m.conflicts);
          renderMembers();
          break;
        case "presence": members = m.members || []; renderMembers(); renderCursors(); break;
        case "cursor":
          remoteCursors[m.memberId] = m;
          if (m.memberId !== identity.memberId) renderCursors();
          break;
        case "pong": break;
        case "error":
          toast("服务器错误：" + (m.error || ""), true);
          break;
      }
    };
    ws.onclose = () => {
      connected = false;
      setConn(false, "连接断开，重连中…");
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  function hello() {
    send({ type: "hello", room: roomId, member: identity });
  }
  function setConn(ok, text) {
    connEl.className = "status " + (ok ? "online" : "offline");
    connEl.textContent = text;
  }
  let toastTimer = null;
  function toast(text, warn) {
    toastEl.textContent = text;
    toastEl.className = "toast show" + (warn ? " warn" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = "toast"; }, 2600);
  }

  /* ---------- 复制邀请链接 ---------- */
  $("copy-link").addEventListener("click", async () => {
    const url = location.origin + "/room.html?id=" + encodeURIComponent(roomId);
    try {
      await navigator.clipboard.writeText(url);
      toast("邀请链接已复制：" + url);
    } catch (e) {
      prompt("复制邀请链接", url);
    }
  });

  // 初始拉取房间名（WS 还没好时）
  fetch("/api/rooms/" + encodeURIComponent(roomId)).then(r => r.json()).then(snap => {
    if (snap && snap.name) {
      document.title = snap.name + " · 协作房间";
      $("room-name").textContent = snap.name;
    }
  }).catch(() => {});

  setConn(false, "连接中…");
  connect();
  setInterval(renderCursors, 1000);
})();
