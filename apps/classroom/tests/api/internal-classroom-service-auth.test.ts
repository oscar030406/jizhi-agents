import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  accountForSession: vi.fn(),
  corpusOwnership: vi.fn(),
  corpusVisibilityFor: vi.fn(),
  orgForAccount: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  readClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
  buildRequestOrigin: vi.fn(),
  readClassroom: vi.fn(),
  listClassrooms: vi.fn(),
  courseReaderForRequest: vi.fn(),
  canReadCourse: vi.fn(),
  courseCorpora: vi.fn(),
  isCourseLearnerReleased: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mocks.after,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/accounts/store', () => ({ accountForSession: mocks.accountForSession }));
vi.mock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'jizhi_session' }));
vi.mock('@/lib/accounts/org-store', () => ({
  corpusOwnership: mocks.corpusOwnership,
  corpusVisibilityFor: mocks.corpusVisibilityFor,
  orgForAccount: mocks.orgForAccount,
}));
vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
  readClassroomGenerationJob: mocks.readClassroomGenerationJob,
  isValidClassroomJobId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
}));
vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));
vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
  readClassroom: mocks.readClassroom,
  listClassrooms: mocks.listClassrooms,
}));
vi.mock('@/lib/server/course-access', () => ({
  courseReaderForRequest: mocks.courseReaderForRequest,
  canReadCourse: mocks.canReadCourse,
  courseCorpora: mocks.courseCorpora,
}));
vi.mock('@/lib/generation/learner-release', () => ({
  isCourseLearnerReleased: mocks.isCourseLearnerReleased,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const corpus = 'private-domain';
const org = 'org-a';
const token = 'service-secret';

function serviceHeaders(overrides: Record<string, string> = {}) {
  return {
    'x-internal-token': token,
    'x-jizhi-service-org': org,
    'x-jizhi-service-corpus': corpus,
    ...overrides,
  };
}

function generateRequest(headers: Record<string, string> = serviceHeaders(), host = '127.0.0.1') {
  return new NextRequest(`http://${host}:3210/api/generate-classroom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ requirement: '私有库完整试跑', learnerProfile: { corpus } }),
  });
}

function storedJob(ownerOrgId = org) {
  return {
    id: 'job_private',
    ownerAccountId: 'browser-account',
    ownerOrgId,
    corpus,
    status: 'succeeded',
    step: 'completed',
    progress: 100,
    message: 'done',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
    inputSummary: {
      requirementPreview: '私有库完整试跑',
      hasPdf: false,
      pdfTextLength: 0,
      pdfImageCount: 0,
    },
    scenesGenerated: 2,
    result: { classroomId: 'course_private', url: '/classroom/course_private', scenesCount: 2 },
  };
}

function storedClassroom(ownerOrgId = org) {
  return {
    id: 'course_private',
    ownerOrgId,
    stage: { name: '私有课', origin: { corpus } },
    scenes: [{ id: 'scene-1', title: '第一屏', type: 'slide' }],
    createdAt: '2026-09-01T00:01:00.000Z',
    generation: { profile: { corpus } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GROUNDING_TOKEN = token;
  mocks.corpusOwnership.mockResolvedValue(new Map([[corpus, org]]));
  mocks.corpusVisibilityFor.mockResolvedValue(() => false);
  mocks.orgForAccount.mockResolvedValue(null);
  mocks.accountForSession.mockResolvedValue(null);
  mocks.buildRequestOrigin.mockReturnValue('http://127.0.0.1:3210');
  mocks.createClassroomGenerationJob.mockResolvedValue(storedJob());
  mocks.readClassroomGenerationJob.mockResolvedValue(storedJob());
  mocks.readClassroom.mockResolvedValue(storedClassroom());
  mocks.listClassrooms.mockResolvedValue([]);
  mocks.courseReaderForRequest.mockResolvedValue({
    accountId: null,
    orgId: null,
    memberRole: null,
    assignedCourseIds: new Set(),
  });
  mocks.courseCorpora.mockReturnValue(new Set([corpus]));
  mocks.isCourseLearnerReleased.mockReturnValue(true);
});

describe('engine -> classroom 私有 corpus 服务身份', () => {
  it('正确 token + loopback + 精确 corpus/org 可创建私有完整造课任务', async () => {
    const { POST } = await import('@/app/api/generate-classroom/route');

    const response = await POST(generateRequest());

    expect(response.status).toBe(202);
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ ownerOrgId: org, learnerProfile: { corpus } }),
      { ownerAccountId: null, ownerOrgId: org, corpus },
    );
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });

  it.each([
    ['缺 token', serviceHeaders({ 'x-internal-token': '' })],
    ['错 token', serviceHeaders({ 'x-internal-token': 'wrong-secret' })],
  ])('%s fail closed，不回退浏览器 session', async (_label, headers) => {
    const { POST } = await import('@/app/api/generate-classroom/route');

    const response = await POST(generateRequest(headers));

    expect(response.status).toBe(401);
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });

  it.each([
    ['缺 token', serviceHeaders({ 'x-internal-token': '' })],
    ['错 token', serviceHeaders({ 'x-internal-token': 'wrong-secret' })],
  ])('轮询与成课读取遇到%s也 fail closed', async (_label, headers) => {
    const [{ GET: poll }, { GET: read }] = await Promise.all([
      import('@/app/api/generate-classroom/[jobId]/route'),
      import('@/app/api/classroom/route'),
    ]);

    const pollResponse = await poll(
      new NextRequest('http://127.0.0.1:3210/api/generate-classroom/job_private', { headers }),
      { params: Promise.resolve({ jobId: 'job_private' }) },
    );
    const readResponse = await read(
      new NextRequest('http://127.0.0.1:3210/api/classroom?id=course_private', { headers }),
    );

    expect(pollResponse.status).toBe(401);
    expect(readResponse.status).toBe(401);
    expect(mocks.readClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.readClassroom).not.toHaveBeenCalled();
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });

  it('正确 token 但非 loopback Host 仍拒绝', async () => {
    const { POST } = await import('@/app/api/generate-classroom/route');

    const response = await POST(generateRequest(serviceHeaders(), 'public.example'));

    expect(response.status).toBe(403);
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('header org 与真实 corpus ownership 不同则拒绝', async () => {
    const { POST } = await import('@/app/api/generate-classroom/route');

    const response = await POST(
      generateRequest(serviceHeaders({ 'x-jizhi-service-org': 'org-b' })),
    );

    expect(response.status).toBe(403);
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('同一服务身份可轮询自己 org/corpus 的试跑 job', async () => {
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
    const request = new NextRequest('http://127.0.0.1:3210/api/generate-classroom/job_private', {
      headers: serviceHeaders(),
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job_private' }) });

    expect(response.status).toBe(200);
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });

  it('服务身份不能轮询别的机构创建的 job', async () => {
    mocks.readClassroomGenerationJob.mockResolvedValue(storedJob('org-b'));
    const { GET } = await import('@/app/api/generate-classroom/[jobId]/route');
    const request = new NextRequest('http://127.0.0.1:3210/api/generate-classroom/job_private', {
      headers: serviceHeaders(),
    });

    const response = await GET(request, { params: Promise.resolve({ jobId: 'job_private' }) });

    expect(response.status).toBe(403);
  });

  it('同一服务身份只能读取自己 org/corpus 且已发布的课程', async () => {
    const { GET } = await import('@/app/api/classroom/route');
    const request = new NextRequest('http://127.0.0.1:3210/api/classroom?id=course_private', {
      headers: serviceHeaders(),
    });

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.canReadCourse).not.toHaveBeenCalled();
    expect(mocks.isCourseLearnerReleased).toHaveBeenCalled();
  });

  it('服务身份不能读取别的机构课程', async () => {
    mocks.readClassroom.mockResolvedValue(storedClassroom('org-b'));
    const { GET } = await import('@/app/api/classroom/route');
    const request = new NextRequest('http://127.0.0.1:3210/api/classroom?id=course_private', {
      headers: serviceHeaders(),
    });

    const response = await GET(request);

    expect(response.status).toBe(403);
  });
});
