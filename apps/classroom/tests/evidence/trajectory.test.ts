/**
 * 证据轨迹的分组与统计。
 *
 * 三条纪律各有用例：
 * 1. 画的是**已发生的事实**，不是掌握度——不平滑、不拟合（fold 还没建）
 * 2. `item-level` 与 `per-kc` 必须分得开（§7.7 降级可见）
 * 3. 只有一条证据的测项也要显示——藏起来就成了一张假图
 */
import { describe, expect, it } from 'vitest';

import { summarize, trajectories } from '@/lib/evidence/trajectory';
import type { Evidence } from '@/lib/evidence/types';

function ev(over: Partial<Evidence> & { at: string; concept: string }): Evidence {
  const { at, concept, ...rest } = over;
  return {
    id: `e-${at}-${concept}`,
    learnerKey: 'l',
    source: { interactionId: `i-${at}`, resourceId: 'scene-1', at },
    measured: { kind: 'concept', domain: 'ai', concept },
    verdict: { outcome: 'correct', score: 1, because: { hit: [], missed: [] } },
    verdictScope: 'per-kc',
    context: { encounter: 1, modality: 'tutor' },
    ...rest,
  } as Evidence;
}

describe('trajectories', () => {
  it('按测项分组，组内按时间升序', () => {
    const list = trajectories([
      ev({ at: '2026-08-12T03:00:00Z', concept: 'rag' }),
      ev({ at: '2026-08-12T01:00:00Z', concept: 'rag' }),
      ev({ at: '2026-08-12T02:00:00Z', concept: 'attention' }),
    ]);
    expect(list.map((t) => t.label)).toEqual(['rag', 'attention']); // 点多的在前
    expect(list[0].points.map((p) => p.at)).toEqual([
      '2026-08-12T01:00:00Z',
      '2026-08-12T03:00:00Z',
    ]);
  });

  it('latest 是最后一个点的原始得分 —— 不做任何平滑', () => {
    const t = trajectories([
      ev({ at: '2026-08-12T01:00:00Z', concept: 'rag' }),
      ev({
        at: '2026-08-12T02:00:00Z',
        concept: 'rag',
        verdict: { outcome: 'incorrect', score: 0, because: { hit: [], missed: [] } },
      }),
    ])[0];
    // 平滑过的话这里会是 0.5 之类；掌握度的 fold 还没建，不许在这儿偷偷造一个
    expect(t.latest).toBe(0);
  });

  it('score 缺席时由 outcome 映射，不留空洞', () => {
    const t = trajectories([
      ev({
        at: '2026-08-12T01:00:00Z',
        concept: 'rag',
        verdict: { outcome: 'partial', because: { hit: [], missed: [] } },
      }),
    ])[0];
    expect(t.points[0].score).toBe(0.5);
  });

  it('item-level 单独计数，藏不住', () => {
    const t = trajectories([
      ev({ at: '2026-08-12T01:00:00Z', concept: 'rag' }),
      ev({ at: '2026-08-12T02:00:00Z', concept: 'rag', verdictScope: 'item-level' }),
    ])[0];
    expect(t.itemLevel).toBe(1);
    expect(t.points.map((p) => p.scope)).toEqual(['per-kc', 'item-level']);
  });

  it('只有一条证据的测项也要显示', () => {
    // 藏起来的话，学习者看到的是「我只学过这几个东西」的假图；
    // 真实情况是大部分测项只测过一次，那本身就是要传达的信息
    expect(trajectories([ev({ at: '2026-08-12T01:00:00Z', concept: 'solo' })])).toHaveLength(1);
  });

  it('通用面测项用轴名当标签', () => {
    const e = ev({ at: '2026-08-12T01:00:00Z', concept: 'x' });
    e.measured = { kind: 'general', axis: 'math' };
    expect(trajectories([e])[0].label).toBe('math');
  });
});

describe('summarize', () => {
  it('itemLevelRatio 是「证据有多粗」的直接读数', () => {
    const list = trajectories([
      ev({ at: '2026-08-12T01:00:00Z', concept: 'a' }),
      ev({ at: '2026-08-12T02:00:00Z', concept: 'b', verdictScope: 'item-level' }),
      ev({ at: '2026-08-12T03:00:00Z', concept: 'c', verdictScope: 'item-level' }),
    ]);
    const s = summarize(list);
    expect(s.concepts).toBe(3);
    expect(s.events).toBe(3);
    expect(s.itemLevelRatio).toBeCloseTo(2 / 3);
  });

  it('时间跨度算得出 —— 只有一天的数据画不出趋势，图上要说清', () => {
    const s = summarize(
      trajectories([
        ev({ at: '2026-08-10T00:00:00Z', concept: 'a' }),
        ev({ at: '2026-08-12T00:00:00Z', concept: 'a' }),
      ]),
    );
    expect(s.spanDays).toBeCloseTo(2);
  });

  it('按形态计数，quiz 与 tutor 分得开', () => {
    const s = summarize(
      trajectories([
        ev({ at: '2026-08-12T01:00:00Z', concept: 'a' }),
        ev({
          at: '2026-08-12T02:00:00Z',
          concept: 'b',
          context: { encounter: 1, modality: 'quiz' },
        }),
      ]),
    );
    expect(s.modalities).toEqual({ tutor: 1, quiz: 1 });
  });

  it('空履历不炸', () => {
    const s = summarize([]);
    expect(s).toMatchObject({ concepts: 0, events: 0, itemLevelRatio: 0, spanDays: 0 });
  });
});
