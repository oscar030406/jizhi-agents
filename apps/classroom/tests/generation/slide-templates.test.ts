import { describe, expect, test } from 'vitest';

import {
  expandSlideTemplate,
  SLIDE_TEMPLATE_IDS,
  type SlideSlotSpec,
} from '@/lib/generation/slide-templates';

// 展开器的两条铁律：①任何输入都不越过画布边界；②装不下走降字号/截断，不溢出。

const CANVAS_H = 562.5;
const CANVAS_W = 1000;

interface Box {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  type?: string;
}

function boxes(spec: SlideSlotSpec): Box[] {
  const out = expandSlideTemplate(spec);
  expect(out).not.toBeNull();
  return out!.elements as Box[];
}

function assertInCanvas(els: Box[]) {
  for (const el of els) {
    if (typeof el.top !== 'number' || typeof el.height !== 'number') continue;
    expect(el.top + el.height, `${el.type} bottom overflow`).toBeLessThanOrEqual(CANVAS_H);
    if (typeof el.left === 'number' && typeof el.width === 'number' && el.type !== 'line') {
      expect(el.left + el.width, `${el.type} right overflow`).toBeLessThanOrEqual(CANVAS_W);
    }
  }
}

describe('expandSlideTemplate', () => {
  test('全模板：常规输入都在画布内', () => {
    const specs: SlideSlotSpec[] = [
      {
        template: 'title-bullets',
        slots: { title: '注意力机制', lead: '一句解释', bullets: ['要点一', '要点二', '要点三'] },
      },
      {
        template: 'two-column',
        slots: {
          title: '两个面向',
          leftTitle: '编码',
          leftBullets: ['a', 'b'],
          rightTitle: '解码',
          rightBullets: ['c', 'd'],
        },
      },
      {
        template: 'compare-table',
        slots: { title: '对比', headers: ['维度', 'A', 'B'], rows: [['速度', '快', '慢']] },
      },
      {
        template: 'flow-steps',
        slots: { title: '流程', steps: [{ label: '检索', desc: '找相关块' }, { label: '生成' }] },
      },
      {
        template: 'worked-example',
        slots: { title: '例题', problem: '算 softmax', steps: ['代入', '归一化'], takeaway: '大分差压小概率' },
      },
      { template: 'excerpt', slots: { title: '教材原文', intro: '读这段注意因果', excerptId: 'hl07#s1' } },
      {
        template: 'code',
        slots: { title: '最小实现', code: 'import torch\nx = torch.rand(2)', points: ['两行就能跑'] },
      },
      { template: 'formula', slots: { title: '缩放点积', latex: '\\frac{QK^T}{\\sqrt{d_k}}', whyPoints: ['防饱和'] } },
    ];
    expect(new Set(specs.map((s) => s.template))).toEqual(new Set(SLIDE_TEMPLATE_IDS));
    for (const spec of specs) assertInCanvas(boxes(spec));
  });

  test('超量要点：截断而不溢出，末条带省略标记', () => {
    const els = boxes({
      template: 'title-bullets',
      slots: { title: '塞爆测试', bullets: Array.from({ length: 30 }, (_, i) => `第${i}条要点内容比较长一些一些一些`) },
    });
    assertInCanvas(els);
    const all = els.map((e) => String((e as Record<string, unknown>).content ?? '')).join('');
    expect(all).toContain('其余');
  });

  test('超长代码：按行截断，画布内', () => {
    const els = boxes({
      template: 'code',
      slots: {
        title: '长代码',
        code: Array.from({ length: 60 }, (_, i) => `line_${i} = ${i}`).join('\n'),
        points: ['注解'],
      },
    });
    assertInCanvas(els);
  });

  test('excerpt 模板：占位符文本框高度 ≥240（注入预算可容 ~300 字）', () => {
    const els = boxes({
      template: 'excerpt',
      slots: { title: 'T', intro: 'I', excerptId: 'x#1' },
    });
    const holder = els.find((e) =>
      String((e as Record<string, unknown>).content ?? '').includes('摘录:x#1'),
    );
    expect(holder).toBeDefined();
    expect(holder!.height!).toBeGreaterThanOrEqual(240);
    assertInCanvas(els);
  });

  test('未知模板返回 null（调用方回退自由版面）', () => {
    expect(expandSlideTemplate({ template: 'nope', slots: {} })).toBeNull();
  });

  test('槽位内 HTML 被转义', () => {
    const els = boxes({
      template: 'title-bullets',
      slots: { title: '<img src=x>', bullets: ['<b>粗</b>'] },
    });
    const all = els.map((e) => String((e as Record<string, unknown>).content ?? '')).join('');
    expect(all).not.toContain('<img');
    expect(all).not.toContain('<b>');
  });
});
