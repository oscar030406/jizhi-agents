// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * 张力动线第 ⑤ 步的**后半段**回归：横幅上的「执行」按下去之后会发生什么。
 *
 * D2 交单时明写「insertedLabel / onJump 两分支本轮没走到（补救生成分钟级），
 * 沿用未实测状态」——本文件把这两条分支钉住。真实链路 2026-08-15 已在
 * 3442 上跑通两次（见 WO-F1 报告的耗时表），这里只用 mock 的完成事件复现界面时序，
 * 不再花十分钟真生成。
 *
 * `generateRemediationScene` 是唯一被 mock 的东西：它背后是
 * remediation 规划 → scene-content → scene-audit → scene-actions 四段真调用，
 * 在单测里跑它没有意义。**store 不 mock**：跳转落点断言的是
 * `useStageStore.getState().currentSceneId` 的真实取值，不是「某个 spy 被调过」。
 */

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'zh-CN', setLocale: () => {} }),
}));

vi.mock('@/components/audio/speech-button', () => ({
  SpeechButton: () => null,
}));

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

/** 补救生成的手动闸门：测试自己决定它什么时候（以什么结果）回来。 */
const generateRemediationScene = vi.fn();
vi.mock('@/lib/hooks/use-scene-generator', () => ({
  generateRemediationScene: (...args: unknown[]) => generateRemediationScene(...args),
}));

import { QuizView } from '@/components/scene-renderers/quiz-view';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { useStageStore } from '@/lib/store/stage';
import type { QuizQuestion } from '@/lib/types/stage';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTIONS: QuizQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: 'temperature 调大，softmax 分布会怎样？',
    options: [
      { label: '更平滑', value: 'A' },
      { label: '更尖锐', value: 'B' },
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

/** 真实链路里 insertSceneAfter 落进 store 的那个场景（这里只用到 id）。 */
const INSERTED_SCENE_ID = 'scene_remediation_1';

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  generateRemediationScene.mockReset();
  useStageStore.setState({ currentSceneId: 'scene-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/adaptive/quiz-decision')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => DECISION } as Response);
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

function buttons(): HTMLButtonElement[] {
  return [...host!.querySelectorAll('button')] as HTMLButtonElement[];
}

function findButton(predicate: (b: HTMLButtonElement) => boolean): HTMLButtonElement | undefined {
  return buttons().find(predicate);
}

async function click(predicate: (b: HTMLButtonElement) => boolean) {
  const btn = findButton(predicate);
  if (!btn) {
    throw new Error(
      `button not found; buttons=${JSON.stringify(buttons().map((b) => b.textContent))}`,
    );
  }
  await act(async () => {
    btn.click();
  });
}

const byText = (text: string) => (b: HTMLButtonElement) => b.textContent?.includes(text) ?? false;

/** 交一次错卷，等到横幅出现。 */
async function submitWrongAnswer() {
  await click(byText('quiz.startQuiz'));
  await click((b) => b.textContent?.trim().startsWith('B') ?? false);
  await click(byText('quiz.submitAnswers'));
  // 决策 fetch 已 resolve，但链上还有几个 microtask
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(
  onRequestSceneSwitch?: (sceneId: string) => Promise<boolean>,
): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <QuizView
        questions={QUESTIONS}
        sceneId="scene-1"
        stageId="stage-1"
        sceneTitle="温度参数"
        onRequestSceneSwitch={onRequestSceneSwitch}
      />,
    );
  });
  await submitWrongAnswer();
  return host!;
}

/** 走 SceneRenderer 挂载同一个 quiz 场景，用来钉住闸门 prop 有没有透传下来。 */
async function mountViaSceneRenderer(
  onRequestSceneSwitch: (sceneId: string) => Promise<boolean>,
): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const scene = {
    id: 'scene-1',
    stageId: 'stage-1',
    title: '温度参数',
    type: 'quiz' as const,
    order: 0,
    content: { type: 'quiz' as const, questions: QUESTIONS },
  };
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <SceneRenderer
        scene={scene as never}
        mode="playback"
        onRequestSceneSwitch={onRequestSceneSwitch}
      />,
    );
  });
  await submitWrongAnswer();
  return host!;
}

function banner(): HTMLElement {
  const el = host!.querySelector('[data-testid="adaptive-decision-banner"]');
  if (!el) throw new Error('决策横幅没出现');
  return el as HTMLElement;
}

