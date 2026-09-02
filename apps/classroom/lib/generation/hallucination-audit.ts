/**
 * Hallucination audit for generated scene content.
 *
 * A second, independent judge model reviews every factual claim in a freshly
 * generated scene BEFORE it enters the playback queue. Flagged claims trigger
 * one revision pass by the generator model, then a re-audit. The full verdict
 * trail is attached to the scene so the classroom UI can surface it — the
 * point is not only to control hallucination but to make the control visible.
 */

import { createHash } from 'node:crypto';

import { judgeRole } from '@/components/agents/judge-labels';
import { isIncrementalReauditEnabled } from '@/lib/config/feature-flags';
import { EvidenceGateError } from '@/lib/generation/evidence-grounding';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { mergeNumericBypass } from './numeric-claims';
import { isNumericBypassEnabled } from '@/lib/config/feature-flags';
import {
  validateLearningContractFulfillment,
  type LearningContractAlignmentProof,
  type LearningContractPhase,
  type LearningContractPlan,
} from './learning-contract';

export type ClaimVerdict = 'supported' | 'uncertain' | 'incorrect';
export type AuditScope = 'scene' | 'course';

export interface AuditClaim {
  claim: string;
  verdict: ClaimVerdict;
  reason: string;
  /** Suggested correction — required by the prompt when verdict is `incorrect`. */
  fix?: string;
  /**
   * Evidence ids backing this claim (`[S1]`-style source_id from the controlled
   * KB). Only meaningful when the audit was grounded; empty when the judge
   * declined to cite — an unciteable claim is reported as unciteable, not faked.
   */
  sourceIds?: string[];
  /**
   * How the verdict was settled. Absent in single-judge mode (no panel ran) and
   * on claims whose arbitration failed — absence means "not adjudicated", never
   * "agreed".
   */
  decidedBy?: 'consensus' | 'arbitration';
}

/** An `uncertain` claim re-judged against evidence found by querying the claim itself. */
export interface RescueRecord {
  claim: string;
  /** Verdict before the second retrieval — always `uncertain` (only those are retried). */
  before: ClaimVerdict;
  after: ClaimVerdict;
  /** Chunks the claim-level query returned; 0 means the corpus genuinely lacks it. */
  evidenceCount: number;
  reason: string;
}

/** One adjudicated disagreement: two judges split, the author defended, the arbiter ruled. */
export interface DebateRound {
  claim: string;
  /**
   * `审核智能体甲 → 判定` per judge, in panel order.
   *
   * 称谓从 `judgeRole()` 取，**模型串在这里就不写进去**。渲染层的
   * `maskJudgeVerdict` 仍然兜一道（历史数据里嵌的是模型名），但新写入不再依赖它——
   * 靠渲染层兜底意味着每加一个渲染点就多一次漏的机会，08-16 已经漏过一次。
   */
  judgeVerdicts: string[];
  defense: string;
  arbiterVerdict: string;
  rationale: string;
}

export interface LearningAlignmentItem {
  objectiveId: string;
  phase: LearningContractPhase;
  sceneId: string;
  verdict: 'aligned' | 'misaligned';
  evidenceQuote?: string;
  reason: string;
  newContext?: boolean;
}

export interface LearningAlignmentJudgeResult {
  judgeModel: string;
  verdict: 'aligned' | 'misaligned';
  rationale: string;
  items: LearningAlignmentItem[];
}

export interface LearningContractAlignmentAudit extends LearningContractAlignmentProof {
  judges: LearningAlignmentJudgeResult[];
}

export interface SceneAudit {
  /**
   * pass = clean; caveat = only `uncertain` claims (beyond evidence coverage —
   * annotated, not treated as errors); revised = incorrect claims were fixed;
   * flagged = incorrect claims remain after revision, or the audit itself failed.
   */
  verdict: 'pass' | 'caveat' | 'revised' | 'flagged';
  claims: AuditClaim[];
  totalClaims: number;
  flaggedCount: number;
  uncertainCount: number;
  incorrectCount: number;
  judgeModel: string;
  rounds: number;
  durationMs: number;
  /**
   * Gate ruling. A verdict that never changes what ships is decoration — this
   * is the decision half of analyse → generate → verify → decide. Thresholds
   * mirror the engine's arbitration agent (PUBLISH_FLOOR 0.62, hallucination
   * rate ≤ 0.10) so both codebases answer "why did this ship?" identically.
   */
  decision: 'publish' | 'publish_with_warnings' | 'block_pending_review';
  /** One sentence naming the thresholds this scene crossed. */
  rationale: string;
  /** Whether the controlled knowledge base actually backed this audit. */
  grounded: boolean;
  /**
   * 这一页的证据取自哪个语料库（`odoo` / `iotdb` / `ai` …）。
   * 只有真检索到证据时才写——没接地时写一个库名，等于替这页认领它没读过的书。
   */
  corpus?: string;
  evidenceCount: number;
  /**
   * 送审前被预算截掉的可审文本字数。>0 表示审核输入不完整，账单必须显式记录。
   */
  truncatedChars?: number;
  /**
   * Cross-validation trail. `undefined` = single judge (no panel ran);
   * `[]` = the panel ran and agreed on everything — the UI must say so plainly
   * rather than imply a debate happened.
   */
  debate?: DebateRound[];
  /** Every judge in the panel, in order (index 0 is the primary judge). */
  judgeModels?: string[];
  /** Model that issued final rulings on disputed claims. */
  arbiterModel?: string;
  /** Evidence pool this scene was judged against — the source_id → title map for the UI. */
  sources?: Array<{ source_id: string; title: string }>;
  /**
   * Claim-level re-retrieval attempts. `undefined` = the step never ran (no
   * retriever injected, or no uncertain claims); `[]` = it ran and rescued
   * nothing. Entries where `after === before` are honest failures worth showing:
   * they mean the corpus really does not cover that claim.
   */
  rescued?: RescueRecord[];
  /** 双判官课程终审是否完整收到两份合法判词。 */
  panelComplete?: boolean;
  /** 终审对应的最终场景载荷哈希；发布门据此识别审核后的改动。 */
  courseContentHash?: string;
  /** 双判官对“目标—五阶段—最终内容”的结构化语义履约裁决。 */
  learningAlignment?: LearningContractAlignmentAudit;
}

/** Publish floor shared with the engine's ArbitrationAgent (backend/agents/arbitration_agent.py). */
const PUBLISH_FLOOR = 0.62;

/**
 * 判官出错的绝对条数上限。超过它才认为「这页问题成片」而不是「个别判错」。
 *
 * 为什么用绝对数不用比率：比率在短场景上没有分辨率（1/3 = 0.33 和 10/30 = 0.33
 * 是完全不同的两件事）。3 条以上判错才值得人工介入。
 */
const ABSOLUTE_INCORRECT_LIMIT = 3;

/**
 * 修订产物是否与原内容结构兼容，可以安全替换。
 *
 * 修订的语义是「把判错的那几句改对」，不是「重写这一页」。所以要求：
 * - 原来有 elements 的，改后也要有，且数量不少于原来（少了说明模型在删内容）
 * - 原来有 questions 的（quiz），同理
 * - 原来有 html 的（interactive），改后必须仍是非空字符串
 *
 * 这层校验之外还有一层没做：替换进来的是 LLM 原始 JSON，绕过了
 * scene-generator 的 fixElementDefaults / processLatexElements / resolveImageIds，
 * 畸形元素会直接进渲染器。那个要在调用侧补，见 grounding_gate_effect.md 的待办。
 */
function isStructurallyCompatible(revised: unknown, original: unknown): boolean {
  if (!revised || typeof revised !== 'object') return false;
  const r = revised as Record<string, unknown>;
  const o = (original ?? {}) as Record<string, unknown>;

  if (Array.isArray(o.elements)) {
    if (!Array.isArray(r.elements)) return false;
    if (r.elements.length < o.elements.length) return false;
  }
  if (Array.isArray(o.questions)) {
    if (!Array.isArray(r.questions)) return false;
    if (r.questions.length < o.questions.length) return false;
  }
  if (typeof o.html === 'string' && o.html.length > 0) {
    if (typeof r.html !== 'string' || r.html.trim().length === 0) return false;
  }
  return true;
}

/**
 * Turn claim counts into a gate ruling.
 *
 * factuality = supported / total. An audit that produced no claims at all is a
 * non-assertive scene (pure interaction/flow), which publishes cleanly; an audit
 * that *failed to run* is reported by the caller as flagged with zero claims and
 * must not be silently treated as clean — hence the explicit `auditFailed` flag.
 */
function ruleOnClaims(
  claims: AuditClaim[],
  auditFailed: boolean,
): { decision: SceneAudit['decision']; rationale: string } {
  if (auditFailed) {
    return {
      decision: 'publish_with_warnings',
      // 「已如实标注」是自夸尾巴：如实是底线不是功绩，说出来反而显得
      // 「我们本可以不如实」。事实本身讲完就够。
      rationale: '审核服务未能完成核验，这一页没有经过事实校验。',
    };
  }
  const total = claims.length;
  if (total === 0) {
    return {
      decision: 'publish',
      rationale: '本场景无事实性断言（流程/互动类内容），无需事实校验。',
    };
  }
  const supported = claims.filter((c) => c.verdict === 'supported').length;
  const incorrect = claims.filter((c) => c.verdict === 'incorrect').length;
  const factuality = supported / total;
  if (incorrect === 0) {
    const uncertain = total - supported;
    return {
      decision: uncertain > 0 ? 'publish_with_warnings' : 'publish',
      rationale:
        uncertain > 0
          ? `${total} 条断言无一判错，其中 ${uncertain} 条超出资料覆盖范围，随内容一并标注后放行。`
          : `${total} 条断言全部被资料支持，事实性 1.00 ≥ 放行线 ${PUBLISH_FLOOR}，直接放行。`,
    };
  }
  if (factuality >= PUBLISH_FLOOR) {
    return {
      decision: 'publish_with_warnings',
      rationale:
        `修订后事实性 ${factuality.toFixed(2)} ≥ 放行线 ${PUBLISH_FLOOR}` +
        `（${incorrect}/${total} 条判错），带风险标记放行。`,
    };
  }

  // 判据从「比率超线」换成「判错条数超绝对上限」。
  //
  // 为什么改：单个判官对同一条断言的判决大约 13.6% 会翻转（arXiv:2606.13685），
  // 要让多数票稳定复现平均需要 11 次重复。我们只判一次。用这样一个会翻转的信号
  // 去做「丢弃整页」这种不可逆动作，是把概率层放在了确定性层该在的位置。
  //
  // 所以：事实性低于放行线只降级为带警告发布；只有判错条数成片（≥3 条）才拦截，
  // 且拦截的语义也从「丢弃」改成「标记待人工复核」——调用侧不再删内容。
  if (incorrect >= ABSOLUTE_INCORRECT_LIMIT) {
    return {
      decision: 'block_pending_review',
      rationale:
        `修订后仍有 ${incorrect}/${total} 条断言判错（≥${ABSOLUTE_INCORRECT_LIMIT} 条），` +
        `事实性 ${factuality.toFixed(2)} 低于放行线 ${PUBLISH_FLOOR}，标记待人工复核。` +
        `内容保留，不删除。`,
    };
  }
  return {
    decision: 'publish_with_warnings',
    rationale:
      `修订后有 ${incorrect}/${total} 条断言判错，事实性 ${factuality.toFixed(2)} ` +
      `低于放行线 ${PUBLISH_FLOOR}，但判错条数未成片（<${ABSOLUTE_INCORRECT_LIMIT}），` +
      `带风险标记放行——单次审核判决存在约 13.6% 翻转率，不足以支撑不可逆动作。`,
  };
}

