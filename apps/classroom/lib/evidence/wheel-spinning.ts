/**
 * wheel-spinning：同一测项连错到阈值就**放弃这个点、换点**，并往账本追加一条放弃记录。
 *
 * 设计稿 `docs/03-design/blackbox-architecture-20260811.md`：
 * - §5.3 阈值表最后一行（385 行）：「放弃该知识点，换点 | — | 连错 5 次 |
 *   ALEKS 失败尝试；wheel-spinning，见 §5.4」。
 * - §5.4（460–463 行）：wheel-spinning（Beck & Gong, AIED 2013）——学不会某个技能的
 *   学习者往往就再也学不会，系统要有放弃条件；ALEKS 的对策是连续答错 5 题算一次
 *   失败尝试，提示换一个知识点。「达标即放弃该点、换点，同时记一条证据」。
 * - 附录 B-15（1068 行）：这条与「系统必须能说做不到」是同一个机制，不是两段主张。
 *
 * 阈值的出处到此为止：**5 这个数我们没有核对 ALEKS 或 Beck & Gong 的原文**，
 * 只按设计稿写的口径实现。所以它是 {@link GIVE_UP_STREAK} 这个显式常数 + 每个函数
 * 都能覆盖的 `threshold` 参数，不是散在判断里的字面量——将来核对到原始数值，
 * 或者从我们自己的履历量出来，改一处即可。
 *
 * ## 两件事分开：判定是导出量，放弃是事件
 *
 * 「哪些测项现在处于放弃状态」由 {@link wheelSpinning} 从履历**算**出来，不存
 * （与 `./fold` 同一个口径：状态不存，从履历算，换阈值重跑一遍就行）。
 * 账本里追加的 {@link GiveUp} 是**当时确实做了这个决定**的留痕：它记下当时用的阈值，
 * 所以阈值以后改了，也还看得出当初是按几判的。追加即不动，与证据一样永不丢弃。
 *
 * 放弃不是永久判决：判据取的是**末尾**那一段连错。他后来在这个点上答对了，
 * 连错段就断了，这个点自然重新进候选——不需要「解除放弃」这个动作。
 * 而只要我们真的不再考他，就不会有新证据，连错段留在末尾，他就一直在放弃集里。
 *
 * ## 一处必须说清的现状：测项键今天是**场景标题**
 *
 * `./from-quiz` 的注释已经写明：`QuizQuestion` 没有知识点字段，现在能给的最细粒度是
 * 场景级，用场景标题当 concept 键。所以 {@link dropAbandoned} 拿选点候选（知识点名）
 * 去匹配账本里的测项键时，只有「知识点名恰好等于场景标题」才对得上，多数情况下
 * 匹配不到、过滤为空转。我们不做模糊匹配、不猜——等词表和前置图就位，测项键换成
 * 真的知识点，这个函数一行不用改。
 */

import { LEGACY_DOMAIN, measuredKey, verdictScore, type Evidence, type Measured } from './types';
import { FAIL_THRESHOLD } from './weight';

/**
 * 放弃该知识点的连错次数。出处见文件头（设计稿 §5.3 表 385 行 / §5.4 461–463 行，
 * 溯源到 ALEKS 的失败尝试计数）。**不是我们自己拍的**，但也没核对到原始文献的数值。
 */
export const GIVE_UP_STREAK = 5;

/** 一个正在打转的测项：连错多少次、栽在哪条证据上。 */
export interface WheelSpin {
  measured: Measured;
  /** {@link measuredKey}，归拢与去重都用它。 */
  key: string;
  /** 末尾连续答错次数。 */
  streak: number;
  /** 触发它的最后一条答错证据。放弃记录的来源锚点从这里取。 */
  last: Evidence;
}

/** 账本里的一条放弃记录。只追加，不修改，不删除。 */
export interface GiveUp {
  id: string;
  learnerKey: string;
  /** 放弃的是哪个测项。 */
  measured: Measured;
  /** 触发时连错了几次。 */
  streak: number;
  /** **当时**用的阈值。阈值以后改了，这条记录仍说得清当初按几判的。 */
  threshold: number;
  /** 触发这次放弃的那条证据 id。要展开成「凭哪几次作答放弃的」就从它回溯。 */
  triggeredBy: string;
  /** ISO 8601。 */
  at: string;
}

export interface WheelSpinOptions {
  /** 连错多少次算放弃。缺省 {@link GIVE_UP_STREAK}。 */
  threshold?: number;
  /** 判定分低于多少算答错。缺省沿用权重函数的 {@link FAIL_THRESHOLD}，不另立一套。 */
  failBelow?: number;
}

