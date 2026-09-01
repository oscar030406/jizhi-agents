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
    title: '练习并反馈重试',
    description: '完成练习并根据反馈修正。',
    keyPoints: ['练习', '反馈', '重试'],
    order: 1,
    widgetType: 'game',
    widgetOutline: { gameType: 'strategy', challenge: '完成练习' },
  },
  {
    id: 'assessment',
    type: 'quiz',
    title: '迁移测验',
    description: '在新情境中验收。',
    keyPoints: ['迁移', '测验', '验收'],
    order: 2,
    quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['text'] },
  },
];

const contract: LearningContract = {
  objectives: [
    { id: 'O1', action: '完成任务', condition: '给定新情境', successCriterion: '通过测验' },
  ],
  prerequisiteActivation: ['practice'],
  demonstration: ['practice'],
  learnerPractice: ['practice'],
  feedbackRetry: ['practice'],
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
    expect(result.learningContractPlan.plannedScenes).toEqual([
      { sceneId: 'practice', type: 'interactive', widgetType: 'game' },
      { sceneId: 'assessment', type: 'quiz' },
    ]);
    expect(JSON.stringify(result.learningContractPlan)).not.toContain('objectives');
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
    expect(rebuilt.plannedScenes.map((scene) => scene.sceneId)).toEqual(['practice', 'assessment']);
    expect(rebuilt.required).toEqual(original.required);
    expect(validateLearningContractPlan(rebuilt, edited)).toEqual(rebuilt);
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
