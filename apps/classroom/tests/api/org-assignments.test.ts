import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  orgForAccount: vi.fn(),
  assignmentsOf: vi.fn(),
  addAssignment: vi.fn(),
  removeAssignment: vi.fn(),
  readClassroom: vi.fn(),
  corpusOwnership: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'session-token' }) }),
}));

vi.mock('@/lib/accounts/store', () => ({ accountForSession: mocks.accountForSession }));
vi.mock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'session' }));
vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: mocks.orgForAccount,
  assignmentsOf: mocks.assignmentsOf,
  addAssignment: mocks.addAssignment,
  removeAssignment: mocks.removeAssignment,
  corpusOwnership: mocks.corpusOwnership,
}));
vi.mock('@/lib/server/classroom-storage', () => ({ readClassroom: mocks.readClassroom }));
vi.mock('@/lib/generation/learner-release', () => ({
  decideCourseLearnerRelease: () => ({ eligible: true, courseReasons: [], blockedScenes: [] }),
  isCourseLearnerReleased: () => true,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const org = {
  id: 'org-a',
  name: '甲方培训中心',
  ownerAccountId: 'owner-a',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('/api/org/assignments 定向可见性', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountForSession.mockResolvedValue({ id: 'owner-a' });
    mocks.orgForAccount.mockResolvedValue({ ...org, memberRole: 'owner' });
    mocks.assignmentsOf.mockResolvedValue([]);
    mocks.readClassroom.mockResolvedValue({ stage: { name: 'AI 课程' } });
    mocks.corpusOwnership.mockResolvedValue(new Map());
  });

  it('owner 读取全量指派，并收到学员显示名', async () => {
    mocks.assignmentsOf.mockResolvedValue([
      {
        id: 'asg-1',
        courseId: 'course-ai',
        title: 'AI 课程',
        assignedBy: 'owner-a',
        learnerAccountId: 'learner-b',
        learnerDisplayName: '学员乙',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    const { GET } = await import('@/app/api/org/assignments/route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.assignmentsOf).toHaveBeenCalledWith('org-a');
    expect(body.assignments[0].learnerDisplayName).toBe('学员乙');
  });

  it('member 只按当前账户读取，不能请求机构全量', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'learner-b' });
    mocks.orgForAccount.mockResolvedValue({ ...org, memberRole: 'member' });
    const { GET } = await import('@/app/api/org/assignments/route');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.assignmentsOf).toHaveBeenCalledWith('org-a', 'learner-b');
  });

  it('新指派必须携带学员，并把学员目标传到存储层', async () => {
    mocks.addAssignment.mockResolvedValue({
      ok: true,
      assignment: {
        id: 'asg-1',
        courseId: 'course-ai',
        title: 'AI 课程',
        assignedBy: 'owner-a',
        learnerAccountId: 'learner-b',
        learnerDisplayName: '学员乙',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    });
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = await POST(
      new NextRequest('http://localhost/api/org/assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          learnerAccountId: 'learner-b',
          courseId: 'course-ai',
          title: 'AI 课程',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.addAssignment).toHaveBeenCalledWith(
      'org-a',
      'course-ai',
      'AI 课程',
      'owner-a',
      'learner-b',
    );
  });

  it('缺少学员目标时拒绝创建，不调用存储层', async () => {
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = await POST(
      new NextRequest('http://localhost/api/org/assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ courseId: 'course-ai', title: 'AI 课程' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.addAssignment).not.toHaveBeenCalled();
  });

  it('owner 不能跨机构指派私有知识库课程', async () => {
    mocks.readClassroom.mockResolvedValue({
      stage: { name: '乙方私有课程', origin: { corpus: 'private-b' } },
    });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-b', 'org-b']]));
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = await POST(
      new NextRequest('http://localhost/api/org/assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ learnerAccountId: 'learner-b', courseId: 'course-private-b' }),
      }),
    );

    expect(response.status).toBe(404);
    expect(mocks.addAssignment).not.toHaveBeenCalled();
  });

  it('member 不能按 id 撤回指派', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'learner-b' });
    mocks.orgForAccount.mockResolvedValue({ ...org, memberRole: 'member' });
    const { DELETE } = await import('@/app/api/org/assignments/route');

    const response = await DELETE(
      new NextRequest('http://localhost/api/org/assignments?id=asg-1', { method: 'DELETE' }),
    );

    expect(response.status).toBe(403);
    expect(mocks.removeAssignment).not.toHaveBeenCalled();
  });

  it('owner 仍可按本机构 assignment id 撤回', async () => {
    mocks.removeAssignment.mockResolvedValue(true);
    const { DELETE } = await import('@/app/api/org/assignments/route');

    const response = await DELETE(
      new NextRequest('http://localhost/api/org/assignments?id=asg-1', { method: 'DELETE' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.removeAssignment).toHaveBeenCalledWith('org-a', 'asg-1');
    expect(body.removed).toBe('asg-1');
  });
});
