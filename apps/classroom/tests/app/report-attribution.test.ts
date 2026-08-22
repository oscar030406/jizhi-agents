import { describe, expect, it } from 'vitest';

import {
  humanizeEngineText,
  learnerTypeLabel,
  levelBandText,
  levelText,
  whyThisCourse,
} from '@/app/report/attribution';
import type { LearnerBlueprint } from '@/lib/generation/learner-profile';
import type { LearnerProfileFields } from '@/lib/types/generation';

/**
 * 「你的课为什么长这样」的两条纪律，与对比页的 humanDifferences 同源：
 * 1. 每条归因都指得回画像/诊断里的**具体字段**，不写没有出处的形容；
 * 2. **字段缺就不出这一条**——引擎降级返回空 resource_mix 时这一节会短，
 *    不许补零、不许写「未返回」占位。
 */

const PROFILE: LearnerProfileFields = {
  domain: 'ai',
  role: '后端开发转 Agent 应用。',
  programming_level: 3,
  python_level: 3,
  agent_level: 1,
  rag_level: 1,
  engineering_level: 3,
  learning_preference: '系统设计、接口契约和扩展 TODO',
};

const FULL: LearnerBlueprint = {
  mastery_vector: { rag: 0.2 },
  weak_concepts: ['rag'],
  recommended_difficulty: 'L2',
  learning_risks: [],
  diagnosis_summary: '',
  blueprint: {
    refined_goal: '',
    learner_type: '工程型转型者',
    skill_gaps: [],
    content_strategy: ['先给可运行例子，再讲机制。'],
    practice_strategy: [],
    assessment_strategy: [],
    resource_mix: {
      scaffold_level: 'faded',
      visual_widget_count: 1,
      diagram_count: 2,
      code_example_count: 3,
      analogy_domain: '后端服务与接口设计',
      section_length_band: '400-600',
      quiz_difficulty_band: ['L1', 'L3'],
      rationale: [],
    },
  },
};

/** 引擎降级：诊断回来了，但没有 resource_mix、没有薄弱概念。 */
const DEGRADED: LearnerBlueprint = {
  ...FULL,
  weak_concepts: [],
  blueprint: { ...FULL.blueprint!, content_strategy: [], resource_mix: null },
};

describe('档位读数：不吐引擎的内部记号', () => {
  it('整数档写成序数', () => {
    expect(levelText(2)).toBe('第 2 档');
  });

  it('落在档间按区间写，不造一个不存在的第 1.5 档', () => {
    expect(levelText(1.5)).toBe('第 1–2 档之间');
  });

  it('难度带整段换算', () => {
    expect(levelBandText(['L1', 'L3'])).toBe('第 1–3 档');
    expect(levelBandText([])).toBe('');
  });
});

describe('humanizeEngineText：内部记号是从数据里来的，不是从源码里来的', () => {
  // 实测拔到的两句原文（引擎 diagnosis_summary / resource_mix.rationale）
  const LABELS: Record<string, string> = {
    agent_basics: '智能体基础',
    rag: '检索增强 RAG',
    langgraph: '工作流编排',
  };
  const label = (id: string) => LABELS[id] ?? id;

  it('档位记号换序数，概念 id 换中文名', () => {
    const out = humanizeEngineText(
      '建议 外部学习者 从 L3 难度起步。薄弱概念：agent_basics、rag、langgraph。',
      label,
    );
    expect(out).toBe('建议 外部学习者 从 第 3 档 难度起步。薄弱概念：智能体基础、检索增强 RAG、工作流编排。');
    expect(out).not.toMatch(/\bL[1-4]\b/);
  });

  it('学习者类型枚举换中文名', () => {
    expect(humanizeEngineText('学习者类型 systems_engineer → 测验难度带 L2/L3', label)).toBe(
      '学习者类型 系统工程型 → 测验难度带 第 2 档/第 3 档',
    );
    expect(learnerTypeLabel('guided_beginner')).toBe('需引导的入门者');
  });

  it('学习风险枚举换中文名', () => {
    expect(humanizeEngineText('evidence_grounding_risk', label)).toBe('证据接地风险');
  });

  it('词表里没有的词原样留着，不改成别的意思', () => {
    expect(humanizeEngineText('走的是 unknown_id 这一路', label)).toBe('走的是 unknown_id 这一路');
    expect(learnerTypeLabel('brand_new_type')).toBe('brand_new_type');
  });
});

describe('whyThisCourse', () => {
  const rows = whyThisCourse({
    profile: PROFILE,
    bp: FULL,
    weakConcepts: ['检索增强 RAG'],
    courseName: 'RAG 入门',
  });
  const byDim = (d: string) => rows.find((r) => r.dimension === d);

  it('讲解姿态一条：档位是画像算的，因由指回自评分', () => {
    const r = byDim('难度与讲解姿态')!;
    expect(r.observation).toContain('转行者');
    expect(r.observation).toContain('第 2 档');
    expect(r.because).toContain('编程自评 3/4');
  });

  it('例子取材指回培训领域与身份', () => {
    const r = byDim('例子取材')!;
    expect(r.observation).toContain('后端服务与接口设计');
    expect(r.because.join(' ')).toContain('人工智能应用开发');
    // trimStop：身份自述自带句号，嵌进「」里不该多一个点
    expect(r.because.join(' ')).toContain('「后端开发转 Agent 应用」');
  });

  it('补基础小节用真实薄弱概念数与课名', () => {
    const r = byDim('补基础的小节')!;
    expect(r.observation).toContain('检索增强 RAG');
    expect(r.observation).toContain('RAG 入门');
  });

  it('篇幅与代码配比逐项取自 resource_mix', () => {
    const r = byDim('篇幅与代码配比')!;
    expect(r.observation).toContain('代码示例 3 个');
    expect(r.observation).toContain('400-600 字');
    expect(r.because).toContain('Python 自评 3/4');
  });

  it('测验难度带换算成序数，不出现引擎记号', () => {
    expect(byDim('测验难度')!.observation).toContain('第 1–3 档');
  });

  it('没单独选库时如实说是跟随培训领域', () => {
    const r = byDim('参考资料')!;
    expect(r.observation).toContain('人工智能应用开发');
    expect(r.because[0]).toContain('跟随培训领域');
  });

  it('选了库就读那个库，名字是中文', () => {
    const r = whyThisCourse({
      profile: { ...PROFILE, corpus: 'odoo' },
      bp: FULL,
      weakConcepts: [],
    }).find((x) => x.dimension === '参考资料')!;
    expect(r.observation).toContain('企业管理系统 Odoo');
  });

  it('引擎降级：缺的维度整条不出，不补占位', () => {
    const degraded = whyThisCourse({ profile: PROFILE, bp: DEGRADED, weakConcepts: [] });
    const dims = degraded.map((r) => r.dimension);
    expect(dims).not.toContain('例子取材');
    expect(dims).not.toContain('篇幅与代码配比');
    expect(dims).not.toContain('补基础的小节');
    expect(dims).not.toContain('测验难度');
    // 画像本身算得出来的两条仍在
    expect(dims).toContain('难度与讲解姿态');
    expect(dims).toContain('参考资料');
    expect(degraded.map((r) => r.observation).join('')).not.toContain('未返回');
  });

  it('整节没有一条上屏内容里带引擎档位记号 L1/L2/L3/L4', () => {
    const text = rows.map((r) => r.observation + r.because.join('')).join('');
    expect(text).not.toMatch(/\bL[1-4]\b/);
  });
});
