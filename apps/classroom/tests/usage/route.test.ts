import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/usage/route';
import { readUsageRecords, type UsageRecord } from '@/lib/server/usage-storage';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  orgForAccount: vi.fn(),
  corpusOwnership: vi.fn(),
  readClassroom: vi.fn(),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountForSession: mocks.accountForSession,
}));

vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: mocks.orgForAccount,
  corpusOwnership: mocks.corpusOwnership,
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return { ...actual, readClassroom: mocks.readClassroom };
});

vi.mock('@/lib/server/usage-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/usage-storage')>();
  return {
    ...actual,
    readUsageRecords: vi.fn(),
  };
});

describe('GET /api/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountForSession.mockResolvedValue({
      id: 'manager-a',
      username: 'manager-a',
      displayName: 'Manager A',
      role: 'manager',
    });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));
    mocks.readClassroom.mockResolvedValue({
      stage: { origin: { corpus: 'private-a' } },
      generation: { profile: { corpus: 'private-a' } },
    });
  });

  function request() {
    return new NextRequest('http://localhost/api/usage', {
      headers: { cookie: 'jizhi_session=t' },
    });
  }

  function record(id: string, classroomId?: string): UsageRecord {
    return {
      id,
      createdAt: Date.UTC(2026, 5, 29),
      kind: 'llm',
      source: 'chat',
      providerId: 'openai',
      modelId: 'gpt-x',
      modelString: 'openai:gpt-x',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      reasoningTokens: 0,
      unit: 'token',
      ...(classroomId ? { classroomId } : {}),
    };
  }

  it('只向本机构管理者开放', async () => {
    mocks.accountForSession.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    mocks.accountForSession.mockResolvedValueOnce({ id: 'learner', role: 'learner' });
    expect((await GET(request())).status).toBe(403);

    mocks.orgForAccount.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(403);
    expect(readUsageRecords).not.toHaveBeenCalled();
  });

  it('只聚合能明确归属当前机构的课程记录', async () => {
    vi.mocked(readUsageRecords).mockResolvedValueOnce([
      record('own', 'course-a'),
      record('other', 'course-b'),
      record('public', 'course-public'),
      record('missing', 'course-missing'),
      record('unattributed'),
      record('invalid', '../escape'),
    ]);
    mocks.corpusOwnership.mockResolvedValueOnce(
      new Map([
        ['private-a', 'org-a'],
        ['private-b', 'org-b'],
      ]),
    );
    mocks.readClassroom.mockImplementation(async (id: string) => {
      if (id === 'course-a') return { stage: { origin: { corpus: 'private-a' } } };
      if (id === 'course-b') return { stage: { origin: { corpus: 'private-b' } } };
      if (id === 'course-public') return { stage: { origin: { corpus: 'public' } } };
      return null;
    });

    const body = await (await GET(request())).json();

    expect(body.totals).toEqual({ requests: 1, llmTokens: 120 });
    expect(mocks.readClassroom).not.toHaveBeenCalledWith('../escape');
  });

  it('does not add cache detail fields again to displayed token totals', async () => {
    vi.mocked(readUsageRecords).mockResolvedValueOnce([record('1', 'course-a')]);

    const response = await GET(request());
    const body = await response.json();

    expect(body.totals.llmTokens).toBe(120);
    expect(body.byModel[0].totalTokens).toBe(120);
    expect(body.byModel[0].cacheReadTokens).toBe(30);
    expect(body.byModel[0].cacheCreationTokens).toBe(10);
  });
});
