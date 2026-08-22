/**
 * 口播（导学栏文本）的机械 lint：一门课的全部 speech 段 → 越界清单。纯函数、零 LLM。
 *
 * ## 为什么单开一层
 *
 * 讲义有 `adaptation-lint.ts` 管着，**口播这条路从来没被查过**——它是
 * `slide-actions` 提示词单独生成的另一条路由。2026-08-13 把已落库的 23 门课
 * 557 条口播（19,103 汉字）量了一遍，结果是全线模板化：
 *
 * | 开头 6 字 | 次数 |
 * |---|---|
 * | 大家好，欢迎 | 23（每门课开场一模一样） |
 * | 这一节的核心 | 17 |
 * | 这一节的关键 | 12 |
 * | 现在让我们通 | 10 |
 * | 读这一节时， | 10 |
 *
 * 前 12 个开头覆盖 22% 的条目。破折号 4.76/千字，而真实中文教材是 0.07–0.44
 * （d2l-zh / Happy-LLM / tiny-universe / 笨办法学 Python，43.9 万汉字，
 * 见 `docs/05-evidence/textbook-prose-ladder-20260813.md`）。「盯住」3.09/千字、
 * 教材 0 次——根因是这个词曾经写在 `slide-actions/system.md` 的示例里，
 * 模型照抄，59 次覆盖 20/23 门课。
 *
 * ## 判据出处
 *
 * - 破折号上限：教材实测最大值 0.44/千字（Happy-LLM），上取整到 **0.5**。
 *   与讲义侧 THRESHOLDS 的〔带〕类同一套办法——取外部语料的观测边界，不自己拍。
 * - 「盯住」等词：走 `data/ai-tells.json`（教材零命中才进表）。
 * - 开头重复、问号密度、开场白：**结构判据，不涉及阈值**——
 *   「同一门课里两条口播不许用同样的开头六个字」不需要标定。
 *
 * ## 与讲义 lint 的分工
 *
 * 那边是「找错 → 模型定向改写」（要花调用）。这边**只找错、不改写**：
 * 口播一条才一两句，重生成比定向改写便宜，而且它的问题是「整门课雷同」，
 * 单条改写看不见全局。所以这一层的产物是给生成侧的重试指令与日志，不是改写 prompt。
 */

import aiTellData from './data/ai-tells.json';

export interface SpeechSegment {
  /** 场景序号，1-based。用来说清是第几页 */
  sceneIndex: number;
  sceneTitle: string;
  text: string;
}

export type SpeechRuleId =
  | 'SPEECH-SAME-OPENING'
  | 'SPEECH-GREETING'
  | 'SPEECH-EMDASH'
  | 'SPEECH-AI-TELL'
  | 'SPEECH-QUESTION-FLOOD';

export interface SpeechViolation {
  ruleId: SpeechRuleId;
  /** 涉及的场景序号；全课级违规为 0 */
  sceneIndex: number;
  value: number;
  threshold: number;
  /** 原文片段，留痕 */
  quote: string;
  message: string;
}

/**
 * 教材实测最大 0.44/千字（Happy-LLM），上取整到 0.5。
 *
 * 但一门课的口播总共才 ~830 汉字（19,103 / 23），按密度算下来配额是 0.4 个——
 * 也就是「一个都不许有」。密度判据在这么短的文本上会变成全禁，那不是教材语料
 * 支持的结论（教材里破折号是有的，只是稀）。所以对外的判据写成**每课计数**：
 * 配额 = max(1, round(汉字数 / 1000 × 0.5))。短课至少给一个，长课按密度放宽。
 */
export const EMDASH_PER_K_MAX = 0.5;

/** 一门课允许的破折号个数。见 EMDASH_PER_K_MAX 的注释。 */
export function emdashQuota(cjkChars: number): number {
  return Math.max(1, Math.round((cjkChars / 1000) * EMDASH_PER_K_MAX));
}

/** 开头判重的长度。六个字足以区分「这一节的核心」与「这一节的关键」。 */
const OPENING_LEN = 6;

/** 一段里的问号上限。检查理解只需要一问；连着追问是把读者当审讯对象。 */
const MAX_QUESTIONS_PER_SEGMENT = 1;

const GREETING_RE = /^(大家好|同学们好|欢迎大家|各位好|大家晚上好|大家早上好)/;
const CJK_G = /[一-鿿]/g;

const AI_TELLS: string[] = [...aiTellData.aiTells].sort((a, b) => b.length - a.length);

const cjkCount = (s: string): number => (s.match(CJK_G) ?? []).length;

