'use client';

/**
 * 知识宇宙：这个知识库有什么、彼此怎么连，一屏看完。
 *
 * 前置图（concept-graph.tsx）画的是概念之间的顺序，AI 库 11 个点、智能制造 66 个点，
 * 一屏看下来只知道"有这么几个概念"。可库里真正的东西在概念底下：10 本教材、388 篇
 * 章节、1752 个证据块，还有课程、实操项目。这张图把它们一起摆出来。
 *
 * ## 图上的关系分两种，别混
 *
 * - **可量化的**：`similar`（相近）是两段教材原文向量的余弦，引擎算的，带数；
 *   概念节点上的 `nearest` 同理。
 * - **盘上现成的**：前置/覆盖/包含来自知识库产物，取材/先修/配套实操来自
 *   `data/learning-path.json` 与已发布的实操项目。
 *
 * **力导向的位置两者都不是**。两个点挨得近只说明布局把它们摆一起了，侧栏那句
 * 解释就是专门说这件事的，别删。
 *
 * ## 三条实现上的约束
 *
 * - **`3d-force-graph` 与 `three` 在 effect 里动态 import**。它们在模块顶层就要
 *   `document`，静态 import 会让 /path 整页 SSR 崩掉。
 * - **不往 React state 里塞每帧的东西**。相机每帧都在动，标签位置也在动；标签是
 *   rAF 里直接写 DOM 的，不走 setState。
 * - **同一个 corpus 只请求一次**（模块级 `GRAPH_CACHE`）。两千个点的图重复拉没意义。
 *
 * 面板内部固定深色，站点主题不跟着变——星空底是这张图能读的前提，浅色底上
 * 两千个半透明点全糊成一片灰。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, Sparkles, X } from 'lucide-react';

import { usePublishedPractice } from '@/components/skills/practice-projects';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import {
  combineUniverses,
  mergeKnowledgeUniverse,
  neighbourhood,
  prerequisiteDirections,
  type ConceptStatus,
  type CuratedNode,
  type EngineGraph,
  type UniverseGraph,
  type UniverseLinkType,
  type UniverseNode,
  type UniverseNodeType,
} from '@/lib/knowledge/knowledge-universe';

/** 引擎那张图按库缓存：同一个 corpus 一个会话里只拉一次。 */
const GRAPH_CACHE = new Map<string, { graph: EngineGraph; curated?: CuratedNode[] }>();

const NODE_TYPE_LABEL: Record<UniverseNodeType, string> = {
  concept: '概念',
  textbook: '教材',
  section: '章节',
  chunk: '证据块',
  course: '课程',
  project: '实操项目',
};

const LINK_TYPE_LABEL: Record<UniverseLinkType, string> = {
  prerequisite: '前置',
  covers: '覆盖',
  contains: '包含',
  teaches: '讲授',
  similar: '相近',
  draws_on: '取材',
  precedes: '先修',
  practices: '配套实操',
};

/**
 * 面板内固定深色，不跟站点主题。
 *
 * 颜色偏亮是因为点是**加法混合**画的：贴图是白色的径向渐变，颜色由材质相乘，
 * 叠在一起会往白里走。按普通实色去挑（#39456b 那一档）在加法混合下几乎看不见。
 */
const COLOR = {
  bg: '#080b16',
  chunk: '#b9c6e8',
  section: '#38bdf8',
  textbook: '#fbbf24',
  course: '#4ade80',
  project: '#fb923c',
  mastered: '#7dd3fc',
  current: '#e9d5ff',
  unmeasured: '#a78bfa',
  hit: '#fde047',
  focus: '#ffffff',
  upstream: '#fbbf24',
  downstream: '#22d3ee',
};

/** 全站视图下按库上色，三团才分得开。 */
const CORPUS_TINT: Record<string, string> = {
  ai: '#a78bfa',
  'smart-manufacturing': '#2dd4bf',
  iotdb: '#fbbf24',
};

/**
 * 边色。`similar` 的 alpha 写在色里：three-forcegraph 的边不透明度是
 * `linkOpacity × 色的 alpha`，全局 0.25 × 0.72 ≈ 0.18——相近边最多，
 * 和别的边同亮度会把整张图糊成一张网。
 */
const LINK_COLOR: Record<UniverseLinkType, string> = {
  prerequisite: '#e9d5ff',
  covers: '#7b8cc0',
  contains: '#4a5578',
  teaches: '#4ade80',
  similar: 'rgba(45,212,191,0.72)',
  draws_on: '#38bdf8',
  precedes: '#4ade80',
  practices: '#fb923c',
};

const NODE_ORDER: UniverseNodeType[] = [
  'concept',
  'textbook',
  'section',
  'chunk',
  'course',
  'project',
];
const LINK_ORDER: UniverseLinkType[] = [
  'prerequisite',
  'covers',
  'contains',
  'teaches',
  'similar',
  'draws_on',
  'precedes',
  'practices',
];

