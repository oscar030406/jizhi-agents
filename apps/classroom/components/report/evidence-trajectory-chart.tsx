'use client';

/**
 * 学情时间轨迹图 —— 学情可视化那条线上唯一缺的一张。
 *
 * 另外三张（知识盲区定位 / 资源难度匹配曲线 / 学习路径规划图）画的是**当前状态**，
 * 都是一次快照。这张画的是**发生过什么**，数据源是证据流（`lib/evidence`）。
 *
 * ## 它画的不是掌握度曲线
 *
 * 掌握度是导出量，`画像 = (fold 更新规则 声明 履历)`，而那个 fold 还没建。
 * 画一条平滑上升的「掌握度」等于把一个不存在的计算画出来。
 * 所以这里每个点就是**一次判定的原始得分**，连线只为看清先后，不做平滑、不做拟合。
 * 标题、图例、空态里都按这个口径写字，别改成「掌握度」。
 *
 * ## 降级必须看得见
 *
 * quiz 那条链现在只能给场景级测项、整卷判定摊过去（`item-level`）。
 * 空心点 = item-level，实心点 = per-kc，图例明写两者差别。
 * 画成一样就是把「这条证据其实很粗」藏起来，那是完成度审计点名的失分项（§7.7）。
 */

import { useEffect, useMemo, useState } from 'react';

import { fold, history, invalidatedIds, readLedger, type Mastery } from '@/lib/evidence';
import { summarize, trajectories, type Trajectory } from '@/lib/evidence/trajectory';
import { conceptLabel } from '@/lib/knowledge/concept-labels';

const W = 620;
const ROW_H = 56;
const PAD_L = 132;
const PAD_R = 24;
const PAD_T = 16;
const PLOT_W = W - PAD_L - PAD_R;
/** 行内纵向半幅：得分 1 在 mid−AMP，得分 0 在 mid+AMP。 */
const AMP = 16;
/** 左侧测项名的截断长度。PAD_L=132，12px 中文一字约 12px，超过 10 字就会压到画区里。 */
const LABEL_MAX = 10;