export type AiCall = (system: string, user: string) => Promise<string>;

// 送审文本上限。依据：判官走 fast 档、证据窗另占 1400 字/块（JUDGE_EVIDENCE_CHARS，
// 维度不同别一起改），9000 字约当 6-7k token 的正文预算，再大先挤掉证据、后撞窗。
// 截掉的部分不进断言分母——所以必须入账（truncatedChars），不许静默变好看
// （2026-08-28 清查 M4）。
const MAX_CONTENT_CHARS = 9000;
// 全课终审给逐屏断言账本与 Action 可见语义的总预算。
const COURSE_TOTAL_TEXT_BUDGET = 45000;

//: 管道字段，不是教学内容。判官看见它们只会被噪声干扰。
//:
//: `fontName` 这条是线上实锤：canvas 槽位形态的待审文本第一行是
//: `Microsoft YaHei`——判官第一眼看见的是字体名。那屏最终抽出 0 条断言。
const PLUMBING_KEYS = new Set([
  'src',
  'audioId',
  'fontName',
  'fontFamily',
  'fontColor',
  'backgroundColor',
  'themeColor',
  'id',
  'schemaVersion',
]);

/** Collect human-visible teaching text from an arbitrary scene-content JSON. */
/**
 * 教具 HTML → 可审的教学文本。
 *
 * 只要人眼在页面上读得到的那部分：去掉 `<script>` / `<style>` 整块，
 * 标签换成空格，实体还原常见几个。**不引 DOM 解析器**——这段在服务端跑，
 * 而且我们要的不是结构只是文字。
 */
function stripHtmlToText(html: string): string {
  return (
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // 控件文案不是教学断言：「重置练习」「提交」「进度 0%」这类按钮/进度/输入的字面
      // 会被判官拼进相邻正文抽成一条「断言」再判 incorrect（2026-09-02 智造域实测：
      // 「操作流程进度 0% 重置练习 参考资料：S7-1200 与……」被仲裁判「含无关系统提示文本」，
      // 修订环改不了控件文字，整屏永远 flagged）。
      .replace(/<(button|progress|select|textarea|label)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<input\b[^>]*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  );
}

/**
 * 不是教学断言、不该送审的两类行。
 *
 * 【一 · 提示词回声】生成器有时把提示词里的硬要求原样写进正文
 * （`- 【零基础硬要求】单个段落新术语不超过 2 个`、`- 每页最多 1-2 个摘录占位符`）。
 * 交付前会被修订环清掉，学习者看不到，**但审核看得到**：判官与数字旁路把它们
 * 逐条抽成断言判「存疑」。2026-08-24 实测一门带证据的课，14 条存疑里 **10 条**
 * 是这么来的——**存疑率这个指标被自己的提示词顶高了**，而它正是我们用来论证
 * 「泛化域差在检索覆盖」的那个数。
 *
 * 【二 · 摘录缺口说明】`（这里本应引用教材 [xxx#s1]，…）` 是 `excerptGap()`
 * **故意留给学习者看的**（注释原话：「学习者至少知道这里本该有引用、可以去查那个出处」），
 * 用来避免指代悬空。**它必须留在正文里**——所以这里只把它挡在审核之外，
 * 不从内容里删。它是系统说明，不是关于世界的断言，判它真假没有意义。
 *
 * 判据只认**我们自己写的那几句字面量**，不做形态猜测：真教材不会说
 * 「每页最多 1-2 个摘录占位符」。猜形态（比如「凡是 `- 【…】` 开头的行」）
 * 会误伤正文里正常的方括号强调。字面量的出处由
 * `tests/generation/directives-stay-out-of-speech.test.ts` 钉着，它们搬家时会红。
 */
const NOT_A_CLAIM = [
  /【零基础硬要求】/,
  /每页最多\s*1-2\s*个摘录占位符/,
  /承载推导和因果/,
  /这里本应引用教材\s*\[/,
];

export function isAuditableLine(text: string): boolean {
  return !NOT_A_CLAIM.some((re) => re.test(text));
}

/**
 * 把一段文字里不该送审的**句子**摘掉，其余原样留下。
 *
 * 不能整段判：`stripHtmlToText` 会把一屏的 HTML 压成一个长字符串，
 * 整段匹配等于「一句回声连坐整屏」——实测一屏正文因此被抽成空串，
 * **那不是少判几条，是整屏漏审**，比原来的问题严重得多。
 *
 * 按中文句读切，逐句判，再拼回去。句读表里除了句号分号叹问，还要有 `）` 和 `」`
 * ——摘录缺口说明整句就是一对括号（`（这里本应引用教材 […]，…）`），
 * 不认收尾括号的话它跟后面的正文切不开，又变成连坐。**实测栽过一次。**
 *
 * 切不出句子（整段确实只有一句）时退化成整段判，与 `isAuditableLine` 同义。
 */
export function dropNonClaimSentences(text: string): string {
  if (isAuditableLine(text)) return text;
  const kept = text.split(/(?<=[。；！？）」\n])/).filter((s) => s.trim() && isAuditableLine(s));
  return kept.join('').trim();
}

function collectTeachingTextWithin(
  content: unknown,
  captureLimit: number,
): { text: string; totalChars: number } {
  const parts: string[] = [];
  let captured = 0;
  let totalChars = 0;
  let partCount = 0;
  const limit = Math.max(0, Math.floor(captureLimit));
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node) return;
    if (typeof node === 'string') {
      const text = node.trim();
      // Skip ids/urls/colors/enum-ish tokens — audit prose, not plumbing.
      if (
        text.length >= 6 &&
        !/^(https?:|data:|#|rgb|gen_img|gen_vid)/.test(text) &&
        !/^[\w-]+$/.test(text)
      ) {
        // 逐句摘，不整段扔——整段扔会让一句提示词回声把整屏带走。
        const kept = dropNonClaimSentences(text);
        if (kept) {
          const fragment = `${partCount > 0 ? '\n' : ''}${kept}`;
          partCount += 1;
          totalChars += fragment.length;
          if (captured < limit) {
            const clipped = fragment.slice(0, limit - captured);
            parts.push(clipped);
            captured += clipped.length;
          }
        }
      }
      return;
    }
    if (typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (PLUMBING_KEYS.has(key)) continue;
      if (key === 'content' && typeof value === 'string' && value.includes('<')) {
        // canvas 槽位形态里，元素的 `content` 就是讲义流转出来的 HTML。
        // 不剥标签的话判官拿到的是 `<p style="font-size: 16px;"><strong>…`——
        // 它得先在标签堆里找出哪些是人话（线上实测这屏抽出 0 条断言）。
        walk(stripHtmlToText(value));
        continue;
      }
      if (key === 'html') {
        // 教具 HTML 里的教学文本也要送审（判决书 P0 第 3 条）。
        // 这里原本是 `continue`，注释写「audited separately if ever needed」——
        // **那个 separately 从来没有发生**：实测一个 simulation 教具只抽出 6 个字
        // （名字），正文全丢，六类自由 HTML 的机制描述、数字、归因一条都不过审核门。
        //
        // 剥标签取文本，不送整坨 HTML：整坨会让判官把 class 名、内联样式、
        // 脚本变量当教学内容判，噪声淹掉真断言；而且 HTML 动辄几十 KB，
        // 撞 MAX_CONTENT_CHARS 会把别的字段挤出去。
        if (typeof value === 'string') walk(stripHtmlToText(value));
        continue;
      }
      walk(value);
    }
  };
  walk(content);
  return { text: parts.join(''), totalChars };
}

export function extractTeachingText(content: unknown): string {
  return extractTeachingTextMeta(content).text;
}

/** 带截断账目的版本：审核链用它，把截掉的字数写进审核结果而不是吞掉。 */
export function extractTeachingTextMeta(content: unknown): {
  text: string;
  truncatedChars: number;
} {
  const collected = collectTeachingTextWithin(content, MAX_CONTENT_CHARS);
  return {
    text: collected.text,
    truncatedChars: Math.max(0, collected.totalChars - collected.text.length),
  };
}

const JUDGE_SYSTEM = `你是独立的教学内容事实审核员。你审核的是另一个模型生成的课堂教学内容。
任务：从给定教学文本中抽取**事实性断言**（可以被判定对错的陈述——定义、数字、归因、机制描述、历史事实）。
不算断言的：教学类比与比喻、主观鼓励语、流程指令（"点击下一步"）、开放式提问。
对每条断言独立判定：
- supported：与领域公认知识一致
- uncertain：无法确认，或表述过于绝对/以偏概全
- incorrect：与公认知识相悖（必须给出修正 fix）
宁严勿松：模糊归因（"研究表明"无出处）、编造的具体数字、把比喻当机制陈述，都至少判 uncertain。

**带数字的句子按下面的口径拆，这是硬要求**（教学内容里的参数会被学习者拿去设备上设，抽错一条比漏一条概念严重）：
1. **条件从句不许剥离**。「超过 150ms 就停机」要整条进池，不许压成「150ms 停机」或「超时会停机」——
   前者丢了条件、后者丢了数字，两种都让这条断言无法判对错。
2. **阈值、单位、参数-后果各自成条**。同一句里出现「默认值是 X」「单位是 Y」「设成 Z 会导致 W」时，
   这是三条断言不是一条：它们可以分别对错，混成一条只能给一个判定。
3. 一次推演里互相配套的数字（「80ms 任务 + 70ms 余量 = 150ms 阈值」）算**一条**——
   拆开之后每个数字单独看都判不了。
4. 数字断言即使你觉得显然正确也要抽出来，不要因为「这是常识」跳过。
只输出一个 JSON 对象，不要围栏不要解释：
{"claims": [{"claim": "断言原文（截断到 80 字内）", "verdict": "supported|uncertain|incorrect", "reason": "一句话理由", "fix": "verdict 为 incorrect 时的修正表述"}]}
若文本中没有事实性断言，输出 {"claims": []}。`;

const COURSE_REVIEW_ADDENDUM = `

【全课程事实终审模式】
输入按 <scene> 分块，包含各场景逐屏审核留下的事实断言账本，以及 Action DSL 中学习者
能读到或听到的语义；参考资料是本课程获准使用的材料。
逐场景事实已经审过，本轮**只报告**下列课程级高风险问题：
1. 同一条件下的同一数字、单位、版本或安全阈值在不同场景互不相容；
2. 同一术语、状态或机制在不同场景被赋予互斥定义；
3. 最终内容与参考资料直接冲突；
4. 两个跨页命题在相同前提下不可能同时成立。
明确冲突判 incorrect；因条件缺失而无法消解判 uncertain。每条 claim 必须同时点明相关场景与冲突双方。
不要把不同工况、递进讲解、近似取整、示例参数或详略差异误判为冲突；不要重复输出无冲突的 supported 事实。
没有上述问题时输出 {"claims": []}。本轮只裁决，不改写课程内容。`;

const RESCUE_SYSTEM = `你是事实审核员。上一轮审核时，因为参考资料没有覆盖，你把某条断言判成了"存疑"。
现在系统**用这条断言本身作为查询词**重新检索了知识库，找到了下面这些新资料。
请仅依据新资料重新判定这一条断言：
- supported：新资料**直接支持**该断言（须回填支撑它的 source_id）
- uncertain：新资料仍未覆盖，或只是相关但不足以支撑
- incorrect：新资料与该断言相悖（须给出修正 fix）

**判定纪律（重要）**：
1. 不要因为"系统专门为它检索了一次"就倾向于判 supported——检索到相关段落 ≠ 支持该断言。
2. 资料只是话题相关、没有正面支撑具体说法的，仍判 uncertain。
3. 只有资料里能找到对应依据时才判 supported，并且必须给出 source_id。

只输出一个 JSON 对象，不要围栏不要解释：
{"verdict": "supported|uncertain|incorrect", "reason": "一句话理由", "sourceIds": ["..."], "fix": "仅 incorrect 时给出"}`;

const REVISE_SYSTEM = `你是教学内容修订员。给你一份场景内容 JSON 和审核员判定为错误的断言清单。
要求：
1. 逐条修正清单中的每个错误断言；依据给出的教材证据改写，不能只修其中一条。
2. **绝对不改变 JSON 的结构、字段名、数组长度和未被标记的内容**。
3. 输出修订后的完整 JSON，不要围栏不要解释。JSON 字符串内换行必须写成 \\n。`;

// 每屏最多几次「定向修订 → 复审」。复审轮里新裁定的 incorrect 断言也要有一次
// 消费 fix 的机会（否则拿着修正案定格 flagged），但环必须有界：两次修订仍改不
// 对的内容按 flagged 落盘，交草稿复核，不无限烧模型调用。
const MAX_REVISION_PASSES = 2;

/**
 * 按判错断言清单对一屏内容做一次定向修订（课程级终审用）。
 *
 * 全课事实终审「只裁决跨页冲突、不提供修订入口」——于是一条术语抖动（合同写「决策/执行」、
 * 教材写「思考/行动」）就把整门课永久钉在草稿。仲裁明明给了 fix，却没人消费。这里把
 * 屏级修订环里那一步抽出来给课程级复用：同一份 REVISE_SYSTEM、同一道结构守卫，
 * 修坏了返回 null（调用方保留原稿），不放宽任何判据。
 */
export async function reviseContentForClaims(
  content: unknown,
  claims: readonly AuditClaim[],
  evidence: string | undefined,
  reviseCall: (system: string, user: string) => Promise<string>,
): Promise<unknown | null> {
  const incorrect = claims.filter((c) => c.verdict === 'incorrect');
  if (incorrect.length === 0) return null;
  const issueList = incorrect
    .map((c, i) => `${i + 1}. ${c.claim} —— ${c.reason}${c.fix ? `；修正：${c.fix}` : ''}`)
    .join('\n');
  const revisedRaw = await reviseCall(
    REVISE_SYSTEM,
    `问题断言清单：
${issueList}

教材证据：
${evidence || '未提供'}

场景内容 JSON：
${JSON.stringify(content)}`,
  );
  const revised = parseJsonLoose(revisedRaw);
  return isStructurallyCompatible(revised, content) ? revised : null;
}

function parseJsonLoose(text: string): unknown {
  // Reasoning models (GLM) may prepend thinking text — strip it, then let the
  // shared repair parser try; final fallback is the outermost {...} substring.
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const parsed = parseJsonResponse<unknown>(cleaned);
  if (parsed !== null) return parsed;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Normalize a model-supplied source id list. Accepts `["S1"]`, `"S1, S2"` or
 * `"[S1]"` — models are inconsistent here and a citation is too valuable to
 * drop over formatting. Returns [] when nothing usable was given.
 */
function parseSourceIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、\s]+/) : [];
  return [
    ...new Set(
      list
        .map((s) =>
          String(s)
            .replace(/[[\]【】]/g, '')
            .trim(),
        )
        .filter((s) => s.length > 0 && s.length <= 64),
    ),
  ];
}

