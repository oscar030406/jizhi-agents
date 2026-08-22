/**
 * 画像 = (fold 更新规则 声明 履历)。设计稿 §4.1 的那个 fold，这里是它。
 *
 * 在此之前画像是 localStorage 里的 `conceptMastery`——一个被 EMA 就地改写的**存储量**。
 * 存储量有三个病，设计稿逐条点过：数字不可对质（说不清是哪几条证据算出来的）、
 * 改规则就废掉历史数据、申诉没地方写。fold 把这三条一次解决：
 * **状态不存，从履历算**；换规则重跑一遍就行。
 *
 * ## 掌握度是二元组，不是标量（§5.2）
 *
 * `(估计, 置信)`。为什么不能只留一个数：「答 3 题对 2 题」与「答 30 题对 20 题」的
 * 估计值都是 0.67，但该采取的下一步动作完全不同——前者该继续测，后者可以推进。
 * 压成标量就分不出来。
 *
 * 内部形式取**加权 Beta-Binomial**（交接单点名的两种形式之一）：
 * `α = α₀ + Σwᵢsᵢ`，`β = β₀ + Σwᵢ(1−sᵢ)`，估计值 = `α/(α+β)`。
 *
 * 一版写的是 logit 空间的高斯更新，**被用例证伪**：`logit(1)` 要钳到 ≈13.8，
 * 一条答对就把估计值拽到接近 1，后面的答错拉不回来——30 题对 20 题算出来是 1.0
 * 而不是 0.67。0/1 观测在 logit 上天然饱和；Beta-Binomial 没这个病，
 * 而且「有效样本量」直接就是置信度的来源，不用另设一套。
 *
 * ## 时间的两件事各归各位
 *
 * `./weight.ts` 已经把它们拆开了，这里只负责用对：
 * - **久未测量** → 老证据在**置信度**那一路按半衰期贴现，**估计值不动**。靠再测一次收回。
 * - **遗忘** → `retrievability()` 压低导出的 `recall`，**估计值不动**。靠再学一次收回。
 *
 * 关键实现细节，一版在这里栽过：贴现**只能进置信度，不能进估计值**。
 * 若把贴现后的 hit/miss 拿去算 `α/(α+β)`，估计值会随时间被拉回先验 0.5——
 * 那等于「放久了就当他没学过」，与 `weight.ts` 文件头写的
 * 「证据强度不因为放久了而变小（证据永不丢弃）」直接冲突。用例钉死了这条。
 *
 * 所以 {@link Mastery} 上同时有 `estimate`（他会不会）和 `recall`（他现在还提不提得出来）。
 * 把两者合成一个数是本轮明确纠正掉的做法。
 *
 * ## 通用面 / 专业面（§4.1）
 *
 * 测项的 `kind` 就是分界：`general` 更新通用面（跨领域守恒），
 * `concept` 更新对应 domain 的专业面。一道矩阵乘法题出现在 AI 课里，
 * 测项仍是 `{kind:'general', axis:'math'}`，所以它更新的是通用面——
 * 跨域误推被堵住，合理迁移被留下。
 */

import {
  DEFAULT_STABILITY_MS,
  retrievability,
  weighAll,
  type WeightOptions,
} from './weight';
import { measuredKey, verdictScore, type Evidence, type Measured } from './types';

/** 先验：Beta(1,1) = 均匀分布，不给任何一边偏袒。 */
export const PRIOR_ALPHA = 1;
export const PRIOR_BETA = 1;

/**
 * 久未测量时，已有信息按多少天减半。
 *
 * 这是 Glicko 的 RD 增长在「有效样本量」这套形式里的等价物：不确定性上升
 * 等价于历史信息贬值。用一个半衰期表达比在两套形式之间来回换算干净。
 * ponytail: 90 天是拍的 `[待验]`，与 `weight.ts` 里那批常数同级，
 * 从履历回归是有跨人数据之后的事。
 */
export const INFO_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

/** 置信度饱和所需的有效样本量。到这个量级就认为「问得够多了」。 */
export const CONFIDENCE_SATURATION = 12;

/** 掌握度：二元组，外加一个导出的可提取度。 */
export interface Mastery {
  measured: Measured;
  key: string;
  /** 他会不会。0–1，Beta 后验均值。**不随时间降**。 */
  estimate: number;
  /** 我们有多确定。0–1，由有效样本量还原；证据越多越高，久未测越低。 */
  confidence: number;
  /** 他**现在**还提不提得出来。= estimate × R(t)，随时间降，决策时用这个。 */
  recall: number;
  /** 算它用了几条证据。数字可对质的第一层：能展开成哪几条。 */
  evidenceCount: number;
  /** 其中有几条是粗粒度的（item-level）。 */
  itemLevelCount: number;
  /** 有效样本量 Σw，贴现后的。置信度就是从它来的。 */
  effectiveN: number;
  /** 最后一条证据的时刻。 */
  lastAt: string | null;
}

