// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * 证据轨迹图：得分不许只靠颜色读。
 *
 * 图上三种结果用绿/黄/红区分，可这三个 token 在 deuteranopia 下几乎重合
 * （深绿 #346538 与深红 #9f2f2d 的 OKLab ΔE 只有 4.0，暗色档的一对是 3.1），
 * 而且 token 在 globals.css 里跨全站共用，改不得。所以位置必须是第二条通道：
 * 每行画出 1.0 / 0.5 / 0 三条刻度线，另有一份逐条证据清单把数值落到页面上。
 */

const POINT = (at: string, score: number, scope: 'per-kc' | 'item-level') => ({
  at,
  score,
  outcome: score >= 1 ? 'correct' : score > 0 ? 'partial' : 'incorrect',
  modality: 'quiz',
  scope,
  encounter: 1,
  because: { hit: [], missed: [] },
});

const TRAJ = [
  {
    measured: { kind: 'concept', concept: '检索增强生成里的重排序模型' },
    key: 'k1',
    label: '检索增强生成里的重排序模型', // 13 字，超过截断长度
    points: [
      POINT('2026-08-10T01:00:00.000Z', 1, 'per-kc'),
      POINT('2026-08-11T01:00:00.000Z', 0.5, 'item-level'),
    ],
    latest: 0.5,
    itemLevel: 1,
  },
];

vi.mock('@/lib/evidence', () => ({
  readLedger: async () => ({ evidence: [], signals: [], invalidations: [], giveUps: [] }),
  history: () => [],
  invalidatedIds: () => new Set(),
  fold: () => ({ all: [] }),
}));
vi.mock('@/lib/evidence/trajectory', () => ({
  trajectories: () => TRAJ,
  summarize: () => ({
    concepts: 1,
    events: 2,
    itemLevelRatio: 0.5,
    spanDays: 1,
    modalities: { quiz: 2 },
  }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { EvidenceTrajectoryChart } = await import('@/components/report/evidence-trajectory-chart');

async function render(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(<EvidenceTrajectoryChart />);
  });
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

describe('证据轨迹图', () => {
  it('每行画出得分刻度线，位置是颜色之外的第二条通道', async () => {
    const host = await render();
    const svg = host.querySelector('svg[aria-label="学情证据时间轨迹图"]')!;
    // 一行三条刻度：1.0 / 0.5 / 0。y 值互不相同才说明真的分了三档。
    const ys = new Set(
      [...svg.querySelectorAll('line')].map((l) => l.getAttribute('y1')),
    );
    expect(ys.size).toBeGreaterThanOrEqual(3);
    expect(svg.textContent).toContain('1.0');
    expect(svg.textContent).toContain('0.0');
  });

  it('每个得分都能不靠悬停读到', async () => {
    const host = await render();
    const details = host.querySelector('details')!;
    expect(details.textContent).toContain('逐条证据（2 条）');
    expect(details.textContent).toContain('得分 1.00');
    expect(details.textContent).toContain('得分 0.50');
    // 粒度降级也要写在清单里，不只在图例里。
    expect(details.textContent).toContain('整卷判定摊过来（粗）');
  });

  it('测项名截断到左栏放得下的长度，不压进画区', async () => {
    const host = await render();
    const svg = host.querySelector('svg[aria-label="学情证据时间轨迹图"]')!;
    const label = [...svg.querySelectorAll('text')].find((t) => t.textContent?.endsWith('…'))!;
    expect(label.textContent).toBe('检索增强生成里的重排…');
  });
});
