import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const access = vi.hoisted(() => ({ requireCorpusVisible: vi.fn() }));
const course = vi.hoisted(() => ({
  corpusOwnership: vi.fn(),
  readCourseDomains: vi.fn(),
  listClassrooms: vi.fn(),
  readClassroom: vi.fn(),
  canReadCourse: vi.fn(),
}));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: access.requireCorpusVisible,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/accounts/org-store', () => ({ corpusOwnership: course.corpusOwnership }));
vi.mock('@/lib/server/course-domains', () => ({ readCourseDomains: course.readCourseDomains }));
vi.mock('@/lib/server/classroom-storage', () => ({
  listClassrooms: course.listClassrooms,
  readClassroom: course.readClassroom,
}));
vi.mock('@/lib/server/course-access', () => ({ canReadCourse: course.canReadCourse }));

const params = { params: Promise.resolve({ corpus: 'private-a' }) };

beforeEach(() => {
  process.env.GROUNDING_URL = 'http://engine.test';
  access.requireCorpusVisible.mockResolvedValue({
    ok: true,
    account: { id: 'manager-a' },
    org: { id: 'org-a', memberRole: 'owner' },
    visible: () => true,
  });
  course.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));
  course.readCourseDomains.mockResolvedValue({});
  course.listClassrooms.mockResolvedValue([]);
  course.readClassroom.mockResolvedValue(null);
  course.canReadCourse.mockReturnValue(false);
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

  it('draft POST 只把本域、管理者可读且已发布课程候选交给引擎', async () => {
    course.readCourseDomains.mockResolvedValue({
      visible: { domain: 'private-a', title: '可见课' },
      denied: { domain: 'private-a', title: '不可见课' },
      foreign: { domain: 'private-b', title: '其它域课' },
    });
    course.listClassrooms.mockResolvedValue([
      { id: 'visible', title: '可见课' },
      { id: 'denied', title: '不可见课' },
      { id: 'foreign', title: '其它域课' },
    ]);
    course.readClassroom.mockImplementation(async (id: string) => ({ id, stage: {}, scenes: [] }));
    course.canReadCourse.mockImplementation((id: string) => id === 'visible');
    let forwarded: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ corpus: 'private-a', projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const { POST } = await import('@/app/api/practice-scout/[corpus]/draft/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ count: 7, courses: [{ id: 'forged', title: '客户端伪造' }] }),
      }) as NextRequest,
      params,
    );

    expect(response.status).toBe(200);
    expect(course.listClassrooms).toHaveBeenCalledWith({ learnerReleasedOnly: true });
    expect(forwarded).toEqual({ count: 7, courses: [{ id: 'visible', title: '可见课' }] });
  });

  it('approve 不信任客户端课程，发布前重新读取当前本域可见课程', async () => {
    course.readCourseDomains.mockResolvedValue({
      visible: { domain: 'private-a' },
      foreign: { domain: 'private-b' },
    });
    course.listClassrooms.mockResolvedValue([
      { id: 'visible', title: '当前可见课' },
      { id: 'foreign', title: '其它域课' },
    ]);
    course.readClassroom.mockImplementation(async (id: string) => ({ id, stage: {}, scenes: [] }));
    course.canReadCourse.mockImplementation((id: string) => id === 'visible');
    let forwarded: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            current_version: 1,
            release: { version: 1, status: 'published', projects: [{ id: 'p1' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { POST } = await import('@/app/api/practice-scout/[corpus]/approve/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          projectIds: ['p1'],
          draftSnapshotId: `sha256:${'a'.repeat(64)}`,
          courses: [{ id: 'forged', title: '客户端伪造' }],
        }),
      }) as NextRequest,
      params,
    );

    expect(response.status).toBe(200);
    expect(forwarded).toEqual({
      projectIds: ['p1'],
      draftSnapshotId: `sha256:${'a'.repeat(64)}`,
      courses: [{ id: 'visible', title: '当前可见课' }],
    });
    expect(await response.json()).toMatchObject({ publication: { current_version: 1 } });
  });

  it('restore 只接受正整数版本，并按当前本域课程复验历史快照', async () => {
    course.readCourseDomains.mockResolvedValue({ visible: { domain: 'private-a' } });
    course.listClassrooms.mockResolvedValue([{ id: 'visible', title: '当前可见课' }]);
    course.readClassroom.mockResolvedValue({ id: 'visible', stage: {}, scenes: [] });
    course.canReadCourse.mockReturnValue(true);
    let forwarded: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            current_version: 3,
            release: { version: 3, restored_from_version: 1, projects: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { POST } = await import('@/app/api/practice-scout/[corpus]/restore/route');
    const invalid = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ version: 0 }),
      }) as NextRequest,
      params,
    );
    expect(invalid.status).toBe(400);

    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ version: 1, courses: [{ id: 'forged' }] }),
      }) as NextRequest,
      params,
    );
    expect(response.status).toBe(200);
    expect(forwarded).toEqual({
      version: 1,
      courses: [{ id: 'visible', title: '当前可见课' }],
    });
  });

  it('releases 只有库管理者可读且原样返回版本摘要', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ current_version: 2, versions: [{ version: 2, status: 'published' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { GET } = await import('@/app/api/practice-scout/[corpus]/releases/route');
    const response = await GET({} as Request, params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      publication: { current_version: 2, versions: [{ version: 2 }] },
    });
    expect(access.requireCorpusVisible).toHaveBeenCalledWith('private-a', { manage: true });
  });

  it('draft POST 只有真实超时返回 504，且不声称任务仍在运行', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new DOMException('timeout', 'TimeoutError'))),
    );
    const { POST } = await import('@/app/api/practice-scout/[corpus]/draft/route');
    const response = await POST(
      new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest,
      params,
    );
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(JSON.stringify(body)).toContain('无法确认');
    expect(JSON.stringify(body)).not.toContain('仍在进行中');
  });

  it('draft POST 网络故障返回 502，不伪装成超时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connection refused'))),
    );
    const { POST } = await import('@/app/api/practice-scout/[corpus]/draft/route');
    const response = await POST(
      new Request('http://localhost', { method: 'POST', body: '{}' }) as NextRequest,
      params,
    );

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).toContain('connection refused');
  });
});