/** 一条轨迹一行：左边测项名，右边时间轴上的点。 */
function Row({
  t,
  index,
  minMs,
  spanMs,
  m,
}: {
  t: Trajectory;
  index: number;
  minMs: number;
  spanMs: number;
  m?: Mastery;
}) {
  const y0 = PAD_T + index * ROW_H;
  const mid = y0 + ROW_H / 2;
  const x = (at: string) => {
    if (spanMs <= 0) return PAD_L + PLOT_W / 2;
    const ms = Date.parse(at);
    return PAD_L + (PLOT_W * (ms - minMs)) / spanMs;
  };
  // 纵向也用得分：高的点靠上。行高有限，压到 ±AMP 之内够看出高低
  const y = (score: number) => mid + AMP - score * (AMP * 2);

  return (
    <g>
      <text x={0} y={mid + 4} className="fill-foreground" fontSize={12}>
        {t.label.length > LABEL_MAX ? `${t.label.slice(0, LABEL_MAX)}…` : t.label}
      </text>
      <text x={0} y={mid + 18} className="fill-muted-foreground" fontSize={10}>
        {m
          ? `掌握 ${m.estimate.toFixed(2)} · 把握 ${m.confidence.toFixed(2)}`
          : `${t.points.length} 条证据`}
      </text>
      <text x={0} y={mid + 30} className="fill-muted-foreground" fontSize={9}>
        {t.points.length} 条证据
        {t.itemLevel > 0 ? ` · ${t.itemLevel} 粗` : ''}
        {m && m.recall < m.estimate - 0.02 ? ` · 现可提取 ${m.recall.toFixed(2)}` : ''}
      </text>
      {/* 得分刻度。颜色（绿/黄/红）在色盲和暗色下并不可靠——深绿与深红在
          deuteranopia 下 OKLab ΔE 只有 4，所以得分必须能只靠位置读出来：
          上沿 1.0 / 中线 0.5 / 下沿 0，三条线画出来，首行标上数值。 */}
      {[1, 0.5, 0].map((s) => (
        <line
          key={s}
          x1={PAD_L}
          y1={y(s)}
          x2={PAD_L + PLOT_W}
          y2={y(s)}
          stroke="currentColor"
          strokeWidth={1}
          opacity={s === 0.5 ? 0.1 : 0.05}
        />
      ))}
      {/* 刻度值放右边空档：左边那一栏三行文字已经占满，标在那儿会压字。 */}
      {index === 0 &&
        [1, 0.5, 0].map((s) => (
          <text
            key={s}
            x={PAD_L + PLOT_W + 4}
            y={y(s) + 3}
            className="fill-muted-foreground"
            fontSize={8}
          >
            {s.toFixed(1)}
          </text>
        ))}
      {t.points.length > 1 && (
        <polyline
          points={t.points.map((p) => `${x(p.at)},${y(p.score)}`).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          opacity={0.28}
        />
      )}
      {t.points.map((p, i) => (
        <circle
          key={i}
          cx={x(p.at)}
          cy={y(p.score)}
          r={4.5}
          className={
            p.outcome === 'correct'
              ? 'fill-green-deep stroke-green-deep'
              : p.outcome === 'partial'
                ? 'fill-yellow-deep stroke-yellow-deep'
                : 'fill-red-deep stroke-red-deep'
          }
          // 空心 = item-level（整卷判定摊过来的），实心 = per-kc（逐知识点判的）
          fillOpacity={p.scope === 'item-level' ? 0 : 1}
          strokeWidth={1.5}
        >
          <title>
            {`${new Date(p.at).toLocaleString()}\n第 ${p.encounter} 次 · ${p.modality} · ` +
              `${p.scope === 'item-level' ? '整卷判定摊到本测项（粗）' : '逐知识点判定'}\n` +
              `得分 ${p.score.toFixed(2)}` +
              (p.because.missed.length ? `\n漏掉：${p.because.missed.slice(0, 3).join('、')}` : '')}
          </title>
        </circle>
      ))}
    </g>
  );
}

export function EvidenceTrajectoryChart({ domain }: { domain?: string } = {}) {
  type LoadState =
    | { domain: string; kind: 'loading' }
    | { domain: string; kind: 'error' }
    | { domain: string; kind: 'ready'; list: Trajectory[]; mastery: Map<string, Mastery> };
  const [state, setState] = useState<LoadState>({ domain: domain ?? '', kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (!domain) return () => undefined;
    void (async () => {
      try {
        const ledger = await readLedger();
        if (cancelled) return;
        const hist = history(ledger).filter(
          (e) => e.measured.kind === 'concept' && e.measured.domain === domain,
        );
        // 概念测项的 label 是引擎概念 id（`llm_basics`、`embodied_vlm` 这种），
        // 左侧行名和下面「逐条证据」两处都直接印它。在这里过一遍概念中文名的单一真源，
        // 两处一起换；退回场景标题的那些本来就是中文，`conceptLabel` 原样放行。
        const profile = fold(hist, { invalidated: invalidatedIds(ledger) });
        setState({
          domain,
          kind: 'ready',
          list: trajectories(hist).map((t) => ({ ...t, label: conceptLabel(t.label) })),
          mastery: new Map((profile.byDomain[domain] ?? []).map((m) => [m.key, m])),
        });
      } catch {
        if (!cancelled) setState({ domain, kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domain]);

  const current: LoadState =
    domain && state.domain === domain ? state : { domain: domain ?? '', kind: 'loading' };
  const list = current.kind === 'ready' ? current.list : null;
  const mastery = current.kind === 'ready' ? current.mastery : new Map<string, Mastery>();

  const stats = useMemo(() => (list ? summarize(list) : null), [list]);
  const bounds = useMemo(() => {
    if (!list?.length) return { minMs: 0, spanMs: 0 };
    const times = list
      .flatMap((t) => t.points.map((p) => Date.parse(p.at)))
      .filter(Number.isFinite);
    const min = Math.min(...times);
    return { minMs: min, spanMs: Math.max(...times) - min };
  }, [list]);

  if (!domain) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-6 py-10 text-center">
        <p className="text-sm font-medium text-foreground">当前领域的证据轨迹未覆盖</p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
          当前有效领域尚未确认；本页没有读取或展示任何全域履历。
        </p>
      </div>
    );
  }
  if (current.kind === 'error') {
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-6 py-10 text-center">
        <p className="text-sm font-medium text-foreground">当前领域的证据轨迹未覆盖</p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
          证据账本暂时无法读取；没有回退到全域履历。
        </p>
      </div>
    );
  }

  if (list === null) {
    return <p className="text-sm text-muted-foreground">正在读取履历…</p>;
  }
  if (list.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-6 py-10 text-center">
        <p className="text-sm font-medium text-foreground">当前领域的履历还是空的</p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
          做完一次测验或走一轮导学问答，这里就会出现第一个点。
          <span className="block">
            履历只从开始记的那天起攒，之前的学习记录补不回来——这是只追加账本的代价，也是它的意义。
          </span>
        </p>
      </div>
    );
  }

  const height = PAD_T * 2 + list.length * ROW_H;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${height}`}
          className="h-auto w-full text-foreground"
          // 兜底宽度必须等于 viewBox 宽度：比它窄只会把字等比压小，横向照样要滚。
          style={{ minWidth: `${W}px` }}
          role="img"
          aria-label="学情证据时间轨迹图"
        >
          {list.map((t, i) => (
            <Row
              key={t.key}
              t={t}
              index={i}
              minMs={bounds.minMs}
              spanMs={bounds.spanMs}
              m={mastery.get(t.key)}
            />
          ))}
        </svg>
      </div>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" className="text-green-deep">
              <circle cx="5" cy="5" r="4" fill="currentColor" />
            </svg>
            实心：逐知识点判定
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="10" height="10" className="text-green-deep">
              <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            空心：整卷判定摊到该测项（粒度较粗）
          </span>
          <span>颜色：绿=答对 / 黄=部分 / 红=未到位</span>
          <span>纵向位置：行内上沿 1.0 · 中线 0.5 · 下沿 0</span>
        </p>
        {stats && (
          <p>
            {stats.concepts} 个测项 · {stats.events} 条证据 ·{' '}
            {Object.entries(stats.modalities)
              .map(([k, v]) => `${k} ${v}`)
              .join(' / ')}
            {stats.itemLevelRatio > 0 &&
              ` · 其中 ${Math.round(stats.itemLevelRatio * 100)}% 是粗粒度证据`}
          </p>
        )}
        <p>
          纵轴是<span className="font-medium text-foreground">每次判定的原始得分</span>，
          不做平滑也不做拟合——点怎么落就怎么画。左侧的
          <span className="font-medium text-foreground">掌握 / 把握</span>
          是由同一段履历 fold 出来的二元组：前者是「他会不会」，后者是「我们有多确定」。
          久没测只降后者，估计值不动；「现可提取」才是随时间衰减的那一个。
          {stats && stats.spanDays < 1 && '（当前数据都在同一天内，看不出趋势。）'}
        </p>
      </div>

      {/* 每个点的时间、得分、粒度原来只在 SVG <title> 里，触屏和投影拿不到。
          与报告页另外两处 details 同一套写法，把值搬到页面上。 */}
      <details className="rounded-lg border border-border/70 p-2.5">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          逐条证据（{stats?.events ?? 0} 条）
        </summary>
        <div className="mt-2 divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
          {list.flatMap((t) =>
            t.points.map((p, i) => (
              <div
                key={`${t.key}-${i}`}
                className="flex flex-col gap-0.5 px-3 py-2 text-xs md:flex-row md:items-start md:justify-between md:gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-muted-foreground">{t.label} · </span>第 {p.encounter} 次 ·{' '}
                  {p.modality}
                  {p.because.missed.length > 0 ? ` · 漏掉 ${p.because.missed.join('、')}` : ''}
                </span>
                <span className="text-muted-foreground md:shrink-0 md:text-right">
                  <span className="tabular-nums">{new Date(p.at).toLocaleString()}</span> · 得分{' '}
                  <span className="tabular-nums">{p.score.toFixed(2)}</span> ·{' '}
                  {p.scope === 'item-level' ? '整卷判定摊过来（粗）' : '逐知识点判定'}
                </span>
              </div>
            )),
          )}
        </div>
      </details>
    </div>
  );
}
