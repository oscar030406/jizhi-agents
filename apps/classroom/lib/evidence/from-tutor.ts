/**
 * 导学判分轮 → 证据草稿。纯函数。
 *
 * ## 为什么这条比 quiz 那条强
 *
 * quiz 只能给场景级测项、整卷判定摊过去（`item-level` 降级，见 `./from-quiz.ts`）。
 * 导学不一样：
 *
 * - **测项是概念级的**——引擎回传 `profile_evidence.concept`
 * - **判定是针对这个概念出的**——`LECTURE_GRADE_SYSTEM` 的判据是「每条判分要点的核心
 *   意思都被覆盖 = correct，明确漏掉至少一条 = partial，答非所问 = incorrect」，
 *   判的就是这一个概念，不是一张卷子
 *
 * 所以这里落 `per-kc`，**不是降级**。设计稿 §4.4 说的「判官对多知识点题逐测项出结论」，
 * 导学天然满足——它一次只问一个概念。
 *
 * ## because 怎么填：只填知道的
 *
 * 引擎的 `because` 是散文式的逐条判分依据（「命中了哪个要点、漏掉了哪个要点」），
 * 机器切不开。`expected_points` 是结构化的要点清单。所以按裁决映射，**不猜**：
 *
 * ```
 * correct    → hit = 全部要点，missed = []      判据是「每条要点都被覆盖」
 * incorrect  → hit = [],       missed = 全部要点 判据是「答非所问或与讲义矛盾」
 * partial    → hit = [],       missed = 全部要点 只知道「漏掉至少一条」，不知道哪条
 * ```
 *
 * partial 那行是**有意低估**：设计稿 §4.4 的教训是答错时不能伪造归因——
 * 合取语义下答对无歧义，答错只说明「至少有一个没过」。把不知道的算成命中是高估，
 * 高估比低估危险（它会让掌握度虚高，然后跳过本该复习的内容）。
 * 真要分得开，得让引擎逐要点回传命中标记，那是上游改动。
 */

import { LEGACY_DOMAIN, isRemediationScene } from './types';
import type { EvidenceDraft, EvidenceVerdict, Measured, Outcome } from './types';
import { resolveConcept } from './scene-concepts';

/** 判分轮里构造证据需要的字段。取 `LectureTutorTurn` 的子集，不依赖整个类型。 */
export interface TutorTurnBrief {
  mode: string;
  verdict: '' | 'correct' | 'partial' | 'incorrect';
  expected_points?: string[];
  mastery_estimate?: number;
  /** 引擎回传的概念级证据。有它就用它当测项。 */
  profile_evidence?: {
    concept: string;
    verdict: string;
    confidence: number;
    /** 这道题用到第几级提示。≥2 说明答案有一部分是提示喂出来的。 */
    hints_used?: number;
    /** 压档前的原始判分。非空即表示这条证据被提示代价压过——留痕用，不重复计罚。 */
    raw_verdict?: string;
  } | null;
  engine?: string;
}

export interface TutorEvidenceInput {
  learnerKey: string;
  /** 哪次交互。一轮问答一个 id。 */
  interactionId: string;
  /** 哪份资源：讲义所属场景。 */
  sceneId: string;
  /** 测项兜底：引擎没回传 concept 时用场景标题。 */
  sceneTitle: string;
  /**
   * 领域。同 `./from-quiz`：调用方从画像取（`profile-bridge.ts` 的 `learnerDomain()`），
   * 缺省值 {@link LEGACY_DOMAIN} 只是历史数据的兜底。
   */
  domain?: string;
  turn: TutorTurnBrief;
  at: string;
  priorEncounters?: number;
  sinceLastMs?: number;
  /** 本轮作答耗时。 */
  elapsedMs?: number;
}

/** `mastery_estimate` 缺席时由裁决映射的分值。 */
const SCORE_BY_OUTCOME: Record<Outcome, number> = {
  correct: 1,
  partial: 0.5,
  incorrect: 0,
};

