'use client';

/**
 * 知识宇宙：这个知识库有什么，一屏看完。
 *
 * 前置图（concept-graph.tsx）画的是概念之间的顺序，AI 库 11 个点、智能制造 66 个点，
 * 一屏看下来只知道"有这么几个概念"。可库里真正的东西在概念底下：10 本教材、388 篇
 * 章节、1752 个证据块。这张图把四层一起摆出来，概念是亮的枢纽，证据块是围着它的尘埃。
 *
 * ## 三条实现上的约束
 *
 * - **`3d-force-graph` 在 effect 里动态 import**。它在模块顶层就要 `document`，
 *   静态 import 会让 /path 整页 SSR 崩掉。
 * - **不往 React state 里塞每帧的东西**。相机每帧都在动，标签位置也在动；标签是
 *   rAF 里直接写 DOM 的，不走 setState。
 * - **同一个 corpus 只请求一次**（模块级 `GRAPH_CACHE`）。两千个点的图重复拉没意义。
 *
 * 面板内部固定深色，站点主题不跟着变——星空底是这张图能读的前提，浅色底上
 * 两千个半透明点全糊成一片灰。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, Sparkles, X } from 'lucide-react';

import {
  mergeKnowledgeUniverse,
  type ConceptStatus,
  type EngineGraph,
  type UniverseGraph,
  type UniverseLinkType,
  type UniverseNode,
  type UniverseNodeType,
} from '@/lib/knowledge/knowledge-universe';

/** 引擎那张图按库缓存：同一个 corpus 一个会话里只拉一次。 */
const GRAPH_CACHE = new Map<string, EngineGraph>();

const NODE_TYPE_LABEL: Record<UniverseNodeType, string> = {
  concept: '概念',
  textbook: '教材',
  section: '章节',
  chunk: '证据块',
  course: '课程',
};

const LINK_TYPE_LABEL: Record<UniverseLinkType, string> = {
  prerequisite: '前置',
  covers: '覆盖',
  contains: '包含',
  teaches: '讲授',
};

/**
 * 面板内固定深色，不跟站点主题。四层各一色，概念再按掌握度分三档。
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
  mastered: '#7dd3fc',
  current: '#e9d5ff',
  unmeasured: '#a78bfa',
  hit: '#fde047',
};

const LINK_COLOR: Record<UniverseLinkType, string> = {
  prerequisite: '#e9d5ff',
  covers: '#7b8cc0',
  contains: '#4a5578',
  teaches: '#4ade80',
};

const NODE_ORDER: UniverseNodeType[] = ['concept', 'textbook', 'section', 'chunk', 'course'];
const LINK_ORDER: UniverseLinkType[] = ['prerequisite', 'covers', 'contains', 'teaches'];

/**
 * 概念标签常驻——这一页是学习路径，概念名不该要人先去勾一个开关才看得见。
 * 教材与课程的标签跟着「显示标签」走，其余（两千个证据块）永远只在悬停时给，
 * 标题同时上屏就是一团墨。
 */
const ALWAYS_LABELLED: ReadonlySet<UniverseNodeType> = new Set(['concept']);
const OPTIONAL_LABELLED: ReadonlySet<UniverseNodeType> = new Set(['textbook', 'course']);

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

