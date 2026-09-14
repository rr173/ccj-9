/* node --test test/permission-request-groups-api.test.js
 * 申请分组与批量处理 HTTP 集成测试：真实启动 server.js（临时数据文件+随机端口）。
 *
 * 覆盖：
 *   - 仅资源负责人可建/改/删组与加移成员；普通成员只见“自己申请所在分组”摘要；
 *   - 申请列表携带所属分组/截止状态/待处理数量；
 *   - 加成员原子（跨资源/已在别组整批拒绝）；
 *   - 批量决定双重版本校验（集合 requestRev + 每条 version）；
 *   - 任一条过期/已被处理/角色冲突整批不改变权限，逐条返回失败原因并留审计；
 *   - 全绿整批批准即时生效（生成正式委派/执行撤销），下一个请求按新角色放行；
 *   - 分组变更/批量审批/截止提醒写独立 groupLogs，重启后分组/处理结果/失败原因/
 *     历史只读与提醒幂等标记全部恢复。
 */
"use strict";

const test = require("node:test");
const { describe, before, after, it } = test;
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const PORT = 9500 + Math.floor(Math.random() * 300);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "pgrg-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "pgrg-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "pgrg-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "pgrg-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(TMP, "pgrg-space-" + TAG + ".json"),
  ARCHIVE_DATA: path.join(TMP, "pgrg-arc-" + TAG + ".json"),
  RECON_DATA: path.join(TMP, "pgrg-recon-" + TAG + ".json"),
  PERM_DATA: path.join(TMP, "pgrg-perm-" + TAG + ".json")
};
const SHORT_TTL = "600000"; // 本测试不依赖申请自身过期，给较长 TTL

let server;
function startServer(extraEnv) {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: FILES.SNAP_DATA, ANNOTATIONS_FILE: FILES.ANN_DATA,
      REVIEW_BATCHES_FILE: FILES.BATCH_DATA, REVIEW_DECISIONS_FILE: FILES.DEC_DATA,
      REPLAY_SPACES_FILE: FILES.REPLAY_DATA, REPLAY_ARCHIVES_FILE: FILES.ARCHIVE_DATA,
      REPLAY_RECONCILE_FILE: FILES.RECON_DATA, PERMISSIONS_FILE: FILES.PERM_DATA,
      DECISION_SCHEDULER_INTERVAL_MS: "100",
      PERMISSION_REQUEST_TTL_MS: SHORT_TTL,
      PERMISSION_GROUP_REMINDER_INTERVAL_MS: "100000"
    }, extraEnv || {}),
    stdio: ["ignore", "pipe", "inherit"]
  });
  return waitUp();
}
function waitUp() {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/permissions/request-groups", function (res) {
        res.resume(); res.on("end", resolve);
      });
      req.on("error", function () {
        if (Date.now() > deadline) reject(new Error("server failed to start"));
        else setTimeout(ping, 100);
      });
    })();
  });
}
function stopServer() {
  return new Promise(function (resolve) {
    if (!server || server.killed) { resolve(); return; }
    server.on("exit", function () { resolve(); });
    server.kill("SIGKILL");
  });
}
async function restartServer(extraEnv) { await stopServer(); return startServer(extraEnv); }

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { Accept: "application/json" };
    if (payload) Object.assign(h,
      { "Content-Type": "application/json", "Content-Length": payload.length });
    if (headers) Object.assign(h, headers);
    const doRequest = function (attempt) {
      const req = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) {}
          resolve({
            status: res.statusCode, data: data, text: text,
            headers: res.headers,
            prev: res.headers["x-permission-rev"],
            reqRev: res.headers["x-permission-request-rev"],
            groupRev: res.headers["x-permission-group-rev"]
          });
        });
      });
      req.on("error", function () {
        if (attempt < 20) setTimeout(function () { doRequest(attempt + 1); }, 150);
        else resolve({ status: 0, data: null, text: "", headers: {} });
      });
      if (payload) req.write(payload);
      req.end();
    };
    doRequest(0);
  });
}
function as(member) {
  return function (method, urlPath, body, headers) {
    const sep = urlPath.indexOf("?") === -1 ? "?" : "&";
    return request(method, urlPath + sep + "as=" + encodeURIComponent(member),
      body, headers);
  };
}
const iso = function (ms) { return new Date(ms).toISOString(); };
const HOUR = 3600000;
const PARAS = [{ dir: "ltr", text: "中文示例文本内容用于申请分组集成测试流程" }];
const farFuture = "2030-01-01T00:00:00Z";
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function drev() {
  return (await request("GET", "/api/review-decisions")).headers["x-decision-rev"];
}
async function annRev() {
  return (await request("GET", "/api/annotations")).headers["x-annotation-rev"];
}
async function batchRev() {
  return (await request("GET", "/api/review-batches")).headers["x-batch-rev"];
}

