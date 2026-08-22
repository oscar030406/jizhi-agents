import { describe, expect, it } from 'vitest';
import {
  deriveCompression,
  deriveTier,
  facetsFromProfile,
  fromLegacyBlueprint,
  makeSpec,
  specEquals,
  specKey,
  toDirective,
} from '@/lib/generation/spec';
import type { LearnerBlueprint, LearnerProfileInput } from '@/lib/generation/learner-profile';

// 真实载荷：apps/agent-engine/data/demo_runs/01-beginner-initial.json 的 diagnosis 段。
const BEGINNER: LearnerBlueprint = {
  mastery_vector: {
    agent_basics: 0.0,
    rag: 0.0,
    tool_calling: 0.0,
    langgraph: 0.0,
    evaluation: 0.0,
    deployment: 0.0,
    guardrails: 0.25,
  },
  weak_concepts: [
    'agent_basics',
    'rag',
    'tool_calling',
    'langgraph',
    'evaluation',
    'guardrails',
    'deployment',
  ],
  recommended_difficulty: 'L1',
  learning_risks: [],
  diagnosis_summary: '',
  blueprint: {
    refined_goal: '',
    learner_type: 'guided_beginner',
    skill_gaps: [
      {
        concept: 'evaluation',
        current_mastery: 0.0,
        target_mastery: 0.75,
        gap: 0.75,
        priority: 1,
        reason: '',
      },
      {
        concept: 'langgraph',
        current_mastery: 0.0,
        target_mastery: 0.75,
        gap: 0.75,
        priority: 2,
        reason: '',
      },
      {
        concept: 'tool_calling',
        current_mastery: 0.0,
        target_mastery: 0.6,
        gap: 0.6,
        priority: 3,
        reason: '',
      },
      {
        concept: 'rag',
        current_mastery: 0.0,
        target_mastery: 0.6,
        gap: 0.6,
        priority: 4,
        reason: '',
      },
      {
        concept: 'agent_basics',
        current_mastery: 0.0,
        target_mastery: 0.45,
        gap: 0.45,
        priority: 5,
        reason: '',
      },
    ],
    content_strategy: [],
    practice_strategy: [],
    assessment_strategy: [],
    resource_mix: {
      scaffold_level: 'full',
      visual_widget_count: 2,
      diagram_count: 2,
      code_example_count: 1,
      analogy_domain: '生活场景（旅行、点餐、快递分拣）',
      section_length_band: '160-220',
      quiz_difficulty_band: ['L1', 'L2'],
      rationale: [],
    },
  },
};

const BEGINNER_PROFILE: LearnerProfileInput = {
  domain: 'ai',
  education: 'college',
  role: '在校学生',
  programming_level: 0,
  python_level: 0,
  agent_level: 0,
  rag_level: 0,
  engineering_level: 0,
  learning_preference: '可运行示例与分步练习',
  time_budget_hours: 24,
};

// 真实载荷：apps/agent-engine/data/demo_runs/02-engineer-initial.json 的 diagnosis 段。
const ENGINEER: LearnerBlueprint = {
  mastery_vector: {
    agent_basics: 0.25,
    rag: 0.5,
    tool_calling: 0.75,
    langgraph: 0.25,
    evaluation: 0.75,
    deployment: 1.0,
    guardrails: 0.5,
  },
  weak_concepts: ['agent_basics', 'langgraph'],
  recommended_difficulty: 'L3',
  learning_risks: [],
  diagnosis_summary: '',
  blueprint: {
    refined_goal: '',
    learner_type: 'systems_engineer',
    skill_gaps: [
      {
        concept: 'langgraph',
        current_mastery: 0.25,
        target_mastery: 0.75,
        gap: 0.5,
        priority: 1,
        reason: '',
      },
      {
        concept: 'agent_basics',
        current_mastery: 0.25,
        target_mastery: 0.45,
        gap: 0.2,
        priority: 2,
        reason: '',
      },
      {
        concept: 'rag',
        current_mastery: 0.5,
        target_mastery: 0.6,
        gap: 0.1,
        priority: 3,
        reason: '',
      },
      {
        concept: 'tool_calling',
        current_mastery: 0.75,
        target_mastery: 0.6,
        gap: 0.0,
        priority: 4,
        reason: '',
      },
      {
        concept: 'evaluation',
        current_mastery: 0.75,
        target_mastery: 0.75,
        gap: 0.0,
        priority: 5,
        reason: '',
      },
    ],
    content_strategy: [],
    practice_strategy: [],
    assessment_strategy: [],
    resource_mix: {
      scaffold_level: 'minimal',
      visual_widget_count: 1,
      diagram_count: 1,
      code_example_count: 1,
      analogy_domain: '后端工程场景（接口契约、缓存失效、数据库查询）',
      section_length_band: '100-160',
      quiz_difficulty_band: ['L2', 'L3'],
      rationale: [],
    },
  },
};

const ENGINEER_PROFILE: LearnerProfileInput = {
  domain: 'ai',
  education: 'bachelor',
  role: '后端开发转型',
  programming_level: 4,
  python_level: 3,
  agent_level: 1,
  rag_level: 2,
  engineering_level: 4,
  learning_preference: '系统设计、接口契约和扩展 TODO',
  time_budget_hours: 24,
};

