// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * 决策横幅的**时序**回归（摸底 §2.4，2/2 复现的那条）。
 *
 * 交卷后判分 effect 会先 `setPhase('reviewing')` 再等 `/api/adaptive/quiz-decision`
 * 回来。这个 effect 的依赖里有 `phase`，所以 setPhase 一执行，它自己的 cleanup 立刻跑。
 * 只要决策请求的守门用的是这个 cleanup 里的闭包变量，回来的结果就会被整条吞掉——
 * 接口 200 带完整决策，界面上既没有横幅也没有「引擎未响应」提示。
 *
 * 所以这个测试**必须**让决策请求在 phase 变成 reviewing 之后才 resolve，
 * 否则它钉不住任何东西（提前 resolve 的话，坏代码也能过）。
 */

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'zh-CN', setLocale: () => {} }),
}));

vi.mock('@/components/audio/speech-button', () => ({
  SpeechButton: () => null,
}));

// motion 的 AnimatePresence mode="wait" 在 jsdom 里等不到 exit 动画结束，
// 下一个 phase 的 DOM 永远挂不上。这里把动画层换成裸标签，只保留结构与事件。
vi.mock('motion/react', async () => {
  const React = await import('react');
  const ANIMATION_PROPS = new Set([
    'initial', 'animate', 'exit', 'transition', 'whileTap', 'whileHover', 'layout', 'layoutId',
    'variants', 'custom', 'drag', 'onAnimationComplete',
  ]);
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub({ children, ...props }: Record<string, unknown> & { children?: unknown }) {
          const clean = Object.fromEntries(
            Object.entries(props).filter(([k]) => !ANIMATION_PROPS.has(k)),
          );
          return React.createElement(tag, clean, children as never);
        },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: unknown }) =>
      React.createElement(React.Fragment, null, children as never),
  };
});

// 履历/画像那条旁路与本测试无关，但它是真 import（动态 import 也会被 mock 拦到）。
vi.mock('@/lib/evidence', () => ({
  appendEvidence: vi.fn(async () => {}),
  evidenceFor: () => [],
  readLedger: vi.fn(async () => ({})),
  LEGACY_DOMAIN: 'ai',
}));
vi.mock('@/lib/evidence/from-quiz', () => ({ quizEvidenceDraft: () => null }));
vi.mock('@/lib/evidence/profile-bridge', () => ({
  learnerDomain: () => 'ai',
  refreshDerivedProfile: vi.fn(async () => {}),
}));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: async () => 'anon:test' }));

const recordPhase = vi.fn(async () => {});
vi.mock('@/lib/quiz/runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/quiz/runtime')>('@/lib/quiz/runtime');
  return {
    ...actual,
    loadQuizAttemptState: vi.fn(async () => ({ attemptId: 'attempt-1' })),
    createQuizAttemptWriter: () => ({
      recordPhase,
      scheduleDraft: vi.fn(),
      cancelDraft: vi.fn(),
      flushDraft: vi.fn(async () => {}),
    }),
  };
});

import { QuizView } from '@/components/scene-renderers/quiz-view';
import type { QuizQuestion } from '@/lib/types/stage';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTIONS: QuizQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: 'Q/K/V 里的 Q 是什么？',
    options: [
      { label: '查询', value: 'A' },
      { label: '键', value: 'B' },
    ],
    answer: ['A'],
    hasAnswer: true,
    points: 1,
  },
];

const DECISION = {
  success: true,
  decision: 'downgrade_explanation',
  updated_difficulty: 'L1',
  next_action: '换一个更基础的切入点重讲',
  because: ['整场正确率 0%，低于目标带下沿'],
  explanation: '按整场得分降到 L1',
  engine: 'deterministic',
};

let root: Root | null = null;
let host: HTMLElement | null = null;

/** 决策请求的手动闸门：测试自己决定它什么时候回来。 */
let releaseDecision: (() => void) | null = null;
let decisionRequests = 0;

beforeEach(() => {
  decisionRequests = 0;
  releaseDecision = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/adaptive/quiz-decision')) {
        decisionRequests += 1;
        return new Promise((resolve) => {
          releaseDecision = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => DECISION,
            } as Response);
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    }),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mountAndSubmit(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<QuizView questions={QUESTIONS} sceneId="scene-1" stageId="stage-1" sceneTitle="Q/K/V 核心概念" />);
  });

  const click = async (predicate: (b: HTMLButtonElement) => boolean) => {
    const btn = [...host!.querySelectorAll('button')].find((b) =>
      predicate(b as HTMLButtonElement),
    ) as HTMLButtonElement | undefined;
    if (!btn)
      throw new Error(
        `button not found; buttons=${JSON.stringify(
          [...host!.querySelectorAll('button')].map((b) => b.textContent),
        )}`,
      );
    await act(async () => {
      btn.click();
    });
  };

  await click((b) => b.textContent?.includes('quiz.startQuiz') ?? false);
  // 故意答错：决策才会是 downgrade_explanation（横幅上的「执行」按钮挂在非 keep_route 上）
  await click((b) => b.textContent?.trim().startsWith('B') ?? false);
  await click((b) => b.textContent?.includes('quiz.submitAnswers') ?? false);
  return host!;
}

describe('交卷 → 决策横幅', () => {
  it('决策在 phase 变成 reviewing 之后才回来，横幅仍然要出现', async () => {
    const el = await mountAndSubmit();

    // 判分已经跑完：成绩页在，phase 已经从 grading 翻成 reviewing。
    expect(el.textContent).toContain('quiz.quizReport');
    expect(decisionRequests).toBe(1);
    expect(el.querySelector('[data-testid="adaptive-decision-banner"]')).toBeNull();

    // 现在——也就是 phase 变化、effect cleanup 已经跑过之后——才放决策回来。
    await act(async () => {
      releaseDecision!();
      await Promise.resolve();
    });

    const banner = el.querySelector('[data-testid="adaptive-decision-banner"]');
    expect(banner, '决策 200 回来了，横幅必须出现（不许被 effect cleanup 吞掉）').not.toBeNull();
    expect(banner!.textContent).toContain('降维解释');
    // ⑤ 步挂在横幅上的执行按钮
    expect(banner!.textContent).toContain('执行：降维解释');
    // 决策写回画像，下一次交卷读到的是 L1
    expect(JSON.parse(localStorage.getItem('learnerProfile') ?? '{}').currentDifficulty).toBe('L1');
  });

  it('决策失败同样不许被吞：要么横幅要么「引擎未响应」，不能两个都没有', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/adaptive/quiz-decision')) {
          decisionRequests += 1;
          return new Promise((resolve) => {
            releaseDecision = () =>
              resolve({ ok: false, status: 204, json: async () => ({}) } as Response);
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
      },
    );

    const el = await mountAndSubmit();
    expect(decisionRequests).toBe(1);

    await act(async () => {
      releaseDecision!();
      await Promise.resolve();
    });

    expect(el.textContent).toContain('反馈决策引擎未响应');
  });
});
