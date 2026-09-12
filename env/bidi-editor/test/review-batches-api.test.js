/* node --test test/review-batches-api.test.js
 * 审阅批次 HTTP 集成测试：真实启动 server.js（临时数据文件 + 随机端口），覆盖：
 *   新建校验（空批次/过期时间/不存在的批注/重名成员冲突）、实时进度、
 *   逐条与批量四态更新、双版本乐观锁（旧页面批量更新必被 409 拒绝）、
 *   成员加/移、负责人/截止/说明变更留痕、按时间查审阅记录、
 *   归档冻结（成员状态不可改、删除/回复被拒、完整历史可查）、
 *   快照嵌入所属批次、从快照恢复时的批次对账、重启持久化。
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

const PORT = 8330 + Math.floor(Math.random() * 90);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const SNAP_DATA = path.join(TMP, "batch-snap-" + TAG + ".json");
const ANN_DATA = path.join(TMP, "batch-ann-" + TAG + ".json");
const BATCH_DATA = path.join(TMP, "batch-data-" + TAG + ".json");

let server;

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: SNAP_DATA,
      ANNOTATIONS_FILE: ANN_DATA,
      REVIEW_BATCHES_FILE: BATCH_DATA
    }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  return waitUp();
}

function waitUp() {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/review-batches", function (res) {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", function () {
        if (Date.now() > deadline) reject(new Error("server failed to start"));
        else setTimeout(ping, 100);
      });
    })();
  });
}

describe("审阅批次 API（顺序用例）", function () {
before(async function () { await startServer(); });

after(async function () {
  server.kill();
  for (const f of [SNAP_DATA, SNAP_DATA + ".tmp", ANN_DATA, ANN_DATA + ".tmp",
                   BATCH_DATA, BATCH_DATA + ".tmp"]) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
});

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve) {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = { "Accept": "application/json" };
    if (payload) Object.assign(h,
      { "Content-Type": "application/json", "Content-Length": payload.length });
    if (method !== "GET" && headers) Object.assign(h, headers);
    const req = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({
          status: res.statusCode, data: data,
          batchRev: res.headers["x-batch-rev"],
          annRev: res.headers["x-annotation-rev"]
        });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function annPayload(overrides) {
  return Object.assign({
    author: "审阅者",
    body: "批注内容",
    paraIndex: 0,
    start: 0,
    end: 2,
    quote: "中文",
    paraDir: "ltr"
  }, overrides || {});
}

async function createAnn(overrides) {
  const rev = (await request("GET", "/api/annotations")).annRev;
  const r = await request("POST", "/api/annotations",
    annPayload(overrides), { "If-Match": rev });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.annotation;
}

async function batchRev() {
  return (await request("GET", "/api/review-batches")).batchRev;
}
async function annotationRev() {
  return (await request("GET", "/api/annotations")).annRev;
}

/* ---------- 新建校验 ---------- */

it("空集合启动：批次 rev=0，响应带 X-Batch-Rev", async function () {
  const r = await request("GET", "/api/review-batches");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.batches, []);
  assert.equal(r.batchRev, "0");
});

it("新建批次缺 If-Match → 428；过期版本 → 409", async function () {
  const a = await createAnn({ body: "a" });
  const noLock = await request("POST", "/api/review-batches",
    { name: "批", annotationIds: [a.id] });
  assert.equal(noLock.status, 428);
  const stale = await request("POST", "/api/review-batches",
    { name: "批", annotationIds: [a.id] }, { "If-Match": "99" });
  assert.equal(stale.status, 409);
  assert.equal((await batchRev()), "0");
});

it("空批次、过期截止时间、不存在的批注：明确拒绝且不推进版本", async function () {
  const a = await createAnn({ body: "b" });
  const rev = await batchRev();

  const empty = await request("POST", "/api/review-batches",
    { name: "空", annotationIds: [] }, { "If-Match": rev });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error, "empty_batch");

  const past = await request("POST", "/api/review-batches",
    { name: "过期", deadline: "2020-01-01T00:00:00Z", annotationIds: [a.id] },
    { "If-Match": rev });
  assert.equal(past.status, 400);
  assert.equal(past.data.error, "deadline_in_past");

  const ghost = await request("POST", "/api/review-batches",
    { name: "幽灵", annotationIds: ["does-not-exist"] }, { "If-Match": rev });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.data.error, "annotation_not_found");
  assert.deepEqual(ghost.data.missing, ["does-not-exist"]);

  assert.equal(await batchRev(), rev, "被拒请求不推进批次版本");
});

