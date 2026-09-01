import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const streamLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const readDomainRegistryMock = vi.hoisted(() => vi.fn());
const VOCATIONAL_FLAG = 'OPENMAIC_ENABLE_VOCATIONAL';
let originalVocationalFlag: string | undefined;

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

vi.mock('@/lib/server/domain-registry', () => ({
  readDomainRegistry: readDomainRegistryMock,
}));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: vi.fn().mockResolvedValue({ ok: true }),
}));

async function readStreamBody(response: Response) {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let text = '';

  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  return text;
}

function parseSseEvents(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

function mockRequest(requirements: Record<string, unknown>) {
  return {
    json: async () => ({
      requirements,
      pdfText: '',
      pdfImages: [],
      imageMapping: {},
      researchContext: '',
    }),
    headers: {
      get: () => null,
    },
  };
}

function withLearningContract<T extends { outlines: Array<Record<string, unknown>> }>(payload: T) {
  const first = payload.outlines[0];
  const practice =
    payload.outlines.find((outline) => outline.type === 'interactive' || outline.type === 'pbl') ??
    first;
  const feedback =
    payload.outlines.find(
      (outline) =>
        outline.type === 'pbl' ||
        outline.type === 'quiz' ||
        (outline.type === 'interactive' &&
          (outline.widgetType === 'game' || outline.widgetType === 'procedural-skill')),
    ) ?? practice;
  const assessment =
    payload.outlines.find(
      (outline) =>
        outline.type === 'quiz' ||
        outline.type === 'pbl' ||
        (outline.type === 'interactive' && outline.widgetType === 'game'),
    ) ??
    payload.outlines.find(
      (outline) => outline.type === 'interactive' && outline.widgetType === 'procedural-skill',
    ) ??
    feedback;

  return {
    ...payload,
    learningContract: {
      objectives: [
        {
          id: 'O1',
          action: '完成本课要求的可观察任务',
          condition: '给定课程中的新案例或操作条件',
          successCriterion: '产出达到场景中声明的验收标准',
        },
      ],
      prerequisiteActivation: [String(first.id)],
      demonstration: [String(first.id)],
      learnerPractice: [String(practice.id)],
      feedbackRetry: [String(feedback.id)],
      transferApplication: [String(assessment.id)],
      assessmentMap: [{ sceneId: String(assessment.id), objectiveIds: ['O1'] }],
      grounding: {
        sourceRefs: ['corpus:ai'],
        claimPolicy: 'cite-or-mark-uncertain',
      },
    },
  };
}

describe('task-engine outline route', () => {
  beforeEach(() => {
    originalVocationalFlag = process.env[VOCATIONAL_FLAG];
    delete process.env[VOCATIONAL_FLAG];
    readDomainRegistryMock.mockReset();
    readDomainRegistryMock.mockResolvedValue({
      entries: {
        ai: { corpus: 'ai', hands_on_safety: false },
        'smart-manufacturing': {
          corpus: 'smart-manufacturing',
          hands_on_safety: true,
        },
      },
      generatedAt: null,
      sourceRunId: null,
    });
  });

  afterEach(() => {
    if (originalVocationalFlag === undefined) {
      delete process.env[VOCATIONAL_FLAG];
    } else {
      process.env[VOCATIONAL_FLAG] = originalVocationalFlag;
    }
  });

  test('auto-routes smart-manufacturing practice to task engine and preserves mixed scene types', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();

    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      thinkingConfig: undefined,
    });

    const outlineResponse = JSON.stringify(
      withLearningContract({
        languageDirective: '用中文授课，保持职业教育语境。',
        outlines: [
          {
            id: 'scene_slide',
            type: 'slide',
            title: '高压风险边界',
            description: '解释高压安全边界。',
            keyPoints: ['风险边界', '安全阈值'],
            order: 1,
            widgetType: 'procedural-skill',
            widgetOutline: {
              task: 'should be removed from slide',
            },
          },
          {
            id: 'scene_procedure',
            type: 'interactive',
            title: 'PPE检查',
            description: '完成PPE检查。',
            keyPoints: ['检查绝缘手套', '确认工具状态'],
            order: 2,
            widgetType: 'procedural-skill',
            widgetOutline: {
              steps: ['确认下电', '选择PPE'],
            },
          },
          {
            id: 'scene_game',
            type: 'interactive',
            title: 'GO/STOP挑战',
            description: '根据检测结果做安全裁决。',
            keyPoints: ['读取状态', '选择GO或STOP'],
            order: 3,
            widgetType: 'game',
            widgetOutline: {
              challenge: '判断是否可以继续作业',
            },
          },
          {
            id: 'scene_diagram',
            type: 'interactive',
            title: '高压风险路径',
            description: '查看高压风险传播路径。',
            keyPoints: ['电池包', '维修开关', '测量点'],
            order: 4,
            widgetType: 'diagram',
            widgetOutline: {
              concept: '风险路径',
            },
          },
          {
            id: 'scene_simulation',
            type: 'interactive',
            title: '普通概念模拟',
            description: '非职教 fallback 可保留 simulation。',
            keyPoints: ['变量观察'],
            order: 5,
            widgetType: 'simulation',
            widgetOutline: {
              concept: 'motion',
            },
          },
          {
            id: 'scene_code',
            type: 'interactive',
            title: '代码练习',
            description: '非职教 fallback 可保留 code。',
            keyPoints: ['代码运行'],
            order: 6,
            widgetType: 'code',
            widgetOutline: {},
          },
          {
            id: 'scene_3d',
            type: 'interactive',
            title: '三维观察',
            description: '非职教 fallback 可保留 visualization3d。',
            keyPoints: ['空间结构'],
            order: 7,
            widgetType: 'visualization3d',
            widgetOutline: {},
          },
          {
            id: 'scene_illegal',
            type: 'quiz',
            title: '任务验收',
            description: '用新的设备状态验收目标。',
            keyPoints: ['新状态', '验收证据', 'GO/STOP'],
            order: 8,
            quizConfig: {
              questionCount: 2,
              difficulty: 'medium',
              questionTypes: ['text'],
            },
          },
        ],
      }),
    );

    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield outlineResponse;
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirement: 'NEV-A12 新能源车动力电池包更换前安全确认',
        interactiveMode: true,
        learnerProfile: { corpus: 'smart-manufacturing', domain: 'manufacturing' },
      }) as unknown as Parameters<typeof POST>[0],
    );

    const promptParams = streamLLMMock.mock.calls[0][0] as { system: string; prompt: string };
    expect(promptParams.system).toContain('Task Engine');
    expect(promptParams.system).toContain('procedural-skill');

    const events = parseSseEvents(await readStreamBody(response));
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    expect(done.taskEngineMode).toBe(true);
    expect(done.learningContract.grounding.sourceRefs).toEqual(['corpus:smart-manufacturing']);
    expect(done.outlines).toHaveLength(8);
    expect(done.outlines[0]).toMatchObject({
      type: 'slide',
      title: '高压风险边界',
    });
    expect(done.outlines[0].widgetType).toBeUndefined();
    expect(done.outlines[0].widgetOutline).toBeUndefined();
    expect(done.outlines[1]).toMatchObject({
      type: 'interactive',
      widgetType: 'procedural-skill',
    });
    expect(done.outlines[1].widgetOutline).toMatchObject({
      task: 'NEV-A12 新能源车动力电池包更换前安全确认',
      steps: ['确认下电', '选择PPE'],
    });
    expect(done.outlines[1].widgetOutline.tools.length).toBeGreaterThan(0);
    expect(done.outlines[1].widgetOutline.successCriteria.length).toBeGreaterThan(0);
    expect(done.outlines[1].widgetOutline.errorConsequences.length).toBeGreaterThan(0);
    expect(done.outlines[2]).toMatchObject({
      type: 'interactive',
      widgetType: 'game',
    });
    expect(done.outlines[2].widgetOutline).toMatchObject({
      challenge: '判断是否可以继续作业',
    });
    expect(done.outlines[2].widgetOutline.gameType).toBeUndefined();
    expect(done.outlines[2].widgetOutline.playerControls).toBeUndefined();
    expect(done.outlines[3]).toMatchObject({
      type: 'interactive',
      widgetType: 'diagram',
    });
    expect(done.outlines[3].widgetOutline).toMatchObject({
      concept: '风险路径',
    });
    expect(done.outlines[3].widgetOutline.diagramType).toBeUndefined();
    expect(done.outlines[3].widgetOutline.nodeCount).toBeUndefined();
    expect(done.outlines[4]).toMatchObject({
      type: 'interactive',
      widgetType: 'simulation',
    });
    expect(done.outlines[4].widgetOutline).toMatchObject({
      concept: 'motion',
    });
    expect(done.outlines[4].widgetOutline.keyVariables).toBeUndefined();
    expect(done.outlines[5]).toMatchObject({
      type: 'interactive',
      widgetType: 'code',
    });
    expect(done.outlines[5].widgetOutline.language).toBeUndefined();
    expect(done.outlines[5].widgetOutline.challengeType).toBeUndefined();
    expect(done.outlines[6]).toMatchObject({
      type: 'interactive',
      widgetType: 'visualization3d',
    });
    expect(done.outlines[6].widgetOutline.visualizationType).toBeUndefined();
    expect(done.outlines[6].widgetOutline.objects).toBeUndefined();
    expect(done.outlines[6].widgetOutline.interactions).toBeUndefined();
    expect(done.outlines[7]).toMatchObject({
      type: 'quiz',
      title: '任务验收',
    });
    expect(done.outlines[7].widgetType).toBeUndefined();
    expect(done.outlines[7].widgetOutline).toBeUndefined();
  });

  test('keeps a generic AI course on the existing interactive prompt without hidden flags', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();

    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      thinkingConfig: undefined,
    });

    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield JSON.stringify(
          withLearningContract({
            languageDirective: 'Teach in English.',
            outlines: [
              {
                id: 'scene_1',
                type: 'interactive',
                title: 'Interactive Scene',
                description: 'Explore a concept.',
                keyPoints: ['Explore'],
                order: 1,
                widgetType: 'simulation',
                widgetOutline: { concept: 'motion', keyVariables: ['speed'] },
              },
              {
                id: 'scene_2',
                type: 'quiz',
                title: 'Transfer Check',
                description: 'Apply the idea to a new case.',
                keyPoints: ['New case', 'Reasoning', 'Feedback'],
                order: 2,
                quizConfig: {
                  questionCount: 1,
                  difficulty: 'medium',
                  questionTypes: ['text'],
                },
              },
            ],
          }),
        );
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirement: 'Teach motion with interaction',
        interactiveMode: true,
        learnerProfile: { corpus: 'ai', domain: 'ai' },
      }) as unknown as Parameters<typeof POST>[0],
    );

    const promptParams = streamLLMMock.mock.calls[0][0] as { system: string; prompt: string };
    expect(promptParams.system).toContain('Interactive Mode Outline Generator');
    expect(promptParams.system).not.toContain('Task Engine Outline Generator');

    const events = parseSseEvents(await readStreamBody(response));
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    expect(done.taskEngineMode).toBe(false);
  });

  test('sanitizes procedural-skill outlines when taskEngineMode is disabled', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();

    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      thinkingConfig: undefined,
    });

    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield JSON.stringify(
          withLearningContract({
            languageDirective: 'Teach in English.',
            outlines: [
              {
                id: 'scene_1',
                type: 'interactive',
                title: 'Operation Process',
                description: 'A model mistakenly emitted the gated widget type.',
                keyPoints: ['Step A', 'Step B'],
                order: 1,
                widgetType: 'procedural-skill',
                widgetOutline: {
                  procedureType: 'inspection',
                  task: 'Inspect the device',
                  tools: ['checklist'],
                  steps: ['Check A', 'Check B'],
                  successCriteria: ['Complete'],
                },
              },
              {
                id: 'scene_2',
                type: 'quiz',
                title: 'Process Check',
                description: 'Apply the process to a new case and retry after feedback.',
                keyPoints: ['New case', 'Decision', 'Retry'],
                order: 2,
                quizConfig: {
                  questionCount: 1,
                  difficulty: 'medium',
                  questionTypes: ['text'],
                },
              },
            ],
          }),
        );
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirement: 'Teach a process interactively',
        interactiveMode: true,
      }) as unknown as Parameters<typeof POST>[0],
    );

    const events = parseSseEvents(await readStreamBody(response));
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    expect(done.outlines[0]).toMatchObject({
      type: 'interactive',
      widgetType: 'diagram',
    });
    expect(done.outlines[0].description).toContain('process or structure diagram');
    expect(done.outlines[0].widgetOutline.diagramType).toBeUndefined();
    expect(done.outlines[0].widgetOutline.nodeCount).toBeUndefined();
    expect(done.outlines[0].widgetOutline.procedureType).toBeUndefined();
    expect(done.outlines[0].widgetOutline.task).toBeUndefined();
    expect(done.outlines[0].widgetOutline.tools).toBeUndefined();
    expect(done.outlines[0].widgetOutline.steps).toBeUndefined();
    expect(done.outlines[0].widgetOutline.successCriteria).toBeUndefined();
  });

  test('preserves model-authored scenario PBL subtype through streamed outlines', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();

    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      thinkingConfig: undefined,
    });

    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield JSON.stringify(
          withLearningContract({
            languageDirective: '用中文授课。',
            outlines: [
              {
                id: 'scene_pbl',
                type: 'pbl',
                title: '同理沟通练习',
                description: '练习安慰压力很大的朋友。',
                keyPoints: ['倾听', '回应'],
                order: 1,
                pblConfig: {
                  projectTopic: '同理沟通练习',
                  projectDescription: '练习安慰压力很大的朋友。',
                  targetSkills: ['倾听', '回应'],
                  issueCount: 2,
                  scenarioRoleplay: true,
                  scenarioBrief: '朋友压力很大，学习者练习倾听和支持。',
                },
              },
            ],
          }),
        );
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirement: '生成一个情景模拟 PBL，练习安慰压力很大的朋友',
      }) as unknown as Parameters<typeof POST>[0],
    );

    const events = parseSseEvents(await readStreamBody(response));
    const outline = events.find((event) => event.type === 'outline');
    const done = events.find((event) => event.type === 'done');

    expect(outline).toBeDefined();
    expect(done).toBeDefined();
    expect(outline?.data.pblConfig.scenarioRoleplay).toBe(true);
    expect(done?.outlines[0].pblConfig.scenarioRoleplay).toBe(true);
    expect(done?.outlines[0].pblConfig.scenarioBrief).toContain('朋友压力很大');
  });

  test('ensures streamed outline ids are unique', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();

    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      thinkingConfig: undefined,
    });

    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield JSON.stringify(
          withLearningContract({
            languageDirective: 'Teach in English.',
            outlines: [
              {
                id: 'scene_4',
                type: 'slide',
                title: 'First Scene',
                description: 'First scene.',
                keyPoints: ['A'],
                order: 1,
              },
              {
                id: 'scene_4',
                type: 'slide',
                title: 'Second Scene',
                description: 'Second scene.',
                keyPoints: ['B'],
                order: 2,
              },
              {
                id: 'scene_assessment',
                type: 'quiz',
                title: 'Assessment',
                description: 'Apply the topic in a new case.',
                keyPoints: ['Application', 'Evidence', 'Feedback'],
                order: 3,
                quizConfig: {
                  questionCount: 1,
                  difficulty: 'medium',
                  questionTypes: ['text'],
                },
              },
              {
                id: 'scene_practice',
                type: 'interactive',
                title: 'Guided Practice',
                description: 'Apply the topic with immediate feedback.',
                keyPoints: ['Practice', 'Feedback', 'Retry'],
                order: 4,
                widgetType: 'game',
                widgetOutline: {
                  challenge: 'Apply the topic to a fresh example',
                },
              },
            ],
          }),
        );
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirement: 'Teach a topic',
      }) as unknown as Parameters<typeof POST>[0],
    );

    const events = parseSseEvents(await readStreamBody(response));
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    const ids = done.outlines.map((outline: { id: string }) => outline.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('scene_4');
    expect(ids[1]).not.toBe('scene_4');
  });

  test('blocks publish when a task-engine response lacks its required vocational structure', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    process.env[VOCATIONAL_FLAG] = 'true';

    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      thinkingConfig: undefined,
    });

    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield JSON.stringify(
          withLearningContract({
            languageDirective: 'Teach in English.',
            outlines: [
              {
                id: 'scene_bad',
                type: 'quiz',
                title: 'Pythagorean theorem recap',
                description: 'A non-vocational math topic with an invalid type.',
                keyPoints: ['a squared plus b squared equals c squared'],
                order: 1,
              },
            ],
          }),
        );
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirement: 'Explain the Pythagorean theorem',
        interactiveMode: true,
        taskEngineMode: true,
      }) as unknown as Parameters<typeof POST>[0],
    );

    const events = parseSseEvents(await readStreamBody(response));
    const done = events.find((event) => event.type === 'done');
    const outline = events.find((event) => event.type === 'outline');
    const error = events.find((event) => event.type === 'error');
    expect(done).toBeUndefined();
    expect(outline?.data).toMatchObject({
      type: 'quiz',
      title: 'Pythagorean theorem recap',
    });
    expect(error?.error).toContain('vocational');
  });
});
