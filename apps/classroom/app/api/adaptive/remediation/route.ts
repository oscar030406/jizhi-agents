/**
 * Remediation planner — the executable end of the feedback-decision loop.
 *
 * The decision banner is decoration unless acting on it changes the classroom.
 * This turns {decision + the questions the learner just missed + learner profile}
 * into a **scene outline**: retrieval agent confirms which controlled-KB concepts
 * actually cover the gap, the diagnosis agent names the weak concepts, and both
 * are folded into `outline.description` — the same zero-schema channel the rest of
 * the graft uses.
 *
 * It deliberately stops at the outline. The caller feeds it to the existing
 * scene-content → scene-audit → scene-actions pipeline, so the remediation scene
 * is grounded, judged and gated by exactly the same machinery (and the same slide
 * DSL prompt) as every other scene. Re-implementing generation here would produce
 * worse slides that skip the gate.
 *
 * Engine offline → the outline still comes back, just ungrounded (evidenceCount 0).
 * The button never dead-ends.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchEvidence } from '@/lib/generation/evidence-grounding';
import type { LearnerBlueprint } from '@/lib/generation/learner-profile';
import { corpusOf, fetchLearnerBlueprint } from '@/lib/generation/learner-profile';
import {
  parseTier,
  pickTier,
  quizDifficultyOf,
  TIERS,
  type DifficultyTier,
} from '@/lib/quiz/item-selection';
import type { LearnerProfileFields, SceneOutline } from '@/lib/types/generation';

const log = createLogger('Remediation');

export const maxDuration = 60;

export type RemediationDecision =
  | 'downgrade_explanation'
  | 'add_practice'
  | 'advance_challenge';

const PLANS: Record<
  RemediationDecision,
  {
    type: SceneOutline['type'];
    titlePrefix: string;
    brief: string;
    keyPoints: (focus: string) => string[];
    quizConfig?: SceneOutline['quizConfig'];
  }
> = {
  downgrade_explanation: {
    type: 'slide',
    titlePrefix: '降维讲解',
    brief:
      '学习者刚在本主题的测验上失分，说明当前讲法太难。用**更低一档**的方式重讲：' +
      '先给一个日常生活里的类比把直觉建立起来，再分步拆解机制，每一步都补上前一版跳过的中间环节，' +
      '不引入新术语，不加深度。宁可讲得慢，也不要再假设学习者已经懂了前置概念。',
    keyPoints: (focus) => [
      `用生活类比重新解释「${focus}」`,
      '分步拆解，补齐上一版跳过的中间环节',
      '给一个最小可跟做的例子',
      '用一句话总结这次要记住什么',
    ],
  },
  add_practice: {
    type: 'quiz',
    titlePrefix: '针对性练习',
    brief:
      '学习者刚在本主题失分，需要**同一知识点**的再练一遍。出 2 道聚焦练习，' +
      '难度略低于刚才那套，只考失分处涉及的那一个点，不要扩展到新知识。' +
      '每题的解析要指出"错在哪一步"，而不是只复述正确答案。',
    keyPoints: (focus) => [`聚焦「${focus}」的 2 道练习`, '难度下调一档', '解析指出典型错因'],
    quizConfig: { questionCount: 2, difficulty: 'easy', questionTypes: ['single', 'multiple'] },
  },
  advance_challenge: {
    type: 'quiz',
    titlePrefix: '进阶挑战',
    brief:
      '学习者已经掌握本主题，给一道**进阶挑战任务**：一道需要综合运用本主题知识的开放题，' +
      '要求说明思路而不是背结论，可以引入一个真实工程场景中的边界条件或失败模式。只出 1 道。',
    keyPoints: (focus) => [`基于「${focus}」的综合应用题`, '要求说明推理过程', '引入真实场景的边界条件'],
    quizConfig: { questionCount: 1, difficulty: 'hard', questionTypes: ['text'] },
  },
};

/**
 * 按学习者当前水平选补救测验的难度档。
 *
 * 原来 `PLANS` 把难度写死成 `add_practice→easy`、`advance_challenge→hard`——
 * 对一个已经很强的人，「再练一遍」出 easy 是浪费；对一个刚被判定要降维讲解的人，
 * 「进阶挑战」出 hard 是把他按在墙上。档位该跟着人走。
 *
 * ## 为什么不是直接用 MFI 的结果覆盖
 *
 * `pickTier` 给的是「现在考他、信息量最大的那一档」，那是**测量**的最优。
 * 但补救有教学意图：`add_practice` 的 brief 自己写着「难度略低于刚才那套」，
 * `advance_challenge` 写着「进阶」。直接用 MFI 覆盖会跟这两句话打架。
 *
 * 所以口径是**锚点 + 相对位移**：MFI 定锚（这个人现在在哪一档），
 * 决策定方向（再练降一档、进阶升一档）。两个信号各管各的，谁也不吃掉谁。
 *
 * ## 不编默认值
 *
 * 一条掌握度都没有时**返回 null**，调用方保留 `PLANS` 里那个写死的档。
 * 没有数据就承认没有，不拿 0.5 当「中等水平」——那是编的。
 */
