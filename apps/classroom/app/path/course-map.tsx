'use client';

/**
 * 课程路径图：与管理端「学习路径规划图」（components/admin/knowledge-map.tsx）同构的
 * SVG 分层 DAG——节点与连线在同一坐标系里计算，杜绝 DOM 卡片 + 叠加 SVG 那套
 * 连线飘移的问题（两列网格与横排 flex 两版都翻过车，这是第三版，直接抄成熟引擎）。
 *
 * 与管理端的差异只有三点：
 * - 节点是课程不是概念：有课的节点整体可点、进课堂；规划中的画虚线框、不可点。
 * - 第二行印「难度星 + 场景数」而不是出入度（学习者关心学什么、多长，不关心图论）。
 * - 悬停 title 带完整课程信息（适合人群、先修），代替被砍掉的详情卡。
 * 悬停/聚焦高亮直接前驱后继的交互照搬。
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface CourseMapNode {
  id: string;
  title: string;
  layer: number;
  slot: number;
  difficulty: number;
  courseId?: string | null;
  sceneCount?: number;
  audience?: string;
  prereqTitles?: string[];
}

const NODE_W = 168;
const NODE_H = 48;
const GAP_X = 64;
const GAP_Y = 16;
const PAD = 16;
const HEAD_H = 20;
const LABEL_FONT = 11;
const LABEL_PAD_X = 11;
const LABEL_MAX_W = NODE_W - LABEL_PAD_X * 2 - 6;

function charWidth(ch: string): number {
  return /[⺀-鿿　-〿＀-￯]/.test(ch) ? LABEL_FONT : LABEL_FONT * 0.55;
}

function ellipsize(text: string): string {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  if (total <= LABEL_MAX_W) return text;
  const budget = LABEL_MAX_W - LABEL_FONT;
  let out = '';
  let acc = 0;
  for (const ch of text) {
    acc += charWidth(ch);
    if (acc > budget) break;
    out += ch;
  }
  return `${out}…`;
}

function nodeXY(layer: number, slot: number) {
  return { x: PAD + layer * (NODE_W + GAP_X), y: PAD + HEAD_H + slot * (NODE_H + GAP_Y) };
}

const STARS = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

export function CourseMap({
  nodes,
  edges,
}: {
  readonly nodes: ReadonlyArray<CourseMapNode>;
  readonly edges: ReadonlyArray<readonly [string, string]>;
}) {
  const router = useRouter();
  const [active, setActive] = useState<string | null>(null);
  if (nodes.length === 0) return null;

  const layerCount = Math.max(...nodes.map((n) => n.layer)) + 1;
  const layerWidth = Math.max(...nodes.map((n) => n.slot)) + 1;
  const width = PAD * 2 + layerCount * NODE_W + (layerCount - 1) * GAP_X;
  const height = PAD * 2 + HEAD_H + layerWidth * NODE_H + (layerWidth - 1) * GAP_Y;
  const pos = new Map(nodes.map((n) => [n.id, nodeXY(n.layer, n.slot)]));

  const lit = active
    ? new Set([
        active,
        ...edges.filter((e) => e[0] === active).map((e) => e[1]),
        ...edges.filter((e) => e[1] === active).map((e) => e[0]),
      ])
    : null;

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card p-3">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={`课程路径图，${nodes.length} 门课、${edges.length} 条先修边`}
        className="max-w-none"
        onMouseLeave={() => setActive(null)}
      >
        <defs>
          <marker
            id="cm-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor" className="text-muted-foreground" />
          </marker>
        </defs>

        {Array.from({ length: layerCount }, (_, l) => (
          <text
            key={l}
            x={PAD + l * (NODE_W + GAP_X) + NODE_W / 2}
            y={PAD + 4}
            textAnchor="middle"
            className="fill-muted-foreground"
            fontSize={9}
          >
            第 {l + 1} 层
          </text>
        ))}

        {edges.map((e, i) => {
          const a = pos.get(e[0]);
          const b = pos.get(e[1]);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          const on = !active || e[0] === active || e[1] === active;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="currentColor"
              className={active && on ? 'text-foreground' : 'text-muted-foreground'}
              strokeWidth={active && on ? 1.5 : 1}
              strokeOpacity={0.6}
              markerEnd="url(#cm-arrow)"
              opacity={on ? 1 : 0.12}
            />
          );
        })}

        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          const on = !lit || lit.has(n.id);
          const self = active === n.id;
          const clickable = Boolean(n.courseId);
          const tip = [
            n.title,
            n.audience ? `适合：${n.audience}` : '',
            n.sceneCount ? `${n.sceneCount} 个场景 · 约 ${n.sceneCount * 8} 分钟` : '还没有生成',
            n.prereqTitles?.length ? `先修：${n.prereqTitles.join('、')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <g
              key={n.id}
              tabIndex={0}
              role={clickable ? 'link' : 'img'}
              aria-label={tip.replace(/\n/g, '，')}
              opacity={on ? 1 : 0.28}
              className={clickable ? 'cursor-pointer outline-none' : 'cursor-default outline-none'}
              onMouseEnter={() => setActive(n.id)}
              onFocus={() => setActive(n.id)}
              onBlur={() => setActive(null)}
              onClick={() => clickable && router.push(`/classroom/${n.courseId}`)}
              onKeyDown={(ev) => {
                if (clickable && (ev.key === 'Enter' || ev.key === ' ')) {
                  ev.preventDefault();
                  router.push(`/classroom/${n.courseId}`);
                }
              }}
            >
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className={
                  self
                    ? 'fill-muted stroke-foreground'
                    : clickable
                      ? 'fill-muted stroke-border'
                      : 'fill-transparent stroke-border'
                }
                strokeWidth={self ? 1.5 : 1}
                strokeDasharray={clickable ? undefined : '4 3'}
              />
              <text x={p.x + LABEL_PAD_X} y={p.y + 20} className="fill-foreground" fontSize={LABEL_FONT}>
                {ellipsize(n.title)}
                <title>{tip}</title>
              </text>
              <text
                x={p.x + LABEL_PAD_X}
                y={p.y + 36}
                className="fill-muted-foreground"
                fontSize={9}
              >
                {STARS(Math.min(5, Math.max(1, Math.round(n.difficulty))))}
                {n.sceneCount ? ` · ${n.sceneCount} 场景` : ' · 规划中'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
