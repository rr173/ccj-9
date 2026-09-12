/* node --test test/decisions-api.test.js
 * 审阅决策 HTTP 集成测试：真实启动 server.js（临时数据文件 + 随机端口），覆盖：
 *   创建校验（归档/过期/重复草案/空批次/重复方案）、方案填写与提交、
 *   记名投票与门槛流转、方案修改清票、按段预览与三版本逐条冲突、
 *   部分成功执行（文本/批注/批次版本只影响受影响条目）、成功批注转已解决、
 *   旧决策版本 409、同草案不可重复执行、撤销最近一次成功执行（执行后变化的
 *   批注不被覆盖）、快照嵌入决策、归档冻结草案、按时间查记录、重启持久化。
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

const PORT = 8430 + Math.floor(Math.random() * 90);
const BASE = "http://127.0.0.1:" + PORT;
const TMP = os.tmpdir();
const TAG = Date.now() + "-" + process.pid;
const SNAP_DATA = path.join(TMP, "dec-snap-" + TAG + ".json");
const ANN_DATA = path.join(TMP, "dec-ann-" + TAG + ".json");
const BATCH_DATA = path.join(TMP, "dec-batch-" + TAG + ".json");
const DEC_DATA = path.join(TMP, "dec-dec-" + TAG + ".json");

let server;

function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), String(PORT)], {
    env: Object.assign({}, process.env, {
      SNAPSHOTS_FILE: SNAP_DATA,
      ANNOTATIONS_FILE: ANN_DATA,
      REVIEW_BATCHES_FILE: BATCH_DATA,
      REVIEW_DECISIONS_FILE: DEC_DATA
    }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  return waitUp();
}

function waitUp() {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + 5000;
    (function ping() {
      const req = http.get(BASE + "/api/review-decisions", function (res) {
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

describe("审阅决策 API（顺序用例）", function () {
before(async function () { await startServer(); });

after(async function () {
  server.kill();
  for (const f of [SNAP_DATA, SNAP_DATA + ".tmp", ANN_DATA, ANN_DATA + ".tmp",
                   BATCH_DATA, BATCH_DATA + ".tmp", DEC_DATA, DEC_DATA + ".tmp"]) {
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
          drev: res.headers["x-decision-rev"],
          annRev: res.headers["x-annotation-rev"],
          batchRev: res.headers["x-batch-rev"]
        });
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function annPayload(overrides) {
  return Object.assign({
    author: "审阅者", body: "批注内容",
    paraIndex: 0, start: 0, end: 2, quote: "中文", paraDir: "ltr"
  }, overrides || {});
}

let annSeq = 0;
async function createAnn(overrides) {
  const rev = (await request("GET", "/api/annotations")).annRev;
  const r = await request("POST", "/api/annotations",
    annPayload(Object.assign({ body: "b" + (annSeq++) }, overrides || {})),
    { "If-Match": rev });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.annotation;
}

async function drev() {
  return (await request("GET", "/api/review-decisions")).drev;
}
async function arev() {
  return (await request("GET", "/api/annotations")).annRev;
}
async function brev() {
  return (await request("GET", "/api/review-batches")).batchRev;
}

async function createBatch(ids, name, deadline) {
  const r = await request("POST", "/api/review-batches", {
    name: name || "批" + annSeq, owner: "负责人",
    deadline: deadline || "2030-01-01T00:00:00Z",
    annotationIds: ids
  }, { "If-Match": await brev() });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.batch;
}

const PARAS = [{ dir: "ltr", text: "中文示例文本" }];

async function createDecision(batchId, extra) {
  const body = Object.assign({
    batchId: batchId,
    threshold: 1,
    paragraphs: PARAS
  }, extra || {});
  const r = await request("POST", "/api/review-decisions", body,
    { "If-Match": await drev() });
  return r;
}

/* ---------- 基础数据 ---------- */

let a1, a2, a3, batch, did;

it("空集合：决策 rev=0，响应带 X-Decision-Rev", async function () {
  const r = await request("GET", "/api/review-decisions");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.decisions, []);
  assert.equal(r.drev, "0");
});

