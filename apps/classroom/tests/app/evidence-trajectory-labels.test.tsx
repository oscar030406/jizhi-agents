// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { Evidence } from '@/lib/evidence/types';

/**
 * 学情证据时间轨迹图（/report）不许再印裸概念 id。
 *
 * 这张图的行名是 `Trajectory.label`，而那个 label 来自 `measured.concept`——
 * 值是引擎判词里的概念、或 `lib/evidence/data/scene-concepts.json` 从引用 chunk 的
 * `concept_tags` 反推出来的，两条来源写的都是 `llm_basics`、`embodied_vlm` 这类内部 id。
 * 左侧行名与下面「逐条证据」清单两处都印它。
 *
 * 退回场景标题的那一路本来就是中文，`conceptLabel` 原样放行——最后一条钉的是这个，
 * 免得有人把映射写成「查不到就删掉」。
 */

vi.mock('@/lib/evidence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/evidence')>();
  return { ...real, readLedger: async () => LEDGER };
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { EvidenceTrajectoryChart } = await import('@/components/report/evidence-trajectory-chart');

function ev(concept: string, at: string): Evidence {
  return {
    id: `e-${concept}-${at}`,
    learnerKey: 'l',
    source: { interactionId: `i-${concept}-${at}`, resourceId: 'scene-1', at },
    measured: { kind: 'concept', domain: 'ai', concept },
    verdict: { outcome: 'correct', score: 1, because: { hit: [], missed: [] } },
    verdictScope: 'per-kc',
    context: { encounter: 1, modality: 'tutor' },
  } as Evidence;
}

const LEDGER = {
  learnerKey: 'l',
  evidence: [
    ev('llm_basics', '2026-08-12T01:00:00Z'),
    ev('embodied_vlm', '2026-08-12T02:00:00Z'),
    ev('学习率的影响', '2026-08-12T03:00:00Z'),
    ev('控制', '2026-08-12T03:30:00Z'),
    {
      ...ev('控制', '2026-08-12T04:00:00Z'),
      measured: { kind: 'concept', domain: 'smart-manufacturing', concept: '控制' },
      verdict: { outcome: 'incorrect', score: 0, because: { hit: [], missed: ['控制'] } },
    } as Evidence,
  ],
  signals: [],
  invalidations: [],
  giveUps: [],
};

async function render(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<EvidenceTrajectoryChart domain="ai" />);
  });
  for (let i = 0; i < 2; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return host;
}

describe('证据轨迹图的测项名', () => {
  it('印概念中文名，内部 id 不上屏', async () => {
    const text = (await render()).textContent ?? '';
    expect(text).toContain('大模型基础');
    expect(text).toContain('视觉语言模型 VLM');
    expect(text).not.toContain('llm_basics');
    expect(text).not.toContain('embodied_vlm');
  });

  it('退回场景标题的测项原样显示', async () => {
    expect((await render()).textContent ?? '').toContain('学习率的影响');
  });

  it('只折叠当前有效领域，智能制造的同名失败证据不进入 AI 轨迹', async () => {
    const text = (await render()).textContent ?? '';
    expect(text).toContain('控制');
    expect(text).not.toContain('得分 0.00');
  });
});
