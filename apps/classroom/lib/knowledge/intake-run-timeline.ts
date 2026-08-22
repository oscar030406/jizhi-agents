/**
 * 从事件流推出「此刻各站是什么样」。纯函数、不碰 node、不碰 DOM——直播与回放走同一条路：
 *
 * - 直播：游标钉在事件流末尾，轮询把新事件追加进来；
 * - 回放：游标从 0 往前走，页面重演当时的样子。
 *
 * 两种模式共用 `deriveView(record, events, cursor)`，所以回放看到的不是另做一份动画，
 * 就是当时真实事件推出来的状态。
 *
 * **阶段清单来自 run.json 的 `stages`**（引擎写的那一份），这里不抄第二份枚举。
 * 事件只负责推状态。
 */

import type { IntakeEvent, IntakeRunRecord, StageStatus } from '@/lib/server/intake-runs';

export interface StageView {
  id: string;
  label: string;
  /** 站号（① ② …）。并行的站共号——`vector` 与 `index` 都是 ③。 */
  order: number;
  deps: string[];
  /** 旁路站：失败只记告警，不判 run 失败。 */
  optional: boolean;
  status: StageStatus;
  /** epoch 秒。没开跑就是 null。 */
  startTs: number | null;
  endTs: number | null;
  durationMs: number | null;
  detail: Record<string, unknown> | null;
  error: string;
  /** 收尾事件那句人话（跳过原因、失败原因都在这里）。 */
  message: string;
  /** 站内进度事件，按 seq 排。 */
  progress: Array<{ seq: number; ts: number; message: string }>;
  /**
   * 依赖波次：没有依赖的站是第 0 波，其余是「所有上游波次的最大值 + 1」。
   * **同一波的站互不依赖，引擎就是这么并发发车的**——泳道按它分组。
   */
  wave: number;
  /** 与本站运行区间有重叠的其他站。非空 = 这一站真的和别人同时在跑。 */
  overlaps: string[];
}

export interface RunView {
  stages: StageView[];
  /** 按波次分组的泳道，波次序号从 0 起。 */
  waves: Array<{ wave: number; stages: StageView[] }>;
  runStatus: 'running' | 'done' | 'failed';
  /** 时间轴左右端（epoch 秒）。事件不足时两端相等，调用方按 span=0 处理。 */
  startTs: number | null;
  endTs: number | null;
  /** 真正跑起来过的站的耗时之和（ms）。与 run 墙钟时长对比就是并行省下的量。 */
  stageMsTotal: number;
  /** run 墙钟时长（ms）：优先用 run.json 的 duration_ms，回放途中用事件时间差。 */
  runMs: number | null;
  /** run 级收尾事件（run_done / run_failed），还没收尾时为 null。 */
  finale: IntakeEvent | null;
}

function waveOf(
  id: string,
  stages: Record<string, { deps?: string[] }>,
  seen: Set<string>,
): number {
  if (seen.has(id)) return 0; // 依赖成环：不该发生，真发生了也不许把页面转死
  seen.add(id);
  const deps = stages[id]?.deps ?? [];
  const depth = deps.length
    ? Math.max(...deps.map((d) => (stages[d] ? waveOf(d, stages, seen) + 1 : 0)))
    : 0;
  seen.delete(id);
  return depth;
}

/**
 * @param cursor 取事件流的前 `cursor` 条（回放游标）。省略 = 全部。
 */
export function deriveView(
  record: IntakeRunRecord,
  events: IntakeEvent[],
  cursor?: number,
): RunView {
  const shown = events.slice(0, cursor ?? events.length);
  const slots = record.stages ?? {};
  const views: Record<string, StageView> = {};
  for (const [id, slot] of Object.entries(slots)) {
    views[id] = {
      id,
      label: slot.label,
      order: slot.order,
      deps: slot.deps ?? [],
      optional: Boolean(slot.optional),
      status: 'waiting',
      startTs: null,
      endTs: null,
      durationMs: null,
      detail: null,
      error: '',
      message: '',
      progress: [],
      wave: waveOf(id, slots, new Set()),
      overlaps: [],
    };
  }

  let runStatus: RunView['runStatus'] = 'running';
  let finale: IntakeEvent | null = null;
  for (const event of shown) {
    const view = views[event.stage];
    switch (event.kind) {
      case 'run_done':
        runStatus = 'done';
        finale = event;
        break;
      case 'run_failed':
        runStatus = 'failed';
        finale = event;
        break;
      case 'stage_start':
        if (view) {
          view.status = 'running';
          view.startTs = event.ts;
        }
        break;
      case 'stage_progress':
        if (view) view.progress.push({ seq: event.seq, ts: event.ts, message: event.message });
        break;
      case 'stage_done':
      case 'stage_failed':
      case 'stage_skipped':
        if (view) {
          // status 有五种而 kind 只有三种收尾形态，所以以事件自带的 status 为准，
          // 不从 message 里猜这一站是「主动关掉」还是「还没实现」。
          view.status =
            (event.status as StageStatus) ??
            (event.kind === 'stage_done'
              ? 'done'
              : event.kind === 'stage_failed'
                ? 'failed'
                : 'skipped');
          view.endTs = event.ts;
          view.detail = (event.detail as Record<string, unknown> | null) ?? null;
          view.error = String(event.error ?? '');
          view.message = event.message;
          // 每站耗时是 G7 时间压缩的基准数据，优先用引擎记的那一份，不在前端重算。
          const slotMs = slots[event.stage]?.duration_ms ?? null;
          view.durationMs =
            slotMs ?? (view.startTs !== null ? Math.round((event.ts - view.startTs) * 1000) : null);
        }
        break;
      default:
        break;
    }
  }

  const stages = Object.values(views).sort((a, b) =>
    a.wave === b.wave ? a.order - b.order || a.id.localeCompare(b.id) : a.wave - b.wave,
  );

  // 区间重叠 = 这两站真的同时在跑。O(n²)，n 是八站。
  for (const a of stages) {
    if (a.startTs === null || a.endTs === null) continue;
    for (const b of stages) {
      if (b === a || b.startTs === null || b.endTs === null) continue;
      if (a.startTs < b.endTs && b.startTs < a.endTs) a.overlaps.push(b.id);
    }
  }

  const tsList = shown.map((e) => e.ts);
  const startTs = tsList.length ? Math.min(...tsList) : null;
  const endTs = tsList.length ? Math.max(...tsList) : null;
  const stageMsTotal = stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const runMs =
    finale && record.duration_ms !== null && record.duration_ms !== undefined
      ? record.duration_ms
      : startTs !== null && endTs !== null
        ? Math.round((endTs - startTs) * 1000)
        : null;

  const waveIds = [...new Set(stages.map((s) => s.wave))].sort((a, b) => a - b);
  return {
    stages,
    waves: waveIds.map((wave) => ({ wave, stages: stages.filter((s) => s.wave === wave) })),
    runStatus,
    startTs,
    endTs,
    stageMsTotal,
    runMs,
    finale,
  };
}
