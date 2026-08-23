/**
 * FSRS 换芯后的调度器测试：钉住四条硬边——重放确定性（同账本两次重放逐位同）、
 * 答错重置（间隔缩短 + lapse 计数）、间隔随连对增长、与旧固定序列的行为差异
 * （记录性断言，证明换芯生效）。外加定性门与类型推断的判据（形态事实，不猜内容）。
 */
import { describe, expect, it } from 'vitest';

import {
  INTERVAL_SEQUENCES,
  inferKnowledgeType,
  qualitativePassed,
  replayRepetition,
} from '@/lib/evidence/spaced';
import type { Evidence } from '@/lib/evidence/types';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-01T00:00:00Z');

describe('replayRepetition (FSRS)', () => {
  it('空履历为 null', () => {
    expect(replayRepetition([], 'memory')).toBeNull();
  });

  it('重放确定性：同一账本两次重放结果逐位相同', () => {
    const ledger = [
      { atMs: T0, correct: true },
      { atMs: T0 + DAY, correct: false },
      { atMs: T0 + 2 * DAY, correct: true },
      { atMs: T0 + 6 * DAY, correct: true },
    ];
    const a = replayRepetition(ledger, 'memory');
    const b = replayRepetition(ledger, 'memory');
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it('答错重置：末次答错比末次答对到期更早，且记一次 lapse', () => {
    const base = [
      { atMs: T0, correct: true },
      { atMs: T0 + DAY, correct: true },
      { atMs: T0 + 4 * DAY, correct: true },
    ];
    const lastAt = T0 + 10 * DAY;
    const pass = replayRepetition([...base, { atMs: lastAt, correct: true }], 'memory')!;
    const fail = replayRepetition([...base, { atMs: lastAt, correct: false }], 'memory')!;
    expect(fail.nextReviewAt).toBeLessThan(pass.nextReviewAt);
    expect(fail.card.lapses).toBe(1);
    expect(pass.card.lapses).toBe(0);
  });

  it('间隔随连对增长：每答对一次，距下次复习的间隔单调不减', () => {
    const answers = [T0, T0 + DAY, T0 + 4 * DAY, T0 + 12 * DAY].map((atMs) => ({
      atMs,
      correct: true,
    }));
    const intervals = answers.map(
      (_, i) =>
        replayRepetition(answers.slice(0, i + 1), 'memory')!.nextReviewAt - answers[i].atMs,
    );
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1]);
    }
  });

  it('与旧固定序列的行为差异冒烟：首次答对进短期学习步，不再是旧序列的整 1 天', () => {
    // 旧规则：首次答对进 memory 第 1 档 = 1 天整。FSRS 默认参数带学习步（分钟级），
    // 新卡答对先落在当天之内——结构性差异，证明换芯生效。
    const state = replayRepetition([{ atMs: T0, correct: true }], 'memory')!;
    const oldNext = T0 + INTERVAL_SEQUENCES.memory[1] * DAY;
    expect(state.nextReviewAt).not.toBe(oldNext);
    expect(state.nextReviewAt).toBeGreaterThan(T0);
    expect(state.nextReviewAt).toBeLessThan(oldNext);
  });
});

function ev(over: { modality: string; outcome?: 'correct' | 'incorrect'; scope?: string }): Evidence {
  return {
    id: 'e1',
    learnerKey: 'l',
    source: { interactionId: 'i', resourceId: 'r', at: '2026-08-01T00:00:00Z' },
    measured: { kind: 'concept', domain: 'ai', concept: 'rag' },
    verdict: { outcome: over.outcome ?? 'correct', because: { hit: [], missed: [] } },
    verdictScope: (over.scope ?? 'per-kc') as Evidence['verdictScope'],
    context: { encounter: 1, modality: over.modality as Evidence['context']['modality'] },
  };
}

describe('定性门与类型推断', () => {
  it('导师 per-kc correct 即定性通过；quiz 的 correct 不算', () => {
    expect(qualitativePassed([ev({ modality: 'tutor' })])).toBe(true);
    expect(qualitativePassed([ev({ modality: 'quiz' })])).toBe(false);
    expect(qualitativePassed([ev({ modality: 'tutor', outcome: 'incorrect' })])).toBe(false);
  });

  it('有导学证据的测项按 concept 走长间隔，否则 memory', () => {
    expect(inferKnowledgeType([ev({ modality: 'tutor' })])).toBe('concept');
    expect(inferKnowledgeType([ev({ modality: 'quiz' })])).toBe('memory');
  });
});
