/* node --test test/core.test.js
 * 纯逻辑测试：校验、字符级逻辑位置差异（重点验证 RTL 不会反转位置）、段落对齐。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../snapshot-core");

function snap(name, texts, dirs) {
  return {
    name: name,
    paragraphs: texts.map(function (t, i) {
      return { dir: (dirs && dirs[i]) || "auto", text: t, editedAt: "2026-09-12T00:00:00.000Z" };
    })
  };
}

/* ---------- 校验 ---------- */

test("名称为空或纯空白必须拒绝", function () {
  ["", "   ", "\t\n"].forEach(function (n) {
    const r = core.validateSnapshotPayload(snap(n, ["x"]));
    assert.equal(r.ok, false);
    assert.equal(r.code, "empty_name");
  });
});

test("名称不是字符串必须拒绝", function () {
  const r = core.validateSnapshotPayload({ name: 123, paragraphs: [{ text: "x" }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_name");
});

test("名称超长必须拒绝", function () {
  const r = core.validateSnapshotPayload({ name: "x".repeat(101), paragraphs: [{ text: "" }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "name_too_long");
});

test("段落缺失/结构错误必须拒绝", function () {
  assert.equal(core.validateSnapshotPayload({ name: "a", paragraphs: [] }).ok, false);
  assert.equal(core.validateSnapshotPayload({ name: "a" }).ok, false);
  assert.equal(core.validateSnapshotPayload({ name: "a", paragraphs: [{ text: 42 }] }).ok, false);
  assert.equal(core.validateSnapshotPayload("x").ok, false);
});

test("单段超 5 万字符拒绝，返回 413", function () {
  const r = core.validateSnapshotPayload({ name: "a", paragraphs: [{ text: "x".repeat(50001) }] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(r.code, "paragraph_too_large");
});

test("总量超 10 万字符拒绝，返回 413；emoji 按码点计", function () {
  const emoji = "😀".repeat(50000); // 50000 码点，100000 UTF-16 单元，恰好等于单段上限
  assert.equal(core.cpLen(emoji), 50000);
  const r = core.validateSnapshotPayload({
    name: "a",
    paragraphs: [{ text: emoji }, { text: "x".repeat(50000) }, { text: "多1个" }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(r.code, "snapshot_too_large");
});

test("合法载荷被规范化：trim 名称、非法 dir 降级 auto、补 editedAt", function () {
  const r = core.validateSnapshotPayload({
    name: "  草稿  ",
    paragraphs: [{ dir: "sideways", text: "abc", editedAt: "not-a-date" }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, "草稿");
  assert.equal(r.value.paragraphs[0].dir, "auto");
  assert.ok(!isNaN(Date.parse(r.value.paragraphs[0].editedAt)));
});

/* ---------- 字符级差异与逻辑位置 ---------- */

test("中文段中间插入：新增段位置是逻辑偏移而非镜像", function () {
  const segs = core.charDiff("我喜欢中文", "我很喜欢中文");
  const ins = segs.filter(s => s.type === "ins");
  assert.equal(ins.length, 1);
  assert.equal(ins[0].text, "很");
  assert.equal(ins[0].newStart, 1);
  assert.equal(ins[0].newEnd, 2);
  assert.equal(ins[0].oldStart, null);
});

test("阿拉伯文插入：位置按逻辑码点，删除/新增不被 RTL 标反", function () {
  // مرحبا = م ر ح ب ا (5)，在 ر(1) 后插入 ى
  const oldT = "مرحبا";
  const newT = "مرحباى"; // 追加情形先做最简单验证
  const segs = core.charDiff(oldT, newT);
  const ins = segs.filter(s => s.type === "ins");
  assert.equal(ins[0].text, "ى");
  assert.equal(ins[0].newStart, 5);
  assert.equal(ins[0].newEnd, 6);
});

test("阿拉伯文中间删除：oldStart/oldEnd 指逻辑位置", function () {
  // 删掉中间的 ح（索引 2）
  const segs = core.charDiff("مرحبا", "مربا");
  const del = segs.filter(s => s.type === "del");
  assert.equal(del[0].text, "ح");
  assert.equal(del[0].oldStart, 2);
  assert.equal(del[0].oldEnd, 3);
});

test("中阿混排：插入位置同时核对 old/new 逻辑偏移", function () {
  const oldT = "学习 العربية 很有趣";
  const newT = "学习 العربية جميل 很有趣";
  const segs = core.charDiff(oldT, newT);
  const ins = segs.find(s => s.type === "ins" && s.text.indexOf("جميل") !== -1);
  assert.ok(ins, "应存在 جميل 新增段");
  // "学习 " = 3 个码点, "العربية" = 7 码点, 再加一个空格 => 3+7+1=11
  // "جميل " = 4 + 1 = 5 个码点
  assert.equal(ins.newStart, 11);
  assert.equal(ins.newEnd, 11 + 5);
});

test("emoji 代理对按一个逻辑字符计位置", function () {
  const segs = core.charDiff("a😀c", "a😀xc");
  const ins = segs.filter(s => s.type === "ins")[0];
  assert.equal(ins.text, "x");
  assert.equal(ins.newStart, 2); // a=0, 😀=1
});

test("完全相同的文本只有 equal 段", function () {
  const segs = core.charDiff("نص عربي", "نص عربي");
  assert.ok(segs.every(s => s.type === "equal"));
});

/* ---------- 段落级差异 ---------- */

test("整快照差异：识别修改/删除/新增/不变与方向变化", function () {
  const a = snap("旧", ["第一段", "第二段", "第三段", "只在旧版"],
                       ["ltr", "auto", "rtl", "auto"]);
  const b = snap("新", ["第一段改了", "第二段", "第四段", "只在新版", "又一新段"],
                       ["ltr", "rtl", "auto", "auto", "auto"]);
  const d = core.diffSnapshots(a, b);

  const kinds = d.rows.map(r => r.kind +
    (r.kind === "changed" && r.dirChanged ? "(dir)" : ""));
  assert.ok(kinds.indexOf("changed") !== -1);      // 第一段 文本变
  assert.ok(kinds.indexOf("changed(dir)") !== -1); // 第二段 仅方向变
  assert.ok(kinds.indexOf("removed") !== -1);      // 未配对的整段删除
  assert.ok(kinds.indexOf("added") !== -1);        // 未配对的整段新增
});

test("仅方向不同：changed 行无字符差异但 dirChanged=true", function () {
  const d = core.diffSnapshots(
    snap("a", ["مرحبا"], ["ltr"]),
    snap("b", ["مرحبا"], ["rtl"])
  );
  assert.equal(d.rows[0].kind, "changed");
  assert.equal(d.rows[0].dirChanged, true);
  assert.equal(d.rows[0].chars.length, 0);
});

test("段号各自按本侧文档顺序编号", function () {
  const d = core.diffSnapshots(
    snap("a", ["A", "B", "C"]),
    snap("b", ["A", "B2", "C"])
  );
  const changed = d.rows.find(r => r.kind === "changed");
  assert.equal(changed.aNo, 2);
  assert.equal(changed.bNo, 2);
});

test("插入一整段：added 行只带新侧段号，且统计字符数", function () {
  const d = core.diffSnapshots(snap("a", ["保持"]), snap("b", ["保持", "新增"]));
  const added = d.rows.find(r => r.kind === "added");
  assert.equal(added.bNo, 2);
  assert.equal(added.b.text, "新增");
  assert.equal(d.stats.added, 1);
  assert.equal(d.stats.insertedChars, 2);
});
