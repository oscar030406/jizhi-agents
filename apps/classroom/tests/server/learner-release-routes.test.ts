import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { SceneAudit } from '@/lib/generation/hallucination-audit';

const mocks = vi.hoisted(() => ({
  listClassrooms: vi.fn(),
  readClassroom: vi.fn(),
  accountForSession: vi.fn(),
  orgForAccount: vi.fn(),
  assignmentsOf: vi.fn(),
  addAssignment: vi.fn(),
  removeAssignment: vi.fn(),
  corpusOwnership: vi.fn(),
  readCourseDomains: vi.fn(),
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
  listClassrooms: mocks.listClassrooms,
  readClassroom: mocks.readClassroom,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'session-token' }) }),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountForSession: mocks.accountForSession,
}));

vi.mock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'session' }));

vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: mocks.orgForAccount,
  assignmentsOf: mocks.assignmentsOf,
  addAssignment: mocks.addAssignment,
  removeAssignment: mocks.removeAssignment,
  corpusOwnership: mocks.corpusOwnership,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/server/course-domains', () => ({
  readCourseDomains: mocks.readCourseDomains,
  UNKNOWN_DOMAIN: 'unknown',
  RETIRED_DOMAIN: 'retired',
}));

function audit(overrides: Partial<SceneAudit> = {}): SceneAudit {
  const base: SceneAudit = {
    verdict: 'pass',
    claims: [
      { claim: '事实性断言', verdict: 'supported', reason: '教材证据支持', sourceIds: ['S1'] },
    ],
    totalClaims: 1,
    flaggedCount: 0,
    uncertainCount: 0,
    incorrectCount: 0,
    judgeModel: 'judge',
    rounds: 1,
    durationMs: 1,
    decision: 'publish',
    rationale: '通过',
    grounded: true,
    evidenceCount: 1,
  };
  return { ...base, ...overrides };
}

