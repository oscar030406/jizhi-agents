import { describe, expect, test } from 'vitest';

import {
  extractVerifiables,
  hasVerifiableContent,
} from '@/lib/generation/content-verify';

// KR2 抽取层的行为锁：等宽字体=代码块，其余进文本；无可验内容不空跑桥。

describe('extractVerifiables', () => {
  test('等宽字体元素判为代码块并剥 HTML', () => {
    const els = [
      {
        type: 'text',
        content:
          '<p style="font-size: 14px; font-family: Consolas, monospace;">import torch</p>' +
          '<p style="font-size: 14px; font-family: Consolas, monospace;">x&nbsp;=&nbsp;1</p>',
        defaultFontName: '',
      },
      { type: 'text', content: '<p style="font-size: 18px;">分母 2.7183 + 1 = 3.7183</p>' },
      { type: 'shape', content: undefined },
    ];
    const { codeBlocks, texts } = extractVerifiables(els);
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]).toContain('import torch');
    expect(codeBlocks[0]).toContain('x = 1');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('2.7183 + 1 = 3.7183');
  });

  test('defaultFontName 等宽也判为代码块', () => {
    const { codeBlocks } = extractVerifiables([
      { type: 'text', content: '<p>print(1)</p>', defaultFontName: 'Courier New' },
    ]);
    expect(codeBlocks).toHaveLength(1);
  });
});

// KR2 三伪影移植（task_00c0763d）：评测链在 6 门课上实锤过的假失败源，产品桥同口径。
describe('抽取伪影三修', () => {
  test('KaTeX 带 annotation：整棵树换回 TeX 源，10^7 不摊平成 107', () => {
    const katex =
      '<span class="katex"><span class="katex-mathml"><annotation encoding="application/x-tex">6.7\\times 10^{7}</annotation></span>' +
      '<span class="katex-html"><span>6.7</span><span>×</span><span>1</span><span>0</span><span>7</span></span></span>';
    const { texts } = extractVerifiables([
      { type: 'text', content: `<p>参数量约 ${katex} 个</p>` },
    ]);
    expect(texts[0].replace(/\s+/g, '')).toContain('6.7*10^7');
    expect(texts[0]).not.toContain('107');
  });

  test('KaTeX 纯 html 树（无 annotation）：msupsub 重建指数', () => {
    const katex =
      '<span class="katex"><span class="katex-html"><span class="base">' +
      '<span class="mord">10</span><span class="msupsub"><span>7</span></span></span></span></span>';
    const { texts } = extractVerifiables([{ type: 'text', content: `<p>${katex}</p>` }]);
    expect(texts[0]).toContain('10^7');
  });

  test('HTML 上标补 ^、下标换 x、字面 NBSP 换空格', () => {
    const { texts } = extractVerifiables([
      { type: 'text', content: '<p>10<sup>7</sup> 与 d<sub>k</sub> = 64</p>' },
    ]);
    expect(texts[0]).toContain('10^7 与');
    expect(texts[0]).toContain('dx = 64');
  });

  test('含行内 code 的中文散文不进代码沙箱（CJK 守卫）', () => {
    const { codeBlocks, texts } = extractVerifiables([
      {
        type: 'text',
        content:
          '<p>注意力权重经过 <code style="font-family: Consolas">softmax</code> 归一化，这是一段讲解性中文散文，不是代码块。</p>',
      },
    ]);
    expect(codeBlocks).toHaveLength(0);
    expect(texts).toHaveLength(1);
  });
});

describe('hasVerifiableContent', () => {
  test('有代码块 → 可验', () => {
    expect(hasVerifiableContent(['print(1)'], [])).toBe(true);
  });

  test('文本含带运算的数值等式 → 可验', () => {
    expect(hasVerifiableContent([], ['权重 2.7183 / 3.7183 ≈ 0.731'])).toBe(true);
  });

  test('纯叙述文本 → 不可验，不空跑桥', () => {
    expect(hasVerifiableContent([], ['注意力机制让模型聚焦关键信息，共 17 题'])).toBe(false);
  });
});