function nodeColor(node: UniverseNode, hits: ReadonlySet<string>): string {
  if (hits.has(node.id)) return COLOR.hit;
  switch (node.type) {
    case 'concept':
      if (node.status === 'mastered') return COLOR.mastered;
      if (node.status === 'current') return COLOR.current;
      return COLOR.unmeasured;
    case 'textbook':
      return COLOR.textbook;
    case 'course':
      return COLOR.course;
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
  sid: string;
  tid: string;
};

export interface KnowledgeUniverseProps {
  corpus: string;
  courses: ReadonlyArray<{ id: string; title: string }>;
  conceptOfCourse: Readonly<Record<string, string | null>>;
  statusOfConcept: Readonly<Record<string, ConceptStatus | undefined>>;
  onDraft?: (conceptLabel: string) => void;
}

export function KnowledgeUniverse({
  corpus,
  courses,
  conceptOfCourse,
  statusOfConcept,
  onDraft,
}: KnowledgeUniverseProps) {
  const [fetched, setFetched] = useState<{ corpus: string; graph: EngineGraph } | null>(null);
  // 缓存直接在渲染时读，不在 effect 里 setState 把它搬进 state：那会多一轮渲染，
  // 也会在换库时短暂拿着上一个库的图。
  const engine = GRAPH_CACHE.get(corpus) ?? (fetched?.corpus === corpus ? fetched.graph : null);
  const [error, setError] = useState<string | null>(null);
  const [nodeTypes, setNodeTypes] = useState<ReadonlySet<UniverseNodeType>>(
    () => new Set(NODE_ORDER),
  );
  const [linkTypes, setLinkTypes] = useState<ReadonlySet<UniverseLinkType>>(
    () => new Set(LINK_ORDER),
  );
  const [showLabels, setShowLabels] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<UniverseNode | null>(null);

  useEffect(() => {
    if (GRAPH_CACHE.has(corpus)) return;
    let alive = true;
    fetch(`/api/knowledge-graph/${encodeURIComponent(corpus)}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          success?: boolean;
          graph?: EngineGraph;
          error?: string;
        } | null;
        if (!res.ok || !body?.success || !body.graph) {
          throw new Error(body?.error ?? '知识库图谱服务暂时不可用。');
        }
        GRAPH_CACHE.set(corpus, body.graph);
        if (alive) setFetched({ corpus, graph: body.graph });
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : '知识库图谱服务暂时不可用。');
      });
    return () => {
      alive = false;
    };
  }, [corpus]);

  const graph: UniverseGraph = useMemo(
    () => mergeKnowledgeUniverse(engine, { courses, conceptOfCourse, statusOfConcept }),
    [engine, courses, conceptOfCourse, statusOfConcept],
  );

  // 点/边对象只造一次：过滤时复用同一批引用，力导向算好的坐标才不会每次归零重排。
  const runtime = useMemo(() => {
    const nodes: RtNode[] = graph.nodes.map((node) => ({ ...node }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links: RtLink[] = graph.links.map((link) => ({
      source: byId.get(link.source) ?? link.source,
      target: byId.get(link.target) ?? link.target,
      type: link.type,
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
        onSelect={setSelected}
      />

      <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-[15rem] space-y-3">
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

        <div className="pointer-events-auto rounded-lg border border-slate-700/60 bg-slate-950/70 p-3 backdrop-blur-sm">
          <label className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900/80 px-2 py-1">
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
            onToggle={(key) =>
              setNodeTypes((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
          />
          <FilterRow
            title="关系"
            order={LINK_ORDER}
            labels={LINK_TYPE_LABEL}
            counts={graph.counts.byLink}
            active={linkTypes}
            onToggle={(key) =>
              setLinkTypes((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
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
            <li className="flex items-center gap-1.5">
              <Dot color={COLOR.mastered} /> 已掌握
            </li>
            <li className="flex items-center gap-1.5">
              <Dot color={COLOR.current} /> 当前推荐
            </li>
            <li className="flex items-center gap-1.5">
              <Dot color={COLOR.unmeasured} /> 未测的概念
            </li>
          </ul>
        </div>
      </div>

      {selected && (
        <DetailCard
          node={selected}
          runtime={runtime}
          onClose={() => setSelected(null)}
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

/** 概念/课程的详情卡。概念显示先修与讲这个概念的课，课程直接给入口。 */
function DetailCard({
  node,
  runtime,
  onClose,
  onDraft,
}: {
  node: UniverseNode;
  runtime: { nodes: RtNode[]; links: RtLink[]; byId: Map<string, RtNode> };
  onClose: () => void;
  onDraft?: (conceptLabel: string) => void;
}) {
  const prereq = runtime.links
    .filter((link) => link.type === 'prerequisite' && link.tid === node.id)
    .map((link) => runtime.byId.get(link.sid)?.label)
    .filter((label): label is string => Boolean(label));
  const taughtBy = runtime.links
    .filter((link) => link.type === 'teaches' && link.tid === node.id)
    .map((link) => runtime.byId.get(link.sid))
    .filter((item): item is RtNode => Boolean(item));

  return (
    <aside className="absolute right-4 top-4 z-10 w-64 rounded-lg border border-slate-700/60 bg-slate-950/85 p-3 text-slate-200 backdrop-blur-sm">
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
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            先修：{prereq.length ? prereq.join('、') : '没有前置概念'}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            讲这个概念的课：
            {taughtBy.length ? '' : '暂时没有'}
          </p>
          {taughtBy.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {taughtBy.slice(0, 4).map((course) => (
                <li key={course.id}>
                  <Link
                    href={`/classroom/${course.courseId}`}
                    className="text-[11px] text-emerald-300 underline underline-offset-2"
                  >
                    {course.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {onDraft && (
            <button
              type="button"
              onClick={() => onDraft(node.label)}
              className="mt-3 inline-flex items-center gap-1 rounded border border-violet-400/60 px-2 py-1 text-[11px] text-violet-200"
            >
              <Sparkles className="size-3" />
              按此概念造课
            </button>
          )}
        </>
      )}
    </aside>
  );
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
  onSelect,
}: {
  runtime: { nodes: RtNode[]; links: RtLink[]; byId: Map<string, RtNode> };
  nodeTypes: ReadonlySet<UniverseNodeType>;
  linkTypes: ReadonlySet<UniverseLinkType>;
  showLabels: boolean;
  hits: ReadonlySet<string>;
  onSelect: (node: UniverseNode | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // 实例进 state 而不是 ref：它是异步 import 之后才有的，喂数据那条 effect 得等它到位
  // 再跑一次。之前放 ref 里，数据 effect 先跑一遍看见 null 就返回，之后再没有触发点——
  // 结果是画布建好了、graphData 一直是空的，屏幕上只有力导向初始撒点。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 库没导出实例类型的窄接口
  const [graph, setGraph] = useState<any>(null);
  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  // 拉全景的钩子：建实例的 effect 挂上，换数据/换过滤的 effect 用它把新的子图框回画面。
  const fitRef = useRef<(() => void) | null>(null);
  // 换配色（搜索命中）时按点改材质，不重设 nodeThreeObject——那会把两千个精灵推倒重建，
  // 每敲一个字卡一下。
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
    const fit = () => {
      if (!touched) instance?.zoomToFit(600, 80);
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
          const sprite = new THREE.Sprite(materialFor(nodeColor(node, hitsRef.current)));
          const radius = 8 + node.size * 3.5;
          sprite.scale.set(radius, radius, 1);
          return sprite;
        })
        .linkColor((link: RtLink) => LINK_COLOR[link.type])
        .linkOpacity(0.25)
        .linkWidth((link: RtLink) => (link.type === 'prerequisite' ? 0.8 : 0.2))
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
        .onNodeClick((node: RtNode) => {
          selectRef.current(node.type === 'concept' || node.type === 'course' ? node : null);
        })
        // 两千个点的斥力会把图铺得比初始视野大得多，不拉全景就只看得见几粒尘。
        // 只在人还没自己动过视角之前拉——之后每次过滤都重排视角等于把视点抢走。
        .onEngineStop(() => {
          fit();
          window.setTimeout(fit, 2000);
        });
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
      fitTimer = window.setInterval(fit, 1500);
      window.setTimeout(() => window.clearInterval(fitTimer), 15000);

      // 标签走 rAF 直接写 DOM：相机每帧都在动，这个位置进 React state 就是每帧重渲染。
      const tick = () => {
        raf = requestAnimationFrame(tick);
        const layer = labelLayerRef.current;
        if (!layer || layer.childElementCount === 0) return;
        for (const child of Array.from(layer.children) as HTMLElement[]) {
          const node = runtimeRef.current.byId.get(child.dataset.nodeId ?? '');
          if (!node || node.x === undefined) continue;
          const screen = instance.graph2ScreenCoords(node.x, node.y ?? 0, node.z ?? 0);
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
  }, [reduced]);

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

  // 命中变了只要重刷颜色，不动布局。
  useEffect(() => {
    if (!graph) return;
    for (const node of runtime.nodes) {
      const object = (node as RtNode & { __threeObj?: { material?: unknown } }).__threeObj;
      if (object) object.material = materialRef.current?.(nodeColor(node, hits));
    }
    // 飞到第一个命中：沿原点→节点方向退开一段，节点落在画面中央。
    const first = runtime.nodes.find((node) => hits.has(node.id));
    if (first && first.x !== undefined) {
      const x = first.x;
      const y = first.y ?? 0;
      const z = first.z ?? 0;
      const ratio = 1 + 160 / Math.max(1, Math.hypot(x, y, z));
      graph.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, first, 800);
    }
  }, [graph, hits, runtime]);

  const labelled = useMemo(
    () =>
      runtime.nodes.filter(
        (node) =>
          nodeTypes.has(node.type) &&
          (ALWAYS_LABELLED.has(node.type) || (showLabels && OPTIONAL_LABELLED.has(node.type))),
      ),
    [runtime, nodeTypes, showLabels],
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
