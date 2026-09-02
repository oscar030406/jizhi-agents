import { describe, expect, it } from 'vitest';

import {
  TEACHING_STRATEGIES,
  buildLearningContractPlan,
  resolveOutlineEngine,
  validateAndRepairLearningContract,
  validateLearningContractFulfillment,
  validateVocationalOutline,
  type LearningContract,
} from '@/lib/generation/learning-contract';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';

const genericAiOutlines: SceneOutline[] = [
  {
    id: 'scene_1',
    type: 'slide',
    title: '先判断现有检索链',
    description: '用一个短案例激活学习者对检索、生成与引用的已有认识。',
    keyPoints: ['已有经验', '常见误区', '本课目标'],
    objectiveIds: ['O1'],
    order: 1,
  },
  {
    id: 'scene_2',
    type: 'slide',
    title: '完整示范一次 RAG 回答',
    description: '教师演示从问题、检索结果到带引用回答的完整过程。',
    keyPoints: ['查询改写', '证据选择', '引用回答'],
    objectiveIds: ['O1'],
    order: 2,
  },
  {
    id: 'scene_3',
    type: 'interactive',
    title: '自己接通最小检索器',
    description: '学习者修改并运行最小代码，观察不同查询的召回结果。',
    keyPoints: ['运行代码', '比较召回', '记录偏差'],
    order: 3,
    teachingObjective: 'O1',
    objectiveIds: ['O1'],
    widgetType: 'code',
    widgetOutline: { language: 'python', challengeType: 'implementation' },
  },
  {
    id: 'scene_4',
    type: 'interactive',
    title: '根据反馈重试查询',
    description: '错误选择会给出证据缺口，学习者据此修改查询后重试。',
    keyPoints: ['可见反馈', '修改查询', '再次验证'],
    order: 4,
    teachingObjective: 'O1',
    objectiveIds: ['O1'],
    widgetType: 'game',
    widgetOutline: { gameType: 'strategy', challenge: '让三个测试问题都命中证据' },
  },
  {
    id: 'scene_5',
    type: 'pbl',
    title: '迁移到一份陌生手册',
    description: '把同一方法应用到未在示范中出现的新资料。',
    keyPoints: ['新资料', '独立取证', '交付引用回答'],
    order: 5,
    teachingObjective: 'O1',
    objectiveIds: ['O1'],
    pblConfig: {
      projectTopic: '陌生手册问答',
      projectDescription: '为一份新手册建立可核验问答。',
      targetSkills: ['检索', '引用', '验证'],
    },
  },
  {
    id: 'scene_6',
    type: 'quiz',
    title: '按目标验收',
    description: '用三个新问题验收检索与引用是否达到标准。',
    keyPoints: ['三题均有证据', '引用可追溯', '不支持时明确拒答'],
    order: 6,
    teachingObjective: 'O1',
    objectiveIds: ['O1'],
    quizConfig: { questionCount: 3, difficulty: 'medium', questionTypes: ['text'] },
  },
];

const strategyOutlines: SceneOutline[] = [
  genericAiOutlines[0]!,
  {
    ...genericAiOutlines[2]!,
    id: 'strategy_2',
    order: 2,
    title: '先说出自己的解释',
  },
  {
    ...genericAiOutlines[3]!,
    id: 'strategy_3',
    order: 3,
    title: '诊断最小缺口并重试',
  },
  {
    ...genericAiOutlines[4]!,
    id: 'strategy_4',
    order: 4,
    title: '用白话重建解释并提交表现证据',
  },
  {
    ...genericAiOutlines[3]!,
    id: 'strategy_5',
    order: 5,
    title: '指出类比边界并修订',
  },
  {
    ...genericAiOutlines[5]!,
    id: 'strategy_6',
    order: 6,
    title: '迁移到未见情境',
  },
];

const genericAiContract: LearningContract = {
  teachingStrategy: 'standard',
  objectives: [
    {
      id: 'O1',
      action: '构建并运行一个最小 RAG 检索链',
      condition: '给定一份陌生资料和三个测试问题',
      successCriterion: '三个回答均引用可追溯证据，缺证据时明确拒答',
    },
  ],
  prerequisiteActivation: ['scene_1'],
  demonstration: ['scene_2'],
  learnerPractice: ['scene_3'],
  feedbackRetry: ['scene_4'],
  transferApplication: ['scene_5'],
  assessmentMap: [{ sceneId: 'scene_6', objectiveIds: ['O1'] }],
  grounding: {
    sourceRefs: ['corpus:ai'],
    claimPolicy: 'cite-or-mark-uncertain',
  },
};

