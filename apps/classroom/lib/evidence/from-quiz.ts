/**
 * 交卷结果 → 证据草稿。纯函数，不碰 store、不碰画像。
 *
 * ## 为什么现在只能接到这个粒度
 *
 * `lib/quiz/grading.ts` 的 TODO 已经把欠账列清楚了：`QuizQuestion` 没有知识点字段，
 * 题目粒度挂不上概念。设计稿 §4.3 给的正解是「资源覆盖的知识点是**导出量**——
 * 由引用的 chunk 反推教材节的知识成分」，而那条路要等词表和前置图（管理者那条路的产物）。
 *
 * 在那之前，诚实能给的最细粒度是**场景级**：一个 quiz 场景一个主题，用场景标题当概念键。
 * 这与 `quiz-view` 现在写 `conceptScores` 的口径一致，不新造第二套。
 *
 * 由此这条证据的 `verdictScope` 必然是 `item-level`：它不是判官逐知识点出的结论，
 * 是整卷成绩摊到这一个测项上。**降级是允许的，静默降级不是**——
 * `downgraded(ledger)` 查得到它，权重函数按 item-level 打折，答辩时说得清。
 *
 * ## 现在就接的理由
 *
 * 履历只能从开始记的那天起攒。等词表齐了再接，中间这段时间的轨迹就永远是空的，
 * 学情时间轴上只会有一个点。先接粗粒度的，细粒度就位后新证据自然变成 `per-kc`，
 * 旧证据留在账本里不需要迁移——这正是「证据只追加、永不丢弃」的用处。
 */

import type { QuestionResult } from '@/lib/quiz/grading';
import { LEGACY_DOMAIN, isRemediationScene } from './types';
import type { ErrorKind, EvidenceDraft, EvidenceVerdict, Measured, Outcome } from './types';
import { resolveConcept } from './scene-concepts';

/** 一道题在构造证据时需要的最少信息。 */
export interface QuizQuestionBrief {
  id: string;
  /** 题干。进 because 的要点摘要，会截断。 */
  prompt: string;
  points?: number;
}

export interface QuizEvidenceInput {
  learnerKey: string;
  /** 哪次交互。交卷记录的 id；拿不到就用 attemptId。 */
  interactionId: string;
  /** 哪份资源：场景 id。 */
  sceneId: string;
  /** 场景标题——当前唯一能当概念键的东西。 */
  sceneTitle: string;
  /**
   * 领域。画像的专业面按域分（fold 的 `byDomain`）。调用方从画像取——
   * `profile-bridge.ts` 的 `learnerDomain()`。缺省值 {@link LEGACY_DOMAIN} 是
   * **历史数据的兜底**（旧证据一律写死 'ai'），不是新证据该走的路。
   */
  domain?: string;
  questions: ReadonlyArray<QuizQuestionBrief>;
  results: ReadonlyArray<QuestionResult>;
  at: string;
  /** 该测项此前已有多少条证据。调用方从账本读，纯函数不自己查。 */
  priorEncounters?: number;
  /** 距上次遇到该测项多久（ms）。首次省略。 */
  sinceLastMs?: number;
  /** 整卷耗时。题级耗时上游没采集，只能给整卷的。 */
  elapsedMs?: number;
}

/** 要点摘要的截断长度。太长会把账本撑爆，太短看不出是哪道题。 */
const POINT_SUMMARY_CHARS = 40;

function summarize(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > POINT_SUMMARY_CHARS ? `${flat.slice(0, POINT_SUMMARY_CHARS)}…` : flat;
}

/**
 * 卷面得分 → 结论。三分带与设计稿 §5.3 的阈值同源，但**这里只决定 outcome 的字面**，
 * 真正影响画像的是 `score` 这个连续量，不是这三个词。
 */
function outcomeOf(score: number): Outcome {
  if (score >= 0.8) return 'correct';
  if (score >= 0.4) return 'partial';
  return 'incorrect';
}

