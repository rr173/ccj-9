/* node --test test/review-core.test.js
 * 协作批注纯逻辑测试：校验规则、锚点重定位（重点验证 RTL 与混排文本下
 * 编辑/换行/方向切换后批注仍指向原来的字符）、记录规范化。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../review-core");

function ann(overrides) {
  return Object.assign({
    author: "审阅者",
    body: "这里需要再斟酌",
    paraIndex: 0,
    start: 2,
    end: 7,
    quote: "العرب", // 5 个码点，与 end-start 一致
    paraDir: "rtl"
  }, overrides || {});
}

/* ---------- 新批注校验 ---------- */

test("合法批注通过并规范化（作者默认匿名、非法方向降级 auto）", function () {
  const r = core.validateNewAnnotation(ann({ author: "  ", paraDir: "sideways" }));
  assert.equal(r.ok, true);
  assert.equal(r.value.author, "匿名");
  assert.equal(r.value.paraDir, "auto");
  assert.equal(r.value.quote, "العرب");
});

test("批注内容为空或纯空白必须拒绝（empty_body）", function () {
  for (const body of ["", "   ", "\n\t"]) {
    const r = core.validateNewAnnotation(ann({ body: body }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "empty_body");
    assert.equal(r.status, 400);
  }
});

test("批注内容超长返回 413", function () {
  const r = core.validateNewAnnotation(
    ann({ body: "长".repeat(core.LIMITS.BODY_MAX_CHARS + 1) }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(r.code, "body_too_large");
});

test("范围为空（end <= start 或负值）必须拒绝", function () {
  for (const [s, e] of [[3, 3], [5, 2], [-1, 2]]) {
    const r = core.validateNewAnnotation(ann({ start: s, end: e, quote: "ال" }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "empty_range", `start=${s} end=${e}`);
  }
});

test("引文长度与起止位置不一致必须拒绝（位置已失真）", function () {
  const r = core.validateNewAnnotation(ann({ start: 0, end: 10, quote: "短" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "range_quote_mismatch");
});

test("引文为空 / 超长必须拒绝", function () {
  assert.equal(core.validateNewAnnotation(ann({ start: 0, end: 1, quote: "" })).ok, false);
  const big = "ق".repeat(core.LIMITS.QUOTE_MAX_CHARS + 1);
  const r = core.validateNewAnnotation(
    ann({ start: 0, end: core.LIMITS.QUOTE_MAX_CHARS + 1, quote: big }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(r.code, "quote_too_large");
});

test("段落编号非法必须拒绝", function () {
  for (const bad of [-1, 1.5, "0", null]) {
    const r = core.validateNewAnnotation(ann({ paraIndex: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "invalid_para_index", String(bad));
  }
});

test("emoji 引文按码点计长度（代理对算 1 个逻辑字符）", function () {
  const r = core.validateNewAnnotation(ann({ start: 1, end: 3, quote: "😀😀" }));
  assert.equal(r.ok, true);
});

/* ---------- 回复校验 ---------- */

test("回复为空拒绝、超长 413、作者默认匿名", function () {
  assert.equal(core.validateReply({ body: "" }).code, "empty_body");
  const long = core.validateReply({ body: "好".repeat(core.LIMITS.REPLY_MAX_CHARS + 1) });
  assert.equal(long.status, 413);
  const ok = core.validateReply({ body: "同意" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.author, "匿名");
});

/* ---------- 锚点重定位 ---------- */

const PARAS = [
  { dir: "rtl", text: "أنا أحب العربية كثيرا" },
  { dir: "auto", text: "中文与 العربية 混排" }
];

test("文本未变：锚点保持原位置（moved=false）", function () {
  // "中文与 العربية 混排"：阿文起点 = 4（中 文 与 空格）
  const a = { paraIndex: 1, start: 4, end: 11, quote: "العربية" };
  const r = core.reanchor(a, PARAS);
  assert.equal(r.ok, true);
  assert.deepEqual([r.paraIndex, r.start, r.end], [1, 4, 11]);
  assert.equal(r.moved, false);
});

test("在批注范围之前插入文字：锚点整体后移，仍指向原字符", function () {
  const paras = [{ dir: "auto", text: "前缀中文与 العربية 混排" }];
  const a = { paraIndex: 0, start: 4, end: 11, quote: "العربية" };
  const r = core.reanchor(a, paras);
  assert.equal(r.ok, true);
  assert.equal(r.start, 6); // 前面多了 2 个码点
  assert.equal(r.end, 13);
  assert.equal(r.moved, true);
});

test("在批注范围之后删除文字：锚点位置不变", function () {
  const paras = [{ dir: "auto", text: "中文与 العربية" }];
  const a = { paraIndex: 0, start: 4, end: 11, quote: "العربية" };
  const r = core.reanchor(a, paras);
  assert.equal(r.ok, true);
  assert.equal(r.start, 4);
  assert.equal(r.moved, false);
});

test("方向切换（ltr↔rtl）不改变文本：锚点完全不动", function () {
  const a = { paraIndex: 0, start: 0, end: 5, quote: "أنا أ" };
  const before = core.reanchor(a, PARAS);
  const flipped = PARAS.map(p => ({ dir: p.dir === "rtl" ? "ltr" : "rtl", text: p.text }));
  const after = core.reanchor(a, flipped);
  assert.deepEqual(after, before);
  assert.equal(after.moved, false);
});

test("引文被移到另一段：跨段重定位并标记 paraMoved", function () {
  const paras = [
    { dir: "auto", text: "第一段内容" },
    { dir: "auto", text: "现在 العربية 在这里" }
  ];
  const a = { paraIndex: 0, start: 4, end: 11, quote: "العربية" };
  const r = core.reanchor(a, paras);
  assert.equal(r.ok, true);
  assert.equal(r.paraIndex, 1);
  assert.equal(r.start, 3);
  assert.equal(r.paraMoved, true);
});

test("同一引文多次出现：取离旧锚点最近的一处", function () {
  // 码点位置：abc␣=0-3, 目标=4-5, ␣xyz␣=6-10, 目标=11-12, ␣abc␣=13-17, 目标=18-19
  const paras = [{ dir: "auto", text: "abc 目标 xyz 目标 abc 目标" }];
  // 旧锚点指向第二个“目标”（11–13），但原位置已被改写 → 取最近出现处
  const a = { paraIndex: 0, start: 9, end: 11, quote: "目标" };
  const r = core.reanchor(a, paras);
  assert.equal(r.ok, true);
  assert.equal(r.start, 11); // |11-9| < |4-9|、|18-9|
  assert.equal(r.moved, true);
});

test("引文被彻底删除：锚点失效（quote_not_found）", function () {
  const paras = [{ dir: "auto", text: "中文与混排内容" }];
  const a = { paraIndex: 0, start: 4, end: 11, quote: "العربية" };
  const r = core.reanchor(a, paras);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "quote_not_found");
});

test("整段被删除且引文不在别处：锚点失效", function () {
  const a = { paraIndex: 3, start: 0, end: 2, quote: "没了" };
  const r = core.reanchor(a, PARAS);
  assert.equal(r.ok, false);
});

test("emoji 参与的重定位按码点计算", function () {
  const paras = [{ dir: "auto", text: "😀😀 目标文本 😀" }];
  const a = { paraIndex: 0, start: 3, end: 7, quote: "目标文本" };
  const r = core.reanchor(a, paras);
  assert.equal(r.ok, true);
  assert.equal(r.start, 3);
  assert.equal(r.end, 7);
});

/* ---------- 记录规范化（从快照恢复） ---------- */

test("完整记录规范化：保留状态/回复/时间，缺省补齐", function () {
  const r = core.normalizeAnnotationRecord({
    id: "abc",
    author: "张三",
    body: "批注",
    paraIndex: 0, start: 0, end: 2, quote: "中文", paraDir: "ltr",
    status: "resolved",
    createdAt: "2026-09-01T00:00:00.000Z",
    resolvedAt: "2026-09-02T00:00:00.000Z",
    resolvedBy: "李四",
    replies: [{ id: "r1", author: "王五", body: "回复", createdAt: "2026-09-01T01:00:00.000Z" }]
  }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.value.status, "resolved");
  assert.equal(r.value.resolvedBy, "李四");
  assert.equal(r.value.replies.length, 1);
  assert.equal(r.value.replies[0].body, "回复");
});

test("非法状态降级 open；空回复内容整条拒绝", function () {
  const downgraded = core.normalizeAnnotationRecord(
    ann({ status: "weird" }), 0);
  assert.equal(downgraded.ok, true);
  assert.equal(downgraded.value.status, "open");

  const bad = core.normalizeAnnotationRecord(
    ann({ replies: [{ body: "  " }] }), 0);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "empty_body");
});

test("回复数超上限拒绝（413）", function () {
  const replies = [];
  for (let i = 0; i < core.LIMITS.REPLY_MAX_COUNT + 1; i++) replies.push({ body: "r" });
  const r = core.normalizeAnnotationRecord(ann({ replies: replies }), 0);
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

/* ---------- 快照嵌入 ---------- */

test("snapshotDigest 深拷贝批注集合（含状态与回复）", function () {
  const anns = [Object.assign(ann(), {
    id: "a1", status: "resolved", createdAt: "t", updatedAt: "t",
    resolvedAt: "t2", resolvedBy: "某人",
    replies: [{ id: "r", author: "乙", body: "好", createdAt: "t" }]
  })];
  const digest = core.snapshotDigest(anns);
  assert.equal(digest.length, 1);
  assert.equal(digest[0].status, "resolved");
  assert.equal(digest[0].replies[0].body, "好");
  // 深拷贝：改原数组不影响 digest
  anns[0].body = "被改";
  anns[0].replies[0].body = "被改";
  assert.notEqual(digest[0].body, "被改");
  assert.notEqual(digest[0].replies[0].body, "被改");
});
