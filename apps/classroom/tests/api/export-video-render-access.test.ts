import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  proxyFetch: vi.fn(),
  resolveRenderServiceUrl: vi.fn(),
}));

vi.mock('@/lib/accounts/store', () => ({ accountForSession: mocks.accountForSession }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));
vi.mock('@/lib/server/render-service', () => ({
  resolveRenderServiceUrl: mocks.resolveRenderServiceUrl,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let ownersDir: string;

function request(method: string, pathname: string, token?: string, body?: BodyInit): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: token ? { cookie: `jizhi_session=${token}` } : undefined,
    body,
  });
}

function submitRequest(token?: string): NextRequest {
  const form = new FormData();
  form.set('project', new Blob(['PK']), 'course.zip');
  return request('POST', '/api/export-video/render', token, form);
}

function anonymousRequest(method: string, pathname: string, anonymousId: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: { cookie: `jizhi_render_anon=${anonymousId}` },
  });
}

function anonymousIdFrom(response: Response): string {
  const match = response.headers.get('set-cookie')?.match(/jizhi_render_anon=([^;]+)/);
  if (!match) throw new Error('Missing anonymous render cookie');
  return decodeURIComponent(match[1]);
}

beforeAll(async () => {
  ownersDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jizhi-render-owners-'));
  process.env.RENDER_JOB_OWNERS_DIR = ownersDir;
});

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.rm(ownersDir, { recursive: true, force: true });
  await fs.mkdir(ownersDir, { recursive: true });
  mocks.resolveRenderServiceUrl.mockReturnValue({ url: 'http://render-service' });
  mocks.accountForSession.mockImplementation(async (token?: string) => {
    if (token === 'owner-token') return { id: 'acct-owner' };
    if (token === 'other-token') return { id: 'acct-other' };
    return null;
  });
});

afterAll(async () => {
  delete process.env.RENDER_JOB_OWNERS_DIR;
  await fs.rm(ownersDir, { recursive: true, force: true });
});

