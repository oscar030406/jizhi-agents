import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decideCourseLearnerRelease: vi.fn(),
  generateClassroom: vi.fn(),
  markFailed: vi.fn(),
  markRunning: vi.fn(),
  markSucceeded: vi.fn(),
  updateProgress: vi.fn(),
}));

vi.mock('@/lib/generation/learner-release', () => ({
  decideCourseLearnerRelease: mocks.decideCourseLearnerRelease,
}));
vi.mock('@/lib/server/classroom-generation', () => ({
  generateClassroom: mocks.generateClassroom,
}));
vi.mock('@/lib/server/classroom-job-store', () => ({
  markClassroomGenerationJobFailed: mocks.markFailed,
  markClassroomGenerationJobRunning: mocks.markRunning,
  markClassroomGenerationJobSucceeded: mocks.markSucceeded,
  updateClassroomGenerationJobProgress: mocks.updateProgress,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateClassroom.mockResolvedValue({
    id: 'course-a',
    url: '/classroom/course-a',
    stage: {},
    scenes: [],
    scenesCount: 0,
    createdAt: '2026-09-02T00:00:00.000Z',
  });
});

it('保存草稿后若未通过学习者发布审核，任务如实失败并保留拦截原因', async () => {
  mocks.decideCourseLearnerRelease.mockReturnValue({
    eligible: false,
    courseReasons: ['learning_contract_unfulfilled'],
    contractViolations: ['缺少实操项目'],
    blockedScenes: [{ sceneId: 'scene-2', reasons: ['incorrect_claim'] }],
  });
  const { runClassroomGenerationJob } = await import('@/lib/server/classroom-job-runner');

  await runClassroomGenerationJob('job-a', { requirement: '生成课程' }, 'http://localhost');

  expect(mocks.markSucceeded).not.toHaveBeenCalled();
  expect(mocks.markFailed).toHaveBeenCalledWith(
    'job-a',
    '课程已保存为草稿，未通过发布审核：learning_contract_unfulfilled; 缺少实操项目; scene-2: incorrect_claim',
  );
});

it('并发场景乱序上报时任务进度不倒退', async () => {
  mocks.decideCourseLearnerRelease.mockReturnValue({
    eligible: true,
    courseReasons: [],
    contractViolations: [],
    blockedScenes: [],
  });
  mocks.generateClassroom.mockImplementation(async (_input, options) => {
    await options.onProgress({
      step: 'generating_scenes',
      progress: 70,
      message: 'scene 7',
      scenesGenerated: 7,
    });
    await options.onProgress({
      step: 'generating_scenes',
      progress: 43,
      message: 'scene 3 retry',
      scenesGenerated: 7,
    });
    return {
      id: 'course-a',
      url: '/classroom/course-a',
      stage: {},
      scenes: [],
      scenesCount: 0,
      createdAt: '2026-09-02T00:00:00.000Z',
    };
  });
  const { runClassroomGenerationJob } = await import('@/lib/server/classroom-job-runner');

  await runClassroomGenerationJob('job-progress', { requirement: '生成课程' }, 'http://localhost');

  expect(mocks.updateProgress.mock.calls.map(([, progress]) => progress.progress)).toEqual([
    70, 70,
  ]);
  expect(mocks.markSucceeded).toHaveBeenCalledOnce();
});