function becauseOf(
  outcome: Outcome,
  points: readonly string[],
  evidence: TutorTurnBrief['profile_evidence'],
): EvidenceVerdict['because'] {
  const all = [...points];
  // 用过提示就在依据里明写一句。压档本身发生在引擎侧、这里不重算，
  // 但**履历上要看得见**：不写的话，一条被压成 incorrect 的证据和一条真答错的
  // 长得一模一样，回头复盘分不出「不会」还是「看了答案」。
  const hints = evidence?.hints_used ?? 0;
  const note =
    hints > 0
      ? [
          hints >= 3
            ? `本题看了兜底答案（第 ${hints} 级提示）`
            : `本题用到第 ${hints} 级提示`,
          ...(evidence?.raw_verdict && evidence.raw_verdict !== outcome
            ? [`原始判分 ${evidence.raw_verdict}，按提示代价压到 ${outcome}`]
            : []),
        ]
      : [];
  // partial 与 incorrect 同样处理：只知道有漏，不知道哪条命中。见文件头的说明。
  const base = outcome === 'correct' ? { hit: all, missed: [] } : { hit: [], missed: all };
  return note.length ? { ...base, note } : base;
}

/**
 * 构造一轮导学判分的证据草稿。
 *
 * 返回 `null` 的三种情况都不是证据：出题轮（`mode !== 'verdict'`）、
 * 引擎降级没判成（`verdict` 为空）、以及没有测项可挂。硬造只会把噪声写进履历。
 */
export function tutorEvidenceDraft(input: TutorEvidenceInput): EvidenceDraft | null {
  const { turn } = input;
  if (turn.mode !== 'verdict') return null;
  if (turn.verdict !== 'correct' && turn.verdict !== 'partial' && turn.verdict !== 'incorrect') {
    return null;
  }
  // 三级优先：引擎判词直接给的概念 > 场景引用推出来的 > 场景标题。
  // 中间那一级是本轮补的：原来引擎没给概念就直接退到标题，于是同一个知识点上的
  // 导学证据与测验证据落在两个键上，永远不合流（图纸 §十 偏差 8）。
  const resolved = resolveConcept({
    engineConcept: turn.profile_evidence?.concept,
    sceneId: input.sceneId,
    sceneTitle: input.sceneTitle,
  });
  if (!resolved) return null;
  const concept = resolved.concept;

  const outcome: Outcome = turn.verdict;
  const measured: Measured = {
    kind: 'concept',
    domain: input.domain ?? LEGACY_DOMAIN,
    concept,
  };
  const score =
    typeof turn.mastery_estimate === 'number' && turn.mastery_estimate >= 0
      ? Math.min(1, turn.mastery_estimate)
      : SCORE_BY_OUTCOME[outcome];

  return {
    learnerKey: input.learnerKey,
    source: {
      interactionId: input.interactionId,
      resourceId: input.sceneId,
      at: input.at,
    },
    items: [
      {
        measured,
        // 判定放在 item 层 → createEvidence 记 per-kc。这是实话：判官判的就是这个概念。
        verdict: {
          outcome,
          score,
          because: becauseOf(outcome, turn.expected_points ?? [], turn.profile_evidence ?? null),
        },
        context: {
          encounter: (input.priorEncounters ?? 0) + 1,
          // 在讲评场景上做的导学问答，测的是订正后的理解，记 review。
          modality: isRemediationScene(input.sceneId) ? 'review' : 'tutor',
          ...(input.sinceLastMs != null ? { sinceLastMs: input.sinceLastMs } : {}),
          ...(input.elapsedMs != null ? { elapsedMs: input.elapsedMs } : {}),
          // 提示痕迹。引擎已经把顶层 verdict 与 mastery_estimate 压过档，
          // 上面的 outcome/score 用的就是压后那份——这里只把「怎么来的」记全，
          // 不再打第二次折（重复惩罚会让对外指标口径失真）。
          ...(turn.profile_evidence?.hints_used
            ? { hintsUsed: turn.profile_evidence.hints_used }
            : {}),
        },
      },
    ],
  };
}