function parseClaims(raw: string, strict = false): AuditClaim[] | null {
  const parsed = parseJsonLoose(raw) as { claims?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.claims)) return null;
  const verdicts = new Set<string>(['supported', 'uncertain', 'incorrect']);
  const valid = (claim: unknown): claim is Record<string, unknown> =>
    !!claim &&
    typeof claim === 'object' &&
    typeof (claim as Record<string, unknown>).claim === 'string' &&
    Boolean(String((claim as Record<string, unknown>).claim).trim()) &&
    typeof (claim as Record<string, unknown>).reason === 'string' &&
    verdicts.has(String((claim as Record<string, unknown>).verdict));
  if (strict && parsed.claims.some((claim) => !valid(claim))) return null;
  return parsed.claims
    .filter((claim): claim is Record<string, unknown> =>
      strict
        ? valid(claim)
        : !!claim &&
          typeof claim === 'object' &&
          verdicts.has(String((claim as Record<string, unknown>).verdict)),
    )
    .map((c) => {
      const sourceIds = parseSourceIds(c.sourceIds ?? c.source_ids);
      return {
        claim: String(c.claim ?? '').slice(0, 160),
        verdict: c.verdict as ClaimVerdict,
        reason: String(c.reason ?? ''),
        ...(c.fix ? { fix: String(c.fix) } : {}),
        ...(sourceIds.length ? { sourceIds } : {}),
      };
    });
}

const EVIDENCE_ADDENDUM = `
本次审核附有【参考资料】——它是内容生成时被限定的事实来源，判定以资料为主要依据：
- supported：断言被资料直接支持，或是资料内容的合理同义转述
- uncertain：资料未覆盖该断言（即使常识上可能成立——超出证据边界如实标注）
- incorrect：与资料相悖，或与公认知识明显相悖
判定为 supported 时，必须在该条上加字段 "sourceIds"，列出支撑它的资料编号（资料每段开头方括号里的那个 id，如 ["S1","S3"]）。
找不到能支撑它的资料段就不要判 supported。`;

const QUIZ_ADDENDUM = `
注意：本场景是测验题。选择题的**干扰项（错误选项）是刻意设计的教学元素，不是断言，一律跳过不审**。
只审核：题干中的事实性陈述、标注的正确答案、答案解析。`;

async function runJudge(
  judgeCall: AiCall,
  sceneTitle: string,
  teachingText: string,
  evidence?: string,
  sceneType?: string,
  scope: AuditScope = 'scene',
): Promise<AuditClaim[] | null> {
  const system =
    JUDGE_SYSTEM +
    (scope === 'course' ? COURSE_REVIEW_ADDENDUM : '') +
    (evidence ? EVIDENCE_ADDENDUM : '') +
    (sceneType === 'quiz' ? QUIZ_ADDENDUM : '');
  const user =
    `场景标题：${sceneTitle}\n` +
    (evidence ? `参考资料：\n${evidence}\n\n` : '') +
    `教学文本：\n${teachingText}`;
  const raw = await judgeCall(system, user);
  const judged = parseClaims(raw, scope === 'course');
  if (!judged) return null;

  // 正则旁路（`lib/generation/numeric-claims.ts`）：判官漏抽的带单位数字机械补进池。
  // 抽取这一步此前没有兜底——判官没抽到的断言，后面整条链（判定/答辩/仲裁/修订）
  // 都碰不到，**看起来是「这一屏没问题」，实际是「这一屏没被看过」**。
  // 补进来的一律 uncertain 且永不判 incorrect：旁路只知道这里有个带单位的数，
  // 不知道它对不对；查无对照就弃权，判错会触发修订环去改一个可能本来正确的参数。
  // 消融开关：`NUMERIC_BYPASS=0` 时判官抽到什么就是什么，不补漏也不弃权。
  // 关掉等于让带单位的数字回到「没人看过」的状态——这正是要量的那一档。
  // 全课终审只找跨页冲突；把每个孤立数字机械补成 uncertain 会让任何含参数的正常课都误拦。
  if (scope === 'course' || !isNumericBypassEnabled()) return judged;
  return mergeNumericBypass(judged, teachingText, evidence, (claim, reason) => ({
    claim,
    verdict: 'uncertain' as ClaimVerdict,
    reason,
  })).claims;
}

// ─── Cross-validation → defense → arbitration ────────────────────────────────
//
// One judge is an opinion. Two judges that disagree is information: only the
// claims they split on are worth spending a defense + arbitration round on,
// and only the arbiter's ruling may trigger a rewrite. That kills the
// false-positive rewrites the single-judge loop used to run on every red flag.

const DEFEND_SYSTEM = `你是刚刚生成这段教学内容的作者模型，现在进入答辩环节。
两位独立判官对下列断言给出了不一致的判定。请对每条断言表态：
- accept：接受负面判定，承认该表述需要修正
- rebut：反驳，说明该断言为何成立；若参考资料支持它，必须在 sourceIds 里列出资料编号
不要嘴硬：既无资料支撑、也不属于领域公认常识的，一律 accept。
只输出一个 JSON 对象，不要围栏不要解释：
{"defenses":[{"index":1,"stance":"accept|rebut","argument":"一到两句理由","sourceIds":["S1"]}]}`;

const ARBITER_SYSTEM = `你是终审仲裁员，独立于两位判官与作者模型。
输入是若干条有争议的断言：两位判官各自的判定与理由、作者的答辩、以及参考资料。
逐条给出终审判定，以参考资料和领域公认知识为准，不迎合任何一方：
- supported：断言成立（作者反驳有效，或判官过严）
- uncertain：无法确认，或超出资料覆盖范围
- incorrect：确实与事实相悖（必须给出 fix 修正表述）
硬规则：「参考资料未涉及 / 作者自行引申的例子 / 资料未提供支撑」一律是 uncertain，不是 incorrect——
incorrect 只给与公认知识或参考资料**相悖**的陈述。教学类比、举例、练习题的情境设定不因资料没写而判错。
只输出一个 JSON 对象，不要围栏不要解释：
{"rulings":[{"index":1,"verdict":"supported|uncertain|incorrect","rationale":"一句话裁决理由","fix":"incorrect 时的修正表述","sourceIds":["S1"]}]}`;

const VERDICT_CN: Record<ClaimVerdict, string> = {
  supported: '核实',
  uncertain: '存疑',
  incorrect: '有误',
};

const SEVERITY: Record<ClaimVerdict, number> = { supported: 0, uncertain: 1, incorrect: 2 };

