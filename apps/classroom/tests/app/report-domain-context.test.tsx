// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const testState = vi.hoisted(() => ({
  assignedDomain: 'smart-manufacturing' as 'smart-manufacturing' | null,
  assignmentsFail: false,
  assignmentUnavailable: false,
  secondMfgCourse: false,
  blueprintRequests: [] as Array<{ learningGoal?: string; profile?: Record<string, unknown> }>,
  pathRequests: [] as string[],
  loadedStageIds: [] as string[],
  trajectoryDomains: [] as Array<string | undefined>,
  profileRequests: 0,
  serverProfile: null as Record<string, unknown> | null,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('motion/react', () => ({ motion: { div: 'div' } }));
vi.mock('@number-flow/react', () => ({ default: () => null }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('@/components/report/evidence-trajectory-chart', () => ({
  EvidenceTrajectoryChart: ({ domain }: { domain?: string }) => {
    testState.trajectoryDomains.push(domain);
    return null;
  },
}));
vi.mock('@/lib/evidence/ledger', () => ({
  readLedger: async () => ({
    evidence: [
      {
        id: 'ai-control',
        learnerKey: 'learner',
        measured: { kind: 'concept', domain: 'ai', concept: '控制' },
        source: { interactionId: 'ai', resourceId: 'ai-course', at: '2026-09-01T02:00:00Z' },
        verdict: { outcome: 'incorrect', because: { hit: [], missed: ['控制'] } },
        verdictScope: 'per-kc',
        context: { encounter: 1, modality: 'quiz' },
      },
      {
        id: 'mfg-control',
        learnerKey: 'learner',
        measured: { kind: 'concept', domain: 'smart-manufacturing', concept: '控制' },
        source: { interactionId: 'mfg', resourceId: 'mfg-course', at: '2026-09-01T01:00:00Z' },
        verdict: { outcome: 'correct', because: { hit: ['控制'], missed: [] } },
        verdictScope: 'per-kc',
        context: { encounter: 1, modality: 'quiz' },
      },
    ],
    signals: [],
    invalidations: [],
    giveUps: [],
  }),
  history: (ledger: { evidence: unknown[] }) => ledger.evidence,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: async () => [
    { id: 'ai-course', name: 'AI 智能体入门' },
    { id: 'mfg-course', name: 'ROS2 与 PLC 产线协同' },
    ...(testState.secondMfgCourse ? [{ id: 'mfg-course-2', name: '智能产线故障诊断实战' }] : []),
  ],
  loadStageData: async (stageId: string) => {
    testState.loadedStageIds.push(stageId);
    return {
      stage: {
        id: stageId,
        name:
          stageId === 'mfg-course'
            ? 'ROS2 与 PLC 产线协同'
            : stageId === 'mfg-course-2'
              ? '智能产线故障诊断实战'
              : 'AI 智能体入门',
      },
      scenes: [],
      outline: { outlines: [] },
    };
  },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { default: ReportPage } = await import('@/app/report/page');

const ok = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const BLUEPRINT = {
  mastery_vector: { rag: 0.4 },
  weak_concepts: ['rag'],
  recommended_difficulty: 'L2',
  diagnosis_summary: 'AI 学情诊断',
  learning_risks: [],
  blueprint: {
    refined_goal: '掌握 AI 智能体',
    skill_gaps: [],
    resource_mix: { quiz_difficulty_band: ['L1', 'L2'], rationale: [] },
  },
};

async function flush(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  testState.assignedDomain = 'smart-manufacturing';
  testState.assignmentsFail = false;
  testState.assignmentUnavailable = false;
  testState.secondMfgCourse = false;
  testState.blueprintRequests = [];
  testState.pathRequests = [];
  testState.loadedStageIds = [];
  testState.trajectoryDomains = [];
  testState.profileRequests = 0;
  window.localStorage.setItem(
    'learnerProfile',
    JSON.stringify({
      domain: 'ai',
      corpus: 'ai',
      role: '学生',
      conceptMastery: { AI扁平旧数据: 0.99 },
      conceptConfidence: { AI扁平旧数据: 0.99 },
      conceptRecall: { AI扁平旧数据: 0.99 },
      conceptMasteryByDomain: {
        ai: { AI专属概念: 0.8, 控制: 0.95 },
        'smart-manufacturing': { 制造专属概念: 0.3, 控制: 0.95 },
      },
      conceptConfidenceByDomain: {
        ai: { AI专属概念: 0.5, 控制: 0.5 },
        'smart-manufacturing': { 制造专属概念: 0.4, 控制: 0.5 },
      },
      conceptRecallByDomain: {
        ai: { AI专属概念: 0.7, 控制: 0.5 },
        'smart-manufacturing': { 制造专属概念: 0.2, 控制: 0.5 },
      },
    }),
  );
  testState.serverProfile = JSON.parse(window.localStorage.getItem('learnerProfile') ?? 'null');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/profile') {
        testState.profileRequests += 1;
        return ok({ fields: testState.serverProfile });
      }
      if (url === '/api/org/assignments') {
        if (testState.assignmentsFail) return ok({}, 503);
        return ok({
          memberRole: 'member',
          assignments: testState.assignedDomain
            ? [
                ...(testState.secondMfgCourse
                  ? [
                      {
                        id: 'assign-mfg-2',
                        courseId: 'mfg-course-2',
                        createdAt: '2026-09-01T01:00:00Z',
                        availability: 'ready',
                      },
                    ]
                  : []),
                {
                  id: 'assign-mfg',
                  courseId: 'mfg-course',
                  createdAt: '2026-09-01T00:00:00Z',
                  ...(testState.assignmentUnavailable
                    ? {
                        availability: 'unavailable',
                        unavailableReason: '机构课程暂不可用：课程尚未通过发布审核。',
                      }
                    : {}),
                },
              ]
            : [],
        });
      }
      if (url === '/api/course-domains') {
        return ok({
          'ai-course': { domain: 'ai', corpus: 'ai', title: 'AI 智能体入门' },
          'mfg-course': {
            domain: 'smart-manufacturing',
            corpus: 'smart-manufacturing',
            title: 'ROS2 与 PLC 产线协同',
          },
          'mfg-course-2': {
            domain: 'smart-manufacturing',
            corpus: 'smart-manufacturing',
            title: '智能产线故障诊断实战',
          },
        });
      }
      if (url === '/api/domains') {
        return ok({
          entries: {
            ai: { corpus: 'ai', label: '人工智能', eligible: true },
            'smart-manufacturing': {
              corpus: 'smart-manufacturing',
              label: '智能制造：ROS2 与 S7-1200 PLC',
              eligible: true,
            },
          },
        });
      }
      if (url === '/api/adaptive/blueprint') {
        testState.blueprintRequests.push(JSON.parse(String(init?.body ?? '{}')));
        return testState.assignedDomain ? ok({}, 204) : ok({ blueprint: BLUEPRINT });
      }
      if (url.startsWith('/api/domain-path/')) {
        const domain = decodeURIComponent(url.slice('/api/domain-path/'.length));
        testState.pathRequests.push(domain);
        return ok({
          success: true,
          path: {
            label: domain === 'ai' ? '人工智能' : '智能制造：ROS2 与 S7-1200 PLC',
            source: 'engine',
            stages: [
              { title: '第一阶段', concepts: [{ name: `${domain}-path`, status: 'current' }] },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('/report 有效领域一致性', () => {
  it('新浏览器没有 localStorage 时仍使用登录账户的服务端画像', async () => {
    window.localStorage.clear();
    testState.assignedDomain = null;
    testState.serverProfile = {
      domain: 'ai',
      corpus: 'ai',
      role: '学生',
      conceptMasteryByDomain: { ai: { 服务端概念: 0.8 } },
      conceptConfidenceByDomain: { ai: { 服务端概念: 0.7 } },
      conceptRecallByDomain: { ai: { 服务端概念: 0.6 } },
    };

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    expect(testState.profileRequests).toBe(1);
    expect(testState.loadedStageIds).toEqual(['ai-course']);
    expect(testState.blueprintRequests[0]).toMatchObject({
      profile: { domain: 'ai', corpus: 'ai', conceptMastery: { 服务端概念: 0.8 } },
    });
  });

  it('智能制造指派覆盖旧 AI 画像，并把学情缺失与统一路径口径如实显示', async () => {
    testState.assignedDomain = 'smart-manufacturing';

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    expect(testState.loadedStageIds).toEqual(['mfg-course']);
    expect(testState.blueprintRequests).toHaveLength(1);
    expect(testState.blueprintRequests[0]).toMatchObject({
      learningGoal: 'ROS2 与 PLC 产线协同',
      profile: {
        domain: 'smart-manufacturing',
        corpus: 'smart-manufacturing',
        conceptMastery: { 制造专属概念: 0.3, 控制: 0.95 },
        conceptConfidence: { 制造专属概念: 0.4, 控制: 0.5 },
        conceptRecall: { 制造专属概念: 0.2, 控制: 0.5 },
      },
    });
    expect(testState.blueprintRequests[0].profile?.conceptMastery).not.toHaveProperty('AI专属概念');
    expect(testState.blueprintRequests[0].profile?.conceptMastery).not.toHaveProperty(
      'AI扁平旧数据',
    );
    expect(host.textContent).toContain('智能制造：ROS2 与 S7-1200 PLC');
    expect(host.textContent).toContain('所属机构尚未提供该领域的学情数据');
    expect(host.textContent).toContain('报告、首页与路径页读取同一份引擎产物');
    expect(host.textContent).toContain('smart-manufacturing-path');
    expect(testState.pathRequests).toContain('smart-manufacturing');
    expect(host.textContent).not.toContain('从高数、Python');
    expect(host.textContent).not.toContain('Agent');
    expect(host.textContent).not.toContain('RAG');
    expect(host.textContent).not.toContain('Python');
    expect(host.textContent).toContain('制造专属概念');
    expect(host.textContent).not.toContain('AI专属概念');
    expect(host.textContent).not.toContain('AI扁平旧数据');
    expect(host.textContent).not.toContain('最近错过');
    expect(testState.trajectoryDomains).toContain('smart-manufacturing');
    expect(host.querySelector('a[href="/path"]')).not.toBeNull();
  });

  it('同域两门 ready 指派都进入报告选择器并可分别加载', async () => {
    testState.secondMfgCourse = true;

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    const select = host.querySelector<HTMLSelectElement>('select[aria-label="选择课程"]');
    expect(select).not.toBeNull();
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual([
      'mfg-course',
      'mfg-course-2',
    ]);
    expect(testState.loadedStageIds).toEqual(['mfg-course']);

    await act(async () => {
      if (!select) return;
      select.value = 'mfg-course-2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush(4);

    expect(testState.loadedStageIds).toEqual(['mfg-course', 'mfg-course-2']);
    expect(testState.blueprintRequests.map((request) => request.learningGoal)).toEqual([
      'ROS2 与 PLC 产线协同',
      '智能产线故障诊断实战',
    ]);
  });

  it('没有课程指派时保持 AI 画像与 AI 课程诊断', async () => {
    testState.assignedDomain = null;

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    expect(testState.loadedStageIds).toEqual(['ai-course']);
    expect(testState.blueprintRequests).toHaveLength(1);
    expect(testState.blueprintRequests[0]).toMatchObject({
      learningGoal: 'AI 智能体入门',
      profile: {
        domain: 'ai',
        corpus: 'ai',
        conceptMastery: { AI专属概念: 0.8, 控制: 0.95 },
      },
    });
    expect(testState.blueprintRequests[0].profile?.conceptMastery).not.toHaveProperty(
      '制造专属概念',
    );
    expect(host.textContent).toContain('AI 学情诊断');
    expect(host.textContent).toContain('ai-path');
    expect(testState.pathRequests).toContain('ai');
    expect(host.textContent).toContain('RAG');
    expect(host.textContent).toContain('AI专属概念');
    expect(host.textContent).not.toContain('制造专属概念');
    expect(host.textContent).not.toContain('AI扁平旧数据');
    expect(testState.trajectoryDomains).toContain('ai');
  });

  it('有效领域接口失败时显式未覆盖，不回退扁平 AI 学情', async () => {
    testState.assignmentsFail = true;

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    expect(host.textContent).toContain('课程指派暂时无法确认');
    expect(host.textContent).toContain('没有继续按旧画像回退');
    expect(host.textContent).not.toContain('AI扁平旧数据');
    expect(host.textContent).not.toContain('AI专属概念');
    expect(testState.trajectoryDomains).toContain(undefined);
  });

  it('机构课程 unavailable 时报告停在缺失态，不加载课程或旧 AI 诊断', async () => {
    testState.assignedDomain = 'smart-manufacturing';
    testState.assignmentUnavailable = true;

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    expect(host.textContent).toContain('机构课程暂不可用');
    expect(host.textContent).toContain('尚未通过发布审核');
    expect(testState.loadedStageIds).toEqual([]);
    expect(testState.blueprintRequests).toEqual([]);
    expect(host.textContent).not.toContain('AI 学情诊断');
    expect(host.textContent).not.toContain('AI专属概念');
  });
});
