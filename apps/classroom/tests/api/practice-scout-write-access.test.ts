import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const access = vi.hoisted(() => ({ requireCorpusVisible: vi.fn() }));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: access.requireCorpusVisible,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const params = { params: Promise.resolve({ corpus: 'private-a' }) };

beforeEach(() => {
  process.env.GROUNDING_URL = 'http://engine.test';
  access.requireCorpusVisible.mockResolvedValue({ ok: true, visible: () => true });
  vi.unstubAllGlobals();
});

describe('practice-scout 写接口 corpus 权限', () => {
  it('draft GET/POST 在鉴权失败时均不访问引擎', async () => {
    access.requireCorpusVisible.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false }), { status: 403 }),
    });
    const engine = vi.fn();
    vi.stubGlobal('fetch', engine);
    const route = await import('@/app/api/practice-scout/[corpus]/draft/route');

    expect((await route.GET({} as NextRequest, params)).status).toBe(403);
    expect(
      (
        await route.POST(
          new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest,
          params,
        )
      ).status,
    ).toBe(403);
    expect(access.requireCorpusVisible).toHaveBeenCalledWith('private-a', { manage: true });
    expect(engine).not.toHaveBeenCalled();
  });

  it('approve 在鉴权失败时不读取请求体也不访问引擎', async () => {
    access.requireCorpusVisible.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false }), { status: 403 }),
    });
    const engine = vi.fn();
    vi.stubGlobal('fetch', engine);
    const { POST } = await import('@/app/api/practice-scout/[corpus]/approve/route');
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectIds: ['p1'] }),
    }) as NextRequest;

    expect((await POST(request, params)).status).toBe(403);
    expect(access.requireCorpusVisible).toHaveBeenCalledWith('private-a', { manage: true });
    expect(engine).not.toHaveBeenCalled();
  });
});
