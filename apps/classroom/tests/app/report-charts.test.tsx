// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * 学情报告页两张图的形式约束。钉的是「画法本身是否诚实」，不是像素。
 *
 * 1. 难度图必须是阶梯，不是折线。L1–L4 是四个档位，场景之间不存在 L2.5，
 *    折线会在两个场景之间画出一段并不存在的过渡值。
 * 2. 估计值必须在图上和实测值分得开（空心点 + 虚线平台），不能只写在图注里。
 * 3. 证据轨迹图的得分必须能只靠位置读出来：绿/红在 deuteranopia 下 OKLab ΔE 只有 4，
 *    颜色不能是唯一通道。刻度线 + 逐条证据清单两条路都要在。
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('motion/react', () => ({ motion: { div: 'div' } }));
vi.mock('@number-flow/react', () => ({ default: () => null }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('@/components/report/evidence-trajectory-chart', () => ({
  EvidenceTrajectoryChart: () => null,
}));

const SCENES = [
  { id: 'a', order: 0, type: 'quiz', title: '测验一', outlineId: 'o1' },
  { id: 'b', order: 1, type: 'slide', title: '讲解一' },
  { id: 'c', order: 2, type: 'pbl', title: '项目一' },
];

vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: async () => [{ id: 's1', name: '测试课' }],
  loadStageData: async () => ({
    stage: { id: 's1', name: '测试课' },
    scenes: SCENES,
    outline: {
      outlines: [
        { id: 'o1', order: 0, title: '测验一', description: '', quizConfig: { difficulty: 'hard' } },
      ],
    },
  }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { default: ReportPage } = await import('@/app/report/page');

const BLUEPRINT = {
  mastery_vector: { rag: 0.2, tool_calling: 0.8 },
  weak_concepts: ['rag'],
  recommended_difficulty: 'L2',
  learning_risks: [],
  diagnosis_summary: '测试用',
  blueprint: {
    skill_gaps: [],
    resource_mix: { quiz_difficulty_band: ['L1', 'L2'], rationale: [] },
  },
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderReport(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<ReportPage />);
  });
  await flush();
  await flush();
  return host;
}

beforeEach(() => {
  window.localStorage.setItem('learnerProfile', JSON.stringify({ domain: 'ai', role: '学生' }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ blueprint: BLUEPRINT }),
    })),
  );
});

describe('难度匹配图', () => {
  it('画阶梯而不是折线：没有跨场景的斜线段', async () => {
    const host = await renderReport();
    const svg = host.querySelector('svg[aria-label="资源难度匹配阶梯图"]');
    expect(svg).not.toBeNull();
    // 折线一旦回来，polyline 就会重新出现——这条断言就是防回退的锁。
    expect(svg!.querySelector('polyline')).toBeNull();

    // 图里每一条 line 要么水平（平台、网格、基线）要么垂直（换档），不许有斜的。
    const skew = [...svg!.querySelectorAll('line')].filter((l) => {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a)));
      return Math.abs(x1 - x2) > 0.01 && Math.abs(y1 - y2) > 0.01;
    });
    expect(skew).toEqual([]);
  });

  it('估计值在图上就能和实测值分开：点线平台 + 空心点', async () => {
    const host = await renderReport();
    const svg = host.querySelector('svg[aria-label="资源难度匹配阶梯图"]')!;

    // 三个场景里只有 quiz 有大纲记录难度（hard→L3），另外两个是估计值。
    const dashedPlateaus = [...svg.querySelectorAll('line')].filter(
      (l) => l.getAttribute('stroke-dasharray') === '0.1 4',
    );
    expect(dashedPlateaus).toHaveLength(2);

    const hollow = [...svg.querySelectorAll('circle')].filter(
      (c) => c.getAttribute('fill') === 'transparent',
    );
    expect(hollow).toHaveLength(2);
  });
});

describe('掌握度', () => {
  it('同一份 mastery_vector 只画一次：方块矩阵删掉后，剩条形图这一张', async () => {
    const host = await renderReport();
    const bars = host.querySelector('svg[aria-label="知识盲区定位图"]');
    expect(bars).not.toBeNull();
    // 矩阵那一版把每个概念的数值又铺了一遍，两处同源数字并排是重复不是对照。
    expect(host.textContent).not.toContain('精通');
  });
});