/** 归一化开头：去掉空白与常见前缀标点后取前 N 字。 */
function opening(text: string): string {
  return text.replace(/^[\s"'「『（(]+/, '').slice(0, OPENING_LEN);
}

/**
 * 一门课的全部口播 → 越界清单。
 *
 * 入参是**整门课**而不是单条，因为最严重的那条问题（雷同）只有在整门课的
 * 尺度上才看得见。单条口播孤立地看几乎总是合格的。
 */
export function lintCourseSpeech(segments: readonly SpeechSegment[]): SpeechViolation[] {
  const out: SpeechViolation[] = [];
  if (segments.length === 0) return out;

  // ── 1. 开头雷同 ────────────────────────────────────────────────
  const byOpening = new Map<string, SpeechSegment[]>();
  for (const s of segments) {
    const key = opening(s.text);
    if (!key) continue;
    const list = byOpening.get(key);
    if (list) list.push(s);
    else byOpening.set(key, [s]);
  }
  for (const [key, list] of byOpening) {
    if (list.length < 2) continue;
    out.push({
      ruleId: 'SPEECH-SAME-OPENING',
      sceneIndex: list[1].sceneIndex,
      value: list.length,
      threshold: 1,
      quote: key,
      message:
        `同一门课里有 ${list.length} 条口播用同样的开头「${key}」` +
        `（第 ${list.map((s) => s.sceneIndex).join('、')} 页）。` +
        `学习者连着读下来会觉得每节都在说同一句话。`,
    });
  }

  // ── 2. 开场白只许出现在第一条 ──────────────────────────────────
  segments.forEach((s, i) => {
    if (i === 0 || !GREETING_RE.test(s.text.trim())) return;
    out.push({
      ruleId: 'SPEECH-GREETING',
      sceneIndex: s.sceneIndex,
      value: i + 1,
      threshold: 1,
      quote: s.text.slice(0, 20),
      message:
        `第 ${s.sceneIndex} 页的口播又打了一次招呼（「${s.text.slice(0, 8)}…」）。` +
        `整门课是一堂连着的课，只有最开头那一条该问好。`,
    });
  });

  // ── 3. 破折号密度（判据来自教材实测） ──────────────────────────
  const all = segments.map((s) => s.text).join('\n');
  const cjk = cjkCount(all);
  const dashes = (all.match(/——/g) ?? []).length;
  const quota = emdashQuota(cjk);
  if (dashes > quota) {
    const first = segments.find((s) => s.text.includes('——'));
    const perK = cjk > 0 ? (dashes / cjk) * 1000 : 0;
    out.push({
      ruleId: 'SPEECH-EMDASH',
      sceneIndex: first?.sceneIndex ?? 0,
      value: dashes,
      threshold: quota,
      quote: first ? first.text.slice(0, 30) : '',
      message:
        `全课口播用了 ${dashes} 个破折号 / ${cjk} 汉字 = ` +
        `${(Math.round(perK * 100) / 100).toFixed(2)} 每千字，配额 ${quota} 个` +
        `（真实中文教材实测 0.07–0.44 每千字，取最大值上取整换算）。` +
        `破折号连用是书面腔，换成逗号、句号或冒号。`,
    });
  }

  // ── 4. AI 味词（教材零命中词表） ───────────────────────────────
  for (const s of segments) {
    const hit = AI_TELLS.find((w) => s.text.includes(w));
    if (!hit) continue;
    out.push({
      ruleId: 'SPEECH-AI-TELL',
      sceneIndex: s.sceneIndex,
      value: 1,
      threshold: 0,
      quote: hit,
      message:
        `第 ${s.sceneIndex} 页口播用了「${hit}」。这个词在 43.9 万汉字的中文教材语料里` +
        `出现 0 次（judged corpus 见 textbook-prose-ladder-20260813.md）。`,
    });
  }

  // ── 5. 问号密度 ────────────────────────────────────────────────
  for (const s of segments) {
    const q = (s.text.match(/[？?]/g) ?? []).length;
    if (q <= MAX_QUESTIONS_PER_SEGMENT) continue;
    out.push({
      ruleId: 'SPEECH-QUESTION-FLOOD',
      sceneIndex: s.sceneIndex,
      value: q,
      threshold: MAX_QUESTIONS_PER_SEGMENT,
      quote: s.text.slice(0, 30),
      message:
        `第 ${s.sceneIndex} 页口播一段里有 ${q} 个问号。检查理解只需要一问，` +
        `连着追问读者只会跳过。`,
    });
  }

  return out;
}

/** 一行日志摘要，用于回归对账。 */
export function formatSpeechViolations(list: readonly SpeechViolation[]): string {
  return list.map((v) => `${v.ruleId}@${v.sceneIndex}(${v.value}/${v.threshold})`).join(' ') || '无';
}