/**
 * 概念标签常驻——这一页是学习路径，概念名不该要人先去勾一个开关才看得见。
 * 教材与课程的标签跟着「显示标签」走，其余（两千个证据块）永远只在悬停时给，
 * 标题同时上屏就是一团墨。
 */
const ALWAYS_LABELLED: ReadonlySet<UniverseNodeType> = new Set(['concept']);
const OPTIONAL_LABELLED: ReadonlySet<UniverseNodeType> = new Set([
  'textbook',
  'course',
  'project',
]);

/**
 * 一张白色的径向渐变贴图：中间实心是核，外圈渐隐是晕。核与晕做进同一张图，
 * 一个点就只要一个 Sprite——两千个点各挂两个精灵是四千次 draw call，集显上直接掉帧。
 */
function glowTexture(THREE: typeof import('three')) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.14, 'rgba(255,255,255,0.92)');
    gradient.addColorStop(0.32, 'rgba(255,255,255,0.26)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

/** 按比例压暗一个 #rrggbb；高亮时非邻域的点靠它退到背景里。 */
function dimmed(hex: string, factor: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return hex;
  const channel = (shift: number) =>
    Math.max(0, Math.min(255, Math.round(((value >> shift) & 255) * factor)));
  return `#${[16, 8, 0].map((s) => channel(s).toString(16).padStart(2, '0')).join('')}`;
}

function baseColor(node: UniverseNode, wholeSite: boolean): string {
  if (wholeSite && (node.type === 'chunk' || node.type === 'section') && node.corpus) {
    return CORPUS_TINT[node.corpus] ?? COLOR.chunk;
  }
  switch (node.type) {
    case 'concept':
      if (node.status === 'mastered') return COLOR.mastered;
      if (node.status === 'current') return COLOR.current;
      return COLOR.unmeasured;
    case 'textbook':
      return COLOR.textbook;
    case 'course':
      return COLOR.course;
    case 'project':
      return COLOR.project;
    case 'section':
      return COLOR.section;
    default:
      return COLOR.chunk;
  }
}

/** 图里跑的点/边对象：库会往上写 x/y/z，也会把 source/target 换成节点对象。 */
type RtNode = UniverseNode & { x?: number; y?: number; z?: number };
type RtLink = {
  source: string | RtNode;
  target: string | RtNode;
  type: UniverseLinkType;
  weight?: number;
  sid: string;
  tid: string;
};

/** 一次高亮：每个点该用什么颜色、压暗到几成。不在表里的点按原色满亮。 */
type Highlight = { colors: Map<string, string>; dims: Map<string, number> } | null;

export interface KnowledgeUniverseProps {
  corpus: string;
  courses: ReadonlyArray<{ id: string; title: string }>;
  conceptOfCourse: Readonly<Record<string, string | null>>;
  statusOfConcept: Readonly<Record<string, ConceptStatus | undefined>>;
  onDraft?: (conceptLabel: string) => void;
}

async function fetchGraph(corpus: string) {
  const cached = GRAPH_CACHE.get(corpus);
  if (cached) return cached;
  const res = await fetch(`/api/knowledge-graph/${encodeURIComponent(corpus)}`, {
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    graph?: EngineGraph;
    curated?: CuratedNode[];
    error?: string;
  } | null;
  if (!res.ok || !body?.success || !body.graph) {
    throw new Error(body?.error ?? '知识库图谱服务暂时不可用。');
  }
  const entry = { graph: body.graph, curated: body.curated };
  GRAPH_CACHE.set(corpus, entry);
  return entry;
}

export function KnowledgeUniverse({
  corpus,
  courses,
  conceptOfCourse,
  statusOfConcept,
  onDraft,
}: KnowledgeUniverseProps) {
  const [scope, setScope] = useState<'corpus' | 'site'>('corpus');
  const [loaded, setLoaded] = useState<Record<string, { graph: EngineGraph; curated?: CuratedNode[] }>>(
    {},
  );
  const [siteCorpora, setSiteCorpora] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeTypes, setNodeTypes] = useState<ReadonlySet<UniverseNodeType>>(
    () => new Set(NODE_ORDER),
  );
  const [linkTypes, setLinkTypes] = useState<ReadonlySet<UniverseLinkType>>(
    () => new Set(LINK_ORDER),
  );
  const [showLabels, setShowLabels] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const practice = usePublishedPractice(corpus);
  const projects = useMemo(
    () =>
      practice.kind === 'ready'
        ? practice.projects.map((p) => ({ id: p.id, name: p.name, courseIds: p.courseIds }))
        : [],
    [practice],
  );

  useEffect(() => {
    let alive = true;
    fetchGraph(corpus)
      .then((entry) => {
        if (alive) setLoaded((prev) => ({ ...prev, [corpus]: entry }));
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : '知识库图谱服务暂时不可用。');
      });
    return () => {
      alive = false;
    };
  }, [corpus]);

  // 全站视图：库的名单走 /api/domains，它已经按机构可见性过滤过；这里不自己判可见性，
  // 每个库的图也照旧走各自的桥（桥上有 requireCorpusVisible），不绕闸。
  useEffect(() => {
    if (scope !== 'site' || siteCorpora) return;
    let alive = true;
    fetch('/api/domains')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { entries?: Record<string, unknown> } | null) => {
        if (!alive) return;
        setSiteCorpora(Object.keys(data?.entries ?? {}));
      })
      .catch(() => {
        if (alive) setSiteCorpora([corpus]);
      });
    return () => {
      alive = false;
    };
  }, [scope, siteCorpora, corpus]);

  useEffect(() => {
    if (scope !== 'site' || !siteCorpora) return;
    let alive = true;
    for (const name of siteCorpora) {
      if (loaded[name]) continue;
      void fetchGraph(name)
        .then((entry) => {
          if (alive) setLoaded((prev) => ({ ...prev, [name]: entry }));
        })
        .catch(() => {
          /* 单个库拿不到就少一团，其余照画；桥那边已经如实记了日志 */
        });
    }
    return () => {
      alive = false;
    };
  }, [scope, siteCorpora, loaded]);

  const wholeSite = scope === 'site';
  const graph: UniverseGraph = useMemo(() => {
    const names = wholeSite ? (siteCorpora ?? [corpus]) : [corpus];
    const merged = names
      .filter((name) => loaded[name])
      .map((name) =>
        mergeKnowledgeUniverse(loaded[name].graph, {
          // 课程/项目/人工路径只有当前领域这一份，别的库如实空着
          courses: name === corpus ? courses : [],
          conceptOfCourse: name === corpus ? conceptOfCourse : {},
          statusOfConcept: name === corpus ? statusOfConcept : {},
          curated: name === corpus ? loaded[name].curated : undefined,
          projects: name === corpus ? projects : [],
          ...(wholeSite ? { prefix: `${name}|`, corpus: name } : {}),
        }),
      );
    return merged.length === 1 ? merged[0] : combineUniverses(merged);
  }, [
    wholeSite,
    siteCorpora,
    corpus,
    loaded,
    courses,
    conceptOfCourse,
    statusOfConcept,
    projects,
  ]);

  // 点/边对象只造一次：过滤时复用同一批引用，力导向算好的坐标才不会每次归零重排。
  //
  // 全站视图下再给每个库一个不同的起始位置：三个库之间一条边都没有，力导向只会被
  // forceCenter 拉向同一个原点，三团从同一处铺开就叠成一坨，看不出是三个库。
  // 分开撒点之后各自在自己那片收敛（forceCenter 只做整体平移，不改相对位置）。
  const runtime = useMemo(() => {
    const corpora = [...new Set(graph.nodes.map((node) => node.corpus).filter(Boolean))];
    const seen = new Map<string, number>();
    /**
     * 每个库一个中心，库内的点按黄金角螺旋撒在中心周围。
     * **不能把一个库的点全撒在同一个坐标上**：几百个点重合时斥力是无穷大，
     * 一开跑就炸开，实测半径中位数上万、相机退到四万开外，屏幕上只剩几粒尘。
     */
    const seedOf = (corpus: string | undefined) => {
      const index = corpus ? corpora.indexOf(corpus) : -1;
      if (index < 0 || corpora.length < 2) return {};
      const angle = (index / corpora.length) * Math.PI * 2;
      const rank = (seen.get(corpus!) ?? 0) + 1;
      seen.set(corpus!, rank);
      const spin = rank * 2.39996; // 黄金角，撒得均匀不成条纹
      const spread = 12 * Math.sqrt(rank);
      return {
        x: Math.cos(angle) * 900 + Math.cos(spin) * spread,
        y: Math.sin(angle) * 900 + Math.sin(spin) * spread,
        z: (rank % 17) * 6 - 48,
      };
    };
    const nodes: RtNode[] = graph.nodes.map((node) => ({ ...node, ...seedOf(node.corpus) }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links: RtLink[] = graph.links.map((link) => ({
      source: byId.get(link.source) ?? link.source,
      target: byId.get(link.target) ?? link.target,
      type: link.type,
      ...(link.weight === undefined ? {} : { weight: link.weight }),
      sid: link.source,
      tid: link.target,
    }));
    return { nodes, links, byId };
  }, [graph]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(
      runtime.nodes.filter((node) => node.label.toLowerCase().includes(q)).map((node) => node.id),
    );
  }, [query, runtime]);

  const selected = selectedId ? (runtime.byId.get(selectedId) ?? null) : null;

  /**
   * 点开一个点之后怎么上色。概念按前置方向分两边（先学暖色、学完可去冷色），
   * 别的点按跳数分明暗——概念图上「方向」有意义，教材块之间没有。
   */
  const highlight = useMemo<Highlight>(() => {
    if (!selected) return null;
    const colors = new Map<string, string>();
    const dims = new Map<string, number>();
    colors.set(selected.id, COLOR.focus);
    if (selected.type === 'concept') {
      const { upstream, downstream } = prerequisiteDirections(graph.links, selected.id);
      for (const id of upstream.keys()) colors.set(id, COLOR.upstream);
      for (const id of downstream.keys()) colors.set(id, COLOR.downstream);
      // 直接连着的课/项目/章节也留亮，否则点开一个概念周围全黑，看不出它挂着什么
      for (const [id, hop] of neighbourhood(graph.links, selected.id, linkTypes, 1)) {
        if (!colors.has(id) && hop === 1) dims.set(id, 1);
      }
    } else {
      for (const [id, hop] of neighbourhood(graph.links, selected.id, linkTypes)) {
        if (id !== selected.id) dims.set(id, hop === 1 ? 1 : 0.45);
      }
    }
    for (const node of graph.nodes) {
      if (!colors.has(node.id) && !dims.has(node.id)) dims.set(node.id, 0.15);
    }
    return { colors, dims };
  }, [selected, graph, linkTypes]);

  const toggle = <K extends string>(
    setter: (updater: (prev: ReadonlySet<K>) => ReadonlySet<K>) => void,
    key: K,
  ) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const flyToRef = useRef<((id: string) => void) | null>(null);
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) flyToRef.current?.(id);
  }, []);

  return (
    <section
      id="universe"
      aria-label="知识宇宙"
      className="relative mt-6 h-[620px] w-full overflow-hidden rounded-xl border border-slate-700/60"
      style={{ background: COLOR.bg }}
    >
      <Canvas
        runtime={runtime}
        nodeTypes={nodeTypes}
        linkTypes={linkTypes}
        showLabels={showLabels}
        hits={hits}
        highlight={highlight}
        wholeSite={wholeSite}
        onSelect={select}
        flyToRef={flyToRef}
      />

      <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-[16rem] space-y-3">
        <div className="pointer-events-auto">
          <p className="text-sm font-medium text-slate-100">知识宇宙</p>
          <p className="mt-0.5 text-xs tabular-nums text-slate-400">
            {graph.counts.nodes} 个节点 · {graph.counts.links} 条边
          </p>
        </div>

        {error && (
          <p role="alert" className="pointer-events-auto text-xs leading-relaxed text-red-300">
            {error}这不表示这个领域没有知识库，是取图的服务此刻没答上来。
          </p>
        )}

        <div className="pointer-events-auto max-h-[520px] overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-950/70 p-3 backdrop-blur-sm">
          <div className="flex gap-1">
            {(
              [
                ['corpus', '只看本领域'],
                ['site', '全站三库'],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                aria-pressed={scope === key}
                onClick={() => {
                  setScope(key);
                  // 全站默认收起证据块：三个库加起来 6171 个块，软件渲染下几乎画不动，
                  // 而这一屏要看的是三团库的相对位置。想看块把上面那个 chip 点开。
                  setNodeTypes((prev) => {
                    const next = new Set(prev);
                    if (key === 'site') next.delete('chunk');
                    else next.add('chunk');
                    return next;
                  });
                }}
                className={
                  scope === key
                    ? 'rounded border border-violet-400/60 bg-violet-400/15 px-2 py-0.5 text-[11px] text-slate-100'
                    : 'rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-500'
                }
              >
                {text}
              </button>
            ))}
          </div>

          <label className="mt-2 flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900/80 px-2 py-1">
            <Search className="size-3 shrink-0 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索节点"
              aria-label="搜索节点"
              className="w-full bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-500"
            />
          </label>
          {query.trim() && (
            <p className="mt-1 text-[11px] tabular-nums text-slate-400">命中 {hits.size} 个</p>
          )}

          <FilterRow
            title="节点"
            order={NODE_ORDER}
            labels={NODE_TYPE_LABEL}
            counts={graph.counts.byType}
            active={nodeTypes}
            onToggle={(key) => toggle(setNodeTypes, key)}
          />
          <FilterRow
            title="关系"
            order={LINK_ORDER}
            labels={LINK_TYPE_LABEL}
            counts={graph.counts.byLink}
            active={linkTypes}
            onToggle={(key) => toggle(setLinkTypes, key)}
          />

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-slate-300">
            <input
              type="checkbox"
              checked={showLabels}
              onChange={(event) => setShowLabels(event.target.checked)}
              className="size-3 accent-violet-400"
            />
            显示标签
          </label>

          <ul className="mt-3 space-y-1 border-t border-slate-700/60 pt-2 text-[11px] text-slate-400">
            {wholeSite ? (
              Object.entries(CORPUS_TINT).map(([name, color]) => (
                <li key={name} className="flex items-center gap-1.5">
                  <Dot color={color} /> {domainLabel(name)}
                </li>
              ))
            ) : (
              <>
                <li className="flex items-center gap-1.5">
                  <Dot color={COLOR.mastered} /> 已掌握
                </li>
                <li className="flex items-center gap-1.5">
                  <Dot color={COLOR.current} /> 当前推荐
                </li>
                <li className="flex items-center gap-1.5">
                  <Dot color={COLOR.unmeasured} /> 未测的概念
                </li>
              </>
            )}
            {selected?.type === 'concept' && (
              <>
                <li className="flex items-center gap-1.5">
                  <Dot color={COLOR.upstream} /> 先学
                </li>
                <li className="flex items-center gap-1.5">
                  <Dot color={COLOR.downstream} /> 学完可去
                </li>
              </>
            )}
          </ul>
        </div>
      </div>

      {selected && (
        <DetailCard
          node={selected}
          graph={graph}
          runtime={runtime}
          onClose={() => select(null)}
          onPick={select}
          onDraft={onDraft}
        />
      )}
    </section>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function FilterRow<K extends string>({
  title,
  order,
  labels,
  counts,
  active,
  onToggle,
}: {
  title: string;
  order: ReadonlyArray<K>;
  labels: Record<K, string>;
  counts: Partial<Record<K, number>>;
  active: ReadonlySet<K>;
  onToggle: (key: K) => void;
}) {
  return (
    <div className="mt-3">
      <p className="text-[11px] text-slate-500">{title}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {order
          .filter((key) => (counts[key] ?? 0) > 0)
          .map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={active.has(key)}
              onClick={() => onToggle(key)}
              className={
                active.has(key)
                  ? 'rounded border border-violet-400/60 bg-violet-400/15 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-100'
                  : 'rounded border border-slate-700 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-500'
              }
            >
              {labels[key]} {counts[key] ?? 0}
            </button>
          ))}
      </div>
    </div>
  );
}

