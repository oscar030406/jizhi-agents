// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { SceneAuditBadge } from '@/components/stage/scene-audit-badge';
import type { SceneAudit } from '@/lib/generation/hallucination-audit';

/**
 * 课堂角标弹层的口径回归（WO-H5 第 1 件）。
 *
 * 原来这里直接把 `siliconflow:Qwen/Qwen3.6-35B-A3B + siliconflow:deepseek-ai/DeepSeek-V3.2`
 * 铺在弹层正文，和 /agents 页的「审核智能体甲（通义系）」两套说法。
 * 这个测试钉三件：默认文案是人话、完整模型串只在折叠里、折叠默认是关的。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const JUDGE_A = 'siliconflow:Qwen/Qwen3.6-35B-A3B';
const JUDGE_B = 'siliconflow:deepseek-ai/DeepSeek-V3.2';

const AUDIT: SceneAudit = {
  verdict: 'revised',
  claims: [],
  totalClaims: 4,
  flaggedCount: 1,
  uncertainCount: 0,
  incorrectCount: 1,
  judgeModel: JUDGE_A,
  judgeModels: [JUDGE_A, JUDGE_B],
  arbiterModel: JUDGE_A,
  rounds: 2,
  durationMs: 8200,
  decision: 'publish_with_warnings',
  rationale: '事实性分数越过放行线，保留一条风险标记。',
  grounded: true,
  evidenceCount: 12,
  debate: [
    {
      claim: 'RAG 的召回阶段用的是稀疏检索。',
      judgeVerdicts: [`${JUDGE_A} → 有误`, `${JUDGE_B} → 存疑`],
      defense: '教材里两种都提到了。',
      arbiterVerdict: 'incorrect',
      rationale: '教材第 7 章写的是稠密向量检索。',
    },
  ],
};

function renderOpenPanel(audit: SceneAudit): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<SceneAuditBadge audit={audit} />);
  });
  const button = host.querySelector<HTMLButtonElement>('[data-testid="scene-audit-badge"]');
  expect(button).not.toBeNull();
  act(() => {
    button!.click();
  });
  const panel = host.querySelector<HTMLElement>('[data-testid="scene-audit-panel"]');
  expect(panel).not.toBeNull();
  return panel!;
}

describe('SceneAuditBadge 弹层模型口径', () => {
  it('正文只出现人话称谓，不出现完整模型串', () => {
    const panel = renderOpenPanel(AUDIT);
    const details = panel.querySelector('[data-testid="scene-audit-models"]')!;
    // 把折叠整块摘掉，剩下的就是「默认糊在脸上」的文字
    details.remove();
    const visible = panel.textContent ?? '';

    expect(visible).toContain('审核智能体甲（通义系）');
    expect(visible).toContain('审核智能体乙（DeepSeek 系）');
    expect(visible).toContain('终审 仲裁（通义系）');
    expect(visible).not.toContain('siliconflow');
    expect(visible).not.toContain('Qwen3.6-35B-A3B');
    expect(visible).not.toContain('DeepSeek-V3.2');
  });

  it('具体型号收在默认折叠的详情里，且脱掉供应商前缀', () => {
    const panel = renderOpenPanel(AUDIT);
    const details = panel.querySelector<HTMLDetailsElement>('[data-testid="scene-audit-models"]')!;

    expect(details.open).toBe(false);
    const rows = [...details.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(rows).toEqual([
      '审核智能体甲（通义系）Qwen3.6-35B-A3B',
      '审核智能体乙（DeepSeek 系）DeepSeek-V3.2',
      '仲裁（通义系）Qwen3.6-35B-A3B',
    ]);
    expect(details.textContent).not.toContain('siliconflow');
  });

  it('接地的场景把取材的知识库写成中文名——换了库要看得见换了', () => {
    const panel = renderOpenPanel({ ...AUDIT, corpus: 'odoo' });
    expect(panel.textContent).toContain('取材《企业管理系统 Odoo》');
    expect(panel.textContent).toContain('12 条证据');
  });

  it('没记来源的旧场景照旧只说受控知识库，不补猜一个库名', () => {
    const panel = renderOpenPanel(AUDIT);
    expect(panel.textContent).toContain('受控知识库 12 条证据');
    expect(panel.textContent).not.toContain('取材');
  });

  it('旧的单判官记录也走同一套称谓', () => {
    const { judgeModels: _drop, arbiterModel: _drop2, debate: _drop3, ...single } = AUDIT;
    const panel = renderOpenPanel(single);
    expect(panel.textContent).toContain('独立审核 · 审核智能体甲（通义系）');
  });
});
