/**
 * 导学判分轮 → 证据。
 *
 * 两条纪律各有用例钉住：
 * 1. 导学的判定是概念级的，落 `per-kc` —— 与 quiz 那条 `item-level` 的区别不能被抹平
 * 2. partial 时**不许猜哪条要点命中了**（§4.4：答错只说明「至少有一个没过」，
 *    伪造归因是本轮纠正掉的那件事）
 */
import { describe, expect, it } from 'vitest';

import { tutorEvidenceDraft, type TutorTurnBrief } from '@/lib/evidence/from-tutor';
import { createEvidence } from '@/lib/evidence/types';

const POINTS = ['注意力权重由 softmax 归一化', '除以 sqrt(d_k) 防止梯度消失'];

function turn(over: Partial<TutorTurnBrief> = {}): TutorTurnBrief {
  return {
    mode: 'verdict',
    verdict: 'correct',
    expected_points: POINTS,
    profile_evidence: { concept: 'attention', verdict: 'correct', confidence: 0.9 },
    ...over,
  };
}

function draft(over: Partial<Parameters<typeof tutorEvidenceDraft>[0]> = {}) {
  return tutorEvidenceDraft({
    learnerKey: 'learner-1',
    interactionId: 'tutor-turn-1',
    sceneId: 'scene-attn',
    sceneTitle: '注意力机制',
    turn: turn(),
    at: '2026-08-12T00:00:00.000Z',
    ...over,
  });
}

describe('tutorEvidenceDraft', () => {
  it('测项取引擎回传的概念，不是场景标题', () => {
    const d = draft()!;
    expect(d.items[0].measured).toEqual({ kind: 'concept', domain: 'ai', concept: 'attention' });
  });

  it('引擎没回传概念时才回落场景标题', () => {
    const d = draft({ turn: turn({ profile_evidence: null }) })!;
    expect(d.items[0].measured).toMatchObject({ concept: '注意力机制' });
  });

  it('落 per-kc —— 判官判的就是这个概念，不是摊过来的', () => {
    const e = createEvidence(draft()!);
    expect(e[0].verdictScope).toBe('per-kc');
    expect(e[0].context.modality).toBe('tutor');
  });

  it('correct 时全部要点算命中', () => {
    const d = draft()!;
    expect(d.items[0].verdict!.because.hit).toEqual(POINTS);
    expect(d.items[0].verdict!.because.missed).toEqual([]);
  });

  it('partial 时不许猜哪条命中 —— 全记 missed，宁可低估', () => {
    const d = draft({ turn: turn({ verdict: 'partial' }) })!;
    // 「明确漏掉至少一条」只说明有漏，不说明哪条命中。把不知道的算成命中是高估，
    // 高估会让掌握度虚高、跳过本该复习的内容。
    expect(d.items[0].verdict!.because.hit).toEqual([]);
    expect(d.items[0].verdict!.because.missed).toEqual(POINTS);
  });

  it('incorrect 同理', () => {
    const d = draft({ turn: turn({ verdict: 'incorrect' }) })!;
    expect(d.items[0].verdict!.because.hit).toEqual([]);
  });

  it('score 优先用引擎的掌握度估计，缺席才按裁决映射', () => {
    expect(draft({ turn: turn({ mastery_estimate: 0.73 }) })!.items[0].verdict!.score).toBe(0.73);
    expect(draft()!.items[0].verdict!.score).toBe(1);
    expect(draft({ turn: turn({ verdict: 'partial' }) })!.items[0].verdict!.score).toBe(0.5);
  });

  it('出题轮不是证据', () => {
    expect(draft({ turn: turn({ mode: 'ask', verdict: '' }) })).toBeNull();
  });

  it('引擎降级没判成也不是证据 —— 硬造只会把噪声写进履历', () => {
    expect(draft({ turn: turn({ mode: 'unavailable', verdict: '' }) })).toBeNull();
    expect(draft({ turn: turn({ verdict: '' }) })).toBeNull();
  });

  it('没有任何测项可挂时返回 null', () => {
    expect(
      draft({ sceneTitle: '  ', turn: turn({ profile_evidence: null }) }),
    ).toBeNull();
  });

  it('encounter 由调用方续', () => {
    expect(draft({ priorEncounters: 5 })!.items[0].context.encounter).toBe(6);
  });
});

describe('讲评场景上的导学', () => {
  it('记 review —— 测的是订正后的理解', () => {
    const d = draft({ sceneId: 'remediation_add_practice_1754000000000' })!;
    expect(d.items[0].context.modality).toBe('review');
  });

  it('普通场景仍是 tutor', () => {
    expect(draft()!.items[0].context.modality).toBe('tutor');
  });
});
