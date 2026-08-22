/**
 * 证据模型的纯函数部分：构造不变量、证据/信号边界、序列权重。
 *
 * 用例取自真实课程 `data/classrooms/zTWuJxehpv.json`（VLA 视觉-语言-动作模型
 * 入门）的场景 id 与小节标题，不是编的。
 */
import { describe, expect, it } from 'vitest';

import {
  createEvidence,
  isEvidence,
  measuredKey,
  verdictScore,
  type Evidence,
  type EvidenceDraft,
  type Measured,
  type Signal,
} from '@/lib/evidence/types';
import {
  DEFAULT_STABILITY_MS,
  GUESS_WINDOW_MS,
  RD_MAX,
  retrievability,
  weighAll,
  weight,
  widenDeviation,
} from '@/lib/evidence/weight';

const LEARNER = 'anon:vla-test';

/** 真实课程：stage zTWuJxehpv「VLA 视觉-语言-动作模型入门」 */
const SCENE_TOKENIZATION = 'scene_CBKAJzwtsm'; // 动作 Token 化与动作分块
const SCENE_PARADIGM = 'scene_-2KR5z_Mn0'; // VLA 定义与端到端范式

const TOKENIZATION: Measured = {
  kind: 'concept',
  domain: 'embodied',
  concept: '动作 Token 化',
};
const CHUNKING: Measured = { kind: 'concept', domain: 'embodied', concept: '动作分块' };
const MATH: Measured = { kind: 'general', axis: 'math' };

/**
 * 正路：判官逐测项出结论。同一道题里「动作 Token 化」用对了、「动作分块」没提，
 * 两个 KC 拿到的是两个不同的判定——这正是本轮纠正掉「一份题级判定抄 N 份」的地方。
 */
function draft(overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    learnerKey: LEARNER,
    source: {
      interactionId: 'quiz:zTWuJxehpv:CBKAJzwtsm:1',
      resourceId: SCENE_TOKENIZATION,
      fragmentId: 'q3',
      at: '2026-08-11T09:00:00.000Z',
    },
    items: [
      {
        measured: TOKENIZATION,
        context: { encounter: 1, modality: 'quiz', difficulty: 0.4 },
        verdict: {
          outcome: 'correct',
          because: { hit: ['说清了离散化后动作变成词表条目'], missed: [] },
        },
      },
      {
        measured: CHUNKING,
        context: { encounter: 1, modality: 'quiz', difficulty: 0.7 },
        verdict: {
          outcome: 'incorrect',
          because: { hit: [], missed: ['没提动作分块降低了自回归步数'] },
        },
      },
    ],
    ...overrides,
  };
}

/** 降级路径：纯选择题只有对错，拿不到 per-KC 判定，题级判定摊给两个 KC。 */
function itemLevelDraft(outcome: 'correct' | 'incorrect' = 'incorrect'): EvidenceDraft {
  return {
    learnerKey: LEARNER,
    source: {
      interactionId: 'quiz:zTWuJxehpv:CBKAJzwtsm:mcq-2',
      resourceId: SCENE_TOKENIZATION,
      fragmentId: 'q7',
      at: '2026-08-11T09:00:00.000Z',
    },
    verdict: { outcome, because: { hit: [], missed: outcome === 'correct' ? [] : ['选了 B'] } },
    items: [
      { measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz', difficulty: 0.5 } },
      { measured: CHUNKING, context: { encounter: 1, modality: 'quiz', difficulty: 0.5 } },
    ],
  };
}

let counter = 0;
const mint = (): string => `evidence:test-${(counter += 1)}`;

function evidence(
  measured: Measured,
  at: string,
  score: number,
  extra: Partial<Evidence['context']> = {},
  interactionId = `i:${at}`,
): Evidence {
  return createEvidence(
    {
      learnerKey: LEARNER,
      source: { interactionId, resourceId: SCENE_TOKENIZATION, at },
      items: [
        {
          measured,
          context: { encounter: 1, modality: 'quiz', ...extra },
          verdict: {
            outcome: score >= 0.75 ? 'correct' : score >= 0.5 ? 'partial' : 'incorrect',
            score,
            because: { hit: [], missed: [] },
          },
        },
      ],
    },
    mint,
  )[0];
}

const day = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number): string =>
  new Date(Date.parse('2026-08-11T09:00:00.000Z') + offsetDays * day).toISOString();