function generatedInteractiveHtml(): string {
  return `
    <p>先观察一次完整作答，说明如何定位证据缺口并依据反馈修订。</p>
    <textarea id="answer" aria-label="学习者答案"></textarea>
    <button type="button" onclick="submitAttempt()">提交并查看反馈</button>
    <output id="feedback" aria-live="polite"></output>
    <script>
      function submitAttempt() {
        const answer = document.getElementById('answer').value;
        document.getElementById('feedback').textContent = answer
          ? '已收到；请依据反馈修改后再试一次。'
          : '请先写下你的答案。';
      }
    </script>
  `;
}

function generatedPblProject(title = '迁移任务') {
  return {
    uiPhase: 'hero',
    title,
    description: '为陌生资料交付一组带可追溯引用的问答及核验记录。',
    learningObjective: '独立完成检索、引用与证据核验。',
    proficiency: 'intermediate',
    language: 'zh-CN',
    tags: ['检索', '引用'],
    status: 'active',
    roles: [{ id: 'role-instructor', type: 'instructor', name: '项目导师' }],
    milestones: [
      {
        id: 'milestone-1',
        title: '完成陌生资料问答',
        description: '检索新资料并形成可核验的最终交付物。',
        status: 'active',
        order: 0,
        briefing: '先明确问题与证据边界，再开始检索。',
        completionCriteria: '三条回答均附可追溯引用，缺证据时明确拒答。',
        debrief: '逐条复核引用与结论，再提交最终版本。',
        microtasks: [
          {
            id: 'microtask-1',
            title: '完成检索并提交引用问答',
            description: '针对三个新问题检索证据并写出回答。',
            status: 'todo',
            assignee: 'user',
            hints: ['先记录证据位置，再组织回答。'],
            order: 0,
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function generatedScenes(outlines: readonly SceneOutline[] = genericAiOutlines) {
  return outlines.map((outline) => {
    if (outline.type === 'quiz') {
      return {
        outlineId: outline.id,
        type: outline.type,
        content: {
          type: 'quiz',
          questions: [{ id: 'q1', question: '面对一份未见过的设备手册，如何检索并核验回答依据？' }],
        },
      };
    }
    if (outline.type === 'interactive') {
      return {
        outlineId: outline.id,
        type: outline.type,
        content: {
          type: 'interactive',
          html: generatedInteractiveHtml(),
          widgetType: outline.widgetType,
        },
      };
    }
    if (outline.type === 'pbl') {
      return {
        outlineId: outline.id,
        type: outline.type,
        content: {
          type: 'pbl',
          projectConfig: {
            projectInfo: { title: '迁移任务', description: '完成陌生资料问答。' },
          },
          projectV2: generatedPblProject(),
        },
      };
    }
    return {
      outlineId: outline.id,
      type: outline.type,
      content: {
        type: 'slide',
        canvas: {
          elements: [
            {
              type: 'text',
              content:
                outline.id === 'scene_1'
                  ? '<p>先回忆已有检索经验，并解释证据缺失时为什么不能直接作答。</p>'
                  : '<p>教师逐步示范查询改写、证据选择和带引用回答，并说明每一步判断依据。</p>',
            },
          ],
        },
      },
    };
  });
}

describe('LearningContract', () => {
  it('只接受 standard、ubd、feynman 三种互斥教学策略', () => {
    expect(TEACHING_STRATEGIES).toEqual(['standard', 'ubd', 'feynman']);

    const result = validateAndRepairLearningContract(
      { ...genericAiContract, teachingStrategy: 'ubd+feynman' },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai'] },
    );

    expect(result.publishable).toBe(false);
    expect(result.violations).toContain('teachingStrategy must be one of: standard, ubd, feynman');
  });

  it('新生成合同缺少教学策略时阻断，不静默归一为 standard', () => {
    const { teachingStrategy: _legacyMissing, ...legacyContract } = genericAiContract;
    const result = validateAndRepairLearningContract(legacyContract, genericAiOutlines, {
      allowedGroundingRefs: ['corpus:ai'],
    });

    expect(result.publishable).toBe(false);
    expect(result.violations).toContain('teachingStrategy is required: standard, ubd, or feynman');
    expect(result.contract?.teachingStrategy).toBe('standard');
  });

  it('放行具备完整教学闭环且评估映射到目标的通用 AI 课程', () => {
    const result = validateAndRepairLearningContract(genericAiContract, genericAiOutlines, {
      allowedGroundingRefs: ['corpus:ai'],
    });

    expect(result.publishable).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.violations).toEqual([]);
    expect(result.contract?.assessmentMap[0]).toEqual({
      sceneId: 'scene_6',
      objectiveIds: ['O1'],
    });
  });

  it('UbD 与 Feynman 只有完整结构化策略证据才能生成 v2 plan', () => {
    const ubd: LearningContract = {
      ...genericAiContract,
      teachingStrategy: 'ubd',
      strategyEvidence: {
        essentialQuestion: '怎样让陌生资料上的回答仍然可核验？',
        enduringUnderstanding: '可靠回答依赖可追溯证据，而不是流畅措辞。',
        performanceEvidence: 'strategy_4',
        reflectionRevision: 'strategy_5',
        transfer: 'strategy_6',
      },
      demonstration: ['strategy_3'],
      learnerPractice: ['strategy_2'],
      feedbackRetry: ['strategy_3'],
      transferApplication: ['strategy_6'],
      assessmentMap: [{ sceneId: 'strategy_6', objectiveIds: ['O1'] }],
    };
    const feynman: LearningContract = {
      ...genericAiContract,
      teachingStrategy: 'feynman',
      strategyEvidence: {
        learnerExplanation: 'strategy_2',
        gapDiagnosis: 'strategy_3',
        diagnosedGapCount: 2,
        plainLanguageRebuild: 'strategy_4',
        analogyBoundary: 'strategy_5',
        transfer: 'strategy_6',
      },
      demonstration: ['strategy_3'],
      learnerPractice: ['strategy_2'],
      feedbackRetry: ['strategy_3'],
      transferApplication: ['strategy_6'],
      assessmentMap: [{ sceneId: 'strategy_6', objectiveIds: ['O1'] }],
    };

    for (const contract of [ubd, feynman]) {
      const validated = validateAndRepairLearningContract(contract, strategyOutlines, {
        allowedGroundingRefs: ['corpus:ai'],
      });
      expect(validated.publishable).toBe(true);
      const plan = buildLearningContractPlan(validated.contract!, strategyOutlines);
      expect(plan.version).toBe(2);
      expect(plan.strategyEvidence).toEqual(contract.strategyEvidence);
      expect(validateLearningContractFulfillment(plan, generatedScenes(strategyOutlines))).toEqual({
        fulfilled: true,
        violations: [],
      });
    }
  });

  it('缺少策略证据、错误 gap 数或不存在的策略 sceneId 均阻断', () => {
    const missingUbd = validateAndRepairLearningContract(
      { ...genericAiContract, teachingStrategy: 'ubd' },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai'] },
    );
    expect(missingUbd.publishable).toBe(false);
    expect(missingUbd.violations).toContain('ubd strategyEvidence is missing');

    const invalidFeynman = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        teachingStrategy: 'feynman',
        strategyEvidence: {
          learnerExplanation: 'scene_3',
          gapDiagnosis: 'scene_4',
          diagnosedGapCount: 3,
          plainLanguageRebuild: 'scene_3',
          analogyBoundary: 'scene_missing',
          transfer: 'scene_5',
        },
      },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai'] },
    );
    expect(invalidFeynman.publishable).toBe(false);
    expect(invalidFeynman.violations).toEqual(
      expect.arrayContaining([
        'feynman diagnosedGapCount must be 1 or 2',
        'feynman analogyBoundary references an unknown scene: scene_missing',
      ]),
    );
  });

  it('专用策略拒绝展示型或乱序证据，迁移与 UbD 表现证据只接受 quiz/PBL', () => {
    const feynman = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        teachingStrategy: 'feynman',
        strategyEvidence: {
          learnerExplanation: 'scene_1',
          gapDiagnosis: 'scene_4',
          diagnosedGapCount: 1,
          plainLanguageRebuild: 'scene_3',
          analogyBoundary: 'scene_4',
          transfer: 'scene_4',
        },
      },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai'] },
    );
    expect(feynman.publishable).toBe(false);
    expect(feynman.violations).toEqual(
      expect.arrayContaining([
        'feynman learnerExplanation must reference an interactive or pbl scene',
        'feynman transfer must reference a quiz or pbl scene',
        'feynman strategy scenes must be ordered: learnerExplanation -> gapDiagnosis -> plainLanguageRebuild -> analogyBoundary -> transfer',
      ]),
    );

    const ubd = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        teachingStrategy: 'ubd',
        strategyEvidence: {
          essentialQuestion: '怎样证明理解可以迁移？',
          enduringUnderstanding: '理解必须通过新情境中的表现来证明。',
          performanceEvidence: 'scene_4',
          reflectionRevision: 'scene_5',
          transfer: 'scene_4',
        },
      },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai'] },
    );
    expect(ubd.publishable).toBe(false);
    expect(ubd.violations).toEqual(
      expect.arrayContaining([
        'ubd performanceEvidence must reference a quiz or pbl scene',
        'ubd transfer must reference a quiz or pbl scene',
        'ubd strategy scenes must be ordered: performanceEvidence -> reflectionRevision -> transfer',
      ]),
    );
  });

  it('每个交互练习都要由同目标反馈重试和后续 quiz/PBL 验收闭环', () => {
    const result = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        objectives: [
          genericAiContract.objectives[0],
          {
            id: 'O2',
            action: '比较两种检索策略',
            condition: '给定同一问题与两组召回结果',
            successCriterion: '能指出至少一项证据差异',
          },
        ],
        assessmentMap: [{ sceneId: 'scene_6', objectiveIds: ['O1', 'O2'] }],
      },
      genericAiOutlines.map((outline) =>
        outline.id === 'scene_4'
          ? { ...outline, teachingObjective: 'O2', objectiveIds: ['O2'] }
          : outline,
      ),
      { allowedGroundingRefs: ['corpus:ai'] },
    );

    expect(result.publishable).toBe(false);
    expect(result.violations).toContain(
      'learnerPractice interactive scene_3 needs a later same-objective feedbackRetry scene',
    );
  });

  it('PBL 练习同样必须有后置的同目标反馈重试与后测', () => {
    const feedbackAfterPbl: SceneOutline = {
      ...genericAiOutlines[3]!,
      id: 'scene_7',
      title: '项目反馈后重试',
      order: 7,
      teachingObjective: 'O1',
    };
    const result = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        learnerPractice: ['scene_5'],
        feedbackRetry: ['scene_7'],
        transferApplication: ['scene_6'],
      },
      [...genericAiOutlines, feedbackAfterPbl],
      { allowedGroundingRefs: ['corpus:ai'] },
    );

    expect(result.publishable).toBe(false);
    expect(result.violations).toContain(
      'learnerPractice pbl scene_5 needs a later same-objective quiz or pbl assessment after feedbackRetry',
    );
  });

  it('普通 interactive 不能充当 transfer 或 assessment', () => {
    const result = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        transferApplication: ['scene_4'],
        assessmentMap: [{ sceneId: 'scene_4', objectiveIds: ['O1'] }],
      },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai'] },
    );

    expect(result.publishable).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        'transferApplication must reference a quiz or pbl scene',
        'assessmentMap must reference quiz or pbl scenes',
      ]),
    );
  });

  it('策略证据引用必须同时存在于 planned 与最终 actual scenes', () => {
    const contract: LearningContract = {
      ...genericAiContract,
      teachingStrategy: 'ubd',
      strategyEvidence: {
        essentialQuestion: '怎样让陌生资料上的回答仍然可核验？',
        enduringUnderstanding: '可靠回答必须受证据约束。',
        performanceEvidence: 'scene_6',
        reflectionRevision: 'scene_4',
        transfer: 'scene_5',
      },
    };
    const plan = buildLearningContractPlan(contract, genericAiOutlines);
    const withoutReflection = generatedScenes().filter((scene) => scene.outlineId !== 'scene_4');

    expect(validateLearningContractFulfillment(plan, withoutReflection).violations).toContain(
      'ubd strategy scene is missing: scene_4',
    );
  });

  it('只修复可由真实请求上下文机械确定的 grounding，不编造来源或教学环节', () => {
    const result = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        grounding: {
          sourceRefs: ['不存在的来源'],
          claimPolicy: 'cite-or-mark-uncertain',
        },
      },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai', 'uploaded-materials'] },
    );

    expect(result.publishable).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.contract?.grounding.sourceRefs).toEqual(['corpus:ai', 'uploaded-materials']);
  });

  it('纯幻灯片且没有契约时阻断发布，不把缺失环节伪装修好', () => {
    const result = validateAndRepairLearningContract(null, genericAiOutlines.slice(0, 2), {
      allowedGroundingRefs: ['corpus:ai'],
    });

    expect(result.publishable).toBe(false);
    expect(result.contract).toBeNull();
    expect(result.violations).toContain('learningContract is missing');
  });

  it('拒绝不可观察的目标，以及拿讲解页冒充反馈重试或迁移任务', () => {
    const result = validateAndRepairLearningContract(
      {
        ...genericAiContract,
        objectives: [{ ...genericAiContract.objectives[0], action: '理解 RAG' }],
        feedbackRetry: ['scene_1'],
        transferApplication: ['scene_2'],
      },
      genericAiOutlines,
      { allowedGroundingRefs: ['corpus:ai'] },
    );

    expect(result.publishable).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        'objective O1 action must be observable and measurable',
        'feedbackRetry must reference an interactive, pbl, or quiz scene',
        'transferApplication must reference a quiz or pbl scene',
      ]),
    );
  });

  it('按计划 sceneId 和教学类别重验最终场景，不补造缺失环节', () => {
    const plan = buildLearningContractPlan(genericAiContract, genericAiOutlines);
    expect(plan.version).toBe(2);
    expect(plan.teachingStrategy).toBe('standard');
    expect(plan.objectives).toEqual(genericAiContract.objectives);
    expect(plan.plannedScenes.every((scene) => scene.objectiveIds.includes('O1'))).toBe(true);
    const actualScenes = generatedScenes();

    expect(validateLearningContractFulfillment(plan, actualScenes)).toEqual({
      fulfilled: true,
      violations: [],
    });

    const withoutTransferAndQuiz = actualScenes.filter(
      (scene) => scene.outlineId !== 'scene_5' && scene.outlineId !== 'scene_6',
    );
    const result = validateLearningContractFulfillment(plan, withoutTransferAndQuiz);
    expect(result.fulfilled).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        'planned scene is missing: scene_5',
        'planned scene is missing: scene_6',
        'transferApplication scene is missing: scene_5',
        'assessment scene is missing: scene_6',
      ]),
    );
  });

  it('激活与示范必须有实质教学文本，合格讲解仍可通过', () => {
    const plan = buildLearningContractPlan(genericAiContract, genericAiOutlines);
    expect(validateLearningContractFulfillment(plan, generatedScenes()).fulfilled).toBe(true);

    const hollow = generatedScenes().map((scene) =>
      scene.outlineId === 'scene_1' || scene.outlineId === 'scene_2'
        ? { ...scene, content: { type: 'slide' } }
        : scene,
    );
    expect(validateLearningContractFulfillment(plan, hollow).violations).toEqual(
      expect.arrayContaining([
        'prerequisiteActivation scene lacks substantive teaching evidence: scene_1',
        'demonstration scene lacks substantive teaching evidence: scene_2',
      ]),
    );
  });

  it('迁移拒绝原题复述、近重复与只换数字，真实新情境可通过', () => {
    const original = '给定3段客服工单，找出每段回答对应的证据并标注来源。';
    const contract: LearningContract = {
      ...genericAiContract,
      transferApplication: ['scene_6'],
    };
    const plan = buildLearningContractPlan(contract, genericAiOutlines);
    const scenes = generatedScenes().map((scene) =>
      scene.outlineId === 'scene_3'
        ? {
            ...scene,
            content: {
              type: 'interactive',
              widgetType: 'code',
              html: `<p>${original}</p>${generatedInteractiveHtml()}`,
            },
          }
        : scene,
    );

    expect(validateLearningContractFulfillment(plan, scenes).fulfilled).toBe(true);
    for (const repeated of [
      original,
      '给定4段客服工单，找出每段回答对应的证据并标注来源。',
      '请给定3段客服工单，找出每段回答所对应的证据，并标注来源。',
    ]) {
      const repeatedTransfer = scenes.map((scene) =>
        scene.outlineId === 'scene_6'
          ? {
              ...scene,
              content: { type: 'quiz', questions: [{ id: 'q1', question: repeated }] },
            }
          : scene,
      );
      expect(validateLearningContractFulfillment(plan, repeatedTransfer).violations).toContain(
        'transferApplication scene does not establish a new context: scene_6',
      );
    }
  });

  it('sceneId 虽在但测验或反馈被降级成讲解页时仍判定未履约', () => {
    const plan = buildLearningContractPlan(genericAiContract, genericAiOutlines);
    const actualScenes = generatedScenes().map((scene) =>
      scene.outlineId === 'scene_4' || scene.outlineId === 'scene_6'
        ? { ...scene, type: 'slide' }
        : scene,
    );

    const result = validateLearningContractFulfillment(plan, actualScenes);
    expect(result.fulfilled).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        'feedbackRetry scene has the wrong teaching category: scene_4',
        'assessment scene has the wrong teaching category: scene_6',
      ]),
    );
  });

  it('v2 拒绝空 HTML、零题 quiz 与空 PBL，反馈重试和迁移不能只剩类型空壳', () => {
    const plan = buildLearningContractPlan(genericAiContract, genericAiOutlines);
    const emptyActivities = generatedScenes().map((scene) => {
      if (scene.outlineId === 'scene_3' || scene.outlineId === 'scene_4') {
        return {
          ...scene,
          content: { type: 'interactive', html: '   ', widgetConfig: {} },
        };
      }
      if (scene.outlineId === 'scene_5') {
        return { ...scene, content: { type: 'pbl', projectConfig: {} } };
      }
      if (scene.outlineId === 'scene_6') {
        return { ...scene, content: { type: 'quiz', questions: [] } };
      }
      return scene;
    });

    const result = validateLearningContractFulfillment(plan, emptyActivities);
    expect(result.fulfilled).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        'interactive scene is not learner-operable with visible feedback: scene_3',
        'interactive scene is not learner-operable with visible feedback: scene_4',
        expect.stringContaining('pbl scene is not production-ready: scene_5'),
        'quiz scene has no questions: scene_6',
      ]),
    );
  });

  it('v2 拒绝静态 HTML 与只有输入没有反馈的伪交互', () => {
    const plan = buildLearningContractPlan(genericAiContract, genericAiOutlines);
    const hollowActivities = generatedScenes().map((scene) => {
      if (scene.outlineId === 'scene_3') {
        return {
          ...scene,
          content: {
            type: 'interactive',
            html: '<main><h2>阅读示例</h2><p>没有操作。</p></main>',
            widgetType: 'code',
          },
        };
      }
      if (scene.outlineId === 'scene_4') {
        return {
          ...scene,
          content: {
            type: 'interactive',
            html: '<textarea id="answer"></textarea><button onclick="submitAttempt()">提交</button><script>function submitAttempt(){ return true; }</script>',
            widgetType: 'game',
          },
        };
      }
      return scene;
    });

    expect(validateLearningContractFulfillment(plan, hollowActivities).violations).toEqual(
      expect.arrayContaining([
        'interactive scene is not learner-operable with visible feedback: scene_3',
        'interactive scene is not learner-operable with visible feedback: scene_4',
      ]),
    );
  });

  it('模板教具必须通过现有生产参数校验，配置对象本身不算交互', () => {
    const outlines = genericAiOutlines.map((outline) =>
      outline.id === 'scene_3' ? { ...outline, widgetType: 'template' as const } : outline,
    );
    const plan = buildLearningContractPlan(genericAiContract, outlines);
    const config = {
      type: 'template',
      templateId: 'process_stepper',
      name: '检索流程步进器',
      params: {
        steps: [
          { title: '提问', detail: '写下需要回答的问题。', carries: '问题文本' },
          { title: '检索', detail: '从资料中召回相关片段。', carries: '证据片段' },
          { title: '核验', detail: '核对回答与证据是否一致。' },
        ],
      },
    };
    const scenes = generatedScenes(outlines).map((scene) =>
      scene.outlineId === 'scene_3'
        ? {
            ...scene,
            content: {
              type: 'interactive',
              html: '',
              widgetType: 'template',
              widgetConfig: config,
            },
          }
        : scene,
    );

    expect(validateLearningContractFulfillment(plan, scenes)).toEqual({
      fulfilled: true,
      violations: [],
    });

    const invalid = scenes.map((scene) =>
      scene.outlineId === 'scene_3'
        ? {
            ...scene,
            content: {
              type: 'interactive',
              html: '',
              widgetType: 'template',
              widgetConfig: { ...config, params: { steps: [] } },
            },
          }
        : scene,
    );
    expect(validateLearningContractFulfillment(plan, invalid).violations).toContain(
      'interactive scene is not learner-operable with visible feedback: scene_3',
    );
  });

  it('UbD/Feynman 证据不能由标题描述空壳 PBL 或任意 HTML 冒充', () => {
    const ubd: LearningContract = {
      ...genericAiContract,
      teachingStrategy: 'ubd',
      strategyEvidence: {
        essentialQuestion: '怎样让陌生资料上的回答仍然可核验？',
        enduringUnderstanding: '可靠回答依赖可追溯证据。',
        performanceEvidence: 'strategy_4',
        reflectionRevision: 'strategy_5',
        transfer: 'strategy_6',
      },
      demonstration: ['strategy_3'],
      learnerPractice: ['strategy_2'],
      feedbackRetry: ['strategy_3'],
      transferApplication: ['strategy_6'],
      assessmentMap: [{ sceneId: 'strategy_6', objectiveIds: ['O1'] }],
    };
    const feynman: LearningContract = {
      ...ubd,
      teachingStrategy: 'feynman',
      strategyEvidence: {
        learnerExplanation: 'strategy_2',
        gapDiagnosis: 'strategy_3',
        diagnosedGapCount: 1,
        plainLanguageRebuild: 'strategy_4',
        analogyBoundary: 'strategy_5',
        transfer: 'strategy_6',
      },
    };
    const actual = generatedScenes(strategyOutlines).map((scene) => {
      if (scene.outlineId === 'strategy_2') {
        return {
          ...scene,
          content: {
            type: 'interactive',
            html: '<article>请阅读这段解释。</article>',
            widgetType: 'code',
          },
        };
      }
      if (scene.outlineId === 'strategy_4') {
        return {
          ...scene,
          content: {
            type: 'pbl',
            projectConfig: { projectInfo: { title: '项目标题', description: '项目描述' } },
            projectV2: {
              uiPhase: 'hero',
              title: '项目标题',
              description: '项目描述',
              roles: [],
              milestones: [],
              threads: [],
            },
          },
        };
      }
      return scene;
    });

    expect(
      validateLearningContractFulfillment(buildLearningContractPlan(ubd, strategyOutlines), actual)
        .violations,
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('pbl scene is not production-ready: strategy_4'),
      ]),
    );
    expect(
      validateLearningContractFulfillment(
        buildLearningContractPlan(feynman, strategyOutlines),
        actual,
      ).violations,
    ).toEqual(
      expect.arrayContaining([
        'interactive scene is not learner-operable with visible feedback: strategy_2',
        expect.stringContaining('pbl scene is not production-ready: strategy_4'),
      ]),
    );
  });

  it('旧 v1 plan 按 standard 读取，不因缺少策略字段或成品内容账误封', () => {
    const current = buildLearningContractPlan(genericAiContract, genericAiOutlines);
    const legacy = {
      version: 1,
      plannedScenes: current.plannedScenes,
      required: current.required,
    };
    const legacyScenes = genericAiOutlines.map((outline) => ({
      outlineId: outline.id,
      type: outline.type,
      content: { widgetType: outline.widgetType },
    }));

    expect(validateLearningContractFulfillment(legacy, legacyScenes)).toEqual({
      fulfilled: true,
      violations: [],
    });
  });

  it('v2 缺 teachingStrategy 或专用策略证据时阻断', () => {
    const plan = buildLearningContractPlan(genericAiContract, genericAiOutlines);
    const missingStrategy = { ...plan, teachingStrategy: undefined };
    expect(
      validateLearningContractFulfillment(missingStrategy, generatedScenes()).violations,
    ).toContain('teachingStrategy is missing from learning contract v2');

    const missingEvidence = { ...plan, teachingStrategy: 'ubd', strategyEvidence: undefined };
    expect(
      validateLearningContractFulfillment(missingEvidence, generatedScenes()).violations,
    ).toContain('ubd strategyEvidence is missing');
  });
});

