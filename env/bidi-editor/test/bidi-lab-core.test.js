/* node --test test/bidi-lab-core.test.js
 * 纯逻辑测试：字素簇切分、码点名称、UAX#9 重排、逐段诊断、
 * 修复计划与整批应用的条件门禁、样例回归比对。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../bidi-lab-core");

/* ---------- 字素簇 ---------- */

test("组合字符、代理对、ZWJ、国旗 emoji 都保持为单个字素簇", function () {
  const gs = C.segmentGraphemes("aé😀🇨🇳رِ\u200C\u200D👨\u200D👩\u200D👧");
  const texts = gs.map(function (g) { return g.text; });
  // a / é(e+combining acute 已预组合，仍 1 簇) / 😀 / 🇨🇳 / رِ / \u200D 前的 ZWNJ 与阿拉伯字成簇 / 家庭 emoji
  assert.ok(texts.indexOf("a") === 0);
  assert.deepEqual(texts[2], "😀");
  assert.deepEqual(texts[3], "🇨🇳");
  // 家庭 emoji ZWJ 序列是一个字素簇
  const family = texts[texts.length - 1];
  assert.equal([...family].length >= 5, true);
  // 所有簇的 start/end 连续覆盖
  var pos = 0;
  gs.forEach(function (g) {
    assert.equal(g.start, pos);
    pos = g.end;
  });
});

test("阿拉伯文 + 拼音符号 + 组合音符不拆散", function () {
  const t = "بِ"; // BEH + KASRA
  const gs = C.segmentGraphemes(t);
  assert.equal(gs.length, 1);
  assert.equal(gs[0].cps.length, 2);
  assert.equal(gs[0].start, 0);
  assert.equal(gs[0].end, 2);
});

test("每个码点都带名称与十六进制码位，且不编造", function () {
  const gs = C.segmentGraphemes("A中\u202E");
  assert.equal(gs[0].cps[0].name, "LATIN CAPITAL LETTER A");
  assert.equal(gs[0].cps[0].cp, 0x41); // cps[].cp 是数字码点
  assert.equal(gs[0].cps[0].hex, "0041");
  assert.equal(gs[1].cps[0].name, "CJK UNIFIED IDEOGRAPH-4E2D");
  assert.equal(gs[2].cps[0].name, "RIGHT-TO-LEFT OVERRIDE");
  // 私用区/未知名：诚实兜底
  assert.match(C.cpName(0xF0000), /^UNNAMED CHARACTER F0000$/);
  assert.equal(C.cpName(0xD800), "SURROGATE CODE POINT");
});

/* ---------- 双向类型 ---------- */

test("bidiType：拉丁/阿拉伯/数字/标点", function () {
  assert.equal(C.bidiType(0x41), "L");
  assert.equal(C.bidiType(0x627), "AL"); // ALEF
  assert.equal(C.bidiType(0x35), "EN");
  assert.equal(C.bidiType(0x663), "AN"); // ARABIC-INDIC DIGIT THREE
  assert.equal(C.bidiType(0x2C), "CS");
  assert.equal(C.bidiType(0x2D), "ES");
  assert.equal(C.bidiType(0x200D), "BN");
  assert.equal(C.bidiType(0x650), "NSM"); // KASRA
});

test("formattingOf 识别全部显式方向控制符", function () {
  assert.equal(C.formattingOf(0x202A).kind, "embed");
  assert.equal(C.formattingOf(0x202B).legacy, true);
  assert.equal(C.formattingOf(0x202E).kind, "override");
  assert.equal(C.formattingOf(0x2069).kind, "pdi");
  assert.equal(C.formattingOf(0x202C).kind, "pop");
  assert.equal(C.formattingOf(0x200F).embedding, "R");
  assert.equal(C.formattingOf(0x61), null);
});

/* ---------- UAX#9 重排 ---------- */

