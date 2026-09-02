import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  readProfile: vi.fn(),
  writeProfile: vi.fn(),
  corpusVisibilityFor: vi.fn(),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountsEnabled: () => true,
  accountForSession: mocks.accountForSession,
  readProfile: mocks.readProfile,
  writeProfile: mocks.writeProfile,
  authenticateAndCreateSession: vi.fn(),
  createAccount: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  normalizeRole: (role: unknown) => role,
  validateCredentials: vi.fn(),
}));
vi.mock('@/lib/accounts/org-store', () => ({
  corpusVisibilityFor: mocks.corpusVisibilityFor,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function request(body?: unknown) {
  return {
    cookies: { get: () => ({ value: 'session-token' }) },
    json: async () => body,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountForSession.mockResolvedValue({ id: 'learner-a', role: 'learner' });
  mocks.corpusVisibilityFor.mockResolvedValue((corpus: string) => corpus !== 'private-b');
});

describe('auth profile corpus ownership', () => {
  it('save-profile 的 domain 回退字段也受机构可见性约束', async () => {
    const { POST } = await import('@/app/api/auth/route');
    const response = await POST(
      request({ action: 'save-profile', profile: { domain: 'private-b' } }),
    );
    expect(response.status).toBe(403);
    expect(mocks.writeProfile).not.toHaveBeenCalled();
  });

  it('旧画像已不可见时不再返回给客户端', async () => {
    mocks.readProfile.mockResolvedValue({ corpus: 'private-b', goal: '旧目标' });
    const { GET } = await import('@/app/api/auth/route');
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).profile).toBeNull();
  });
});
