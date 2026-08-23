/**
 * 生成后机械 lint：讲义 markdown → 5 项指标 → 越界清单 → 定向改写指令。
 *
 * 规格与全部阈值的出处：`docs/03-design/adaptation-lint-spec-20260811.md`
 * 校准参考实现（对拍基准，同一批 54 份资源上逐项一致）：
 * `apps/agent-engine/scripts/calibrate_adaptation_lint.py --zone own`
 *
 * **作用域（2026-08-11 口径修订）**：这一层只对**模型自撰区**负责。lint 跑在摘录注入
 * 之前（scene-generator 里 md 刚生成、`{{摘录:id}}` 还是占位符），它物理上看不见教材
 * 摘录，改写 prompt 也明令摘录原样保留。摘录区的形态越界归检索侧的机械上限管，
 * 不在这里。第一版阈值是在**注入后**的成品上校准的（摘录占全文中位 54%），
 * 输入形态错配，已按自撰区口径全部重校准——两版数字不可比。
 *
 * 为什么是「脚本找错、模型改错」而不是让模型自评：Tyen et al. 2311.08516 把自我修订
 * 拆成找错/改错分别测——模型找错很差，给了位置就改得对；IFEval 2311.07911 的设计
 * 原则是能用代码判的指令别让模型判。所以这一层只负责把「找错」从模型手里拿走。
 *
 * 本文件是纯函数：无 LLM、无 IO、无副作用。阈值集中在 RULES 一处。
 * 改任何一个阈值之前先重跑校准脚本（规格 §2.6：n=54、无留出集，阈值全部出自这批数据）。
 */

import wordlists from './data/adaptation-terms.json';
import aiTellData from './data/ai-tells.json';
import { decompressionCoverage } from './decompression';

/** 讲解姿态档。L1=beginner，L2=transition，L3=advanced（与评测 rubric 三档同名）。 */
export type Tier = 'L1' | 'L2' | 'L3';
/** 违规落点：模型自撰区可改写，教材摘录区改不了（自查 prompt 明令原样保留）。 */
export type Zone = 'own' | 'excerpt';
/** A = 触发一次定向改写调用；B = 只记警告，0 调用。 */
export type ViolationClass = 'A' | 'B';

export interface CodeBlock {
  first: number;
  last: number;
  codeLines: number;
  commentUnits: number;
  ratio: number;
  /** 注释比只在 ≥3 行的块上有意义（1 行代码配 1 条注释 = 1.00 是纯噪声）。 */
  ratioOk: boolean;
  excerpt: boolean;
  /** 块里出现 import / def / class / 装饰器时，记下第一处原文（没有则空串）。 */
  beyondBeginnerForm: string;
}

/**
 * 入门段不出现的代码结构。**判据是外部教材量出来的，不是自拟阈值**
 * （`apps/agent-engine/scripts/experiments/textbook_code_ladder.py` 可复算，九份语料）：
 *
 * | 档 | 外部锚 | 行中位 | import | def | class |
 * |---|---|---|---|---|---|
 * | L1 | 蟒蛇书 1-6 章（129 文件） | 4 | **0%** | **0%** | **0%** |
 * | L2 | 蟒蛇书全书（563 文件） | 10 | 57% | 31% | 25% |
 * | L3 | 鱼书 / 从零构建 / tiny-universe | 68-140 | 95%+ | 81%+ | 33-61% |
 *
 * 九份语料里入门段是唯一三项全 0 的一档，而且是断崖。所以「零基础能读的代码」
 * 的分界不只是长度——3 行的 `import numpy` + `def f():` 比 5 行 print 序列难得多。
 *
 * 2026-08-13 实测：摘录侧加了同源的结构闸之后，自撰区仍然写出 `import numpy as np`、
 * `import math`、`def distance(a, b):`——L1 指令里「不引入未讲过的语法或库」是文字要求，
 * 机械层不查就压不住。这条规则补的就是这一处。
 */
const BEYOND_BEGINNER_CODE_RE = /^\s*(?:from\s+\S+\s+import\s|import\s|def\s|class\s|@\w)/;

export interface TermHit {
  term: string;
  pos: number;
  line: number;
}

/**
 * 「AI 味」词表。**每个词进表的资格由真实中文教材语料判定，不是我们挑的**
 * （`apps/agent-engine/scripts/experiments/textbook_prose_ladder.py --emit-lint` 可复算）：
 * 候选词在 43.8 万汉字的中文教材（d2l-zh / Happy-LLM / tiny-universe / 笨办法学 Python）
 * 里出现 **0 次** 才进表；教材自己在用的一律剔除。
 *
 * 这一关不是形式。92 个候选里 37 个被教材救下来——包括「魔法」「精髓」「强大的」
 * 「恭喜你」「想象一下」「至关重要」「本质上」。按直觉禁它们就是误伤：
 * d2l 原文写「不幸的是，这种魔法并不适用于每一层」，Happy-LLM 写「本系统的一部分精髓」。
 * 上一批我们在导学 prompt 里拍过一条「一句不超过 40 字」，无出处，已撤；这一层不重犯。
 *
 * 顺带否掉了两条本来想加的判据：
 * - **句长上限**：我们的讲义句长 P90=41 / P99=56，教材是 43-63 / 66-120，我们本来就更短
 * - **破折号密度**：讲义 0.00-0.03 每千字，教材 0.07-0.44，也没超
 * 讲义侧行文的统计形态并不比教材差，AI 味集中在词，所以只留词表这一条。
 */
const AI_TELLS: string[] = [...aiTellData.aiTells].sort((a, b) => b.length - a.length);

/**
 * 正文形态的两条外部锚，都是 2026-08-13 拿四本真实中文教材（43.9 万汉字）
 * 与我们已生成的 165 页对照量出来的（`scripts/experiments/lecture_body_audit.py`）：
 *
 * | | 我们 | 教材 P90 | 教材 P95 |
 * |---|---|---|---|
 * | 一页不同术语数 | 中位 5 / P90 11 | 6 | 8 |
 * | 段落汉字 | 中位 69 / P90 133 | 66 | 104 |
 *
 * 阈值取 **P95** 而不是 P90：P90 会让 42% 的页、52% 的段落越界，
 * 那种命中率的规则读不出信号；P95 是 29% 与 22%，还能指出真正的长尾。
 * 提示词端按 P90 写目标（预防），这一层按 P95 记警告（观测）——两层不同用途。
 *
 * 都是 **B 类**：概念太多这件事改写修不了（删不掉内容），只能回生成侧重写。
 */
const TEXTBOOK_TERMS_P95 = 8;
const TEXTBOOK_PARA_CJK_P95 = 104;

/**
 * 段落**中位数**的目标区间：教材 2000 个段落的 P25–P75 = 19–41 汉字（中位 27）。
 *
 * 为什么要下界：这条规则第一版只写了上限，2026-08-13 用新提示词跑一门课复测，
 * 段落中位从 69 掉到 **13**——正好压在教材的 P10，每句一段，同样读不成文章。
 * **给单边上界，模型就往下顶死。** 上下界一起给才守得住。
 *
 * 判的是整页的**中位数**不是逐段：教材里 27% 的段落短于 20 字，那是用来断节奏的，
 * 逐段卡下界会把正常的短句报成违规。
 */
const TEXTBOOK_PARA_MEDIAN_LO = 19;
const TEXTBOOK_PARA_MEDIAN_HI = 41;

