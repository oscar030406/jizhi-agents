/**
 * 知识宇宙的合并与邻域计算。纯函数，不碰 WebGL——图上看不出的错都在这里钉：
 * 悬空边（3d-force-graph 会自己造个没有 type 的孤点顶上，看着像数据里真有）、
 * 概念内部代号直接上屏、课程挂不上概念时被悄悄丢掉、教材出处号解析歪了。
 */

import { describe, expect, it } from 'vitest';

import {
  combineUniverses,
  mergeKnowledgeUniverse,
  neighbourhood,
  parseSourceRefs,
  prerequisiteDirections,
  type EngineGraph,
  type UniverseLink,
} from '@/lib/knowledge/knowledge-universe';

const ENGINE: EngineGraph = {
  nodes: [
    {
      id: 'c:llm_basics',
      type: 'concept',
      label: 'llm_basics',
      group: 'stage-1',
      size: 6,
      nearest: [{ id: 'k:ha01s01#s1', weight: 0.812 }],
    },
    { id: 'c:rag', type: 'concept', label: 'rag', group: 'stage-2', size: 5 },
    { id: 'b:ha', type: 'textbook', label: 'hello-agents', group: 'ha', size: 12 },
    { id: 's:ha01s01', type: 'section', label: '第1章', group: 'ha', size: 3 },
    { id: 's:hl04s01', type: 'section', label: 'Happy-LLM 4.1', group: 'hl', size: 3 },
    { id: 's:hl04s02', type: 'section', label: 'Happy-LLM 4.2', group: 'hl', size: 3 },
    { id: 'k:ha01s01#s1', type: 'chunk', label: '第1章 开头', group: 'ha', size: 1 },
    { id: 'k:hl04s01#s1', type: 'chunk', label: '4.1 开头', group: 'hl', size: 1 },
  ],
  links: [
    { source: 'c:llm_basics', target: 'c:rag', type: 'prerequisite' },
    { source: 'b:ha', target: 's:ha01s01', type: 'contains' },
    { source: 's:ha01s01', target: 'k:ha01s01#s1', type: 'contains' },
    { source: 's:hl04s01', target: 'k:hl04s01#s1', type: 'contains' },
    { source: 's:ha01s01', target: 'c:llm_basics', type: 'covers' },
    { source: 'k:ha01s01#s1', target: 'k:hl04s01#s1', type: 'similar', weight: 0.734 },
    // 引擎多给了一条指向不存在节点的边（抽样砍块之后可能出现）
    { source: 's:ha01s01', target: 'k:nope#s9', type: 'contains' },
  ],
};

const INPUT = {
  courses: [
    { id: 'course-a', title: 'RAG 入门' },
    { id: 'course-b', title: '没挂上概念的课' },
  ],
  conceptOfCourse: { 'course-a': 'rag', 'course-b': null },
  statusOfConcept: { llm_basics: 'mastered' as const },
  curated: [
    {
      id: 'llm-intro',
      courseId: 'course-b',
      prereq: [],
      textbookRef: 'Happy-LLM 第 4 章 4.1 什么是 LLM（hl04s01）',
      status: 'live',
    },
    {
      id: 'rag-intro',
      courseId: 'course-a',
      prereq: ['llm-intro'],
      textbookRef: '库外教材，没有出处号',
      status: 'live',
    },
    // 没有课程 id 的规划节点：一条边都不该连
    { id: 'planned', courseId: null, prereq: ['rag-intro'], textbookRef: '（hl04s02）', status: 'planned' },
  ],
  projects: [{ id: 'proj-1', name: '动手做一个 RAG', courseIds: ['course-a', 'ghost-course'] }],
};

describe('parseSourceRefs', () => {
  it('抠出括号里的出处号，全角半角都认', () => {
    expect(parseSourceRefs('Happy-LLM 第 4 章（hl04s01）')).toEqual(['hl04s01']);
    expect(parseSourceRefs('AgentGuide (ag005)')).toEqual(['ag005']);
  });

  it('同章的段区间展开，位数按左侧补零', () => {
    expect(parseSourceRefs('（ha08s01–s03）')).toEqual(['ha08s01', 'ha08s02', 'ha08s03']);
  });

  it('跨章区间也展开', () => {
    expect(parseSourceRefs('（tu02–tu04）')).toEqual(['tu02', 'tu03', 'tu04']);
  });

  it('没有出处号就是空——库外教材一条边都不许连', () => {
    expect(parseSourceRefs('《Python编程：从入门到实践（第3版）》第 1–4 章')).toEqual([]);
    expect(parseSourceRefs(undefined)).toEqual([]);
  });
});

