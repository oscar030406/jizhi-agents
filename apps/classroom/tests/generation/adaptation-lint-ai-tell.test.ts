/**
 * AI-TELL：自撰散文区的「AI 味」词闸。
 *
 * 病灶（2026-08-13 实测生成的课）：
 *   「盯住…这个核心直觉」「你就抓住了向量数据库的**命门**」
 *   「那是语义关系被数学捕捉的**魔法时刻**」「这正是向量数据库**最打动人**的地方」
 *
 * 词表不是我们挑的，是量出来的：候选词拿到 43.8 万汉字的真实中文教材里查频，
 * **出现 0 次才进表**（`apps/agent-engine/scripts/experiments/textbook_prose_ladder.py`）。
 * 这一关把 92 个候选砍掉 37 个——本文件后半段的用例钉的就是那 37 个不许被误伤。
 */

import { describe, expect, it } from 'vitest';

import { buildRewriteDirective, lintAdaptation } from '@/lib/generation/adaptation-lint';

const ids = (text: string, tier: 'L1' | 'L2' | 'L3' = 'L1') =>
  lintAdaptation(text, tier).violations.map((v) => v.ruleId);

const hits = (text: string, tier: 'L1' | 'L2' | 'L3' = 'L1') =>
  lintAdaptation(text, tier).metrics.aiTells.map((h) => h.term);

describe('AI-TELL 抓的是实测那几句', () => {
  it('命门', () => {
    expect(ids('把这一层想清楚，你就抓住了向量数据库的命门。')).toContain('AI-TELL');
  });

  it('魔法时刻', () => {
    expect(hits('那是语义关系被数学捕捉的魔法时刻。')).toContain('魔法时刻');
  });

  it('最打动人', () => {
    expect(hits('这正是向量数据库最打动人的地方。')).toContain('最打动人');
  });

  it('盯住', () => {
    expect(hits('读这一节时盯住方差那一步。')).toContain('盯住');
  });

  it('三档共用一套词表——教材在任何难度段都不写这些词', () => {
    for (const tier of ['L1', 'L2', 'L3'] as const) {
      expect(ids('这就是它的命门。', tier)).toContain('AI-TELL');
    }
  });

  it('长词优先：「魔法时刻」不会被拆成「魔法」再报一次', () => {
    // 「魔法」本身被教材救下来了（d2l 写过「这种魔法并不适用于每一层」），不在表里
    expect(hits('那是魔法时刻。')).toEqual(['魔法时刻']);
  });
});

describe('教材自己在用的词不许禁——误伤这一关', () => {
  // 逐条都能在语料里翻到原句，见 data/eval/textbook_prose_ladder.json 的 spared 列表
  const spared: Array<[string, string]> = [
    ['魔法', '不幸的是，这种魔法并不适用于每一层。'],
    ['精髓', '本系统的一部分精髓即为使用大模型预先处理文档信息。'],
    ['强大的', '云计算服务允许你使用功能更强大的计算机。'],
    ['至关重要', '深刻理解新添加的层如何提升性能变得至关重要。'],
    ['本质上', '由于注意力权重是概率分布，加权和本质上是加权平均值。'],
    ['想象一下', '想象一下，假如我们面前有五个物品。'],
    ['恭喜你', '恭喜你阅读完此文。'],
    ['体现了', '这种转变集中体现了现代深度网络的设计原则。'],
    ['里程碑', 'NLP 模型的里程碑式转变自此而始。'],
    ['无缝', '需要确保每一步工作都能无缝链接。'],
  ];
  for (const [word, sentence] of spared) {
    it(`不抓「${word}」`, () => {
      expect(ids(sentence)).not.toContain('AI-TELL');
    });
  }
});

describe('分区：只管我们自己写的字', () => {
  it('代码块里的不算——那是素材不是行文', () => {
    // t2-prompt-engineering 的真实形态：「太棒了」整句在 Python 提示词字符串里
    const text = [
      '下面是一个少样本提示的例子：',
      '',
      '```python',
      'prompt = """',
      '任务：将情感分类为正或负。',
      '示例 1：输入：这电影太棒了。输出：正',
      '"""',
      '```',
    ].join('\n');
    expect(ids(text, 'L2')).not.toContain('AI-TELL');
  });

  it('教材摘录里的不算——改写环无权动摘录', () => {
    const text = [
      '教材对此的说法是：',
      '',
      '📖 这就是整个方法的命门所在。',
      '—— 摘自《某教材 第1章》[x#1]',
      '',
      '我们接着往下看。',
    ].join('\n');
    expect(ids(text, 'L2')).not.toContain('AI-TELL');
  });

  it('摘录之外的自撰句照抓', () => {
    const text = [
      '📖 注意力机制有三个核心变量。',
      '—— 摘自《Happy-LLM 第2章》[hl02s01#s3]',
      '',
      '读到这里你就抓住了它的命门。',
    ].join('\n');
    expect(ids(text, 'L2')).toContain('AI-TELL');
  });
});

describe('干净的讲义不触发', () => {
  it('陈述句写法零命中', () => {
    const text = [
      '缩放点积注意力在 softmax 之前除以 √d_k。',
      '维度升高时点积的方差随之增大，不做缩放会把 softmax 推向饱和区，梯度趋近于零。',
      '除以 √d_k 之后方差回到 1 的量级，梯度得以保留。',
    ].join('\n');
    expect(ids(text, 'L3')).not.toContain('AI-TELL');
  });
});

describe('没有画像通道时（引擎离线）AI-TELL 仍然生效', () => {
  // 档位标记来自引擎蓝图（lib/server/classroom-generation.ts 的 fetchLearnerBlueprint）。
  // 引擎离线时 scenePlan 为 null、标记不注入。老写法在这种情况下整套 lint 一条都不跑，
  // 恰好是最需要兜底的时候。AI-TELL 与档位无关，所以它必须照跑。
  it('tier = null 时照样抓 AI 味词', () => {
    const r = lintAdaptation('把这一层想清楚，你就抓住了它的命门。', null);
    expect(r.violations.map((v) => v.ruleId)).toContain('AI-TELL');
    expect(r.a.length).toBeGreaterThan(0);
  });

  it('tier = null 时不跑分档规则——那些阈值没有目标档就没有意义', () => {
    // 这段在 L1 档下会触发 L1-TERM / L1-CODE-FORM；无档位时一条都不该出现
    const text = [
      '注意力机制的打分靠点积完成，softmax 把 logits 变成概率分布，掩码控制可见范围。',
      '',
      '```python',
      'import numpy as np',
      'v = np.array([1, 2])',
      '```',
    ].join('\n');
    const withTier = lintAdaptation(text, 'L1').violations.map((v) => v.ruleId);
    const noTier = lintAdaptation(text, null).violations.map((v) => v.ruleId);
    expect(withTier).toContain('L1-CODE-FORM');
    expect(noTier.filter((id) => id.startsWith('L1-'))).toEqual([]);
  });

  it('改写指令在无档位时不写「本页面向某某档」', () => {
    const r = lintAdaptation('那是它的命门。', null);
    const directive = buildRewriteDirective(r, '那是它的命门。');
    expect(directive).toContain('逐条改掉');
    expect(directive).not.toContain('本页面向');
  });
});
