/**
 * Learner profile → generation directive.
 *
 * The second seam of the 李代桃僵 graft (the first is evidence grounding).
 * A lightweight profile collected in the UI is sent to the multi-agent engine's
 * diagnosis agent, which returns a *computed* plan — mastery vector, weak
 * concepts, recommended difficulty and a resource-mix (scaffold depth, widget /
 * code-example quotas, analogy domain, section length, quiz difficulty band) —
 * each item carrying a because-chain back to a profile dimension.
 *
 * That plan is folded into the outline/scene prompts through the same
 * description-append channel evidence uses: zero schema intrusion, and any
 * failure degrades silently to ungrounded generation.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('Learner Profile');

// 8s 在引擎并发忙时（skill-map 冷启/多课并行）会误判失联，探针批实测 54 组盲跑 6 组。
// 蓝图缺失的代价（整场景无个性化）远大于多等十几秒，放宽到 25s。
const FETCH_TIMEOUT_MS = 25_000;

/** Five-dimension self-assessment, 0–4 each. Semantics mirror the engine's rubric. */
export interface LearnerProfileInput {
  /** 领域：ai | manufacturing | industrial-internet | software (scenario coverage) */
  domain?: string;
  /**
   * 检索用的知识库名。不填就跟着 `domain` 走（旧行为逐字节不变）。
   *
   * 为什么不复用 `domain`：`domain` 同时是蓝图提示词里的「培训领域」、证据账本
   * `Measured.domain` 的分桶键和类比取材域，而语料库现在叫 `odoo` / `iotdb` ——
   * 把它们塞进同一个字段，就得对学习者说「你的培训领域是 odoo」。两件事分开，
   * 换库不动画像语义。
   */
  corpus?: string;
  /** 学历背景：high_school | college | bachelor | master | other */
  education?: string;
  /** 身份/来路，e.g. 在校学生 / 后端开发转型 / 企业新员工转岗 */
  role?: string;
  programming_level?: number;
  python_level?: number;
  agent_level?: number;
  rag_level?: number;
  engineering_level?: number;
  /** 学习偏好自述，驱动呈现配比（不驱动内容深度） */
  learning_preference?: string;
  time_budget_hours?: number;
  /** 动态层：quiz 决策写回的当前难度（L1-L4） */
  currentDifficulty?: string;
  /** 动态层：逐概念掌握度（键=场景标题或概念 id，0-1，EMA 累积） */
  conceptMastery?: Record<string, number>;
  /** 动态层：Elo 能力评级（组卷难度自适应用），无则由画像映射冷启动 */
  eloRating?: number;
}

export interface ResourceMix {
  scaffold_level: string;
  visual_widget_count: number;
  diagram_count: number;
  code_example_count: number;
  analogy_domain: string;
  section_length_band: string;
  quiz_difficulty_band: string[];
  rationale: string[];
}

export interface LearnerBlueprint {
  /** 谁做的诊断：llm=真协同决策；deterministic=规则降级。UI 按此如实标注。 */
  engine?: string;
  mastery_vector: Record<string, number>;
  weak_concepts: string[];
  recommended_difficulty: string;
  learning_risks: string[];
  diagnosis_summary: string;
  blueprint: {
    refined_goal: string;
    learner_type: string;
    /**
     * `current_mastery` / `target_mastery` / `priority` are present on the live
     * engine payload (backend/schemas/learner.py SkillGap) but optional here so
     * older cached blueprints still parse.
     */
    skill_gaps: Array<{
      concept: string;
      gap: number;
      reason: string;
      current_mastery?: number;
      target_mastery?: number;
      priority?: number;
    }>;
    content_strategy: string[];
    practice_strategy: string[];
    assessment_strategy: string[];
    resource_mix: ResourceMix | null;
  } | null;
}

const EDUCATION_LABEL: Record<string, string> = {
  high_school: '高中/中专',
  college: '专科',
  bachelor: '本科',
  master: '硕士及以上',
  other: '其他',
};

// 领域/语料显示名的真源在 `lib/knowledge/domain-labels.ts`（原先这里、报告页、
// 生成入口各抄一份，且都缺实际接入的语料库）。这里只做转出，老调用点不用改 import。
import { domainLabel } from '@/lib/knowledge/domain-labels';
export { domainLabel };

/**
 * 这次检索该读哪个语料库：显式选的库优先，没选就沿用培训领域（旧行为）。
 *
 * 全链只此一处口径——检索、摘录咬合打分、判官对照必须同源。此前判官那一路根本
 * 没拿到这个值（客户端 `fetchSceneAudit` 从来不发画像），于是换库生成的课
 * 由 ai 语料的判官来评，正文与对照资料不是同一本书。
 */
export function corpusOf(profile?: { corpus?: string; domain?: string }): string | undefined {
  return profile?.corpus?.trim() || profile?.domain;
}