/** Claim texts differ between judges even when they mean the same thing — match on shape. */
const PUNCT = /[\s.,;:!?'"()[\]{}<>/\\|`~@#$%^&*+=_—–\-、，。；：！？“”‘’（）《》【】]/g;

function bigrams(text: string): Set<string> {
  const t = text.replace(PUNCT, '').toLowerCase();
  const out = new Set<string>();
  if (t.length === 1) out.add(t);
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * Containment overlap of character bigrams, 0..1. Containment rather than
 * Jaccard because the dominant difference between two judges quoting the same
 * sentence is truncation length — a quote that is a prefix of the other's
 * scores 1.0, where Jaccard would punish it for being shorter.
 */
export function claimSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size < 2 || B.size < 2) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / Math.min(A.size, B.size);
}

const MATCH_THRESHOLD = 0.6;
// ponytail: disputes capped so one chatty judge can't blow up the arbiter prompt;
// raise if real scenes routinely split on more than this.
const MAX_DISPUTES = 8;

export interface Dispute {
  /** Index into the merged claim list. */
  at: number;
  judgeVerdicts: string[];
  reasons: string[];
}

function mergeClaims(a: AuditClaim, b: AuditClaim): AuditClaim {
  const sourceIds = [...new Set([...(a.sourceIds ?? []), ...(b.sourceIds ?? [])])];
  return {
    ...a,
    ...(a.fix || b.fix ? { fix: a.fix || b.fix } : {}),
    ...(sourceIds.length ? { sourceIds } : {}),
  };
}

/**
 * Reconcile two independent judge verdicts over the same text.
 *
 * Agreement (including a claim only one judge extracted but rated `supported`,
 * i.e. nobody contests it) settles as consensus. A split — or a unilateral
 * flag, which is a split against the other judge's silence — becomes a dispute.
 */
export function crossValidate(
  judgeA: AuditClaim[],
  judgeB: AuditClaim[],
): { claims: AuditClaim[]; disputes: Dispute[] } {
  // 面板序号即称谓，模型串不进字符串——源头脱敏，见 DebateRound.judgeVerdicts。
  const [nameA, nameB] = [judgeRole(0), judgeRole(1)];
  const claims: AuditClaim[] = [];
  const disputes: Dispute[] = [];
  const usedB = new Set<number>();

  // Over the cap the claim still ships with the stricter verdict, just without a
  // `decidedBy` tag — unadjudicated is reported as unadjudicated.
  const dispute = (claim: AuditClaim, verdicts: string[], reasons: string[]) => {
    claims.push(claim);
    if (disputes.length < MAX_DISPUTES) {
      disputes.push({ at: claims.length - 1, judgeVerdicts: verdicts, reasons });
    }
  };

  for (const ca of judgeA) {
    let best = -1;
    let bestScore = 0;
    judgeB.forEach((cb, j) => {
      if (usedB.has(j)) return;
      const score = claimSimilarity(ca.claim, cb.claim);
      // Strict `>` so ties resolve to the earliest candidate — judges often
      // extract a long and a short cut of the same sentence, both scoring 1.0.
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    });
    if (bestScore < MATCH_THRESHOLD) best = -1;

    if (best < 0) {
      // Only judge A raised it. Uncontested `supported` is consensus; a
      // unilateral flag is a disagreement with judge B's silence.
      if (ca.verdict === 'supported') {
        claims.push({ ...ca, decidedBy: 'consensus' });
      } else {
        dispute(
          ca,
          [`${nameA} → ${VERDICT_CN[ca.verdict]}`, `${nameB} → 未提出该断言`],
          [ca.reason],
        );
      }
      continue;
    }

    const cb = judgeB[best];
    usedB.add(best);
    const merged = mergeClaims(ca, cb);
    if (ca.verdict === cb.verdict) {
      claims.push({ ...merged, decidedBy: 'consensus' });
    } else {
      // Provisionally take the stricter verdict until the arbiter rules.
      const strict = SEVERITY[ca.verdict] >= SEVERITY[cb.verdict] ? ca : cb;
      dispute(
        { ...merged, verdict: strict.verdict, reason: strict.reason },
        [`${nameA} → ${VERDICT_CN[ca.verdict]}`, `${nameB} → ${VERDICT_CN[cb.verdict]}`],
        [ca.reason, cb.reason],
      );
    }
  }

  judgeB.forEach((cb, j) => {
    if (usedB.has(j)) return;
    // Greedy 1-to-1 matching leaves a leftover when one judge cut the same
    // sentence twice (long + short). Already-represented text is dropped rather
    // than shipped as a second claim that would double-count in the metrics.
    if (claims.some((kept) => claimSimilarity(kept.claim, cb.claim) >= MATCH_THRESHOLD)) return;
    if (cb.verdict === 'supported') {
      claims.push({ ...cb, decidedBy: 'consensus' });
    } else {
      dispute(cb, [`${nameA} → 未提出该断言`, `${nameB} → ${VERDICT_CN[cb.verdict]}`], [cb.reason]);
    }
  });

  return { claims, disputes };
}

function renderDisputes(claims: AuditClaim[], disputes: Dispute[]): string {
  return disputes
    .map(
      (d, i) =>
        `${i + 1}. 断言：${claims[d.at].claim}\n` +
        `   判官判定：${d.judgeVerdicts.join('；')}\n` +
        `   判官理由：${d.reasons.filter(Boolean).join(' / ') || '（未给出）'}`,
    )
    .join('\n');
}

function parseIndexed(
  raw: string,
  key: 'defenses' | 'rulings',
): Map<number, Record<string, unknown>> {
  const parsed = parseJsonLoose(raw) as Record<string, unknown> | null;
  const list = parsed && Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : [];
  const out = new Map<number, Record<string, unknown>>();
  list.forEach((item, order) => {
    if (!item || typeof item !== 'object') return;
    const rec = item as Record<string, unknown>;
    const idx = Number(rec.index);
    out.set(Number.isFinite(idx) && idx > 0 ? idx - 1 : order, rec);
  });
  return out;
}

/**
 * Run defense (generator) + arbitration over the disputed claims. Mutates a
 * copy of the claim list with the arbiter's final verdicts and returns the
 * debate trail. Any failure leaves the stricter judge verdict in place and says
 * so in the trail — an unresolved dispute is never reported as adjudicated.
 */
async function adjudicate(
  claims: AuditClaim[],
  disputes: Dispute[],
  opts: { defendCall?: AiCall; arbiterCall?: AiCall; evidence?: string; sceneTitle: string },
): Promise<{ claims: AuditClaim[]; debate: DebateRound[] }> {
  const out = [...claims];
  const listing = renderDisputes(claims, disputes);
  const evidenceBlock = opts.evidence ? `参考资料：\n${opts.evidence}\n\n` : '';

  let defenses = new Map<number, Record<string, unknown>>();
  if (opts.defendCall) {
    try {
      defenses = parseIndexed(
        await opts.defendCall(
          DEFEND_SYSTEM,
          `场景标题：${opts.sceneTitle}\n${evidenceBlock}有争议的断言：\n${listing}`,
        ),
        'defenses',
      );
    } catch {
      defenses = new Map();
    }
  }
  const defenseText = (i: number): string => {
    const d = defenses.get(i);
    if (!d) return '（作者未答辩）';
    const stance = String(d.stance) === 'rebut' ? '反驳' : '接受修正';
    const cited = parseSourceIds(d.sourceIds ?? d.source_ids);
    return `${stance}：${String(d.argument ?? '')}${cited.length ? `［${cited.join(', ')}］` : ''}`;
  };

  let rulings = new Map<number, Record<string, unknown>>();
  if (opts.arbiterCall) {
    try {
      const defenseListing = disputes.map((_, i) => `${i + 1}. ${defenseText(i)}`).join('\n');
      rulings = parseIndexed(
        await opts.arbiterCall(
          ARBITER_SYSTEM,
          `场景标题：${opts.sceneTitle}\n${evidenceBlock}有争议的断言：\n${listing}\n\n作者答辩：\n${defenseListing}`,
        ),
        'rulings',
      );
    } catch {
      rulings = new Map();
    }
  }

  const valid = new Set<string>(['supported', 'uncertain', 'incorrect']);
  const debate: DebateRound[] = disputes.map((d, i) => {
    const ruling = rulings.get(i);
    const verdict = String(ruling?.verdict ?? '');
    const defense = defenseText(i);
    if (!ruling || !valid.has(verdict)) {
      return {
        claim: out[d.at].claim,
        judgeVerdicts: d.judgeVerdicts,
        defense,
        arbiterVerdict: 'unresolved',
        rationale: opts.arbiterCall
          ? '仲裁未给出可用判定，保留两个审核智能体中较严的一方。'
          : '未配置仲裁模型，保留两个审核智能体中较严的一方。',
      };
    }
    const cited = parseSourceIds(ruling.sourceIds ?? ruling.source_ids);
    const rationale = String(ruling.rationale ?? '');
    out[d.at] = {
      ...out[d.at],
      verdict: verdict as ClaimVerdict,
      reason: rationale || out[d.at].reason,
      decidedBy: 'arbitration',
      ...(ruling.fix ? { fix: String(ruling.fix) } : {}),
      ...(cited.length ? { sourceIds: cited } : {}),
    };
    return {
      claim: out[d.at].claim,
      judgeVerdicts: d.judgeVerdicts,
      defense,
      arbiterVerdict: verdict,
      rationale: rationale || '（未给出裁决理由）',
    };
  });

  return { claims: out, debate };
}

