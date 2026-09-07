// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProfileRadar } from '@/components/learner/profile-radar';

/**
 * 两个渲染分支：可用维度够就画图，不够就只出清单。
 *
 * echarts 在这里被替掉——测的是「什么时候画、缺的维度怎么写」，不是 echarts 会不会画。
 * 真图形在 jsdom 里也量不出宽高，量了也不能当证据。
 */
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: () => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }),
}));
vi.mock('echarts/charts', () => ({ RadarChart: {} }));
vi.mock('echarts/components', () => ({ TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ SVGRenderer: {} }));

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return host;
}

describe('ProfileRadar', () => {
  it('可用维度不足三个：不画图，逐维写清为什么没有', async () => {
    const host = await render(<ProfileRadar input={{ selfLevels: [1, 2, 1, 0, 1] }} />);
    expect(host.querySelector('[role="img"]')).toBeNull();
    expect(host.textContent).toContain('不足 3 个');
    // 五维全在清单里，缺的四维都写「暂无数据」而不是 0%
    expect(host.textContent).toContain('知识掌握');
    expect(host.textContent).toContain('目标达成');
    expect(host.textContent).toContain('巩固保持');
    expect(host.textContent).toContain('测评把握');
    expect(host.textContent?.match(/暂无数据/g)).toHaveLength(4);
    expect(host.textContent).not.toContain('0%');
  });

  it('维度够三个：画图，图上只有有数据的那几维，缺的仍标暂无数据', async () => {
    const host = await render(
      <ProfileRadar
        input={{
          conceptMastery: { a: 0.5 },
          conceptRecall: { a: 0.4 },
          selfLevels: [2, 2, 2, 2, 2],
        }}
      />,
    );
    const canvas = host.querySelector('[role="img"]');
    expect(canvas).not.toBeNull();
    const label = canvas?.getAttribute('aria-label') ?? '';
    expect(label).toContain('知识掌握 50%');
    expect(label).toContain('巩固保持 40%');
    expect(label).toContain('先验基础 50%');
    // 没数据的两维不进雷达轴
    expect(label).not.toContain('目标达成');
    expect(label).not.toContain('测评把握');
    expect(host.textContent?.match(/暂无数据/g)).toHaveLength(2);
  });
});
