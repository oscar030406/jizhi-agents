/**
 * 资源规格（ResourceSpec）——`(下一步 学习者 目标) → 资源规格` 的产物。
 *
 * 设计基准：docs/03-design/blackbox-architecture-20260811.md §三「为什么资源规格要从资源里分出来」。
 *
 * 现状（本文件要取代的东西）：规格是 `blueprintDirective()` 拼出来的一段自然语言，
 * 直接塞进 outline.description。自然语言不可比较，于是「同一份规格换个领域取材」
 * 「按规格聚合复用」「同类资源之间比质量」三件事全都做不了。
 *
 * 这里把规格拆成两组维度：
 *   - 核心维：全部离散或有界，参与相等判定，决定 `specKey()`；
 *   - 装饰维：类比域、举例偏好、语气，不参与相等判定。
 * 理由（because）不在规格里，`fromLegacyBlueprint()` 把它作为并列的第二个返回值挂出来。
 *
 * 相等判定先做**严格全等**（同一个 key 就相等，否则不相等）。不引阈值、不做近似——
 * 设计讨论的结论是先用严的，等真实数据说话再谈放宽。
 *
 * 本文件不接线：scene-generator / route / classroom-generation 的调用点一律没动。
 */

/** 难度档。导出量，不是标注量——见 `deriveTier()`。 */
export type Tier = 'L1' | 'L2' | 'L3';

/** 形态。`(应答 …)` 与形态无关，所以形态只是规格的一维，不是分支的开关。 */
export type Modality = 'lecture' | 'quiz' | 'manipulative' | 'critique' | 'lab';

/** 教材固定序列的三步。 */
export type SequencePosition = 'concept' | 'from-scratch' | 'framework';

/**
 * 压缩带。**分档，不存字数**——存 "100-160" 这种字数带的话两份规格永远不相等，
 * 聚合与复用就无从谈起（现状 resource_mix.section_length_band 就是字数带）。
 */
export type CompressionBand = 'compact' | 'standard' | 'detailed';

/** 冗长程度递增。压缩下限用它比较。 */
const BAND_ORDER: CompressionBand[] = ['compact', 'standard', 'detailed'];

export const MODALITY_LABEL: Record<Modality, string> = {
  lecture: '讲义',
  quiz: '测验',
  manipulative: '教具',
  critique: '讲评',
  lab: '实操',
};

export const SEQUENCE_LABEL: Record<SequencePosition, string> = {
  concept: '概念',
  'from-scratch': '从零实现',
  framework: '框架实现',
};

const BAND_LABEL: Record<CompressionBand, string> = {
  compact: '紧凑',
  standard: '标准',
  detailed: '详尽',
};

/** 装饰维：影响读起来的样子，不影响「这是不是同一份规格」。 */
export interface SpecDecoration {
  /** 类比取材领域。软约束——没有贴切类比时允许改用通用日常场景。 */
  analogyDomain?: string;
  /** 举例偏好（学习者自述的学习偏好原话）。 */
  examplePreference?: string;
  /** 语气/口吻。 */
  tone?: string;
}

export interface ResourceSpec {
  /** 这份资源要服务的知识点集合。已去重并按字典序排好。 */
  kcs: string[];
  tier: Tier;
  modality: Modality;
  sequence: SequencePosition;
  compression: CompressionBand;
  /** 前置假设集：写的时候视为学习者已经会了的 KC。已去重排序，且与 kcs 不相交。 */
  assumedKnown: string[];
  decoration: SpecDecoration;
}

export type SpecDimension =
  | 'kcs'
  | 'tier'
  | 'modality'
  | 'sequence'
  | 'compression'
  | 'assumedKnown'
  | 'decoration';

/** because 链的一条。**不属于规格**，单独挂，不参与相等判定。 */
export interface SpecReason {
  dim: SpecDimension;
  /** 依据来自哪：画像维度、引擎诊断字段、目标约束…… */
  from: string;
  because: string;
}

export interface SpecInput {
  kcs: string[];
  tier: Tier;
  modality?: Modality;
  sequence?: SequencePosition;
  compression?: CompressionBand;
  assumedKnown?: string[];
  decoration?: SpecDecoration;
}

const normalizeSet = (xs: readonly string[] | undefined): string[] =>
  Array.from(new Set((xs ?? []).map((s) => s.trim()).filter(Boolean))).sort();

/**
 * 构造函数。做三件事：去重排序、把空串清掉、保证前置假设集与知识点集不相交
 * （一个 KC 不能既是这次要教的、又是视为已知的——不排掉的话两份语义相同的规格会不相等）。
 */
