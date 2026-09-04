/**
 * 知识宇宙的合并函数。纯函数，不碰 WebGL——图上看不出的错都在这里钉：
 * 悬空边（3d-force-graph 会自己造个没有 type 的孤点顶上，看着像数据里真有）、
 * 概念内部代号直接上屏、课程挂不上概念时被悄悄丢掉。
 */

import { describe, expect, it } from 'vitest';

import { mergeKnowledgeUniverse, type EngineGraph } from '@/lib/knowledge/knowledge-universe';

const ENGINE: EngineGraph = {
  nodes: [
    { id: 'c:llm_basics', type: 'concept', label: 'llm_basics', group: 'stage-1', size: 6 },
    { id: 'c:rag', type: 'concept', label: 'rag', group: 'stage-2', size: 5 },
    { id: 'b:ha', type: 'textbook', label: 'hello-agents', group: 'ha', size: 12 },
    { id: 's:ha01s01', type: 'section', label: '第1章', group: 'ha', size: 3 },
    { id: 'k:ha01s01#s1', type: 'chunk', label: '第1章 开头', group: 'ha', size: 1 },
  ],
  links: [
    { source: 'c:llm_basics', target: 'c:rag', type: 'prerequisite' },
    { source: 'b:ha', target: 's:ha01s01', type: 'contains' },
    { source: 's:ha01s01', target: 'k:ha01s01#s1', type: 'contains' },
    { source: 's:ha01s01', target: 'c:llm_basics', type: 'covers' },
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
};

describe('mergeKnowledgeUniverse', () => {
  const graph = mergeKnowledgeUniverse(ENGINE, INPUT);

  it('每条边的两头都在节点表里', () => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.links.filter((l) => !ids.has(l.source) || !ids.has(l.target))).toEqual([]);
  });

  it('概念上屏用中文名，不是内部代号', () => {
    const concept = graph.nodes.find((node) => node.id === 'c:llm_basics');
    expect(concept?.label).toBe('大模型基础');
  });

  it('掌握度落到概念节点上', () => {
    expect(graph.nodes.find((n) => n.id === 'c:llm_basics')?.status).toBe('mastered');
    expect(graph.nodes.find((n) => n.id === 'c:rag')?.status).toBeUndefined();
  });

  it('课程都上图，挂不上概念的也不隐藏', () => {
    const courses = graph.nodes.filter((node) => node.type === 'course');
    expect(courses.map((node) => node.courseId).sort()).toEqual(['course-a', 'course-b']);
    expect(graph.links.filter((link) => link.type === 'teaches')).toEqual([
      { source: 'course:course-a', target: 'c:rag', type: 'teaches' },
    ]);
  });

  it('读数与节点表一致', () => {
    expect(graph.counts.nodes).toBe(graph.nodes.length);
    expect(graph.counts.links).toBe(graph.links.length);
    expect(graph.counts.byType).toEqual({
      concept: 2,
      textbook: 1,
      section: 1,
      chunk: 1,
      course: 2,
    });
    expect(graph.counts.byLink).toEqual({ prerequisite: 1, contains: 2, covers: 1, teaches: 1 });
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
