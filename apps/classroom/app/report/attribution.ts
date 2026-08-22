/**
 * 「你的课为什么长这样」——单人版差异归因。
 *
 * 同题异人对比页回答的是「两个人拿到的课差在哪」（`app/compare/report.ts` 的
 * `humanDifferences`）。这里是同一套思路的单人版：对象换成登录者自己的画像与
 * 这门课，不做两列对照，所以每条只有「结果 ← 画像的哪个字段」这一跳。
 *
 * 复用的是**结构**不是文案：`AttributedDifference` 与 `trimStop` 直接从对比页那份
 * 引过来，两处的归因条形状一致（维度 / 一句人话 / 指得回具体字段的 because 链），
 * 谁改了形状另一处会立刻编译不过。
 *
 * 纪律与对比页同源：**字段缺就不写这一条**，不补零、不写「未返回」占位。
 * 引擎降级返回空 resource_mix 时这一节会短，那是真的短，不是这里省略了。
 */

import type { AttributedDifference } from '@/app/compare/report';
import { trimStop } from '@/app/compare/report';
import { TIER_TEXT, NO_BLUEPRINT } from '@/components/generation/profile-impact-preview';
import { corpusOf, presentationTier, type LearnerBlueprint } from '@/lib/generation/learner-profile';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import type { LearnerProfileFields } from '@/lib/types/generation';

/** 引擎难度量表（backend/agents/learning_path_planner_agent.py `_LEVELS`）。 */
export const LEVELS = ['L1', 'L2', 'L3', 'L4'];

export const levelRank = (level: string): number => Math.max(1, LEVELS.indexOf(level) + 1);

/**
 * 档位读数。写成「第 N 档」而不是原样吐引擎的 `L2`：量表是内部记号，
 * 学习者读不出 L 是什么，而序数本身不丢任何信息。
 *
 * 估计值取能力区间中点，可能落在两档之间（区间 [1,2] 的中点是 1.5）——
 * 量表上没有第 1.5 档，把它写成「第 1.5 档」是把一个不存在的档位当档位报，
 * 所以落在档间时按区间写。
 */
export function levelText(rank: number): string {
  return Number.isInteger(rank) ? `第 ${rank} 档` : `第 ${Math.floor(rank)}–${Math.ceil(rank)} 档之间`;
}

/** 一串引擎档位（如测验难度带）转人话：`L1/L2` → `第 1–2 档`。 */
export function levelBandText(band: string[]): string {
  const ranks = band.map(levelRank).filter((r) => r > 0);
  if (ranks.length === 0) return '';
  const lo = Math.min(...ranks);
  const hi = Math.max(...ranks);
  return lo === hi ? `第 ${lo} 档` : `第 ${lo}–${hi} 档`;
}

/**
 * 引擎的 `learner_type` 枚举 → 中文名。
 *
 * 闭集，三个值，判据在 `backend/services/personalization_service.py` 的 `_learner_type`
 * （按平均掌握度与编程/工程档位分流），中文名是那三条判据的直译，不是新编的口径。
 * 查不到就退回原值——与 `domainLabel` 同一个约定，引擎哪天加了第四类不会被静默改名。
 */
const LEARNER_TYPE_LABEL: Readonly<Record<string, string>> = {
  guided_beginner: '需引导的入门者',
  practice_builder: '动手实践型',
  systems_engineer: '系统工程型',
};

/**
 * 引擎 `learning_risks` 的枚举 → 中文名。
 *
 * 判据在 `backend/agents/learner_diagnosis_agent.py`（工程档位 ≤1 / rag 薄弱 /
 * evaluation 薄弱三条），中文名是这三条的直译。这一路**不是闭集**——LLM 分支
 * 可以再补别的风险 id，所以查不到照样原样上屏，不硬编一个兜底名。
 */
const RISK_LABEL: Readonly<Record<string, string>> = {
  engineering_foundation_weak: '工程基础薄弱',
  evidence_grounding_risk: '证据接地风险',
  cannot_self_verify_outputs: '难以自行验证产出',
};

export function learnerTypeLabel(t?: string): string {
  return (t && LEARNER_TYPE_LABEL[t]) || t || '';
}

/**
 * 引擎返回的**自由文本**上屏前的人话化。
 *
 * 这一步是必须的，原因是实测出来的：页面源码里一个内部记号都没有，DOM 上却印着
 * `建议从 L3 难度起步。薄弱概念：agent_basics、rag、langgraph` 和
 * `学习者类型 systems_engineer → 支架档 minimal、测验难度带 L2/L3`——串不在源码里，
 * 在引擎返回的 `diagnosis_summary` / `resource_mix.rationale` 数据里。
 *
 * 只换记号，不改语义、不删句子：档位换成序数，概念 id 与学习者类型换成中文名，
 * 表里查不到的词原样留着（宁愿露一个英文 id，也不把一个不认识的词改成别的意思）。
 *
 * `label` 由调用方给——概念词表（引擎 goal_concepts 的逆映射）在报告页里，
 * 只有一份，不在这里再抄。约定：认不出就返回传进去的那个 id 本身。
 */
export function humanizeEngineText(text: string, label: (id: string) => string): string {
  return text
    .replace(/\bL([1-4])\b/g, (_m, d: string) => `第 ${d} 档`)
    .replace(/\b[a-z][a-z0-9_]*\b/g, (word) => {
      const mapped = LEARNER_TYPE_LABEL[word] ?? RISK_LABEL[word] ?? label(word);
      return mapped === word ? word : mapped;
    });
}