export interface Profile {
  /** 通用面：跨领域守恒。 */
  general: Mastery[];
  /** 专业面：按 domain 分。换领域是**切换**不是重置（§4.1）。 */
  byDomain: Record<string, Mastery[]>;
  /** 全部测项，含通用与专业，按证据数降序。 */
  all: Mastery[];
}

interface State {
  measured: Measured;
  /** 加权命中数与失手数。**不贴现**——估计值只由它们算，证据永不因放久而变弱。 */
  hit: number;
  miss: number;
  /** 贴现后的有效样本量，只喂置信度。 */
  effective: number;
  n: number;
  itemLevel: number;
  lastAt: string | null;
}

export interface FoldOptions extends WeightOptions {
  /** 作废的证据 id。作废不删证据，但它不再影响画像。 */
  invalidated?: ReadonlySet<string>;
  /** 算 `recall` 与置信度扩散时的「现在」。测试注入用；默认取系统时间。 */
  now?: number;
  /** 稳定度。ponytail: 全局常数，从履历回归是有跨人数据之后的事。 */
  stabilityMs?: number;
}

/**
 * 把履历折成画像。**纯函数**——同一段履历永远得到同一份画像，换规则重跑即可。
 *
 * 声明（学习者自述）不在这里：设计稿 §4.1 说「申诉写进声明，但要通过验证题产生
 * 履历证据才改变画像」。所以自述影响的是**出什么题**，不是直接改这个数——
 * 想让自述进画像的人，请先让它产生一条证据。
 */
export function fold(history: readonly Evidence[], options: FoldOptions = {}): Profile {
  const { invalidated, now = Date.now(), stabilityMs = DEFAULT_STABILITY_MS, ...weightOpts } =
    options;
  const weighted = weighAll(history, { ...weightOpts, invalidated });

  const states = new Map<string, State>();
  for (const { evidence, weight } of weighted) {
    if (weight <= 0) continue;
    const key = measuredKey(evidence.measured);
    let s = states.get(key);
    if (!s) {
      s = {
        measured: evidence.measured,
        hit: 0,
        miss: 0,
        effective: 0,
        n: 0,
        itemLevel: 0,
        lastAt: null,
      };
      states.set(key, s);
    }
    const atMs = Date.parse(evidence.source.at);
    const score = verdictScore(evidence.verdict);
    // 估计值这一路：原始权重，不贴现。证据永不因放久而变弱（§4.4）。
    s.hit += weight * score;
    s.miss += weight * (1 - score);
    // 置信度这一路：按「距今多久」贴现。老证据还算数，但它不再支撑「我们现在很确定」。
    const age = Number.isFinite(atMs) ? Math.max(0, now - atMs) : 0;
    s.effective += weight * Math.pow(0.5, age / INFO_HALF_LIFE_MS);
    s.n += 1;
    if (evidence.verdictScope === 'item-level') s.itemLevel += 1;
    if (!s.lastAt || evidence.source.at > s.lastAt) s.lastAt = evidence.source.at;
  }

  const all: Mastery[] = [];
  for (const [key, s] of states) {
    const alpha = PRIOR_ALPHA + s.hit;
    const beta = PRIOR_BETA + s.miss;
    const estimate = alpha / (alpha + beta);
    const effectiveN = s.effective;
    const lastMs = s.lastAt ? Date.parse(s.lastAt) : NaN;
    const idleMs = Number.isFinite(lastMs) ? Math.max(0, now - lastMs) : 0;
    all.push({
      measured: s.measured,
      key,
      estimate,
      // 置信度只看**有效样本量**：问得够多就确定，久未测则贴现把它拉低。
      // 不掺估计值——0.9 和 0.5 的把握程度不该因为数值高低而不同。
      confidence: Math.max(0, Math.min(1, effectiveN / CONFIDENCE_SATURATION)),
      recall: estimate * retrievability(idleMs, stabilityMs),
      evidenceCount: s.n,
      itemLevelCount: s.itemLevel,
      effectiveN,
      lastAt: s.lastAt,
    });
  }
  all.sort((a, b) => b.evidenceCount - a.evidenceCount || a.key.localeCompare(b.key));

  const general = all.filter((m) => m.measured.kind === 'general');
  const byDomain: Record<string, Mastery[]> = {};
  for (const m of all) {
    if (m.measured.kind !== 'concept') continue;
    (byDomain[m.measured.domain] ??= []).push(m);
  }
  return { general, byDomain, all };
}

/**
 * 画像里某一项能展开成哪几条证据。**数字可对质**的兑现（§4.1 第一条理由）：
 * 「RAG 掌握度 0.62」能展开成「由这 7 条证据算出来的」。
 */
export function evidenceBehind(
  history: readonly Evidence[],
  measured: Measured,
  options: FoldOptions = {},
): { evidence: Evidence; weight: number }[] {
  const key = measuredKey(measured);
  return weighAll(history, { ...options, invalidated: options.invalidated }).filter(
    (w) => measuredKey(w.evidence.measured) === key,
  );
}