describe('测项唯一性', () => {
  it('一道题挂两个知识点 → 两条证据，各自测项唯一，共享来源，判定各自独立', () => {
    const produced = createEvidence(draft(), mint);

    expect(produced).toHaveLength(2);
    expect(produced.map((e) => measuredKey(e.measured))).toEqual([
      'concept:embodied:%E5%8A%A8%E4%BD%9C%20Token%20%E5%8C%96',
      'concept:embodied:%E5%8A%A8%E4%BD%9C%E5%88%86%E5%9D%97',
    ]);
    // 共享来源
    expect(produced[0].source).toEqual(produced[1].source);
    // 判定不共享：一个 KC 用对了、另一个没有，抄同一份就是伪造归因
    expect(produced[0].verdict.outcome).toBe('correct');
    expect(produced[1].verdict.outcome).toBe('incorrect');
    expect(produced.every((e) => e.verdictScope === 'per-kc')).toBe(true);
    // 情境可不同：同一道题对两个知识点的难度不一样
    expect(produced[0].context.difficulty).toBe(0.4);
    expect(produced[1].context.difficulty).toBe(0.7);
    // id 各自独立
    expect(produced[0].id).not.toBe(produced[1].id);
  });

  it('每条证据只有一个测项——类型和实例都不允许挂一串', () => {
    for (const e of createEvidence(draft(), mint)) {
      expect(Array.isArray(e.measured)).toBe(false);
      expect(measuredKey(e.measured)).toMatch(/^(general|concept):/);
    }
  });

  it('同一次交互里重复测项 → 抛，不许在一个测项上重复计数', () => {
    expect(() =>
      createEvidence(
        draft({
          items: [
            draft().items[0],
            {
              ...draft().items[0],
              measured: { ...TOKENIZATION },
              context: { encounter: 2, modality: 'tutor' },
            },
          ],
        }),
        mint,
      ),
    ).toThrow(/重复/);
  });

  it('空 items → 抛（没有测项就不是证据）', () => {
    expect(() => createEvidence(draft({ items: [] }), mint)).toThrow(/items 为空/);
  });

  it('两头都没判定 → 抛（不许悄悄产出一条没结论的证据）', () => {
    expect(() =>
      createEvidence(
        draft({ items: [{ measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } }] }),
        mint,
      ),
    ).toThrow(/没有判定/);
  });

  it('测项键区分通用面与专业面，且带 domain 标识', () => {
    expect(measuredKey(MATH)).toBe('general:math');
    expect(measuredKey({ kind: 'concept', domain: 'ai', concept: 'RAG' })).toBe('concept:ai:RAG');
    // 换领域同名概念不撞
    expect(measuredKey({ kind: 'concept', domain: 'embodied', concept: 'RAG' })).not.toBe(
      measuredKey({ kind: 'concept', domain: 'ai', concept: 'RAG' }),
    );
    // 领域名里带冒号也不撞（分段转义）
    expect(measuredKey({ kind: 'concept', domain: 'a:b', concept: 'c' })).not.toBe(
      measuredKey({ kind: 'concept', domain: 'a', concept: 'b:c' }),
    );
  });
});

/**
 * 纠正一（2026-08-11 调研）：题级判定不能复制 N 份。
 * 拿不到 per-KC 判定时可以降级，但必须留痕、必须打折、必须查得到。
 */