describe('相等判定', () => {
  const core = {
    kcs: ['rag', 'langgraph'],
    tier: 'L2' as const,
    modality: 'lecture' as const,
    sequence: 'from-scratch' as const,
    compression: 'standard' as const,
    assumedKnown: ['tool_calling'],
  };

  it('同核心维、不同装饰维 → 相等', () => {
    const a = makeSpec({
      ...core,
      decoration: { analogyDomain: '后端工程场景', tone: 'systems_engineer' },
    });
    const b = makeSpec({
      ...core,
      decoration: { analogyDomain: '生活场景', examplePreference: '看图先行' },
    });
    expect(specEquals(a, b)).toBe(true);
    expect(specKey(a)).toBe(specKey(b));
  });

  it('集合的顺序与重复不影响相等', () => {
    const a = makeSpec(core);
    const b = makeSpec({
      ...core,
      kcs: ['langgraph', 'rag', 'rag'],
      assumedKnown: [' tool_calling ', ''],
    });
    expect(specEquals(a, b)).toBe(true);
  });

  it('任一核心维不同 → 不相等（严格全等，不引阈值）', () => {
    const base = makeSpec(core);
    expect(specEquals(base, makeSpec({ ...core, tier: 'L3' }))).toBe(false);
    expect(specEquals(base, makeSpec({ ...core, modality: 'quiz' }))).toBe(false);
    expect(specEquals(base, makeSpec({ ...core, sequence: 'framework' }))).toBe(false);
    expect(specEquals(base, makeSpec({ ...core, compression: 'compact' }))).toBe(false);
    expect(specEquals(base, makeSpec({ ...core, kcs: ['rag'] }))).toBe(false);
    expect(specEquals(base, makeSpec({ ...core, assumedKnown: [] }))).toBe(false);
  });

  it('前置假设集与知识点集不相交——重合项被剔除，否则语义相同的两份规格会不相等', () => {
    const withOverlap = makeSpec({ ...core, assumedKnown: ['tool_calling', 'rag'] });
    expect(withOverlap.assumedKnown).toEqual(['tool_calling']);
    expect(specEquals(withOverlap, makeSpec(core))).toBe(true);
  });
});

describe('稳定序列化', () => {
  it('key 只吃核心维，可直接当聚合 key', () => {
    const spec = makeSpec({
      kcs: ['rag', 'agent_basics'],
      tier: 'L1',
      modality: 'quiz',
      sequence: 'concept',
      compression: 'detailed',
      assumedKnown: ['guardrails'],
      decoration: { analogyDomain: '生活场景', tone: 'guided_beginner' },
    });
    expect(specKey(spec)).toBe(
      '[["agent_basics","rag"],"L1","quiz","concept","detailed",["guardrails"]]',
    );
    // 反复调用不漂移
    expect(specKey(spec)).toBe(specKey(makeSpec({ ...spec, decoration: {} })));
  });
});

describe('档位导出表', () => {
  it('通用面低 → L1，专业面不看', () => {
    expect(deriveTier(0, 0)).toBe('L1');
    expect(deriveTier(1, 4)).toBe('L1'); // 边界：通用面 =1 仍算低
  });

  it('通用面高 + 专业面低 → L2', () => {
    expect(deriveTier(2, 0)).toBe('L2'); // 边界：通用面 =2 起算高
    expect(deriveTier(4, 2)).toBe('L2'); // 边界：专业面 =2 仍算低
  });

  it('通用面高 + 专业面高 → L3', () => {
    expect(deriveTier(2, 3)).toBe('L3'); // 边界：专业面 =3 起算高
    expect(deriveTier(4, 4)).toBe('L3');
  });

  it('画像两面的取数与真实画像对得上', () => {
    expect(facetsFromProfile(BEGINNER_PROFILE)).toEqual({ general: 0, domain: 0 });
    expect(facetsFromProfile(ENGINEER_PROFILE)).toEqual({ general: 4, domain: 4 });
  });
});

describe('压缩带', () => {
  it('跟引擎判词走，前端不再自己拿小时数判一遍', () => {
    expect(deriveCompression('L3', 'ok')).toBe('standard');
    expect(deriveCompression('L3', 'tight')).toBe('compact');
    expect(deriveCompression('L3', 'infeasible')).toBe('compact');
  });

  it('没有判词时取 standard —— 那是「没判」，不是「宽裕」', () => {
    expect(deriveCompression('L3', undefined)).toBe('standard');
  });

  it('L1 有压缩下限——判词再紧也不压到紧凑档', () => {
    expect(deriveCompression('L1', 'tight')).toBe('standard');
    expect(deriveCompression('L1', 'infeasible')).toBe('standard');
  });
});

