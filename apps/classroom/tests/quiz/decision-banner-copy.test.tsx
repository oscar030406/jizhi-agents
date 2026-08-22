// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * 横幅上的对外措辞：引擎的内部代号一个字都不许出现在学习者眼前。
 *
 * `next_action` 是自由文本（引擎侧只校验非空），模型路径实测会吐
 * `reexplain_concept` 这类英文下划线代号，原来直接 `{decision.next_action}` 渲染。
 * 这个测试钉两件事：已知代号翻成人话；**没见过的**代号也不许裸渲——
 * 后者才是关键，因为取值集合没有上界，靠补映射表永远追不上。
 */

import { AdaptiveDecisionBanner } from '@/components/scene-renderers/adaptive-decision-banner';
import type { AdaptiveDecision } from '@/app/api/adaptive/quiz-decision/route';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: AdaptiveDecision = {
  feedback_type: 'remediation',
  decision: 'downgrade_explanation',
  updated_difficulty: 'L1',
  next_action: '换一个更基础的切入点重讲',
  explanation: '按整场得分降到 L1',
  because: ['整场正确率 0%'],
  engine: 'llm',
};

/** 英文下划线代号的形状：连续小写英文中间夹下划线。 */
const SNAKE_CASE = /[a-z]+_[a-z]+/;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(decision: AdaptiveDecision): string {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<AdaptiveDecisionBanner decision={decision} scorePercent={0} />);
  });
  return host.textContent ?? '';
}

beforeEach(() => {
  root = null;
  host = null;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('决策横幅的对外措辞', () => {
  it('中文的 next_action 原样透传（确定性/仲裁路径给的就是中文整句）', () => {
    const text = render(BASE);
    expect(text).toContain('换一个更基础的切入点重讲');
  });

  it('已知英文代号翻成人话，代号本身不出现', () => {
    const text = render({ ...BASE, next_action: 'reexplain_concept' });
    expect(text).not.toContain('reexplain_concept');
    expect(text).toContain('换个说法，把这个概念再讲一遍');
  });

  it('没见过的代号也不裸渲：退回按 decision 说的中性话', () => {
    const text = render({ ...BASE, next_action: 'schedule_spaced_repetition_drill_v2' });
    expect(text).not.toContain('schedule_spaced_repetition_drill_v2');
    expect(SNAKE_CASE.test(text)).toBe(false);
    expect(text).toContain('换个更简单的说法重讲');
  });

  it('next_action 为空串时同样有中文可读的说法', () => {
    const text = render({ ...BASE, decision: 'advance_challenge', next_action: '   ' });
    expect(SNAKE_CASE.test(text)).toBe(false);
    expect(text).toContain('往上加一道更综合的题');
  });

  it('协商块里的未知 decision 值不裸渲', () => {
    const text = render({
      ...BASE,
      negotiation: {
        conflict: true,
        proposals: [
          {
            source: '反馈决策 Agent',
            signal: '整场得分',
            decision: 'mystery_route',
            difficulty: 'L2',
            engine: 'deterministic',
            basis: ['整场正确率 0%'],
          },
        ],
        arbitration: {
          decision: 'mystery_route',
          difficulty: 'L2',
          next_action: 'do_something_unknown',
          rationale: '采信知识点信号',
          engine: 'deterministic',
          overruled: 'another_mystery_route',
        },
        final_decision: 'mystery_route',
        final_difficulty: 'L2',
      },
    });
    expect(SNAKE_CASE.test(text)).toBe(false);
    expect(text).toContain('其他路线');
  });
});
