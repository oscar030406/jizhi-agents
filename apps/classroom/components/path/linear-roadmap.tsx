'use client';

/**
 * 线性路线图（学习端 /path 的第三块）。
 *
 * 两张图讲结构，这条线讲顺序：一站一个概念，从当前位置往前后看，横向可滚，
 * 挂了课的站点可以直接点进课程。数据整理在 lib/learner/roadmap.ts 里（纯函数，单测在
 * tests/learner/roadmap.test.ts），这里只负责画。
 *
 * ## 颜色
 *
 * 语义沿用知识宇宙的图例（knowledge-universe.tsx 的 COLOR / 图例）：
 * 已掌握 / 当前推荐 / 未测的概念 / 先学 / 学完可去。但色值不能照抄——那面板是固定深色、
 * 点用加法混合画的，那几个亮色（#7dd3fc、#fbbf24）搬到跟随主题的白底页面上会糊成一片。
 * 这里改用站点自己的语义色对（globals.css 的 `--blue-*` / `--yellow-*` / `--green-*`，
 * 明暗两套都有定义），色相尽量对齐：已掌握=蓝、先学=黄、学完可去=绿（宇宙里是青，
 * 站点变量里没有青，绿是最近的一档）、当前推荐用主色、未测留灰空心（与前置图
 * 「灰底空心是还没测过」同一口径）。
 *
 * 纯展示：不取数、不改顺序，输入就是 domain-learning-path.tsx 已经合好的那份节点表。
 */

import { useEffect, useMemo, useRef, type Ref } from 'react';
import Link from 'next/link';

import { truncateLabel } from '@/lib/knowledge/domain-registry';
import {
  buildRoadmap,
  type RoadmapInputNode,
  type RoadmapInputStage,
  type RoadmapStation,
  type RoadmapStatus,
} from '@/lib/learner/roadmap';
import { cn } from '@/lib/utils';

/** 图例文案。与知识宇宙图例同名，「先学」补一句卡在哪，否则一条线上看不出它指谁。 */
const STATUS_TEXT: Record<RoadmapStatus, string> = {
  mastered: '已掌握',
  current: '当前推荐',
  ready: '学完可去',
  blocked: '先学前置',
  unmeasured: '未测',
};

const LEGEND: ReadonlyArray<[RoadmapStatus, string]> = [
  ['mastered', '已掌握'],
  ['current', '当前推荐'],
  ['ready', '学完可去'],
  ['blocked', '先学（前置未达标）'],
  ['unmeasured', '未测的概念'],
];

/** 站点圆点。图例小方块用同一套类，改一处两处都变。 */
const DOT_CLASS: Record<RoadmapStatus, string> = {
  mastered: 'bg-blue-deep',
  current: 'bg-primary',
  ready: 'bg-green-deep',
  blocked: 'bg-yellow-deep',
  unmeasured: 'border border-border bg-card',
};

const CARD_CLASS: Record<RoadmapStatus, string> = {
  mastered: 'border-blue-deep/30 bg-blue-soft/60',
  current: 'border-primary bg-primary/10',
  ready: 'border-green-deep/30 bg-green-soft/60',
  blocked: 'border-yellow-deep/30 bg-yellow-soft/60',
  unmeasured: 'border-border bg-card',
};

const STATUS_CLASS: Record<RoadmapStatus, string> = {
  mastered: 'text-blue-deep',
  current: 'text-primary',
  ready: 'text-green-deep',
  blocked: 'text-yellow-deep',
  unmeasured: 'text-muted-foreground',
};