export function makeSpec(input: SpecInput): ResourceSpec {
  const kcs = normalizeSet(input.kcs);
  const kcSet = new Set(kcs);
  return {
    kcs,
    tier: input.tier,
    modality: input.modality ?? 'lecture',
    sequence: input.sequence ?? 'concept',
    compression: input.compression ?? 'standard',
    assumedKnown: normalizeSet(input.assumedKnown).filter((k) => !kcSet.has(k)),
    decoration: { ...(input.decoration ?? {}) },
  };
}

/**
 * 稳定序列化：只吃核心维，字段顺序写死，集合已在构造时排序。
 * 同核心维的两份规格必然得到同一个字符串，可以直接当聚合/缓存的 key。
 */
export function specKey(spec: ResourceSpec): string {
  return JSON.stringify([
    spec.kcs,
    spec.tier,
    spec.modality,
    spec.sequence,
    spec.compression,
    spec.assumedKnown,
  ]);
}

/** 严格全等：核心维逐一相同才相等，装饰维一律不看。 */
export function specEquals(a: ResourceSpec, b: ResourceSpec): boolean {
  return specKey(a) === specKey(b);
}

// ---------------------------------------------------------------------------
// 导出量：档位 / 压缩带
// ---------------------------------------------------------------------------

/** 通用面「低」的上界（0–4 自评量表）。 */
const GENERAL_LOW_MAX = 1;
/** 专业面「高」的下界。 */
const DOMAIN_HIGH_MIN = 3;

/**
 * 档位是导出量（设计稿 §4.1 那张表），不手写规则、不为每个领域各写一套映射：
 *
 * | 通用面 | 专业面 | 档 |
 * |---|---|---|
 * | 低 | —  | L1 引导型 |
 * | 高 | 低 | L2 转行者 |
 * | 高 | 高 | L3 进阶   |
 *
 * 两个入参都是 0–4 的有界量（自评量表口径）。阈值取得与现有 `presentationTier`
 * 一致（通用面 ≤1 为低、专业面 ≥3 为高），接线时行为不漂。
 */
export function deriveTier(generalFacet: number, domainFacet: number): Tier {
  if (generalFacet <= GENERAL_LOW_MAX) return 'L1';
  return domainFacet >= DOMAIN_HIGH_MIN ? 'L3' : 'L2';
}

/**
 * 压缩下限：`压缩下限 = f(知识点, 学习者画像)`（设计稿 §5.4）。这里先只吃档位那一半——
 * 零基础没有解压字典，压到紧凑档他解压不出来，所以 L1 的下限是「标准」。
 *
 * ponytail: 阈值是常量表。**升级路径不是「从历史通过率回归」**——设计稿初稿写过那句，
 * 2026-08-11 学习科学对照调研把它证伪并整句删掉了（设计稿附录 B-14）：同类回归（iAFM）
 * 用了 130 万次交互 / 7000 人；Lee et al. 2026 (arXiv:2605.01690) 用同模型同 27 个数据集
 * 重拟合，只改「每人每技能取多少条记录」一个设定，学习速率的个体间变异估计中位膨胀 118%。
 * 我们每人几十条证据，回归出来的是噪声。看着像放弃了一条路，是文献打回来的，别写回去。
 *
 * 替代方案是设计稿 §5.4 的三层，按需要的数据量排：L0 解压覆盖率（零数据，落在现有
 * `adaptation-lint` 层）→ L1 必需成分 rubric（零数据，判官逐条判）→ L2 配对标定（几十人）。
 */
const COMPRESSION_FLOOR: Record<Tier, CompressionBand> = {
  L1: 'standard',
  L2: 'compact',
  L3: 'compact',
};

/**
 * 引擎的可行性判词（`DiagnosisResult.feasibility.verdict`，定义在
 * `apps/agent-engine/backend/schemas/learner.py`，算法在
 * `apps/agent-engine/backend/services/feasibility.py`）。
 *
 * 判据是量出来的，不是拍的：23 门实测课程的单课可读体量（中位 27.35 分钟 / 最小 10.45 分钟，
 * 快照 `apps/agent-engine/data/course_volume_stats.json`），字数换分钟取 390 字/分钟
 * （Brysbaert 2019, JML 109:104047）。ok = 预算排得下中位体量；tight = 只有压到出过的
 * 最小体量才排得下；infeasible = 比最小体量还紧。
 *
 * 适用范围照抄引擎侧的口径，不放大：**这是「读得完」的下限判定，不是「学得会」的判定**。
 * 分钟数只算读，不算做题、动手、回看。判成 infeasible 的一定做不到，判成 ok 只说明读得完。
 */
