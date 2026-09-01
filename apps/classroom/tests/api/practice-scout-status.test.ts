import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const access = vi.hoisted(() => ({
  requireCorpusVisible: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: access.requireCorpusVisible,
}));

const originalUrl = process.env.GROUNDING_URL;
const req = {} as NextRequest;

async function get(corpus = 'smart-manufacturing') {
  const { GET } = await import('@/app/api/practice-scout/[corpus]/route');
  return GET(req, { params: Promise.resolve({ corpus }) });
}

beforeEach(() => {
  process.env.GROUNDING_URL = 'http://engine.test';
  access.requireCorpusVisible.mockResolvedValue({ ok: true, visible: () => true });
});

afterEach(() => {
  process.env.GROUNDING_URL = originalUrl;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/practice-scout/[corpus] 生成状态', () => {
  it('引擎明确返回空项目时标为 missing，不伪造其它领域项目', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const response = await get();
    const body = (await response.json()) as {
      status: string;
      projects: unknown[];
      reason: string;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('missing');
    expect(body.projects).toEqual([]);
    expect(body.reason).toBe('所属机构尚未提供该领域的实操项目');
    expect(seen).toEqual(['http://engine.test/api/practice-scout/smart-manufacturing/published']);
  });

  it('引擎未配置时标为 unavailable，不把故障说成项目为空', async () => {
    delete process.env.GROUNDING_URL;

    const response = await get();
    const body = (await response.json()) as { status: string; projects: unknown[]; reason: string };

    expect(body.status).toBe('unavailable');
    expect(body.projects).toEqual([]);
    expect(body.reason).toContain('无法确认');
  });

  it('只把引擎已发布项目标为 ready 并原样返回', async () => {
    const projects = [{ id: 'mfg-1', title: '产线故障诊断' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ projects }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const body = (await (await get()).json()) as {
      status: string;
      projects: typeof projects;
      reason?: string;
    };
    expect(body.status).toBe('ready');
    expect(body.projects).toEqual(projects);
    expect(body.reason).toBeUndefined();
  });

  it('无权访问时拒绝且不调用引擎', async () => {
    access.requireCorpusVisible.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false }), { status: 403 }),
    });
    const engine = vi.fn();
    vi.stubGlobal('fetch', engine);

    expect((await get()).status).toBe(403);
    expect(engine).not.toHaveBeenCalled();
    expect(access.requireCorpusVisible).toHaveBeenCalledWith('smart-manufacturing');
  });
});
