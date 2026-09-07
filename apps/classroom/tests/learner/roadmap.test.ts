import { describe, expect, it } from 'vitest';

import { buildRoadmap, type RoadmapInputNode } from '@/lib/learner/roadmap';

/** 引擎 domain-path 的一小段：3 阶 5 个概念，前置边照 AI 库的形状写。 */
function nodes(overrides: Partial<Record<string, Partial<RoadmapInputNode>>> = {}) {
  const base: RoadmapInputNode[] = [
    { id: 'llm_basics', label: '大模型基础', stage: 1, prereq: [], courses: [] },
    { id: 'prompt', label: '提示工程', stage: 1, prereq: ['llm_basics'], courses: [] },
    {
      id: 'rag',
      label: '检索增强生成',
      stage: 2,
      prereq: ['prompt'],
      courses: [{ id: 'c-rag', title: 'RAG 实战' }],
    },
    { id: 'agent', label: '智能体编排', stage: 3, prereq: ['rag'], courses: [] },
    { id: 'eval', label: '效果评估', stage: 3, prereq: ['agent', '域外概念'], courses: [] },
  ];
  return base.map((node) => ({ ...node, ...(overrides[node.id] ?? {}) }));
}

const stages = [
  { index: 1, title: '第一阶 · 打底' },
  { index: 2, title: '第二阶 · 接地' },
  { index: 3, title: '第三阶 · 落地' },
];

describe('线性路线图的站点整理', () => {
  it('正常：顺序照阶次，游标停在引擎点名的当前推荐，future 按前置拆成先学/学完可去', () => {
    const roadmap = buildRoadmap(
      nodes({
        llm_basics: { status: 'mastered', mastery: 0.91 },
        prompt: { status: 'current', mastery: 0.42 },
        rag: { status: 'future', mastery: 0.1 },
        agent: { status: 'future' },
        eval: { status: 'future' },
      }),
      stages,
    );

    expect(roadmap.stations.map((s) => s.id)).toEqual([
      'llm_basics',
      'prompt',
      'rag',
      'agent',
      'eval',
    ]);
    expect(roadmap.stations.map((s) => s.status)).toEqual([
      'mastered',
      'current',
      'blocked', // 前置 prompt 还没达标
      'blocked', // 前置 rag 还没达标
      'blocked',
    ]);
    // 路径之外的前置（`域外概念`）不算数：说不出它在线上哪一站，就不拿它解释卡点
    expect(roadmap.stations[4].blockedBy).toEqual(['智能体编排']);
    expect(roadmap.cursor).toBe(1);
    expect(roadmap.measured).toBe(true);
    expect(roadmap.counts).toEqual({
      mastered: 1,
      current: 1,
      blocked: 3,
      ready: 0,
      unmeasured: 0,
    });

    // 阶次标题与分隔：每阶第一站才带标题
    expect(roadmap.stations.map((s) => s.stageHead)).toEqual([true, false, true, true, false]);
    expect(roadmap.stations[2].stageTitle).toBe('第二阶 · 接地');
    expect(roadmap.stations[2].courses).toHaveLength(1);
  });

  it('前置都掌握了的后续站是「学完可去」，不是「先学」', () => {
    const roadmap = buildRoadmap(
      nodes({
        llm_basics: { status: 'mastered', mastery: 0.9 },
        prompt: { status: 'mastered', mastery: 0.88 },
        rag: { status: 'future', mastery: 0.2 },
        agent: { status: 'future' },
        eval: { status: 'future' },
      }),
      stages,
    );
    expect(roadmap.stations[2].status).toBe('ready');
    expect(roadmap.stations[3].status).toBe('blocked');
    // 引擎没点名 current 时，游标落在第一个还没掌握的站
    expect(roadmap.cursor).toBe(2);
  });

  it('缺掌握度：没有 status 也没有 mastery 时整条线是「未测」，游标停在第一站', () => {
    const roadmap = buildRoadmap(nodes(), stages);

    expect(roadmap.stations.every((s) => s.status === 'unmeasured')).toBe(true);
    expect(roadmap.stations.every((s) => s.mastery === null)).toBe(true);
    expect(roadmap.measured).toBe(false);
    expect(roadmap.cursor).toBe(0);
    expect(roadmap.counts.unmeasured).toBe(5);
    // 阶次标题缺失时兜底成「第 n 阶」，不编一个名字
    expect(buildRoadmap(nodes()).stations[2].stageTitle).toBe('第 2 阶');
  });

  it('空路径：没有站点，游标 -1，计数全零', () => {
    const roadmap = buildRoadmap([], []);
    expect(roadmap.stations).toEqual([]);
    expect(roadmap.cursor).toBe(-1);
    expect(roadmap.measured).toBe(false);
    expect(roadmap.counts).toEqual({
      mastered: 0,
      current: 0,
      blocked: 0,
      ready: 0,
      unmeasured: 0,
    });
  });

  it('全部掌握时没有待推进的站；mastery 过线也算掌握，不必等 status', () => {
    const roadmap = buildRoadmap(
      nodes({
        llm_basics: { mastery: 0.95 },
        prompt: { mastery: 0.8 },
        rag: { mastery: 0.7 },
        agent: { mastery: 0.71 },
        eval: { status: 'mastered' },
      }),
      stages,
    );
    expect(roadmap.stations.every((s) => s.status === 'mastered')).toBe(true);
    expect(roadmap.cursor).toBe(-1);
  });

  it('乱序输入按阶次排回去，重复概念只留第一次出现的那一站', () => {
    const roadmap = buildRoadmap(
      [
        { id: 'b', label: 'B', stage: 3, prereq: [], courses: [] },
        { id: 'a', label: 'A', stage: 1, prereq: [], courses: [] },
        { id: 'a', label: 'A（重复）', stage: 2, prereq: [], courses: [] },
        { id: 'c', label: 'C', stage: 1, prereq: [], courses: [] },
      ],
      [],
    );
    expect(roadmap.stations.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(roadmap.stations[0].label).toBe('A');
    expect(roadmap.stations.map((s) => s.stage)).toEqual([1, 1, 3]);
  });
});
