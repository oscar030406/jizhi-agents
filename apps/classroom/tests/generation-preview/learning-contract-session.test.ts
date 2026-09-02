import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LEARNING_CONTRACT_REQUIRED_MESSAGE,
  learningContractPlanFromDoneEvent,
  rebuildLearningContractPlan,
  validateLearningContractPlan,
} from '@/app/generation-preview/types';
import type { LearningContract } from '@/lib/generation/learning-contract';
import type { SceneOutline } from '@/lib/types/generation';

const outlines: SceneOutline[] = [
  {
    id: 'practice',
    type: 'interactive',
    title: '先独立练习',
    description: '学习者先完成一次可观察练习。',
    keyPoints: ['练习', '提交', '目标 O1'],
    order: 1,
    teachingObjective: 'O1',
    widgetType: 'game',
    widgetOutline: { gameType: 'strategy', challenge: '完成练习' },
  },
  {
    id: 'feedback',
    type: 'interactive',
    title: '根据反馈重试',
    description: '查看错误反馈，修改答案后再次提交。',
    keyPoints: ['反馈', '修订', '重试'],
    order: 2,
    teachingObjective: 'O1',
    widgetType: 'game',
    widgetOutline: { gameType: 'strategy', challenge: '根据反馈完成第二次尝试' },
  },
  {
    id: 'performance',
    type: 'pbl',
    title: '提交表现证据',
    description: '在完整任务中提交可验收的表现证据。',
    keyPoints: ['任务', '证据', '标准'],
    order: 3,
    teachingObjective: 'O1',
    pblConfig: {
      projectTopic: '表现任务',
      projectDescription: '完成一项可按标准验收的任务。',
      targetSkills: ['应用', '验证'],
    },
  },
  {
    id: 'reflection',
    type: 'interactive',
    title: '反思并修订',
    description: '对照表现标准修订自己的方案。',
    keyPoints: ['反思', '修订', '标准'],
    order: 4,
    teachingObjective: 'O1',
    widgetType: 'game',
    widgetOutline: { gameType: 'strategy', challenge: '找出证据缺口并修订' },
  },
  {
    id: 'assessment',
    type: 'quiz',
    title: '迁移测验',
    description: '在新情境中验收。',
    keyPoints: ['迁移', '测验', '验收'],
    order: 5,
    teachingObjective: 'O1',
    quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['text'] },
  },
];

const contract: LearningContract = {
  teachingStrategy: 'ubd',
  strategyEvidence: {
    essentialQuestion: '怎样把练习迁移到新情境？',
    enduringUnderstanding: '反馈后的修订是迁移能力的一部分。',
    performanceEvidence: 'performance',
    reflectionRevision: 'reflection',
    transfer: 'assessment',
  },
  objectives: [
    { id: 'O1', action: '完成任务', condition: '给定新情境', successCriterion: '通过测验' },
  ],
  prerequisiteActivation: ['practice'],
  demonstration: ['practice'],
  learnerPractice: ['practice'],
  feedbackRetry: ['feedback'],
  transferApplication: ['assessment'],
  assessmentMap: [{ sceneId: 'assessment', objectiveIds: ['O1'] }],
  grounding: { sourceRefs: ['corpus:ai'], claimPolicy: 'cite-or-mark-uncertain' },
};

