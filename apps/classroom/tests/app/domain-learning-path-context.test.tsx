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

    await act(async () => root.render(<DomainLearningPath>AI 策展路径正文</DomainLearningPath>));
    await flush();
    expect(host.textContent).toContain('AI 策展路径正文');
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
});
