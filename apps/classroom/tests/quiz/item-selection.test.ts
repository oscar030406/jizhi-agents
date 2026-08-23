import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER,
  DISCRIMINATION,
  TIER_DIFFICULTY,
  TIERS,
  abilityFromMastery,
  guessRate,
  itemInformation,
  parseTier,
  peakAbility,
  peakProb,
  pickTier,
  probCorrect,
  quizDifficultyOf,
  rankByInformation,
  rankRepractice,
  standardError,
  type CandidateItem,
} from '@/lib/quiz/item-selection';
import { TARGET_SUCCESS_MAX, TARGET_SUCCESS_MIN } from '@/lib/generation/selection';

/** 在 [lo, hi] 上扫 θ，返回信息量最大的那个点。用来数值验证解析解。 */
function argmaxAbility(b: number, guess: number, lo = -6, hi = 6, step = 0.0005): number {
  let best = lo;
  let bestInfo = -1;
  for (let t = lo; t <= hi; t += step) {
    const info = itemInformation(t, b, guess);
    if (info > bestInfo) {
      bestInfo = info;
      best = t;
    }
  }
  return best;
}

describe('信息量函数：算得对', () => {
  it('c=0 时退化成 2PL 的 a²·P·(1−P)', () => {
    for (const theta of [-2, -0.7, 0, 0.3, 1.9]) {
      const b = 0.5;
      const p = probCorrect(theta, b, 0);
      expect(itemInformation(theta, b, 0)).toBeCloseTo(DISCRIMINATION ** 2 * p * (1 - p), 10);
    }
  });

  it('3PL 概率式与手算一致', () => {
    // θ=b 时 logistic 项恰为 0.5，P = c + (1−c)/2
    expect(probCorrect(0.5, 0.5, 0.25)).toBeCloseTo(0.625, 12);
    expect(probCorrect(0.5, 0.5, 0)).toBeCloseTo(0.5, 12);
    // θ→±∞ 的两个渐近值
    expect(probCorrect(-50, 0, 0.25)).toBeCloseTo(0.25, 10);
    expect(probCorrect(50, 0, 0.25)).toBeCloseTo(1, 10);
  });

  it('信息量在 P* = (1+√(1+8c))/4 处取到峰值——数值扫描对上解析解', () => {
    for (const c of [0, 0.2, 0.25, 1 / 3]) {
      const b = 0.5;
      const thetaStar = argmaxAbility(b, c);
      // 峰值位置
      expect(thetaStar).toBeCloseTo(peakAbility(b, c), 2);
      // 峰值处的答对概率
      expect(probCorrect(thetaStar, b, c)).toBeCloseTo(peakProb(c), 2);
    }
  });

  it('c=0 的最优题正好五五开，且难度等于能力', () => {
    expect(peakProb(0)).toBeCloseTo(0.5, 12);
    expect(peakAbility(0.5, 0)).toBeCloseTo(0.5, 12);
  });

  it('c>0 时峰值右移——四选一的最优题比学习者能力略难', () => {
    // ln[(1+√3)/2] / 1.7 ≈ 0.1835
    expect(peakAbility(0, 0.25)).toBeCloseTo(0.1835, 3);
    expect(peakAbility(0, 0.25)).toBeGreaterThan(0);
    expect(peakProb(0.25)).toBeCloseTo(0.6830, 4);
  });

  it('猜对率越高，同一道题能给的最大信息量越低', () => {
    const maxInfo = (c: number) => itemInformation(peakAbility(0, c), 0, c);
    expect(maxInfo(0)).toBeGreaterThan(maxInfo(0.25));
    expect(maxInfo(0.25)).toBeGreaterThan(maxInfo(0.5));
  });
});

describe('与 rankNext 的关系：并列而不是替换', () => {
  it('测评最优点 0.683 落在学习带 0.75–0.85 之下', () => {
    const p = peakProb(guessRate('single', 4));
    expect(p).toBeLessThan(TARGET_SUCCESS_MIN);
    expect(p).toBeLessThan(TARGET_SUCCESS_MAX);
    // 「相邻但不相等」：差得不多，但不是同一个数
    expect(TARGET_SUCCESS_MIN - p).toBeGreaterThan(0.05);
    expect(TARGET_SUCCESS_MIN - p).toBeLessThan(0.1);
  });

  it('落在学习带里的题，信息量反而不是最高的', () => {
    // 找一个 P 恰在带内的 θ，与峰值 θ 比信息量
    const b = 0;
    const c = 0.25;
    const inBand = argmaxAbility(b, c, -6, 6, 0.001);
    const bandTheta = (() => {
      for (let t = -6; t <= 6; t += 0.001) {
        if (probCorrect(t, b, c) >= TARGET_SUCCESS_MIN) return t;
      }
      return 6;
    })();
    expect(probCorrect(bandTheta, b, c)).toBeGreaterThanOrEqual(TARGET_SUCCESS_MIN);
    expect(itemInformation(bandTheta, b, c)).toBeLessThan(itemInformation(inBand, b, c));
  });
});

