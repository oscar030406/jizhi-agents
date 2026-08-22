// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { WorkshopFeed } from '@/components/generation/workshop-feed';
import { useWorkshopStore } from '@/lib/store/workshop';
import { reportPipeline } from '@/lib/hooks/use-scene-generator';
import type { ScenePipelineMeta } from '@/lib/types/generation';

/**
 * 三禁实拔 DOM（WO-M2）：跨模型回落必须在车间面板上说出来，但**内部型号串不许上屏**。
 *
 * 这里驱动的是生产函数 `reportPipeline` → workshop store → `WorkshopFeed` 渲染，
 * 不是复刻一遍字符串——复刻出来的测试只能证明我抄对了自己。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** `SILICONFLOW_MODELS` 白名单六档，一个都不许出现在 DOM 里。 */
const WHITELIST = [
  'Qwen/Qwen3.5-397B-A17B',
  'MiniMaxAI/MiniMax-M2.5',
  'Qwen/Qwen3.5-122B-A10B',
  'deepseek-ai/DeepSeek-V3.2',
  'Qwen/Qwen3-30B-A3B-Instruct-2507',
  'zai-org/GLM-5.2',
];

const FALLBACK_PIPELINE: ScenePipelineMeta = {
  blueprint: null,
  evidence: null,
  assembly: null,
  modelFallback: [
    { from: 'Qwen/Qwen3.5-397B-A17B', to: 'MiniMaxAI/MiniMax-M2.5', reason: 'HTTP 503' },
  ],
  verification: null,
};

function render(): { container: HTMLElement; text: string } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<WorkshopFeed />);
  });
  return { container, text: container.textContent ?? '' };
}

describe('车间面板的回落行', () => {
  beforeEach(() => {
    useWorkshopStore.getState().clear();
    document.body.innerHTML = '';
  });

  it('回落发生时出黄行，且 DOM 里没有任何白名单型号串', () => {
    act(() => reportPipeline('什么是 RAG', FALLBACK_PIPELINE));
    const { container, text } = render();

    expect(text).toContain('生成回落');
    expect(text).toContain('HTTP 503');
    expect(text).toContain('〈型号略〉');
    for (const model of WHITELIST) {
      expect(text).not.toContain(model);
    }
    // 厂商名单独出现也算泄型号（redactCaliber 的正则就是按厂商前缀抓的）。
    expect(text).not.toMatch(/MiniMax|Qwen|DeepSeek|GLM/);
    // 审核色带（yellow）—— 回落是要人看见的事，不能塞进 neutral 里。
    expect(container.querySelectorAll('.bg-yellow-soft').length).toBeGreaterThan(0);
  });

  it('没发生回落（modelFallback 为 null）时一行都不多出来', () => {
    act(() => reportPipeline('什么是 RAG', { ...FALLBACK_PIPELINE, modelFallback: null }));
    const { text } = render();
    expect(text).not.toContain('生成回落');
    // 原有的「生成：版面内容就绪」还在，说明只是回落那一行没出，不是整体没渲染
    expect(text).toContain('版面内容就绪');
  });
});
