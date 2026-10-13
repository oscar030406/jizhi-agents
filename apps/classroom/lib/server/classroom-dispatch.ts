/**
 * 调度实验用的 k 槽派发器（默认关闭）。
 *
 * 未设 SCHED_K 时 `dispatch()` 直接调用传进来的执行体，行为与改造前逐字一致——
 * 没有队列、没有落盘、没有额外的 header。设了 SCHED_K 才有 k 个并发槽、排队、
 * 三种策略与逐 job 记录。
 *
 * 三种策略：
 *   fcfs   先到先派
 *   spjf   按派发时可算的预测代价排序（小的先派）
 *   guard  在 spjf 外面套超越预算闸：闸不开火时听基策略的，开火时强制派最早的那个
 *
 * 两种计费口径（guard 用）：
 *   completed    只把「已完成的超越者」的实际执行工作量记到等待者账上
 *   reservation  派发时先按上限 ℓ 扣住，完成时退还 ℓ - C（预留-退还）
 *
 * 时间一律用整数微秒记账，判定里不出现浮点时钟。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type SchedPolicy = 'fcfs' | 'spjf' | 'guard';
export type SchedCharging = 'completed' | 'reservation';
export type SchedScoreMode = 'proxy' | 'inverted' | 'random';

export interface SchedConfig {
  /** 并发槽数；0 = 整个派发器关闭 */
  k: number;
  policy: SchedPolicy;
  charging: SchedCharging;
  scoreMode: SchedScoreMode;
  /** 逐 job 执行上限 L（微秒），也就是预留口径里的 ℓ */
  limitUs: number;
  /** 对外承诺 G（微秒）：任何 job 比同输入 FCFS 多等的秒数上限 */
  promiseUs: number;
  /** 预算形状 budget(q,t) = min(B0 + gamma*n_q + eta*k*(t-a_q), Bmax) */
  b0Us: number;
  gamma: number;
  eta: number;
  /** 记录落盘路径（JSONL）；空 = 不落盘 */
  recordPath: string;
  /** 决策审计落盘路径（JSONL）；空 = 不落盘 */
  decisionPath: string;
  /** 本轮的标签，写进每条记录 */
  cell: string;
}

export interface SchedJob {
  /** 作业类；不同类有不同的执行上限与代价模型 */
  jobClass: string;
  /** 派发时刻可算的预测代价（秒）。只用来排序，不进任何判定式 */
  predictedCostS: number;
  /** 进记录的请求侧字段，不含正文 */
  meta: Record<string, string | number | boolean | null>;
  /** 该 job 的执行上限 ℓ（毫秒）。不给就用全局 L */
  limitMs?: number;
}

interface Waiting {
  rank: number;
  arrivalUs: number;
  nAtArrival: number;
  score: number;
  limitUs: number;
  job: SchedJob;
  /** 已完成超越者的实际执行工作量之和（微秒） */
  over: number;
  /** 预留口径：已派发超越者的 min(已完成则 C，否则 ℓ) 之和（微秒） */
  overR: number;
  release: (decision: Decision) => void;
}

interface Decision {
  dispatchUs: number;
  guardFired: boolean;
  baseProposalRank: number | null;
  baseRankAmongWaiting: number;
  overUs: number;
  overRUs: number;
  budgetUs: number;
  queueLen: number;
  epochUs: number;
  /** 决策当刻，rank 比被派者小的每个等待者：[rank, over_us, overR_us, budget_us] */
  waitingBefore: Array<[number, number, number, number]>;
}

/** 每个在跑的 job：完成时要把执行工作量记到还在等的、rank 更小的人账上 */
interface Running {
  rank: number;
  limitUs: number;
  reserved: boolean;
}

export interface SchedSlotContext {
  limitMs: number;
  cell: string;
  policy: SchedPolicy;
  /** 本 job 拿到槽位的时刻（nowUs 时钟），执行体按它算绝对截止时刻 */
  dispatchUs: number;
}

const slotStore = new AsyncLocalStorage<SchedSlotContext>();

/** 当前执行体所在槽位；不在派发器里执行时为 undefined */
export function schedSlot(): SchedSlotContext | undefined {
  return slotStore.getStore();
}

