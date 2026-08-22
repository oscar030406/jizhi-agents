'use client';

import { useMemo, useState } from 'react';
import type { LayeredGraphParams } from '@/lib/types/widgets';

/** 分层拓扑图：点一个节点，高亮它连出去和连进来的边，下面写清它跟谁说话。
 * 列的位置、节点的坐标、边的走线全是这里算的，LLM 只给「谁在第几层、谁连谁」——
 * 老 diagram widget 让模型自己排版，反复生成失败，这个模板就是为了不重蹈那条路。
 * 与 ProcessStepper 的分工：线性一条链用步进器，有分叉/汇聚/回边的用这个。 */

const W = 560;
const NW = 112; // 节点框宽
const NH = 32;
const ROW = 46; // 同层相邻节点的行距
const TITLE_H = 22;
const BACK_LANE = 22; // 回边专用的下方走线通道，有回边才腾这段高度

interface Placed {
  id: string;
  label: string;
  note?: string;
  layer: number;
  cx: number;
  cy: number;
}

export default function LayeredGraph({ params }: { params: LayeredGraphParams }) {
  const [sel, setSel] = useState<string | null>(null);

  const { placed, byId, height } = useMemo(() => {
    const cols = params.layers.length;
    const slotW = W / cols;
    const maxRows = Math.max(...params.layers.map((l) => l.nodes.length));
    const list: Placed[] = [];
    params.layers.forEach((layer, li) => {
      const n = layer.nodes.length;
      // 每层在垂直方向居中，层与层之间节点数不同也不会错位
      const top = TITLE_H + ((maxRows - n) * ROW) / 2;
      layer.nodes.forEach((node, ni) => {
        list.push({
          ...node,
          layer: li,
          cx: slotW * (li + 0.5),
          cy: top + ni * ROW + ROW / 2,
        });
      });
    });
    const map = new Map(list.map((p) => [p.id, p]));
    // 回边要从节点下方绕过去，有回边才加这段通道——没有的话别白留一条空白
    const hasBack = params.edges.some((e) => {
      const a = map.get(e.from);
      const b = map.get(e.to);
      return a && b && b.layer < a.layer;
    });
    return {
      placed: list,
      byId: map,
      height: TITLE_H + maxRows * ROW + 10 + (hasBack ? BACK_LANE : 0),
    };
  }, [params.layers, params.edges]);

  // 校验器保证两端都存在，这里的 filter 只是让组件对手工构造的参数也不崩
  const edges = useMemo(
    () =>
      params.edges
        .map((e) => ({ ...e, a: byId.get(e.from), b: byId.get(e.to) }))
        .filter((e): e is typeof e & { a: Placed; b: Placed } => !!e.a && !!e.b),
    [params.edges, byId],
  );

  const linked = useMemo(() => {
    if (!sel) return null;
    const out = edges.filter((e) => e.from === sel);
    const inc = edges.filter((e) => e.to === sel);
    return {
      out,
      inc,
      ids: new Set([sel, ...out.map((e) => e.to), ...inc.map((e) => e.from)]),
    };
  }, [sel, edges]);

  const dim = (id: string) => (linked && !linked.ids.has(id) ? 0.3 : 1);
  const slotW = W / params.layers.length;
  const selNode = sel ? byId.get(sel) : undefined;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${height}`} className="w-full min-w-[30rem]" role="img" aria-label="分层拓扑图">
          {params.layers.map((l, i) => (
            <text
              key={l.title}
              x={slotW * (i + 0.5)}
              y={13}
              textAnchor="middle"
              className="fill-current text-[10px] opacity-50"
            >
              {l.title}
            </text>
          ))}

          {edges.map((e, i) => {
            const back = e.b.layer < e.a.layer;
            const active = !linked || e.from === sel || e.to === sel;
            const stroke = active && linked ? 'stroke-blue-deep' : 'stroke-border';
            const width = active && linked ? 2 : 1.2;
            // 回边直连会横穿中间那一列的节点框（实测就是这么被吃掉的），改成从底下绕
            const lane = height - 8;
            const geom = back
              ? {
                  d: `M ${e.a.cx} ${e.a.cy + NH / 2} C ${e.a.cx} ${lane}, ${e.b.cx} ${lane}, ${e.b.cx} ${e.b.cy + NH / 2}`,
                  lx: (e.a.cx + e.b.cx) / 2,
                  ly: lane - 3,
                }
              : {
                  d: `M ${e.a.cx + NW / 2} ${e.a.cy} L ${e.b.cx - NW / 2} ${e.b.cy}`,
                  lx: (e.a.cx + NW / 2 + e.b.cx - NW / 2) / 2,
                  ly: (e.a.cy + e.b.cy) / 2 - 3,
                };
            return (
              <g key={i} opacity={active ? 1 : 0.15}>
                <path
                  d={geom.d}
                  fill="none"
                  className={stroke}
                  strokeWidth={width}
                  strokeDasharray={back ? '4 3' : undefined}
                />
                {e.label && (
                  <text
                    x={geom.lx}
                    y={geom.ly}
                    textAnchor="middle"
                    className="fill-current text-[9px] opacity-55"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {placed.map((p) => {
            const on = sel === p.id;
            return (
              <g
                key={p.id}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={p.label}
                opacity={dim(p.id)}
                className="cursor-pointer outline-none"
                onClick={() => setSel(on ? null : p.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    setSel(on ? null : p.id);
                  }
                }}
              >
                <rect
                  x={p.cx - NW / 2}
                  y={p.cy - NH / 2}
                  width={NW}
                  height={NH}
                  rx={6}
                  className={
                    on ? 'fill-blue-deep/15 stroke-blue-deep' : 'fill-card stroke-border hover:stroke-blue-deep/60'
                  }
                  strokeWidth={on ? 2 : 1}
                />
                <text
                  x={p.cx}
                  y={p.cy + 4}
                  textAnchor="middle"
                  className={`text-[11px] ${on ? 'fill-blue-deep font-semibold' : 'fill-current'}`}
                >
                  {p.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-xs">
        {selNode && linked ? (
          <>
            <p className="font-medium">{selNode.label}</p>
            {selNode.note && (
              <p className="mt-1 leading-relaxed text-muted-foreground">{selNode.note}</p>
            )}
            <p className="mt-1.5 text-muted-foreground">
              → 输出到：
              {linked.out.length
                ? linked.out.map((e) => byId.get(e.to)?.label).join('、')
                : '（终点，没有下游）'}
            </p>
            <p className="text-muted-foreground">
              ← 输入自：
              {linked.inc.length
                ? linked.inc.map((e) => byId.get(e.from)?.label).join('、')
                : '（起点，没有上游）'}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            点任意一个节点，看它连出去和连进来的是谁；虚线是回流边（从右往左）。
          </p>
        )}
      </div>
    </div>
  );
}