test("LTR 段保持顺序；内嵌数字不反转", function () {
  const r = C.resolveParagraph("a123b", "ltr");
  assert.equal(r.baseLevel, 0);
  assert.deepEqual(r.order.map(function (o) { return o.gi; }), [0, 1, 2, 3, 4]);
});

test("RTL 段：阿拉伯文反转，内嵌拉丁数字保持 LTR 阅读序", function () {
  const r = C.resolveParagraph("السعر 123 ريال", "rtl");
  assert.equal(r.baseLevel, 1);
  const visual = r.order.map(function (o) { return r.clusters[o.gi].text; }).join("");
  // 视觉上：ريال 123 السعر 的形态；关键是数字串顺序仍是 1 2 3
  const i1 = visual.indexOf("1"), i2 = visual.indexOf("2"), i3 = visual.indexOf("3");
  assert.ok(i1 < i2 && i2 < i3, "数字 123 在视觉序中保持 1→2→3");
});

test("括号在 RTL 上下文中镜像定位", function () {
  const r = C.resolveParagraph("نص (عربي) هنا", "rtl");
  const visual = r.order.map(function (o) { return r.clusters[o.gi].text; }).join("");
  // 开括号 '(' 应出现在 عربي 的右侧（即视觉上包在 عربي 两边）
  const po = visual.indexOf("("), pc = visual.indexOf(")");
  const ai = visual.indexOf("ع"), yi = visual.indexOf("ي");
  assert.ok(po !== -1 && pc !== -1);
  assert.ok(Math.abs(po - ai) <= 5 && Math.abs(pc - yi) <= 5);
});

test("旧式嵌入：LRE…PDF 改变内部方向；未关闭在段末重置", function () {
  const r = C.resolveParagraph("a\u202Bb\u202Cc", "ltr");
  assert.equal(r.maxDepth >= 2, true);
  const pushes = r.events.filter(function (e) { return e.action === "push"; });
  const pops = r.events.filter(function (e) { return e.action === "pop"; });
  assert.equal(pushes.length, 1);
  assert.equal(pops.length, 1);
});

/* ---------- 诊断 ---------- */

test("孤立 PDI/PDF 报 orphan_control", function () {
  const rep = C.diagnose([{ dir: "auto", text: "abc\u2069x\u202Cy" }]);
  assert.ok(rep.issues.some(function (i) {
    return i.type === C.IT.ORPHAN_CONTROL && i.start === 3;
  }));
  assert.ok(rep.issues.some(function (i) {
    return i.type === C.IT.ORPHAN_CONTROL && i.start === 5;
  }));
});

test("RLO 覆盖报高风险 override_control 与 visual_logic_mismatch", function () {
  const rep = C.diagnose([{ dir: "auto", text: "x\u202Eabc\u202Cy" }]);
  const ov = rep.issues.filter(function (i) { return i.type === C.IT.OVERRIDE_CONTROL; });
  assert.equal(ov.length, 1);
  assert.equal(ov[0].severity, C.SEV.HIGH);
  assert.match(ov[0].codepoints[0].name, /OVERRIDE/);
  assert.ok(rep.issues.some(function (i) {
    return i.type === C.IT.VISUAL_LOGIC_MISMATCH;
  }));
});

test("LRE 旧式嵌入报 legacy_embedding，且给转隔离建议", function () {
  const rep = C.diagnose([{ dir: "auto", text: "a\u202Bb\u202Cc" }]);
  const le = rep.issues.find(function (i) { return i.type === C.IT.LEGACY_EMBEDDING; });
  assert.ok(le);
  const plan = C.buildPlan({ paragraphs: [{ dir: "auto", text: "a\u202Bb\u202Cc" }] }, rep);
  assert.ok(plan.suggestions.some(function (s) {
    return s.kind === C.FK.LEGACY_TO_ISOLATE &&
           s.replacementCp === "U+2067" && // RLE -> RLI
           s.start === le.start;
  }));
});

