"use strict";
/*
 * 纯逻辑单元测试：字素簇、身份 diff、双方合并收敛、冲突区间、坐标变换。
 * 运行：node test/core.test.js
 */

const test = require("node:test");
const assert = require("node:assert");
const core = require("../core");

function atoms(text, prefix) {
  return core.graphemes(text).map((ch, i) => ({ id: (prefix || "p") + i, ch }));
}
function text(a) { return core.atomsText(a); }

test("字素簇：emoji ZWJ 序列与组合字符不被劈开", () => {
  assert.deepEqual(core.graphemes("👨‍👩‍👧"), ["👨‍👩‍👧"]);
  assert.deepEqual(core.graphemes("a👨‍👩‍👧م"), ["a", "👨‍👩‍👧", "م"]);
  const s = "aé";
  // UTF-16 偏移到集群索引：é 在 1..（可能 1 或 2 个 UTF-16 单元），但集群边界固定
  assert.equal(core.codeUnitToCluster(s, 0), 0);
  assert.equal(core.clusterToCodeUnit(s, 2), core.clusterOffsets(s)[2]);
  assert.equal(core.gLen("مرحبا"), 5);
});

test("身份 diff：重复字符不会跨身份配对，applyDirect 往返一致", () => {
  const from = atoms("aab", "f");
  const ops = [{ t: "ins", gap: 0, text: "a" }]; // 得到 aaab
  const to = core.applyDirect(from, ops, "op1");
  assert.equal(text(to), "aaab");
  // from->to 的身份编辑脚本只含一次插入
  const diff = core.diffToOps(from, to);
  const ins = diff.filter(o => o.t === "ins");
  const del = diff.filter(o => o.t === "del");
  assert.equal(ins.length, 1);
  assert.equal(del.length, 0);
  assert.equal(text(core.applyDirect(from, diff, "op2")), "aaab");
});

test("mergeChangeset：随机 2 万组双方编辑，两世界应用变换后收敛", () => {
  function randOps(s) {
    const ops = [];
    for (let i = 0; i < 6; i++) {
      const gs = core.graphemes(s);
      if (Math.random() < 0.5 || gs.length === 0) {
        const gap = Math.floor(Math.random() * (gs.length + 1));
        const ch = String.fromCharCode(97 + Math.floor(Math.random() * 5));
        ops.push({ t: "ins", gap, text: ch });
        gs.splice(gap, 0, ch);
      } else {
        const start = Math.floor(Math.random() * gs.length);
        const len = 1 + Math.floor(Math.random() * Math.min(2, gs.length - start));
        ops.push({ t: "del", start, len });
        gs.splice(start, len);
      }
      s = gs.join("");
    }
    return ops;
  }
  let fails = 0, spanBad = 0;
  for (let t = 0; t < 20000; t++) {
    let s = "";
    const n = Math.floor(Math.random() * 8);
    for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 5));
    const base = atoms(s);
    const oa = randOps(s), ob = randOps(s);
    const m = core.mergeChangeset(base, oa, ob, "a" + t, "b" + t);
    const wA = core.applyDirect(base, oa, "a" + t);
    const wB = core.applyDirect(base, ob, "b" + t);
    const fA = core.applyDirect(wA, m.opsForA, "fixA");
    const fB = core.applyDirect(wB, m.opsForB, "fixB");
    const mt = text(m.doc);
    if (text(fA) !== mt || text(fB) !== mt) fails++;
    for (const cf of m.conflicts) {
      if (text(m.doc).slice(cf.aStart, cf.aEnd) !== cf.aText) spanBad++;
      if (text(m.doc).slice(cf.bStart, cf.bEnd) !== cf.bText) spanBad++;
    }
  }
  assert.equal(fails, 0);
  assert.equal(spanBad, 0);
});

test("同位置双插产生冲突，两段文本都在合并文档且区间正确", () => {
  const base = atoms("ac");
  const m = core.mergeChangeset(base, [{ t: "ins", gap: 1, text: "B" }],
    [{ t: "ins", gap: 1, text: "D" }], "o1", "o2");
  assert.equal(text(m.doc), "aBDc");
  assert.equal(m.conflicts.length, 1);
  const c = m.conflicts[0];
  assert.equal(c.kind, "same_gap_insert");
  const span = text(m.doc).slice(c.aStart, c.aEnd);
  const spanB = text(m.doc).slice(c.bStart, c.bEnd);
  assert.ok(span === "B" || span === "D");
  assert.ok(spanB === "B" || spanB === "D");
  assert.notEqual(span, spanB);
});

test("插入撞删除：双方内容都保留并标记冲突", () => {
  const base = atoms("abcdef");
  const m = core.mergeChangeset(base, [{ t: "ins", gap: 2, text: "X" }],
    [{ t: "del", start: 1, len: 3 }], "g", "d");
  assert.ok(text(m.doc).includes("X"));
  assert.ok(m.conflicts.some(c => c.kind === "insert_in_delete"));
  // 双方应用变换后收敛
  const wA = core.applyDirect(base, [{ t: "ins", gap: 2, text: "X" }], "g");
  const wB = core.applyDirect(base, [{ t: "del", start: 1, len: 3 }], "d");
  assert.equal(text(core.applyDirect(wA, m.opsForA, "fa")), text(m.doc));
  assert.equal(text(core.applyDirect(wB, m.opsForB, "fb")), text(m.doc));
});

test("单方删除按常规 OT 生效，不产生冲突", () => {
  const base = atoms("abcdef");
  const m = core.mergeChangeset(base, [{ t: "ins", gap: 0, text: ">" }],
    [{ t: "del", start: 2, len: 2 }], "o1", "o2");
  assert.equal(m.conflicts.length, 0);
  assert.ok(text(m.doc).includes(">"));
  assert.ok(!text(m.doc).includes("cd"));
});

test("remapSpanById：身份区间在编辑后正确重定位", () => {
  const from = atoms("hello world");
  const to = core.applyDirect(from, [{ t: "ins", gap: 0, text: ">>" }], "x");
  const span = core.remapSpanById(from, to, 6, 11); // "world"
  assert.equal(text(to.slice(span[0], span[1])), "world");
  const gone = core.remapSpanById(from, core.applyDirect(from, [{ t: "del", start: 0, len: 11 }], "y"), 0, 5);
  assert.equal(gone, null);
});

test("校验：越界删除/空 changeset/超限文本被拒", () => {
  assert.equal(core.validateChangeset(3, [{ t: "del", start: 2, len: 5 }]).ok, false);
  assert.equal(core.validateChangeset(3, []).ok, false);
  assert.equal(core.validateChangeset(0, [{ t: "ins", gap: 0, text: "ok" }]).ok, true);
});

test("merge3：单方删除生效，双方内容不重复", () => {
  const base = atoms("abc");
  const a = base.map(x => x);
  const b = [base[0], base[2]]; // 删除 b
  const m = core.merge3(base, a, b, "a", "b");
  assert.equal(text(m.doc), "ac");
});