function adaptiveDifficulty(
  decision: RemediationDecision,
  profile: LearnerProfileFields | undefined,
  blueprint: LearnerBlueprint | null,
): { difficulty: 'easy' | 'medium' | 'hard'; because: string } | null {
  // 两个来源都是真数据，优先画像自己那份——它直接来自这个人的作答履历
  // （`deriveProfileFields` 从证据账本折出来的），比引擎诊断更贴近当下。
  const fromProfile = Object.values(profile?.conceptMastery ?? {});
  const fromEngine = Object.values(blueprint?.mastery_vector ?? {});
  const source = fromProfile.length ? 'profile' : 'engine';
  const values = (fromProfile.length ? fromProfile : fromEngine).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (values.length === 0) return null;

  // 取整体均值，不按本屏主题取。`conceptMastery` 的键是概念名，跨域同名会撞、
  // 与这一屏的主题也对不上——学情报告的下一步面板里记着同一件事，
  // 拿它当主题级判据会静默算出一份看着合理的错结论。当「这个人大概什么水平」用，
  // 这一层它站得住。
  const mastery = values.reduce((a, b) => a + b, 0) / values.length;

  // 画像给的难度带是硬边界：带外的档不该被选中，哪怕它信息量更高。
  const band = (blueprint?.blueprint?.resource_mix?.quiz_difficulty_band ?? [])
    .map((raw) => parseTier(raw))
    .filter((t): t is DifficultyTier => t !== null);

  const anchor = pickTier(mastery, { allowed: band });
  const shift = decision === 'add_practice' ? -1 : decision === 'advance_challenge' ? 1 : 0;
  const pool = band.length ? TIERS.filter((t) => band.includes(t)) : TIERS;
  const at = pool.indexOf(anchor.tier);
  // 位移后落在带内；带只有一档时位移无处可去，就停在锚点——
  // 那是画像自己定的边界，不许越过去。
  const shifted = pool[Math.min(pool.length - 1, Math.max(0, at + shift))] ?? anchor.tier;

  return {
    difficulty: quizDifficultyOf(shifted),
    because:
      `掌握度均值 ${mastery.toFixed(2)}（${values.length} 个概念，来源 ${source}）→ ` +
      `信息量最大档 ${anchor.tier}，按「${decision}」位移 ${shift > 0 ? '+1' : shift < 0 ? '-1' : '0'} → ${shifted}` +
      (band.length ? `，画像难度带 ${band.join('/')}` : '，画像未给难度带'),
  };
}

/**
 * 测验场景标题里的通用套话。23 门课的测验场景标题实测（`data/classrooms/*.json`）：
 * 9 门直接叫「知识检查」，另有「知识检测」「综合知识检查」「知识巩固测试」「核心概念巩固」
 * 「课程总结测验」「阶段一知识检测」「知识小测试」——这些词一个字的知识点都不带。
 * 剩下 8 门是「套话 + 分隔符 + 知识点」或「知识点 + 套话」的组合：
 * 「知识检查：调用路径与参数」「矩阵乘法知识检查」「LLM 能力知识检查」。
 * 把套话剥掉，剩下的就是这场测验真正考的那个点。
 */
const QUIZ_BOILERPLATE =
  /核心概念巩固|阶段[一二三四五六七八九十\d]*|课程总结|知识巩固|知识检查点|知识检查|知识检测|知识小?测验|知识小?测试|综合|随堂|课堂|练习|小?测验|小?测试|检测|检查|测验|测试/g;

/** 剥完套话后残留的分隔符与空白：「知识检查 - 评测榜单」剥完剩「 - 评测榜单」。 */
const LEFTOVER_EDGE = /^[\s\-—–:：·、,，.。/|]+|[\s\-—–:：·、,，.。/|]+$/g;

/**
 * 补救场景的「焦点」——标题和 keyPoint 都用它，会上侧栏、会进录屏。
 *
 * 原来直接取锚点测验的场景标题，于是 9 门课的补救 outline 标题成了「降维讲解：知识检查」、
 * keyPoint 成了「用生活类比重新解释「知识检查」」——学习者看到的是一句空话。
 *
 * 取值顺序：测验标题剥掉套话后的知识点 → 课程标题 → 原标题兜底。
 * **不从题干里切短语**：中文题干按标点切出来的是「在自注意力机制中」这种半句话；
 * 引擎侧的 `matched_concepts` / `weak_concepts` 又是 `llm_basics`、`rag` 这类内部代号，
 * 更不能上屏。题干原文另有去处——它整条进 description 供生成时定位，不进标题。
 */
