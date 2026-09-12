/* decision-core.js
 * 审阅决策的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.DecisionCore），Node 下可直接 require 单测。
 *
 * 一个“决策草案”从未归档批次派生，为批次中每条批注指定处理方案：
 *   keep 保留 / replace 替换 / delete 删除（处理对象是被批注的原文）。
 * 不同审阅者逐条投票 approve 通过 / reject 驳回 / abstain 弃权，
 * 每条达到草案设定的通过人数且无驳回时，草案才进入 ready 待执行。
 *
 * ★ 版本校验（执行前同时核对文本、批注、批次三个版本）★
 *   - 文本版本：对创建草案时的段落数组（dir+text，不含 editedAt）计算指纹
 *     textContentRev；执行时客户端回传当前段落，指纹不同即文本已变，
 *     再用 SnapshotCore 的段落对齐把变化精确归到段落，只把受影响条目标冲突；
 *   - 批注版本：草案创建时记录集合 rev 与每条批注的 updatedAt，
 *     集合 rev 变化时逐条比对，只标真正变化/删除/被移出批次的条目；
 *   - 批次版本：记录批次 rev；rev 变化但成员归属、批注、段落文本都没变
 *     （例如只改了负责人）不影响任何条目。
 *
 * ★ 中阿混排：所有偏移都是 Unicode 码点逻辑位置（半开区间），
 *   替换/删除在码点数组上拼接，完全不读屏幕布局；渲染层须用 <bdi> 隔离。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./snapshot-core"));
  } else {
    root.DecisionCore = factory(root.SnapshotCore);
  }
})(typeof self !== "undefined" ? self : this, function (Snap) {
  "use strict";

  var LIMITS = {
    DECISION_NAME_MAX_CHARS: 100,
    REPLACEMENT_MAX_CHARS: 5000,   // 替换文本上限（码点）
    THRESHOLD_MIN: 1,
    THRESHOLD_MAX: 50,             // 通过人数上限
    DECISION_MAX_COUNT: 200,
    ITEM_VOTE_HISTORY_MAX: 200,    // 每条投票流水保留条数
    LOG_MAX: 5000
  };

  var DISPOSITIONS = ["keep", "replace", "delete"];
  var DISPOSITION_SET = { keep: true, replace: true, delete: true };
  var DISPOSITION_LABELS = { keep: "保留", replace: "替换", delete: "删除" };

  var VOTES = ["approve", "reject", "abstain"];
  var VOTE_SET = { approve: true, reject: true, abstain: true };
  var VOTE_LABELS = { approve: "通过", reject: "驳回", abstain: "弃权" };

  // drafting 拟定中 / voting 投票中 / ready 待执行 / executed 已执行
  // 批次归档后草案只读（frozen 由批次状态派生，不单独占状态）
  var DECISION_STATUSES = ["drafting", "voting", "ready", "executed"];
  var STATUS_LABELS = {
    drafting: "拟定中", voting: "投票中", ready: "待执行", executed: "已执行"
  };

  var RESULT_LABELS = { success: "成功", conflict: "冲突", skipped: "跳过" };
  var REASON_LABELS = {
    not_selected: "本次未选择执行",
    not_approved: "尚未通过投票",
    annotation_deleted: "批注已被删除",
    annotation_changed: "批注在草案创建后被修改",
    member_removed: "批注已被移出批次",
    paragraph_changed: "批注所在段落已修改",
    paragraph_deleted: "批注所在段落已被删除",
    paragraph_dir_changed: "段落方向已改变",
    quote_mismatch: "原文与批注引文不一致",
    changed_since_execution: "批注在执行后又被修改，未回滚"
  };

  function err(status, code, message) {
    return { ok: false, status: status, code: code, message: message };
  }

  function isInt(v) {
    return typeof v === "number" && isFinite(v) && Math.floor(v) === v;
  }

  function cpLen(s) { return s ? Array.from(s).length : 0; }

  function cpSlice(s, start, end) { return Array.from(s).slice(start, end).join(""); }

  function nowISO() { return new Date().toISOString(); }

  /* ---------- 文本版本指纹 ----------
   * 只取 dir + text（editedAt 不参与：时间戳变化不代表文字版本变化）。
   * 两个独立 32 位哈希拼接，把碰撞概率压到可忽略；变化检测不依赖密码学性质。
   */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function textContentRev(paragraphs) {
    var canon = JSON.stringify((paragraphs || []).map(function (p) {
      return { dir: p && p.dir ? p.dir : "auto", text: p && typeof p.text === "string" ? p.text : "" };
    }));
    return fnv1a(canon) + djb2(canon);
  }

  /* ---------- 字段校验 ---------- */

  function validateName(v, batchName) {
    if (v == null || v === "") {
      return { ok: true, value: "“" + batchName + "”决策草案" };
    }
    if (typeof v !== "string") return err(400, "invalid_name", "草案名称必须是文本");
    var name = v.trim();
    if (!name) return { ok: true, value: "“" + batchName + "”决策草案" };
    if (cpLen(name) > LIMITS.DECISION_NAME_MAX_CHARS) {
      return err(400, "name_too_long",
        "草案名称不能超过 " + LIMITS.DECISION_NAME_MAX_CHARS + " 个字符");
    }
    return { ok: true, value: name };
  }

  function validateThreshold(v) {
    if (v == null || v === "") return { ok: true, value: 1 };
    if (!isInt(v)) return err(400, "invalid_threshold", "通过人数必须是整数");
    if (v < LIMITS.THRESHOLD_MIN || v > LIMITS.THRESHOLD_MAX) {
      return err(400, "invalid_threshold",
        "通过人数必须在 " + LIMITS.THRESHOLD_MIN + " 到 " + LIMITS.THRESHOLD_MAX + " 之间");
    }
    return { ok: true, value: v };
  }

  // null/缺省/""/"pending" 都视为“未定方案”，供拟定阶段逐条填写
  function normalizeDisposition(v) {
    if (v == null || v === "" || v === "pending") return { ok: true, value: null };
    if (typeof v !== "string" || !DISPOSITION_SET[v]) {
      return err(400, "invalid_disposition",
        "处理方案必须是 keep（保留）、replace（替换）或 delete（删除）");
    }
    return { ok: true, value: v };
  }

  function validateReplacement(disposition, replacement) {
    if (disposition !== "replace") return { ok: true, value: null };
    if (typeof replacement !== "string") {
      return err(400, "invalid_replacement", "替换方案必须提供替换文本");
    }
    var value = replacement; // 替换文本允许内部空白（中阿文排版可能有意保留）
    if (!value || !value.trim()) {
      return err(400, "empty_replacement", "替换文本不能为空（删除请改用“删除”方案）");
    }
    if (cpLen(value) > LIMITS.REPLACEMENT_MAX_CHARS) {
      return err(413, "replacement_too_long",
        "替换文本不能超过 " + LIMITS.REPLACEMENT_MAX_CHARS + " 个字符");
    }
    return { ok: true, value: value };
  }

  function validateVoter(v) {
    // 与批注署名不同：投票必须记名，缺少投票人直接拒绝
    if (typeof v !== "string" || !v.trim()) {
      return err(400, "missing_voter", "投票必须署名：请先填写审阅者名称");
    }
    var name = v.trim();
    if (cpLen(name) > 50) return err(400, "voter_too_long", "审阅者名称不能超过 50 个字符");
    return { ok: true, value: name };
  }

  function validateVote(v) {
    if (typeof v !== "string" || !VOTE_SET[v]) {
      return err(400, "invalid_vote", "投票必须是 approve（通过）、reject（驳回）或 abstain（弃权）");
    }
    return { ok: true, value: v };
  }

  // 创建载荷：
  // {batchId, name?, threshold?, items?: [{annotationId, disposition, replacement?}], actor}
  // members: 批次当前成员批注（按 memberIds 顺序），至少 1 条。
  // 返回 value：{name, threshold, items:[{annotationId, disposition, replacement}]}
  function validateCreatePayload(payload, members) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return err(400, "invalid_body", "请求内容必须是决策草案对象");
    }
    if (!Array.isArray(members) || !members.length) {
      return err(400, "empty_draft", "批次中没有批注，不能创建决策草案");
    }
    var threshold = validateThreshold(payload.threshold);
    if (!threshold.ok) return threshold;

    var byId = Object.create(null);
    var given = [];
    if (payload.items != null) {
      if (!Array.isArray(payload.items)) {
        return err(400, "invalid_items", "处理方案必须是数组");
      }
      var seen = Object.create(null);
      for (var i = 0; i < payload.items.length; i++) {
        var it = payload.items[i];
        if (!it || typeof it !== "object" || typeof it.annotationId !== "string") {
          return err(400, "invalid_item", "第 " + (i + 1) + " 条方案结构错误");
        }
        if (seen[it.annotationId]) {
          return err(409, "duplicate_item",
            "同一条批注的处理方案出现了多次，请合并为一条后再提交（当前页面内容已保留）");
        }
        seen[it.annotationId] = true;
        var disp = normalizeDisposition(it.disposition);
        if (!disp.ok) return err(disp.status, disp.code, "第 " + (i + 1) + " 条方案：" + disp.message);
        var repl = validateReplacement(disp.value, it.replacement);
        if (!repl.ok) return err(repl.status, repl.code, "第 " + (i + 1) + " 条方案：" + repl.message);
        given.push({ annotationId: it.annotationId, disposition: disp.value, replacement: repl.value });
      }
    }
    members.forEach(function (m) { byId[m.id] = m; });
    // 方案只允许针对批次成员；给了不属于成员的 id 也是一种“重复/错位”，明确拒绝
    var foreign = given.filter(function (g) { return !byId[g.annotationId]; });
    if (foreign.length) {
      return err(409, "not_batch_member",
        "有 " + foreign.length + " 条方案对应的批注不在该批次中，请刷新后重试（当前页面内容已保留）");
    }

    // 以成员顺序展开；未给方案的条目留空（拟定阶段逐条填）
    var givenById = Object.create(null);
    given.forEach(function (g) { givenById[g.annotationId] = g; });
    var items = members.map(function (m) {
      var g = givenById[m.id];
      return g ? { annotationId: m.id, disposition: g.disposition, replacement: g.replacement }
               : { annotationId: m.id, disposition: null, replacement: null };
    });
    return { ok: true, value: { threshold: threshold.value, items: items } };
  }

  // 方案更新载荷：{items:[...]}，只允许改动草案已有条目；重复 id 整批拒绝。
  function validateItemsUpdate(payload, decision) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return err(400, "invalid_body", "请求内容必须是方案对象");
    }
    if (!Array.isArray(payload.items)) {
      return err(400, "invalid_items", "处理方案必须是数组");
    }
    if (!payload.items.length) {
      return err(400, "empty_draft", "方案为空：请至少填写一条批注的处理方案（当前页面内容已保留）");
    }
    var have = Object.create(null);
    decision.items.forEach(function (it) { have[it.annotationId] = it; });
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < payload.items.length; i++) {
      var x = payload.items[i];
      if (!x || typeof x !== "object" || typeof x.annotationId !== "string") {
        return err(400, "invalid_item", "第 " + (i + 1) + " 条方案结构错误");
      }
      if (seen[x.annotationId]) {
        return err(409, "duplicate_item",
          "同一条批注提交了两个方案，请只保留一个（当前页面内容已保留）");
      }
      seen[x.annotationId] = true;
      if (!have[x.annotationId]) {
        return err(409, "not_batch_member",
          "批注 " + x.annotationId + " 不在该草案中（草案创建后新加入批次的批注需另建草案）");
      }
      var disp = normalizeDisposition(x.disposition);
      if (!disp.ok) return err(disp.status, disp.code, "第 " + (i + 1) + " 条方案：" + disp.message);
      var repl = validateReplacement(disp.value, x.replacement);
      if (!repl.ok) return err(repl.status, repl.code, "第 " + (i + 1) + " 条方案：" + repl.message);
      // 非替换方案强制清空 replacement，避免残留旧文本被误执行
      if (disp.value !== "replace") repl.value = null;
      out.push({ annotationId: x.annotationId, disposition: disp.value, replacement: repl.value });
    }
    return { ok: true, value: { items: out } };
  }

  // 投票载荷：{annotationId, vote, voter}
  function validateVotePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return err(400, "invalid_body", "请求内容必须是投票对象");
    }
    if (typeof payload.annotationId !== "string" || !payload.annotationId) {
      return err(400, "invalid_annotation_id", "投票必须指定一条批注");
    }
    var vote = validateVote(payload.vote);
    if (!vote.ok) return vote;
    var voter = validateVoter(payload.voter);
    if (!voter.ok) return voter;
    return { ok: true, value: { annotationId: payload.annotationId,
                                vote: vote.value, voter: voter.value } };
  }

  /* ---------- 投票统计与逐条状态 ---------- */

  // votes: [{voter, vote, at}]，同一投票人以最后一次为准
  function tallyVotes(votes) {
    var latest = Object.create(null);
    (votes || []).forEach(function (v) { latest[v.voter] = v.vote; });
    var counts = { approve: 0, reject: 0, abstain: 0 };
    Object.keys(latest).forEach(function (voter) { counts[latest[voter]]++; });
    return {
      counts: counts,
      voters: Object.keys(latest).length,
      byVoter: latest
    };
  }

  // 单条状态：
  //   pending 方案未定 / waiting 方案已定未达标 / rejected 有驳回 / approved 通过
  function itemState(item, threshold) {
    if (!item || !item.disposition) return "pending";
    var t = tallyVotes(item.votes);
    if (t.counts.reject > 0) return "rejected";
    if (t.counts.approve >= threshold) return "approved";
    return "waiting";
  }

  var ITEM_STATE_LABELS = {
    pending: "方案未定", waiting: "待投票", rejected: "已驳回", approved: "已通过"
  };

  function decisionProgress(decision) {
    var threshold = decision.threshold || 1;
    var counts = { pending: 0, waiting: 0, rejected: 0, approved: 0 };
    decision.items.forEach(function (it) { counts[itemState(it, threshold)]++; });
    var total = decision.items.length;
    return {
      total: total,
      counts: counts,
      approved: counts.approved,
      ready: total > 0 && counts.approved === total
    };
  }

  // 投票后重算草案状态：全部条目通过才进入 ready；有驳回或缺票则留在 voting
  function recomputeStatus(decision) {
    if (decision.status === "drafting") return decision.status;
    if (decision.status === "executed") return decision.status;
    var p = decisionProgress(decision);
    return p.ready ? "ready" : "voting";
  }

  // 同一投票人改票：votes 中替换、voteHistory 追加（截断上限）
  function applyVote(item, voter, vote, at) {
    var next = (item.votes || []).filter(function (v) { return v.voter !== voter; });
    next.push({ voter: voter, vote: vote, at: at });
    var history = (item.voteHistory || []).slice();
    history.push({ voter: voter, vote: vote, at: at });
    if (history.length > LIMITS.ITEM_VOTE_HISTORY_MAX) {
      history.splice(0, history.length - LIMITS.ITEM_VOTE_HISTORY_MAX);
    }
    return { votes: next, voteHistory: history };
  }

  // 修改方案：方案内容变化则该条既有投票全部作废（改票流水保留），
  // 驳回后改方案即按新方案重新计票。
  function reviseItem(item, patch, at) {
    var changed = item.disposition !== patch.disposition ||
      (item.replacement || null) !== (patch.replacement || null);
    if (!changed) return { changed: false };
    return {
      changed: true,
      disposition: patch.disposition,
      replacement: patch.replacement,
      votes: [],
      voteClearedAt: at,
      updatedAt: at
    };
  }

  function isOverdue(deadline, nowMs) {
    if (!deadline) return false;
    var t = Date.parse(deadline);
    if (isNaN(t)) return false;
    return t <= (nowMs == null ? Date.now() : nowMs);
  }

  /* ---------- 段落对齐与逐条版本校验 ---------- */

  // 基线段落（草案创建时）→ 当前段落的映射：
  // 返回 {map: baselineIndex -> currentIndex|null, dirChanged:Set, deleted:Set}
  // 文本完全相同才建立映射（沿用快照对齐口径）；被修改/删除的段落没有映射。
  function mapParagraphs(baselineParas, currentParas) {
    var map = new Array(baselineParas.length).fill(null);
    var deleted = {};
    var changed = {};
    var changedTo = {};
    var dirChanged = {};
    if (!Snap || !Array.isArray(currentParas)) {
      baselineParas.forEach(function (_, i) { deleted[i] = true; });
      return { map: map, deleted: deleted, changed: changed,
               changedTo: changedTo, dirChanged: dirChanged };
    }
    var ops = Snap.alignParagraphs(baselineParas, currentParas);
    // 连续 del/ins 段：1 del + 1 ins 配对为“修改”（与 diffSnapshots 口径一致），
    // 其余 del 才是整段删除；被修改的段落记下对应的新段落号，
    // 条目仍可在新段落内做引文核对（引文还在原位则不算文本冲突）。
    var k = 0;
    while (k < ops.length) {
      if (ops[k].op === "equal") {
        var a = ops[k].a, b = ops[k].b;
        map[a] = b;
        var bd = baselineParas[a].dir || "auto";
        var cd = currentParas[b].dir || "auto";
        if (bd !== cd) dirChanged[a] = true;
        k++;
        continue;
      }
      var dels = [], inss = [];
      while (k < ops.length && ops[k].op !== "equal") {
        if (ops[k].op === "del") dels.push(ops[k++].a);
        else inss.push(ops[k++].b);
      }
      if (dels.length === 1 && inss.length === 1) {
        changed[dels[0]] = true;
        changedTo[dels[0]] = inss[0];
      } else {
        dels.forEach(function (i) { deleted[i] = true; });
      }
    }
    return { map: map, deleted: deleted, changed: changed,
             changedTo: changedTo, dirChanged: dirChanged };
  }

  // 评估单条能否在当前文本上执行。
  // 返回 null 表示可执行；否则 {reason, currentParaIndex?}
  function evaluateItem(item, ctx) {
    var ann = ctx.annotationMap[item.annotationId];
    if (!ann) return { reason: "annotation_deleted" };
    if (ctx.memberIds.indexOf(item.annotationId) === -1) {
      return { reason: "member_removed" };
    }
    // 批注版本：updatedAt 是批注记录的每次变化时间（含状态、回复不更新? 回复会更新）
    if (item.annotationUpdatedAt && ann.updatedAt !== item.annotationUpdatedAt) {
      return { reason: "annotation_changed" };
    }
    // 方向变化是版本变化：无论文本是否还在原位，受影响条目都标冲突
    if (ctx.mapping.dirChanged[item.paraIndex]) {
      return {
        reason: "paragraph_dir_changed",
        currentParaIndex: ctx.mapping.map[item.paraIndex] != null
          ? ctx.mapping.map[item.paraIndex] : ctx.mapping.changedTo[item.paraIndex]
      };
    }
    var curIdx = ctx.mapping.map[item.paraIndex];
    if (curIdx == null && ctx.mapping.changed[item.paraIndex]) {
      // 段落被改写：落到配对的新段落继续做引文核对
      curIdx = ctx.mapping.changedTo[item.paraIndex];
    }
    if (curIdx == null) {
      if (ctx.mapping.deleted[item.paraIndex]) {
        return { reason: "paragraph_deleted" };
      }
      return { reason: "paragraph_changed" };
    }
    var para = ctx.currentParagraphs[curIdx];
    if (cpSlice(para.text, item.start, item.end) !== item.quote) {
      return { reason: "quote_mismatch", currentParaIndex: curIdx };
    }
    return null;
  }

  /* ---------- 执行计划（不改任何数据） ---------- */

  // selectedIds：本次要执行的条目；缺省为全部。
  // 输出每个条目的 result：success / conflict / skipped（含原因）。
  function planExecution(decision, currentParagraphs, annotationMap, memberIds, selectedIds) {
    var mapping = mapParagraphs(decision.baselineParagraphs, currentParagraphs);
    var baselineTextRev = decision.textRev;
    var currentTextRev = textContentRev(currentParagraphs);
    var selected = Object.create(null);
    (selectedIds || decision.items.map(function (it) { return it.annotationId; }))
      .forEach(function (id) { selected[id] = true; });

    var ctx = {
      annotationMap: annotationMap,
      memberIds: memberIds,
      mapping: mapping,
      currentParagraphs: currentParagraphs
    };
    var results = decision.items.map(function (it) {
      var row = {
        annotationId: it.annotationId,
        paraIndex: it.paraIndex,
        start: it.start,
        end: it.end,
        quote: it.quote,
        disposition: it.disposition,
        replacement: it.replacement,
        currentParaIndex: undefined,
        result: null,
        reason: null
      };
      var state = itemState(it, decision.threshold || 1);
      if (!selected[it.annotationId]) {
        row.result = "skipped"; row.reason = "not_selected";
        return row;
      }
      if (state !== "approved") {
        row.result = "skipped"; row.reason = "not_approved";
        return row;
      }
      var problem = evaluateItem(it, ctx);
      if (problem) {
        row.result = "conflict";
        row.reason = problem.reason;
        row.currentParaIndex = problem.currentParaIndex;
        return row;
      }
      var mapped = mapping.map[it.paraIndex];
      row.currentParaIndex = mapped != null ? mapped : mapping.changedTo[it.paraIndex];
      row.result = "success";
      return row;
    });

    var counts = { success: 0, conflict: 0, skipped: 0 };
    results.forEach(function (r) { counts[r.result]++; });
    return {
      baselineTextRev: baselineTextRev,
      currentTextRev: currentTextRev,
      textChanged: baselineTextRev !== currentTextRev,
      results: results,
      counts: counts
    };
  }

  // 在码点数组上应用区间替换/删除；同一文本只用于单段。
  function applyRange(text, start, end, replacement) {
    var cps = Array.from(text);
    var ins = replacement ? Array.from(replacement) : [];
    return cps.slice(0, start).concat(ins, cps.slice(end)).join("");
  }

  // 按计划中的成功条目产出执行后段落（多条目同段时按码点位置从后向前应用，
  // 前面的偏移不会被后面的改动影响）。currentParagraphs 不被修改。
  function applyPlan(currentParagraphs, results) {
    var next = currentParagraphs.map(function (p) {
      return { dir: p.dir || "auto", text: p.text, editedAt: p.editedAt || null };
    });
    var byPara = Object.create(null);
    results.forEach(function (r) {
      if (r.result !== "success" || r.disposition === "keep") return;
      var key = String(r.currentParaIndex);
      (byPara[key] = byPara[key] || []).push(r);
    });
    Object.keys(byPara).forEach(function (key) {
      var idx = Number(key);
      if (!next[idx]) return;
      var rows = byPara[key].slice().sort(function (a, b) { return b.start - a.start; });
      var text = next[idx].text;
      rows.forEach(function (r) {
        text = applyRange(text, r.start, r.end,
          r.disposition === "replace" ? r.replacement : "");
      });
      next[idx].text = text;
    });
    return next;
  }

  /* ---------- 执行前预览（按段落） ---------- */

  // 返回按段落组织的预览：段状态、每段的当前文本/执行后文本、每条的判定。
  function buildPreview(decision, currentParagraphs, annotationMap, memberIds, selectedIds) {
    var plan = planExecution(decision, currentParagraphs, annotationMap, memberIds, selectedIds);
    var mapping = plan.results.reduce(function (m, r) {
      if (r.currentParaIndex != null) m[r.annotationId] = r.currentParaIndex;
      return m;
    }, Object.create(null));

    // 只展示含草案条目的段落；同段条目聚到一起
    var rowByPara = Object.create(null);
    var paraOrder = [];
    decision.items.forEach(function (it) {
      var key = String(it.paraIndex);
      if (!rowByPara[key]) {
        rowByPara[key] = {
          paraIndex: it.paraIndex,
          currentParaIndex: mapping[it.annotationId] == null ? null : mapping[it.annotationId],
          baseline: decision.baselineParagraphs[it.paraIndex] || null,
          current: null,
          dirChanged: false,
          deleted: false,
          items: []
        };
        paraOrder.push(it.paraIndex);
      }
    });
    var mp = mapParagraphs(decision.baselineParagraphs, currentParagraphs);
    paraOrder.forEach(function (pi) {
      var row = rowByPara[String(pi)];
      var ci = mp.map[pi];
      if (ci == null && mp.changed[pi]) ci = mp.changedTo[pi];
      row.currentParaIndex = ci == null ? null : ci;
      row.dirChanged = !!mp.dirChanged[pi];
      row.deleted = !!mp.deleted[pi];
      row.paraChanged = !!mp.changed[pi];
      row.current = ci == null ? null : currentParagraphs[ci];
    });

    var resultById = Object.create(null);
    plan.results.forEach(function (r) { resultById[r.annotationId] = r; });

    decision.items.forEach(function (it) {
      var row = rowByPara[String(it.paraIndex)];
      var r = resultById[it.annotationId];
      var state = itemState(it, decision.threshold || 1);
      row.items.push({
        annotationId: it.annotationId,
        quote: it.quote,
        start: it.start,
        end: it.end,
        paraDir: it.paraDir,
        annotation: annotationMap[it.annotationId] || null,
        disposition: it.disposition,
        replacement: it.replacement,
        voteState: state,
        tally: tallyVotes(it.votes),
        votes: it.votes || [],
        result: r.result,
        reason: r.reason,
        selected: r.reason !== "not_selected",
        beforeText: it.quote,
        afterText: it.disposition === "replace" ? it.replacement
                  : it.disposition === "delete" ? "（删除该段文字）"
                  : it.disposition === "keep" ? it.quote : "（方案未定）"
      });
    });

    // 每段“执行后”整段文本：仅由该段成功条目合成
    paraOrder.forEach(function (pi) {
      var row = rowByPara[String(pi)];
      if (row.current == null) { row.afterText = null; return; }
      var succ = plan.results.filter(function (r) {
        return r.result === "success" && r.currentParaIndex === row.currentParaIndex;
      });
      row.afterText = succ.length
        ? applyPlan(currentParagraphs, succ)[row.currentParaIndex].text
        : row.current.text;
    });

    return {
      baselineTextRev: plan.baselineTextRev,
      currentTextRev: plan.currentTextRev,
      textChanged: plan.textChanged,
      rows: paraOrder.map(function (pi) { return rowByPara[String(pi)]; }),
      results: plan.results,
      counts: plan.counts
    };
  }

  /* ---------- 快照嵌入 ---------- */

  function itemDigest(it) {
    return {
      annotationId: it.annotationId,
      paraIndex: it.paraIndex,
      start: it.start,
      end: it.end,
      quote: it.quote,
      paraDir: it.paraDir,
      disposition: it.disposition,
      replacement: it.replacement,
      annotationUpdatedAt: it.annotationUpdatedAt || null,
      updatedAt: it.updatedAt || null,
      voteClearedAt: it.voteClearedAt || null,
      votes: (it.votes || []).map(function (v) {
        return { voter: v.voter, vote: v.vote, at: v.at };
      })
    };
  }

  function executionDigest(ex) {
    return {
      id: ex.id,
      at: ex.at,
      actor: ex.actor,
      applied: ex.applied,
      undone: !!ex.undone,
      undoneAt: ex.undoneAt || null,
      textRevBefore: ex.textRevBefore,
      textRevAfter: ex.textRevAfter || null,
      annotationRevBefore: ex.annotationRevBefore,
      batchRevBefore: ex.batchRevBefore,
      counts: ex.counts,
      results: (ex.results || []).map(function (r) {
        return {
          annotationId: r.annotationId, disposition: r.disposition,
          result: r.result, reason: r.reason, paraIndex: r.paraIndex, at: r.at
        };
      }),
      undo: ex.undo ? {
        at: ex.undo.at, actor: ex.undo.actor,
        results: (ex.undo.results || []).map(function (r) {
          return { annotationId: r.annotationId, reverted: r.reverted, reason: r.reason || null };
        })
      } : null
    };
  }

  // 保存快照时把全部决策草案（含投票与执行结果）拷贝进去；
  // 查看历史快照即可看到当时各草案的状态、投票与执行记录。
  function decisionDigest(decisions) {
    return (decisions || []).map(function (d) {
      return {
        id: d.id,
        batchId: d.batchId,
        batchName: d.batchName,
        name: d.name,
        status: d.status,
        threshold: d.threshold,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        submittedAt: d.submittedAt || null,
        readyAt: d.readyAt || null,
        deadline: d.deadline || null,
        textRev: d.textRev,
        annotationRev: d.annotationRev,
        batchRev: d.batchRev,
        items: (d.items || []).map(itemDigest),
        executions: (d.executions || []).map(executionDigest),
        lastExecutionId: d.lastExecutionId || null
      };
    });
  }

  return {
    LIMITS: LIMITS,
    DISPOSITIONS: DISPOSITIONS,
    DISPOSITION_LABELS: DISPOSITION_LABELS,
    VOTES: VOTES,
    VOTE_LABELS: VOTE_LABELS,
    DECISION_STATUSES: DECISION_STATUSES,
    STATUS_LABELS: STATUS_LABELS,
    ITEM_STATE_LABELS: ITEM_STATE_LABELS,
    RESULT_LABELS: RESULT_LABELS,
    REASON_LABELS: REASON_LABELS,
    // 校验
    validateName: validateName,
    validateThreshold: validateThreshold,
    normalizeDisposition: normalizeDisposition,
    validateReplacement: validateReplacement,
    validateVoter: validateVoter,
    validateVote: validateVote,
    validateCreatePayload: validateCreatePayload,
    validateItemsUpdate: validateItemsUpdate,
    validateVotePayload: validateVotePayload,
    // 版本与投票
    textContentRev: textContentRev,
    cpLen: cpLen,
    cpSlice: cpSlice,
    applyRange: applyRange,
    tallyVotes: tallyVotes,
    itemState: itemState,
    decisionProgress: decisionProgress,
    recomputeStatus: recomputeStatus,
    applyVote: applyVote,
    reviseItem: reviseItem,
    isOverdue: isOverdue,
    // 执行与预览
    mapParagraphs: mapParagraphs,
    evaluateItem: evaluateItem,
    planExecution: planExecution,
    applyPlan: applyPlan,
    buildPreview: buildPreview,
    // 快照
    decisionDigest: decisionDigest
  };
});
