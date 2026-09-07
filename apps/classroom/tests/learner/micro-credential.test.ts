/**
 * 技能徽章判定（lib/learner/micro-credential.ts）。
 *
 * 钉三件事：三态各自的判据、拿不到的数据源不许被算成「学习者没做」、
 * 以及未登录时整块不可判定而不是逐条编一个「未开始」。
 */

import { describe, expect, it } from 'vitest';

import {
  MICRO_CREDENTIAL_RULE,
  NO_LEARNER_REASON,
  evaluateSkillBadge,
  evaluateSkillBadges,
  indexBadges,
  type LearnerEvidenceInput,
  type SkillEvidenceInput,
} from '@/lib/learner/micro-credential';

const skill: SkillEvidenceInput = {
  skill: 'Agent 记忆类型设计与 RAG 对比选型',
  courses: [{ courseId: 'txRsDW0aYs', title: '智能体记忆系统详解' }],
  concepts: ['agent_basics'],
  scenes: [
    { sceneId: 'scene_a', courseId: 'txRsDW0aYs', courseTitle: '智能体记忆系统详解' },
    { sceneId: 'scene_b', courseId: 'txRsDW0aYs', courseTitle: '智能体记忆系统详解' },
  ],
};

/** 三条都齐的学习者。各条测试再按需削掉其中一条。 */
function fullLearner(): LearnerEvidenceInput {
  return {
    jobId: 'agent_engineer',
    mastery: { agent_basics: 0.93 },
    confidence: { agent_basics: 0.42 },
    derivedAt: '2026-09-05T10:00:00.000Z',
    ledger: 'ready',
    quizzes: [
      {
        sceneId: 'scene_b',
        at: '2026-09-04T08:00:00.000Z',
        passed: true,
        score: 0.9,
        modality: 'quiz',
      },
    ],
    practiceSource: 'ready',
    practice: [
      {
        projectId: 'tiny-universe',
        projectName: 'tiny-universe',
        corpus: 'ai',
        jobIds: ['agent_engineer'],
        doneMilestones: 2,
        updatedAt: '2026-09-06T12:00:00.000Z',
      },
    ],
  };
}

describe('三态', () => {
  it('三条证据齐备 → 已达成，并给出可点回原处的证据与时间', () => {
    const badge = evaluateSkillBadge(skill, fullLearner());
    expect(badge.status).toBe('earned');
    expect(badge.metCount).toBe(3);
    expect(badge.gaps).toEqual([]);
    // 时间取最后一条证据（实操里程碑那条）。
    expect(badge.earnedAt).toBe('2026-09-06T12:00:00.000Z');
    const links = badge.criteria.flatMap((c) => c.evidence.map((e) => e.href));
    expect(links).toContain('/classroom/txRsDW0aYs');
    expect(links).toContain('/practice/ai/tiny-universe');
    expect(links).toContain('/report');
  });

  it('有记录但没到门槛 → 进行中，逐条说清已有与还缺', () => {
    const learner = fullLearner();
    learner.quizzes = [
      {
        sceneId: 'scene_a',
        at: '2026-09-04T08:00:00.000Z',
        passed: false,
        score: 0.5,
        modality: 'quiz',
      },
    ];
    const badge = evaluateSkillBadge(skill, learner);
    expect(badge.status).toBe('in-progress');
    expect(badge.metCount).toBe(2);
    const quiz = badge.criteria.find((c) => c.id === 'quiz-pass')!;
    expect(quiz.met).toBe(false);
    expect(quiz.unavailable).toBe(false);
    expect(quiz.detail).toContain('还没有一次判定过线');
    // 没过线的那次也要露出来：它是「做过」的证据。
    expect(quiz.evidence[0].label).toContain('未过线');
    expect(badge.earnedAt).toBeNull();
  });

  it('一条记录都没有 → 未开始', () => {
    const badge = evaluateSkillBadge(skill, {
      ...fullLearner(),
      mastery: {},
      confidence: {},
      quizzes: [],
      practice: [
        {
          projectId: 'tiny-universe',
          projectName: 'tiny-universe',
          corpus: 'ai',
          jobIds: ['agent_engineer'],
          doneMilestones: 0,
          updatedAt: '',
        },
      ],
    });
    expect(badge.status).toBe('not-started');
    expect(badge.metCount).toBe(0);
    expect(badge.criteria.every((c) => c.unavailable === false)).toBe(true);
  });

  it('掌握度过线但置信度不够 → 不算达成（证据封顶，一两次答对不判掌握）', () => {
    const learner = fullLearner();
    learner.confidence = { agent_basics: 0.1 };
    const badge = evaluateSkillBadge(skill, learner);
    expect(badge.status).toBe('in-progress');
    const concept = badge.criteria.find((c) => c.id === 'concept-mastery')!;
    expect(concept.met).toBe(false);
    expect(concept.started).toBe(true);
  });

  it('相关概念要全部过门，漏一个就不算达成', () => {
    const twoConcepts: SkillEvidenceInput = {
      ...skill,
      concepts: ['agent_basics', 'context_engineering'],
    };
    const badge = evaluateSkillBadge(twoConcepts, fullLearner());
    const concept = badge.criteria.find((c) => c.id === 'concept-mastery')!;
    expect(concept.met).toBe(false);
    expect(concept.detail).toContain('1/2');
    expect(badge.status).toBe('in-progress');
  });
});