function atMs(e: Evidence): number {
  const t = Date.parse(e.source.at);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 每个测项**末尾**的连续答错次数。答对（或部分对）一次就断，计数从 0 重新起。
 *
 * 「答错」的判据复用权重函数的 {@link FAIL_THRESHOLD}（判定分 < 0.5），不看
 * `outcome` 字面——判定的连续量才是正主，`outcome` 只是它的三分带标签。
 * 部分对（0.5 ≤ score < 0.75）既不算错也不重置为「答对」，但它确实中断了连错段：
 * 「连续答错」这个词的字面意思就是这样，不做加权。
 *
 * 传进来的应当是**有效履历**（`history(ledger)`，已剔除作废的）。
 */
export function trailingFailStreaks(
  history: readonly Evidence[],
  options: WheelSpinOptions = {},
): Map<string, WheelSpin> {
  const failBelow = options.failBelow ?? FAIL_THRESHOLD;
  const byKey = new Map<string, Evidence[]>();
  for (const e of history) {
    const key = measuredKey(e.measured);
    const group = byKey.get(key);
    if (group) group.push(e);
    else byKey.set(key, [e]);
  }

  const out = new Map<string, WheelSpin>();
  for (const [key, group] of byKey) {
    // 账本是追加序，但作答时刻才是「连续」的顺序依据（补记、跨设备都会错开）。
    // Array.sort 是稳定的，同一时刻的两条保持追加序。
    const ordered = [...group].sort((a, b) => atMs(a) - atMs(b));
    let streak = 0;
    let last: Evidence | undefined;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      if (verdictScore(ordered[i].verdict) >= failBelow) break;
      streak += 1;
      last ??= ordered[i];
    }
    if (streak > 0 && last) out.set(key, { measured: last.measured, key, streak, last });
  }
  return out;
}

/**
 * 达到阈值、该放弃的测项。按测项键排序，结果稳定可测。
 *
 * 这是 `(下一步 …)` 里「说做不到」的知识点级形式：不是继续换着花样考同一个点，
 * 而是承认这个点现在教不动，换一个。
 */
export function wheelSpinning(
  history: readonly Evidence[],
  options: WheelSpinOptions = {},
): WheelSpin[] {
  const threshold = options.threshold ?? GIVE_UP_STREAK;
  return [...trailingFailStreaks(history, options).values()]
    .filter((s) => s.streak >= threshold)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 处于放弃状态的测项键。{@link dropAbandoned} 的输入。 */
export function abandonedKeys(
  history: readonly Evidence[],
  options: WheelSpinOptions = {},
): Set<string> {
  return new Set(wheelSpinning(history, options).map((s) => s.key));
}

/**
 * 从选点候选里剔掉已放弃的知识点——「换点」的那一半。
 *
 * 候选是知识点名（`lib/generation/selection.ts` 的 `PrereqGraph.items` 那套），
 * 账本里的测项是 `Measured`，两者靠 `domain` 拼成同一个键。**今天多半对不上**，
 * 理由见文件头（测项键现在是场景标题）；对不上时这个函数原样返回候选，
 * 不做模糊匹配、不猜。
 */
export function dropAbandoned(
  candidates: readonly string[],
  history: readonly Evidence[],
  options: WheelSpinOptions & { domain?: string } = {},
): string[] {
  const dead = abandonedKeys(history, options);
  if (dead.size === 0) return [...candidates];
  // 域缺省与 `./from-quiz` 写进账本时的兜底同源（都是 LEGACY_DOMAIN），不另立一套。
  const domain = options.domain ?? LEGACY_DOMAIN;
  return candidates.filter(
    (kc) => !dead.has(measuredKey({ kind: 'concept', domain, concept: kc })),
  );
}

/**
 * 还没在账本里留过痕的放弃。追加前先过一遍，免得同一个点每答一次就记一条。
 *
 * 幂等的粒度是**测项**：一个测项放弃过就不再记。他后来答对、连错段断了、再连错到
 * 阈值——那时账本里已经有一条了，仍然不重记。要看「第几次放弃」得先有「解除放弃」
 * 这个动作，而我们没有它（见文件头）。
 */
export function unrecorded(
  spins: readonly WheelSpin[],
  giveUps: readonly GiveUp[],
): WheelSpin[] {
  const done = new Set(giveUps.map((g) => measuredKey(g.measured)));
  return spins.filter((s) => !done.has(s.key));
}
