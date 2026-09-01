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
    expect(await readRenderJobOwner('owned-job')).toBe('acct-owner');
    expect(mocks.proxyFetch.mock.calls[0][1].headers['x-openmaic-client']).toBe('acct-owner');
  });

  it('匿名任务不落 owner，仍凭 jobId 查询', async () => {
    mocks.proxyFetch
      .mockResolvedValueOnce(Response.json({ jobId: 'public-job' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ jobId: 'public-job', status: 'running' }));
    const { POST } = await import('@/app/api/export-video/render/route');
    const { GET } = await import('@/app/api/export-video/render/[jobId]/route');
    const { readRenderJobOwner } = await import('@/lib/server/render-job-owner-store');

    expect((await POST(submitRequest())).status).toBe(202);
    expect(await readRenderJobOwner('public-job')).toBeNull();
    const response = await GET(request('GET', '/api/export-video/render/public-job'), {
      params: Promise.resolve({ jobId: 'public-job' }),
    });
    expect(response.status).toBe(200);
  });

  it('其他账户查询、取消、下载同一律 404 且不触达渲染服务', async () => {
    const { recordRenderJobOwner } = await import('@/lib/server/render-job-owner-store');
    const jobRoute = await import('@/app/api/export-video/render/[jobId]/route');
    const downloadRoute = await import('@/app/api/export-video/render/[jobId]/download/route');
    await recordRenderJobOwner('private-job', 'acct-owner');
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
    await recordRenderJobOwner('private-job', 'acct-owner');
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
