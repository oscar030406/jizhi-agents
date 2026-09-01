import { describe, expect, it } from 'vitest';

import {
  parseTemplateSelection,
  validateTemplateParams,
  buildTemplateCatalogText,
  WIDGET_TEMPLATES,
} from '@/lib/generation/widget-templates';
import {
  generateSceneContent,
  generateSceneActions,
} from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { GeneratedInteractiveContent, SceneOutline } from '@/lib/types/generation';

const VALID_SAMPLER_SELECTION = {
  templateId: 'temperature_sampler',
  name: '温度采样器',
  guide: '先把温度拉低再拉高，对比采样结果。',
  params: {
    context: '今天天气真',
    candidates: [
      { token: '不错', logit: 3.2 },
      { token: '冷', logit: 1.5 },
    ],
  },
};

function interactiveOutline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-template',
    type: 'interactive',
    title: '温度与采样',
    description: '理解温度如何改变下一个词的概率分布。',
    keyPoints: ['softmax 与温度', '低温保守高温发散'],
    order: 0,
    widgetType: 'simulation',
    widgetOutline: { concept: '温度采样' },
    ...overrides,
  };
}

describe('validateTemplateParams', () => {
  it('accepts valid attention params and applies name fallback', () => {
    const result = validateTemplateParams('attention_playground', {
      tokens: ['我', '去', '银行'],
      scores: [
        [2, 0.5, 0.3],
        [0.5, 2, 0.8],
        [0.3, 0.8, 2],
      ],
      focusDefault: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.templateId).toBe('attention_playground');
      // LLM 未起名时兜底到模板默认名
      expect(result.config.name).toBe('注意力权重热区');
    }
  });

  it('rejects a non-square attention score matrix', () => {
    const result = validateTemplateParams('attention_playground', {
      tokens: ['a', 'b', 'c'],
      scores: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('square matrix');
  });

  it('rejects bpe steps/captions length mismatch', () => {
    const result = validateTemplateParams('bpe_merge_stepper', {
      steps: [
        ['l', 'o', 'w'],
        ['lo', 'w'],
      ],
      captions: ['只有一条说明', '第二条', '多出来的第三条'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('captions length');
  });

  it('rejects unknown templateId with the id list in the error', () => {
    const result = validateTemplateParams('quantum_visualizer', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('temperature_sampler');
  });

  it('rejects sampler candidates missing logit', () => {
    const result = validateTemplateParams('temperature_sampler', {
      context: '今天天气真',
      candidates: [{ token: '不错' }, { token: '冷' }],
    });
    expect(result.ok).toBe(false);
  });
});

// 通用模板：LLM 出参数的自由度越大越容易出错，这里守的是每一条跨字段约束。
const CURVE_OK = {
  curve: 'quadratic',
  coefficients: { a: 1, b: 0, c: 0 },
  sliders: [{ key: 'a', label: '开口系数', min: 0.2, max: 3, step: 0.1 }],
  xAxis: { label: 'x', min: -3, max: 3 },
  yAxis: { label: 'L(x)' },
  observations: ['把 a 拉大看谷底变陡', '把 a 拉小看曲线变平'],
};

describe('validateTemplateParams — parameter_curve', () => {
  it('accepts a well-formed curve', () => {
    expect(validateTemplateParams('parameter_curve', CURVE_OK).ok).toBe(true);
  });

  it('rejects an unknown curve family (no free-form formulas)', () => {
    const r = validateTemplateParams('parameter_curve', { ...CURVE_OK, curve: 'Math.sin(x)*2' });
    expect(r.ok).toBe(false);
  });

  it('rejects a coefficient sitting outside its own slider range', () => {
    const r = validateTemplateParams('parameter_curve', {
      ...CURVE_OK,
      coefficients: { a: 9, b: 0, c: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('slider range');
  });

  it('rejects log/power curves whose x range reaches 0 (would render NaN)', () => {
    for (const curve of ['logarithmic', 'power']) {
      const r = validateTemplateParams('parameter_curve', {
        ...CURVE_OK,
        curve,
        xAxis: { label: 'x', min: 0, max: 10 },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('greater than 0');
    }
  });

  it('rejects an inverted x range', () => {
    const r = validateTemplateParams('parameter_curve', {
      ...CURVE_OK,
      xAxis: { label: 'x', min: 5, max: 5 },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects two sliders bound to the same coefficient', () => {
    const r = validateTemplateParams('parameter_curve', {
      ...CURVE_OK,
      sliders: [
        { key: 'a', label: '一', min: 0, max: 3, step: 0.1 },
        { key: 'a', label: '二', min: 0, max: 3, step: 0.1 },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('same coefficient');
  });

  it('rejects more than 2 sliders (self-imposed freedom cap)', () => {
    const r = validateTemplateParams('parameter_curve', {
      ...CURVE_OK,
      sliders: ['a', 'b', 'c'].map((key) => ({ key, label: key, min: 0, max: 3, step: 0.1 })),
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateTemplateParams — process_stepper', () => {
  const steps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ title: `步骤${i}`, detail: `第 ${i} 步做的事` }));

  it('accepts 3-8 steps and an optional carries field', () => {
    const r = validateTemplateParams('process_stepper', {
      steps: [{ title: '提问', detail: '拿到用户问题', carries: '原始问题' }, ...steps(2)],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects fewer than 3 steps (that is a bullet list, not a process)', () => {
    expect(validateTemplateParams('process_stepper', { steps: steps(2) }).ok).toBe(false);
  });

  it('rejects more than 8 steps', () => {
    expect(validateTemplateParams('process_stepper', { steps: steps(9) }).ok).toBe(false);
  });

  it('rejects a step with an empty detail', () => {
    const r = validateTemplateParams('process_stepper', {
      steps: [...steps(2), { title: '收尾', detail: '' }],
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateTemplateParams — tradeoff_matrix', () => {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `格${i}`, rating: 3 }));

  it('accepts a matrix whose every row matches the dimension count', () => {
    const r = validateTemplateParams('tradeoff_matrix', {
      dimensions: ['快', '省'],
      options: [
        { name: 'A', cells: cells(2) },
        {
          name: 'B',
          cells: [
            { text: '更快', rating: 4 },
            { text: '更贵', rating: 2 },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a row whose cell count does not match the dimensions', () => {
    const r = validateTemplateParams('tradeoff_matrix', {
      dimensions: ['快', '省', '稳'],
      options: [
        { name: 'A', cells: cells(3) },
        { name: '缺一格的方案', cells: cells(2) },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('缺一格的方案');
  });

  it('rejects a rating outside 1-5 or non-integer', () => {
    for (const rating of [0, 6, 3.5]) {
      const r = validateTemplateParams('tradeoff_matrix', {
        dimensions: ['快', '省'],
        options: [
          { name: 'A', cells: [{ text: 'x', rating }, { text: 'y', rating: 3 }] },
          { name: 'B', cells: cells(2) },
        ],
      });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a single option (nothing to trade off against)', () => {
    const r = validateTemplateParams('tradeoff_matrix', {
      dimensions: ['快', '省'],
      options: [{ name: 'A', cells: cells(2) }],
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateTemplateParams — layered_graph', () => {
  const graph = (over: Record<string, unknown> = {}) => ({
    layers: [
      { title: '上游', nodes: [{ id: 'a', label: '入口', note: '接收请求。' }] },
      { title: '下游', nodes: [{ id: 'b', label: '出口', note: '返回结果。' }] },
    ],
    edges: [{ from: 'a', to: 'b' }],
    ...over,
  });

  it('accepts a two-layer graph whose edges cross layers', () => {
    expect(validateTemplateParams('layered_graph', graph()).ok).toBe(true);
  });

  it('rejects an edge pointing at a node id that was never declared', () => {
    const r = validateTemplateParams('layered_graph', graph({ edges: [{ from: 'a', to: 'ghost' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ghost');
  });

  it('rejects two nodes sharing an id — edges would resolve at random', () => {
    const r = validateTemplateParams(
      'layered_graph',
      graph({
        layers: [
          { title: '上游', nodes: [{ id: 'a', label: '入口' }] },
          { title: '下游', nodes: [{ id: 'a', label: '出口' }] },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('duplicate node id');
  });

  it('rejects an edge joining two nodes inside the same layer', () => {
    const r = validateTemplateParams(
      'layered_graph',
      graph({
        layers: [
          {
            title: '同层',
            nodes: [
              { id: 'a', label: '甲' },
              { id: 'b', label: '乙' },
            ],
          },
          { title: '下游', nodes: [{ id: 'c', label: '丙' }] },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('same layer');
  });

  it('accepts a backward edge — feedback loops are the point of this template', () => {
    expect(validateTemplateParams('layered_graph', graph({ edges: [{ from: 'b', to: 'a', label: '重试' }] })).ok).toBe(true);
  });

  it('rejects a single layer and more than four layers', () => {
    const layer = (i: number) => ({ title: `L${i}`, nodes: [{ id: `n${i}`, label: `节点${i}` }] });
    expect(validateTemplateParams('layered_graph', graph({ layers: [layer(0)] })).ok).toBe(false);
    expect(
      validateTemplateParams('layered_graph', {
        layers: [0, 1, 2, 3, 4].map(layer),
        edges: [{ from: 'n0', to: 'n1' }],
      }).ok,
    ).toBe(false);
  });

  it('rejects a label too long to fit its box', () => {
    const r = validateTemplateParams(
      'layered_graph',
      graph({
        layers: [
          { title: '上游', nodes: [{ id: 'a', label: '这个标签明显超过了八个字' }] },
          { title: '下游', nodes: [{ id: 'b', label: '出口' }] },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a graph past the 12-node ceiling', () => {
    // 每层最多 4 个是 zod 管的；这里要打的是「层数合法、每层也合法，但加起来太多」
    const full = (count: number) =>
      Array.from({ length: count }, (_, li) => ({
        title: `L${li}`,
        nodes: [0, 1, 2, 3].map((ni) => ({
          id: `n${li}${ni}`,
          label: `节点${ni}`,
          note: `第 ${li} 层第 ${ni} 个节点。`,
        })),
      }));
    const edges = [{ from: 'n00', to: 'n10' }];

    expect(validateTemplateParams('layered_graph', { layers: full(3), edges }).ok).toBe(true); // 12 压线
    const r = validateTemplateParams('layered_graph', { layers: full(4), edges }); // 16 超顶
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('12 nodes or fewer');
  });
});

describe('validateTemplateParams — teaching red lines', () => {
  const cases: Array<{ name: string; code: string; templateId: string; params: unknown }> = [
    {
      name: 'B1 复读步骤',
      code: 'B1',
      templateId: 'process_stepper',
      params: {
        steps: Array.from({ length: 3 }, () => ({
          title: '训练',
          detail: '训练模型并优化参数。',
          carries: '模型',
        })),
      },
    },
    {
      name: 'B2 死滑块',
      code: 'B2',
      templateId: 'parameter_curve',
      params: {
        curve: 'logarithmic',
        coefficients: { a: 2, b: 1, c: 5 },
        sliders: [{ key: 'c', label: '无效系数', min: 0, max: 10, step: 1 }],
        xAxis: { label: 'x', min: 1, max: 10 },
        yAxis: { label: 'y' },
        observations: ['拖动系数观察曲线。', '比较变化。'],
      },
    },
    {
      name: 'B3 空详情',
      code: 'B3',
      templateId: 'layered_graph',
      params: {
        layers: [
          { title: '上游', nodes: [{ id: 'a', label: '入口' }] },
          { title: '下游', nodes: [{ id: 'b', label: '出口' }] },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    },
    {
      name: 'B4 空首屏',
      code: 'B4',
      templateId: 'parameter_curve',
      params: {
        curve: 'exponential',
        coefficients: { a: 1, b: 100, c: 0 },
        sliders: [{ key: 'b', label: '增长指数', min: 1, max: 100, step: 1 }],
        xAxis: { label: 'x', min: 1, max: 10 },
        yAxis: { label: 'y' },
        observations: ['观察指数增长。', '比较曲线变化。'],
      },
    },
  ];

  it.each(cases)('rejects $name', ({ code, templateId, params }) => {
    const result = validateTemplateParams(templateId, params);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`[${code}]`);
  });
});

describe('parseTemplateSelection', () => {
  it('parses a valid selection, including one wrapped in a code fence', () => {
    for (const response of [
      JSON.stringify(VALID_SAMPLER_SELECTION),
      '```json\n' + JSON.stringify(VALID_SAMPLER_SELECTION) + '\n```',
    ]) {
      const result = parseTemplateSelection(response);
      expect(result.status).toBe('selected');
      if (result.status === 'selected') {
        expect(result.config).toMatchObject({
          type: 'template',
          templateId: 'temperature_sampler',
          name: '温度采样器',
        });
      }
    }
  });

  it('returns none when templateId is null', () => {
    const result = parseTemplateSelection(
      JSON.stringify({ templateId: null, reason: '主题是历史事件，无匹配模板' }),
    );
    expect(result).toEqual({ status: 'none', reason: '主题是历史事件，无匹配模板' });
  });

  it('returns invalid for markdown-only responses (the old failure mode)', () => {
    const result = parseTemplateSelection('# 温度采样教具设计\n\n本教具将展示……');
    expect(result.status).toBe('invalid');
  });

  it('returns invalid when params fail validation', () => {
    const result = parseTemplateSelection(
      JSON.stringify({
        templateId: 'rag_retrieval_playground',
        params: { chunks: [], suggestedQueries: [] },
      }),
    );
    expect(result.status).toBe('invalid');
  });
});

describe('buildTemplateCatalogText', () => {
  it('lists every template id for the prompt', () => {
    const text = buildTemplateCatalogText();
    // 从注册表推，不手抄一份 id 清单——手抄的那份加了新模板就会悄悄过期
    for (const t of WIDGET_TEMPLATES) {
      expect(text).toContain(t.id);
    }
  });

  // sample 一身三用：提示词里的 Example、断网降级形态、渲染测试的输入。
  // 它要是不合法，等于把一份非法示例天天喂给模型。
  it('every template sample passes its own validator', () => {
    for (const t of WIDGET_TEMPLATES) {
      const r = validateTemplateParams(t.id, t.sample);
      expect(r.ok, `${t.id} sample rejected: ${r.ok ? '' : r.error}`).toBe(true);
    }
  });
});

describe('generateSceneContent — interactive template flow', () => {
  it('returns template content with empty html on a valid selection', async () => {
    const capturedUsers: string[] = [];
    const aiCall: AICallFn = async (system, user) => {
      capturedUsers.push(user);
      expect(system).toContain('Template Pool');
      return JSON.stringify(VALID_SAMPLER_SELECTION);
    };

    const content = (await generateSceneContent(interactiveOutline(), aiCall, {
      languageDirective: '用中文授课。',
    })) as GeneratedInteractiveContent | null;

    expect(capturedUsers).toHaveLength(1);
    expect(capturedUsers[0]).toContain('温度与采样');
    expect(content).toMatchObject({
      html: '',
      widgetType: 'template',
      widgetConfig: { type: 'template', templateId: 'temperature_sampler' },
    });
  });

  it('retries once with the validation error, then succeeds', async () => {
    const capturedUsers: string[] = [];
    const aiCall: AICallFn = async (_system, user) => {
      capturedUsers.push(user);
      return capturedUsers.length === 1
        ? '# 这是一份 markdown 设计稿'
        : JSON.stringify(VALID_SAMPLER_SELECTION);
    };

    const content = (await generateSceneContent(interactiveOutline(), aiCall, {})) as
      | GeneratedInteractiveContent
      | null;

    expect(capturedUsers).toHaveLength(2);
    // 第二次请求带上被拒原因
    expect(capturedUsers[1]).toContain('Previous Attempt Rejected');
    expect(content?.widgetType).toBe('template');
  });

  // 下面两条原本断言 `toBeNull()`，而测试名写的是「degrade to lecture」——
  // 名字、代码注释、widget-templates.ts 的文档三处都说会降级成讲义，
  // 实现却返回 null、上游重试 6 次后整屏丢弃。**连测试都在替这个谎言背书。**
  // 三层轮落地后改成锁真降级：模板池 → 上游自由 HTML → 讲义。

  /** 讲义那层要的是 markdown 正文，不是 JSON。够长才过 `cleanLectureMarkdown`。 */
  const LECTURE_MD = [
    '## 这一节讲什么',
    '',
    '注意力机制的核心是让模型在处理每个位置时，能够回看序列里的其他位置。',
    '传统的循环网络只能顺序传递信息，越远的依赖越容易衰减；注意力直接算两两之间的相关度，',
    '距离不再是障碍。',
    '',
    '## 为什么这样设计',
    '',
    '把查询、键、值三个角色分开，是为了让「我要找什么」和「我能提供什么」解耦。',
    '同一份表示既当键又当值时，模型没有办法表达「这个位置对定位有用，但内容要取别处」。',
  ].join('\n');

  it('模板池两次都解析不了时，降级链真的走到讲义并出内容', async () => {
    // 原来这条叫「returns null after two invalid attempts (degrade to lecture)」，
    // 名字写降级、断言却是 `toBeNull()`——**测试在替谎言背书**：
    // 代码注释、模块文档、测试名四处都说会降级成讲义，实现返回 null、
    // 上游重试 6 次整屏丢弃。有测试守着，后来人更不会怀疑。
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      // 前两次是模板池（选模板 + 带错误重试一次），喂垃圾让它选不出；
      // 之后的调用属于二层/三层，喂合法讲义 markdown。
      return calls <= 2 ? '不是 JSON 的回复' : LECTURE_MD;
    };

    const content = await generateSceneContent(interactiveOutline(), aiCall, {});
    expect(calls).toBeGreaterThan(2);
    expect(content).not.toBeNull();
    // 降到讲义之后就不该还是教具形态。联合类型里只有 interactive 分支有
    // widgetType，用 in 收窄——直接点属性 tsc 不认。
    expect(content && 'widgetType' in content ? content.widgetType : undefined).not.toBe(
      'template',
    );
  });

  it('模型明说没有合适模板时不重试，但继续往下降级', async () => {
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return calls === 1
        ? JSON.stringify({ templateId: null, reason: '无匹配模板' })
        : LECTURE_MD;
    };

    const content = await generateSceneContent(interactiveOutline(), aiCall, {});
    // 明说选不出就别浪费第二次调用——模板池这层只调一次
    expect(calls).toBeGreaterThan(1);
    expect(content).not.toBeNull();
  });

  it('三层全失败时返回 null——做不出来就是做不出来', async () => {
    // 这条守住另一头：降级链存在不等于永远有产物。
    // 全链都喂垃圾时返回 null 是诚实的，外层重试与「跳过这一屏」照旧。
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return '不是 JSON 的回复';
    };
    expect(await generateSceneContent(interactiveOutline(), aiCall, {})).toBeNull();
    expect(calls).toBeGreaterThan(2);
  });
});

describe('generateSceneActions — template widget short-circuit', () => {
  it('emits a guide speech action without calling the LLM', async () => {
    const aiCall: AICallFn = async () => {
      throw new Error('template widget actions should not call the LLM');
    };
    const content: GeneratedInteractiveContent = {
      html: '',
      widgetType: 'template',
      widgetConfig: {
        type: 'template',
        templateId: 'temperature_sampler',
        name: '温度采样器',
        guide: '先拉低温度采样，再拉高对比。',
        params: VALID_SAMPLER_SELECTION.params,
      },
    };

    const actions = await generateSceneActions(interactiveOutline(), content, aiCall, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'speech' });
    expect((actions[0] as { text?: string }).text).toContain('先拉低温度采样');
  });
});