test("LRE 在非最后一段未关闭 → cross_paragraph_state；最后一段 → unclosed_embedding", function () {
  const two = C.diagnose([
    { dir: "auto", text: "a\u202Bb" },
    { dir: "auto", text: "c" }
  ]);
  assert.ok(two.issues.some(function (i) {
    return i.type === C.IT.CROSS_PARAGRAPH_STATE && i.para === 1;
  }));
  assert.ok(!two.issues.some(function (i) {
    return i.type === C.IT.UNCLOSED_EMBEDDING;
  }));
  const one = C.diagnose([{ dir: "auto", text: "a\u202Bb" }]);
  assert.ok(one.issues.some(function (i) {
    return i.type === C.IT.UNCLOSED_EMBEDDING;
  }));
});

test("混合阿拉伯/拉丁数字报 mixed_digits，位置是逻辑码点", function () {
  const rep = C.diagnose([{ dir: "rtl", text: "السعر ٣٥٠350 ريال" }]);
  const md = rep.issues.find(function (i) { return i.type === C.IT.MIXED_DIGITS; });
  assert.ok(md);
  // 逻辑位置 6..12，即使段落 RTL 也不反转
  assert.equal(md.start, 6);
  assert.equal(md.end, 12);
});

test("未配对括号报 bracket_mismatch", function () {
  const rep = C.diagnose([{ dir: "ltr", text: "a(b c" }]);
  assert.ok(rep.issues.some(function (i) {
    return i.type === C.IT.BRACKET_MISMATCH;
  }));
});

test("悬空 ZWJ 报 dangling_joiner；正常连接不报", function () {
  const dangling = C.diagnose([{ dir: "rtl", text: "a\u200Db" }]); // a/L 与 b/L 之间 ZWJ
  assert.ok(dangling.issues.some(function (i) {
    return i.type === C.IT.DANGLING_JOINER;
  }));
  const joined = C.diagnose([{ dir: "rtl", text: "ب\u200Dب" }]); // 两个阿拉伯字母间 ZWJ
  assert.ok(!joined.issues.some(function (i) {
    return i.type === C.IT.DANGLING_JOINER;
  }));
});

test("每个问题都带段落号、逻辑码点范围、码点名称、字素簇与原因", function () {
  const rep = C.diagnose([{ dir: "auto", text: "x\u2069y\u202Ez\u202C" }]);
  assert.ok(rep.issues.length >= 2);
  rep.issues.forEach(function (i) {
    assert.ok(Number.isInteger(i.para) && i.para >= 1);
    assert.ok(Number.isInteger(i.start) && Number.isInteger(i.end) && i.end > i.start);
    assert.ok(Array.isArray(i.codepoints) && i.codepoints.length);
    i.codepoints.forEach(function (c) {
      assert.match(c.cp, /^U\+[0-9A-F]{4,6}$/);
      assert.equal(typeof c.name, "string");
    });
    assert.equal(typeof i.cluster, "string");
    assert.ok(i.reason.length > 8);
    assert.ok(i.graphemeEnd >= i.graphemeStart); // 簇下标包含端点；单簇问题两端相等
    assert.ok(i.end > i.start);
  });
});

test("超长段落：截断诊断并告警，不抛异常", function () {
  const long = "ع".repeat(C.LIMITS.PARA_WARN_CHARS + 50) + "\u202E";
  const rep = C.diagnose([{ dir: "auto", text: long }]);
  assert.ok(rep.truncatedParas.indexOf(1) !== -1);
  assert.ok(rep.warnings.some(function (w) { return w.code === "paragraph_truncated"; }));
  const tooLong = "x".repeat(C.LIMITS.PARA_MAX_CHARS + 1);
  const rep2 = C.diagnose([{ dir: "auto", text: tooLong }]);
  assert.ok(rep2.warnings.some(function (w) { return w.code === "paragraph_too_large"; }));
});