describe('automatic outline engine routing', () => {
  it('通用 AI 课程保持标准引擎，不因“构建”一词误入职教任务引擎', () => {
    const requirements: UserRequirements = {
      requirement: '从零讲清楚如何构建一个 RAG 检索增强生成系统',
      learnerProfile: { corpus: 'ai', domain: 'ai' },
    };

    expect(
      resolveOutlineEngine(requirements, { hands_on_safety: false }, { vocationalEnabled: true }),
    ).toEqual({ engine: 'standard', reason: 'standard' });
  });

  it('智能制造实训按域元数据与操作型需求自动选任务引擎，无需 taskEngineMode', () => {
    const requirements: UserRequirements = {
      requirement: '按照工单完成控制柜上电前点检，并依据测量结果做 GO/STOP 判定',
      learnerProfile: { corpus: 'smart-manufacturing', domain: 'manufacturing' },
    };

    expect(requirements.taskEngineMode).toBeUndefined();
    expect(
      resolveOutlineEngine(requirements, { hands_on_safety: true }, { vocationalEnabled: true }),
    ).toEqual({ engine: 'task-engine', reason: 'domain-metadata' });
  });

  it('需求明确要求岗位实训时，即使域元数据缺失也自动选任务引擎', () => {
    expect(
      resolveOutlineEngine(
        { requirement: '设计一门岗位实训：按 SOP 完成设备巡检、异常复查和交接' },
        undefined,
        { vocationalEnabled: true },
      ),
    ).toEqual({ engine: 'task-engine', reason: 'requirement' });
  });
});