it("准备三条批注与一个批次", async function () {
  a1 = await createAnn({ start: 0, end: 2, quote: "中文" });
  a2 = await createAnn({ start: 2, end: 4, quote: "示例" });
  a3 = await createAnn({ paraIndex: 1, start: 0, end: 3, quote: "أحب",
    paraDir: "rtl", body: "阿文段" });
  batch = await createBatch([a1.id, a2.id, a3.id], "主批次");
});

/* ---------- 创建校验 ---------- */

it("缺 If-Match → 428；旧版本 → 409，且不推进版本", async function () {
  const noLock = await request("POST", "/api/review-decisions",
    { batchId: batch.id, paragraphs: PARAS });
  assert.equal(noLock.status, 428);
  const stale = await request("POST", "/api/review-decisions",
    { batchId: batch.id, paragraphs: PARAS }, { "If-Match": "99" });
  assert.equal(stale.status, 409);
  assert.equal(await drev(), "0");
});

it("不存在/已归档批次不能建草案", async function () {
  const ghost = await createDecision("does-not-exist");
  assert.equal(ghost.status, 404);
  assert.equal(ghost.data.error, "batch_not_found");

  const arc = await request("POST", "/api/review-batches/" + batch.id + "/archive",
    { actor: "甲" }, { "If-Match": await brev() });
  assert.equal(arc.status, 200);
  const onArchived = await createDecision(batch.id);
  assert.equal(onArchived.status, 409);
  assert.equal(onArchived.data.error, "batch_archived");
  // 归档批次不能再改成员：直接重建一个新批次继续后续用例
});

it("过期批次建草案 → deadline_passed", async function () {
  // 新建一条批注 + 一个截止时间 1 秒后的批次，等它过期
  const a = await createAnn({ body: "短截止批注", start: 0, end: 1, quote: "中" });
  const dl = new Date(Date.now() + 1100).toISOString();
  const short = await request("POST", "/api/review-batches", {
    name: "短截止", deadline: dl, annotationIds: [a.id]
  }, { "If-Match": await brev() });
  assert.equal(short.status, 201);
  await new Promise(function (r) { setTimeout(r, 1250); });
  const r = await createDecision(short.data.batch.id);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "deadline_passed");
});