describe('判定的作用域', () => {
  it('纯选择题：题级判定摊给两个 KC → 两条都标 item-level', () => {
    const produced = createEvidence(itemLevelDraft(), mint);
    expect(produced.map((e) => e.verdictScope)).toEqual(['item-level', 'item-level']);
    expect(produced[0].verdict).toEqual(produced[1].verdict);
  });

  it('混合：判官只对得上一个 KC 时，另一个降级，逐条标不同的 scope', () => {
    const mixed = createEvidence(
      {
        ...itemLevelDraft(),
        items: [
          {
            measured: TOKENIZATION,
            context: { encounter: 1, modality: 'quiz' },
            verdict: { outcome: 'correct', because: { hit: ['离散化说清了'], missed: [] } },
          },
          { measured: CHUNKING, context: { encounter: 1, modality: 'quiz' } },
        ],
      },
      mint,
    );
    expect(mixed.map((e) => e.verdictScope)).toEqual(['per-kc', 'item-level']);
  });

  it('降级证据答错时权重打折，答对时不打折（合取语义：答对无歧义，答错不知道怪谁）', () => {
    const [wrongItemLevel] = createEvidence(itemLevelDraft('incorrect'), mint);
    const [rightItemLevel] = createEvidence(itemLevelDraft('correct'), mint);
    // 同一道题、同一个判定，只把作用域换成 per-kc 作对照
    const wrongPerKc: Evidence = {
      ...wrongItemLevel,
      id: 'e:per-kc-wrong',
      verdictScope: 'per-kc',
    };
    const rightPerKc: Evidence = {
      ...rightItemLevel,
      id: 'e:per-kc-right',
      verdictScope: 'per-kc',
    };

    expect(weight(wrongItemLevel, [])).toBeCloseTo(weight(wrongPerKc, []) * 0.5, 5);
    expect(weight(rightItemLevel, [])).toBeCloseTo(weight(rightPerKc, []), 5);
  });
});

/**
 * 纠正二（2026-08-11 调研）：猜测参数挂题不挂 KC。
 * 一次交互的信息量是题级的，N 条同源证据分它，不是各拿一份。
 */
describe('同源分摊', () => {
  it('一道题挂两个 KC：两条证据各拿一半，合计等于单点题的一次', () => {
    const pair = createEvidence(itemLevelDraft('correct'), mint);
    const [single] = createEvidence(
      {
        ...itemLevelDraft('correct'),
        items: [{ measured: TOKENIZATION, context: { encounter: 1, modality: 'quiz' } }],
      },
      mint,
    );

    const each = pair.map((e) => weight(e, pair));
    expect(each[0]).toBeCloseTo(weight(single, [single]) / 2, 5);
    expect(each[0] + each[1]).toBeCloseTo(weight(single, [single]), 5);
  });

  it('分摊按题不按交互：一次提交里的三道不同题各拿整份', () => {
    // 蒙对是题级事件，所以分摊的分组键是题。三道题是三次独立的蒙对机会，
    // 按交互分摊会把每道题打成 1/3——那是把「一题多点」错用成「一次多题」。
    const one = (measured: Measured, fragmentId: string): Evidence =>
      createEvidence(
        {
          learnerKey: LEARNER,
          source: {
            interactionId: 'quiz:zTWuJxehpv:CBKAJzwtsm:submit',
            resourceId: SCENE_TOKENIZATION,
            fragmentId,
            at: iso(0),
          },
          items: [
            {
              measured,
              context: { encounter: 1, modality: 'quiz' },
              verdict: { outcome: 'correct', because: { hit: [], missed: [] } },
            },
          ],
        },
        mint,
      )[0];
    const submitted = [one(TOKENIZATION, 'q1'), one(CHUNKING, 'q2'), one(MATH, 'q3')];
    const solo = one(TOKENIZATION, 'q1');
    for (const e of submitted) {
      expect(weight(e, submitted)).toBeCloseTo(weight(solo, [solo]), 10);
    }
  });

  it('分摊只看同一次交互——别的交互的证据不参与分摊', () => {
    const pair = createEvidence(itemLevelDraft('correct'), mint);
    const elsewhere = evidence(MATH, iso(0), 1, {}, 'quiz:other:1');
    expect(weight(pair[0], [...pair, elsewhere])).toBeCloseTo(weight(pair[0], pair), 5);
  });

  it('作废掉同源的另一条，剩下那条拿回整份（weighAll 只传 live）', () => {
    const pair = createEvidence(itemLevelDraft('correct'), mint);
    const full = weighAll(pair, { invalidated: new Set([pair[1].id]) });
    expect(full).toHaveLength(1);
    expect(full[0].weight).toBeCloseTo(weight(pair[0], pair) * 2, 5);
  });
});

