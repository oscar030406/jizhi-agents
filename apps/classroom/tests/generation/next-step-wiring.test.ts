import { describe, expect, it } from 'vitest';

import { prereqGraphFor } from '@/lib/generation/prereq-graph';
import {
  knowledgeState,
  outerFringe,
  prereqClosure,
  rankNext,
  reviewCandidates,
  unmetPrereqs,
} from '@/lib/generation/selection';

/**
 * 选点算法接上真实数据之后的回归。
 *
 * 2026-08-13 之前 `selection.ts` 的 rankNext / outerFringe / reviewCandidates
 * **零生产调用点**——图纸 §5.3/§6.1 整节在材料里能讲、在代码里没有路径走到。
 * 接线落在 `/report` 的 NextStepPanel，输入是页面上本来就有的两份数据：
 * 前置图 `lib/generation/data/prereq-graph.json` + 引擎 `mastery_vector`。
 *
 * 这里用的是真实 demo run（`apps/agent-engine/data/demo_runs/01-beginner-initial.json`）
 * 的原始数字，不是编的夹具。它同时钉住一个**真结论**：引擎按目标反推的 skill_gaps
 * 清单不自足，照它的 priority 顺序学，第一个点就撞墙。
 */

const GRAPH = prereqGraphFor('ai');

/** demo run 的 diagnosis.mastery_vector，逐字。 */
const COLD = {
  agent_basics: 0.0,
  rag: 0.0,
  tool_calling: 0.0,
  langgraph: 0.0,
  evaluation: 0.0,
  deployment: 0.0,
  guardrails: 0.25,
};

/** 同一个 run 的 skill_gaps，按 priority 1–5 排。 */
const GAPS = ['evaluation', 'langgraph', 'tool_calling', 'rag', 'agent_basics'];

describe('冷启动：引擎的 priority 序把撞墙的点排在最前', () => {
  const known = knowledgeState(COLD);

  it('全 0 的掌握度向量里一个点都不算「会」', () => {
    // guardrails 的 0.25 落在 uncertain 带（0.2–0.8），按设计不计入状态。
    expect([...known]).toEqual([]);
  });

  it('现在真能学的只有两个，都不在缺口清单里', () => {
    expect(outerFringe(GRAPH, known)).toEqual(['deep_learning', 'deployment']);
  });

  it('priority=1 的 evaluation 距当前 4 步，不是 1 步', () => {
    const picks = rankNext(GRAPH, COLD, { candidates: GAPS });
    const evaluation = picks.find((p) => p.kc === 'evaluation');
    expect(evaluation!.layer).toBe(4);
    // 缺口清单里没有任何一个点是现在就能学的
    expect(picks.filter((p) => p.layer === 1)).toEqual([]);
  });

  it('清单不自足：闭包里冒出 llm_basics / deep_learning，而 skill_gaps 没列', () => {
    const offList = prereqClosure(GRAPH, GAPS, known).filter((c) => !GAPS.includes(c));
    expect(offList).toEqual(['deep_learning', 'llm_basics']);
  });

  it('冷启动时首排序键完全并列——排序实际由 layer 决定', () => {
    const picks = rankNext(GRAPH, COLD, { candidates: GAPS });
    // predictedCorrect(0) === guess === 0.25，与知识点无关
    expect(new Set(picks.map((p) => p.predicted))).toEqual(new Set([0.25]));
    expect(picks.map((p) => p.layer)).toEqual([...picks.map((p) => p.layer)].sort((a, b) => a - b));
  });

  it('一个都没学会时没有复习候选', () => {
    expect(reviewCandidates(GRAPH, known)).toEqual([]);
  });
});

describe('进阶态：目标成功率这条键真的会翻转顺序', () => {
  const mastery = { ...COLD, llm_basics: 0.9, prompt_engineering: 0.85, rag: 0.5 };
  const known = knowledgeState(mastery);

  it('rag 排在 agent_basics 前面，尽管 agent_basics 解锁 4 个后续', () => {
    const picks = rankNext(GRAPH, mastery);
    expect(picks[0].kc).toBe('rag');
    // 两者同为 layer 1；rag 赢在预测正确率更靠近 0.75–0.85 带，
    // 而不是赢在「解锁多」——unlocks 是末位键，这里恰好反向。
    expect(picks[0].unlocks).toBe(0);
    expect(picks.find((p) => p.kc === 'agent_basics')!.unlocks).toBe(4);
  });

  it('复习候选取 inner fringe：刚学会且拿掉它不破坏别人的那些', () => {
    // llm_basics 被 rag / agent_basics / prompt_engineering 依赖，拿掉会破坏——不进队列。
    expect(reviewCandidates(GRAPH, known)).toEqual(['prompt_engineering']);
  });
});

describe('unmetPrereqs：OR 之间取缺得最少的那条', () => {
  const graph = {
    items: ['py', 'ts', 'rag'],
    clauses: { rag: [{ all: ['py', 'ts'] }, { all: ['ts'] }] },
  };

  it('两条 clause 都不满足时报缺得少的那条', () => {
    expect(unmetPrereqs(graph, 'rag', new Set())).toEqual(['ts']);
  });

  it('任一条满足就返回空', () => {
    expect(unmetPrereqs(graph, 'rag', new Set(['ts']))).toEqual([]);
  });

  it('无 clause 视为无前置', () => {
    expect(unmetPrereqs(graph, 'py', new Set())).toEqual([]);
  });
});

describe('prereqClosure 的边界', () => {
  it('有环也收敛，不转圈', () => {
    const cyclic = {
      items: ['a', 'b'],
      clauses: { a: [{ all: ['b'] }], b: [{ all: ['a'] }] },
    };
    expect(prereqClosure(cyclic, ['a'], new Set())).toEqual(['a', 'b']);
  });

  it('已掌握的不进闭包', () => {
    expect(prereqClosure(GRAPH, ['rag'], new Set(['llm_basics']))).toEqual(['rag']);
  });
});
