/**
 * 学习路径规划图（赛题五(3)① 点名的三张图之一，机构维度）。
 *
 * 内联 SVG，零依赖：概念是十几个的量级，力导向布局解决的问题我们没有。
 * 分层由 `lib/server/knowledge-map.ts` 拓扑算好，这里只排版。
 *
 * 两条如实呈现，不许为了好看抹掉：
 * - 未经人工签字的边画虚线。设计稿 §7.6 只允许人工签字的边当硬前置，
 *   模型抽的一律软前置，画成实线会让读者以为它拦得住人。
 * - 孤立点单列。图里没有任何前置关系的概念是最可疑的部分，藏起来等于粉饰。
 *
 * 改成客户端组件只为一件事：悬停或键盘聚焦一个概念时，把它的前驱后继挑出来、其余压暗。
 * 十几个节点、十条边，人眼顺着箭头追一条链要来回扫好几遍，这个高亮是替读者做那件事。
 * 除此之外没有任何状态，图形仍然是服务端算好的。
 */

'use client';

import { useState } from 'react';

import type { DomainMap } from '@/lib/server/knowledge-map';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { Caliber } from './caliber';
import { TIER_FILL, TIER_BG, TIER_UNKNOWN_BG, tierLabel } from './difficulty-scale';

const NODE_W = 132;
const NODE_H = 44;
const GAP_X = 72;
const GAP_Y = 18;
const PAD = 16;
/** 顶上留一条层号带。层号原来印在每个节点里，18 个节点重复 18 遍，抬到轴上说一次就够 */
const HEAD_H = 20;
const LABEL_FONT = 11;
const LABEL_PAD_X = 11;
/** 可用宽度：节点宽减两侧内边距，再留 6px 安全边（中文字面宽不严格等于字号，实测会超 1px） */
const LABEL_MAX_W = NODE_W - LABEL_PAD_X * 2 - 6;

/**
 * 按**字面宽**截断，不按字数。中文一字约等于字号，拉丁字母/数字约 0.55 倍。
 * 原来按字数算（可用宽 / 字号 = 9 字）：中文没问题，拉丁标签全废——概念图谱里没条目的概念
 * 标题回落成 id，`embodied_ros2`、`embodied_vla` 这些在第 9 个字符被砍，
 * embodied 域 7 个节点在图上全叫「embodied…」，等于没有标签。
 */
function charWidth(ch: string): number {
  return /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? LABEL_FONT : LABEL_FONT * 0.55;
}

