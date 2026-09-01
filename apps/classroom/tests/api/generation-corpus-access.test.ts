import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireCorpusVisible: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
  buildRequestOrigin: vi.fn(),
  fetchLearnerBlueprint: vi.fn(),
}));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: mocks.requireCorpusVisible,
}));
vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
}));
vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));
vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
}));
vi.mock('@/lib/generation/learner-profile', () => ({
  corpusOf: (profile?: { corpus?: string }) => profile?.corpus ?? null,
  fetchLearnerBlueprint: mocks.fetchLearnerBlueprint,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function request(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe('external generation corpus access gate', () => {
  it('generate-classroom 原样返回 403 且不创建或运行 job', async () => {
    const denied = new Response(JSON.stringify({ success: false, error: '无权访问该知识库' }), {
      status: 403,
    });
    mocks.requireCorpusVisible.mockResolvedValue({ ok: false, response: denied });
    const { POST } = await import('@/app/api/generate-classroom/route');

    const response = await POST(
      request('/api/generate-classroom', {
        requirement: '生成私有域课程',
        learnerProfile: { corpus: 'private-domain' },
      }),
    );

    expect(response).toBe(denied);
    expect(response.status).toBe(403);
    expect(mocks.requireCorpusVisible).toHaveBeenCalledWith('private-domain');
    expect(mocks.buildRequestOrigin).not.toHaveBeenCalled();
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.runClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('adaptive/blueprint 原样返回 403 且不调用引擎', async () => {
    const denied = new Response(JSON.stringify({ success: false, error: '无权访问该知识库' }), {
      status: 403,
    });
    mocks.requireCorpusVisible.mockResolvedValue({ ok: false, response: denied });
    const { POST } = await import('@/app/api/adaptive/blueprint/route');

    const response = await POST(
      request('/api/adaptive/blueprint', {
        learningGoal: '学习私有域',
        profile: { corpus: 'private-domain' },
      }),
    );

    expect(response).toBe(denied);
    expect(response.status).toBe(403);
    expect(mocks.requireCorpusVisible).toHaveBeenCalledWith('private-domain');
    expect(mocks.fetchLearnerBlueprint).not.toHaveBeenCalled();
  });
});