describe('vocational structural contract', () => {
  it('复用上游可机械检查的首屏、类型配比和 procedural-skill 字段约束', () => {
    const outlines: SceneOutline[] = [
      {
        id: 'v1',
        type: 'slide',
        title: '任务简报',
        description: '说明任务边界与完成标准。',
        keyPoints: ['目标', '风险', 'GO/STOP'],
        order: 1,
      },
      ...[2, 3, 4].map(
        (order): SceneOutline => ({
          id: `v${order}`,
          type: 'interactive',
          title: `操作阶段 ${order - 1}`,
          description: '完成操作并根据后果反馈重试。',
          keyPoints: ['工具', '步骤', '验收'],
          order,
          widgetType: 'procedural-skill',
          widgetOutline: {
            task: `阶段 ${order - 1}`,
            steps: ['确认条件', '执行操作'],
            successCriteria: ['状态达到工单要求'],
            errorConsequences: ['停止并复查'],
          },
        }),
      ),
      {
        id: 'v5',
        type: 'interactive',
        title: '异常判定',
        description: '根据新读数选择继续、复查或停止。',
        keyPoints: ['异常读数', '错误反馈', '重新判定'],
        order: 5,
        widgetType: 'game',
        widgetOutline: { gameType: 'strategy', challenge: '完成 GO/STOP 判定' },
      },
      {
        id: 'v6',
        type: 'quiz',
        title: '按工单标准验收',
        description: '用新的设备状态判断是否达到交接标准。',
        keyPoints: ['新状态', '验收证据', 'GO/STOP'],
        order: 6,
        quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['text'] },
      },
    ];

    expect(validateVocationalOutline(outlines)).toEqual([]);
  });

  it('缺少上游约束要求的测验型验收场景时阻断发布', () => {
    expect(validateVocationalOutline(genericAiOutlines.slice(0, 5))).toContain(
      'vocational outline needs at least 1 quiz scene; got 0',
    );
  });
});