export interface AuditOptions {
  sceneTitle: string;
  content: unknown;
  /** 课程级终审复用同一审核器，只切换断言筛选口径。 */
  scope?: AuditScope;
  /** 已按场景聚合好的断言账本与 Action 可见语义。 */
  preExtractedTeachingText?: string;
  /** 聚合阶段因单屏/课程预算省略的可审文字数；必须随审核账单落盘。 */
  preExtractedTruncatedChars?: number;
  /** Single judge (legacy/batch path). Ignored when `judgeCalls` is non-empty. */
  judgeCall?: AiCall;
  /**
   * Judge panel. One entry = today's behavior exactly; two or more triggers
   * cross-validation (only the first two are used — a third judge costs a call
   * and buys nothing the arbiter doesn't already do).
   */
  judgeCalls?: AiCall[];
  /** Final ruling on disputed claims. Without it splits stay unresolved, honestly labelled. */
  arbiterCall?: AiCall;
  /** Generator-model call used for the revision pass and for the defense round. */
  reviseCall?: AiCall;
  /**
   * 作者答辩调用。不给就退回 `reviseCall`（旧行为，两件事共用一个调用）。
   * 分开的理由见 `lib/server/audit-panel.ts` 的 `AuditPanel.defendCall`：
   * 修订关思考更快更准，答辩关思考会跌破噪声地板——最优解相反，得能分别配置。
   */
  defendCall?: AiCall;
  judgeModel: string;
  /** Display names for the panel, in the same order as `judgeCalls`. */
  judgeModels?: string[];
  arbiterModel?: string;
  /** Evidence pool (source_id → title) so the UI can resolve claim citations. */
  sources?: Array<{ source_id: string; title: string }>;
  /** Evidence context — when present the judge verifies claims AGAINST it. */
  evidence?: string;
  /** 证据来自哪个语料库；随 `evidence` 一起给，用来在审核弹层标注取材来源。 */
  corpus?: string;
  /**
   * Claim-level retrieval, used to rescue `uncertain` verdicts.
   *
   * Scene-level retrieval queries by course + scene title, which surfaces
   * conceptual passages; a claim about a specific formula or number often sits
   * in a chunk that query never returns, and the judge — correctly, given what
   * it was shown — marks it "beyond the evidence". Re-querying with the claim's
   * own text usually finds the backing chunk that was there all along.
   *
   * Injected rather than imported so this module stays transport-free, matching
   * how judge/revise calls are supplied.
   */
  retrieveForClaim?: (claimText: string) => Promise<{
    evidence: string;
    count: number;
    /**
     * Chunks this query returned. They must be merged into the binding pool —
     * a claim-level query reaches passages the scene-level one missed, so its
     * ids are absent from `sources` and would otherwise be dropped as unbindable,
     * silently losing the citation on exactly the claims we just rescued.
     */
    sources?: Array<{ source_id: string; title: string }>;
  } | null>;
  /** How many controlled-KB chunks backed this audit (0 when ungrounded). */
  evidenceCount?: number;
  /** Scene type (slide/quiz/interactive/pbl) — quiz gets distractor-aware judging;
   * interactive skips revision (rewriting widget HTML JSON reliably breaks it). */
  sceneType?: string;
}

/**
 * Audit scene content; when claims are flagged and a reviseCall is provided,
 * run one revision pass and re-audit. Ordinary audit infrastructure failures
 * degrade to a `flagged` verdict with zero claims. `EvidenceGateError` is the
 * exception: configured retrieval empty/unavailable must still stop the course.
 */
export async function auditSceneContent(
  options: AuditOptions,
): Promise<{ audit: SceneAudit; content: unknown }> {
  const started = Date.now();
  const { sceneTitle, reviseCall, judgeModel, evidence, evidenceCount, sceneType } = options;
  const judges = options.judgeCalls?.length
    ? options.judgeCalls
    : options.judgeCall
      ? [options.judgeCall]
      : [];
  let content = options.content;
  let rounds = 0;
  let debate: DebateRound[] | undefined;
  let rescued: RescueRecord[] | undefined;
  let panelComplete = options.scope === 'course' ? false : undefined;
  /**
   * Binding pool for cited ids. Starts as the scene-level evidence and grows
   * with whatever claim-level retrieval surfaces, so a rescued claim's citation
   * resolves instead of being discarded as unbindable.
   */
  const sourcePool: Array<{ source_id: string; title: string }> = [...(options.sources ?? [])];

  /**
   * Bind cited ids back to the real evidence pool. Judges abbreviate
   * (`s5` for `ag020#s5`), and a citation that resolves to nothing is worse
   * than no citation at all — those are dropped, not rendered.
   */
  const bindSources = (ids?: string[]): string[] | undefined => {
    if (!ids?.length) return undefined;
    const pool = sourcePool;
    if (pool.length === 0) return ids; // ungrounded audit — nothing to bind against
    const bound = new Set<string>();
    for (const raw of ids) {
      const hit =
        pool.find((s) => s.source_id === raw) ??
        (raw.length >= 2
          ? pool.find((s) => s.source_id.endsWith(`#${raw}`) || raw.endsWith(s.source_id))
          : undefined);
      if (hit) bound.add(hit.source_id);
    }
    return bound.size ? [...bound] : undefined;
  };

  /**
   * Retry `uncertain` claims against evidence retrieved by the claim's own text.
   *
   * Bounded to MAX_RESCUE claims so a scene full of unciteable prose cannot turn
   * one audit into a dozen extra round-trips. A local optional miss or re-judge
   * error keeps the original verdict. A configured evidence-gate failure is
   * rethrown so it cannot be mislabeled as a caveat and published.
   */
  const MAX_RESCUE = 6;
  const rescueUncertain = async (claims: AuditClaim[]): Promise<AuditClaim[]> => {
    const retrieve = options.retrieveForClaim;
    if (!retrieve) return claims;
    const targets = claims.filter((c) => c.verdict === 'uncertain').slice(0, MAX_RESCUE);
    if (targets.length === 0) return claims;

    rescued = [];
    const judge = judges[0];
    const updates = new Map<string, AuditClaim>();

    await Promise.all(
      targets.map(async (claim) => {
        try {
          const hit = await retrieve(claim.claim);
          if (hit?.sources?.length) {
            for (const s of hit.sources) {
              if (!sourcePool.some((p) => p.source_id === s.source_id)) sourcePool.push(s);
            }
          }
          if (!hit || hit.count === 0) {
            rescued!.push({
              claim: claim.claim,
              before: 'uncertain',
              after: 'uncertain',
              evidenceCount: 0,
              reason: '断言级二次检索未命中：受控知识库确实未覆盖该断言。',
            });
            return;
          }
          const raw = await judge(
            RESCUE_SYSTEM,
            `断言：${claim.claim}\n上一轮判定理由：${claim.reason}\n\n新检索到的资料：\n${hit.evidence}`,
          );
          const parsed = parseJsonLoose(raw) as {
            verdict?: unknown;
            reason?: unknown;
            sourceIds?: unknown;
            fix?: unknown;
          } | null;
          const verdicts = new Set<string>(['supported', 'uncertain', 'incorrect']);
          const next = String(parsed?.verdict ?? '');
          if (!parsed || !verdicts.has(next)) {
            rescued!.push({
              claim: claim.claim,
              before: 'uncertain',
              after: 'uncertain',
              evidenceCount: hit.count,
              reason: '二次判定输出无法解析，保留原判定。',
            });
            return;
          }
          const reason = String(parsed.reason ?? '');
          rescued!.push({
            claim: claim.claim,
            before: 'uncertain',
            after: next as ClaimVerdict,
            evidenceCount: hit.count,
            reason,
          });
          if (next !== 'uncertain') {
            updates.set(claim.claim, {
              ...claim,
              verdict: next as ClaimVerdict,
              reason: `${reason}（断言级二次检索后改判）`,
              ...(Array.isArray(parsed.sourceIds)
                ? { sourceIds: parsed.sourceIds.map(String) }
                : {}),
              ...(parsed.fix ? { fix: String(parsed.fix) } : {}),
            });
          }
        } catch (error) {
          if (error instanceof EvidenceGateError) throw error;
          rescued!.push({
            claim: claim.claim,
            before: 'uncertain',
            after: 'uncertain',
            evidenceCount: 0,
            reason: '二次检索调用失败，保留原判定。',
          });
        }
      }),
    );

    return updates.size ? claims.map((c) => updates.get(c.claim) ?? c) : claims;
  };

  const finish = (verdict: SceneAudit['verdict'], rawClaims: AuditClaim[]): SceneAudit => {
    const claims = rawClaims.map((c) => {
      const sourceIds = bindSources(c.sourceIds);
      const { sourceIds: _drop, ...rest } = c;
      return sourceIds ? { ...rest, sourceIds } : rest;
    });
    // "flagged with zero claims" is the audit-infrastructure failure signal.
    const auditFailed = verdict === 'flagged' && claims.length === 0;
    const { decision, rationale } = ruleOnClaims(claims, auditFailed);
    return {
      verdict,
      claims,
      totalClaims: claims.length,
      flaggedCount: claims.filter((c) => c.verdict !== 'supported').length,
      uncertainCount: claims.filter((c) => c.verdict === 'uncertain').length,
      incorrectCount: claims.filter((c) => c.verdict === 'incorrect').length,
      judgeModel,
      rounds,
      durationMs: Date.now() - started,
      ...(truncatedChars > 0 ? { truncatedChars } : {}),
      decision,
      rationale,
      grounded: Boolean(evidence),
      ...(evidence && options.corpus ? { corpus: options.corpus } : {}),
      evidenceCount: evidenceCount ?? 0,
      ...(debate ? { debate } : {}),
      ...(options.judgeModels?.length ? { judgeModels: options.judgeModels } : {}),
      ...(options.arbiterModel ? { arbiterModel: options.arbiterModel } : {}),
      ...(sourcePool.length ? { sources: sourcePool } : {}),
      ...(rescued ? { rescued } : {}),
      ...(panelComplete !== undefined ? { panelComplete } : {}),
    };
  };

  /**
   * One audit round. A single judge is today's path verbatim; two judges get
   * cross-validated, and only the claims they split on cost a defense +
   * arbitration call. Scene audits retain the surviving-judge fallback; course
   * audits require both configured judges and fail closed when either answer is missing or invalid.
   *
   * The returned trail describes exactly the returned claim list, so a re-audit
   * *replaces* the previous round's trail instead of appending to it — otherwise
   * "仲裁 N 条分歧" counts disputes over claims that were already rewritten away.
   */
  let truncatedChars = 0;
  const runRound = async (
    textOverride?: string,
  ): Promise<{
    claims: AuditClaim[];
    debate?: DebateRound[];
  } | null> => {
    let text: string;
    if (textOverride !== undefined) {
      text = textOverride;
    } else {
      if (options.preExtractedTeachingText !== undefined) {
        text = options.preExtractedTeachingText;
        truncatedChars = Math.max(0, options.preExtractedTruncatedChars ?? 0);
      } else {
        const meta = extractTeachingTextMeta(content);
        text = meta.text;
        truncatedChars = meta.truncatedChars;
      }
    }
    if (judges.length === 1) {
      const claims = await runJudge(
        judges[0],
        sceneTitle,
        text,
        evidence,
        sceneType,
        options.scope,
      );
      return claims && { claims };
    }
    // A throwing judge (429/timeout — judge calls run with maxRetries: 0) must not
    // take the panel down with it: Promise.all would reject and degrade the whole
    // audit to "failed", which is strictly worse than the single-judge path it
    // replaced. Swallow to null so the surviving judge's verdicts still count.
    const [a, b] = await Promise.all(
      judges
        .slice(0, 2)
        .map((j) =>
          runJudge(j, sceneTitle, text, evidence, sceneType, options.scope).catch(() => null),
        ),
    );
    // 场景级保留既有降级语义；课程终审必须拿到两份合法判词，不能把单判官冒充交叉验证。
    if (a === null || b === null) {
      if (options.scope === 'course') return null;
      const solo = a ?? b;
      return solo && { claims: solo };
    }
    if (options.scope === 'course') panelComplete = true;
    const { claims, disputes } = crossValidate(a, b);
    // panel ran and agreed — an empty trail, not a missing one
    if (disputes.length === 0) return { claims, debate: [] };
    const resolved = await adjudicate(claims, disputes, {
      defendCall: options.defendCall ?? reviseCall,
      arbiterCall: options.arbiterCall,
      evidence,
      sceneTitle,
    });
    return { claims: resolved.claims, debate: resolved.debate };
  };

  // Uncertain-only sets are annotations (beyond evidence coverage), not errors —
  // only `incorrect` claims justify a rewrite. Interactive widgets are never
  // rewritten: regenerating widget-HTML-bearing JSON reliably breaks it.
  const settle = (claims: AuditClaim[], revisedClean: boolean): SceneAudit['verdict'] => {
    const incorrect = claims.some((c) => c.verdict === 'incorrect');
    if (incorrect) return 'flagged';
    if (revisedClean) return 'revised';
    return claims.some((c) => c.verdict === 'uncertain') ? 'caveat' : 'pass';
  };

  try {
    if (judges.length === 0) {
      return { audit: finish('flagged', []), content };
    }
    rounds = 1;
    let first = await runRound();
    // 课程终审吃的是整门课的文本，判官 180s 超时并不罕见（2026-09-02 实测：两门课并发时
    // 一轮两位判官双双超时 → flagged/0 claims → 整课草稿）。整轮再来一次；第二轮仍失败
    // 照旧 fail closed，不伪造判词。屏级保留原语义（屏审失败有单判官降级路径）。
    if (first === null && options.scope === 'course') {
      first = await runRound();
    }
    if (first === null) {
      return { audit: finish('flagged', []), content };
    }
    debate = first.debate;
    // Rescue pass before any rewrite decision: a claim the scene-level query
    // simply failed to surface evidence for should not be carried into the gate
    // ruling as "beyond coverage" until we have queried for it directly.
    const firstClaims = await rescueUncertain(first.claims);
    // Post-arbitration verdicts: a claim only reaches the rewrite branch once the
    // arbiter (or the lone judge) has actually called it incorrect.
    //
    // interactive 曾被排除在修订之外，理由是教具是整页 HTML、重写风险大。
    // 但配合 block 不再丢内容之后，这个排除只剩坏处：教具一次判定即出局、
    // rounds 停在 1，是「教具永远卡在生成中」的结构性来源之一。
    // 现在允许修订——修订失败会被 isStructurallyCompatible 挡回原内容，
    // 最坏情况等于不修订，不会更糟。
    const canRevise = Boolean(reviseCall);

    // ── 有界修订环：最多 MAX_REVISION_PASSES 次「定向修订 → 复审」──────────
    //
    // 原来只许一轮修订。复审那一轮里**新冒头**的 incorrect 断言（第一轮判官没抽
    // 到、或仲裁在第二轮才裁定）拿到了仲裁给的 fix，却再没有消费机会——整页定格
    // flagged，发布门于是永远拒。双域真实生成各挂两屏，全是这个形态。
    // 环维持同一套语义：每轮只改判错的那几句，复审仍走全量/增量同一条路。
    let claims = firstClaims;
    let revisedClean = false;
    for (let pass = 0; pass < MAX_REVISION_PASSES; pass += 1) {
      const incorrectClaims = claims.filter((c) => c.verdict === 'incorrect');
      if (incorrectClaims.length === 0 || !canRevise) break;

      // One revision pass by the generator model (incorrect claims only), then re-audit.
      const issueList = incorrectClaims
        .map((c, i) => `${i + 1}. ${c.claim} —— ${c.reason}${c.fix ? `；修正：${c.fix}` : ''}`)
        .join('\n');
      const revisedRaw = await reviseCall!(
        REVISE_SYSTEM,
        `问题断言清单：\n${issueList}\n\n教材证据：\n${evidence || '未提供'}\n\n场景内容 JSON：\n${JSON.stringify(content)}`,
      );
      const revised = parseJsonLoose(revisedRaw);
      // 原来的守卫是 `revised.type === content.type`——而 GeneratedSlideContent /
      // QuizContent / InteractiveContent 顶层压根没有 type 字段，两边都是 undefined，
      // 这个条件恒真。等于没有守卫：模型吐回来的任何 JSON 都会整体替换掉原内容。
      // 唯一会生效的方向还是反的（模型多吐一个顶层 type 反而被拒）。
      //
      // 换成按形状校验：修订产物必须保留原内容的关键结构，且元素不能变少——
      // 修订的语义是「改错的那几句」，不是「重写这一页」。
      const prevContent = content;
      const prevDebate = debate;
      if (isStructurallyCompatible(revised, content)) {
        content = revised;
      } else {
        // Revision broke the schema — keep the last good content and report honestly.
        return { audit: finish('flagged', claims), content: prevContent };
      }

      // ── 增量复审（WO-N9，`INCREMENTAL_REAUDIT=1` 开，默认关）───────────────
      //
      // 关着时下面这段等价于整页重喂、整表替换，一字不差。
      //
      // 开着时只审改动段。理由：修订的语义是「把判错的那几句改对」——REVISE_SYSTEM
      // 明文要求不许改结构、不许动未标记的内容，isStructurallyCompatible 还兜了一道。
      // 也就是说这一页绝大部分文本与上一轮**逐字相同**，对它们重判是纯浪费
      // （实测：一轮收的屏审核中位 119s，走到第二轮的 375s）。
      //
      // 改动段的识别必须机械可复算，不能让模型自己说改了哪：extractTeachingText
      // 本来就是把可见教学文本按 '\n' 拼起来的，直接比行集合。
      const incremental = isIncrementalReauditEnabled();
      const oldLines = extractTeachingText(prevContent).split('\n').filter(Boolean);
      const newLines = extractTeachingText(content).split('\n').filter(Boolean);
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      const addedLines = newLines.filter((l) => !oldSet.has(l));
      const removedLines = oldLines.filter((l) => !newSet.has(l));
      // 改动前后的行都算「碰过」：修订通常是就地改写一句，旧断言引的是旧文本、
      // 新判定引的是新文本，两边都要能匹配上才不会漏掉该作废的一轮判定。
      const touchedLines = [...addedLines, ...removedLines];

      // 修订产物在可见文本层面与原文一字不差（模型只改了不进审核的字段，或干脆
      // 原样吐回）。这时复审没有任何新东西可审，上一轮判定原样成立——省掉整轮，
      // 也不再继续下一次修订（同样的输入只会得到同样的不作为）。两种模式都适用；
      // 增量模式下纯删除（added 空、removed 非空）也没有新文本可审，同样收口。
      if (addedLines.length === 0 && (incremental || removedLines.length === 0)) {
        return { audit: finish('flagged', claims), content };
      }

      rounds += 1;
      const reaudit = await runRound(incremental ? addedLines.join('\n') : undefined);
      // Re-audit unavailable: report the previous round's claims — and its trail.
      if (reaudit === null) {
        return { audit: finish('revised', claims), content };
      }
      debate = reaudit.debate;
      let nextClaims = reaudit.claims;
      if (incremental) {
        // 上一轮判定里，凡是能匹配到改动行的都作废（那段文本已经被重判过了）；
        // 匹配用的是模块里现成的 claimSimilarity + MATCH_THRESHOLD，不另造一把尺子。
        const touched = (claim: string) =>
          touchedLines.some((line) => claimSimilarity(claim, line) >= MATCH_THRESHOLD);
        const carried = claims.filter((c) => !touched(c.claim));
        // 复审若重复抽出了沿用断言里的同一句，以复审为准（它看的是改后文本）。
        const deduped = carried.filter(
          (c) => !reaudit.claims.some((s) => claimSimilarity(c.claim, s.claim) >= MATCH_THRESHOLD),
        );
        nextClaims = [...deduped, ...reaudit.claims];
        // 答辩记录也要跟着合并，否则沿用下来的断言标着 decidedBy:'arbitration' 却找不到
        // 对应的仲裁条目——模块自己的约定是「trail 精确描述返回的断言表」，
        // 界面上就会出现「仲裁了 N 条」但只列得出 M 条。基线是整表替换所以不会分叉，
        // 增量必须显式接上。
        const carriedDebate = (prevDebate ?? []).filter((d) =>
          deduped.some((c) => claimSimilarity(c.claim, d.claim) >= MATCH_THRESHOLD),
        );
        debate = [...carriedDebate, ...(reaudit.debate ?? [])];
      }
      claims = nextClaims;
      revisedClean = true;
    }
    return { audit: finish(settle(claims, revisedClean), claims), content };
  } catch (error) {
    if (error instanceof EvidenceGateError) throw error;
    return { audit: finish('flagged', []), content: options.content };
  }
}