/* ---------- 成员互斥与进度 ---------- */

let batchA, members;

it("成功创建批次：成员记录带上 batchId/batchName，进度实时计算", async function () {
  const a1 = await createAnn({ body: "m1", start: 0, end: 1, quote: "中" });
  const a2 = await createAnn({ body: "m2", start: 1, end: 2, quote: "文" });
  const a3 = await createAnn({ body: "m3", start: 0, end: 2, quote: "示例" });
  members = [a1, a2, a3];

  const rev = await batchRev();
  const deadline = new Date(Date.now() + 7 * 86400000).toISOString();
  const r = await request("POST", "/api/review-batches", {
    name: "第一批", owner: "负责人甲", deadline: deadline,
    description: "集中处理第一章", annotationIds: [a1.id, a2.id, a3.id],
    actor: "创建者"
  }, { "If-Match": rev });
  assert.equal(r.status, 201);
  assert.equal(r.batchRev, String(Number(rev) + 1));
  batchA = r.data.batch;
  assert.equal(batchA.name, "第一批");
  assert.equal(batchA.owner, "负责人甲");
  assert.equal(batchA.memberCount, 3);
  assert.equal(batchA.progress.total, 3);
  assert.equal(batchA.progress.progress, 0);
  assert.equal(batchA.overdue, false);

  const anns = await request("GET", "/api/annotations");
  const tagged = anns.data.annotations.filter(x => x.batchName === "第一批");
  assert.equal(tagged.length, 3);
});

it("同一条批注不能同时属于两个未归档批次", async function () {
  const rev = await batchRev();
  const r = await request("POST", "/api/review-batches",
    { name: "冲突批次", annotationIds: [members[0].id] },
    { "If-Match": rev });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "annotation_already_in_batch");
  assert.deepEqual(r.data.conflictIds, [members[0].id]);
  // 失败不创建批次
  const list = await request("GET", "/api/review-batches");
  assert.equal(list.data.batches.length, 1);
});

/* ---------- 逐条与批量状态、乐观锁 ---------- */

it("逐条标记处理中/需复核：四态可流转，审阅记录留痕", async function () {
  const rev = await annotationRev();
  const brevs = await batchRev();
  const r = await request("PUT", "/api/annotations/" + members[0].id,
    { status: "in_progress", actor: "乙" }, { "If-Match": rev });
  assert.equal(r.status, 200);
  assert.equal(r.data.annotation.status, "in_progress");
  // 批注 rev 与批次 rev 同时 +1
  assert.equal(Number(r.annRev), Number(rev) + 1);
  assert.equal(Number(r.batchRev), Number(brevs) + 1);

  const need = await request("PUT", "/api/annotations/" + members[0].id,
    { status: "needs_review", actor: "乙" },
    { "If-Match": r.annRev });
  assert.equal(need.data.annotation.status, "needs_review");

  const list = await request("GET", "/api/review-batches");
  const b = list.data.batches[0];
  assert.equal(b.progress.counts.needs_review, 1);
  assert.equal(b.progress.progress, 0);
});

it("非法工作流状态 → 400 invalid_status", async function () {
  const rev = await annotationRev();
  const r = await request("PUT", "/api/annotations/" + members[1].id,
    { status: "bogus" }, { "If-Match": rev });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "invalid_status");
});

it("批量更新：成功后 changed/unchanged 正确，进度实时推进", async function () {
  const brevs = await batchRev();
  const r = await request("POST",
    "/api/review-batches/" + batchA.id + "/status",
    { annotationIds: [members[0].id, members[1].id, members[2].id],
      status: "resolved", actor: "乙" },
    { "If-Match": brevs });
  assert.equal(r.status, 200);
  assert.equal(r.data.changed, 3);
  assert.equal(r.data.unchanged, 0);
  assert.equal(r.data.batch.progress.progress, 100);
  assert.equal(r.data.batch.progress.done, true);

  // 再次批量设为同一状态：全部 unchanged
  const rev2 = await batchRev();
  const again = await request("POST",
    "/api/review-batches/" + batchA.id + "/status",
    { annotationIds: [members[0].id], status: "resolved" },
    { "If-Match": rev2 });
  assert.equal(again.status, 200);
  assert.equal(again.data.changed, 0);
  assert.equal(again.data.unchanged, 1);
});

