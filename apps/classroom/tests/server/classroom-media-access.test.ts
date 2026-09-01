import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  orgForAccount: vi.fn(),
  corpusOwnership: vi.fn(),
  readClassroom: vi.fn(),
  isCourseLearnerReleased: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: { realpath: mocks.realpath, stat: mocks.stat },
  createReadStream: mocks.createReadStream,
}));

vi.mock('@/lib/accounts/store', () => ({ accountForSession: mocks.accountForSession }));
vi.mock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'session' }));
vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: mocks.orgForAccount,
  corpusOwnership: mocks.corpusOwnership,
}));
vi.mock('@/lib/server/classroom-storage', () => ({
  CLASSROOMS_DIR: 'D:\\classrooms',
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
  readClassroom: mocks.readClassroom,
}));
vi.mock('@/lib/generation/learner-release', () => ({
  isCourseLearnerReleased: mocks.isCourseLearnerReleased,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));

async function getMedia(classroomId = 'course-a') {
  const { GET } = await import('@/app/api/classroom-media/[classroomId]/[...path]/route');
  return GET(new NextRequest(`http://localhost/api/classroom-media/${classroomId}/audio/a.mp3`), {
    params: Promise.resolve({ classroomId, path: ['audio', 'a.mp3'] }),
  });
}

describe('GET /api/classroom-media course ACL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountForSession.mockResolvedValue(null);
    mocks.orgForAccount.mockResolvedValue(null);
    mocks.corpusOwnership.mockResolvedValue(new Map());
    mocks.readClassroom.mockResolvedValue({ stage: { name: '公共课程' }, scenes: [] });
    mocks.isCourseLearnerReleased.mockReturnValue(true);
    mocks.realpath.mockResolvedValue('D:\\classrooms\\course-a\\audio\\a.mp3');
    mocks.stat.mockResolvedValue({ isFile: () => true, size: 5 });
    mocks.createReadStream.mockImplementation(() => Readable.from(Buffer.from('media')));
  });

  it('匿名请求私有课程返回 404，且不接触媒体文件', async () => {
    mocks.readClassroom.mockResolvedValue({
      stage: { name: '私有课程', origin: { corpus: 'private-a' } },
      scenes: [],
    });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));

    const response = await getMedia();

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.realpath).not.toHaveBeenCalled();
    expect(mocks.createReadStream).not.toHaveBeenCalled();
  });

  it('未发布课程返回 404，且不接触媒体文件', async () => {
    mocks.isCourseLearnerReleased.mockReturnValue(false);

    const response = await getMedia();

    expect(response.status).toBe(404);
    expect(mocks.realpath).not.toHaveBeenCalled();
  });

  it('其他机构即使知道课程 ID 也只能得到 404', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'member-b' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-b' });
    mocks.readClassroom.mockResolvedValue({
      stage: { name: '私有课程', origin: { corpus: 'private-a' } },
      scenes: [],
    });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));

    const response = await getMedia();

    expect(response.status).toBe(404);
    expect(mocks.realpath).not.toHaveBeenCalled();
  });

  it('同机构成员可读取私有媒体，但响应禁止缓存', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'member-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a' });
    mocks.readClassroom.mockResolvedValue({
      stage: { name: '私有课程', origin: { corpus: 'private-a' } },
      scenes: [],
    });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));

    const response = await getMedia();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.createReadStream).toHaveBeenCalledOnce();
  });

  it('公共课程媒体保持公开缓存', async () => {
    const response = await getMedia();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
  });
});
