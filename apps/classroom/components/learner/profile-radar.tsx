'use client';

/**
 * 学习者画像雷达图。
 *
 * ## 为什么要有它
 *
 * 画像的几个量原本散在页面各处：自评档位在画像面板里是五个下拉，掌握度在盲区图里，
 * 可提取度和置信度只出现在复习那一小段文字里。散着看不出一个人的形状——
 * 「底子厚但还没测过」和「测得多但记不住」在页面上长得一模一样。
 * 这张图把它们放到同一个 0–1 标尺上，一眼能看出短板在哪一维。
 *
 * ## 一条硬规则：缺的维度不画
 *
 * 雷达图最容易撒的谎是拿 0 补缺口——补完形状是完整的，但那个凹陷是「没数据」
 * 不是「不行」，看图的人分不出来。所以这里的做法是：
 *
 * - 没有数据的维度**不进雷达轴**，只在下面的清单里写「暂无数据」和缺的原因；
 * - 可用维度不足 {@link RADAR_MIN_AXES} 个时**整张图都不画**，退回清单——
 *   两根轴的「雷达图」是一条线段，三根以下画出来的形状由缺口决定，不由学习者决定。
 *
 * ## 每个数字都要说得出出处
 *
 * {@link RadarDimension} 带 `how`（怎么算的）和 `source`（数据来自哪），
 * 两句都印在图下面。图是给人看形状的，说清楚靠字。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ECharts } from 'echarts/core';

import { cn } from '@/lib/utils';

/** 少于这么多可用维度就不画雷达图。三根轴是「形状」的下限。 */
export const RADAR_MIN_AXES = 3;

/** 经历自陈档位的满档（0–4 五档，见 learner-profile-popover 的 DIMENSIONS）。 */
export const SELF_LEVEL_MAX = 4;

/** fold 出的三张表按领域取过之后的样子；键是概念，值 0–1。 */
type ConceptTable = Record<string, number> | null | undefined;

export interface ProfileRadarInput {
  /** 本领域逐概念掌握度（证据账本折叠回写）。 */
  conceptMastery?: ConceptTable;
  /** 本领域逐概念置信度（有效样本量折算，0–1）。 */
  conceptConfidence?: ConceptTable;
  /** 本领域逐概念可提取度（随间隔衰减，0–1）。 */
  conceptRecall?: ConceptTable;
  /** 学情诊断返回的掌握度向量。只在本领域还没有实测记录时才作为知识掌握的来源。 */
  masteryVector?: ConceptTable;
  /** 经历自陈档位（0–4）。该领域不适用自评维度时传 null，不要传一串 0。 */
  selfLevels?: Array<number | null | undefined> | null;
  /** 学情诊断返回的技能缺口。老蓝图可能没有 current/target 两个字段。 */
  skillGaps?: Array<{ current_mastery?: number; target_mastery?: number }> | null;
}

export interface RadarDimension {
  key: 'knowledge' | 'prior' | 'goal' | 'retention' | 'evidence';
  label: string;
  /** 0–1；null = 暂无数据，此时不进雷达轴。 */
  value: number | null;
  /** 这个数怎么算出来的。有值时写算式，没值时为空串。 */
  how: string;
  /** 这个数从哪来。有值时写来源，没值时为空串。 */
  source: string;
  /** 没值时：为什么没有。有值时为空串。 */
  missing: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 表里的有效数字取均值。整张表空、或一个有效数字都没有时返回 null。 */
function meanOfTable(table: ConceptTable): { mean: number; count: number } | null {
  if (!table) return null;
  const values = Object.values(table).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + clamp01(v), 0);
  return { mean: sum / values.length, count: values.length };
}

/**
 * 画像 → 雷达维度。纯函数，永远返回五项、顺序固定；拿不到数据的那几项 `value` 为 null。
 *
 * **不要给缺数据的维度补 0 或补默认值。** 这里每加一个兜底值，图上就多一个
 * 看不出来是编的凹陷——那正是这张图要避免的事。
 */
