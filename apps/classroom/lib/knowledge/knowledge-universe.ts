/**
 * 知识宇宙的图数据合并：引擎给的结构 + 学习端已经在手里的三样东西。
 *
 * 引擎那张图只有知识库自己的东西（概念、教材、章节、证据块）。课程和掌握度是
 * classroom 侧的数据，/path 那一页本来就各拉过一次，不再走一遍桥——纯函数在这里合，
 * 组件只管画。放在 lib 里也是为了能单测：合并逻辑出错（边指向不存在的点、概念名
 * 上屏成 llm_basics 这种内部代号）在 WebGL 画布上看不出来，得靠断言钉。
 */

import { conceptLabel } from '@/lib/knowledge/concept-labels';

export type UniverseNodeType = 'concept' | 'textbook' | 'section' | 'chunk' | 'course';
export type UniverseLinkType = 'prerequisite' | 'covers' | 'contains' | 'teaches';
export type ConceptStatus = 'mastered' | 'current' | 'future' | 'unmeasured';

export interface UniverseNode {
  id: string;
  type: UniverseNodeType;
  label: string;
  group: string;
  size: number;
  difficulty?: string;
  sourceId?: string;
  /** 概念节点专有：当前账户在这个概念上的状态，决定着色 */
  status?: ConceptStatus;
  /** 课程节点专有：点开跳 /classroom/<id> */
  courseId?: string;
}

export interface UniverseLink {
  source: string;
  target: string;
  type: UniverseLinkType;
}

export interface UniverseGraph {
  nodes: UniverseNode[];
  links: UniverseLink[];
  counts: {
    nodes: number;
    links: number;
    byType: Partial<Record<UniverseNodeType, number>>;
    byLink: Partial<Record<UniverseLinkType, number>>;
  };
}

/** 引擎 `/api/knowledge-graph/{corpus}` 的返回体里我们用到的部分。 */
export interface EngineGraph {
  nodes?: Array<{
    id: string;
    type: string;
    label?: string;
    group?: string;
    size?: number;
    difficulty?: string;
    sourceId?: string;
  }>;
  links?: Array<{ source: string; target: string; type: string }>;
}

export interface MergeInput {
  /** 本领域的课程（/api/course-domains 过滤后的那批） */
  courses: ReadonlyArray<{ id: string; title: string }>;
  /** courseId → 主概念 id（/api/course-path 汇总场景概念票的结论），null = 反推不出 */
  conceptOfCourse: Readonly<Record<string, string | null>>;
  /** 概念 id → 掌握状态（/api/domain-path 已经带回来了） */
  statusOfConcept: Readonly<Record<string, ConceptStatus | undefined>>;
}

const NODE_TYPES: ReadonlySet<string> = new Set([
  'concept',
  'textbook',
  'section',
  'chunk',
  'course',
]);
const LINK_TYPES: ReadonlySet<string> = new Set(['prerequisite', 'covers', 'contains', 'teaches']);

export function mergeKnowledgeUniverse(engine: EngineGraph | null, input: MergeInput): UniverseGraph {
  const nodes: UniverseNode[] = [];
  const ids = new Set<string>();

  for (const raw of engine?.nodes ?? []) {
    if (!raw?.id || !NODE_TYPES.has(raw.type) || ids.has(raw.id)) continue;
    const type = raw.type as UniverseNodeType;
    // 概念 id 是内部代号（llm_basics），上屏要换中文名；表里没有就原样，不编。
    const conceptId = type === 'concept' ? raw.id.slice(2) : '';
    ids.add(raw.id);
    nodes.push({
      id: raw.id,
      type,
      label: type === 'concept' ? conceptLabel(conceptId) : (raw.label ?? raw.id),
      group: raw.group ?? type,
      size: typeof raw.size === 'number' ? raw.size : 1,
      ...(raw.difficulty ? { difficulty: raw.difficulty } : {}),
      ...(raw.sourceId ? { sourceId: raw.sourceId } : {}),
      ...(type === 'concept' && input.statusOfConcept[conceptId]
        ? { status: input.statusOfConcept[conceptId] }
        : {}),
    });
  }

  const links: UniverseLink[] = [];
  for (const raw of engine?.links ?? []) {
    if (!raw || !LINK_TYPES.has(raw.type)) continue;
    if (!ids.has(raw.source) || !ids.has(raw.target)) continue;
    links.push({ source: raw.source, target: raw.target, type: raw.type as UniverseLinkType });
  }

  // 课程：挂不上概念的照样上图（一个孤点），不隐藏——课程墙那条同源纪律，
  // 少一门课比多一条错边更难解释。
  for (const course of input.courses) {
    const id = `course:${course.id}`;
    if (ids.has(id)) continue;
    ids.add(id);
    nodes.push({
      id,
      type: 'course',
      label: course.title,
      group: 'course',
      size: 5,
      courseId: course.id,
    });
    const concept = input.conceptOfCourse[course.id];
    if (concept && ids.has(`c:${concept}`)) {
      links.push({ source: id, target: `c:${concept}`, type: 'teaches' });
    }
  }

  const byType: Partial<Record<UniverseNodeType, number>> = {};
  for (const node of nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  const byLink: Partial<Record<UniverseLinkType, number>> = {};
  for (const link of links) byLink[link.type] = (byLink[link.type] ?? 0) + 1;

  return { nodes, links, counts: { nodes: nodes.length, links: links.length, byType, byLink } };
}
