// @vitest-environment jsdom
/**
 * 场景切换闸门的两段透传（ACCEPTANCE 第四批遗留第 2 条）。
 *
 * 闸门 `gatedSceneSwitch` 从 PlaybackChromeRoot 一路传到 QuizView 的「跳转过去」：
 *   PlaybackChromeRoot → CanvasArea → SceneRenderer → QuizView
 * 后两段 `tests/quiz/remediation-insert.test.tsx` 已经钉住了，前两段没有——
 * 而 `onRequestSceneSwitch` 是可选 prop，**中间哪一层漏传，tsc 一个字都不会报**，
 * 结果是「跳转过去」悄悄退回直连 store：讨论会话不收、SSE 不断。
 *
 * 这里各钉一段：
 * - CanvasArea 那段真渲染，断言 SceneRenderer 收到的就是传进去的那个函数；
 * - PlaybackChromeRoot 那段读源码断言。它是 1500 行、挂满 store 与 SSE 的壳，
 *   在 jsdom 里挂起来的成本远大于这条线的价值；读源码换来的保证弱一些，
 *   但删掉那一行照样红——比没有测试强。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'zh-CN', setLocale: () => {} }),
}));

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t, tag: string) =>
          function MotionStub({ children }: { children?: unknown }) {
            return React.createElement(tag, null, children as never);
          },
      },
    ),
    AnimatePresence: ({ children }: { children?: unknown }) =>
      React.createElement(React.Fragment, null, children as never),
  };
});

// 画布里除 SceneRenderer 以外的挂件与本条线无关，一律置空。
vi.mock('@/components/whiteboard', () => ({ Whiteboard: () => null }));
vi.mock('@/components/canvas/canvas-toolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('@/components/scene-renderers/classroom-complete', () => ({
  ClassroomCompletePageConnected: () => null,
}));
vi.mock('@/components/generation/workshop-feed', () => ({ WorkshopFeed: () => null }));
vi.mock('@/components/lecture-view', () => ({ LectureView: () => null }));
vi.mock('@/components/generation/live-lecture-draft', () => ({ LiveLectureDraft: () => null }));

/** SceneRenderer 换成收件箱：只记下它拿到的 props。 */
const received: Array<Record<string, unknown>> = [];
vi.mock('@/components/stage/scene-renderer', () => ({
  SceneRenderer: (props: Record<string, unknown>) => {
    received.push(props);
    return null;
  },
}));

import { CanvasArea } from '@/components/canvas/canvas-area';
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SCENE = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: '温度参数',
  type: 'quiz',
  content: { questions: [] },
} as unknown as Scene;

const TOOLBAR = {
  currentSceneIndex: 0,
  scenesCount: 1,
  engineState: 'idle',
  whiteboardOpen: false,
  onPrevSlide: () => {},
  onNextSlide: () => {},
  onPlayPause: () => {},
  onWhiteboardClose: () => {},
} as const;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  received.length = 0;
});

function mount(gate?: (sceneId: string) => Promise<boolean>) {
  // SceneProvider 是非受控的：store 里没有当前场景它就渲染 null，子树整棵不挂。
  useStageStore.setState({ scenes: [SCENE], currentSceneId: SCENE.id });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <CanvasArea
        {...TOOLBAR}
        currentScene={SCENE}
        mode="playback"
        hideToolbar
        onRequestSceneSwitch={gate}
      />,
    );
  });
}

describe('CanvasArea → SceneRenderer 闸门透传', () => {
  it('把闸门原样交给 SceneRenderer', () => {
    const gate = vi.fn(async () => true);
    mount(gate);
    expect(received).toHaveLength(1);
    // 断言是同一个函数引用，不是「有个函数」——包一层 wrapper 会丢掉闸门语义。
    expect(received[0].onRequestSceneSwitch).toBe(gate);
  });

  it('没有闸门时如实传 undefined（Pro 编辑器那条无会话的路）', () => {
    mount(undefined);
    expect(received).toHaveLength(1);
    expect(received[0].onRequestSceneSwitch).toBeUndefined();
  });
});

describe('PlaybackChromeRoot → CanvasArea 闸门透传', () => {
  it('CanvasArea 拿到的是 gatedSceneSwitch 本尊', () => {
    const src = readFileSync(
      resolve(__dirname, '../../components/edit/PlaybackChromeRoot.tsx'),
      'utf8',
    );
    expect(src).toMatch(/onRequestSceneSwitch=\{\s*gatedSceneSwitch\s*\}/);
  });
});