test("诊断是只读的：同一输入两次诊断结果一致且不改输入", function () {
  const doc = [{ dir: "auto", text: "a\u2069b\u202Ec\u202Cd" }];
  const snapshot = JSON.stringify(doc);
  const r1 = C.diagnose(doc);
  const r2 = C.diagnose(doc);
  assert.equal(JSON.stringify(doc), snapshot);
  assert.equal(r1.contentFp, r2.contentFp);
  assert.equal(r1.issues.length, r2.issues.length);
});

/* ---------- 修复与门禁 ---------- */

test("批量应用：删除孤立控制符 + 旧式转隔离 + set_dir 可一次成功", function () {
  const doc = { paragraphs: [
    { dir: "auto", text: "x\u202Ez\u202Aa\u202C\u2069b" },
    { dir: "ltr", text: "ثاني نص عربي طويل" }
  ]};
  const rep = C.diagnose(doc.paragraphs);
  const plan = C.buildPlan(doc, rep);
  const meta = { contentFp: rep.contentFp,
    renderFp: C.renderFingerprint({ dirs: ["auto", "ltr"], width: 800, zoom: 1, font: "" }) };
  const ids = plan.suggestions.map(function (s) { return s.id; });
  const r = C.applySuggestions(doc, { dirs: ["auto", "ltr"], width: 800, zoom: 1, font: "" },
    ids, plan, meta);
  assert.equal(r.ok, true, JSON.stringify(r));
  // RLO 被删、LRE 被换成 LRI、段落 2 方向改为 rtl
  assert.equal(r.paragraphs[0].text.indexOf("\u202E"), -1);
  assert.notEqual(r.paragraphs[0].text.indexOf("\u2066"), -1); // LRE→LRI
  assert.equal(r.paragraphs[1].dir, "rtl");
});

test("正文变化后应用被整次拒绝（content_changed），不改任何文字", function () {
  const doc = { paragraphs: [{ dir: "auto", text: "x\u2069y\u202Ez" }] };
  const rep = C.diagnose(doc.paragraphs);
  const plan = C.buildPlan(doc, rep);
  const meta = { contentFp: rep.contentFp,
    renderFp: C.renderFingerprint({ dirs: ["auto"], width: 800, zoom: 1, font: "" }) };
  const changed = { paragraphs: [{ dir: "auto", text: "x\u2029y\u202EzEXTRA" }] };
  const r = C.applySuggestions(changed, { dirs: ["auto"], width: 800, zoom: 1, font: "" },
    [plan.suggestions[0].id], plan, meta);
  assert.equal(r.ok, false);
  assert.equal(r.code, "content_changed");
});

test("渲染条件（宽度/缩放/字体/方向）变化后应用被拒绝", function () {
  const doc = { paragraphs: [{ dir: "rtl", text: "a\u2069b" }] };
  const rep = C.diagnose(doc.paragraphs);
  const plan = C.buildPlan(doc, rep);
  const meta = { contentFp: rep.contentFp,
    renderFp: C.renderFingerprint({ dirs: ["rtl"], width: 800, zoom: 1, font: "X" }) };
  [
    { dirs: ["rtl"], width: 600, zoom: 1, font: "X" },
    { dirs: ["rtl"], width: 800, zoom: 2, font: "X" },
    { dirs: ["rtl"], width: 800, zoom: 1, font: "Y" },
    { dirs: ["ltr"], width: 800, zoom: 1, font: "X" }
  ].forEach(function (cond) {
    const r = C.applySuggestions(doc, cond, [plan.suggestions[0].id], plan, meta);
    assert.equal(r.code, "render_condition_changed", JSON.stringify(cond));
  });
});

test("建议范围重叠时整次拒绝", function () {
  // 手工构造两个重叠建议
  const doc = { paragraphs: [{ dir: "auto", text: "\u2069\u2069ab" }] };
  const rep = C.diagnose(doc.paragraphs);
  const plan = { docFp: rep.contentFp, suggestions: [
    { id: "a", kind: C.FK.REMOVE_FORMATTING, para: 1, start: 0, end: 1, before: [{ cp: "U+2069" }] },
    { id: "b", kind: C.FK.REMOVE_FORMATTING, para: 1, start: 0, end: 2, before: [{ cp: "U+2069" }, { cp: "U+2069" }] }
  ]};
  const meta = { contentFp: rep.contentFp,
    renderFp: C.renderFingerprint({ dirs: ["auto"], width: 800, zoom: 1, font: "" }) };
  const r = C.applySuggestions(doc, { dirs: ["auto"], width: 800, zoom: 1, font: "" },
    ["a", "b"], plan, meta);
  assert.equal(r.code, "suggestions_overlap");
});

