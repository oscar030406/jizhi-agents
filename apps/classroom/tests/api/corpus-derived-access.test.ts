import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireCorpusVisible: vi.fn(),
  readCourseDomains: vi.fn(),
  readClassroom: vi.fn(),
  courseReaderForRequest: vi.fn(),
  canReadCourse: vi.fn(),
  corpusOwnership: vi.fn(),
  orgForAccount: vi.fn(),
  setCorpusOrg: vi.fn(),
  releaseCorpusOwnerMarker: vi.fn(),
}));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: mocks.requireCorpusVisible,
}));
vi.mock('@/lib/server/course-domains', () => ({ readCourseDomains: mocks.readCourseDomains }));
vi.mock('@/lib/server/classroom-storage', () => ({ readClassroom: mocks.readClassroom }));
vi.mock('@/lib/server/course-access', () => ({
  courseReaderForRequest: mocks.courseReaderForRequest,
  canReadCourse: mocks.canReadCourse,
}));
vi.mock('@/lib/accounts/org-store', () => ({
  corpusOwnership: mocks.corpusOwnership,
  orgForAccount: mocks.orgForAccount,
  setCorpusOrg: mocks.setCorpusOrg,
}));
vi.mock('@/lib/server/knowledge-center', () => ({
  isValidCorpusName: (name: string) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name),
  releaseCorpusOwnerMarker: mocks.releaseCorpusOwnerMarker,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireCorpusVisible.mockResolvedValue({
    ok: true,
    account: { id: 'owner-a' },
    visible: (corpus: string) => corpus !== 'private-b',
  });
  mocks.courseReaderForRequest.mockResolvedValue({
    accountId: 'owner-a',
    orgId: 'org-a',
    memberRole: 'owner',
    assignedCourseIds: new Set(),
  });
  mocks.canReadCourse.mockImplementation((id: string) => id !== 'otherCourse');
  mocks.readClassroom.mockImplementation(async (id: string) => ({ id, stage: {} }));
  mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });
  mocks.setCorpusOrg.mockResolvedValue({ ok: true });
  mocks.releaseCorpusOwnerMarker.mockResolvedValue(true);
  mocks.corpusOwnership.mockResolvedValue(
    new Map([
      ['private-a', 'org-a'],
      ['private-b', 'org-b'],
    ]),
  );
  mocks.readCourseDomains.mockResolvedValue({
    publicCourse: { domain: 'public', title: '公共课' },
    ownCourse: { domain: 'private-a', title: '本机构课' },
    otherCourse: { domain: 'private-b', title: '其他机构课' },
  });
});

describe('corpus 派生列表接口', () => {
  it('course-domains 只返回公共与本机构课程', async () => {
    const { GET } = await import('@/app/api/course-domains/route');
    const body = await (await GET(new NextRequest('http://localhost/api/course-domains'))).json();
    expect(body).toEqual({
      publicCourse: { domain: 'public', title: '公共课' },
      ownCourse: { domain: 'private-a', title: '本机构课' },
    });
  });

  it('归属总表仅 owner 可读且只返回本机构可见项', async () => {
    const { GET } = await import('@/app/api/org/corpora/route');
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ownership).toEqual({ 'private-a': 'org-a' });
  });

  it('匿名拿不到归属总表', async () => {
    mocks.requireCorpusVisible.mockResolvedValue({
      ok: true,
      account: null,
      visible: (corpus: string) => corpus === 'public',
    });
    const { GET } = await import('@/app/api/org/corpora/route');
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.corpusOwnership).not.toHaveBeenCalled();
  });

  it('公共系统知识库不能由机构 owner 手工 claim', async () => {
    const { POST } = await import('@/app/api/org/corpora/route');
    const response = await POST(
      new NextRequest('http://localhost/api/org/corpora', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus: 'public', action: 'claim' }),
      }),
    );
    expect(response.status).toBe(409);
    expect(mocks.setCorpusOrg).not.toHaveBeenCalled();
  });

  it('释放先清理已校对的兼容行，再删引擎唯一真源 marker', async () => {
    const { POST } = await import('@/app/api/org/corpora/route');
    const response = await POST(
      new NextRequest('http://localhost/api/org/corpora', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus: 'private-a', action: 'release' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.releaseCorpusOwnerMarker).toHaveBeenCalledWith('private-a', 'org-a');
    expect(mocks.setCorpusOrg).toHaveBeenCalledWith('private-a', null, 'org-a');
    expect(mocks.setCorpusOrg.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.releaseCorpusOwnerMarker.mock.invocationCallOrder[0],
    );
  });

  it('引擎拒绝释放时 marker 仍是真源，兼容行已可安全清理', async () => {
    mocks.releaseCorpusOwnerMarker.mockResolvedValue(false);
    const { POST } = await import('@/app/api/org/corpora/route');
    const response = await POST(
      new NextRequest('http://localhost/api/org/corpora', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus: 'private-a', action: 'release' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.setCorpusOrg).toHaveBeenCalledWith('private-a', null, 'org-a');
  });

  it('引擎释放接口不可达时返回 503，marker 保留且重试仍可用', async () => {
    mocks.releaseCorpusOwnerMarker.mockRejectedValue(new Error('engine unavailable'));
    const { POST } = await import('@/app/api/org/corpora/route');
    const response = await POST(
      new NextRequest('http://localhost/api/org/corpora', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus: 'private-a', action: 'release' }),
      }),
    );
    expect(response.status).toBe(503);
    expect(mocks.setCorpusOrg).toHaveBeenCalledWith('private-a', null, 'org-a');
  });

  it('兼容行清理失败时不删 marker', async () => {
    mocks.setCorpusOrg.mockResolvedValue({ ok: false, message: '旧表清理失败' });
    const { POST } = await import('@/app/api/org/corpora/route');
    const response = await POST(
      new NextRequest('http://localhost/api/org/corpora', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus: 'private-a', action: 'release' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.releaseCorpusOwnerMarker).not.toHaveBeenCalled();
  });

  it('权限解析失败时不读取任何全量数据', async () => {
    mocks.courseReaderForRequest.mockRejectedValue(new Error('ACL unavailable'));
    const { GET } = await import('@/app/api/course-domains/route');
    expect((await GET(new NextRequest('http://localhost/api/course-domains'))).status).toBe(503);
    expect(mocks.readCourseDomains).not.toHaveBeenCalled();
  });
});
