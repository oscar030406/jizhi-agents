import { describe, expect, it } from 'vitest';
import {
  bandDistance,
  bandOf,
  innerFringe,
  knowledgeState,
  layers,
  outerFringe,
  predictedCorrect,
  prereqSatisfied,
  rankNext,
  reviewCandidates,
  targetScore,
  unlockCount,
  type PrereqGraph,
} from '@/lib/generation/selection';

/**
 * 小图，覆盖三种前置形态：
 * - 无前置：python / prompt / typescript
 * - AND：tool_calling 要 agent_basics **且** python（同一条 clause 内）
 * - OR：rag 要 python **或** typescript（两条 clause）
 */
const GRAPH: PrereqGraph = {
  items: [
    'python',
    'typescript',
    'prompt',
    'agent_basics',
    'rag',
    'tool_calling',
    'evaluation',
    'langgraph',
  ],
  clauses: {
    agent_basics: [{ all: ['prompt'] }],
    rag: [
      { all: ['python'], confidence: 0.9, because: 'ha02s01 检索代码用 Python 写' },
      { all: ['typescript'], confidence: 0.4 },
    ],
    tool_calling: [{ all: ['agent_basics', 'python'] }],
    evaluation: [{ all: ['agent_basics'] }],
    langgraph: [{ all: ['tool_calling'] }],
  },
};

const set = (...xs: string[]) => new Set(xs);

describe('前置判定：AND / OR 显式区分', () => {
  it('clause 内是 AND——差一项就不满足', () => {
    expect(prereqSatisfied(GRAPH, 'tool_calling', set('python'))).toBe(false);
    expect(prereqSatisfied(GRAPH, 'tool_calling', set('agent_basics'))).toBe(false);
    expect(prereqSatisfied(GRAPH, 'tool_calling', set('agent_basics', 'python'))).toBe(true);
  });

  it('clause 之间是 OR——两条路各自都够', () => {
    expect(prereqSatisfied(GRAPH, 'rag', set('python'))).toBe(true);
    expect(prereqSatisfied(GRAPH, 'rag', set('typescript'))).toBe(true);
    expect(prereqSatisfied(GRAPH, 'rag', set())).toBe(false);
  });

  it('没有 clause 的项无前置', () => {
    expect(prereqSatisfied(GRAPH, 'python', set())).toBe(true);
  });
});

describe('outer fringe：可学的下一个', () => {
  it('缺口 ∩ 前置已满足', () => {
    expect(outerFringe(GRAPH, set('python', 'prompt'))).toEqual([
      'agent_basics',
      'rag',
      'typescript',
    ]);
  });

  it('OR 前置不会凭空多算前置链——会 Python 就能学 rag，不必先学 TS', () => {
    expect(outerFringe(GRAPH, set('python'))).toContain('rag');
  });

  it('空状态下只有无前置项', () => {
    expect(outerFringe(GRAPH, set())).toEqual(['prompt', 'python', 'typescript']);
  });
});

describe('inner fringe：刚学会的、最该复习的', () => {
  it('拿掉仍是合法状态的才算刚学会——被依赖的项不算', () => {
    const known = set('python', 'prompt', 'agent_basics');
    // prompt 被 agent_basics 依赖，拿掉它状态就不闭 → 不是「刚学会」
    expect(innerFringe(GRAPH, known)).toEqual(['agent_basics', 'python']);
  });

  it('复习候选集就是 inner fringe，不另造', () => {
    const known = set('python', 'prompt', 'agent_basics');
    expect(reviewCandidates(GRAPH, known)).toEqual(innerFringe(GRAPH, known));
  });

  it('空状态没有复习候选', () => {
    expect(innerFringe(GRAPH, set())).toEqual([]);
  });

  it('K 不是合法状态时仍出候选——掌握度向量不做闭包，这是常态不是异常', () => {
    // 引擎的 mastery_vector 可以给出「agent_basics 0.9 而它的前置 prompt 只有 0.5」。
    // 照 KST 原式验 K\{q} 是否闭，这种 K 会让 inner fringe 整个空掉、复习队列一条不出。
    const k = knowledgeState({ agent_basics: 0.9, evaluation: 0.9, prompt: 0.5 });
    expect([...k].sort()).toEqual(['agent_basics', 'evaluation']);
    // evaluation 没人依赖 → 进；agent_basics 被 evaluation 依赖（且这条依赖在 K 内成立）→ 不进。
    expect(innerFringe(GRAPH, k)).toEqual(['evaluation']);
  });
});

describe('layer：距当前状态的图距离（不是绝对难度标注）', () => {
  const depth = layers(GRAPH, set('python', 'prompt'));

  it('状态内 0，outer fringe 1，再往外递增', () => {
    expect(depth.get('python')).toBe(0);
    expect(depth.get('agent_basics')).toBe(1);
    expect(depth.get('tool_calling')).toBe(2);
    expect(depth.get('langgraph')).toBe(3);
  });

  it('同一个概念对不同人不在同一层——这就是「相对」的意思', () => {
    expect(layers(GRAPH, set('python', 'prompt', 'agent_basics')).get('tool_calling')).toBe(1);
  });

  it('前置成环 → 到不了，不出现在结果里（不会被当成 layer 1）', () => {
    const cyclic: PrereqGraph = {
      items: ['a', 'b'],
      clauses: { a: [{ all: ['b'] }], b: [{ all: ['a'] }] },
    };
    expect(layers(cyclic, set()).size).toBe(0);
  });
});