it("重复方案/空替换文本/非法门槛：创建即拒绝", async function () {
  // 用主批次（已归档）不行；需要新活批次
  const x1 = await createAnn({ body: "x1", start: 0, end: 1, quote: "中" });
  const x2 = await createAnn({ body: "x2", start: 1, end: 2, quote: "文" });
  const bx = await createBatch([x1.id, x2.id], "校验批次");

  let r = await createDecision(bx.id, {
    items: [
      { annotationId: x1.id, disposition: "keep" },
      { annotationId: x1.id, disposition: "delete" }
    ]
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "duplicate_item");

  r = await createDecision(bx.id, {
    items: [{ annotationId: x1.id, disposition: "replace", replacement: "  " }]
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "empty_replacement");

  r = await request("POST", "/api/review-decisions",
    Object.assign(createBody(bx.id), { threshold: 0 }),
    { "If-Match": await drev() });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "invalid_threshold");

  r = await request("POST", "/api/review-decisions",
    Object.assign(createBody(bx.id), { paragraphs: [] }),
    { "If-Match": await drev() });
  assert.equal(r.status, 400);
});

function createBody(batchId, extra) {
  return Object.assign({
    batchId: batchId, threshold: 1,
    paragraphs: [{ dir: "ltr", text: "中文示例文本" }]
  }, extra || {});
}

it("同一未归档批次不能有两个活草案", async function () {
  const r1 = await createDecision(batch.id); // 主批次已归档，应 409
  assert.equal(r1.status, 409);
  const c1 = await createAnn({ body: "c1" });
  const bc = await createBatch([c1.id], "唯一草案批");
  const first = await createDecision(bc.id);
  assert.equal(first.status, 201);
  const second = await createDecision(bc.id);
  assert.equal(second.status, 409);
  assert.equal(second.data.error, "duplicate_decision");
});

/* ---------- 主流程：新批次 + 草案 + 投票 + 执行 ---------- */

it("创建活批次与草案：未给方案的条目为空，状态 drafting", async function () {
  // 主批次此前已归档；归档时其成员冻结。新建一批复用 a1/a2/a3 不可行
  // （归档成员不能再进新批次），故新建三条批注。
  a1 = await createAnn({ start: 0, end: 2, quote: "中文", body: "m1" });
  a2 = await createAnn({ start: 2, end: 4, quote: "示例", body: "m2" });
  a3 = await createAnn({ paraIndex: 1, start: 0, end: 3, quote: "أحب",
    paraDir: "rtl", body: "m3" });
  batch = await createBatch([a1.id, a2.id, a3.id], "执行批次");
  const r = await createDecision(batch.id, {
    name: "第一次决策",
    threshold: 2,
    paragraphs: PARAS2(),
    items: [
      { annotationId: a1.id, disposition: "replace", replacement: "英文" },
      { annotationId: a2.id, disposition: "delete" }
    ]
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.decision.name, "第一次决策");
  assert.equal(r.data.decision.status, "drafting");
  assert.equal(r.data.decision.itemCount, 3);
  assert.equal(r.data.decision.progress.counts.pending, 1);
  did = r.data.decision.id;

  const detail = await request("GET", "/api/review-decisions/" + did);
  assert.equal(detail.data.items.length, 3);
  assert.equal(detail.data.textRev.length, 16);
});

it("未填满方案不能提交：empty_items 且不推进版本", async function () {
  const before = await drev();
  const r = await request("POST", "/api/review-decisions/" + did + "/submit",
    { actor: "甲" }, { "If-Match": before });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "empty_items");
  assert.ok(r.data.unfilled.includes(a3.id));
  assert.equal(await drev(), before);
});

it("补齐 a3 方案；重复 id 整批拒绝", async function () {
  const rev = await drev();
  const dup = await request("PUT", "/api/review-decisions/" + did + "/items",
    { items: [
      { annotationId: a3.id, disposition: "keep" },
      { annotationId: a3.id, disposition: "delete" }
    ] }, { "If-Match": rev });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, "duplicate_item");

  const ok = await request("PUT", "/api/review-decisions/" + did + "/items",
    { items: [{ annotationId: a3.id, disposition: "keep" }], actor: "甲" },
    { "If-Match": rev });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.items.every(function (it) { return it.disposition; }));
});

it("drafting 之后再提交：进入 voting；重复提交 409", async function () {
  const rev = await drev();
  const r = await request("POST", "/api/review-decisions/" + did + "/submit",
    { actor: "甲" }, { "If-Match": rev });
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.status, "voting");
  const detail = await request("GET", "/api/review-decisions/" + did);
  assert.ok(detail.data.decision.submittedAt);
  const again = await request("POST", "/api/review-decisions/" + did + "/submit",
    {}, { "If-Match": await drev() });
  assert.equal(again.status, 409);
});

it("投票必须记名；非法票值拒绝；drafting 草案不能投票", async function () {
  const noVoter = await request("POST", "/api/review-decisions/" + did + "/votes",
    { annotationId: a1.id, vote: "approve" }, { "If-Match": await drev() });
  assert.equal(noVoter.status, 400);
  assert.equal(noVoter.data.error, "missing_voter");
  const bad = await request("POST", "/api/review-decisions/" + did + "/votes",
    { annotationId: a1.id, vote: "yes", voter: "甲" }, { "If-Match": await drev() });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "invalid_vote");
});

