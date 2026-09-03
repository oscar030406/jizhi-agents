import { describe, expect, it } from 'vitest';

import { layoutConcepts } from '@/components/path/concept-graph';

/** 智能制造那张图的真实形状：6 阶、第 1 阶 15 个概念。 */
const sizes = [15, 9, 9, 11, 11, 11];
const nodes = sizes.flatMap((n, stage) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${stage + 1}-${i}`, stage: stage + 1 })),
);

describe('概念图排版', () => {
  it('同一列内节点不重叠，阶次严格从左到右', () => {
    const pos = layoutConcepts(nodes);
    expect(pos.size).toBe(nodes.length);

    // 每阶占的横坐标区间不许和别的阶交叠：折出来的第二列仍属本阶，必须在下一阶左边。
    const xs = new Map<number, number[]>();
    for (const node of nodes)
      xs.set(node.stage, [...(xs.get(node.stage) ?? []), pos.get(node.id)!.x]);
    const stages = [...xs.keys()].sort((a, b) => a - b);
    for (let i = 1; i < stages.length; i += 1) {
      expect(Math.max(...xs.get(stages[i - 1])!)).toBeLessThan(Math.min(...xs.get(stages[i])!));
    }

    // 同一列（x 相同）里两两纵向间距不小于节点高度
    const byColumn = new Map<number, number[]>();
    for (const node of nodes) {
      const p = pos.get(node.id)!;
      byColumn.set(p.x, [...(byColumn.get(p.x) ?? []), p.y]);
    }
    for (const ys of byColumn.values()) {
      const sorted = [...ys].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(36);
      }
    }
  });

  it('一阶一列：智能制造 6 阶就是 6 列，折列只在一阶超过 16 个概念时发生', () => {
    expect(new Set([...layoutConcepts(nodes).values()].map((p) => p.x)).size).toBe(sizes.length);

    const huge = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, stage: 1 }));
    expect(new Set([...layoutConcepts(huge).values()].map((p) => p.x)).size).toBe(2);
  });
});
