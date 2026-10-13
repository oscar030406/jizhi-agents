/**
 * 派发器的离线检验：拿合成到达序列跑三种策略，断言
 *   1. SCHED_K 未设时 dispatch() 就是直调，不建队列；
 *   2. 同时在跑的 job 数永远不超过 k；
 *   3. guard 每个 job 比同输入 FCFS 多等的时间不超过承诺 G。
 *
 * 服务时间用 setTimeout 模拟，单位与 SCHED_L_MS / SCHED_G_MS 同一把尺子，
 * 整份测试十几秒跑完，不花模型钱。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { dispatch, resetDispatcherForTest, schedConfig, budgetCapUs } from '@/lib/server/classroom-dispatch';

interface SynthJob {
  arrivalMs: number;
  serviceMs: number;
  predictedCostS: number;
}

const FLAGS = [
  'SCHED_K',
  'SCHED_POLICY',
  'SCHED_CHARGING',
  'SCHED_SCORE_MODE',
  'SCHED_L_MS',
  'SCHED_G_MS',
  'SCHED_B0_MS',
  'SCHED_GAMMA',
  'SCHED_ETA',
  'SCHED_RECORD',
  'SCHED_DECISIONS',
  'SCHED_CELL',
] as const;

function clearFlags() {
  for (const flag of FLAGS) delete process.env[flag];
  resetDispatcherForTest();
}

afterEach(clearFlags);

/**
 * 把合成序列喂给真的派发器。每个 job 到达时立刻 dispatch，执行体用
 * setTimeout 模拟服务时间。
 */
async function runCell(jobs: SynthJob[]) {
  const started = Date.now();
  let inFlight = 0;
  let maxInFlight = 0;
  const waits: number[] = [];
  const pending = jobs.map(
    (job, index) =>
      new Promise<void>((resolve) => {
        setTimeout(
          () => {
            const enqueued = Date.now();
            void dispatch(
              { jobClass: 'synth', predictedCostS: job.predictedCostS, meta: { index } },
              () =>
                new Promise<number>((done) => {
                  waits[index] = Date.now() - enqueued;
                  inFlight += 1;
                  maxInFlight = Math.max(maxInFlight, inFlight);
                  setTimeout(() => {
                    inFlight -= 1;
                    done(index);
                  }, job.serviceMs);
                }),
            ).then(() => resolve());
          },
          job.arrivalMs,
        );
      }),
  );
  await Promise.all(pending);
  return { waits, maxInFlight, wallMs: Date.now() - started };
}

/** 同输入的 FCFS 等待时间，纯算术，不起计时器 */
function fcfsWaits(jobs: SynthJob[], k: number, limitMs: number): number[] {
  const free = new Array(k).fill(0);
  const waits: number[] = [];
  for (const job of jobs) {
    let slot = 0;
    for (let i = 1; i < k; i += 1) if (free[i] < free[slot]) slot = i;
    const start = Math.max(job.arrivalMs, free[slot]);
    waits.push(start - job.arrivalMs);
    free[slot] = start + Math.min(job.serviceMs, limitMs);
  }
  return waits;
}

// 时间不做压缩：派发器的预算算的是真实微秒，输入的服务时间必须与 SCHED_L_MS /
// SCHED_G_MS 同一把尺子，压缩一边会让闸看到一个放大了的预算。
const LONG_MS = 800;
const SHORT_MS = 40;
const LIMIT_MS = 1000;
const SYNTH: SynthJob[] = [
  // 一个小突发：三个长的先到，后面挤进一串短的——没有闸时短的会一直插队
  { arrivalMs: 0, serviceMs: LONG_MS, predictedCostS: 160 },
  { arrivalMs: 10, serviceMs: LONG_MS, predictedCostS: 160 },
  { arrivalMs: 20, serviceMs: LONG_MS, predictedCostS: 160 },
  { arrivalMs: 30, serviceMs: SHORT_MS, predictedCostS: 8 },
  { arrivalMs: 40, serviceMs: SHORT_MS, predictedCostS: 8 },
  { arrivalMs: 50, serviceMs: SHORT_MS, predictedCostS: 8 },
  { arrivalMs: 60, serviceMs: SHORT_MS, predictedCostS: 8 },
  { arrivalMs: 70, serviceMs: LONG_MS, predictedCostS: 160 },
  { arrivalMs: 80, serviceMs: SHORT_MS, predictedCostS: 8 },
  { arrivalMs: 90, serviceMs: SHORT_MS, predictedCostS: 8 },
  { arrivalMs: 100, serviceMs: SHORT_MS, predictedCostS: 8 },
  { arrivalMs: 110, serviceMs: SHORT_MS, predictedCostS: 8 },
];

