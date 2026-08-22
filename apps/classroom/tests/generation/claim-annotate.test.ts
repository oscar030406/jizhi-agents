// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  annotateClaimsInHtml,
  claimNeedle,
  claimSentenceScore,
} from '@/lib/generation/claim-annotate';
import type { AuditClaim } from '@/lib/generation/hallucination-audit';

const claim = (text: string, verdict: AuditClaim['verdict'] = 'supported'): AuditClaim => ({
  claim: text,
  verdict,
  reason: '与教材一致',
});

describe('claimNeedle', () => {
  it('剥引号、句号与截断省略号', () => {
    expect(claimNeedle('「注意力权重经 softmax 归一化。」')).toBe('注意力权重经 softmax 归一化');
    expect(claimNeedle('温度参数控制采样分布的平滑程度…')).toBe('温度参数控制采样分布的平滑程度');
  });

  it('过短的断言不产出检索串（误伤防线）', () => {
    expect(claimNeedle('模型')).toBeNull();
  });
});

describe('claimSentenceScore', () => {
  it('markdown 强调符不拉低分（判官引的是渲染后文本）', () => {
    const s = claimSentenceScore(
      '注意力机制有三个核心变量：Query（查询值）、Key（键值）和 Value（真值）',
      '注意力机制有三个核心变量：**Query**（查询值）、**Key**（键值）和 **Value**（真值）。',
    );
    expect(s).toBeGreaterThan(0.9);
  });

  it('不相干句子低分', () => {
    expect(claimSentenceScore('温度参数控制采样分布的平滑程度', '梯度下降沿负梯度方向更新参数')).toBeLessThan(0.3);
  });
});

describe('annotateClaimsInHtml', () => {
  const html = '<p>注意力权重经 softmax 归一化，随后与值向量加权求和。温度参数控制分布的平滑程度。</p>';

  it('命中断言给整句包上朱批 span', () => {
    const out = annotateClaimsInHtml(html, [claim('注意力权重经 softmax 归一化，随后与值向量加权求和')]);
    expect(out).toContain('data-annot="0"');
    expect(out).toContain('annot-zhu');
    // 句界切分：第二句不在标注范围里
    expect(out).toMatch(/温度参数控制分布的平滑程度。<\/p>$/);
  });

  it('存疑断言走赭色 dotted', () => {
    const out = annotateClaimsInHtml(html, [claim('温度参数控制分布的平滑程度', 'uncertain')]);
    expect(out).toContain('annot-zhe');
    expect(out).toContain('annot-dotted');
  });

  it('判官截断的断言仍按前缀命中', () => {
    const out = annotateClaimsInHtml(html, [claim('注意力权重经 softmax 归一化，随后与值向量…')]);
    expect(out).toContain('data-annot="0"');
  });

  it('跨行内标签的句子整句可标（多枚同号 span）', () => {
    const split =
      '<p>注意力机制有三个核心变量：<strong>Query</strong>（查询值）、<strong>Key</strong>（键值）和 <strong>Value</strong>（真值）。</p>';
    const out = annotateClaimsInHtml(split, [
      claim('注意力机制有三个核心变量：Query（查询值）、Key（键值）和 Value（真值）'),
    ]);
    expect(out).toContain('data-annot="0"');
    // strong 结构保留（批注 span 切进标签内侧，不破坏元素嵌套）
    expect(out).toMatch(/<strong><span[^>]*data-annot="0"[^>]*>Query<\/span><\/strong>/);
  });

  it('找不到相似句时原样返回（引用相等）', () => {
    expect(annotateClaimsInHtml(html, [claim('梯度下降沿负梯度方向迭代更新模型参数')])).toBe(html);
  });

  it('两条断言指同一句不嵌套', () => {
    const out = annotateClaimsInHtml(html, [
      claim('注意力权重经 softmax 归一化，随后与值向量加权求和'),
      claim('注意力权重经过 softmax 做归一化处理，与值向量加权求和'),
    ]);
    const matches = out.match(/data-annot="(\d+)"/g) ?? [];
    expect(new Set(matches).size).toBe(1);
  });
});
