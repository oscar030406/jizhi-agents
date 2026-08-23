/**
 * 蓝图三张课程级表：数字例登记、概念引入顺序、示例文风。
 *
 * 这三个字段里前两个**昨天就定义好了却一直没人灌**——`coherenceDirective`
 * 里发它们的分支写着，但 frame 上永远是 undefined，等于那段代码从没执行过。
 * 「接了没灌注」，我自己写的代码里也长这个病。
 */
import { describe, expect, it } from 'vitest';

import {
  coherenceDirective,
  coherenceFromOutlines,
  courseFrameFromOutlines,
  emptyProgress,
} from '@/lib/generation/course-coherence';
import { blueprintDirective } from '@/lib/generation/learner-profile';

const OUTLINES = [
  { id: 'a', title: '什么是循环周期', keyPoints: ['扫描周期就像食堂排队，一轮走完才轮到下一轮'] },
  { id: 'b', title: '监视时间怎么算', keyPoints: ['默认 150ms，任务占 80ms，余量 70ms'] },
  { id: 'c', title: '超时了怎么办', keyPoints: ['超时直接停机'] },
];

describe('课程级三张表', () => {
  it('数字例登记：概念绑定唯一一组数字', () => {
    const frame = courseFrameFromOutlines(OUTLINES);
    expect(frame.numericExamples).toHaveLength(1);
    expect(frame.numericExamples![0].concept).toBe('监视时间怎么算');
    expect(frame.numericExamples![0].example).toContain('150ms');
    // 概念名不该在 example 里重复一遍（进提示词时两边会拼起来）
    expect(frame.numericExamples![0].example).not.toContain('监视时间怎么算');
  });

  it('同名概念只登记第一次那组，后面的不覆盖也不追加', () => {
    const dup = [
      { id: 'a', title: '监视时间', keyPoints: ['默认 150ms，余量 70ms'] },
      { id: 'b', title: '监视时间', keyPoints: ['也可以设 300ms，任务 200ms'] },
    ];
    const frame = courseFrameFromOutlines(dup);
    expect(frame.numericExamples).toHaveLength(1);
    expect(frame.numericExamples![0].example).toContain('150ms');
    expect(frame.numericExamples![0].example).not.toContain('300ms');
  });

  it('概念引入顺序 = 大纲顺序', () => {
    expect(courseFrameFromOutlines(OUTLINES).conceptOrder).toEqual([
      '什么是循环周期',
      '监视时间怎么算',
      '超时了怎么办',
    ]);
  });

  it('两张表都进指令，且措辞是可比对的负向判据', () => {
    const { frame, progress } = coherenceFromOutlines(OUTLINES, 'b');
    const d = coherenceDirective(frame, progress);
    expect(d).toContain('数字例登记');
    expect(d).toContain('150ms');
    expect(d).toContain('还没讲的概念');
    expect(d).toContain('超时了怎么办');
  });

  it('这一屏正在讲的概念，两张清单都排除它', () => {
    const { frame, progress } = coherenceFromOutlines(OUTLINES, 'b');
    expect(progress.teachingNow).toBe('监视时间怎么算');
    expect(progress.concepts).not.toContain('监视时间怎么算');
    const d = coherenceDirective(frame, progress);
    // 「还没讲」那一段不许把本屏主题列进去——那会让模型不敢讲它
    const notYet = d.slice(d.indexOf('还没讲的概念'));
    expect(notYet).not.toContain('监视时间怎么算');
  });

  it('空大纲不造表', () => {
    const frame = courseFrameFromOutlines([]);
    expect(frame.numericExamples).toBeUndefined();
    expect(frame.conceptOrder).toBeUndefined();
    expect(coherenceDirective(frame, emptyProgress())).toBe('');
  });
});

describe('示例文风', () => {
  const bp = {
    recommended_difficulty: 'L1',
    weak_concepts: [],
    blueprint: { learner_type: '零基础' },
  } as never;

  it('L1 给的是大白话样例', () => {
    const d = blueprintDirective(bp, { domain: 'ai', programming_level: 0 } as never);
    expect(d).toContain('这一档的文风长这样');
    expect(d).toContain('闹钟');
  });

  it('L3 给的是工程取舍样例，不是大白话', () => {
    const d = blueprintDirective(
      { ...(bp as object), recommended_difficulty: 'L3' } as never,
      { domain: 'ai', programming_level: 5, agent_level: 4 } as never,
    );
    expect(d).toContain('这一档的文风长这样');
    expect(d).toContain('最坏路径');
    expect(d).not.toContain('闹钟');
  });

  it('明说别把样例抄进正文——不然它会当成内容', () => {
    const d = blueprintDirective(bp, { domain: 'ai', programming_level: 0 } as never);
    expect(d).toContain('不要把这句抄进正文');
  });
});
