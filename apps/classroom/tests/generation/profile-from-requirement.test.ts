/**
 * 自述并进画像的合并口径。
 *
 * 钉住 2026-08-13 实测暴露的洞：需求框里写「我完全不懂技术，也没写过代码」，
 * 画像纹丝不动（programming_level 仍是 1、偏好仍是「可运行示例与分步练习」），
 * 生成的课照旧给 argsort/.tolist() 这类代码摘录。
 */

import { describe, expect, it } from 'vitest';

import {
  describeChanges,
  mergeSeedIntoProfile,
  type ProfileSeed,
} from '@/lib/generation/profile-from-requirement';

const STORED = {
  domain: 'ai',
  programming_level: 1,
  python_level: 1,
  agent_level: 0,
  rag_level: 0,
  engineering_level: 1,
  learning_preference: '可运行示例与分步练习',
};

const seed = (levels: Record<string, number>, keyword = '没写过代码'): ProfileSeed => ({
  levels,
  background_hint: '',
  evidence: Object.entries(levels).map(([dimension, level]) => ({
    dimension,
    level,
    keyword,
    reason: '自述',
  })),
  unmatched: false,
});

describe('自述并进画像', () => {
  it('自述说不会编程时**下调**已存画像——用户刚说了，不许当没听见', () => {
    const { profile, changes } = mergeSeedIntoProfile(STORED, seed({ programming: 0 }));
    expect(profile.programming_level).toBe(0);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: 'programming_level', from: 1, to: 0 });
  });

  it('自述没提到的维度原样保留，不虚构', () => {
    const { profile } = mergeSeedIntoProfile(STORED, seed({ programming: 0 }));
    expect(profile.python_level).toBe(1);
    expect(profile.engineering_level).toBe(1);
    expect(profile.learning_preference).toBe('可运行示例与分步练习');
  });

  it('不修改入参——画像在生成流程里被多处读，就地改会串味', () => {
    const before = JSON.stringify(STORED);
    mergeSeedIntoProfile(STORED, seed({ programming: 0, agent: 2 }));
    expect(JSON.stringify(STORED)).toBe(before);
  });

  it('一条规则都没命中时原样返回，且没有变更', () => {
    const none: ProfileSeed = { levels: {}, background_hint: '', evidence: [], unmatched: true };
    const { profile, changes } = mergeSeedIntoProfile(STORED, none);
    expect(profile).toBe(STORED);
    expect(changes).toEqual([]);
  });

  it('桥断了（seed 为 null）不挡住生成', () => {
    const { profile, changes } = mergeSeedIntoProfile(STORED, null);
    expect(profile).toBe(STORED);
    expect(changes).toEqual([]);
  });

  it('档位没变化不算变更——避免弹一句什么都没改的提示', () => {
    const { changes } = mergeSeedIntoProfile(STORED, seed({ programming: 1 }));
    expect(changes).toEqual([]);
  });

  it('给用户的说明带上命中的原词，不是一句“已按你的描述调整”', () => {
    const { changes } = mergeSeedIntoProfile(STORED, seed({ programming: 0 }));
    const msg = describeChanges(changes);
    expect(msg).toContain('没写过代码');
    expect(msg).toContain('编程 → 0 档');
    expect(msg).toContain('学习者画像'); // 告诉用户去哪长期改
  });

  it('抽取器给的未知维度不落地——映射表里没有就跳过，别往画像上塞野字段', () => {
    const { profile, changes } = mergeSeedIntoProfile(STORED, seed({ 未知维度: 3 }));
    expect(changes).toEqual([]);
    expect(Object.keys(profile)).toEqual(Object.keys(STORED));
  });
});