describe('证据与信号的边界', () => {
  it('四个子盒齐备 → 是证据', () => {
    expect(createEvidence(draft(), mint).every(isEvidence)).toBe(true);
  });

  it('页面停留时长：只有来源 → 是信号不是证据', () => {
    const signal: Signal = {
      id: 'signal:dwell-1',
      learnerKey: LEARNER,
      source: {
        interactionId: 'view:zTWuJxehpv:-2KR5z_Mn0',
        resourceId: SCENE_PARADIGM,
        at: iso(0),
      },
      kind: 'lowDwell',
      value: 1800,
    };
    expect(isEvidence(signal)).toBe(false);
  });

  it('没有测项、没有判定、没有情境、判定缺 because —— 一律不是证据', () => {
    const [ok] = createEvidence(draft({ items: [draft().items[0]] }), mint);
    const strip = (k: keyof Evidence): unknown => {
      const copy: Record<string, unknown> = { ...ok };
      delete copy[k];
      return copy;
    };
    expect(isEvidence(strip('measured'))).toBe(false);
    expect(isEvidence(strip('verdict'))).toBe(false);
    expect(isEvidence(strip('context'))).toBe(false);
    expect(isEvidence(strip('source'))).toBe(false);
    // 判定的作用域也是必填：没有它就分不清这条是逐 KC 判的还是题级摊来的
    expect(isEvidence(strip('verdictScope'))).toBe(false);
    expect(isEvidence({ ...ok, verdictScope: 'question' })).toBe(false);
    // 「判定」少了 because 就没法对质，等于没判定
    expect(isEvidence({ ...ok, verdict: { outcome: 'correct' } })).toBe(false);
    // 「跳过某节」不补问就是弱测项 + 无判定
    expect(
      isEvidence({ ...ok, verdict: { outcome: 'skipped', because: { hit: [], missed: [] } } }),
    ).toBe(false);
    expect(isEvidence({ ...ok, context: { modality: 'quiz' } })).toBe(false);
    expect(isEvidence({ ...ok, context: { ...ok.context, encounter: 0 } })).toBe(false);
  });

  it('跳过补问一句就升格成证据——零成本，不需要新机制', () => {
    const upgraded = createEvidence(
      {
        learnerKey: LEARNER,
        source: {
          interactionId: 'view:zTWuJxehpv:-2KR5z_Mn0',
          resourceId: SCENE_PARADIGM,
          at: iso(0),
        },
        items: [
          {
            measured: { kind: 'concept', domain: 'embodied', concept: 'VLA 端到端范式' },
            context: { encounter: 1, modality: 'skip-probe' },
            // 补问的那一句问的就是这一个 KC，判定天然是 per-kc
            verdict: {
              outcome: 'correct',
              because: { hit: ['自述已掌握端到端范式'], missed: [] },
            },
          },
        ],
      },
      mint,
    );
    expect(upgraded.every(isEvidence)).toBe(true);
    expect(upgraded[0].verdictScope).toBe('per-kc');
  });

  it('verdictScore：缺省 score 时由 outcome 映射，越界被夹住', () => {
    expect(verdictScore({ outcome: 'correct', because: { hit: [], missed: [] } })).toBe(1);
    expect(verdictScore({ outcome: 'partial', because: { hit: [], missed: [] } })).toBe(0.5);
    expect(verdictScore({ outcome: 'incorrect', because: { hit: [], missed: [] } })).toBe(0);
    expect(verdictScore({ outcome: 'correct', score: 1.7, because: { hit: [], missed: [] } })).toBe(
      1,
    );
  });
});

