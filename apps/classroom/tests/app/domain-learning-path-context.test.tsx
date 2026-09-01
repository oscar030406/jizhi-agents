// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectiveDomainContextState } from '@/lib/knowledge/use-domain-context';

let contextState: EffectiveDomainContextState = { kind: 'loading' };

vi.mock('@/lib/knowledge/use-domain-context', () => ({
  useEffectiveDomainContext: () => contextState,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => {
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
  it('AI 学员继续看到原 AI 策展路径', async () => {
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
              source: 'curated',
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
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<DomainLearningPath>AI 策展路径正文</DomainLearningPath>));
    await flush();
    await flush();
    expect(host.textContent).toContain('AI 策展路径正文');
    expect(host.textContent).toContain('我的当前路线');
    expect(host.textContent).toContain('模块一 · 大模型基础');
    expect(host.textContent).toContain('当前推荐：线性代数核心三要素');
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
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<DomainLearningPath>AI 策展路径正文</DomainLearningPath>));
    await flush();
    await flush();

    expect(host.textContent).toContain('这是当前账户自己的路线');
    expect(host.textContent).toContain('PLC 基础已掌握');
    expect(host.textContent).toContain('顺序控制当前推荐');
    expect(host.textContent).toContain('产线联调后续节点');
  });
});
