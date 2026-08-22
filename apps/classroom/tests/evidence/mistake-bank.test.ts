// @vitest-environment jsdom
/**
 * 错题本存储：钉三条——新错题排最前、封顶丢最旧、坏数据不炸。
 * localStorage 由 vitest 环境提供（与 profile 相关测试同前提）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { appendMistakes, readMistakes, type MistakeEntry } from '@/lib/evidence/mistake-bank';

function entry(id: string): MistakeEntry {
  return {
    at: '2026-08-22T00:00:00.000Z',
    sceneId: 's1',
    sceneTitle: '注意力机制',
    questionId: id,
    prompt: `题目 ${id}`,
    analysis: '因为如此',
    userAnswer: 'B',
    correctAnswer: 'A',
    answered: true,
  };
}

describe('mistake-bank', () => {
  beforeEach(() => localStorage.clear());

  it('新错题排最前，读写往返一致', () => {
    appendMistakes([entry('q1')]);
    appendMistakes([entry('q2')]);
    const all = readMistakes();
    expect(all.map((m) => m.questionId)).toEqual(['q2', 'q1']);
    expect(all[0].analysis).toBe('因为如此');
  });

  it('超过封顶丢最旧', () => {
    appendMistakes(Array.from({ length: 205 }, (_, i) => entry(`q${i}`)));
    expect(readMistakes()).toHaveLength(200);
  });

  it('存储里是坏数据时读回空数组不抛', () => {
    localStorage.setItem('mistakeBank', '{not json');
    expect(readMistakes()).toEqual([]);
  });
});
