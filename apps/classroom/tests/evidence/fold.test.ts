/**
 * 画像 fold：履历 → 掌握度二元组。
 *
 * 钉住的都是「压成标量」或「把两件事混成一件」时会悄悄坏掉的东西：
 * 二元组不许退化、久未测只动置信不动估计、遗忘只动 recall 不动 estimate、
 * 同一段履历必须算出同一份画像（可复算是「导出量」的全部意义）。
 */
import { describe, expect, it } from 'vitest';

import { fold, evidenceBehind, PRIOR_ALPHA, PRIOR_BETA } from '@/lib/evidence/fold';
import type { Evidence, Measured } from '@/lib/evidence/types';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-01T00:00:00Z');
const NOW = Date.parse('2026-08-02T00:00:00Z');

function ev(
  i: number,
  score: number,
  over: Partial<Evidence> & { measured?: Measured; atMs?: number } = {},
): Evidence {
  const { measured, atMs, ...rest } = over;
  const at = new Date(atMs ?? T0 + i * 60_000).toISOString();
  return {
    id: `e${i}`,
    learnerKey: 'l',
    source: { interactionId: `i${i}`, resourceId: 'r', at },
    measured: measured ?? { kind: 'concept', domain: 'ai', concept: 'rag' },
    verdict: {
      outcome: score >= 0.8 ? 'correct' : score >= 0.4 ? 'partial' : 'incorrect',
      score,
      because: { hit: [], missed: [] },
    },
    verdictScope: 'per-kc',
    context: { encounter: i + 1, modality: 'tutor' },
    ...rest,
  } as Evidence;
}

describe('掌握度是二元组', () => {
  it('答对拉高估计值，答错拉低', () => {
    const up = fold([ev(0, 1), ev(1, 1), ev(2, 1)], { now: NOW }).all[0];
    const down = fold([ev(0, 0), ev(1, 0), ev(2, 0)], { now: NOW }).all[0];
    expect(up.estimate).toBeGreaterThan(0.5);
    expect(down.estimate).toBeLessThan(0.5);
  });

  it('证据越多置信度越高 —— 3 题对 2 与 30 题对 20 必须分得开', () => {
    const few = fold([ev(0, 1), ev(1, 1), ev(2, 0)], { now: NOW }).all[0];
    const many = fold(
      Array.from({ length: 30 }, (_, i) => ev(i, i % 3 === 2 ? 0 : 1)),
      { now: NOW },
    ).all[0];
    // 估计值接近（都是 2/3 上下），置信度必须差开——压成标量就分不出来了
    expect(Math.abs(few.estimate - many.estimate)).toBeLessThan(0.25);
    expect(many.confidence).toBeGreaterThan(few.confidence);
  });

  it('空履历得到空画像，不是一个假的先验数字', () => {
    const p = fold([], { now: NOW });
    expect(p.all).toEqual([]);
    expect(p.general).toEqual([]);
    expect(p.byDomain).toEqual({});
  });
});