function pickFocus(sceneTitle: string, courseTitle: string): string {
  const stripped = sceneTitle.replace(QUIZ_BOILERPLATE, '').replace(LEFTOVER_EDGE, '');
  if (stripped.length >= 2) return stripped;
  return courseTitle || sceneTitle;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      decision?: string;
      sceneTitle?: string;
      courseTitle?: string;
      /** Stems of the questions the learner actually got wrong — real data, never invented. */
      missedPoints?: string[];
      /** 跨会话错题史：此前交卷漏掉过的要点（证据账本），客户端已与本次去重。 */
      historicalMissedPoints?: string[];
      learnerProfile?: LearnerProfileFields;
      order?: number;
    };

    const plan = PLANS[body.decision as RemediationDecision];
    if (!plan) {
      return apiError('INVALID_REQUEST', 400, `Unsupported remediation decision: ${body.decision}`);
    }
    const sceneTitle = (body.sceneTitle || '').trim() || '本节测验';
    const courseTitle = (body.courseTitle || '').trim();
    const missedPoints = (body.missedPoints ?? []).filter((s) => typeof s === 'string').slice(0, 5);
    const historicalMissed = (body.historicalMissedPoints ?? [])
      .filter((s) => typeof s === 'string')
      .slice(0, 5);

    // Both bridges degrade to null; neither is required to produce an outline.
    const [evidence, blueprint] = await Promise.all([
      // 补救场景与正课同一本书：这里原来一个语料参数都不传，补救内容永远接地在
      // 默认（ai）语料上，与刚讲完的那门课可能不是同一个知识库。
      fetchEvidence(
        `${courseTitle} ${sceneTitle} ${missedPoints.join(' ')}`.trim(),
        corpusOf(body.learnerProfile),
      ),
      body.learnerProfile
        ? fetchLearnerBlueprint(courseTitle || sceneTitle, body.learnerProfile)
        : Promise.resolve(null),
    ]);
    // The blueprint's weak concepts are *profile-wide* skill gaps, not this
    // scene's topic — they stay as background context in the description and
    // never become the remediation's subject. The subject is what the learner
    // just failed: this scene.
    const weakConcepts = blueprint?.weak_concepts?.slice(0, 4) ?? [];

    const description = [
      plan.brief,
      missedPoints.length > 0
        ? `\n学习者刚答错的题目（据此定位薄弱处，不要照抄题面）：\n${missedPoints
            .map((p, i) => `${i + 1}. ${p}`)
            .join('\n')}`
        : '',
      historicalMissed.length > 0
        ? `\n此前学习中反复漏掉的要点（跨会话错题史，优先覆盖但不要复述原题）：\n${historicalMissed
            .map((p, i) => `${i + 1}. ${p}`)
            .join('\n')}`
        : '',
      weakConcepts.length > 0
        ? `\n学情诊断给出的整体薄弱概念（背景参考，不要跑题过去）：${weakConcepts.join('、')}`
        : '',
      evidence && evidence.matchedConcepts.length > 0
        ? `\n受控知识库覆盖到的相关概念：${evidence.matchedConcepts.join('、')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const focus = pickFocus(sceneTitle, courseTitle);

    // 难度档跟着人走，不再写死。拿不到掌握度就返回 null，保留 PLANS 里那个档——
    // 没有数据就承认没有，不编一个「中等水平」出来。
    const adaptive = plan.quizConfig
      ? adaptiveDifficulty(body.decision as RemediationDecision, body.learnerProfile, blueprint)
      : null;
    const quizConfig = plan.quizConfig
      ? { ...plan.quizConfig, ...(adaptive ? { difficulty: adaptive.difficulty } : {}) }
      : undefined;

    const outline: SceneOutline = {
      id: `remediation_${body.decision}_${Date.now()}`,
      type: plan.type,
      title: `${plan.titlePrefix}：${focus}`,
      description,
      keyPoints: plan.keyPoints(focus),
      order: typeof body.order === 'number' && body.order > 0 ? body.order : 1,
      ...(quizConfig ? { quizConfig } : {}),
    };

    log.info(
      `Planned ${body.decision} for "${sceneTitle}" → focus "${focus}" — evidence=${evidence?.chunks.length ?? 0} weak=[${weakConcepts.join(',')}]` +
        (adaptive
          ? ` 难度自适应：${adaptive.because}`
          : plan.quizConfig
            ? ` 难度沿用预设 ${plan.quizConfig.difficulty}（掌握度一条都没有，不推断）`
            : ''),
    );

    return apiSuccess({
      outline,
      evidenceCount: evidence?.chunks.length ?? 0,
      weakConcepts,
      // 难度是怎么定的，随响应返回——界面上要说得出「为什么给你出这一档」，
      // 而不是让人对着一个档位猜。没有掌握度时这一格为 null，同样是可对质的答案。
      difficultyBecause: adaptive?.because ?? null,
    });
  } catch (error) {
    log.error('Remediation planning failed:', error);
    return apiError('INTERNAL_ERROR', 500, '补救内容规划失败');
  }
}