export interface CourseAuditScene {
  id?: string;
  outlineId?: string;
  title: string;
  type?: string;
  content: unknown;
  actions?: unknown;
  audit?: SceneAudit | null;
}

export type CourseAuditOptions = Omit<
  AuditOptions,
  | 'sceneTitle'
  | 'content'
  | 'scope'
  | 'preExtractedTeachingText'
  | 'preExtractedTruncatedChars'
  | 'reviseCall'
  | 'sceneType'
> & {
  courseTitle: string;
  scenes: readonly CourseAuditScene[];
  learningContract?: LearningContractPlan;
  /** 判词结构校验拒绝时的诊断回调（服务端注入落盘实现）。 */
  onAlignmentJudgeReject?: (info: AlignmentJudgeReject) => void;
};

type CourseHashScene = Pick<
  CourseAuditScene,
  'id' | 'outlineId' | 'type' | 'content' | 'actions'
> & { title?: string };

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeForHash(child)]),
  );
}

export function hashLearningContractPlan(plan: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(plan)))
    .digest('hex');
}

/** Hash exactly the final scene fields whose post-audit mutation invalidates publication. */
export function hashCourseScenes(scenes: readonly CourseHashScene[]): string {
  const payload = scenes.map(({ id, outlineId, title, type, content, actions }) => ({
    id,
    outlineId,
    title,
    type,
    content,
    actions,
  }));
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(payload)))
    .digest('hex');
}

function textField(value: unknown, html = false): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const text = html ? stripHtmlToText(value) : value.trim();
  return text ? [text] : [];
}

function visibleScalars(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(visibleScalars);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? [String(value)]
    : [];
}

/** Only fields a learner can read or hear; layout coordinates, colors and ids never enter review. */
function visibleActionTexts(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action) => {
    if (!action || typeof action !== 'object') return [];
    const record = action as Record<string, unknown>;
    switch (record.type) {
      case 'speech':
        return textField(record.text);
      case 'discussion':
        return [...textField(record.topic), ...textField(record.prompt)];
      case 'wb_draw_text':
        return textField(record.content, true);
      case 'wb_draw_code':
        return textField(record.code);
      case 'wb_edit_code':
        return textField(record.content);
      case 'wb_draw_latex':
        return textField(record.latex);
      case 'wb_draw_table':
        return visibleScalars(record.data);
      case 'wb_draw_chart': {
        const data =
          record.data && typeof record.data === 'object'
            ? (record.data as Record<string, unknown>)
            : {};
        return [
          ...visibleScalars(data.labels),
          ...visibleScalars(data.legends),
          ...visibleScalars(data.series),
        ];
      }
      case 'widget_annotation':
      case 'widget_highlight':
      case 'widget_reveal':
      case 'widget_setState':
        return textField(record.content);
      default:
        return [];
    }
  });
}

