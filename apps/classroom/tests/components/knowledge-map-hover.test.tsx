// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { KnowledgeMap } from '@/components/admin/knowledge-map';
import { readDomainMaps } from '@/lib/server/knowledge-map';

/**
 * 学习路径图的挑链高亮：聚焦一个概念，只留它的直接前驱与后继，其余压暗。
 *
 * 为什么值得一个测试：这是这张图上唯一的分支逻辑，而它错了不报错——
 * 高亮集合算漏一个方向（只留后继、丢了前驱），图看着照样正常，读者却会照着错的链排课。
 * 用真前置图跑，不造 fixture：造的图必然满足我自己的假设。
 */

async function pickMap() {
  const maps = await readDomainMaps();
  // 挑一个既有前驱又有后继的概念，两个方向才都测得到
  for (const m of maps) {
    for (const n of m.nodes) {
      const hasIn = m.edges.some((e) => e.to === n.id);
      const hasOut = m.edges.some((e) => e.from === n.id);
      if (hasIn && hasOut) return { map: m, node: n };
    }
  }
  return null;
}

describe('学习路径图', () => {
  it('聚焦一个概念时，只有它和直接前驱后继保持全亮', async () => {
    const picked = await pickMap();
    if (!picked) {
      console.warn('跳过：读不到前置图，或图里没有既有前驱又有后继的概念');
      return;
    }
    const { map, node } = picked;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<KnowledgeMap map={map} />);
    });

    const groups = [...container.querySelectorAll('g[aria-label]')];
    expect(groups.length).toBe(map.nodes.length);
    // 常态：一个都不压暗
    expect(groups.every((g) => !g.getAttribute('opacity') || g.getAttribute('opacity') === '1')).toBe(true);

    const target = groups.find((g) => g.getAttribute('aria-label')!.startsWith(`${node.title}，`))!;
    expect(target).toBeTruthy();
    await act(async () => {
      target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });

    const kin = new Set([
      node.id,
      ...map.edges.filter((e) => e.from === node.id).map((e) => e.to),
      ...map.edges.filter((e) => e.to === node.id).map((e) => e.from),
    ]);
    // 前驱与后继两个方向都得在里面，不然这个断言测不出「只留了一半」
    expect(map.edges.some((e) => e.to === node.id && kin.has(e.from))).toBe(true);
    expect(map.edges.some((e) => e.from === node.id && kin.has(e.to))).toBe(true);

    const titleOf = new Map(map.nodes.map((n) => [n.id, n.title]));
    for (const g of groups) {
      const label = g.getAttribute('aria-label')!;
      const id = [...titleOf.entries()].find(([, t]) => label.startsWith(`${t}，`))![0];
      const dim = g.getAttribute('opacity');
      if (kin.has(id)) expect(dim === '1' || dim === null).toBe(true);
      else expect(Number(dim)).toBeLessThan(1);
    }

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
