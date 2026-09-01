import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  corpusVisibilityFor: vi.fn(),
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
  corpusVisibilityFor: mocks.corpusVisibilityFor,
}));
vi.mock('@/lib/server/intake-runs', () => ({
  isValidRunId: () => true,
  readRunEvents: mocks.readRunEvents,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountForSession.mockResolvedValue({ id: 'manager-a', role: 'manager' });
  mocks.readRunEvents.mockResolvedValue({
    record: { corpus: 'private-b' },
    events: [{ seq: 1 }],
    nextSeq: 2,
  });
});

describe('intake run events tenant view', () => {
  it('其他机构的接入记录统一返回 404', async () => {
    mocks.corpusVisibilityFor.mockResolvedValue((corpus: string) => corpus !== 'private-b');
    const { GET } = await import('@/app/api/knowledge/intake-runs/[runId]/events/route');
    const response = await GET(
      { nextUrl: new URL('http://localhost/api/knowledge/intake-runs/run-1/events') } as never,
      { params: Promise.resolve({ runId: 'run-1' }) },
    );
    expect(response.status).toBe(404);
  });
});
