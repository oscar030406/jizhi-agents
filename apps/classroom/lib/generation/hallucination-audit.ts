/**
 * Hallucination audit for generated scene content.
 *
 * A second, independent judge model reviews every factual claim in a freshly
 * generated scene BEFORE it enters the playback queue. Flagged claims trigger
 * one revision pass by the generator model, then a re-audit. The full verdict
 * trail is attached to the scene so the classroom UI can surface it — the
 * point is not only to control hallucination but to make the control visible.
 */

import { judgeRole } from '@/components/agents/judge-labels';
import { isIncrementalReauditEnabled } from '@/lib/config/feature-flags';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { mergeNumericBypass } from './numeric-claims';

export type ClaimVerdict = 'supported' | 'uncertain' | 'incorrect';

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
}

/** Publish floor shared with the engine's ArbitrationAgent (backend/agents/arbitration_agent.py). */
const PUBLISH_FLOOR = 0.62;

/**
 * 幻觉率天花板已停用（保留常量供报表引用）。
 *
 * 停用原因：断言数 <10 时，只要 1 条 incorrect 就必然 1/9=0.111 > 0.1，
 * 天花板对短场景是恒真的拦截条件——它误杀的是 factuality 0.89 的场景。
 * 判据换成绝对数（见 ABSOLUTE_INCORRECT_LIMIT）。
 */
const HALLUCINATION_CEILING = 0.1;

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
  const hallucinationRate = incorrect / total;

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