describe('export-video render job ownership', () => {
  it('提交任务时记录当前账户并把账户作为渲染限流身份', async () => {
    mocks.proxyFetch.mockResolvedValueOnce(Response.json({ jobId: 'owned-job' }, { status: 202 }));
    const { POST } = await import('@/app/api/export-video/render/route');
    const { readRenderJobOwner } = await import('@/lib/server/render-job-owner-store');

    const response = await POST(submitRequest('owner-token'));

    expect(response.status).toBe(202);
    expect(await readRenderJobOwner('owned-job')).toBe('account:acct-owner');
    expect(mocks.proxyFetch.mock.calls[0][1].headers['x-openmaic-client']).toBe(
      'account:acct-owner',
    );
  });

  it('匿名任务落稳定命名空间，只有同一匿名主体可查询', async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce(Response.json({ jobId: 'public-job' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ jobId: 'public-job', status: 'running' }));
    const { POST } = await import('@/app/api/export-video/render/route');
    const { GET } = await import('@/app/api/export-video/render/[jobId]/route');
    const { readRenderJobOwner } = await import('@/lib/server/render-job-owner-store');

    const submitted = await POST(submitRequest());
    expect(submitted.status).toBe(202);
    const anonymousId = anonymousIdFrom(submitted);
    expect(await readRenderJobOwner('public-job')).toBe(`anon:${anonymousId}`);

    const missingCookie = await GET(request('GET', '/api/export-video/render/public-job'), {
      params: Promise.resolve({ jobId: 'public-job' }),
    });
    const otherAnonymous = await GET(
      anonymousRequest('GET', '/api/export-video/render/public-job', crypto.randomUUID()),
      { params: Promise.resolve({ jobId: 'public-job' }) },
    );
    const owner = await GET(
      anonymousRequest('GET', '/api/export-video/render/public-job', anonymousId),
      { params: Promise.resolve({ jobId: 'public-job' }) },
    );

    expect([missingCookie.status, otherAnonymous.status, owner.status]).toEqual([404, 404, 200]);
  });

  it('归属记录缺失时查询、取消、下载全部 fail closed', async () => {
    const jobRoute = await import('@/app/api/export-video/render/[jobId]/route');
    const downloadRoute = await import('@/app/api/export-video/render/[jobId]/download/route');
    const context = { params: Promise.resolve({ jobId: 'missing-owner' }) };

    const responses = await Promise.all([
      jobRoute.GET(request('GET', '/api/export-video/render/missing-owner'), context),
      jobRoute.DELETE(request('DELETE', '/api/export-video/render/missing-owner'), context),
      downloadRoute.GET(
        request('GET', '/api/export-video/render/missing-owner/download'),
        context,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('上游已创建但归属记录写失败时尽力取消并返回失败', async () => {
    const blockedDir = path.join(ownersDir, 'not-a-directory');
    await fs.writeFile(blockedDir, 'block mkdir');
    process.env.RENDER_JOB_OWNERS_DIR = blockedDir;
    mocks.proxyFetch
      .mockResolvedValueOnce(Response.json({ jobId: 'orphan-job' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }));
    const { POST } = await import('@/app/api/export-video/render/route');
    const jobRoute = await import('@/app/api/export-video/render/[jobId]/route');

    const response = await POST(submitRequest('owner-token'));
    process.env.RENDER_JOB_OWNERS_DIR = ownersDir;

    expect(response.status).toBe(502);
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(2);
    expect(mocks.proxyFetch.mock.calls[1][0]).toBe(
      'http://render-service/render/orphan-job',
    );
    expect(mocks.proxyFetch.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });

    const inaccessible = await jobRoute.GET(
      request('GET', '/api/export-video/render/orphan-job', 'owner-token'),
      { params: Promise.resolve({ jobId: 'orphan-job' }) },
    );
    expect(inaccessible.status).toBe(404);
    expect(mocks.proxyFetch).toHaveBeenCalledTimes(2);
  });

  it('其他账户查询、取消、下载同一律 404 且不触达渲染服务', async () => {
    const { recordRenderJobOwner } = await import('@/lib/server/render-job-owner-store');
    const jobRoute = await import('@/app/api/export-video/render/[jobId]/route');
    const downloadRoute = await import('@/app/api/export-video/render/[jobId]/download/route');
    await recordRenderJobOwner('private-job', 'account:acct-owner');
    const context = { params: Promise.resolve({ jobId: 'private-job' }) };

    const responses = await Promise.all([
      jobRoute.GET(request('GET', '/api/export-video/render/private-job', 'other-token'), context),
      jobRoute.DELETE(
        request('DELETE', '/api/export-video/render/private-job', 'other-token'),
        context,
      ),
      downloadRoute.GET(
        request('GET', '/api/export-video/render/private-job/download', 'other-token'),
        context,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it('任务所属账户可查询、取消和下载', async () => {
    const { recordRenderJobOwner } = await import('@/lib/server/render-job-owner-store');
    const jobRoute = await import('@/app/api/export-video/render/[jobId]/route');
    const downloadRoute = await import('@/app/api/export-video/render/[jobId]/download/route');
    await recordRenderJobOwner('private-job', 'account:acct-owner');
    mocks.proxyFetch
      .mockResolvedValueOnce(Response.json({ jobId: 'private-job', status: 'running' }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-length': '3' },
        }),
      );
    const context = { params: Promise.resolve({ jobId: 'private-job' }) };

    const status = await jobRoute.GET(
      request('GET', '/api/export-video/render/private-job', 'owner-token'),
      context,
    );
    const cancel = await jobRoute.DELETE(
      request('DELETE', '/api/export-video/render/private-job', 'owner-token'),
      context,
    );
    const download = await downloadRoute.GET(
      request('GET', '/api/export-video/render/private-job/download', 'owner-token'),
      context,
    );

    expect([status.status, cancel.status, download.status]).toEqual([200, 200, 200]);
  });
});