describe('mergeKnowledgeUniverse', () => {
  const graph = mergeKnowledgeUniverse(ENGINE, INPUT);

  it('每条边的两头都在节点表里', () => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.links.filter((l) => !ids.has(l.source) || !ids.has(l.target))).toEqual([]);
  });

  it('概念上屏用中文名，不是内部代号', () => {
    expect(graph.nodes.find((node) => node.id === 'c:llm_basics')?.label).toBe('大模型基础');
  });

  it('掌握度与最近块落到概念节点上', () => {
    const concept = graph.nodes.find((n) => n.id === 'c:llm_basics');
    expect(concept?.status).toBe('mastered');
    expect(concept?.nearest).toEqual([{ id: 'k:ha01s01#s1', weight: 0.812 }]);
    expect(graph.nodes.find((n) => n.id === 'c:rag')?.status).toBeUndefined();
  });

  it('课程都上图，挂不上概念的也不隐藏', () => {
    const courses = graph.nodes.filter((node) => node.type === 'course');
    expect(courses.map((node) => node.courseId).sort()).toEqual(['course-a', 'course-b']);
    expect(graph.links.filter((link) => link.type === 'teaches')).toEqual([
      { source: 'course:course-a', target: 'c:rag', type: 'teaches' },
    ]);
  });

  it('相近边带余弦，透传不改数', () => {
    expect(graph.links.filter((link) => link.type === 'similar')).toEqual([
      { source: 'k:ha01s01#s1', target: 'k:hl04s01#s1', type: 'similar', weight: 0.734 },
    ]);
  });

  it('取材边只连解析得出、且盘上真有的章节', () => {
    expect(graph.links.filter((link) => link.type === 'draws_on')).toEqual([
      { source: 'course:course-b', target: 's:hl04s01', type: 'draws_on' },
    ]);
  });

  it('课程先修只在两端都是已上线课时才连', () => {
    expect(graph.links.filter((link) => link.type === 'precedes')).toEqual([
      { source: 'course:course-b', target: 'course:course-a', type: 'precedes' },
    ]);
  });

  it('实操项目只连到课，不直连概念', () => {
    expect(graph.nodes.filter((n) => n.type === 'project').map((n) => n.label)).toEqual([
      '动手做一个 RAG',
    ]);
    // ghost-course 不在盘上，那一条不连
    expect(graph.links.filter((link) => link.type === 'practices')).toEqual([
      { source: 'project:proj-1', target: 'course:course-a', type: 'practices' },
    ]);
  });

  it('读数与节点表一致', () => {
    expect(graph.counts.nodes).toBe(graph.nodes.length);
    expect(graph.counts.links).toBe(graph.links.length);
    expect(graph.counts.byType).toEqual({
      concept: 2,
      textbook: 1,
      section: 3,
      chunk: 2,
      course: 2,
      project: 1,
    });
    expect(graph.counts.byLink).toEqual({
      prerequisite: 1,
      contains: 3,
      covers: 1,
      similar: 1,
      teaches: 1,
      draws_on: 1,
      precedes: 1,
      practices: 1,
    });
  });

  it('引擎没答上来时是空图，不是崩溃', () => {
    const empty = mergeKnowledgeUniverse(null, {
      courses: [],
      conceptOfCourse: {},
      statusOfConcept: {},
    });
    expect(empty.counts).toEqual({ nodes: 0, links: 0, byType: {}, byLink: {} });
  });
});

describe('全站视图', () => {
  it('加了库前缀就不会撞 id，读数是几个库之和', () => {
    const one = mergeKnowledgeUniverse(ENGINE, { ...INPUT, prefix: 'ai|', corpus: 'ai' });
    const two = mergeKnowledgeUniverse(ENGINE, {
      courses: [],
      conceptOfCourse: {},
      statusOfConcept: {},
      prefix: 'iotdb|',
      corpus: 'iotdb',
    });
    const all = combineUniverses([one, two]);
    expect(all.counts.nodes).toBe(one.counts.nodes + two.counts.nodes);
    expect(new Set(all.nodes.map((n) => n.id)).size).toBe(all.nodes.length);
    expect(all.nodes.find((n) => n.id === 'ai|c:rag')?.corpus).toBe('ai');
  });
});

describe('neighbourhood', () => {
  const links: UniverseLink[] = [
    { source: 'a', target: 'b', type: 'contains' },
    { source: 'b', target: 'c', type: 'contains' },
    { source: 'c', target: 'd', type: 'contains' },
    { source: 'a', target: 'z', type: 'similar' },
  ];

  it('两跳为止，起点是 0 跳', () => {
    const hops = neighbourhood(links, 'a', new Set(['contains', 'similar']));
    expect(Object.fromEntries(hops)).toEqual({ a: 0, b: 1, z: 1, c: 2 });
  });

  it('只走当前可见的边——关掉相近，就不该有点因为相近边亮起来', () => {
    const hops = neighbourhood(links, 'a', new Set(['contains']));
    expect(hops.has('z')).toBe(false);
  });
});

describe('prerequisiteDirections', () => {
  const links: UniverseLink[] = [
    { source: 'c:base', target: 'c:mid', type: 'prerequisite' },
    { source: 'c:mid', target: 'c:top', type: 'prerequisite' },
    { source: 'c:side', target: 'c:top', type: 'prerequisite' },
    { source: 'course:x', target: 'c:mid', type: 'teaches' },
  ];

  it('逆着前置边是先学的，顺着是学完可去的，跳数如实', () => {
    const { upstream, downstream } = prerequisiteDirections(links, 'c:mid');
    expect(Object.fromEntries(upstream)).toEqual({ 'c:base': 1 });
    expect(Object.fromEntries(downstream)).toEqual({ 'c:top': 1 });
  });

  it('只认 prerequisite，讲授边不算方向', () => {
    const { upstream } = prerequisiteDirections(links, 'c:mid');
    expect(upstream.has('course:x')).toBe(false);
  });

  it('多跳按最短距离', () => {
    const { upstream } = prerequisiteDirections(links, 'c:top');
    expect(Object.fromEntries(upstream)).toEqual({ 'c:mid': 1, 'c:side': 1, 'c:base': 2 });
  });
});
