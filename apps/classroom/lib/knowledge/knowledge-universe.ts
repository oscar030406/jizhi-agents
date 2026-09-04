/**
 * 知识宇宙的图数据合并：引擎给的结构 + 学习端已经在手里的几样东西。
 *
 * 引擎那张图只有知识库自己的东西（概念、教材、章节、证据块，以及块之间由向量算出来的
 * 「相近」边）。课程、实操项目、人工路径的先修关系是 classroom 侧的数据，/path 那一页
 * 本来就各拉过一次，不再走一遍桥——纯函数在这里合，组件只管画。
 *
 * 放在 lib 里也是为了能单测：合并逻辑出错（边指向不存在的点、概念名上屏成 llm_basics
 * 这种内部代号、教材出处解析歪了）在 WebGL 画布上看不出来，得靠断言钉。
 */

import { conceptLabel } from '@/lib/knowledge/concept-labels';

export type UniverseNodeType = 'concept' | 'textbook' | 'section' | 'chunk' | 'course' | 'project';
export type UniverseLinkType =
  | 'prerequisite'
  | 'covers'
  | 'contains'
  | 'teaches'
  | 'similar'
  | 'draws_on'
  | 'precedes'
  | 'practices';
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
  /** 概念节点专有：引擎按向量质心算出来的最近证据块 */
  nearest?: Array<{ id: string; weight: number }>;
  /** 课程节点专有：点开跳 /classroom/<id> */
  courseId?: string;
  /** 全站视图下这个点属于哪个库 */
  corpus?: string;
}

export interface UniverseLink {
  source: string;
  target: string;
  type: UniverseLinkType;
  /** similar 边专有：两段教材文字向量的余弦 */
  weight?: number;
}

export type LinkCounts = Partial<Record<UniverseLinkType, number>>;
export type NodeCounts = Partial<Record<UniverseNodeType, number>>;

export interface UniverseGraph {
  nodes: UniverseNode[];
  links: UniverseLink[];
  counts: { nodes: number; links: number; byType: NodeCounts; byLink: LinkCounts };
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
    nearest?: Array<{ id: string; weight: number }>;
  }>;
  links?: Array<{ source: string; target: string; type: string; weight?: number }>;
}

/** `data/learning-path.json` 里一个节点（人工策展的 AI 主线路径）。 */
export interface CuratedNode {
  id: string;
  courseId?: string | null;
  altCourseIds?: string[] | null;
  prereq?: string[];
  textbookRef?: string;
  status?: string;
}

export interface PracticeProjectRef {
  id: string;
  name: string;
  courseIds: string[];
}

export interface MergeInput {
  /** 本领域的课程（/api/course-domains 过滤后的那批） */
  courses: ReadonlyArray<{ id: string; title: string }>;
  /** courseId → 主概念 id（/api/course-path 汇总场景概念票的结论），null = 反推不出 */
  conceptOfCourse: Readonly<Record<string, string | null>>;
  /** 概念 id → 掌握状态（/api/domain-path 已经带回来了） */
  statusOfConcept: Readonly<Record<string, ConceptStatus | undefined>>;
  /** 人工策展路径的节点，只有 AI 主库有；用来连「取材」与课程先修 */
  curated?: ReadonlyArray<CuratedNode>;
  /** 已发布的实操项目 */
  projects?: ReadonlyArray<PracticeProjectRef>;
  /** 全站视图下给节点 id 加的库前缀（如 `ai|`），单库视图留空 */
  prefix?: string;
  /** 全站视图下这批点属于哪个库 */
  corpus?: string;
}

const NODE_TYPES: ReadonlySet<string> = new Set([
  'concept',
  'textbook',
  'section',
  'chunk',
  'course',
  'project',
]);
const LINK_TYPES: ReadonlySet<string> = new Set([
  'prerequisite',
  'covers',
  'contains',
  'teaches',
  'similar',
  'draws_on',
  'precedes',
  'practices',
]);

/**
 * 从 `textbookRef` 那段中文里把教材出处号抠出来。
 *
 * 这一栏是人写给人看的（「Happy-LLM 第 4 章 4.1 什么是 LLM（hl04s01）」），
 * 出处号写在括号里，可能是全角也可能是半角，可能是单个（hl04s01）、
 * 同章连续段（ha08s01–s02）、跨章连续（tu02–tu04），也可能根本没有——
 * 43 个节点里有一半引的是库外教材，那种一条边都不该连。**解析不出就返回空**，
 * 不猜：连错的取材边比没有取材边更难解释。
 */
