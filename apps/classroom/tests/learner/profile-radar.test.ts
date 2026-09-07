import { describe, expect, it } from 'vitest';

import {
  RADAR_MIN_AXES,
  availableDimensions,
  computeProfileRadar,
  type ProfileRadarInput,
  type RadarDimension,
} from '@/components/learner/profile-radar';

/**
 * 画像雷达维度的算法约束。钉的是「缺数据时不许编」，不是具体数值好不好看。
 *
 * 这张图最容易撒的谎是拿 0 补缺口——补完形状完整，但凹陷是「没测过」不是「不行」。
 * 所以每个维度缺数据时必须 `value === null`，而不是 0。
 */

const dimOf = (dims: RadarDimension[], key: RadarDimension['key']): RadarDimension => {
  const found = dims.find((d) => d.key === key);
  if (!found) throw new Error(`维度 ${key} 不见了——computeProfileRadar 必须永远返回全部五项`);
  return found;
};

/** 有值的维度都得说得出出处；没值的维度都得说得出为什么没有。 */
const expectSelfExplaining = (dims: RadarDimension[]) => {
  for (const d of dims) {
    if (d.value === null) {
      expect(d.missing, `${d.key} 缺数据却没写原因`).not.toBe('');
    } else {
      expect(d.how, `${d.key} 有值却没写算法`).not.toBe('');
      expect(d.source, `${d.key} 有值却没写来源`).not.toBe('');
      expect(d.value).toBeGreaterThanOrEqual(0);
      expect(d.value).toBeLessThanOrEqual(1);
    }
  }
};

describe('computeProfileRadar', () => {
  it('空画像：五项全在，全部 null，不拿 0 充数', () => {
    const dims = computeProfileRadar({});
    expect(dims).toHaveLength(5);
    expect(dims.map((d) => d.value)).toEqual([null, null, null, null, null]);
    expect(availableDimensions(dims)).toHaveLength(0);
    expectSelfExplaining(dims);
  });

  it('空表与缺字段一样处理：{} 不算数据', () => {
    const dims = computeProfileRadar({
      conceptMastery: {},
      conceptRecall: {},
      conceptConfidence: {},
      masteryVector: {},
      selfLevels: [],
      skillGaps: [],
    });
    expect(availableDimensions(dims)).toHaveLength(0);
  });

  it('知识掌握优先用本领域实测，不用引擎诊断向量', () => {
    const dims = computeProfileRadar({
      conceptMastery: { a: 0.4, b: 0.6 },
      masteryVector: { a: 0.9, b: 0.9 },
    });
    const knowledge = dimOf(dims, 'knowledge');
    expect(knowledge.value).toBeCloseTo(0.5, 6);
    expect(knowledge.source).toContain('证据账本');
  });

  it('没有实测记录时退到引擎诊断向量，并在口径里写明用的是估计', () => {
    const dims = computeProfileRadar({ masteryVector: { a: 0.8, b: 0.6 } });
    const knowledge = dimOf(dims, 'knowledge');
    expect(knowledge.value).toBeCloseTo(0.7, 6);
    expect(knowledge.source).toContain('引擎');
    expect(knowledge.how).toContain('尚无实测记录');
  });

  it('先验基础把 0–4 档折到 0–1，只算填了的那几项', () => {
    // 三项有值（1、3、4，均值 8/3），两项缺——缺的不按 0 计入分母。
    const dims = computeProfileRadar({ selfLevels: [1, undefined, 3, null, 4] });
    const prior = dimOf(dims, 'prior');
    expect(prior.value).toBeCloseTo(8 / 3 / 4, 6);
    expect(prior.how).toContain('3 项');
  });

  it('领域不适用自评时 selfLevels 传 null → 先验基础暂无数据', () => {
    const dims = computeProfileRadar({ selfLevels: null, conceptMastery: { a: 0.5 } });
    expect(dimOf(dims, 'prior').value).toBeNull();
    expect(dimOf(dims, 'prior').missing).not.toBe('');
  });

  it('目标达成按 当前/目标 折算并封顶 1', () => {
    const dims = computeProfileRadar({
      skillGaps: [
        { current_mastery: 0.3, target_mastery: 0.6 }, // 0.5
        { current_mastery: 0.9, target_mastery: 0.6 }, // 封顶 1
      ],
    });
    expect(dimOf(dims, 'goal').value).toBeCloseTo(0.75, 6);
  });

  it('老蓝图的技能缺口没有 current/target 两个字段 → 目标达成暂无数据', () => {
    const input: ProfileRadarInput = {
      skillGaps: [{}, {}] as ProfileRadarInput['skillGaps'],
    };
    const dims = computeProfileRadar(input);
    expect(dimOf(dims, 'goal').value).toBeNull();
  });

  it('目标掌握度为 0 的缺口按已达成算，不做除零', () => {
    const dims = computeProfileRadar({
      skillGaps: [{ current_mastery: 0, target_mastery: 0 }],
    });
    expect(dimOf(dims, 'goal').value).toBe(1);
  });

  it('巩固保持与测评把握各走各的表，一张缺了不影响另一张', () => {
    const dims = computeProfileRadar({ conceptRecall: { a: 0.2, b: 0.4 } });
    expect(dimOf(dims, 'retention').value).toBeCloseTo(0.3, 6);
    expect(dimOf(dims, 'evidence').value).toBeNull();
  });

  it('越界与非数字的值不参与均值，也不把整维拖成 null', () => {
    const dims = computeProfileRadar({
      conceptConfidence: {
        a: 1.4, // 夹到 1
        b: -0.2, // 夹到 0
        c: Number.NaN, // 丢掉
        d: 'x' as unknown as number, // 丢掉
      },
    });
    const evidence = dimOf(dims, 'evidence');
    expect(evidence.value).toBeCloseTo(0.5, 6);
    expect(evidence.how).toContain('2 个');
  });

  it('维度顺序固定，换数据不换轴的排布', () => {
    const keys = computeProfileRadar({}).map((d) => d.key);
    expect(keys).toEqual(['knowledge', 'prior', 'goal', 'retention', 'evidence']);
    expect(computeProfileRadar({ conceptMastery: { a: 1 } }).map((d) => d.key)).toEqual(keys);
  });

  it('学过一轮的真实画像：可用维度够画雷达图', () => {
    const dims = computeProfileRadar({
      conceptMastery: { llm_basics: 0.82, rag_basics: 0.55 },
      conceptConfidence: { llm_basics: 0.33, rag_basics: 0.17 },
      conceptRecall: { llm_basics: 0.71, rag_basics: 0.5 },
      selfLevels: [2, 1, 1, 0, 2],
      skillGaps: [{ current_mastery: 0.55, target_mastery: 0.8 }],
    });
    expect(availableDimensions(dims).length).toBe(5);
    expect(availableDimensions(dims).length).toBeGreaterThanOrEqual(RADAR_MIN_AXES);
    expectSelfExplaining(dims);
  });

  it('刚填完画像还没答过题：只剩先验一维，达不到画图门槛', () => {
    const dims = computeProfileRadar({ selfLevels: [1, 1, 0, 0, 1] });
    expect(availableDimensions(dims).map((d) => d.key)).toEqual(['prior']);
    expect(availableDimensions(dims).length).toBeLessThan(RADAR_MIN_AXES);
    expectSelfExplaining(dims);
  });
});