it("旧页面的批量更新必须被版本冲突拒绝，不覆盖新状态", async function () {
  // 页面 A 拿到批次版本；页面 B 先改一条成员状态
  const pageARev = await batchRev();
  const latestAnn = await annotationRev();
  const bFirst = await request("PUT", "/api/annotations/" + members[0].id,
    { status: "needs_review", actor: "页面B" },
    { "If-Match": latestAnn });
  assert.equal(bFirst.status, 200);

  // 页面 A 持旧批次版本批量改：必须 409
  const a = await request("POST",
    "/api/review-batches/" + batchA.id + "/status",
    { annotationIds: [members[1].id, members[2].id], status: "open", actor: "页面A" },
    { "If-Match": pageARev });
  assert.equal(a.status, 409);
  assert.equal(a.data.error, "version_conflict");
  assert.equal(a.data.currentRev, Number(pageARev) + 1);

  // B 的新状态保留；A 想覆盖的成员仍是 resolved
  const detail = await request("GET", "/api/review-batches/" + batchA.id);
  const byId = Object.fromEntries(detail.data.members.map(m => [m.id, m.status]));
  assert.equal(byId[members[0].id], "needs_review");
  assert.equal(byId[members[1].id], "resolved");
  assert.equal(byId[members[2].id], "resolved");
});

it("批量操作包含不存在或不属于本批次的批注：整批拒绝，状态不变", async function () {
  const rev = await batchRev();
  const ghost = await request("POST",
    "/api/review-batches/" + batchA.id + "/status",
    { annotationIds: [members[1].id, "ghost"], status: "open" },
    { "If-Match": rev });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.data.error, "annotation_not_found");

  const other = await createAnn({ body: "游离批注", start: 2, end: 3, quote: "啊" });
  const foreign = await request("POST",
    "/api/review-batches/" + batchA.id + "/status",
    { annotationIds: [members[1].id, other.id], status: "open" },
    { "If-Match": rev });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.data.error, "not_batch_member");

  // 成员 1 仍是 resolved：整批原子拒绝
  const detail = await request("GET", "/api/review-batches/" + batchA.id);
  const m1 = detail.data.members.find(m => m.id === members[1].id);
  assert.equal(m1.status, "resolved");
});

it("空批量选择 → 400 empty_batch", async function () {
  const rev = await batchRev();
  const r = await request("POST",
    "/api/review-batches/" + batchA.id + "/status",
    { annotationIds: [], status: "open" }, { "If-Match": rev });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "empty_batch");
});

/* ---------- 成员加/移 ---------- */

it("移出成员后可加入新批次；加入重复/别人的成员被拒", async function () {
  const brevs = await batchRev();
  // 把 members[2] 移出第一批
  const out = await request("POST",
    "/api/review-batches/" + batchA.id + "/members",
    { mode: "remove", annotationIds: [members[2].id], actor: "乙" },
    { "If-Match": brevs });
  assert.equal(out.status, 200);
  assert.equal(out.data.batch.memberCount, 2);

  // 移出后该批注可以进入新批次
  const rev2 = await batchRev();
  const created = await request("POST", "/api/review-batches",
    { name: "第二批", annotationIds: [members[2].id] },
    { "If-Match": rev2 });
  assert.equal(created.status, 201);
  const batchBId = created.data.batch.id;

  // 再加入第一批 → 冲突（已属于第二批，未归档）
  const rev3 = await batchRev();
  const dup = await request("POST",
    "/api/review-batches/" + batchA.id + "/members",
    { mode: "add", annotationIds: [members[2].id] },
    { "If-Match": rev3 });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, "annotation_already_in_batch");

  // 移出非本批次成员 → not_batch_member
  const foreign = await request("POST",
    "/api/review-batches/" + batchA.id + "/members",
    { mode: "remove", annotationIds: [members[2].id] },
    { "If-Match": rev3 });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.data.error, "not_batch_member");
});

