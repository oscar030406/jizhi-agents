import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  accountForSession: vi.fn(),
  authorizeInternalCorpusService: vi.fn(),
  requireCorpusVisible: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  readClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
  buildRequestOrigin: vi.fn(),
  orgForAccount: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mocks.after,
}));
vi.mock('@/lib/accounts/store', () => ({ accountForSession: mocks.accountForSession }));
vi.mock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'jizhi_session' }));
vi.mock('@/lib/accounts/org-store', () => ({ orgForAccount: mocks.orgForAccount }));
vi.mock('@/lib/server/corpus-access', () => ({
  authorizeInternalCorpusService: mocks.authorizeInternalCorpusService,
  requireCorpusVisible: mocks.requireCorpusVisible,
}));
vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
  readClassroomGenerationJob: mocks.readClassroomGenerationJob,
  isValidClassroomJobId: (jobId: string) => /^[a-zA-Z0-9_-]+$/.test(jobId),
}));
vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));
vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
}));
vi.mock('@/lib/generation/learner-profile', () => ({
  corpusOf: (profile?: { corpus?: string }) => profile?.corpus ?? null,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function postRequest(corpus?: string, token?: string) {
  return new NextRequest('http://localhost/api/generate-classroom', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `jizhi_session=${token}` } : {}),
    },
    body: JSON.stringify({
      requirement: '生成一门课程',
      ...(corpus ? { learnerProfile: { corpus } } : {}),
    }),
  });
}

function storedJob(ownerAccountId: string | null, ownerOrgId: string | null = null) {
  return {
    id: 'job_123',
    ownerAccountId,
    ownerOrgId,
    corpus: 'ai',
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'queued',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    inputSummary: {
      requirementPreview: '生成一门课程',
      hasPdf: false,
      pdfTextLength: 0,
      pdfImageCount: 0,
    },
    scenesGenerated: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountForSession.mockResolvedValue(null);
  mocks.authorizeInternalCorpusService.mockResolvedValue({ attempted: false });
  mocks.requireCorpusVisible.mockResolvedValue({ ok: true });
  mocks.orgForAccount.mockResolvedValue(null);
  mocks.buildRequestOrigin.mockReturnValue('http://localhost');
  mocks.createClassroomGenerationJob.mockResolvedValue(storedJob(null));
});

describe('整课生成 job 账户归属', () => {
  it.each([
    ['登录账户', 'private-domain', 'session-a', { id: 'account-a' }, 'account-a'],
    ['匿名公共生成', undefined, undefined, null, null],
  ])('%s 创建时记录 ownerAccountId 与 corpus', async (_label, corpus, token, account, owner) => {
    mocks.accountForSession.mockResolvedValue(account);
    mocks.requireCorpusVisible.mockResolvedValue({ ok: true, account });
    mocks.orgForAccount.mockResolvedValue(account ? { id: 'org-a' } : null);
    const { POST } = await import('@/app/api/generate-classroom/route');

    const response = await POST(postRequest(corpus, token));

    expect(response.status).toBe(202);
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { ownerAccountId: owner, ownerOrgId: account ? 'org-a' : null, corpus: corpus ?? 'ai' },
    );
    expect(mocks.createClassroomGenerationJob.mock.calls[0][1]).toEqual(
      account
        ? expect.objectContaining({ ownerOrgId: 'org-a' })
        : expect.not.objectContaining({ ownerOrgId: expect.anything() }),
    );
  });

  it('ignores a spoofed ownerOrgId and derives organization from the session', async () => {
    const account = { id: 'account-a' };
    mocks.requireCorpusVisible.mockResolvedValue({ ok: true, account });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a' });
    const { POST } = await import('@/app/api/generate-classroom/route');
    const request = new NextRequest('http://localhost/api/generate-classroom', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requirement: '生成一门课程', ownerOrgId: 'org-b' }),
    });

    expect((await POST(request)).status).toBe(202);
    expect(mocks.createClassroomGenerationJob.mock.calls[0][1]).toMatchObject({
      ownerOrgId: 'org-a',
    });
  });

  it.each([
    { label: '同一账户', account: { id: 'account-a' }, status: 200 },
    { label: '其他账户', account: { id: 'account-b' }, status: 404 },
    { label: '未登录', account: null, status: 404 },
  ])('有 owner 的 job：$label 轮询返回 $status', async ({ account, status }) => {
    mocks.accountForSession.mockResolvedValue(account);
    mocks.readClassroomGenerationJob.mockResolvedValue(storedJob('account-a'));
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');

    const response = await GET(new NextRequest('http://localhost/api/generate-classroom/job_123'), {
      params: Promise.resolve({ jobId: 'job_123' }),
    });

    expect(response.status).toBe(status);
    if (status === 404) {
      expect((await response.json()).error).toBe('Classroom generation job not found');
    }
  });

  it('无 owner 的公共 job 可匿名轮询', async () => {
    mocks.readClassroomGenerationJob.mockResolvedValue(storedJob(null));
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');

    const response = await GET(new NextRequest('http://localhost/api/generate-classroom/job_123'), {
      params: Promise.resolve({ jobId: 'job_123' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });

  it('机构 job 在浏览器分支一律返回 404，即使会话账户与 ownerAccountId 相同', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'account-a' });
    mocks.readClassroomGenerationJob.mockResolvedValue(storedJob('account-a', 'org-a'));
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');

    const response = await GET(new NextRequest('http://localhost/api/generate-classroom/job_123'), {
      params: Promise.resolve({ jobId: 'job_123' }),
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Classroom generation job not found');
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });
});
