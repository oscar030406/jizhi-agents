/**
 * 测验题机械门禁。
 *
 * 能用代码判的判据不发模型调用；能确定性修的就修，修不了的报出来。
 * 最要紧的一条是答案位置：LLM 出题偏 C 是训练分布带来的，提示里写
 * 「随机化位置」劝不住，只能代码轮转。
 */
import { describe, expect, it } from 'vitest';

import {
  answerPositions,
  checkItem,
  gateQuiz,
  rebalanceAnswerPositions,
} from '@/lib/quiz/item-gate';
import type { QuizQuestion } from '@openmaic/dsl';

const q = (over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: 'q1',
  type: 'single',
  question: '循环监视时间的默认值是多少？',
  options: [
    { label: '50ms', value: 'A', misconception: '把最小扫描周期当上限' },
    { label: '100ms', value: 'B', misconception: '记成了整百的那个数' },
    { label: '150ms', value: 'C' },
  ],
  answer: ['C'],
  analysis: '出厂默认 150ms。',
  ...over,
});

describe('逐题机械检查', () => {
  it('干净的题不报', () => {
    expect(checkItem(q())).toEqual([]);
  });

  it('干扰项没写对应误解要报', () => {
    const bad = q({
      options: [
        { label: '50ms', value: 'A' },
        { label: '100ms', value: 'B' },
        { label: '150ms', value: 'C' },
      ],
    });
    expect(checkItem(bad).map((v) => v.ruleId)).toContain('NO-MISCONCEPTION');
  });

  it('以上都对要报', () => {
    const bad = q({
      options: [
        { label: '50ms', value: 'A', misconception: 'x' },
        { label: '150ms', value: 'B', misconception: 'y' },
        { label: '以上都对', value: 'C' },
      ],
    });
    expect(checkItem(bad).map((v) => v.ruleId)).toContain('META-OPTION');
  });

  it('绝对词干扰项要报', () => {
    const bad = q({
      options: [
        { label: '超时永远不会触发停机', value: 'A', misconception: '以为只是告警' },
        { label: '150ms', value: 'C' },
      ],
      answer: ['C'],
    });
    expect(checkItem(bad).map((v) => v.ruleId)).toContain('ABSOLUTE-DISTRACTOR');
  });

  it('正确项明显最长要报——长度本身在指路', () => {
    const bad = q({
      options: [
        { label: '50ms', value: 'A', misconception: 'x' },
        { label: '100ms', value: 'B', misconception: 'y' },
        { label: '出厂默认 150ms，可在参数页按任务实际耗时上调或下调', value: 'C' },
      ],
    });
    expect(checkItem(bad).map((v) => v.ruleId)).toContain('ANSWER-LONGEST');
  });

  it('三选项不算违规——凑不出好干扰项就出三个', () => {
    expect(checkItem(q()).map((v) => v.ruleId)).not.toContain('OPTION-COUNT');
  });

  it('缺解析要报', () => {
    expect(checkItem(q({ analysis: '' })).map((v) => v.ruleId)).toContain('NO-ANALYSIS');
  });
});

describe('答案位置轮转', () => {
  const five = Array.from({ length: 6 }, (_, i) =>
    q({ id: `q${i}`, answer: ['C'] }),
  );

  it('全挤在 C 的一组被摊开', () => {
    expect(answerPositions(five)).toEqual([0, 0, 6]);
    const after = answerPositions(rebalanceAnswerPositions(five));
    expect(after).toEqual([2, 2, 2]);
  });

  it('选项内容跟着位置走，答案键仍指向同一句话', () => {
    const [first] = rebalanceAnswerPositions([q({ answer: ['C'] })]);
    const picked = first.options!.find((o) => o.value === first.answer![0]);
    expect(picked?.label).toBe('150ms');
  });

  it('确定性——同一份输入两次跑出同一份卷子', () => {
    expect(rebalanceAnswerPositions(five)).toEqual(rebalanceAnswerPositions(five));
  });

  it('选项引用了别的字母就不动它', () => {
    const cross = q({
      options: [
        { label: '50ms', value: 'A', misconception: 'x' },
        { label: '同 A，但只在高速模式下', value: 'B', misconception: 'y' },
        { label: '150ms', value: 'C' },
      ],
    });
    expect(rebalanceAnswerPositions([cross])[0]).toEqual(cross);
  });

  it('多选题不动', () => {
    const multi = q({ type: 'multiple', answer: ['A', 'C'] });
    expect(rebalanceAnswerPositions([multi])[0]).toEqual(multi);
  });
});

describe('门禁一次过', () => {
  it('先摊位置再查违规，不丢题', () => {
    const input = [q({ id: 'a' }), q({ id: 'b', analysis: '' })];
    const out = gateQuiz(input);
    expect(out.questions).toHaveLength(2); // 有瑕疵也不丢
    expect(out.violations.map((v) => v.questionId)).toEqual(['b']);
  });
});