/** 带模糊限定/效果动词的数字 = 对世界的声称，需要出处。示例参数不算。 */
const CLAIM_HEDGE = '可能|大约|约|高达|接近|通常|一般|往往|普遍|典型|平均|提升|下降|降低|提高|增加|减少|加快|超过';
const CLAIM_NUM = String.raw`\d+\.\d+%?|\d+%|\d+\s*(?:倍|万|亿|ms|MB|GB|KB|tokens?|维)`;
// 限定词与数字之间最多隔 20 个字符，且不许跨句、不许跨行——跨了就不是同一个断言。
const CLAIM_HEDGE_RE = new RegExp(
  `(?:${CLAIM_HEDGE})[^。！？\\n]{0,20}?(?:${CLAIM_NUM})`,
  'g',
);

/** M1–M5 与定位所需的中间量。字段名对应规格 §1.1 的指标编号。 */
export interface AdaptationMetrics {
  /** M1 全文最小代码块注释比（仅 ≥3 行的块），无合格块为 null */
  codeMinCommentRatio: number | null;
  /** M1 自撰区口径 */
  codeMinCommentRatioOwn: number | null;
  /** M2 代码行数合计 */
  codeLines: number;
  /** M2 的逐块读数：最长代码块行数 */
  codeMaxBlock: number;
  /** M3 不同术语数 / 中文字数 × 100 */
  uniqTermPer100: number;
  /** M4 裸符号（代码用了、散文没交代）去重个数，两区合计 */
  bareSymbolN: number;
  /** M4 自撰区口径 */
  bareSymbolOwn: number;
  /** M5 生产域词密度 − 生活域词密度（每千字） */
  domainSkew: number;

  /** 自撰散文区命中的 AI 味词（教材零命中词表），按出现顺序 */
  aiTells: TermHit[];

  /** 自撰散文区里超长的段落（汉字数），按出现顺序 */
  longParagraphs: Array<{ line: number; cjk: number }>;

  /** 自撰散文段落长度的中位数（汉字）。段落数不足 4 段时为 null——样本太小不判。 */
  paraMedianCjk: number | null;

  /**
   * 带模糊限定的**声称数字**（「余弦值可能高达 0.85」这类），自撰区口径。
   * 示例参数（「温度设成 2.0」）不算——那本来就不需要出处。
   */
  claimNumbers: Array<{ line: number; text: string }>;

  /**
   * 解压覆盖率（设计稿 §5.4 的 L0）：本页用到的术语里，有多少是**这一页自己交代过**的。
   *
   * 口径是 `known = ∅`——不带画像，只问「这页自足吗」。带画像的口径要把已掌握概念
   * 传进来，那需要把画像穿到 lint 这一层，本轮没做（lint 的入参只有 text 与 tier）。
   * 对 L1 来说 known=∅ 恰好是诚实的最坏情况：零基础读者的字典本来就近乎空的。
   */
  decompression: { coverage: number; uncovered: string[]; terms: number };

  cjkChars: number;
  blocks: CodeBlock[];
  terms: TermHit[];
  bare: Record<Zone, string[]>;
  firstProdWord: { word: string; line: number } | null;
  /** 围栏数为奇数（摘录裁剪的产物），结构告警 */
  fenceUnbalanced: boolean;
}

export interface Violation {
  ruleId: string;
  /** null = 没有画像通道，只跑与档位无关的那几条 */
  tier: Tier | null;
  cls: ViolationClass;
  zone: Zone;
  /** 1-based 行号；0 = 全文级违规（如代码总行数不足） */
  line: number;
  value: number;
  threshold: number;
  /** 原文片段（§7.4 要求的留痕字段） */
  quote: string;
  /** 塞进改写 prompt 的完整一条（含行号与数值） */
  message: string;
  /** 二选一改法。只说一条死路会让模型把内容删空或让篇幅爆掉（规格 §3.3.3） */
  fix: string;
}

export interface LintReport {
  tier: Tier | null;
  metrics: AdaptationMetrics;
  violations: Violation[];
  /** A 类：进改写 prompt */
  a: Violation[];
  /** B 类：只落日志（摘录区改不了、素材不够硬不是改写能解决的） */
  b: Violation[];
}

// ─────────────────────────────────────────────────────────── 字符与分词工具

const CJK_RE = /[一-鿿]/;
const CJK_G = /[一-鿿]/g;

/**
 * Python `\w`（unicode 口径）的近似：字母/数字/下划线，含中日韩。
 * JS 的 `\w` 只认 ASCII，直接用会让「torch是一个库」这种紧贴中文的提及被误判成
 * 没提及过（Python 侧 `\b` 在 'h' 与 '是' 之间不成立）。参考实现按 Python 口径写，
 * 这里必须跟着走，否则 M4 对不上。
 */
function isWordChar(ch: string): boolean {
  if (ch === '_' || (ch >= '0' && ch <= '9')) return true;
  if (CJK_RE.test(ch)) return true;
  return ch.toLowerCase() !== ch.toUpperCase();
}

