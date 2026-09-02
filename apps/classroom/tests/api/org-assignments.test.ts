import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  orgForAccount: vi.fn(),
  assignmentsOf: vi.fn(),
  addAssignment: vi.fn(),
  removeAssignment: vi.fn(),
  readClassroom: vi.fn(),
  readCourseDomains: vi.fn(),
  corpusOwnership: vi.fn(),
  isCourseLearnerReleased: vi.fn(),
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
vi.mock('@/lib/server/course-domains', () => ({
  UNKNOWN_DOMAIN: 'unknown',
  RETIRED_DOMAIN: 'retired',
  readCourseDomains: mocks.readCourseDomains,
}));
vi.mock('@/lib/generation/learner-release', () => ({
  decideCourseLearnerRelease: () => ({ eligible: true, courseReasons: [], blockedScenes: [] }),
  isCourseLearnerReleased: mocks.isCourseLearnerReleased,
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
    mocks.readCourseDomains.mockResolvedValue({
      'course-ai': { domain: 'ai', title: 'AI 课程' },
    });
    mocks.corpusOwnership.mockResolvedValue(new Map());
    mocks.isCourseLearnerReleased.mockReturnValue(true);
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
    expect(body.memberRole).toBe('owner');
  });

  it('member 只按当前账户读取，不能请求机构全量', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'learner-b' });
    mocks.orgForAccount.mockResolvedValue({ ...org, memberRole: 'member' });
    const { GET } = await import('@/app/api/org/assignments/route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.assignmentsOf).toHaveBeenCalledWith('org-a', 'learner-b');
    expect(body.memberRole).toBe('member');
  });

  it('旧指派缺失 domain 时回填课程归属域名', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'learner-b' });
    mocks.orgForAccount.mockResolvedValue({ ...org, memberRole: 'member' });
    mocks.assignmentsOf.mockResolvedValue([
      {
        id: 'asg-legacy',
        courseId: 'course-legacy',
        title: '历史课程',
        assignedBy: 'owner-a',
        learnerAccountId: 'learner-b',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    mocks.readCourseDomains.mockResolvedValue({
      'course-legacy': { domain: 'ai', corpus: 'ai' },
    });
    const { GET } = await import('@/app/api/org/assignments/route');

    const body = await (await GET()).json();

    expect(body.assignments).toEqual([
      expect.objectContaining({
        id: 'asg-legacy',
        courseId: 'course-legacy',
        domain: 'ai',
        availability: 'ready',
      }),
    ]);
  });

  it.each([
    ['课程文件缺失', null],
    ['课程文件读取失败', new Error('storage unavailable')],
  ])('已有定向指派但%s时返回显式 unavailable', async (_label, result) => {
    mocks.accountForSession.mockResolvedValue({ id: 'learner-b' });
    mocks.orgForAccount.mockResolvedValue({ ...org, memberRole: 'member' });
    mocks.assignmentsOf.mockResolvedValue([
      {
        id: 'asg-missing',
        courseId: 'course-missing',
        title: '机构课程',
        learnerAccountId: 'learner-b',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    if (result instanceof Error) mocks.readClassroom.mockRejectedValue(result);
    else mocks.readClassroom.mockResolvedValue(result);
    const { GET } = await import('@/app/api/org/assignments/route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.assignments).toEqual([
      expect.objectContaining({
        id: 'asg-missing',
        courseId: 'course-missing',
        availability: 'unavailable',
        unavailableReason: expect.stringContaining('机构课程暂不可用'),
      }),
    ]);
  });

  it('已有定向指派重新变为未发布时保留指派并返回 unavailable', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'learner-b' });
    mocks.orgForAccount.mockResolvedValue({ ...org, memberRole: 'member' });
    mocks.assignmentsOf.mockResolvedValue([
      {
        id: 'asg-draft',
        courseId: 'course-ai',
        title: 'AI 课程',
        learnerAccountId: 'learner-b',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    mocks.isCourseLearnerReleased.mockReturnValue(false);
    const { GET } = await import('@/app/api/org/assignments/route');

    const body = await (await GET()).json();

    expect(body.assignments).toEqual([
      expect.objectContaining({
        id: 'asg-draft',
        availability: 'unavailable',
        unavailableReason: expect.stringContaining('发布审核'),
      }),
    ]);
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
      'ai',
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

  it('学员已有不同领域的有效课程时返回 409，并提示先撤回旧领域课程', async () => {
    mocks.addAssignment.mockResolvedValue({
      ok: false,
      message: '该学员已有其他领域课程指派，请先撤回旧领域课程后再指派',
    });
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = await POST(
      new NextRequest('http://localhost/api/org/assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ learnerAccountId: 'learner-b', courseId: 'course-ai' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain('先撤回旧领域课程');
    expect(mocks.addAssignment).toHaveBeenCalledOnce();
  });

  it('学员已有同领域课程时允许继续指派', async () => {
    mocks.addAssignment.mockResolvedValue({
      ok: true,
      assignment: {
        id: 'asg-2',
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
        body: JSON.stringify({ learnerAccountId: 'learner-b', courseId: 'course-ai' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.addAssignment).toHaveBeenCalledOnce();
  });

  it('新课程的领域无法确定时 fail closed', async () => {
    mocks.readCourseDomains.mockResolvedValue({
      'course-ai': { domain: 'unknown', title: '待归域课程' },
    });
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = await POST(
      new NextRequest('http://localhost/api/org/assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ learnerAccountId: 'learner-b', courseId: 'course-ai' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain('无法确定');
    expect(mocks.addAssignment).not.toHaveBeenCalled();
  });

  it('存储层发现历史指派缺少领域时返回 409', async () => {
    mocks.addAssignment.mockResolvedValue({
      ok: false,
      message: '该学员现有指派缺少领域，请先撤回后重新指派',
    });
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = await POST(
      new NextRequest('http://localhost/api/org/assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ learnerAccountId: 'learner-b', courseId: 'course-ai' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain('缺少领域');
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
