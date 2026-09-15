/* bidi-lab-geometry.js
 * 双向实验室的“实际渲染序列”测量层（仅浏览器使用）。
 *
 * 纯逻辑层 BidiLabCore.resolveParagraph 给出的是 UAX #9 重排顺序，
 * 不依赖屏幕；这里把每段放进一个与编辑器同字体、同字号、同宽度、
 * 同方向的离屏测量舞台，逐字素簇测量 getBoundingClientRect，
 * 得到浏览器引擎实际渲染时的阅读顺序（先按行自上而下，行内按 x），
 * 以及每个簇的行号与包围盒。宽度、缩放或字体改变后必须重新测量。
 *
 * 字素簇用 display:inline-block + unicode-bidi:isolate 隔离，
 * 保证组合字符 / 代理对 / ZWJ 序列始终在同一个测量单元内，
 * 不会被拆成多个可单独定位或修复的位置。
 */
(function () {
  "use strict";

  var BidiLabGeometry = (function () {
    var stage = null;

    function ensureStage() {
      if (stage) return stage;
      stage = document.createElement("div");
      stage.id = "bidi-lab-measure-stage";
      stage.setAttribute("aria-hidden", "true");
      stage.style.cssText = [
        "position:absolute", "left:-99999px", "top:0",
        "visibility:hidden", "pointer-events:none",
        "white-space:pre-wrap", "word-break:normal",
        "overflow-wrap:break-word"
      ].join(";");
      document.body.appendChild(stage);
      return stage;
    }

    // 测量单个字素簇的矩形（用于定位）。span 必须已在文档中。
    function rectsOf(span) {
      var rects = span.getClientRects();
      var out = [];
      for (var i = 0; i < rects.length; i++) {
        out.push({
          x: rects[i].left, y: rects[i].top,
          w: rects[i].width, h: rects[i].height
        });
      }
      if (!out.length) {
        var r = span.getBoundingClientRect();
        out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
      return out;
    }

    /* measureParagraph(text, dir, opts)
     * opts: { width, fontSize, fontFamily, zoom }（zoom 仅记录，不参与测量，
     *       因为缩放是等比的；字体不可用时由调用方检测并警告）
     * 返回：
     * { clusters:[{gi,text,start,end,line,x,y,w,h,rtl}],
     *   visualOrder:[gi...],     // 实际阅读顺序（逻辑簇下标）
     *   lineCount, width, dir, fontFamily }
     */
    function measureParagraph(text, dir, opts) {
      opts = opts || {};
      var core = window.BidiLabCore;
      var clusters = core.segmentGraphemes(text);
      var el = ensureStage();

      el.style.width = (opts.width || 800) + "px";
      el.style.fontFamily = opts.fontFamily || "inherit";
      el.style.fontSize = (opts.fontSize || 20) + "px";
      el.style.lineHeight = "1.9";
      el.setAttribute("dir", dir === "rtl" || dir === "ltr" ? dir : "auto");
      el.textContent = "";

      var spans = [];
      clusters.forEach(function (g) {
        var s = document.createElement("span");
        s.className = "bidi-lab-gcell";
        // 关键：用普通 inline 容器而不是 inline-block / isolate——
        // 1) 阿拉伯文的草书连字会跨越 inline 元素边界继续成形，宽度测量才真实；
        // 2) 容器不插入任何字符，不影响 UAX #9 的中立符解析；
        // 3) 每个簇独立成一个 span，getClientRects 即可拿到该簇的实际位置，
        //    簇本身（含组合字符/ZWJ 序列）绝不会被拆成多个可定位单元。
        s.textContent = g.text === "" ? "​" : g.text;
        el.appendChild(s);
        spans.push(s);
      });

      // 强制布局后逐簇测量
      var measured = clusters.map(function (g, gi) {
        var rs = rectsOf(spans[gi]);
        // 取首矩形的位置（折行时簇本身一般单行；控制符可能 0 宽）
        var r0 = rs[0];
        return {
          gi: gi, text: g.text, start: g.start, end: g.end,
          cps: g.cps,
          line: 0, x: r0.x, y: r0.y, w: r0.w, h: r0.h,
          allRects: rs,
          rtl: false // 由行方向填充
        };
      });

      // 行分组：按 y（容差 1px）
      var yOrder = measured.slice().sort(function (a, b) { return a.y - b.y; });
      var lines = [];
      var currentY = null, line = [];
      yOrder.forEach(function (m) {
        if (currentY === null || Math.abs(m.y - currentY) > 2) {
          if (line.length) lines.push(line);
          line = [];
          currentY = m.y;
        }
        line.push(m);
      });
      if (line.length) lines.push(line);

      var paraRTL = (dir === "rtl") ||
        (dir !== "ltr" && (function () {
          var res = core.resolveParagraph(text, dir);
          return res.baseLevel === 1;
        })());

      var visualOrder = [];
      lines.forEach(function (ln, lineNo) {
        // 行内按 x 升序就是人眼阅读顺序（无论 RTL/LTR；
        // RTL 行的数字/英文片段也在其真实 x 位置）
        ln.sort(function (a, b) {
          if (Math.abs(a.x - b.x) > 0.5) return a.x - b.x;
          return a.gi - b.gi;
        });
        ln.forEach(function (m) {
          m.line = lineNo;
          m.rtl = paraRTL;
          visualOrder.push(m.gi);
        });
      });

      el.textContent = "";
      return {
        clusters: measured,
        visualOrder: visualOrder,
        lineCount: lines.length,
        width: opts.width || 800,
        dir: dir,
        fontFamily: opts.fontFamily || "",
        paraRTL: paraRTL
      };
    }

    // 检测字体是否实际可用（标准对比法）：
    // 先以 monospace 基线测量探针宽度，再以 “候选字体, monospace” 测量；
    // 若候选字体不存在会完全回退到 monospace，两次宽度一致 → 判定缺失。
    function fontAvailable(fontFamily) {
      if (!fontFamily) return true;
      var el = ensureStage();
      el.style.width = "auto";
      el.style.fontSize = "72px";
      el.setAttribute("dir", "ltr");
      var probes = ["mmmmmmmmmmlli", "iiiiiiiiii!!!"];
      function widths(stack) {
        el.style.fontFamily = stack;
        return probes.map(function (p) {
          el.textContent = p;
          return el.getBoundingClientRect().width;
        });
      }
      var clean = fontFamily.replace(/["';]/g, "");
      var base = widths("monospace");
      var test = widths("'" + clean + "', monospace");
      el.textContent = "";
      var same = base[0] === test[0] && base[1] === test[1];
      return !same;
    }

    return {
      measureParagraph: measureParagraph,
      fontAvailable: fontAvailable
    };
  })();

  window.BidiLabGeometry = BidiLabGeometry;
})();
