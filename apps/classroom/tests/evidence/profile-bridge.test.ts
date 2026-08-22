/**
 * 画像从存储量切成导出量。
 *
 * 这一层要钉死的是**幂等**：旧的 EMA 每跑一次值就变一次（自己迭代自己），
 * 新的从全量履历重算，同一段履历跑多少次都一样。这个区别就是「导出量」的定义，
 * 也是「改规则能重算历史」「数字可对质」两条得以成立的前提。
 */
import { describe, expect, it } from 'vitest';

import { deriveProfileFields } from '@/lib/evidence/profile-bridge';
import type { Evidence, Measured } from '@/lib/evidence/types';

const T0 = Date.parse('2026-08-01T00:00:00Z');
const NOW = Date.parse('2026-08-02T00:00:00Z');

function ev(i: number, score: number, measured?: Measured): Evidence {
  return {
    id: `e${i}`,
    learnerKey: 'l',
    source: {
      interactionId: `i${i}`,
      resourceId: 'r',
      at: new Date(T0 + i * 60_000).toISOString(),
    },
    measured: measured ?? { kind: 'concept', domain: 'ai', concept: 'rag' },
    verdict: {
      outcome: score >= 0.8 ? 'correct' : score >= 0.4 ? 'partial' : 'incorrect',
      score,
      because: { hit: [], missed: [] },
    },
    verdictScope: 'per-kc',
    context: { encounter: i + 1, modality: 'tutor' },
  } as Evidence;
}

describe('导出量的定义：幂等', () => {
  it('同一段履历重算多少次结果都一样', () => {
    const hist = [ev(0, 1), ev(1, 0), ev(2, 1)];
    const a = deriveProfileFields(hist, { now: NOW });
    const b = deriveProfileFields(hist, { now: NOW });
    expect(a.conceptMastery).toEqual(b.conceptMastery);
    expect(a.conceptConfidence).toEqual(b.conceptConfidence);
    // 旧的 EMA 在这里会给出两个不同的值——那正是它不可复算的根源
  });

  it('删掉再重建能得到同一份画像 —— 缓存丢了不心疼', () => {
    const hist = [ev(0, 1), ev(1, 1)];
    expect(deriveProfileFields(hist, { now: NOW }).conceptMastery).toEqual(
      deriveProfileFields([...hist], { now: NOW }).conceptMastery,
    );
  });
});

describe('三个量不许压成一个', () => {
  it('mastery / confidence / recall 各存一张表', () => {
    const f = deriveProfileFields([ev(0, 1), ev(1, 1)], { now: NOW });
    expect(f.conceptMastery.rag).toBeGreaterThan(0.5);
    expect(f.conceptConfidence).toHaveProperty('rag');
    expect(f.conceptRecall).toHaveProperty('rag');
  });

  it('久未测：mastery 不动，recall 掉', () => {
    const hist = [ev(0, 1), ev(1, 1)];
    const fresh = deriveProfileFields(hist, { now: T0 + 24 * 3600_000 });
    const stale = deriveProfileFields(hist, { now: T0 + 200 * 24 * 3600_000 });
    expect(stale.conceptMastery.rag).toBe(fresh.conceptMastery.rag);
    expect(stale.conceptRecall.rag).toBeLessThan(fresh.conceptRecall.rag);
  });
});

describe('通用面不混进专业面那张表', () => {
  it('general 测项不写进 conceptMastery', () => {
    const f = deriveProfileFields(
      [
        ev(0, 1, { kind: 'general', axis: 'math' }),
        ev(1, 1, { kind: 'concept', domain: 'ai', concept: 'rag' }),
      ],
      { now: NOW },
    );
    // 把通用面塞进同一张表正是图纸 §10 第 3 条要治的「五维向量拍平」
    expect(Object.keys(f.conceptMastery)).toEqual(['rag']);
  });

  it('跨域同名概念取证据多的那个', () => {
    const f = deriveProfileFields(
      [
        ev(0, 0, { kind: 'concept', domain: 'embodied', concept: '控制' }),
        ev(1, 1, { kind: 'concept', domain: 'ai', concept: '控制' }),
        ev(2, 1, { kind: 'concept', domain: 'ai', concept: '控制' }),
        ev(3, 1, { kind: 'concept', domain: 'ai', concept: '控制' }),
      ],
      { now: NOW },
    );
    // ai 域 3 条证据全对，embodied 域 1 条答错——取前者
    expect(f.conceptMastery['控制']).toBeGreaterThan(0.5);
  });
});

describe('可对质', () => {
  it('画像带出它是从几条证据算的', () => {
    const f = deriveProfileFields([ev(0, 1), ev(1, 0), ev(2, 1)], { now: NOW });
    expect(f.derivedFrom.evidenceCount).toBe(3);
    expect(typeof f.derivedFrom.at).toBe('string');
  });

  it('作废的证据不进画像', () => {
    const hist = [ev(0, 1), ev(1, 0), ev(2, 0)];
    const all = deriveProfileFields(hist, { now: NOW });
    const pruned = deriveProfileFields(hist, { now: NOW, invalidated: new Set(['e1', 'e2']) });
    expect(pruned.conceptMastery.rag).toBeGreaterThan(all.conceptMastery.rag);
    expect(pruned.derivedFrom.evidenceCount).toBe(1);
  });

  it('空履历给出空表，不是一个假的默认掌握度', () => {
    const f = deriveProfileFields([], { now: NOW });
    expect(f.conceptMastery).toEqual({});
    expect(f.derivedFrom.evidenceCount).toBe(0);
  });
});
