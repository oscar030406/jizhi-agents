import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  orgForAccount: vi.fn(),
  readRunEvents: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'session-token' }) }),
}));
vi.mock('@/lib/accounts/store', () => ({
  accountsEnabled: () => true,
  accountForSession: mocks.accountForSession,
}));
vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: mocks.orgForAccount,
}));
vi.mock('@/lib/server/intake-runs', () => ({
  isValidRunId: () => true,
  readRunEvents: mocks.readRunEvents,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountForSession.mockResolvedValue({ id: 'manager-a', role: 'manager' });
  mocks.orgForAccount.mockResolvedValue({ id: 'org-a' });
  mocks.readRunEvents.mockResolvedValue({
    record: { corpus: 'private-b', owner_org_id: 'org-b' },
    events: [{ seq: 1 }],
    nextSeq: 2,
  });
});

describe('intake run events tenant view', () => {
  it('其他机构的接入记录统一返回 404', async () => {
    const { GET } = await import('@/app/api/knowledge/intake-runs/[runId]/events/route');
    const response = await GET(
      { nextUrl: new URL('http://localhost/api/knowledge/intake-runs/run-1/events') } as never,
      { params: Promise.resolve({ runId: 'run-1' }) },
    );
    expect(response.status).toBe(404);
  });

  it('旧 run 没有所有者时不向任何机构管理者开放', async () => {
    mocks.readRunEvents.mockResolvedValue({ record: { corpus: 'public' }, events: [], nextSeq: 0 });
    const { GET } = await import('@/app/api/knowledge/intake-runs/[runId]/events/route');
    const response = await GET(
      { nextUrl: new URL('http://localhost/api/knowledge/intake-runs/legacy/events') } as never,
      { params: Promise.resolve({ runId: 'legacy' }) },
    );
    expect(response.status).toBe(404);
  });

  it('只向 run 创建机构返回事件', async () => {
    mocks.readRunEvents.mockResolvedValue({
      record: { corpus: 'private-a', owner_org_id: 'org-a' },
      events: [{ seq: 1 }],
      nextSeq: 2,
    });
    const { GET } = await import('@/app/api/knowledge/intake-runs/[runId]/events/route');
    const response = await GET(
      { nextUrl: new URL('http://localhost/api/knowledge/intake-runs/run-a/events') } as never,
      { params: Promise.resolve({ runId: 'run-a' }) },
    );
    expect(response.status).toBe(200);
  });
});
