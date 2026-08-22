import { describe, expect, it } from 'vitest';

import { computeAdaptationMetrics, lintAdaptation } from '@/lib/generation/adaptation-lint';

/**
 * 段落长度的**双边**判据。
 *
 * 这条规则的第一版只有上界（「超过 66 字先拆」）。2026-08-13 用新提示词真跑一门课复测，
 * 段落中位从 69 掉到 **13 汉字**——正好压在教材 2000 个段落的 P10（14），每句一段。
 * 上界救了大块文本，却把模型推到了另一面墙。
 *
 * 所以判据改成整页中位落在教材 P25–P75（19–41，中位 27）之内。
 * 判中位不判逐段：教材里 27% 的段落短于 20 字，那是断节奏用的，逐段卡下界会误报。
 *
 * 教材分位实测见 `apps/agent-engine/scripts/experiments/lecture_body_audit.py`
 * 与 `data/eval/lecture_body_audit.json`。
 */

const ids = (text: string) => lintAdaptation(text, null).violations.map((v) => v.ruleId);

/** 造 n 段、每段约 cjk 个汉字的散文。 */
const page = (n: number, cjk: number) =>
  Array.from({ length: n }, (_, i) => `第${i + 1}段。` + '这一段讲清楚一件事情的来龙去脉。'.repeat(Math.max(1, Math.round(cjk / 16))))
    .join('\n\n');

describe('段落中位落在教材区间内不报', () => {
  it('中位 ~27（教材中位）零违规', () => {
    const md = page(6, 27);
    const m = computeAdaptationMetrics(md);
    expect(m.paraMedianCjk).toBeGreaterThanOrEqual(19);
    expect(m.paraMedianCjk).toBeLessThanOrEqual(41);
    expect(ids(md)).not.toContain('BODY-PARA-TOO-SHORT');
    expect(ids(md)).not.toContain('BODY-PARA-TOO-LONG');
  });
});

describe('太短要报——这是第一版规则真实造成的失败模式', () => {
  it('每句一段（中位 ~13）报 TOO-SHORT', () => {
    // 每段 13 汉字：正是 08-13 那门新课实测的中位数。
    // 别用更短的碎片造夹具——computeAdaptationMetrics 会把 <10 汉字的行当排版产物剔掉。
    const md = [
      '向量检索能把语义相近的补回来。',
      '关键词检索遇到换词就会漏掉。',
      '余弦相似度在这一组上更高些。',
      '所以召回阶段要用向量来兜底。',
      '下一节讲索引怎么加速这一步。',
      '先看这个查询和文档的例子。',
    ].join('\n\n');
    const m = computeAdaptationMetrics(md);
    expect(m.paraMedianCjk).toBeLessThan(19);
    expect(ids(md)).toContain('BODY-PARA-TOO-SHORT');
  });

  it('报文里点出教材中位，让人知道往哪个方向改', () => {
    const md = [
      '向量检索能把语义相近的补回来。',
      '关键词检索遇到换词就会漏掉。',
      '余弦相似度在这一组上更高些。',
      '所以召回阶段要用向量来兜底。',
    ].join('\n\n');
    const hit = lintAdaptation(md, null).violations.find((v) => v.ruleId === 'BODY-PARA-TOO-SHORT');
    expect(hit!.message).toContain('教材中位 27');
  });
});

describe('太长要报', () => {
  it('中位 ~70（改规则之前我们的真实水平）报 TOO-LONG', () => {
    const md = page(5, 70);
    const m = computeAdaptationMetrics(md);
    expect(m.paraMedianCjk).toBeGreaterThan(41);
    expect(ids(md)).toContain('BODY-PARA-TOO-LONG');
  });
});

describe('样本太小不判', () => {
  it('少于 4 段返回 null，不报任何一侧', () => {
    const md = ['向量检索能把语义相近的补回来。', '关键词检索遇到换词就会漏掉。'].join('\n\n');
    expect(computeAdaptationMetrics(md).paraMedianCjk).toBeNull();
    expect(ids(md)).not.toContain('BODY-PARA-TOO-SHORT');
    expect(ids(md)).not.toContain('BODY-PARA-TOO-LONG');
  });

  it('不成句的碎片（<10 汉字）不算段落', () => {
    const md = ['短。', '也短。', '还短。', '这一段讲清楚一件事情的来龙去脉，说完它再换行。'].join('\n\n');
    // 三个碎片被剔掉后只剩 1 段 → 不足 4 段 → 不判
    expect(computeAdaptationMetrics(md).paraMedianCjk).toBeNull();
  });
});
