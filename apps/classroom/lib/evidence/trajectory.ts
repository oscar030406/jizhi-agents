/**
 * 证据轨迹：把履历按测项摊成一条条时间序列，供学情报告画图。纯函数。
 *
 * ## 为什么画的是「证据轨迹」而不是「掌握度曲线」
 *
 * 掌握度是**导出量**——`画像 = (fold 更新规则 声明 履历)`（设计稿 §4.1）。
 *
 * ⚠️ 2026-08-13 更正：原文写「而那个 fold 还没建」，已过期——fold 建好了，在
 * `lib/evidence/fold.ts`（estimate / confidence / recall 三个量分开），
 * 由 `lib/evidence/profile-bridge.ts` 每次全量重算、幂等写回。
 *
 * 但这里**仍然只画已经发生的事实**，理由变了：fold 的输出是当下的一个点估计，
 * 不是一条随时间演化的曲线；要画「掌握度随时间上升」得对每个历史时刻各跑一次 fold，
 * 那是另一件事，没做。现在画的曲线如果标成掌握度，就是把没算过的东西画出来。
 *
 * 所以这里只画**已经发生的事实**：每条证据一个点，纵轴是那次判定的得分。
 * 曲线是不是上升由数据自己说，我们不替它平滑、不替它拟合。
 *
 * ## item-level 必须画得出来
 *
 * quiz 那条链现在只能给场景级测项、整卷判定摊过去（`verdictScope: 'item-level'`）。
 * 设计稿 §7.7 要求降级可见——所以点的形状按 scope 区分，图例里写明两者的差别。
 * 把两种点画成一样，就是把「这条证据其实很粗」这个事实藏起来。
 */

import type { Evidence, Measured } from './types';
import { measuredKey } from './types';

export interface TrajectoryPoint {
  /** ISO 时间，取自证据的来源子盒。 */
  at: string;
  /** 该次判定的得分 0–1。缺省由 outcome 映射。 */
  score: number;
  outcome: Evidence['verdict']['outcome'];
  /** 通过什么形态产生的：quiz / tutor / … */
  modality: string;
  /** per-kc 还是 item-level。**画图必须区分**，见文件头。 */
  scope: Evidence['verdictScope'];
  /** 该测项第几次遇到。 */
  encounter: number;
  /** 命中/漏掉的要点，供 tooltip 展开。 */
  because: { hit: string[]; missed: string[] };
}

export interface Trajectory {
  measured: Measured;
  key: string;
  /** 展示名。概念测项用概念名，通用面用轴名。 */
  label: string;
  points: TrajectoryPoint[];
  /** 最近一次得分。**不是掌握度**——单点事实，不做任何平滑。 */
  latest: number;
  /** 这条轨迹里有多少条是 item-level 的（粗粒度）。 */
  itemLevel: number;
}

const SCORE_BY_OUTCOME: Record<Evidence['verdict']['outcome'], number> = {
  correct: 1,
  partial: 0.5,
  incorrect: 0,
};

function labelOf(m: Measured): string {
  return m.kind === 'concept' ? m.concept : m.axis;
}

/**
 * 按测项分组，组内按时间升序。
 *
 * `minPoints` 默认 1——**只有一条证据的测项也要显示**。把它们藏起来，
 * 学习者看到的就是一张「我只学过这几个东西」的假图；真实情况是大部分测项只测过一次，
 * 那本身就是要传达的信息（也是「Q 完备性不满足 → 置信封顶」的直观理由）。
 */
export function trajectories(history: readonly Evidence[], minPoints = 1): Trajectory[] {
  const byKey = new Map<string, Trajectory>();
  for (const e of history) {
    const key = measuredKey(e.measured);
    let slot = byKey.get(key);
    if (!slot) {
      slot = {
        measured: e.measured,
        key,
        label: labelOf(e.measured),
        points: [],
        latest: 0,
        itemLevel: 0,
      };
      byKey.set(key, slot);
    }
    slot.points.push({
      at: e.source.at,
      score: e.verdict.score ?? SCORE_BY_OUTCOME[e.verdict.outcome],
      outcome: e.verdict.outcome,
      modality: e.context.modality,
      scope: e.verdictScope,
      encounter: e.context.encounter,
      because: e.verdict.because,
    });
    if (e.verdictScope === 'item-level') slot.itemLevel += 1;
  }

  const out: Trajectory[] = [];
  for (const t of byKey.values()) {
    if (t.points.length < minPoints) continue;
    t.points.sort((a, b) => a.at.localeCompare(b.at));
    t.latest = t.points[t.points.length - 1].score;
    out.push(t);
  }
  // 点多的排前面：证据多的测项更值得看，也更可能是学习者当前在攻的
  out.sort((a, b) => b.points.length - a.points.length || a.label.localeCompare(b.label));
  return out;
}

export interface TrajectorySummary {
  concepts: number;
  events: number;
  /** 跨全部轨迹的 item-level 占比。这个数就是「证据有多粗」的直接读数。 */
  itemLevelRatio: number;
  /** 时间跨度（天）。只有一天的数据画不出趋势，图上要说清。 */
  spanDays: number;
  modalities: Record<string, number>;
}

export function summarize(list: readonly Trajectory[]): TrajectorySummary {
  const events = list.reduce((n, t) => n + t.points.length, 0);
  const itemLevel = list.reduce((n, t) => n + t.itemLevel, 0);
  const modalities: Record<string, number> = {};
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const t of list) {
    for (const p of t.points) {
      modalities[p.modality] = (modalities[p.modality] ?? 0) + 1;
      const ms = Date.parse(p.at);
      if (Number.isFinite(ms)) {
        min = Math.min(min, ms);
        max = Math.max(max, ms);
      }
    }
  }
  return {
    concepts: list.length,
    events,
    itemLevelRatio: events > 0 ? itemLevel / events : 0,
    spanDays: Number.isFinite(min) && Number.isFinite(max) ? (max - min) / 86_400_000 : 0,
    modalities,
  };
}