describe('时间的两件事各归各位', () => {
  it('久未测：置信度掉，估计值不动', () => {
    const hist = [ev(0, 1), ev(1, 1)];
    const fresh = fold(hist, { now: T0 + DAY }).all[0];
    const stale = fold(hist, { now: T0 + 200 * DAY }).all[0];
    expect(stale.estimate).toBeCloseTo(fresh.estimate, 6); // 估计值一点不动
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it('遗忘：recall 掉，estimate 不动 —— 两者靠不同动作收回', () => {
    const hist = [ev(0, 1), ev(1, 1)];
    const fresh = fold(hist, { now: T0 + DAY }).all[0];
    const stale = fold(hist, { now: T0 + 200 * DAY }).all[0];
    expect(stale.recall).toBeLessThan(fresh.recall);
    expect(stale.estimate).toBeCloseTo(fresh.estimate, 6);
    // recall 是导出量：一定不高于 estimate
    expect(stale.recall).toBeLessThanOrEqual(stale.estimate + 1e-9);
  });
});

describe('可复算', () => {
  it('同一段履历算出同一份画像', () => {
    const hist = [ev(0, 1), ev(1, 0), ev(2, 0.5)];
    expect(fold(hist, { now: NOW })).toEqual(fold(hist, { now: NOW }));
  });

  it('履历顺序打乱不影响结果 —— fold 内部按时间排序', () => {
    const hist = [ev(0, 1), ev(1, 0), ev(2, 1)];
    const shuffled = [hist[2], hist[0], hist[1]];
    expect(fold(shuffled, { now: NOW }).all[0].estimate).toBeCloseTo(
      fold(hist, { now: NOW }).all[0].estimate,
      10,
    );
  });

  it('作废的证据不再影响画像，但证据本身还在', () => {
    const hist = [ev(0, 1), ev(1, 0), ev(2, 0)];
    const withAll = fold(hist, { now: NOW }).all[0];
    const withoutBad = fold(hist, { now: NOW, invalidated: new Set(['e1', 'e2']) }).all[0];
    expect(withoutBad.estimate).toBeGreaterThan(withAll.estimate);
    expect(withoutBad.evidenceCount).toBe(1);
    expect(hist).toHaveLength(3); // 原履历没被改动
  });
});

describe('通用面与专业面', () => {
  it('general 更新通用面，concept 更新对应领域的专业面', () => {
    const p = fold(
      [
        ev(0, 1, { measured: { kind: 'general', axis: 'math' } }),
        ev(1, 1, { measured: { kind: 'concept', domain: 'ai', concept: 'rag' } }),
        ev(2, 1, { measured: { kind: 'concept', domain: 'embodied', concept: 'ros2' } }),
      ],
      { now: NOW },
    );
    expect(p.general.map((m) => m.key)).toEqual(['general:math']);
    expect(Object.keys(p.byDomain).sort()).toEqual(['ai', 'embodied']);
    expect(p.byDomain.ai).toHaveLength(1);
  });

  it('换领域是切换不是重置 —— 别的领域的项还在画像里', () => {
    const p = fold(
      [
        ev(0, 1, { measured: { kind: 'concept', domain: 'ai', concept: 'rag' } }),
        ev(1, 1, { measured: { kind: 'concept', domain: 'embodied', concept: 'ros2' } }),
      ],
      { now: NOW },
    );
    expect(p.byDomain.ai).toHaveLength(1);
    expect(p.byDomain.embodied).toHaveLength(1);
  });
});

describe('数字可对质', () => {
  it('每一项能展开成算它用了哪几条证据', () => {
    const hist = [
      ev(0, 1),
      ev(1, 0),
      ev(2, 1, { measured: { kind: 'concept', domain: 'ai', concept: '别的' } }),
    ];
    const m = fold(hist, { now: NOW }).all.find((x) => x.key.includes('rag'))!;
    expect(m.evidenceCount).toBe(2);
    const behind = evidenceBehind(hist, { kind: 'concept', domain: 'ai', concept: 'rag' });
    expect(behind.map((b) => b.evidence.id)).toEqual(['e0', 'e1']);
    expect(behind.every((b) => typeof b.weight === 'number')).toBe(true);
  });

  it('粗粒度证据单独计数，置信度算得出它的影响', () => {
    const m = fold([ev(0, 1), ev(1, 1, { verdictScope: 'item-level' })], { now: NOW }).all[0];
    expect(m.evidenceCount).toBe(2);
    expect(m.itemLevelCount).toBe(1);
  });

  it('先验是 Beta(1,1) 均匀分布 —— 不给任何一边偏袒', () => {
    expect(PRIOR_ALPHA).toBe(1);
    expect(PRIOR_BETA).toBe(1);
    // 零证据时估计值就是 0.5，不是某个拍出来的默认掌握度
    expect(PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA)).toBe(0.5);
  });
});
