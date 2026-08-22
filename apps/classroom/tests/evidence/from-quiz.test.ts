/**
 * 交卷结果 → 证据草稿。
 *
 * 钉住的核心是**降级必须留痕**：题目粒度挂不上概念之前，这条证据只能是
 * 整卷判定摊到场景级测项上，`verdictScope` 必须是 `item-level`。
 * 哪天有人把它改成 `per-kc`（比如为了让权重不打折），这里会红。
 */
import { describe, expect, it } from 'vitest';

import { quizEvidenceDraft } from '@/lib/evidence/from-quiz';
import { createEvidence } from '@/lib/evidence/types';
import type { QuestionResult } from '@/lib/quiz/grading';

const QUESTIONS = [
  { id: 'q1', prompt: '注意力机制里 softmax 作用在哪个维度上？', points: 1 },
  { id: 'q2', prompt: '为什么要除以 sqrt(d_k)？', points: 1 },
  { id: 'q3', prompt: '多头注意力的头之间共享参数吗？', points: 2 },
];

function results(...statuses: Array<'correct' | 'incorrect'>): QuestionResult[] {
  return statuses.map((status, i) => ({
    questionId: QUESTIONS[i].id,
    correct: status === 'correct',
    status,
    earned: status === 'correct' ? (QUESTIONS[i].points ?? 1) : 0,
  }));
}

function draft(over: Partial<Parameters<typeof quizEvidenceDraft>[0]> = {}) {
  return quizEvidenceDraft({
    learnerKey: 'learner-1',
    interactionId: 'attempt-1',
    sceneId: 'scene-attn',
    sceneTitle: '注意力机制',
    questions: QUESTIONS,
    results: results('correct', 'correct', 'incorrect'),
    at: '2026-08-12T00:00:00.000Z',
    ...over,
  });
}

describe('quizEvidenceDraft', () => {
  it('一次交卷产一条证据，测项是场景级概念', () => {
    const d = draft();
    expect(d).not.toBeNull();
    expect(d!.items).toHaveLength(1);
    expect(d!.items[0].measured).toEqual({
      kind: 'concept',
      domain: 'ai',
      concept: '注意力机制',
    });
  });

  it('判定放在 draft 层，落成 item-level —— 降级必须留痕', () => {
    const evidence = createEvidence(draft()!);
    expect(evidence).toHaveLength(1);
    // 判官没有逐知识点出过结论，标成 per-kc 就是撒谎
    expect(evidence[0].verdictScope).toBe('item-level');
    expect(d(evidence[0].verdict.score)).toBeCloseTo(2 / 4);
  });

  it('score 按配分算，不按题数算', () => {
    // q3 值 2 分：只答对 q3 = 2/4，只答对 q1+q2 = 2/4，两者相等才说明按配分
    const onlyBig = draft({ results: results('incorrect', 'incorrect', 'correct') })!;
    const onlySmall = draft({ results: results('correct', 'correct', 'incorrect') })!;
    expect(onlyBig.verdict!.score).toBeCloseTo(onlySmall.verdict!.score!);
    expect(onlyBig.verdict!.score).toBeCloseTo(0.5);
  });

  it('because 分出命中与漏掉，用题干摘要标识', () => {
    const d0 = draft()!;
    expect(d0.verdict!.because.hit).toHaveLength(2);
    expect(d0.verdict!.because.missed).toHaveLength(1);
    expect(d0.verdict!.because.missed[0]).toContain('多头注意力');
  });

  it('长题干截断，账本不被撑爆', () => {
    const long = { id: 'q1', prompt: '啊'.repeat(200), points: 1 };
    const d0 = quizEvidenceDraft({
      learnerKey: 'l',
      interactionId: 'i',
      sceneId: 's',
      sceneTitle: 't',
      questions: [long],
      results: [{ questionId: 'q1', correct: true, status: 'correct', earned: 1 }],
      at: '2026-08-12T00:00:00.000Z',
    })!;
    expect(d0.verdict!.because.hit[0].length).toBeLessThan(50);
    expect(d0.verdict!.because.hit[0]).toMatch(/…$/);
  });

  it('encounter 从调用方给的历史条数续上，不自己查账本', () => {
    expect(draft()!.items[0].context.encounter).toBe(1);
    expect(draft({ priorEncounters: 3 })!.items[0].context.encounter).toBe(4);
  });

  it('题目难度不填 —— 上游没有，编一个不如缺省', () => {
    expect(draft()!.items[0].context.difficulty).toBeUndefined();
  });

  it('没有结果或没有场景标题就不是证据，返回 null', () => {
    expect(draft({ results: [] })).toBeNull();
    expect(draft({ sceneTitle: '   ' })).toBeNull();
  });

  it('三分带按得分给 outcome', () => {
    expect(draft({ results: results('correct', 'correct', 'correct') })!.verdict!.outcome).toBe(
      'correct',
    );
    expect(draft()!.verdict!.outcome).toBe('partial');
    expect(draft({ results: results('incorrect', 'incorrect', 'incorrect') })!.verdict!.outcome).toBe(
      'incorrect',
    );
  });
});

/** 让上面那行读起来不别扭的小工具。 */
function d(v: number | undefined): number {
  return v ?? Number.NaN;
}

describe('讲评与首次作答分得开', () => {
  it('补救场景上的作答记 review，不是 quiz', () => {
    const d = draft({ sceneId: 'remediation_downgrade_explanation_1754000000000' })!;
    expect(d.items[0].context.modality).toBe('review');
  });

  it('普通场景仍是 quiz', () => {
    expect(draft()!.items[0].context.modality).toBe('quiz');
  });
});

describe('错因粗分（errorType）', () => {
  const withAnswered = (flags: Array<boolean | undefined>) =>
    results('correct', 'incorrect', 'incorrect').map((r, i) => ({ ...r, answered: flags[i] }));

  it('答错全是空答记 metacognitive，全答了记 application，混着记 mixed', () => {
    expect(draft({ results: withAnswered([true, false, false]) })?.verdict?.errorType).toBe(
      'metacognitive',
    );
    expect(draft({ results: withAnswered([true, true, true]) })?.verdict?.errorType).toBe(
      'application',
    );
    expect(draft({ results: withAnswered([true, false, true]) })?.verdict?.errorType).toBe('mixed');
  });

  it('全对没有 errorType；旧调用方不带 answered 时不编分型', () => {
    expect(
      draft({ results: results('correct', 'correct', 'correct') })?.verdict?.errorType,
    ).toBeUndefined();
    expect(draft()?.verdict?.errorType).toBeUndefined();
  });
});