test("isolate_number 修复后问题可被重新诊断清除", function () {
  const doc = { paragraphs: [{ dir: "rtl", text: "السعر ٣٥٠350 ريال" }] };
  const rep = C.diagnose(doc.paragraphs);
  const plan = C.buildPlan(doc, rep);
  const meta = { contentFp: rep.contentFp,
    renderFp: C.renderFingerprint({ dirs: ["rtl"], width: 800, zoom: 1, font: "" }) };
  const s = plan.suggestions.find(function (x) { return x.kind === C.FK.ISOLATE_NUMBER; });
  const r = C.applySuggestions(doc, { dirs: ["rtl"], width: 800, zoom: 1, font: "" },
    [s.id], plan, meta);
  assert.equal(r.ok, true);
  assert.ok(r.paragraphs[0].text.indexOf("\u2068") !== -1);
  assert.ok(r.paragraphs[0].text.indexOf("\u2069") !== -1);
});

/* ---------- 成对方向控制符修复（开符必须与配对闭符联动处理） ---------- */

// 应用某段文本中除 set_dir 外的全部修复建议，并重新诊断
function repairAndRediagnose(text) {
  const doc = { paragraphs: [{ dir: "auto", text: text }] };
  const rep = C.diagnose(doc.paragraphs);
  const plan = C.buildPlan(doc, rep);
  const meta = { contentFp: rep.contentFp,
    renderFp: C.renderFingerprint({ dirs: ["auto"], width: 800, zoom: 1, font: "" }) };
  const ids = plan.suggestions
    .filter(function (s) { return s.kind !== C.FK.SET_DIR; })
    .map(function (s) { return s.id; });
  const r = C.applySuggestions(doc, { dirs: ["auto"], width: 800, zoom: 1, font: "" },
    ids, plan, meta);
  assert.equal(r.ok, true, JSON.stringify(r));
  return { plan: plan, result: r, after: C.diagnose(r.paragraphs) };
}

// 控制符配对类问题：修复后不允许出现任何一个
function pairingIssueTypes(report) {
  const pairing = {};
  [C.IT.ORPHAN_CONTROL, C.IT.UNCLOSED_EMBEDDING,
   C.IT.CROSS_PARAGRAPH_STATE, C.IT.LEGACY_EMBEDDING,
   C.IT.OVERRIDE_CONTROL].forEach(function (t) { pairing[t] = true; });
  return report.issues.filter(function (i) { return pairing[i.type]; });
}

test("已闭合的 LRE…PDF / RLO…PDF 不再被误报为未关闭", function () {
  const LRE = "‪", PDF = "‬", RLO = "‮";
  const lre = C.diagnose([{ dir: "auto", text: "a" + LRE + "b" + PDF + "c" }]);
  assert.ok(!lre.issues.some(function (i) {
    return i.type === C.IT.UNCLOSED_EMBEDDING || i.type === C.IT.CROSS_PARAGRAPH_STATE;
  }));
  const rlo = C.diagnose([{ dir: "auto", text: "x" + RLO + "abc" + PDF + "y" }]);
  assert.ok(!rlo.issues.some(function (i) {
    return i.type === C.IT.UNCLOSED_EMBEDDING || i.type === C.IT.CROSS_PARAGRAPH_STATE;
  }));
});