export function LinearRoadmap({
  nodes,
  stages,
}: {
  readonly nodes: ReadonlyArray<RoadmapInputNode>;
  readonly stages?: ReadonlyArray<RoadmapInputStage>;
}) {
  const roadmap = useMemo(() => buildRoadmap(nodes, stages ?? []), [nodes, stages]);
  const scroller = useRef<HTMLDivElement>(null);
  const cursorItem = useRef<HTMLLIElement>(null);

  // 打开就停在当前位置上。用 scrollLeft 而不是 scrollIntoView：后者会连带把整页
  // 往下滚一段，读者一进 /path 就丢了标题。
  useEffect(() => {
    const box = scroller.current;
    const item = cursorItem.current;
    if (!box || !item) return;
    box.scrollLeft = Math.max(0, item.offsetLeft - box.clientWidth / 2 + item.clientWidth / 2);
  }, [roadmap]);

  if (roadmap.stations.length === 0) {
    return (
      <section aria-label="学习路线" className="mt-6">
        <p className="text-sm font-semibold">学习路线</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          引擎没有给出本领域的阶次，这条线排不出来。路线的顺序只来自引擎的前置关系与阶次，
          没有产物时不另行推测。
        </p>
      </section>
    );
  }

  const cursor = roadmap.cursor >= 0 ? roadmap.stations[roadmap.cursor] : null;

  return (
    <section aria-label="学习路线" className="mt-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-semibold">学习路线</p>
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          {cursor
            ? `共 ${roadmap.stations.length} 站，当前在第 ${roadmap.cursor + 1} 站「${cursor.label}」（${cursor.stageTitle}）。`
            : `共 ${roadmap.stations.length} 站，本领域概念均已达标，没有待推进的站。`}
          {roadmap.measured ? '' : '还没有同源测评，游标停在第一站。'}
        </p>
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {LEGEND.map(([status, text]) => (
          <li key={status} className="flex items-center gap-1.5">
            <span className={cn('inline-block size-2.5 rounded-full', DOT_CLASS[status])} />
            {text}
            <span className="tabular-nums">{roadmap.counts[status]}</span>
          </li>
        ))}
      </ul>

      <div
        ref={scroller}
        className="mt-2 overflow-x-auto rounded-xl border border-border bg-card"
        // 横向滚动的列表要自己能用键盘滚，否则只有鼠标能看到后面的站
        tabIndex={0}
        role="group"
        aria-label="路线站点，可横向滚动"
      >
        <ol className="flex min-w-max items-stretch px-3 py-3">
          {roadmap.stations.map((station, index) => (
            <Station
              key={station.id}
              station={station}
              first={index === 0}
              last={index === roadmap.stations.length - 1}
              current={index === roadmap.cursor}
              ref={index === roadmap.cursor ? cursorItem : undefined}
            />
          ))}
        </ol>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        站点顺序来自引擎的前置关系与阶次；测评只移动当前位置，不改顺序。挂了课的站点可以点开课程。
      </p>
    </section>
  );
}

function Station({
  station,
  first,
  last,
  current,
  ref,
}: {
  readonly station: RoadmapStation;
  readonly first: boolean;
  readonly last: boolean;
  readonly current: boolean;
  /** React 19 起 ref 就是普通 prop，不用 forwardRef */
  readonly ref?: Ref<HTMLLIElement>;
}) {
  const course = station.courses[0];
  const detail =
    station.status === 'blocked' && station.blockedBy.length
      ? `先学：${station.blockedBy
          .slice(0, 2)
          .map((name) => truncateLabel(name, 10))
          .join('、')}`
      : station.mastery !== null
        ? `掌握度 ${station.mastery.toFixed(2)}`
        : '';

  const body = (
    <>
      <p className="line-clamp-2 text-xs font-medium leading-snug">
        {truncateLabel(station.label, 16)}
      </p>
      <p className={cn('mt-1 text-[11px]', STATUS_CLASS[station.status])}>
        {STATUS_TEXT[station.status]}
      </p>
      {detail && (
        <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
          {detail}
        </p>
      )}
      <p className="mt-1 truncate text-[10px] text-muted-foreground">
        {station.courses.length === 0
          ? '还没有课'
          : station.courses.length === 1
            ? truncateLabel(course!.title, 12)
            : `${station.courses.length} 门课`}
      </p>
    </>
  );

  return (
    <li ref={ref} className="relative flex w-36 shrink-0 flex-col">
      {/* 站点之间的连线。首末两站各截掉外侧半段，线不许探出列表两端。 */}
      <div aria-hidden className="relative h-3">
        <span
          className={cn(
            'absolute top-1/2 h-px bg-border',
            first ? 'left-1/2 right-0' : last ? 'left-0 right-1/2' : 'left-0 right-0',
          )}
        />
        <span
          className={cn(
            'absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
            DOT_CLASS[station.status],
            current && 'ring-2 ring-primary/50 ring-offset-1 ring-offset-card',
          )}
        />
      </div>

      <p className="h-4 px-1 text-center text-[10px] text-muted-foreground">
        {station.stageHead ? truncateLabel(station.stageTitle, 9) : ''}
      </p>

      {/* flex + flex-1：一行里所有卡片等高，标签折行的那张不会比邻居矮一截 */}
      <div className="flex flex-1 px-1 pb-1">
        {course ? (
          <Link
            href={`/classroom/${course.id}`}
            className={cn(
              'w-full rounded-lg border px-2 py-1.5 transition-colors hover:border-primary/60',
              CARD_CLASS[station.status],
            )}
            title={`${station.label} · ${STATUS_TEXT[station.status]}`}
          >
            {body}
          </Link>
        ) : (
          <div
            className={cn('w-full rounded-lg border px-2 py-1.5', CARD_CLASS[station.status])}
            title={`${station.label} · ${STATUS_TEXT[station.status]}`}
          >
            {body}
          </div>
        )}
      </div>
    </li>
  );
}
