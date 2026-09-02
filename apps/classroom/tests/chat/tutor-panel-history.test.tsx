// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * 导学多轮：上一轮的判定必须进下一轮的请求。
 *
 * 引擎是无状态的——「第二问该降维还是推进」完全由客户端回传的 `lectureHistory`
 * 决定（引擎侧 `_lecture_decision(corrects)`：空历史 → probe「这是本节第一问」，
 * 末轮判错 → simplify）。所以只要面板把历史丢了或回传空，第二问就会被标成
 * 「探测提问」、理由行写「这是本节第一问」——摸底 §2.6 看到的正是这个画面。
 *
 * 这条测试钉的是**出站请求体**，不是渲染文案：标签是引擎按历史算的，
 * 客户端只有把历史送到才有正确标签可用。
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('@/lib/evidence', () => ({
  appendEvidence: vi.fn(async () => {}),
  evidenceFor: () => [],
  readLedger: vi.fn(async () => ({})),
  LEGACY_DOMAIN: 'ai',
}));
vi.mock('@/lib/evidence/from-tutor', () => ({ tutorEvidenceDraft: () => null }));
vi.mock('@/lib/evidence/profile-bridge', () => ({
  courseDomain: vi.fn(async () => 'ai'),
  refreshDerivedProfile: vi.fn(async () => {}),
}));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: async () => 'anon:test' }));

import { TutorPanel } from '@/components/chat/tutor-panel';
import { useStageStore } from '@/lib/store';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SCENE = {
  id: 'scene-1',
  title: 'Q/K/V 核心概念',
  content: {
    canvas: {
      elements: [
        {
          type: 'text',
          content: '注意力机制有三个核心变量：Query、Key 和 Value。',
          top: 0,
          left: 0,
        },
      ],
    },
  },
};

const ASK_1 = {
  mode: 'ask',
  question: 'Q/K/V 分别起什么作用？',
  expected_points: ['Q 是查询'],
  because: ['从当前讲义节「Q/K/V 核心概念」现生成定向检查问题：这是本节第一问……'],
  decision_type: 'probe',
  engine: 'llm',
};
const VERDICT = {
  mode: 'verdict',
  verdict: 'incorrect',
  because: ['没答到 Q 的作用'],
  explanation: 'Q 是查询向量',
  quote: '',
  decision_type: 'simplify',
  engine: 'llm',
  mastery_estimate: 0,
  asked: 1,
  correct: 0,
};
const ASK_2 = {
  mode: 'ask',
  question: '先只说 Query：它代表谁在提问？',
  expected_points: ['Query 是当前关注的目标'],
  because: ['从当前讲义节「Q/K/V 核心概念」现生成降维小切口问题：上一问学习者没答到位……'],
  decision_type: 'simplify',
  engine: 'llm',
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let tutorBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  // jsdom 没有 scrollIntoView
  (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  tutorBodies = [];
  const queue = [ASK_1, VERDICT, ASK_2];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return { ok: true, status: 200, json: async () => ({ engineBridge: 'ok' }) } as Response;
      }
      if (url.includes('/api/tutor')) {
        tutorBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, ...(queue.shift() ?? ASK_2) }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
  useStageStore.setState({
    scenes: [SCENE],
    stage: { id: 'stage-1', name: 'Transformer 注意力机制详解' },
  } as never);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

const clickText = async (text: string) => {
  const btn = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!btn)
    throw new Error(
      `没找到按钮「${text}」；现有：${JSON.stringify(
        [...host!.querySelectorAll('button')].map((b) => b.textContent),
      )}`,
    );
  await act(async () => btn.click());
};

describe('导学连问两轮', () => {
  it('只把当前课程领域的难度和掌握度送给导学引擎', async () => {
    localStorage.setItem(
      'learnerProfile',
      JSON.stringify({
        domain: 'ai',
        corpus: 'ai',
        currentDifficulty: 'L4',
        conceptMastery: { [SCENE.title]: 0.99 },
        currentDifficultyByDomain: { ai: 'L4', 'smart-manufacturing': 'L1' },
        conceptMasteryByDomain: {
          ai: { [SCENE.title]: 0.99 },
          'smart-manufacturing': { [SCENE.title]: 0.2 },
        },
      }),
    );
    useStageStore.setState({
      stage: {
        id: 'stage-1',
        name: '智能制造课程',
        origin: { corpus: 'smart-manufacturing', domain: 'smart-manufacturing' },
      },
    } as never);

    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<TutorPanel currentSceneId="scene-1" />);
    });
    await clickText('让导师考考我');

    expect(tutorBodies[0].recommendedDifficulty).toBe('L1');
    expect(tutorBodies[0].priorMastery).toBe(0.2);
  });

  it('第二问的请求必须带上第一轮的判定', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<TutorPanel currentSceneId="scene-1" />);
    });

    await clickText('让导师考考我');
    expect(tutorBodies).toHaveLength(1);
    expect(tutorBodies[0].lectureHistory).toEqual([]);

    const textarea = host!.querySelector('textarea');
    expect(textarea, '第一问出来后应该有作答框').not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea!, '不知道');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickText('提交回答');

    // 判分轮 + 紧接着的第二问，两条请求
    expect(tutorBodies).toHaveLength(3);
    expect(tutorBodies[1].learnerAnswer).toBe('不知道');

    const secondAsk = tutorBodies[2];
    expect(secondAsk.learnerAnswer, '第 3 条应是出题轮，不带作答').toBeUndefined();
    expect(
      secondAsk.lectureHistory,
      '第二问必须带上一轮判定，否则引擎按空历史算，标签退回「探测提问」',
    ).toEqual([
      {
        question: 'Q/K/V 分别起什么作用？',
        answer: '不知道',
        verdict: 'incorrect',
        // 提示阶梯上线后每一轮各自带代价。这一轮没要过提示，所以是 0——
        // 引擎按它逐轮压档，不带的话回放历史会把看过答案的轮重新算成真会了。
        hints_used: 0,
      },
    ]);

    // 引擎按历史给出的 simplify 标签要真的渲染出来，理由行不再是「第一问」
    expect(host!.textContent).toContain('降维追问');
    expect(host!.textContent).toContain('降维小切口问题');
  });
});
