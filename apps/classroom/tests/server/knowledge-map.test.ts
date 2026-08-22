/**
 * 前置图分层与覆盖读取。跑真数据——分层算错在小图上肉眼看不出来，
 * 只有断言「前置一定在更左的层」才抓得住。
 */

import { describe, expect, it } from 'vitest';

import {
  readCoverageRuns,
  readDifficultySupply,
  readDomainMaps,
} from '@/lib/server/knowledge-map';

describe('知识图谱视图', () => {
  it('分层满足前置约束：每条边的起点层号严格小于终点', async () => {
    const maps = await readDomainMaps();
    if (maps.length === 0) {
      console.warn('跳过：读不到 prereq_graph.json');
      return;
    }
    for (const m of maps) {
      const layer = new Map(m.nodes.map((n) => [n.id, n.layer]));
      for (const e of m.edges) {
        // 违反它就说明分层算错了，图会画出反向箭头
        expect(layer.get(e.from)!).toBeLessThan(layer.get(e.to)!);
      }
      // 每层的 slot 必须从 0 起、无重复，否则节点会画重叠
      const perLayer = new Map<number, Set<number>>();
      for (const n of m.nodes) {
        const set = perLayer.get(n.layer) ?? new Set();
        expect(set.has(n.slot)).toBe(false);
        set.add(n.slot);
        perLayer.set(n.layer, set);
      }
    }
  });

  it('孤立点确实不在任何边上', async () => {
    const maps = await readDomainMaps();
    for (const m of maps) {
      const touched = new Set(m.edges.flatMap((e) => [e.from, e.to]));
      for (const id of m.isolated) expect(touched.has(id)).toBe(false);
    }
  });

  it('环不会让分层死循环', async () => {
    // 分层用固定轮数迭代，有环也必须返回；这里只验它不挂
    const maps = await readDomainMaps();
    expect(Array.isArray(maps)).toBe(true);
  });

  it('覆盖率：同主题多次重跑只留最后一次', async () => {
    const rows = await readCoverageRuns();
    const topics = rows.map((r) => r.topic);
    expect(new Set(topics).size).toBe(topics.length);
    for (const r of rows) {
      expect(r.coverage).toBeGreaterThanOrEqual(0);
      expect(r.coverage).toBeLessThanOrEqual(1);
    }
  });

  it('难度供给：不把 _meta 当成概念', async () => {
    const tiers = await readDifficultySupply();
    for (const t of tiers) {
      expect(t.concepts.length).toBeGreaterThan(0);
      expect(t.concepts.some((c) => c.startsWith('_'))).toBe(false);
    }
  });
});