describe('权重是序列函数', () => {
  it('蒙对回落：答对之后同一知识点连续两次答错，那条答对基本不算数', () => {
    const guessed = evidence(TOKENIZATION, iso(0), 1, { difficulty: 0.5 });
    const fail1 = evidence(TOKENIZATION, iso(0.2), 0);
    const fail2 = evidence(TOKENIZATION, iso(0.5), 0);

    const alone = weight(guessed, []);
    const retracted = weight(guessed, [fail1, fail2]);

    expect(alone).toBeCloseTo(1, 5);
    expect(retracted).toBeLessThan(alone * 0.3);
  });

  it('区分「忘了」与「当初蒙的」：同样两次答错，隔得远只轻打折', () => {
    const answered = evidence(TOKENIZATION, iso(0), 1);
    const soon = [evidence(TOKENIZATION, iso(0.2), 0), evidence(TOKENIZATION, iso(0.5), 0)];
    const late = [evidence(TOKENIZATION, iso(40), 0), evidence(TOKENIZATION, iso(41), 0)];

    const guessing = weight(answered, soon);
    const forgetting = weight(answered, late);

    expect(forgetting).toBeGreaterThan(guessing * 3);
    expect(guessing).toBeLessThan(0.3);
    expect(forgetting).toBeGreaterThan(0.6);
  });

  it('窗口边界：第二次答错落在窗口内算蒙，落在窗口外算忘', () => {
    const answered = evidence(TOKENIZATION, iso(0), 1);
    const at = (ms: number): string => new Date(Date.parse(iso(0)) + ms).toISOString();
    const inside = [
      evidence(TOKENIZATION, at(1000), 0),
      evidence(TOKENIZATION, at(GUESS_WINDOW_MS), 0),
    ];
    const outside = [
      evidence(TOKENIZATION, at(1000), 0),
      evidence(TOKENIZATION, at(GUESS_WINDOW_MS + 1000), 0),
    ];
    expect(weight(answered, inside)).toBeLessThan(weight(answered, outside));
  });

  it('只错一次不回落——两次才是模式，一次是噪声', () => {
    const answered = evidence(TOKENIZATION, iso(0), 1);
    const one = [evidence(TOKENIZATION, iso(0.2), 0)];
    expect(weight(answered, one)).toBeCloseTo(1, 5);
  });

  it('别的知识点答错不影响这条——测项是隔离的', () => {
    const answered = evidence(TOKENIZATION, iso(0), 1);
    const otherFails = [evidence(CHUNKING, iso(0.2), 0), evidence(CHUNKING, iso(0.5), 0)];
    expect(weight(answered, otherFails)).toBeCloseTo(1, 5);
  });

  it('答错的那条本身不回落——回落只惩罚可疑的「对」', () => {
    const wrong = evidence(TOKENIZATION, iso(0), 0);
    const after = [evidence(TOKENIZATION, iso(0.2), 0), evidence(TOKENIZATION, iso(0.5), 0)];
    expect(weight(wrong, after)).toBeCloseTo(1, 5);
  });

  it('难题的证据更重', () => {
    const easy = evidence(TOKENIZATION, iso(0), 1, { difficulty: 0 });
    const hard = evidence(TOKENIZATION, iso(0), 1, { difficulty: 1 });
    expect(weight(hard, [])).toBeGreaterThan(weight(easy, []));
  });

  it('信号进权重不进履历：同一次交互的 lowDwell 压低该次作答的权重', () => {
    const answered = evidence(TOKENIZATION, iso(0), 1, {}, 'quiz:CBKAJzwtsm:7');
    const dwell: Signal = {
      id: 'signal:dwell-2',
      learnerKey: LEARNER,
      source: {
        interactionId: 'quiz:CBKAJzwtsm:7',
        resourceId: SCENE_TOKENIZATION,
        at: iso(0),
      },
      kind: 'lowDwell',
      value: 900,
    };
    const elsewhere: Signal = { ...dwell, id: 'signal:dwell-3' };
    elsewhere.source = { ...dwell.source, interactionId: 'quiz:other:1' };

    const plain = weight(answered, []);
    expect(weight(answered, [], { signals: [dwell] })).toBeLessThan(plain);
    // 别的交互的信号不该影响这条
    expect(weight(answered, [], { signals: [elsewhere] })).toBeCloseTo(plain, 5);
    // 认不出的信号类型不影响权重，不猜
    expect(weight(answered, [], { signals: [{ ...dwell, kind: 'scrolledFast' }] })).toBeCloseTo(
      plain,
      5,
    );
  });
});