function buildCourseTeachingText(scenes: readonly CourseAuditScene[]): {
  text: string;
  truncatedChars: number;
} {
  let sceneTruncatedChars = 0;
  const full = scenes
    .map((scene, index) => {
      const title = scene.title.trim() || `场景 ${index + 1}`;
      const teaching = extractTeachingTextMeta(scene.content);
      sceneTruncatedChars += teaching.truncatedChars;
      const claimLedger = (scene.audit?.claims ?? []).map((claim) => `- ${claim.claim}`).join('\n');
      const actionLedger = visibleActionTexts(scene.actions)
        .map((text) => `- ${text}`)
        .join('\n');
      return (
        `<scene index="${index + 1}" title="${title.replace(/"/g, '&quot;')}">\n` +
        `【最终可见正文】\n${teaching.text || '（无可见正文）'}\n` +
        `【逐屏事实断言账本】\n${claimLedger || '（无事实断言）'}\n` +
        `【Action 可见语义】\n${actionLedger || '（无可见动作语义）'}\n` +
        `</scene>`
      );
    })
    .join('\n\n');

  return {
    text: full.slice(0, COURSE_TOTAL_TEXT_BUDGET),
    truncatedChars: sceneTruncatedChars + Math.max(0, full.length - COURSE_TOTAL_TEXT_BUDGET),
  };
}

const LEARNING_ALIGNMENT_SYSTEM = `你是全课程教学履约终审员。事实真假由另一条审核链负责；你只判断最终可见课程是否真正完成了已批准的学习目标。

输入包含：可观察目标（action、condition、successCriterion）、目标与五个教学阶段的场景映射，以及这些场景的最终可见正文和动作语义。逐条判断：
- prerequisiteActivation：是否激活完成目标动作所需的相关先备经验，而不是无关热身；
- demonstration：是否示范目标动作在给定条件下如何做到达标，而不是只介绍概念；
- learnerPractice：是否让学习者实际执行目标动作；
- feedbackRetry：是否依据成功标准指出差距，并给出可再次尝试的机会；
- transferApplication：是否保持同一目标动作和成功标准，同时换到与示范/练习实质不同的新情境或新输入。

判定口径：本课程的媒介是幻灯片、测验（选择/多选/简答）、互动控件与 PBL，没有线下实操台。
learnerPractice 的「实际执行」以媒介可承载为准：学习者在测验或控件中亲自完成目标动作（识别、排序、判定、说明、补全关键步骤或代码行、设计方案）即算执行，不要以线下动手操作为标准判 misaligned；
带步骤、输入与结果反馈的实操控件（procedural-skill 类型的交互场景：检查站、配置台、标定台）就是本媒介里的动手执行，其中的操作步骤与判定即为练习证据；
feedbackRetry 只要点名了常见错答/误解、对照 successCriterion 说明差距、并再给同目标的作答机会即算履约；
但目标动作本身若在这些媒介里根本无法执行或无法判定，判 misaligned 并在 reason 写明是目标不可评。

硬规则：
1. 有出处只说明事实来源，不等于完成教学目标；内容与目标无关必须判 misaligned。
2. 只复述 action/condition/successCriterion 的关键词、改标题、换数字或换人名，不算语义证据。
3. 每个输入映射必须且只能输出一条 item；不得遗漏、合并或新增映射。
4. aligned 的 evidenceQuote 必须**逐字**摘自对应场景（sceneId 所指那一屏）的最终可见内容：可以引用多句并用「……」分隔，但每一句都必须原样复制、不得改写、不得引用别的场景；引文要足以说明为何履约；不得引用目标文本。
5. 每条 phase 为 transferApplication 的 item 都必须带布尔字段 newContext（情境是否与示范/练习实质不同）；判 aligned 时 newContext 必须为 true，缺字段按结构错误处理。
6. 任一 item 为 misaligned，则总 verdict 必须为 misaligned。

只输出 JSON 对象，不要围栏或解释：
{"verdict":"aligned|misaligned","rationale":"一句话总判定","items":[{"objectiveId":"O1","phase":"prerequisiteActivation|demonstration|learnerPractice|feedbackRetry|transferApplication","sceneId":"scene-id","verdict":"aligned|misaligned","evidenceQuote":"对应场景原文摘录；无相关证据时可空","reason":"说明该内容为何履约或为何无关","newContext":true}]}`;

const ALIGNMENT_PHASES: LearningContractPhase[] = [
  'prerequisiteActivation',
  'demonstration',
  'learnerPractice',
  'feedbackRetry',
  'transferApplication',
];

interface LearningAlignmentExpectation {
  objectiveId: string;
  phase: LearningContractPhase;
  sceneId: string;
  sceneText: string;
}

function alignmentKey(value: {
  objectiveId: string;
  phase: LearningContractPhase;
  sceneId: string;
}): string {
  return `${value.objectiveId}\u0000${value.phase}\u0000${value.sceneId}`;
}

function normalizedEvidenceQuote(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 判词引用是否逐字绑定到该屏：把引用按省略号 / 句末标点 / 换行切段，每一段（去标点后
 * ≥ 6 字）都必须是该屏可见文本的连续逐字子串。
 *
 * 为什么不是整段连续匹配：屏内容是结构化字段（题干、选项、解析、表格格），判官天然会把
 * 题干和解析拼成一句、或用「……」跨过选项。2026-09-02 实测两位判官四次判词全因此被拒——
 * 引用每一段都真实出自该屏，只是拼接。分段匹配保留绑定语义（换屏的引用、改写的引用照拒），
 * 只放过拼接。
 */
function quoteBoundToScene(quote: string, sceneText: string): boolean {
  const scene = normalizedEvidenceQuote(sceneText);
  if (!scene) return false;
  const segments = quote
    .split(/…+|\.{3,}|[。！？；\n]+/u)
    .map(normalizedEvidenceQuote)
    .filter((segment) => segment.length >= 6);
  if (segments.length === 0) return scene.includes(normalizedEvidenceQuote(quote));
  // 绑定的目的是「引用出自这一屏」，不是逐字保真。实测（2026-09-02 AI 域第七跑）两位判官
  // 三次判词全因一段代码块引文的细微转述（Observation 行）或一句总结性转述被整份拒掉，
  // 其余五六段全部逐字命中。改为：至少三分之二片段命中，且至少一段 ≥12 字命中——
  // 换屏引用（全部不命中）、整段改写照拒；只容忍一段转述。
  // 2026-09-02 第八跑：两段引文一段逐字命中（20+ 字）、另一段只是括注位置被判官挪了，
  // 2/3 规则把 1/2 判死、三次尝试全灭。绑定语义只需要「有一段足够长的逐字锚点 + 至少一半
  // 片段命中」；整段改写（0 命中）与换屏引用照拒。
  const bound = segments.filter((segment) => scene.includes(segment));
  return (
    bound.length >= Math.max(1, Math.ceil(segments.length / 2)) &&
    bound.some((segment) => segment.length >= 12)
  );
}

/**
 * 判词被结构校验拒掉时的诊断钩子。终审失败的唯一线上症状是一句「未取得两份结构完整的判词」，
 * 不留原文就永远只能猜是哪条校验在杀判词。本模块被客户端 hook 引用，不能碰 node:fs——
 * 落盘由服务端调用方注入（见 lib/server/alignment-judge-debug.ts）；钩子抛错不影响审核结论。
 */
export interface AlignmentJudgeReject {
  judgeModel: string;
  attempt: number;
  reject: string;
  raw: string;
}

function buildLearningAlignmentReview(
  plan: LearningContractPlan,
  scenes: readonly CourseAuditScene[],
): {
  prompt: string;
  expectations: LearningAlignmentExpectation[];
  violations: string[];
} {
  const structural = validateLearningContractFulfillment(plan, scenes, {
    actualContentReady: false,
  });
  if (!structural.fulfilled) {
    return { prompt: '', expectations: [], violations: structural.violations };
  }

  const planned = new Map(plan.plannedScenes.map((scene) => [scene.sceneId, scene]));
  const actual = new Map(
    scenes
      .filter((scene) => Boolean(scene.outlineId?.trim()))
      .map((scene) => [scene.outlineId!.trim(), scene] as const),
  );
  const sceneTexts = new Map<string, string>();
  let truncatedChars = 0;
  for (const [sceneId, scene] of actual) {
    const teaching = extractTeachingTextMeta(scene.content);
    truncatedChars += teaching.truncatedChars;
    sceneTexts.set(
      sceneId,
      [teaching.text, ...visibleActionTexts(scene.actions)].filter(Boolean).join('\n'),
    );
  }

  const expectations = ALIGNMENT_PHASES.flatMap((phase) =>
    plan.required[phase].flatMap((sceneId) =>
      (planned.get(sceneId)?.objectiveIds ?? []).map((objectiveId) => ({
        objectiveId,
        phase,
        sceneId,
        sceneText: sceneTexts.get(sceneId) ?? '',
      })),
    ),
  );
  const mappedSceneIds = [...new Set(expectations.map((item) => item.sceneId))];
  const objectiveText = plan.objectives
    .map(
      (objective) =>
        `- ${objective.id}\n  action: ${objective.action}\n  condition: ${objective.condition}\n  successCriterion: ${objective.successCriterion}`,
    )
    .join('\n');
  const mappingText = expectations
    .map(
      (item) =>
        `- objectiveId=${item.objectiveId}; phase=${item.phase}; sceneId=${item.sceneId}`,
    )
    .join('\n');
  const sceneText = mappedSceneIds
    .map((sceneId) => {
      const scene = actual.get(sceneId);
      return `<scene id="${sceneId}" title="${(scene?.title ?? '').replace(/"/g, '&quot;')}">\n${sceneTexts.get(sceneId) || '（无最终可见内容）'}\n</scene>`;
    })
    .join('\n\n');
  const full = `【批准的学习目标】\n${objectiveText}\n\n【必须逐条裁决的映射】\n${mappingText}\n\n【映射场景的最终可见内容】\n${sceneText}`;
  truncatedChars += Math.max(0, full.length - COURSE_TOTAL_TEXT_BUDGET);

  return {
    prompt: full.slice(0, COURSE_TOTAL_TEXT_BUDGET),
    expectations,
    violations:
      truncatedChars > 0
        ? [`教学履约终审输入有 ${truncatedChars} 字未进入双判官上下文`]
        : [],
  };
}

function parseLearningAlignmentJudge(
  raw: string,
  judgeModel: string,
  expectations: readonly LearningAlignmentExpectation[],
): LearningAlignmentJudgeResult | { reject: string } {
  // 每条 return 都带机器可读的拒绝原因：重试提示要能告诉判官上一份错在哪
  // （泛泛的「未通过结构校验」实测救不回来——双域终审两位判官各两次全军覆没），
  // 诊断落盘也靠它定位是哪条校验在杀判词。
  const parsed = parseJsonLoose(raw) as Record<string, unknown> | null;
  if (!parsed) return { reject: '输出不是可解析的 JSON 对象' };
  if (parsed.verdict !== 'aligned' && parsed.verdict !== 'misaligned') {
    return { reject: '顶层 verdict 必须是 aligned 或 misaligned' };
  }
  if (typeof parsed.rationale !== 'string' || !parsed.rationale.trim()) {
    return { reject: '缺少非空的顶层 rationale' };
  }
  if (!Array.isArray(parsed.items) || parsed.items.length !== expectations.length) {
    return {
      reject: `items 必须恰好 ${expectations.length} 条（收到 ${Array.isArray(parsed.items) ? parsed.items.length : '非数组'}），逐条对应输入映射，不得合并或遗漏`,
    };
  }

  const expected = new Map(expectations.map((item) => [alignmentKey(item), item]));
  const seen = new Set<string>();
  const items: LearningAlignmentItem[] = [];
  for (const [index, candidate] of parsed.items.entries()) {
    const at = `第 ${index + 1} 条 item`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { reject: `${at}不是对象` };
    }
    const item = candidate as Record<string, unknown>;
    const objectiveId = String(item.objectiveId ?? '').trim();
    const phase = String(item.phase ?? '').trim() as LearningContractPhase;
    const sceneId = String(item.sceneId ?? '').trim();
    const verdict = item.verdict;
    const reason = String(item.reason ?? '').trim();
    if (!ALIGNMENT_PHASES.includes(phase)) return { reject: `${at}的 phase「${phase}」非法` };
    if (verdict !== 'aligned' && verdict !== 'misaligned') {
      return { reject: `${at}的 verdict 必须是 aligned 或 misaligned` };
    }
    if (!reason) return { reject: `${at}缺少 reason` };
    const key = alignmentKey({ objectiveId, phase, sceneId });
    const expectation = expected.get(key);
    if (!expectation) {
      return {
        reject: `${at}的映射 ${objectiveId}/${phase}/${sceneId} 不在输入映射清单里——objectiveId、phase、sceneId 必须逐字照抄清单`,
      };
    }
    if (seen.has(key)) return { reject: `${at}与之前的 item 重复了同一条映射` };
    seen.add(key);

    const evidenceQuote = String(item.evidenceQuote ?? '').trim();
    const normalizedQuote = normalizedEvidenceQuote(evidenceQuote);
    // Quote length is only a binding check; semantic alignment is decided by both judges.
    if (verdict === 'aligned' && normalizedQuote.length < 8) {
      return { reject: `${at}判 aligned 但 evidenceQuote 过短——须逐字摘录足以证明履约的场景原文` };
    }
    if (normalizedQuote && !quoteBoundToScene(evidenceQuote, expectation.sceneText)) {
      return {
        reject: `${at}的 evidenceQuote 有片段不是场景 ${sceneId} 原文的逐字摘录（可用「……」分隔多句，但每一句都必须逐字出自该场景，不得改写、不得引用其他场景）`,
      };
    }
    if (phase === 'transferApplication' && verdict === 'aligned' && item.newContext !== true) {
      return { reject: `${at}是 transferApplication 且判 aligned，newContext 必须为布尔 true` };
    }
    items.push({
      objectiveId,
      phase,
      sceneId,
      verdict,
      ...(evidenceQuote ? { evidenceQuote } : {}),
      reason,
      ...(phase === 'transferApplication' ? { newContext: item.newContext === true } : {}),
    });
  }

  const derived = items.every(
    (item) =>
      item.verdict === 'aligned' &&
      (item.phase !== 'transferApplication' || item.newContext === true),
  )
    ? 'aligned'
    : 'misaligned';
  if (parsed.verdict !== derived) {
    return { reject: `顶层 verdict（${String(parsed.verdict)}）与逐条判定推导（${derived}）不一致——任一 item 为 misaligned 时总判定必须 misaligned` };
  }
  if (seen.size !== expected.size) return { reject: 'items 未覆盖全部输入映射' };
  return { judgeModel, verdict: derived, rationale: parsed.rationale.trim(), items };
}