export function computeProfileRadar(input: ProfileRadarInput): RadarDimension[] {
  const measured = meanOfTable(input.conceptMastery);
  const engine = meanOfTable(input.masteryVector);
  // 知识掌握优先用本领域实测：实测是这个人真答过题算出来的，诊断向量是引擎按
  // 画像推的。两者都在时不做平均——平均出来的数没有出处可写。
  const knowledge: RadarDimension = measured
    ? {
        key: 'knowledge',
        label: '知识掌握',
        value: clamp01(measured.mean),
        how: `本领域 ${measured.count} 个已测概念的掌握度取均值`,
        source: '证据账本折叠回写的画像（答题与导学判定累积）',
        missing: '',
      }
    : engine
      ? {
          key: 'knowledge',
          label: '知识掌握',
          value: clamp01(engine.mean),
          how: `学情诊断给出的 ${engine.count} 个概念掌握度取均值（尚无实测记录，用的是诊断估计）`,
          source: '多智能体引擎学情诊断（/api/adaptive/blueprint）',
          missing: '',
        }
      : {
          key: 'knowledge',
          label: '知识掌握',
          value: null,
          how: '',
          source: '',
          missing: '本领域还没有答题记录，学情诊断也没有返回掌握度向量',
        };

  const levels = (input.selfLevels ?? []).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const prior: RadarDimension =
    levels.length > 0
      ? {
          key: 'prior',
          label: '先验基础',
          value: clamp01(
            levels.reduce((acc, v) => acc + Math.min(SELF_LEVEL_MAX, Math.max(0, v)), 0) /
              levels.length /
              SELF_LEVEL_MAX,
          ),
          how: `${levels.length} 项经历自陈的档位（0–${SELF_LEVEL_MAX}）取均值，再除以 ${SELF_LEVEL_MAX} 折到 0–1`,
          source: '画像面板的「经历自陈」，做过前测校准的档位已按实测校正',
          missing: '',
        }
      : {
          key: 'prior',
          label: '先验基础',
          value: null,
          how: '',
          source: '',
          missing: '当前领域不使用那五项经历自陈，或画像里一项都没填',
        };

  const pairs = (input.skillGaps ?? []).filter(
    (g) =>
      typeof g?.current_mastery === 'number' &&
      Number.isFinite(g.current_mastery) &&
      typeof g?.target_mastery === 'number' &&
      Number.isFinite(g.target_mastery),
  );
  const goal: RadarDimension =
    pairs.length > 0
      ? {
          key: 'goal',
          label: '目标达成',
          value: clamp01(
            pairs.reduce((acc, g) => {
              const target = g.target_mastery as number;
              const current = g.current_mastery as number;
              // 目标是 0 的缺口没有要补的东西，按已达成算，不能除。
              return acc + (target > 0 ? clamp01(current / target) : 1);
            }, 0) / pairs.length,
          ),
          how: `${pairs.length} 个技能缺口各按「当前掌握度 ÷ 目标掌握度」折算（封顶 1），再取均值`,
          source: '多智能体引擎学情诊断的 skill_gaps',
          missing: '',
        }
      : {
          key: 'goal',
          label: '目标达成',
          value: null,
          how: '',
          source: '',
          missing: '还没有拿到带目标掌握度的技能缺口——它由学情诊断算出，在学情报告页里',
        };

  const recall = meanOfTable(input.conceptRecall);
  const retention: RadarDimension = recall
    ? {
        key: 'retention',
        label: '巩固保持',
        value: clamp01(recall.mean),
        how: `本领域 ${recall.count} 个已测概念的可提取度取均值（距上次作答越久越低）`,
        source: '证据账本折叠出的 recall，是到期复习的判据',
        missing: '',
      }
    : {
        key: 'retention',
        label: '巩固保持',
        value: null,
        how: '',
        source: '',
        missing: '本领域还没有可提取度记录——做完一次测验或导学问答才会有',
      };

  const confidence = meanOfTable(input.conceptConfidence);
  const evidence: RadarDimension = confidence
    ? {
        key: 'evidence',
        label: '测评把握',
        value: clamp01(confidence.mean),
        how: `本领域 ${confidence.count} 个已测概念的置信度取均值（问得越多越高）`,
        source: '证据账本折叠出的 confidence，答的是「我们有多确定」不是「他会不会」',
        missing: '',
      }
    : {
        key: 'evidence',
        label: '测评把握',
        value: null,
        how: '',
        source: '',
        missing: '本领域还没有测评证据',
      };

  return [knowledge, prior, goal, retention, evidence];
}

/** 有数据、能上雷达轴的那几维。 */
export function availableDimensions(dimensions: readonly RadarDimension[]): RadarDimension[] {
  return dimensions.filter((d) => d.value !== null);
}

