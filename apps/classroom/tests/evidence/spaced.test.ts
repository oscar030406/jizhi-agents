/**
 * 类型化间隔调度器（DeepTutor scheduler 直移）：钉更新规则的四条硬边——
 * 连对 2 跳 2 档、答错退 1 档、档位钳边界、从履历重放可复算。
 * 外加定性门与类型推断的判据（形态事实，不猜内容）。
 */
import { describe, expect, it } from 'vitest';

import {
  INTERVAL_SEQUENCES,
  inferKnowledgeType,
  initialState,
  qualitativePassed,
  replayRepetition,
  scheduleNext,
} from '@/lib/evidence/spaced';
import type { Evidence } from '@/lib/evidence/types';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-01T00:00:00Z');

describe('scheduleNext', () => {
  it('连对 2 次跳 2 档并清零；单次对进 1 档', () => {
    let s = initialState('memory', T0);
    s = scheduleNext(s, 'memory', true, T0); // cc=1, idx 0→1
    expect(s.intervalIndex).toBe(1);
    s = scheduleNext(s, 'memory', true, T0 + DAY); // cc=2 → idx 1→3, cc 清零
    expect(s.intervalIndex).toBe(3);
    expect(s.consecutiveCorrect).toBe(0);
    expect(s.nextReviewAt).toBe(T0 + DAY + INTERVAL_SEQUENCES.memory[3] * DAY);
  });

  it('答错退 1 档且不越下界；档位不越上界', () => {
    let s = { intervalIndex: 0, consecutiveCorrect: 0, consecutiveWrong: 0, nextReviewAt: 0 };
    s = scheduleNext(s, 'design', false, T0);
    expect(s.intervalIndex).toBe(0); // 已在底，不再退
    let top = { intervalIndex: 1, consecutiveCorrect: 1, consecutiveWrong: 0, nextReviewAt: 0 };
    top = scheduleNext(top, 'design', true, T0); // cc=2 → +2 → 钳到 1（design 只有 2 档）
    expect(top.intervalIndex).toBe(1);
  });

  it('replayRepetition 从履历重放，空履历为 null', () => {
    expect(replayRepetition([], 'memory')).toBeNull();
    const state = replayRepetition(
      [
        { atMs: T0, correct: true },
        { atMs: T0 + DAY, correct: true },
      ],
      'memory',
    );
    expect(state?.intervalIndex).toBe(3);
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