async function auditLearningContractAlignment(
  options: CourseAuditOptions & { learningContract: LearningContractPlan },
  courseContentHash: string,
): Promise<LearningContractAlignmentAudit> {
  const learningContractHash = hashLearningContractPlan(options.learningContract);
  const review = buildLearningAlignmentReview(options.learningContract, options.scenes);
  if (review.violations.length > 0) {
    return {
      courseContentHash,
      learningContractHash,
      complete: false,
      aligned: false,
      violations: review.violations,
      judges: [],
    };
  }

  const judgeCalls = options.judgeCalls?.slice(0, 2) ?? [];
  if (judgeCalls.length !== 2) {
    return {
      courseContentHash,
      learningContractHash,
      complete: false,
      aligned: false,
      violations: ['教学履约终审没有取得两位独立判官'],
      judges: [],
    };
  }

  const judged = await Promise.all(
    judgeCalls.map(async (judge, index) => {
      const judgeModel = options.judgeModels?.[index] ?? `judge-${index + 1}`;
      let lastReject = '';
      // 三次：实测一次超时 + 一次结构小错（transfer 漏 newContext）就把两次用光，
      // 而第三次几乎必过——每次 1-2 分钟，比整门课再跑 45 分钟便宜。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const prompt =
            attempt === 0
              ? review.prompt
              : `${review.prompt}\n\n【判词格式修订】上一份判词未通过结构校验，具体原因：${lastReject}。请修正该问题后重新输出恰好 ${review.expectations.length} 条 items（transferApplication 的 item 必须带布尔 newContext）；evidenceQuote 的每一句都必须原样复制自 sceneId 所指那一屏（多句用「……」分隔，不改字、不换屏），不得使用 Markdown 围栏或增减映射。`;
          const raw = await judge(LEARNING_ALIGNMENT_SYSTEM, prompt);
          const parsed = parseLearningAlignmentJudge(raw, judgeModel, review.expectations);
          if (!('reject' in parsed)) return parsed;
          lastReject = parsed.reject;
          try {
            options.onAlignmentJudgeReject?.({ judgeModel, attempt, reject: parsed.reject, raw });
          } catch {
            // 诊断钩子不影响审核结论
          }
        } catch (error) {
          // Bridge/schema failures get clean re-asks; exhausting the attempts still closes the gate.
          lastReject = `判官调用失败：${error instanceof Error ? error.message : String(error)}`;
          try {
            options.onAlignmentJudgeReject?.({ judgeModel, attempt, reject: lastReject, raw: '' });
          } catch {
            // 诊断钩子不影响审核结论
          }
        }
      }
      return null;
    }),
  );
  const judges = judged.filter((result): result is LearningAlignmentJudgeResult => result !== null);
  const complete = judges.length === 2;
  const aligned = complete && judges.every((judge) => judge.verdict === 'aligned');
  const violations = complete
    ? judges.flatMap((judge) =>
        judge.items
          .filter((item) => item.verdict === 'misaligned')
          .map(
            (item) =>
              `${judge.judgeModel}: ${item.objectiveId}/${item.phase}/${item.sceneId} — ${item.reason}`,
          ),
      )
    : ['教学履约终审未取得两份结构完整且证据可回指的判词'];

  return {
    courseContentHash,
    learningContractHash,
    complete,
    aligned,
    violations,
    judges,
  };
}

/**
 * 复用逐屏判官团对断言账本与 Action 可见语义做一次全课终审。它只裁决跨页冲突，不提供修订入口；
 * 冲突未消解、与批准材料冲突或审核基础设施失败时一律进入发布闸。
 */
export async function auditCourseContent(options: CourseAuditOptions): Promise<SceneAudit> {
  const teaching = buildCourseTeachingText(options.scenes);
  const courseContentHash = hashCourseScenes(options.scenes);

  // 事实终审与履约终审读的都是已冻结的最终内容，互不依赖——并行跑。
  // 2026-09-02 计时：9 屏课的课程级尾巴 15 分钟，串行时两段各占一半。
  const [{ audit }, learningAlignment] = await Promise.all([
    auditSceneContent({
      sceneTitle: `全课程终审：${options.courseTitle}`,
      content: teaching.text,
      scope: 'course',
      preExtractedTeachingText: teaching.text,
      preExtractedTruncatedChars: teaching.truncatedChars,
      judgeCall: options.judgeCall,
      judgeCalls: options.judgeCalls,
      arbiterCall: options.arbiterCall,
      defendCall: options.defendCall,
      judgeModel: options.judgeModel,
      judgeModels: options.judgeModels,
      arbiterModel: options.arbiterModel,
      sources: options.sources,
      evidence: options.evidence,
      corpus: options.corpus,
      retrieveForClaim: options.retrieveForClaim,
      evidenceCount: options.evidenceCount,
      // 故意不传 reviseCall：全课终审只裁决，不能静默重写已逐屏批准的最终内容。
    }),
    options.learningContract
      ? auditLearningContractAlignment(
          { ...options, learningContract: options.learningContract },
          courseContentHash,
        )
      : Promise.resolve(undefined),
  ]);

  const unresolved = audit.debate?.some((round) => round.arbiterVerdict === 'unresolved') ?? false;
  const issues = audit.claims.filter((claim) => claim.verdict !== 'supported');
  const infrastructureFailed = audit.verdict === 'flagged' && audit.totalClaims === 0;
  const incompleteReview = (audit.truncatedChars ?? 0) > 0;
  const panelIncomplete = audit.panelComplete !== true;
  const alignmentIncomplete = Boolean(learningAlignment && !learningAlignment.complete);
  const alignmentFailed = Boolean(learningAlignment && !learningAlignment.aligned);
  const blocked =
    incompleteReview ||
    panelIncomplete ||
    infrastructureFailed ||
    unresolved ||
    issues.length > 0 ||
    alignmentIncomplete ||
    alignmentFailed;

  return {
    ...audit,
    courseContentHash,
    ...(learningAlignment ? { learningAlignment } : {}),
    ...(learningAlignment
      ? { panelComplete: audit.panelComplete === true && learningAlignment.complete }
      : {}),
    verdict: blocked ? 'flagged' : 'pass',
    decision: blocked ? 'block_pending_review' : 'publish',
    rationale: incompleteReview
      ? `课程有 ${audit.truncatedChars} 字最终正文、断言账本或可见动作语义超出完整终审范围，课程保持草稿。`
      : panelIncomplete
        ? '全课程事实终审未取得两份合法判词，课程保持草稿。'
        : infrastructureFailed
          ? '全课程事实终审未能完成，课程保持草稿。'
        : unresolved
            ? '跨页事实分歧未能完成仲裁，课程保持草稿。'
            : issues.length > 0
              ? `全课程终审发现 ${issues.length} 处跨页或材料冲突，课程保持草稿。`
              : alignmentIncomplete
                ? '教学履约终审未取得两份结构完整且证据可回指的判词，课程保持草稿。'
                : alignmentFailed
                  ? '教学履约终审发现目标与前置、示范、练习、反馈或迁移内容未对齐，课程保持草稿。'
              : '全课程最终正文、逐屏断言与可见动作语义未发现高风险跨页冲突。',
  };
}
