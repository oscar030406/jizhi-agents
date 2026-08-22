/**
 * 权重（导出量，设计稿 §4.4）+ 两条时间量。
 *
 * `weight = f(情境, 判定, 后续证据)` —— 存的是情境这个事实，权重由公式算。
 * 所以它必须是**纯函数**且**可替换**：换公式能重算历史，不废数据。
 *
 * 关键在「序列」二字：一条证据的强度取决于它之后发生了什么。设计稿点名的场景
 * 是「这条答对之后同一知识点连续两次答错」——那次答对多半是蒙的，权重要回落。
 * 而如果两次答错是很久以后才发生的，那是**忘了**，当初那次答对是真的，只该被
 * 轻打折，不该被追认成蒙对。两者的区分口径就是 {@link GUESS_WINDOW_MS}。
 *
 * ## 时间是两件事，不是一件（2026-08-11 学习科学对照调研的纠正）
 *
 * 这里原来有一个 `HALF_LIFE_MS` 乘在权重上，把两条独立的量混成了一个数：
 * **遗忘**让估计值下降（ACT-R / Duolingo HLR / BKT-Forget / DASH），
 * **久未测量**让置信度扩散而估计值不动（Glicko 的 `RD' = min(√(RD²+c²·t), RD_MAX)`）。
 * 混在一起的后果是久未练习既掉分又掉信心，且分不清掉的是哪一种。
 *
 * 正确形式取 DSR/FSRS 的拆法，三件各归各位：
 * ```
 * 存的     S（稳定度）    不因时间降，只因新证据改变          ← 画像层持有
 * 决策用   R(t)           随 t/S 降，是导出量                 ← retrievability()
 * 置信度   RD(t)          随「距上次证据的时间」加宽，估计值不动 ← widenDeviation()
 * ```
 * 所以**权重函数里不再有时间衰减**：一条证据的证据强度不因为放久了而变小
 * （证据永不丢弃，§4.4），变小的是我们现在还能提取多少（R）和我们对估计值的
 * 把握（RD）。
 *
 * 顺带纠正设计稿 §6.3 的原表述「三个月没碰，估计值不降、置信度降」：**只对了一半**。
 * BKT-Forget / DASH / DAS3H / HLR 的估计值都降，「不降」在主流模型里不成立；
 * 真正不降的是 DSR 的 `S`，降的是导出的 `R(t)`。别把 R 塞回权重里。
 */

import { measuredKey, verdictScore, type Evidence, type Signal } from './types';

/**
 * 「蒙对」窗口：答对之后多久之内连着栽两次，就认定当初是蒙的而不是忘了。
 *
 * ponytail: 24h 是拍的常数，没有回归依据。升级路径是从历史里回归（同一档学习者、
 * 同一概念，间隔多久之后的失败才该算遗忘）——但那条路本轮被调研判为暂不可走：
 * 同类回归（iAFM）用了 130 万次交互 / 7000 人，我们是单人几十条。
 */
export const GUESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 「答对但吃力」的耗时阈值。**逐条**（不是整卷）的作答耗时超过它就算吃力。
 *
 * 90s 沿用 quiz-view 里那段 EMA 的原值（选择题常规作答带的宽上限）。
 * ponytail: 拍的 `[待验]`，与本文件其余常数同级——从履历回归要有跨人数据。
 */
export const SLOW_RESPONSE_MS = 90_000;

/** 吃力时的权重折扣。原实现是把掌握度按 0.75 封顶，这里等价成对证据强度打折。 */
export const SLOW_RESPONSE_DISCOUNT = 0.75;

/** 判定分 ≥ 此值算答对。 */
export const CORRECT_THRESHOLD = 0.75;
/** 判定分 < 此值算答错。 */
export const FAIL_THRESHOLD = 0.5;

/** 蒙对回落：窗口内连栽两次，那条答对基本不算数。 */
const GUESS_RETRACTION = 0.2;
/** 遗忘：隔了很久才连栽两次，当初那次是真的，只轻打折。 */
const FORGETTING_RETRACTION = 0.7;

/**
 * `item-level` 降级证据在**非全对**时的折扣。
 *
 * 依据 van de Sande (EDM 2016)：合取语义下答对无歧义（每个 KC 都得用对才可能对），
 * 答错只说明「至少一个 KC 没过」，**不知道该怪谁**。所以题级判定摊到 N 个 KC 上时，
 * 好消息照收、坏消息要打折——归因不确定不该按确定的力度扣。
 * 部分对同样打折：部分对在合取语义下一样不知道是哪个 KC 拖的。
 *
 * ponytail: 0.5 是拍的。要更严就让判官逐测项出结论（`per-kc`），那才是根治，
 * 这个系数只是纯选择题的兜底。
 */
const ITEM_LEVEL_MISS_FACTOR = 0.5;

/** 信号对权重的乘数。认不出的信号类型不影响权重（乘 1），不猜。 */
const SIGNAL_FACTORS: Record<string, number> = {
  /** 停留极短——那次作答的置信度低。 */
  lowDwell: 0.6,
};

