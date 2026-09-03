'use client';

/**
 * 概念前置图（学习端 /path 的主视图）。
 *
 * 取代原来的「逐阶段列卡片」：一屏 66 张卡片里 66 张写着「尚未测评」，读者看到的是
 * 一页空白，看不到库里其实有 66 个概念、51 条前置关系。图能一眼把结构摆出来，
 * 掌握度只是节点的着色。
 *
 * 布局是算好的，不是力导向：横轴 = 引擎给的拓扑阶次，同阶垂直排一列，一列超过
 * MAX_PER_COL 个就在本阶内折成第二列（智能制造第 1 阶有 15 个概念）。力导向每次
 * 刷新位置都不一样，同一张图两次截图对不上，教学场景里这是缺点不是优点。
 *
 * 用 @xyflow/react 只为拿到平移缩放与 fitView；节点坐标全是这里算的。
 */

import { createContext, useContext, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { Sparkles, X } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import { truncateLabel } from '@/lib/knowledge/domain-registry';
import { cn } from '@/lib/utils';

export type ConceptStatus = 'mastered' | 'current' | 'future' | 'unmeasured';

export interface ConceptGraphNode {
  id: string;
  /** 中文名，取自 lib/knowledge 的概念表；表里没有就是概念 id 原样 */
  label: string;
  /** 引擎给的阶次，1 起 */
  stage: number;
  prereq: string[];
  status?: ConceptStatus;
  mastery?: number | null;
  confidence?: number | null;
  because?: string | null;
  section?: string | null;
  courses: ReadonlyArray<{ id: string; title: string }>;
}

/** 三档着色：达标填充、有记录未达标描边、没测过的留白。没测过不是错误态。 */
type Tone = 'mastered' | 'partial' | 'blank';

const MASTERY_THRESHOLD = 0.7;
/**
 * 一阶最多摞多高，超了才在本阶内折第二列。定 16 是量出来的：智能制造第 1 阶 15 个概念，
 * 折成两列会把整张图从 6 列撑到 12 列，宽度翻倍、fitView 的缩放砍半（0.85 → 0.41），
 * 节点上的字直接看不清。折列是为了不让某一阶无限长，不是默认排法。
 */
const MAX_PER_COL = 16;

function toneOf(node: ConceptGraphNode): Tone {
  if (node.status === 'mastered' || (node.mastery ?? 0) >= MASTERY_THRESHOLD) return 'mastered';
  if (typeof node.mastery === 'number') return 'partial';
  return 'blank';
}

const TONE_CLASS: Record<Tone, string> = {
  mastered: 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-400 dark:bg-indigo-500',
  partial: 'border-amber-500 bg-transparent text-amber-800 dark:text-amber-200',
  blank: 'border-border bg-card text-foreground',
};

/** 图例上的小色块，和节点用同一套类，改一处两处都变。 */
const TONE_SWATCH: Record<Tone, string> = {
  mastered: 'border-indigo-600 bg-indigo-600 dark:border-indigo-400 dark:bg-indigo-500',
  partial: 'border-amber-500 bg-transparent',
  blank: 'border-border bg-card',
};

interface Metrics {
  w: number;
  h: number;
  colGap: number;
  rowGap: number;
  small: boolean;
}

function metricsFor(count: number): Metrics {
  return count > 30
    ? { w: 140, h: 36, colGap: 56, rowGap: 16, small: true }
    : { w: 158, h: 46, colGap: 84, rowGap: 20, small: false };
}

/**
 * 按阶次排列：同阶一列，超过 MAX_PER_COL 折成同阶的第二列。列序全局递增，
 * 所以第 k 阶的所有列一定在第 k+1 阶左边，边永远朝右走。
 *
 * 导出是为了单测能直接查「不重叠 + 阶次单调」，不必渲染 React Flow。
 */
export function layoutConcepts(
  nodes: ReadonlyArray<{ id: string; stage: number }>,
  m: Metrics = metricsFor(nodes.length),
): Map<string, { x: number; y: number }> {
  const stages = [...new Set(nodes.map((n) => n.stage))].sort((a, b) => a - b);
  const out = new Map<string, { x: number; y: number }>();
  let col = 0;
  for (const stage of stages) {
    const inStage = nodes.filter((n) => n.stage === stage);
    const cols = Math.ceil(inStage.length / MAX_PER_COL);
    const perCol = Math.ceil(inStage.length / cols);
    for (let c = 0; c < cols; c += 1) {
      const slice = inStage.slice(c * perCol, (c + 1) * perCol);
      slice.forEach((n, i) => {
        out.set(n.id, {
          x: col * (m.w + m.colGap),
          // 每列自己居中，短列不会全贴在顶上
          y: (i - (slice.length - 1) / 2) * (m.h + m.rowGap),
        });
      });
      col += 1;
    }
  }
  return out;
}

interface NodeData extends Record<string, unknown> {
  label: string;
  tone: Tone;
  current: boolean;
  courseCount: number;
  small: boolean;
  width: number;
  height: number;
}

/**
 * 悬停与点选走 context，不进 `nodes` 数组——这是一个真踩到的坑：把 dim 写进节点 data，
 * 每次悬停整份 nodes 都是新数组，React Flow 借机重新 fitView，节点在 mousedown 与
 * mouseup 之间挪了位置，浏览器把 click 的目标退回到公共祖先（画布），于是「点节点开侧栏」
 * 在真鼠标下一次都不触发（合成 click 却正常，正是这个差别把问题藏了很久）。
 */
const GraphContext = createContext<{
  lit: ReadonlySet<string> | null;
  pick: (id: string) => void;
}>({ lit: null, pick: () => {} });

function ConceptNode({ id, data }: NodeProps<Node<NodeData>>) {
  const { lit, pick } = useContext(GraphContext);
  return (
    <div
      style={{ width: data.width, height: data.height }}
      onClick={() => pick(id)}
      className={cn(
        'flex cursor-pointer items-center justify-between gap-1.5 rounded-lg border px-2.5 transition-opacity',
        TONE_CLASS[data.tone],
        data.current && 'ring-2 ring-primary/50 ring-offset-1 ring-offset-background',
        lit && !lit.has(id) && 'opacity-25',
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1 !border-0 !bg-border" />
      <span className={cn('min-w-0 truncate', data.small ? 'text-[10px]' : 'text-xs')}>
        {data.label}
      </span>
      {data.courseCount > 0 && (
        <span
          className={cn(
            'shrink-0 rounded-full px-1 tabular-nums',
            data.small ? 'text-[9px]' : 'text-[10px]',
            data.tone === 'mastered' ? 'bg-white/20' : 'bg-muted text-muted-foreground',
          )}
        >
          {data.courseCount} 课
        </span>
      )}
      <Handle type="source" position={Position.Right} className="!size-1 !border-0 !bg-border" />
    </div>
  );
}

const nodeTypes = { concept: ConceptNode };

export function ConceptGraph({
  nodes: input,
  onDraft,
  height,
}: {
  readonly nodes: ReadonlyArray<ConceptGraphNode>;
  /** 传了才显示「按此概念造课」；管理端只读预览不传 */
  readonly onDraft?: (node: ConceptGraphNode) => void;
  /** 不传就按最长的一列算：容器比图矮时 fitView 会一路缩到字看不清 */
  readonly height?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const byId = useMemo(() => new Map(input.map((n) => [n.id, n])), [input]);
  const metrics = useMemo(() => metricsFor(input.length), [input.length]);
  const pos = useMemo(() => layoutConcepts(input, metrics), [input, metrics]);

  const rawEdges = useMemo(
    () => input.flatMap((n) => n.prereq.filter((p) => byId.has(p)).map((p) => [p, n.id] as const)),
    [input, byId],
  );

  /** 悬停时挑出这个概念的整条前置链（传递闭包），不是只挑一跳。 */
  const lit = useMemo(() => {
    if (!hover) return null;
    const seen = new Set([hover]);
    const queue = [hover];
    while (queue.length) {
      for (const p of byId.get(queue.pop()!)?.prereq ?? []) {
        if (byId.has(p) && !seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return seen;
  }, [hover, byId]);

  const flowNodes = useMemo<Node<NodeData>[]>(
    () =>
      input.map((n) => ({
        id: n.id,
        type: 'concept',
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        draggable: false,
        connectable: false,
        data: {
          label: n.label,
          tone: toneOf(n),
          current: n.status === 'current',
          courseCount: n.courses.length,
          small: metrics.small,
          width: metrics.w,
          height: metrics.h,
        },
      })),
    // 刻意不依赖 lit：悬停不许改动 nodes 数组，理由见 GraphContext。
    [input, pos, metrics],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      rawEdges.map(([from, to]) => {
        const on = !lit || (lit.has(from) && lit.has(to));
        return {
          id: `${from}->${to}`,
          source: from,
          target: to,
          type: 'smoothstep',
          style: {
            stroke: 'var(--muted-foreground)',
            strokeWidth: on && lit ? 1.8 : 1,
            opacity: lit && !on ? 0.12 : 0.5,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        };
      }),
    [rawEdges, lit],
  );

  const withCourse = input.filter((n) => n.courses.length > 0).length;
  const mounted = input.length ? Math.round((withCourse / input.length) * 100) : 0;
  const selected = picked ? (byId.get(picked) ?? null) : null;
  const ctx = useMemo(() => ({ lit, pick: setPicked }), [lit]);

  const tallest = Math.max(
    1,
    ...[...new Set([...pos.values()].map((p) => p.x))].map(
      (x) => [...pos.values()].filter((p) => p.x === x).length,
    ),
  );
  const box = height ?? Math.min(720, Math.max(420, tallest * (metrics.h + metrics.rowGap) + 48));

  if (input.length === 0) return null;

  return (
    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
      <aside className="shrink-0 space-y-3 text-xs sm:w-40">
        <dl className="space-y-1.5">
          {[
            ['节点总数', `${input.length}`],
            ['前置边数', `${rawEdges.length}`],
            ['资源挂载率', `${mounted}%`],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          挂载率是已有课程的概念占比，{withCourse}/{input.length}。
        </p>
        <ul className="space-y-1.5 border-t border-border pt-3">
          {(
            [
              ['mastered', '已掌握'],
              ['partial', '有记录未达标'],
              ['blank', '尚未测评'],
            ] as const
          ).map(([tone, text]) => (
            <li key={tone} className="flex items-center gap-2 text-muted-foreground">
              <span className={cn('inline-block size-3 rounded border', TONE_SWATCH[tone])} />
              {text}
            </li>
          ))}
          <li className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block size-3 rounded border border-border bg-card ring-2 ring-primary/50" />
            当前推荐
          </li>
        </ul>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          灰底空心是还没测过，不是没内容；测评后点亮。
        </p>
      </aside>

      <div
        className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card"
        style={{ height: box }}
      >
        <GraphContext.Provider value={ctx}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.25}
            maxZoom={1.6}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeMouseEnter={(_, node) => setHover(node.id)}
            onNodeMouseLeave={() => setHover(null)}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
        </GraphContext.Provider>

        {selected && (
          <div className="absolute inset-y-0 right-0 w-72 max-w-full overflow-y-auto border-l border-border bg-card p-4 shadow-lg">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium leading-snug">{selected.label}</p>
              <button
                type="button"
                aria-label="关闭概念详情"
                onClick={() => setPicked(null)}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              第 {selected.stage} 阶 ·{' '}
              {toneOf(selected) === 'mastered'
                ? '已掌握'
                : toneOf(selected) === 'partial'
                  ? `有记录未达标（${(selected.mastery ?? 0).toFixed(2)}）`
                  : '尚未测评'}
              {selected.status === 'current' ? ' · 当前推荐' : ''}
            </p>

            {selected.prereq.length > 0 && (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                先修：{selected.prereq.map((p) => byId.get(p)?.label ?? p).join('、')}
              </p>
            )}
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {typeof selected.confidence === 'number'
                ? `前置判定置信度 ${selected.confidence.toFixed(2)}`
                : selected.because || '入口概念，没有前置'}
            </p>
            {selected.section && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                证据出处：{truncateLabel(selected.section, 30)}
              </p>
            )}

            <div className="mt-3 border-t border-border pt-3">
              {selected.courses.length > 0 ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    已挂 {selected.courses.length} 门课
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {selected.courses.map((course) => (
                      <li key={course.id}>
                        <Link
                          href={`/classroom/${course.id}`}
                          className="block truncate text-xs hover:text-primary hover:underline"
                        >
                          {course.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">这个概念还没有课。</p>
              )}
              {onDraft && selected.courses.length === 0 && (
                <button
                  type="button"
                  onClick={() => onDraft(selected)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/60"
                >
                  <Sparkles className="size-3.5" />
                  按此概念造课
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
