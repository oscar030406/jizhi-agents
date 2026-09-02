import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 生成期元数据落库（WO-B1）。
 *
 * 账本 B3 + F3 欠的是同一笔债：生成时知道的三样（档位、目标画像、概念标签）
 * 在落库那一刻全丢了。这里钉两件事：
 *
 * 1. 引擎给了蓝图/证据 → 三样都写进存档；
 * 2. 引擎没给 → **字段整个不存在**，不是 null、不是空对象。
 *    （空值占位会让读的人以为「算出来是空的」，而不是「压根没算」。）
 *
 * 不实际生成课：课程墙冻结中，全部走 mock 夹具。
 */

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  isProviderKeyRequired: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  persistClassroom: vi.fn(),
  callLLM: vi.fn(),
  fetchEvidence: vi.fn(),
  fetchLearnerBlueprint: vi.fn(),
  corpusUnavailableReason: vi.fn(),
  zeroEvidenceReason: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', () => ({ isProviderKeyRequired: mocks.isProviderKeyRequired }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));

vi.mock('@/lib/generation/outline-generator', () => ({
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
}));

vi.mock('@/lib/generation/scene-generator', () => ({
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', () => ({ persistClassroom: mocks.persistClassroom }));
vi.mock('@/lib/server/knowledge-center', () => ({
  corpusUnavailableReason: mocks.corpusUnavailableReason,
}));

// 只替换「出网」的那几个函数，其余（presentationTier / blueprintDirective / 计票口径）
// 用真实现——这条测试要验的正是它们的输出，桩掉就什么都没验。
//
// `zeroEvidenceReason` 也必须桩掉：它是开跑前的零命中闸，自己发一次真请求。
// 不桩的话这条测试就变成「本机引擎起没起就换结果」——2026-08-24 实测，
// 本地引擎一起，它拿 anyLiveCorpus() 选中的 iotdb 去查「教会我 RAG」，
// 确实零命中、当场拦车，测试红。**闸没错，是这条测试的主题不是闸**
// （它验的是元数据落库），所以在这里放行。闸本身另有用例守
// （tests/generation/zero-evidence-preflight.test.ts）。
vi.mock('@/lib/generation/evidence-grounding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation/evidence-grounding')>()),
  fetchEvidence: mocks.fetchEvidence,
  zeroEvidenceReason: mocks.zeroEvidenceReason,
}));
vi.mock('@/lib/generation/learner-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation/learner-profile')>()),
  fetchLearnerBlueprint: mocks.fetchLearnerBlueprint,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: '检索增强怎么做',
  description: '讲清召回与重排',
  keyPoints: ['先召回再重排'],
  order: 1,
} as const;

const slideContent = { elements: [], remark: '先召回再重排' };

const learningContract = {
  teachingStrategy: 'standard' as const,
  objectives: [
    {
      id: 'O1',
      action: 'explain retrieval and reranking',
      condition: 'given a RAG pipeline',
      successCriterion: 'names both stages in order',
    },
  ],
  prerequisiteActivation: ['outline-1'],
  demonstration: ['outline-1'],
  learnerPractice: ['outline-1'],
  feedbackRetry: ['outline-1'],
  transferApplication: ['outline-1'],
  assessmentMap: [{ sceneId: 'outline-1', objectiveIds: ['O1'] }],
  grounding: { sourceRefs: ['corpus:ai'], claimPolicy: 'cite-or-mark-uncertain' as const },
};

/** 五维自评 + 领域/学历，外加两个**不该落盘**的身份/自述字段。 */
const profile = {
  domain: 'ai',
  education: 'bachelor',
  role: '后端开发转型',
  learning_preference: '喜欢先看可运行示例',
  programming_level: 3,
  python_level: 2,
  agent_level: 1,
  rag_level: 1,
  engineering_level: 3,
};

