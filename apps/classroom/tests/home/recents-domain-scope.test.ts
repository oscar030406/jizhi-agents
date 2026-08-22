/**
 * 最近学习按域分桶（B1）。
 *
 * 实锤：新账号切到智能制造域，最近学习里躺着前一个账号的 15 门 AI 课。
 * 用户口径「两个库的课程与个性化不许混」。
 */
import { describe, expect, it } from 'vitest';

import { belongsToDomain } from '@/lib/knowledge/use-course-domains';

const DOMAINS = {
  'ai-1': { corpus: 'ai' },
  'ai-2': { domain: 'ai' },
  'mfg-1': { corpus: 'smart-manufacturing' },
};

describe('最近学习的域归属判据', () => {
  it('画像选了库时只留这个库的课', () => {
    expect(belongsToDomain('mfg-1', 'smart-manufacturing', DOMAINS)).toBe(true);
    expect(belongsToDomain('ai-1', 'smart-manufacturing', DOMAINS)).toBe(false);
    expect(belongsToDomain('ai-2', 'smart-manufacturing', DOMAINS)).toBe(false);
  });

  it('画像没选库（跟随培训领域）时不过滤', () => {
    for (const id of Object.keys(DOMAINS)) {
      expect(belongsToDomain(id, undefined, DOMAINS)).toBe(true);
      expect(belongsToDomain(id, '  ', DOMAINS)).toBe(true);
    }
  });

  it('归属表里没有的课算可见——刚生成的课不该凭空消失', () => {
    // 归属表是异步推导的，新课有一段时间不在表里。
    // 宁可多显示一门，也不要让学习者刚造好的课在首页找不到。
    expect(belongsToDomain('just-created', 'smart-manufacturing', DOMAINS)).toBe(true);
  });

  it('corpus 与 domain 两种键都认', () => {
    // 归属表历史上两种写法都有，运行时推导给 corpus、打包快照给 domain
    expect(belongsToDomain('ai-1', 'ai', DOMAINS)).toBe(true);
    expect(belongsToDomain('ai-2', 'ai', DOMAINS)).toBe(true);
  });
});