/** Ask the engine's diagnosis agent for a plan. Null on any failure — never blocks generation. */
export async function fetchLearnerBlueprint(
  learningGoal: string,
  profile: LearnerProfileInput,
  // 只在「配置了但调用真失败」时回调；未配置不算。用于车间面板红行显式告警。
  onFailure?: (message: string) => void,
): Promise<LearnerBlueprint | null> {
  const base = process.env.GROUNDING_URL;
  if (!base) return null;
  try {
    const background = [
      profile.role,
      profile.education ? EDUCATION_LABEL[profile.education] : '',
      profile.domain ? `目标领域：${domainLabel(profile.domain)}` : '',
    ]
      .filter(Boolean)
      .join('；');

    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/blueprint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({
        learning_goal: learningGoal,
        background,
        programming_level: profile.programming_level ?? 1,
        python_level: profile.python_level ?? 1,
        agent_level: profile.agent_level ?? 1,
        rag_level: profile.rag_level ?? 1,
        engineering_level: profile.engineering_level ?? 1,
        learning_preference: profile.learning_preference || '可运行示例与分步练习',
        time_budget_hours: profile.time_budget_hours ?? 24,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!resp.ok) {
      onFailure?.(`学情诊断桥返回 HTTP ${resp.status}`);
      return null;
    }
    const payload = (await resp.json()) as { data?: LearnerBlueprint };
    return payload.data ?? null;
  } catch (err) {
    log.warn(`Blueprint fetch failed (falling back to generic generation): ${String(err)}`);
    onFailure?.(`学情诊断桥不可达（${err instanceof Error ? err.name : 'error'}）`);
    return null;
  }
}

const SCAFFOLD_DIRECTIVE: Record<string, string> = {
  full:
    '完整支架（加）：每个机制必须配一个完整分步例题——用真实数字走一遍手算过程，不跳步骤；' +
    '每段正文前加一句逐段导读，告诉学习者这段在讲什么、看完要能回答什么。',
  faded:
    '渐进支架（半撤）：例题给一半留一半——前半步骤写全（含数字），后半只留步骤名，让学习者自己补全；' +
    '不写逐段导读，只在难读处标一句读法要点（如「先看分母再看分子」）。',
  minimal:
    '主动撤支架（删）：不写导读、不放完整例题，直接给问题与机制差异点、边界条件、失败模式，提示按需给。' +
    '对该学习者，冗长铺垫是认知负荷不是帮助（expertise reversal），禁止为保险堆解释——写了铺垫就是错。',
};

/**
 * 讲解姿态档：由画像的前置假设直接决定，不随主题难度上限压平。
 * 判据与难度档公认定义同源——看「假设读者会什么」：
 * 不会编程 → L1；会编程但无 AI 背景 → L2；有 Agent/RAG 实战或资深工程 → L3。
 * 画像缺维度时退回引擎推荐档（老行为）。
 */
export function presentationTier(bp: LearnerBlueprint, profile: LearnerProfileInput): 'L1' | 'L2' | 'L3' {
  const prog = profile.programming_level;
  if (typeof prog !== 'number') {
    const rec = bp.recommended_difficulty;
    return rec === 'L1' ? 'L1' : rec === 'L2' ? 'L2' : 'L3';
  }
  if (prog <= 1) return 'L1';
  const agent = profile.agent_level ?? 0;
  const eng = profile.engineering_level ?? 0;
  if (agent >= 3 || (prog >= 4 && eng >= 3)) return 'L3';
  return 'L2';
}

/**
 * 摘录难度上限：与姿态档同源（画像前置假设），给证据检索的 max_difficulty 用。
 * 零基础放行到 L2（纯 L1 语料太薄）、转行放行到 L3、进阶不设限。
 * 画像缺维度不设限（保持旧行为）。
 */
export function excerptDifficultyCap(profile: LearnerProfileInput): string {
  const prog = profile.programming_level;
  if (typeof prog !== 'number') return '';
  if (prog <= 1) return 'L2';
  const agent = profile.agent_level ?? 0;
  const eng = profile.engineering_level ?? 0;
  if (agent >= 3 || (prog >= 4 && eng >= 3)) return '';
  return 'L3';
}

/**
 * 摘录代码形态上限：最长代码块的行数，给证据检索的 max_code_lines 用。0 = 不设限。
 *
 * 难度档管不住代码长度——b1-tool-calling 命中的 ha04s01#s2 是 L1 档语料，却带
 * 21 行无注释的生产级 class（import/typing/raise 齐全），判官据此把零基础资源
 * 判成 transition。自撰区的代码归 lint 管；摘录区 prompt 明令原样保留、lint 改不动。
 *
 * 5 行不是拍的：与零基础硬要求里「极短（≤5 行）」同一个数（见 blueprintDirective
 * 的 L1 分支），对齐的是难度档公认定义。代价实测可接受——L1+L2 候选池 626 块里
 * 404 块（64.5%）最长代码块 ≤5 行，且引擎侧「无合规替代就保底一块」兜底还在，
 * 不会因为过滤严把学习者推进零证据裸生成。
 *
 * 只对 L1 设限：转行档硬要求本就写着「代码示例常规使用（可多行/带库调用）」，
 * 现有 13 例 miss 里也没有一例把 transition/advanced 的摘录代码判为问题。
 */
export function excerptCodeLineCap(profile: LearnerProfileInput): number {
  const prog = profile.programming_level;
  if (typeof prog !== 'number') return 0;
  return prog <= 1 ? 5 : 0;
}

/**
 * 零基础档再加一道**结构**闸：摘录里不许出现 import / def / class / 装饰器。
 *
 * 长度管不住结构——2026-08-13 以零基础视角实测，学习者拿到的摘录是
 * `import numpy` + `def query(...)` + `np.array(...)`，行数没超 5 行上限，
 * 形态整段超纲，配的解释还在说「关注 argsort 排序步骤」。
 *
 * 判据不是我们拍的，是从真实教材量出来的（`scripts/experiments/textbook_code_ladder.py`）：
 *
 * | 档 | 外部锚 | 行中位 | import | def | class |
 * |---|---|---|---|---|---|
 * | L1 | 蟒蛇书 1-6 章（129 文件） | 4 | **0%** | **0%** | **0%** |
 * | L2 | 蟒蛇书全书（563 文件） | 10 | 57% | 31% | 25% |
 * | L3 | 鱼书 / 从零构建大模型 | 125-140 | 95%+ | 84%+ | 33-61% |
 *
 * 教材作者已经替我们回答了「学到哪一步该见什么代码」：入门段那三种结构一次都不出现。
 * 只对 L1 设这道闸——L2 的自然形态本来就有 import 和 def，卡它等于不让人学。
 */
export function beginnerCodeFormOnly(profile: LearnerProfileInput): boolean {
  const prog = profile.programming_level;
  return typeof prog === 'number' && prog <= 1;
}

/**
 * Render the plan as a prompt directive. Kept as prose (not JSON) because it is
 * appended to a human-readable outline description that the generator reads.
 */
export function blueprintDirective(bp: LearnerBlueprint, profile: LearnerProfileInput): string {
  const mix = bp.blueprint?.resource_mix;
  const lines: string[] = [
    `\n\n【学习者画像 · 由学情诊断 Agent 计算，必须遵守】`,
    `- 培训领域：${domainLabel(profile.domain)}`,
    `- 学习者类型：${bp.blueprint?.learner_type ?? '未知'}；推荐难度档：${bp.recommended_difficulty}`,
    `- 薄弱概念（要重点补）：${bp.weak_concepts.slice(0, 4).join('、') || '无'}`,
  ];
  if (profile.education) lines.push(`- 学历背景：${EDUCATION_LABEL[profile.education] ?? profile.education}`);
  if (profile.role) lines.push(`- 身份/来路：${profile.role}`);

  // 分档特征硬要求（2026-08-10，适配评测 2A 首测 44.4% 的定向修复）：
  // 首测发现零基础画像的资源被判官一致判为更高档——支架指令让篇幅变厚了，
  // 但「术语先定义/例子生活化/前置假设为零」这些可观察的分档特征没落实。
  // 这里按推荐难度档写成硬要求（特征清单与教育测量的难度档共识一致，
  // 也与评测 rubric 同源——对齐的是「难度档」的公认定义，不是背答案）。
  //
  // 姿态档与内容难度解耦（2A 复测 t/a 双档 61% 的定向修复）：
  // recommended_difficulty 会被目标难度上限压平——入门主题把进阶学习者压回 L2，
  // 讲解姿态跟着变软。对读者的前置假设由画像本身决定；内容选型（测验带/配比）
  // 仍走 recommended_difficulty，不动。
  const tier = presentationTier(bp, profile);
  if (tier === 'L1') {
    lines.push(
      `- 【零基础硬要求】每个专业术语第一次出现必须立刻用一句大白话定义，不许裸用；`,
      `- 【零基础硬要求】单个段落新术语不超过 2 个——宁可多分几段慢慢讲，不许术语连发；`,
      `- 【零基础硬要求】主要例子取自日常生活（排队/做菜/找书这类），不用技术域例子起手；`,
      `- 【零基础硬要求】代码只放学习者当前读得懂的水平：极短（≤5 行）、每行配大白话注释、` +
        `不引入本课没讲过的语法或库；做不到就用文字描述流程代替代码。教编程本身的课除外——` +
        `但同样只用已讲过的语法逐步递进；`,
      `- 【零基础硬要求】不假设学习者会高等数学——公式出现前，先给一段无公式的直觉解释。`,
    );
  } else if (tier === 'L2') {
    lines.push(
      `- 【转行者硬要求】前置假设：读者会编程、没有任何 AI 背景，全文按这个假设写——` +
        `不解释什么是变量/函数/API；`,
      `- 【转行者硬要求】每个 AI 领域术语（注意力、KV 缓存、embedding、梯度这类）第一次出现` +
        `必须紧跟一句大白话定义，一个都不许裸用——术语裸用即写错档，这是与进阶档的分界线；`,
      `- 【转行者硬要求】每段正文至少落一个工程直觉类比（接口/缓存/流水线/索引/数据库），` +
        `把新概念挂到读者已会的工程经验上；不用做菜排队找书这类日常场景类比；`,
      `- 【转行者硬要求】代码示例常规使用（可多行/带库调用），但每块代码必须配一段块级说明` +
        `讲清意图与输入输出——只贴代码不解释是进阶姿态，逐行手把手注释是零基础姿态，都不要；`,
      `- 【转行者硬要求】不写鼓励性语句；也不假设读者见过任何论文、训练框架或线上生产环境——` +
        `出现「熟悉的 transformer 结构」「如你在生产中所见」这类默认背景的表述即写错档。`,
    );
  } else if (tier === 'L3' || tier === 'L4') {
    lines.push(
      `- 【进阶硬要求】术语直接使用不再定义；直接进机制、公式与工程取舍的讨论；`,
      `- 【进阶硬要求】代码贴生产形态（完整实现，不做手把手注释）；`,
      `- 【进阶硬要求】例子贴生产场景（吞吐/显存/线上退化）；`,
      `- 【进阶硬要求】以下任何一条出现即视为写错档，必须改掉：给基础术语下定义、` +
        `逐行注释、生活化类比、鼓励性语句（「别担心」「让我们一步步来」这类）。`,
    );
  }

  if (mix) {
    lines.push(
      `- 讲解深度：${SCAFFOLD_DIRECTIVE[mix.scaffold_level] ?? mix.scaffold_level}`,
      // 类比域是软约束，不是硬锁。硬锁版本（「一律取自 X，不要用其他领域的比喻」）
      // 实测把「什么是注意力机制」整节课带进了 default.yaml 覆盖与日志排错，
      // 而同题面上游无画像通道时自己选了咖啡馆/多人聊天。见
      // docs/03-design/openmaic_quality_gap_diagnosis.md R1。
      // 兴趣情境化本身有证据（personalization_research.md §2.1），错的是"一律"。
      //
      // 同时删掉了原来的「每屏正文控制在 {section_length_band} 字」：那个字数带
      // 来自引擎 resource_generation_agent 的 markdown 讲义正文口径，被直接搬来约束
      // PPT 单屏，量级根本不是一回事；实测走过画像路径的页面字数低于下限，
      // 说明模型也没当回事。篇幅应由 slide-content 模板自己管。
      `- 类比与举例优先取自「${mix.analogy_domain}」；` +
        `该领域没有贴切类比时，改用面向所有人都成立的日常生活场景，不要强行套用。`,
      `- 代码示例约 ${mix.code_example_count} 个；示意图/结构图约 ${mix.diagram_count} 个`,
      `- 测验题难度落在 ${mix.quiz_difficulty_band.join('/')} 档`,
    );
  }

  // 检索练习（practice testing，g=0.61）+ 间隔（317 实验）：学习科学里证据最硬的
  // 两条，落法是组卷规则——测验掺 1-2 道往期薄弱主题的复现题，逼学习者从记忆里
  // 取一次。薄弱 = 画像动态层里概念分 <0.6 的场景（quiz 决策同一条线）。
  const weakPast = Object.entries(profile.conceptMastery ?? {})
    .filter(([, v]) => typeof v === 'number' && v < 0.6)
    .sort(([, a], [, b]) => (a as number) - (b as number))
    .slice(0, 2)
    .map(([k]) => k);
  if (weakPast.length > 0) {
    lines.push(
      `- 本课测验须额外包含 ${weakPast.length} 道**往期薄弱主题的复现题**（主题：${weakPast.join('、')}），` +
        `题干场景要换新的，考点保持原主题——检验是否真会了，不是检验记没记住原题。`,
    );
  }
  if (bp.blueprint?.content_strategy?.length) {
    lines.push(`- 内容策略：${bp.blueprint.content_strategy.slice(0, 3).join('；')}`);
  }
  lines.push(
    `注意：以上只改变讲法、深度与举例领域，**不得改变任何知识事实**；事实仍以参考资料为准。`,
  );
  return lines.join('\n');
}
