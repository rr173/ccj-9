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
    TASK_MAX_COUNT: 500,
    TASK_ATTEMPT_MAX: 50,
    TASK_APPROVER_MIN: 1,
    TASK_APPROVER_MAX: 3,           // 一到三名审批人
    APPROVER_NAME_MAX_CHARS: 50,
    TASK_DEPENDENCY_MAX: 50,
    ITEM_VOTE_HISTORY_MAX: 200,    // 每条投票流水保留条数
    LOG_MAX: 5000
  };

  var DISPOSITIONS = ["keep", "replace", "delete"];
  var DISPOSITION_SET = { keep: true, replace: true, delete: true };
  var DISPOSITION_LABELS = { keep: "保留", replace: "替换", delete: "删除" };

  var VOTES = ["approve", "reject", "abstain"];
  var VOTE_SET = { approve: true, reject: true, abstain: true };
  var VOTE_LABELS = { approve: "通过", reject: "驳回", abstain: "弃权" };

  // drafting 拟定中 / voting 投票中 / ready 待执行 / scheduled 已发布定时执行中 /
  // executed 已执行（有成功条目固化）
  // 批次归档后草案只读（frozen 由批次状态派生，不单独占状态）
  var DECISION_STATUSES = ["drafting", "voting", "ready", "scheduled", "executed"];
  var STATUS_LABELS = {
    drafting: "拟定中", voting: "投票中", ready: "待执行",
    scheduled: "已排期", executed: "已执行"
  };

  /* 执行队列任务状态：
   *   scheduled 已排期等待生效（可暂停/恢复/取消）
   *   paused    已暂停（计时停止，恢复后重排）
   *   running   服务端正在执行（仅内存守卫，不写盘）
   *   succeeded 全部条目成功（终态）
   *   partial   部分成功（终态；冲突/跳过条目可“失败重试”）
   *   failed    本次没有成功条目（终态；草案退回待执行，可重试）
   *   blocked   到期但批次归档/草案过期等整体不能执行（终态；需先排除原因）
   *   cancelled 已取消（终态；草案退回待执行）
   *
   * 依赖与审批不改变任务自身状态：未开始的任务仍是 scheduled/paused，
   * 其“能否在计划时间进入执行”由独立的前置门控 gate 表示（见 GATE_STATES）。
   */
  var TASK_STATUSES = ["scheduled", "paused", "running",
                      "succeeded", "partial", "failed", "blocked", "cancelled"];
  var TASK_TERMINAL = {
    succeeded: true, partial: true, failed: true, blocked: true, cancelled: true
  };
  var TASK_STATUS_LABELS = {
    scheduled: "等待生效", paused: "已暂停", running: "执行中",
    succeeded: "全部成功", partial: "部分成功", failed: "执行失败",
    blocked: "已阻断", cancelled: "已取消"
  };

  /* 前置门控（gate）：scheduled/paused 任务在计划时间到来时还要再过两道关。
   *   ready         前置全部满足，到点允许执行
   *   waiting       等待中：前置任务尚未结束，或前置失败等待重试后重新评估
   *   can_continue  前置任务“部分成功”：负责人确认后即可继续（需显式确认）
   *   blocked       被阻断：前置取消/终态阻断，或前置链上传递了阻断/等待
   *   approvals     等待执行前审批（依赖已满足，但审批未达门槛）
   *   rejected      审批被拒绝
   */
  var GATE_STATES = ["ready", "waiting", "can_continue", "blocked",
                     "approvals", "rejected"];
  var GATE_STATE_LABELS = {
    ready: "前置已满足",
    waiting: "等待前置任务",
    can_continue: "前置部分成功，待确认继续",
    blocked: "前置未通过，已阻断",
    approvals: "等待执行前审批",
    rejected: "审批已拒绝"
  };
  // 前置任务终态 → 直接后续任务的依赖门控（不传递时的单跳规则）
  var DEPENDENCY_TERMINAL_GATE = {
    succeeded: "ready",
    partial: "can_continue",
    failed: "waiting",
    blocked: "blocked",
    cancelled: "blocked"
  };

  var APPROVAL_LABELS = { approve: "通过", reject: "拒绝" };

  var RESULT_LABELS = { success: "成功", conflict: "冲突", skipped: "跳过" };
  var REASON_LABELS = {
    not_selected: "本次未选择执行",
    not_approved: "尚未通过投票",
    already_done: "之前的尝试已成功，幂等跳过",
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

  // 投票后重算草案状态：全部条目通过才进入 ready；有驳回或缺票则留在 voting。
  // scheduled/executed 不由投票重算改变（排期后投票入口已关闭）。
  function recomputeStatus(decision) {
    if (decision.status === "drafting") return decision.status;
    if (decision.status === "executed") return decision.status;
    if (decision.status === "scheduled") return decision.status;
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

  /* ---------- 执行队列（发布定时执行） ---------- */

  // 生效时间必须是合法且严格晚于当前的时间；缺时间/过去时间都明确拒绝。
  function validateScheduledAt(v, nowMs) {
    if (v == null || v === "") {
      return err(400, "missing_scheduled_at",
        "发布到执行队列必须指定未来的生效时间（当前表单内容已保留）");
    }
    var t = Date.parse(v);
    if (isNaN(t)) {
      return err(400, "invalid_scheduled_at", "生效时间格式无法识别，请使用合法的日期时间");
    }
    var base = nowMs == null ? Date.now() : nowMs;
    if (t <= base) {
      return err(409, "scheduled_at_in_past",
        "生效时间必须晚于当前时间，请选择一个未来的时间（当前表单内容已保留）");
    }
    return { ok: true, value: new Date(t).toISOString(), ms: t };
  }

  // 恢复/重试时给出的新生效时间：给了就必须是未来；不给表示“立即/下次轮询执行”。
  function validateRescheduleAt(v, nowMs) {
    if (v == null || v === "") return { ok: true, value: null };
    return validateScheduledAt(v, nowMs);
  }

  function taskIsTerminal(task) {
    return !!(task && TASK_TERMINAL[task.status]);
  }
  function taskIsActive(task) {
    return !!task && (task.status === "scheduled" || task.status === "paused" ||
                      task.status === "running");
  }

  /* ---------- 任务依赖配置 ---------- */

  function validateApproverName(v) {
    if (typeof v !== "string" || !v.trim()) {
      return err(400, "missing_approver", "审批人必须署名（不能为空）");
    }
    var name = v.trim();
    if (cpLen(name) > LIMITS.APPROVER_NAME_MAX_CHARS) {
      return err(400, "approver_too_long",
        "审批人名称不能超过 " + LIMITS.APPROVER_NAME_MAX_CHARS + " 个字符");
    }
    return { ok: true, value: name };
  }

  // 审批配置：null/缺省 = 不要求执行前审批；
  // 否则 approvers 1~3 人且互不重复，minApprovals 在 1..审批人数之间。
  // 返回 value：null 或 {approvers:[name...], minApprovals:n}
  function validateApprovalConfig(payload) {
    if (payload == null) return { ok: true, value: null };
    var ap = payload;
    if (ap && ap.approval !== undefined) ap = ap.approval;
    if (ap == null) return { ok: true, value: null };
    if (typeof ap !== "object" || Array.isArray(ap)) {
      return err(400, "invalid_approval", "审批配置必须是对象");
    }
    var raw = ap.approvers;
    if (raw == null || raw === "") return { ok: true, value: null };
    if (!Array.isArray(raw)) {
      return err(400, "invalid_approvers", "审批人必须是数组");
    }
    if (raw.length === 0) return { ok: true, value: null };
    if (raw.length < LIMITS.TASK_APPROVER_MIN ||
        raw.length > LIMITS.TASK_APPROVER_MAX) {
      return err(400, "invalid_approvers",
        "审批人必须为 " + LIMITS.TASK_APPROVER_MIN + " 到 " +
        LIMITS.TASK_APPROVER_MAX + " 名");
    }
    var names = [];
    var seen = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var chk = validateApproverName(raw[i]);
      if (!chk.ok) return chk;
      if (seen[chk.value]) {
        return err(409, "duplicate_approver",
          "审批人“" + chk.value + "”重复：同一名审批人只能出现一次");
      }
      seen[chk.value] = true;
      names.push(chk.value);
    }
    var min = ap.minApprovals;
    if (min == null || min === "") min = names.length;
    if (!isInt(min) || min < 1 || min > names.length) {
      return err(400, "invalid_min_approvals",
        "最少通过人数必须是 1 到审批人数（" + names.length + "）之间的整数");
    }
    return { ok: true, value: { approvers: names, minApprovals: min } };
  }

  // 依赖配置：缺省/null/[] = 无前置；否则每一项必须是字符串任务 id。
  // 去重保序后返回；数量上限在此校验，自依赖/循环/不存在由
  // validateTaskDependencies 在完整任务图上统一校验。
  function normalizeDependencyIds(raw) {
    if (raw == null || raw === "") return { ok: true, value: [] };
    if (raw && !Array.isArray(raw.dependencyIds) && raw.dependencies !== undefined) {
      raw = raw.dependencies;
    }
    if (!Array.isArray(raw)) {
      return err(400, "invalid_dependencies", "前置任务必须是数组");
    }
    var ids = [];
    var seen = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var v = raw[i];
      if (typeof v !== "string" || !v.trim()) {
        return err(400, "invalid_dependency", "第 " + (i + 1) + " 个前置任务 id 无效");
      }
      v = v.trim();
      if (seen[v]) continue; // 同一前置重复列出按一次计
      seen[v] = true;
      ids.push(v);
    }
    if (ids.length > LIMITS.TASK_DEPENDENCY_MAX) {
      return err(413, "too_many_dependencies",
        "前置任务不能超过 " + LIMITS.TASK_DEPENDENCY_MAX + " 个");
    }
    return { ok: true, value: ids };
  }

  // 在完整任务图上校验依赖：拒绝自依赖、不存在的任务与（含本任务新边的）循环。
  //   taskId        被配置的任务（发布时可能尚不存在，传 null）
  //   dependencyIds normalize 后的候选依赖
  //   tasks         当前全部任务
  function validateTaskDependencies(taskId, dependencyIds, tasks) {
    var byId = Object.create(null);
    (tasks || []).forEach(function (t) { byId[t.id] = t; });
    var deps = (dependencyIds || []).slice();

    for (var i = 0; i < deps.length; i++) {
      if (taskId && deps[i] === taskId) {
        return err(409, "self_dependency", "不能把任务自身设为前置任务");
      }
      if (!byId[deps[i]]) {
        return err(404, "dependency_not_found",
          "前置任务 " + deps[i].slice(0, 8) + " 不存在，可能已被清理，请刷新后重试");
      }
    }
    // 循环检测：以每个候选前置为起点沿既有 dependencyIds 边游走，
    // 若能回到本任务则新边闭合出环（同时也覆盖既有图中的环）。
    var edges = Object.create(null);
    Object.keys(byId).forEach(function (id) {
      edges[id] = Array.isArray(byId[id].dependencyIds)
        ? byId[id].dependencyIds.filter(function (x) { return !!byId[x]; }) : [];
    });
    if (taskId) {
      // 用候选依赖替换本任务出边后再检测（配置可能是在删/改既有依赖）
      edges[taskId] = deps.filter(function (x) { return !!byId[x]; });
    }
    var startIds = taskId ? [taskId] : deps;
    for (var s = 0; s < startIds.length; s++) {
      var stack = [[startIds[s], 0]];
      var seen = Object.create(null);
      while (stack.length) {
        var frame = stack.pop();
        var node = frame[0], depth = frame[1];
        if (depth > LIMITS.TASK_DEPENDENCY_MAX) {
          return err(409, "dependency_cycle", "前置任务形成了循环依赖，请调整");
        }
        var next = edges[node] || [];
        for (var k = 0; k < next.length; k++) {
          if (taskId && next[k] === taskId && node !== taskId) {
            return err(409, "dependency_cycle",
              "该前置关系会形成循环依赖（经任务 " +
              (byId[node] ? byId[node].decisionName : node.slice(0, 8)) + "），请调整");
          }
          if (!seen[next[k]]) {
            seen[next[k]] = true;
            stack.push([next[k], depth + 1]);
          }
        }
      }
    }
    return { ok: true, value: deps };
  }

  /* ---------- 执行前审批统计 ---------- */

  // decisions: [{approver, decision:"approve"|"reject", at, withdrawnAt?}]
  // 同一审批人以最后一次未撤回的决定为准；返回当前进度与审批门控状态：
  //   none     未配置审批
  //   pending  尚无人拒绝，通过人数未达门槛
  //   approved 达到最少通过人数（且无拒绝）
  //   rejected 已有拒绝（一名拒绝即否决；撤回拒绝后自动回到 pending/approved）
  function approvalTally(approval, decisions) {
    if (!approval || !Array.isArray(approval.approvers) || !approval.approvers.length) {
      return { configured: false, approvers: [], minApprovals: 0,
               approved: 0, rejected: 0, pending: 0, decided: 0,
               byApprover: {}, state: "none" };
    }
    var latest = Object.create(null);
    (decisions || []).forEach(function (x) {
      if (x && x.withdrawnAt) return;
      if (x && (x.decision === "approve" || x.decision === "reject")) {
        latest[x.approver] = x.decision;
      }
    });
    var counts = { approve: 0, reject: 0 };
    approval.approvers.forEach(function (name) {
      if (latest[name]) counts[latest[name]]++;
    });
    var decided = counts.approve + counts.reject;
    var state;
    if (counts.reject > 0) state = "rejected";
    else if (counts.approve >= approval.minApprovals) state = "approved";
    else state = "pending";
    return {
      configured: true,
      approvers: approval.approvers.slice(),
      minApprovals: approval.minApprovals,
      approved: counts.approve,
      rejected: counts.reject,
      pending: approval.approvers.length - decided,
      decided: decided,
      byApprover: latest,
      state: state
    };
  }

  /* ---------- 前置门控（依赖 + 审批的统一计算） ---------- */

  // 单个依赖对直接后继的门控（单跳）；active 前置一律 waiting。
  function directDependencyGate(dep) {
    if (!dep) return { state: "blocked", reason: "dependency_not_found" };
    if (taskIsActive(dep)) return { state: "waiting", reason: "dependency_active" };
    return {
      state: DEPENDENCY_TERMINAL_GATE[dep.status] || "blocked",
      reason: "dependency_" + dep.status
    };
  }

  // 计算一个活动任务的完整前置门控（内部递归版，带 memo 缓存）。
  //   task       活动任务（scheduled/paused/running）
  //   allTasks   全部任务（依赖任务图）
  // 合并优先级：blocked > rejected > waiting > can_continue > approvals > ready
  function taskGateImpl(task, list, byId, memo, stack) {
    if (memo[task.id]) return memo[task.id];
    if (stack && stack[task.id]) {
      return { state: "blocked", reason: "dependency_cycle",
               dependencyState: "blocked", approvalState: "none",
               dependencies: [], blockingDependency: null, approval: null };
    }
    var nextStack = Object.assign({}, stack || null);
    nextStack[task.id] = true;

    function effectiveDep(dep, rowVia) {
      if (!dep) return { state: "blocked", reason: "dependency_not_found", via: null };
      var own = directDependencyGate(dep); // 终态：成功/部分/失败/取消/阻断
      if (dep.status === "scheduled" || dep.status === "paused") {
        // 前置自身还在等待：它的门控（审批/继续确认/上游传递）决定其结果可用性
        var dg = taskGateImpl(dep, list, byId, memo, nextStack);
        if (dg.state === "ready" || dg.state === "approvals") {
          // 前置本身尚未执行完毕（即使只差审批），对后继仍是“等待中”；
          // 但前置只在等审批而本任务也在等审批时，下面的本任务审批优先生效
          return { state: "waiting", reason: "dependency_active", via: dep.id };
        }
        return {
          state: dg.state === "rejected" ? "blocked" : dg.state,
          reason: dg.reason, via: dep.id
        };
      }
      // 终态前置还要沿其依赖链传播（其结果是在更上游条件下得到的）
      var worst = own;
      (dep.dependencyIds || []).forEach(function (pid) {
        var pg = effectiveDep(byId[pid], pid);
        if (pg.state === "blocked" ||
            (pg.state === "waiting" && worst.state !== "blocked") ||
            (pg.state === "can_continue" && worst.state === "ready")) {
          worst = { state: pg.state, reason: pg.reason, via: pid };
        }
      });
      return worst;
    }

    var depState = "ready";
    var depRows = [];
    var blockingDep = null;
    (task.dependencyIds || []).forEach(function (pid) {
      var dep = byId[pid];
      var g = effectiveDep(dep, pid);
      // 负责人对“部分成功前置”的确认：确认后该前置视为可继续放行
      var conf = (task.continueConfirmed || {})[pid];
      if (g.state === "can_continue" && conf) g = { state: "ready", reason: "partial_confirmed" };
      depRows.push({
        taskId: pid,
        decisionName: dep ? dep.decisionName : null,
        status: dep ? dep.status : "not_found",
        gate: g.state,
        reason: g.reason,
        via: g.via || null,
        confirmed: !!conf,
        snapshotId: dep ? (dep.snapshotId || dep.approvalSnapshotId || null) : null
      });
      if (g.state === "blocked" ||
          (g.state === "waiting" && depState !== "blocked") ||
          (g.state === "can_continue" && depState === "ready")) {
        depState = g.state;
        if (g.state !== "ready") blockingDep = depRows[depRows.length - 1];
      }
    });

    var tally = approvalTally(task.approval || null, task.approvalDecisions || []);
    var appState = tally.state; // none | pending | approved | rejected

    var state, reason;
    if (depState === "blocked") {
      state = "blocked";
      reason = blockingDep ? blockingDep.reason : "dependency_blocked";
    } else if (appState === "rejected") {
      state = "rejected";
      reason = "approval_rejected";
    } else if (depState === "waiting") {
      state = "waiting";
      reason = blockingDep ? blockingDep.reason : "dependency_active";
    } else if (depState === "can_continue") {
      state = "can_continue";
      reason = "dependency_partial";
    } else if (tally.configured && appState === "pending") {
      state = "approvals";
      reason = "approval_pending";
    } else if (tally.configured && appState === "approved") {
      state = "ready";
      reason = "approved";
    } else {
      state = "ready";
      reason = depRows.length ? "dependencies_satisfied" : "no_prerequisites";
    }

    var result = {
      state: state,
      reason: reason,
      dependencyState: depState,
      approvalState: appState,
      dependencies: depRows,
      blockingDependency: blockingDep,
      continueConfirmations: depRows
        .filter(function (row) { return row.status === "partial"; })
        .map(function (row) {
          var conf = (task.continueConfirmed || {})[row.taskId];
          return {
            taskId: row.taskId,
            needsConfirm: true,
            confirmed: !!conf,
            confirmedAt: conf ? (conf.at || null) : null,
            confirmedBy: conf ? (conf.by || null) : null
          };
        }),
      approval: tally.configured ? {
        approvers: tally.approvers,
        minApprovals: tally.minApprovals,
        approved: tally.approved,
        rejected: tally.rejected,
        pending: tally.pending,
        decided: tally.decided,
        byApprover: tally.byApprover,
        state: tally.state
      } : null
    };
    memo[task.id] = result;
    return result;
  }

  function taskGate(task, allTasks) {
    var byId = Object.create(null);
    (allTasks || []).forEach(function (t) { byId[t.id] = t; });
    return taskGateImpl(task, allTasks || [], byId, Object.create(null), Object.create(null));
  }

  // 批量计算整张图上所有活动任务的门控；终态任务给 null。
  function computeGates(allTasks) {
    var byId = Object.create(null);
    (allTasks || []).forEach(function (t) { byId[t.id] = t; });
    var memo = Object.create(null);
    var map = Object.create(null);
    (allTasks || []).forEach(function (t) {
      map[t.id] = taskIsActive(t)
        ? taskGateImpl(t, allTasks || [], byId, memo, Object.create(null))
        : null;
    });
    return map;
  }

  // 单个审批决定（去掉只在服务端使用的字段）
  function approvalDecisionDigest(x) {
    return {
      approver: x.approver,
      decision: x.decision, // approve | reject
      at: x.at,
      withdrawnAt: x.withdrawnAt || null
    };
  }

  // 门控的对外结构：优先用实时计算的 gate（含完整任务图），
  // 否则退回任务上持久化的上一次门控（服务重启后仍可展示等待原因与审批进度）。
  function gateSummary(task, gate) {
    var tally = approvalTally(task.approval || null, task.approvalDecisions || []);
    var approval = tally.configured ? {
      approvers: tally.approvers,
      minApprovals: tally.minApprovals,
      approved: tally.approved,
      rejected: tally.rejected,
      pending: tally.pending,
      decided: tally.decided,
      byApprover: tally.byApprover,
      state: tally.state,
      decisions: (task.approvalDecisions || []).map(approvalDecisionDigest)
    } : null;

    if (gate) {
      if (approval) gate.approval = approval; // 实时门控里的 tally 不带决定流水
      gate.label = GATE_STATE_LABELS[gate.state] || gate.state;
      gate.ready = gate.state === "ready";
      gate.at = task.gateAt || null;
      // 负责人对“部分成功前置”的继续确认进度（确认后该行 gate=ready，
      // 因此是否“需要确认”看前置自身终态是不是 partial）
      gate.continueConfirmations = (task.dependencyIds || []).map(function (pid) {
        var row = (gate.dependencies || []).filter(function (r) { return r.taskId === pid; })[0];
        var conf = (task.continueConfirmed || {})[pid];
        return {
          taskId: pid,
          needsConfirm: !!(row && row.status === "partial" &&
            (row.gate === "can_continue" || conf)),
          confirmed: !!conf,
          confirmedAt: conf ? (conf.at || null) : null,
          confirmedBy: conf ? (conf.by || null) : null
        };
      }).filter(function (x) { return x.needsConfirm; });
      return gate;
    }
    // 重启恢复路径：只有持久化的门控快照
    if (!task.gateState) {
      return {
        state: "ready", reason: null, label: GATE_STATE_LABELS.ready,
        ready: true, at: null, dependencyState: "ready",
        approvalState: tally.state, approval: approval,
        dependencies: (task.dependencyIds || []).map(function (pid) {
          return { taskId: pid, gate: "unknown", reason: null, status: null };
        }),
        blockingDependency: null, continueConfirmations: []
      };
    }
    return {
      state: task.gateState,
      reason: task.gateReason || null,
      label: GATE_STATE_LABELS[task.gateState] || task.gateState,
      ready: task.gateState === "ready",
      at: task.gateAt || null,
      dependencyState: task.gateDependencyState || "ready",
      approvalState: tally.state,
      approval: approval,
      dependencies: Array.isArray(task.gateDependencies) ? task.gateDependencies : [],
      blockingDependency: task.gateBlockingDependency || null,
      continueConfirmations: Array.isArray(task.gateContinueConfirmations)
        ? task.gateContinueConfirmations : []
    };
  }

  function taskSummary(t, gate) {
    if (!t) return null;
    return {
      id: t.id,
      decisionId: t.decisionId,
      decisionName: t.decisionName,
      batchId: t.batchId,
      batchName: t.batchName,
      status: t.status,
      publishedAt: t.publishedAt,
      publishedBy: t.publishedBy,
      scheduledAt: t.scheduledAt,
      scheduledAtMs: t.scheduledAtMs,
      pausedAt: t.pausedAt || null,
      pausedBy: t.pausedBy || null,
      pauseScheduledAt: t.pauseScheduledAt || null,
      resumedAt: t.resumedAt || null,
      cancelReason: t.cancelReason || null,
      cancelledAt: t.cancelledAt || null,
      finishedAt: t.finishedAt || null,
      blockReason: t.blockReason || null,
      lastError: t.lastError || null,
      attempts: (t.attempts || []).map(function (a) {
        return {
          at: a.at, kind: a.kind, scheduledAt: a.scheduledAt || null,
          status: a.status, counts: a.counts || null,
          executionId: a.executionId || null,
          reason: a.reason || null, message: a.message || null
        };
      }),
      lastExecutionId: t.lastExecutionId || null,
      lastCounts: t.lastCounts || null,
      successAnnotationIds: (t.successAnnotationIds || []).slice(),
      snapshotId: t.snapshotId || null,
      // 前置任务与执行前审批配置
      dependencyIds: (t.dependencyIds || []).slice(),
      approval: t.approval ? {
        approvers: (t.approval.approvers || []).slice(),
        minApprovals: t.approval.minApprovals
      } : null,
      approvalSnapshotId: t.approvalSnapshotId || null,
      continueConfirmedIds: Object.keys(t.continueConfirmed || {}),
      // 实时（或重启后持久化）的门控：等待原因 + 审批进度都在这里
      gate: gateSummary(t, gate || null),
      lock: t.lock ? {
        at: t.lock.at,
        textRev: t.lock.textRev,
        annotationRev: t.lock.annotationRev,
        batchRev: t.lock.batchRev,
        decisionRev: t.lock.decisionRev,
        paragraphCount: (t.lock.paragraphs || []).length
      } : null
    };
  }

  // 一次性算好整张任务图的门控再映射摘要（队列列表用，避免 O(n²) 重复计算）
  function taskSummaries(tasks) {
    var gates = computeGates(tasks);
    return (tasks || []).map(function (t) { return taskSummary(t, gates[t.id]); });
  }

  // 把当前门控快照写回任务（持久化用）；服务重启后据此恢复等待原因与审批进度。
  function persistGateOnTask(task, gate) {
    task.gateState = gate.state;
    task.gateReason = gate.reason || null;
    task.gateDependencyState = gate.dependencyState;
    task.gateAt = new Date().toISOString();
    task.gateDependencies = (gate.dependencies || []).map(function (r) {
      return {
        taskId: r.taskId, decisionName: r.decisionName, status: r.status,
        gate: r.gate, reason: r.reason, via: r.via || null,
        snapshotId: r.snapshotId || null
      };
    });
    task.gateBlockingDependency = gate.blockingDependency ? {
      taskId: gate.blockingDependency.taskId,
      decisionName: gate.blockingDependency.decisionName,
      status: gate.blockingDependency.status,
      reason: gate.blockingDependency.reason,
      via: gate.blockingDependency.via || null,
      snapshotId: gate.blockingDependency.snapshotId || null
    } : null;
    task.gateContinueConfirmations = (task.dependencyIds || []).map(function (pid) {
      var row = (gate.dependencies || []).filter(function (r) { return r.taskId === pid; })[0];
      var conf = (task.continueConfirmed || {})[pid];
      return {
        taskId: pid,
        needsConfirm: !!(row && row.status === "partial"),
        confirmed: !!conf,
        confirmedAt: conf ? (conf.at || null) : null,
        confirmedBy: conf ? (conf.by || null) : null
      };
    }).filter(function (x) { return x.needsConfirm; });
  }

  // 执行任务（含发布时锁定的文本/批注/批次版本与成功条目集合）快照摘要，
  // 保存快照时嵌入，与当时的草案/批注状态关联。
  function taskDigest(tasks) {
    var gates = computeGates(tasks);
    return (tasks || []).map(function (t) {
      var s = taskSummary(t, gates[t.id]);
      if (t.lock) {
        s.lock = {
          at: t.lock.at,
          textRev: t.lock.textRev,
          annotationRev: t.lock.annotationRev,
          batchRev: t.lock.batchRev,
          decisionRev: t.lock.decisionRev,
          // 发布时锁定的段落文本：历史快照可见当时将被自动执行的确切文本
          paragraphs: (t.lock.paragraphs || []).map(function (p) {
            return { dir: p.dir || "auto", text: p.text };
          })
        };
      }
      s.successAnnotationIds = (t.successAnnotationIds || []).slice();
      // 历史快照中保留当时审批决定流水，可回溯“谁在执行前通过/拒绝/撤回”
      if (t.approvalDecisions) {
        s.approvalDecisions = t.approvalDecisions.map(approvalDecisionDigest);
      }
      return s;
    });
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
      trigger: ex.trigger || (ex.actor === "系统定时执行" ? "scheduled" : "manual"),
      taskId: ex.taskId || null,
      snapshotId: ex.snapshotId || null,
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
        scheduledAt: d.scheduledAt || null,
        deadline: d.deadline || null,
        textRev: d.textRev,
        annotationRev: d.annotationRev,
        batchRev: d.batchRev,
        activeTaskId: d.activeTaskId || null,
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
    TASK_STATUSES: TASK_STATUSES,
    TASK_TERMINAL: TASK_TERMINAL,
    TASK_STATUS_LABELS: TASK_STATUS_LABELS,
    GATE_STATES: GATE_STATES,
    GATE_STATE_LABELS: GATE_STATE_LABELS,
    DEPENDENCY_TERMINAL_GATE: DEPENDENCY_TERMINAL_GATE,
    APPROVAL_LABELS: APPROVAL_LABELS,
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
    // 执行队列
    validateScheduledAt: validateScheduledAt,
    validateRescheduleAt: validateRescheduleAt,
    taskIsTerminal: taskIsTerminal,
    taskIsActive: taskIsActive,
    taskSummary: taskSummary,
    taskSummaries: taskSummaries,
    taskDigest: taskDigest,
    persistGateOnTask: persistGateOnTask,
    // 任务依赖与执行前审批
    validateApproverName: validateApproverName,
    validateApprovalConfig: validateApprovalConfig,
    normalizeDependencyIds: normalizeDependencyIds,
    validateTaskDependencies: validateTaskDependencies,
    approvalTally: approvalTally,
    directDependencyGate: directDependencyGate,
    taskGate: taskGate,
    computeGates: computeGates,
    gateSummary: gateSummary,
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