describe('执行决策 → 补救场景落地', () => {
  it('生成成功：横幅换成 insertedLabel，执行按钮收起', async () => {
    generateRemediationScene.mockResolvedValue({ scene: { id: INSERTED_SCENE_ID } });
    await mount();

    expect(banner().textContent).toContain('执行：降维解释');
    await click(byText('执行：降维解释'));

    // 真实调用参数：答错的题干原样传下去，锚点是本场景
    expect(generateRemediationScene).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'downgrade_explanation',
        anchorSceneId: 'scene-1',
        missedPoints: ['temperature 调大，softmax 分布会怎样？'],
      }),
    );
    expect(banner().textContent).toContain('已插入新场景');
    expect(findButton(byText('执行：降维解释')), '插入完成后不该还留着执行按钮').toBeUndefined();
  });

  it('跳转过去：当前场景真的换成插入的那个', async () => {
    generateRemediationScene.mockResolvedValue({ scene: { id: INSERTED_SCENE_ID } });
    await mount();
    await click(byText('执行：降维解释'));

    expect(useStageStore.getState().currentSceneId).toBe('scene-1');
    await click(byText('跳转过去'));
    expect(useStageStore.getState().currentSceneId).toBe(INSERTED_SCENE_ID);
  });

  /**
   * WO-H4 第 2 件：「跳转过去」以前直连 `useStageStore.setCurrentSceneId`，
   * 绕开 PlaybackChromeRoot 的 `gatedSceneSwitch` —— 讨论会话还开着就翻页，
   * SSE 不收、会话不结。这里的假闸门只复刻真闸门的两条要害
   * （PlaybackChromeRoot.tsx:1039 起）：会话进行中先拦下；放行时先 endActiveSession 再落场景。
   */
  function makeGate(topicActive: boolean) {
    const trace: string[] = [];
    const gate = vi.fn(async (target: string) => {
      if (topicActive) {
        trace.push('blocked');
        return false;
      }
      trace.push('endActiveSession');
      await Promise.resolve();
      useStageStore.getState().setCurrentSceneId(target);
      trace.push('setCurrentSceneId');
      return true;
    });
    return { gate, trace };
  }

  it('跳转走闸门：讨论会话进行中先拦下，不直接改场景', async () => {
    generateRemediationScene.mockResolvedValue({ scene: { id: INSERTED_SCENE_ID } });
    const { gate, trace } = makeGate(true);
    await mount(gate);
    await click(byText('执行：降维解释'));

    await click(byText('跳转过去'));
    expect(gate).toHaveBeenCalledWith(INSERTED_SCENE_ID);
    expect(trace).toEqual(['blocked']);
    expect(
      useStageStore.getState().currentSceneId,
      '闸门没放行就换了场景，说明「跳转过去」还在直连 store',
    ).toBe('scene-1');
  });

  it('跳转走闸门：放行时先收会话再落场景', async () => {
    generateRemediationScene.mockResolvedValue({ scene: { id: INSERTED_SCENE_ID } });
    const { gate, trace } = makeGate(false);
    await mount(gate);
    await click(byText('执行：降维解释'));

    await click(byText('跳转过去'));
    expect(trace).toEqual(['endActiveSession', 'setCurrentSceneId']);
    expect(useStageStore.getState().currentSceneId).toBe(INSERTED_SCENE_ID);
  });

  it('闸门经 SceneRenderer 透传到 QuizView', async () => {
    generateRemediationScene.mockResolvedValue({ scene: { id: INSERTED_SCENE_ID } });
    const { gate } = makeGate(true);
    await mountViaSceneRenderer(gate);
    await click(byText('执行：降维解释'));

    await click(byText('跳转过去'));
    expect(gate, 'SceneRenderer 没把闸门传给 QuizView').toHaveBeenCalledWith(INSERTED_SCENE_ID);
  });

  it('生成失败：原样显示失败原因，执行按钮留着让人重来', async () => {
    generateRemediationScene.mockResolvedValue({ error: '补救内容未过事实审核放行线：断言 3 条判错' });
    await mount();
    await click(byText('执行：降维解释'));

    expect(banner().textContent).toContain('补救内容未过事实审核放行线：断言 3 条判错');
    expect(banner().textContent).not.toContain('已插入新场景');
    expect(findButton(byText('执行：降维解释')), '失败后必须还能再点一次').toBeDefined();
  });

  it('重新答题作废上一次的补救结果：不许把旧的「已插入」带到新一轮', async () => {
    // 上一次交卷已经插过一个补救场景
    generateRemediationScene.mockResolvedValue({ scene: { id: INSERTED_SCENE_ID } });
    await mount();
    await click(byText('执行：降维解释'));
    expect(banner().textContent).toContain('已插入新场景');

    // 重答 → 再交一次错卷
    await click(byText('quiz.retry'));
    await submitWrongAnswer();

    const text = banner().textContent ?? '';
    expect(text, '这一轮还没执行过，不该显示上一轮的插入结果').not.toContain('已插入新场景');
    expect(findButton(byText('执行：降维解释')), '新一轮必须能重新执行').toBeDefined();
  });

  /**
   * WO-H4 第 4 件：补救链 2.5–10 分钟（F1 实测 155/164/593 秒），
   * 界面原来整段只有按钮上一句「生成中…」。这里钉住阶段行：
   * 生成期间在，报的是链上真回调过来的阶段名，跑完消失。
   */
  it('生成期间显示当前阶段与耗时预期，跑完收走', async () => {
    let reportPhase: ((phase: string) => void) | null = null;
    let finish: (() => void) | null = null;
    generateRemediationScene.mockImplementation((params: { onPhase?: (p: string) => void }) => {
      reportPhase = params.onPhase ?? null;
      return new Promise((resolve) => {
        finish = () => resolve({ scene: { id: INSERTED_SCENE_ID } });
      });
    });
    await mount();
    await click(byText('执行：降维解释'));

    const phaseLine = () => host!.querySelector('[data-testid="remediation-phase"]');
    expect(phaseLine(), '点了执行就该有阶段行').not.toBeNull();
    expect(phaseLine()!.textContent).toContain('通常 3–10 分钟');

    await act(async () => {
      reportPhase!('事实审核');
    });
    expect(phaseLine()!.textContent).toContain('当前阶段：事实审核');

    await act(async () => {
      finish!();
      await Promise.resolve();
    });
    expect(phaseLine(), '生成结束后阶段行不该留着').toBeNull();
  });

  it('重新答题作废上一次的失败提示：不许把旧的「执行失败」带到新一轮', async () => {
    generateRemediationScene.mockResolvedValue({ error: '补救内容规划失败（HTTP 500）' });
    await mount();
    await click(byText('执行：降维解释'));
    expect(banner().textContent).toContain('执行失败');

    await click(byText('quiz.retry'));
    await submitWrongAnswer();

    expect(banner().textContent ?? '').not.toContain('执行失败');
  });
});
