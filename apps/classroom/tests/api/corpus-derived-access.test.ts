import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireCorpusVisible: vi.fn(),
  readCourseDomains: vi.fn(),
  corpusOwnership: vi.fn(),
  orgForAccount: vi.fn(),
}));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: mocks.requireCorpusVisible,
}));
vi.mock('@/lib/server/course-domains', () => ({ readCourseDomains: mocks.readCourseDomains }));
vi.mock('@/lib/accounts/org-store', () => ({
  corpusOwnership: mocks.corpusOwnership,
  orgForAccount: mocks.orgForAccount,
  setCorpusOrg: vi.fn(),
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
  mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });
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
    const body = await (await GET()).json();
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

  it('权限解析失败时不读取任何全量数据', async () => {
    mocks.requireCorpusVisible.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false }), { status: 503 }),
    });
    const { GET } = await import('@/app/api/course-domains/route');
    expect((await GET()).status).toBe(503);
    expect(mocks.readCourseDomains).not.toHaveBeenCalled();
  });
});