export type FeasibilityVerdict = 'ok' | 'tight' | 'infeasible';

/**
 * 判词 → 压缩带。判词三档对压缩带三档里的两档，第三档 `detailed` 不再由预算自动推出——
 * 引擎的判词里没有「宽裕到该写更详尽」这一档，我们也不为它另发明一个阈值；要出详尽档
 * 由调用方在 `SpecInput.compression` 里显式指定。
 *
 * 没有判词（引擎离线、没填预算、读不到实测快照）时取 standard。那是「没判」，不是「宽裕」。
 */
function bandFromVerdict(verdict?: FeasibilityVerdict): CompressionBand {
  return verdict === 'tight' || verdict === 'infeasible' ? 'compact' : 'standard';
}

/**
 * 判词 × 档位 → 压缩带。判词再紧也不会突破该档的压缩下限。
 *
 * 这里原来有一对 8 小时 / 40 小时的常量，自己拿小时数判了一遍。那两个数没有出处，
 * 已经删掉：同一件事引擎用实测量出来判过（见 {@link FeasibilityVerdict}），
 * 两份判据并存只会给出对不上的结论。
 *
 * 顶到下限这件事本身是真冲突：**低档学习者需要更长的内容**（Yano, Long & Ross 1994：
 * 详述版与简化版理解度无显著差异，但详述版保留了原文生词、也就保留了学习机会，领域标准词是
 * elaborated text 不是 simplified text），**而低档学习者往往正是时间预算最紧的人**。
 * 顶到下限时照常出内容，边界那句话由引擎的 `Feasibility.reason` / `suggested_goal` 出，
 * 前端不再复述第二份。
 */
export function deriveCompression(tier: Tier, verdict?: FeasibilityVerdict): CompressionBand {
  const byVerdict = bandFromVerdict(verdict);
  const floor = COMPRESSION_FLOOR[tier];
  return BAND_ORDER.indexOf(byVerdict) < BAND_ORDER.indexOf(floor) ? floor : byVerdict;
}

// ---------------------------------------------------------------------------
// 渲染：规格 → 生成器看的自然语言指令
// ---------------------------------------------------------------------------

/**
 * 分档硬要求的压缩版。长版在 `learner-profile.ts` 的 `blueprintDirective()` 里，
 * 那份是评测 rubric 对齐过的原文；这里只保留可观察的分档特征（前置假设 / 术语处理 /
 * 例子来源 / 代码形态），因为规格渲染要短到能和别的约束拼在一起。
 * 接线那一批要在两者之间选一个留，别两份都发。
 */
const TIER_DIRECTIVE: Record<Tier, string[]> = {
  L1: [
    '前置假设：读者不会编程、不会高等数学，全文按这个假设写；',
    '每个专业术语第一次出现立刻用一句大白话定义，不许裸用；单段新术语不超过 2 个；',
    '主要例子取自日常生活；公式出现前先给一段无公式的直觉解释；',
    '代码极短（≤5 行）、每行配大白话注释、不引入本课没讲过的语法或库。',
  ],
  L2: [
    '前置假设：读者会编程、没有任何 AI 背景——不解释变量/函数/API；',
    '每个 AI 领域术语第一次出现紧跟一句大白话定义，一个都不许裸用；',
    '类比取自工程经验（接口/缓存/流水线/索引），不用做菜排队这类日常场景；',
    '代码可多行带库调用，但每块配一段说明讲清意图与输入输出；不写鼓励性语句。',
  ],
  L3: [
    '前置假设：读者有实战经验——术语直接使用不再定义，直接进机制、公式与工程取舍；',
    '代码贴生产形态（完整实现，不做逐行注释）；',
    '例子贴生产场景（吞吐/显存/线上退化）；',
    '给基础术语下定义、逐行注释、生活化类比、鼓励性语句，出现任何一条即视为写错档。',
  ],
};

const SEQUENCE_DIRECTIVE: Record<SequencePosition, string> = {
  concept: '本节位于「概念」步：只讲是什么、为什么需要、与前置的接口，不出实现代码。',
  'from-scratch':
    '本节位于「从零实现」步：不调框架，用最小依赖手写一遍核心机制，读者要能照着跑通。',
  framework: '本节位于「框架实现」步：用框架把上一步的手写版替换掉，讲清框架替你做了什么。',
};

const COMPRESSION_DIRECTIVE: Record<CompressionBand, string> = {
  compact: '压缩带 紧凑：只留定义、动机、一个例子、与前置的接口；历史、变体、推导细节一律略去。',
  standard: '压缩带 标准：核心四件（定义/动机/例子/前置接口）齐全，另给一到两处边界或失败模式。',
  detailed: '压缩带 详尽：核心四件之外补推导过程、常见变体与边界条件，允许展开历史脉络。',
};