test("RLO…PDF：修复建议同时删除开符与配对 PDF，重新诊断无孤立 PDF", function () {
  const out = repairAndRediagnose("x‮abc‬y");
  // 建议必须带一个删除型附加编辑，且落在 PDF（U+202C）位置
  const ov = out.plan.suggestions.find(function (s) {
    return s.kind === C.FK.REMOVE_FORMATTING && s.start === 1;
  });
  assert.ok(ov && Array.isArray(ov.extraEdits) && ov.extraEdits.length === 1);
  assert.equal(ov.extraEdits[0].start, 5);
  assert.equal(ov.extraEdits[0].replacementCp, null);
  // 两个控制符都被删掉
  assert.equal(Array.from(out.result.paragraphs[0].text)
    .some(function (c) { return c.codePointAt(0) === 0x202E; }), false);
  assert.equal(Array.from(out.result.paragraphs[0].text)
    .some(function (c) { return c.codePointAt(0) === 0x202C; }), false);
  // 重新诊断：无任何配对问题
  assert.equal(pairingIssueTypes(out.after).length, 0,
    out.after.issues.map(function (i) { return i.type; }).join(","));
});

test("LRE…PDF：开符转 LRI 的同时把配对 PDF 替换为 PDI，重新诊断配对有效", function () {
  const out = repairAndRediagnose("a‪b‬c");
  const fix = out.plan.suggestions.find(function (s) {
    return s.kind === C.FK.LEGACY_TO_ISOLATE;
  });
  assert.ok(fix);
  assert.equal(fix.start, 1);
  assert.ok(Array.isArray(fix.extraEdits) && fix.extraEdits.length === 1);
  assert.equal(fix.extraEdits[0].start, 3);
  assert.equal(fix.extraEdits[0].replacementCp, "U+2069"); // PDF → PDI
  // 修复后为 a + LRI + b + PDI + c
  const cps = Array.from(out.result.paragraphs[0].text).map(function (c) {
    return c.codePointAt(0);
  });
  assert.deepEqual(cps, [0x61, 0x2066, 0x62, 0x2069, 0x63]);
  // 重新诊断：无孤立 PDF、无未闭合隔离、无旧式/覆盖控制符
  assert.equal(pairingIssueTypes(out.after).length, 0,
    out.after.issues.map(function (i) { return i.type; }).join(","));
});

test("RLE…PDF：RLE→RLI 且 PDF→PDI，重新诊断配对有效", function () {
  const text = ["a", "‫", "b", "‬", "c"].join("");
  const out = repairAndRediagnose(text);
  const cps = Array.from(out.result.paragraphs[0].text).map(function (c) {
    return c.codePointAt(0);
  });
  assert.deepEqual(cps, [0x61, 0x2067, 0x62, 0x2069, 0x63]);
  assert.equal(pairingIssueTypes(out.after).length, 0);
});

test("未闭合的 RLO 只删开符即可，不产生孤立 PDF；未闭合 LRE 转 LRI 不新增问题类型", function () {
  const rlo = repairAndRediagnose("x‮abc");
  const ov = rlo.plan.suggestions.find(function (s) { return s.start === 1; });
  assert.ok(!ov.extraEdits || ov.extraEdits.length === 0);
  assert.equal(rlo.after.issues.filter(function (i) {
    return [C.IT.ORPHAN_CONTROL, C.IT.OVERRIDE_CONTROL].indexOf(i.type) !== -1;
  }).length, 0);

  const lre = repairAndRediagnose("a‪b");
  // 转隔离后至多保留“未关闭”这一修复前就存在的问题类型，且绝不出现孤立 PDF
  assert.ok(!lre.after.issues.some(function (i) { return i.type === C.IT.ORPHAN_CONTROL; }));
  assert.ok(!lre.after.issues.some(function (i) { return i.type === C.IT.LEGACY_EMBEDDING; }));
});

