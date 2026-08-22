/**
 * 类型化间隔重复调度器——DeepTutor `learning/scheduler.py` 的直移
 * （HKUDS，Apache-2.0；提炼判决见 docs/04-research/deeptutor-transplant-decision-20260821.md）。
 *
 * 与 policy.ts 的 recall 阈值是互补关系，不是重复：recall 只能回答「现在该不该复习」，
 * 这里回答「**哪天**该复习」——学习者要的是一张排期表，不只是一个红点。
 * 两个信号在消费端取或：到日期了、或者 recall 已经掉穿，都算到期。
 *
 * 与原版的两点差异（其余规则逐条同源）：
 * - 状态不落盘。DeepTutor 把 RepetitionState 存进 LearningProgress；我们守
 *   「状态不存，从履历算」（fold.ts 文件头），用 {@link replayRepetition} 对
 *   该测项的作答序列重放更新规则，随时可复算、换规则不废历史。
 * - 知识点类型我们没有教研标注，由 {@link inferKnowledgeType} 从证据形态推：
 *   有导学（概念级判定）证据的算 concept，否则算 memory（DeepTutor 调度器
 *   查不到类型时的缺省同为 MEMORY）。有真标注后换掉推断即可，规则不动。
 */

import type { Evidence } from './types';

/** 知识点四类型（DeepTutor KnowledgeType 直移）。 */
export type KnowledgeType = 'memory' | 'concept' | 'procedure' | 'design';

/** 类型化间隔序列，单位天（DeepTutor INTERVAL_SEQUENCES 原值直移）。 */
export const INTERVAL_SEQUENCES: Record<KnowledgeType, readonly number[]> = {
  memory: [0, 1, 3, 7, 14, 30, 60],
  concept: [3, 7, 14, 30],
  procedure: [3, 7, 14],
  design: [14, 28],
};

/** 复习优先级：错题置顶为 1（policy 层处理），类型内序与 DeepTutor _TYPE_PRIORITY 同。 */
export const TYPE_PRIORITY: Record<KnowledgeType, number> = {
  memory: 2,
  concept: 3,
  procedure: 4,
  design: 5,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RepetitionState {
  intervalIndex: number;
  consecutiveCorrect: number;
  consecutiveWrong: number;
  /** 下次复习时刻（ms epoch）。 */
  nextReviewAt: number;
}

/**
 * 一次作答后的状态更新（DeepTutor schedule_next 规则直移）：
 * 连对 2 次跳 2 档并清零，否则进 1 档；答错退 1 档、清零连对，连错 2 次清零连错。
 * 档位钳在序列边界内。
 */
export function scheduleNext(
  state: RepetitionState,
  type: KnowledgeType,
  isCorrect: boolean,
  atMs: number,
): RepetitionState {
  const intervals = INTERVAL_SEQUENCES[type];
  let { intervalIndex, consecutiveCorrect, consecutiveWrong } = state;
  if (isCorrect) {
    consecutiveWrong = 0;
    consecutiveCorrect += 1;
    if (consecutiveCorrect >= 2) {
      intervalIndex += 2;
      consecutiveCorrect = 0;
    } else {
      intervalIndex += 1;
    }
  } else {
    consecutiveWrong += 1;
    consecutiveCorrect = 0;
    intervalIndex = Math.max(0, intervalIndex - 1);
    if (consecutiveWrong >= 2) consecutiveWrong = 0;
  }
  intervalIndex = Math.max(0, Math.min(intervalIndex, intervals.length - 1));
  return {
    intervalIndex,
    consecutiveCorrect,
    consecutiveWrong,
    nextReviewAt: atMs + intervals[intervalIndex] * DAY_MS,
  };
}

/** 初始状态（DeepTutor get_initial_state 同源：从序列第 0 档起算）。 */
export function initialState(type: KnowledgeType, atMs: number): RepetitionState {
  return {
    intervalIndex: 0,
    consecutiveCorrect: 0,
    consecutiveWrong: 0,
    nextReviewAt: atMs + INTERVAL_SEQUENCES[type][0] * DAY_MS,
  };
}

/**
 * 从该测项的证据序列（时间升序）重放出当前排期状态。空序列返回 null——
 * 没作答过的东西没有复习排期，那是 nextObjective 的 probe 管的事。
 */
export function replayRepetition(
  chronological: ReadonlyArray<{ atMs: number; correct: boolean }>,
  type: KnowledgeType,
): RepetitionState | null {
  if (chronological.length === 0) return null;
  let state = initialState(type, chronological[0].atMs);
  for (const step of chronological) {
    state = scheduleNext(state, type, step.correct, step.atMs);
  }
  return state;
}

/**
 * 类型推断（我们的适配，非 DeepTutor 原有）：有概念级导学判定的测项按 concept
 * 走长间隔，纯测验测项按 memory 走短间隔。判据是证据形态这个事实，不是猜内容。
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
