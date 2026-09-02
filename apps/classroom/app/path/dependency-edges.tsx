'use client';

// 硬依赖连线。规格 docs/03-design/learning-path-practice-spec-20260809.md §1.1 原话：
// 「三层结构（分区排布，只画硬依赖边）……阶段感靠空间分区表达，依赖只在硬性处画箭头；
// 不做全连接依赖图」，§1.5 又写「分区布局，CSS grid 三列，不引图库——节点少于 30 个
// 用不着 React Flow」。所以规格要的是「不引图库、不画全连接图」，不是一条箭头都不画。
// 我们照这个口径做：零依赖的内联 SVG，只画同一分区内的 prereq 边。
//
// 跨分区依赖不画线，仍由卡片上的「先修：」文字承担——它同时是读屏和窄屏的唯一通道，
// 所以连线整体 aria-hidden，删掉也不丢信息。
// 窄屏（单列）整块不渲染：单列下每条边都退化成一条穿过卡片的竖线，画了只是挡视线。

import { useCallback, useEffect, useId, useRef, useState } from 'react';

/** 卡片相对本容器的位置，单位 px */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
}

export function DependencyEdges({
  edges,
  children,
}: {
  /** [先修节点 id, 后继节点 id]，两端都必须在本容器内 */
  readonly edges: ReadonlyArray<readonly [string, string]>;
  readonly children: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const markerId = useId();
  const [paths, setPaths] = useState<readonly string[]>([]);

  const draw = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const base = host.getBoundingClientRect();
    const boxOf = (id: string): Box | null => {
      const el = host.querySelector(`[data-node="${CSS.escape(id)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left - base.left,
        top: r.top - base.top,
        right: r.right - base.left,
        bottom: r.bottom - base.top,
        cx: r.left - base.left + r.width / 2,
        cy: r.top - base.top + r.height / 2,
      };
    };

    // 单列（窄屏）下不画：判据取真实几何——所有卡片横向中心重合就是单列。
    // 单列时每条边都退化成一条穿过卡片的竖线，画了只挡视线。
    const centers = [...host.querySelectorAll('[data-node]')].map(
      (el) => el.getBoundingClientRect().left,
    );
    if (centers.length > 1 && centers.every((x) => Math.abs(x - centers[0]) < 4)) {
      setPaths([]);
      return;
    }

    const next: string[] = [];
    for (const [from, to] of edges) {
      const a = boxOf(from);
      const b = boxOf(to);
      if (!a || !b) continue;
      const head = 7; // 给箭头留出的落点余量
      if (Math.abs(a.cy - b.cy) < 4 && b.left >= a.right) {
        // 同一行、后继在右：横直线走列间距
        next.push(`M${a.right} ${a.cy}H${b.left - head}`);
      } else if (b.top >= a.bottom) {
        // 后继在下方：从下边缘中点走 S 形到上边缘中点
        const mid = (a.bottom + b.top) / 2;
        next.push(`M${a.cx} ${a.bottom}C${a.cx} ${mid},${b.cx} ${mid},${b.cx} ${b.top - head}`);
      }
      // 其余方向（后继在上方或左侧）不画：连线要横穿卡片，看不清也帮不上忙，
      // 这些依赖由「先修：」文字说明。
    }
    setPaths(next);
  }, [edges]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(draw);
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') {
      return () => window.cancelAnimationFrame(frame);
    }
    // 卡片高度随字体加载/换行变化都会改容器尺寸，观察容器即可覆盖
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => {
      window.cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [draw]);

  return (
    <div ref={hostRef} className="relative">
      {/* 卡片层在上（bg-card 不透明），连线从卡片背后穿过 */}
      <div className="relative z-10">{children}</div>
      {paths.length > 0 && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 h-full w-full text-muted-foreground/70"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0.5 L7 4 L0 7.5 z" fill="currentColor" />
            </marker>
          </defs>
          {paths.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              markerEnd={`url(#${markerId})`}
            />
          ))}
        </svg>
      )}
    </div>
  );
}