export interface WeightOptions {
  /** 同一次交互的信号。会按 `source.interactionId` 自己筛，传全量也行。 */
  signals?: readonly Signal[];
}

/**
 * 权重函数的签名。整条闭环只认这个签名，所以公式可以整个换掉再
 * {@link weighAll} 重算历史。
 *
 * `history` 传整段履历即可——函数自己筛出要用的那些（同测项的后续、同交互的同源
 * 证据），调用方不需要预筛，也就没法筛错。
 */
export type WeightFn = (
  evidence: Evidence,
  history: readonly Evidence[],
  options?: WeightOptions,
) => number;

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 默认权重公式。返回值 ≥ 0，难题可以超过 1（`难度 1.0` 时基数 1.25）——权重是
 * 相对强度，不是概率，不在 1 处截断。
 *
 * 五个因子相乘：
 * - **难度**：`0.75 + 0.5 × difficulty`，缺省难度 0.5 记 1.0。
 * - **蒙对回落**：见文件头。
 * - **同源分摊**：`1/N`，见下。
 * - **归因降级**：`item-level` 且非全对时打折，见 {@link ITEM_LEVEL_MISS_FACTOR}。
 * - **信号**：同一次交互的信号乘数，见 {@link SIGNAL_FACTORS}。
 *
 * 没有时间衰减，这是本轮的纠正，理由见文件头。
 */
export const weight: WeightFn = (evidence, history, options = {}) => {
  const key = measuredKey(evidence.measured);
  const at = ms(evidence.source.at);
  const mine = history.filter((x) => x.id !== evidence.id && x.learnerKey === evidence.learnerKey);
  const later = mine
    .filter((x) => measuredKey(x.measured) === key && ms(x.source.at) >= at)
    .sort((a, b) => ms(a.source.at) - ms(b.source.at));

  const difficulty = evidence.context.difficulty ?? 0.5;
  const difficultyFactor = 0.75 + 0.5 * Math.min(1, Math.max(0, difficulty));

  // 「答对但吃力」降权。原来这条逻辑长在 quiz-view 的 EMA 里（单题均耗 >90s 就把
  // 掌握度按 0.75 封顶），那是放错了层：耗时是**情境**，而 `权重 = f(情境, 判定)`——
  // 它该在这儿，而不是在某个写回点里就地改分。挪过来之后导学那条链也自动享有。
  //
  // 只打折**答对**的：答错本来就没什么可高估的，再按耗时打一次等于罚两遍。
  // 阈值 90s 沿用原实现（选择题常规作答带的宽上限），ponytail: 拍的 `[待验]`。
  const elapsed = evidence.context.elapsedMs;
  const effortFactor =
    elapsed !== undefined &&
    elapsed > SLOW_RESPONSE_MS &&
    verdictScore(evidence.verdict) >= CORRECT_THRESHOLD
      ? SLOW_RESPONSE_DISCOUNT
      : 1;

  let retraction = 1;
  if (verdictScore(evidence.verdict) >= CORRECT_THRESHOLD) {
    const nextTwo = later.slice(0, 2);
    if (nextTwo.length === 2 && nextTwo.every((x) => verdictScore(x.verdict) < FAIL_THRESHOLD)) {
      const gap = ms(nextTwo[1].source.at) - at;
      retraction = gap <= GUESS_WINDOW_MS ? GUESS_RETRACTION : FORGETTING_RETRACTION;
    }
  }

  // 同源分摊：**同一道题**产出 N 条证据，它们**分**这道题的信息量，不是各拿一份。
  // 依据（2026-08-11 调研）：蒙对是**题级事件**——四选一里蒙中与这题考几个知识点
  // 无关，所以猜测参数 g 挂在题上不挂在 KC 上。DINA `s=0.1, g=0.25` 下一次四选一
  // 答对值 +1.28 log-odds（开放题 +2.89，折扣率约 44%），而这 1.28 是**题级的**：
  // 一道挂 3 个 KC 的四选一答对若三条证据各自独立更新，会各涨 1.28、合计 3.84，
  // 等于把一道题的信息量用了三遍。
  // 这是拆条的第二处损失，方向与第一处（答错的归因，见 types.ts）相反：
  // 答错时高估坏消息，答对时高估好消息。
  //
  // 分组键是**题**（`interactionId` + `fragmentId`），不是交互。一次提交十道题是十次
  // 独立的蒙对机会，按交互分摊会把每道题打成 1/10——那是把「一题多点要分摊」错用成
  // 「一次多题要分摊」，与 g 挂在题上这条依据直接矛盾。`fragmentId` 缺席（整份资源级
  // 别的判定）时退回按交互分，那时交互本身就是最细的粒度。
  //
  // ponytail: 平均分。升级路径是按 Fisher 信息或按判官的命中/未命中分摊（命中的
  // 测项拿多数）——判官已逐测项出结论，依据是有的，等有画像层的实测再上。
  const itemKey = (e: Evidence): string =>
    `${e.source.interactionId} ${e.source.fragmentId ?? ''}`;
  const mineKey = itemKey(evidence);
  const cohort = 1 + mine.filter((x) => itemKey(x) === mineKey).length;
  const shareFactor = 1 / cohort;

  const attributionFactor =
    evidence.verdictScope === 'item-level' && verdictScore(evidence.verdict) < CORRECT_THRESHOLD
      ? ITEM_LEVEL_MISS_FACTOR
      : 1;

  let signalFactor = 1;
  for (const s of options.signals ?? []) {
    if (s.source.interactionId !== evidence.source.interactionId) continue;
    signalFactor *= SIGNAL_FACTORS[s.kind] ?? 1;
  }

  return Math.max(
    0,
    difficultyFactor * effortFactor * retraction * shareFactor * attributionFactor * signalFactor,
  );
};

