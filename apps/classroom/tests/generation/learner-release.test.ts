import { describe, expect, it } from 'vitest';

import {
  decideCourseLearnerRelease,
  decideSceneLearnerRelease,
} from '@/lib/generation/learner-release';
import {
  buildLearningContractPlan,
  type LearningContract,
} from '@/lib/generation/learning-contract';
import type { SceneOutline } from '@/lib/types/generation';
import { hashCourseScenes, type SceneAudit } from '@/lib/generation/hallucination-audit';

function audit(overrides: Partial<SceneAudit> = {}): SceneAudit {
  const base: SceneAudit = {
    verdict: 'pass',
    claims: [
      {
        claim: '课程中的事实性断言',
        verdict: 'supported',
        reason: '教材证据支持',
        sourceIds: ['S1'],
      },
    ],
    totalClaims: 1,
    flaggedCount: 0,
    uncertainCount: 0,
    incorrectCount: 0,
    judgeModel: 'judge',
    rounds: 1,
    durationMs: 1,
    decision: 'publish',
    rationale: '通过',
    grounded: true,
    evidenceCount: 1,
  };
  return { ...base, ...overrides };
}

describe('学习者发布资格纯函数', () => {
  const releaseOutlines: SceneOutline[] = [
    {
      id: 'outline-practice',
      type: 'interactive',
      title: '练习并按反馈重试',
      description: '完成练习并根据反馈修正。',
      keyPoints: ['练习', '反馈', '重试'],
      order: 1,
      widgetType: 'game',
      widgetOutline: { gameType: 'strategy', challenge: '完成练习' },
    },
    {
      id: 'outline-assessment',
      type: 'quiz',
      title: '迁移测验',
      description: '在新情境中验收。',
      keyPoints: ['迁移', '测验', '验收'],
      order: 2,
      quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['text'] },
    },
  ];
  const releaseContract: LearningContract = {
    teachingStrategy: 'standard',
    objectives: [
      { id: 'O1', action: '完成任务', condition: '给定新情境', successCriterion: '通过测验' },
    ],
    prerequisiteActivation: ['outline-practice'],
    demonstration: ['outline-practice'],
    learnerPractice: ['outline-practice'],
    feedbackRetry: ['outline-practice'],
    transferApplication: ['outline-assessment'],
    assessmentMap: [{ sceneId: 'outline-assessment', objectiveIds: ['O1'] }],
    grounding: { sourceRefs: ['corpus:ai'], claimPolicy: 'cite-or-mark-uncertain' },
  };
  const releasePlan = buildLearningContractPlan(releaseContract, releaseOutlines);
  const releasePlanV1 = { ...releasePlan, version: 1 };
  const releasedScenes = [
    {
      id: 'scene-practice',
      outlineId: 'outline-practice',
      type: 'interactive',
      content: { type: 'interactive', widgetType: 'game', html: '<button>完成练习</button>' },
      audit: audit(),
    },
    {
      id: 'scene-assessment',
      outlineId: 'outline-assessment',
      type: 'quiz',
      content: { type: 'quiz', questions: [{ id: 'q1', type: 'text', question: '迁移作答' }] },
      audit: audit(),
    },
  ];
  const cleanCourseAudit = audit({
    claims: [],
    totalClaims: 0,
    flaggedCount: 0,
    uncertainCount: 0,
    incorrectCount: 0,
    grounded: false,
    evidenceCount: 0,
    panelComplete: true,
    courseContentHash: hashCourseScenes(releasedScenes),
  });
  const numericContent = {
    type: 'slide',
    canvas: { elements: [{ type: 'text', content: '<p>2 + 2 = 4</p>' }] },
  };
  const passedVerification = {
    codePassed: 0,
    codeFailed: 0,
    codeUnverifiable: 0,
    arithmeticChecked: 1,
    arithmeticPassed: 1,
    failures: [],
  };

  it('有事实断言且审核通过、证据接地时可发布', () => {
    expect(decideSceneLearnerRelease({ id: 'scene-ok', audit: audit() })).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it('纯流程场景没有事实断言时不强求证据覆盖', () => {
    expect(
      decideSceneLearnerRelease({
        id: 'scene-flow',
        audit: audit({
          claims: [],
          totalClaims: 0,
          grounded: false,
          evidenceCount: 0,
        }),
      }).eligible,
    ).toBe(true);
  });

  it('最终正文含可验算内容但没有验算记录时保留为草稿', () => {
    const result = decideSceneLearnerRelease({
      id: 'scene-unverified-math',
      audit: audit(),
      content: numericContent,
    });
    expect(result.reasons).toContain('verification_missing');
  });

  it('验算失败即使事实审核通过也不得发布', () => {
    const result = decideSceneLearnerRelease({
      id: 'scene-wrong-math',
      audit: audit(),
      content: numericContent,
      verification: {
        ...passedVerification,
        arithmeticPassed: 0,
        failures: ['数值：2 + 2 = 5'],
      },
    });
    expect(result.reasons).toContain('verification_failed');
  });

  it('事实审核与机械验算都通过时可发布数值教学内容', () => {
    expect(
      decideSceneLearnerRelease({
        id: 'scene-verified-math',
        audit: audit(),
        content: numericContent,
        verification: passedVerification,
      }).eligible,
    ).toBe(true);
  });

  it('没有审核记录视为审核未完成，不允许 fail-open', () => {
    expect(decideSceneLearnerRelease({ id: 'scene-missing' })).toEqual({
      eligible: false,
      reasons: ['audit_missing'],
    });
  });

  it('审核服务失败即使旧 decision 写着带警告发布也必须拦截', () => {
    const result = decideSceneLearnerRelease({
      id: 'scene-audit-failed',
      audit: audit({
        verdict: 'flagged',
        claims: [],
        totalClaims: 0,
        decision: 'publish_with_warnings',
        grounded: false,
        evidenceCount: 0,
      }),
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('audit_failed');
  });

  it('显式待复核判决必须拦截', () => {
    const result = decideSceneLearnerRelease({
      id: 'scene-review',
      audit: audit({ decision: 'block_pending_review' }),
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('pending_review');
  });

  it('任何显式 incorrect 断言都必须拦截，不复用旧事实性公式放行', () => {
    const result = decideSceneLearnerRelease({
      id: 'scene-incorrect',
      audit: audit({
        verdict: 'flagged',
        decision: 'publish_with_warnings',
        claims: [{ claim: '待修正断言', verdict: 'incorrect', reason: '与证据冲突', fix: '修正' }],
        incorrectCount: 1,
        flaggedCount: 1,
      }),
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('incorrect_claim');
  });

  it.each([
    ['未接地', false, 1],
    ['证据数为零', true, 0],
    ['证据计数缺失', true, undefined],
  ])('有事实断言但%s时必须拦截', (_label, grounded, evidenceCount) => {
    const result = decideSceneLearnerRelease({
      id: 'scene-no-evidence',
      audit: audit({ grounded, evidenceCount }),
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('ungrounded_factual_claims');
  });

  it('一门课只要有一个场景不合格，整门课仍是草稿', () => {
    const result = decideCourseLearnerRelease({
      stage: { learningContract: releasePlan, courseAudit: cleanCourseAudit },
      scenes: [
        releasedScenes[0],
        { ...releasedScenes[1], audit: audit({ decision: 'block_pending_review' }) },
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.blockedScenes).toEqual([
      { sceneId: 'scene-assessment', reasons: ['pending_review'] },
    ]);
  });

  it('仍在生成的课程不能提前成为学习者发布版', () => {
    const result = decideCourseLearnerRelease({
      stage: { learningContract: releasePlan, courseAudit: cleanCourseAudit },
      scenes: releasedScenes,
      generating: { done: 1, total: 2 },
    });

    expect(result.eligible).toBe(false);
    expect(result.courseReasons).toContain('course_incomplete');
  });

  it('没有落盘教学契约的旧课保持草稿', () => {
    const result = decideCourseLearnerRelease({ scenes: releasedScenes });
    expect(result.courseReasons).toContain('learning_contract_missing');
  });

  it('任一计划场景生成失败时，剩余场景不能发布', () => {
    const result = decideCourseLearnerRelease({
      stage: { learningContract: releasePlan, courseAudit: cleanCourseAudit },
      scenes: releasedScenes.slice(0, 1),
    });

    expect(result.courseReasons).toContain('learning_contract_unfulfilled');
    expect(result.contractViolations).toEqual(
      expect.arrayContaining([
        'planned scene is missing: outline-assessment',
        'transferApplication scene is missing: outline-assessment',
        'assessment scene is missing: outline-assessment',
      ]),
    );
  });

  it('全课程事实终审存在未消解冲突时，逐屏均通过也保持草稿', () => {
    const result = decideCourseLearnerRelease({
      stage: {
        learningContract: releasePlan,
        courseAudit: audit({
          verdict: 'flagged',
          decision: 'block_pending_review',
          claims: [
            {
              claim: '两页对同一阈值给出不同数字。',
              verdict: 'incorrect',
              reason: '跨页冲突',
            },
          ],
          totalClaims: 1,
          incorrectCount: 1,
          flaggedCount: 1,
          courseContentHash: hashCourseScenes(releasedScenes),
        }),
      },
      scenes: releasedScenes,
    });

    expect(result.eligible).toBe(false);
    expect(result.courseReasons).toContain('course_fact_review_failed');
  });

  it('v2 教学契约缺少全课程终审时保持草稿，v1 存量仍兼容', () => {
    expect(
      decideCourseLearnerRelease({
        stage: { learningContract: releasePlan },
        scenes: releasedScenes,
      }).courseReasons,
    ).toContain('course_fact_review_failed');

    expect(
      decideCourseLearnerRelease({
        stage: { learningContract: releasePlanV1 },
        scenes: releasedScenes,
      }).courseReasons,
    ).not.toContain('course_fact_review_failed');
  });

  it('终审后修改最终场景内容会使旧哈希失效并阻断发布', () => {
    const courseAudit = audit({
      claims: [],
      totalClaims: 0,
      flaggedCount: 0,
      uncertainCount: 0,
      incorrectCount: 0,
      grounded: false,
      evidenceCount: 0,
      courseContentHash: hashCourseScenes(releasedScenes),
    });
    const editedScenes = releasedScenes.map((scene, index) =>
      index === 0 ? { ...scene, content: { ...scene.content, edited: true } } : scene,
    );

    const result = decideCourseLearnerRelease({
      stage: { learningContract: releasePlan, courseAudit },
      scenes: editedScenes,
    });

    expect(result.eligible).toBe(false);
    expect(result.courseReasons).toContain('course_fact_review_failed');
  });

  it('计划场景与教学类别全部履约时才可发布', () => {
    expect(
      decideCourseLearnerRelease({
        stage: { learningContract: releasePlan, courseAudit: cleanCourseAudit },
        scenes: releasedScenes,
      }),
    ).toMatchObject({ eligible: true, courseReasons: [], contractViolations: [] });
  });
});