function ellipsize(text: string): string {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  if (total <= LABEL_MAX_W) return text;
  const budget = LABEL_MAX_W - LABEL_FONT; // 省略号自己占一格
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

export function KnowledgeMap({ map }: { readonly map: DomainMap }) {
  /** 当前悬停/聚焦的概念。null = 全图常态 */
  const [active, setActive] = useState<string | null>(null);

  if (map.nodes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
        这个域在前置图里没有概念条目，画不出图。
      </p>
    );
  }

  const width = PAD * 2 + map.layerCount * NODE_W + (map.layerCount - 1) * GAP_X;
  const height = PAD * 2 + HEAD_H + map.layerWidth * NODE_H + (map.layerWidth - 1) * GAP_Y;
  const pos = new Map(map.nodes.map((n) => [n.id, nodeXY(n.layer, n.slot)]));

  // 出入度印在节点上：图上看得出「谁是枢纽」，比再画一遍箭头省事
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of map.edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  // 高亮集合 = 自己 + 直接前驱 + 直接后继。只走一跳：两跳以外全亮等于没高亮
  const lit = active
    ? new Set([
        active,
        ...map.edges.filter((e) => e.from === active).map((e) => e.to),
        ...map.edges.filter((e) => e.to === active).map((e) => e.from),
      ])
    : null;

  const tiers = [...new Set(map.nodes.map((n) => n.difficulty))].sort();
  const signed = map.edges.filter((e) => e.reviewed).length;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-border bg-card p-3">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={`${domainLabel(map.domain)} 领域的概念前置图，${map.nodes.length} 个概念、${map.edges.length} 条前置边`}
          className="max-w-none"
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <marker id="kg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" className="text-muted-foreground" />
            </marker>
          </defs>

          {/* 层号带：横轴是「第几层前置」，说一次 */}
          {Array.from({ length: map.layerCount }, (_, l) => (
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

          {map.edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const on = !active || e.from === active || e.to === active;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                // 常态一律走 muted：边是图的底纹，不该压过节点。只有挑出来那一跳才提到正文色
                className={active && on ? 'text-foreground' : 'text-muted-foreground'}
                strokeWidth={active && on ? 1.5 : 1}
                strokeOpacity={0.35 + 0.5 * Math.min(Math.max(e.confidence, 0), 1)}
                strokeDasharray={e.reviewed ? undefined : '4 3'}
                markerEnd="url(#kg-arrow)"
                // opacity 而不是 stroke-opacity：箭头是 marker，只有 opacity 压得住它
                opacity={on ? 1 : 0.12}
              >
                <title>
                  {`${e.from} → ${e.to}｜置信度 ${e.confidence}｜${e.reviewed ? '人工已签字（硬前置）' : '未签字（软前置，不拦人）'}`}
                </title>
              </path>
            );
          })}

          {map.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const on = !lit || lit.has(n.id);
            const self = active === n.id;
            return (
              <g
                key={n.id}
                tabIndex={0}
                role="img"
                aria-label={`${n.title}，难度 ${tierLabel(n.difficulty)}，第 ${n.layer + 1} 层，前置 ${inDeg.get(n.id) ?? 0} 个、后继 ${outDeg.get(n.id) ?? 0} 个`}
                opacity={on ? 1 : 0.28}
                className="cursor-default outline-none"
                onMouseEnter={() => setActive(n.id)}
                onFocus={() => setActive(n.id)}
                onBlur={() => setActive(null)}
              >
                <rect
                  x={p.x}
                  y={p.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  className={self ? 'fill-muted stroke-foreground' : 'fill-muted stroke-border'}
                  strokeWidth={self ? 1.5 : 1}
                />
                <rect
                  x={p.x}
                  y={p.y}
                  width={4}
                  height={NODE_H}
                  rx={2}
                  className={TIER_FILL[n.difficulty] ?? 'fill-transparent'}
                />
                <text
                  x={p.x + LABEL_PAD_X}
                  y={p.y + 19}
                  className="fill-foreground"
                  fontSize={LABEL_FONT}
                >
                  {ellipsize(n.title)}
                  <title>{`${n.title}（${n.id}）`}</title>
                </text>
                <text x={p.x + LABEL_PAD_X} y={p.y + 33} className="fill-muted-foreground" fontSize={9}>
                  {tierLabel(n.difficulty)} · 前置 {inDeg.get(n.id) ?? 0} · 后继 {outDeg.get(n.id) ?? 0}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* 默认视图只留图例与两个数：色阶怎么读、多少条边经人工签字、多少个概念是孤立的。
          怎么读这张图、签字与没签字的边分别算什么、孤立点是哪几个——一个字不删，
          全在下面的折叠里（08-16 用户评审：管理端小字堆砌，处理办法是分层不是删）。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          难度
          {tiers.map((t) => (
            <span key={t} className="inline-flex items-center gap-1">
              <span className={`inline-block h-2.5 w-1 rounded-sm ${TIER_BG[t] ?? TIER_UNKNOWN_BG}`} />
              {tierLabel(t)}
            </span>
          ))}
        </span>
        <span className="tabular-nums">
          前置边 {signed}/{map.edges.length} 条经人工签字
        </span>
        {map.isolated.length > 0 && (
          <span className="tabular-nums">{map.isolated.length} 个概念无前置关系</span>
        )}
      </div>

      <Caliber summary="展开：这张图怎么读、哪些边拦得住人、孤立的是哪几个">
        <p>
          横轴是前置层级，越靠右越依赖前面的概念；节点上的「前置 / 后继」是该概念在本图里的
          入度与出度。悬停或 Tab 到一个概念，图上只留它的直接前驱与后继。
        </p>
        <p>
          实线是经人工签字的边（硬前置），虚线是模型抽的软前置——只作选点建议，不拦人。
          本图 {map.edges.length} 条边里签过字的有 {signed} 条。
        </p>
        {map.isolated.length > 0 && (
          <p>
            不在任何前置关系里的 {map.isolated.length} 个概念：
            <span className="text-foreground">{map.isolated.join('、')}</span>
            ——它们要么真的独立，要么是造图时漏了，单列出来供人工核。
          </p>
        )}
      </Caliber>
    </div>
  );
}
