import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  extractContentVerifiables,
  extractVerifiables,
  hasVerifiableContent,
  verificationHasFailures,
  verifyContent,
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

  test('无等号的 softmax 数值微例仍会送验', () => {
    expect(hasVerifiableContent([], ['分数 [1.0, 0.1]，softmax 后约为 [0.71, 0.29]'])).toBe(true);
  });
});

describe('extractContentVerifiables', () => {
  test('从学习者最终读取的 slide canvas 抽取，而不只认生成中间态', () => {
    const result = extractContentVerifiables({
      type: 'slide',
      canvas: { elements: [{ type: 'text', content: '<p>2 + 2 = 4</p>' }] },
    });
    expect(result.texts).toEqual(['2 + 2 = 4']);
  });

  test('覆盖 slide 的原生代码、形状、表格与公式元素', () => {
    const result = extractContentVerifiables({
      type: 'slide',
      canvas: {
        elements: [
          { type: 'code', lines: [{ content: 'print(2 + 2)' }] },
          { type: 'shape', text: { content: '<p>3 * 3 = 9</p>' } },
          { type: 'table', data: [[{ text: '8 / 2 = 4' }]] },
          { type: 'latex', latex: 'sqrt(64) = 8' },
        ],
      },
    });

    expect(result.codeBlocks).toContain('print(2 + 2)');
    expect(result.texts).toEqual(
      expect.arrayContaining(['3 * 3 = 9', '8 / 2 = 4', 'sqrt(64) = 8']),
    );
  });

  test('覆盖 quiz 题干、选项、解析及其中的 fenced code', () => {
    const result = extractContentVerifiables({
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: '2 + 3 = 5 对吗？',
          options: [{ label: '因为 2 + 3 = 5', value: 'A' }],
          analysis: '运行验证：\n```python\nprint(2 + 3)\n```',
        },
      ],
    });

    expect(result.codeBlocks).toContain('print(2 + 3)');
    expect(result.texts.join('\n')).toContain('2 + 3 = 5');
  });

  test('覆盖 interactive 可见正文、脚本与 code widget 配置', () => {
    const result = extractContentVerifiables({
      type: 'interactive',
      url: '',
      html: [
        '<p>6 / 2 = 3</p>',
        '<pre><code class="language-python">print(6 / 2)</code></pre>',
        '<script>const answer = 6 / 2;</script>',
      ].join(''),
      widgetType: 'code',
      widgetConfig: {
        type: 'code',
        language: 'python',
        description: '补全后应满足 10 - 4 = 6',
        starterCode: 'print(10 - 4)',
        solution: 'print(6)',
        testCases: [],
        hints: [],
      },
    });

    expect(result.codeBlocks).toEqual(
      expect.arrayContaining([
        'print(6 / 2)',
        'const answer = 6 / 2;',
        'print(10 - 4)',
        'print(6)',
      ]),
    );
    expect(result.texts.join('\n')).toContain('6 / 2 = 3');
    expect(result.texts.join('\n')).toContain('10 - 4 = 6');
  });

  test('覆盖 PBL 深层任务文本与 fenced code', () => {
    const result = extractContentVerifiables({
      type: 'pbl',
      projectConfig: {
        projectInfo: { title: '验算项目', description: '预算 12 / 3 = 4 万元。' },
        agents: [
          {
            name: '导师',
            system_prompt: '核对：\n```python\nassert 12 / 3 == 4\n```',
          },
        ],
      },
      projectV2: {
        milestones: [{ title: '迁移检验', description: '样本 5 * 5 = 25 个。' }],
      },
    });

    expect(result.codeBlocks).toContain('assert 12 / 3 == 4');
    expect(result.texts.join('\n')).toContain('12 / 3 = 4');
    expect(result.texts.join('\n')).toContain('5 * 5 = 25');
  });

  test('纯自然语言仍可抽取，但不会成为可执行候选', () => {
    const result = extractContentVerifiables({
      type: 'quiz',
      questions: [{ question: '请解释注意力机制为何有助于聚焦上下文。' }],
    });

    expect(result.texts).toEqual(['请解释注意力机制为何有助于聚焦上下文。']);
    expect(hasVerifiableContent(result.codeBlocks, result.texts)).toBe(false);
  });
});

describe('verificationHasFailures', () => {
  const clean = {
    codePassed: 1,
    codeFailed: 0,
    codeUnverifiable: 0,
    arithmeticChecked: 1,
    arithmeticPassed: 1,
    arithmeticUnverifiable: 0,
    failures: [],
    warnings: [],
  };

  test('只把机械复核出的确定错误判为失败', () => {
    expect(verificationHasFailures({ ...clean, codeFailed: 1 })).toBe(true);
    expect(verificationHasFailures({ ...clean, arithmeticPassed: 0 })).toBe(true);
    expect(verificationHasFailures({ ...clean, failures: ['数值不一致'] })).toBe(true);
  });

  test('不可验证项保留未知状态，但不冒充确定错误阻断课程', () => {
    expect(verificationHasFailures({ ...clean, codeUnverifiable: 1 })).toBe(false);
    expect(verificationHasFailures({ ...clean, arithmeticUnverifiable: 1 })).toBe(false);
    expect(verificationHasFailures({ ...clean, warnings: ['未能安全验算'] })).toBe(false);
  });

  test('全部候选通过或根本没有候选时不误伤', () => {
    expect(verificationHasFailures(clean)).toBe(false);
    expect(
      verificationHasFailures({
        ...clean,
        codePassed: 0,
        arithmeticChecked: 0,
        arithmeticPassed: 0,
      }),
    ).toBe(false);
  });
});

describe('verifyContent bridge metadata', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test('不可安全执行的代码与数值表达式作为 warning 透传，不冒充通过', async () => {
    vi.stubEnv('GROUNDING_URL', 'http://engine.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                code_passed: 0,
                code_failed: 0,
                code_unverifiable: 1,
                code: [{ verdict: 'unverifiable', detail: '安全策略拦截危险调用' }],
                arithmetic: {
                  checked: 0,
                  passed: 0,
                  failures: [],
                  unverifiable: 1,
                  warnings: ['表达式无法安全解析，未判为通过'],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const result = await verifyContent(['open("secret")'], ['x = unknown']);
    expect(result).toMatchObject({
      codePassed: 0,
      codeFailed: 0,
      codeUnverifiable: 1,
      arithmeticUnverifiable: 1,
    });
    expect(result?.warnings).toEqual([
      '代码：安全策略拦截危险调用',
      '数值：表达式无法安全解析，未判为通过',
    ]);
  });
});
