// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinearRoadmap } from '@/components/path/linear-roadmap';
import type { RoadmapInputNode } from '@/lib/learner/roadmap';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const nodes: RoadmapInputNode[] = [
  { id: 'llm_basics', label: '大模型基础', stage: 1, prereq: [], status: 'mastered', courses: [] },
  {
    id: 'prompt',
    label: '提示工程',
    stage: 1,
    prereq: ['llm_basics'],
    status: 'current',
    courses: [{ id: 'course-prompt', title: '提示工程实战' }],
  },
  { id: 'rag', label: '检索增强生成', stage: 2, prereq: ['prompt'], status: 'future', courses: [] },
];

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('线性路线图', () => {
  it('一站一个概念，当前位置写在抬头，挂了课的站点是课程链接', async () => {
    await act(async () =>
      root.render(<LinearRoadmap nodes={nodes} stages={[{ index: 1, title: '第一阶 · 打底' }]} />),
    );

    expect(host.querySelectorAll('ol > li')).toHaveLength(3);
    expect(host.textContent).toContain('共 3 站，当前在第 2 站「提示工程」');
    expect(host.textContent).toContain('第一阶 · 打底');
    // stages 里没有第 2 阶，兜底成「第 2 阶」，不编名字
    expect(host.textContent).toContain('第 2 阶');
    expect(host.textContent).toContain('先学前置');

    const link = host.querySelector('a[href="/classroom/course-prompt"]');
    expect(link, '挂了课的站点应当能点进课程').toBeTruthy();
    expect(link?.textContent).toContain('提示工程');
    // 没有课的站点不做成链接
    expect(host.querySelectorAll('a')).toHaveLength(1);
  });

  it('没有站点时给明确空态，不画空壳', async () => {
    await act(async () => root.render(<LinearRoadmap nodes={[]} />));
    expect(host.querySelector('ol')).toBeNull();
    expect(host.textContent).toContain('引擎没有给出本领域的阶次');
  });
});