it("批次成员的批注不能直接删除（未归档需先移出）", async function () {
  const rev = await annotationRev();
  const r = await request("DELETE", "/api/annotations/" + members[0].id,
    null, { "If-Match": rev });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "annotation_in_batch");
});

/* ---------- 批次信息更新与审阅记录 ---------- */

it("更新负责人/截止/说明：变化留痕；无变化 no_change；过期时间拒绝", async function () {
  const rev = await batchRev();
  const r = await request("PUT", "/api/review-batches/" + batchA.id,
    { owner: "新负责人", description: "新的说明", actor: "丙" },
    { "If-Match": rev });
  assert.equal(r.status, 200);
  assert.equal(r.data.batch.owner, "新负责人");

  const same = await request("PUT", "/api/review-batches/" + batchA.id,
    { owner: "新负责人", actor: "丙" },
    { "If-Match": r.batchRev });
  assert.equal(same.status, 400);
  assert.equal(same.data.error, "no_change");

  const badDl = await request("PUT", "/api/review-batches/" + batchA.id,
    { deadline: "2020-01-01T00:00:00Z" },
    { "If-Match": await batchRev() });
  assert.equal(badDl.status, 400);
  assert.equal(badDl.data.error, "deadline_in_past");
});

it("审阅记录可按时间查看：创建/更新/状态/成员变化都在", async function () {
  const r = await request("GET",
    "/api/review-batches/" + batchA.id + "/logs");
  assert.equal(r.status, 200);
  const actions = r.data.logs.map(l => l.action);
  assert.ok(actions.includes("batch_create"));
  assert.ok(actions.includes("batch_update"));
  assert.ok(actions.includes("status_change"));
  assert.ok(actions.includes("members_remove"));
  // 倒序：新的在前
  for (let i = 1; i < r.data.logs.length; i++) {
    assert.ok(r.data.logs[i - 1].at >= r.data.logs[i].at);
  }
  // 按时间范围筛选
  const mid = r.data.logs[Math.floor(r.data.logs.length / 2)].at;
  const filtered = await request("GET",
    "/api/review-batches/" + batchA.id + "/logs?from=" + encodeURIComponent(mid));
  assert.ok(filtered.data.logs.every(l => l.at >= mid));
  assert.ok(filtered.data.logs.length <= r.data.logs.length);
});

/* ---------- 快照嵌入批次 ---------- */

let snapId;
it("保存快照时每条批注带所属批次及当时状态", async function () {
  const r = await request("POST", "/api/snapshots", {
    name: "批次时刻",
    paragraphs: [{ dir: "ltr", text: "中文示例啊", editedAt: "2026-09-12T00:00:00Z" }]
  });
  assert.equal(r.status, 201);
  snapId = r.data.id;
  const withBatch = r.data.annotations.filter(a => a.batchInfo);
  assert.ok(withBatch.length >= 3);
  const m1Snap = r.data.annotations.find(a => a.id === members[0].id);
  assert.equal(m1Snap.batchInfo.name, "第一批");
  assert.equal(m1Snap.status, "needs_review", "快照记录当时的工作流状态");
});

/* ---------- 归档冻结 ---------- */