const MAX_CONTENT_CHARS = 9000;

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
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTeachingText(content: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || parts.join('').length > MAX_CONTENT_CHARS) return;
    if (typeof node === 'string') {
      const text = node.trim();
      // Skip ids/urls/colors/enum-ish tokens — audit prose, not plumbing.
      if (
        text.length >= 6 &&
        !/^(https?:|data:|#|rgb|gen_img|gen_vid)/.test(text) &&
        !/^[\w-]+$/.test(text)
      ) {
        parts.push(text);
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
  return parts.join('\n').slice(0, MAX_CONTENT_CHARS);
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
1. 只修改清单中断言涉及的文字，按给出的修正表述改写。
2. **绝对不改变 JSON 的结构、字段名、数组长度和未被标记的内容**。
3. 输出修订后的完整 JSON，不要围栏不要解释。JSON 字符串内换行必须写成 \\n。`;

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

function parseClaims(raw: string): AuditClaim[] | null {
  const parsed = parseJsonLoose(raw) as { claims?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.claims)) return null;
  const verdicts = new Set<string>(['supported', 'uncertain', 'incorrect']);
  return parsed.claims
    .filter(
      (c): c is Record<string, unknown> =>
        !!c && typeof c === 'object' && verdicts.has(String((c as { verdict?: unknown }).verdict)),
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
): Promise<AuditClaim[] | null> {
  const system =
    JUDGE_SYSTEM +
    (evidence ? EVIDENCE_ADDENDUM : '') +
    (sceneType === 'quiz' ? QUIZ_ADDENDUM : '');
  const user =
    `场景标题：${sceneTitle}\n` +
    (evidence ? `参考资料：\n${evidence}\n\n` : '') +
    `教学文本：\n${teachingText}`;
  const raw = await judgeCall(system, user);
  const judged = parseClaims(raw);
  if (!judged) return null;

  // 正则旁路（`lib/generation/numeric-claims.ts`）：判官漏抽的带单位数字机械补进池。
  // 抽取这一步此前没有兜底——判官没抽到的断言，后面整条链（判定/答辩/仲裁/修订）
  // 都碰不到，**看起来是「这一屏没问题」，实际是「这一屏没被看过」**。
  // 补进来的一律 uncertain 且永不判 incorrect：旁路只知道这里有个带单位的数，
  // 不知道它对不对；查无对照就弃权，判错会触发修订环去改一个可能本来正确的参数。
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
 * run one revision pass and re-audit. Never throws — an audit infrastructure
 * failure degrades to a `flagged` verdict with zero claims rather than
 * blocking generation (the gate must not be less reliable than the generator).
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
   * one audit into a dozen extra round-trips. Mutates nothing on failure: a
   * claim whose re-query finds nothing, or whose re-judge errors, keeps its
   * original verdict and is still recorded — "we looked again and the corpus
   * really doesn't have it" is a result worth showing.
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
        } catch {
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
    };
  };

  /**
   * One audit round. A single judge is today's path verbatim; two judges get
   * cross-validated, and only the claims they split on cost a defense +
   * arbitration call. A judge that fails to answer degrades the round to the
   * other judge's verdicts (and no debate trail) rather than failing the audit.
   *
   * The returned trail describes exactly the returned claim list, so a re-audit
   * *replaces* the previous round's trail instead of appending to it — otherwise
   * "仲裁 N 条分歧" counts disputes over claims that were already rewritten away.
   */
  const runRound = async (
    textOverride?: string,
  ): Promise<{
    claims: AuditClaim[];
    debate?: DebateRound[];
  } | null> => {
    const text = textOverride ?? extractTeachingText(content);
    if (judges.length === 1) {
      const claims = await runJudge(judges[0], sceneTitle, text, evidence, sceneType);
      return claims && { claims };
    }
    // A throwing judge (429/timeout — judge calls run with maxRetries: 0) must not
    // take the panel down with it: Promise.all would reject and degrade the whole
    // audit to "failed", which is strictly worse than the single-judge path it
    // replaced. Swallow to null so the surviving judge's verdicts still count.
    const [a, b] = await Promise.all(
      judges
        .slice(0, 2)
        .map((j) => runJudge(j, sceneTitle, text, evidence, sceneType).catch(() => null)),
    );
    // Degraded to one judge: no cross-validation happened, so no trail is claimed.
    if (a === null || b === null) {
      const solo = a ?? b;
      return solo && { claims: solo };
    }
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
    const first = await runRound();
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
    const incorrectClaims = firstClaims.filter((c) => c.verdict === 'incorrect');
    // interactive 曾被排除在修订之外，理由是教具是整页 HTML、重写风险大。
    // 但配合 block 不再丢内容之后，这个排除只剩坏处：教具一次判定即出局、
    // rounds 停在 1，是「教具永远卡在生成中」的结构性来源之一。
    // 现在允许修订——修订失败会被 isStructurallyCompatible 挡回原内容，
    // 最坏情况等于不修订，不会更糟。
    const canRevise = Boolean(reviseCall);
    if (incorrectClaims.length === 0 || !canRevise) {
      return { audit: finish(settle(firstClaims, false), firstClaims), content };
    }

    // One revision pass by the generator model (incorrect claims only), then re-audit.
    const issueList = incorrectClaims
      .map((c, i) => `${i + 1}. ${c.claim} —— ${c.reason}${c.fix ? `；修正：${c.fix}` : ''}`)
      .join('\n');
    const revisedRaw = await reviseCall!(
      REVISE_SYSTEM,
      `问题断言清单：\n${issueList}\n\n场景内容 JSON：\n${JSON.stringify(content)}`,
    );
    const revised = parseJsonLoose(revisedRaw);
    // 原来的守卫是 `revised.type === content.type`——而 GeneratedSlideContent /
    // QuizContent / InteractiveContent 顶层压根没有 type 字段，两边都是 undefined，
    // 这个条件恒真。等于没有守卫：模型吐回来的任何 JSON 都会整体替换掉原内容。
    // 唯一会生效的方向还是反的（模型多吐一个顶层 type 反而被拒）。
    //
    // 换成按形状校验：修订产物必须保留原内容的关键结构，且元素不能变少——
    // 修订的语义是「改错的那几句」，不是「重写这一页」。
    if (isStructurallyCompatible(revised, content)) {
      content = revised;
    } else {
      // Revision broke the schema — keep the original and report honestly.
      return { audit: finish('flagged', firstClaims), content: options.content };
    }

    rounds = 2;

    // ── 增量复审（WO-N9，`INCREMENTAL_REAUDIT=1` 开，默认关）─────────────────
    //
    // 关着时下面这段等价于原来的 `runRound()`：整页重喂、整表替换，一字不差。
    //
    // 开着时只审改动段。理由：修订的语义是「把判错的那几句改对」——REVISE_SYSTEM
    // 明文要求不许改结构、不许动未标记的内容，isStructurallyCompatible 还兜了一道。
    // 也就是说这一页绝大部分文本与第一轮**逐字相同**，对它们重判是纯浪费
    // （实测：一轮收的屏审核中位 119s，走到第二轮的 375s）。
    //
    // 改动段的识别必须机械可复算，不能让模型自己说改了哪：extractTeachingText
    // 本来就是把可见教学文本按 '\n' 拼起来的，直接比行集合。
    const incremental = isIncrementalReauditEnabled();
    const oldLines = extractTeachingText(options.content).split('\n').filter(Boolean);
    const newLines = extractTeachingText(content).split('\n').filter(Boolean);
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    const addedLines = newLines.filter((l) => !oldSet.has(l));
    const removedLines = oldLines.filter((l) => !newSet.has(l));
    // 改动前后的行都算「碰过」：修订通常是就地改写一句，旧断言引的是旧文本、
    // 新判定引的是新文本，两边都要能匹配上才不会漏掉该作废的一轮判定。
    const touchedLines = [...addedLines, ...removedLines];

    // 修订产物在可见文本层面与原文一字不差（模型只改了不进审核的字段，或干脆
    // 原样吐回）。这时第二轮没有任何新东西可审，第一轮判定原样成立——省掉整轮。
    if (incremental && addedLines.length === 0) {
      return { audit: finish('flagged', firstClaims), content };
    }

    const second = await runRound(incremental ? addedLines.join('\n') : undefined);
    // Re-audit unavailable: report round 1's claims — and round 1's trail with them.
    if (second === null) {
      return { audit: finish('revised', firstClaims), content };
    }
    debate = second.debate;
    let secondClaims = second.claims;
    if (incremental) {
      // 一轮判定里，凡是能匹配到改动行的都作废（那段文本已经被重判过了）；
      // 匹配用的是模块里现成的 claimSimilarity + MATCH_THRESHOLD，不另造一把尺子。
      const touched = (claim: string) =>
        touchedLines.some((line) => claimSimilarity(claim, line) >= MATCH_THRESHOLD);
      const carried = firstClaims.filter((c) => !touched(c.claim));
      // 第二轮若重复抽出了沿用断言里的同一句，以第二轮为准（它看的是改后文本）。
      const deduped = carried.filter(
        (c) => !second.claims.some((s) => claimSimilarity(c.claim, s.claim) >= MATCH_THRESHOLD),
      );
      secondClaims = [...deduped, ...second.claims];
      // 答辩记录也要跟着合并，否则沿用下来的断言标着 decidedBy:'arbitration' 却找不到
      // 对应的仲裁条目——模块自己的约定是「trail 精确描述返回的断言表」，
      // 界面上就会出现「仲裁了 N 条」但只列得出 M 条。基线是整表替换所以不会分叉，
      // 增量必须显式接上。
      const carriedDebate = (first.debate ?? []).filter((d) =>
        deduped.some((c) => claimSimilarity(c.claim, d.claim) >= MATCH_THRESHOLD),
      );
      debate = [...carriedDebate, ...(second.debate ?? [])];
    }
    const stillIncorrect = secondClaims.some((c) => c.verdict === 'incorrect');
    return {
      audit: finish(stillIncorrect ? 'flagged' : settle(secondClaims, true), secondClaims),
      content,
    };
  } catch {
    return { audit: finish('flagged', []), content: options.content };
  }
}