describe('toDirective', () => {
  const spec = makeSpec({
    kcs: ['langgraph', 'agent_basics'],
    tier: 'L2',
    modality: 'lecture',
    sequence: 'from-scratch',
    compression: 'compact',
    assumedKnown: ['tool_calling'],
    decoration: { analogyDomain: '后端工程场景（接口契约、缓存失效、数据库查询）' },
  });
  const out = toDirective(spec);

  it('带上知识点、档位硬要求、序列位、压缩带、前置假设', () => {
    expect(out).toContain('agent_basics、langgraph');
    expect(out).toContain('难度档：L2');
    expect(out).toContain('读者会编程、没有任何 AI 背景');
    expect(out).toContain('从零实现');
    expect(out).toContain('压缩带 紧凑');
    expect(out).toContain('前置假设（视为已会');
    expect(out).toContain('tool_calling');
  });

  it('装饰维只作软偏好，且不写事实授权', () => {
    expect(out).toContain('后端工程场景（接口契约、缓存失效、数据库查询）');
    expect(out).toContain('不要强行套用');
    expect(out).toContain('不得改变任何知识事实');
  });

  it('换档就换硬要求', () => {
    expect(toDirective(makeSpec({ ...spec, tier: 'L1' }))).toContain('读者不会编程');
    expect(toDirective(makeSpec({ ...spec, tier: 'L3' }))).toContain('术语直接使用不再定义');
  });
});

describe('fromLegacyBlueprint（真实引擎载荷）', () => {
  it('零基础画像 → L1、无前置假设、压缩带顶到下限之上', () => {
    const { spec, reasons } = fromLegacyBlueprint(BEGINNER, BEGINNER_PROFILE);
    expect(spec.tier).toBe('L1');
    expect(spec.kcs).toEqual(['evaluation', 'langgraph', 'rag', 'tool_calling']); // 按 priority 取前 4，再排序
    expect(spec.assumedKnown).toEqual([]); // 掌握度最高 0.25，全在 uncertain 带以下
    expect(spec.compression).toBe('standard');
    expect(spec.decoration.analogyDomain).toBe('生活场景（旅行、点餐、快递分拣）');
    expect(reasons.some((r) => r.dim === 'tier')).toBe(true);
  });

  it('后端转型画像 → L3，进了知识状态的概念才算前置假设', () => {
    const { spec } = fromLegacyBlueprint(ENGINEER, ENGINEER_PROFILE);
    expect(spec.tier).toBe('L3');
    // gap=0 的 tool_calling / evaluation 不进知识点集
    expect(spec.kcs).toEqual(['agent_basics', 'langgraph', 'rag']);
    // 只有 deployment=1.0 越过 in-state 带（>0.8）。tool_calling / evaluation 都是 0.75，
    // 落在 uncertain 带，按三分带不计入状态——这不是回归，是 D-31 的纠正：老口径 ≥0.7
    // 会把这两个当成已会，资源里就不再解释它们。
    expect(spec.assumedKnown).toEqual(['deployment']);
  });

  it('载荷带判词时压缩带跟着判词走，理由链写明判词来自引擎', () => {
    const { spec, reasons } = fromLegacyBlueprint(
      { ...ENGINEER, feasibility: { verdict: 'infeasible' } } as LearnerBlueprint,
      ENGINEER_PROFILE,
    );
    expect(spec.compression).toBe('compact');
    expect(reasons.find((r) => r.dim === 'compression')?.from).toContain(
      'feasibility.verdict=infeasible',
    );
  });

  it('载荷没有判词时理由链如实写「未判」，不写成预算宽裕', () => {
    const { reasons } = fromLegacyBlueprint(BEGINNER, BEGINNER_PROFILE);
    const r = reasons.find((x) => x.dim === 'compression');
    expect(r?.from).toContain('未判');
    expect(r?.because).toContain('没给判词');
  });

  it('画像缺 programming_level 时退回引擎推荐档（老行为）', () => {
    const { spec, reasons } = fromLegacyBlueprint(ENGINEER, { domain: 'ai' });
    expect(spec.tier).toBe('L3');
    expect(reasons.find((r) => r.dim === 'tier')?.from).toBe('引擎 recommended_difficulty');
  });

  it('because 链挂在规格外面，不参与相等判定', () => {
    const a = fromLegacyBlueprint(ENGINEER, ENGINEER_PROFILE);
    const b = fromLegacyBlueprint(ENGINEER, {
      ...ENGINEER_PROFILE,
      learning_preference: '别的偏好',
    });
    expect(specEquals(a.spec, b.spec)).toBe(true);
    expect(a.reasons.length).toBeGreaterThan(0);
    expect(Object.keys(a.spec)).not.toContain('reasons');
  });

  it('调用方指定知识点/形态/序列位时以调用方为准', () => {
    const { spec } = fromLegacyBlueprint(ENGINEER, ENGINEER_PROFILE, {
      kcs: ['tool_calling'],
      modality: 'critique',
      sequence: 'framework',
    });
    expect(spec.kcs).toEqual(['tool_calling']);
    expect(spec.modality).toBe('critique');
    expect(spec.sequence).toBe('framework');
    // tool_calling 成了本节的知识点，就不再算「视为已知」（这里它本来也没进状态）
    expect(spec.assumedKnown).toEqual(['deployment']);
  });
});