/**
 * 判定的 because。选择题的「命中/漏掉哪些要点」其实一直算得出——
 * `grading.ts` 的 TODO 原话是「多选题其实算得出（选了什么 vs 答案键），只是没人算」。
 * 这里按题算：答对的题进 hit，答错的进 missed，各自用题干摘要标识。
 */
function becauseOf(
  questions: ReadonlyArray<QuizQuestionBrief>,
  results: ReadonlyArray<QuestionResult>,
): EvidenceVerdict['because'] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const hit: string[] = [];
  const missed: string[] = [];
  for (const r of results) {
    const q = byId.get(r.questionId);
    const label = q ? summarize(q.prompt) : r.questionId;
    (r.status === 'correct' ? hit : missed).push(label);
  }
  return { hit, missed };
}

/**
 * 错因粗分（DeepTutor classify_error 提炼）：只看答错的题——全部空答是
 * 「不知道」（metacognitive），全部答了是「会用错」（application），混着来记 mixed。
 * `answered` 是新采集的字段，旧调用方不传时无法区分，返回 undefined（不编）。
 */
function errorTypeOf(results: ReadonlyArray<QuestionResult>): ErrorKind | undefined {
  const missed = results.filter((r) => r.status !== 'correct');
  if (missed.length === 0) return undefined;
  if (missed.some((r) => r.answered === undefined)) return undefined;
  const blank = missed.filter((r) => !r.answered).length;
  if (blank === missed.length) return 'metacognitive';
  if (blank === 0) return 'application';
  return 'mixed';
}

/**
 * 构造一次交卷的证据草稿。**一次交卷 = 一条证据**（一个场景一个测项）。
 *
 * 返回 `null` 表示这次交互不构成证据（没有题、或没有任何判定结果）——
 * 那种情况是信号不是证据，调用方不该硬造。
 */
export function quizEvidenceDraft(input: QuizEvidenceInput): EvidenceDraft | null {
  if (input.results.length === 0) return null;
  const title = input.sceneTitle.trim();
  if (!title) return null;

  const total = input.questions.reduce((sum, q) => sum + (q.points ?? 1), 0);
  const earned = input.results.reduce((sum, r) => sum + r.earned, 0);
  const score = total > 0 ? Math.max(0, Math.min(1, earned / total)) : 0;

  // 归拢键取知识点，不取场景标题——标题键让测验证据与导学证据永远不合流（图纸 §十 偏差 8）。
  // 映射来自场景实际引用的教材 chunk 的 concept_tags，覆盖不到时退回标题（行为与改动前一致）。
  const resolved = resolveConcept({ sceneId: input.sceneId, sceneTitle: title });
  const measured: Measured = {
    kind: 'concept',
    domain: input.domain ?? LEGACY_DOMAIN,
    concept: resolved?.concept ?? title,
  };

  return {
    learnerKey: input.learnerKey,
    source: {
      interactionId: input.interactionId,
      resourceId: input.sceneId,
      at: input.at,
    },
    // 放在 draft 层而不是 item 层——这是**有意的降级标记**：整卷判定摊到一个测项上，
    // createEvidence 会据此把 verdictScope 记成 item-level。给到 item.verdict 就成了
    // per-kc，那是撒谎：判官并没有逐知识点出过结论。
    verdict: {
      outcome: outcomeOf(score),
      score,
      ...(errorTypeOf(input.results) ? { errorType: errorTypeOf(input.results) } : {}),
      because: becauseOf(input.questions, input.results),
    },
    items: [
      {
        measured,
        context: {
          encounter: (input.priorEncounters ?? 0) + 1,
          // 讲评场景上的作答是**订正后**的表现，与首次作答不是一回事。
          // 混成同一个 modality，轨迹上就看不出「错完改对」与「一次就对」的区别。
          modality: isRemediationScene(input.sceneId) ? 'review' : 'quiz',
          ...(input.sinceLastMs != null ? { sinceLastMs: input.sinceLastMs } : {}),
          ...(input.elapsedMs != null ? { elapsedMs: input.elapsedMs } : {}),
          // 题目难度上游没有（`points` 是配分不是难度），不填。
          // 权重函数缺省按 0.5 计权，比编一个数诚实。
        },
      },
    ],
  };
}
