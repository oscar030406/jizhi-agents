import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  auditCourseContent: vi.fn(),
  buildAuditPanel: vi.fn(),
  fetchEvidence: vi.fn(),
  requireCorpusVisible: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/generation/hallucination-audit', () => ({
  auditCourseContent: mocks.auditCourseContent,
}));
vi.mock('@/lib/generation/evidence-grounding', () => ({
  fetchEvidence: mocks.fetchEvidence,
  evidenceForJudge: (bundle: { chunks: Array<{ source_id: string; content: string }> }) =>
    bundle.chunks.map((chunk) => `[${chunk.source_id}] ${chunk.content}`).join('\n'),
}));
vi.mock('@/lib/server/audit-panel', () => ({ buildAuditPanel: mocks.buildAuditPanel }));
vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: mocks.requireCorpusVisible,
}));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/server/llm-error-response', () => ({
  llmApiError: (error: unknown) =>
    NextResponse.json({ success: false, error: String(error) }, { status: 500 }),
}));

import { POST } from '@/app/api/generate/course-audit/route';

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  type: 'slide',
  title: '第一屏',
  order: 1,
  content: { type: 'slide', canvas: { id: 'canvas-1', elements: [] } },
  actions: [],
  createdAt: 1,
  updatedAt: 1,
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/generate/course-audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/generate/course-audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireCorpusVisible.mockResolvedValue({ ok: true, account: { id: 'acct-1' } });
    mocks.resolveModelFromRequest.mockResolvedValue({ modelString: 'generator' });
    mocks.fetchEvidence.mockResolvedValue({
      chunks: [{ source_id: 'S1', title: '教材', content: '批准材料' }],
      matchedConcepts: [],
      summary: '',
    });
    mocks.buildAuditPanel.mockResolvedValue({
      judgeCalls: [vi.fn(), vi.fn()],
      arbiterCall: vi.fn(),
      defendCall: vi.fn(),
      reviseCall: vi.fn(),
      judgeModel: 'judge-a',
      judgeModels: ['judge-a', 'judge-b'],
      arbiterModel: 'arbiter',
      describe: 'panel',
    });
    mocks.auditCourseContent.mockResolvedValue({
      verdict: 'pass',
      decision: 'publish',
      panelComplete: true,
      claims: [],
      totalClaims: 0,
    });
  });

  it('checks corpus access and reuses the shared audit panel', async () => {
    const response = await POST(
      request({ courseTitle: '测试课', corpus: 'manufacturing', scenes: [scene] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      audit: { verdict: 'pass', decision: 'publish', panelComplete: true },
    });
    expect(mocks.requireCorpusVisible).toHaveBeenCalledWith('manufacturing');
    expect(mocks.auditCourseContent).toHaveBeenCalledWith(
      expect.objectContaining({
        courseTitle: '测试课',
        scenes: [scene],
        judgeModels: ['judge-a', 'judge-b'],
        corpus: 'manufacturing',
        evidenceCount: 1,
      }),
    );
  });

  it('stops before model resolution when the corpus is not visible', async () => {
    mocks.requireCorpusVisible.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }),
    });
    const response = await POST(
      request({ courseTitle: '测试课', corpus: 'private', scenes: [scene] }),
    );
    expect(response.status).toBe(403);
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.auditCourseContent).not.toHaveBeenCalled();
  });

  it('rejects anonymous callers with 401 even for a public corpus', async () => {
    mocks.requireCorpusVisible.mockResolvedValue({ ok: true, account: null });
    const response = await POST(request({ courseTitle: '测试课', corpus: 'ai', scenes: [scene] }));

    expect(response.status).toBe(401);
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.auditCourseContent).not.toHaveBeenCalled();
  });

  it('rejects excessive scene count before model or evidence calls', async () => {
    const response = await POST(
      request({ courseTitle: '超长课', corpus: 'ai', scenes: Array.from({ length: 65 }, () => scene) }),
    );

    expect(response.status).toBe(413);
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.fetchEvidence).not.toHaveBeenCalled();
  });

  it('rejects excessive total input before model or evidence calls', async () => {
    const response = await POST(
      request({
        courseTitle: '超大课',
        corpus: 'ai',
        scenes: [{ ...scene, content: { text: 'x'.repeat(2_000_000) } }],
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.fetchEvidence).not.toHaveBeenCalled();
  });
});