describe('classroom dispatch', () => {
  it('SCHED_K 未设时就是直调：没有队列，没有并发上限', async () => {
    clearFlags();
    expect(schedConfig().k).toBe(0);
    let concurrent = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        dispatch(
          { jobClass: 'synth', predictedCostS: 1, meta: {} },
          () =>
            new Promise<void>((done) => {
              concurrent += 1;
              peak = Math.max(peak, concurrent);
              setTimeout(() => {
                concurrent -= 1;
                done();
              }, 20);
            }),
        ),
      ),
    );
    expect(peak).toBe(6);
  });

  it('k 个槽是真的上限，三种策略都不超', async () => {
    for (const policy of ['fcfs', 'spjf', 'guard'] as const) {
      clearFlags();
      process.env.SCHED_K = '2';
      process.env.SCHED_POLICY = policy;
      process.env.SCHED_L_MS = String(LIMIT_MS);
      process.env.SCHED_G_MS = '20000';
      const result = await runCell(SYNTH);
      expect(result.maxInFlight).toBeLessThanOrEqual(2);
      expect(result.waits).toHaveLength(SYNTH.length);
    }
  }, 30_000);

  it('spjf 让长作业多等，guard 把多等的部分压回承诺 G 以内', async () => {
    const k = 2;
    const promiseMs = 2400; // (3-2/k)L = 2000，再留 400 ms 的正预算给闸
    const baseline = fcfsWaits(SYNTH, k, LIMIT_MS);

    clearFlags();
    process.env.SCHED_K = String(k);
    process.env.SCHED_POLICY = 'spjf';
    process.env.SCHED_L_MS = String(LIMIT_MS);
    process.env.SCHED_G_MS = String(promiseMs);
    const spjf = await runCell(SYNTH);

    clearFlags();
    process.env.SCHED_K = String(k);
    process.env.SCHED_POLICY = 'guard';
    process.env.SCHED_CHARGING = 'completed';
    process.env.SCHED_L_MS = String(LIMIT_MS);
    process.env.SCHED_G_MS = String(promiseMs);
    const cap = budgetCapUs(schedConfig());
    const guard = await runCell(SYNTH);

    // 这组参数下预算是正的，闸才有东西可管
    expect(cap).toBeGreaterThan(0);

    // 计时器有抖动，留一个与最短服务时间同量级的容差
    const tolerance = 80;
    const spjfExcess = Math.max(...spjf.waits.map((w, i) => w - baseline[i]));
    const guardExcess = Math.max(...guard.waits.map((w, i) => w - baseline[i]));

    expect(guardExcess).toBeLessThanOrEqual(promiseMs + tolerance);
    // 基策略本身没有这条约束：它在这组输入上确实把长作业推得更远
    expect(spjfExcess).toBeGreaterThan(guardExcess);
  }, 30_000);

  it('预留-退还口径同样守住承诺', async () => {
    const k = 2;
    const promiseMs = 1400; // 预留口径的门槛是 (2-2/k)L = 1000，比算法 1 低一个 L
    const baseline = fcfsWaits(SYNTH, k, LIMIT_MS);

    clearFlags();
    process.env.SCHED_K = String(k);
    process.env.SCHED_POLICY = 'guard';
    process.env.SCHED_CHARGING = 'reservation';
    process.env.SCHED_L_MS = String(LIMIT_MS);
    process.env.SCHED_G_MS = String(promiseMs);
    expect(budgetCapUs(schedConfig())).toBeGreaterThan(0);
    const guard = await runCell(SYNTH);
    const excess = Math.max(...guard.waits.map((w, i) => w - baseline[i]));
    expect(excess).toBeLessThanOrEqual(promiseMs + 80);
  }, 30_000);
});
