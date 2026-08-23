/**
 * 测验题的机械门禁：能用代码判的判据不发模型调用。
 *
 * 同一条依据支撑 `adaptation-lint`：纯提示式自评找不出自己的错
 * （Kamoi TACL 2024 / Tyen et al. 2311.08516），模型强在「改」不在「找」。
 * 出题这边的错更机械——答案位置扎堆、正确项最长、以上都对、干扰项重复——
 * 全是代码一眼能判的。
 *
 * ## 两类处理，分得很清
 *
 * **能确定性修好的就修**，不回问模型：答案位置扎堆用轮转选项修（模型的 C 偏置
 * 是训练分布带来的，叫它「随机化」没用，实测叫了照旧）。
 *
 * **修不了的报出来**：正确项最长、干扰项没有对应误解——这些要改内容，
 * 代码改不了，只能记违规让上游看见。**不静默丢题**：一道有瑕疵的题
 * 比没有题强，丢题会让一屏空掉。唯一例外是死题（答案不在选项里），
 * 那个上游已经丢了。
 */
import type { QuizQuestion, QuizOption } from '@openmaic/dsl';

export interface ItemViolation {
  questionId: string;
  ruleId: string;
  message: string;
}

/** 「以上都对」这类元选项：不考知识，只考应试技巧。 */
const META_OPTION =
  /^(?:以上(?:都|全)?(?:对|正确|错|不对|不正确|均是|皆是)|都对|都不对|all of the above|none of the above)/i;

/** 绝对词干扰项：学习者被训练成一律排除，与内容无关。 */
const ABSOLUTE_TERM = /(?:总是|永远|绝不|从不|一定|必然|所有情况下|always|never)/;

/** 单选题的选项数上下限。3 选项与 4 选项质量无差异，凑不出好干扰项就出 3 个。 */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

/** 正确项相对最短项的长度上限倍数。超了就是「最长的那个是答案」的应试线索。 */
const LONGEST_ANSWER_RATIO = 2.5;

const isChoice = (q: QuizQuestion): boolean => q.type === 'single' || q.type === 'multiple';

/**
 * 逐题查。返回违规清单，**不改题**——修复归 `rebalanceAnswerPositions`。
 */
export function checkItem(q: QuizQuestion): ItemViolation[] {
  const out: ItemViolation[] = [];
  const bad = (ruleId: string, message: string) => out.push({ questionId: q.id, ruleId, message });

  if (!q.question || q.question.trim().length < 8) {
    bad('STEM-TOO-SHORT', `题干过短（${q.question?.trim().length ?? 0} 字），说不清要问什么`);
  }
  if (!q.analysis || !q.analysis.trim()) {
    bad('NO-ANALYSIS', '没有解析：答完看不到为什么，这道题只剩计分功能');
  }
  if (!isChoice(q)) return out;

  const options = q.options ?? [];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    bad('OPTION-COUNT', `选项 ${options.length} 个，超出 ${MIN_OPTIONS}-${MAX_OPTIONS}`);
  }

  const labels = options.map((o) => o.label.trim());
  if (new Set(labels).size !== labels.length) {
    bad('DUPLICATE-OPTION', '有两个选项文字相同');
  }
  for (const label of labels) {
    if (META_OPTION.test(label)) {
      bad('META-OPTION', `「${label.slice(0, 20)}」考的是应试技巧不是知识点`);
      break;
    }
  }

  const answers = new Set(q.answer ?? []);
  const wrong = options.filter((o) => !answers.has(o.value));
  const right = options.filter((o) => answers.has(o.value));

  for (const o of wrong) {
    if (ABSOLUTE_TERM.test(o.label)) {
      bad('ABSOLUTE-DISTRACTOR', `干扰项「${o.label.slice(0, 20)}」带绝对词，学习者一律排除`);
      break;
    }
  }

  const missing = wrong.filter((o) => !o.misconception?.trim());
  if (missing.length) {
    bad(
      'NO-MISCONCEPTION',
      `${missing.length} 个干扰项没写对应误解——说不出谁会这么想的干扰项没人会选`,
    );
  }

  if (right.length && wrong.length) {
    const len = (o: QuizOption) => o.label.trim().length;
    const shortest = Math.min(...options.map(len));
    const longestRight = Math.max(...right.map(len));
    if (shortest > 0 && longestRight / shortest > LONGEST_ANSWER_RATIO) {
      bad(
        'ANSWER-LONGEST',
        `正确项 ${longestRight} 字、最短项 ${shortest} 字，长度本身就在指路`,
      );
    }
  }
  return out;
}

/** 一组题里正确答案落在各位置的次数。 */
export function answerPositions(questions: readonly QuizQuestion[]): number[] {
  const counts: number[] = [];
  for (const q of questions) {
    if (q.type !== 'single' || !q.options?.length) continue;
    const idx = q.options.findIndex((o) => o.value === q.answer?.[0]);
    if (idx < 0) continue;
    counts[idx] = (counts[idx] ?? 0) + 1;
    for (let i = 0; i < q.options.length; i++) counts[i] ??= 0;
  }
  return counts;
}

/**
 * 轮转单选题的选项，把正确答案摊到各个位置。
 *
 * LLM 出题偏 C（训练分布带来的，不是提示词能劝住的——提示里写「随机化位置」
 * 实测照旧扎堆）。学习者两三题就摸出规律，后面全蒙 C。
 *
 * 确定性做法：按题序轮转目标位置 0,1,2,…，把正确项挪到目标位，其余顺次填。
 * 不引入随机数——同一门课重跑要出同一份卷子，随机会让复现和对照实验失效。
 *
 * **跳过的题**：选项文字里引用了别的选项字母（「同 A」「除 B 外」）——
 * 挪了位置那句话就错了。多选题也跳过（没有单一位置可摊）。
 */
export function rebalanceAnswerPositions(questions: readonly QuizQuestion[]): QuizQuestion[] {
  let seq = 0;
  return questions.map((q) => {
    if (q.type !== 'single' || !q.options?.length || !q.answer?.length) return q;
    const options = q.options;
    if (options.some((o) => /(?:^|[^A-Za-z])(?:同|除|与)\s*[A-E]\b/.test(o.label))) return q;

    const rightIdx = options.findIndex((o) => o.value === q.answer![0]);
    if (rightIdx < 0) return q;

    const target = seq++ % options.length;
    if (target === rightIdx) return q;

    // 把正确项抽出来插到目标位，其余保持相对顺序
    const rest = options.filter((_, i) => i !== rightIdx);
    const reordered = [...rest.slice(0, target), options[rightIdx], ...rest.slice(target)];
    // value 是位置键（A/B/C/D），跟着位置重排；label 跟着内容走
    const relabeled = reordered.map((o, i) => ({ ...o, value: String.fromCharCode(65 + i) }));
    return { ...q, options: relabeled, answer: [String.fromCharCode(65 + target)] };
  });
}

/** 一次过：先摊位置，再查剩下的违规。 */
export function gateQuiz(questions: readonly QuizQuestion[]): {
  questions: QuizQuestion[];
  violations: ItemViolation[];
} {
  const balanced = rebalanceAnswerPositions(questions);
  return { questions: balanced, violations: balanced.flatMap(checkItem) };
}