describe('掌握度 → 能力映射', () => {
  it('与引擎定标脚本的 4m−2 一致', () => {
    expect(abilityFromMastery(0)).toBe(-2);
    expect(abilityFromMastery(0.5)).toBe(0);
    expect(abilityFromMastery(1)).toBe(2);
  });

  it('越界截断，非有限值当 0 掌握度——与 selection.ts 的 estimateOf 同一条约定', () => {
    expect(abilityFromMastery(-3)).toBe(-2);
    expect(abilityFromMastery(9)).toBe(2);
    expect(abilityFromMastery(Number.NaN)).toBe(-2);
    expect(abilityFromMastery(Number.POSITIVE_INFINITY)).toBe(-2);
  });
});

describe('猜对率：题型与选项数', () => {
  it('单选 1/n，多选 1/(2ⁿ−1)，短答 0', () => {
    expect(guessRate('single', 4)).toBeCloseTo(0.25, 12);
    expect(guessRate('single', 3)).toBeCloseTo(1 / 3, 12);
    expect(guessRate('multiple', 4)).toBeCloseTo(1 / 15, 12);
    expect(guessRate('short_answer', 0)).toBe(0);
  });

  it('选项数缺失或非法按短答处理，不编默认值', () => {
    expect(guessRate('single', undefined)).toBe(0);
    expect(guessRate('single', 1)).toBe(0);
    expect(guessRate('single', Number.NaN)).toBe(0);
  });
});

describe('分阶测验：pickTier', () => {
  it('全不会 → 最低档', () => {
    expect(pickTier(0).tier).toBe('L1');
  });

  it('全会 → 最高档', () => {
    expect(pickTier(1).tier).toBe('L4');
  });

  it('掌握度单调上升，选出的档不下降', () => {
    let last = 0;
    for (let m = 0; m <= 1.0001; m += 0.02) {
      const rank = TIERS.indexOf(pickTier(m).tier);
      expect(rank).toBeGreaterThanOrEqual(last);
      last = rank;
    }
    expect(last).toBe(3);
  });

  it('中段掌握度落在中间两档', () => {
    expect(['L2', 'L3']).toContain(pickTier(0.5).tier);
  });

  it('选中的档就是全档里信息量最大的那一个', () => {
    for (const m of [0, 0.15, 0.4, 0.62, 0.88, 1]) {
      const theta = abilityFromMastery(m);
      const picked = pickTier(m);
      for (const t of TIERS) {
        expect(picked.information + 1e-12).toBeGreaterThanOrEqual(
          itemInformation(theta, TIER_DIFFICULTY[t], 0.25),
        );
      }
    }
  });

  it('allowed 卡住难度带——带外的档再优也不选', () => {
    const picked = pickTier(1, { allowed: ['L1', 'L2'] });
    expect(picked.tier).toBe('L2');
    expect(pickTier(0, { allowed: ['L3', 'L4'] }).tier).toBe('L3');
  });

  it('allowed 传空数组视为不限，不至于选不出档', () => {
    expect(pickTier(0.9, { allowed: [] }).tier).toBe(pickTier(0.9).tier);
  });

  it('短答（c=0）与四选一在同一能力上可能选到不同档——猜对率参与了裁决', () => {
    // c 只右移峰值，不改单调性；这里只断言两种题型都能选出合法档且概率自洽
    for (const m of [0.3, 0.55, 0.8]) {
      const mcq = pickTier(m, { options: 4, type: 'single' });
      const open = pickTier(m, { type: 'short_answer' });
      expect(TIERS).toContain(mcq.tier);
      expect(TIERS).toContain(open.tier);
      expect(mcq.predicted).toBeGreaterThan(open.predicted); // 能蒙就更容易答对
    }
  });

  it('L1–L4 与三档难度名互转', () => {
    expect(quizDifficultyOf('L1')).toBe('easy');
    expect(quizDifficultyOf('L2')).toBe('medium');
    expect(quizDifficultyOf('L4')).toBe('hard');
    expect(parseTier('L3')).toBe('L3');
    expect(parseTier('easy')).toBe('L1');
    expect(parseTier('HARD')).toBe('L3');
    expect(parseTier('困难')).toBeNull();
    expect(parseTier(undefined)).toBeNull();
  });
});