/** 侧栏一节：标题 + 一串可点的条目。空的就不渲染，不留「暂无」占位。 */
function CardList({
  title,
  items,
  onPick,
}: {
  title: string;
  items: Array<{ id: string; label: string; note?: string }>;
  onPick: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <p className="text-[11px] text-slate-500">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onPick(item.id)}
              className="text-left text-[11px] leading-snug text-slate-200 hover:text-white"
            >
              {item.label}
              {item.note ? <span className="ml-1 text-slate-500">{item.note}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 概念/课程/块的详情卡。 */
function DetailCard({
  node,
  graph,
  runtime,
  onClose,
  onPick,
  onDraft,
}: {
  node: UniverseNode;
  graph: UniverseGraph;
  runtime: { nodes: RtNode[]; links: RtLink[]; byId: Map<string, RtNode> };
  onClose: () => void;
  onPick: (id: string) => void;
  onDraft?: (conceptLabel: string) => void;
}) {
  const labelOf = (id: string) => runtime.byId.get(id)?.label ?? id;

  const directions = useMemo(
    () =>
      node.type === 'concept'
        ? prerequisiteDirections(graph.links, node.id)
        : { upstream: new Map<string, number>(), downstream: new Map<string, number>() },
    [graph.links, node],
  );
  const byHop = (hops: Map<string, number>) =>
    [...hops.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([id, hop]) => ({ id, label: labelOf(id), note: `第 ${hop} 跳` }));

  // teaches 是「课 → 概念」，所以讲这个概念的课在边的 source 那一头。
  const teachingCourses = runtime.links
    .filter((link) => link.type === 'teaches' && link.tid === node.id)
    .map((link) => ({ id: link.sid, label: labelOf(link.sid) }));
  const relatedProjects = [
    ...new Set(
      teachingCourses.flatMap((course) =>
        runtime.links
          .filter((link) => link.type === 'practices' && link.tid === course.id)
          .map((link) => link.sid),
      ),
    ),
  ].map((id) => ({ id, label: labelOf(id) }));

  // 「最近的知识点」：概念用引擎算好的质心近邻，块/章节用它自己的 similar 边。
  const nearest = node.nearest
    ? node.nearest.map((item) => ({
        id: item.id,
        label: labelOf(item.id),
        note: `相似度 ${item.weight.toFixed(2)}${sectionOf(runtime, item.id)}`,
      }))
    : runtime.links
        .filter((link) => link.type === 'similar' && (link.sid === node.id || link.tid === node.id))
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
        .map((link) => {
          const other = link.sid === node.id ? link.tid : link.sid;
          return {
            id: other,
            label: labelOf(other),
            note: `相似度 ${(link.weight ?? 0).toFixed(2)}${sectionOf(runtime, other)}`,
          };
        });

  return (
    <aside className="absolute right-4 top-4 z-10 max-h-[560px] w-72 overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-950/85 p-3 text-slate-200 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{node.label}</p>
        <button type="button" onClick={onClose} aria-label="关闭详情" className="text-slate-500">
          <X className="size-3.5" />
        </button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        {NODE_TYPE_LABEL[node.type]}
        {node.difficulty ? ` · 难度 ${node.difficulty}` : ''}
        {node.sourceId ? ` · ${node.sourceId}` : ''}
      </p>

      {node.type === 'course' && node.courseId && (
        <Link
          href={`/classroom/${node.courseId}`}
          className="mt-2 inline-block text-xs text-emerald-300 underline underline-offset-2"
        >
          打开这门课
        </Link>
      )}

      {node.type === 'concept' && (
        <>
          <CardList title="先学" items={byHop(directions.upstream)} onPick={onPick} />
          <CardList title="学完可去" items={byHop(directions.downstream)} onPick={onPick} />
          <CardList title="讲这个概念的课" items={teachingCourses} onPick={onPick} />
          <CardList title="用到它的实操项目" items={relatedProjects} onPick={onPick} />
        </>
      )}

      <CardList title="最近的知识点" items={nearest.slice(0, 8)} onPick={onPick} />
      {nearest.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          相似度是两段教材文字向量的余弦值，和图上的位置无关；位置只是力导向布局。
        </p>
      )}

      {node.type === 'concept' && onDraft && (
        <button
          type="button"
          onClick={() => onDraft(node.label)}
          className="mt-3 inline-flex items-center gap-1 rounded border border-violet-400/60 px-2 py-1 text-[11px] text-violet-200"
        >
          <Sparkles className="size-3" />
          按此概念造课
        </button>
      )}
    </aside>
  );
}

/**
 * 「· 出处」后缀。同一节里切出来的两个块标题是一样的，只写章节名会看成重复条目，
 * 所以标题与章节同名时改写块自己的 source_id——它们确实是两段不同的原文。
 */
function sectionOf(
  runtime: { links: RtLink[]; byId: Map<string, RtNode> },
  chunkId: string,
): string {
  const chunk = runtime.byId.get(chunkId);
  const link = runtime.links.find((item) => item.type === 'contains' && item.tid === chunkId);
  const section = link ? runtime.byId.get(link.sid) : undefined;
  if (section && section.label !== chunk?.label) return ` · ${section.label}`;
  return chunk?.sourceId ? ` · ${chunk.sourceId}` : '';
}

/**
 * WebGL 那一半。所有 3d-force-graph 的调用都关在这里，React 只在过滤条件变化时
 * 重新喂一次 graphData；相机、标签、粒子全在库自己的循环里跑。
 */
function Canvas({
  runtime,
  nodeTypes,
  linkTypes,
  showLabels,
  hits,
  highlight,
  wholeSite,
  onSelect,
  flyToRef,
}: {
  runtime: { nodes: RtNode[]; links: RtLink[]; byId: Map<string, RtNode> };
  nodeTypes: ReadonlySet<UniverseNodeType>;
  linkTypes: ReadonlySet<UniverseLinkType>;
  showLabels: boolean;
  hits: ReadonlySet<string>;
  highlight: Highlight;
  wholeSite: boolean;
  onSelect: (id: string | null) => void;
  flyToRef: React.RefObject<((id: string) => void) | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // 实例进 state 而不是 ref：它是异步 import 之后才有的，喂数据那条 effect 得等它到位
  // 再跑一次。之前放 ref 里，数据 effect 先跑一遍看见 null 就返回，之后再没有触发点——
  // 结果是画布建好了、graphData 一直是空的，屏幕上只有力导向初始撒点。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 库没导出实例类型的窄接口
  const [graph, setGraph] = useState<any>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const fitRef = useRef<(() => void) | null>(null);
  // 换配色（搜索命中、点开高亮）时按点改材质，不重设 nodeThreeObject——那会把
  // 两千个精灵推倒重建，每敲一个字卡一下。
  const materialRef = useRef<((color: string) => unknown) | null>(null);
  const framedRef = useRef(false);

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let instance: any = null;
    let raf = 0;
    let touched = false;
    // 布局是一边铺开一边看的：只在 cooldown 之后拉一次全景，前十几秒屏幕上就是
    // 几粒尘。所以开场这段时间每 1.5 秒跟拉一次，人一动视角就立刻停手。
    let fitTimer = 0;
    /**
     * 自己算相机距离，不用库的 `zoomToFit`。它按**所有点里最远的那个**定距离，
     * 而力导向总会把几个没有边的孤点甩到很远——七千个点的全站视图里，那几个点
     * 一个人就把相机推到十几倍远，屏幕上剩几粒尘。这里取 95 分位半径，
     * 甩出去的少数点允许出画。视线方向不动，只改距离，和自动旋转不打架。
     */
    const fit = () => {
      if (touched || !instance) return;
      const positioned = instance
        .graphData()
        .nodes.filter((node: RtNode) => typeof node.x === 'number');
      if (!positioned.length) return;
      const radii = positioned
        .map((node: RtNode) => Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0))
        .sort((a: number, b: number) => a - b);
      const reach = radii[Math.floor(radii.length * 0.95)] ?? radii[radii.length - 1];
      // 50° fov 下可见半高 ≈ 0.466×距离，取 2.4 倍留一点余量
      const distance = Math.max(300, reach * 2.4);
      const cam = instance.cameraPosition();
      const length = Math.max(1, Math.hypot(cam.x, cam.y, cam.z));
      instance.cameraPosition(
        {
          x: (cam.x / length) * distance,
          y: (cam.y / length) * distance,
          z: (cam.z / length) * distance,
        },
        { x: 0, y: 0, z: 0 },
        400,
      );
    };

    void Promise.all([import('3d-force-graph'), import('three')]).then(([mod, THREE]) => {
      const ForceGraph3D = mod.default;
      // 用 effect 入口捕获的 host，不要在这里再读一次 hostRef：StrictMode 的双挂载会在
      // 两次 effect 之间把 ref 摘掉，重读到的是 null，库拿 null 去 wipe DOM 直接抛。
      if (disposed) return;
      try {
        // 库的 NodeObject/LinkObject 泛型不认我们自己加的字段（type/sid/tid），
        // 每个 accessor 都要写一遍断言。实例这里放宽一次，读点集中在本文件内。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instance = new ForceGraph3D(host, { controlType: 'orbit' }) as any;
      } catch {
        // 没有 WebGL（老机器、禁用了硬件加速、jsdom）。如实说一句并把人指去 2D，
        // 不要留一块黑板让人以为这个库是空的。
        setUnavailable(true);
        return;
      }

      // 每种颜色一个材质，两千个精灵共享——每个点各建一个材质是两千份 shader uniform。
      const texture = glowTexture(THREE);
      const materials = new Map<string, InstanceType<typeof THREE.SpriteMaterial>>();
      const materialFor = (color: string) => {
        let material = materials.get(color);
        if (!material) {
          material = new THREE.SpriteMaterial({
            map: texture,
            color,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
          });
          materials.set(color, material);
        }
        return material;
      };
      materialRef.current = materialFor;

      instance
        .backgroundColor(COLOR.bg)
        .showNavInfo(false)
        .nodeLabel((node: RtNode) => node.label)
        .nodeVal((node: RtNode) => node.size)
        .nodeThreeObject((node: RtNode) => {
          const sprite = new THREE.Sprite(materialFor(baseColor(node, wholeSite)));
          // 点的大小是世界坐标里的尺寸，而图铺开的尺度跟着点数走：全站三库摊得比
          // 单库大三四倍，同样的半径拉远之后就不到一个像素——屏幕上是一片黑。
          const radius = (8 + node.size * 3.5) * (wholeSite ? 2 : 1);
          sprite.scale.set(radius, radius, 1);
          return sprite;
        })
        .linkColor((link: RtLink) => LINK_COLOR[link.type])
        .linkOpacity(0.25)
        .linkWidth((link: RtLink) => (link.type === 'prerequisite' ? 0.8 : 0.2))
        // 前置边是有方向的：箭头说清「谁在前」，粒子只说明它在流动。
        .linkDirectionalArrowLength((link: RtLink) => (link.type === 'prerequisite' ? 4 : 0))
        .linkDirectionalArrowRelPos(0.85)
        .linkDirectionalParticles((link: RtLink) =>
          !reduced && link.type === 'prerequisite' ? 2 : 0,
        )
        .linkDirectionalParticleWidth(1.2)
        // 先空转一批 tick 再上屏，省掉开场的乱飞；alpha 衰减调快让它三秒内停，
        // 停下来的图截图才对得上。cooldownTicks 只是兜底，正常是 alpha 先到底。
        .warmupTicks(60)
        .cooldownTicks(220)
        .d3AlphaDecay(0.06)
        .d3VelocityDecay(0.35)
        .onNodeClick((node: RtNode) => selectRef.current(node.id))
        .onBackgroundClick(() => selectRef.current(null))
        // 两千个点的斥力会把图铺得比初始视野大得多，不拉全景就只看得见几粒尘。
        // 只在人还没自己动过视角之前拉——之后每次过滤都重排视角等于把视点抢走。
        .onEngineStop(() => {
          fit();
          window.setTimeout(fit, 2000);
        });

      // 斥力设一个作用半径。全站视图收起证据块之后，剩下的章节/教材/概念之间边很少，
      // 无上限的斥力会让整团一直往外涨（实测半径中位数涨到一万以上，相机只好退到
      // 四万开外，点全变成不到一个像素）。限住之后只有邻近的点互相推，图收得住。
      instance.d3Force('charge')?.distanceMax(700);

      const controls = instance.controls();
      if (!reduced) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.35;
      }
      // 一旦有人自己转/缩放：停自动旋转，也不再抢视角。
      controls.addEventListener?.('start', () => {
        touched = true;
        controls.autoRotate = false;
        clearInterval(fitTimer);
      });

      fitRef.current = fit;
      flyToRef.current = (id: string) => {
        const node = runtimeRef.current.byId.get(id);
        if (!node || node.x === undefined) return;
        const x = node.x;
        const y = node.y ?? 0;
        const z = node.z ?? 0;
        const ratio = 1 + 450 / Math.max(1, Math.hypot(x, y, z));
        touched = true;
        controls.autoRotate = false;
        clearInterval(fitTimer);
        try {
          instance.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 800);
        } catch {
          /* 相机补间偶尔在换数据的那一帧上取不到位置；飞不过去不该把整页打断 */
        }
      };
      // 一直跟着拉到有人自己动视角为止：七千个点在软件渲染上要跑几十秒才 cooldown，
      // 定死十五秒就会停在「还在铺开」的那一帧上——那一帧整屏是空的。
      // zoomToFit 只改相机到原点的距离、不改方向，和自动旋转不打架。
      fitTimer = window.setInterval(fit, 1500);
      framedRef.current = false;

      // 标签走 rAF 直接写 DOM：相机每帧都在动，这个位置进 React state 就是每帧重渲染。
      const tick = () => {
        raf = requestAnimationFrame(tick);
        const layer = labelLayerRef.current;
        if (!layer || layer.childElementCount === 0) return;
        for (const child of Array.from(layer.children) as HTMLElement[]) {
          const node = runtimeRef.current.byId.get(child.dataset.nodeId ?? '');
          if (!node || node.x === undefined) continue;
          const screen = instance.graph2ScreenCoords(node.x, node.y ?? 0, node.z ?? 0);
          // 换数据的那一两帧里渲染器还没接上，这里会拿到 undefined——直接读 .x 就抛。
          if (!screen) continue;
          child.style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px)`;
        }
      };
      raf = requestAnimationFrame(tick);
      // 必须包一层：kapsule 的实例本身是个函数，直接 setGraph(instance) 会被 React
      // 当成 updater 调用一遍 —— 等于拿上一次的 state（null）当 DOM 节点重新 init。
      setGraph(() => instance);
    });

    let pending = 0;
    const observer = new ResizeObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        if (instance) instance.width(host.clientWidth).height(host.clientHeight);
      });
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      if (fitTimer) clearInterval(fitTimer);
      if (raf) cancelAnimationFrame(raf);
      if (pending) cancelAnimationFrame(pending);
      instance?._destructor?.();
      setGraph(null);
    };
    // 画布只建一次：数据与过滤都只喂 graphData，不重建 WebGL 上下文。
  }, [reduced, wholeSite, flyToRef]);

  useEffect(() => {
    if (!graph) return;
    const nodes = runtime.nodes.filter((node) => nodeTypes.has(node.type));
    const visible = new Set(nodes.map((node) => node.id));
    const links = runtime.links.filter(
      (link) => linkTypes.has(link.type) && visible.has(link.sid) && visible.has(link.tid),
    );
    graph.graphData({ nodes, links });
    // 第一帧就把相机退到能装下整张图的距离：点数的立方根 × 常数，与力导向铺开的
    // 尺度同阶。不设的话开场几秒里屏幕上只有几粒尘。
    if (!framedRef.current && nodes.length) {
      framedRef.current = true;
      graph.cameraPosition({ z: Math.cbrt(nodes.length) * 230 });
    }
    // 换了数据就重新框一次：过滤掉证据块之后剩下的几十个点会缩成中间一小团，
    // 不重框就是一屏黑底加几个点。
    const timers = [800, 2500].map((delay) => window.setTimeout(() => fitRef.current?.(), delay));
    return () => timers.forEach(clearTimeout);
  }, [graph, runtime, nodeTypes, linkTypes]);

  // 命中与高亮都只是换材质，不动布局。
  useEffect(() => {
    if (!graph || !materialRef.current) return;
    // 选中一个点时把全部连线压暗：相近边有四千条，不压下去邻域高亮全被网盖住。
    graph.linkOpacity(highlight ? 0.07 : 0.25);
    const material = materialRef.current;
    for (const node of runtime.nodes) {
      const object = (node as RtNode & { __threeObj?: { material?: unknown } }).__threeObj;
      if (!object) continue;
      const color = hits.has(node.id)
        ? COLOR.hit
        : (highlight?.colors.get(node.id) ?? baseColor(node, wholeSite));
      const dim = highlight && !highlight.colors.has(node.id) ? (highlight.dims.get(node.id) ?? 1) : 1;
      object.material = material(dim < 1 ? dimmed(color, dim) : color);
    }
  }, [graph, hits, highlight, runtime, wholeSite]);

  // 全站视图里概念也跟着开关走：三个库加起来 79 个概念名同时上屏就是一面字墙，
  // 而那一屏要看的是三团分没分开，不是概念名。
  const labelled = useMemo(
    () =>
      runtime.nodes.filter(
        (node) =>
          nodeTypes.has(node.type) &&
          ((ALWAYS_LABELLED.has(node.type) && (showLabels || !wholeSite)) ||
            (showLabels && OPTIONAL_LABELLED.has(node.type))),
      ),
    [runtime, nodeTypes, showLabels, wholeSite],
  );

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" />
      {unavailable && (
        <p className="absolute inset-x-0 top-1/2 px-6 text-center text-sm text-slate-400">
          当前浏览器没有可用的 WebGL，这张 3D 图画不出来。换成上面的「前置图（2D）」可以看概念结构。
        </p>
      )}
      <div
        ref={labelLayerRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        {labelled.map((node) => (
          <span
            key={node.id}
            data-node-id={node.id}
            className="absolute left-0 top-0 whitespace-nowrap text-[11px] text-slate-200 [text-shadow:0_1px_3px_#000]"
          >
            {node.label}
          </span>
        ))}
      </div>
    </>
  );
}