const blueprint = {
  engine: 'llm',
  mastery_vector: {},
  weak_concepts: ['rag'],
  recommended_difficulty: 'L2',
  learning_risks: [],
  diagnosis_summary: '',
  blueprint: {
    refined_goal: '',
    learner_type: '转行工程师',
    skill_gaps: [],
    content_strategy: [],
    practice_strategy: [],
    assessment_strategy: [],
    resource_mix: null,
  },
};

const evidence = {
  chunks: [
    { source_id: 'k1', title: 'A', content: 'a', concept_tags: ['rag', 'llm_basics'] },
    { source_id: 'k2', title: 'B', content: 'b', concept_tags: ['rag'] },
    { source_id: 'k1', title: 'A', content: 'a', concept_tags: ['rag'] },
  ],
  matchedConcepts: ['rag'],
  summary: '',
};

const evidenceOk = { status: 'ok' as const, bundle: evidence };
const evidenceUnconfigured = {
  status: 'unavailable' as const,
  configured: false,
  reason: '本地未配置证据检索桥',
};

async function generate(input: Record<string, unknown> = {}) {
  const { generateClassroom } = await import('@/lib/server/classroom-generation');
  return generateClassroom(
    { requirement: '教会我 RAG', ...input } as Parameters<typeof generateClassroom>[0],
    { baseUrl: 'http://localhost' },
  );
}

/**
 * 取**最后一次** persistClassroom 的入参——那才是「落盘的那门课」。
 *
 * 2026-08-21 起这个函数在一门课的生成过程中会被调多次：每落一屏写一次带
 * `generating` 标记的增量快照（渐进式落盘，让学习者第 1 屏就能进课堂），
 * 完课时再写一次完整版。`generation` 元数据只有完整版才有，所以断言必须看最后一次。
 * 原来写的是 `calls[0][0]`，那是单次落盘时代的写法，现在指向的是第一张半成品快照。
 */
