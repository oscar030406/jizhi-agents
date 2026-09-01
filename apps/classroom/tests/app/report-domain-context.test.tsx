// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const testState = vi.hoisted(() => ({
  assignedDomain: 'smart-manufacturing' as 'smart-manufacturing' | null,
  blueprintRequests: [] as Array<{ learningGoal?: string; profile?: Record<string, unknown> }>,
  loadedStageIds: [] as string[],
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('motion/react', () => ({ motion: { div: 'div' } }));
vi.mock('@number-flow/react', () => ({ default: () => null }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('@/components/report/evidence-trajectory-chart', () => ({
  EvidenceTrajectoryChart: () => null,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: async () => [
    { id: 'ai-course', name: 'AI 智能体入门' },
    { id: 'mfg-course', name: 'ROS2 与 PLC 产线协同' },
  ],
  loadStageData: async (stageId: string) => {
    testState.loadedStageIds.push(stageId);
    return {
      stage: {
        id: stageId,
        name: stageId === 'mfg-course' ? 'ROS2 与 PLC 产线协同' : 'AI 智能体入门',
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
  testState.blueprintRequests = [];
  testState.loadedStageIds = [];
  window.localStorage.setItem(
    'learnerProfile',
    JSON.stringify({ domain: 'ai', corpus: 'ai', role: '学生' }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/org/assignments') {
        return ok({
          assignments: testState.assignedDomain
            ? [{ id: 'assign-mfg', courseId: 'mfg-course', createdAt: '2026-09-01T00:00:00Z' }]
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
  it('智能制造指派覆盖旧 AI 画像，并把学情缺失与统一路径口径如实显示', async () => {
    testState.assignedDomain = 'smart-manufacturing';

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    expect(testState.loadedStageIds).toEqual(['mfg-course']);
    expect(testState.blueprintRequests).toHaveLength(1);
    expect(testState.blueprintRequests[0]).toMatchObject({
      learningGoal: 'ROS2 与 PLC 产线协同',
      profile: { domain: 'smart-manufacturing', corpus: 'smart-manufacturing' },
    });
    expect(host.textContent).toContain('智能制造：ROS2 与 S7-1200 PLC');
    expect(host.textContent).toContain('所属机构尚未提供该领域的学情数据');
    expect(host.textContent).toContain('完整路径统一由路径全景页按当前有效领域读取引擎产物');
    expect(host.textContent).not.toContain('从高数、Python');
    expect(host.textContent).not.toContain('Agent');
    expect(host.textContent).not.toContain('RAG');
    expect(host.textContent).not.toContain('Python');
    expect(host.querySelector('a[href="/path"]')).not.toBeNull();
  });

  it('没有课程指派时保持 AI 画像与 AI 课程诊断', async () => {
    testState.assignedDomain = null;

    await act(async () => root.render(<ReportPage />));
    await flush(4);

    expect(testState.loadedStageIds).toEqual(['ai-course']);
    expect(testState.blueprintRequests).toHaveLength(1);
    expect(testState.blueprintRequests[0]).toMatchObject({
      learningGoal: 'AI 智能体入门',
      profile: { domain: 'ai', corpus: 'ai' },
    });
    expect(host.textContent).toContain('AI 学情诊断');
    expect(host.textContent).toContain('RAG');
  });
});