export function parseSourceRefs(textbookRef: string | undefined): string[] {
  if (!textbookRef) return [];
  const out: string[] = [];
  for (const [, inner] of textbookRef.matchAll(/[（(]([^）)]*)[）)]/g)) {
    for (const token of inner.split(/[、,，/;；\s]+/)) {
      // 区间右端写法有两种：「ha08s01–s02」省掉前缀，「tu02–tu04」整个重写一遍
      const matched = /^([a-z]{2})(\d+)(?:s(\d+))?(?:[–—-](?:[a-z]{2})?(s?)(\d+))?$/.exec(
        token.trim(),
      );
      if (!matched) continue;
      const [, prefix, chapter, section, rangeIsSection, rangeEnd] = matched;
      if (!rangeEnd) {
        out.push(section ? `${prefix}${chapter}s${section}` : `${prefix}${chapter}`);
        continue;
      }
      // 「s01–s02」是同章的段区间，「02–04」是章区间；两种都按左侧的位数补零。
      const overSections = rangeIsSection === 's' || Boolean(section);
      const from = Number(overSections ? section : chapter);
      const to = Number(rangeEnd);
      const width = (overSections ? (section ?? '') : chapter).length;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 40) continue;
      for (let n = from; n <= to; n += 1) {
        const padded = String(n).padStart(width, '0');
        out.push(overSections ? `${prefix}${chapter}s${padded}` : `${prefix}${padded}`);
      }
    }
  }
  return [...new Set(out)];
}

export function mergeKnowledgeUniverse(
  engine: EngineGraph | null,
  input: MergeInput,
): UniverseGraph {
  const prefix = input.prefix ?? '';
  const key = (id: string) => `${prefix}${id}`;
  const nodes: UniverseNode[] = [];
  const ids = new Set<string>();

  for (const raw of engine?.nodes ?? []) {
    if (!raw?.id || !NODE_TYPES.has(raw.type) || ids.has(key(raw.id))) continue;
    const type = raw.type as UniverseNodeType;
    // 概念 id 是内部代号（llm_basics），上屏要换中文名；表里没有就原样，不编。
    const conceptId = type === 'concept' ? raw.id.slice(2) : '';
    ids.add(key(raw.id));
    nodes.push({
      id: key(raw.id),
      type,
      label: type === 'concept' ? conceptLabel(conceptId) : (raw.label ?? raw.id),
      group: raw.group ?? type,
      size: typeof raw.size === 'number' ? raw.size : 1,
      ...(raw.difficulty ? { difficulty: raw.difficulty } : {}),
      ...(raw.sourceId ? { sourceId: raw.sourceId } : {}),
      ...(input.corpus ? { corpus: input.corpus } : {}),
      ...(raw.nearest?.length
        ? { nearest: raw.nearest.map((item) => ({ id: key(item.id), weight: item.weight })) }
        : {}),
      ...(type === 'concept' && input.statusOfConcept[conceptId]
        ? { status: input.statusOfConcept[conceptId] }
        : {}),
    });
  }

  const links: UniverseLink[] = [];
  const push = (source: string, target: string, type: UniverseLinkType, weight?: number) => {
    if (!ids.has(source) || !ids.has(target) || source === target) return;
    links.push({ source, target, type, ...(weight === undefined ? {} : { weight }) });
  };

  for (const raw of engine?.links ?? []) {
    if (!raw || !LINK_TYPES.has(raw.type)) continue;
    push(key(raw.source), key(raw.target), raw.type as UniverseLinkType, raw.weight);
  }

  // 课程：挂不上概念的照样上图（一个孤点），不隐藏——课程墙那条同源纪律，
  // 少一门课比多一条错边更难解释。
  for (const course of input.courses) {
    const id = key(`course:${course.id}`);
    if (ids.has(id)) continue;
    ids.add(id);
    nodes.push({
      id,
      type: 'course',
      label: course.title,
      group: 'course',
      size: 5,
      courseId: course.id,
      ...(input.corpus ? { corpus: input.corpus } : {}),
    });
  }
  for (const course of input.courses) {
    const concept = input.conceptOfCourse[course.id];
    if (concept) push(key(`course:${course.id}`), key(`c:${concept}`), 'teaches');
  }

  // 人工路径：取材（课 → 章节）与课程先修（课 → 课）。两头都得是盘上真有的点，
  // planned/blocked 的节点没有课程 id，自然连不上，也不该连——它还不是资源。
  const courseOfCuratedNode = new Map<string, string>();
  for (const node of input.curated ?? []) {
    const courseId = node.courseId ?? node.altCourseIds?.[0];
    if (courseId && ids.has(key(`course:${courseId}`))) courseOfCuratedNode.set(node.id, courseId);
  }
  for (const node of input.curated ?? []) {
    const courseId = courseOfCuratedNode.get(node.id);
    if (!courseId) continue;
    for (const sourceId of parseSourceRefs(node.textbookRef)) {
      push(key(`course:${courseId}`), key(`s:${sourceId}`), 'draws_on');
    }
    for (const prereqNode of node.prereq ?? []) {
      const before = courseOfCuratedNode.get(prereqNode);
      if (before) push(key(`course:${before}`), key(`course:${courseId}`), 'precedes');
    }
  }

  // 实操项目：只连到课，不直接连概念——项目对口的是课，概念是隔着课推出来的，
  // 画一条直连边等于把推断说成数据。
  for (const project of input.projects ?? []) {
    const linked = project.courseIds.filter((courseId) => ids.has(key(`course:${courseId}`)));
    if (!linked.length) continue;
    const id = key(`project:${project.id}`);
    if (!ids.has(id)) {
      ids.add(id);
      nodes.push({
        id,
        type: 'project',
        label: project.name,
        group: 'project',
        size: 6,
        ...(input.corpus ? { corpus: input.corpus } : {}),
      });
    }
    for (const courseId of linked) push(id, key(`course:${courseId}`), 'practices');
  }

  return withCounts(nodes, links);
}