/**
 * 默认稳定度：一条新证据在没有后续复测时能管多久。
 *
 * ponytail: 30 天是拍的 `[待验]`。文献里没有能直接搬给我们场景的值——FSRS 的初始
 * S 来自评分档位与大规模标定，我们既没有评分档也没有那批数据。先设常数、写进配置，
 * 事后从我们自己的履历回归。成功复测后 `S ← k·S` 由画像层做，这里不管。
 */
export const DEFAULT_STABILITY_MS = 30 * 24 * 60 * 60 * 1000;

/** Glicko 的 `c`：每天给方差加多少（logit 空间）。ponytail: 拍的 `[待验]`。 */
export const RD_GROWTH_PER_DAY = 0.05;

/**
 * RD 上限，对应 Glicko 的 350：再久不测也不会比「一无所知」更不确定。
 * 2 logit 的标准误在 IRT 里已经等于没有信息。ponytail: 拍的 `[待验]`。
 */
export const RD_MAX = 2;

/**
 * 可提取度 `R(t)`：**遗忘**那一半，会降，是导出量，决策时才算。
 *
 * FSRS/DSR 的默认曲线 `R(t) = (1 + F·t/S)^D`，`F = 19/81`、`D = −0.5`。
 * 这两个数是 FSRS 在大规模复习数据上标定好的**公开默认参数**，我们只借形式与默认值：
 * 19 参数拟合需要每人 400–1000 条复习记录，我们是单人几十条，拟不动（KT §3.1）。
 * 定义上 `R(S) = 0.9`，即稳定度 S 就是「掉到 90% 可提取度」所需的时间。
 *
 * 这个量**不进权重**（见文件头）：它作用在画像层算出来的估计值上，不作用在证据上。
 */
export function retrievability(sinceLastMs: number, stabilityMs = DEFAULT_STABILITY_MS): number {
  const t = Math.max(0, sinceLastMs);
  const s = Math.max(1, stabilityMs);
  return (1 + (19 / 81) * (t / s)) ** -0.5;
}

/**
 * 置信度扩散：**久未测量**那一半，只动不确定性，**不动估计值**。
 *
 * Glicko 的不活跃期公式 `RD' = min(√(RD² + c²·t), RD_MAX)`（Glickman 1999）。
 * 它建模的是「我们对这个人的判断过期了」（epistemic uncertainty），
 * 不是「他真的忘了」（那是 {@link retrievability}）。两者必须分开：
 * 前者靠**再测一次**收回，后者靠**再学一次**收回，对应的下一步动作根本不同。
 *
 * `rd` 与返回值都在 logit 空间（画像层的状态是 `(m, v)`，置信度 = `1/√v`）。
 */
export function widenDeviation(rd: number, sinceLastMs: number): number {
  const t = Math.max(0, sinceLastMs) / (24 * 60 * 60 * 1000);
  return Math.min(Math.sqrt(rd * rd + RD_GROWTH_PER_DAY ** 2 * t), RD_MAX);
}

/** 一条证据算完的权重。 */
export interface WeightedEvidence {
  evidence: Evidence;
  weight: number;
}

/**
 * 用给定公式重算整段履历。换公式就是换 `fn` 再跑一遍——历史不用重存，
 * 这就是「导出量优于存储量」（设计稿 §5.1）在权重上的兑现。
 *
 * `invalidated` 里的证据权重直接是 0：作废不删证据，但它不该再影响画像。
 */
export function weighAll(
  history: readonly Evidence[],
  options: WeightOptions & { fn?: WeightFn; invalidated?: ReadonlySet<string> } = {},
): WeightedEvidence[] {
  const { fn = weight, invalidated, ...rest } = options;
  const live = invalidated ? history.filter((e) => !invalidated.has(e.id)) : history;
  return live.map((evidence) => ({
    evidence,
    // 作废的证据既不计权，也不参与别人的「连续两次答错」判定与同源分摊——所以传 live。
    weight: fn(evidence, live, rest),
  }));
}