function course(id: string, sceneAudit: SceneAudit) {
  const outlineId = `${id}-outline`;
  return {
    id,
    stage: {
      id,
      name: `引擎课程 ${id}`,
      learningContract: {
        version: 1,
        plannedScenes: [{ sceneId: outlineId, type: 'pbl' }],
        required: {
          prerequisiteActivation: [outlineId],
          demonstration: [outlineId],
          learnerPractice: [outlineId],
          feedbackRetry: [outlineId],
          transferApplication: [outlineId],
          assessment: [outlineId],
        },
      },
    },
    scenes: [{ id: `${id}-scene`, outlineId, type: 'pbl', audit: sceneAudit }],
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

function requireResponse(response: Response | undefined): Response {
  if (!response) throw new Error('路由没有返回响应');
  return response;
}

async function getClassroom(id?: string) {
  const { GET } = await import('@/app/api/classroom/route');
  const suffix = id ? `?id=${encodeURIComponent(id)}` : '';
  return GET(new NextRequest(`http://localhost/api/classroom${suffix}`));
}

describe('GET /api/classroom 学习者发布门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listClassrooms.mockResolvedValue([]);
    mocks.accountForSession.mockResolvedValue(null);
    mocks.orgForAccount.mockResolvedValue(null);
    mocks.assignmentsOf.mockResolvedValue([]);
    mocks.corpusOwnership.mockResolvedValue(new Map());
    mocks.readCourseDomains.mockResolvedValue({});
  });

  it.each([
    [
      '审核失败',
      audit({
        verdict: 'flagged',
        claims: [],
        totalClaims: 0,
        decision: 'publish_with_warnings',
        grounded: false,
        evidenceCount: 0,
      }),
    ],
    ['待人工复核', audit({ decision: 'block_pending_review' })],
  ])('%s课程对学习者表现为不存在，草稿数据仍留在存储层', async (_label, sceneAudit) => {
    const draft = course('draft-course', sceneAudit);
    mocks.readClassroom.mockResolvedValue(draft);

    const response = await getClassroom(draft.id);

    expect(response.status).toBe(404);
    expect(mocks.readClassroom).toHaveBeenCalledWith(draft.id);
    expect(draft.scenes).toHaveLength(1);
  });

  it('所属机构 owner 可查看草稿复核，member 即使已指派仍不可读', async () => {
    const draft = {
      ...course('draft-course', audit({ decision: 'block_pending_review' })),
      ownerOrgId: 'org-a',
    };
    mocks.readClassroom.mockResolvedValue(draft);
    mocks.accountForSession.mockResolvedValue({ id: 'owner-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });

    expect((await getClassroom(draft.id)).status).toBe(200);

    mocks.accountForSession.mockResolvedValue({ id: 'member-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'member' });
    mocks.assignmentsOf.mockResolvedValue([{ courseId: draft.id }]);
    expect((await getClassroom(draft.id)).status).toBe(404);
  });

  it('合格课程仍可读取', async () => {
    const released = course('released-course', audit());
    mocks.readClassroom.mockResolvedValue(released);

    const response = await getClassroom(released.id);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.classroom.id).toBe(released.id);
  });

  it('公共课程清单显式请求发布版过滤', async () => {
    await getClassroom();
    expect(mocks.listClassrooms).toHaveBeenCalledWith({ learnerReleasedOnly: true });
  });

  it('匿名列表与详情都隐藏已知私有知识库课程', async () => {
    const baseCourse = course('private-course', audit());
    const privateCourse = {
      ...baseCourse,
      stage: {
        ...baseCourse.stage,
        name: '机构私有课程',
        origin: { corpus: 'private-a' },
      },
    };
    mocks.listClassrooms.mockResolvedValue([
      {
        id: privateCourse.id,
        title: privateCourse.stage.name,
        sceneCount: 1,
        createdAt: privateCourse.createdAt,
        audit: null,
      },
    ]);
    mocks.readClassroom.mockResolvedValue(privateCourse);
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));

    const listResponse = await getClassroom();
    const detailResponse = await getClassroom(privateCourse.id);

    expect((await listResponse.json()).classrooms).toEqual([]);
    expect(detailResponse.status).toBe(404);
  });

  it('同机构 owner 可读全部，member 只有明确指派后才可读，其他机构不可读', async () => {
    const baseCourse = course('private-course', audit());
    const privateCourse = {
      ...baseCourse,
      stage: {
        ...baseCourse.stage,
        name: '机构私有课程',
        origin: { corpus: 'private-a' },
      },
    };
    mocks.readClassroom.mockResolvedValue(privateCourse);
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));
    mocks.accountForSession.mockResolvedValue({ id: 'owner-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });

    expect((await getClassroom(privateCourse.id)).status).toBe(200);

    mocks.accountForSession.mockResolvedValue({ id: 'member-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'member' });
    expect((await getClassroom(privateCourse.id)).status).toBe(404);

    mocks.assignmentsOf.mockResolvedValue([{ courseId: privateCourse.id }]);
    expect((await getClassroom(privateCourse.id)).status).toBe(200);

    mocks.orgForAccount.mockResolvedValue({ id: 'org-b', memberRole: 'member' });
    expect((await getClassroom(privateCourse.id)).status).toBe(404);
  });

  it('机构 member 的课程墙只列明确指派课程', async () => {
    const assigned = course('assigned', audit());
    const unassigned = course('unassigned', audit());
    mocks.accountForSession.mockResolvedValue({ id: 'member-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'member' });
    mocks.assignmentsOf.mockResolvedValue([{ courseId: assigned.id }]);
    mocks.listClassrooms.mockResolvedValue(
      [assigned, unassigned].map((item) => ({
        id: item.id,
        title: item.stage.name,
        sceneCount: 1,
        createdAt: item.createdAt,
        audit: null,
      })),
    );
    mocks.readClassroom.mockImplementation(async (id: string) =>
      id === assigned.id ? assigned : unassigned,
    );

    const response = await getClassroom();
    expect((await response.json()).classrooms.map((item: { id: string }) => item.id)).toEqual([
      assigned.id,
    ]);
    expect(mocks.assignmentsOf).toHaveBeenCalledWith('org-a', 'member-a');
  });
});

describe('机构指派的学习者消费门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountForSession.mockResolvedValue({ id: 'account-1' });
    mocks.corpusOwnership.mockResolvedValue(new Map());
    mocks.orgForAccount.mockResolvedValue({
      id: 'org-1',
      name: '机构一',
      ownerAccountId: 'owner-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      memberRole: 'member',
    });
    mocks.assignmentsOf.mockResolvedValue([]);
  });

  it('学员读取已有指派时保留被打回课程并显式标为不可用，合格课程仍可进入', async () => {
    mocks.assignmentsOf.mockResolvedValue([
      { id: 'a1', courseId: 'blocked', title: '待复核', assignedBy: 'owner-1', createdAt: '1' },
      { id: 'a2', courseId: 'released', title: '已发布', assignedBy: 'owner-1', createdAt: '2' },
    ]);
    mocks.readClassroom.mockImplementation(async (id: string) =>
      id === 'blocked'
        ? course('blocked', audit({ decision: 'block_pending_review' }))
        : course('released', audit()),
    );
    const { GET } = await import('@/app/api/org/assignments/route');

    const response = requireResponse(await GET());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.assignments).toEqual([
      {
        id: 'a1',
        courseId: 'blocked',
        title: '待复核',
        assignedBy: 'owner-1',
        createdAt: '1',
        domain: null,
        availability: 'unavailable',
        unavailableReason: '机构课程暂不可用：课程尚未通过发布审核，请联系管理者完成复核。',
      },
      {
        id: 'a2',
        courseId: 'released',
        title: '已发布',
        assignedBy: 'owner-1',
        createdAt: '2',
        domain: null,
        availability: 'ready',
      },
    ]);
    expect(body.assignments[0]).not.toHaveProperty('href');
    expect(body.assignments[0]).not.toHaveProperty('url');
  });

  it('管理者不能新指派待复核草稿', async () => {
    mocks.orgForAccount.mockResolvedValue({
      id: 'org-1',
      name: '机构一',
      ownerAccountId: 'account-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      memberRole: 'owner',
    });
    mocks.readClassroom.mockResolvedValue(
      course('blocked', audit({ decision: 'block_pending_review' })),
    );
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = requireResponse(
      await POST(
        new NextRequest('http://localhost/api/org/assignments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            learnerAccountId: 'learner-1',
            courseId: 'blocked',
            title: '客户端标题',
          }),
        }),
      ),
    );

    expect(response.status).toBe(409);
    expect(mocks.addAssignment).not.toHaveBeenCalled();
  });

  it('合格课程仍可指派，标题取课程真源而不信任客户端快照', async () => {
    mocks.orgForAccount.mockResolvedValue({
      id: 'org-1',
      name: '机构一',
      ownerAccountId: 'account-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      memberRole: 'owner',
    });
    mocks.readClassroom.mockResolvedValue(course('released', audit()));
    mocks.readCourseDomains.mockResolvedValue({
      released: { domain: 'ai', corpus: 'ai', title: '引擎课程 released' },
    });
    mocks.addAssignment.mockResolvedValue({
      ok: true,
      assignment: {
        id: 'a1',
        courseId: 'released',
        title: '引擎课程 released',
        assignedBy: 'account-1',
        createdAt: '1',
      },
    });
    const { POST } = await import('@/app/api/org/assignments/route');

    const response = requireResponse(
      await POST(
        new NextRequest('http://localhost/api/org/assignments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            learnerAccountId: 'learner-1',
            courseId: 'released',
            title: '客户端旧标题',
          }),
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.addAssignment).toHaveBeenCalledWith(
      'org-1',
      'released',
      '引擎课程 released',
      'account-1',
      'learner-1',
      'ai',
    );
  });
});