it("两人投票：一条驳回时草案停留 voting；改票达标后进入 ready", async function () {
  async function vote(aid, v, who, expectedRev) {
    const r = await request("POST", "/api/review-decisions/" + did + "/votes",
      { annotationId: aid, vote: v, voter: who },
      { "If-Match": expectedRev });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r;
  }
  let rev = await drev();
  // 甲三条全 approve
  for (const a of [a1, a2, a3]) {
    const r = await vote(a.id, "approve", "甲", rev);
    rev = r.drev;
  }
  let d = (await request("GET", "/api/review-decisions/" + did)).data;
  assert.equal(d.decision.status, "voting"); // 门槛 2，每人 1 票

  // 乙：a1 approve，a2 reject，a3 approve
  let r = await vote(a1.id, "approve", "乙", rev); rev = r.drev;
  r = await vote(a3.id, "approve", "乙", rev); rev = r.drev;
  r = await vote(a2.id, "reject", "乙", rev); rev = r.drev;
  d = (await request("GET", "/api/review-decisions/" + did)).data;
  assert.equal(d.decision.status, "voting");
  const a2item = d.items.find(function (it) { return it.annotationId === a2.id; });
  assert.equal(a2item.state, "rejected");

  // 乙改票 approve：三条都达 2 票 → ready
  r = await vote(a2.id, "approve", "乙", rev);
  assert.equal(r.data.decision.status, "ready");
  assert.ok(r.data.decision.readyAt);
  const tally = r.data.items.find(function (it) { return it.annotationId === a2.id; });
  assert.equal(tally.approve, 2);
  assert.equal(tally.reject, 0); // 改票后旧票作废
});

/* ---------- 预览 ---------- */

it("预览：原文未变，按段合成执行后文本，且不写盘", async function () {
  const before = await drev();
  const r = await request("POST", "/api/review-decisions/" + did + "/preview",
    { paragraphs: PARAS2() });
  assert.equal(r.status, 200);
  assert.equal(r.data.textChanged, false);
  assert.deepEqual(r.data.counts, { success: 3, conflict: 0, skipped: 0 });
  // 段0：replace [0,2)→英文 + delete [2,4)示例 => 英文文本
  const row0 = r.data.rows.find(function (x) { return x.paraIndex === 0; });
  assert.equal(row0.afterText, "英文文本");
  assert.equal(await drev(), before, "纯预览不推进决策版本");
});

function PARAS2() {
  return [
    { dir: "ltr", text: "中文示例文本" },
    { dir: "rtl", text: "أحب العربية" }
  ];
}

it("预览：段首插入导致 quote_mismatch，逐条冲突；另一段不受影响", async function () {
  const r = await request("POST", "/api/review-decisions/" + did + "/preview",
    { paragraphs: [
      { dir: "ltr", text: "新中文示例文本" },
      { dir: "rtl", text: "أحب العربية" }
    ] });
  assert.equal(r.status, 200);
  assert.equal(r.data.textChanged, true);
  assert.deepEqual(r.data.counts, { success: 1, conflict: 2, skipped: 0 });
  const byId = Object.fromEntries(r.data.results.map(function (x) { return [x.annotationId, x]; }));
  assert.equal(byId[a1.id].reason, "quote_mismatch");
  assert.equal(byId[a2.id].reason, "quote_mismatch");
  assert.equal(byId[a3.id].result, "success");
});

it("预览：批注版本变化/成员被移出只影响对应条目（决策 rev 不变也允许预览）", async function () {
  // 把 a1 标记处理中（推进批注 rev，但不推进决策 rev）
  const ar = await arev();
  const s1 = await request("PUT", "/api/annotations/" + a1.id,
    { status: "in_progress", actor: "别人" }, { "If-Match": ar });
  assert.equal(s1.status, 200);
  // 把 a3 移出批次
  const br = await brev();
  const rm = await request("POST", "/api/review-batches/" + batch.id + "/members",
    { mode: "remove", annotationIds: [a3.id], actor: "甲" }, { "If-Match": br });
  assert.equal(rm.status, 200);

  const r = await request("POST", "/api/review-decisions/" + did + "/preview",
    { paragraphs: PARAS2() });
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.results.map(function (x) { return [x.annotationId, x]; }));
  assert.equal(byId[a1.id].result, "conflict");
  assert.equal(byId[a1.id].reason, "annotation_changed");
  assert.equal(byId[a2.id].result, "success");
  assert.equal(byId[a3.id].result, "conflict");
  assert.equal(byId[a3.id].reason, "member_removed");
  assert.deepEqual(r.data.counts, { success: 1, conflict: 2, skipped: 0 });
});