describe('候选池排序：rankByInformation', () => {
  const pool: CandidateItem[] = [
    { id: 'q_easy', tier: 'L1', options: 4, type: 'single' },
    { id: 'q_mid', tier: 'L2', options: 4, type: 'single' },
    { id: 'q_hard', tier: 'L4', options: 4, type: 'single' },
    { id: 'q_open', tier: 'L2', type: 'short_answer' },
  ];

  it('弱学习者：最易的那道排在最难的那道前面', () => {
    const ranked = rankByInformation(pool, abilityFromMastery(0.1));
    const pos = (id: string) => ranked.findIndex((p) => p.id === id);
    expect(pos('q_easy')).toBeLessThan(pos('q_hard'));
  });

  it('强学习者：反过来', () => {
    const ranked = rankByInformation(pool, abilityFromMastery(0.95));
    const pos = (id: string) => ranked.findIndex((p) => p.id === id);
    expect(pos('q_hard')).toBeLessThan(pos('q_easy'));
  });

  it('同档下短答比四选一携带更多信息（能蒙就测不准）', () => {
    const ranked = rankByInformation(pool, abilityFromMastery(0.42));
    const open = ranked.find((p) => p.id === 'q_open')!;
    const mid = ranked.find((p) => p.id === 'q_mid')!;
    expect(open.b).toBe(mid.b);
    expect(open.information).toBeGreaterThan(mid.information);
  });

  it('档位缺失时全池同 b——排序只剩题型在起作用（写在文档里的退化行为）', () => {
    const ranked = rankByInformation(
      [
        { id: 'a', options: 4, type: 'single' },
        { id: 'b', type: 'short_answer' },
      ],
      0,
    );
    expect(ranked.every((p) => p.b === TIER_DIFFICULTY[DEFAULT_TIER])).toBe(true);
    expect(ranked[0].id).toBe('b');
  });

  it('信息量相同就按 id，稳定可复现', () => {
    const same: CandidateItem[] = [
      { id: 'z', tier: 'L2', options: 4, type: 'single' },
      { id: 'a', tier: 'L2', options: 4, type: 'single' },
      { id: 'm', tier: 'L2', options: 4, type: 'single' },
    ];
    expect(rankByInformation(same, 0).map((p) => p.id)).toEqual(['a', 'm', 'z']);
    // 顺序不影响结果
    expect(rankByInformation([...same].reverse(), 0).map((p) => p.id)).toEqual(['a', 'm', 'z']);
  });

  it('空池、极端能力、脏数据都不崩', () => {
    expect(rankByInformation([], 0)).toEqual([]);
    for (const theta of [-2, 2, -1e6, 1e6, Number.NaN]) {
      const ranked = rankByInformation(pool, theta);
      expect(ranked).toHaveLength(4);
      for (const p of ranked) {
        expect(Number.isFinite(p.information)).toBe(true);
        expect(p.information).toBeGreaterThanOrEqual(0);
        expect(p.predicted).toBeGreaterThanOrEqual(0);
        expect(p.predicted).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('错题重练：rankRepractice', () => {
  it('空答一律排到答错之后——分流在信息量之前', () => {
    const ranked = rankRepractice(
      [
        { id: 'blank_easy', tier: 'L1', options: 4, type: 'single', answered: false },
        { id: 'wrong_hard', tier: 'L4', options: 4, type: 'single', answered: true },
      ],
      0.1,
    );
    expect(ranked.map((p) => p.id)).toEqual(['wrong_hard', 'blank_easy']);
  });

  it('同为答错时按信息量降序', () => {
    const ranked = rankRepractice(
      [
        { id: 'far', tier: 'L4', options: 4, type: 'single', answered: true },
        { id: 'near', tier: 'L1', options: 4, type: 'single', answered: true },
      ],
      0.1,
    );
    expect(ranked[0].id).toBe('near');
    expect(ranked[0].information).toBeGreaterThan(ranked[1].information);
  });

  it('answered 缺省当作答过——老记录不会被误分流到队尾', () => {
    const ranked = rankRepractice(
      [
        { id: 'legacy', tier: 'L2', options: 4, type: 'single' },
        { id: 'blank', tier: 'L2', options: 4, type: 'single', answered: false },
      ],
      0.5,
    );
    expect(ranked.map((p) => p.id)).toEqual(['legacy', 'blank']);
    expect(ranked[0].answered).toBe(true);
  });

  it('全会 / 全不会都排得出队列，且不产生 NaN', () => {
    const items = [
      { id: 'a', tier: 'L1' as const, options: 4, type: 'single' },
      { id: 'b', tier: 'L4' as const, options: 4, type: 'single' },
    ];
    for (const m of [0, 1]) {
      const ranked = rankRepractice(items, m);
      expect(ranked).toHaveLength(2);
      expect(ranked.every((p) => Number.isFinite(p.information))).toBe(true);
    }
  });

  it('空队列返回空数组', () => {
    expect(rankRepractice([], 0.5)).toEqual([]);
  });
});

describe('标准误：把「我们达不到 CAT 的门槛」算给自己看', () => {
  it('一道题都没有时是无穷', () => {
    expect(standardError([])).toBe(Number.POSITIVE_INFINITY);
    expect(standardError([0, 0])).toBe(Number.POSITIVE_INFINITY);
  });

  it('SE = 1/√ΣI', () => {
    expect(standardError([0.25, 0.75])).toBeCloseTo(1, 12);
    expect(standardError([4])).toBeCloseTo(0.5, 12);
  });

  it('四选一即使全打在峰值上，也要二十多道才够 SE ≤ 0.32', () => {
    const c = guessRate('single', 4);
    const peak = itemInformation(peakAbility(0, c), 0, c);
    let n = 0;
    while (standardError(Array(n).fill(peak)) > 0.32) n += 1;
    expect(n).toBeGreaterThan(20);
    // 一次测验通常 2–5 道题，差一个数量级——这就是 selection.ts 那句话的量化版
    expect(standardError(Array(5).fill(peak))).toBeGreaterThan(0.32);
  });
});
