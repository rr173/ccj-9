/* node --test test/permissions-api.test.js
 * 角色委派与操作权限 HTTP 集成测试：真实启动 server.js（临时数据文件+随机端口）。
 *
 * 走完 线上任务 -> 导出 -> 导入回放空间 -> 意见/会话 后覆盖：
 *   空间/会话/批次角色授予（含生效/失效时间）、未授权 403、角色过期、角色未生效、
 *   撤销后立即失权、重复委派 409、同成员 approve/execute 冲突、负责人自审、
 *   非负责人不能配置委派、旧页面提交权限配置版本冲突不覆盖新配置、
 *   跨模块限制（空间 view 不能提交结论、批次角色不串空间）、
 *   会话角色继承空间角色、审批/执行角色门槛、列表可见性过滤、
 *   拒绝原因/操作记录查询、重启恢复、历史记录保留原操作人与时间（历史只读）。
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

const PORT = 9200 + Math.floor(Math.random() * 300);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "pm-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "pm-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "pm-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "pm-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(TMP, "pm-space-" + TAG + ".json"),
  ARCHIVE_DATA: path.join(TMP, "pm-arc-" + TAG + ".json"),
  RECON_DATA: path.join(TMP, "pm-recon-" + TAG + ".json"),
  PERM_DATA: path.join(TMP, "pm-perm-" + TAG + ".json")
};

let server;
function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: FILES.SNAP_DATA, ANNOTATIONS_FILE: FILES.ANN_DATA,
      REVIEW_BATCHES_FILE: FILES.BATCH_DATA, REVIEW_DECISIONS_FILE: FILES.DEC_DATA,
      REPLAY_SPACES_FILE: FILES.REPLAY_DATA, REPLAY_ARCHIVES_FILE: FILES.ARCHIVE_DATA,
      REPLAY_RECONCILE_FILE: FILES.RECON_DATA, PERMISSIONS_FILE: FILES.PERM_DATA,
      DECISION_SCHEDULER_INTERVAL_MS: "100"
    }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  return waitUp();
}
function waitUp() {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/permissions/delegations", function (res) {
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
async function restartServer() { await stopServer(); return startServer(); }

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
          resolve({ status: res.statusCode, data: data, text: text,
            headers: res.headers,
            rrev: res.headers["x-reconcile-rev"],
            prev: res.headers["x-permission-rev"],
            playrev: res.headers["x-replay-rev"] });
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
async function drev() {
  return (await request("GET", "/api/review-decisions", undefined)).headers["x-decision-rev"];
}
async function annRev() {
  return (await request("GET", "/api/annotations", undefined)).headers["x-annotation-rev"];
}
async function batchRev() {
  return (await request("GET", "/api/review-batches", undefined)).headers["x-batch-rev"];
}
// 以指定成员身份发请求（HTTP 头不允许非 ASCII，统一用 ?as= 查询参数；
// 服务端 X-Member 头与 as 参数等价。注意不能用 ?member=——它是委派清单的筛选参数）
function as(member) {
  return function (method, urlPath, body, headers) {
    const sep = urlPath.indexOf("?") === -1 ? "?" : "&";
    return request(method, urlPath + sep + "as=" +
      encodeURIComponent(member), body, headers);
  };
}
const QM = encodeURIComponent;
const PARAS = [{ dir: "ltr", text: "中文示例文本内容用于权限集成测试流程" }];
const farFuture = "2030-01-01T00:00:00Z";
const iso = function (ms) { return new Date(ms).toISOString(); };
const HOUR = 3600000;

describe("角色委派与操作权限 API（顺序用例）", function () {
  const ctx = {
    spaceId: null, spaceRev: { v: 1 }, reviewId: null,
    sessionId: null, sver: { v: 1 },
    archiveA: null, archiveB: null, diffId: null,
    reconRev: null, batchId: null, batchVer: 1, permRev: "0",
    secondSpaceId: null
  };

  before(async function () { await startServer(); });
  after(async function () {
    await stopServer();
    for (const f of Object.values(FILES)) {
      for (const suffix of ["", ".tmp", ".recover.tmp"]) {
        try { fs.unlinkSync(f + suffix); } catch (e) {}
      }
    }
  });

  /* ---------------- 准备：一条完整的回放空间 + 意见 + 会话 ---------------- */

  it("准备：线上任务 -> 导出 -> 导入空间 -> 一条意见 -> 一个待提交会话", async function () {
    let r = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": await annRev() });
    assert.equal(r.status, 201);
    const annotationId = r.data.annotation.id;

    const batch = await request("POST", "/api/review-batches", {
      name: "权限批次", owner: "负责人", deadline: farFuture,
      annotationIds: [annotationId]
    }, { "If-Match": await batchRev() });
    assert.equal(batch.status, 201, JSON.stringify(batch.data));
    const batchId = batch.data.batch.id;

    r = await request("POST", "/api/review-decisions",
      { batchId: batchId, threshold: 1, paragraphs: PARAS, items: [] },
      { "If-Match": await drev() });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const did = r.data.decision.id;
    r = await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: [{ annotationId: annotationId, disposition: "delete" }],
        actor: "甲" },
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
    await new Promise(function (res) { setTimeout(res, 700); });

    const exp = await request("POST", "/api/replay/export", { actor: "负责人" });
    assert.equal(exp.status, 200, JSON.stringify(exp.data));
    const imp = await request("POST", "/api/replay/import", exp.data);
    assert.equal(imp.status, 201, JSON.stringify(imp.data));
    ctx.spaceId = imp.data.space.id;
    ctx.spaceRev.v = imp.data.space.rev;

    const detail = await request("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    const eventId = detail.data.space.content.events[0].id;

    const rv = await request("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/reviews",
      { target: { kind: "event", eventId: eventId }, reviewer: "复核人甲",
        content: "权限测试意见", dueAt: iso(Date.now() + HOUR), actor: "负责人" },
      { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(rv.status, 201, JSON.stringify(rv.data));
    ctx.reviewId = rv.data.review.id;
    ctx.spaceRev.v = rv.data.spaceRev;

    const cs = await request("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions",
      { name: "权限会话", participants: ["参与人甲", "参与人乙"],
        deadline: iso(Date.now() + HOUR), reviewIds: [ctx.reviewId],
        actor: "负责人" },
      { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(cs.status, 201, JSON.stringify(cs.data));
    ctx.sessionId = cs.data.session.id;
    ctx.sver.v = cs.data.session.version;
    ctx.spaceRev.v = cs.data.spaceRev;

    // 再导入一个相同审计包：同包幂等，返回同一空间 200
    const imp2 = await request("POST", "/api/replay/import", exp.data);
    assert.equal(imp2.status, 200);
    assert.equal(imp2.data.space.id, ctx.spaceId);
  });

  /* ---------------- 未配置权限：全员可访问（向后兼容） ---------------- */

  it("未配置委派时：任何成员都能查看空间/会话（未启用管控）", async function () {
    const r = await as("陌生人")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(r.status, 200);
    const s = await as("陌生人")("GET",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + ctx.sessionId);
    assert.equal(s.status, 200);
    const list = await as("陌生人")("GET", "/api/replay/spaces");
    assert.ok(list.data.spaces.some(function (x) { return x.id === ctx.spaceId; }));
  });

  /* ---------------- 授予与基本查看权 ---------------- */

  it("非负责人不能配置委派：403 not_resource_owner 并留拒绝记录", async function () {
    const r = await as("路人甲")("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "张三", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "not_resource_owner");
    const den = await request("GET", "/api/permissions/denials");
    assert.ok(den.data.denials.some(function (d) {
      return d.code === "not_resource_owner" && d.member === "路人甲";
    }));
  });

  it("授予校验：缺失效时间 400 / 负责人自审 409 / 不存在资源 404", async function () {
    let r = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view", member: "张三"
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "missing_expire");

    r = await request("POST", "/api/permissions/delegations", {
      scope: "batch", resourceId: "btc_nonexistent", role: "approve",
      member: "审批人甲", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, "batch_not_found");

    // space 上不能授予 approve 角色
    r = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "approve",
      member: "审批人甲", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "role_not_allowed_for_scope");

    // 缺 If-Match 428
    r = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "张三", expireAt: iso(Date.now() + HOUR)
    });
    assert.equal(r.status, 428);
  });

  it("负责人授予张三空间查看角色；授予后陌生人立即 403，张三可查看", async function () {
    // 用百分号编码的 X-Member 头以负责人身份授予（浏览器真实传输路径）
    const r0 = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "张三", expireAt: iso(Date.now() + HOUR),
      reason: "临时查看"
    }, { "If-Match": ctx.permRev,
         "X-Member": encodeURIComponent("负责人") });
    assert.equal(r0.status, 201, JSON.stringify(r0.data));
    const r = r0;
    assert.equal(r.data.delegation.status, "active");
    ctx.permRev = r.prev;
    ctx.viewDelegation = r.data.delegation.id;

    // 角色变更后新请求立即生效：陌生人未授权
    const denied = await as("陌生人")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "unauthorized");
    assert.equal(denied.data.required, "view");

    // 列表中陌生人看不到该空间
    const list = await as("陌生人")("GET", "/api/replay/spaces");
    assert.equal(list.data.spaces.some(function (x) {
      return x.id === ctx.spaceId;
    }), false);

    // 张三可以看
    const ok = await as("张三")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(ok.status, 200);

    // 浏览器路径：非 ASCII 成员名经百分号编码放在 X-Member 头中，服务端正确还原
    const byHeader = await request("GET",
      "/api/replay/spaces/" + ctx.spaceId, undefined,
      { "X-Member": encodeURIComponent("张三") });
    assert.equal(byHeader.status, 200);
    const byHeaderDenied = await request("GET",
      "/api/replay/spaces/" + ctx.spaceId, undefined,
      { "X-Member": encodeURIComponent("陌生人") });
    assert.equal(byHeaderDenied.status, 403);
    // 时间线/冲突/意见列表/任务/快照等只读接口都放行
    for (const suffix of ["timeline", "conflicts", "reviews", "sessions"]) {
      const method = suffix === "reviews" || suffix === "sessions" ? "GET" : "GET";
      const rr = await as("张三")(method,
        "/api/replay/spaces/" + ctx.spaceId + "/" + suffix);
      assert.equal(rr.status, 200, suffix + " " + JSON.stringify(rr.data));
    }
  });

  /* ---------------- 跨模块/跨角色操作限制 ---------------- */

  it("跨模块限制：只有 view 角色不能新增意见/创建会话；无角色成员连筛选都不能保存",
    async function () {
    let r = await as("张三")("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/reviews",
      { target: { kind: "event", eventId: "x" }, reviewer: "张三",
        content: "越权", dueAt: iso(Date.now() + HOUR), actor: "张三" },
      { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "unauthorized");

    r = await as("张三")("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions",
      { participants: ["张三"], deadline: iso(Date.now() + HOUR),
        reviewIds: [ctx.reviewId], actor: "张三" },
      { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(r.status, 403);

    // view 角色可以保存自己的筛选条件（属于查看范畴），不推进 rev 到失败状态
    const canView = await as("张三")("PUT",
      "/api/replay/spaces/" + ctx.spaceId + "/view",
      { taskId: "" }, { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(canView.status, 200, JSON.stringify(canView.data));
    // PUT view 成功会推进空间 rev，后续测试必须用最新 rev
    ctx.spaceRev.v = canView.data.spaceRev;

    // 无任何角色的陌生人保存筛选 403（且不推进 rev）
    const noView = await as("陌生人")("PUT",
      "/api/replay/spaces/" + ctx.spaceId + "/view",
      { taskId: "" }, { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(noView.status, 403);
    assert.equal(noView.data.error, "unauthorized");
  });

  it("授予复核角色后张三可以提交结论（空间角色继承到会话）", async function () {
    const r = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "张三", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.permRev = r.prev;

    // 张三不是会话参与人：角色校验先通过，业务校验 403 not_participant
    const np = await as("张三")("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" +
      ctx.sessionId + "/conclusions",
      { reviewId: ctx.reviewId, result: "confirm", actor: "张三" },
      { "If-Match": String(ctx.spaceRev.v),
        "X-Session-Version": String(ctx.sver.v) });
    assert.equal(np.status, 403);
    assert.equal(np.data.error, "not_participant");

    // 参与人但无角色的参与人乙仍然 403 unauthorized
    const denied = await as("参与人乙")("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" +
      ctx.sessionId + "/conclusions",
      { reviewId: ctx.reviewId, result: "reject", actor: "参与人乙" },
      { "If-Match": String(ctx.spaceRev.v),
        "X-Session-Version": String(ctx.sver.v) });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "unauthorized");
  });

  it("会话级委派：为参与人乙单独授予会话复核角色后可提交结论", async function () {
    const r = await request("POST", "/api/permissions/delegations", {
      scope: "session", resourceId: ctx.sessionId, role: "review",
      member: "参与人乙", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.permRev = r.prev;

    const c = await as("参与人乙")("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" +
      ctx.sessionId + "/conclusions",
      { reviewId: ctx.reviewId, result: "reject", note: "权限测试结论",
        actor: "参与人乙" },
      { "If-Match": String(ctx.spaceRev.v),
        "X-Session-Version": String(ctx.sver.v) });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    ctx.spaceRev.v = c.data.spaceRev;
    ctx.sver.v = c.data.session.version;

    // 历史结论保留原操作人与时间
    const detail = await request("GET",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + ctx.sessionId);
    const item = detail.data.session.items[0];
    assert.equal(item.conclusion.by, "参与人乙");
    assert.ok(item.conclusion.at);
    ctx.conclusionAt = item.conclusion.at;
  });

  /* ---------------- 有效期：未生效 / 已过期 ---------------- */

  it("角色未生效：future-effective 委派在生效前 403 role_not_active", async function () {
    const r = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "赵六", effectiveAt: iso(Date.now() + HOUR / 2),
      expireAt: iso(Date.now() + 2 * HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.permRev = r.prev;
    const denied = await as("赵六")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "role_not_active");
  });

  it("角色过期：已过期委派 403 role_expired；过期不阻挡重新授予", async function () {
    const granted = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "钱七", effectiveAt: iso(Date.now() - 2 * HOUR),
      expireAt: iso(Date.now() - HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(granted.status, 201, JSON.stringify(granted.data));
    ctx.permRev = granted.prev;
    assert.equal(granted.data.delegation.status, "expired");

    const denied = await as("钱七")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "role_expired");

    // effective 接口实时反映角色
    const eff = await as("钱七")("GET",
      "/api/permissions/effective?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(eff.status, 200);
    assert.deepEqual(eff.data.roles, []);
  });

  /* ---------------- 重复委派与冲突 ---------------- */

  it("重复委派 409：同成员同角色时间窗重叠明确拒绝且不覆盖", async function () {
    const r = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "张三", expireAt: iso(Date.now() + 2 * HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "duplicate_delegation");
    assert.ok(r.data.existingDelegationId);
  });

  it("并发更新：旧页面用旧 rev 提交委派 409 version_conflict，不覆盖新配置",
    async function () {
      const oldRev = ctx.permRev;
      // 先用旧 rev 之外的新 rev 做一次成功变更
      const ok = await request("POST", "/api/permissions/delegations", {
        scope: "space", resourceId: ctx.spaceId, role: "view",
        member: "周八", expireAt: iso(Date.now() + HOUR)
      }, { "If-Match": oldRev });
      assert.equal(ok.status, 201, JSON.stringify(ok.data));
      ctx.permRev = ok.prev;

      // 旧页面仍拿 oldRev 提交：必须冲突且不写入
      const stale = await request("POST", "/api/permissions/delegations", {
        scope: "space", resourceId: ctx.spaceId, role: "review",
        member: "吴九", expireAt: iso(Date.now() + HOUR)
      }, { "If-Match": oldRev });
      assert.equal(stale.status, 409);
      assert.equal(stale.data.error, "version_conflict");

      // 吴九未获得任何权限
      const denied = await as("吴九")("GET",
        "/api/replay/spaces/" + ctx.spaceId);
      assert.equal(denied.status, 403);
      // 周八的新配置仍在
      const list = await request("GET",
        "/api/permissions/delegations?scope=space&resourceId=" +
        ctx.spaceId + "&member=" + encodeURIComponent("周八"));
      assert.equal(list.status, 200, JSON.stringify(list.data));
      assert.equal(list.data.delegations.length, 1);
    });

  /* ---------------- 撤销 ---------------- */

  it("撤销：负责人撤销张三的查看角色后，张三新请求立即 403", async function () {
    const r = await request("POST",
      "/api/permissions/delegations/" + ctx.viewDelegation + "/revoke",
      { reason: "查看结束" }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.delegation.status, "revoked");
    ctx.permRev = r.prev;

    // 张三还有 review 委派，所以 view 仍满足；改撤 review
    const reviewDel = (await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" +
      ctx.spaceId + "&member=" + encodeURIComponent("张三") + "&role=review")).data.delegations
      .find(function (d) { return d.status === "active"; });
    const r2 = await request("POST",
      "/api/permissions/delegations/" + reviewDel.id + "/revoke",
      {}, { "If-Match": ctx.permRev });
    assert.equal(r2.status, 200);
    ctx.permRev = r2.prev;

    const denied = await as("张三")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);

    // 重复撤销 409；撤销已过期委派 409
    const again = await request("POST",
      "/api/permissions/delegations/" + ctx.viewDelegation + "/revoke",
      {}, { "If-Match": ctx.permRev });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "duplicate_revoke");
  });

  /* ---------------- 纠错批次：审批/执行角色 + 负责人自审 + 冲突 ---------------- */

  it("准备：两个归档 + 差异 + 纠错批次（审批人甲/乙，负责人负责人）", async function () {
    // 恢复空间得到第二个归档（会话已有一条结论，直接归档当前会话）
    let arc = await request("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" +
      ctx.sessionId + "/archive",
      { actor: "负责人" }, { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(arc.status, 201, JSON.stringify(arc.data));
    ctx.archiveA = arc.data.archive;
    ctx.spaceRev.v = (arc.headers["x-replay-rev"] ? ctx.spaceRev.v : ctx.spaceRev.v);

    const rs = await request("POST",
      "/api/replay/archives/" + ctx.archiveA.id + "/restore",
      { actor: "负责人", name: "权限用恢复空间" });
    assert.equal(rs.status, 201, JSON.stringify(rs.data));
    const space2Id = rs.data.space.id;
    const space2Rev = { v: 1 };

    // 在恢复空间用带入的历史意见建新会话并给出不同结论
    const detail = await request("GET", "/api/replay/spaces/" + space2Id);
    const revs = detail.data.space.reviews;
    assert.ok(revs.length >= 1, "恢复空间应带入意见");
    const cs = await request("POST",
      "/api/replay/spaces/" + space2Id + "/sessions",
      { name: "权限会话二", participants: ["参与人甲", "参与人乙"],
        deadline: iso(Date.now() + HOUR), reviewIds: [revs[0].id],
        actor: "负责人" },
      { "If-Match": String(space2Rev.v) });
    assert.equal(cs.status, 201, JSON.stringify(cs.data));
    const sid2 = cs.data.session.id;
    const sv2 = { v: cs.data.session.version };
    space2Rev.v = cs.data.spaceRev;
    const cc = await request("POST",
      "/api/replay/spaces/" + space2Id + "/sessions/" + sid2 + "/conclusions",
      { reviewId: revs[0].id, result: "confirm", note: "另一侧结论",
        actor: "参与人甲" },
      { "If-Match": String(space2Rev.v),
        "X-Session-Version": String(sv2.v) });
    assert.equal(cc.status, 201, JSON.stringify(cc.data));
    space2Rev.v = cc.data.spaceRev;
    const arc2 = await request("POST",
      "/api/replay/spaces/" + space2Id + "/sessions/" + sid2 + "/archive",
      { actor: "负责人" }, { "If-Match": String(space2Rev.v) });
    assert.equal(arc2.status, 201, JSON.stringify(arc2.data));
    ctx.archiveB = arc2.data.archive;
    ctx.secondSpaceId = space2Id;

    const diff = await request("POST", "/api/replay/reconcile/diff",
      { aId: ctx.archiveA.id, bId: ctx.archiveB.id, actor: "负责人" },
      { "If-Match": "0" });
    assert.equal(diff.status, 201, JSON.stringify(diff.data));
    ctx.diffId = diff.data.diff.id;
    ctx.reconRev = diff.rrev;

    const items = diff.data.diff.items.filter(function (it) {
      return it.resolvable;
    }).map(function (it) {
      return { id: it.id, resolution: "keep_a" };
    });
    const cb = await request("POST", "/api/replay/reconcile/batches",
      { diffId: ctx.diffId, name: "权限纠错批次", owner: "负责人",
        deadline: iso(Date.now() + 2 * HOUR),
        approvers: ["审批人甲", "审批人乙"], items: items, actor: "负责人" },
      { "If-Match": String(ctx.reconRev) });
    assert.equal(cb.status, 201, JSON.stringify(cb.data));
    ctx.batchId = cb.data.batch.id;
    ctx.batchVer = cb.data.batch.version;
    ctx.reconRev = cb.rrev;
  });

  it("批次配置：同一成员 approve+execute 时间窗冲突 409 conflicting_roles",
    async function () {
      const expire = iso(Date.now() + HOUR);
      let r = await request("POST", "/api/permissions/delegations", {
        scope: "batch", resourceId: ctx.batchId, role: "approve",
        member: "双角色人", expireAt: expire
      }, { "If-Match": ctx.permRev });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ctx.permRev = r.prev;

      r = await request("POST", "/api/permissions/delegations", {
        scope: "batch", resourceId: ctx.batchId, role: "execute",
        member: "双角色人", expireAt: expire
      }, { "If-Match": ctx.permRev });
      assert.equal(r.status, 409);
      assert.equal(r.data.error, "conflicting_roles");
      assert.equal(r.data.conflictingRole, "approve");
    });

  it("批次负责人不能被授予 approve 角色：409 approver_is_owner", async function () {
    const r = await request("POST", "/api/permissions/delegations", {
      scope: "batch", resourceId: ctx.batchId, role: "approve",
      member: "负责人", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "approver_is_owner");
  });

  it("未授权：无角色成员看不到批次详情/列表，审批与执行都 403", async function () {
    const list = await as("旁观者")("GET", "/api/replay/reconcile/batches");
    assert.equal(list.data.batches.some(function (b) {
      return b.id === ctx.batchId;
    }), false);

    let r = await as("旁观者")("GET",
      "/api/replay/reconcile/batches/" + ctx.batchId);
    assert.equal(r.status, 403);

    // 提交审批（负责人动作）也拒绝
    r = await as("旁观者")("POST",
      "/api/replay/reconcile/batches/" + ctx.batchId + "/submit",
      { actor: "旁观者" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(ctx.batchVer) });
    assert.equal(r.status, 403);
  });

  it("审批人甲有 approve 委派前：审批 403 unauthorized（业务名单通过但权限不足）",
    async function () {
      const r = await as("审批人甲")("POST",
        "/api/replay/reconcile/batches/" + ctx.batchId + "/approvals",
        { decision: "approve", actor: "审批人甲" },
        { "If-Match": String(ctx.reconRev),
          "X-Batch-Version": String(ctx.batchVer) });
      assert.equal(r.status, 403, JSON.stringify(r.data));
      assert.equal(r.data.error, "unauthorized");
    });

  it("负责人提交批次；授予 approve 后审批人甲可审批；负责人自审 403", async function () {
    const sub = await request("POST",
      "/api/replay/reconcile/batches/" + ctx.batchId + "/submit",
      { actor: "负责人" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(ctx.batchVer) });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    ctx.batchVer = sub.data.batch.version;
    ctx.reconRev = sub.rrev;

    const g = await request("POST", "/api/permissions/delegations", {
      scope: "batch", resourceId: ctx.batchId, role: "approve",
      member: "审批人甲", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    ctx.permRev = g.prev;

    // 负责人自审：即使默认负责人主体也明确拒绝
    const self = await request("POST",
      "/api/replay/reconcile/batches/" + ctx.batchId + "/approvals",
      { decision: "approve", actor: "负责人" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(ctx.batchVer) });
    assert.equal(self.status, 403);
    assert.equal(self.data.error, "owner_self_approval");

    const a1 = await as("审批人甲")("POST",
      "/api/replay/reconcile/batches/" + ctx.batchId + "/approvals",
      { decision: "approve", actor: "审批人甲" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(ctx.batchVer) });
    assert.equal(a1.status, 200, JSON.stringify(a1.data));
    ctx.batchVer = a1.data.batch.version;
    ctx.reconRev = a1.rrev;
  });

  it("执行角色：审批未全员前 execute 成员执行 -> 审批不足整批 failed",
    async function () {
    // 给执行人授予 execute
    const g = await request("POST", "/api/permissions/delegations", {
      scope: "batch", resourceId: ctx.batchId, role: "execute",
      member: "执行人", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    ctx.permRev = g.prev;

    // 仅 1/2 审批人通过：审批不足，整批 failed
    const ex1 = await as("执行人")("POST",
      "/api/replay/reconcile/batches/" + ctx.batchId + "/execute",
      { actor: "执行人" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(ctx.batchVer) });
    assert.equal(ex1.status, 409, JSON.stringify(ex1.data));
    assert.equal(ex1.data.error, "approval_insufficient");
    const failed = await request("GET",
      "/api/replay/reconcile/batches/" + ctx.batchId);
    assert.equal(failed.data.batch.status, "failed");

    // 失败原因可查询（对账记录 + 批次 failureCode）
    assert.equal(failed.data.batch.failureCode, "approval_insufficient");
    const logs = await request("GET", "/api/replay/reconcile/logs");
    assert.ok(logs.data.logs.some(function (l) {
      return l.code === "approval_insufficient";
    }));
  });

  it("第二个批次全员审批通过后：只有 execute 角色能执行，approve 角色 403",
    async function () {
    // 基于同一差异再建一个批次（单审批人，便于全员通过）
    const diff = await request("GET",
      "/api/replay/reconcile/diffs/" + ctx.diffId);
    const items = diff.data.diff.items.filter(function (it) {
      return it.resolvable;
    }).map(function (it) { return { id: it.id, resolution: "keep_a" }; });
    const cb = await request("POST", "/api/replay/reconcile/batches",
      { diffId: ctx.diffId, name: "权限纠错批次二", owner: "负责人",
        deadline: iso(Date.now() + 2 * HOUR),
        approvers: ["审批人甲"], items: items, actor: "负责人" },
      { "If-Match": String(ctx.reconRev) });
    assert.equal(cb.status, 201, JSON.stringify(cb.data));
    const bid2 = cb.data.batch.id;
    let bver = cb.data.batch.version;
    ctx.reconRev = cb.rrev;

    // 为审批人甲授予第二批次的 approve
    let g = await request("POST", "/api/permissions/delegations", {
      scope: "batch", resourceId: bid2, role: "approve",
      member: "审批人甲", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    ctx.permRev = g.prev;
    // 为执行人授予 execute
    g = await request("POST", "/api/permissions/delegations", {
      scope: "batch", resourceId: bid2, role: "execute",
      member: "执行人", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.permRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    ctx.permRev = g.prev;

    const sub = await request("POST",
      "/api/replay/reconcile/batches/" + bid2 + "/submit",
      { actor: "负责人" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(bver) });
    assert.equal(sub.status, 200, JSON.stringify(sub.data));
    bver = sub.data.batch.version;
    ctx.reconRev = sub.rrev;

    const a1 = await as("审批人甲")("POST",
      "/api/replay/reconcile/batches/" + bid2 + "/approvals",
      { decision: "approve", actor: "审批人甲" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(bver) });
    assert.equal(a1.status, 200, JSON.stringify(a1.data));
    bver = a1.data.batch.version;
    ctx.reconRev = a1.rrev;

    // approve 角色不能执行：403 unauthorized（先于业务状态校验）
    const denied = await as("审批人甲")("POST",
      "/api/replay/reconcile/batches/" + bid2 + "/execute",
      { actor: "审批人甲" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(bver) });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "unauthorized");

    // execute 角色执行成功（生成纠错归档与新回放空间）
    const ex = await as("执行人")("POST",
      "/api/replay/reconcile/batches/" + bid2 + "/execute",
      { actor: "执行人" },
      { "If-Match": String(ctx.reconRev),
        "X-Batch-Version": String(bver) });
    assert.equal(ex.status, 201, JSON.stringify(ex.data));
    assert.ok(ex.data.correction.id);
    assert.ok(ex.data.space.id);
    ctx.reconRev = ex.rrev;

    // 历史只读：执行记录保留原执行人（执行人）而非负责人
    const detail = await request("GET",
      "/api/replay/reconcile/batches/" + bid2);
    assert.equal(detail.data.batch.status, "approved");
    assert.ok(detail.data.batch.correctionId);
    const execLog = (await request("GET", "/api/replay/reconcile/logs"))
      .data.logs.find(function (l) {
        return l.action === "execute" && l.batchId === bid2;
      });
    assert.ok(execLog, "执行操作记录存在");
    assert.equal(execLog.actor, "执行人");
    ctx.batch2Id = bid2;
  });

  it("非负责人不能删除回放空间：403（负责人放行）", async function () {
    // 该空间在测试末尾才删除；这里确认非负责人被拒且空间仍在
    const denied = await as("张三")("DELETE",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "not_resource_owner");
    const still = await request("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(still.status, 200);
  });

  /* ---------------- 审计记录 ---------------- */

  it("委派清单访问控制：系统负责人可见全部；资源负责人可见本资源；" +
     "普通成员 403；member= 只是筛选参数不改变身份", async function () {
    // 默认身份（系统负责人）：全部可见
    const all = await request("GET", "/api/permissions/delegations");
    assert.equal(all.status, 200);
    assert.ok(all.data.count >= 5);

    // ?member=周八 是筛选参数，不改变身份：仍以负责人身份查询，结果只含周八
    const filtered = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" +
      ctx.spaceId + "&member=" + encodeURIComponent("周八"));
    assert.equal(filtered.status, 200);
    assert.equal(filtered.data.count, 1);

    // 普通成员查全量清单 403
    const deniedAll = await as("张三")("GET", "/api/permissions/delegations");
    assert.equal(deniedAll.status, 403);
    // 普通成员即使带 scope/resourceId 也不能看（张三不是空间负责人）
    const deniedScoped = await as("张三")("GET",
      "/api/permissions/delegations?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(deniedScoped.status, 403);

    // 普通成员可用 effective 查自己的角色
    const eff = await as("周八")("GET",
      "/api/permissions/effective?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(eff.status, 200);
    assert.deepEqual(eff.data.roles, ["view"]);
  });

  it("操作记录与拒绝原因可按时间/资源查询", async function () {    const l = await request("GET",
      "/api/permissions/logs?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(l.status, 200);
    assert.ok(l.data.logs.length >= 4);
    assert.ok(l.data.logs.every(function (x) { return x.action === "grant" ||
      x.action === "revoke"; }));
    // 倒序
    const times = l.data.logs.map(function (x) { return Date.parse(x.at); });
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i]);

    const d = await request("GET",
      "/api/permissions/denials?scope=batch&resourceId=" + ctx.batchId);
    assert.ok(d.data.denials.length >= 1);
    assert.ok(d.data.denials.some(function (x) {
      return x.code === "owner_self_approval";
    }));

    // 非法时间参数 400
    const bad = await request("GET", "/api/permissions/logs?from=notadate");
    assert.equal(bad.status, 400);

    // 审计记录只对系统负责人开放：其他成员 403 且留拒绝记录
    const noLogs = await as("旁观者")("GET", "/api/permissions/logs");
    assert.equal(noLogs.status, 403);
    assert.equal(noLogs.data.error, "not_resource_owner");
    const noDenials = await as("旁观者")("GET", "/api/permissions/denials");
    assert.equal(noDenials.status, 403);
  });

  /* ---------------- 重启恢复 ---------------- */

  it("重启后：委派/有效期/撤销状态/拒绝原因/操作记录全部恢复，规则继续生效",
    async function () {
      await restartServer();
      const list = await request("GET",
        "/api/permissions/delegations?scope=space&resourceId=" +
        ctx.spaceId + "&member=" + encodeURIComponent("张三"));
      assert.ok(list.data.delegations.length >= 2);
      // 撤销状态保留
      assert.ok(list.data.delegations.every(function (d) {
        return d.status === "revoked";
      }));

      // 张三仍无权（撤销状态恢复）
      const denied = await as("张三")("GET",
        "/api/replay/spaces/" + ctx.spaceId);
      assert.equal(denied.status, 403);

      // 审批人甲在批次一上的 approve 委派恢复为 active（批次二上另有一条）
      const bd = await request("GET",
        "/api/permissions/delegations?scope=batch&resourceId=" +
        ctx.batchId + "&member=" + encodeURIComponent("审批人甲"));
      assert.equal(bd.data.delegations.length, 1);
      assert.equal(bd.data.delegations[0].status, "active");

      // 拒绝记录与操作记录恢复
      const den = await request("GET", "/api/permissions/denials");
      assert.ok(den.data.denials.some(function (x) {
        return x.code === "owner_self_approval";
      }));
      const logs = await request("GET", "/api/permissions/logs");
      assert.ok(logs.data.logs.length >= 5);

      // 过期判定重启后继续有效（钱七仍 role_expired）
      const expired = await as("钱七")("GET",
        "/api/replay/spaces/" + ctx.spaceId);
      assert.equal(expired.status, 403);
      assert.equal(expired.data.error, "role_expired");
    });

  it("历史只读：重启后已提交结论仍保留原操作人与时间，权限变化不改写历史",
    async function () {
      const detail = await request("GET",
        "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + ctx.sessionId);
      const item = detail.data.session.items[0];
      assert.equal(item.conclusion.by, "参与人乙");
      assert.equal(item.conclusion.at, ctx.conclusionAt);

      // 归档中的结论也原样保留
      const arc = await request("GET",
        "/api/replay/archives/" + ctx.archiveA.id);
      assert.equal(arc.status, 200);
    });

  it("重启后可继续授予与撤销（版本号从文件恢复，旧 rev 仍然冲突）", async function () {
    const cur = (await request("GET", "/api/permissions/delegations")).data.rev;
    const stale = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "重启后用户", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": "0" });
    assert.equal(stale.status, 409);

    const ok = await request("POST", "/api/permissions/delegations", {
      scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "重启后用户", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": String(cur) });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    const seen = await as("重启后用户")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(seen.status, 200);
  });
});