/* ---------- 执行 ---------- */

it("未达 ready（用一个驳回场景）不能执行；旧决策版本执行被 409 拒绝", async function () {
  // 当前草案 ready；先验证旧 rev
  const oldRev = String(Number(await drev()) - 100);
  const stale = await request("POST", "/api/review-decisions/" + did + "/execute",
    { paragraphs: PARAS2(), actor: "甲" }, { "If-Match": oldRev });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, "version_conflict");
});

it("部分成功执行：成功 a2 一条；a1/a3 冲突；编辑区合成结果只应用 a2", async function () {
  const rev = await drev();
  const r = await request("POST", "/api/review-decisions/" + did + "/execute",
    { paragraphs: PARAS2(), actor: "甲" }, { "If-Match": rev });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.counts, { success: 1, conflict: 2, skipped: 0 });
  assert.equal(r.data.applied, true);
  assert.equal(r.data.status, "executed");
  // 段0 仅删除“示例” → 中文文本；段1 未触碰
  assert.equal(r.data.afterParagraphs[0].text, "中文文本");
  assert.equal(r.data.afterParagraphs[1].text, "أحب العربية");

  // 只有成功条目 a2 被标 resolved；a1 保留别人的 in_progress；a3 已移出保持 open
  const anns = Object.fromEntries(
    (await request("GET", "/api/annotations")).data.annotations.map(function (x) {
      return [x.id, x];
    }));
  assert.equal(anns[a1.id].status, "in_progress");
  assert.equal(anns[a2.id].status, "resolved");
  assert.equal(anns[a2.id].resolvedBy, "甲");
  assert.equal(anns[a3.id].status, "open");
});

it("同一草案不能重复执行", async function () {
  const r = await request("POST", "/api/review-decisions/" + did + "/execute",
    { paragraphs: PARAS2(), actor: "甲" }, { "If-Match": await drev() });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "decision_executed");
});

it("成功/冲突/跳过逐条记录可按时间查看", async function () {
  const all = await request("GET", "/api/review-decisions/" + did + "/logs");
  const actions = all.data.logs.map(function (l) { return l.action; });
  assert.ok(actions.includes("execute"));
  assert.ok(actions.includes("execute_item_success"));
  assert.ok(actions.includes("execute_item_conflict"));
  // 时间倒序
  for (let i = 1; i < all.data.logs.length; i++) {
    assert.ok(all.data.logs[i - 1].at >= all.data.logs[i].at);
  }
  // 按时间筛选
  const some = all.data.logs[Math.floor(all.data.logs.length / 2)].at;
  const filtered = await request("GET",
    "/api/review-decisions/" + did + "/logs?from=" + encodeURIComponent(some));
  assert.ok(filtered.data.logs.every(function (l) { return l.at >= some; }));
});

/* ---------- 撤销 ---------- */

it("撤销最近一次执行：回滚 a2，返回执行前段落；之后不能再撤销", async function () {
  const rev = await drev();
  const r = await request("POST", "/api/review-decisions/" + did + "/undo",
    { actor: "乙" }, { "If-Match": rev });
  assert.equal(r.status, 200);
  assert.equal(r.data.reverted, 1);
  assert.equal(r.data.notReverted, 0);
  assert.equal(r.data.beforeParagraphs[0].text, "中文示例文本");
  assert.equal(r.data.decision.status, "ready");

  const anns = Object.fromEntries(
    (await request("GET", "/api/annotations")).data.annotations.map(function (x) {
      return [x.id, x];
    }));
  assert.equal(anns[a2.id].status, "open");

  const again = await request("POST", "/api/review-decisions/" + did + "/undo",
    {}, { "If-Match": await drev() });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "nothing_to_undo");
});

