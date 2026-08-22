// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import type { LearnerBlueprint } from '@/lib/generation/learner-profile';
import { NextStepPanel } from '@/app/report/page';

/**
 * 「下一步先学什么」面板的渲染回归。
 *
 * 纯函数那一层在 `tests/generation/next-step-wiring.test.ts` 里已经钉住，这里只管三件
 * 渲染侧的事：**结论真的出现在页面上**（不是算完扔掉）、**降级不静默**、
 * **前置图里冒出来的概念不露裸 id**。
 *
 * 用 demo run 01-beginner-initial 的原始数字，与那份纯函数测试同源。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const COLD = {
  agent_basics: 0,
  rag: 0,
  tool_calling: 0,
  langgraph: 0,
  evaluation: 0,
  deployment: 0,
  guardrails: 0.25,
};
const GAPS = ['evaluation', 'langgraph', 'tool_calling', 'rag', 'agent_basics'];

const bpOf = (mastery: Record<string, number>) => ({ mastery_vector: mastery }) as LearnerBlueprint;

async function render(bp: LearnerBlueprint, gaps: string[]): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    createRoot(host).render(<NextStepPanel bp={bp} gapConcepts={gaps} />);
  });
  return host;
}

describe('冷启动', () => {
  it('把「一个都学不了」说出来，而不是渲染一份空清单', async () => {
    const host = await render(bpOf(COLD), GAPS);
    expect(host.textContent).toContain('缺口清单里没有一个点的前置是现在就满足的');
  });

  it('必经但清单没列的前置带中文名列出来', async () => {
    const host = await render(bpOf(COLD), GAPS);
    const text = host.textContent ?? '';
    expect(text).toContain('缺口清单不自足');
    expect(text).toContain('深度学习');
    expect(text).toContain('大模型基础');
    // CONCEPT_META 没覆盖到的 id 会原样漏出来——这一条就是防它。
    expect(text).not.toContain('deep_learning');
    expect(text).not.toContain('llm_basics');
  });

  it('首排序键并列时说清楚顺序其实是谁排的', async () => {
    const host = await render(bpOf(COLD), GAPS);
    expect(host.textContent).toContain('预测正确率完全并列');
  });
});

describe('进阶态', () => {
  const mastery = { ...COLD, llm_basics: 0.9, prompt_engineering: 0.85, rag: 0.5 };

  it('可学的点带上预测正确率和解锁数一起渲染', async () => {
    const host = await render(bpOf(mastery), GAPS);
    const text = host.textContent ?? '';
    expect(text).toContain('检索增强 RAG');
    // 0.5*0.9 + 0.5*0.25 = 0.575，浮点上是 57.49999...，四舍五入到 57 而不是 58。
    expect(text).toContain('预测正确率 57%');
    expect(text).toContain('解锁 4 个后续'); // agent_basics
    expect(text).toContain('复习候选');
    expect(text).toContain('提示工程');
  });
});

describe('降级', () => {
  it('缺口一个都不在前置图词表内时整块不渲染', async () => {
    const host = await render(bpOf(COLD), ['傅里叶变换', '特征值分解']);
    expect(host.textContent).toBe('');
  });
});
