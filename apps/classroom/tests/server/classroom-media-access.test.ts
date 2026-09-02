import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountForSession: vi.fn(),
  orgForAccount: vi.fn(),
  assignmentsOf: vi.fn(),
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
  assignmentsOf: mocks.assignmentsOf,
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

async function getMedia(classroomId = 'course-a', range?: string) {
  const { GET } = await import('@/app/api/classroom-media/[classroomId]/[...path]/route');
  return GET(
    new NextRequest(`http://localhost/api/classroom-media/${classroomId}/audio/a.mp3`, {
      headers: range ? { Range: range } : undefined,
    }),
    { params: Promise.resolve({ classroomId, path: ['audio', 'a.mp3'] }) },
  );
}

describe('GET /api/classroom-media course ACL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountForSession.mockResolvedValue(null);
    mocks.orgForAccount.mockResolvedValue(null);
    mocks.assignmentsOf.mockResolvedValue([]);
    mocks.corpusOwnership.mockResolvedValue(new Map());
    mocks.readClassroom.mockResolvedValue({ stage: { name: '公共课程' }, scenes: [] });
    mocks.isCourseLearnerReleased.mockReturnValue(true);
    mocks.realpath.mockResolvedValue('D:\\classrooms\\course-a\\audio\\a.mp3');
    mocks.stat.mockResolvedValue({ isFile: () => true, size: 5 });
    mocks.createReadStream.mockImplementation(
      (_file: string, options?: { start?: number; end?: number }) => {
        const bytes = Buffer.from('media');
        return Readable.from(
          bytes.subarray(options?.start ?? 0, (options?.end ?? bytes.length - 1) + 1),
        );
      },
    );
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

  it('同机构未指派 member 不能读取私有媒体', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'member-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'member' });
    mocks.readClassroom.mockResolvedValue({
      stage: { name: '私有课程', origin: { corpus: 'private-a' } },
      scenes: [],
    });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));

    const response = await getMedia();

    expect(response.status).toBe(404);
    expect(mocks.createReadStream).not.toHaveBeenCalled();
  });

  it('同机构 member 指派后可读取私有媒体，但响应禁止缓存', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'member-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'member' });
    mocks.assignmentsOf.mockResolvedValue([{ courseId: 'course-a' }]);
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

  it('机构 owner 无需指派即可读取本机构草稿媒体', async () => {
    mocks.accountForSession.mockResolvedValue({ id: 'owner-a' });
    mocks.orgForAccount.mockResolvedValue({ id: 'org-a', memberRole: 'owner' });
    mocks.isCourseLearnerReleased.mockReturnValue(false);
    mocks.readClassroom.mockResolvedValue({
      stage: { name: '私有课程', origin: { corpus: 'private-a' } },
      scenes: [],
    });
    mocks.corpusOwnership.mockResolvedValue(new Map([['private-a', 'org-a']]));

    expect((await getMedia()).status).toBe(200);
    expect(mocks.assignmentsOf).not.toHaveBeenCalled();
  });

  it('公共课程媒体保持公开缓存', async () => {
    const response = await getMedia();

    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
  });

  it('公共课程媒体支持单段 Range 请求', async () => {
    const response = await getMedia('course-a', 'bytes=1-3');

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-3/5');
    expect(response.headers.get('content-length')).toBe('3');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(mocks.createReadStream).toHaveBeenCalledWith(expect.any(String), { start: 1, end: 3 });
    expect(await response.text()).toBe('edi');
  });

  it('不可满足的 Range 返回不可缓存的 416', async () => {
    const response = await getMedia('course-a', 'bytes=9-');

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */5');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.createReadStream).not.toHaveBeenCalled();
  });
});