/** 主题色按 CSS 变量取真值——echarts 收的是颜色字符串，`var(--x)` 传进去不生效。 */
function readThemeColors(): { line: string; axis: string; label: string } {
  if (typeof window === 'undefined') {
    return { line: '#722ed1', axis: '#d4d4d8', label: '#71717a' };
  }
  const style = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    line: read('--primary', '#722ed1'),
    axis: read('--border', '#d4d4d8'),
    label: read('--muted-foreground', '#71717a'),
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 画像雷达图 + 逐维口径清单。学情报告页的画像区与首页自画像面板共用这一个。
 *
 * echarts 走动态 import：首页在评审，首屏 bundle 不能因为一张图涨一截。
 * 图只在客户端 effect 里初始化，SSR 阶段这里什么都不做。
 */
export function ProfileRadar({
  input,
  height = 240,
  className,
}: {
  input: ProfileRadarInput;
  /** 画布高度（px）。面板窄，传小一点。 */
  height?: number;
  className?: string;
}) {
  const dimensions = useMemo(() => computeProfileRadar(input), [input]);
  const available = useMemo(() => availableDimensions(dimensions), [dimensions]);
  const canDraw = available.length >= RADAR_MIN_AXES;

  const holder = useRef<HTMLDivElement | null>(null);
  const [dark, setDark] = useState(false);

  // 主题切换要重画：颜色是初始化时按 CSS 变量读的真值，不会自己跟着变。
  // 只在深浅真的翻转时改 state——弹层开合会动 <html> 上的别的属性，
  // 无条件 bump 会把图反复重建一遍。
  useEffect(() => {
    const read = () => document.documentElement.classList.contains('dark');
    setDark(read());
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // 依赖只认可用维度的名字与数值，不认整个 input 对象：调用方每次渲染都会新建
  // 一个字面量对象，按对象比会导致每帧重建图表。
  const seriesKey = available.map((d) => `${d.key}:${d.value?.toFixed(4)}`).join('|');

  useEffect(() => {
    if (!canDraw) return;
    const el = holder.current;
    if (!el) return;
    let disposed = false;
    let chart: ECharts | null = null;
    let observer: ResizeObserver | null = null;

    void (async () => {
      try {
        const [core, charts, components, renderers] = await Promise.all([
          import('echarts/core'),
          import('echarts/charts'),
          import('echarts/components'),
          import('echarts/renderers'),
        ]);
        if (disposed) return;
        core.use([charts.RadarChart, components.TooltipComponent, renderers.SVGRenderer]);
        const colors = readThemeColors();
        chart = core.init(el, undefined, { renderer: 'svg' });
        chart.setOption({
          animation: false,
          tooltip: {
            trigger: 'item',
            confine: true,
            borderWidth: 0,
            formatter: () =>
              available.map((d) => `${d.label} ${percent(d.value as number)}`).join('<br/>'),
          },
          radar: {
            shape: 'polygon',
            center: ['50%', '54%'],
            radius: '62%',
            splitNumber: 4,
            indicator: available.map((d) => ({ name: d.label, max: 1 })),
            axisName: { color: colors.label, fontSize: 12 },
            axisLine: { lineStyle: { color: colors.axis } },
            splitLine: { lineStyle: { color: colors.axis } },
            splitArea: { show: false },
          },
          series: [
            {
              type: 'radar',
              symbolSize: 4,
              lineStyle: { color: colors.line, width: 1.5 },
              itemStyle: { color: colors.line },
              areaStyle: { color: colors.line, opacity: 0.1 },
              data: [{ value: available.map((d) => d.value as number), name: '当前画像' }],
            },
          ],
        });
        // jsdom 与个别老浏览器没有 ResizeObserver。没有就不自适应宽度，
        // 图照画——不能因为少一个可选能力把整块渲染吞成一条未捕获的 rejection。
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => chart?.resize());
          observer.observe(el);
        }
      } catch {
        // 图表分包没加载出来（离线、chunk 404）时保持清单可读，不炸整页。
        chart?.dispose();
        chart = null;
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- available 由 seriesKey 代表，见上面注释
  }, [canDraw, seriesKey, dark, height]);

  return (
    <div className={cn('space-y-2', className)}>
      {canDraw ? (
        <div
          ref={holder}
          role="img"
          aria-label={`学习者画像雷达图：${available.map((d) => `${d.label} ${percent(d.value as number)}`).join('，')}`}
          style={{ height }}
          className="w-full"
        />
      ) : (
        <p className="rounded-md border border-dashed border-border/70 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
          有数据的维度只有 {available.length} 个，不足 {RADAR_MIN_AXES} 个，这里不画雷达图——
          三根轴以下画出来的形状由缺口决定，不由你的学习情况决定。下面按维度逐条列出。
        </p>
      )}

      <dl className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border/70">
        {dimensions.map((d) => (
          <div key={d.key} className="px-2.5 py-1.5">
            <dt className="flex items-baseline gap-2">
              <span className="text-[11px] font-medium text-foreground">{d.label}</span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {d.value === null ? '暂无数据' : percent(d.value)}
              </span>
            </dt>
            <dd className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {d.value === null ? d.missing : `${d.how}；来自${d.source}`}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        五个维度都折到 0–1 同一把标尺上。没有数据的维度不进雷达轴，也不补 0——
        补出来的凹陷分不清是「还不行」还是「还没测」。
      </p>
    </div>
  );
}
