'use client';

/**
 * 画像影响预览：还没开始生成，先看这份画像会把课改成什么样。
 *
 * **只读确定性字段**——`lib/generation/learner-profile.ts` 里那几个纯函数
 * （`presentationTier` / `excerptCodeLineCap` / `beginnerCodeFormOnly` / `corpusOf`）
 * 就是生成时真正跑的那几个，同一份代码同一条判据。零 LLM、零请求、零等待，
 * 换一档立刻变。
 *
 * **刻意不预览的**（这些要调引擎的学情诊断 Agent 才算得出来，本地没有）：
 * 薄弱概念清单、代码示例个数、示意图个数、每节篇幅字数、测验难度带。
 * 为了预览好看去调一次模型，就不再是「秒变」了；照着经验编一个更糟。
 * 它们在生成完成后的学情报告「你的课为什么长这样」里有真值。
 */

import {
  beginnerCodeFormOnly,
  corpusOf,
  excerptCodeLineCap,
  presentationTier,
  type LearnerBlueprint,
} from '@/lib/generation/learner-profile';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import type { LearnerProfileFields } from '@/lib/types/generation';

/**
 * `presentationTier(bp, profile)` 只在画像缺 `programming_level` 时才回退去读
 * 引擎推荐档。预览里这个字段总是有值（DEFAULT_LEARNER_PROFILE 给了 1，
 * 下拉也只能选到 0–4），所以这里传一份空蓝图占位，不是在假装有诊断结果。
 */
export const NO_BLUEPRINT: LearnerBlueprint = {
  mastery_vector: {},
  weak_concepts: [],
  recommended_difficulty: '',
  learning_risks: [],
  diagnosis_summary: '',
  blueprint: null,
};

/**
 * 三档讲解姿态的人话。
 *
 * `name` 与 `lib/generation/adaptation-lint.ts` 的 `TIER_LABEL` 逐字同源
 * （那份没导出，抄字符串比为了三个短语去改别人的模块划算）；
 * `teaching` / `analogy` 是 `blueprintDirective` 里对应档的硬要求原文压缩成一句，
 * 不是这里新编的口径。
 */
export const TIER_TEXT: Record<
  'L1' | 'L2' | 'L3',
  { name: string; teaching: string; analogy: string }
> = {
  L1: {
    name: '零基础（不会编程）',
    teaching: '术语第一次出现就用大白话解释，一段最多两个新词，公式前先给无公式的直觉',
    analogy: '排队、做菜、找书这类日常场景',
  },
  L2: {
    name: '转行者（会编程、无 AI 背景）',
    teaching: '不解释变量函数，但每个 AI 术语都紧跟一句大白话定义，一个都不裸用',
    analogy: '接口、缓存、流水线、索引这类工程经验',
  },
  L3: {
    name: '进阶（有实战经验）',
    teaching: '术语直接用，不下定义、不做铺垫，直接进机制、公式与工程取舍',
    analogy: '吞吐、显存、线上退化这类生产场景',
  },
};

const DIM_LABEL: Array<{ key: keyof LearnerProfileFields; label: string }> = [
  { key: 'programming_level', label: '编程' },
  { key: 'python_level', label: 'Python' },
  { key: 'agent_level', label: 'Agent' },
  { key: 'rag_level', label: 'RAG' },
  { key: 'engineering_level', label: '工程' },
];

export interface ImpactRow {
  label: string;
  value: string;
  /** 这条结论是从画像哪个字段来的 */
  because: string;
}

/**
 * 画像 → 这门课会怎么变。纯函数，同一份画像永远给同一个结果。
 */
export function profileImpact(profile: LearnerProfileFields): ImpactRow[] {
  const tier = presentationTier(NO_BLUEPRINT, profile);
  const t = TIER_TEXT[tier];
  const prog = profile.programming_level ?? 0;
  const agent = profile.agent_level ?? 0;
  const eng = profile.engineering_level ?? 0;

  const codeCap = excerptCodeLineCap(profile);
  const codeValue =
    codeCap > 0
      ? `极短（不超过 ${codeCap} 行）、每行配大白话注释` +
        (beginnerCodeFormOnly(profile) ? '；参考资料里带 import／函数定义／类定义的片段会被挡掉' : '')
      : tier === 'L3'
        ? '贴生产形态的完整实现，不做逐行注释'
        : '常规多行、可带库调用，但每块代码配一段讲清意图与输入输出的说明';

  // 「先补哪块」只说画像里读得出来的事实：哪几维自评落在最低两档。
  // 真正的薄弱概念清单要引擎诊断才有，不在这里编。
  const weakDims = DIM_LABEL.filter(({ key }) => ((profile[key] as number) ?? 0) <= 1).map(
    (d) => d.label,
  );

  const corpus = corpusOf(profile);

  return [
    {
      label: '讲解姿态',
      value: `${t.name} — ${t.teaching}`,
      because: `编程自评 ${prog}/4、Agent ${agent}/4、工程 ${eng}/4`,
    },
    {
      label: '例子取自',
      value: `${t.analogy}；主题背景取「${domainLabel(profile.domain)}」`,
      because: `讲解姿态 + 培训领域「${domainLabel(profile.domain)}」`,
    },
    {
      label: '代码怎么写',
      value: codeValue,
      because: codeCap > 0 ? `编程自评 ${prog}/4（最低两档）` : `编程自评 ${prog}/4`,
    },
    {
      label: '先补哪块',
      value:
        weakDims.length > 0
          ? `${weakDims.join('、')} 这 ${weakDims.length} 块自评最低，学情诊断会优先从这里找缺口`
          : '五维自评都在两档以上，不预设补基础方向，由学情诊断按学习目标定',
      because: '五维经历自陈里落在最低两档的维度',
    },
    {
      label: '参考资料读',
      value: domainLabel(corpus),
      because: profile.corpus ? '你选定的知识库' : '没单独选库，跟随培训领域',
    },
  ];
}

/** 弹层里的预览块。展示用，逻辑全在 `profileImpact`。 */
export function ProfileImpactPreview({ profile }: { profile: LearnerProfileFields }) {
  const rows = profileImpact(profile);
  return (
    <div className="space-y-1.5 rounded-lg border border-blue-deep/20 bg-blue-soft/40 p-2.5">
      <p className="text-[11px] font-medium text-blue-deep">
        这份画像会把课改成这样（改一项立刻更新）
      </p>
      <dl className="space-y-1" data-testid="profile-impact">
        {rows.map((r) => (
          <div key={r.label} className="text-[11px] leading-relaxed">
            <dt className="inline font-medium text-foreground">{r.label}：</dt>
            <dd className="inline text-muted-foreground">{r.value}</dd>
            <span className="ml-1 text-[10px] text-muted-foreground/80">（依据：{r.because}）</span>
          </div>
        ))}
      </dl>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        以上都是画像直接算出来的，不调模型。薄弱概念、代码示例与示意图个数、每节篇幅、
        测验难度带要生成时由学情诊断给，在生成完的学情报告里看。
      </p>
    </div>
  );
}