test("隔离内部无配对 PDF、由外层 PDI 隐式结束的 RLE：转换时在 PDI 前补 PDI", function () {
  // a + LRI + RLE + b + PDI + c（无 PDF；RLE 帧被 PDI 按 X6a 隐式结束）
  const text = ["a", "⁦", "‫", "b", "⁩", "c"].join("");
  const rep = C.diagnose([{ dir: "auto", text: text }]);
  assert.ok(rep.issues.some(function (i) { return i.type === C.IT.LEGACY_EMBEDDING; }));
  const out = repairAndRediagnose(text);
  const fix = out.plan.suggestions.find(function (s) {
    return s.kind === C.FK.LEGACY_TO_ISOLATE;
  });
  assert.ok(fix.extraEdits.length === 1);
  // 插入型编辑：start===end，在 PDI（gi 4）前插入 PDI
  assert.equal(fix.extraEdits[0].start, fix.extraEdits[0].end);
  assert.equal(fix.extraEdits[0].start, 4);
  assert.equal(fix.extraEdits[0].replacementCp, "U+2069");
  const cps = Array.from(out.result.paragraphs[0].text).map(function (c) {
    return c.codePointAt(0);
  });
  assert.deepEqual(cps, [0x61, 0x2066, 0x2067, 0x62, 0x2069, 0x2069, 0x63]);
  assert.equal(pairingIssueTypes(out.after).length, 0);
});

test("嵌套 LRE…RLE…PDF…PDF：两条建议各自只改自己的配对 PDF", function () {
  const text = ["a", "‪", "b", "‫", "x", "‬", "y", "‬", "z"].join("");
  const out = repairAndRediagnose(text);
  const cps = Array.from(out.result.paragraphs[0].text).map(function (c) {
    return c.codePointAt(0);
  });
  assert.deepEqual(cps, [0x61, 0x2066, 0x62, 0x2067, 0x78, 0x2069, 0x79, 0x2069, 0x7A]);
  assert.equal(pairingIssueTypes(out.after).length, 0);
});

/* ---------- 指纹 ---------- */

test("内容指纹对文本与方向敏感、对重复计算稳定", function () {
  const a = [{ dir: "ltr", text: "ab" }];
  const b = [{ dir: "rtl", text: "ab" }];
  const c = [{ dir: "ltr", text: "abc" }];
  assert.equal(C.contentFingerprint(a), C.contentFingerprint([{ dir: "ltr", text: "ab" }]));
  assert.notEqual(C.contentFingerprint(a), C.contentFingerprint(b));
  assert.notEqual(C.contentFingerprint(a), C.contentFingerprint(c));
});

test("渲染指纹：宽度/缩放/字体/方向数组任一变化都不同", function () {
  const base = { dirs: ["ltr", "rtl"], width: 800, zoom: 1, font: "A" };
  assert.equal(C.renderFingerprint(base),
    C.renderFingerprint({ dirs: ["ltr", "rtl"], width: 800, zoom: 1, font: "A" }));
  assert.notEqual(C.renderFingerprint(base),
    C.renderFingerprint({ dirs: ["ltr", "rtl"], width: 801, zoom: 1, font: "A" }));
  assert.notEqual(C.renderFingerprint(base),
    C.renderFingerprint({ dirs: ["ltr", "rtl"], width: 800, zoom: 1.5, font: "A" }));
  assert.notEqual(C.renderFingerprint(base),
    C.renderFingerprint({ dirs: ["ltr", "rtl"], width: 800, zoom: 1, font: "B" }));
  assert.notEqual(C.renderFingerprint(base),
    C.renderFingerprint({ dirs: ["rtl", "rtl"], width: 800, zoom: 1, font: "A" }));
});

/* ---------- 样例与回归 ---------- */

function validSample(over) {
  return Object.assign({
    name: "样例",
    paragraphs: [{ dir: "auto", text: "a\u202Eb\u2029c" }],
    expected: [{ type: C.IT.OVERRIDE_CONTROL, para: 1, start: 1 }],
    anchors: [{ para: 1, label: "覆盖点", start: 1, end: 2 }]
  }, over || {});
}