describe('三分带：>0.8 会 / <0.2 不会 / 中间 uncertain', () => {
  it('两个边界都是严格不等号', () => {
    expect(bandOf(0.81)).toBe('in');
    expect(bandOf(0.8)).toBe('uncertain'); // 边界：0.8 本身不算会
    expect(bandOf(0.2)).toBe('uncertain'); // 边界：0.2 本身不算不会
    expect(bandOf(0.19)).toBe('out');
    expect(bandOf(1)).toBe('in');
    expect(bandOf(0)).toBe('out');
  });

  it('uncertain 不计入状态——宁可当他不会', () => {
    expect([...knowledgeState({ a: 0.95, b: 0.8, c: 0.75, d: 0.1 })]).toEqual(['a']);
  });

  it('老口径 ≥0.7 会把 0.75 当成已会，三分带不会——这是纠正不是回归', () => {
    expect(knowledgeState({ tool_calling: 0.75 }).has('tool_calling')).toBe(false);
  });

  it('二元组入参与裸数字等价（引擎的 mastery_vector 是标量）', () => {
    expect([...knowledgeState({ a: { estimate: 0.95, confidence: 0.1 } })]).toEqual(['a']);
  });

  it('uncertain 走快速通道：目标分 3 而不是 5', () => {
    expect(targetScore('uncertain')).toBe(3);
    expect(targetScore('in')).toBe(5);
    expect(targetScore('out')).toBe(5);
  });
});

describe('目标成功率 0.75–0.85', () => {
  it('预测正确率 = p(1−s) + (1−p)g', () => {
    expect(predictedCorrect(0)).toBeCloseTo(0.25, 10); // 四选一蒙对下限
    expect(predictedCorrect(1)).toBeCloseTo(0.9, 10); // slip 0.1 的上限
    expect(predictedCorrect(0, { guess: 0.05 })).toBeCloseTo(0.05, 10); // 开放题
  });

  it('带内为 0，带外给距离', () => {
    expect(bandDistance(0.8)).toBe(0);
    expect(bandDistance(0.75)).toBe(0);
    expect(bandDistance(0.85)).toBe(0);
    expect(bandDistance(0.25)).toBeCloseTo(0.5, 10);
    expect(bandDistance(0.9)).toBeCloseTo(0.05, 10);
  });

  it('冷启动时这条键不区分候选（p=0 全部并列），排序落到 layer 上', () => {
    const picks = rankNext(GRAPH, { python: 1, prompt: 1 });
    expect(new Set(picks.map((p) => p.bandDistance)).size).toBe(1);
  });
});

describe('排序键的优先级', () => {
  const KNOWN = { python: 1, prompt: 1 };

  it('目标成功率是首键——压过前置度', () => {
    const picks = rankNext(GRAPH, { ...KNOWN, agent_basics: 0.5, rag: 0.8 });
    // agent_basics 解锁 2 个，rag 解锁 0 个；但 rag 的预测正确率 0.77 落在带内
    expect(unlockCount(GRAPH, 'agent_basics')).toBe(2);
    expect(unlockCount(GRAPH, 'rag')).toBe(0);
    expect(picks.map((p) => p.kc)).toEqual(['rag', 'agent_basics', 'typescript']);
    expect(picks[0].bandDistance).toBe(0);
  });

  it('前置度优先默认开，但在最末位；关掉就退回名字序', () => {
    expect(rankNext(GRAPH, KNOWN).map((p) => p.kc)).toEqual([
      'agent_basics', // 解锁 2
      'typescript', // 解锁 1
      'rag', // 解锁 0
    ]);
    expect(rankNext(GRAPH, KNOWN, { prereqPriority: false }).map((p) => p.kc)).toEqual([
      'agent_basics',
      'rag',
      'typescript',
    ]);
  });

  it('默认候选集是 outer fringe——前置没满足的不进候选', () => {
    expect(rankNext(GRAPH, KNOWN).map((p) => p.kc)).not.toContain('langgraph');
  });

  it('给整段路径排序时 layer 才起作用，且结果单调不降', () => {
    const picks = rankNext(GRAPH, KNOWN, {
      candidates: ['langgraph', 'tool_calling', 'agent_basics', 'evaluation'],
    });
    expect(picks.map((p) => p.layer)).toEqual([1, 2, 2, 3]);
    expect(picks[0].kc).toBe('agent_basics');
    expect(picks.at(-1)?.kc).toBe('langgraph');
  });

  it('layer 压过前置度：深一层的即使解锁更多也排后面', () => {
    const chain: PrereqGraph = {
      items: ['near', 'deep', 'x', 'y', 'z'],
      clauses: {
        deep: [{ all: ['near'] }],
        x: [{ all: ['deep'] }],
        y: [{ all: ['deep'] }],
        z: [{ all: ['deep'] }],
      },
    };
    expect(unlockCount(chain, 'deep')).toBeGreaterThan(unlockCount(chain, 'near'));
    const picks = rankNext(chain, {}, { candidates: ['deep', 'near'] });
    expect(picks.map((p) => p.kc)).toEqual(['near', 'deep']);
  });

  it('已在状态内的项不是「下一步」，从候选里剔掉', () => {
    const picks = rankNext(
      GRAPH,
      { ...KNOWN, agent_basics: 0.95 },
      {
        candidates: ['agent_basics', 'evaluation'],
      },
    );
    expect(picks.map((p) => p.kc)).toEqual(['evaluation']);
  });

  it('图上到不了的候选排最后，不冒充 layer 1', () => {
    const picks = rankNext(GRAPH, KNOWN, { candidates: ['rag', 'ghost'] });
    expect(picks.map((p) => p.kc)).toEqual(['rag', 'ghost']);
    expect(picks.at(-1)?.layer).toBeGreaterThan(1000);
  });
});