it("归档后：成员状态/回复/删除/加移成员/改信息全部被拒，历史仍可查", async function () {
  const rev = await batchRev();
  const arc = await request("POST",
    "/api/review-batches/" + batchA.id + "/archive",
    { actor: "丁" }, { "If-Match": rev });
  assert.equal(arc.status, 200);
  assert.equal(arc.data.batch.status, "archived");
  assert.ok(arc.data.batch.archivedAt);

  const newRev = await batchRev();
  // 批量更新 → batch_archived
  const bulk = await request("POST",
    "/api/review-batches/" + batchA.id + "/status",
    { annotationIds: [members[0].id], status: "open" },
    { "If-Match": newRev });
  assert.equal(bulk.status, 409);
  assert.equal(bulk.data.error, "batch_archived");

  // 逐条状态 → annotation_frozen
  const arev = await annotationRev();
  const one = await request("PUT", "/api/annotations/" + members[0].id,
    { status: "open" }, { "If-Match": arev });
  assert.equal(one.status, 409);
  assert.equal(one.data.error, "annotation_frozen");

  // 回复 → 冻结
  const reply = await request("POST",
    "/api/annotations/" + members[0].id + "/replies",
    { body: "归档后尝试回复" }, { "If-Match": arev });
  assert.equal(reply.status, 409);
  assert.equal(reply.data.error, "annotation_frozen");

  // 删除 → 冻结
  const del = await request("DELETE", "/api/annotations/" + members[0].id,
    null, { "If-Match": arev });
  assert.equal(del.status, 409);
  assert.equal(del.data.error, "annotation_frozen");

  // 加/移成员 → 批次已归档
  for (const mode of ["add", "remove"]) {
    const m = await request("POST",
      "/api/review-batches/" + batchA.id + "/members",
      { mode: mode, annotationIds: [members[1].id] },
      { "If-Match": newRev });
    assert.equal(m.status, 409, mode);
    assert.equal(m.data.error, "batch_archived");
  }

  // 改信息 → 批次已归档
  const upd = await request("PUT", "/api/review-batches/" + batchA.id,
    { owner: "别人" }, { "If-Match": newRev });
  assert.equal(upd.status, 409);
  assert.equal(upd.data.error, "batch_archived");

  // 重复归档 → batch_archived
  const again = await request("POST",
    "/api/review-batches/" + batchA.id + "/archive", {},
    { "If-Match": newRev });
  assert.equal(again.status, 409);

  // 详情仍可读：frozen=true，成员为归档瞬间快照
  const detail = await request("GET", "/api/review-batches/" + batchA.id);
  assert.equal(detail.data.frozen, true);
  assert.equal(detail.data.members.length, 2);
  assert.ok(detail.data.members.every(m => ["needs_review", "resolved"].includes(m.status)));

  // 审阅记录仍可读，含归档条目
  const logs = await request("GET",
    "/api/review-batches/" + batchA.id + "/logs");
  assert.ok(logs.data.logs.some(l => l.action === "batch_archive"));
});

it("归档批次成员缺失时，从快照恢复批注集合被拒绝", async function () {
  // 恢复集只放一个无关批注，缺少第一批的冻结成员
  const rev = await annotationRev();
  const r = await request("PUT", "/api/annotations", {
    annotations: [annPayload({
      id: "standalone-restore", body: "恢复集", quote: "中", start: 0, end: 1
    })]
  }, { "If-Match": rev });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "archived_members_lost");
  assert.ok(r.data.missing.includes(members[0].id));
});

/* ---------- 持久化 ---------- */

it("重启后批次、进度、审阅记录与成员归属均恢复", async function () {
  const rawBatch = JSON.parse(fs.readFileSync(BATCH_DATA, "utf8"));
  assert.ok(Number.isInteger(rawBatch.rev) && rawBatch.rev > 0);
  assert.ok(rawBatch.batches.length >= 2);
  assert.ok(Array.isArray(rawBatch.logs) && rawBatch.logs.length >= 4);
  const archived = rawBatch.batches.find(b => b.id === batchA.id);
  assert.equal(archived.status, "archived");
  assert.ok(Array.isArray(archived.memberSnapshot));
  assert.equal(archived.memberSnapshot.length, 2);

  server.kill();
  await new Promise(r => setTimeout(r, 300));
  await startServer();

  const list = await request("GET", "/api/review-batches");
  assert.equal(Number(list.batchRev), rawBatch.rev);
  const got = list.data.batches.find(b => b.id === batchA.id);
  assert.equal(got.status, "archived");
  assert.equal(got.memberCount, 2);

  const logs = await request("GET",
    "/api/review-batches/" + batchA.id + "/logs");
  assert.ok(logs.data.logs.some(l => l.action === "batch_create"));

  const anns = await request("GET", "/api/annotations");
  assert.ok(anns.data.annotations.find(a => a.id === members[0].id && a.batchName === "第一批"));
});

it("不存在的批次：详情 404；变更操作 404", async function () {
  const g = await request("GET", "/api/review-batches/nope");
  assert.equal(g.status, 404);
  const rev = await batchRev();
  const p = await request("POST", "/api/review-batches/nope/archive",
    {}, { "If-Match": rev });
  assert.equal(p.status, 404);
});
});
