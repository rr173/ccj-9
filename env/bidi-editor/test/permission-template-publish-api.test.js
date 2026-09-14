/* node --test test/permission-template-publish-api.test.js
 * 模板发布、计划发布、取消、回滚与并发一致性的集成测试。
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

const PORT = 9800 + Math.floor(Math.random() * 150);
const BASE = "http://127.0.0.1:" + PORT;
const TAG = Date.now() + "-" + process.pid;
const FILES = {
  SNAP_DATA: path.join(os.tmpdir(), "tpub-snap-" + TAG + ".json"),
  ANN_DATA: path.join(os.tmpdir(), "tpub-ann-" + TAG + ".json"),
  BATCH_DATA: path.join(os.tmpdir(), "tpub-batch-" + TAG + ".json"),
  DEC_DATA: path.join(os.tmpdir(), "tpub-dec-" + TAG + ".json"),
  REPLAY_DATA: path.join(os.tmpdir(), "tpub-space-" + TAG + ".json"),
  ARCHIVE_DATA: path.join(os.tmpdir(), "tpub-arc-" + TAG + ".json"),
  RECON_DATA: path.join(os.tmpdir(), "tpub-recon-" + TAG + ".json"),
  PERM_DATA: path.join(os.tmpdir(), "tpub-perm-" + TAG + ".json")
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
      PERMISSION_TEMPLATE_PUBLISH_INTERVAL_MS: "50"
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
        else setTimeout(ping, 50);
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
            reqRev: res.headers["x-permission-request-rev"],
            grpRev: res.headers["x-permission-group-rev"],
            tplRev: res.headers["x-permission-template-rev"]
          });
        });
      });
      req.on("error", function () {
        if (attempt < 30) setTimeout(function () { doRequest(attempt + 1); }, 50);
        else resolve({ status: 0, data: null, text: "", tplRev: null });
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
const PARAS = [{ dir: "ltr", text: "中文示例文本内容用于模板发布集成测试流程" }];
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

describe("模板发布与回滚 API", function () {
  const ctx = {
    spaceId: null, requestRev: "0", templateRev: "0",
    tpl: null, tplOther: null, submittedId: null, planId: null,
    groupRev: "0", groupId: null
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

  it("准备：空间", async function () {
    let r = await request("POST", "/api/annotations",
      { author: "审阅者", body: "m1", paraIndex: 0, start: 0, end: 2,
        quote: "中文", paraDir: "ltr" }, { "If-Match": await annRev() });
    assert.equal(r.status, 201);
    const annotationId = r.data.annotation.id;
    const batch = await request("POST", "/api/review-batches", {
      name: "模板发布批次", owner: "负责人", deadline: farFuture,
      annotationIds: [annotationId]
    }, { "If-Match": await batchRev() });
    assert.equal(batch.status, 201, JSON.stringify(batch.data));
    r = await request("POST", "/api/review-decisions",
      { batchId: batch.data.batch.id, threshold: 1, paragraphs: PARAS, items: [] },
      { "If-Match": await drev() });
    assert.equal(r.status, 201);
    const did = r.data.decision.id;
    await request("PUT", "/api/review-decisions/" + did + "/items",
      { items: [{ annotationId: annotationId, disposition: "delete" }], actor: "甲" },
      { "If-Match": await drev() });
    await request("POST", "/api/review-decisions/" + did + "/submit",
      { actor: "甲" }, { "If-Match": await drev() });
    await request("POST", "/api/review-decisions/" + did + "/votes",
      { annotationId: annotationId, vote: "approve", voter: "甲" },
      { "If-Match": await drev() });
    await request("POST", "/api/execution-tasks", {
      decisionId: did, scheduledAt: iso(Date.now() + 300),
      paragraphs: PARAS, actor: "负责人"
    }, { "If-Match": await drev() });
    await sleep(700);
    const exp = await request("POST", "/api/replay/export", { actor: "负责人" });
    assert.equal(exp.status, 200);
    const imp = await request("POST", "/api/replay/import", exp.data);
    assert.equal(imp.status, 201);
    ctx.spaceId = imp.data.space.id;
  });

  it("创建即发布；编辑生成草稿，成员仍只能看到和提交 v1", async function () {
    let r = await request("POST", "/api/permissions/request-templates", {
      name: "发布模板", scope: "space", resourceId: ctx.spaceId,
      role: "view", kind: "grant", defaultDurationMs: DAY,
      memberScope: { mode: "members", members: ["张三", "李四"] }
    }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ctx.tpl = r.data.template.id;
    ctx.templateRev = r.tplRev;
    assert.equal(r.data.template.publishedVersion, 1);
    assert.equal(r.data.template.draftStatus, "none");
    assert.equal(r.data.template.releases.length, 1);

    r = await request("PATCH", "/api/permissions/request-templates/" + ctx.tpl,
      { defaultDurationMs: 2 * DAY }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ctx.templateRev = r.tplRev;
    assert.equal(r.data.template.publishedVersion, 1);
    assert.equal(r.data.template.draftStatus, "unpublished");
    assert.equal(r.data.template.draft.draftVersion, 1);
    assert.equal(r.data.template.defaultDurationMs, DAY);

    const view = await as("李四")("GET",
      "/api/permissions/request-templates/" + ctx.tpl);
    assert.equal(view.status, 200);
    assert.equal(view.data.template.currentVersion, 1);
    assert.equal(view.data.template.defaultDurationMs, DAY);
    assert.equal(view.data.template.draftStatus, undefined);

    const submit = await as("李四")("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(submit.status, 201, JSON.stringify(submit.data));
    ctx.requestRev = submit.reqRev;
    ctx.submittedId = submit.data.request.id;
    assert.equal(submit.data.request.templateVersion, 1);
    assert.equal(submit.data.request.templateSnapshot.defaultDurationMs, DAY);
  });

  it("立即发布生成独立发布版本；已提交申请不被改写，后续申请固定到新版本", async function () {
    const pub = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/publish",
      { draftVersion: 1 }, { "If-Match": ctx.templateRev });
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    ctx.templateRev = pub.tplRev;
    assert.equal(pub.data.release.version, 2);
    assert.equal(pub.data.template.publishedVersion, 2);
    assert.equal(pub.data.template.draft, null);
    assert.equal(pub.data.template.defaultDurationMs, 2 * DAY);

    const old = await request("GET",
      "/api/permissions/requests/" + ctx.submittedId);
    assert.equal(old.data.request.templateVersion, 1);
    assert.equal(old.data.request.templateSnapshot.defaultDurationMs, DAY);

    const oldVersion = await as("张三")("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/submit",
      { templateVersion: 1 }, { "If-Match": ctx.requestRev });
    assert.equal(oldVersion.status, 409);
    assert.equal(oldVersion.data.error, "template_version_changed");
    assert.equal(oldVersion.data.currentVersion, 2);
  });

  it("申请分组只使用已提交申请固化的发布版本，后续发布不改写组内统计和快照", async function () {
    const g = await request("POST", "/api/permissions/request-groups", {
      name: "模板版本组", scope: "space", resourceId: ctx.spaceId
    }, { "If-Match": ctx.groupRev });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    ctx.groupId = g.data.group.id;
    ctx.groupRev = g.grpRev;

    const add = await request("POST",
      "/api/permissions/request-groups/" + ctx.groupId + "/requests",
      { requestIds: [ctx.submittedId] }, { "If-Match": ctx.groupRev });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    ctx.groupRev = add.grpRev;
    ctx.requestRev = add.reqRev;

    const detail = await request("GET",
      "/api/permissions/request-groups/" + ctx.groupId);
    assert.equal(detail.data.requests[0].templateVersion, 1);
    assert.equal(
      detail.data.requests[0].templateSnapshot.defaultDurationMs, DAY);
    assert.equal(detail.data.group.totalCount, 1);
    assert.equal(detail.data.group.pendingCount, 1);

    const memberView = await as("李四")("GET",
      "/api/permissions/request-groups/" + ctx.groupId);
    assert.equal(memberView.data.requests[0].templateVersion, 1);
    assert.equal(memberView.data.requests[0].templateVersion, 1);
  });

  it("回滚产生新版本且不覆盖历史；非法目标和未发布草稿均拒绝", async function () {
    let r = await request("PATCH", "/api/permissions/request-templates/" + ctx.tpl,
      { defaultDurationMs: 3 * DAY }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 200);
    const draftRev = r.tplRev;

    r = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/rollback",
      { releaseVersion: 1 }, { "If-Match": draftRev });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "draft_exists");
    // 失败不留审计半成品：回滚日志不存在，版本不变
    const unchanged = await request("GET",
      "/api/permissions/request-templates/" + ctx.tpl);
    assert.equal(unchanged.data.template.publishedVersion, 2);

    const discard = await request("DELETE",
      "/api/permissions/request-templates/" + ctx.tpl + "/draft",
      null, { "If-Match": draftRev });
    assert.equal(discard.status, 200, JSON.stringify(discard.data));
    ctx.templateRev = discard.tplRev;

    const missing = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/rollback",
      { releaseVersion: 99 }, { "If-Match": ctx.templateRev });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, "release_version_not_found");

    const rb = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/rollback",
      { releaseVersion: 1, reason: "恢复旧有效期" },
      { "If-Match": ctx.templateRev });
    assert.equal(rb.status, 200, JSON.stringify(rb.data));
    ctx.templateRev = rb.tplRev;
    assert.equal(rb.data.release.version, 3);
    assert.equal(rb.data.targetReleaseVersion, 1);
    assert.equal(rb.data.template.defaultDurationMs, DAY);
    assert.equal(rb.data.template.releases.length, 3);
    assert.equal(rb.data.template.releases[0].source, "rollback");
  });

  it("未来计划发布：成员暂不可见，到点后自动生效；重复触发幂等；重启可恢复", async function () {
    let r = await request("PATCH", "/api/permissions/request-templates/" + ctx.tpl,
      { defaultDurationMs: 4 * DAY }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const dVer = r.data.template.draft.draftVersion;
    ctx.templateRev = r.tplRev;
    const scheduledAt = new Date(Date.now() + 500).toISOString();
    const plan = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/publish",
      { draftVersion: dVer, scheduledAt: scheduledAt },
      { "If-Match": ctx.templateRev });
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    ctx.templateRev = plan.tplRev;
    ctx.planId = plan.data.plan.planId;
    assert.equal(plan.data.scheduled, true);
    assert.equal(plan.data.template.scheduledAt, scheduledAt);

    const duplicate = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/publish",
      { draftVersion: dVer, scheduledAt: new Date(Date.now() + 3000).toISOString() },
      { "If-Match": ctx.templateRev });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.error, "scheduled_publish_pending");

    const before = await as("李四")("GET",
      "/api/permissions/request-templates/" + ctx.tpl);
    assert.equal(before.data.template.currentVersion, 3);

    await restartServer();
    await sleep(850);
    for (let i = 0; i < 30; i++) {
      const done = await request("GET",
        "/api/permissions/request-templates/" + ctx.tpl);
      if (done.data.template.publishedVersion === 4) {
        assert.equal(done.data.template.defaultDurationMs, 4 * DAY);
        assert.equal(done.data.template.draftStatus, "none");
        assert.equal(done.data.template.publishPlans[0].status, "succeeded");
        assert.equal(done.data.template.publishPlans[0].releaseVersion, 4);
        ctx.templateRev = done.tplRev;
        break;
      }
      if (i === 29) assert.equal(done.data.template.publishedVersion, 4);
      await sleep(100);
    }

    // 过期计划不会重复执行：发布记录仍只有 4 个，计划状态保持 succeeded。
    await sleep(250);
    const after = await request("GET",
      "/api/permissions/request-templates/" + ctx.tpl);
    assert.equal(after.data.template.releases.length, 4);
    assert.equal(after.data.template.publishPlans[0].status, "succeeded");
  });

  it("取消尚未执行的计划发布；取消后不能再次取消", async function () {
    let r = await request("PATCH", "/api/permissions/request-templates/" + ctx.tpl,
      { defaultDurationMs: 5 * DAY }, { "If-Match": ctx.templateRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const dVer = r.data.template.draft.draftVersion;
    ctx.templateRev = r.tplRev;
    const scheduledAt = new Date(Date.now() + 60 * 60000).toISOString();
    const plan = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl + "/publish",
      { draftVersion: dVer, scheduledAt: scheduledAt },
      { "If-Match": ctx.templateRev });
    assert.equal(plan.status, 200, JSON.stringify(plan.data));
    ctx.templateRev = plan.tplRev;
    const planId = plan.data.plan.planId;

    const cancel = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl +
      "/publish-plans/" + planId + "/cancel",
      { reason: "暂不发布", templateVersion: plan.data.plan.templateVersion,
        draftVersion: plan.data.plan.draftVersion },
      { "If-Match": ctx.templateRev });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
    ctx.templateRev = cancel.tplRev;
    assert.equal(cancel.data.plan.status, "cancelled");
    assert.equal(cancel.data.template.draftStatus, "unpublished");
    assert.equal(cancel.data.template.publishedVersion, 4);

    const again = await request("POST",
      "/api/permissions/request-templates/" + ctx.tpl +
      "/publish-plans/" + planId + "/cancel",
      { templateVersion: plan.data.plan.templateVersion,
        draftVersion: plan.data.plan.draftVersion },
      { "If-Match": ctx.templateRev });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, "publish_plan_not_pending");
  });

  it("同一资源相同时间不能同时生效两个计划；并发旧 templateRev 只有一个写入成功", async function () {
    const baseRev = (await request("GET", "/api/permissions/request-templates")).tplRev;
    const aTpl = await request("POST", "/api/permissions/request-templates", {
      name: "并发计划 A", scope: "space", resourceId: ctx.spaceId,
      role: "view", kind: "revoke"
    }, { "If-Match": baseRev });
    assert.equal(aTpl.status, 201, JSON.stringify(aTpl.data));
    const bTpl = await request("POST", "/api/permissions/request-templates", {
      name: "并发计划 B", scope: "space", resourceId: ctx.spaceId,
      role: "review", kind: "revoke"
    }, { "If-Match": aTpl.tplRev });
    assert.equal(bTpl.status, 201, JSON.stringify(bTpl.data));
    const idA = aTpl.data.template.id;
    const idB = bTpl.data.template.id;
    const baseCurrent = bTpl.tplRev;

    const patchA = request("PATCH",
      "/api/permissions/request-templates/" + idA,
      { name: "同刻计划 A" }, { "If-Match": baseCurrent });
    const patchB = request("PATCH",
      "/api/permissions/request-templates/" + idB,
      { name: "同刻计划 B" }, { "If-Match": baseCurrent });
    const [a, b] = await Promise.all([patchA, patchB]);
    const results = [a, b].sort(function (x) { return x.status === 200 ? -1 : 1; });
    assert.equal(results[0].status, 200);
    assert.equal(results[1].status, 409);
    assert.equal(results[1].data.error, "version_conflict");

    const winnerId = results[0] === a ? idA : idB;
    const winnerRev = results[0].tplRev;
    const scheduledAt = new Date(Date.now() + 2 * HOUR).toISOString();
    const p1 = await request("POST",
      "/api/permissions/request-templates/" + winnerId + "/publish",
      { draftVersion: 1, scheduledAt: scheduledAt }, { "If-Match": winnerRev });
    assert.equal(p1.status, 200, JSON.stringify(p1.data));
    // 另一个模板没有草稿，需要先补一个草稿；同刻计划应被拒绝。
    const otherId = winnerId === idA ? idB : idA;
    const otherDraft = await request("PATCH",
      "/api/permissions/request-templates/" + otherId,
      { name: "同刻计划 B 草稿" }, { "If-Match": p1.tplRev });
    assert.equal(otherDraft.status, 200, JSON.stringify(otherDraft.data));
    const p2 = await request("POST",
      "/api/permissions/request-templates/" + otherId + "/publish",
      { draftVersion: 1, scheduledAt: scheduledAt },
      { "If-Match": otherDraft.tplRev });
    assert.equal(p2.status, 409, JSON.stringify(p2.data));
    assert.equal(p2.data.error, "scheduled_publish_conflict");
  });

  it("计划执行时版本不匹配会失败且不产生半发布，取消/执行过期计划不能重复", async function () {
    const baseRev = (await request("GET", "/api/permissions/request-templates")).tplRev;
    const created = await request("POST", "/api/permissions/request-templates", {
      name: "计划冲突模板", scope: "space", resourceId: ctx.spaceId,
      role: "view", kind: "revoke"
    }, { "If-Match": baseRev });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.template.id;
    let rev = created.tplRev;
    const patched = await request("PATCH",
      "/api/permissions/request-templates/" + id,
      { name: "计划冲突草稿" }, { "If-Match": rev });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    rev = patched.tplRev;
    const scheduledAt = new Date(Date.now() + 300).toISOString();
    const planned = await request("POST",
      "/api/permissions/request-templates/" + id + "/publish",
      { draftVersion: 1, scheduledAt: scheduledAt },
      { "If-Match": rev });
    assert.equal(planned.status, 200, JSON.stringify(planned.data));
    rev = planned.tplRev;
    const planId = planned.data.plan.planId;
    const cancelled = await request("POST",
      "/api/permissions/request-templates/" + id +
      "/publish-plans/" + planId + "/cancel",
      { templateVersion: 1, draftVersion: 1 }, { "If-Match": rev });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    rev = cancelled.tplRev;
    assert.equal(cancelled.data.plan.status, "cancelled");

    // 过期计划不能重复取消。
    const cancelAgain = await request("POST",
      "/api/permissions/request-templates/" + id +
      "/publish-plans/" + planId + "/cancel",
      { templateVersion: 1, draftVersion: 1 }, { "If-Match": rev });
    assert.equal(cancelAgain.status, 409);
    assert.equal(cancelAgain.data.error, "publish_plan_not_pending");
  });

  it("页面与版本接口显示当前发布版本、草稿状态、计划发布时间和发布记录", async function () {
    const versions = await request("GET",
      "/api/permissions/request-templates/" + ctx.tpl + "/versions");
    assert.equal(versions.status, 200);
    assert.equal(versions.data.publishedVersion, 4);
    assert.ok(versions.data.releases.length >= 4);
    assert.ok(versions.data.publishPlans.some(function (p) {
      return p.status === "cancelled";
    }));
    const actions = versions.data.versions.map(function (v) { return v.action; });
    ["publish", "rollback", "schedule_publish", "cancel_publish"].forEach(function (x) {
      assert.ok(actions.indexOf(x) !== -1, x);
    });
  });
});
