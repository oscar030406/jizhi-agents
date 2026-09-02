// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { loadAccountProfile, useAccountProfile } from '@/lib/knowledge/account-profile';

const response = (body: unknown, status: number) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('account profile server-first loader', () => {
  it('登录态只采用 /api/profile 的当前账户画像，不读取旧 localStorage', async () => {
    const local = vi.fn(() => ({ domain: 'ai', corpus: 'ai' }));
    const fetcher = vi.fn(async () =>
      response({ fields: { domain: 'smart-manufacturing', corpus: 'smart-manufacturing' } }, 200),
    );

    const state = await loadAccountProfile(local, fetcher as typeof fetch);

    expect(state).toEqual({
      kind: 'ready',
      source: 'server',
      profile: { domain: 'smart-manufacturing', corpus: 'smart-manufacturing' },
    });
    expect(local).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith('/api/profile', { cache: 'no-store' });
  });

  it('只有明确匿名 401 才读取本地画像', async () => {
    const local = vi.fn(() => ({ domain: 'ai', corpus: 'ai' }));

    await expect(
      loadAccountProfile(
        local,
        vi.fn(async () => response({ error: '未登录' }, 401)) as typeof fetch,
      ),
    ).resolves.toEqual({
      kind: 'ready',
      source: 'anonymous-local',
      profile: { domain: 'ai', corpus: 'ai' },
    });
    expect(local).toHaveBeenCalledOnce();
  });

  it.each([403, 500])('服务端返回 %s 时显式失败，绝不回退 localStorage', async (status) => {
    const local = vi.fn(() => ({ domain: 'ai', corpus: 'ai' }));

    const state = await loadAccountProfile(
      local,
      vi.fn(async () => response({ error: 'profile unavailable' }, status)) as typeof fetch,
    );

    expect(state).toMatchObject({ kind: 'error' });
    expect(local).not.toHaveBeenCalled();
  });

  it('父组件重渲染产生新回调身份时不重复请求 /api/profile', async () => {
    const fetcher = vi.fn(async () => response({ fields: { domain: 'ai' } }, 200));
    vi.stubGlobal('fetch', fetcher);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    function Probe({ renderId }: { renderId: number }) {
      const state = useAccountProfile(() => ({ domain: `local-${renderId}` }));
      return createElement('span', null, state.kind);
    }

    await act(async () => {
      root.render(createElement(Probe, { renderId: 1 }));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(createElement(Probe, { renderId: 2 }));
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/profile', { cache: 'no-store' });

    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
});