const MODALITY_DIRECTIVE: Record<Modality, string> = {
  lecture: '形态 讲义：正文讲解为主，读完要能复述机制。',
  quiz: '形态 测验：出题为主，每题只挂一个知识点，题干场景要新。',
  manipulative: '形态 教具：做一个可操作的东西，参数变化要能看见结果变化。',
  critique: '形态 讲评：针对已有错误做错因分析与订正材料，先说错在哪再说怎么改。',
  lab: '形态 实操：给可运行的步骤与验收标准，读者跟着做完要有产出物。',
};

/** 把规格渲染成给生成器看的自然语言指令。核心维出硬约束，装饰维出软偏好。 */
export function toDirective(spec: ResourceSpec): string {
  const lines: string[] = [
    '',
    '【资源规格 · 必须遵守】',
    `- 本节知识点：${spec.kcs.join('、') || '（未指定）'}`,
    `- 难度档：${spec.tier}`,
    ...TIER_DIRECTIVE[spec.tier].map((s) => `  - ${s}`),
    `- ${MODALITY_DIRECTIVE[spec.modality]}`,
    `- 序列位 ${SEQUENCE_LABEL[spec.sequence]}：${SEQUENCE_DIRECTIVE[spec.sequence]}`,
    `- ${COMPRESSION_DIRECTIVE[spec.compression]}（${BAND_LABEL[spec.compression]}）`,
  ];
  if (spec.assumedKnown.length > 0) {
    lines.push(`- 前置假设（视为已会，不再从头讲，可直接引用）：${spec.assumedKnown.join('、')}`);
  }
  const { analogyDomain, examplePreference, tone } = spec.decoration;
  if (analogyDomain) {
    lines.push(
      `- 类比与举例优先取自「${analogyDomain}」；该领域没有贴切类比时，改用面向所有人都成立的日常场景，不要强行套用。`,
    );
  }
  if (examplePreference) lines.push(`- 举例偏好：${examplePreference}`);
  if (tone) lines.push(`- 语气：${tone}`);
  lines.push(
    '注意：以上只改变讲法、深度与举例领域，**不得改变任何知识事实**；事实仍以参考资料为准。',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 兼容路径：LearnerBlueprint + profile → Spec
// ---------------------------------------------------------------------------

import type { LearnerBlueprint, LearnerProfileInput } from './learner-profile';
import { IN_STATE_MIN, knowledgeState } from './selection';
/** 一份规格最多带几个知识点。场景 ≈ 教材一到两节的压缩，挂太多就不是一份规格了。 */
const MAX_KCS = 4;

/**
 * 从引擎载荷上取可行性判词。`LearnerBlueprint` 是 08-13 之前定的型，还没这一维，
 * 所以按结构取；取不到（旧缓存、引擎离线）就当没判，不给它编一个。
 */
function feasibilityVerdict(bp: LearnerBlueprint): FeasibilityVerdict | undefined {
  const v = (bp as LearnerBlueprint & { feasibility?: { verdict?: string } }).feasibility?.verdict;
  return v === 'ok' || v === 'tight' || v === 'infeasible' ? v : undefined;
}

export interface LegacySpecOverrides {
  /** 已知的知识点集合（由取材侧算出来时传入）。不传就从 skill_gaps / weak_concepts 推。 */
  kcs?: string[];
  modality?: Modality;
  sequence?: SequencePosition;
}

/**
 * 画像的两面：通用面取编程能力，专业面取该领域的实战能力。
 *
 * 专业面这个 max 是为了与现有 `presentationTier` 完全等价（它的 L3 条件是
 * `agent >= 3 || (prog >= 4 && eng >= 3)`）——接线时不产生行为漂移。
 * 换领域时这里要换成该领域专业面的取数，通用面不动。
 */
export function facetsFromProfile(profile: LearnerProfileInput): {
  general: number;
  domain: number;
} {
  const general = profile.programming_level ?? 0;
  const agent = profile.agent_level ?? 0;
  const eng = profile.engineering_level ?? 0;
  return { general, domain: Math.max(agent, general >= 4 ? eng : 0) };
}

/**
 * 把现有 `blueprintDirective()` 的两个入参映射成 Spec，供接线用。
 * 返回值把 because 链**并列挂在旁边**——它不是规格的一部分，不参与相等判定。
 */
export function fromLegacyBlueprint(
  bp: LearnerBlueprint,
  profile: LearnerProfileInput,
  overrides: LegacySpecOverrides = {},
): { spec: ResourceSpec; reasons: SpecReason[] } {
  const reasons: SpecReason[] = [];

  // 档位：有 programming_level 就走导出表；没有就退回引擎推荐档（老行为）。
  let tier: Tier;
  if (typeof profile.programming_level === 'number') {
    const { general, domain } = facetsFromProfile(profile);
    tier = deriveTier(general, domain);
    reasons.push({
      dim: 'tier',
      from: `画像 通用面=${general} / 专业面=${domain}`,
      because: `通用面×专业面导出档位表 → ${tier}`,
    });
  } else {
    const rec = bp.recommended_difficulty;
    tier = rec === 'L1' ? 'L1' : rec === 'L2' ? 'L2' : 'L3';
    reasons.push({
      dim: 'tier',
      from: '引擎 recommended_difficulty',
      because: `画像缺 programming_level，退回引擎推荐档 ${rec}`,
    });
  }

  // 知识点：调用方给了就用（取材侧算出来的更准），否则按缺口优先级取。
  const gaps = bp.blueprint?.skill_gaps ?? [];
  const byPriority = [...gaps]
    .filter((g) => (g.gap ?? 0) > 0)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((g) => g.concept);
  const kcs =
    overrides.kcs ?? (byPriority.length > 0 ? byPriority : bp.weak_concepts).slice(0, MAX_KCS);
  reasons.push({
    dim: 'kcs',
    from: overrides.kcs
      ? '调用方指定'
      : byPriority.length > 0
        ? '引擎 skill_gaps（按 priority）'
        : '引擎 weak_concepts',
    because: `本节服务 ${kcs.length} 个知识点`,
  });

  // 前置假设集 = 知识状态 K（构造函数会把与 kcs 重合的剔掉）。
  //
  // 判据从「掌握度 ≥0.7」换成 ALEKS 的三分带（`>0.8` 判会 / `<0.2` 判不会 / 中间
  // uncertain 不计入状态），依据见 `./selection` 的 IN_STATE_MIN 与 knowledgeState。
  // 这条看起来像收紧、其实是修错：0.7 在任何成熟系统里都不是掌握线，而且原来那一个 0.7
  // 同时充当估计值门槛和置信门槛。落在 uncertain 带的（0.75 这种）宁可当他不会——
  // 代价只是资源里多一句解释，反过来猜错的代价是他被当成会了、这一段再也不讲。
  //
  // 只过了估计值那一半的门槛：引擎的 `mastery_vector` 是标量，没有置信度分量。
  // 二元组接上来之后，这里要按 selection 里写的结构判据补另一半，不是给置信度也编个 0.7。
  const assumedKnown = [...knowledgeState(bp.mastery_vector ?? {})];
  if (assumedKnown.length > 0) {
    reasons.push({
      dim: 'assumedKnown',
      from: '引擎 mastery_vector',
      because: `掌握度 >${IN_STATE_MIN} 的概念进知识状态，视为已知；落在 uncertain 带的不进`,
    });
  }

  // 压缩带跟引擎的可行性判词走。前端不再拿 time_budget_hours 自己判一遍——
  // 判词已经把预算摊到知识点上跟实测体量比过了，我们这边没有更多信息。
  const verdict = feasibilityVerdict(bp);
  const compression = deriveCompression(tier, verdict);
  reasons.push({
    dim: 'compression',
    from: `引擎 feasibility.verdict=${verdict ?? '未判'} × 档位 ${tier}`,
    because:
      verdict === undefined
        ? `引擎没给判词（离线、没填预算、或读不到实测快照），压缩带取默认 ${compression}`
        : compression !== bandFromVerdict(verdict)
          ? `判词 ${verdict} 要求压到 ${bandFromVerdict(verdict)}，被 ${tier} 的压缩下限顶回 ${compression}`
          : `判词 ${verdict} → 压缩带 ${compression}`,
  });

  const mix = bp.blueprint?.resource_mix ?? null;
  if (mix?.analogy_domain) {
    reasons.push({
      dim: 'decoration',
      from: '引擎 resource_mix.analogy_domain',
      because: `类比域「${mix.analogy_domain}」（装饰维，不参与规格相等判定）`,
    });
  }

  const spec = makeSpec({
    kcs,
    tier,
    modality: overrides.modality,
    sequence: overrides.sequence,
    compression,
    assumedKnown,
    decoration: {
      analogyDomain: mix?.analogy_domain,
      examplePreference: profile.learning_preference,
      tone: bp.blueprint?.learner_type,
    },
  });
  return { spec, reasons };
}
