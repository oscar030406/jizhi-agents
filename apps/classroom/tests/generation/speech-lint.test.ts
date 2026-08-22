import { describe, expect, it } from 'vitest';

import { emdashQuota, lintCourseSpeech, EMDASH_PER_K_MAX } from '@/lib/generation/speech-lint';

/**
 * 口播 lint。判据全部来自 2026-08-13 对已落库 23 门课 557 条口播的实测
 * （见 lib/generation/speech-lint.ts 头注与 docs/05-evidence/textbook-prose-ladder-20260813.md）。
 *
 * 用例里的反例句子直接取自真实落库数据，不是我编的。
 */

const seg = (sceneIndex: number, text: string, sceneTitle = `第${sceneIndex}节`) => ({
  sceneIndex,
  sceneTitle,
  text,
});

const ids = (list: ReturnType<typeof lintCourseSpeech>) => list.map((v) => v.ruleId);

describe('开头雷同 —— 实测最严重的一条', () => {
  it('两条口播开头六字相同就报', () => {
    const v = lintCourseSpeech([
      seg(1, '这一节的核心是缩放因子，读推导时留意方差那一步。'),
      seg(2, '这一节的核心是位置编码，注意它和词向量怎么相加。'),
    ]);
    expect(ids(v)).toContain('SPEECH-SAME-OPENING');
    expect(v[0].quote).toBe('这一节的核心');
    expect(v[0].value).toBe(2);
  });

  it('报文里点出是哪几页，方便定位', () => {
    const v = lintCourseSpeech([
      seg(3, '读这一节时，注意批大小对显存的影响。'),
      seg(7, '读这一节时，注意学习率的衰减节奏。'),
    ]);
    expect(v[0].message).toContain('第 3、7 页');
  });

  it('开头不同就不报——「核心」与「关键」是两句话', () => {
    const v = lintCourseSpeech([
      seg(1, '这一节的核心是缩放因子。'),
      seg(2, '这一节的关键是位置编码。'),
    ]);
    expect(ids(v)).not.toContain('SPEECH-SAME-OPENING');
  });

  it('前置引号不影响判重', () => {
    const v = lintCourseSpeech([seg(1, '「先看这个数字，它决定了后面全部推导。'), seg(2, '先看这个数字，换成 0.9 会怎样。')]);
    expect(ids(v)).toContain('SPEECH-SAME-OPENING');
  });
});

describe('开场白只许第一条', () => {
  it('第一条问好不报', () => {
    const v = lintCourseSpeech([seg(1, '大家好，欢迎来到本课程。'), seg(2, '先看第二段那组数字。')]);
    expect(ids(v)).not.toContain('SPEECH-GREETING');
  });

  it('中途再问好就报——实测 23 门课每门都在开场用同一句', () => {
    const v = lintCourseSpeech([seg(1, '先看第一段。'), seg(2, '大家好，欢迎进入第二节。')]);
    expect(ids(v)).toContain('SPEECH-GREETING');
  });
});

describe('破折号密度（判据来自教材实测）', () => {
  it('阈值就是教材观测上界上取整', () => {
    expect(EMDASH_PER_K_MAX).toBe(0.5);
  });

  it('短课至少给一个配额——密度判据在 800 字上会变成全禁，那不是语料支持的结论', () => {
    expect(emdashQuota(830)).toBe(1);
    expect(emdashQuota(4000)).toBe(2);
  });

  it('超了就报，报文带实测数与出处', () => {
    // 40 个汉字里两个破折号 = 50/千字，远超 0.5
    const v = lintCourseSpeech([seg(1, '批大小决定显存占用——这一点在训练时最先撞上——所以先算它。')]);
    const hit = v.find((x) => x.ruleId === 'SPEECH-EMDASH');
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain('0.07–0.44');
  });

  it('偶尔一个不报——不是禁用破折号', () => {
    const v = lintCourseSpeech([seg(1, '批大小决定显存占用，这一点在训练时最先撞上——先算它。')]);
    expect(ids(v)).not.toContain('SPEECH-EMDASH');
  });

  it('实测那种密度会报：557 条口播里 91 个破折号', () => {
    const v = lintCourseSpeech([
      seg(1, '批大小决定显存——训练时最先撞上——所以先算它——这是硬约束。'),
    ]);
    expect(ids(v)).toContain('SPEECH-EMDASH');
  });
});

describe('AI 味词（教材零命中词表）', () => {
  it('抓「盯住」——实测 59 次、覆盖 20/23 门课，根因是提示词示例里写了它', () => {
    const v = lintCourseSpeech([seg(1, '读代码时盯住 get_lr 函数的三个阶段。')]);
    expect(ids(v)).toContain('SPEECH-AI-TELL');
    expect(v.find((x) => x.ruleId === 'SPEECH-AI-TELL')!.quote).toBe('盯住');
  });

  it('教材自己在用的词不抓', () => {
    const v = lintCourseSpeech([seg(1, '想象一下，假如面前有五个物品，你会先看哪个。')]);
    expect(ids(v)).not.toContain('SPEECH-AI-TELL');
  });
});

describe('问号密度', () => {
  it('一段两个问号就报', () => {
    const v = lintCourseSpeech([seg(1, '把学习率调到 10 会怎样？那调到 0.001 呢？')]);
    expect(ids(v)).toContain('SPEECH-QUESTION-FLOOD');
  });

  it('一问不报——检查理解本来就要问', () => {
    const v = lintCourseSpeech([seg(1, '把学习率从 1e-4 调到 1e-5，第 3 段那组损失会怎么变？')]);
    expect(ids(v)).not.toContain('SPEECH-QUESTION-FLOOD');
  });
});

describe('干净的一门课零违规', () => {
  it('开头各不相同、只问一次好、不用禁词', () => {
    const v = lintCourseSpeech([
      seg(1, '大家好。这门课从一条真实的检索链路开始。'),
      seg(2, '先看第二段那组召回数字，它决定后面所有取舍。'),
      seg(3, '把切块大小从 500 降到 50，召回率会掉到多少？'),
      seg(4, '前面算过的那个阈值，在这一节会被重新用一次。'),
    ]);
    expect(v).toEqual([]);
  });

  it('空输入不炸', () => {
    expect(lintCourseSpeech([])).toEqual([]);
  });
});