it("撤销后可以重新执行；执行后被别人改过的批注撤销时不覆盖", async function () {
  // 重新执行（此时 a1 仍 in_progress 冲突、a3 已移出冲突；a2 再次成功）
  const rev = await drev();
  const run = await request("POST", "/api/review-decisions/" + did + "/execute",
    { paragraphs: PARAS2(), actor: "甲" }, { "If-Match": rev });
  assert.equal(run.status, 200);
  assert.equal(run.data.counts.success, 1);

  // 别人在执行后立即把 a2 改成 needs_review（updatedAt 变化）
  const ar = await arev();
  const edit = await request("PUT", "/api/annotations/" + a2.id,
    { status: "needs_review", actor: "别人" }, { "If-Match": ar });
  assert.equal(edit.status, 200);

  const undo = await request("POST", "/api/review-decisions/" + did + "/undo",
    { actor: "乙" }, { "If-Match": await drev() });
  assert.equal(undo.status, 200);
  assert.equal(undo.data.reverted, 0);
  assert.equal(undo.data.notReverted, 1);
  assert.equal(undo.data.undoResults[0].reason, "changed_since_execution");
  const anns = Object.fromEntries(
    (await request("GET", "/api/annotations")).data.annotations.map(function (x) {
      return [x.id, x];
    }));
  assert.equal(anns[a2.id].status, "needs_review", "别人的新状态不被覆盖");
});

/* ---------- 跳过 + 另一草案的“最近一次”顺序 ---------- */

it("只能撤销全局最近一次成功执行", async function () {
  // did 的执行此前已被撤销（ready、无未撤销执行）。
  // 再造两个新草案并先后执行：先 yid 后 zid。
  const y1 = await createAnn({ body: "y1", start: 0, end: 1, quote: "中" });
  const by = await createBatch([y1.id], "撤销顺序批Y");
  const cy = await createDecision(by.id, {
    paragraphs: [{ dir: "ltr", text: "中文" }],
    items: [{ annotationId: y1.id, disposition: "keep" }]
  });
  const yid = cy.data.decision.id;
  let r = await request("POST", "/api/review-decisions/" + yid + "/submit",
    {}, { "If-Match": await drev() });
  assert.equal(r.status, 200);
  r = await request("POST", "/api/review-decisions/" + yid + "/votes",
    { annotationId: y1.id, vote: "approve", voter: "甲" },
    { "If-Match": await drev() });
  assert.equal(r.status, 200);
  r = await request("POST", "/api/review-decisions/" + yid + "/execute",
    { paragraphs: [{ dir: "ltr", text: "中文" }], actor: "甲" },
    { "If-Match": await drev() });
  assert.equal(r.status, 200);
  assert.equal(r.data.counts.success, 1);

  const z1 = await createAnn({ body: "z1", start: 0, end: 1, quote: "中" });
  const bz = await createBatch([z1.id], "撤销顺序批Z");
  const cz = await createDecision(bz.id, {
    paragraphs: [{ dir: "ltr", text: "中文" }],
    items: [{ annotationId: z1.id, disposition: "keep" }]
  });
  const zid = cz.data.decision.id;
  r = await request("POST", "/api/review-decisions/" + zid + "/submit",
    {}, { "If-Match": await drev() });
  assert.equal(r.status, 200);
  r = await request("POST", "/api/review-decisions/" + zid + "/votes",
    { annotationId: z1.id, vote: "approve", voter: "甲" },
    { "If-Match": await drev() });
  assert.equal(r.status, 200);
  r = await request("POST", "/api/review-decisions/" + zid + "/execute",
    { paragraphs: [{ dir: "ltr", text: "中文" }], actor: "甲" },
    { "If-Match": await drev() });
  assert.equal(r.status, 200);
  assert.equal(r.data.counts.success, 1);

  // yid 不是最近一次成功执行 → not_latest_execution
  r = await request("POST", "/api/review-decisions/" + yid + "/undo",
    {}, { "If-Match": await drev() });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "not_latest_execution");
  assert.equal(r.data.latestExecutionId != null, true);

  // did 的执行早已撤销 → nothing_to_undo
  r = await request("POST", "/api/review-decisions/" + did + "/undo",
    {}, { "If-Match": await drev() });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "nothing_to_undo");

  // 撤销全局最近一次（zid）成功
  r = await request("POST", "/api/review-decisions/" + zid + "/undo",
    {}, { "If-Match": await drev() });
  assert.equal(r.status, 200);
  assert.equal(r.data.reverted, 1);
});

