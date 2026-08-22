import { describe, expect, it } from 'vitest';

import { quizEvidenceDraft } from '@/lib/evidence/from-quiz';
import { tutorEvidenceDraft } from '@/lib/evidence/from-tutor';
import {
  conceptForScene,
  conceptVotesForScene,
  resolveConcept,
  sceneConceptTableSize,
} from '@/lib/evidence/scene-concepts';
import { measuredKey } from '@/lib/evidence/types';

/**
 * 证据归拢到知识点，而不是场景标题。
 *
 * 图纸 §十 偏差 8（账本 F3）：四种交互的证据各走各的，没挂到同一知识点——
 * 测验证据的键是场景标题、导学证据的键是另一个场景标题，同一个知识点上的两条
 * 永远不合流，置信度涨不起来。
 *
 * 映射判据不是标题（关键词表在 212 个真实标题上只解析出 18.4%），
 * 是**场景实际引用的教材 chunk 的 `concept_tags`**，实测覆盖 160/212 = 75.5%。
 * 表由 `apps/agent-engine/scripts/experiments/derive_scene_concepts.py` 生成。
 *
 * 下面用的场景 id 都是真表里的，不是编的。
 */

/** 真表里两个不同场景，主概念都是 rag——归拢的价值就体现在这两条能合流。 */
const RAG_SCENE_A = 'scene_8JNE3hQ_Mp';
const RAG_SCENE_B = 'scene__PAfi7B8x3';
/** 真表里一个票数并列的场景：llm_basics 4 票 vs rag 4 票。 */
const TIED_SCENE = 'scene_noOw0nWejG';

describe('映射表本身', () => {
  it('覆盖了已落库的大部分场景', () => {
    // 75.5% 那个数的分母是 212 个场景，这里只钉表的绝对规模，
    // 免得课程墙一变动这条就红——覆盖率的真源是脚本输出与证据文档。
    expect(sceneConceptTableSize()).toBeGreaterThan(100);
  });

  it('表外的场景返回 null，不猜', () => {
    expect(conceptForScene('scene-does-not-exist')).toBeNull();
    expect(conceptForScene(undefined)).toBeNull();
  });

  it('票数并列时按名字定序，保证可复算', () => {
    const votes = conceptVotesForScene(TIED_SCENE);
    expect(votes.llm_basics).toBe(votes.rag);
    // 并列 → 取字典序在前的那个
    expect(conceptForScene(TIED_SCENE)).toBe('llm_basics');
  });
});

describe('resolveConcept 的三级优先', () => {
  it('引擎判词给了概念就用它——那是判官逐条出的结论，比我们反推的硬', () => {
    expect(
      resolveConcept({ engineConcept: 'attention', sceneId: RAG_SCENE_A, sceneTitle: '随便' }),
    ).toEqual({ concept: 'attention', source: 'engine' });
  });

  it('引擎没给就用引用推出来的', () => {
    expect(resolveConcept({ sceneId: RAG_SCENE_A, sceneTitle: '检索那一节' })).toEqual({
      concept: 'rag',
      source: 'cited-chunks',
    });
  });

  it('两条都没有才退回标题，并且来源标成 title——不许静默假装归拢成功', () => {
    expect(resolveConcept({ sceneId: 'scene-new', sceneTitle: '课程介绍' })).toEqual({
      concept: '课程介绍',
      source: 'title',
    });
  });

  it('什么都没有返回 null', () => {
    expect(resolveConcept({ sceneId: 'scene-new', sceneTitle: '  ' })).toBeNull();
  });
});

describe('多形态证据真的合流了', () => {
  const quiz = quizEvidenceDraft({
    learnerKey: 'learner-1',
    interactionId: 'attempt-1',
    sceneId: RAG_SCENE_A,
    sceneTitle: '向量检索怎么做',
    questions: [{ id: 'q1', prompt: '召回阶段用什么兜底？', points: 1 }],
    results: [{ questionId: 'q1', correct: true, status: 'correct', earned: 1 }],
    at: '2026-08-14T00:00:00.000Z',
  })!;

  const tutor = tutorEvidenceDraft({
    learnerKey: 'learner-1',
    interactionId: 'tutor-turn-1',
    sceneId: RAG_SCENE_B,
    sceneTitle: '重排序模型入门',
    turn: { mode: 'verdict', verdict: 'partial', profile_evidence: null },
    at: '2026-08-14T01:00:00.000Z',
  })!;

  it('两个不同场景、两种形态，归到同一个测项键', () => {
    expect(quiz.items[0].measured).toEqual({ kind: 'concept', domain: 'ai', concept: 'rag' });
    expect(tutor.items[0].measured).toEqual({ kind: 'concept', domain: 'ai', concept: 'rag' });
    expect(measuredKey(quiz.items[0].measured)).toBe(measuredKey(tutor.items[0].measured));
  });

  it('场景级溯源没丢——归拢变粗了，但还知道是哪一节', () => {
    expect(quiz.source.resourceId).toBe(RAG_SCENE_A);
    expect(tutor.source.resourceId).toBe(RAG_SCENE_B);
  });
});

describe('表外场景保持旧行为', () => {
  it('退回标题，与改动之前一字不差', () => {
    const d = quizEvidenceDraft({
      learnerKey: 'learner-1',
      interactionId: 'attempt-2',
      sceneId: 'scene-brand-new',
      sceneTitle: '注意力机制',
      questions: [{ id: 'q1', prompt: 'softmax 作用在哪个维度？', points: 1 }],
      results: [{ questionId: 'q1', correct: false, status: 'incorrect', earned: 0 }],
      at: '2026-08-14T00:00:00.000Z',
    })!;
    expect(d.items[0].measured).toEqual({
      kind: 'concept',
      domain: 'ai',
      concept: '注意力机制',
    });
  });
});
