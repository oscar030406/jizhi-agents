/**
 * 解压覆盖率（§5.4 的 L0）：压缩下限从写死的常量换成算得出的判据。
 *
 * 钉住三条：
 * 1. 「画像里有」和「本文里定义了」都算解压键 —— 两条路都能补上字典条目
 * 2. 低置信的掌握度**不算**键 —— 蒙对一次不等于会（掌握度是二元组的直接后果）
 * 3. 覆盖率低不是「写得不好」，是**这一档读不了** —— 它要指得出是哪几个术语
 */
import { describe, expect, it } from 'vitest';

import {
  COVERAGE_THRESHOLD,
  decompressionCoverage,
  keysFromProfile,
} from '@/lib/generation/decompression';

describe('解压覆盖率', () => {
  it('画像里已掌握的术语算有解压键', () => {
    const text = '注意力机制的计算依赖 Query 与 Key 的相似度。';
    const blind = decompressionCoverage(text, new Set());
    const expert = decompressionCoverage(text, new Set(['注意力机制', 'Query', 'Key']));
    expect(expert.coverage).toBeGreaterThan(blind.coverage);
    expect(expert.uncovered.length).toBeLessThan(blind.uncovered.length);
  });

  it('本文里显式定义过的术语也算有键 —— 补定义是降压缩比之外的另一条路', () => {
    const bare = decompressionCoverage('多头注意力让模型并行关注多处。', new Set());
    const defined = decompressionCoverage(
      '多头注意力是指把注意力拆成若干组并行计算的做法。',
      new Set(),
    );
    expect(defined.coverage).toBeGreaterThan(bare.coverage);
  });

  it('定义句要紧跟术语 —— 别处的「即」不能算这个术语的定义', () => {
    // 术语在句首、定义标记在很远的后面：不该被算成已定义
    const far = decompressionCoverage(
      '多头注意力' + '很'.repeat(80) + '，即另一件事。',
      new Set(),
    );
    expect(far.uncovered).toContain('多头注意力');
  });

  it('长术语覆盖短术语 —— 同一个概念不数两次，否则分母失真', () => {
    const r = decompressionCoverage('自注意力是一种注意力机制。', new Set());
    // 「注意力」被「自注意力」「注意力机制」包含，不该单独进 terms
    expect(r.terms).not.toContain('注意力');
  });

  it('没有术语就没有解压负担，覆盖率记 1', () => {
    const r = decompressionCoverage('今天天气不错。', new Set());
    expect(r.terms).toEqual([]);
    expect(r.coverage).toBe(1);
    expect(r.belowFloor).toBe(false);
  });

  it('低于阈值时要指得出是哪几个术语 —— 「读不下去」得有具体位置', () => {
    const r = decompressionCoverage('自注意力与交叉注意力的差别在于 Query 的来源。', new Set());
    expect(r.belowFloor).toBe(true);
    expect(r.uncovered.length).toBeGreaterThan(0);
    expect(r.coverage).toBeLessThan(COVERAGE_THRESHOLD);
  });
});

describe('什么样的掌握度才算解压键', () => {
  it('估计值够但置信度不够 —— 不算键', () => {
    // 蒙对一次估计值也能很高；只看估计值就会把它当成「他会了」
    expect(keysFromProfile({ rag: 0.9 }, { rag: 0.05 }).has('rag')).toBe(false);
  });

  it('置信度缺席按不够处理 —— 宁可多补一次定义', () => {
    expect(keysFromProfile({ rag: 0.9 }, undefined).has('rag')).toBe(false);
  });

  it('两条都够才算键', () => {
    expect(keysFromProfile({ rag: 0.9 }, { rag: 0.8 }).has('rag')).toBe(true);
  });

  it('估计值不够，置信度再高也不算 —— 我们很确定他不会', () => {
    expect(keysFromProfile({ rag: 0.2 }, { rag: 0.95 }).has('rag')).toBe(false);
  });
});

// 「时间预算够不够」这件事原来在这里也有一份（spec.ts 的 infeasibility），
// 阈值是拍的。判据和用词现在只有引擎那一份（实测 23 门课），测试也跟着搬过去：
// apps/agent-engine/tests/test_feasibility.py。