export interface WhyInput {
  profile: LearnerProfileFields;
  bp: LearnerBlueprint;
  /**
   * 薄弱概念，**已由调用方换成中文名**。页面上那张概念词表（CONCEPT_META）是引擎
   * goal_concepts 的逆映射，只有一份，不在这里再抄一份。
   */
  weakConcepts: string[];
  /** 这门课的名字；没有课时不传，相关条目自动不出。 */
  courseName?: string;
  /**
   * 引擎自由文本的人话化钩子（页面传 `humanizeEngineText` + 它那份概念词表）。
   * 不传就原样出——纯逻辑单测不需要词表。
   */
  humanize?: (text: string) => string;
}

export function whyThisCourse({
  profile,
  bp,
  weakConcepts,
  courseName,
  humanize = (s) => s,
}: WhyInput): AttributedDifference[] {
  const out: AttributedDifference[] = [];
  const mix = bp.blueprint?.resource_mix ?? null;
  const prog = profile.programming_level;
  const py = profile.python_level;

  // 1) 讲解姿态与难度 ← 编程/Agent/工程自评
  const tier = TIER_TEXT[presentationTier(NO_BLUEPRINT, profile)];
  const recRank = bp.recommended_difficulty ? levelRank(bp.recommended_difficulty) : null;
  out.push({
    dimension: '难度与讲解姿态',
    observation:
      `这门课按「${tier.name}」的姿态写：${tier.teaching}` +
      (recRank ? `；内容难度定在${levelText(recRank)}。` : '。'),
    because: [
      typeof prog === 'number' ? `编程自评 ${prog}/4` : '',
      typeof profile.agent_level === 'number' ? `Agent 自评 ${profile.agent_level}/4` : '',
      typeof profile.engineering_level === 'number' ? `工程自评 ${profile.engineering_level}/4` : '',
      recRank ? `学情诊断给的推荐难度${levelText(recRank)}` : '',
    ].filter(Boolean),
  });

  // 2) 例子取材 ← 培训领域 + 身份（姿态决定类比的"质地"，领域决定题材）
  if (mix?.analogy_domain) {
    out.push({
      dimension: '例子取材',
      observation: `例子取自${humanize(mix.analogy_domain)}，类比用${tier.analogy}。`,
      because: [
        `培训领域「${domainLabel(profile.domain)}」`,
        profile.role ? `身份自述「${trimStop(profile.role)}」` : '',
        `讲解姿态「${tier.name}」`,
      ].filter(Boolean),
    });
  }

  // 3) 补基础的小节 ← 掌握度不到线的概念
  //    不写「测验」：没做过前测时掌握度是从画像分值推的
  //    （引擎 orchestration/workflow.py 走 estimate_pretest_from_profile）。
  if (weakConcepts.length > 0) {
    out.push({
      dimension: '补基础的小节',
      observation:
        `${weakConcepts.slice(0, 4).join('、')} 这 ${weakConcepts.length} 个概念的掌握度不到线，` +
        `${courseName ? `「${courseName}」` : '这门课'}按它们的优先级插了补基础的小节。`,
      because: [`学情诊断标记的薄弱概念 ${weakConcepts.length} 个`],
    });
  }

  // 4) 篇幅与代码配比 ← Python 基础
  if (mix) {
    const effects: string[] = [];
    if (typeof mix.code_example_count === 'number') {
      effects.push(`每节代码示例 ${mix.code_example_count} 个`);
    }
    if (typeof mix.diagram_count === 'number') effects.push(`示意图 ${mix.diagram_count} 个`);
    if (mix.section_length_band) effects.push(`每节篇幅 ${mix.section_length_band} 字`);
    if (effects.length > 0) {
      out.push({
        dimension: '篇幅与代码配比',
        observation: `${effects.join('，')}。`,
        because: [
          typeof py === 'number' ? `Python 自评 ${py}/4` : '',
          profile.learning_preference ? `学习偏好「${trimStop(profile.learning_preference)}」` : '',
        ].filter(Boolean),
      });
    }
  }

  // 5) 讲法 ← 内容策略第一条
  const strategy = bp.blueprint?.content_strategy?.[0];
  if (strategy) {
    out.push({
      dimension: '讲法',
      observation: `讲法定在「${trimStop(humanize(strategy))}」。`,
      because: [
        bp.blueprint?.learner_type
          ? `学情诊断判定的学习者类型「${learnerTypeLabel(bp.blueprint.learner_type)}」`
          : '',
        profile.learning_preference ? `学习偏好「${trimStop(profile.learning_preference)}」` : '',
      ].filter(Boolean),
    });
  }

  // 6) 测验难度带
  const bandText = levelBandText(mix?.quiz_difficulty_band ?? []);
  if (bandText) {
    out.push({
      dimension: '测验难度',
      observation: `测验题落在${bandText}。`,
      because: [`学情诊断给的测验难度带`, typeof prog === 'number' ? `编程自评 ${prog}/4` : ''].filter(
        Boolean,
      ),
    });
  }

  // 7) 参考资料读哪个库（确定性，不依赖引擎）
  const corpus = corpusOf(profile);
  if (corpus) {
    out.push({
      dimension: '参考资料',
      observation: `正文引用的教材片段来自「${domainLabel(corpus)}」。`,
      because: [profile.corpus ? '你在画像里选定的知识库' : '没单独选库，跟随培训领域'],
    });
  }

  return out;
}
