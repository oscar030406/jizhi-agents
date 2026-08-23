/**
 * 间隔重复调度器——内核为 ts-fsrs（open-spaced-repetition 官方 TS 实现，MIT），
 * 默认参数，取代原 DeepTutor 固定间隔序列（见文件历史与 INTERVAL_SEQUENCES 注记）。
 *
 * 与 policy.ts 的 recall 阈值是互补关系，不是重复：recall 只能回答「现在该不该复习」，
 * 这里回答「**哪天**该复习」——学习者要的是一张排期表，不只是一个红点。
 * 两个信号在消费端取或：到日期了、或者 recall 已经掉穿，都算到期。
 *
 * 架构原则不变：状态不落盘，用 {@link replayRepetition} 从证据账本重放推导当前
 * 卡片状态与到期时间，随时可复算、换规则不废历史。重放必须确定：默认参数
 * enable_fuzz=false，同一账本两次重放结果逐位相同。
 *
 * 评分映射：答对→Good、答错→Again。我们没有作答置信/耗时输入，Hard/Easy 无判据，不用。
 */

import { createEmptyCard, fsrs, Rating, type Card } from 'ts-fsrs';

import type { Evidence } from './types';

/** 知识点四类型（沿自 DeepTutor KnowledgeType）。 */
export type KnowledgeType = 'memory' | 'concept' | 'procedure' | 'design';

/**
 * @deprecated 旧固定间隔序列（DeepTutor 直移），已被 FSRS 替代，仅供测试对照旧行为。
 */
export const INTERVAL_SEQUENCES: Record<KnowledgeType, readonly number[]> = {
  memory: [0, 1, 3, 7, 14, 30, 60],
  concept: [3, 7, 14, 30],
  procedure: [3, 7, 14],
  design: [14, 28],
};

export interface RepetitionState {
  /** 下次复习时刻（ms epoch）。 */
  nextReviewAt: number;
  /** FSRS 卡片全量状态（stability/difficulty/reps/lapses/state）。 */
  card: Card;
}

/** FSRS 默认参数；enable_fuzz 默认关闭，保重放确定性。 */
const scheduler = fsrs();

/**
 * 从该测项的证据序列（时间升序）重放出当前排期状态。空序列返回 null——
 * 没作答过的东西没有复习排期，那是 nextObjective 的 probe 管的事。
 *
 * type 参数保留接口兼容：FSRS 默认参数不按知识类型分档（个体化靠参数优化，
 * 我们没有训练数据，先统一默认参数）。
 */
export function replayRepetition(
  chronological: ReadonlyArray<{ atMs: number; correct: boolean }>,
  _type: KnowledgeType,
): RepetitionState | null {
  if (chronological.length === 0) return null;
  let card = createEmptyCard(new Date(chronological[0].atMs));
  for (const step of chronological) {
    card = scheduler.next(card, new Date(step.atMs), step.correct ? Rating.Good : Rating.Again).card;
  }
  return { nextReviewAt: card.due.getTime(), card };
}

/**
 * 类型推断（我们的适配，非 DeepTutor 原有）：有概念级导学判定的测项按 concept，
 * 纯测验测项按 memory。判据是证据形态这个事实，不是猜内容。
 */
export function inferKnowledgeType(evidences: ReadonlyArray<Evidence>): KnowledgeType {
  return evidences.some((e) => e.context.modality === 'tutor') ? 'concept' : 'memory';
}

/**
 * 定性门（DeepTutor mastery_assess 的语义映射）：导师就该概念出过 per-kc 的
 * correct 判定（判据是「每条要点都被覆盖」的费曼式检查）即视为定性通过。
 * 与原版的差异：原版 concept/design **只**认定性门；我们的概念测项大多由测验
 * 累积定量证据，锁死在定性门后会让没用过导学的学习者永远「未掌握」——所以
 * 这里定性通过是**充分条件之一**，定量门照常有效。偏差已记录在判决文档。
 */
export function qualitativePassed(evidences: ReadonlyArray<Evidence>): boolean {
  return evidences.some(
    (e) =>
      e.verdictScope === 'per-kc' &&
      e.verdict.outcome === 'correct' &&
      e.context.modality === 'tutor',
  );
}
