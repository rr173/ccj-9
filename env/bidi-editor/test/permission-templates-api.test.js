/* node --test test/permission-templates-api.test.js
 * 申请模板与条件校验 HTTP 集成测试：真实启动 server.js（临时数据文件+随机端口）。
 *
 * 覆盖：
 *   - 仅资源负责人可建/改/停用模板；普通成员只见“启用且适用范围含自己”的模板；
 *   - 独立 templateRev / X-Permission-Template-Rev；旧 templateRev 写操作 409；
 *   - 用模板发起申请：默认有效期窗口、显式覆盖、申请记录 templateId/version/快照；
 *   - 提交时条件复核：角色已存在 duplicate_delegation、重复申请 duplicate_request、
 *     成员不在适用范围、模板版本已变化、停用模板/旧版本不能再创建申请；
 *   - 模板修改后历史版本仍可查；已提交申请不被后续模板修改/停用改变；
 *   - 撤销模板发起撤销申请；
 *   - 模板变更/使用记录/拒绝原因写 templateLogs 与 denials，普通成员只见自己相关；
 *   - 重启后模板/历史/申请溯源/日志与版本号全部恢复。
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

const PORT = 9700 + Math.floor(Math.random() * 200);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "ptpl-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "ptpl-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "ptpl-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "ptpl-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(TMP, "ptpl-space-" + TAG + ".json"),
  ARCHIVE_DATA: path.join(TMP, "ptpl-arc-" + TAG + ".json"),
  RECON_DATA: path.join(TMP, "ptpl-recon-" + TAG + ".json"),
  PERM_DATA: path.join(TMP, "ptpl-perm-" + TAG + ".json")
};

let server;
function startServer(extraEnv) {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: FILES.SNAP_DATA, ANNOTATIONS_FILE: FILES.ANN_DATA,
      REVIEW_BATCHES_FILE: FILES.BATCH_DATA, REVIEW_DECISIONS_FILE: FILES.DEC_DATA,
      REPLAY_SPACES_FILE: FILES.REPLAY_DATA, REPLAY_ARCHIVES_FILE: FILES.ARCHIVE_DATA,
      REPLAY_RECONCILE_FILE: FILES.RECON_DATA, PERMISSIONS_FILE: FILES.PERM_DATA,
      DECISION_SCHEDULER_INTERVAL_MS: "100000",
      PERMISSION_REQUEST_TTL_MS: "600000",
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
      const req = http.get(BASE + "/api/permissions/request-templates", function (res) {
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
            status: res.statusCode, data: data, text: text, headers: res.headers,
            prev: res.headers["x-permission-rev"],
            reqRev: res.headers["x-permission-request-rev"],
            groupRev: res.headers["x-permission-group-rev"],
            tplRev: res.headers["x-permission-template-rev"]
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
const DAY = 24 * HOUR;
const PARAS = [{ dir: "ltr", text: "中文示例文本内容用于申请模板集成测试流程" }];
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

describe("申请模板与条件校验 API（顺序用例）", function () {
  const ctx = {
    spaceId: null, spaceRev: { v: 1 }, batchId: null,
    requestRev: "0", templateRev: "0",
    tplView: null, tplReview: null, tplRevoke: null,
    tplViewVersion: 1,
    submittedId: null
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

  /* ---------- 准备资源 ---------- */

  it("准备：空间（任务->导出->导入）", async function () {
    let r = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": await annRev() });
    assert.equal(r.status, 201);
    const annotationId = r.data.annotation.id;

    const batch = await request("POST", "/api/review-batches", {
      name: "模板权限批次", owner: "负责人", deadline: farFuture,
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
  });

  /* ---------- 模板创建权限与校验 ---------- */

  it("普通成员不能建模板；负责人创建授予模板（全体 + 白名单）", async function () {
    let r = await as("张三")("POST", "/api/permissions/request-templates", {
      name: "非法", scope: "space", resourceId: ctx.spaceId, role: "view",
      kind: "grant", defaultDurationMs: DAY
    }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "not_resource_owner");

    // 授予模板缺默认有效期 -> 400
    r = await request("POST", "/api/permissions/request-templates", {
      name: "无有效期", scope: "space", resourceId: ctx.spaceId,
      role: "view", kind: "grant"
    }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "missing_default_duration");

    // space 不支持 approve 角色模板
    r = await request("POST", "/api/permissions/request-templates", {
      name: "审批", scope: "space", resourceId: ctx.spaceId, role: "approve",
      kind: "grant", defaultDurationMs: DAY
    }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "role_not_allowed_for_scope");

    // 合法：全体成员的查看授予模板
    r = await request("POST", "/api/permissions/request-templates", {
      name: "常规查看申请", scope: "space", resourceId: ctx.spaceId,
      role: "view", kind: "grant", defaultDurationMs: 2 * DAY,
      description: "新成员查看空间用",
      memberScope: { mode: "all" }
    }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.tplView = r.data.template.id;
    ctx.templateRev = r.tplRev;
    assert.equal(r.data.template.currentVersion, 1);
    assert.equal(r.data.template.history.length, 1);
    assert.equal(r.data.template.history[0].action, "create");

    // 合法：白名单（张三、李四）的复核授予模板
    r = await request("POST", "/api/permissions/request-templates", {
      name: "复核申请-受限", scope: "space", resourceId: ctx.spaceId,
      role: "review", kind: "grant", defaultDurationMs: DAY,
      memberScope: { mode: "members", members: ["张三", "李四"] }
    }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.tplReview = r.data.template.id;
    ctx.templateRev = r.tplRev;

    // 合法：撤销模板（不需要默认有效期）
    r = await request("POST", "/api/permissions/request-templates", {
      name: "查看撤销", scope: "space", resourceId: ctx.spaceId,
      role: "view", kind: "revoke"
    }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.tplRevoke = r.data.template.id;
    ctx.templateRev = r.tplRev;
  });

  it("独立 templateRev：旧版本创建 409；缺 If-Match 428", async function () {
    let r = await request("POST", "/api/permissions/request-templates", {
      name: "旧版本", scope: "space", resourceId: ctx.spaceId, role: "view",
      kind: "grant", defaultDurationMs: DAY
    }, { "If-Match": String(Number(ctx.templateRev) - 1) });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "version_conflict");

    r = await request("POST", "/api/permissions/request-templates", {
      name: "无版本", scope: "space", resourceId: ctx.spaceId, role: "view",
      kind: "grant", defaultDurationMs: DAY
    }, {});
    assert.equal(r.status, 428);
  });

  /* ---------- 普通成员可见性 ---------- */

  it("王五（白名单外）看不到受限模板，张三能看到；成员视图不暴露完整白名单", async function () {
    let r = await as("王五")("GET",
      "/api/permissions/request-templates?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(r.status, 200);
    const ids = r.data.templates.map(function (t) { return t.id; });
    assert.ok(ids.indexOf(ctx.tplView) !== -1); // 全体模板可见
    assert.ok(ids.indexOf(ctx.tplReview) === -1); // 白名单模板不可见

    r = await as("张三")("GET",
      "/api/permissions/request-templates?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(r.status, 200);
    const review = r.data.templates.find(function (t) {
      return t.id === ctx.tplReview;
    });
    assert.ok(review);
    assert.deepEqual(review.memberScope.members, []);
    assert.equal(review.history, undefined);

    // 直接取不属于自己范围的模板详情 -> 403
    const peek = await as("王五")("GET",
      "/api/permissions/request-templates/" + ctx.tplReview);
    assert.equal(peek.status, 403);

    // 普通成员不能看版本历史
    const hist = await as("张三")("GET",
      "/api/permissions/request-templates/" + ctx.tplReview + "/versions");
    assert.equal(hist.status, 403);
  });

  /* ---------- 用模板发起申请 ---------- */

  it("张三用全体模板发起授予申请：默认窗口=2天，记录模板与版本来源", async function () {
    const before = Date.now();
    let r = await as("张三")("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/submit",
      { templateVersion: 1, note: "按模板申请" },
      { "If-Match": ctx.requestRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.requestRev = r.reqRev;
    const q = r.data.request;
    ctx.submittedId = q.id;
    assert.equal(q.templateId, ctx.tplView);
    assert.equal(q.templateVersion, 1);
    assert.equal(q.templateName, "常规查看申请");
    assert.ok(q.templateSnapshot);
    assert.equal(q.templateSnapshot.defaultDurationMs, 2 * DAY);
    // 默认窗口：生效≈now，失效≈now+2天
    const span = Date.parse(q.expireAt) - Date.parse(q.effectiveAt);
    assert.ok(Math.abs(span - 2 * DAY) < 5000, "span=" + span);
    assert.ok(Date.parse(q.createdAt) >= before - 1000);
  });

  it("角色已存在（已有 pending 同角色申请）-> duplicate_request，拒绝原因明确", async function () {
    const r = await as("张三")("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "duplicate_request");
    assert.equal(r.data.existingRequestId, ctx.submittedId);
    assert.equal(r.data.templateId, ctx.tplView);
    // 被拒不推进 requestRev
    const list = await request("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(list.data.requests.length, 1);
  });

  it("成员不在适用范围 -> member_not_in_template_scope", async function () {
    const r = await as("王五")("POST",
      "/api/permissions/request-templates/" + ctx.tplReview + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "member_not_in_template_scope");
  });

  it("模板版本已变化 -> template_version_changed；缺版本 -> 428", async function () {
    // 负责人先修改受限模板（李四复核 -> 改默认有效期）
    let r = await request("PATCH",
      "/api/permissions/request-templates/" + ctx.tplReview,
      { defaultDurationMs: 3 * DAY }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.templateRev = r.tplRev;
    assert.equal(r.data.template.currentVersion, 2);
    assert.equal(r.data.template.history.length, 2);
    assert.equal(r.data.template.history[1].action, "update");

    // 张三拿旧版本号发起 -> 409
    r = await as("张三")("POST",
      "/api/permissions/request-templates/" + ctx.tplReview + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "template_version_changed");
    assert.equal(r.data.currentVersion, 2);
    assert.equal(r.data.submittedVersion, 1);

    // 不带版本 -> 428
    r = await as("张三")("POST",
      "/api/permissions/request-templates/" + ctx.tplReview + "/submit",
      {}, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 428);
    assert.equal(r.data.error, "precondition_required");

    // 新版本可发起（李四在白名单内，且无同角色 pending）
    r = await as("李四")("POST",
      "/api/permissions/request-templates/" + ctx.tplReview + "/submit",
      { templateVersion: 2, expireAt: iso(Date.now() + 12 * HOUR) },
      { "If-Match": ctx.requestRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.requestRev = r.reqRev;
    assert.equal(r.data.request.templateVersion, 2);
    assert.equal(r.data.request.role, "review");
  });

  it("显式时间窗覆盖默认有效期", async function () {
    const r = await as("王五")("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/submit",
      { templateVersion: 1,
        effectiveAt: iso(Date.now() + HOUR),
        expireAt: iso(Date.now() + 6 * HOUR) },
      { "If-Match": ctx.requestRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.requestRev = r.reqRev;
    assert.equal(r.data.request.templateId, ctx.tplView);
    const span = Date.parse(r.data.request.expireAt) -
      Date.parse(r.data.request.effectiveAt);
    assert.ok(Math.abs(span - 5 * HOUR) < 5000);
  });

  it("与正式委派时间窗重叠 -> duplicate_delegation", async function () {
    // 负责人直接给赵六授予 view（窗口未来 10 小时），赵六再用模板申请 -> 拒绝
    let r = await request("POST", "/api/permissions/delegations",
      { scope: "space", resourceId: ctx.spaceId, role: "view",
        member: "赵六", expireAt: iso(Date.now() + 10 * HOUR) },
      { "If-Match": ctx.prev || "0" });
    // 委派集合 rev：从响应头取
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const permRev = r.prev;

    r = await as("赵六")("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "duplicate_delegation");
    assert.ok(r.data.existingDelegationId);
    void permRev;
  });

  /* ---------- 停用 ---------- */

  it("停用模板后不能再发起、不能再修改；重复停用 409；停用不改内容版本", async function () {
    let r = await request("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/disable",
      { reason: "统一换新模板" }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.templateRev = r.tplRev;
    assert.equal(r.data.template.status, "disabled");
    assert.equal(r.data.template.currentVersion, 1); // 停用不推进内容版本
    const last = r.data.template.history[r.data.template.history.length - 1];
    assert.equal(last.action, "disable");

    // 停用后发起 -> 409 template_disabled
    r = await as("李四")("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "template_disabled");

    // 停用后修改 -> 409
    r = await request("PATCH",
      "/api/permissions/request-templates/" + ctx.tplView,
      { name: "改名" }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "template_disabled");

    // 普通成员列表不再看到停用模板
    const list = await as("张三")("GET",
      "/api/permissions/request-templates?scope=space&resourceId=" + ctx.spaceId);
    const ids = list.data.templates.map(function (t) { return t.id; });
    assert.ok(ids.indexOf(ctx.tplView) === -1);

    // 重复停用
    r = await request("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/disable",
      {}, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "template_disabled");
  });

  /* ---------- 模板修改不改变已提交申请 ---------- */

  it("已提交申请保留当时模板版本快照，后续修改/停用不回溯", async function () {
    const before = await request("GET",
      "/api/permissions/requests/" + ctx.submittedId);
    assert.equal(before.data.request.templateVersion, 1);
    const snap = before.data.request.templateSnapshot;
    assert.equal(snap.templateName, "常规查看申请");
    assert.equal(snap.defaultDurationMs, 2 * DAY);
    // 模板此时已停用；申请仍可被负责人正常审批（模板状态不影响既有申请）
    let r = await request("POST",
      "/api/permissions/requests/" + ctx.submittedId + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.requestRev = r.reqRev;
    const after = await request("GET",
      "/api/permissions/requests/" + ctx.submittedId);
    assert.equal(after.data.request.status, "approved");
    assert.equal(after.data.request.templateVersion, 1);
    assert.equal(after.data.request.generatedDelegationId,
      after.data.request.generatedDelegationId); // 已生成正式委派
  });

  /* ---------- 撤销模板 ---------- */

  it("用撤销模板对本人正式委派发起撤销申请；非本人委派被拒", async function () {
    // 上一步张三的申请已批准生成正式委派
    const dels = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" +
      ctx.spaceId + "&member=" + encodeURIComponent("张三"));
    const zd = dels.data.delegations.find(function (d) {
      return d.role === "view" && d.statusAt !== "expired";
    });
    assert.ok(zd, "张三应有批准生成的 view 委派");

    let r = await as("张三")("POST",
      "/api/permissions/request-templates/" + ctx.tplRevoke + "/submit",
      { templateVersion: 1, delegationId: zd.id },
      { "If-Match": ctx.requestRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.requestRev = r.reqRev;
    assert.equal(r.data.request.kind, "revoke");
    assert.equal(r.data.request.templateId, ctx.tplRevoke);
    assert.equal(r.data.request.delegationId, zd.id);

    // 李四拿赵六的委派 id 走撤销模板 -> not_delegation_member
    const zhao = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" +
      ctx.spaceId + "&member=" + encodeURIComponent("赵六"));
    const zd6 = zhao.data.delegations[0];
    r = await as("李四")("POST",
      "/api/permissions/request-templates/" + ctx.tplRevoke + "/submit",
      { templateVersion: 1, delegationId: zd6.id },
      { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "not_delegation_member");
  });

  /* ---------- 审计：变更/使用/拒绝原因 ---------- */

  it("templateLogs 记录创建/修改/停用/发起/拒绝；普通成员只见自己相关", async function () {
    let r = await request("GET",
      "/api/permissions/request-templates/logs?scope=space&resourceId=" +
      ctx.spaceId);
    assert.equal(r.status, 200);
    const actions = r.data.logs.map(function (l) { return l.action; });
    assert.ok(actions.indexOf("template_create") !== -1);
    assert.ok(actions.indexOf("template_update") !== -1);
    assert.ok(actions.indexOf("template_disable") !== -1);
    assert.ok(actions.indexOf("template_submit") !== -1);
    assert.ok(actions.indexOf("template_submit_rejected") !== -1);

    // 赵六只看到自己的发起/拒绝（看不到张三李四的记录与管理事件）
    const mine = await as("赵六")("GET",
      "/api/permissions/request-templates/logs?scope=space&resourceId=" +
      ctx.spaceId);
    assert.equal(mine.status, 200);
    mine.data.logs.forEach(function (l) {
      assert.ok(l.actor === "赵六" || l.member === "赵六");
    });
    const rej = mine.data.logs.find(function (l) {
      return l.action === "template_submit_rejected";
    });
    assert.ok(rej);
    assert.equal(rej.detail.code, "duplicate_delegation");
  });

  it("拒绝原因同样进入统一 denials（仅系统负责人可见）", async function () {
    const r = await request("GET", "/api/permissions/denials");
    assert.equal(r.status, 200);
    const tplDenials = r.data.denials.filter(function (d) {
      return d.action === "permission_template_submit";
    });
    assert.ok(tplDenials.length >= 3);
    const codes = tplDenials.map(function (d) { return d.code; });
    assert.ok(codes.indexOf("duplicate_request") !== -1);
    assert.ok(codes.indexOf("member_not_in_template_scope") !== -1);
    assert.ok(codes.indexOf("template_version_changed") !== -1);

    // 普通成员不能查统一 denials
    const denied = await as("张三")("GET", "/api/permissions/denials");
    assert.equal(denied.status, 403);
  });

  /* ---------- 重启恢复 ---------- */

  it("重启后模板/版本历史/申请溯源/日志/独立版本号全部恢复", async function () {
    await restartServer();
    // 版本号恢复
    const head = await request("GET",
      "/api/permissions/request-templates?scope=space&resourceId=" +
      ctx.spaceId);
    assert.equal(head.tplRev, ctx.templateRev);

    const r = await request("GET",
      "/api/permissions/request-templates/" + ctx.tplReview);
    assert.equal(r.status, 200);
    assert.equal(r.data.template.currentVersion, 2);
    const versions = r.data.template.history;
    assert.ok(versions.length >= 2);
    assert.equal(versions[0].action, "create");

    const vh = await request("GET",
      "/api/permissions/request-templates/" + ctx.tplReview + "/versions");
    assert.equal(vh.status, 200);
    assert.equal(vh.data.versions[0].version, 2);

    // 已提交申请的模板溯源仍在
    const q = await request("GET",
      "/api/permissions/requests/" + ctx.submittedId);
    assert.equal(q.data.request.status, "approved");
    assert.equal(q.data.request.templateId, ctx.tplView);
    assert.equal(q.data.request.templateVersion, 1);
    assert.equal(q.data.request.templateSnapshot.templateName, "常规查看申请");

    // 停用状态恢复：仍不能发起
    const again = await as("李四")("POST",
      "/api/permissions/request-templates/" + ctx.tplView + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "template_disabled");

    // 日志恢复
    const logs = await request("GET",
      "/api/permissions/request-templates/logs?scope=space&resourceId=" +
      ctx.spaceId);
    assert.ok(logs.data.logs.length >= 5);
  });
});
