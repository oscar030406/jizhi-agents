/**
 * 解压覆盖率（设计稿 §5.4 的 L0）——压缩下限从「写死的常量」换成「算得出的判据」。
 *
 * ## 为什么不是回归出来的
 *
 * 图纸 §10 第 12 条把「下限从历史回归」这条路判死了，依据是两条：iAFM 那套用了
 * 130 万次交互 / 7000 人；Lee et al.（arXiv:2605.01690）用同样模型同样 27 个数据集
 * 重拟合，**只改「每人每技能取多少条记录」这一个设定**，学习速率的个体间变异估计
 * 中位膨胀 118%。我们每人几十条证据，回归出来的是噪声。
 *
 * 所以走 L0：**零数据、纯结构、当场可算**。
 *
 * ## 判据
 *
 * 「画像就是解压字典」。一段压缩过的话，进阶的人解压得出、零基础的人解压不出——
 * 因为他没有字典条目。于是：
 *
 * ```
 * 解压覆盖率 = |T 中「画像里已掌握且置信够」∪「本资源内被显式定义」| / |T|
 * T = 这段资源用到的前置术语集
 * ```
 *
 * 低于阈值就不是「写得不好」，是**这一档的学习者读不了**——正确动作是补定义或降压缩比，
 * 由 `(下一步 …)` 处理，不是在这里硬压。
 *
 * 度量形式借自 Hu & Nation 2000 的词汇覆盖阈值，**数值不借**：95%/98% 是 L2 词汇的
 * 阈值，术语密度与可推断性都不同。起点 θ = 0.9，标为待标定。
 *
 * ## ⚠️ 2026-08-13 实测：这个探测器按现在的设计是不工作的，别拿它当判据
 *
 * 全账 `docs/05-evidence/decompression-detector-20260813.md`。要点：
 * - 108 份判官评过的探针资源上，三档覆盖率**中位数都是 0.000**
 * - 现行 11 条句式在教材的 1778 次术语首现窗口里覆盖 **7.5%**；
 *   把窗口开头片段按频次排，这 11 条**一条都没进前 40**（对首现窗口覆盖 0.0%）
 * - 放宽到「任意出现 + 60 字 + 更宽的标记表」能到 71.9%，但教材 71.9% vs
 *   我们 74.9% **几乎相等**——那一档没有判别力，测的是「附近有没有句子」
 *
 * 所以不是词表窄，是「术语首现后 40 字内必有定义标记」这个前提不成立。
 * **本模块目前只作指标（computeAdaptationMetrics 会算出来进日志），不参与任何拦截；
 * 对外也不许把它当创新点讲。** 要救得换机制（审核智能体判定，或等知识点标注就位），
 * 不是放宽词表——放宽到数字好看就是在凑。
 *
 * ## 与「必需成分」那半的证据强度不一样，别混着说
 *
 * 「可省项必须省」有硬证据（连贯性原则 23/23 实验支持、中位 d = 0.86；
 * 诱人细节效应 g ≈ −0.37～−0.41）。「必需成分那四件」是**我们的操作定义**，
 * 检索不到实证工作。写材料时不要都说成有文献支持。
 */

import wordlists from './data/adaptation-terms.json';

/** 术语被认定「已在画像里」所需的最低置信度。低置信的掌握度不算解压键。 */
export const MIN_CONFIDENCE_FOR_KEY = 0.3;

/** 术语被认定「已掌握」所需的最低估计值。 */
export const MIN_ESTIMATE_FOR_KEY = 0.6;

/** 解压覆盖率阈值。ponytail: 起点 0.9，`[待标定]`——形式借自 Hu & Nation，数值不借。 */
export const COVERAGE_THRESHOLD = 0.9;

const TERMS: string[] = Array.isArray((wordlists as { terms?: unknown }).terms)
  ? ((wordlists as { terms: string[] }).terms as string[])
  : [];

/**
 * 「本资源内被显式定义」的判据。
 *
 * 不做语义判断——定义句在中文技术文本里有稳定的句式标记，机械匹配比问模型稳，
 * 而且可复算。漏判的代价是覆盖率偏低（更保守），不是放行不该放行的。
 */
const DEFINITION_PATTERNS = [
  '是指',
  '指的是',
  '称为',
  '叫做',
  '定义为',
  '所谓',
  '也就是',
  '即',
  '是一种',
  '是一个',
];

export interface DecompressionKey {
  /** 已在学习者画像里的概念（估计值与置信度都够）。 */
  known: ReadonlySet<string>;
}

export interface CoverageResult {
  /** 这段资源用到的前置术语。 */
  terms: string[];
  /** 有解压键的那些（画像里有 ∪ 本文内定义）。 */
  covered: string[];
  /** 没有解压键的——**这就是「他读不下去」的具体位置**。 */
  uncovered: string[];
  /** 覆盖率。术语集为空时记 1（没有术语就没有解压负担）。 */
  coverage: number;
  /** 低于阈值 = 这一档读不了，要补定义或降压缩比。 */
  belowFloor: boolean;
}

function definedInText(term: string, text: string): boolean {
  const idx = text.indexOf(term);
  if (idx < 0) return false;
  // 只看术语出现处**之后**的一小段：定义句总是紧跟着术语。
  // 全文扫会把别处的「即」误算成这个术语的定义。
  const window = text.slice(idx + term.length, idx + term.length + 40);
  return DEFINITION_PATTERNS.some((p) => window.includes(p));
}

/**
 * 算一段资源对某个学习者的解压覆盖率。**纯函数**，零 LLM 调用。
 *
 * `known` 传学习者已掌握的概念名集合——调用方从画像里按
 * {@link MIN_ESTIMATE_FOR_KEY} / {@link MIN_CONFIDENCE_FOR_KEY} 筛好再传，
 * 这里不重复那套阈值逻辑（画像的形状是画像层的事）。
 */
export function decompressionCoverage(
  text: string,
  known: ReadonlySet<string> = new Set(),
  threshold = COVERAGE_THRESHOLD,
): CoverageResult {
  const used = TERMS.filter((t) => text.includes(t));
  // 去掉被更长术语包含的短词：「注意力」被「注意力机制」覆盖时只算后者，
  // 否则同一个概念会被数两次，覆盖率的分母失真。
  const terms = used.filter((t) => !used.some((o) => o !== t && o.includes(t)));

  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const t of terms) {
    if (known.has(t) || definedInText(t, text)) covered.push(t);
    else uncovered.push(t);
  }
  const coverage = terms.length === 0 ? 1 : covered.length / terms.length;
  return { terms, covered, uncovered, coverage, belowFloor: coverage < threshold };
}

/**
 * 从画像里筛出够格当解压键的概念。
 *
 * 「够格」有两条：估计值够高（他确实会）**且**置信度够（我们确实知道他会）。
 * 只看估计值会把「蒙对一次」当成解压键——那正是掌握度必须是二元组的理由（§5.2）。
 */
export function keysFromProfile(
  mastery: Record<string, number> | undefined,
  confidence: Record<string, number> | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const [concept, estimate] of Object.entries(mastery ?? {})) {
    if (estimate < MIN_ESTIMATE_FOR_KEY) continue;
    const c = confidence?.[concept];
    // 置信度缺席时按「不够」处理：宁可多补一次定义，不可假设他会。
    if (typeof c !== 'number' || c < MIN_CONFIDENCE_FOR_KEY) continue;
    out.add(concept);
  }
  return out;
}
