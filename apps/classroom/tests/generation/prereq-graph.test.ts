/**
 * 前置图的加载、降级与硬前置判据。
 *
 * 这一层最容易悄悄坏掉的是两件事：
 * 1. 没有图时**静默**按空图跑（降级不可见 = 完成度审计的失分项，§7.7）
 * 2. 把未经人工确认的边当硬前置去拦人（§7.6 只允许人工签字的边拦人）
 * 两条各有用例钉住。
 */
import { describe, expect, it } from 'vitest';

import {
  availableDomains,
  emptyGraph,
  isHardPrereq,
  orderByPrereq,
  prereqGraphFor,
  prereqGraphStatus,
} from '@/lib/generation/prereq-graph';
import { outerFringe, prereqSatisfied } from '@/lib/generation/selection';

describe('前置图加载', () => {
  it('两个领域都造出来了', () => {
    const domains = availableDomains();
    expect(domains).toContain('ai');
    expect(domains).toContain('embodied');
  });

  it('图的形状对得上 selection.ts 的 PrereqGraph', () => {
    for (const d of availableDomains()) {
      const g = prereqGraphFor(d);
      expect(g.items.length).toBeGreaterThan(0);
      for (const [q, clauses] of Object.entries(g.clauses ?? {})) {
        expect(g.items).toContain(q);
        expect(clauses.length).toBeGreaterThan(0);
        for (const c of clauses) {
          expect(Array.isArray(c.all)).toBe(true);
          // clause 里的前置必须都在词表里，否则 fringe 会算出不存在的概念
          for (const p of c.all) expect(g.items).toContain(p);
          // 自己不能是自己的前置
          expect(c.all).not.toContain(q);
        }
      }
    }
  });

  it('图能直接喂给选点，不需要适配层', () => {
    const g = prereqGraphFor('ai');
    const known = new Set<string>();
    const fringe = outerFringe(g, known);
    // 零知识状态下，至少有一个无前置的概念可学——否则整张图是环或全都互为前置
    expect(fringe.length).toBeGreaterThan(0);
    for (const kc of fringe) expect(prereqSatisfied(g, kc, known)).toBe(true);
  });

  it('没有环：按拓扑序能走完全图', () => {
    for (const d of availableDomains()) {
      const g = prereqGraphFor(d);
      const known = new Set<string>();
      let guard = g.items.length + 1;
      while (known.size < g.items.length && guard-- > 0) {
        const next = outerFringe(g, known);
        if (next.length === 0) break;
        for (const kc of next) known.add(kc);
      }
      expect(known.size).toBe(g.items.length);
    }
  });
});

describe('降级必须可见', () => {
  it('未知领域返回空图，且状态里说清为什么', () => {
    const g = prereqGraphFor('没有这个域');
    expect(g.items).toEqual([]);
    const s = prereqGraphStatus('没有这个域');
    expect(s.ready).toBe(false);
    expect(s.notice).toContain('教材章节顺序');
  });

  it('空图不拦任何概念 —— 降级是放行不是失败', () => {
    const g = emptyGraph(['a', 'b']);
    expect(prereqSatisfied(g, 'b', new Set())).toBe(true);
    expect(outerFringe(g, new Set())).toEqual(['a', 'b']);
  });

  it('有图时也要说明边有没有经过人工确认', () => {
    const s = prereqGraphStatus('ai');
    expect(s.ready).toBe(true);
    expect(s.concepts).toBeGreaterThan(0);
    expect(s.notice.length).toBeGreaterThan(0);
  });
});

describe('硬前置判据', () => {
  it('只有人工确认过的 clause 才是硬前置', () => {
    expect(isHardPrereq({ all: ['x'], confidence: 0.99 })).toBe(false);
    expect(isHardPrereq({ all: ['x'], confidence: 0.1, reviewed: true })).toBe(true);
  });

  it('当前造出来的边一条都没确认 —— 所以现在没有硬前置', () => {
    // 这不是缺陷，是 §7.6 写死的：模型抽的边不能拦人。
    // 哪天人工过完目，这条用例要连同 reviewed 标记一起改。
    for (const d of availableDomains()) {
      expect(prereqGraphStatus(d).reviewed).toBe(0);
    }
  });
});

describe('按前置层级排序', () => {
  it('前置排在被前置的前面 —— 拓扑序而不是优先级序', () => {
    const g = prereqGraphFor('ai');
    // 从真图里取一对真实的边来测，不构造假数据
    const [child, clauses] = Object.entries(g.clauses ?? {})[0];
    const parent = clauses[0].all[0];
    // 故意把被前置的放前面，看排序会不会把它挪到后面
    const { concepts, usedGraph, prereqOf } = orderByPrereq([child, parent], 'ai');
    expect(usedGraph).toBe(true);
    expect(concepts.indexOf(parent)).toBeLessThan(concepts.indexOf(child));
    expect(prereqOf[child]).toContain(parent);
  });

  it('只列这批概念内部的前置 —— 图外的前置指不过去', () => {
    const g = prereqGraphFor('ai');
    const [child, clauses] = Object.entries(g.clauses ?? {})[0];
    const parent = clauses[0].all[0];
    const { prereqOf } = orderByPrereq([child], 'ai');
    expect(prereqOf[child] ?? []).not.toContain(parent);
  });

  it('同层保持原顺序 —— 是在优先级序上加约束，不是换一套排序', () => {
    const g = prereqGraphFor('ai');
    // 取两个互相没有前置关系的概念
    const free = g.items.filter((i) => !(g.clauses ?? {})[i]).slice(0, 2);
    expect(free.length).toBe(2);
    expect(orderByPrereq(free, 'ai').concepts).toEqual(free);
    expect(orderByPrereq([free[1], free[0]], 'ai').concepts).toEqual([free[1], free[0]]);
  });

  it('图缺席时原样返回并标明没用上图 —— 不静默降级', () => {
    const r = orderByPrereq(['x', 'y'], '没有这个域');
    expect(r.usedGraph).toBe(false);
    expect(r.matched).toBe(0);
    expect(r.concepts).toEqual(['x', 'y']);
  });

  it('一个概念都对不上词表时同样标 false', () => {
    const r = orderByPrereq(['压根不存在的概念'], 'ai');
    expect(r.usedGraph).toBe(false);
  });

  it('概念一个都不丢', () => {
    const g = prereqGraphFor('ai');
    const picked = g.items.slice(0, 6);
    expect(orderByPrereq(picked, 'ai').concepts.sort()).toEqual([...picked].sort());
  });
});