/** 逐码点小写，长度变化的字符（İ 之类）保持原样——索引必须与原串对齐。 */
function safeLower(s: string): string {
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

function countCjk(s: string): number {
  return (s.match(CJK_G) ?? []).length;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PROD_RE = new RegExp(wordlists.productionDomain.map(escapeRe).join('|'), 'g');
const LIFE_RE = new RegExp(wordlists.lifeDomain.map(escapeRe).join('|'), 'g');

/** 长词优先，避免「注意力」在「自注意力」里重复计数。等长按原表顺序（稳定）。 */
const TERMS: string[] = Array.from(new Set(wordlists.terms))
  .map((t, i) => ({ t, i }))
  .sort((x, y) => y.t.length - x.t.length || x.i - y.i)
  .map((x) => x.t);

// ─────────────────────────────────────────────────────────── 分区

interface Row {
  no: number;
  raw: string;
  zone: 'prose' | 'code' | 'formula';
  excerpt: boolean;
}

/** 代码行判据：去掉行内注释后无中文，且命中代码结构记号。 */
const CODE_HINT_RE =
  /^\s*(import |from |def |class |return |print\(|if |for |while |with |try:|except|@)|[A-Za-z_\])]\s*=[^=]|[A-Za-z_]\w*\s*\(|^\s{2,}\S/;

/** 生成期的摘录还是占位符（`{{摘录:id}}`），渲染后才是 `📖 … —— 摘自`。两种都当摘录区。 */
const EXCERPT_PLACEHOLDER_LINE = /\{\{\s*摘录\s*[:：]\s*([A-Za-z0-9_#-]+)\s*\}\}/;

/**
 * 逐行打区：excerpt（教材摘录，改写环无权动）/ formula / code / prose。
 * 本库大多数代码没有围栏（b1-gradient、b2-attention 都是裸行），只认围栏会漏一大半。
 */
function segment(text: string): Row[] {
  const rows: Row[] = text.split('\n').map((raw, i) => ({
    no: i + 1,
    raw,
    zone: 'prose' as const,
    excerpt: false,
  }));

  let inEx = false;
  for (const r of rows) {
    if (r.raw.includes('📖')) inEx = true;
    if (inEx || EXCERPT_PLACEHOLDER_LINE.test(r.raw)) r.excerpt = true;
    if (r.raw.replace(/^\s+/, '').startsWith('—— 摘自')) inEx = false;
  }

  let inMath = false;
  let inFence = false;
  for (const r of rows) {
    const s = r.raw.trim();
    if (s.startsWith('```')) {
      r.zone = 'code';
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      r.zone = 'code';
      continue;
    }
    if (s === '$$') {
      r.zone = 'formula';
      inMath = !inMath;
      continue;
    }
    if (inMath) r.zone = 'formula';
  }

  // 裸代码行；纯注释行（`# ...` 单独成行）靠邻接确认，与参考实现一样就地顺序判定
  const pending = new Set<number>();
  for (const r of rows) {
    if (r.zone !== 'prose' || !r.raw.trim()) continue;
    const hash = r.raw.indexOf('#');
    const codePart = hash < 0 ? r.raw : r.raw.slice(0, hash);
    const commentPart = hash < 0 ? '' : r.raw.slice(hash + 1);
    if (codePart.trim() && !CJK_RE.test(codePart) && CODE_HINT_RE.test(codePart)) {
      r.zone = 'code';
    } else if (!codePart.trim() && commentPart.trim()) {
      pending.add(r.no);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (!pending.has(rows[i].no)) continue;
    const near = [rows[i - 1], rows[i + 1]].filter(Boolean);
    rows[i].zone = near.some((n) => n.zone === 'code' && !pending.has(n.no)) ? 'code' : 'prose';
    if (rows[i].zone === 'code') pending.delete(rows[i].no);
  }
  return rows;
}

/** 连续 code 行成块，容忍块内一行空行（a2-attention 的 import 后有一行空白）。 */
function codeBlocks(rows: Row[]): CodeBlock[] {
  const groups: Row[][] = [];
  let cur: Row[] = [];
  let gap = 0;
  for (const r of rows) {
    if (r.zone === 'code') {
      gap = 0;
      cur.push(r);
    } else if (cur.length && !r.raw.trim() && gap === 0) {
      gap = 1;
    } else {
      if (cur.length) groups.push(cur);
      cur = [];
      gap = 0;
    }
  }
  if (cur.length) groups.push(cur);

  const out: CodeBlock[] = [];
  for (const g of groups) {
    let codeN = 0;
    let commentN = 0;
    let beyond = '';
    for (const r of g) {
      const s = r.raw.trim();
      if (s.startsWith('```')) continue;
      if (s.startsWith('#') || s.startsWith('//')) {
        commentN += 1;
        continue;
      }
      if (!s) continue;
      codeN += 1;
      if (!beyond && BEYOND_BEGINNER_CODE_RE.test(r.raw)) beyond = s;
      const hash = s.indexOf('#');
      if (hash >= 0 && s.slice(hash + 1).trim()) commentN += 1;
    }
    if (codeN === 0) continue;
    out.push({
      first: g[0].no,
      last: g[g.length - 1].no,
      codeLines: codeN,
      commentUnits: commentN,
      ratio: commentN / codeN,
      ratioOk: codeN >= 3,
      excerpt: g.some((r) => r.excerpt),
      beyondBeginnerForm: beyond,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────── 术语 / 句子 / 裸符号

function lineOf(text: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') n += 1;
  return n;
}

/** 首现术语扫描（长词优先掩码）。 */
function scanTerms(text: string): TermHit[] {
  const mask = new Uint8Array(text.length);
  const low = safeLower(text);
  const hits: TermHit[] = [];
  for (const term of TERMS) {
    const needle = safeLower(term);
    let start = 0;
    for (;;) {
      const i = low.indexOf(needle, start);
      if (i < 0) break;
      let free = true;
      for (let k = i; k < i + term.length; k++) {
        if (mask[k]) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let k = i; k < i + term.length; k++) mask[k] = 1;
        hits.push({ term, pos: i, line: lineOf(text, i) });
        break;
      }
      start = i + 1;
    }
  }
  return hits.sort((a, b) => a.pos - b.pos);
}

/**
 * 只留自撰散文：摘录区（教材原文，改写环无权动）、代码区、公式区全部抹成同长空白。
 * 抹而不删是为了行号与 pos 仍与原文对齐。
 *
 * 抹代码区不是可选项——实测 t2-prompt-engineering 的「太棒了」整句在 Python 提示词
 * 字符串里（`示例 1：输入：这电影太棒了。输出：正`），那是**素材**不是行文，抓它是误报。
 */
function ownProseOnly(rows: Row[]): string {
  return rows
    .map((r) => (r.excerpt || r.zone !== 'prose' ? ' '.repeat(r.raw.length) : r.raw))
    .join('\n');
}

/** AI 味词扫描：长词优先掩码，逐词只记首现（同一个口癖报一次就够改写定位了）。 */
function scanAiTells(masked: string): TermHit[] {
  const mask = new Uint8Array(masked.length);
  const hits: TermHit[] = [];
  for (const term of AI_TELLS) {
    for (let i = masked.indexOf(term); i >= 0; i = masked.indexOf(term, i + 1)) {
      let free = true;
      for (let k = i; k < i + term.length; k++) if (mask[k]) { free = false; break; }
      if (!free) continue;
      for (let k = i; k < i + term.length; k++) mask[k] = 1;
      hits.push({ term, pos: i, line: lineOf(masked, i) });
      break;
    }
  }
  return hits.sort((a, b) => a.pos - b.pos);
}

const BUILTIN = new Set(
  `print len range int str float list dict set tuple enumerate zip open sum max min abs
   type format sorted map filter round bool input any all isinstance super repr id next iter
   Step self`.split(/\s+/),
);
const KEYWORD = new Set(
  `if elif else for while with try except finally return def class import from as in is
   not and or None True False lambda pass raise yield global assert del`.split(/\s+/),
);

/** `\b[A-Za-z_]\w*` 的逐字符实现（`\w` 走 Python 口径，见 isWordChar）。 */
function scanIdentifiers(code: string): Array<{ name: string; end: number }> {
  const out: Array<{ name: string; end: number }> = [];
  for (let i = 0; i < code.length; i++) {
    if (!/[A-Za-z_]/.test(code[i])) continue;
    if (i > 0 && isWordChar(code[i - 1])) continue;
    let j = i + 1;
    while (j < code.length && isWordChar(code[j])) j++;
    out.push({ name: code.slice(i, j), end: j });
    i = j - 1;
  }
  return out;
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function mentionedInProse(sym: string, prose: string, proseLow: string): boolean {
  const needle = safeLower(sym);
  for (let i = proseLow.indexOf(needle); i >= 0; i = proseLow.indexOf(needle, i + 1)) {
    const before = i > 0 ? prose[i - 1] : '';
    const after = i + needle.length < prose.length ? prose[i + needle.length] : '';
    if (!(before && isWordChar(before)) && !(after && isWordChar(after))) return true;
  }
  return false;
}

/**
 * 代码里用了、散文里从没交代过的外部符号（库名 / 未定义的调用名）。
 * 按区分别计数：摘录区的漏项改写不了，只能换素材。
 */
function bareSymbols(rows: Row[]): Record<Zone, string[]> {
  const prose = rows
    .filter((r) => r.zone !== 'code')
    .map((r) => r.raw)
    .join('\n');
  const proseLow = safeLower(prose);
  const out: Record<Zone, string[]> = { own: [], excerpt: [] };

  for (const scope of ['own', 'excerpt'] as Zone[]) {
    const codeRows = rows.filter((r) => r.zone === 'code' && r.excerpt === (scope === 'excerpt'));
    const code = codeRows.map((r) => r.raw).join('\n');
    const syms = new Set<string>();
    const local = new Set<string>();

    for (const line of codeRows.map((r) => r.raw)) {
      const im = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(line);
      if (im) syms.add(im[1].split('.')[0]);
      const fr = /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(line);
      if (fr) {
        syms.add(fr[1].split('.')[0]);
        for (const raw of fr[2].split(',')) {
          const name = raw.trim();
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) syms.add(name);
        }
      }
      const df = /^\s*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (df) local.add(df[1]);
      const asg = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/.exec(line);
      if (asg) local.add(asg[1]);
    }

    for (const tok of scanIdentifiers(code)) {
      // `x.y(` → 记根标识符 x
      if (code[tok.end] === '.') {
        let k = tok.end + 1;
        while (k < code.length && isWordChar(code[k])) k++;
        if (k > tok.end + 1 && code[skipSpace(code, k)] === '(') syms.add(tok.name);
      }
      // `y(` → 记调用名 y
      if (code[skipSpace(code, tok.end)] === '(') syms.add(tok.name);
    }

    out[scope] = [...syms]
      .filter(
        (s) =>
          s.length > 1 &&
          !BUILTIN.has(s) &&
          !KEYWORD.has(s) &&
          !local.has(s) &&
          !mentionedInProse(s, prose, proseLow),
      )
      .sort();
  }
  return out;
}

// ─────────────────────────────────────────────────────────── 指标

export function computeAdaptationMetrics(text: string): AdaptationMetrics {
  const rows = segment(text);
  const blocks = codeBlocks(rows);
  const cjk = countCjk(text);
  const perK = Math.max(cjk, 1) / 1000;
  const perH = Math.max(cjk, 1) / 100;

  const terms = scanTerms(text);
  const own = blocks.filter((b) => !b.excerpt);
  const ratioOf = (list: CodeBlock[]): number | null => {
    const vals = list.filter((b) => b.ratioOk).map((b) => b.ratio);
    return vals.length ? Math.min(...vals) : null;
  };
  const prod = (text.match(PROD_RE) ?? []).length / perK;
  const life = (text.match(LIFE_RE) ?? []).length / perK;
  const bare = bareSymbols(rows);

  PROD_RE.lastIndex = 0;
  const firstProd = PROD_RE.exec(text);
  PROD_RE.lastIndex = 0;

  return {
    codeMinCommentRatio: ratioOf(blocks),
    codeMinCommentRatioOwn: ratioOf(own),
    codeLines: blocks.reduce((n, b) => n + b.codeLines, 0),
    codeMaxBlock: blocks.reduce((n, b) => Math.max(n, b.codeLines), 0),
    aiTells: scanAiTells(ownProseOnly(rows)),
    longParagraphs: (() => {
      const out: Array<{ line: number; cjk: number }> = [];
      for (const r of rows) {
        if (r.excerpt || r.zone !== 'prose') continue;
        const n = countCjk(r.raw);
        if (n > TEXTBOOK_PARA_CJK_P95) out.push({ line: r.no, cjk: n });
      }
      return out;
    })(),
    paraMedianCjk: (() => {
      // 空行与不成句的碎片（<10 汉字）不算段落——它们是排版产物不是行文
      const lens = rows
        .filter((r) => !r.excerpt && r.zone === 'prose')
        .map((r) => countCjk(r.raw))
        .filter((n) => n >= 10)
        .sort((a, b) => a - b);
      if (lens.length < 4) return null;
      const mid = Math.floor(lens.length / 2);
      return lens.length % 2 ? lens[mid] : Math.round((lens[mid - 1] + lens[mid]) / 2);
    })(),
    claimNumbers: (() => {
      const masked = ownProseOnly(rows);
      const out: Array<{ line: number; text: string }> = [];
      CLAIM_HEDGE_RE.lastIndex = 0;
      for (let m = CLAIM_HEDGE_RE.exec(masked); m; m = CLAIM_HEDGE_RE.exec(masked)) {
        out.push({ line: lineOf(masked, m.index), text: m[0].trim() });
      }
      CLAIM_HEDGE_RE.lastIndex = 0;
      return out;
    })(),
    decompression: (() => {
      const own = ownProseOnly(rows);
      const r = decompressionCoverage(own);
      return { coverage: r.coverage, uncovered: r.uncovered, terms: r.terms.length };
    })(),
    uniqTermPer100: terms.length / perH,
    bareSymbolN: bare.own.length + bare.excerpt.length,
    bareSymbolOwn: bare.own.length,
    domainSkew: prod - life,
    cjkChars: cjk,
    blocks,
    terms,
    bare,
    firstProdWord: firstProd ? { word: firstProd[0], line: lineOf(text, firstProd.index) } : null,
    fenceUnbalanced: (text.match(/^\s*```/gm) ?? []).length % 2 === 1,
  };
}

// ─────────────────────────────────────────────────────────── 规则表（唯一阈值来源）

/**
 * 规格 §3.2。阈值来源标注：〔锚〕外部依据（rubric 明文 / 文献）· 〔带〕本档命中样本参照带。
 * 标〔护栏〕的规则在校准快照上一次都没触发过，留着是为了档位对称。
 *
 * **全部数字出自 `--zone own`（剥掉摘录后的自撰区），与第一版不可比。** 变的不只是数字：
 * 旧口径下 L2 的三条规则里两条在真实输入上恒不触发，L3-THIN-CODE 反过来误触发 10/13，
 * 因为它们量的是摘录里的东西。
 *
 * A = 定向改写（+1 次调用），B = 只记警告。〔带〕类 A 规则一律取「本档命中样本的观测
 * 边界」，也就是**在判官认可的样本上零触发**——A 类要花钱，不许拿它去博召回。
 */
export const THRESHOLDS = {
  L1_TERM_PER100: 2.3, // 〔带〕本档命中样本最大观测 2.203，上取整（旧口径 1.68 → 1.7）
  L1_BARE_OWN: 2, // 〔锚〕rubric 明文是 0，放到 2 给缩写留余量。不以分档信号名义留用：M4 sep 0.47
  L1_DOMAIN_SKEW: 1.0, // 〔带〕本档命中样本最大观测 0.00
  L1_CODE_RATIO: 0.8, // 〔锚〕Riehle ICSE'09 开源注释比 0.187±0.109，0.8 = 逐行注释
  L1_CODE_MAX_BLOCK: 5, // 〔锚〕rubric v2 明文「≤5 行」
  L2_OWN_RATIO: 0.8, // 〔带〕本档命中样本 P90 = 0.733，取 0.8 留余量
  L2_HARD_SKEW: 6.5, // 〔带〕本档命中样本最大观测 6.452，上取整
  L3_OWN_RATIO: 0.25, // 〔带〕本档命中样本最大观测 0.25
  L3_SOFT_SKEW: 0, // 语义边界：生活域词压过生产域词。本档命中样本最小观测 2.833
  L3_THIN_SKEW: 2.8, // 〔带〕本档命中样本最小观测 2.833，下取整（旧口径 1.85 → 1.7）
} as const;

const TIER_LABEL: Record<Tier, string> = {
  L1: '零基础（不会编程）',
  L2: '转行者（会编程、无 AI 背景）',
  L3: '进阶（有实战经验）',
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

function v(x: Omit<Violation, 'tier'>, tier: Tier | null): Violation {
  return { ...x, tier };
}

/** L1/L2/L3 各自的规则。每条只在本档跑——没有一个指标能同时管住两条边界（规格 §2.1）。 */
/**
 * 提示词脚手架泄漏：模型把内部规划标签写进了正文。
 *
 * 线上实锤（PLC 课屏 4）：四段逐字渲染「**本段目标：……**」加粗领句。
 * grep 提示词里没有这个词——不是模板漏了变量，是**模型对「每段先明确目标」
 * 这类指令的表演性服从**：把规划过程当成产物写了出来。
 *
 * 改提示词治不了（换一版模型换个说法照样写），只能机械拦。
 * 与档位无关：任何档位的教材正文里都不该出现这些标签。
 *
 * 词表只收**明确是元话语**的：「本段目标」是规划标签，「学习目标」是
 * 教材里常见的正经小节标题，不能一起拦。
 *
 * ## 词表打地鼠打不完
 *
 * 拦掉「本段目标」之后，同题对照课上模型换了马甲：4/5 屏开头变成
 * 「**导读：本段通过食堂排队类比，解释什么是……**」，屏 6 还留着「**P7:**」。
 * 词换了，行为没换——所以下面三组是**模式**不是词表：屏号编址、
 * 行首元话语标签、句内自指。
 *
 * ## 三组都量过误报
 *
 * 1704 块主语料（`knowledge_index.jsonl`）上：屏号 0、元话语标签 0、自指 0。
 * 量掉的一条记在这里免得有人再加回来——**「本节/本章 + 介绍/将」55 处（3.23%），
 * 全是教材正经写法**（「本节将讨论…」「本章介绍…」）。自指只收
 * 本段/本屏/本页/这一段/这一屏这类**屏级**词：教材不按屏组织，不会这么写。
 * 「下面这段代码会…」也踩过一次，所以「下面这段」不收。
 *
 * 新规则进这里之前先跑一遍误报，零误报才许进。
 */
const SCAFFOLD_LEAK = [
  /(?:^|\n)\s*\**\s*本段(?:目标|要点|任务|安排|重点)\s*[:：]/,
  /(?:^|\n)\s*\**\s*本节(?:目标|安排)\s*[:：]/,
  /(?:^|\n)\s*\**\s*(?:段落|写作|生成)(?:目标|计划|规划|要求)\s*[:：]/,
  /(?:^|\n)\s*\**\s*(?:第[一二三四五六七八九十]+段|下一段)\s*[:：]\s*(?:讲|写|说明)/,
  /(?:^|\n)\s*\**\s*(?:输出|回答)(?:格式|要求)\s*[:：]/,
];

/** 屏号/页号编址泄漏：「P7:」「屏 3：」——内部编址不该出现在学习者眼前。 */
const SCAFFOLD_SCREEN_NO = /(?:^|\n)\s*\**\s*(?:P|屏|页|Scene|Slide)\s*\d+\s*[:：]/;

/**
 * 行首元话语标签：「导读：」「写作思路：」这类领句。
 *
 * 只收**描述写作行为**的标签。「定义：」「注意：」「例：」「步骤：」是教材
 * 正经领句，不在名单里。
 */
const SCAFFOLD_META_LABEL =
  /(?:^|\n)\s*\**\s*(?:导读|引导语|概要|内容概要|段落概述|写作思路|讲解思路|教学设计|本段导读|承上启下)\s*[:：]/;

/**
 * 句内自指：屏级指代词 + 描述动词，例如「本段通过食堂排队类比，解释…」。
 *
 * 不限行首——换成「导读：」开头照样拦得住，这正是打地鼠打不完的那一路。
 */
const SCAFFOLD_SELF_REF =
  /(?:本段|本屏|本页|这一段|这一屏)[^。；！？\n]{0,12}?(?:通过|采用|将|会|旨在|意在|试图|带你|帮助你|介绍|讲解|解释|说明|阐述|围绕|聚焦|分析|探讨)/;

/** 正文里有没有规划标签。返回命中的那一行（去掉首尾空白），没有就返回 null。 */
export function findScaffoldLeak(text: string): { line: number; quote: string } | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const probe = '\n' + line;
    if (
      SCAFFOLD_LEAK.some((re) => re.test(probe)) ||
      SCAFFOLD_SCREEN_NO.test(probe) ||
      SCAFFOLD_META_LABEL.test(probe) ||
      SCAFFOLD_SELF_REF.test(line)
    ) {
      return { line: i + 1, quote: line.trim().slice(0, 60) };
    }
  }
  return null;
}

function rulesFor(tier: Tier | null, m: AdaptationMetrics): Violation[] {
  const out: Violation[] = [];
  const T = THRESHOLDS;

  const codeBlockViolation = (
    b: CodeBlock,
    ruleId: string,
    cls: ViolationClass,
    value: number,
    threshold: number,
    message: string,
    fix: string,
  ): Violation =>
    v(
      {
        ruleId,
        cls,
        zone: b.excerpt ? 'excerpt' : 'own',
        line: b.first,
        value: round2(value),
        threshold,
        quote: `第 ${b.first}-${b.last} 行代码块（${b.codeLines} 行，注释单元 ${b.commentUnits}）`,
        message,
        fix,
      },
      tier,
    );

  if (tier === 'L1') {
    if (m.uniqTermPer100 > T.L1_TERM_PER100) {
      const allowed = Math.floor((T.L1_TERM_PER100 * Math.max(m.cjkChars, 1)) / 100);
      const over = m.terms.slice(allowed, allowed + 6);
      const listed = over.map((t) => `${t.term}（第 ${t.line} 行）`).join('、');
      out.push(
        v(
          {
            ruleId: 'L1-TERM',
            cls: 'A',
            zone: 'own',
            line: over[0]?.line ?? 0,
            value: round2(m.uniqTermPer100),
            threshold: T.L1_TERM_PER100,
            quote: listed,
            message:
              `全文不同术语 ${m.terms.length} 个 / ${m.cjkChars} 中文字 = ` +
              `${round2(m.uniqTermPer100)} 个每百字，本档上限 ${T.L1_TERM_PER100}。` +
              `超出的首现术语按出现顺序是：${listed}。`,
            fix: '改法二选一：删掉与本页主线无关的那几个，或者给它们各补一句大白话定义并把这一段拆成两段。',
          },
          tier,
        ),
      );
    }
    if (m.bareSymbolOwn >= T.L1_BARE_OWN) {
      const syms = m.bare.own;
      const blk = m.blocks.filter((b) => !b.excerpt);
      const span = blk.length ? `第 ${blk[0].first}-${blk[blk.length - 1].last} 行` : '代码部分';
      out.push(
        v(
          {
            ruleId: 'L1-BARE',
            cls: 'A',
            zone: 'own',
            line: blk[0]?.first ?? 0,
            value: m.bareSymbolOwn,
            threshold: T.L1_BARE_OWN,
            quote: syms.join('、'),
            message:
              `${span}的代码用了 ${syms.join('、')}，全文散文部分从头到尾没有交代过` +
              `${syms.length > 1 ? '这些' : '这个'}是什么。`,
            fix: '改法二选一：在代码块前补一句大白话说明它们是什么，或者把这几行换成不依赖外部库的写法。',
          },
          tier,
        ),
      );
    }
    if (m.domainSkew > T.L1_DOMAIN_SKEW) {
      const w = m.firstProdWord;
      out.push(
        v(
          {
            ruleId: 'L1-SOFT-DOMAIN',
            cls: 'A',
            zone: 'own',
            line: w?.line ?? 0,
            value: round2(m.domainSkew),
            threshold: T.L1_DOMAIN_SKEW,
            quote: w?.word ?? '',
            message:
              `例子偏生产域（域偏置 ${round2(m.domainSkew)}，本档上限 ${T.L1_DOMAIN_SKEW}）：` +
              `第 ${w?.line ?? 0} 行的「${w?.word ?? ''}」这类词对零基础读者是完全陌生的场景。`,
            fix: '改法二选一：把这个例子整体换成日常生活场景（排队/做菜/找书），或者保留它但先用一句生活类比铺垫再引入。',
          },
          tier,
        ),
      );
    }
    // 结构闸：长度和注释比都管不住形态。摘录侧已在检索层拦（beginner_code_form），
    // 自撰区归这里管——实测摘录修好之后，模型自己照样写 `import numpy as np`。
    for (const b of m.blocks) {
      if (b.excerpt || !b.beyondBeginnerForm) continue;
      out.push(
        codeBlockViolation(
          b,
          'L1-CODE-FORM',
          'A',
          1,
          0,
          `第 ${b.first}-${b.last} 行代码块出现「${b.beyondBeginnerForm.slice(0, 40)}」：` +
            `import / def / class 是入门段不出现的结构（外部基线：蟒蛇书 1-6 章 129 个文件里这三项均为 0%，` +
            `全书才 57%/31%/25%）。零基础读者没学过导入和函数定义，这一行会直接卡住。`,
          '改法二选一：把这段改写成不需要 import 和 def 的直白语句（像 `价格 = 10` `print(价格)` 这样一行一件事），或者整块删掉改成文字讲流程。',
        ),
      );
    }
    for (const b of m.blocks) {
      const thin = b.ratioOk && b.ratio < T.L1_CODE_RATIO;
      const long = b.codeLines > T.L1_CODE_MAX_BLOCK;
      if (!thin && !long) continue;
      out.push(
        codeBlockViolation(
          b,
          'L1-CODE',
          'B',
          thin ? b.ratio : b.codeLines,
          thin ? T.L1_CODE_RATIO : T.L1_CODE_MAX_BLOCK,
          thin
            ? `第 ${b.first}-${b.last} 行代码块注释比 ${round2(b.ratio)} < ${T.L1_CODE_RATIO}（零基础档要求逐行大白话注释）。`
            : `第 ${b.first}-${b.last} 行代码块 ${b.codeLines} 行 > ${T.L1_CODE_MAX_BLOCK} 行（rubric v2 明文上限）。`,
          '改法二选一：删到 5 行以内并逐行配大白话注释，或者整块改成文字描述流程。',
        ),
      );
    }
  }

  if (tier === 'L2') {
    for (const b of m.blocks) {
      if (b.excerpt || !b.ratioOk || b.ratio <= T.L2_OWN_RATIO) continue;
      out.push(
        codeBlockViolation(
          b,
          'L2-SOFT-CODE',
          'A',
          b.ratio,
          T.L2_OWN_RATIO,
          `第 ${b.first}-${b.last} 行代码块注释比 ${round2(b.ratio)} > ${T.L2_OWN_RATIO}：` +
            `逐行手把手注释是零基础姿态，本档要的是块级说明。`,
          '改法二选一：把逐行注释合并成代码块前的一段块级说明（讲意图与输入输出），或者只保留关键行的注释、删掉复述语法的那些。',
        ),
      );
    }
    // 防「太硬」的那一侧。原先占这个位置的 L2-LONGSENT / L2-BARE 在自撰区口径上
    // 一次都不触发（长句和裸符号都在摘录里），换成本档 t|a 边界上最强的 M5。
    if (m.domainSkew > T.L2_HARD_SKEW) {
      const w = m.firstProdWord;
      out.push(
        v(
          {
            ruleId: 'L2-HARD-DOMAIN',
            cls: 'A',
            zone: 'own',
            line: w?.line ?? 0,
            value: round2(m.domainSkew),
            threshold: T.L2_HARD_SKEW,
            quote: w?.word ?? '',
            message:
              `例子几乎全在生产域（域偏置 ${round2(m.domainSkew)}，本档上限 ${T.L2_HARD_SKEW}）：` +
              `第 ${w?.line ?? 0} 行的「${w?.word ?? ''}」这类词假设读者见过线上系统，` +
              `本档读者会编程但没有 AI 工程背景。`,
            fix: '改法二选一：把其中一两个生产场景的例子换成读者手上就能跑的小规模场景，或者保留它们但在第一次出现时补一句这个指标为什么重要。',
          },
          tier,
        ),
      );
    }
  }

  if (tier === 'L3') {
    for (const b of m.blocks) {
      if (b.excerpt || !b.ratioOk || b.ratio <= T.L3_OWN_RATIO) continue;
      out.push(
        codeBlockViolation(
          b,
          'L3-SOFT-COMMENT',
          'A',
          b.ratio,
          T.L3_OWN_RATIO,
          `第 ${b.first}-${b.last} 行代码块注释比 ${round2(b.ratio)} > ${T.L3_OWN_RATIO}：` +
            `进阶档的代码要贴生产形态，手把手注释是写错档。`,
          '改法二选一：删掉复述语法的注释只留下工程取舍的说明，或者把这块代码换成更完整的生产形态实现（不加注释）。',
        ),
      );
    }
    if (m.domainSkew < T.L3_SOFT_SKEW) {
      out.push(
        v(
          {
            ruleId: 'L3-SOFT-LIFE',
            cls: 'A',
            zone: 'own',
            line: 0,
            value: round2(m.domainSkew),
            threshold: T.L3_SOFT_SKEW,
            quote: '',
            message: `域偏置 ${round2(m.domainSkew)} < 0：生活域类比压过了生产域表述，进阶档不要生活化类比。`,
            fix: '改法二选一：把生活类比换成生产场景（吞吐/显存/线上退化）的对应说法，或者直接删掉类比只留机制陈述。',
          },
          tier,
        ),
      );
    }
    // 原先这里还有一条 L3-THIN-CODE（代码总行数 <10）。砍掉：自撰区的代码行数
    // 分不开 transition/advanced（sep 0.28，置换 p=0.145），厚代码在摘录里，
    // 旧阈值在自撰区口径上误触发 10/13。素材厚度归检索侧量，lint 够不着。
    if (m.domainSkew < T.L3_THIN_SKEW) {
      out.push(
        v(
          {
            ruleId: 'L3-THIN-DOMAIN',
            cls: 'B',
            zone: 'own',
            line: 0,
            value: round2(m.domainSkew),
            threshold: T.L3_THIN_SKEW,
            quote: '',
            message:
              `域偏置 ${round2(m.domainSkew)} < ${T.L3_THIN_SKEW}（本档命中样本最小观测 2.833）：` +
              `生产场景的例子给少了。素材不够硬不是改写能解决的，动作是回到检索侧要 L3 素材。`,
            fix: '',
          },
          tier,
        ),
      );
    }
  }

  // ── 正文形态三条（B 类：只记警告，0 调用）─────────────────────────
  // 判据全部来自教材对照，见 TEXTBOOK_TERMS_P95 / TEXTBOOK_PARA_CJK_P95 的注释。
  // 为什么不是 A 类：概念太多、段落太长这两件事改写修不了——删概念就是删内容，
  // 只能回生成侧按提示词的目标重写。第三条（无出处数字）改写倒是能修，
  // 但它与摘录的咬合要看整页上下文，定向改写容易把数字改成另一个编的数。
  if (m.uniqTermPer100 > 0 && m.terms.length > TEXTBOOK_TERMS_P95) {
    const over = m.terms.slice(TEXTBOOK_TERMS_P95, TEXTBOOK_TERMS_P95 + 5);
    out.push(
      v(
        {
          ruleId: 'BODY-TOO-MANY-CONCEPTS',
          cls: 'B',
          zone: 'own',
          line: over[0]?.line ?? 0,
          value: m.terms.length,
          threshold: TEXTBOOK_TERMS_P95,
          quote: over.map((t) => t.term).join('、'),
          message:
            `本页出现 ${m.terms.length} 个不同术语，教材同体量节的 P95 是 ${TEXTBOOK_TERMS_P95}` +
            `（中位才 3）。超出的有：${over.map((t) => t.term).join('、')}。` +
            `读者记住 3 个胜过扫过 11 个——回生成侧挑关键的讲透，其余留到下一节。`,
          fix: '',
        },
        tier,
      ),
    );
  }
  if (m.longParagraphs.length > 0) {
    const worst = m.longParagraphs.reduce((a, b) => (b.cjk > a.cjk ? b : a));
    out.push(
      v(
        {
          ruleId: 'BODY-LONG-PARAGRAPH',
          cls: 'B',
          zone: 'own',
          line: worst.line,
          value: worst.cjk,
          threshold: TEXTBOOK_PARA_CJK_P95,
          quote: `第 ${m.longParagraphs.map((x) => x.line).slice(0, 6).join('、')} 行`,
          message:
            `${m.longParagraphs.length} 个段落超过 ${TEXTBOOK_PARA_CJK_P95} 汉字（最长第 ${worst.line} 行 ${worst.cjk} 字）。` +
            `真实中文教材段落中位 24 字、P90 66 字，我们中位 69 字。一段说一件事，说完换行。`,
          fix: '',
        },
        tier,
      ),
    );
  }
  // 段落中位数落在教材区间外。**上下两面都判**——只判上界的那一版让模型把段落
  // 砍到中位 13 字（教材 P10），每句一段，同样读不成文章。
  if (
    m.paraMedianCjk !== null &&
    (m.paraMedianCjk < TEXTBOOK_PARA_MEDIAN_LO || m.paraMedianCjk > TEXTBOOK_PARA_MEDIAN_HI)
  ) {
    const tooShort = m.paraMedianCjk < TEXTBOOK_PARA_MEDIAN_LO;
    out.push(
      v(
        {
          ruleId: tooShort ? 'BODY-PARA-TOO-SHORT' : 'BODY-PARA-TOO-LONG',
          cls: 'B',
          zone: 'own',
          line: 0,
          value: m.paraMedianCjk,
          threshold: tooShort ? TEXTBOOK_PARA_MEDIAN_LO : TEXTBOOK_PARA_MEDIAN_HI,
          quote: '',
          message: tooShort
            ? `本页段落中位 ${m.paraMedianCjk} 汉字，低于教材 P25 的 ${TEXTBOOK_PARA_MEDIAN_LO}` +
              `（教材中位 27）。每句一段读不成文章——一段要说完一件事：有主张、有支撑。`
            : `本页段落中位 ${m.paraMedianCjk} 汉字，高于教材 P75 的 ${TEXTBOOK_PARA_MEDIAN_HI}` +
              `（教材中位 27）。一段说一件事，说完换行。`,
          fix: '',
        },
        tier,
      ),
    );
  }

  if (m.claimNumbers.length > 0) {
    const first = m.claimNumbers[0];
    out.push(
      v(
        {
          ruleId: 'BODY-UNGROUNDED-NUMBER',
          cls: 'B',
          zone: 'own',
          line: first.line,
          value: m.claimNumbers.length,
          threshold: 0,
          quote: m.claimNumbers.slice(0, 3).map((x) => x.text).join(' / '),
          message:
            `自撰区有 ${m.claimNumbers.length} 处带模糊限定的声称数字（第 ${first.line} 行「${first.text}」）。` +
            `实测已生成的 165 页里这类数 86 个、85 个在本页摘录里查不到。` +
            `课程招牌是「带出处」：数来自摘录就照抄并放占位符，是手算就把算式写出来，都不是就删掉换定性表述。`,
          fix: '',
        },
        tier,
      ),
    );
  }

  // 三档共用：教材在**任何**难度段都不写这些词，没有分档的道理。
  // A 类（要花一次改写调用）的代价评估：131 份已判语料上只触发 2 次（1.5%），
  // 不是拿 A 类去博召回。两次分别是 b1-attention 的「学会“划重点”」与
  // a3-softmax-temp 的「追求极致吞吐」——都是一个词的替换，改写便宜。
  if (m.aiTells.length > 0) {
    const listed = m.aiTells.map((h) => `「${h.term}」（第 ${h.line} 行）`).join('、');
    out.push(
      v(
        {
          ruleId: 'AI-TELL',
          cls: 'A',
          zone: 'own',
          line: m.aiTells[0].line,
          value: m.aiTells.length,
          threshold: 0,
          quote: listed,
          message:
            `自撰部分出现 ${m.aiTells.length} 处教材里不会出现的修辞：${listed}。` +
            `判据是外部语料量出来的：这些词在 43.8 万汉字的中文教材` +
            `（动手学深度学习 / Happy-LLM / tiny-universe / 笨办法学 Python）里出现 0 次。`,
          fix: '改法二选一：换成陈述这件事本身的说法（「命门」→「决定性能的关键参数是 X」），或者整句删掉——如果删掉不损失信息，说明它本来就只是修辞。',
        },
        tier,
      ),
    );
  }

  if (m.fenceUnbalanced) {
    out.push(
      v(
        {
          ruleId: 'FENCE-UNBALANCED',
          cls: 'B',
          zone: 'own',
          line: 0,
          value: 1,
          threshold: 0,
          quote: '',
          message: '代码围栏 ``` 数量为奇数（通常是摘录裁剪的产物）。',
          fix: '',
        },
        tier,
      ),
    );
  }
  return out;
}

/** 纯函数入口：文本 + 目标档 → 越界清单。无 LLM、无 IO。 */
export function lintAdaptation(text: string, tier: Tier | null): LintReport {
  const metrics = computeAdaptationMetrics(text);
  const violations = rulesFor(tier, metrics);

  // 脚手架泄漏与档位无关：任何档位的正文里都不该出现「本段目标：」这类规划标签。
  // 判 A 类（必须改）——它不是风格问题，是把内部过程当产物交付了。
  const leak = findScaffoldLeak(text);
  if (leak) {
    violations.push({
      ruleId: 'SCAFFOLD-LEAK',
      cls: 'A',
      zone: 'own',
      line: leak.line,
      value: 1,
      threshold: 0,
      quote: leak.quote,
      message:
        `第 ${leak.line} 行把写作规划标签写进了正文：「${leak.quote}」。` +
        '这是给生成过程看的，不是给学习者看的。',
      fix: '删掉这一行的标签前缀，把后面的内容直接融进正文；不要用「本段目标」「输出格式」这类元话语领句。',
      tier,
    });
  }
  return {
    tier,
    metrics,
    violations,
    a: violations.filter((x) => x.cls === 'A'),
    b: violations.filter((x) => x.cls === 'B'),
  };
}

// ─────────────────────────────────────────────────────────── 档位识别 / 改写指令 / 兜底

const TIER_MARKERS: Array<[Tier, string]> = [
  ['L1', '【零基础硬要求】'],
  ['L2', '【转行者硬要求】'],
  ['L3', '【进阶硬要求】'],
];

/** 从蓝图指令（outline.description）反解目标档。没有画像通道时返回 null，不跑 lint。 */
export function tierFromDirective(description?: string): Tier | null {
  const d = description ?? '';
  for (const [tier, marker] of TIER_MARKERS) if (d.includes(marker)) return tier;
  return null;
}

export const ADAPTATION_REWRITE_SYSTEM =
  '你是讲义的难度适配审校。下面给出脚本逐行核出的越界点，你只改这些点名的地方，' +
  '其余段落原样复制。只输出改写后的完整 markdown，不要任何说明文字。';

/**
 * 整篇审校提示词（定向改写失手后的第二道）。
 *
 * 定向改写指名到片段、改动最小，但指令过窄时模型改不动（2A 复测：18 个 L1 场景
 * 7 次「未修好」）。这组是按档位的整篇重写口径——放宽到"逐段检查并改写"，
 * 与 blueprintDirective 的分档硬要求同源。L1 版即 08-10 的 L1 自查环原文，
 * 那版实测把 beginner 从 61% 抬到 94.4%，不该在换 lint 时被整体丢掉。
 *
 * 共同约束：结构（标题/摘录占位符/围栏）原样保留、不新增主题、不改事实表述。
 */
export const BROAD_TIER_SWEEP: Record<'L1' | 'L2' | 'L3', string> = {
  L1:
    '你是讲义的零基础适配审校。对给定讲义 markdown 逐段检查并直接改写：' +
    '①每个专业术语第一次出现必须紧跟一句大白话定义（没有就补上）；' +
    '②单段新术语超过 2 个就拆段或删减；' +
    '③代码块若超过 5 行或缺逐行大白话注释，改写为符合要求的版本或改为文字描述流程；' +
    '④公式前若无直觉解释则补一句。保持原有结构（标题/摘录占位符/围栏原样保留），' +
    '不新增内容主题，不改变事实表述。只输出改写后的完整 markdown，不要任何说明文字。',
  L2:
    '你是讲义的转行者适配审校（读者会编程、无 AI 背景）。逐段检查并直接改写：' +
    '①AI 领域术语首次出现补一句简短定义，但不要解释变量/函数/API 这类编程常识；' +
    '②每段尽量落一个工程直觉类比（接口/缓存/流水线/索引），不用做菜排队这类日常类比；' +
    '③代码块配块级说明讲清意图与输入输出，不做逐行注释；' +
    '④删掉鼓励性语句，以及"熟悉的 transformer 结构""如你在生产中所见"这类默认读者见过' +
    '论文或线上环境的表述。保持原有结构（标题/摘录占位符/围栏原样保留），' +
    '不新增内容主题，不改变事实表述。只输出改写后的完整 markdown，不要任何说明文字。',
  L3:
    '你是讲义的进阶适配审校（读者是有实战经验的工程师）。逐段检查并直接改写：' +
    '①删掉对基础术语的定义与铺垫，术语直接使用；②删掉生活化类比与鼓励性语句，' +
    '例子换成生产场景（吞吐/显存/线上退化）；③代码去掉手把手逐行注释，贴生产形态；' +
    '④直接进机制、公式与工程取舍的讨论。保持原有结构（标题/摘录占位符/围栏原样保留），' +
    '不新增内容主题，不改变事实表述。只输出改写后的完整 markdown，不要任何说明文字。',
};

/**
 * 定向改写的 user 消息：审校清单 + 待改写全文。
 * 指名道姓到行号 + 原文片段，不写「请简化」——依据 Tyen et al. 2311.08516，
 * 给了错误位置模型就改得对。只喂 A 类：B 类（摘录区违规、素材不够硬）写进去
 * 只会诱导模型去动它改不了的摘录。
 *
 * 讲义正文不加行号前缀：模型照抄前缀的风险比行号带来的定位收益大，真正的锚点是
 * 每条违规里的原文片段（quote），行号只是给日志对账用的。
 */
export function buildRewriteDirective(report: LintReport, md: string): string {
  const items = report.a.map(
    (x, i) => `${i + 1}. [${x.ruleId}] ${x.message}${x.fix ? `\n   ${x.fix}` : ''}`,
  );
  return [
    '【机械审校结果 · 只改下面点名的地方，其余原样输出】',
    '',
    report.tier
      ? `本页面向「${TIER_LABEL[report.tier]}」。以下是脚本逐行核出的越界点，逐条改掉：`
      : '以下是脚本逐行核出的越界点，逐条改掉：',
    '',
    items.join('\n\n'),
    '',
    '约束（违反任何一条这次改写作废）：',
    '- 标题、教材摘录（📖 到「—— 摘自」之间的全部内容，以及 {{摘录:xxx}} 占位符）、' +
      '出处标记 [xxx#yy]，一个字都不许动。',
    '- 不新增内容主题，不改变任何事实表述。',
    '- 没被点名的段落原样复制。',
    '- 只输出改写后的完整 markdown，不要任何说明文字。',
    '',
    '--- 待改写的讲义 markdown ---',
    md,
  ].join('\n');
}

/** 摘录块数（渲染前的占位符 + 渲染后的 📖 都算）。 */
function excerptCount(text: string): number {
  const ph = (text.match(/\{\{\s*摘录\s*[:：]/g) ?? []).length;
  const rendered = (text.match(/📖/g) ?? []).length;
  return ph + rendered;
}

/** 出处标记集合：`[xxx#yy]` 与 `{{摘录:xxx#yy}}` 里的 id。 */
function sourceTags(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[([A-Za-z0-9_-]+#[A-Za-z0-9_-]+)\]/g)) out.add(m[1]);
  for (const m of text.matchAll(/\{\{\s*摘录\s*[:：]\s*([A-Za-z0-9_#-]+)\s*\}\}/g)) out.add(m[1]);
  return out;
}

const fenceOdd = (text: string): boolean => (text.match(/^\s*```/gm) ?? []).length % 2 === 1;

/**
 * 标题行 = 首个非空行且是 markdown 标题。讲义 md 常常直接以正文起手
 * （cleanLectureMarkdown 会把与场景同名的标题去掉），那种情况下没有标题行可比，
 * 不能拿「首行不变」去冻结第一段正文——那是改写最常要动的地方。
 */
const titleLine = (text: string): string => {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  return first.startsWith('#') ? first : '';
};

/**
 * 改写产物的完整性检查（规格 §3.4）。任一不过 → 该版本作废，不参与选版。
 * 摘录被吃掉是接地徽标的事故，比档位判错严重。
 */
export function checkRewriteIntegrity(
  original: string,
  revised: string,
): { ok: boolean; reason?: string } {
  if (revised.length < original.length * 0.6) return { ok: false, reason: '长度不足原稿 60%' };
  if (excerptCount(revised) !== excerptCount(original)) return { ok: false, reason: '摘录块数量变了' };
  const a = sourceTags(original);
  const b = sourceTags(revised);
  if (a.size !== b.size || [...a].some((t) => !b.has(t)))
    return { ok: false, reason: '出处标记集合变了' };
  if (fenceOdd(revised) && !fenceOdd(original)) return { ok: false, reason: '代码围栏配对变差' };
  if (titleLine(revised) !== titleLine(original)) return { ok: false, reason: '标题行被改' };
  return { ok: true };
}

/** 一行日志摘要：规则 ID + 行号 + 数值/阈值，用于回归对账。 */
export function formatViolations(list: Violation[]): string {
  return (
    list
      .map((x) => `${x.ruleId}@${x.line}(${x.zone} ${x.value}/${x.threshold})`)
      .join(' ') || '无'
  );
}

/**
 * 从 canvas 元素的 HTML 正文里清掉脚手架泄漏段。
 *
 * `runAdaptationLintLoop` 只挂在讲义流（markdown 形态）。槽位路与自由版面路
 * 产出的是 `PPTElement` 的 HTML `content`，一条机械检查都没跑过——
 * 线上那一屏四个「本段目标：」就是从这条路出去的。**同一份内容两种形态、
 * 处理只覆盖一种**，与判官吃到字体名同一族。
 *
 * 这里不发模型调用：泄漏段整段都是元话语，删掉即可，改写没有信息可留。
 *
 * **安全阀**：删完不足原文一半、或删空了，就整个放弃并原样返回。
 * 宁可留一句「本段目标」，也不能把一屏内容删没。
 */
export function scrubScaffoldHtml(html: string): { html: string; dropped: string[] } {
  if (!html.includes('本') && !/[Pp屏页]\s*\d+\s*[:：]/.test(html) && !html.includes('导读')) {
    return { html, dropped: [] }; // 快路径：绝大多数元素连候选词都没有
  }
  // 按块边界切：`</p>`、`<br>`、换行。保留分隔符，拼回去形状不变。
  const parts = html.split(/(<\/p>|<br\s*\/?>|\n)/i);
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const part of parts) {
    const plain = part
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (plain && findScaffoldLeak(plain)) {
      dropped.push(plain.slice(0, 60));
      continue; // 连同它的闭合标签一起丢；后面 kept 里剩下的标签仍成对
    }
    kept.push(part);
  }
  if (!dropped.length) return { html, dropped: [] };

  const next = kept.join('');
  const plainLen = (s: string) => s.replace(/<[^>]*>/g, '').trim().length;
  if (plainLen(next) < plainLen(html) / 2) {
    // 删得太多，多半是判错了或整屏都是元话语——放弃，别把屏删空
    return { html, dropped: [] };
  }
  return { html: next, dropped };
}
