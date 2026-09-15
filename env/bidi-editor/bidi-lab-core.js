/* bidi-lab-core.js
 * 双向文本安全诊断与修复实验室的纯逻辑层：不依赖浏览器 DOM，也不依赖 Node API，
 * 浏览器以 <script> 引入（window.BidiLabCore），Node 下可直接 require 单测。
 *
 * 包含：
 *   1) 字素簇切分（Intl.Segmenter 优先，UAX #29 扩展字素簇状态机兜底）
 *   2) Unicode 码点名称查询（精确表 + 区段规则名 + 诚实的兜底名）
 *   3) 双向字符类型判定与 UAX #9 简化重排（逻辑序列 → 渲染序列）
 *   4) 逐段诊断：不可见标记、未配对嵌入/隔离、跨段方向状态、
 *      数字与标点歧义、视觉顺序可疑片段
 *   5) 修复建议、指纹校验与整批应用（任一条件变化即整次拒绝）
 *   6) 诊断样例的回归比对（新增 / 消失 / 位置变化 / 渲染顺序变化）
 *
 * ★ 与阿拉伯文 RTL 显示相关的关键约定 ★
 *   所有 start/end 都是“逻辑码点位置”：字符串在内存中的 Unicode 码点顺序，
 *   半开区间 [start, end)，从 0 开始。计算时完全不读取屏幕布局、不做视觉反算，
 *   阿拉伯文从右向左显示时位置依然以原始逻辑文本为准。
 *   修复的最小单位是“字素簇”，组合字符 / 代理对 / ZWJ 序列绝不拆开。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BidiLabCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ================= 常量与限制 ================= */

  var LIMITS = {
    PARA_WARN_CHARS: 5000,      // 单段超过该长度：给出超长提示并截断诊断范围
    PARA_MAX_CHARS: 50000,      // 与快照一致的硬上限，超过拒绝载入实验室
    TOTAL_MAX_CHARS: 100000,
    MAX_NESTING_DEPTH: 60,      // UAX #9 实际栈深 125；实验室按 60 预警嵌套过深
    SAMPLE_NAME_MAX: 100,
    SAMPLE_MAX_COUNT: 200,
    SAMPLE_PARAS_MAX: 20,
    LABEL_MAX_CHARS: 200,
    NOTE_MAX_CHARS: 1000,
    RECORD_MAX_COUNT: 1000,
    ID_MAX_CHARS: 64
  };

  var DIRS = { auto: true, ltr: true, rtl: true };

  // 问题类型（issue types）
  var IT = {
    ORPHAN_CONTROL: "orphan_control",                 // 孤立 PDI/PDF
    UNCLOSED_EMBEDDING: "unclosed_embedding",         // 段末仍未关闭
    CROSS_PARAGRAPH_STATE: "cross_paragraph_state",   // 跨段方向状态不延续
    LEGACY_EMBEDDING: "legacy_embedding",             // LRE/RLE/PDF 旧式嵌入
    OVERRIDE_CONTROL: "override_control",             // LRO/RLO 强制覆盖
    DEEP_NESTING: "deep_nesting",                     // 控制符嵌套过深
    MIXED_DIGITS: "mixed_digits",                     // 同数字串混阿拉伯/拉丁数字
    DIGIT_PUNCT_AMBIGUITY: "digit_punct_ambiguity",   // 数字与标点方向歧义
    NEUTRAL_BETWEEN_SCRIPTS: "neutral_between_scripts", // 中立符夹在两套文字之间
    BRACKET_MISMATCH: "bracket_mismatch",             // 括号未配对
    DANGLING_JOINER: "dangling_joiner",               // ZWJ/ZWNJ 无相邻可连接字符
    VISUAL_LOGIC_MISMATCH: "visual_logic_mismatch"    // 屏幕顺序易误解的片段
  };

  // 风险等级
  var SEV = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

  // 修复类型（fix kinds）
  var FK = {
    REMOVE_FORMATTING: "remove_formatting", // 删除孤立/覆盖控制符或悬空连接符
    LEGACY_TO_ISOLATE: "legacy_to_isolate", // 旧式嵌入改隔离控制
    SET_DIR: "set_dir",                     // 调整段落方向元数据
    ISOLATE_NUMBER: "isolate_number",       // 数字串包进 FSI...PDI
    REMOVE_BRACKET: "remove_bracket"        // 删除孤立括号
  };

  var TYPE_LABELS_ZH = {
    orphan_control: "孤立方向控制符",
    unclosed_embedding: "嵌入未关闭",
    cross_paragraph_state: "跨段方向状态",
    legacy_embedding: "旧式嵌入控制",
    override_control: "强制覆盖控制",
    deep_nesting: "嵌套过深",
    mixed_digits: "数字体系混用",
    digit_punct_ambiguity: "数字标点方向歧义",
    neutral_between_scripts: "中立符夹在两套文字间",
    bracket_mismatch: "括号未配对",
    dangling_joiner: "悬空连接控制符",
    visual_logic_mismatch: "视觉/逻辑顺序可疑"
  };

  var FIX_LABELS_ZH = {
    remove_formatting: "删除控制符",
    legacy_to_isolate: "改为隔离控制",
    set_dir: "调整段落方向",
    isolate_number: "隔离数字片段",
    remove_bracket: "删除孤立括号"
  };

  /* ================= 基础工具 ================= */

  function nowISO() { return new Date().toISOString(); }

  function cpArray(s) { return s ? Array.from(s) : []; }
  function cpCodes(s) { return s ? Array.from(s).map(function (ch) { return ch.codePointAt(0); }) : []; }
  function cpLen(s) { return s ? Array.from(s).length : 0; }
  function cpSlice(s, start, end) { return Array.from(s).slice(start, end).join(""); }

  function hex4(n) {
    return n.toString(16).toUpperCase().padStart(n > 0xFFFF ? 4 : 4, "0");
  }
  function uHex(ch) { return "U+" + hex4(ch.codePointAt(0)); }

  function isInt(v) {
    return typeof v === "number" && isFinite(v) && Math.floor(v) === v;
  }

  function err(status, code, message) {
    return { ok: false, status: status, code: code, message: message };
  }

  function validISO(v) {
    return typeof v === "string" && v.length <= 64 && !isNaN(Date.parse(v));
  }

  // FNV-1a 32 位：零依赖内容指纹（完整性校验用，非密码学用途）
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ("0000000" + (h >>> 0).toString(16)).slice(-8);
  }

  /* ================= Unicode 码点名称 =================
   * 1) 精确表覆盖双向控制符、零宽字符、常见标点与编辑器用到的阿拉伯字母；
   * 2) 区段规则名覆盖拉丁字母、数字、CJK 表意文字、谚文、变体选择符等；
   * 3) 其余码点给诚实的 “UNNAMED CHARACTER (U+XXXX)”，绝不编造名称。
   */

  var EXACT_NAMES = {
    0x00: "NULL", 0x09: "CHARACTER TABULATION", 0x0A: "LINE FEED",
    0x0B: "LINE TABULATION", 0x0C: "FORM FEED", 0x0D: "CARRIAGE RETURN",
    0x1C: "INFORMATION SEPARATOR FOUR", 0x1D: "INFORMATION SEPARATOR THREE",
    0x1E: "INFORMATION SEPARATOR TWO",
    0x20: "SPACE", 0x21: "EXCLAMATION MARK", 0x22: "QUOTATION MARK",
    0x23: "NUMBER SIGN", 0x24: "DOLLAR SIGN", 0x25: "PERCENT SIGN",
    0x26: "AMPERSAND", 0x27: "APOSTROPHE", 0x28: "LEFT PARENTHESIS",
    0x29: "RIGHT PARENTHESIS", 0x2A: "ASTERISK", 0x2B: "PLUS SIGN",
    0x2C: "COMMA", 0x2D: "HYPHEN-MINUS", 0x2E: "FULL STOP",
    0x2F: "SOLIDUS", 0x3A: "COLON", 0x3B: "SEMICOLON",
    0x3D: "EQUALS SIGN", 0x3F: "QUESTION MARK",
    0x5B: "LEFT SQUARE BRACKET", 0x5D: "RIGHT SQUARE BRACKET",
    0x7B: "LEFT CURLY BRACKET", 0x7D: "RIGHT CURLY BRACKET",
    0x7F: "DELETE",
    0x85: "NEXT LINE",
    0xA0: "NO-BREAK SPACE", 0xA2: "CENT SIGN", 0xA3: "POUND SIGN",
    0xA5: "YEN SIGN", 0xAB: "LEFT-POINTING DOUBLE ANGLE QUOTATION MARK",
    0xAD: "SOFT HYPHEN",
    0xB2: "SUPERSCRIPT TWO", 0xB3: "SUPERSCRIPT THREE", 0xB9: "SUPERSCRIPT ONE",
    0xBB: "RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK",
    0x34F: "COMBINING GRAPHEME JOINER",

    // 阿拉伯文常用字母（编辑器样例全部覆盖）
    0x621: "ARABIC LETTER HAMZA",
    0x622: "ARABIC LETTER ALEF WITH MADDA ABOVE",
    0x623: "ARABIC LETTER ALEF WITH HAMZA ABOVE",
    0x624: "ARABIC LETTER WAW WITH HAMZA ABOVE",
    0x625: "ARABIC LETTER ALEF WITH HAMZA BELOW",
    0x626: "ARABIC LETTER YEH WITH HAMZA ABOVE",
    0x627: "ARABIC LETTER ALEF",
    0x628: "ARABIC LETTER BEH",
    0x629: "ARABIC LETTER TEH MARBUTA",
    0x62A: "ARABIC LETTER TEH",
    0x62B: "ARABIC LETTER THEH",
    0x62C: "ARABIC LETTER JEEM",
    0x62D: "ARABIC LETTER HAH",
    0x62E: "ARABIC LETTER KHAH",
    0x62F: "ARABIC LETTER DAL",
    0x630: "ARABIC LETTER THAL",
    0x631: "ARABIC LETTER REH",
    0x632: "ARABIC LETTER ZAIN",
    0x633: "ARABIC LETTER SEEN",
    0x634: "ARABIC LETTER SHEEN",
    0x635: "ARABIC LETTER SAD",
    0x636: "ARABIC LETTER DAD",
    0x637: "ARABIC LETTER TAH",
    0x638: "ARABIC LETTER ZAH",
    0x639: "ARABIC LETTER AIN",
    0x63A: "ARABIC LETTER GHAIN",
    0x640: "ARABIC TATWEEL",
    0x641: "ARABIC LETTER FEH",
    0x642: "ARABIC LETTER QAF",
    0x643: "ARABIC LETTER KAF",
    0x644: "ARABIC LETTER LAM",
    0x645: "ARABIC LETTER MEEM",
    0x646: "ARABIC LETTER NOON",
    0x647: "ARABIC LETTER HEH",
    0x648: "ARABIC LETTER WAW",
    0x649: "ARABIC LETTER ALEF MAKSURA",
    0x64A: "ARABIC LETTER YEH",
    0x64B: "ARABIC FATHATAN", 0x64C: "ARABIC DAMMATAN",
    0x64D: "ARABIC KASRATAN", 0x64E: "ARABIC FATHA",
    0x64F: "ARABIC DAMMA", 0x650: "ARABIC KASRA",
    0x651: "ARABIC SHADDA", 0x652: "ARABIC SUKUN",
    0x670: "ARABIC LETTER SUPERSCRIPT ALEF",

    0x60C: "ARABIC COMMA", 0x61B: "ARABIC SEMICOLON",
    0x61C: "ARABIC LETTER MARK",
    0x61F: "ARABIC QUESTION MARK",
    0x660: "ARABIC-INDIC DIGIT ZERO", 0x661: "ARABIC-INDIC DIGIT ONE",
    0x662: "ARABIC-INDIC DIGIT TWO", 0x663: "ARABIC-INDIC DIGIT THREE",
    0x664: "ARABIC-INDIC DIGIT FOUR", 0x665: "ARABIC-INDIC DIGIT FIVE",
    0x666: "ARABIC-INDIC DIGIT SIX", 0x667: "ARABIC-INDIC DIGIT SEVEN",
    0x668: "ARABIC-INDIC DIGIT EIGHT", 0x669: "ARABIC-INDIC DIGIT NINE",
    0x66A: "ARABIC PERCENT SIGN", 0x66B: "ARABIC DECIMAL SEPARATOR",
    0x66C: "ARABIC THOUSANDS SEPARATOR",
    0x6F0: "EXTENDED ARABIC-INDIC DIGIT ZERO",
    0x6F1: "EXTENDED ARABIC-INDIC DIGIT ONE",
    0x6F2: "EXTENDED ARABIC-INDIC DIGIT TWO",
    0x6F3: "EXTENDED ARABIC-INDIC DIGIT THREE",
    0x6F4: "EXTENDED ARABIC-INDIC DIGIT FOUR",
    0x6F5: "EXTENDED ARABIC-INDIC DIGIT FIVE",
    0x6F6: "EXTENDED ARABIC-INDIC DIGIT SIX",
    0x6F7: "EXTENDED ARABIC-INDIC DIGIT SEVEN",
    0x6F8: "EXTENDED ARABIC-INDIC DIGIT EIGHT",
    0x6F9: "EXTENDED ARABIC-INDIC DIGIT NINE",

    0x180E: "MONGOLIAN VOWEL SEPARATOR",
    0x2000: "EN QUAD", 0x2001: "EM QUAD", 0x2002: "EN SPACE",
    0x2003: "EM SPACE", 0x2004: "THREE-PER-EM SPACE",
    0x2005: "FOUR-PER-EM SPACE", 0x2006: "SIX-PER-EM SPACE",
    0x2007: "FIGURE SPACE", 0x2008: "PUNCTUATION SPACE",
    0x2009: "THIN SPACE", 0x200A: "HAIR SPACE",
    0x200B: "ZERO WIDTH SPACE",
    0x200C: "ZERO WIDTH NON-JOINER",
    0x200D: "ZERO WIDTH JOINER",
    0x200E: "LEFT-TO-RIGHT MARK",
    0x200F: "RIGHT-TO-LEFT MARK",
    0x2010: "HYPHEN", 0x2011: "NON-BREAKING HYPHEN",
    0x2013: "EN DASH", 0x2014: "EM DASH",
    0x2018: "LEFT SINGLE QUOTATION MARK", 0x2019: "RIGHT SINGLE QUOTATION MARK",
    0x201C: "LEFT DOUBLE QUOTATION MARK", 0x201D: "RIGHT DOUBLE QUOTATION MARK",
    0x2026: "HORIZONTAL ELLIPSIS",
    0x2028: "LINE SEPARATOR", 0x2029: "PARAGRAPH SEPARATOR",
    0x202F: "NARROW NO-BREAK SPACE",
    0x202A: "LEFT-TO-RIGHT EMBEDDING",
    0x202B: "RIGHT-TO-LEFT EMBEDDING",
    0x202C: "POP DIRECTIONAL FORMATTING",
    0x202D: "LEFT-TO-RIGHT OVERRIDE",
    0x202E: "RIGHT-TO-LEFT OVERRIDE",
    0x2030: "PER MILLE SIGN", 0x2032: "PRIME", 0x2033: "DOUBLE PRIME",
    0x2044: "FRACTION SLASH",
    0x2060: "WORD JOINER",
    0x2061: "FUNCTION APPLICATION", 0x2062: "INVISIBLE TIMES",
    0x2063: "INVISIBLE SEPARATOR", 0x2064: "INVISIBLE PLUS",
    0x2066: "LEFT-TO-RIGHT ISOLATE",
    0x2067: "RIGHT-TO-LEFT ISOLATE",
    0x2068: "FIRST STRONG ISOLATE",
    0x2069: "POP DIRECTIONAL ISOLATE",
    0x20AC: "EURO SIGN",
    0xFEFF: "ZERO WIDTH NO-BREAK SPACE",
    0xFFF9: "INTERLINEAR ANNOTATION ANCHOR",
    0xFFFA: "INTERLINEAR ANNOTATION SEPARATOR",
    0xFFFB: "INTERLINEAR ANNOTATION TERMINATOR",

    0x3000: "IDEOGRAPHIC SPACE", 0x3001: "IDEOGRAPHIC COMMA",
    0x3002: "IDEOGRAPHIC FULL STOP",
    0x3008: "LEFT ANGLE BRACKET", 0x3009: "RIGHT ANGLE BRACKET",
    0x300A: "LEFT DOUBLE ANGLE BRACKET", 0x300B: "RIGHT DOUBLE ANGLE BRACKET",
    0x300C: "LEFT CORNER BRACKET", 0x300D: "RIGHT CORNER BRACKET",
    0x300E: "LEFT WHITE CORNER BRACKET", 0x300F: "RIGHT WHITE CORNER BRACKET",
    0x3010: "LEFT BLACK LENTICULAR BRACKET", 0x3011: "RIGHT BLACK LENTICULAR BRACKET",

    0xFE30: "PRESENTATION FORM FOR VERTICAL TWO DOT LEADER",
    0xFE35: "PRESENTATION FORM FOR VERTICAL LEFT PARENTHESIS",
    0xFE36: "PRESENTATION FORM FOR VERTICAL RIGHT PARENTHESIS",
    0xFE44: "PRESENTATION FORM FOR VERTICAL IDEOGRAPHIC COMMA",
    0xFE47: "PRESENTATION FORM FOR VERTICAL LEFT CURLY BRACKET",
    0xFE48: "PRESENTATION FORM FOR VERTICAL RIGHT CURLY BRACKET",

    0xFF0C: "FULLWIDTH COMMA", 0xFF0E: "FULLWIDTH FULL STOP",
    0xFF1A: "FULLWIDTH COLON",
    0xFF5B: "FULLWIDTH LEFT CURLY BRACKET",
    0xFF5D: "FULLWIDTH RIGHT CURLY BRACKET"
  };

  // 06F3? already. 拉丁字母与数字用区段规则名
  function rangeName(c) {
    if (c >= 0x30 && c <= 0x39) return "DIGIT " + (c - 0x30);
    if (c >= 0x41 && c <= 0x5A) return "LATIN CAPITAL LETTER " + String.fromCodePoint(c);
    if (c >= 0x61 && c <= 0x7A) return "LATIN SMALL LETTER " + String.fromCodePoint(c);
    if (c >= 0xFF10 && c <= 0xFF19) return "FULLWIDTH DIGIT " + (c - 0xFF10);
    if (c >= 0xFF21 && c <= 0xFF3A) return "FULLWIDTH LATIN CAPITAL LETTER " + String.fromCodePoint(c - 0xFEE0);
    if (c >= 0xFF41 && c <= 0xFF5A) return "FULLWIDTH LATIN SMALL LETTER " + String.fromCodePoint(c - 0xFEE0);
    if (c >= 0xFE00 && c <= 0xFE0F) return "VARIATION SELECTOR-" + (c - 0xFE00 + 1);
    if (c >= 0xE0100 && c <= 0xE01EF) return "VARIATION SELECTOR-" + (c - 0xE0100 + 17);
    if (c >= 0x4E00 && c <= 0x9FFF) return "CJK UNIFIED IDEOGRAPH-" + hex4(c);
    if (c >= 0x3400 && c <= 0x4DBF) return "CJK UNIFIED IDEOGRAPH-" + hex4(c);
    if (c >= 0xF900 && c <= 0xFAFF) return "CJK COMPATIBILITY IDEOGRAPH-" + hex4(c);
    if (c >= 0xAC00 && c <= 0xD7A3) return "HANGUL SYLLABLE " + hex4(c);
    if (c >= 0xE0001 && c <= 0xE0001) return "LANGUAGE TAG";
    if (c >= 0xE0020 && c <= 0xE007E) return "TAG " + String.fromCharCode(c - 0xE0000);
    if (c === 0xE007F) return "CANCEL TAG";
    return null;
  }

  function cpName(cp) {
    if (Object.prototype.hasOwnProperty.call(EXACT_NAMES, cp)) return EXACT_NAMES[cp];
    var rn = rangeName(cp);
    if (rn) return rn;
    // 诚实兜底：不编造具体名称
    if (cp >= 0xD800 && cp <= 0xDFFF) return "SURROGATE CODE POINT";
    return "UNNAMED CHARACTER " + hex4(cp);
  }

  /* ================= 通用类别（简化，用于名称兜底与标记识别） ================= */

  function generalCategory(c) {
    if ((c >= 0x300 && c <= 0x36F) || (c >= 0x483 && c <= 0x489) ||
        (c >= 0x591 && c <= 0x5BD) || c === 0x5BF ||
        (c >= 0x5C1 && c <= 0x5C2) || (c >= 0x5C4 && c <= 0x5C5) ||
        c === 0x5C7 ||
        (c >= 0x610 && c <= 0x61A) || (c >= 0x64B && c <= 0x65F) ||
        c === 0x670 || (c >= 0x6D6 && c <= 0x6DC) ||
        (c >= 0x6DF && c <= 0x6E4) || (c >= 0x6E7 && c <= 0x6ED) ||
        (c >= 0x700 && c <= 0x70D) || (c >= 0x730 && c <= 0x74A) ||
        (c >= 0x7A6 && c <= 0x7B0) || (c >= 0x7EB && c <= 0x7F3) ||
        (c >= 0x816 && c <= 0x819) || (c >= 0x81B && c <= 0x823) ||
        (c >= 0x825 && c <= 0x827) || (c >= 0x829 && c <= 0x82D) ||
        (c >= 0x859 && c <= 0x85B) ||
        (c >= 0x8D4 && c <= 0x8E1) || (c >= 0x8E3 && c <= 0x902) ||
        c === 0x93A || c === 0x93C ||
        (c >= 0x941 && c <= 0x948) || c === 0x94D ||
        (c >= 0x951 && c <= 0x957) ||
        (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF) ||
        (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE20 && c <= 0xFE2F)) {
      return "Mn";
    }
    if (c === 0x903 || c === 0x93E || c === 0x940 || c === 0x949 ||
        c === 0x94A || c === 0x94C || (c >= 0x1B00 && c <= 0x1B04)) {
      return "Mc";
    }
    return null; // 未知：不臆测
  }

  /* ================= 双向字符类型（UAX #9，简化） ================= */
  // 返回 L R AL EN ES ET CS B S BN NSM
  // 显式控制符另外由 isFormatting 判定，不在此分类。

  function inRanges(c, list) {
    for (var i = 0; i < list.length; i++) {
      if (c >= list[i][0] && c <= list[i][1]) return true;
    }
    return false;
  }

  var AL_RANGES = [
    [0x608, 0x608], [0x61B, 0x61B], [0x61C, 0x61C],
    [0x61D, 0x64A], [0x66D, 0x66F], [0x670, 0x6D3],
    [0x6D5, 0x6D5], [0x6E5, 0x6E6], [0x6EE, 0x6EF],
    [0x6FA, 0x6FC], [0x6FF, 0x6FF],
    [0x750, 0x77F], [0x8A0, 0x8BD], [0x8D3, 0x8FF],
    [0xFB50, 0xFBB1], [0xFBD3, 0xFD3D], [0xFD50, 0xFD8F],
    [0xFD92, 0xFDC7], [0xFDF0, 0xFDFF], [0xFE70, 0xFEFE],
    [0x1EE00, 0x1EE03]
  ];
  // 0640 tatweel 在 AL 段中（0x61D-0x64A 覆盖）
  var R_RANGES = [
    [0x5BB, 0x5BD], [0x5BF, 0x5BF], [0x5C1, 0x5C2],
    [0x5C4, 0x5C5], [0x5D0, 0x5EA], [0x5F0, 0x5F4],
    [0x7C0, 0x7EA], [0x7F4, 0x7F5], [0x7FA, 0x7FA],
    [0x800, 0x815], [0x81A, 0x81A], [0x824, 0x824],
    [0x828, 0x828], [0x830, 0x83E], [0x840, 0x858],
    [0x85C, 0x85F], [0xFB1D, 0xFB4F], [0x10800, 0x10805],
    [0x10808, 0x10808], [0x1080A, 0x10835], [0x10837, 0x10838],
    [0x1083C, 0x1083C], [0x10900, 0x1091B], [0x10920, 0x10939],
    [0x1093F, 0x1093F]
  ];
  var L_RANGES = [
    [0x41, 0x5A], [0x61, 0x7A],
    [0xAA, 0xAA], [0xB5, 0xB5], [0xBA, 0xBA],
    [0xC0, 0xD6], [0xD8, 0xF6], [0xF8, 0x2B8],
    [0x2BB, 0x2C4], [0x2E5, 0x2EB], [0x1D00, 0x1D25],
    [0x1D2C, 0x1D5C], [0x1D62, 0x1D65], [0x1D6B, 0x1D77],
    [0x1D79, 0x1DBE], [0x1E00, 0x1EFF], [0x2071, 0x2071],
    [0x207F, 0x207F], [0x2090, 0x209C], [0x212A, 0x212B],
    [0x2190, 0x2194], [0x24B6, 0x24E9], [0x2C60, 0x2C7F],
    [0xA720, 0xA7FF], [0xFB00, 0xFB06], [0xFF21, 0xFF3A],
    [0xFF41, 0xFF5A],
    // CJK / 谚文等大块
    [0x1100, 0x115F], [0x11A3, 0x11A7], [0x11FA, 0x11FF],
    [0x2329, 0x232A], [0x2E80, 0x2EFF], [0x2F00, 0x2FDF],
    [0x3004, 0x3007], [0x3012, 0x301C], [0x3021, 0x3029],
    [0x3031, 0x3035], [0x3038, 0x303B], [0x3041, 0x3096],
    [0x309D, 0x309F], [0x30A1, 0x30FA], [0x30FC, 0x30FF],
    [0x3105, 0x312F], [0x3131, 0x318E], [0x31B0, 0x31BB],
    [0x31F0, 0x321E], [0x3220, 0x3247], [0x3250, 0x32FE],
    [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF],
    [0xA960, 0xA97C], [0xAC00, 0xD7A3], [0xF900, 0xFAFF],
    [0xFE30, 0xFE52], [0xFE54, 0xFE66], [0xFE68, 0xFE6B],
    [0xFF66, 0xFF9D], [0xFFA0, 0xFFBE]
  ];
  var EN_RANGES = [
    [0x30, 0x39], [0xB9, 0xB9], [0xB2, 0xB3],
    [0x2070, 0x2070], [0x2074, 0x2079], [0x2080, 0x2089],
    [0xFF10, 0xFF19]
  ];
  var AN_RANGES = [
    [0x660, 0x669], [0x6F0, 0x6F9], [0x104A0, 0x104A9]
  ];
  var ET_EXACT = {
    0x23: 1, 0x24: 1, 0x25: 1, 0x26: 1, 0x2A: 1,
    0xA2: 1, 0xA3: 1, 0xA4: 1, 0xA5: 1,
    0x58F: 1, 0x60B: 1, 0x7FE: 1, 0x9F2: 1, 0x9F3: 1,
    0xAF1: 1, 0xBF9: 1, 0x9FC: 1, 0x9FD: 1,
    0xFE69: 1, 0xFF04: 1, 0xFFE0: 1, 0xFFE1: 1,
    0xFFE5: 1, 0xFFE6: 1
  };
  var CS_EXACT = {
    0x2C: 1, 0x2E: 1, 0x3A: 1, 0xA0: 1, 0x60C: 1,
    0x61B: 1, 0x66A: 1, 0x66B: 1, 0x66C: 1,
    0x2044: 1, 0xFE50: 1, 0xFE52: 1, 0xFE55: 1,
    0xFF0C: 1, 0xFF0E: 1, 0xFF1A: 1, 0x387: 1
  };
  var BN_EXACT = {
    0xAD: 1, 0x180B: 1, 0x180C: 1, 0x180D: 1,
    0x200B: 1, 0x200C: 1, 0x200D: 1, 0x2060: 1,
    0x2061: 1, 0x2062: 1, 0x2063: 1, 0x2064: 1,
    0xFEFF: 1, 0xFFF9: 1, 0xFFFA: 1, 0xFFFB: 1,
    0x115F: 1, 0x1160: 1, 0x1D173: 1, 0x1D174: 1,
    0x1D175: 1, 0x1D176: 1, 0x1D177: 1, 0x1D178: 1,
    0x1D179: 1, 0x1D17A: 1
  };

  function isB(c) {
    return c === 0xA || c === 0xD || (c >= 0x1C && c <= 0x1E) ||
           c === 0x85 || c === 0x2029;
  }
  function isS(c) {
    return c === 0x9 || c === 0xB || c === 0xC || c === 0x20 ||
           (c >= 0x2000 && c <= 0x200A) || c === 0x2028 ||
           c === 0x202F || c === 0x205F || c === 0x3000;
  }

  function bidiType(c) {
    if (isB(c)) return "B";
    if (isS(c)) return "S";
    var gc = generalCategory(c);
    if (gc === "Mn" || gc === "Mc") return "NSM";
    if (BN_EXACT[c]) return "BN";
    if (CS_EXACT[c]) return "CS";
    if (ET_EXACT[c]) return "ET";
    if (inRanges(c, AN_RANGES)) return "AN";
    if (inRanges(c, EN_RANGES)) return "EN";
    if (inRanges(c, AL_RANGES)) return "AL";
    if (inRanges(c, R_RANGES)) return "R";
    if (inRanges(c, L_RANGES)) return "L";
    if (c === 0x2D || c === 0x2B || c === 0xB1) return "ES";
    // 未识别码点：按中立处理（UAX 对未分配/私有区默认 BN/ON；此处取 ON，
    // 保守且不会错误地赋予强方向）
    return "ON";
  }

  // 显式方向控制符
  var FORMATTING = {
    0x202A: { embedding: "L", kind: "embed", legacy: true },
    0x202B: { embedding: "R", kind: "embed", legacy: true },
    0x202D: { embedding: "L", kind: "override", legacy: true },
    0x202E: { embedding: "R", kind: "override", legacy: true },
    0x202C: { kind: "pop" },
    0x2066: { embedding: "L", kind: "isolate" },
    0x2067: { embedding: "R", kind: "isolate" },
    0x2068: { embedding: "auto", kind: "isolate" },
    0x2069: { kind: "pdi" },
    0x200E: { kind: "mark", embedding: "L" },
    0x200F: { kind: "mark", embedding: "R" },
    0x61C: { kind: "mark", embedding: "R" }
  };
  function formattingOf(c) {
    return Object.prototype.hasOwnProperty.call(FORMATTING, c) ? FORMATTING[c] : null;
  }

  /* ================= 字素簇切分 ================= */

  function hangulClass(c) {
    if (c === 0x1100) return "L";
    if (c > 0x1100 && c <= 0x115F) return "L";
    if (0xA960 <= c && c <= 0xA97C) return "L";
    if (0x1160 <= c && c <= 0x11A7) return "V";
    if (0xD7B0 <= c && c <= 0xD7C6) return "V";
    if (0x11A8 <= c && c <= 0x11FF) return "T";
    if (0xD7CB <= c && c <= 0xD7FB) return "T";
    if (c === 0xAC00) return "LV";
    if (c > 0xAC00 && c <= 0xD7A3) {
      var n = c - 0xAC00;
      if (n % 28 === 0) return "LV";
      return "LVT"; // GB8: LVT × T
    }
    return null;
  }

  var rePictographic = null;
  var reExtend = null;
  var reRI = null;
  try {
    rePictographic = /\p{Extended_Pictographic}/u;
    reExtend = /\p{Grapheme_Extend}/u;
    reRI = /\p{Regional_Indicator}/u;
  } catch (e) { /* 极老引擎 */ }

  function isPictographic(c) {
    return rePictographic ? rePictographic.test(String.fromCodePoint(c))
      : (c >= 0x1F300 && c <= 0x1FAFF);
  }
  function isExtend(c) {
    // 由状态机调用：RI 的成对逻辑单独处理，这里 RI 不算 Extend
    if (isRI(c)) return false;
    if (reExtend && reExtend.test(String.fromCodePoint(c))) return true;
    var gc = generalCategory(c);
    return gc === "Mn" || gc === "Mc" || c === 0x200D || c === 0x200C;
  }
  function isRI(c) {
    return reRI ? reRI.test(String.fromCodePoint(c))
      : (c >= 0x1F1E6 && c <= 0x1F1FF);
  }
  function isControlCp(c) {
    var t = bidiType(c);
    return t === "B" || t === "S" || c === 0x7F || (c >= 0x80 && c <= 0x9F);
  }
  function isVS(c) { return c >= 0xFE00 && c <= 0xFE0F || c >= 0xE0100 && c <= 0xE01EF; }

  // UAX #29 扩展字素簇状态机（Intl.Segmenter 不可用时的兜底）
  function fallbackGraphemes(cps) {
    var clusters = [];
    var i = 0;
    while (i < cps.length) {
      // GB1/GB2: CR/LF/CRLF
      if (cps[i] === 0xD && cps[i + 1] === 0xA) {
        clusters.push([cps[i], cps[i + 1]]); i += 2; continue;
      }
      if (cps[i] === 0xD || cps[i] === 0xA) {
        clusters.push([cps[i]]); i++; continue;
      }
      var start = i;
      var hc = hangulClass(cps[i]);
      var picto = isPictographic(cps[i]);
      var ri = isRI(cps[i]);
      i++;

      if (hc === "L") {
        while (i < cps.length) {
          var h2 = hangulClass(cps[i]);
          if (h2 === "L" || h2 === "V" || h2 === "LV") i++;
          else break;
        }
      } else if (hc === "LV" || hc === "V") {
        while (i < cps.length) {
          var h3 = hangulClass(cps[i]);
          if (h3 === "V" || h3 === "T" || h3 === "LVT") i++;
          else break;
        }
      } else if (hc === "LVT" || hc === "T") {
        while (i < cps.length && hangulClass(cps[i]) === "T") i++;
      } else if (ri) {
        // GB12/GB13: RI 成对
        if (i < cps.length && isRI(cps[i])) i++;
      } else if (isControlCp(cps[start])) {
        // 控制符独占一簇
      } else if (picto) {
        // GB11: Extend* (ZWJ ExtendPictographic)*
        while (i < cps.length && isExtend(cps[i]) && !isRI(cps[i])) i++;
        while (i < cps.length) {
          if (cps[i] === 0x200D) {
            i++;
            if (i < cps.length && (isPictographic(cps[i]) ||
                (isExtend(cps[i]) && !isRI(cps[i])))) {
              i++;
              while (i < cps.length && isExtend(cps[i]) && !isRI(cps[i])) i++;
              continue;
            }
            break;
          }
          if (isVS(cps[i])) { i++; continue; }
          break;
        }
      } else {
        // GB9: Extend* / ZWJ*（普通基字 + 组合序列）
        while (i < cps.length && isExtend(cps[i]) && !isRI(cps[i]) &&
               !isControlCp(cps[i])) i++;
      }
      clusters.push(cps.slice(start, i));
    }
    return clusters;
  }

  // 输出：[{text, start, end, cps:[{cp,hex,name,type}]}]
  // start/end 为逻辑码点偏移（半开）
  function segmentGraphemes(text) {
    if (!text) return [];
    var cps = cpCodes(text);
    var lists;
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      try {
        var segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        lists = [];
        // Segmenter 边界必然落在字素簇（亦即码点簇）边界上；
        // 按返回顺序、以每段码点数直接从 cps 切分，不做 UTF-16 偏移反查。
        var consumed = 0;
        for (var seg of segmenter.segment(text)) {
          var n = cpLen(seg.segment);
          lists.push(cps.slice(consumed, consumed + n));
          consumed += n;
        }
        if (consumed !== cps.length) throw new Error("segmenter coverage mismatch");
      } catch (e) {
        lists = fallbackGraphemes(cps);
      }
    } else {
      lists = fallbackGraphemes(cps);
    }

    var out = [];
    var pos = 0;
    lists.forEach(function (list) {
      var gCps = list.map(function (c) {
        return { cp: c, hex: hex4(c), name: cpName(c), type: bidiType(c) };
      });
      var gText = list.map(function (c) { return String.fromCodePoint(c); }).join("");
      out.push({ text: gText, start: pos, end: pos + list.length, cps: gCps });
      pos += list.length;
    });
    return out;
  }

  /* ================= UAX #9 简化重排 ================= */

  function nextLevel(level, dir) {
    var want = dir === "L" ? 0 : 1;
    var n = level + 1;
    if (n % 2 !== want) n++;
    return n;
  }

  // 找隔离序列的首个强方向（跳过嵌套隔离）
  function firstStrongInIsolate(units, fromIdx) {
    var depth = 0;
    for (var i = fromIdx; i < units.length; i++) {
      var f = units[i].fmt;
      if (f && (f.kind === "isolate")) depth++;
      else if (f && f.kind === "pdi") {
        if (depth === 0) return null;
        depth--;
      } else if (depth === 0) {
        var t = units[i].type;
        if (t === "L") return "L";
        if (t === "R" || t === "AL") return "R";
      }
    }
    return null;
  }

  function baseLevelFor(dir) {
    if (dir === "ltr") return 0;
    if (dir === "rtl") return 1;
    return null; // auto
  }

  // 括号对
  var BRACKET_PAIRS = [
    [0x28, 0x29], [0x5B, 0x5D], [0x7B, 0x7D],
    [0xF3A, 0xF3B], [0xF3C, 0xF3D], [0xF3E, 0xF3F],
    [0x169B, 0x169C], [0x2045, 0x2046],
    [0x207D, 0x207E], [0x208D, 0x208E],
    [0x2208, 0x220B], [0x2209, 0x220C],
    [0x2215, 0x229F], [0x2220, 0x2221], [0x2222, 0x2223],
    [0x2224, 0x2225], [0x2226, 0x2227], [0x2228, 0x2229],
    [0x222A, 0x222B], [0x222C, 0x222D], [0x2234, 0x2235],
    [0x2236, 0x2237], [0x223C, 0x223D], [0x2243, 0x2244],
    [0x2245, 0x2246], [0x2247, 0x2248], [0x2249, 0x224A],
    [0x224B, 0x224C], [0x224D, 0x224E], [0x2252, 0x2253],
    [0x2254, 0x2255], [0x2256, 0x2257], [0x2258, 0x2259],
    [0x225A, 0x225B], [0x225C, 0x225D], [0x225E, 0x225F],
    [0x2260, 0x2261], [0x2262, 0x2263], [0x2264, 0x2265],
    [0x2266, 0x2267], [0x2268, 0x2269], [0x226A, 0x226B],
    [0x226C, 0x226D], [0x226E, 0x226F], [0x2270, 0x2271],
    [0x2272, 0x2273], [0x2274, 0x2275], [0x2276, 0x2277],
    [0x2278, 0x2279], [0x227A, 0x227B], [0x227C, 0x227D],
    [0x227E, 0x227F], [0x2280, 0x2281], [0x2282, 0x2283],
    [0x2284, 0x2285], [0x2286, 0x2287], [0x2288, 0x2289],
    [0x228A, 0x228B], [0x228F, 0x2290], [0x2291, 0x2292],
    [0x2298, 0x229B], [0x22A2, 0x22A3], [0x22A6, 0x22AE],
    [0x22B0, 0x22B1], [0x22B2, 0x22B3], [0x22B4, 0x22B5],
    [0x22B6, 0x22B7], [0x22C0, 0x22C1], [0x22C6, 0x22C7],
    [0x22C8, 0x22C9], [0x22CA, 0x22CB], [0x22CC, 0x22CD],
    [0x22D0, 0x22D1], [0x22D6, 0x22D7], [0x22D8, 0x22D9],
    [0x22DA, 0x22DB], [0x22DC, 0x22DD], [0x22DE, 0x22DF],
    [0x22E0, 0x22E1], [0x22E2, 0x22E3], [0x22E4, 0x22E5],
    [0x22E6, 0x22E7], [0x22E8, 0x22E9], [0x22EA, 0x22EB],
    [0x22EC, 0x22ED], [0x2308, 0x2309], [0x230A, 0x230B],
    [0x2983, 0x2984], [0x2985, 0x2986], [0x2987, 0x2988],
    [0x2989, 0x298A], [0x298B, 0x298C], [0x298D, 0x298E],
    [0x298F, 0x2990], [0x2991, 0x2992], [0x2993, 0x2994],
    [0x2995, 0x2996], [0x2997, 0x2998], [0x29C9, 0x29CA],
    [0x29CB, 0x29CC], [0x29CD, 0x29CE], [0x29CF, 0x29D0],
    [0x29D1, 0x29D2], [0x2A2B, 0x2A2C], [0x2A2D, 0x2A2E],
    [0x2A34, 0x2A35], [0x2A3C, 0x2A3D], [0x2A64, 0x2A65],
    [0x2A79, 0x2A7A], [0x2A7D, 0x2A7E], [0x2A7F, 0x2A80],
    [0x2A81, 0x2A82], [0x2A83, 0x2A84], [0x2A8B, 0x2A8C],
    [0x2A91, 0x2A92], [0x2A93, 0x2A94], [0x2A95, 0x2A96],
    [0x2A97, 0x2A98], [0x2A99, 0x2A9A], [0x2A9B, 0x2A9C],
    [0x2AA1, 0x2AA2], [0x2AA6, 0x2AA7], [0x2AA8, 0x2AA9],
    [0x2AAA, 0x2AAB], [0x2AAC, 0x2AAD], [0x2AAF, 0x2AB0],
    [0x2AB1, 0x2AB2], [0x2AB3, 0x2AB4], [0x2E02, 0x2E03],
    [0x2E04, 0x2E05], [0x2E09, 0x2E0A], [0x2E0C, 0x2E0D],
    [0x2E1C, 0x2E1D], [0x3008, 0x3009], [0x300A, 0x300B],
    [0x300C, 0x300D], [0x300E, 0x300F], [0x3010, 0x3011],
    [0xFE59, 0xFE5A], [0xFE5B, 0xFE5C], [0xFE5D, 0xFE5E],
    [0xFF08, 0xFF09], [0xFF3B, 0xFF3D], [0xFF5B, 0xFF5D]
  ];
  var OPEN_TO_CLOSE = {}, CLOSE_TO_OPEN = {};
  BRACKET_PAIRS.forEach(function (p) {
    OPEN_TO_CLOSE[p[0]] = p[1];
    CLOSE_TO_OPEN[p[1]] = p[0];
  });

  // 不可见（无字形或仅作用于相邻字符）码点集合
  var INVISIBLE = (function () {
    var set = {};
    [
      0x00, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x7F, 0x85,
      0xAD, 0x34F, 0x180B, 0x180C, 0x180D, 0x180E,
      0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
      0x2028, 0x2029, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
      0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
      0x2066, 0x2067, 0x2068, 0x2069,
      0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F,
      0xFE00, 0xFE01, 0xFE02, 0xFE03, 0xFE04, 0xFE05, 0xFE06, 0xFE07,
      0xFE08, 0xFE09, 0xFE0A, 0xFE0B, 0xFE0C, 0xFE0D, 0xFE0E, 0xFE0F,
      0xFEFF, 0xFFF9, 0xFFFA, 0xFFFB, 0x61C,
      0x115F // 前有字形宽度但不独立成簇显示
    ].forEach(function (c) { set[c] = true; });
    for (var v = 0xE0100; v <= 0xE01EF; v++) set[v] = true;
    return set;
  })();
  function isInvisibleCluster(g) {
    // 字素簇全部由无字形码点组成时才视为不可见（组合在可见基字上的不算）
    return g.cps.every(function (c) { return INVISIBLE[c.cp]; });
  }

  // 解析一段：返回每个参与重排的单元（显式控制也保留，标记 invisible）
  function resolveParagraph(text, declaredDir) {
    var gClusters = segmentGraphemes(text);
    var units = [];
    gClusters.forEach(function (g, gi) {
      // 字素簇的方向属性取“非 NSM 的首个码点”；控制符簇单独标记
      var fmt = formattingOf(g.cps[0].cp);
      var leadType = null;
      for (var i = 0; i < g.cps.length; i++) {
        if (g.cps[i].type !== "NSM") { leadType = g.cps[i].type; break; }
      }
      if (leadType === null) leadType = "NSM";
      units.push({
        gi: gi, type: leadType, fmt: fmt || null,
        invisible: isInvisibleCluster(g)
      });
    });

    // 段落基准级别（P2/P3）
    var baseLevel = baseLevelFor(declaredDir);
    if (baseLevel === null) {
      baseLevel = 0;
      for (var i = 0; i < units.length; i++) {
        var f = units[i].fmt;
        if (f && f.kind === "isolate") {
          var d2 = firstStrongInIsolate(units, i + 1);
          if (d2) { baseLevel = d2 === "R" ? 1 : 0; break; }
          continue; // 空隔离跳过
        }
        if (f && f.kind === "pdi") continue;
        var t = units[i].type;
        if (t === "L") { baseLevel = 0; break; }
        if (t === "R" || t === "AL") { baseLevel = 1; break; }
      }
    }

    var stack = [{ level: baseLevel, override: "N", iso: false }];
    var maxDepth = 1;
    var overflow = 0; // 超过栈深上限的控制符计数（UAX BD9 行为）
    var events = []; // 给诊断用：{gi, action, depth}

    function top() { return stack[stack.length - 1]; }

    for (var u = 0; u < units.length; u++) {
      var un = units[u];
      var fm = un.fmt;

      // X1..X6 显式控制
      if (fm) {
        if (fm.kind === "embed" || fm.kind === "override" || fm.kind === "isolate") {
          var dir = fm.embedding;
          if (dir === "auto") dir = firstStrongInIsolate(units, u + 1) || "L";
          if (stack.length - overflow >= 125) {
            overflow++;
            events.push({ gi: u, action: "overflow" });
          } else {
            var lvl = nextLevel(top().level, dir);
            stack.push({
              kind: fm.kind,
              openGi: u,
              level: lvl,
              override: fm.kind === "override" ? dir : "N",
              iso: fm.kind === "isolate"
            });
            maxDepth = Math.max(maxDepth, stack.length - overflow);
            events.push({ gi: u, action: "push", kind: fm.kind, level: lvl, depth: stack.length });
          }
          un.resolvedLevel = top().level;
          continue;
        }
        if (fm.kind === "pop") {
          // PDF：匹配最近的嵌入/覆盖帧（忽略中间的隔离帧——PDF 不匹配隔离）
          var matchFrame = -1;
          for (var pi = stack.length - 1; pi >= 1; pi--) {
            if (!stack[pi].iso) { matchFrame = pi; break; }
          }
          if (matchFrame === -1) {
            events.push({ gi: u, action: "stray_pop" });
          } else if (matchFrame === stack.length - 1) {
            var popOpenGi = stack[matchFrame].openGi;
            stack.pop();
            events.push({ gi: u, action: "pop", openGi: popOpenGi, depth: stack.length + 1 });
          } else {
            // PDF 位于隔离帧之上：按 UAX X6b 忽略（隔离只能由 PDI 结束）
            events.push({ gi: u, action: "ignored_pdf" });
          }
          un.resolvedLevel = top().level;
          continue;
        }
        if (fm.kind === "pdi") {
          // PDI：匹配最近的隔离开启符（忽略中间嵌入/覆盖帧，它们随之结束）
          var found = -1;
          for (var si = stack.length - 1; si >= 1; si--) {
            if (stack[si].iso) { found = si; break; }
          }
          if (found === -1) {
            events.push({ gi: u, action: "stray_pdi" });
            un.resolvedLevel = top().level;
          } else {
            // PDI 按 X6a 同时结束隔离帧内部的嵌入/覆盖帧（它们由 PDI 隐式关闭，
            // 不算未闭合，也不再需要各自的 PDF）。
            for (var fi2 = found + 1; fi2 < stack.length; fi2++) {
              if (!stack[fi2].iso) {
                events.push({ gi: u, action: "close_implicit", openGi: stack[fi2].openGi });
              }
            }
            var isoOpenGi = stack[found].openGi;
            stack.length = found; // 弹掉隔离帧及其内部的嵌入/覆盖帧
            un.resolvedLevel = top().level;
            events.push({ gi: u, action: "pop_iso", openGi: isoOpenGi, depth: found + 1 });
          }
          continue;
        }
        if (fm.kind === "mark") {
          un.resolvedLevel = top().level;
          continue;
        }
      }

      // 普通字素簇
      var t3 = top();
      if (un.type === "NSM") {
        // W1: 取上一字符类型（简化：取当前 override / 栈上下文）
        if (t3.override !== "N") un.type = t3.override;
        else un.type = "ON";
      } else if (t3.override !== "N") {
        un.type = t3.override;
      }
      un.resolvedLevel = t3.level;
    }

    // W2: EN→AN（前一个强字符为 AL）；W3 AL→R；W4/W5；W6；W7
    var lastStrong = null;
    for (var u2 = 0; u2 < units.length; u2++) {
      var x = units[u2];
      if (x.type === "AL") { x.type = "R"; lastStrong = "AL"; continue; }
      if (x.type === "EN" && lastStrong === "AL") x.type = "AN";
      if (x.type === "L" || x.type === "R") lastStrong = x.type;
      if (x.type === "AN") lastStrong = "AL";
      if (x.type === "EN") lastStrong = "EN";
    }

    // W4: ES/CS 并入相邻数字
    for (var u3 = 1; u3 < units.length - 1; u3++) {
      var m = units[u3];
      if (m.type === "ES" && units[u3 - 1].type === "EN" &&
          units[u3 + 1].type === "EN") {
        m.type = "EN";
      } else if (m.type === "CS" &&
                 (units[u3 - 1].type === "EN" || units[u3 - 1].type === "AN") &&
                 (units[u3 + 1].type === "EN" || units[u3 + 1].type === "AN") &&
                 units[u3 - 1].type === units[u3 + 1].type) {
        m.type = units[u3 - 1].type;
      }
    }
    // W5: ET 序列任一侧紧邻 EN 则整段并入 EN
    for (var u4 = 0; u4 < units.length; u4++) {
      if (units[u4].type !== "ET") continue;
      var runS = u4;
      while (units[u4] && units[u4].type === "ET") u4++;
      var runE = u4 - 1;
      var pAdj = units[runS - 1] && units[runS - 1].type === "EN";
      var nAdj = units[runE + 1] && units[runE + 1].type === "EN";
      if (pAdj || nAdj) {
        for (var j4 = runS; j4 <= runE; j4++) units[j4].type = "EN";
      }
    }

    // W6/W7: 解析中立符序列（B/S 边界断开；忽略显式控制）
    var NEUTRALS = { ON: 1, ET: 1, ES: 1, CS: 1 };
    var i5 = 0;
    while (i5 < units.length) {
      if (!NEUTRALS[units[i5].type]) { i5++; continue; }
      var runStart = i5;
      while (i5 < units.length && NEUTRALS[units[i5].type]) i5++;
      var runEnd = i5; // 半开
      var prevU = units[runStart - 1];
      var nextU = units[runEnd];
      var prevT = prevU && (prevU.type === "L" || prevU.type === "R" ||
                            prevU.type === "AN" || prevU.type === "EN")
        ? prevU.type : null;
      var nextT = nextU && (nextU.type === "L" || nextU.type === "R" ||
                            nextU.type === "AN" || nextU.type === "EN")
        ? nextU.type : null;
      var leadR = prevT === "L" ? "L" : (prevT === "R" || prevT === "AN" || prevT === "EN") ? "R" : null;
      var trailR = nextT === "L" ? "L" : (nextT === "R" || nextT === "AN" || nextT === "EN") ? "R" : null;
      // N1/N2: 两同强取同；EN 与 R 视为同侧；否则取基准方向
      var resolved;
      if (leadR && leadR === trailR) resolved = leadR;
      else resolved = (units[runStart].resolvedLevel % 2 === 0) ? "L" : "R";
      for (var j5 = runStart; j5 < runEnd; j5++) {
        units[j5].neutralResolved = resolved;
      }
    }

    // N1/N2 + I2：分配最终嵌入级别
    for (var u6 = 0; u6 < units.length; u6++) {
      var uu = units[u6];
      var lvl2 = uu.resolvedLevel == null ? baseLevel : uu.resolvedLevel;
      var ftype = uu.type;
      var isEven = lvl2 % 2 === 0;
      if (uu.neutralResolved) {
        // 解析为与当前级别相反的方向时升一级
        var nR = uu.neutralResolved === "R";
        uu.finalLevel = (nR === isEven) ? lvl2 + 1 : lvl2;
      } else if (ftype === "R") {
        uu.finalLevel = isEven ? lvl2 + 1 : lvl2;
      } else if (ftype === "L") {
        uu.finalLevel = isEven ? lvl2 : lvl2 + 2;
      } else if (ftype === "AN") {
        uu.finalLevel = isEven ? lvl2 + 2 : lvl2 + 1;
      } else if (ftype === "EN") {
        uu.finalLevel = isEven ? lvl2 + 2 : lvl2 + 1;
      } else {
        uu.finalLevel = lvl2; // B/S/控制
      }
    }

    // 括号配对（BD16 简化）：对常用文本括号配对并调整闭括号级别
    var openStacks = [];
    var pairInfo = [];
    for (var u7 = 0; u7 < units.length; u7++) {
      var c2 = gClusters[units[u7].gi].cps[0].cp;
      if (OPEN_TO_CLOSE[c2]) {
        openStacks.push({ idx: u7, cp: c2 });
      } else if (CLOSE_TO_OPEN[c2]) {
        // 找最近匹配
        var match = -1;
        for (var oi = openStacks.length - 1; oi >= 0; oi--) {
          if (openStacks[oi].cp === CLOSE_TO_OPEN[c2]) { match = oi; break; }
        }
        if (match !== -1) {
          var op = openStacks[match];
          // 检查括号间强方向（N0b-d）：含 R/AN 即视为 RTL 括号对
          var strong = null;
          for (var bi = op.idx + 1; bi < u7; bi++) {
            var tt = units[bi].type;
            if (tt === "R" || tt === "AL" || tt === "AN") { strong = "R"; break; }
            if (tt === "L") { strong = strong || "L"; }
          }
          pairInfo.push({ openGi: units[op.idx].gi, closeGi: units[u7].gi, strong: strong });
          if (strong === "R") {
            // N0：RTL 上下文中括号取与嵌入级相反的方向级（1→0），
            // 使 “(عربي)” 在屏幕上呈现为 “(عربي)” 的正确镜像位置。
            var fixLevel = function (idx) {
              var lv = units[idx].finalLevel;
              units[idx].finalLevel = (lv % 2 === 1) ? lv - 1 : lv;
              units[idx].bracketMirrored = true;
            };
            fixLevel(op.idx);
            fixLevel(u7);
          }
          openStacks.splice(match, 1);
        } else {
          pairInfo.push({ closeGi: units[u7].gi, unmatched: true });
        }
      }
    }
    openStacks.forEach(function (o) {
      pairInfo.push({ openGi: units[o.idx].gi, unmatched: true });
    });

    // L1/L2：按 finalLevel 重排（显式格式控制保留在逻辑位置，标记 invisible）
    var visible = [];
    for (var u8 = 0; u8 < units.length; u8++) {
      visible.push({ gi: units[u8].gi, level: units[u8].finalLevel });
    }
    // L2 重排：从最高级向下，仅奇数级反转“同级别”的连续段；
    // 更高级（如 EN/AN 的偶数级 2）片段作为原子段保留其内部顺序，
    // 不被低一级的反转吞掉（UAX #9 L2：偶数级永不反转）。
    var maxLevel2 = 0;
    visible.forEach(function (v) { maxLevel2 = Math.max(maxLevel2, v.level); });
    for (var lev = maxLevel2; lev >= 1; lev--) {
      if (lev % 2 === 0) continue;
      var s2 = 0;
      while (s2 < visible.length) {
        if (visible[s2].level !== lev) { s2++; continue; }
        var e2 = s2;
        while (e2 < visible.length && visible[e2].level >= lev) e2++;
        // 段内更高级的子段原子保留，仅把恰好位于 lev 的单元按位置倒序摆放
        var slots = [];
        for (var q = s2; q < e2; q++) {
          if (visible[q].level === lev) slots.push(q);
        }
        if (slots.length > 1) {
          var held = slots.map(function (idx) { return visible[idx]; });
          held.reverse();
          slots.forEach(function (idx, k) { visible[idx] = held[k]; });
        }
        s2 = e2;
      }
    }

    return {
      baseLevel: baseLevel,
      clusters: gClusters,
      units: units,
      events: events,
      pairs: pairInfo,
      order: visible,
      maxDepth: maxDepth
    };
  }

  /* ================= 诊断 ================= */

  function clusterRef(giStart, giEnd) {
    return { graphemeStart: giStart, graphemeEnd: giEnd };
  }

  function diagnoseParagraph(paraIdx, dir, text, issues, warnings, truncated, isLastPara) {
    var limit = truncated ? Math.min(cpLen(text), LIMITS.PARA_WARN_CHARS) : cpLen(text);
    var scannedText = cpSlice(text, 0, limit);
    var res = resolveParagraph(scannedText, dir);
    var clusters = res.clusters;

    function cpRangeOf(giA, giB) {
      var a = clusters[giA].start;
      var b = clusters[clusters.length - 1] === clusters[giB] ? limit : clusters[giB].end;
      return [a, b];
    }
    function clusterText(giA, giB) {
      var parts = [];
      for (var i = giA; i <= giB; i++) parts.push(clusters[i].text);
      return parts.join("");
    }
    function codepointInfo(giA, giB) {
      var out = [];
      for (var i = giA; i <= giB; i++) {
        clusters[i].cps.forEach(function (c) {
          out.push({ cp: "U+" + c.hex, name: c.name });
        });
      }
      return out;
    }

    function addIssue(type, severity, giA, giB, reason, extra) {
      var r = cpRangeOf(giA, giB);
      var ref = clusterRef(giA, giB);
      var issue = {
        id: "p" + (paraIdx + 1) + "-" + type + "-" + r[0] + "-" + issues.length,
        para: paraIdx + 1,
        start: r[0], end: r[1],
        graphemeStart: ref.graphemeStart, graphemeEnd: ref.graphemeEnd,
        type: type, severity: severity, reason: reason,
        codepoints: codepointInfo(giA, giB),
        cluster: clusterText(giA, giB)
      };
      // 修复作用范围可精确到簇内个别码点（仍是同一个字素簇，不会拆出多个修复位）
      if (extra) {
        if (isInt(extra.fixStart) && isInt(extra.fixEnd) &&
            extra.fixStart >= r[0] && extra.fixEnd <= r[1] &&
            extra.fixEnd > extra.fixStart) {
          issue.fixStart = extra.fixStart;
          issue.fixEnd = extra.fixEnd;
        }
        if (Array.isArray(extra.fixCodepoints) && extra.fixCodepoints.length) {
          issue.codepoints = extra.fixCodepoints;
        }
      }
      issues.push(issue);
    }

    // —— 1) 控制符栈事件：孤立 / 未关闭 / 旧式 / 覆盖 / 嵌套深度 ——
    // 影子帧栈与 resolveParagraph 的显式控制栈保持同步：PDF/PDI 关闭帧时必须
    // 同步弹出，否则已正确闭合的 LRE…PDF / RLO…PDF 也会被误报为“未关闭”。
    var openFrames = []; // {gi, kind, iso}
    var reportedLegacy = {};
    var reportedOverride = {};
    var deepReported = false;

    function frameIndexOf(gi) {
      for (var fi = openFrames.length - 1; fi >= 0; fi--) {
        if (openFrames[fi].gi === gi) return fi;
      }
      return -1;
    }

    res.events.forEach(function (ev) {
      if (ev.action === "push") {
        openFrames.push({ gi: ev.gi, kind: ev.kind, iso: ev.kind === "isolate" });

        var g = clusters[ev.gi];
        var cp0 = g.cps[0].cp;
        var fmt = formattingOf(cp0);
        // 旧式嵌入：每个 LRE/RLE 报一次（PDF 配对时不再重复）
        if (fmt && fmt.legacy && ev.kind === "embed" && !reportedLegacy[ev.gi]) {
          reportedLegacy[ev.gi] = true;
          addIssue(IT.LEGACY_EMBEDDING, SEV.MEDIUM, ev.gi, ev.gi,
            "使用旧式显式嵌入控制符（" + g.cps[0].name +
            "）；UAX #9 建议改用隔离控制（LRI/RLI/PDI），旧式嵌入与隔离混用时配对关系容易出错。");
        }
        if (fmt && ev.kind === "override" && !reportedOverride[ev.gi]) {
          reportedOverride[ev.gi] = true;
          addIssue(IT.OVERRIDE_CONTROL, SEV.HIGH, ev.gi, ev.gi,
            "存在强制覆盖控制符（" + g.cps[0].name +
            "），其后字符的双向类型被强制改写，屏幕顺序可能与逻辑顺序完全相反且不留可见痕迹。");
        }
        if (ev.depth > LIMITS.MAX_NESTING_DEPTH && !deepReported) {
          deepReported = true;
          addIssue(IT.DEEP_NESTING, SEV.HIGH, ev.gi, ev.gi,
            "方向控制嵌套深度达到 " + ev.depth + "，超过 " + LIMITS.MAX_NESTING_DEPTH +
            " 的预警阈值；配对排查困难，超出实现栈深后控制符会被静默忽略。");
        }
      }
      if (ev.action === "pop") {
        // PDF 关闭最近的嵌入/覆盖帧（配对时该帧位于栈顶）
        var pi2 = frameIndexOf(ev.openGi);
        if (pi2 !== -1) openFrames.length = pi2;
      }
      if (ev.action === "pop_iso") {
        // PDI 关闭隔离帧及其内部全部嵌入/覆盖帧（X6a）
        var si2 = frameIndexOf(ev.openGi);
        if (si2 !== -1) openFrames.length = si2;
      }
      if (ev.action === "close_implicit") {
        // 隔离内部的嵌入/覆盖帧被 PDI 隐式结束
        var ii = frameIndexOf(ev.openGi);
        if (ii !== -1) openFrames.splice(ii, 1);
      }
      if (ev.action === "stray_pdi") {
        addIssue(IT.ORPHAN_CONTROL, SEV.HIGH, ev.gi, ev.gi,
          "POP DIRECTIONAL ISOLATE（PDI）找不到对应的隔离开启符，是孤立控制符；它不产生可见效果，却会让后续自动诊断与修复位置计算出现偏差。");
      }
      if (ev.action === "stray_pop") {
        addIssue(IT.ORPHAN_CONTROL, SEV.HIGH, ev.gi, ev.gi,
          "POP DIRECTIONAL FORMATTING（PDF）在段落栈为空时出现，是孤立控制符；不会改变渲染，却会打断对嵌入层级的判断。");
      }
      if (ev.action === "ignored_pdf") {
        addIssue(IT.ORPHAN_CONTROL, SEV.MEDIUM, ev.gi, ev.gi,
          "PDF 无法弹出隔离序列（隔离只能由 PDI 结束），该 PDF 在此处被双向引擎忽略，属于错位控制符。");
      }
      if (ev.action === "overflow") {
        addIssue(IT.DEEP_NESTING, SEV.HIGH, ev.gi, ev.gi,
          "嵌入/隔离栈超过实现上限 125 层，该控制符被引擎静默忽略，嵌套内容的方向将不符合作者预期。");
      }
    });

    // 段末仍未关闭的嵌入/隔离：
    // 最后一段报 unclosed_embedding；其后还有段落时报 cross_paragraph_state
    // （段落边界强制重置方向状态，作者可能误以为会延续）。
    function reportUnclosed(gi, count, kindName) {
      if (isLastPara) {
        addIssue(IT.UNCLOSED_EMBEDDING, SEV.MEDIUM, gi, gi,
          "段落结束时仍有 " + count + " 个" + kindName + "未关闭；" +
          "浏览器在段尾隐式补齐，但未配对的开启符会让片段边界依赖实现细节。");
      } else {
        addIssue(IT.CROSS_PARAGRAPH_STATE, SEV.MEDIUM, gi, gi,
          "本段段末仍有 " + count + " 个" + kindName + "未关闭，而后面还有第 " +
          (paraIdx + 2) + " 段；双向方向状态在段落边界被强制重置、不会延续，" +
          "若作者以为状态会跨段延续，两段交界处的屏幕顺序会被误读。");
      }
    }
    var openLegacy = openFrames.filter(function (f) { return !f.iso; });
    var openIsoOnly = openFrames.filter(function (f) { return f.iso; });
    if (openLegacy.length) {
      reportUnclosed(openLegacy[openLegacy.length - 1].gi,
        openLegacy.length, "旧式嵌入/覆盖（LRE/RLE/LRO/RLO）");
    }
    if (openIsoOnly.length) {
      reportUnclosed(openIsoOnly[openIsoOnly.length - 1].gi,
        openIsoOnly.length, "隔离序列（LRI/RLI/FSI）");
    }

    // —— 2) 数字体系混用、数字/标点歧义 ——
    // 注意：诊断要读码点的“原始”数字类型（EN/AN），因为 UAX W2 已把
    // AL 之后的 EN 归一成 AN；混用与否看字符本身，不看归一结果。
    var units = res.units;
    function rawNumType(gi) {
      var cl = clusters[gi];
      if (!cl) return null;
      var t = bidiType(cl.cps[0].cp);
      return (t === "EN" || t === "AN") ? t : null;
    }
    function typeAt(gi) { return units[gi] ? units[gi].type : null; }

    for (var di = 0; di < clusters.length; di++) {
      // 数字串：连续原始 EN/AN（允许其间已并入的 ES/CS 与 ET）
      var raw0 = rawNumType(di);
      if (!raw0) continue;
      var runStart = di;
      var hasEN = raw0 === "EN", hasAN = raw0 === "AN";
      di++;
      while (di < clusters.length) {
        var rawN = rawNumType(di);
        if (rawN) { hasEN = hasEN || rawN === "EN"; hasAN = hasAN || rawN === "AN"; di++; }
        else {
          var tt = typeAt(di);
          if (tt === "ES" || tt === "CS" || tt === "ET") {
            // 只在另一侧仍为数字时延伸
            if (rawNumType(di + 1)) di++;
            else break;
          } else break;
        }
      }
      var runEnd = di - 1;

      if (hasEN && hasAN) {
        addIssue(IT.MIXED_DIGITS, SEV.MEDIUM, runStart, runEnd,
          "同一数字片段中混用了拉丁数字（EN）与阿拉伯-印度数字（AN）；二者在 RTL 段落中的视觉归组级别不同，容易把 “350” 与 “٣٥٠” 的先后或位数读错。");
      }

      // 数字串相邻中立标点且上下文方向冲突
      var beforeGi = runStart - 1, afterGi = runEnd + 1;
      var bT = beforeGi >= 0 ? typeAt(beforeGi) : null;
      var aT = afterGi < clusters.length ? typeAt(afterGi) : null;
      var paraRTL = res.baseLevel === 1;
      var punctGi = -1;
      if (bT === "ON" || bT === "CS") punctGi = beforeGi;
      else if (aT === "ON" || aT === "CS") punctGi = afterGi;
      if (punctGi !== -1) {
        // 标点另一侧是否为相反强方向
        var otherGi = punctGi === beforeGi ? beforeGi - 1 : afterGi + 1;
        var oT = otherGi >= 0 && otherGi < clusters.length ? typeAt(otherGi) : null;
        var conflict =
          (paraRTL && (oT === "L")) || (!paraRTL && (oT === "R" || oT === "AN")) ||
          (punctGi === beforeGi && bT === "CS" && paraRTL && aT !== null) ||
          (punctGi === afterGi && aT === "CS" && paraRTL);
        if (conflict || (paraRTL && punctGi !== -1 && (raw0 === "EN"))) {
          var from = Math.min(runStart, punctGi), to = Math.max(runEnd, punctGi);
          addIssue(IT.DIGIT_PUNCT_AMBIGUITY, SEV.MEDIUM, from, to,
            "数字片段与中立标点（" + clusters[punctGi].cps[0].name +
            "）相邻且上下文方向不一致；标点会被解析到某一侧，屏幕上它贴着的数字未必是逻辑上同组的数字。");
        }
      }
      di = runEnd + 1;
    }

    // —— 3) 中立符夹在两套强方向文字之间 ——
    for (var ni = 1; ni < clusters.length - 1; ni++) {
      var tMid = typeAt(ni);
      if (tMid !== "ON" && tMid !== "CS" && tMid !== "ES" &&
          tMid !== "B" && tMid !== "S") continue;
      if (tMid === "B" || tMid === "S") continue;
      var pT = typeAt(ni - 1), nT = typeAt(ni + 1);
      var pStrong = pT === "L" ? "L" : (pT === "R" || pT === "AN") ? "R" : null;
      var nStrong = nT === "L" ? "L" : (nT === "R" || nT === "AN") ? "R" : null;
      if (pStrong && nStrong && pStrong !== nStrong) {
        addIssue(IT.NEUTRAL_BETWEEN_SCRIPTS, SEV.MEDIUM, ni - 1, ni + 1,
          "中立字符 “" + clusterText(ni, ni) + "” 两侧是相反方向的文字；" +
          "解析结果取决于段落基准方向，未加隔离时屏幕阅读顺序与逻辑顺序可能被误解。");
      }
    }

    // —— 4) 括号未配对 ——
    res.pairs.forEach(function (p) {
      if (!p.unmatched) return;
      var gi2 = p.openGi != null ? p.openGi : p.closeGi;
      addIssue(IT.BRACKET_MISMATCH, SEV.MEDIUM, gi2, gi2,
        "括号 “" + clusterText(gi2, gi2) + "” 没有匹配的另一半；" +
        "双向引擎仍会给它分配层级，可能把后续一整段文字归到错误的视觉一侧。");
    });

    // —— 5) 悬空 ZWJ/ZWNJ（码点级扫描；连接符可能并入相邻基字的字素簇）——
    // 展开簇序列，保留每码点所属簇下标
    var flat = []; // {cp, gi}
    clusters.forEach(function (g, gi2) {
      g.cps.forEach(function (c) { flat.push({ cp: c.cp, gi: gi2 }); });
    });
    var joinableRanges = [
      [0x591, 0x5F4], [0x620, 0x64A], [0x656, 0x6DC], [0x6DF, 0x6FF],
      [0x710, 0x73F], [0x74D, 0x7A5], [0x7B1, 0x7B1], [0x7CA, 0x7EA],
      [0x840, 0x85B], [0x860, 0x86A], [0x870, 0x88E], [0x8A0, 0x8E4],
      [0x903, 0x97F], [0xA03, 0xA83], [0x1000, 0x1248], [0x1780, 0x17DD],
      [0x180B, 0x180D], [0x1885, 0x1886], [0x2D7F, 0x2D7F],
      [0x2E80, 0x2FFF], [0x3040, 0x30FF], [0x3400, 0x4DBF],
      [0x4E00, 0x9FFF], [0xA000, 0xA48C], [0xA800, 0xA82C],
      [0xAC00, 0xD7A3], [0xF900, 0xFAFF]
    ];
    function joins(c) {
      if (c == null) return false;
      if (inRanges(c, joinableRanges)) return true;
      // 梵文修饰鼻音等组合标记不单独连字；emoji 通过 ZWJ 连字
      return isPictographic(c);
    }
    // 找相邻“可见基字”码点（跳过组合音符与其他零宽控制）
    function neighborCp(idx, dir) {
      var j = idx + dir;
      while (j >= 0 && j < flat.length) {
        var c = flat[j].cp;
        var t = bidiType(c);
        if (t === "NSM" || t === "BN" || isS(c)) { j += dir; continue; }
        return c;
      }
      return null;
    }
    var reportedJoinerClusters = {};
    for (var fi = 0; fi < flat.length; fi++) {
      var fcp = flat[fi].cp;
      if (fcp !== 0x200D && fcp !== 0x200C) continue;
      var gi3 = flat[fi].gi;
      if (reportedJoinerClusters[gi3]) continue; // 同一簇只报一条
      var prevJ = neighborCp(fi, -1), nextJ = neighborCp(fi, 1);
      if (joins(prevJ) && joins(nextJ)) continue;
      reportedJoinerClusters[gi3] = true;
      var joinerCpPos = clusters[gi3].start;
      for (var k2 = 0; k2 < fi; k2++) { /* no-op，位置在下方按簇内偏移求 */ }
      // 连接符在所属簇内的码点偏移
      var intra = 0;
      for (var cc = 0; cc < clusters[gi3].cps.length; cc++) {
        if (clusters[gi3].cps[cc].cp === fcp) { intra = cc; break; }
      }
      var fixStart = clusters[gi3].start + intra;
      addIssue(IT.DANGLING_JOINER, SEV.MEDIUM, gi3, gi3,
        (fcp === 0x200D ? "ZERO WIDTH JOINER（ZWJ，U+200D）" :
                          "ZERO WIDTH NON-JOINER（ZWNJ，U+200C）") +
        " 缺少可构成连接的相邻字符（两侧至少一侧不参与连字：" +
        (prevJ == null ? "段首/段尾" : "U+" + hex4(prevJ)) + " / " +
        (nextJ == null ? "段首/段尾" : "U+" + hex4(nextJ)) +
        "）；它不产生可见效果，却会让字素簇切分和位置统计产生隐性偏差。",
        {
          fixStart: fixStart, fixEnd: fixStart + 1,
          fixCodepoints: [{ cp: "U+" + hex4(fcp), name: cpName(fcp) }]
        });
    }

    // —— 6) 覆盖范围内的视觉/逻辑可疑片段 ——
    // 用 events 配对 override 的 push/pop；未关闭的覆盖到段末。
    var stack2 = [];
    var ovSpans = [];
    res.events.forEach(function (ev) {
      if (ev.action === "push" && ev.kind === "override") stack2.push(ev.gi);
      else if (ev.action === "pop" && stack2.length) {
        var op2 = stack2.pop();
        ovSpans.push([op2, ev.gi]);
      }
    });
    while (stack2.length) {
      var op3 = stack2.pop();
      ovSpans.push([op3, clusters.length - 1]); // 未关闭，到段末
    }
    ovSpans.forEach(function (sp) {
      if (sp[1] - sp[0] <= 1) return; // 仅报覆盖了实际内容的片段
      addIssue(IT.VISUAL_LOGIC_MISMATCH, SEV.HIGH, sp[0], Math.min(sp[1] - 1, clusters.length - 1),
        "该片段位于强制覆盖（LRO/RLO）作用域内：屏幕显示顺序被整体反转或强制，" +
        "仅凭视觉无法还原逻辑顺序，复制、检索与逐字定位都可能误解字符先后。");
    });
  }

  // 主诊断入口。paragraphs: [{dir, text}]
  // 返回 {issues, warnings, generatedAt, contentFp, truncatedParas, oversize}
  function diagnose(paragraphs) {
    var issues = [];
    var warnings = [];
    var truncatedParas = [];
    var oversize = false;

    if (!Array.isArray(paragraphs) || !paragraphs.length) {
      return { issues: [], warnings: [{ code: "empty", message: "没有可诊断的段落" }],
               generatedAt: nowISO(), contentFp: null, truncatedParas: [], oversize: false };
    }

    var total = 0;
    paragraphs.forEach(function (p, idx) {
      var len = cpLen(p.text || "");
      if (len > LIMITS.PARA_MAX_CHARS) oversize = true;
      total += len;
      if (len > LIMITS.PARA_WARN_CHARS) truncatedParas.push(idx + 1);
    });
    if (total > LIMITS.TOTAL_MAX_CHARS) oversize = true;

    paragraphs.forEach(function (p, idx) {
      var len = cpLen(p.text || "");
      var dir = DIRS.hasOwnProperty(p.dir) ? p.dir : "auto";
      if (len > LIMITS.PARA_MAX_CHARS) {
        warnings.push({
          code: "paragraph_too_large", para: idx + 1,
          message: "第 " + (idx + 1) + " 段超过 " + LIMITS.PARA_MAX_CHARS +
            " 码点上限，未参与诊断；请拆分段落后再载入实验室。"
        });
        return;
      }
      diagnoseParagraph(idx, dir, p.text || "", issues, warnings,
        truncatedParas.indexOf(idx + 1) !== -1, idx === paragraphs.length - 1);
    });

    // 超长段落警告
    truncatedParas.forEach(function (n) {
      warnings.push({
        code: "paragraph_truncated", para: n,
        message: "第 " + n + " 段超过 " + LIMITS.PARA_WARN_CHARS +
          " 字符；仅诊断前 " + LIMITS.PARA_WARN_CHARS + " 个码点，超长部分未检查。"
      });
    });

    return {
      issues: issues,
      warnings: warnings,
      generatedAt: nowISO(),
      contentFp: contentFingerprint(paragraphs),
      truncatedParas: truncatedParas,
      oversize: oversize
    };
  }

  /* ================= 指纹 ================= */

  function normalizeParas(paragraphs) {
    return (paragraphs || []).map(function (p) {
      return { dir: DIRS.hasOwnProperty(p.dir) ? p.dir : "auto", text: p.text || "" };
    });
  }

  function contentFingerprint(paragraphs) {
    var ps = normalizeParas(paragraphs);
    return fnv1a(ps.map(function (p) {
      return p.dir + ":" + fnv1a(p.text);
    }).join("|"));
  }

  // 渲染条件指纹：段落方向数组 + 容器宽度 + 缩放 + 字体
  function renderFingerprint(conditions) {
    conditions = conditions || {};
    var dirs = (conditions.dirs || []).join(",");
    return fnv1a([
      dirs,
      Math.round(Number(conditions.width) || 0),
      Math.round((Number(conditions.zoom) || 1) * 100),
      conditions.font || ""
    ].join("|"));
  }

  /* ================= 修复建议 ================= */

  function cpListAt(clusters, giA, giB) {
    var out = [];
    for (var i = giA; i <= giB; i++) {
      clusters[i].cps.forEach(function (c) {
        out.push({ cp: "U+" + c.hex, name: c.name });
      });
    }
    return out;
  }

  // 码点逻辑范围（可落在簇内）→ 码点描述列表
  function cpListForRange(clusters, cpStart, cpEnd) {
    var out = [];
    clusters.forEach(function (g) {
      if (g.end <= cpStart || g.start >= cpEnd) return;
      g.cps.forEach(function (c, k) {
        var abs = g.start + k;
        if (abs >= cpStart && abs < cpEnd) {
          out.push({ cp: "U+" + c.hex, name: c.name });
        }
      });
    });
    return out;
  }

  // 根据诊断结果生成完整修复计划（不执行）。
  // doc: {paragraphs:[{dir,text}]}
  // 返回 {docFp, suggestions:[...]}
  function buildPlan(doc, report) {
    var paragraphs = normalizeParas(doc.paragraphs);
    var suggestions = [];
    var used = {}; // 避免同一控制符被多条建议重复引用

    function push(s) {
      var key = s.kind + ":" + (s.para) + ":" + s.start + ":" + s.end + ":" + (s.toDir || "");
      if (used[key]) return;
      used[key] = true;
      s.id = "fix-" + suggestions.length;
      suggestions.push(s);
    }

    // 每段只解析一次；同时建立“开启符簇 gi → 配对闭符”映射。
    // via: 'pdf'（由配对 PDF 结束）/ 'pdi'（隔离开启符由 PDI 结束）/
    //      'implicit_pdi'（隔离内部的旧式帧被 PDI 按 X6a 隐式结束）。
    var ctxCache = {};
    function paraCtx(idx) {
      if (ctxCache[idx]) return ctxCache[idx];
      var res = resolveParagraph(paragraphs[idx].text, paragraphs[idx].dir);
      var closerOf = {};
      res.events.forEach(function (ev) {
        if (!isInt(ev.openGi)) return;
        if (ev.action === "pop") closerOf[ev.openGi] = { gi: ev.gi, via: "pdf" };
        else if (ev.action === "pop_iso") closerOf[ev.openGi] = { gi: ev.gi, via: "pdi" };
        else if (ev.action === "close_implicit") closerOf[ev.openGi] = { gi: ev.gi, via: "implicit_pdi" };
      });
      ctxCache[idx] = { res: res, clusters: res.clusters, closerOf: closerOf };
      return ctxCache[idx];
    }

    // 一个码点范围编辑描述符；replCp 为 null/undefined 表示删除。
    function rangeEdit(ctx, start, end, replCp) {
      return {
        start: start,
        end: end,
        before: cpListForRange(ctx.clusters, start, end),
        after: replCp == null ? [] : [{ cp: "U+" + hex4(replCp), name: cpName(replCp) }],
        replacementCp: replCp == null ? null : "U+" + hex4(replCp)
      };
    }

    report.issues.forEach(function (issue) {
      var paraIdx = issue.para - 1;
      var para = paragraphs[paraIdx];
      if (!para) return;
      var ctx = paraCtx(paraIdx);
      var clusters = ctx.clusters;
      var giA = issue.graphemeStart, giB = issue.graphemeEnd;

      if (issue.type === IT.ORPHAN_CONTROL ||
          issue.type === IT.DANGLING_JOINER) {
        // 悬空连接符可精确到簇内的连接符码点；其余整簇删除
        var rStart = isInt(issue.fixStart) ? issue.fixStart : clusters[giA].start;
        var rEnd = isInt(issue.fixEnd) ? issue.fixEnd : clusters[giB].end;
        push({
          kind: FK.REMOVE_FORMATTING,
          para: issue.para,
          start: rStart,
          end: rEnd,
          label: FIX_LABELS_ZH[FK.REMOVE_FORMATTING] + "：" +
            issue.codepoints.map(function (c) { return c.name; }).join("、"),
          before: cpListForRange(clusters, rStart, rEnd),
          after: [],
          issueIds: [issue.id],
          // 删除后保留簇文本用于前端预览（重建时只移除目标码点）
          clusterText: isInt(issue.fixStart)
            ? cpSlice(para.text, issue.fixStart, issue.fixEnd)
            : issue.cluster
        });
      }

      if (issue.type === IT.OVERRIDE_CONTROL) {
        // 强制覆盖（LRO/RLO）整帧删除：若该帧由配对 PDF 结束，必须连同
        // PDF 一起删——只删开符会留下孤立 PDF，重新诊断即报 orphan_control。
        var oStart = clusters[giA].start, oEnd = clusters[giA].end;
        var primary = rangeEdit(ctx, oStart, oEnd, null);
        var extraEdits = [];
        var closer = ctx.closerOf[giA];
        var labelTail = "";
        if (closer && closer.via === "pdf") {
          var cg = clusters[closer.gi];
          extraEdits.push(rangeEdit(ctx, cg.start, cg.end, null));
          labelTail = "（连同配对的 POP DIRECTIONAL FORMATTING / PDF 一并删除，避免遗留孤立 PDF）";
        }
        var allBefore = primary.before.concat(extraEdits.reduce(function (acc, e) {
          return acc.concat(e.before);
        }, []));
        push({
          kind: FK.REMOVE_FORMATTING,
          para: issue.para,
          start: oStart,
          end: oEnd,
          label: FIX_LABELS_ZH[FK.REMOVE_FORMATTING] + "：" +
            issue.codepoints.map(function (c) { return c.name; }).join("、") + labelTail,
          before: allBefore,
          primaryBefore: primary.before,
          after: [],
          extraEdits: extraEdits,
          issueIds: [issue.id],
          clusterText: issue.cluster
        });
      }

      if (issue.type === IT.LEGACY_EMBEDDING) {
        var c0 = clusters[giA].cps[0].cp;
        // LRE(U+202A)→LRI(U+2066) / RLE(U+202B)→RLI(U+2067)
        var replacement = c0 === 0x202A ? 0x2066 : 0x2067;
        var primary2 = rangeEdit(ctx, clusters[giA].start, clusters[giA].end, replacement);

        // 开符改成隔离开启符后，旧式闭符 PDF 不再与它配对：
        //   - 由配对 PDF 结束：PDF 必须同步替换成 PDI，否则会留下孤立 PDF +
        //     未闭合隔离（重新诊断会新增 orphan_control / unclosed_embedding）；
        //   - 位于隔离内部、由外层 PDI 按 X6a 隐式结束：在该 PDI 前补一个 PDI，
        //     显式关闭转换后的隔离开启符，保持原有帧结构；
        //   - 段末未关闭：段落边界本就隐式结束，只转换开符即可。
        var legacyExtraEdits = [];
        var closer2 = ctx.closerOf[giA];
        var legacyLabelTail = "";
        if (closer2 && closer2.via === "pdf") {
          var cg2 = clusters[closer2.gi];
          legacyExtraEdits.push(rangeEdit(ctx, cg2.start, cg2.end, 0x2069));
          legacyLabelTail = "（配对的 POP DIRECTIONAL FORMATTING / PDF 同步替换为 PDI）";
        } else if (closer2 && closer2.via === "implicit_pdi") {
          var pgi = clusters[closer2.gi];
          legacyExtraEdits.push(rangeEdit(ctx, pgi.start, pgi.start, 0x2069));
          legacyLabelTail = "（在结束外层隔离的 PDI 前补一个 PDI，显式关闭转换后的隔离）";
        }
        var legacyAfter = primary2.after.concat(legacyExtraEdits.reduce(function (acc, e) {
          return acc.concat(e.after);
        }, []));
        push({
          kind: FK.LEGACY_TO_ISOLATE,
          para: issue.para,
          start: clusters[giA].start,
          end: clusters[giA].end,
          label: FIX_LABELS_ZH[FK.LEGACY_TO_ISOLATE] + "：" + cpName(c0) +
            " → " + cpName(replacement) + legacyLabelTail,
          before: cpListAt(clusters, giA, giA),
          primaryBefore: cpListAt(clusters, giA, giA),
          after: legacyAfter,
          replacementCp: "U+" + hex4(replacement),
          extraEdits: legacyExtraEdits,
          issueIds: [issue.id],
          clusterText: issue.cluster
        });
      }

      if (issue.type === IT.UNCLOSED_EMBEDDING) {
        // 未关闭的旧式开启符由 LEGACY_EMBEDDING 建议（转隔离）处理；
        // 只有未关闭的隔离开启符（无旧式建议可覆盖）才单独给删除建议。
        var cp0 = clusters[giA].cps[0].cp;
        if (cp0 === 0x2066 || cp0 === 0x2067 || cp0 === 0x2068) {
          push({
            kind: FK.REMOVE_FORMATTING,
            para: issue.para,
            start: clusters[giA].start,
            end: clusters[giB].end,
            label: FIX_LABELS_ZH[FK.REMOVE_FORMATTING] + "：删除未配对的隔离开启符（段落边界已隐式结束它）",
            before: cpListAt(clusters, giA, giB),
            after: [],
            issueIds: [issue.id],
            clusterText: issue.cluster
          });
        }
      }

      if (issue.type === IT.CROSS_PARAGRAPH_STATE) {
        // 旧式开启符（LRE/RLE/LRO/RLO）已由各自的 LEGACY_EMBEDDING /
        // OVERRIDE_CONTROL 建议覆盖，这里只给“隔离型未关闭”删除建议，
        // 保证同一码点不会有两条可组合建议。
        var cpX = clusters[giA].cps[0].cp;
        if (cpX === 0x2066 || cpX === 0x2067 || cpX === 0x2068) {
          push({
            kind: FK.REMOVE_FORMATTING,
            para: issue.para,
            start: clusters[giA].start,
            end: clusters[giB].end,
            label: FIX_LABELS_ZH[FK.REMOVE_FORMATTING] + "：删除跨段未关闭的隔离开启符（方向状态不会跨段延续）",
            before: cpListAt(clusters, giA, giB),
            after: [],
            issueIds: [issue.id],
            clusterText: issue.cluster
          });
        }
      }

      if (issue.type === IT.MIXED_DIGITS ||
          issue.type === IT.DIGIT_PUNCT_AMBIGUITY) {
        // 用 FSI...PDI 包住整个数字片段
        push({
          kind: FK.ISOLATE_NUMBER,
          para: issue.para,
          start: clusters[giA].start,
          end: clusters[giB].end,
          label: FIX_LABELS_ZH[FK.ISOLATE_NUMBER] + "：FSI…PDI 包裹 “" + issue.cluster + "”",
          before: cpListAt(clusters, giA, giB),
          after: [{ cp: "U+2068", name: cpName(0x2068) }]
            .concat(cpListAt(clusters, giA, giB))
            .concat([{ cp: "U+2069", name: cpName(0x2069) }]),
          issueIds: [issue.id],
          clusterText: issue.cluster
        });
      }

      if (issue.type === IT.BRACKET_MISMATCH) {
        push({
          kind: FK.REMOVE_BRACKET,
          para: issue.para,
          start: clusters[giA].start,
          end: clusters[giA].end,
          label: FIX_LABELS_ZH[FK.REMOVE_BRACKET] + "：“" + clusters[giA].text + "”",
          before: cpListAt(clusters, giA, giA),
          after: [],
          issueIds: [issue.id],
          clusterText: issue.cluster
        });
      }
    });

    // 段落方向建议：对“auto 但首个强字符方向与常见误解一致”的情况不臆测；
    // 仅当段落内强方向字符多数为 RTL 而 dir=ltr，或反之，给出方向元数据建议。
    paragraphs.forEach(function (p, idx) {
      var res = resolveParagraph(p.text, p.dir);
      var rtlCount = 0, ltrCount = 0;
      res.units.forEach(function (un) {
        var t = un.type;
        if (t === "R" || t === "AN") rtlCount++;
        if (t === "L") ltrCount++;
      });
      var suggestTo = null;
      if (p.dir === "ltr" && rtlCount > ltrCount * 2 && rtlCount >= 3) suggestTo = "rtl";
      if (p.dir === "rtl" && ltrCount > rtlCount * 2 && ltrCount >= 3) suggestTo = "ltr";
      if (p.dir === "auto" && rtlCount >= 3 && rtlCount > ltrCount) suggestTo = "rtl";
      if (suggestTo) {
        push({
          kind: FK.SET_DIR,
          para: idx + 1,
          start: 0, end: 0,
          toDir: suggestTo, fromDir: p.dir,
          label: FIX_LABELS_ZH[FK.SET_DIR] + "：第 " + (idx + 1) + " 段 " + p.dir + " → " + suggestTo,
          before: [], after: [],
          issueIds: [],
          clusterText: ""
        });
      }
    });

    return {
      docFp: contentFingerprint(paragraphs),
      suggestions: suggestions
    };
  }

  /* ================= 应用修复（整批，条件变化即拒绝） ================= */

  // 在一段内按建议编辑。edits: [{start,end, replacementText}]（码点偏移，降序）
  function applyEditsToText(text, edits) {
    var cps = cpArray(text);
    edits.sort(function (a, b) { return b.start - a.start; });
    edits.forEach(function (e) {
      if (e.start < 0 || e.end > cps.length || e.start > e.end) {
        throw { code: "range_out_of_bounds" };
      }
      cps.splice(e.start, e.end - e.start, e.replacementText);
    });
    return cps.join("");
  }

  // 一条建议的全部码点编辑（主编辑 + 与配对闭符联动的附加编辑）。
  // 返回 [{start,end,replacementText}]；replacementCp 形如 "U+2069"，null=删除。
  function editsOfSuggestion(s) {
    function replText(ed) {
      return ed.replacementCp
        ? String.fromCodePoint(parseInt(ed.replacementCp.slice(2), 16))
        : "";
    }
    var list = [];
    if (s.kind === FK.LEGACY_TO_ISOLATE) {
      list.push({ start: s.start, end: s.end, replacementText:
        String.fromCodePoint(parseInt(s.replacementCp.slice(2), 16)) });
    } else if (s.kind === FK.ISOLATE_NUMBER) {
      list.push({ start: s.start, end: s.end, replacementText:
        String.fromCodePoint(0x2068) + s.clusterText + String.fromCodePoint(0x2069) });
    } else {
      list.push({ start: s.start, end: s.end, replacementText: "" });
    }
    (Array.isArray(s.extraEdits) ? s.extraEdits : []).forEach(function (ed) {
      list.push({ start: ed.start, end: ed.end, replacementText: replText(ed) });
    });
    return list;
  }

  // 校验并应用选中建议。
  // currentDoc: {paragraphs:[{dir,text}]}
  // currentConditions: {dirs,width,zoom,font}
  // plan: buildPlan 的返回；selectedIds: [suggestion.id]
  // planMeta: {contentFp, renderFp}（诊断/生成计划时记录的条件）
  // 返回 {ok:true, paragraphs, applied:[...], at} 或 {ok:false, code, message}
  function applySuggestions(currentDoc, currentConditions, selectedIds, plan, planMeta) {
    if (!plan || !Array.isArray(plan.suggestions)) {
      return err(400, "invalid_plan", "修复计划无效，请重新诊断。");
    }
    if (!Array.isArray(selectedIds) || !selectedIds.length) {
      return err(400, "nothing_selected", "没有选中任何修复建议。");
    }

    // —— 条件门禁：正文指纹 ——
    var currentFp = contentFingerprint(currentDoc.paragraphs);
    var expectedFp = planMeta && planMeta.contentFp != null
      ? planMeta.contentFp : plan.docFp;
    if (currentFp !== expectedFp) {
      return err(409, "content_changed",
        "诊断之后正文已经变化（含段落方向切换），旧诊断的码点位置不再可信；请重新诊断后再应用修复。本次未改动任何文字。");
    }

    // —— 条件门禁：渲染条件指纹 ——
    if (planMeta && planMeta.renderFp != null) {
      var currentRenderFp = renderFingerprint(currentConditions);
      if (currentRenderFp !== planMeta.renderFp) {
        return err(409, "render_condition_changed",
          "诊断时的渲染条件（段落方向/容器宽度/缩放/字体）已经变化，视觉范围与映射均已重算，不能拿旧位置执行修复。请重新诊断。本次未改动任何文字。");
      }
    }

    var byId = {};
    plan.suggestions.forEach(function (s) { byId[s.id] = s; });
    var selected = [];
    for (var i = 0; i < selectedIds.length; i++) {
      var s2 = byId[selectedIds[i]];
      if (!s2) return err(400, "suggestion_not_found",
        "修复建议 “" + selectedIds[i] + "” 已不在当前计划中，请重新诊断。");
      selected.push(s2);
    }

    // 同段建议检查范围重叠（重叠时无法确定先后语义，整次拒绝）
    var byPara = {};
    selected.forEach(function (s) {
      if (s.kind === FK.SET_DIR) return;
      (byPara[s.para] = byPara[s.para] || []).push(s);
    });
    var overlapError = null;
    Object.keys(byPara).forEach(function (n) {
      if (overlapError) return;
      var list = byPara[n];
      var ranges = [];
      list.forEach(function (s) {
        editsOfSuggestion(s).forEach(function (e) {
          ranges.push({ s: s, start: e.start, end: e.end });
        });
      });
      for (var a = 0; a < ranges.length; a++) {
        for (var b = a + 1; b < ranges.length; b++) {
          var x = ranges[a], y = ranges[b];
          // 同一建议的插入式编辑（end===start）允许紧贴另一编辑边界
          if (x.s === y.s) continue;
          if (x.start < y.end && y.start < x.end) {
            overlapError = err(409, "suggestions_overlap",
              "第 " + n + " 段的两项建议作用范围重叠（" + x.s.label + " / " + y.s.label +
              "），无法安全组合；请只选其中一项后重新诊断。本次未改动任何文字。");
            return;
          }
        }
      }
    });
    if (overlapError) return overlapError;

    // 同一段不允许同时 set_dir 与文本修改之外的冲突：允许（方向独立于文本），
    // 但两个 set_dir 指向同一段则拒绝
    var dirSeen = {};
    for (var d = 0; d < selected.length; d++) {
      if (selected[d].kind !== FK.SET_DIR) continue;
      if (dirSeen[selected[d].para]) {
        return err(409, "duplicate_set_dir",
          "第 " + selected[d].para + " 段存在两个方向调整建议，无法同时应用。本次未改动任何文字。");
      }
      dirSeen[selected[d].para] = true;
    }

    // —— 执行（先在副本上计算，全部成功后才返回）——
    var paragraphs = normalizeParas(currentDoc.paragraphs).map(function (p) {
      return { dir: p.dir, text: p.text };
    });

    // —— 先对照原始正文统一校验所有范围（任一不符则整次拒绝），
    //    然后每段内部按起始码点偏移降序应用，避免前面的编辑改动后续偏移。——
    var originals = normalizeParas(currentDoc.paragraphs);

    try {
      selected.forEach(function (s) {
        if (s.kind === FK.SET_DIR) return;
        var pi0 = s.para - 1;
        // 主编辑与附加编辑逐一对照原始正文，任一不符即整次拒绝
        var edits = editsOfSuggestion(s);
        var beforeLists = [s.primaryBefore || s.before || []];
        (Array.isArray(s.extraEdits) ? s.extraEdits : []).forEach(function (ed) {
          beforeLists.push(ed.before || []);
        });
        edits.forEach(function (e, ei) {
          var actualCps = cpArray(cpSlice(originals[pi0].text, e.start, e.end))
            .map(function (ch) { return "U+" + hex4(ch.codePointAt(0)); });
          var expectedCps = (beforeLists[ei] || []).map(function (c) { return c.cp; });
          if (actualCps.join(",") !== expectedCps.join(",")) {
            throw { code: "range_contents_changed" };
          }
        });
      });

      // 方向先改（与文本编辑互不影响偏移）
      selected.forEach(function (s) {
        if (s.kind === FK.SET_DIR) paragraphs[s.para - 1].dir = s.toDir;
      });

      // 按段分组文本编辑（含配对闭符的附加编辑），段内降序
      var editsByPara = {};
      selected.forEach(function (s) {
        if (s.kind === FK.SET_DIR) return;
        editsOfSuggestion(s).forEach(function (e) {
          (editsByPara[s.para] = editsByPara[s.para] || []).push(e);
        });
      });
      Object.keys(editsByPara).forEach(function (n) {
        var pi0 = Number(n) - 1;
        paragraphs[pi0].text = applyEditsToText(paragraphs[pi0].text,
          editsByPara[n]);
      });
    } catch (e) {
      return err(409, e.code || "apply_failed",
        "修复范围已失效（" + (e.code || "位置不匹配") +
        "）；请重新诊断。本次未改动任何文字。");
    }

    return {
      ok: true,
      paragraphs: paragraphs,
      applied: selected.map(function (s) {
        return { id: s.id, kind: s.kind, para: s.para, start: s.start, end: s.end, label: s.label };
      }),
      contentFp: contentFingerprint(paragraphs),
      at: nowISO()
    };
  }

  // 计算一条建议在同渲染条件下“可能改变的视觉范围”：
  // 返回修复前/后的渲染顺序中受影响的字素簇 gi 集合（用于预览标注）。
  function visualSpanFor(para, suggestion) {
    function span(text, dir) {
      var r = resolveParagraph(text, dir);
      var set = {};
      r.order.forEach(function (v, visualIdx) { set[v.gi] = visualIdx; });
      return { order: r.order.map(function (v) { return v.gi; }), set: set };
    }
    var before = span(para.text, para.dir);
    var afterText = para.text, afterDir = para.dir;
    var pi2 = 0;
    try {
      if (suggestion.kind === FK.SET_DIR) afterDir = suggestion.toDir;
      else {
        afterText = applyEditsToText(para.text, editsOfSuggestion(suggestion));
      }
    } catch (e) { return null; }
    var after = span(afterText, afterDir);
    return {
      beforeOrder: before.order,
      afterOrder: after.order,
      // 视觉范围：修复前后位置不同的视觉索引区间 [min, max)
      changedVisualIndices: changedRange(before.order, after.order)
    };
  }

  function changedRange(beforeOrder, afterOrder) {
    var n = Math.max(beforeOrder.length, afterOrder.length);
    var first = -1, last = -1;
    for (var i = 0; i < n; i++) {
      if (beforeOrder[i] !== afterOrder[i]) {
        if (first === -1) first = i;
        last = i;
      }
    }
    return first === -1 ? null : { start: first, end: last + 1 };
  }

  /* ================= 诊断样例 ================= */

  function validateSampleName(v) {
    if (typeof v !== "string") return err(400, "invalid_name", "样例名称必须是文本");
    var value = v.trim();
    if (!value) return err(400, "empty_name", "样例名称不能为空");
    if (cpLen(value) > LIMITS.SAMPLE_NAME_MAX) {
      return err(400, "name_too_long", "样例名称不能超过 " + LIMITS.SAMPLE_NAME_MAX + " 个字符");
    }
    return { ok: true, value: value };
  }

  // sample: {name, paragraphs:[{dir,text}], expected:[{type,para,start,end?}],
  //          anchors:[{para,label,start,end}]}
  function validateSample(sample) {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
      return err(400, "invalid_sample", "样例必须是对象");
    }
    var nc = validateSampleName(sample.name);
    if (!nc.ok) return nc;

    var paras = sample.paragraphs;
    if (!Array.isArray(paras) || !paras.length) {
      return err(400, "invalid_paragraphs", "样例至少要包含一个段落");
    }
    if (paras.length > LIMITS.SAMPLE_PARAS_MAX) {
      return err(400, "too_many_paragraphs", "单个样例不能超过 " + LIMITS.SAMPLE_PARAS_MAX + " 段");
    }
    var normParas = [];
    for (var pi = 0; pi < paras.length; pi++) {
      var pp = paras[pi];
      if (!pp || typeof pp.text !== "string") {
        return err(400, "invalid_paragraph", "第 " + (pi + 1) + " 段文本必须是字符串");
      }
      if (cpLen(pp.text) > LIMITS.PARA_MAX_CHARS) {
        return err(413, "paragraph_too_large", "第 " + (pi + 1) + " 段超过长度上限");
      }
      normParas.push({ dir: DIRS.hasOwnProperty(pp.dir) ? pp.dir : "auto", text: pp.text });
    }

    var expected = [];
    (Array.isArray(sample.expected) ? sample.expected : []).forEach(function (e) {
      if (!e || !TYPE_LABELS_ZH[e.type]) return;
      if (!isInt(e.para) || e.para < 1 || e.para > normParas.length) return;
      if (!isInt(e.start) || e.start < 0) return;
      var paraLen = cpLen(normParas[e.para - 1].text);
      if (e.start > paraLen) return;
      var end2 = isInt(e.end) && e.end >= e.start ? Math.min(e.end, paraLen) : Math.min(e.start + 1, paraLen);
      expected.push({ type: e.type, para: e.para, start: e.start, end: end2 });
    });

    var anchors = [];
    (Array.isArray(sample.anchors) ? sample.anchors : []).forEach(function (a) {
      if (!a || typeof a.label !== "string") return;
      var label = a.label.trim();
      if (!label || cpLen(label) > LIMITS.LABEL_MAX_CHARS) return;
      if (!isInt(a.para) || a.para < 1 || a.para > normParas.length) return;
      if (!isInt(a.start) || !isInt(a.end) || a.start < 0 || a.end < a.start) return;
      var pLen = cpLen(normParas[a.para - 1].text);
      if (a.end > pLen) return;
      anchors.push({ para: a.para, label: label, start: a.start, end: a.end });
    });

    return {
      ok: true,
      value: {
        name: nc.value,
        paragraphs: normParas,
        expected: expected,
        anchors: anchors
      }
    };
  }

  // 视觉锚点指纹：对 anchors 中的每个锚点，记录其字素簇在当前渲染顺序中的
  // 视觉位置序列；任一锚点位置变化即渲染顺序变化。
  function anchorFingerprint(sample) {
    var fps = [];
    sample.paragraphs.forEach(function (p, idx) {
      var res = resolveParagraph(p.text, p.dir);
      var gClusters = res.clusters;
      // 视觉顺序：每个视觉位置上的逻辑簇下标
      var visualGiSeq = res.order.map(function (o) { return o.gi; });
      var relevant = sample.anchors.filter(function (a) { return a.para === idx + 1; });
      if (!relevant.length) return;
      relevant.forEach(function (a) {
        var gA = clusterIndexAt(gClusters, a.start);
        var gB = clusterIndexAt(gClusters, Math.max(a.end - 1, a.start));
        // 记录锚点簇“在视觉序列中依次出现的位置”，真正反映屏幕顺序
        var positions = {};
        visualGiSeq.forEach(function (gi, vi) { positions[gi] = vi; });
        var seq = [];
        for (var g = gA; g <= gB; g++) {
          seq.push(gClusters[g] ? positions[g] : -1);
        }
        // 同时记录按视觉顺序读出的簇下标序列（两者结合可捕捉顺序变化）
        var visualReadout = visualGiSeq.filter(function (gi) {
          return gi >= gA && gi <= gB;
        });
        fps.push(a.label + ":" + seq.join(",") + "|" + visualReadout.join(","));
      });
    });
    return fnv1a(fps.join("|"));
  }

  function clusterIndexAt(clusters, cpIndex) {
    // 码点偏移 → 包含该偏移的字素簇下标
    var lo = 0, hi = clusters.length - 1;
    if (cpIndex <= 0) return 0;
    for (var i = 0; i < clusters.length; i++) {
      if (cpIndex >= clusters[i].start && cpIndex < clusters[i].end) return i;
    }
    return clusters.length - 1;
  }

  /* ---------- 回归比对 ---------- */

  // 对单个样例重新诊断并与保存的预期/锚点比对。
  // 绝不修改任何外部数据。返回：
  // {sampleId, name, status, added:[], disappeared:[], moved:[], orderChanged, current:[...]}
  function recheckSample(sample) {
    var vc = validateSample(sample);
    if (!vc.ok) return { sampleId: sample.id || null, name: sample.name || "",
                         status: "invalid_sample", error: vc.message };
    var v = vc.value;
    var report = diagnose(v.paragraphs);
    var current = report.issues;

    // 与 expected 比对
    var consumedCurrent = new Array(current.length).fill(false);
    var disappeared = [], moved = [];

    v.expected.forEach(function (exp) {
      // 同类型 + 同段：优先精确位置，其次最近距离
      var exact = -1, near = -1, nearDist = Infinity;
      current.forEach(function (c, idx) {
        if (consumedCurrent[idx]) return;
        if (c.type !== exp.type || c.para !== exp.para) return;
        if (c.start === exp.start) exact = idx;
        var d = Math.abs(c.start - exp.start);
        if (d < nearDist) { nearDist = d; near = idx; }
      });
      if (exact !== -1) { consumedCurrent[exact] = true; return; }
      if (near !== -1 && nearDist > 0) {
        consumedCurrent[near] = true;
        moved.push({ type: exp.type, para: exp.para,
                     oldStart: exp.start, newStart: current[near].start });
      } else {
        disappeared.push({ type: exp.type, para: exp.para, start: exp.start });
      }
    });

    var added = [];
    current.forEach(function (c, idx) {
      if (consumedCurrent[idx]) return;
      added.push({ type: c.type, para: c.para, start: c.start, end: c.end });
    });

    var currentAnchorFp = anchorFingerprint(v);
    var orderChanged = sample.anchorFp != null && sample.anchorFp !== currentAnchorFp;

    var status;
    if (added.length && (disappeared.length || moved.length)) status = "mixed";
    else if (added.length) status = "new";
    else if (disappeared.length) status = "disappeared";
    else if (moved.length) status = "moved";
    else if (orderChanged) status = "render_changed";
    else status = "unchanged";

    return {
      sampleId: sample.id, name: v.name, status: status,
      added: added, disappeared: disappeared, moved: moved,
      orderChanged: orderChanged,
      anchorFp: currentAnchorFp,
      issueCount: current.length
    };
  }

  function recheckAll(samples) {
    return (samples || []).map(recheckSample);
  }

  // 汇总批量回归结果
  function summarizeRecheck(results) {
    var s = { unchanged: 0, new: 0, disappeared: 0, moved: 0,
              render_changed: 0, mixed: 0, invalid_sample: 0, total: results.length };
    results.forEach(function (r) { s[r.status] = (s[r.status] || 0) + 1; });
    return s;
  }

  /* ================= 记录（报告/修复/撤销结果）校验 ================= */

  function validateRecord(rec) {
    if (!rec || typeof rec !== "object") return err(400, "invalid_record", "记录必须是对象");
    if (!rec.kind || ["report", "repair", "undo"].indexOf(rec.kind) === -1) {
      return err(400, "invalid_kind", "记录类别必须是 report/repair/undo");
    }
    if (rec.note && (typeof rec.note !== "string" || cpLen(rec.note) > LIMITS.NOTE_MAX_CHARS)) {
      return err(400, "note_too_long", "备注不能超过 " + LIMITS.NOTE_MAX_CHARS + " 字符");
    }
    return { ok: true };
  }

  /* ================= 导出 ================= */

  return {
    LIMITS: LIMITS,
    DIRS: DIRS,
    IT: IT, SEV: SEV, FK: FK,
    TYPE_LABELS_ZH: TYPE_LABELS_ZH,
    FIX_LABELS_ZH: FIX_LABELS_ZH,
    // 基础
    cpLen: cpLen, cpArray: cpArray, cpSlice: cpSlice,
    hex4: hex4, fnv1a: fnv1a, nowISO: nowISO,
    // 名称 / 类型
    cpName: cpName, bidiType: bidiType, generalCategory: generalCategory,
    formattingOf: formattingOf,
    isBracket: function (c) { return !!OPEN_TO_CLOSE[c] || !!CLOSE_TO_OPEN[c]; },
    // 字素
    segmentGraphemes: segmentGraphemes,
    clusterIndexAt: clusterIndexAt,
    // UAX #9
    resolveParagraph: resolveParagraph,
    // 诊断
    diagnose: diagnose,
    // 指纹
    contentFingerprint: contentFingerprint,
    renderFingerprint: renderFingerprint,
    // 修复
    buildPlan: buildPlan,
    applySuggestions: applySuggestions,
    visualSpanFor: visualSpanFor,
    // 样例
    validateSample: validateSample,
    validateSampleName: validateSampleName,
    anchorFingerprint: anchorFingerprint,
    recheckSample: recheckSample,
    recheckAll: recheckAll,
    summarizeRecheck: summarizeRecheck,
    // 记录
    validateRecord: validateRecord
  };
});
