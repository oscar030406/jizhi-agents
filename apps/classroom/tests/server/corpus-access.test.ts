import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  corpusVisibilityFor: vi.fn(),
  orgForAccount: vi.fn(),
  corpusOwnership: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'session-1' }) }),
}));
vi.mock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'sid' }));
vi.mock('@/lib/accounts/store', () => ({ accountForSession: mocks.accountForSession }));
vi.mock('@/lib/accounts/org-store', () => ({
  corpusVisibilityFor: mocks.corpusVisibilityFor,
  orgForAccount: mocks.orgForAccount,
  corpusOwnership: mocks.corpusOwnership,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { requireCorpusVisible } from '@/lib/server/corpus-access';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountForSession.mockResolvedValue(null);
  mocks.corpusVisibilityFor.mockResolvedValue((corpus: string) => corpus === 'public');
  mocks.orgForAccount.mockResolvedValue(null);
  mocks.corpusOwnership.mockResolvedValue(new Map());
});

describe('requireCorpusVisible', () => {
  it('匿名只放行公共库', async () => {
    expect((await requireCorpusVisible('public')).ok).toBe(true);
    const denied = await requireCorpusVisible('private');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
    expect(mocks.corpusVisibilityFor).toHaveBeenCalledWith(null);
  });

  it('权限解析异常时 fail-closed，响应不泄露内部配置或路径', async () => {
    mocks.corpusVisibilityFor.mockRejectedValue(
      new Error('GROUNDING_URL=/root/jizhi/secret/private-index.json'),
    );

    const result = await requireCorpusVisible('public');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    const body = JSON.stringify(await result.response.json());
    expect(body).not.toContain('GROUNDING_URL');
    expect(body).not.toContain('/root/');
    expect(body).not.toContain('private-index.json');
  });

  it('写操作只放行所属机构 owner 管理者管理已归属的库', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'manager-a', role: 'manager' });
    mocks.corpusVisibilityFor.mockResolvedValue(() => true);
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));

    expect((await requireCorpusVisible('private-a', { manage: true })).ok).toBe(true);
    const denied = await requireCorpusVisible('public', { manage: true });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
  });

  it('他机构管理者和普通学员都不能管理 corpus', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'manager-a', role: 'manager' });
    mocks.corpusVisibilityFor.mockResolvedValue(() => false);
    const otherOrg = await requireCorpusVisible('private-b', { manage: true });
    expect(otherOrg.ok).toBe(false);
    if (!otherOrg.ok) expect(otherOrg.response.status).toBe(403);

    mocks.accountForSession.mockResolvedValue({ id: 'learner-a', role: 'learner' });
    mocks.corpusVisibilityFor.mockResolvedValue(() => true);
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'member' });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));
    const learner = await requireCorpusVisible('private-a', { manage: true });
    expect(learner.ok).toBe(false);
    if (!learner.ok) expect(learner.response.status).toBe(403);
  });

  it('匿名写请求在读取归属表前即拒绝', async () => {
    const result = await requireCorpusVisible('private-a', { manage: true });
    expect(result.ok).toBe(false);
    expect(mocks.corpusVisibilityFor).not.toHaveBeenCalled();
    expect(mocks.corpusOwnership).not.toHaveBeenCalled();
  });
});