/**
 * 纠正三（2026-08-11 调研）：时间是两件事。
 * 遗忘 → 估计值下降（DSR 的 R(t)）；久未测量 → 置信度扩散、估计值不动（Glicko 的 RD）。
 * 原来 weight() 里一个 HALF_LIFE_MS 把两者混成一个乘数，已删。
 */
describe('两条时间量各归各位', () => {
  it('证据强度不随时间衰减——放三个月和当天是同一个权重', () => {
    const old = evidence(TOKENIZATION, iso(-90), 1, { difficulty: 0.5 });
    const fresh = evidence(TOKENIZATION, iso(0), 1, { difficulty: 0.5 });
    // 同一条证据，只是发生得早：权重相同（会降的是 R(t)，不是证据本身）
    expect(weight(old, [])).toBeCloseTo(weight(fresh, []), 5);
    expect(weight(old, [])).toBeCloseTo(1, 5);
  });

  it('R(t)：随时间降，且 R(S) = 0.9（FSRS 对稳定度的定义）', () => {
    expect(retrievability(0)).toBeCloseTo(1, 5);
    expect(retrievability(DEFAULT_STABILITY_MS)).toBeCloseTo(0.9, 3);
    expect(retrievability(10 * DEFAULT_STABILITY_MS)).toBeLessThan(
      retrievability(DEFAULT_STABILITY_MS),
    );
    // 稳定度越高，同样的间隔掉得越少
    expect(retrievability(30 * day, 90 * day)).toBeGreaterThan(retrievability(30 * day, 30 * day));
  });

  it('RD：随时间加宽，且有上限；它不动估计值', () => {
    const rd0 = 0.4;
    expect(widenDeviation(rd0, 0)).toBeCloseTo(rd0, 5);
    expect(widenDeviation(rd0, 30 * day)).toBeGreaterThan(rd0);
    expect(widenDeviation(rd0, 365 * day)).toBeGreaterThan(widenDeviation(rd0, 30 * day));
    expect(widenDeviation(rd0, 100 * 365 * day)).toBeCloseTo(RD_MAX, 5);
  });

  it('两条量互不替代：同样的间隔，一条降一条升', () => {
    const gap = 60 * day;
    expect(retrievability(gap)).toBeLessThan(retrievability(0));
    expect(widenDeviation(0.4, gap)).toBeGreaterThan(widenDeviation(0.4, 0));
  });
});

describe('权重公式可替换、历史可重算', () => {
  const history = [
    evidence(TOKENIZATION, iso(0), 1),
    evidence(TOKENIZATION, iso(0.2), 0),
    evidence(TOKENIZATION, iso(0.5), 0),
    evidence(CHUNKING, iso(1), 1),
  ];

  it('默认公式跑全量：蒙对的那条被自己的后续压下去', () => {
    const weighed = weighAll(history);
    expect(weighed).toHaveLength(4);
    const guessed = weighed.find((w) => w.evidence.id === history[0].id);
    const legit = weighed.find((w) => w.evidence.id === history[3].id);
    expect(guessed?.weight).toBeLessThan(0.3);
    expect(legit?.weight).toBeGreaterThan(0.9);
  });

  it('换一个公式就重算历史，原始事实一个字节没动', () => {
    const flat = weighAll(history, { fn: () => 1 });
    expect(flat.map((w) => w.weight)).toEqual([1, 1, 1, 1]);
    // 换算法不改数据：同一批 Evidence 对象引用原样返回
    expect(flat.map((w) => w.evidence)).toEqual(history);
  });

  it('作废的证据权重为 0，且不参与别人的「连续两次答错」判定', () => {
    // 第一次答错是坏题被判官作废 → 剩下的一次错不构成模式，那条答对不该回落
    const invalidated = new Set([history[1].id]);
    const weighed = weighAll(history, { invalidated });

    expect(weighed.map((w) => w.evidence.id)).not.toContain(history[1].id);
    const guessed = weighed.find((w) => w.evidence.id === history[0].id);
    expect(guessed?.weight).toBeGreaterThan(0.9);
  });
});
