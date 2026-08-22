import type { QuizQuestion } from '@/lib/types/stage';

/**
 * 一道题的判定结果。它是测验唯一的持久产物（进 `QuizAttemptPayload.results`），
 * 所以也是证据流（`lib/evidence`）唯一能读到的答题事实。
 *
 * TODO(证据流)：对着 `Evidence` 的四个子盒，这里差四样东西，都不是接线能补的，
 * 缺的是上游数据：
 * 1. **测项**（`Measured`）：`QuizQuestion` 没有知识点/领域字段，题目粒度挂不上
 *    概念。现在唯一的替代是拿场景标题当概念键（见 quiz-view 的 conceptMastery
 *    写回），场景粒度且是展示文案。按设计稿 §4.3 应当由资源引用的 chunk 推导，
 *    不是让模型多写一个字段。
 * 2. **判定的 because**：只有短答题有 `aiComment`，选择题没有「命中/漏掉哪些
 *    要点」。多选题其实算得出（选了什么 vs 答案键），只是没人算。
 * 3. **情境的 elapsedMs / difficulty**：耗时只有整卷一个数（quiz-view 的
 *    `quizStartedAtRef`，用完即弃，不落盘），题目难度 `QuizQuestion` 里没有，
 *    `points` 是配分不是难度。
 * 4. **来源的 interactionId**：`recordQuizAttempt` 返回 void，调用方拿不到刚写
 *    进去的那条 record 的 id，证据挂不回具体那次交互。
 *
 * 另：交卷时采集的自报把握度（1–5）只发给了决策接口，没有落盘。
 */
export interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: 'correct' | 'incorrect';
  earned: number;
  aiComment?: string;
  /**
   * 学习者是否作答过（空答 = false）。错因分型的原料：空答是「不知道」
   * （元认知型），答了但错是「会用错」（应用型）——两者的补救方向不同
   * （前者该降档重讲，后者该加练订正）。可选，旧调用方不传不坏。
   */
  answered?: boolean;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Whether a question is graded as open text (AI) rather than by exact
 * answer-key match. Classification is by the explicit `type` only: an
 * unanswered choice question (empty `answer`) is still a choice question and
 * must not be re-routed to AI grading. `hasAnswer` does not override the type.
 */
export function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === 'short_answer';
}

/** Grade choice questions locally. Returns results only for non-short-answer questions. */
export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): QuestionResult[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = q.points ?? 1;
      const userAnswer = toArray(answers[q.id]);
      const correctAnswer = toArray(q.answer);
      const correct = arraysEqual(userAnswer, correctAnswer);
      return {
        questionId: q.id,
        correct,
        status: correct ? ('correct' as const) : ('incorrect' as const),
        earned: correct ? pts : 0,
        answered: userAnswer.length > 0,
      };
    });
}