test("样例校验：空名、超长、坏段落、坏预期都被拒绝或过滤", function () {
  assert.equal(C.validateSample(validSample({ name: " " })).ok, false);
  assert.equal(C.validateSample(validSample({ name: "x".repeat(101) })).ok, false);
  assert.equal(C.validateSample(validSample({ paragraphs: [] })).ok, false);
  assert.equal(C.validateSample(validSample({ paragraphs: [{ text: 1 }] })).ok, false);
  const ok = C.validateSample(validSample());
  assert.equal(ok.ok, true);
  assert.equal(ok.value.expected.length, 1);
  // 不存在的问题类型被过滤
  const bad = C.validateSample(validSample({
    expected: [{ type: "not_a_type", para: 1, start: 0 }]
  }));
  assert.equal(bad.value.expected.length, 0);
});

test("回归：预期问题消失 → disappeared；新增 → added；位置变化 → moved", function () {
  // 初始样例预期 override 在位置 1
  const s = validSample();
  const r1 = C.recheckSample(s);
  // 当前文本 a + RLO(1) + b + PDI(3) + c：override 仍在 1，其余为新增
  assert.equal(r1.status === "new" || r1.status === "mixed", true);
  assert.ok(r1.added.length >= 1);

  // 把 RLO 去掉：override 消失
  const gone = validSample({
    paragraphs: [{ dir: "auto", text: "ab\u2029c" }]
  });
  const r2 = C.recheckSample(gone);
  assert.ok(r2.disappeared.some(function (d) {
    return d.type === C.IT.OVERRIDE_CONTROL;
  }));

  // RLO 后移一位：moved
  const moved = validSample({
    paragraphs: [{ dir: "auto", text: "ab\u202Ec" }]
  });
  const r3 = C.recheckSample(moved);
  assert.ok(r3.moved.some(function (m) {
    return m.type === C.IT.OVERRIDE_CONTROL && m.oldStart === 1 && m.newStart === 2;
  }));
});

test("回归：逻辑问题集合不变但渲染顺序变化 → render_changed", function () {
  // 构造两个视觉锚点：锚点所在簇的视觉位置随 dir 改变
  const text = "عربي abc";
  const sample = {
    id: "s", name: "render",
    paragraphs: [{ dir: "ltr", text: text }],
    expected: [],
    // 跨方向文本片段：dir 改变后其视觉序列必然不同
    anchors: [{ para: 1, label: "全段", start: 0, end: 8 }]
  };
  const fpLtr = C.anchorFingerprint(sample);
  // 同样问题集合（无问题），但 dir 改 rtl
  const changed = Object.assign({}, sample, { anchorFp: fpLtr });
  changed.paragraphs = [{ dir: "rtl", text: text }];
  const r = C.recheckSample(changed);
  assert.equal(r.orderChanged, true);
  assert.equal(r.status, "render_changed");
});

test("回归是只读的：不修改样例对象", function () {
  const s = validSample();
  const before = JSON.stringify(s);
  C.recheckSample(s);
  C.recheckAll([s]);
  assert.equal(JSON.stringify(s), before);
});

test("summarizeRecheck 统计各状态", function () {
  const summary = C.summarizeRecheck([
    { status: "unchanged" }, { status: "new" }, { status: "moved" },
    { status: "render_changed" }
  ]);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.new, 1);
  assert.equal(summary.moved, 1);
  assert.equal(summary.render_changed, 1);
  assert.equal(summary.total, 4);
});

/* ---------- visualSpanFor ---------- */

test("visualSpanFor 给出前后视觉序", function () {
  const para = { dir: "rtl", text: "السعر ٣٥٠350 ريال" };
  const rep = C.diagnose([para]);
  const plan = C.buildPlan({ paragraphs: [para] }, rep);
  const s = plan.suggestions.find(function (x) { return x.kind === C.FK.ISOLATE_NUMBER; });
  const span = C.visualSpanFor(para, s);
  assert.ok(span);
  assert.ok(Array.isArray(span.beforeOrder));
  assert.ok(Array.isArray(span.afterOrder));
});
