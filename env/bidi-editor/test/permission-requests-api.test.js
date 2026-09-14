/* node --test test/permission-requests-api.test.js
 * 权限变更申请与生效预览 HTTP 集成测试：真实启动 server.js（临时数据文件+随机端口）。
 *
 * 走完 线上任务 -> 导出 -> 导入回放空间 -> 意见 -> 会话 -> 归档差异 -> 纠错批次
 * 的准备链路后覆盖：
 *   跨资源申请（space/session/batch）、批准后即时生效（下一个请求即按新角色放行）、
 *   拒绝不改变权限、并发审批（同申请只成功一次，旧 X-Request-Version 拒绝）、
 *   过期边界（截止前可批、截止后 409 request_expired 落终态）、
 *   撤销后重新申请、负责人审批自己的申请被拒、重复申请拒绝、
 *   申请集合与正式委派集合独立版本号、待处理申请不改变实际授权、
 *   生效预览四分组（即将生效/即将失效/撤销/待处理）、预览不改权限不推 rev、
 *   撤销申请批准 -> 正式委派立即撤销、历史申请/记录只读、重启恢复
 *   （申请状态/版本/拒绝原因/预览依据时间点）。
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

const PORT = 9400 + Math.floor(Math.random() * 300);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(TMP, "prq-snap-" + TAG + ".json"),
  ANN_DATA: path.join(TMP, "prq-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(TMP, "prq-batch-" + TAG + ".json"),
  DEC_DATA: path.join(TMP, "prq-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(TMP, "prq-space-" + TAG + ".json"),
  ARCHIVE_DATA: path.join(TMP, "prq-arc-" + TAG + ".json"),
  RECON_DATA: path.join(TMP, "prq-recon-" + TAG + ".json"),
  PERM_DATA: path.join(TMP, "prq-perm-" + TAG + ".json")
};
// 极短申请审批有效期：通过 TTL 控制过期边界（不依赖墙钟 sleep 太久）
const SHORT_TTL = "1500";

let server;
function startServer(extraEnv) {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: FILES.SNAP_DATA, ANNOTATIONS_FILE: FILES.ANN_DATA,
      REVIEW_BATCHES_FILE: FILES.BATCH_DATA, REVIEW_DECISIONS_FILE: FILES.DEC_DATA,
      REPLAY_SPACES_FILE: FILES.REPLAY_DATA, REPLAY_ARCHIVES_FILE: FILES.ARCHIVE_DATA,
      REPLAY_RECONCILE_FILE: FILES.RECON_DATA, PERMISSIONS_FILE: FILES.PERM_DATA,
      DECISION_SCHEDULER_INTERVAL_MS: "100",
      PERMISSION_REQUEST_TTL_MS: SHORT_TTL
    }, extraEnv || {}),
    stdio: ["ignore", "pipe", "inherit"]
  });
  return waitUp();
}
function waitUp() {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/permissions/requests", function (res) {
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
            reqRev: res.headers["x-permission-request-rev"]
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
const PARAS = [{ dir: "ltr", text: "中文示例文本内容用于权限申请集成测试流程" }];
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

describe("权限变更申请与生效预览 API（顺序用例）", function () {
  const ctx = {
    spaceId: null, spaceRev: { v: 1 }, sessionId: null,
    batchId: null, requestRev: "0", permRev: "0"
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

  /* ---------- 准备：空间 + 会话 + 纠错批次 ---------- */

  it("准备：线上任务->导出->导入->意见->会话", async function () {
    let r = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": await annRev() });
    assert.equal(r.status, 201);
    const annotationId = r.data.annotation.id;

    const batch = await request("POST", "/api/review-batches", {
      name: "申请权限批次", owner: "负责人", deadline: farFuture,
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
        actor: "甲" }, { "If-Match": await drev() });
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
    }, { "If-Match": await drev() });    assert.equal(r.status, 201, JSON.stringify(r.data));
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
    const reviewId = rv.data.review.id;

    const cs = await request("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions",
      { name: "申请会话", participants: ["参与人甲"],
        deadline: iso(Date.now() + HOUR), reviewIds: [reviewId],
        actor: "负责人" },
      { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(cs.status, 201, JSON.stringify(cs.data));
    ctx.sessionId = cs.data.session.id;
    ctx.spaceRev.v = cs.data.spaceRev;
  });

  it("准备：生成两个归档、差异与纠错批次", async function () {
    // 完成会话：参与人提交结论
    const sid = ctx.sessionId;
    const detail = await request("GET",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + sid);
    const itemReviewId = detail.data.session.items[0].reviewId;
    const sver = detail.data.session.version;
    const con = await as("参与人甲")("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + sid + "/conclusions",
      { reviewId: itemReviewId, result: "confirm", note: "ok", actor: "参与人甲" },
      { "If-Match": String(ctx.spaceRev.v), "X-Session-Version": String(sver) });
    assert.ok(con.status === 200 || con.status === 201, JSON.stringify(con.data));
    ctx.spaceRev.v = con.data.spaceRev;

    const arc = await request("POST",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + sid + "/archive",
      {}, { "If-Match": String(ctx.spaceRev.v) });
    assert.equal(arc.status, 201, JSON.stringify(arc.data));
    const arcId = arc.data.archive.id;

    // 恢复归档到新空间得到第二个不同空间，再归档其会话
    const rest = await request("POST", "/api/replay/archives/" + arcId + "/restore",
      { name: "恢复空间B", actor: "负责人" });
    assert.equal(rest.status, 201, JSON.stringify(rest.data));
    // 在恢复空间新建并完成一个会话后归档，以获得两个可比较的归档
    const newSpaceId = rest.data.space.id;
    let sp = await request("GET", "/api/replay/spaces/" + newSpaceId);
    let rev = sp.data.space.rev;
    // 恢复空间带入了原意见；先关闭它，才能在同一事件上提新意见
    const eventIdB = sp.data.space.content.events[0].id;
    const existingRv = (sp.data.space.reviews || []).find(function (x) {
      return x.target && x.target.eventId === eventIdB && x.status !== "closed";
    });
    if (existingRv) {
      const cl = await request("POST",
        "/api/replay/spaces/" + newSpaceId + "/reviews/" + existingRv.id +
        "/close",
        { reason: "准备新会话", actor: "负责人" },
        { "If-Match": String(rev),
          "X-Review-Version": String(existingRv.version) });
      assert.ok(cl.status === 200 || cl.status === 201, JSON.stringify(cl.data));
      rev = cl.data.spaceRev;
    }
    const rv2 = await request("POST",
      "/api/replay/spaces/" + newSpaceId + "/reviews",
      { target: { kind: "event", eventId: eventIdB },
        reviewer: "复核人乙", content: "意见2",
        dueAt: iso(Date.now() + HOUR), actor: "负责人" },
      { "If-Match": String(rev) });
    assert.equal(rv2.status, 201, JSON.stringify(rv2.data));
    rev = rv2.data.spaceRev;
    const cs2 = await request("POST",
      "/api/replay/spaces/" + newSpaceId + "/sessions",
      { name: "B会话", participants: ["参与人乙"],
        deadline: iso(Date.now() + HOUR),
        reviewIds: [rv2.data.review.id], actor: "负责人" },
      { "If-Match": String(rev) });
    assert.equal(cs2.status, 201, JSON.stringify(cs2.data));
    rev = cs2.data.spaceRev;
    const sid2 = cs2.data.session.id;
    const d2 = await request("GET",
      "/api/replay/spaces/" + newSpaceId + "/sessions/" + sid2);
    const con2 = await as("参与人乙")("POST",
      "/api/replay/spaces/" + newSpaceId + "/sessions/" + sid2 + "/conclusions",
      { reviewId: d2.data.session.items[0].reviewId, result: "reject",
        note: "no", actor: "参与人乙" },
      { "If-Match": String(rev),
        "X-Session-Version": String(d2.data.session.version) });
    assert.ok(con2.status === 200 || con2.status === 201, JSON.stringify(con2.data));
    rev = con2.data.spaceRev;
    const arcB = await request("POST",
      "/api/replay/spaces/" + newSpaceId + "/sessions/" + sid2 + "/archive",
      {}, { "If-Match": String(rev) });
    assert.equal(arcB.status, 201, JSON.stringify(arcB.data));

    // 差异
    const diff = await request("POST", "/api/replay/reconcile/diff",
      { aId: arcId, bId: arcB.data.archive.id, actor: "负责人" },
      { "If-Match": (await request("GET", "/api/replay/reconcile/diffs"))
        .headers["x-reconcile-rev"] });
    assert.equal(diff.status, 201, JSON.stringify(diff.data));
    const diffId = diff.data.diff.id;
    const diffDetail = await request("GET",
      "/api/replay/reconcile/diffs/" + diffId);
    const items = (diffDetail.data.diff.items || [])
      .filter(function (it) { return it.resolvable; })
      .map(function (it) { return { id: it.id, resolution: "keep_a" }; });
    assert.ok(items.length >= 1, "差异至少有一条可裁决项");
    const reconRev = (await request("GET", "/api/replay/reconcile/diffs"))
      .headers["x-reconcile-rev"];
    const bc = await request("POST", "/api/replay/reconcile/batches",
      { diffId: diffId, name: "申请纠错批次", owner: "负责人",
        deadline: farFuture, approvers: ["审批人A"],
        items: items, actor: "负责人" },
      { "If-Match": reconRev });
    assert.equal(bc.status, 201, JSON.stringify(bc.data));
    ctx.batchId = bc.data.batch.id;
  });

  /* ---------- 启用三类资源管控（任一委派记录即启用） ---------- */

  it("准备：负责人授予基准成员角色，启用 space/session/batch 管控", async function () {
    const targets = [
      { scope: "space", resourceId: ctx.spaceId, role: "view" },
      { scope: "session", resourceId: ctx.sessionId, role: "view" },
      { scope: "batch", resourceId: ctx.batchId, role: "view" }
    ];
    for (const t of targets) {
      const r = await request("POST", "/api/permissions/delegations",
        Object.assign({ member: "基准成员",
          expireAt: iso(Date.now() + 24 * HOUR) }, t),
        { "If-Match": ctx.permRev });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ctx.permRev = r.prev;
    }
  });

  /* ---------- 申请提交：跨资源、待处理不改权限 ---------- */

  it("普通成员可对 space/session/batch 跨资源提交授予申请", async function () {
    const bodies = [
      { scope: "space", resourceId: ctx.spaceId, role: "view" },
      { scope: "session", resourceId: ctx.sessionId, role: "review" },
      { scope: "batch", resourceId: ctx.batchId, role: "execute",
        expireAt: iso(Date.now() + 24 * HOUR) }
    ];
    for (const b of bodies) {
      const body = Object.assign({
        kind: "grant", member: "张三",
        expireAt: iso(Date.now() + 24 * HOUR), note: "需要访问"
      }, b);
      const r = await as("张三")("POST", "/api/permissions/requests", body,
        { "If-Match": ctx.requestRev });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      ctx.requestRev = r.reqRev;
      assert.equal(r.data.request.version, 1);
      assert.equal(r.data.request.status, "pending");
      assert.equal(r.data.request.createdBy, "张三");
      assert.ok(r.data.request.expiresAt);
    }
  });

  it("待处理申请不改变实际授权（张三仍 403）", async function () {
    const r = await as("张三")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "unauthorized");
  });

  it("重复申请被明确拒绝 duplicate_request", async function () {
    const r = await as("张三")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "张三", expireAt: iso(Date.now() + 24 * HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "duplicate_request");
    assert.ok(r.data.existingRequestId);
    // 被拒不推进申请集合版本
    const list = await request("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(list.reqRev, ctx.requestRev);
  });

  it("不能替别人申请；非本人不能查他人的申请明细", async function () {
    const r = await as("李四")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "张三", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "request_for_other_member");
    const mine = await as("张三")("GET",
      "/api/permissions/requests?member=" + encodeURIComponent("张三"));
    const otherId = mine.data.requests[0].id;
    const peek = await as("李四")("GET",
      "/api/permissions/requests/" + otherId);
    assert.equal(peek.status, 403);
    // 申请人本人可见
    const self = await as("张三")("GET",
      "/api/permissions/requests/" + otherId);
    assert.equal(self.status, 200);
  });

  /* ---------- 审批：拒绝不变权 / 批准即时生效 ---------- */

  it("拒绝必须填原因；拒绝后权限不变，但状态/处理人/原因可查", async function () {
    const list = await request("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId);
    const q = list.data.requests.find(function (x) {
      return x.role === "view" && x.status === "pending";
    });
    let r = await request("POST",
      "/api/permissions/requests/" + q.id + "/decision",
      { decision: "reject", reason: "" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "reject_reason_required");

    r = await request("POST",
      "/api/permissions/requests/" + q.id + "/decision",
      { decision: "reject", reason: "暂不需要该权限" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.request.status, "rejected");
    assert.equal(r.data.request.version, 2);
    assert.equal(r.data.request.decidedBy, "负责人");
    assert.equal(r.data.request.decisionReason, "暂不需要该权限");
    ctx.requestRev = r.reqRev;
    // 正式委派集合 rev 不变（拒绝不产生委派）
    assert.equal(r.data.rev, Number(ctx.permRev));

    // 张三依旧 403
    const denied = await as("张三")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
  });

  it("批准 session review 申请后即时生效：下一个请求即放行", async function () {
    const list = await request("GET",
      "/api/permissions/requests?scope=session&resourceId=" + ctx.sessionId);
    const q = list.data.requests[0];
    // 批准前张三无权查看会话
    const before = await as("张三")("GET",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + ctx.sessionId);
    assert.equal(before.status, 403);

    const r = await request("POST",
      "/api/permissions/requests/" + q.id + "/decision",
      { decision: "approve", reason: "同意" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.request.status, "approved");
    assert.ok(r.data.request.generatedDelegationId);
    assert.ok(r.data.delegation);
    assert.equal(r.data.delegation.member, "张三");
    ctx.requestRev = r.reqRev;
    ctx.permRev = String(r.data.rev);

    // 即时生效
    const after = await as("张三")("GET",
      "/api/replay/spaces/" + ctx.spaceId + "/sessions/" + ctx.sessionId);
    assert.equal(after.status, 200);
    // /effective 反映新角色
    const eff = await as("张三")("GET", "/api/permissions/effective?scope=session" +
      "&resourceId=" + ctx.sessionId);
    assert.ok(eff.data.roles.indexOf("review") !== -1);
  });

  it("非负责人不能审批；负责人审批自己的申请 -> self_approval", async function () {
    // 张三自己的 batch 申请：先用负责人身份尝试（负责人 != 张三，可以批）。
    // 这里测另一条：李四（非负责人）审批被拒
    const list = await request("GET",
      "/api/permissions/requests?scope=batch&resourceId=" + ctx.batchId);
    const q = list.data.requests[0];
    const r = await as("李四")("POST",
      "/api/permissions/requests/" + q.id + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "not_resource_owner");

    // 负责人“负责人”以成员身份提交申请后自批
    const create = await request("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "负责人", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    const selfId = create.data.request.id;
    const self = await request("POST",
      "/api/permissions/requests/" + selfId + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(self.status, 403);
    assert.equal(self.data.error, "self_approval");
  });

  /* ---------- 并发审批：同申请只成功一次 ---------- */

  it("并发审批同一申请：一个成功，另一个旧版本号被拒", async function () {
    const create = await as("王五")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "王五", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    const id = create.data.request.id;
    const [a, b] = await Promise.all([
      request("POST", "/api/permissions/requests/" + id + "/decision",
        { decision: "approve", reason: "并发A" },
        { "If-Match": ctx.requestRev, "X-Request-Version": "1" }),
      request("POST", "/api/permissions/requests/" + id + "/decision",
        { decision: "reject", reason: "并发B" },
        { "If-Match": ctx.requestRev, "X-Request-Version": "1" })
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409]);
    const okOne = a.status === 200 ? a : b;
    const badOne = a.status === 200 ? b : a;
    // 失败方要么撞申请集合版本（version_conflict），要么撞申请自身版本
    // （request_version_conflict）——两者都明确拒绝且不写入
    assert.ok(["version_conflict", "request_version_conflict"]
      .indexOf(badOne.data.error) !== -1, badOne.data.error);
    assert.equal(okOne.data.request.version, 2);
    ctx.requestRev = okOne.reqRev;
    ctx.permRev = String(okOne.data.rev);
    // 最终状态唯一：批准
    const get = await request("GET", "/api/permissions/requests/" + id);
    assert.equal(get.data.request.status, "approved");
    // 只有一条正式委派
    const dels = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" + ctx.spaceId +
      "&member=" + encodeURIComponent("王五"));
    assert.equal(dels.data.count, 1);

    // 串行的旧 X-Request-Version：申请集合 rev 最新但申请版本已推进 ->
    // request_version_conflict
    const stale = await request("POST",
      "/api/permissions/requests/" + id + "/decision",
      { decision: "reject", reason: "旧版本" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, "request_version_conflict");
    assert.equal(stale.data.currentVersion, 2);
  });

  /* ---------- 过期边界 ---------- */

  it("过期申请：截止后审批 409 request_expired，落 expired 终态，权限不变", async function () {
    const create = await as("赵六")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "赵六", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    const id = create.data.request.id;
    await sleep(Number(SHORT_TTL) + 400);

    const late = await request("POST",
      "/api/permissions/requests/" + id + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(late.status, 409);
    assert.equal(late.data.error, "request_expired");
    assert.equal(late.data.currentStatus, "expired");
    ctx.requestRev = late.reqRev;

    const get = await request("GET", "/api/permissions/requests/" + id);
    assert.equal(get.data.request.status, "expired");
    assert.equal(get.data.request.displayState, "expired");
    assert.equal(get.data.request.decidedBy, "负责人");
    // 权限未变
    const denied = await as("赵六")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
    // 终态再次审批仍被 request_expired（终态只读）
    const again = await request("POST",
      "/api/permissions/requests/" + id + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev,
        "X-Request-Version": String(late.data.currentVersion) });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "request_not_pending");
  });

  it("过期后可重新申请（过期申请不阻止新申请），新申请批准成功", async function () {
    const create = await as("赵六")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "赵六", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    const approve = await request("POST",
      "/api/permissions/requests/" + create.data.request.id + "/decision",
      { decision: "approve", reason: "重新提交后批准" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(approve.status, 200, JSON.stringify(approve.data));
    ctx.requestRev = approve.reqRev;
    ctx.permRev = String(approve.data.rev);
    const eff = await as("赵六")("GET", "/api/permissions/effective?scope=space" +
      "&resourceId=" + ctx.spaceId);
    assert.ok(eff.data.roles.indexOf("review") !== -1);
  });

  /* ---------- 撤销申请 + 撤销后重新申请 ---------- */

  it("撤销申请：普通成员提交 -> 负责人批准 -> 正式委派即时撤销", async function () {
    // 赵六当前持有 space review；先查到 delegationId
    const dels = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" + ctx.spaceId +
      "&member=" + encodeURIComponent("赵六") + "&role=review");
    assert.equal(dels.data.count, 1);
    const delegationId = dels.data.delegations[0].id;

    const create = await as("赵六")("POST", "/api/permissions/requests", {
      kind: "revoke", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "赵六", delegationId: delegationId, note: "不再需要"
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    // 重复撤销申请被拒
    const dup = await as("赵六")("POST", "/api/permissions/requests", {
      kind: "revoke", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "赵六", delegationId: delegationId
    }, { "If-Match": ctx.requestRev });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error, "duplicate_revoke_request");

    const approve = await request("POST",
      "/api/permissions/requests/" + create.data.request.id + "/decision",
      { decision: "approve", reason: "同意交回" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(approve.status, 200, JSON.stringify(approve.data));
    ctx.requestRev = approve.reqRev;
    ctx.permRev = String(approve.data.rev);
    // 正式委派已撤销
    const after = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" + ctx.spaceId +
      "&member=" + encodeURIComponent("赵六") + "&role=review");
    assert.equal(after.data.delegations[0].status, "revoked");
    assert.equal(after.data.delegations[0].revokedBy, "负责人");
    // 赵六立即失权
    const denied = await as("赵六")("GET",
      "/api/replay/spaces/" + ctx.spaceId);
    assert.equal(denied.status, 403);
  });

  it("撤销后可重新申请同一角色并批准", async function () {
    const create = await as("赵六")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "赵六", expireAt: iso(Date.now() + HOUR), note: "再次需要"
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    const approve = await request("POST",
      "/api/permissions/requests/" + create.data.request.id + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(approve.status, 200, JSON.stringify(approve.data));
    ctx.requestRev = approve.reqRev;
    ctx.permRev = String(approve.data.rev);
  });

  /* ---------- 生效预览 ---------- */

  it("预览：未来生效委派出现在 activating；待处理申请只在 pending 组", async function () {
    // 孙七：申请一个未来时刻才生效的 review，批准后预览
    const startIn2h = new Date(Date.now() + 2 * HOUR).toISOString();
    const endIn24h = new Date(Date.now() + 24 * HOUR).toISOString();
    const create = await as("孙七")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "review",
      member: "孙七", effectiveAt: startIn2h, expireAt: endIn24h
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    const approve = await request("POST",
      "/api/permissions/requests/" + create.data.request.id + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(approve.status, 200, JSON.stringify(approve.data));
    ctx.requestRev = approve.reqRev;
    ctx.permRev = String(approve.data.rev);

    // 再提一条待处理申请（不批准）
    const pending = await as("孙七")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "孙七", expireAt: iso(Date.now() + 5 * HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(pending.status, 201, JSON.stringify(pending.data));
    ctx.requestRev = pending.reqRev;

    const revBefore = ctx.permRev;
    const at3h = new Date(Date.now() + 3 * HOUR).toISOString();
    const pv = await as("孙七")("GET", "/api/permissions/preview?scope=space" +
      "&resourceId=" + ctx.spaceId + "&at=" + encodeURIComponent(at3h));
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    // review 已激活；view 待处理申请不计入
    assert.deepEqual(pv.data.roles.sort(), ["review"]);
    assert.equal(pv.data.activating.length, 1);
    assert.equal(pv.data.activating[0].role, "review");
    assert.equal(pv.data.pending.length, 1);
    assert.equal(pv.data.pending[0].role, "view");
    assert.equal(pv.data.basedOn.permissionRev, Number(revBefore));
    // 预览不推 rev
    const dels = await request("GET", "/api/permissions/delegations?scope=space" +
      "&resourceId=" + ctx.spaceId + "&member=" + encodeURIComponent("孙七"));
    assert.equal(dels.data.rev, Number(revBefore));
  });

  it("预览：即将失效与已批准撤销分组正确", async function () {
    // 周八：批准一个 1 小时后到期的 view
    // 周八：批准一个 24 小时后到期的 view（使撤销成为 +2h 预览中失效的唯一原因）
    const create = await as("周八")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "周八", expireAt: iso(Date.now() + 24 * HOUR)
    }, { "If-Match": ctx.requestRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    ctx.requestRev = create.reqRev;
    let r = await request("POST",
      "/api/permissions/requests/" + create.data.request.id + "/decision",
      { decision: "approve" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.requestRev = r.reqRev; ctx.permRev = String(r.data.rev);

    // 立即申请撤销并批准
    const delId = r.data.request.generatedDelegationId;
    const rv = await as("周八")("POST", "/api/permissions/requests", {
      kind: "revoke", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "周八", delegationId: delId
    }, { "If-Match": ctx.requestRev });
    assert.equal(rv.status, 201, JSON.stringify(rv.data));
    ctx.requestRev = rv.reqRev;
    r = await request("POST",
      "/api/permissions/requests/" + rv.data.request.id + "/decision",
      { decision: "approve", reason: "收回" },
      { "If-Match": ctx.requestRev, "X-Request-Version": "1" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.requestRev = r.reqRev; ctx.permRev = String(r.data.rev);

    const at2h = new Date(Date.now() + 2 * HOUR).toISOString();
    const pv = await request("GET", "/api/permissions/preview?scope=space" +
      "&resourceId=" + ctx.spaceId + "&member=" + encodeURIComponent("周八") +
      "&at=" + encodeURIComponent(at2h));
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    assert.deepEqual(pv.data.roles, []);
    assert.equal(pv.data.revoking.length, 1);
    assert.equal(pv.data.revoking[0].revokedByRequestId, rv.data.request.id);
    assert.equal(pv.data.expiring.length, 0); // 撤销优先归类为 revoking
  });

  it("预览权限：普通成员不能预览他人；非法 at 400", async function () {
    const r = await as("张三")("GET", "/api/permissions/preview?scope=space" +
      "&resourceId=" + ctx.spaceId + "&member=" + encodeURIComponent("周八") +
      "&at=" + encodeURIComponent(iso(Date.now() + HOUR)));
    assert.equal(r.status, 403);
    const bad = await as("张三")("GET", "/api/permissions/preview?scope=space" +
      "&resourceId=" + ctx.spaceId + "&at=not-a-time");
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, "invalid_at");
  });

  /* ---------- 审计链与版本独立性 ---------- */

  it("申请审计记录完整（提交/批准/拒绝/过期），且与委派 rev 相互独立", async function () {
    const logs = await request("GET", "/api/permissions/requests/logs");
    assert.equal(logs.status, 200);
    const actions = logs.data.logs.map(function (l) { return l.action; });
    assert.ok(actions.indexOf("submit") !== -1);
    assert.ok(actions.indexOf("approve_grant") !== -1);
    assert.ok(actions.indexOf("reject") !== -1);
    assert.ok(actions.indexOf("expire") !== -1);
    assert.ok(actions.indexOf("approve_revoke") !== -1);
    // 每个处理动作都带 requestId/version/actor/member
    const decided = logs.data.logs.find(function (l) {
      return l.action === "approve_grant";
    });
    assert.ok(decided.requestId);
    assert.ok(decided.version >= 2);
    assert.equal(decided.actor, "负责人");
    assert.ok(decided.delegationId);
    // 普通成员只能看到自己相关的审计记录
    const mine = await as("孙七")("GET",
      "/api/permissions/requests/logs?scope=space&resourceId=" + ctx.spaceId);
    assert.ok(mine.data.logs.every(function (l) {
      return l.member === "孙七" || l.actor === "孙七";
    }));
  });

  it("旧申请集合版本号提交/审批均 409 version_conflict（不写盘）", async function () {
    const r = await as("吴九")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "吴九", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": String(Number(ctx.requestRev) - 1) });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "version_conflict");
  });

  /* ---------- 重启恢复 ---------- */

  it("重启后：申请状态/版本/拒绝原因/处理记录/预览依据全部恢复", async function () {
    const beforeReqRev = ctx.requestRev;
    const beforePermRev = ctx.permRev;
    await restartServer();

    const list = await request("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId);
    assert.equal(list.reqRev, beforeReqRev);
    const rejected = list.data.requests.find(function (q) {
      return q.status === "rejected";
    });
    assert.ok(rejected, "拒绝申请仍可查");
    assert.equal(rejected.decisionReason, "暂不需要该权限");
    assert.equal(rejected.decidedBy, "负责人");
    assert.ok(rejected.decidedAt);
    const expired = list.data.requests.find(function (q) {
      return q.status === "expired";
    });
    assert.ok(expired, "过期申请仍可查");
    const approved = list.data.requests.find(function (q) {
      return q.status === "approved" && q.member === "孙七";
    });
    assert.ok(approved.generatedDelegationId);
    assert.ok(approved.version >= 2);

    // 正式委派 rev 独立且恢复
    const dels = await request("GET", "/api/permissions/delegations?scope=space" +
      "&resourceId=" + ctx.spaceId);
    assert.equal(dels.data.rev, Number(beforePermRev));

    // 预览在重启后同一时间点结果一致
    const at3h = new Date(Date.now() + 3 * HOUR).toISOString();
    const pv = await as("孙七")("GET", "/api/permissions/preview?scope=space" +
      "&resourceId=" + ctx.spaceId + "&at=" + encodeURIComponent(at3h));
    assert.equal(pv.status, 200);
    assert.deepEqual(pv.data.roles.sort(), ["review"]);
    assert.equal(pv.data.basedOn.permissionRev, Number(beforePermRev));
    assert.equal(pv.data.basedOn.requestRev, Number(beforeReqRev));

    // 重启后审批流可继续：新申请提交+批准
    const create = await as("郑十")("POST", "/api/permissions/requests", {
      kind: "grant", scope: "space", resourceId: ctx.spaceId, role: "view",
      member: "郑十", expireAt: iso(Date.now() + HOUR)
    }, { "If-Match": list.reqRev });
    assert.equal(create.status, 201, JSON.stringify(create.data));
  });

  it("历史申请只读：已终态申请不能再改；正式委派记录保留授予申请关联", async function () {
    const list = await request("GET",
      "/api/permissions/requests?scope=space&resourceId=" + ctx.spaceId);
    const rejected = list.data.requests.find(function (q) {
      return q.status === "rejected";
    });
    const r = await request("POST",
      "/api/permissions/requests/" + rejected.id + "/decision",
      { decision: "approve" },
      { "If-Match": list.reqRev,
        "X-Request-Version": String(rejected.version) });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "request_not_pending");

    const dels = await request("GET",
      "/api/permissions/delegations?scope=space&resourceId=" + ctx.spaceId +
      "&member=" + encodeURIComponent("王五"));
    assert.ok(dels.data.delegations[0].id.indexOf("del_") === 0);
  });
});