describe('数据源缺失', () => {
  it('账本读不到 → 那条判不了，写进 gaps，不算达成也不算没做', () => {
    const learner = fullLearner();
    learner.ledger = 'unavailable';
    learner.quizzes = [];
    const badge = evaluateSkillBadge(skill, learner);
    const quiz = badge.criteria.find((c) => c.id === 'quiz-pass')!;
    expect(quiz.unavailable).toBe(true);
    expect(quiz.met).toBe(false);
    expect(quiz.detail).toContain('读不到不等于没做过');
    expect(badge.gaps).toHaveLength(1);
    expect(badge.gaps[0]).toContain('对口课测验判定过线');
    // 另外两条仍然达成，所以整体是进行中，不会因为一条判不了就退回未开始。
    expect(badge.status).toBe('in-progress');
    expect(badge.metCount).toBe(2);
    expect(badge.earnedAt).toBeNull();
  });

  it('技能没有对口课 → 概念与测验两条都判不了，各自说明缺什么', () => {
    const orphan: SkillEvidenceInput = {
      skill: '自进化 Agent',
      courses: [],
      concepts: [],
      scenes: [],
    };
    const badge = evaluateSkillBadge(orphan, fullLearner());
    expect(badge.gaps).toHaveLength(2);
    expect(badge.criteria.find((c) => c.id === 'concept-mastery')!.detail).toContain(
      '还没有对口课',
    );
    expect(badge.criteria.find((c) => c.id === 'quiz-pass')!.detail).toContain('还没成课');
    // 实操那条仍然达成 → 进行中。
    expect(badge.status).toBe('in-progress');
  });

  it('该岗位还没有已发布实操项目 → 那条判不了，不拿别的岗位的项目顶上', () => {
    const learner = fullLearner();
    learner.practice = [
      {
        projectId: 'other',
        projectName: '别的岗位的项目',
        corpus: 'ai',
        jobIds: ['ml_engineer'],
        doneMilestones: 5,
        updatedAt: '2026-09-06T12:00:00.000Z',
      },
    ];
    const badge = evaluateSkillBadge(skill, learner);
    const practice = badge.criteria.find((c) => c.id === 'practice-acceptance')!;
    expect(practice.unavailable).toBe(true);
    expect(practice.evidence).toEqual([]);
    expect(badge.status).toBe('in-progress');
  });

  it('实操项目清单读不到 → 判不了，与「本领域没有项目」是两回事', () => {
    const learner = fullLearner();
    learner.practiceSource = 'unavailable';
    learner.practice = [];
    const practice = evaluateSkillBadge(skill, learner).criteria.find(
      (c) => c.id === 'practice-acceptance',
    )!;
    expect(practice.unavailable).toBe(true);
    expect(practice.detail).toContain('没读到');
  });

  it('别的领域的测验交卷不算数：场景对不上对口课就不进证据', () => {
    const learner = fullLearner();
    learner.quizzes = [
      {
        sceneId: 'scene_from_other_course',
        at: '2026-09-04T08:00:00.000Z',
        passed: true,
        score: 1,
        modality: 'quiz',
      },
    ];
    const quiz = evaluateSkillBadge(skill, learner).criteria.find((c) => c.id === 'quiz-pass')!;
    expect(quiz.met).toBe(false);
    expect(quiz.detail).toContain('还没有交卷记录');
  });
});

describe('没有学习者记录', () => {
  it('未登录 → 整块不可判定，给出明确文案，不逐条编「未开始」', () => {
    const report = evaluateSkillBadges({ skills: [skill], learner: null });
    expect(report.kind).toBe('unavailable');
    if (report.kind !== 'unavailable') throw new Error('unreachable');
    expect(report.reason).toBe(NO_LEARNER_REASON);
    expect(report.reason).toContain('登录后按你的学习记录判定');
    expect(indexBadges(report).size).toBe(0);
  });

  it('上游有更具体的原因时原样带出来', () => {
    const report = evaluateSkillBadges({
      skills: [skill],
      learner: null,
      unavailableReason: '当前账户画像暂时无法读取。',
    });
    expect(report.kind === 'unavailable' && report.reason).toBe('当前账户画像暂时无法读取。');
  });
});

describe('对外口径', () => {
  it('判据原文写清三条与门槛', () => {
    expect(MICRO_CREDENTIAL_RULE).toContain('0.90');
    expect(MICRO_CREDENTIAL_RULE).toContain('80%');
    expect(MICRO_CREDENTIAL_RULE).toContain('里程碑验收');
  });

  it('概念名可由调用方翻译，判定本身不依赖中文名', () => {
    const badge = evaluateSkillBadge(skill, fullLearner(), (c) =>
      c === 'agent_basics' ? '智能体基础' : c,
    );
    const concept = badge.criteria.find((c) => c.id === 'concept-mastery')!;
    expect(concept.evidence[0].label).toContain('智能体基础');
    expect(concept.met).toBe(true);
  });

  it('按技能名建索引，供视图逐项查', () => {
    const report = evaluateSkillBadges({ skills: [skill], learner: fullLearner() });
    expect(report.kind).toBe('ready');
    const index = indexBadges(report);
    expect(index.get(skill.skill)?.status).toBe('earned');
  });
});