function withCounts(nodes: UniverseNode[], links: UniverseLink[]): UniverseGraph {
  const byType: NodeCounts = {};
  for (const node of nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  const byLink: LinkCounts = {};
  for (const link of links) byLink[link.type] = (byLink[link.type] ?? 0) + 1;
  return { nodes, links, counts: { nodes: nodes.length, links: links.length, byType, byLink } };
}

/** 全站视图：几个库各自合好之后拼成一张图。id 已经带库前缀，不会撞。 */
export function combineUniverses(graphs: ReadonlyArray<UniverseGraph>): UniverseGraph {
  return withCounts(
    graphs.flatMap((graph) => graph.nodes),
    graphs.flatMap((graph) => graph.links),
  );
}

/**
 * 点开一个点之后的邻域：沿**当前可见的边**广搜两跳，返回 id → 跳数。
 *
 * 只走可见边是要紧的：把「相近」关掉之后，高亮还按相近边扩散，屏幕上就会亮起
 * 一批看不见连线的点，读者无从解释它们为什么亮。
 */
export function neighbourhood(
  links: ReadonlyArray<UniverseLink>,
  startId: string,
  visible: ReadonlySet<UniverseLinkType>,
  maxHops = 2,
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    if (!visible.has(link.type)) continue;
    (adjacency.get(link.source) ?? adjacency.set(link.source, []).get(link.source)!).push(
      link.target,
    );
    (adjacency.get(link.target) ?? adjacency.set(link.target, []).get(link.target)!).push(
      link.source,
    );
  }
  const hops = new Map<string, number>([[startId, 0]]);
  let frontier = [startId];
  for (let hop = 1; hop <= maxHops; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (hops.has(neighbour)) continue;
        hops.set(neighbour, hop);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return hops;
}

/**
 * 概念的前置方向：沿 prerequisite 边**逆着**走是先学的，顺着走是学完可去的。
 * 引擎那边的边方向是 前置 → 后继，这里不重新定义方向，只分两边。
 */
export function prerequisiteDirections(
  links: ReadonlyArray<UniverseLink>,
  conceptId: string,
): { upstream: Map<string, number>; downstream: Map<string, number> } {
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const link of links) {
    if (link.type !== 'prerequisite') continue;
    (after.get(link.source) ?? after.set(link.source, []).get(link.source)!).push(link.target);
    (before.get(link.target) ?? before.set(link.target, []).get(link.target)!).push(link.source);
  }
  const walk = (adjacency: Map<string, string[]>) => {
    const hops = new Map<string, number>();
    let frontier = [conceptId];
    for (let hop = 1; frontier.length && hop <= 8; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbour of adjacency.get(id) ?? []) {
          if (neighbour === conceptId || hops.has(neighbour)) continue;
          hops.set(neighbour, hop);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
    return hops;
  };
  return { upstream: walk(before), downstream: walk(after) };
}