function lastPersisted(source: Pick<typeof mocks, 'persistClassroom'>) {
  const calls = source.persistClassroom.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

/**
 * 盘上任意一个建好索引的扩展库（不含主语料 ai）。一个都没有时返回 null。
 *
 * 存在的理由：这份测试要的只是「某个真库」，而库会随泛化域收敛来来去去。
 * 写死一个名字，等它被删的那天测试就红——红的还不是判据本身。
 */
async function anyLiveCorpus(): Promise<string | null> {
  const { promises: fsp } = await import('node:fs');
  const nodePath = await import('node:path');
  const dir = nodePath.join(
    process.env.ENGINE_DATA_DIR ?? nodePath.join(process.cwd(), '..', 'agent-engine', 'data'),
    'knowledge_base',
    'corpora',
  );
  try {
    for (const name of (await fsp.readdir(dir)).sort()) {
      const idx = nodePath.join(dir, name, 'knowledge_index.jsonl');
      try {
        if ((await fsp.stat(idx)).size > 0) return name;
      } catch {
        /* 这个库没有索引，看下一个 */
      }
    }
  } catch {
    /* 没有引擎数据目录 */
  }
  return null;
}

describe('生成期元数据落库', () => {
  beforeEach(() => {
    // 摘录拼装是另一条线（会真去算咬合度），这条测试只看元数据，关掉它。
    process.env.EXCERPT_ASSEMBLY = '0';
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: {},
      modelString: 'test:model',
      providerId: 'test',
      apiKey: '',
    });
    mocks.isProviderKeyRequired.mockReturnValue(false);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: '用中文。',
        courseTitle: 'RAG 入门',
        outlines: [outline],
        learningContract,
      },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value: unknown) => ({
      ...(value as Record<string, unknown>),
    }));
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.fetchEvidence.mockResolvedValue(evidenceUnconfigured);
    mocks.fetchLearnerBlueprint.mockResolvedValue(null);
    mocks.corpusUnavailableReason.mockResolvedValue(null);
    mocks.zeroEvidenceReason.mockResolvedValue(null);
    mocks.createSceneWithActions.mockImplementation(
      (
        sceneOutline: { type: string; title: string; order: number },
        content: { elements: unknown[] },
        actions: unknown[],
        api: {
          scene: { create: (s: unknown) => { success: boolean; data?: string | null } };
        },
      ) => {
        const sceneResult = api.scene.create({
          type: sceneOutline.type,
          title: sceneOutline.title,
          order: sceneOutline.order,
          content: {
            type: 'slide',
            canvas: {
              id: 'slide-1',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              elements: content.elements,
            },
          },
          actions,
        });
        return sceneResult.success ? (sceneResult.data ?? null) : null;
      },
    );
    mocks.persistClassroom.mockImplementation(async ({ id }: { id: string }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      createdAt: '2026-08-15T00:00:00.000Z',
    }));
  });

  it('蓝图 + 证据在场：档位、目标画像、概念标签三样都落盘', async () => {
    mocks.fetchEvidence.mockResolvedValue(evidenceOk);
    mocks.fetchLearnerBlueprint.mockResolvedValue(blueprint);

    const result = await generate({ learnerProfile: profile });

    expect(mocks.fetchLearnerBlueprint).toHaveBeenCalledTimes(1);
    expect(mocks.generateSceneOutlinesFromRequirements.mock.calls[0][4]).toMatchObject({
      learnerBlueprint: blueprint,
    });

    // 场景级：k1 去重后只算一次 → rag 2 票、llm_basics 1 票，主概念 rag
    expect(result.scenes[0].concepts).toEqual({
      concept: 'rag',
      votes: { rag: 2, llm_basics: 1 },
      citedChunks: 2,
    });

    // 课级：写在课程 JSON 根级，不动 @openmaic/dsl 的 Stage 契约
    const persisted = lastPersisted(mocks);
    expect('generation' in persisted.stage).toBe(false);
    expect(persisted.generation).toEqual({
      recommendedDifficulty: 'L2',
      // programming_level=3、agent_level=1、engineering_level=3 → 真 presentationTier 算出 L2
      presentationTier: 'L2',
      engine: 'llm',
      learnerType: '转行工程师',
      profile: {
        domain: 'ai',
        education: 'bachelor',
        programmingLevel: 3,
        pythonLevel: 2,
        agentLevel: 1,
        ragLevel: 1,
        engineeringLevel: 3,
      },
    });
  });

  it('domain-only 画像的有效语料库同时进入 readiness 与零证据闸', async () => {
    await generate({ learnerProfile: { domain: 'domain-only' } });

    expect(mocks.corpusUnavailableReason).toHaveBeenCalledWith('domain-only');
    expect(mocks.zeroEvidenceReason).toHaveBeenCalledWith('教会我 RAG', 'domain-only');
  });

  it('显式选了知识库就记进课级元数据；没选不占位', async () => {
    mocks.fetchEvidence.mockResolvedValue(evidenceOk);
    mocks.fetchLearnerBlueprint.mockResolvedValue(blueprint);

    // 库名不写死。原来钉的是 odoo，2026-08-23 泛化域收敛把它删掉之后这条就红了
    // ——**这一条要证的是「选了库就记进元数据」，不是「odoo 必须存在」**。
    // 生成链开跑前有一道闸会拒绝没建索引的库（classroom-generation.ts 的
    // corpusUnavailableReason），所以这里必须挑一个盘上真有的。
    const corpus = await anyLiveCorpus();
    if (!corpus) {
      console.warn('跳过：本机一个建好索引的扩展库都没有');
      return;
    }
    await generate({ learnerProfile: { ...profile, corpus } });
    expect(lastPersisted(mocks).generation.profile.corpus).toBe(corpus);

    mocks.persistClassroom.mockClear();
    await generate({ learnerProfile: profile });
    expect('corpus' in lastPersisted(mocks).generation.profile).toBe(false);
  });

  it('脱敏：身份自述与偏好自述一个都不落盘（赛题第(5)款）', async () => {
    mocks.fetchEvidence.mockResolvedValue(evidenceOk);
    mocks.fetchLearnerBlueprint.mockResolvedValue(blueprint);

    await generate({ learnerProfile: profile });

    const persisted = lastPersisted(mocks);
    const dumped = JSON.stringify(persisted.generation);
    expect(dumped).not.toContain('后端开发转型');
    expect(dumped).not.toContain('可运行示例');
    expect('role' in persisted.generation.profile).toBe(false);
  });

  it('本地未配置证据桥：两个字段整个不存在，不是 null、不是空对象', async () => {
    mocks.fetchEvidence.mockResolvedValue(evidenceUnconfigured);
    mocks.fetchLearnerBlueprint.mockResolvedValue(null);

    const result = await generate({ learnerProfile: profile });

    expect('concepts' in result.scenes[0]).toBe(false);
    const persisted = lastPersisted(mocks);
    expect('generation' in persisted).toBe(false);
  });

  it('有证据但没画像：概念标签照写，课级元数据不写', async () => {
    mocks.fetchEvidence.mockResolvedValue(evidenceOk);

    const result = await generate();

    expect(result.scenes[0].concepts?.concept).toBe('rag');
    expect(mocks.fetchLearnerBlueprint).not.toHaveBeenCalled();
    expect('generation' in lastPersisted(mocks)).toBe(false);
  });

  it('渐进式落盘：每屏一张带 generating 标记的快照，完课那张不带', async () => {
    // 这条守的是「首屏可看」的地基。原来整门课跑完才落一次盘，生成中课堂在磁盘上
    // 根本不存在，学习者只能对着进度条等（实测 7 屏 2416 秒，评委现场等不起）。
    // 两个性质缺一不可：**中途要有快照**（否则等于没改），
    // **完课那张不能留 generating**（否则课永远显示"还在生成"）。
    await generate({});
    const calls = mocks.persistClassroom.mock.calls.map((c) => c[0]);
    expect(calls.length).toBeGreaterThan(1);

    // 第一张必须是骨架：大纲一出来就落，scenes 还空着但课已经存在。
    // 这条守的是「两分钟进课堂」——没有它，学习者要等到第一屏审完（实测 572s）
    // 才知道这门课长什么样。
    const skeleton = calls[0];
    expect(skeleton.scenes).toEqual([]);
    expect(skeleton.generating?.done).toBe(0);
    expect(skeleton.generating?.plannedTitles?.length).toBe(skeleton.generating?.total);

    const snapshots = calls.slice(0, -1);
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) {
      expect(snap.generating).toBeTruthy();
      expect(snap.generating.done).toBeLessThanOrEqual(snap.generating.total);
    }
    // 屏数单调不减：增量快照不许倒退
    const counts = snapshots.map((s) => (s.scenes ?? []).length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));

    expect(calls[calls.length - 1].generating).toBeUndefined();
  });

  it('机构归属贯穿骨架、增量快照和完课存档', async () => {
    await generate({ ownerOrgId: 'org-a' });
    const snapshots = mocks.persistClassroom.mock.calls.map((call) => call[0]);
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.every((snapshot) => snapshot.ownerOrgId === 'org-a')).toBe(true);
  });

  it('检索命中了但块上没有概念标签：同样整个字段不写', async () => {
    mocks.fetchEvidence.mockResolvedValue({
      status: 'ok',
      bundle: {
        chunks: [{ source_id: 'k9', title: 'C', content: 'c', concept_tags: [] }],
        matchedConcepts: [],
        summary: '',
      },
    });

    const result = await generate();

    expect('concepts' in result.scenes[0]).toBe(false);
  });

  it('完课快照在教学契约复核前写入全课程事实终审，审核不可用时 fail closed', async () => {
    await generate();

    expect(lastPersisted(mocks).stage.courseAudit).toMatchObject({
      verdict: 'flagged',
      decision: 'block_pending_review',
      totalClaims: 0,
    });
  });
});