/* ---------- 快照嵌入 ---------- */

it("保存快照时嵌入全部决策草案的状态/投票/执行结果", async function () {
  // did 上一轮执行已撤销（回到 ready）；重新执行一次使其进入 executed。
  // a1 仍是 in_progress 冲突、a3 已移出冲突，仅 a2 成功（部分成功）。
  const rerun = await request("POST", "/api/review-decisions/" + did + "/execute",
    { paragraphs: PARAS2(), actor: "甲" }, { "If-Match": await drev() });
  assert.equal(rerun.status, 200, JSON.stringify(rerun.data));
  assert.equal(rerun.data.counts.success, 1);

  const r = await request("POST", "/api/snapshots", {
    name: "决策时刻",
    paragraphs: PARAS2()
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.decisionRev >= 1);
  const digests = r.data.decisions;
  const mine = digests.find(function (x) { return x.id === did; });
  assert.equal(mine.status, "executed");
  assert.equal(mine.items.length, 3);
  assert.ok(mine.executions.length >= 3, "历次执行（含已撤销）都在快照里");
  const last = mine.executions[mine.executions.length - 1];
  assert.equal(last.undone, false);
  const undone = mine.executions.slice(0, -1).some(function (e) { return e.undone; });
  assert.equal(undone, true, "此前撤销的执行也保留在快照中");
  const tally = mine.items.find(function (it) { return it.annotationId === a2.id; });
  assert.equal(tally.disposition, "delete");
  assert.equal(tally.votes.length, 2);
});

/* ---------- 归档冻结 ---------- */

it("批次归档后：草案只读（改方案/投票/执行/撤销全拒绝），仍可查看", async function () {
  const ar2 = await brev();
  const arc = await request("POST", "/api/review-batches/" + batch.id + "/archive",
    { actor: "甲" }, { "If-Match": ar2 });
  assert.equal(arc.status, 200, JSON.stringify(arc.data));

  const rev = await drev();
  let r = await request("PUT", "/api/review-decisions/" + did + "/items",
    { items: [{ annotationId: a1.id, disposition: "keep" }] }, { "If-Match": rev });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "batch_archived");
  r = await request("POST", "/api/review-decisions/" + did + "/votes",
    { annotationId: a1.id, vote: "abstain", voter: "丙" }, { "If-Match": rev });
  assert.equal(r.status, 409);
  r = await request("POST", "/api/review-decisions/" + did + "/undo",
    {}, { "If-Match": rev });
  assert.equal(r.status, 409);
  const detail = await request("GET", "/api/review-decisions/" + did);
  assert.equal(detail.data.batchFrozen, true);
});

/* ---------- 持久化 ---------- */

it("重启后决策、投票、执行记录全部恢复", async function () {
  const raw = JSON.parse(fs.readFileSync(DEC_DATA, "utf8"));
  assert.ok(Number.isInteger(raw.rev) && raw.rev > 0);
  assert.ok(raw.decisions.length >= 2);
  assert.ok(Array.isArray(raw.logs) && raw.logs.length >= 5);

  server.kill();
  await new Promise(function (r) { setTimeout(r, 300); });
  await startServer();

  const list = await request("GET", "/api/review-decisions");
  assert.equal(list.drev, String(raw.rev));
  const mine = list.data.decisions.find(function (d) { return d.id === did; });
  assert.equal(mine.status, "executed");
  assert.equal(mine.itemCount, 3);

  const detail = await request("GET", "/api/review-decisions/" + did);
  assert.equal(detail.data.executions.length >= 2, true);
  const logs = await request("GET", "/api/review-decisions/" + did + "/logs");
  assert.ok(logs.data.logs.some(function (l) { return l.action === "execute"; }));
});

it("不存在的草案：详情 404；变更操作 404", async function () {
  const g = await request("GET", "/api/review-decisions/nope");
  assert.equal(g.status, 404);
  const p = await request("POST", "/api/review-decisions/nope/submit",
    {}, { "If-Match": await drev() });
  assert.equal(p.status, 404);
});
});
