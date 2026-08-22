/**
 * 领域一路传到 `byDomain` 的桶里。
 *
 * 在这个用例存在之前，`Measured.domain` 从画像到账本这一路全是写死的 `'ai'`：
 * `from-quiz` / `from-tutor` 的 `input.domain ?? 'ai'` 拿不到调用方传的域，
 * 两个调用点也确实一个都没传。结果是 `fold` 分桶的代码写了、`byDomain` 永远只有一个桶。
 *
 * 这里钉两件事：
 * 1. 画像里录的域要真的落进证据，不同域落进不同桶；
 * 2. 画像里没有域时兜到 {@link LEGACY_DOMAIN}——2026-08-13 之前的旧证据都在
 *    'ai' 这个桶里，兜底必须和它们对齐，不能为「没填域」另开一个空桶。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => (key in store ? store[key] : null),
  setItem: (key: string, value: string) => {
    store[key] = String(value);
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const key of Object.keys(store)) delete store[key];
  },
};

vi.stubGlobal('localStorage', localStorageStub);

import { quizEvidenceDraft } from '@/lib/evidence/from-quiz';
import { tutorEvidenceDraft } from '@/lib/evidence/from-tutor';
import { fold } from '@/lib/evidence/fold';
import { PROFILE_KEY, learnerDomain } from '@/lib/evidence/profile-bridge';
import { LEGACY_DOMAIN, createEvidence } from '@/lib/evidence/types';
import type { QuestionResult } from '@/lib/quiz/grading';

const QUESTIONS = [{ id: 'q1', prompt: '什么是 PLC 的扫描周期？', points: 1 }];
const RESULTS: QuestionResult[] = [
  { questionId: 'q1', correct: true, status: 'correct', earned: 1 },
];

function quizDraft(domain?: string) {
  return quizEvidenceDraft({
    learnerKey: 'l',
    interactionId: 'attempt-1',
    sceneId: 'scene-plc',
    sceneTitle: '扫描周期',
    ...(domain ? { domain } : {}),
    questions: QUESTIONS,
    results: RESULTS,
    at: '2026-08-13T00:00:00.000Z',
  })!;
}

function tutorDraft(domain?: string) {
  return tutorEvidenceDraft({
    learnerKey: 'l',
    interactionId: 'tutor-1',
    sceneId: 'scene-plc',
    sceneTitle: '扫描周期',
    ...(domain ? { domain } : {}),
    turn: { mode: 'verdict', verdict: 'correct', expected_points: ['扫描周期'] },
    at: '2026-08-13T00:01:00.000Z',
  })!;
}

describe('learnerDomain：领域的来源', () => {
  beforeEach(() => localStorageStub.clear());

  it('读画像里录的 domain', () => {
    localStorageStub.setItem(PROFILE_KEY, JSON.stringify({ domain: 'manufacturing' }));
    expect(learnerDomain()).toBe('manufacturing');
  });

  it('画像没有 domain、画像不存在、画像损坏都给 undefined —— 由调用方兜底，不猜', () => {
    expect(learnerDomain()).toBeUndefined();
    localStorageStub.setItem(PROFILE_KEY, JSON.stringify({ role: '在校学生' }));
    expect(learnerDomain()).toBeUndefined();
    localStorageStub.setItem(PROFILE_KEY, JSON.stringify({ domain: '   ' }));
    expect(learnerDomain()).toBeUndefined();
    localStorageStub.setItem(PROFILE_KEY, '{ 不是 JSON');
    expect(learnerDomain()).toBeUndefined();
  });
});

describe('领域落进证据', () => {
  it('quiz 与 tutor 都用调用方给的域，不再写死 ai', () => {
    expect(quizDraft('manufacturing').items[0].measured).toMatchObject({
      kind: 'concept',
      domain: 'manufacturing',
    });
    expect(tutorDraft('industrial-internet').items[0].measured).toMatchObject({
      kind: 'concept',
      domain: 'industrial-internet',
    });
  });

  it('没给域时兜到 LEGACY_DOMAIN —— 与旧证据同桶', () => {
    expect(quizDraft().items[0].measured).toMatchObject({ domain: LEGACY_DOMAIN });
    expect(tutorDraft().items[0].measured).toMatchObject({ domain: LEGACY_DOMAIN });
  });
});

describe('fold 分桶', () => {
  it('不同领域的证据落进不同桶，旧证据仍归 ai', () => {
    const history = [
      // 旧证据：2026-08-13 之前写进账本的，域一律 'ai'
      ...createEvidence(quizDraft()),
      ...createEvidence(quizDraft('manufacturing')),
      ...createEvidence(tutorDraft('industrial-internet')),
    ];
    const profile = fold(history, { now: Date.parse('2026-08-13T01:00:00Z') });
    expect(Object.keys(profile.byDomain).sort()).toEqual([
      'ai',
      'industrial-internet',
      'manufacturing',
    ]);
    // 同名概念（都叫「扫描周期」）在不同域里是不同测项，不许并成一条
    expect(profile.byDomain.ai).toHaveLength(1);
    expect(profile.byDomain.manufacturing).toHaveLength(1);
    expect(profile.byDomain.ai[0].key).not.toBe(profile.byDomain.manufacturing[0].key);
  });
});
