// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { PathOrDomainCard } from '@/components/home/learning-overview';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

it('首页按当前领域读取引擎路径且展示个性化摘要', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          success: true,
          path: {
            source: 'intake',
            label: '智能制造',
            stages: [
              {
                title: '入门',
                concepts: [{ name: '工业视觉检测', status: 'current' }],
              },
            ],
            personalization: { counts: { mastered: 1, current: 1, future: 3 } },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(<PathOrDomainCard corpus="smart-manufacturing" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(requests).toEqual(['/api/domain-path/smart-manufacturing']);
  expect(host.textContent).toContain('智能制造 · 我的学习路径');
  expect(host.textContent).toContain('工业视觉检测');
  expect(host.textContent).toContain('已会 1 · 当前 1 · 待学 3');
  expect(host.textContent).not.toContain('学习路径目前只覆盖人工智能');

  act(() => root.unmount());
  host.remove();
});