/** 微秒单调时钟。Node 的 hrtime 与进程启动点绑定，同一进程内可比。 */
export function nowUs(): number {
  return Math.round(Number(process.hrtime.bigint()) / 1000);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

let cached: SchedConfig | null = null;
let cachedKey = '';

export function schedConfig(): SchedConfig {
  const key = [
    process.env.SCHED_K,
    process.env.SCHED_POLICY,
    process.env.SCHED_CHARGING,
    process.env.SCHED_SCORE_MODE,
    process.env.SCHED_L_MS,
    process.env.SCHED_G_MS,
    process.env.SCHED_B0_MS,
    process.env.SCHED_GAMMA,
    process.env.SCHED_ETA,
    process.env.SCHED_RECORD,
    process.env.SCHED_DECISIONS,
    process.env.SCHED_CELL,
  ].join('|');
  if (cached && key === cachedKey) return cached;
  const k = Math.max(0, Math.floor(intEnv('SCHED_K', 0)));
  const limitUs = Math.round(intEnv('SCHED_L_MS', 170_000) * 1000);
  const promiseUs = Math.round(intEnv('SCHED_G_MS', 900_000) * 1000);
  const policy = (process.env.SCHED_POLICY ?? 'fcfs') as SchedPolicy;
  const charging = (process.env.SCHED_CHARGING ?? 'completed') as SchedCharging;
  const scoreMode = (process.env.SCHED_SCORE_MODE ?? 'proxy') as SchedScoreMode;
  cached = {
    k,
    policy: ['fcfs', 'spjf', 'guard'].includes(policy) ? policy : 'fcfs',
    charging: charging === 'reservation' ? 'reservation' : 'completed',
    scoreMode: ['proxy', 'inverted', 'random'].includes(scoreMode) ? scoreMode : 'proxy',
    limitUs,
    promiseUs,
    b0Us: Math.round(intEnv('SCHED_B0_MS', 0) * 1000),
    gamma: intEnv('SCHED_GAMMA', 0),
    eta: intEnv('SCHED_ETA', 0),
    recordPath: process.env.SCHED_RECORD ?? '',
    decisionPath: process.env.SCHED_DECISIONS ?? '',
    cell: process.env.SCHED_CELL ?? 'unlabelled',
  };
  cachedKey = key;
  return cached;
}

/**
 * 预算上限。completed 口径是论文的 B_max = k(G - (3-2/k)L)；
 * reservation 口径按预留-退还的证书取 Z_max = k(G - (2-2/k)L)，k=1 时正好是 G。
 * 算出来是负的就取 0——0 预算即退化成 FCFS，仍然是合法设置。
 */
export function budgetCapUs(config: SchedConfig): number {
  const { k, promiseUs, limitUs, charging } = config;
  if (k <= 0) return 0;
  const coefficient = charging === 'reservation' ? 2 - 2 / k : 3 - 2 / k;
  return Math.max(0, Math.round(promiseUs - coefficient * limitUs) * k);
}

/** budget(q,t) = min(B0 + gamma*n_q + eta*k*(t-a_q), cap)，全部微秒 */
function budgetUs(config: SchedConfig, cap: number, waiting: Waiting, tUs: number): number {
  const shape =
    config.b0Us +
    Math.round(config.gamma * waiting.nAtArrival * 1_000_000) +
    Math.round(config.eta * config.k * (tUs - waiting.arrivalUs));
  return Math.min(shape, cap);
}

class Dispatcher {
  private readonly queue: Waiting[] = [];
  private readonly running = new Map<number, Running>();
  private nextRank = 0;
  private free: number;

  constructor(private readonly config: SchedConfig) {
    this.free = config.k;
  }

  admit(job: SchedJob, arrivalUs: number): { rank: number; decision: Promise<Decision> } {
    const rank = this.nextRank++;
    const limitUs = job.limitMs === undefined ? this.config.limitUs : Math.round(job.limitMs * 1000);
    let release!: (decision: Decision) => void;
    const decision = new Promise<Decision>((resolve) => {
      release = resolve;
    });
    this.queue.push({
      rank,
      arrivalUs,
      nAtArrival: this.queue.length,
      score: this.scoreOf(job, rank),
      limitUs,
      job,
      over: 0,
      overR: 0,
      release,
    });
    this.pump(arrivalUs);
    return { rank, decision };
  }

  /** 完成事件：把这一个完成者的执行工作量记到还在等、且 rank 更小的人账上 */
  complete(rank: number, serviceUs: number, tUs: number): void {
    const run = this.running.get(rank);
    if (!run) return;
    this.running.delete(rank);
    this.free += 1;
    const executedUs = Math.min(Math.max(0, serviceUs), run.limitUs);
    for (const waiting of this.queue) {
      if (waiting.rank >= rank) continue;
      waiting.over += executedUs;
      // 预留口径：派发时已按 ℓ 扣住，完成时退还 ℓ - C
      if (run.reserved) waiting.overR -= run.limitUs - executedUs;
    }
    this.pump(tUs);
  }

  private scoreOf(job: SchedJob, rank: number): number {
    switch (this.config.scoreMode) {
      case 'inverted':
        return -job.predictedCostS;
      case 'random': {
        // 固定种子的确定性伪随机：同一 rank 序列可重放
        const x = Math.sin(rank * 12.9898 + 78.233) * 43758.5453;
        return x - Math.floor(x);
      }
      default:
        return job.predictedCostS;
    }
  }

  /** 基策略 A(Q,t)：返回队列数组下标 */
  private baseChoice(): number {
    if (this.config.policy === 'fcfs') return 0; // 队列按 rank 升序维护
    let best = 0;
    for (let i = 1; i < this.queue.length; i += 1) {
      const a = this.queue[i];
      const b = this.queue[best];
      if (a.score < b.score || (a.score === b.score && a.rank < b.rank)) best = i;
    }
    return best;
  }

  private pump(tUs: number): void {
    while (this.free > 0 && this.queue.length > 0) {
      const epochStart = nowUs();
      const cap = budgetCapUs(this.config);
      let index: number;
      let fired = false;
      const baseIndex = this.baseChoice();

      if (this.config.policy !== 'guard') {
        index = baseIndex;
      } else if (this.config.charging === 'reservation') {
        // 规则 R：只在基策略的提案通不过预留检验时才改派队首
        const proposal = this.queue[baseIndex];
        let admissible = baseIndex === 0;
        if (!admissible) {
          admissible = true;
          for (const waiting of this.queue) {
            if (waiting.rank >= proposal.rank) continue;
            if (waiting.overR + proposal.limitUs > budgetUs(this.config, cap, waiting, tUs)) {
              admissible = false;
              break;
            }
          }
        }
        index = admissible ? baseIndex : 0;
        fired = !admissible;
      } else {
        // 算法 1：开火集非空就取其中 rank 最小的，否则听基策略的
        let firedIndex = -1;
        for (let i = 0; i < this.queue.length; i += 1) {
          const waiting = this.queue[i];
          if (waiting.over >= budgetUs(this.config, cap, waiting, tUs)) {
            if (firedIndex < 0 || waiting.rank < this.queue[firedIndex].rank) firedIndex = i;
          }
        }
        if (firedIndex >= 0) {
          index = firedIndex;
          fired = true;
        } else {
          index = baseIndex;
        }
      }

      const chosen = this.queue[index];
      const queueLen = this.queue.length;
      const baseProposalRank = this.config.policy === 'guard' ? this.queue[baseIndex].rank : null;
      const waitingBefore: Array<[number, number, number, number]> = [];
      for (const waiting of this.queue) {
        if (waiting.rank >= chosen.rank) continue;
        waitingBefore.push([
          waiting.rank,
          waiting.over,
          waiting.overR,
          budgetUs(this.config, cap, waiting, tUs),
        ]);
      }
      this.queue.splice(index, 1);
      this.free -= 1;
      this.running.set(chosen.rank, {
        rank: chosen.rank,
        limitUs: chosen.limitUs,
        reserved: this.config.charging === 'reservation',
      });
      if (this.config.charging === 'reservation') {
        // 派发即按上限扣住所有 rank 更小的等待者的额度
        for (const waiting of this.queue) {
          if (waiting.rank < chosen.rank) waiting.overR += chosen.limitUs;
        }
      }
      chosen.release({
        dispatchUs: tUs,
        guardFired: fired,
        baseProposalRank,
        baseRankAmongWaiting: baseIndex,
        overUs: chosen.over,
        overRUs: chosen.overR,
        budgetUs: budgetUs(this.config, cap, chosen, tUs),
        queueLen,
        epochUs: nowUs() - epochStart,
        waitingBefore,
      });
    }
  }

}

let dispatcher: Dispatcher | null = null;
let dispatcherKey = '';

function dispatcherFor(config: SchedConfig): Dispatcher {
  const key = `${config.k}|${config.policy}|${config.charging}|${config.scoreMode}|${config.cell}`;
  if (!dispatcher || key !== dispatcherKey) {
    dispatcher = new Dispatcher(config);
    dispatcherKey = key;
  }
  return dispatcher;
}

async function appendLine(path: string, value: unknown): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(value)}\n`, 'utf-8');
  } catch {
    // 记录写不进去不该让请求失败；缺行会在汇总时被 job 数对不上暴露出来
  }
}

/**
 * 给引擎调用带上本 job 的剩余执行上限。派发器关闭时返回空对象，
 * 请求头与改造前一致。
 */
export function schedHeaders(): Record<string, string> {
  const slot = slotStore.getStore();
  if (!slot) return {};
  return { 'x-sched-deadline-ms': String(slot.limitMs) };
}

export interface DispatchOutcome<T> {
  value: T;
  timedOut: boolean;
}

/**
 * 主入口。SCHED_K 未设时直接执行，不建队列、不落盘。
 *
 * 槽位一直占到执行体真的返回为止：引擎那一侧是同步 handler，调用方放弃等待
 * 并不会让它停下来，所以只有等到响应真的回来，槽位才代表真实占用。
 * 上限由 `x-sched-deadline-ms` 在引擎侧生效（见 backend/services/call_deadline.py）。
 */
export async function dispatch<T>(
  job: SchedJob,
  run: () => Promise<T>,
  /** 执行完才知道的记录字段（响应大小、是否命中缓存等）。不含正文。 */
  outcomeMeta?: (value: T | null, error: unknown) => Record<string, string | number | boolean | null>,
): Promise<T> {
  const config = schedConfig();
  if (config.k <= 0) return run();

  const enqueueUs = nowUs();
  const enqueueWall = Date.now();
  const engine = dispatcherFor(config);
  const { rank, decision } = engine.admit(job, enqueueUs);
  const chosen = await decision;
  const limitMs = Math.round((job.limitMs === undefined ? config.limitUs / 1000 : job.limitMs));

  const startUs = nowUs();
  // 决策日志不挡在派发与开始执行之间：先开跑，日志与执行并行写，记 job 行之前等它写完
  const decisionWritten = appendLine(config.decisionPath, {
    cell: config.cell,
    rank,
    tUs: chosen.dispatchUs,
    guardFired: chosen.guardFired,
    baseProposalRank: chosen.baseProposalRank,
    queueLen: chosen.queueLen,
    epochUs: chosen.epochUs,
    waitingBefore: chosen.waitingBefore,
  });
  let ok = true;
  let error = '';
  let value: T;
  try {
    value = await slotStore.run(
      { limitMs, cell: config.cell, policy: config.policy, dispatchUs: chosen.dispatchUs },
      run,
    );
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.name : 'error';
    const endUs = nowUs();
    engine.complete(rank, endUs - startUs, endUs);
    await decisionWritten;
    await appendLine(config.recordPath, {
      ...recordBase(config, job, rank, chosen, enqueueWall, enqueueUs, startUs, endUs, limitMs),
      ok,
      error,
      ...(outcomeMeta ? outcomeMeta(null, err) : {}),
    });
    throw err;
  }
  const endUs = nowUs();
  engine.complete(rank, endUs - startUs, endUs);
  await decisionWritten;
  await appendLine(config.recordPath, {
    ...recordBase(config, job, rank, chosen, enqueueWall, enqueueUs, startUs, endUs, limitMs),
    ok,
    error,
    ...(outcomeMeta ? outcomeMeta(value, null) : {}),
  });
  return value;
}

function recordBase(
  config: SchedConfig,
  job: SchedJob,
  rank: number,
  chosen: Decision,
  enqueueWall: number,
  enqueueUs: number,
  startUs: number,
  endUs: number,
  limitMs: number,
) {
  const serviceUs = endUs - startUs;
  const limitUs = limitMs * 1000;
  return {
    cell: config.cell,
    policy: config.policy,
    charging: config.charging,
    scoreMode: config.scoreMode,
    k: config.k,
    jobClass: job.jobClass,
    rank,
    enqueueWallMs: enqueueWall,
    enqueueUs,
    dispatchUs: chosen.dispatchUs,
    startUs,
    completeUs: endUs,
    waitMs: (chosen.dispatchUs - enqueueUs) / 1000,
    serviceMs: serviceUs / 1000,
    executedMs: Math.min(serviceUs, limitUs) / 1000,
    capExceededMs: Math.max(0, serviceUs - limitUs) / 1000,
    timedOut: serviceUs >= limitUs,
    limitMs,
    promiseMs: config.promiseUs / 1000,
    budgetCapMs: budgetCapUs(config) / 1000,
    b0Ms: config.b0Us / 1000,
    gamma: config.gamma,
    eta: config.eta,
    predictedCostS: job.predictedCostS,
    baseRankAmongWaiting: chosen.baseRankAmongWaiting,
    guardFired: chosen.guardFired,
    overAtDispatchMs: chosen.overUs / 1000,
    overRAtDispatchMs: chosen.overRUs / 1000,
    budgetAtDispatchMs: chosen.budgetUs / 1000,
    queueLenAtDispatch: chosen.queueLen,
    dispatchEpochUs: chosen.epochUs,
    ...job.meta,
  };
}

/** 单测用：丢掉进程内的队列状态 */
export function resetDispatcherForTest(): void {
  dispatcher = null;
  dispatcherKey = '';
  cached = null;
  cachedKey = '';
}
