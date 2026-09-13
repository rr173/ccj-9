/* replay-core.js
 * 执行回放的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.ReplayCore），Node 下可直接 require 单测。
 *
 * 职责：
 *   1) 审计包构建：从线上任务 / 决策日志 / 执行记录 / 快照数据中提取
 *      指定时间范围内的等待、审批、执行、重试事件，生成带版本号、
 *      内容哈希与事件链哈希的自洽审计包（只读快照，不反向引用线上数据）。
 *   2) 审计包校验：格式、必填字段、内容哈希、事件 id 重复、事件链顺序
 *      （时间倒退 / prev 断链）、跨任务引用（依赖任务 / 快照必须在包内）、
 *      大包条目数量限制，全部通过后才允许写入回放空间（全有或全无）。
 *   3) 幂等与冲突：包标识（producerId + packageId 唯一）相同且哈希一致
 *      视为同一包，重复导入幂等；标识相同但哈希不同是明确冲突。
 *   4) 时间线视图：按事件类别归类（等待 / 审批 / 执行 / 重试 / 配置 / 取消），
 *      支持按任务与事件类型筛选，只展示包内锁定的历史内容。
 *
 * 重要约定：回放数据是“锁定的历史”。本模块不提供任何修改任务 / 审批 /
 * 执行的能力，UI 与服务端均不得在回放视图中触发线上动作。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("crypto"));
  } else {
    root.ReplayCore = factory(root.crypto);
  }
})(typeof self !== "undefined" ? self : this, function (nodeCrypto) {
  "use strict";

  var PACKAGE_FORMAT = "bidi-replay";
  var PACKAGE_VERSION = 1;
  var SCHEMA_VERSION = 1;

  var LIMITS = {
    // 导入（含导出时预校验）的大包条目数量上限
    EVENTS_MAX: 5000,
    TASKS_MAX: 500,
    DECISIONS_MAX: 200,
    SNAPSHOTS_MAX: 1000,
    ITEMS_PER_TASK_MAX: 500,
    RESULTS_PER_EXECUTION_MAX: 2000,
    APPROVALS_PER_TASK_MAX: 50,
    ATTEMPTS_PER_TASK_MAX: 100,
    DEPENDENCIES_PER_TASK_MAX: 50,
    NAME_MAX_CHARS: 200,
    // 单条事件 detail 文本上限（防御性）
    DETAIL_MAX_CHARS: 5000
  };

  /* ================= 事件类别 =================
   * wait     任务等待（排期 / 门控等待 / 阻断 / 可继续 / 暂停）
   * approval 执行前审批（配置 / 通过 / 拒绝 / 撤回 / 达标 / 否决）
   * execute  执行尝试与逐条结果（自动 / 手动 / 重试触发，成功 / 部分 / 失败 / 阻断）
   * retry    重试
   * config   依赖与配置变更
   * cancel   取消
   */
  var EVENT_CATEGORIES = ["wait", "approval", "execute", "retry", "config", "cancel"];

  var ACTION_CATEGORY = {
    task_publish: "wait",
    task_gate_waiting: "wait",
    task_dependency_blocked: "wait",
    task_dependency_unblocked: "wait",
    task_dependency_can_continue: "wait",
    task_blocked: "execute",
    task_pause: "wait",
    task_resume: "wait",

    task_approval_configured: "approval",
    task_approval_reset: "approval",
    task_approved: "approval",
    task_rejected: "approval",
    task_approval_withdrawn: "approval",
    task_approval_met: "approval",
    task_approval_rejected: "approval",
    task_approval_reopened: "approval",

    task_auto_execute: "execute",
    task_succeeded: "execute",
    task_partial: "execute",
    task_failed: "execute",
    task_interrupted: "execute",

    task_retry: "retry",
    task_retry_execute: "retry",

    task_dependencies_changed: "config",
    task_dependency_continue: "config",

    task_cancel: "cancel",
    task_cancelled: "cancel"
  };

  // 执行尝试种类（写入 attempt.kind 时的原文）与事件类别
  // 执行引擎的逐条流水：task_auto_execute_item_success/conflict/skipped、
  // task_retry_execute_item_*（前缀兜底会在下方统一识别）。
  function categoryOfAction(action) {
    if (Object.prototype.hasOwnProperty.call(ACTION_CATEGORY, action)) {
      return ACTION_CATEGORY[action];
    }
    // 未知动作：按前缀兜底归类，保证新老版本互操作
    if (action.indexOf("task_approval") === 0) return "approval";
    if (action.indexOf("task_auto_execute_item") === 0 ||
        action.indexOf("task_retry_execute_item") === 0 ||
        action.indexOf("_item_success") !== -1 ||
        action.indexOf("_item_conflict") !== -1 ||
        action.indexOf("_item_skipped") !== -1) return "execute";
    if (action.indexOf("task_retry") === 0) return "retry";
    if (action.indexOf("task_cancel") === 0) return "cancel";
    if (action.indexOf("task_dependenc") === 0) return "config";
    if (action.indexOf("task_") === 0) return "wait";
    return "wait";
  }

  /* ================= 哈希工具 =================
   * 浏览器使用 SubtleCrypto 的同步接口不可得，因此包内哈希统一使用
   * “规范化 JSON + FNV-1a 64 位（16 进制）”的确定性摘要：
   * 纯函数、无环境依赖、Node 与浏览器结果一致，足以发现内容篡改。
   * 若 Node 环境下需要更强算法，verifyPackage 仅比较摘要字符串本身，
   * 因此未来可在构建端升级算法而不破坏校验接口。
   */
  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map(stableStringify).join(",") + "]";
    }
    var keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + stableStringify(value[k]);
    }).join(",") + "}";
  }

  // 字符串 -> UTF-8 字节数组（浏览器与 Node 行为一致）
  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                   0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }

  // 64 位 FNV-1a：BigInt 实现（offset basis 与 prime 均为标准常量），
  // 输入是规范化 JSON 的 UTF-8 字节，输出 16 进制。纯确定性、无环境依赖。
  function fnv1a64Hex(str) {
    var FNV_OFFSET = 0xcbf29ce484222325n;
    var FNV_PRIME = 0x100000001b3n;
    var MASK = 0xffffffffffffffffn;
    var hash = FNV_OFFSET;
    var bytes = utf8Bytes(str);
    for (var i = 0; i < bytes.length; i++) {
      hash ^= BigInt(bytes[i]);
      hash = (hash * FNV_PRIME) & MASK;
    }
    var hex = hash.toString(16);
    return ("0000000000000000" + hex).slice(-16);
  }

  function hashCanonical(value) {
    return "fnv1a64:" + fnv1a64Hex(stableStringify(value));
  }

  // 供 Node 服务端使用的强哈希（sha256），写入 manifest.contentHashSha256；
  // 浏览器端校验时若无此字段也不报错（以 fnv 摘要为准）。
  function sha256Canonical(value) {
    if (!nodeCrypto || !nodeCrypto.createHash) return null;
    return "sha256:" + nodeCrypto.createHash("sha256")
      .update(stableStringify(value), "utf8").digest("hex");
  }

  /* ================= 时间工具 ================= */

  function isISODateString(s) {
    if (typeof s !== "string") return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      return false;
    }
    var t = Date.parse(s);
    return !isNaN(t) && new Date(t).toISOString() != null;
  }

  /* ================= 审计包构建 =================
   *
   * 输入 sourceData：
   * {
   *   name, producerId, actor,
   *   range: {from, to},
   *   tasks: [...],          // 线上任务（含 lock/attempts/approval 等全字段）
   *   decisionLogs: [...],   // 决策日志（带 taskId 的动作）
   *   executions: { [decisionId]: [ex, ...] }, // 各草案执行记录（逐条结果）
   *   snapshots: [...],      // 快照全量（按 id 关联提取）
   *   decisions: [...]       // 决策摘要（供任务关联展示）
   * }
   *
   * 输出：自洽的审计包对象（尚未写哈希，buildPackage 会填好）。
   * 时间范围筛选的是“事件”：凡有事件落入 [from,to] 的任务整体纳入
   * （任务依赖、审批流水、执行尝试与关联快照需要完整上下文）；
   * 任务之外的对象（快照）只纳入被引用者。
   */

  function inRange(iso, from, to) {
    if (!iso) return false;
    var t = Date.parse(iso);
    if (isNaN(t)) return false;
    if (from) { var f = Date.parse(from); if (!isNaN(f) && t < f) return false; }
    if (to) { var e = Date.parse(to); if (!isNaN(e) && t > e) return false; }
    return true;
  }

  function pickString(v, maxChars) {
    if (v == null) return null;
    if (typeof v !== "string") return null;
    if (maxChars && v.length > maxChars) return v.slice(0, maxChars);
    return v;
  }

  // 从一条决策日志生成时间线事件（保留逐条结果关联 executionId）
  function eventFromLog(log) {
    var ev = {
      id: log.id,
      taskId: log.taskId,
      at: log.at,
      actor: pickString(log.actor, LIMITS.NAME_MAX_CHARS) || "匿名",
      action: log.action,
      category: categoryOfAction(log.action),
      detail: pickString(log.detail, LIMITS.DETAIL_MAX_CHARS),
      annotationId: log.annotationId || null,
      decisionId: log.decisionId || null,
      executionId: log.executionId || null,
      snapshotId: log.snapshotId || null,
      prevEventId: null
    };
    return ev;
  }

  function buildPackage(sourceData) {
    sourceData = sourceData || {};
    var range = sourceData.range || {};
    var from = range.from || null;
    var to = range.to || null;
    if (from && !isISODateString(from)) {
      return { ok: false, code: "invalid_from", message: "起始时间不是合法 ISO 时间" };
    }
    if (to && !isISODateString(to)) {
      return { ok: false, code: "invalid_to", message: "结束时间不是合法 ISO 时间" };
    }
    if (from && to && Date.parse(from) > Date.parse(to)) {
      return { ok: false, code: "invalid_range", message: "起始时间晚于结束时间" };
    }

    var tasks = Array.isArray(sourceData.tasks) ? sourceData.tasks : [];
    var logs = Array.isArray(sourceData.decisionLogs) ? sourceData.decisionLogs : [];

    // 1) 选出时间范围内、且属于执行任务的事件
    var events = [];
    logs.forEach(function (log) {
      if (!log || !log.taskId) return;
      if (!inRange(log.at, from, to)) return;
      events.push(eventFromLog(log));
    });

    // 2) 稳定排序：时间升序，同一时刻按 (taskId, action, id) 保证确定性
    events.sort(function (a, b) {
      var ta = Date.parse(a.at);
      var tb = Date.parse(b.at);
      if (ta !== tb) return ta - tb;
      if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
      if (a.action !== b.action) return a.action < b.action ? -1 : 1;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    var involvedTaskIds = Object.create(null);
    events.forEach(function (ev) { involvedTaskIds[ev.taskId] = true; });

    var includedTasks = tasks.filter(function (t) { return involvedTaskIds[t.id]; });

    // 3) 任务依赖：依赖任务若不在时间范围内，也作为“关联任务”纳入
    //    （否则跨任务引用校验无法通过，回放也看不出等待原因）。
    var taskById = Object.create(null);
    tasks.forEach(function (t) { taskById[t.id] = t; });
    var relatedTaskIds = Object.create(null);
    includedTasks.forEach(function (t) {
      (t.dependencyIds || []).forEach(function (depId) {
        relatedTaskIds[depId] = true;
      });
    });
    Object.keys(relatedTaskIds).forEach(function (depId) {
      if (!involvedTaskIds[depId] && taskById[depId]) includedTasks.push(taskById[depId]);
    });
    var includedTaskIdSet = Object.create(null);
    includedTasks.forEach(function (t) { includedTaskIdSet[t.id] = true; });

    // 4) 依赖的任务必须真实存在（线上数据自洽性检查）
    var missingDep = null;
    includedTasks.forEach(function (t) {
      (t.dependencyIds || []).forEach(function (depId) {
        if (!taskById[depId] && !missingDep) missingDep = depId;
      });
    });
    if (missingDep) {
      return { ok: false, code: "dependency_not_found",
        message: "任务依赖引用了不存在的任务：" + missingDep };
    }

    // 5) 序列化任务：任务依赖 / 审批流水 / 尝试 / 锁定版本
    var pkgTasks = includedTasks.map(serializeTask);

    // 6) 执行记录与逐条结果：纳入包内任务关联的全部执行记录。
    //    逐条成功/冲突/跳过在线上决策日志里已有 *_item_* 事件（见步骤 1），
    //    这里只固化结构化的执行记录与冲突原因，供回看，不再合成时间线事件。
    var executionsByDecision = sourceData.executions || {};
    var pkgExecutions = [];
    includedTasks.forEach(function (t) {
      var list = executionsByDecision[t.decisionId] || [];
      list.forEach(function (ex) {
        var belongs = ex.taskId === t.id ||
          (t.attempts || []).some(function (a) { return a.executionId === ex.id; });
        if (!belongs) return;
        pkgExecutions.push(serializeExecution(ex, t.id));
      });
    });

    // 7) 快照关联：收集事件 / 任务 / 执行记录引用到的快照。
    //    线上快照可能已被删除而日志仍引用其 id——包必须自洽，因此无法解析
    //    的快照引用一律剪枝为 null（引用对象存在但快照缺失的情况不阻断导出）。
    var snapshots = Array.isArray(sourceData.snapshots) ? sourceData.snapshots : [];
    var snapshotById = Object.create(null);
    snapshots.forEach(function (s) { snapshotById[s.id] = s; });
    var wantedSnapshotIds = Object.create(null);
    events.forEach(function (ev) { if (ev.snapshotId) wantedSnapshotIds[ev.snapshotId] = true; });
    includedTasks.forEach(function (t) {
      if (t.snapshotId) wantedSnapshotIds[t.snapshotId] = true;
      if (t.approvalSnapshotId) wantedSnapshotIds[t.approvalSnapshotId] = true;
    });
    pkgExecutions.forEach(function (ex) {
      if (ex.snapshotId) wantedSnapshotIds[ex.snapshotId] = true;
    });
    var resolvableSnapshotIds = Object.create(null);
    var pkgSnapshots = Object.keys(wantedSnapshotIds)
      .filter(function (id) {
        if (snapshotById[id]) { resolvableSnapshotIds[id] = true; return true; }
        return false;
      })
      .map(function (id) { return serializeSnapshot(snapshotById[id]); });
    // 剪枝无法解析的引用
    events.forEach(function (ev) {
      if (ev.snapshotId && !resolvableSnapshotIds[ev.snapshotId]) ev.snapshotId = null;
    });
    pkgExecutions.forEach(function (ex) {
      if (ex.snapshotId && !resolvableSnapshotIds[ex.snapshotId]) {
        ex.snapshotId = null;
      }
    });
    pkgTasks.forEach(function (t) {
      if (t.snapshotId && !resolvableSnapshotIds[t.snapshotId]) t.snapshotId = null;
      if (t.approvalSnapshotId && !resolvableSnapshotIds[t.approvalSnapshotId]) {
        t.approvalSnapshotId = null;
      }
      (t.approvalDecisions || []).forEach(function (a) {
        if (a.snapshotId && !resolvableSnapshotIds[a.snapshotId]) a.snapshotId = null;
      });
    });

    // 8) 关联草案摘要（任务上的版本、逐条方案用于回看冲突原因）；
    //    草案若已被删除，任务上的 decisionId 剪枝为 null 并移除其事件关联。
    var decisions = Array.isArray(sourceData.decisions) ? sourceData.decisions : [];
    var decisionById = Object.create(null);
    decisions.forEach(function (d) { decisionById[d.id] = d; });
    var wantedDecisionIds = Object.create(null);
    includedTasks.forEach(function (t) { if (t.decisionId) wantedDecisionIds[t.decisionId] = true; });
    var resolvableDecisionIds = Object.create(null);
    var pkgDecisions = Object.keys(wantedDecisionIds)
      .filter(function (id) {
        if (decisionById[id]) { resolvableDecisionIds[id] = true; return true; }
        return false;
      })
      .map(function (id) { return serializeDecision(decisionById[id]); });
    pkgTasks.forEach(function (t) {
      if (t.decisionId && !resolvableDecisionIds[t.decisionId]) t.decisionId = null;
    });
    pkgExecutions.forEach(function (ex) {
      if (ex.decisionId && !resolvableDecisionIds[ex.decisionId]) ex.decisionId = null;
    });
    events.forEach(function (ev) {
      if (ev.decisionId && !resolvableDecisionIds[ev.decisionId]) ev.decisionId = null;
    });

    // 9) 事件链：排序后串 prevEventId（允许同一毫秒，不允许倒退）
    for (var i = 0; i < events.length; i++) {
      events[i].seq = i + 1;
      events[i].prevEventId = i === 0 ? null : events[i - 1].id;
    }

    var content = {
      range: { from: from, to: to },
      tasks: pkgTasks,
      decisions: pkgDecisions,
      executions: pkgExecutions,
      events: events,
      snapshots: pkgSnapshots
    };

    // 10) 数量上限预校验（导入端会再查一遍）
    var limitErr = checkContentLimits(content);
    if (limitErr) return { ok: false, code: "package_too_large", message: limitErr };

    var name = pickString(sourceData.name, LIMITS.NAME_MAX_CHARS) ||
      "执行回放 " + (from || "…") + " 至 " + (to || "…");
    var now = new Date().toISOString();
    var producerId = pickString(sourceData.producerId, 100) || "bidi-editor";
    var packageId = sourceData.packageId || makePackageId(producerId, content);

    var pkg = {
      format: PACKAGE_FORMAT,
      packageVersion: PACKAGE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      packageId: packageId,
      producerId: producerId,
      name: name,
      createdAt: now,
      createdBy: pickString(sourceData.actor, LIMITS.NAME_MAX_CHARS) || "负责人",
      exportedAt: now,
      range: content.range,
      content: content,
      manifest: null
    };
    pkg.manifest = buildManifest(pkg);
    return { ok: true, value: pkg };
  }

  function makePackageId(producerId, content) {
    // 包标识：生产者 + 时间范围 + 纳入事件 id 集合的摘要。
    // 同一线上数据同一范围导出两次得到相同 packageId（重复导入幂等）。
    var eventIds = content.events.map(function (e) { return e.id; })
      .sort().join(",");
    var basis = producerId + "|" + (content.range.from || "") + "|" +
      (content.range.to || "") + "|" + eventIds;
    return "rpk_" + fnv1a64Hex(basis).slice(0, 24);
  }

  function serializeTask(t) {
    return {
      id: t.id,
      decisionId: t.decisionId || null,
      decisionName: pickString(t.decisionName, LIMITS.NAME_MAX_CHARS),
      batchId: t.batchId || null,
      batchName: pickString(t.batchName, LIMITS.NAME_MAX_CHARS),
      status: t.status,
      publishedAt: t.publishedAt || null,
      publishedBy: pickString(t.publishedBy, LIMITS.NAME_MAX_CHARS) || null,
      scheduledAt: t.scheduledAt || null,
      pausedAt: t.pausedAt || null,
      resumedAt: t.resumedAt || null,
      finishedAt: t.finishedAt || null,
      cancelledAt: t.cancelledAt || null,
      cancelReason: pickString(t.cancelReason, LIMITS.DETAIL_MAX_CHARS),
      blockReason: pickString(t.blockReason, LIMITS.DETAIL_MAX_CHARS),
      lastError: pickString(t.lastError, LIMITS.DETAIL_MAX_CHARS),
      createdAt: t.createdAt || null,
      updatedAt: t.updatedAt || null,
      // 发布时锁定的版本
      lock: t.lock ? {
        at: t.lock.at || null,
        paragraphs: Array.isArray(t.lock.paragraphs) ? t.lock.paragraphs : [],
        textRev: t.lock.textRev == null ? null : t.lock.textRev,
        annotationRev: t.lock.annotationRev == null ? null : t.lock.annotationRev,
        batchRev: t.lock.batchRev == null ? null : t.lock.batchRev,
        decisionRev: t.lock.decisionRev == null ? null : t.lock.decisionRev
      } : null,
      dependencyIds: Array.isArray(t.dependencyIds) ? t.dependencyIds.slice() : [],
      approval: t.approval ? {
        approvers: (t.approval.approvers || []).slice(),
        minApprovals: t.approval.minApprovals
      } : null,
      // 审批流水（逐人最后决定 + 历史在决策日志中，这里固化决定快照）
      approvalDecisions: Array.isArray(t.approvalDecisions)
        ? t.approvalDecisions.slice(0, LIMITS.APPROVALS_PER_TASK_MAX)
          .map(function (a) {
            return {
              approver: pickString(a.approver, 50),
              decision: a.decision,
              at: a.at || null,
              snapshotId: a.snapshotId || null
            };
          })
        : [],
      gateState: t.gateState || null,
      gateReason: pickString(t.gateReason, LIMITS.DETAIL_MAX_CHARS),
      snapshotId: t.snapshotId || null,
      approvalSnapshotId: t.approvalSnapshotId || null,
      attempts: Array.isArray(t.attempts)
        ? t.attempts.slice(0, LIMITS.ATTEMPTS_PER_TASK_MAX).map(function (a) {
            return {
              at: a.at || null,
              kind: a.kind || null,
              scheduledAt: a.scheduledAt || null,
              status: a.status || null,
              reason: pickString(a.reason, LIMITS.DETAIL_MAX_CHARS),
              counts: a.counts || null,
              executionId: a.executionId || null
            };
          })
        : [],
      successAnnotationIds: Array.isArray(t.successAnnotationIds)
        ? t.successAnnotationIds.slice() : [],
      lastCounts: t.lastCounts || null
    };
  }

  function serializeExecution(ex, taskId) {
    return {
      id: ex.id,
      taskId: taskId,
      decisionId: ex.decisionId || null,
      at: ex.at || null,
      actor: pickString(ex.actor, LIMITS.NAME_MAX_CHARS) || null,
      trigger: ex.trigger || null,
      applied: !!ex.applied,
      undone: !!ex.undone,
      snapshotId: ex.snapshotId || null,
      counts: ex.counts || null,
      results: (ex.results || []).slice(0, LIMITS.RESULTS_PER_EXECUTION_MAX).map(function (r) {
        return {
          annotationId: r.annotationId || null,
          disposition: r.disposition || null,
          replacement: pickString(r.replacement, 5000),
          result: r.result,
          reason: r.reason || null, // 冲突原因（quote_mismatch / paragraph_deleted 等）
          paraIndex: r.paraIndex == null ? null : r.paraIndex,
          currentParaIndex: r.currentParaIndex == null ? null : r.currentParaIndex,
          start: r.start == null ? null : r.start,
          end: r.end == null ? null : r.end,
          at: r.at || ex.at || null
        };
      })
    };
  }

  function serializeSnapshot(s) {
    return {
      id: s.id,
      name: pickString(s.name, 100),
      createdAt: s.createdAt || null,
      rev: s.rev == null ? null : s.rev,
      kind: s.kind || null,
      paragraphs: Array.isArray(s.paragraphs) ? s.paragraphs : [],
      textRev: s.textRev == null ? null : s.textRev,
      annotationRev: s.annotationRev == null ? null : s.annotationRev,
      batchRev: s.batchRev == null ? null : s.batchRev,
      decisionRev: s.decisionRev == null ? null : s.decisionRev,
      // 关联摘要（批注/决策/队列嵌入），用于回看看锁定时刻的关联状态
      annotationCount: Array.isArray(s.annotations) ? s.annotations.length
        : (s.openAnnotationCount != null ? s.openAnnotationCount : null),
      taskId: s.taskId || null,
      executionId: s.executionId || null
    };
  }

  function serializeDecision(d) {
    return {
      id: d.id,
      name: pickString(d.name, LIMITS.NAME_MAX_CHARS),
      batchId: d.batchId || null,
      status: d.status || null,
      threshold: d.threshold == null ? null : d.threshold,
      createdAt: d.createdAt || null,
      deadline: d.deadline || null,
      textRev: d.textRev == null ? null : d.textRev,
      annotationRev: d.annotationRev == null ? null : d.annotationRev,
      batchRev: d.batchRev == null ? null : d.batchRev,
      items: Array.isArray(d.items)
        ? d.items.slice(0, LIMITS.ITEMS_PER_TASK_MAX).map(function (it) {
            return {
              annotationId: it.annotationId || null,
              disposition: it.disposition || null,
              replacement: pickString(it.replacement, 5000)
            };
          })
        : []
    };
  }

  /* ================= manifest（版本 + 内容哈希 + 事件链哈希） ================= */

  function buildManifest(pkg) {
    var contentHash = hashCanonical(pkg.content);
    var chain = chainHashes(pkg.content.events);
    return {
      format: pkg.format,
      packageVersion: pkg.packageVersion,
      schemaVersion: pkg.schemaVersion,
      packageId: pkg.packageId,
      producerId: pkg.producerId,
      contentHash: contentHash,
      contentHashSha256: sha256Canonical(pkg.content),
      eventCount: pkg.content.events.length,
      chainHead: chain.head,
      chainHeadId: chain.headId,
      createdAt: pkg.createdAt
    };
  }

  // 事件链：每条事件 hash_i = H(hash_{i-1} || canonical(event))
  // 头哈希对整链顺序与内容敏感：调换、倒退、缺环都会改变 head。
  function chainHashes(events) {
    var prev = null;
    var head = null;
    var headId = null;
    events.forEach(function (ev) {
      var basis = (prev || "") + "|" + stableStringify(chainEventPayload(ev));
      head = "fnv1a64:" + fnv1a64Hex(basis);
      prev = head;
      headId = ev.id;
    });
    return { head: head, headId: headId };
  }

  // 链式哈希只覆盖事件的业务字段（不含链上自身的 prevEventId/seq，
  // 避免自引用；prevEventId 的正确性在 verifyPackage 单独校验）
  function chainEventPayload(ev) {
    return {
      id: ev.id, taskId: ev.taskId, at: ev.at, actor: ev.actor,
      action: ev.action, category: ev.category, detail: ev.detail || null,
      annotationId: ev.annotationId || null, decisionId: ev.decisionId || null,
      executionId: ev.executionId || null, snapshotId: ev.snapshotId || null
    };
  }

  function checkContentLimits(content) {
    if (!content) return "包内容为空";
    if ((content.events || []).length > LIMITS.EVENTS_MAX) {
      return "事件数 " + content.events.length + " 超过上限 " + LIMITS.EVENTS_MAX;
    }
    if ((content.tasks || []).length > LIMITS.TASKS_MAX) {
      return "任务数 " + content.tasks.length + " 超过上限 " + LIMITS.TASKS_MAX;
    }
    if ((content.decisions || []).length > LIMITS.DECISIONS_MAX) {
      return "草案数超过上限 " + LIMITS.DECISIONS_MAX;
    }
    if ((content.snapshots || []).length > LIMITS.SNAPSHOTS_MAX) {
      return "快照数超过上限 " + LIMITS.SNAPSHOTS_MAX;
    }
    if ((content.executions || []).length > LIMITS.EVENTS_MAX) {
      return "执行记录数超过上限 " + LIMITS.EVENTS_MAX;
    }
    var tasks = content.tasks || [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if ((t.dependencyIds || []).length > LIMITS.DEPENDENCIES_PER_TASK_MAX) {
        return "任务 " + t.id + " 的依赖数超过上限";
      }
      if ((t.attempts || []).length > LIMITS.ATTEMPTS_PER_TASK_MAX) {
        return "任务 " + t.id + " 的尝试次数超过上限";
      }
      if ((t.approvalDecisions || []).length > LIMITS.APPROVALS_PER_TASK_MAX) {
        return "任务 " + t.id + " 的审批记录数超过上限";
      }
    }
    var execs = content.executions || [];
    for (var j = 0; j < execs.length; j++) {
      if ((execs[j].results || []).length > LIMITS.RESULTS_PER_EXECUTION_MAX) {
        return "执行记录 " + execs[j].id + " 的逐条结果超过上限";
      }
    }
    return null;
  }

  /* ================= 审计包校验（导入前全部跑完，任一失败即拒绝） ================= */

  function fail(code, message, extra) {
    return { ok: false, code: code, message: message,
      errors: extra ? [].concat(extra) : [] };
  }

  function verifyPackage(pkg) {
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
      return fail("invalid_format", "审计包不是 JSON 对象");
    }
    // ---- 顶层字段 ----
    var topFields = ["format", "packageVersion", "schemaVersion", "packageId",
      "producerId", "name", "createdAt", "exportedAt", "range", "content", "manifest"];
    for (var i = 0; i < topFields.length; i++) {
      if (!(topFields[i] in pkg)) {
        return fail("missing_field", "审计包缺少字段：" + topFields[i]);
      }
    }
    if (pkg.format !== PACKAGE_FORMAT) {
      return fail("invalid_format",
        "审计包格式标识不匹配：期望 " + PACKAGE_FORMAT + "，实际 " + pkg.format);
    }
    if (!Number.isInteger(pkg.packageVersion) || pkg.packageVersion < 1) {
      return fail("invalid_version", "审计包版本号非法或不受支持：" + pkg.packageVersion);
    }
    if (pkg.packageVersion > PACKAGE_VERSION) {
      return fail("unsupported_version",
        "审计包来自更新的版本（" + pkg.packageVersion + "），当前服务仅支持到 " +
        PACKAGE_VERSION);
    }
    if (!Number.isInteger(pkg.schemaVersion) || pkg.schemaVersion < 1) {
      return fail("invalid_version", "审计内容结构版本号非法");
    }
    if (typeof pkg.packageId !== "string" || !/^[A-Za-z0-9_:.-]{4,100}$/.test(pkg.packageId)) {
      return fail("invalid_package_id", "审计包标识非法");
    }
    if (typeof pkg.producerId !== "string" || !pkg.producerId ||
        pkg.producerId.length > 100) {
      return fail("invalid_producer", "生产者标识非法");
    }
    if (typeof pkg.name !== "string" || !pkg.name ||
        pkg.name.length > LIMITS.NAME_MAX_CHARS) {
      return fail("invalid_name", "审计包名称缺失或超长");
    }
    if (!isISODateString(pkg.createdAt) || !isISODateString(pkg.exportedAt)) {
      return fail("invalid_time", "审计包创建/导出时间不是合法 ISO 时间");
    }

    // ---- range ----
    var range = pkg.range;
    if (!range || typeof range !== "object") {
      return fail("missing_field", "审计包缺少时间范围 range");
    }
    if (range.from !== null && !isISODateString(range.from)) {
      return fail("invalid_range", "起始时间非法");
    }
    if (range.to !== null && !isISODateString(range.to)) {
      return fail("invalid_range", "结束时间非法");
    }
    if (range.from && range.to && Date.parse(range.from) > Date.parse(range.to)) {
      return fail("invalid_range", "起始时间晚于结束时间");
    }

    // ---- content ----
    var content = pkg.content;
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return fail("missing_field", "审计包内容 content 缺失或非法");
    }
    var contentFieldErr = null;
    ["tasks", "decisions", "executions", "events", "snapshots"].forEach(function (k) {
      if (!Array.isArray(content[k]) && !contentFieldErr) {
        contentFieldErr = fail("missing_field", "审计包内容缺少数组字段：" + k);
      }
    });
    if (contentFieldErr) return contentFieldErr;

    var limitMsg = checkContentLimits(content);
    if (limitMsg) return fail("package_too_large", limitMsg);

    // ---- 任务字段 ----
    var taskIds = Object.create(null);
    var decisionIds = Object.create(null);
    var snapshotIds = Object.create(null);
    var executionIds = Object.create(null);
    var errors = [];

    content.tasks.forEach(function (t) {
      if (!t || typeof t !== "object") { errors.push("存在非法任务条目"); return; }
      ["id", "status", "createdAt"].forEach(function (k) {
        if (!(k in t) || t[k] == null) errors.push("任务 " + (t && t.id) + " 缺字段 " + k);
      });
      if (typeof t.id !== "string") return;
      if (taskIds[t.id]) errors.push("任务 id 重复：" + t.id);
      taskIds[t.id] = true;
      if (t.decisionId) decisionIds[t.decisionId] = true;
      if (t.snapshotId) snapshotIds[t.snapshotId] = true;
      if (t.approvalSnapshotId) snapshotIds[t.approvalSnapshotId] = true;
      (t.dependencyIds || []).forEach(function (dep) {
        // 跨任务引用：依赖必须在包内（稍后统一报告）
      });
      if (t.lock && !Array.isArray(t.lock.paragraphs)) {
        errors.push("任务 " + t.id + " 的锁定文本 paragraphs 不是数组");
      }
      if (t.approval) {
        if (!Array.isArray(t.approval.approvers) || !t.approval.approvers.length) {
          errors.push("任务 " + t.id + " 的审批人名单为空");
        }
        if (!Number.isInteger(t.approval.minApprovals) ||
            t.approval.minApprovals < 1 ||
            t.approval.minApprovals > (t.approval.approvers || []).length) {
          errors.push("任务 " + t.id + " 的最少通过人数非法");
        }
      }
    });
    if (errors.length) return fail("invalid_task", "任务数据校验失败：" + errors[0], errors);

    // ---- 草案 / 快照 / 执行记录 ----
    content.decisions.forEach(function (d) {
      if (!d || typeof d.id !== "string") {
        errors.push("存在缺 id 的草案条目"); return;
      }
      if (decisionIds[d.id] === "declared") errors.push("草案 id 重复：" + d.id);
      decisionIds[d.id] = "declared";
    });
    content.snapshots.forEach(function (s) {
      if (!s || typeof s.id !== "string") { errors.push("存在缺 id 的快照条目"); return; }
      if (snapshotIds[s.id] === "declared") errors.push("快照 id 重复：" + s.id);
      snapshotIds[s.id] = "declared";
    });
    content.executions.forEach(function (ex) {
      if (!ex || typeof ex.id !== "string") { errors.push("存在缺 id 的执行记录"); return; }
      if (executionIds[ex.id]) errors.push("执行记录 id 重复：" + ex.id);
      executionIds[ex.id] = true;
      if (!taskIds[ex.taskId]) errors.push("执行记录 " + ex.id + " 引用了包内不存在的任务");
      (ex.results || []).forEach(function (r) {
        if (!r || ["success", "conflict", "skipped"].indexOf(r.result) === -1) {
          errors.push("执行记录 " + ex.id + " 含非法逐条结果");
        }
      });
    });
    if (errors.length) {
      return fail("invalid_content", "包内容校验失败：" + errors[0], errors);
    }

    // ---- 跨任务引用：依赖任务必须存在 ----
    content.tasks.forEach(function (t) {
      (t.dependencyIds || []).forEach(function (dep) {
        if (!taskIds[dep]) {
          errors.push("任务 " + t.id + " 的前置任务 " + dep + " 不在审计包内");
        }
        if (dep === t.id) errors.push("任务 " + t.id + " 存在自依赖");
      });
    });
    if (errors.length) {
      return fail("cross_reference_missing", "跨任务引用校验失败：" + errors[0], errors);
    }

    // ---- 事件：必填、重复、归属、时间、链顺序 ----
    var eventIds = Object.create(null);
    var prevAtMs = null;
    var expectedPrev = null;
    content.events.forEach(function (ev, idx) {
      var label = "第 " + (idx + 1) + " 条事件";
      if (!ev || typeof ev !== "object") { errors.push(label + " 不是对象"); return; }
      ["id", "taskId", "at", "action", "category"].forEach(function (k) {
        if (ev[k] === undefined || ev[k] === null || ev[k] === "") {
          errors.push(label + " 缺字段 " + k);
        }
      });
      if (typeof ev.id !== "string") return;
      if (eventIds[ev.id]) errors.push("事件 id 重复：" + ev.id);
      eventIds[ev.id] = true;
      if (!taskIds[ev.taskId]) {
        errors.push("事件 " + ev.id + " 引用了包内不存在的任务 " + ev.taskId);
      }
      if (!isISODateString(ev.at)) {
        errors.push("事件 " + ev.id + " 时间非法");
      } else {
        var ms = Date.parse(ev.at);
        if (ev.seq !== idx + 1) errors.push("事件 " + ev.id + " 序号断裂");
        if (prevAtMs !== null && ms < prevAtMs) {
          errors.push("事件时间倒退：" + ev.id + "（" + ev.at + "）早于前一事件");
        }
        prevAtMs = ms;
      }
      if (EVENT_CATEGORIES.indexOf(ev.category) === -1) {
        errors.push("事件 " + ev.id + " 类别非法：" + ev.category);
      }
      if (categoryOfAction(ev.action) !== ev.category) {
        errors.push("事件 " + ev.id + " 的类别与动作不一致");
      }
      if ((ev.prevEventId || null) !== (expectedPrev || null)) {
        errors.push("事件链断裂：" + ev.id + " 的 prevEventId 不指向前一事件");
      }
      if (ev.executionId && !executionIds[ev.executionId]) {
        errors.push("事件 " + ev.id + " 引用了包内不存在的执行记录 " + ev.executionId);
      }
      if (ev.snapshotId && snapshotIds[ev.snapshotId] !== "declared") {
        errors.push("事件 " + ev.id + " 引用了包内不存在的快照 " + ev.snapshotId);
      }
      expectedPrev = ev.id;
    });
    if (errors.length) {
      var code = errors[0].indexOf("重复") !== -1 ? "duplicate_event"
        : errors[0].indexOf("倒退") !== -1 ? "event_time_regression"
        : errors[0].indexOf("断裂") !== -1 ? "broken_event_chain"
        : "invalid_event";
      return fail(code, "事件链校验失败：" + errors[0], errors);
    }

    // ---- 快照/任务交叉引用 ----
    content.tasks.forEach(function (t) {
      if (t.snapshotId && snapshotIds[t.snapshotId] !== "declared") {
        errors.push("任务 " + t.id + " 关联快照 " + t.snapshotId + " 不在包内");
      }
      if (t.approvalSnapshotId && snapshotIds[t.approvalSnapshotId] !== "declared") {
        errors.push("任务 " + t.id + " 审批快照 " + t.approvalSnapshotId + " 不在包内");
      }
      if (t.decisionId && decisionIds[t.decisionId] !== "declared") {
        errors.push("任务 " + t.id + " 关联草案 " + t.decisionId + " 不在包内");
      }
    });
    if (errors.length) {
      return fail("cross_reference_missing", "引用校验失败：" + errors[0], errors);
    }

    // ---- manifest 与内容哈希 ----
    var manifest = pkg.manifest;
    if (!manifest || typeof manifest !== "object") {
      return fail("missing_manifest", "审计包缺少 manifest");
    }
    var expectedManifest = buildManifest(pkg);
    if (manifest.format !== PACKAGE_FORMAT ||
        manifest.packageVersion !== pkg.packageVersion ||
        manifest.schemaVersion !== pkg.schemaVersion ||
        manifest.packageId !== pkg.packageId ||
        manifest.producerId !== pkg.producerId) {
      return fail("manifest_mismatch", "manifest 与包标识不一致");
    }
    if (manifest.eventCount !== content.events.length) {
      return fail("manifest_mismatch", "manifest 事件计数与内容不一致");
    }
    var recomputed = hashCanonical(content);
    if (manifest.contentHash !== recomputed) {
      return fail("hash_mismatch",
        "内容哈希不匹配：审计包可能已被改动（期望 " + recomputed + "）");
    }
    var chain = chainHashes(content.events);
    if (manifest.chainHead !== chain.head ||
        (content.events.length && manifest.chainHeadId !== chain.headId)) {
      return fail("chain_hash_mismatch", "事件链哈希不匹配：事件顺序或内容与导出时不一致");
    }
    if (manifest.contentHashSha256) {
      var expectSha = sha256Canonical(content);
      if (expectSha && manifest.contentHashSha256 !== expectSha) {
        return fail("hash_mismatch", "内容 SHA-256 哈希不匹配");
      }
    }

    return { ok: true, value: pkg, errors: [] };
  }

  /* ================= 时间线筛选（回放视图） ================= */

  function filterEvents(events, opts) {
    opts = opts || {};
    return (events || []).filter(function (ev) {
      if (opts.taskId && ev.taskId !== opts.taskId) return false;
      if (opts.category && ev.category !== opts.category) return false;
      if (opts.action && ev.action !== opts.action) return false;
      if (opts.annotationId && ev.annotationId !== opts.annotationId) return false;
      if (opts.from && Date.parse(ev.at) < Date.parse(opts.from)) return false;
      if (opts.to && Date.parse(ev.at) > Date.parse(opts.to)) return false;
      return true;
    });
  }

  // 时间线分组：按任务聚合，组内按链顺序
  function timelineByTask(content, opts) {
    var filtered = filterEvents(content.events, opts);
    var map = Object.create(null);
    var order = [];
    filtered.forEach(function (ev) {
      if (!map[ev.taskId]) { map[ev.taskId] = []; order.push(ev.taskId); }
      map[ev.taskId].push(ev);
    });
    return order.map(function (taskId) {
      var task = (content.tasks || []).filter(function (t) { return t.id === taskId; })[0] || null;
      return {
        taskId: taskId,
        task: task,
        events: map[taskId] // 已是链顺序（filter 不改变顺序）
      };
    });
  }

  // 冲突原因汇总（逐条结果中 result=conflict 的原因分布）
  function conflictSummary(content) {
    var counts = Object.create(null);
    var items = [];
    (content.executions || []).forEach(function (ex) {
      (ex.results || []).forEach(function (r) {
        if (r.result === "conflict") {
          counts[r.reason || "unknown"] = (counts[r.reason || "unknown"] || 0) + 1;
          items.push({
            executionId: ex.id, taskId: ex.taskId,
            annotationId: r.annotationId, reason: r.reason || "unknown",
            paraIndex: r.paraIndex, at: r.at
          });
        }
      });
    });
    return { counts: counts, items: items };
  }

  return {
    PACKAGE_FORMAT: PACKAGE_FORMAT,
    PACKAGE_VERSION: PACKAGE_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    LIMITS: LIMITS,
    EVENT_CATEGORIES: EVENT_CATEGORIES,
    ACTION_CATEGORY: ACTION_CATEGORY,
    categoryOfAction: categoryOfAction,
    stableStringify: stableStringify,
    hashCanonical: hashCanonical,
    sha256Canonical: sha256Canonical,
    isISODateString: isISODateString,
    inRange: inRange,
    buildPackage: buildPackage,
    buildManifest: buildManifest,
    chainHashes: chainHashes,
    verifyPackage: verifyPackage,
    checkContentLimits: checkContentLimits,
    filterEvents: filterEvents,
    timelineByTask: timelineByTask,
    conflictSummary: conflictSummary
  };
});
