// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import TemplateWidgetHost from '@/components/widgets/TemplateWidgetHost';
import { evalCurve } from '@/components/widgets/ParameterCurve';
import { WIDGET_TEMPLATES, validateTemplateParams } from '@/lib/generation/widget-templates';
import type { TemplateWidgetConfig, WidgetTemplateId } from '@/lib/types/widgets';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 每个模板的默认参数样例走一遍真校验器再进组件——测的是「生成端出的参数
 * 渲染端一定吃得下」这条契约，而不是一份手写的、和线上不同形状的 fixture。 */
function configFor(id: WidgetTemplateId): TemplateWidgetConfig {
  const meta = WIDGET_TEMPLATES.find((t) => t.id === id);
  if (!meta) throw new Error(`no template ${id}`);
  const result = validateTemplateParams(id, meta.sample);
  if (!result.ok) throw new Error(`${id} sample invalid: ${result.error}`);
  return result.config;
}

function mount(config: TemplateWidgetConfig) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<TemplateWidgetHost config={config} />);
  });
  return {
    host,
    /** 派事件而不是调 .click()：SVG 元素在 jsdom 里没有 HTMLElement.click */
    click(el: Element | null | undefined) {
      if (!el) throw new Error('element not found');
      act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    },
    /** range input 要绕 React 的 value tracker，否则 onChange 不触发 */
    drag(el: Element | null | undefined, value: number) {
      if (!el) throw new Error('slider not found');
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      act(() => {
        setter?.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const buttonsByText = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');

describe('evalCurve', () => {
  const k = { a: 2, b: 3, c: 1 };
  it('computes each family from its documented formula', () => {
    expect(evalCurve('linear', k, 4)).toBeCloseTo(11); // 2*4+3
    expect(evalCurve('quadratic', k, 2)).toBeCloseTo(15); // 2*4+3*2+1
    expect(evalCurve('power', k, 2)).toBeCloseTo(17); // 2*2^3+1
    expect(evalCurve('exponential', { a: 1, b: 1, c: 0 }, 0)).toBeCloseTo(1);
    expect(evalCurve('logarithmic', k, 1)).toBeCloseTo(3); // 2*ln(1)+3
    expect(evalCurve('logistic', { a: 1, b: 1, c: 0 }, 0)).toBeCloseTo(0.5);
  });

  it('is monotone for logistic — the saturation story the widget tells', () => {
    const p = { a: 1, b: 1, c: 0 };
    expect(evalCurve('logistic', p, -5)).toBeLessThan(evalCurve('logistic', p, 0));
    expect(evalCurve('logistic', p, 0)).toBeLessThan(evalCurve('logistic', p, 5));
  });
});

describe('ParameterCurve', () => {
  it('draws a finite polyline and reacts to the coefficient slider', () => {
    const w = mount(configFor('parameter_curve'));

    const polyline = w.host.querySelector('polyline');
    expect(polyline).not.toBeNull();
    const coords = (polyline!.getAttribute('points') ?? '').split(' ');
    expect(coords.length).toBeGreaterThan(2);
    // NaN 混进 points 会让整条曲线消失，是这个模板最现实的失效方式
    for (const pair of coords) {
      const [x, y] = pair.split(',').map(Number);
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }

    // sample 里 a 初值为 1，公式行应先显示 1
    expect(w.host.textContent).toContain('y = 1·x²');
    const sliders = w.host.querySelectorAll('input[type="range"]');
    w.drag(sliders[0], 2.5);
    expect(w.host.textContent).toContain('y = 2.50·x²');

    w.unmount();
  });

  it('shows the tangent and its slope when showTangent is on', () => {
    const w = mount(configFor('parameter_curve'));
    // y = x²，切点拖到 x=1，斜率应当是 2
    const sliders = w.host.querySelectorAll('input[type="range"]');
    w.drag(sliders[sliders.length - 1], 1);
    expect(w.host.querySelector('circle')).not.toBeNull();
    expect(w.host.textContent).toContain('斜率 2.000');
    w.unmount();
  });

  it('survives a curve whose values overflow to Infinity', () => {
    // 生成门禁会拒绝这种空首屏；这里绕过门禁，只验证旧数据不会把渲染器炸白。
    const config = configFor('parameter_curve') as Extract<
      TemplateWidgetConfig,
      { templateId: 'parameter_curve' }
    >;
    const w = mount({
      ...config,
      params: {
        curve: 'exponential',
        coefficients: { a: 1, b: 700, c: 0 },
        sliders: [{ key: 'b', label: '增长率', min: 1, max: 900, step: 1 }],
        xAxis: { label: 'x', min: 1, max: 5 },
        yAxis: { label: 'y' },
        observations: ['指数会爆', '爆了也不该白屏'],
      },
    });
    // e^3500 = Infinity，全部采样点被丢弃 → 不画线，但坐标轴与说明照常在
    expect(w.host.textContent).toContain('指数会爆');
    w.unmount();
  });
});

describe('ProcessStepper', () => {
  it('walks stages forward and back, showing what each hands on', () => {
    const w = mount(configFor('process_stepper'));

    expect(w.host.textContent).toContain('第 1/4 步：提问');
    expect(w.host.textContent).toContain('交给下一步：原始问题文本');
    const prev = () => Array.from(w.host.querySelectorAll('button')).find((b) => b.textContent?.includes('上一步'));
    const next = () => Array.from(w.host.querySelectorAll('button')).find((b) => b.textContent?.includes('下一步 →'));

    expect(prev()!.disabled).toBe(true);
    w.click(next());
    expect(w.host.textContent).toContain('第 2/4 步：检索');
    expect(prev()!.disabled).toBe(false);

    w.click(next());
    w.click(next());
    expect(w.host.textContent).toContain('第 4/4 步：生成');
    expect(next()!.disabled).toBe(true);
    // 最后一步没有 carries，不该渲染一条空的传递行
    expect(w.host.textContent).not.toContain('交给下一步： ');

    w.click(Array.from(w.host.querySelectorAll('button')).find((b) => b.textContent?.includes('回到第 1 步')));
    expect(w.host.textContent).toContain('第 1/4 步：提问');
    w.unmount();
  });

  it('jumps to a stage when its chip is clicked', () => {
    const w = mount(configFor('process_stepper'));
    w.click(Array.from(w.host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('3.')));
    expect(w.host.textContent).toContain('第 3/4 步：拼装');
    w.unmount();
  });
});

describe('TradeoffMatrix', () => {
  const rowOrder = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('tbody tr td:first-child')).map((td) => td.textContent);

  it('re-ranks options when a dimension is switched off', () => {
    const w = mount(configFor('tradeoff_matrix'));

    // 三维全选：小模型+检索 (5+5+3)/3 领先
    expect(rowOrder(w.host)[0]).toBe('小模型 + 检索');

    // 只在意「可定制」时，自部署应当翻上来
    const dim = (label: string) =>
      Array.from(w.host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    w.click(dim('响应速度'));
    w.click(dim('成本可控'));
    expect(rowOrder(w.host)[0]).toBe('自部署开源模型');

    w.unmount();
  });

  it('stops ranking when no dimension is selected instead of showing a fake winner', () => {
    const w = mount(configFor('tradeoff_matrix'));
    const dim = (label: string) =>
      Array.from(w.host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    for (const label of ['响应速度', '成本可控', '可定制']) w.click(dim(label));

    expect(rowOrder(w.host)).toEqual(['调用闭源 API', '自部署开源模型', '小模型 + 检索']);
    expect(w.host.textContent).toContain('没有偏好就没有最优解');
    expect(w.host.querySelectorAll('tbody tr.bg-green-soft\\/60')).toHaveLength(0);
    w.unmount();
  });
});

describe('LayeredGraph', () => {
  const nodeByLabel = (host: HTMLElement, label: string) =>
    Array.from(host.querySelectorAll('g[role="button"]')).find(
      (g) => g.getAttribute('aria-label') === label,
    );

  it('lays out every node and edge without any coordinate from the params', () => {
    const w = mount(configFor('layered_graph'));
    // sample: 6 个节点 8 条边，坐标全部由组件算出来
    expect(w.host.querySelectorAll('g[role="button"]')).toHaveLength(6);
    expect(w.host.querySelectorAll('path')).toHaveLength(8);
    for (const rect of Array.from(w.host.querySelectorAll('rect'))) {
      for (const attr of ['x', 'y', 'width', 'height']) {
        expect(Number.isFinite(Number(rect.getAttribute(attr)))).toBe(true);
      }
    }
    w.unmount();
  });

  it('reports both directions of traffic when a node is clicked', () => {
    const w = mount(configFor('layered_graph'));
    expect(w.host.textContent).toContain('点任意一个节点');

    w.click(nodeByLabel(w.host, '规划 Agent'));
    expect(w.host.textContent).toContain('检索 Agent');
    // 规划器扇出三个执行 Agent，入边来自用户和汇总的回流
    expect(w.host.textContent).toContain('→ 输出到：检索 Agent、代码 Agent、审校 Agent');
    expect(w.host.textContent).toContain('← 输入自：用户提问、汇总输出');

    w.unmount();
  });

  it('names the dead ends instead of printing an empty list', () => {
    const w = mount(configFor('layered_graph'));
    w.click(nodeByLabel(w.host, '用户提问'));
    expect(w.host.textContent).toContain('← 输入自：（起点，没有上游）');
    w.unmount();
  });

  it('routes the backward edge under the boxes instead of straight through them', () => {
    const w = mount(configFor('layered_graph'));
    const paths = Array.from(w.host.querySelectorAll('path'));
    const dashed = paths.filter((p) => p.getAttribute('stroke-dasharray'));
    // sample 里只有 汇总输出 → 规划 Agent 这一条回流边
    expect(dashed).toHaveLength(1);

    // 直连的回边会横穿中间那一列的节点框，实测在页面上整条边看不见了。
    // 回边必须是绕行曲线，且最低点低于所有节点框的底边。
    const d = dashed[0].getAttribute('d') ?? '';
    expect(d).toContain('C');
    for (const p of paths.filter((x) => !x.getAttribute('stroke-dasharray'))) {
      expect(p.getAttribute('d')).toContain('L'); // 前向边仍是直线
    }

    const lowestBoxBottom = Math.max(
      ...Array.from(w.host.querySelectorAll('rect')).map(
        (r) => Number(r.getAttribute('y')) + Number(r.getAttribute('height')),
      ),
    );
    const ys = [...d.matchAll(/[\d.]+\s+([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeGreaterThan(lowestBoxBottom);

    w.unmount();
  });

  it('clicking the selected node again clears the selection', () => {
    const w = mount(configFor('layered_graph'));
    w.click(nodeByLabel(w.host, '汇总输出'));
    expect(w.host.textContent).not.toContain('点任意一个节点');
    w.click(nodeByLabel(w.host, '汇总输出'));
    expect(w.host.textContent).toContain('点任意一个节点');
    w.unmount();
  });
});

describe('TemplateWidgetHost', () => {
  it('renders every registered template from its own default sample', () => {
    for (const meta of WIDGET_TEMPLATES) {
      const w = mount(configFor(meta.id));
      // 教具就得能动：真按钮、滑块，或 SVG 里带 role=button 的可点节点，至少有一个
      const affordances =
        buttonsByText(w.host).length +
        w.host.querySelectorAll('input').length +
        w.host.querySelectorAll('[role="button"]').length;
      expect(affordances, `${meta.id} rendered nothing interactive`).toBeGreaterThan(0);
      expect(w.host.textContent).toContain(meta.label);
      w.unmount();
    }
  });
});
