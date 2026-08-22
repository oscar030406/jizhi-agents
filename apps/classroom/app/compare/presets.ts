/**
 * 对比页可选的预设画像。
 *
 * 字段逐个抄自引擎的 `apps/agent-engine/data/learner_profiles/learner_profiles.json`，
 * 一个字段都不新造——`tests/app/compare-report.test.ts` 直接读那份 JSON 逐字段比对，
 * 引擎侧改了这里没跟上，测试会红。
 *
 * 为什么是这四个：两根轴各切一刀，两两组合正好四格。
 *   轴一 编程基础：Python 与工程实践的分值（弱 = 两项都在 2/4 及以下）。
 *   轴二 想要什么样的材料：画像里的学习偏好（要例子和步骤 / 要设计图和接口）。
 * 引擎两根轴都真吃：Python 与工程分值进诊断的掌握度初值
 * （`backend/agents/learner_diagnosis_agent.py:43-49`）与生成提示词
 * （`backend/agents/resource_generation_agent.py:229-230`）；学习偏好进同一段提示词，
 * 并决定配比里的教具/图示/代码示例数量。
 *
 * 原先还有第五个画像（团队赶比赛演示那个），2026-08-15 删除：它在两根轴上都落进
 * 别人已经占了的格子，真正的区别只有 20 小时的时间预算——那是另一个维度的东西。
 */

export interface ComparePreset {
  id: string;
  name: string;
  /** learner_profiles.json 的 background */
  background: string;
  /** 五个 *_level 字段，满分 4 */
  levels: {
    programming: number;
    python: number;
    agent: number;
    rag: number;
    engineering: number;
  };
  /** learning_preference */
  wantsText: string;
  /** learning_goal：画像自带的目标，跑对比时以输入框里的目标为准 */
  goal: string;
  /** 轴一：编程基础 */
  base: 'weak' | 'strong';
  /** 轴二：想要什么样的材料 */
  wants: 'examples' | 'design';
}

/** 网格按行主序排：第一行编程基础弱，第二行强；每行左「要例子」右「要设计」。 */
export const PRESETS: readonly ComparePreset[] = [
  {
    id: 'zero_beginner',
    name: '零基础型',
    background: '非计算机专业，想用 AI 做简单工具。',
    levels: { programming: 0, python: 0, agent: 0, rag: 0, engineering: 0 },
    wantsText: '生活类比和分步练习',
    goal: '理解 Agent 应用开发的最小闭环，并完成一个文档问答助手。',
    base: 'weak',
    wants: 'examples',
  },
  {
    id: 'ai_weak_engineering',
    name: 'AI 专业但工程能力弱',
    background: '理解模型和论文，缺少 API、部署、测试经验。',
    levels: { programming: 2, python: 2, agent: 2, rag: 2, engineering: 1 },
    wantsText: '架构图、接口说明和测试驱动',
    goal: '把 RAG 和评测做成可部署的 Agent 工作流。',
    base: 'weak',
    wants: 'design',
  },
  {
    id: 'python_no_agent',
    name: '有 Python 基础但不了解 Agent',
    background: '会写脚本和简单 Web API，但没做过 Agent/RAG。',
    levels: { programming: 2, python: 3, agent: 0, rag: 1, engineering: 2 },
    wantsText: '代码模板和可运行示例',
    goal: '用 FastAPI 做一个带检索和工具调用的 Agent 服务。',
    base: 'strong',
    wants: 'examples',
  },
  {
    id: 'backend_to_agent',
    name: '后端开发转 Agent 应用',
    background: '熟悉后端服务和数据库，想掌握 Agent 编排与审核。',
    levels: { programming: 4, python: 3, agent: 1, rag: 2, engineering: 4 },
    wantsText: '系统设计、接口契约和扩展 TODO',
    goal: '构建可观测、多 Agent 协作、带审核和评测的学习助手。',
    base: 'strong',
    wants: 'design',
  },
] as const;

/** 字段名用人话，顺序即卡片上的展示顺序。 */
export const LEVEL_LABELS: ReadonlyArray<[keyof ComparePreset['levels'], string]> = [
  ['programming', '编程'],
  ['python', 'Python'],
  ['agent', 'Agent 了解'],
  ['rag', '检索增强（RAG）'],
  ['engineering', '工程实践'],
];

export const BASE_LABEL: Record<ComparePreset['base'], string> = {
  weak: '编程基础弱',
  strong: '编程基础强',
};

export const WANTS_LABEL: Record<ComparePreset['wants'], string> = {
  examples: '要例子和步骤',
  design: '要设计图和接口',
};
