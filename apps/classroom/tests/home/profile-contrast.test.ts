/**
 * 首页「画像改变了什么」挑的那一对课（components/home/public-landing.tsx）。
 *
 * 要治的病是「凑一对给人看」：这一块的说服力全在于两门课**真的**是同一个概念、
 * 两份画像各自生成的。所以最重要的断言是**凑不出就返回 null**——
 * 它红了说明又开始拿两门无关的课硬当对照了。
 */

import { describe, expect, it } from 'vitest';

import {
  type ClassroomSummary,
  type CoursePath,
  pickProfileContrast,
} from '@/components/home/public-landing';

const course = (id: string, title: string, sceneCount = 5): ClassroomSummary => ({
  id,
  title,
  sceneCount,
  createdAt: '2026-01-01',
  audit: null,
});

const path = (courses: CoursePath['courses']): Pick<CoursePath, 'courses'> => ({ courses });

describe('pickProfileContrast', () => {
  it('同一概念下讲解档不同时，给出档低的与档高的各一门', () => {
    const hit = pickProfileContrast(
      path({
        a: { concept: 'rag', tier: 'L1', profileFields: ['education'] },
        b: { concept: 'rag', tier: 'L2', profileFields: ['education', 'pythonLevel'] },
      }),
      [course('a', '低档课'), course('b', '高档课', 10)],
    );
    expect(hit?.concept).toBe('rag');
    expect(hit?.low.course.id).toBe('a');
    expect(hit?.high.course.id).toBe('b');
  });

  it('同一概念只有同一个档时不凑对照', () => {
    expect(
      pickProfileContrast(
        path({
          a: { concept: 'rag', tier: 'L1', profileFields: [] },
          b: { concept: 'rag', tier: 'L1', profileFields: ['education'] },
        }),
        [course('a', '甲'), course('b', '乙')],
      ),
    ).toBeNull();
  });

  it('档不同但概念不同时不凑对照', () => {
    expect(
      pickProfileContrast(
        path({
          a: { concept: 'rag', tier: 'L1' },
          b: { concept: 'llm_basics', tier: 'L2' },
        }),
        [course('a', '甲'), course('b', '乙')],
      ),
    ).toBeNull();
  });

  it('老课没有生成期档位，不参与对照', () => {
    expect(
      pickProfileContrast(path({ a: { concept: 'rag' }, b: { concept: 'rag', tier: 'L2' } }), [
        course('a', '甲'),
        course('b', '乙'),
      ]),
    ).toBeNull();
  });
});