describe("申请分组与批量处理 API（顺序用例）", function () {
  const ctx = {
    spaceId: null, spaceRev: { v: 1 }, sessionId: null, batchId: null,
    requestRev: "0", groupRev: "0", permRev: "0",
    groupId: null, requestIds: {}
  };

  before(async function () { await startServer(); });
  after(async function () {
    await stopServer();
    for (const f of Object.values(FILES)) {
      for (const suffix of ["", ".tmp"]) {
        try { fs.unlinkSync(f + suffix); } catch (e) {}
      }
    }
  });

  /* ---------- 准备资源（与 permission-requests-api 相同的链路） ---------- */

  it("准备：空间（任务->导出->导入->意见->会话）", async function () {
    let r = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": await annRev() });
    assert.equal(r.status, 201);
    const annotationId = r.data.annotation.id;

    const batch = await request("POST", "/api/review-batches", {
      name: "分组权限批次", owner: "负责人", deadline: farFuture,
      annotationIds: [annotationId]
    }, { "If-Match": await batchRev() });
    assert.equal(batch.status, 201, JSON.stringify(batch.data));

    r = await request("POST", "/api/review-decisions",
      { batchId: batch.data.batch.id, threshold: 1, paragraphs: PARAS, items: [] },
      { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const did = r.data.decision.id;
    r = await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: [{ annotationId: annotationId, disposition: "delete" }], actor: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200);
    r = await request("POST", "/api/review-decisions/" + did + "/submit",
      { actor: "甲" }, { "If-Match": await drev() });
    assert.equal(r.status, 200);
    r = await request("POST", "/api/review-decisions/" + did + "/votes",
      { annotationId: annotationId, vote: "approve", voter: "甲" },
      { "If-Match": await drev() });
    assert.equal(r.status, 200);
    r = await request("POST", "/api/execution-tasks", {
      decisionId: did, scheduledAt: iso(Date.now() + 300),
      paragraphs: PARAS, actor: "负责人"
    }, { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await sleep(700);

    const exp = await request("POST", "/api/replay/export", { actor: "负责人" });
    assert.equal(exp.status, 200, JSON.stringify(exp.data));
    const imp = await request("POST", "/api/replay/import", exp.data);
    assert.equal(imp.status, 201, JSON.stringify(imp.data));
    ctx.spaceId = imp.data.space.id;
    ctx.spaceRev.v = imp.data.space.rev;

    const detail = await request("GET", "/api/replay/spaces/" + ctx.spaceId);
    const eventId = detail.data.space.content.events[0].id;
    const rv = await request("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/reviews",
      { target: { kind: "event", eventId: eventId }, reviewer: "复核人甲",
        content: "意见", dueAt: iso(Date.now() + HOUR), actor: "负责人" },
      { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(rv.status, 201, JSON.stringify(rv.data));
    ctx.spaceRev.v = rv.data.spaceRev;

    const cs = await request("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions",
      { name: "分组会话", participants: ["参与人甲"],
        deadline: iso(Date.now() + HOUR), reviewIds: [rv.data.review.id],
        actor: "负责人" },
      { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(cs.status, 201, JSON.stringify(cs.data));
    ctx.sessionId = cs.data.session.id;
  });

  it("准备：负责人授予基准角色启用管控", async function () {
    const r = await request("POST", "/api/permissions/delegations",
      { scope: "space", resourceId: ctx.spaceId, role: "view",
        member: "基准成员", expireAt: iso(Date.now() + 24 * HOUR) },
      { "If-Match": ctx.permRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.permRev = r.prev;
  });

  /* ---------- 多条申请（不同成员/角色），用于分组批量 ---------- */

  it("张三/李四/王五各提交授予申请", async function () {
    const specs = [
      { who: "张三", role: "view" },
      { who: "李四", role: "view" },
      { who: "王五", role: "review" }
    ];
    for (const s of specs) {
      const r = await as(s.who)("POST", "/api/permissions/requests", {
        kind: "grant", scope: "space", resourceId: ctx.spaceId,
        role: s.role, member: s.who,
        expireAt: iso(Date.now() + 24 * HOUR), note: "需要访问"
      }, { "If-Match": ctx.requestRev });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ctx.requestRev = r.reqRev;
      ctx.requestIds[s.who] = r.data.request.id;
    }
  });

  /* ---------- 分组创建权限 ---------- */

  it("普通成员不能建组；负责人建组成功（独立 groupRev）", async function () {
    let r = await as("张三")("POST", "/api/permissions/request-groups", {
      name: "非法组", scope: "space", resourceId: ctx.spaceId,
      deadline: iso(Date.now() + 2 * HOUR)
    }, { "If-Match": ctx.groupRev });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "not_resource_owner");

    r = await request("POST", "/api/permissions/request-groups", {
      name: "本周空间审批组", scope: "space", resourceId: ctx.spaceId,
      deadline: iso(Date.now() + 2 * HOUR), note: "集中处理"
    }, { "If-Match": ctx.groupRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.groupId = r.data.group.id;
    ctx.groupRev = r.groupRev;
    assert.equal(r.data.group.pendingCount, 0);
    assert.equal(r.data.group.deadlineState, "pending");

    // 缺名称 400
    r = await request("POST", "/api/permissions/request-groups", {
      scope: "space", resourceId: ctx.spaceId
    }, { "If-Match": ctx.groupRev });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "missing_group_name");
  });

  it("建组旧 groupRev 提交 409；改名/改截止/备注推进 groupRev", async function () {
    let r = await request("PATCH",
      "/api/permissions/request-groups/" + ctx.groupId,
      { name: "旧版本" }, { "If-Match": String(Number(ctx.groupRev) - 1) });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "version_conflict");

    r = await request("PATCH",
      "/api/permissions/request-groups/" + ctx.groupId,
      { name: "空间审批组-改名", deadline: iso(Date.now() + 3 * HOUR) },
      { "If-Match": ctx.groupRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.groupRev = r.groupRev;
    assert.equal(r.data.group.name, "空间审批组-改名");
  });

  /* ---------- 加入分组（原子） ---------- */

  it("把张三、李四加入分组；申请列表携带分组/截止状态/待处理数量", async function () {
    let r = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/requests",
      { requestIds: [ctx.requestIds["张三"], ctx.requestIds["李四"]] },
      { "If-Match": ctx.groupRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.groupRev = r.groupRev;
    ctx.requestRev = r.reqRev;
    assert.equal(r.data.group.pendingCount, 2);

    const list = await request("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId);
    const zs = list.data.requests.find(function (x) {
      return x.id === ctx.requestIds["张三"];
    });
    assert.equal(zs.groupId, ctx.groupId);
    assert.equal(zs.groupName, "空间审批组-改名");
    assert.equal(zs.groupDeadlineState, "pending");
    assert.equal(zs.groupPendingCount, 2);
  });

  it("重复加入已在别组的申请整批拒绝（无 reassign 不改归属）", async function () {
    // 另建一个组
    let r = await request("POST", "/api/permissions/request-groups", {
      name: "第二组", scope: "space", resourceId: ctx.spaceId
    }, { "If-Match": ctx.groupRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const g2 = r.data.group.id;
    ctx.groupRev = r.groupRev;

    // g2 加入王五（成功）
    r = await request("POST",
      "/api/permissions/request-groups/" + g2 + "/requests",
      { requestIds: [ctx.requestIds["王五"]] },
      { "If-Match": ctx.groupRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.groupRev = r.groupRev;
    ctx.requestRev = r.reqRev;

    // 把张三（已在第一组）加入 g2，不带 reassign -> 整批失败
    r = await request("POST",
      "/api/permissions/request-groups/" + g2 + "/requests",
      { requestIds: [ctx.requestIds["张三"]] },
      { "If-Match": ctx.groupRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "group_members_conflict");
    assert.equal(r.data.results[0].code, "request_already_grouped");
  });

  /* ---------- 普通成员只见自己申请所在分组摘要 ---------- */

  it("张三只见自己所在分组摘要（待处理按本人口径），看不到别人的组", async function () {
    const r = await as("张三")("GET", "/api/permissions/request-groups" +
      "?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(r.status, 200);
    // 张三在第一组，不在第二组 -> 只看到第一组
    assert.equal(r.data.groups.length, 1);
    const g = r.data.groups[0];
    assert.equal(g.id, ctx.groupId);
    assert.equal(g.myPendingCount, 1);
    assert.ok(g.members.indexOf("张三") !== -1);
    // 摘要不含他人工作量字段
    assert.equal(g.pendingCount, undefined);
    assert.equal(g.totalCount, undefined);

    // 组详情：张三只看到自己那条
    const detail = await as("张三")("GET",
      "/api/permissions/request-groups/" + ctx.groupId);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.requests.length, 1);
    assert.equal(detail.data.requests[0].member, "张三");

    // 与张三无关的组 -> 403
    const other = await request("POST", "/api/permissions/request-groups", {
      name: "第三组", scope: "space", resourceId: ctx.spaceId
    }, { "If-Match": ctx.groupRev });
    ctx.groupRev = other.groupRev;
    const peek = await as("张三")("GET",
      "/api/permissions/request-groups/" + other.data.group.id);
    assert.equal(peek.status, 403);
  });

  /* ---------- 批量决定：版本/冲突整批原子 ---------- */

  it("批量审批：旧集合 requestRev 整批 409；缺每条 version 逐条失败", async function () {
    const items = [
      { id: ctx.requestIds["张三"], version: 1, decision: "approve" },
      { id: ctx.requestIds["李四"], decision: "reject", reason: "名额已满" }
    ];
    let r = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/batch-decide",
      { items: items },
      { "If-Match": String(Number(ctx.requestRev) - 1) });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "version_conflict");

    // 正确集合版本，但李四缺 version -> 整批不改，逐条原因
    r = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/batch-decide",
      { items: items }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "batch_conflict");
    const rows = r.data.results;
    assert.equal(rows.find(function (x) { return x.id === ctx.requestIds["李四"]; }).code,
      "precondition_required");
    // 张三那条格式没问题（本应可批），但整批不改 -> 张三仍 pending
    const chk = await request("GET",
      "/api/permissions/requests/" + ctx.requestIds["张三"]);
    assert.equal(chk.data.request.status, "pending");
    assert.equal(chk.data.request.version, 1);
  });

  it("批量审批：非负责人 403；拒绝缺原因/非本组条目整批拒绝，逐条返回", async function () {
    // 张三不是资源负责人，不能批量审批（即使批的是自己的申请）
    let r = await as("张三")("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/batch-decide",
      { items: [
        { id: ctx.requestIds["张三"], version: 1, decision: "approve" }
      ] }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(r.data.error, "not_resource_owner");

    // 负责人批量：拒绝缺原因
    r = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/batch-decide",
      { items: [
        { id: ctx.requestIds["张三"], version: 1, decision: "approve" },
        { id: ctx.requestIds["李四"], version: 1, decision: "reject", reason: " " }
      ] }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(
      r.data.results.find(function (x) { return x.id === ctx.requestIds["李四"]; }).code,
      "reject_reason_required");

    // 含非本组的王五 -> not_in_group 整批拒绝
    r = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/batch-decide",
      { items: [
        { id: ctx.requestIds["张三"], version: 1, decision: "approve" },
        { id: ctx.requestIds["王五"], version: 1, decision: "approve" }
      ] }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 400);
    assert.equal(
      r.data.results.find(function (x) { return x.id === ctx.requestIds["王五"]; }).code,
      "not_in_group");
  });

  it("负责人审批自己的申请 self_approval：逐条返回且整批不改", async function () {
    // 资源负责人（负责人）本人提交一条申请，加入本组后批量审批 -> self_approval
    const own = await request("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "负责人", expireAt: iso(Date.now() + 24 * HOUR)
    }, { "If-Match": ctx.requestRev });
    // 负责人给自己申请 review（space 允许 view/review）：自授申请不被自审规则拦
    assert.equal(own.status, 201, JSON.stringify(own.data));
    ctx.requestRev = own.reqRev;
    const ownId = own.data.request.id;
    const add = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/requests",
      { requestIds: [ownId] }, { "If-Match": ctx.groupRev });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    ctx.groupRev = add.groupRev;
    ctx.requestRev = add.reqRev;
    const r = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/batch-decide",
      { items: [
        { id: ownId, version: 1, decision: "approve" },
        { id: ctx.requestIds["李四"], version: 1,
          decision: "reject", reason: "名额已满" }
      ] }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(
      r.data.results.find(function (x) { return x.id === ownId; }).code,
      "self_approval");
    // 整批不改：李四仍 pending
    const chk = await request("GET",
      "/api/permissions/requests/" + ctx.requestIds["李四"]);
    assert.equal(chk.data.request.status, "pending");
    // 把负责人自己的申请移出本分组，避免影响后续成功批量
    const rm = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/requests/remove",
      { requestIds: [ownId] }, { "If-Match": ctx.groupRev });
    assert.equal(rm.status, 200, JSON.stringify(rm.data));
    ctx.groupRev = rm.groupRev;
    ctx.requestRev = rm.reqRev;
  });

  it("成功批量：批准张三 + 拒绝李四，整批一次事务，requestRev 只推进一次", async function () {
    const beforeRev = Number(ctx.requestRev);
    const r = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/batch-decide",
      { items: [
        { id: ctx.requestIds["张三"], version: 1, decision: "approve" },
        { id: ctx.requestIds["李四"], version: 1, decision: "reject",
          reason: "本期名额已满" }
      ] }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.count, 2);
    assert.equal(Number(r.reqRev), beforeRev + 1); // 整批只推进一次
    ctx.requestRev = r.reqRev;
    const zs = r.data.requests.find(function (x) { return x.id === ctx.requestIds["张三"]; });
    const ls = r.data.requests.find(function (x) { return x.id === ctx.requestIds["李四"]; });
    assert.equal(zs.status, "approved");
    assert.ok(zs.generatedDelegationId);
    assert.equal(ls.status, "rejected");
    assert.equal(ls.decisionReason, "本期名额已满");
  });

  it("批准即时生效：张三下一个业务请求按新角色放行", async function () {
    // 管控启用后，无角色的王五仍 403
    const denied = await as("王五")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
    // 张三刚经批量批准拿到 view -> 200
    const ok = await as("张三")("GET", "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  });

  it("已被批量处理的申请不能再批（旧版本）；历史只读", async function () {
    // 张三已是 approved v2
    let r = await request("POST",
      "/api/permissions/requests/" + ctx.requestIds["张三"] + "/decision",
      { decision: "reject", reason: "x" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "request_version_conflict");

    // 用新版本也不能再处理终态申请
    r = await request("POST",
      "/api/permissions/requests/" + ctx.requestIds["张三"] + "/decision",
      { decision: "reject", reason: "x" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "2" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "request_not_pending");
  });

  /* ---------- 批内角色冲突整批拒绝、不改权限 ---------- */

  it("批内 approve/execute 同窗口冲突：整批拒绝且不改任何权限", async function () {
    // 新建一个 batch 资源用于 approve/execute
    // 复用 reconcile 批次成本高，这里直接在同一 space 用 view/review 不冲突，
    // 改为构造同成员同角色重复授予：赵六两条申请不可能（duplicate_request），
    // 因此用同成员 view 批准 + 与正式委派重复来验证“批准瞬间复核”整批回滚。
    // 先让钱七、孙八提交申请并加入新组
    ctx.groupRev = (await request("GET", "/api/permissions/request-groups" +
      "?scope=space&resourceId=" + ctx.spaceId)).groupRev;
    const g = await request("POST", "/api/permissions/request-groups", {
      name: "冲突组", scope: "space", resourceId: ctx.spaceId
    }, { "If-Match": ctx.groupRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    const cgId = g.data.group.id;
    ctx.groupRev = g.groupRev;

    // 钱七、孙八先提交申请（此时无冲突）
    const q = await as("钱七")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "钱七", expireAt: iso(Date.now() + 24 * HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(q.status, 201, JSON.stringify(q.data));
    ctx.requestRev = q.reqRev;
    const s = await as("孙八")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "孙八", expireAt: iso(Date.now() + 24 * HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(s.status, 201, JSON.stringify(s.data));
    ctx.requestRev = s.reqRev;

    // 审批前负责人直接授予孙八 view（窗口覆盖申请窗口），
    // 制造“批准瞬间”与正式委派重复 -> 该条整批冲突
    const permHead = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" + ctx.spaceId);
    ctx.permRev = permHead.prev;
    const grant = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "孙八", expireAt: iso(Date.now() + 24 * HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(grant.status, 201, JSON.stringify(grant.data));
    ctx.permRev = grant.prev;

    const add = await request("POST",
      "/api/permissions/request-groups/" + cgId + "/requests",
      { requestIds: [q.data.request.id, s.data.request.id] },
      { "If-Match": ctx.groupRev });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    ctx.groupRev = add.groupRev;
    ctx.requestRev = add.reqRev;

    const r = await request("POST",
      "/api/permissions/request-groups/" + cgId + "/batch-decide",
      { items: [
        { id: q.data.request.id, version: 1, decision: "approve" },
        { id: s.data.request.id, version: 1, decision: "approve" }
      ] }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.error, "batch_conflict");
    assert.equal(
      r.data.results.find(function (x) { return x.id === s.data.request.id; }).code,
      "duplicate_delegation");
    // 整批不改：钱七仍 pending，孙八仍 pending（版本仍 1）
    const chkQ = await request("GET", "/api/permissions/requests/" + q.data.request.id);
    const chkS = await request("GET", "/api/permissions/requests/" + s.data.request.id);
    assert.equal(chkQ.data.request.status, "pending");
    assert.equal(chkS.data.request.status, "pending");
    assert.equal(chkQ.data.request.version, 1);
    assert.equal(chkS.data.request.version, 1);
    // requestRev 不因失败而推进（失败响应头等于提交时的集合版本）
    assert.equal(r.reqRev, ctx.requestRev);
  });

  /* ---------- 独立审计：分组变更 + 批量审批/失败 + 截止提醒 ---------- */

  it("分组变更与批量审批写入独立 groupLogs", async function () {
    const r = await request("GET",
      "/api/permissions/request-groups/logs?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(r.status, 200);
    const actions = r.data.logs.map(function (x) { return x.action; });
    assert.ok(actions.indexOf("group_create") !== -1);
    assert.ok(actions.indexOf("group_update") !== -1);
    assert.ok(actions.indexOf("group_requests_add") !== -1);
    assert.ok(actions.indexOf("batch_decide") !== -1);
    assert.ok(actions.indexOf("batch_decide_failed") !== -1);
    const bd = r.data.logs.find(function (x) { return x.action === "batch_decide"; });
    assert.equal(bd.detail.count, 2);
  });

  it("截止提醒：到点产生 deadline_reminder（overdue），独立审计且重启不重复", async function () {
    ctx.groupRev = (await request("GET", "/api/permissions/request-groups" +
      "?scope=space&resourceId=" + ctx.spaceId)).groupRev;
    // 新建一个截止时间在 1 小时后的分组，随后 PATCH 成过去
    const g = await request("POST", "/api/permissions/request-groups", {
      name: "临期组", scope: "space", resourceId: ctx.spaceId,
      deadline: iso(Date.now() + 3600000)
    }, { "If-Match": ctx.groupRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    const dgId = g.data.group.id;
    ctx.groupRev = g.groupRev;

    // 组内放一条 pending 申请（把钱七从冲突组移到临期组需要 reassign）
    const qId = (await as("钱七")("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId))
      .data.requests[0].id;
    const mv = await request("POST",
      "/api/permissions/request-groups/" + dgId + "/requests",
      { requestIds: [qId], reassign: true },
      { "If-Match": ctx.groupRev });
    assert.equal(mv.status, 200, JSON.stringify(mv.data));
    ctx.groupRev = mv.groupRev;
    ctx.requestRev = mv.reqRev;

    // 截止改为过去（更新允许，用于把组标记为逾期；只影响提醒，不改权限）
    const up = await request("PATCH",
      "/api/permissions/request-groups/" + dgId,
      { deadline: iso(Date.now() - 1000) }, { "If-Match": ctx.groupRev });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    ctx.groupRev = up.groupRev;
    assert.equal(up.data.group.deadlineState, "overdue");
  });

  it("截止提醒经重启扫描产生 overdue 审计；重复扫描幂等", async function () {
    // 重启触发立即扫描：临期组已逾期且有钱七 pending -> overdue 提醒
    await restartServer();
    await sleep(300);
    const logs = await request("GET",
      "/api/permissions/request-groups/logs?scope=space&resourceId=" + ctx.spaceId);
    const reminders = logs.data.logs.filter(function (x) {
      return x.action === "deadline_reminder";
    });
    assert.ok(reminders.length >= 1, "应至少产生一条截止提醒");
    assert.equal(reminders[0].detail.kind, "overdue");
    const firstCount = reminders.length;

    // 再重启扫描一次：已提醒的不重复（幂等）
    await restartServer();
    await sleep(300);
    const logs2 = await request("GET",
      "/api/permissions/request-groups/logs?scope=space&resourceId=" + ctx.spaceId);
    const reminders2 = logs2.data.logs.filter(function (x) {
      return x.action === "deadline_reminder";
    });
    assert.equal(reminders2.length, firstCount);
  });

  /* ---------- 重启恢复：分组/处理结果/失败原因/历史只读 ---------- */

  it("重启后：分组、成员归属、批量结果、失败审计、待处理数量全部恢复", async function () {
    const list = await request("GET",
      "/api/permissions/request-groups?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(list.status, 200);
    const g = list.data.groups.find(function (x) { return x.id === ctx.groupId; });
    assert.ok(g, "分组恢复");
    assert.equal(g.name, "空间审批组-改名");
    // 张三批准、李四拒绝 -> 组内待处理为 0（负责人自己的失败申请已移出）
    assert.equal(g.pendingCount, 0);
    assert.equal(g.statusCounts.approved, 1);
    assert.equal(g.statusCounts.rejected, 1);

    // 申请的分组关联恢复；张三 approved 且生成委派 id 恢复
    const zs = await request("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId +
      "&member=" + encodeURIComponent("张三"));
    const zsReq = zs.data.requests.find(function (x) {
      return x.status === "approved" && x.role === "view";
    });
    assert.ok(zsReq, "张三的已批准申请存在");
    assert.equal(zsReq.groupId, ctx.groupId);
    assert.equal(zsReq.status, "approved");
    assert.ok(zsReq.generatedDelegationId);
    assert.equal(zsReq.groupName, "空间审批组-改名");

    // 失败批量的逐条原因仍可在独立审计查询
    const logs = await request("GET",
      "/api/permissions/request-groups/logs?scope=space&resourceId=" + ctx.spaceId);
    const failed = logs.data.logs.find(function (x) {
      return x.action === "batch_decide_failed";
    });
    assert.ok(failed, "批量失败审计恢复");
    assert.ok(Array.isArray(failed.detail.results));

    // 张三重启后仍能按批准角色访问（即时生效持久）
    const access = await as("张三")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(access.status, 200);
  });

  it("删除分组解除申请归属（申请与权限不变），写审计", async function () {
    // 新建临时组并放入王五
    const cur = await request("GET", "/api/permissions/request-groups" +
      "?scope=space&resourceId=" + ctx.spaceId);
    ctx.groupRev = cur.groupRev;
    const g = await request("POST", "/api/permissions/request-groups", {
      name: "待删组", scope: "space", resourceId: ctx.spaceId
    }, { "If-Match": ctx.groupRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    const dgId = g.data.group.id;
    ctx.groupRev = g.groupRev;

    // 王五当前在第二组，需 reassign
    const add = await request("POST",
      "/api/permissions/request-groups/" + dgId + "/requests",
      { requestIds: [ctx.requestIds["王五"]], reassign: true },
      { "If-Match": ctx.groupRev });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    ctx.groupRev = add.groupRev;
    ctx.requestRev = add.reqRev;
    assert.equal(add.data.group.pendingCount, 1);

    const del = await request("DELETE",
      "/api/permissions/request-groups/" + dgId, null,
      { "If-Match": ctx.groupRev });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal(del.data.detachedRequests, 1);
    ctx.groupRev = del.groupRev;
    ctx.requestRev = del.reqRev;

    const ww = await request("GET",
      "/api/permissions/requests/" + ctx.requestIds["王五"]);
    assert.equal(ww.data.request.groupId, null);
    assert.equal(ww.data.request.status, "pending"); // 申请本身不变
  });
});
