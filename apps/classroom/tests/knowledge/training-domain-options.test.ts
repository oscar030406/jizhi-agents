import { describe, expect, it } from 'vitest';

import { trainingDomainOptions } from '@/components/generation/learner-profile-popover';

/**
 * 培训领域下拉曾是四条硬编码：manufacturing / industrial-internet / software
 * 盘上一块语料都没有，而真建好的 smart-manufacturing（1703 块）不在名单里——
 * 选「智能制造」选到的是空壳。下面这几条钉住改法。
 */
const ENTRIES = {
  ai: { corpus: 'ai', chunks: 1529 },
  manufacturing: { corpus: 'manufacturing', chunks: 0 },
  'industrial-internet': { corpus: 'industrial-internet', chunks: 0 },
  software: { corpus: 'software', chunks: 0 },
  'smart-manufacturing': { corpus: 'smart-manufacturing', chunks: 1703 },
  'fullpath-probe': { corpus: 'fullpath-probe', chunks: 42 },
};

describe('培训领域下拉', () => {
  it('只列有块数的库，空壳领域不出现', () => {
    const ids = trainingDomainOptions(ENTRIES, 'ai').map((o) => o.id);
    expect(ids).toContain('ai');
    expect(ids).toContain('smart-manufacturing');
    expect(ids).not.toContain('manufacturing');
    expect(ids).not.toContain('industrial-internet');
    expect(ids).not.toContain('software');
  });

  it('一次性验证库不给学习者看', () => {
    const ids = trainingDomainOptions(ENTRIES, 'ai').map((o) => o.id);
    expect(ids).not.toContain('fullpath-probe');
  });

  it('账户里存的旧值照样上屏，并标出未接入', () => {
    const options = trainingDomainOptions(ENTRIES, 'manufacturing');
    expect(options[0]).toMatchObject({ id: 'manufacturing', missing: true });
    // 存的值不被改写成别的领域：下拉里仍然是它自己
    expect(options.filter((o) => o.id === 'manufacturing')).toHaveLength(1);
  });

  it('清单还没灌注时退回老名单，不给一个空下拉', () => {
    const ids = trainingDomainOptions({}, 'ai').map((o) => o.id);
    expect(ids).toEqual(['ai', 'manufacturing', 'industrial-internet', 'software']);
  });
});