describe('generation-preview 教学契约 session', () => {
  it('done 事件缺契约时直接失败，不用已收集 outlines 放行', () => {
    expect(() => learningContractPlanFromDoneEvent({ outlines }, outlines)).toThrow(
      LEARNING_CONTRACT_REQUIRED_MESSAGE,
    );
  });

  it('done 事件只把发布复核需要的最小 plan 写入 session', () => {
    const result = learningContractPlanFromDoneEvent({ outlines, learningContract: contract }, []);

    expect(result.outlines).toEqual(outlines);
    expect(result.learningContractPlan.version).toBe(2);
    expect(result.learningContractPlan.teachingStrategy).toBe('ubd');
    expect(result.learningContractPlan.strategyEvidence).toEqual(contract.strategyEvidence);
    expect(result.learningContractPlan.objectives).toEqual(contract.objectives);
    expect(result.learningContractPlan.plannedScenes).toEqual([
      { sceneId: 'practice', type: 'interactive', widgetType: 'game', objectiveIds: ['O1'] },
      { sceneId: 'feedback', type: 'interactive', widgetType: 'game', objectiveIds: ['O1'] },
      { sceneId: 'performance', type: 'pbl', objectiveIds: ['O1'] },
      { sceneId: 'reflection', type: 'interactive', widgetType: 'game', objectiveIds: ['O1'] },
      { sceneId: 'assessment', type: 'quiz', objectiveIds: ['O1'] },
    ]);
  });

  it('人工改纲后同步重建 plannedScenes，并保留原教学环节约束', () => {
    const original = learningContractPlanFromDoneEvent(
      { outlines, learningContract: contract },
      [],
    ).learningContractPlan;
    const edited = outlines.map((outline) =>
      outline.id === 'practice' ? { ...outline, title: '改名后的练习' } : outline,
    );

    const rebuilt = rebuildLearningContractPlan(original, edited);
    expect(rebuilt.plannedScenes.map((scene) => scene.sceneId)).toEqual([
      'practice',
      'feedback',
      'performance',
      'reflection',
      'assessment',
    ]);
    expect(rebuilt.version).toBe(2);
    expect(rebuilt.teachingStrategy).toBe('ubd');
    expect(rebuilt.strategyEvidence).toEqual(original.strategyEvidence);
    expect(rebuilt.required).toEqual(original.required);
    expect(validateLearningContractPlan(rebuilt, edited)).toEqual(rebuilt);
  });

  it('旧 v1 session 缺少可验证目标时 fail-closed，不伪造目标放行', () => {
    const current = learningContractPlanFromDoneEvent(
      { outlines, learningContract: contract },
      [],
    ).learningContractPlan;
    const legacy = {
      version: 1 as const,
      plannedScenes: current.plannedScenes,
      required: current.required,
    };

    const rebuilt = rebuildLearningContractPlan(legacy, outlines);
    expect(rebuilt.version).toBe(2);
    expect(rebuilt.teachingStrategy).toBe('standard');
    expect(rebuilt.strategyEvidence).toBeUndefined();
    expect(rebuilt.objectives).toEqual([]);
    expect(() => validateLearningContractPlan(legacy, outlines)).toThrow(
      LEARNING_CONTRACT_REQUIRED_MESSAGE,
    );
  });

  it('人工删除必需场景或把反馈练习降成讲解页时明确要求重新验证', () => {
    const plan = learningContractPlanFromDoneEvent(
      { outlines, learningContract: contract },
      [],
    ).learningContractPlan;

    expect(() => validateLearningContractPlan(plan, outlines.slice(1))).toThrow(
      LEARNING_CONTRACT_REQUIRED_MESSAGE,
    );
    expect(() =>
      validateLearningContractPlan(
        plan,
        outlines.map((outline) =>
          outline.id === 'practice' ? { ...outline, type: 'slide' as const } : outline,
        ),
      ),
    ).toThrow(LEARNING_CONTRACT_REQUIRED_MESSAGE);
  });

  it('页面在 retry 清旧 plan、EOF 拒绝、恢复后写回 stage', () => {
    const source = readFileSync(join(process.cwd(), 'app/generation-preview/page.tsx'), 'utf-8');

    expect(source).toContain('learningContractPlan: undefined');
    expect(source).toContain('learningContractPlanFromDoneEvent');
    expect(source).toContain('stage.learningContract = learningContractPlan');
    expect(source).toMatch(
      /if \(done\) \{\s*reject\(new Error\(LEARNING_CONTRACT_REQUIRED_MESSAGE\)\)/,
    );
  });
});
