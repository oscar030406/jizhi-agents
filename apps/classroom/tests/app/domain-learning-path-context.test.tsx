// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectiveDomainContextState } from '@/lib/knowledge/use-domain-context';
import type { AccountProfileState } from '@/lib/knowledge/account-profile';

let contextState: EffectiveDomainContextState = { kind: 'loading' };
let accountProfileState: AccountProfileState = {
  kind: 'ready',
  source: 'server',
  profile: { domain: 'ai', corpus: 'ai' },
};

vi.mock('@/lib/knowledge/use-domain-context', () => ({
  useEffectiveDomainContext: () => contextState,
}));
vi.mock('@/lib/knowledge/account-profile', () => ({
  useAccountProfile: () => accountProfileState,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom 没有 ResizeObserver，概念图用的 @xyflow/react 一挂载就要它。图的排版本身
// 在 concept-graph-layout.test.ts 里单测，这里只要它别把整棵树炸掉。
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { DomainLearningPath } = await import('@/components/path/domain-learning-path');

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let host: HTMLElement;
let root: Root;

/**
 * 切到「前置图（2D）」。/path 默认开在 3D 的知识宇宙上（那张图是 WebGL 画的，
 * jsdom 里建不出来），本文件断言的都是 2D 前置图的内容，先按一下 tab。
 */
async function switchToPrereqGraph() {
  const tab = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === '前置图（2D）',
  );
  expect(tab, '找不到「前置图（2D）」切换按钮').toBeTruthy();
  await act(async () => {
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  accountProfileState = {
    kind: 'ready',
    source: 'server',
    profile: { domain: 'ai', corpus: 'ai' },
  };
  window.localStorage.setItem('learnerProfile', JSON.stringify({ domain: 'ai', corpus: 'ai' }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('/path effective domain', () => {
  it('账户画像接口失败时显式停止，不读取本地旧画像路径', async () => {
    accountProfileState = { kind: 'error', reason: '当前账户画像暂时无法读取；未使用本地旧画像。' };
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await act(async () => root.render(<DomainLearningPath />));
    await flush();

    expect(host.textContent).toContain('当前账户画像暂时无法读取');
    expect(host.textContent).toContain('未使用本地旧画像');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AI 学员也只展示引擎根据索引与前置图生成的路径', async () => {
    contextState = {
      kind: 'ready',
      context: {
        domain: 'ai',
        source: 'profile-domain',
        status: 'ready',
        isAi: true,
        registered: true,
      },
    };

    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        if (url === '/api/domain-path/ai') {
          return ok({
            success: true,
            path: {
              corpus: 'ai',
              label: '人工智能应用开发',
              source: 'index-graph',
              stages: [
                {
                  index: 1,
                  title: '模块一 · 大模型基础',
                  status: 'current',
                  concepts: [
                    { name: 'Python 零基础第一课', depth: 0, status: 'mastered' },
                    { name: '线性代数核心三要素', depth: 0, status: 'current' },
                  ],
                },
              ],
              personalization: {
                matched_mastery: 1,
                counts: { mastered: 1, current: 1, future: 0 },
                current: ['线性代数核心三要素'],
              },
            },
          });
        }
        if (url === '/api/course-domains') return ok({});
        if (url.startsWith('/api/course-path/')) return ok({ courses: {} });
        if (url.startsWith('/api/knowledge-graph/'))
          return ok({ success: true, graph: { nodes: [], links: [] } });
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<DomainLearningPath>不应出现的手工路径</DomainLearningPath>));
    await flush();
    await flush();
    expect(host.textContent).not.toContain('不应出现的手工路径');
    expect(host.textContent).toContain('这条路径不是人工排的');
    expect(host.textContent).toContain('我的当前路线');
    expect(host.textContent).toContain('当前推荐：线性代数核心三要素');
    // 阶段卡没了，结构改由概念图承担：节点标签与左侧统计都要在。
    await switchToPrereqGraph();
    expect(host.textContent).toContain('节点总数');
    expect(host.textContent).toContain('Python 零基础第一课');
    expect(seen).toContain('/api/domain-path/ai');
  });

  it('智能制造指派覆盖残留 AI 画像，只向引擎请求智能制造路径', async () => {
    contextState = {
      kind: 'ready',
      context: {
        domain: 'smart-manufacturing',
        label: '智能制造：ROS2 与 S7-1200 PLC',
        source: 'course-assignment',
        status: 'ready',
        isAi: false,
        registered: true,
      },
    };
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        if (url === '/api/domain-path/smart-manufacturing') {
          return ok({
            success: true,
            path: {
              corpus: 'smart-manufacturing',
              label: '智能制造：ROS2 与 S7-1200 PLC',
              source: 'none',
              stages: [],
            },
          });
        }
        if (url === '/api/course-domains') return ok({});
        if (url.startsWith('/api/course-path/')) return ok({ courses: {} });
        if (url.startsWith('/api/knowledge-graph/'))
          return ok({ success: true, graph: { nodes: [], links: [] } });
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<DomainLearningPath>AI 策展路径正文</DomainLearningPath>));
    await flush();
    await flush();

    expect(host.textContent).not.toContain('AI 策展路径正文');
    expect(host.textContent).toContain('智能制造：ROS2 与 S7-1200 PLC');
    expect(host.textContent).toContain('所属机构尚未提供该领域的学习路径');
    expect(seen).toContain('/api/domain-path/smart-manufacturing');
    expect(seen).not.toContain('/api/domain-path/ai');
  });

  it('机构课程 unavailable 时只显示诚实缺失，不请求旧画像路径', async () => {
    contextState = {
      kind: 'ready',
      context: {
        domain: null,
        source: 'course-assignment',
        status: 'assignment-unavailable',
        isAi: false,
        registered: false,
        assignment: {
          id: 'asg-unavailable',
          courseId: 'course-mfg',
          availability: 'unavailable',
        },
        reason: '机构课程暂不可用：课程尚未通过发布审核。',
      },
    };
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await act(async () => root.render(<DomainLearningPath>旧 AI 路径</DomainLearningPath>));
    await flush();

    expect(host.textContent).toContain('机构课程暂不可用');
    expect(host.textContent).toContain('尚未通过发布审核');
    expect(host.textContent).not.toContain('旧 AI 路径');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('外域节点显示已掌握、当前推荐与后续状态', async () => {
    contextState = {
      kind: 'ready',
      context: {
        domain: 'smart-manufacturing',
        label: '智能制造',
        source: 'profile-corpus',
        status: 'ready',
        isAi: false,
        registered: true,
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/domain-path/smart-manufacturing') {
          return ok({
            success: true,
            path: {
              corpus: 'smart-manufacturing',
              label: '智能制造',
              source: 'intake',
              stages: [
                {
                  index: 1,
                  title: '第 1 阶',
                  status: 'current',
                  concepts: [
                    { name: 'PLC 基础', depth: 0, status: 'mastered', mastery: 0.9 },
                    { name: '顺序控制', depth: 1, status: 'current' },
                    { name: '产线联调', depth: 2, status: 'future' },
                  ],
                },
              ],
              personalization: {
                matched_mastery: 1,
                counts: { mastered: 1, current: 1, future: 1 },
                current: ['顺序控制'],
              },
            },
          });
        }
        if (url === '/api/course-domains') return ok({});
        if (url.startsWith('/api/course-path/')) return ok({ courses: {} });
        if (url.startsWith('/api/knowledge-graph/'))
          return ok({ success: true, graph: { nodes: [], links: [] } });
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<DomainLearningPath>AI 策展路径正文</DomainLearningPath>));
    await flush();
    await flush();

    expect(host.textContent).toContain('这是当前账户自己的路线');
    expect(host.textContent).toContain('当前推荐：顺序控制');
    expect(host.textContent).toContain('已掌握 1 · 当前推荐 1 · 后续 1');
    await switchToPrereqGraph();
    for (const name of ['PLC 基础', '顺序控制', '产线联调']) {
      expect(host.textContent).toContain(name);
    }
  });

  it('该 corpus 没有同 ID mastery_vector 时明确显示尚无匹配记录', async () => {
    contextState = {
      kind: 'ready',
      context: {
        domain: 'smart-manufacturing',
        label: '智能制造',
        source: 'profile-corpus',
        status: 'ready',
        isAi: false,
        registered: true,
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/domain-path/smart-manufacturing') {
          return ok({
            success: true,
            path: {
              corpus: 'smart-manufacturing',
              label: '智能制造',
              source: 'intake',
              stages: [
                {
                  index: 1,
                  title: '第 1 阶',
                  status: 'unmeasured',
                  concepts: [
                    { id: 'control-basics', name: '控制基础', depth: 0, status: 'unmeasured' },
                  ],
                },
              ],
              personalization: {
                mastery_corpus: 'smart-manufacturing',
                matched_mastery: 0,
                counts: { mastered: 0, current: 0, future: 0, unmeasured: 1 },
                current: [],
                reason: '当前账户在该领域尚无与路径概念 ID 同源的测评记录。',
              },
            },
          });
        }
        if (url === '/api/course-domains') return ok({});
        if (url.startsWith('/api/course-path/')) return ok({ courses: {} });
        if (url.startsWith('/api/knowledge-graph/'))
          return ok({ success: true, graph: { nodes: [], links: [] } });
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<DomainLearningPath>AI 策展路径正文</DomainLearningPath>));
    await flush();
    await flush();

    expect(host.textContent).toContain('尚无与路径概念 ID 同源的测评记录');
    expect(host.textContent).toContain('还没有同源测评，路线从第 1 阶的推荐概念开始：控制基础');
    expect(host.textContent).toContain('尚未测评');
    expect(host.textContent).not.toContain('已掌握 1');
  });
});
