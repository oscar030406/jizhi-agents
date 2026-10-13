/**
 * 把一轮（或几轮）的逐 job 记录汇总成表，并做边界检查。
 *
 * 边界检查的做法：拿同一条到达序列与同一批实测执行工作量，离线重放一遍先到先派，
 * 逐 job 算 `excess = 实测等待 − 重放的先到先派等待`，再看它有没有超过承诺 G。
 * 重放用的是实测出来的执行工作量 min(C_i, ℓ_i)，不是任何假设的分布。
 *
 * 用法：
 *   node experiments/scheduling/summarize.mjs experiments/scheduling/records/jobs-*.jsonl
 *   node experiments/scheduling/summarize.mjs --json out.json <files...>
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const argv = process.argv.slice(2);
let jsonOut = '';
// --append：把本次的行并进已有的 --json 文件（同名 cell 覆盖）。
// 六个 cell 是一个接一个跑的，每跑完一个就往里追一行，崩了最多丢一个。
let append = false;
const files = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--json') {
    jsonOut = argv[i + 1];
    i += 1;
  } else if (argv[i] === '--append') {
    append = true;
  } else files.push(argv[i]);
}
if (!files.length) {
  console.error('用法：node summarize.mjs [--json out.json] <jobs-*.jsonl ...>');
  process.exit(1);
}

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const cv = (values) => {
  const m = mean(values);
  if (!m) return null;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / m;
};
const round = (value, digits = 2) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits));

/** k 台机的先到先派重放：到达时刻与执行工作量都用实测值 */
function replayFcfs(jobs, k) {
  const free = new Array(k).fill(-Infinity);
  const order = [...jobs].sort((a, b) => a.enqueueUs - b.enqueueUs);
  const waits = new Map();
  for (const job of order) {
    let slot = 0;
    for (let i = 1; i < k; i += 1) if (free[i] < free[slot]) slot = i;
    const start = Math.max(job.enqueueUs, free[slot] === -Infinity ? job.enqueueUs : free[slot]);
    waits.set(job, (start - job.enqueueUs) / 1000);
    free[slot] = start + job.executedMs * 1000;
  }
  return waits;
}

const cells = new Map();
for (const file of files) {
  const text = await readFile(file, 'utf-8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!cells.has(row.cell)) cells.set(row.cell, []);
    cells.get(row.cell).push(row);
  }
}

const report = [];
for (const [cell, jobs] of cells) {
  const k = jobs[0].k;
  const promiseMs = jobs[0].promiseMs;
  const fcfsWaits = replayFcfs(jobs, k);
  const excess = jobs.map((job) => job.waitMs - fcfsWaits.get(job));
  const byClass = new Map();
  for (const job of jobs) {
    if (!byClass.has(job.jobClass)) byClass.set(job.jobClass, []);
    byClass.get(job.jobClass).push(job);
  }

  const entry = {
    cell,
    policy: jobs[0].policy,
    charging: jobs[0].charging,
    scoreMode: jobs[0].scoreMode,
    k,
    limitMsByClass: Object.fromEntries([...byClass].map(([name, rows]) => [name, rows[0].limitMs])),
    promiseMs,
    budgetCapMs: jobs[0].budgetCapMs,
    jobs: jobs.length,
    classes: Object.fromEntries(
      [...byClass].map(([name, rows]) => {
        const service = rows.map((r) => r.serviceMs / 1000);
        return [
          name,
          {
            n: rows.length,
            serviceS: {
              min: round(Math.min(...service)),
              median: round(quantile(service, 0.5)),
              p90: round(quantile(service, 0.9)),
              max: round(Math.max(...service)),
              mean: round(mean(service)),
              cv: round(cv(service), 3),
            },
            timedOut: rows.filter((r) => r.timedOut).length,
            engineDeadlineHit: rows.filter((r) => r.engineDeadlineHit).length,
            capExceededMsMax: round(Math.max(...rows.map((r) => r.capExceededMs))),
            httpOk: rows.filter((r) => r.ok).length,
          },
        ];
      }),
    ),
    // 这一轮实际压了多少负载：闭环里 rho 是结果不是参数，只能事后量
    load: (() => {
      const first = Math.min(...jobs.map((j) => j.enqueueUs));
      const last = Math.max(...jobs.map((j) => j.completeUs));
      const makespanS = (last - first) / 1e6;
      const executedS = jobs.reduce((sum, j) => sum + j.executedMs / 1000, 0);
      return {
        makespanS: round(makespanS),
        meanExecutedS: round(executedS / jobs.length),
        arrivalsPerS: round(jobs.length / makespanS, 5),
        // 服务器忙率：实执行工作量 / (k × 跨度)
        rho: round(executedS / (k * makespanS), 3),
      };
    })(),
    waitS: {
      mean: round(mean(jobs.map((j) => j.waitMs / 1000))),
      median: round(quantile(jobs.map((j) => j.waitMs / 1000), 0.5)),
      p90: round(quantile(jobs.map((j) => j.waitMs / 1000), 0.9)),
      max: round(Math.max(...jobs.map((j) => j.waitMs / 1000))),
    },
    replayFcfsWaitS: {
      mean: round(mean(jobs.map((j) => fcfsWaits.get(j) / 1000))),
      max: round(Math.max(...jobs.map((j) => fcfsWaits.get(j) / 1000))),
    },
    excessS: {
      mean: round(mean(excess.map((e) => e / 1000))),
      max: round(Math.max(...excess) / 1000),
    },
    boundCheck: {
      promiseS: promiseMs / 1000,
      maxExcessS: round(Math.max(...excess) / 1000),
      // 用掉了承诺的多少：1.0 就是刚好顶到
      ratio: round(Math.max(...excess) / promiseMs, 4),
      jobsOverPromise: excess.filter((e) => e > promiseMs).length,
      passed: Math.max(...excess) <= promiseMs,
    },
    guardFirings: jobs.filter((j) => j.guardFired).length,
    dispatchEpochUs: {
      mean: round(mean(jobs.map((j) => j.dispatchEpochUs))),
      max: Math.max(...jobs.map((j) => j.dispatchEpochUs)),
    },
    bytes: {
      requestTotal: jobs.reduce((s, j) => s + (j.requestBytes ?? 0), 0),
      responseTotal: jobs.reduce((s, j) => s + (j.responseBytes ?? 0), 0),
    },
  };
  report.push(entry);
}

let merged = report;
if (append && jsonOut) {
  let existing = [];
  try {
    existing = JSON.parse(await readFile(jsonOut, 'utf-8'));
  } catch {
    existing = [];
  }
  const fresh = new Set(report.map((row) => row.cell));
  merged = [...existing.filter((row) => !fresh.has(row.cell)), ...report];
}
merged.sort((a, b) => a.cell.localeCompare(b.cell));
const text = JSON.stringify(merged, null, 2);
if (jsonOut) await writeFile(jsonOut, `${text}\n`, 'utf-8');
console.log(JSON.stringify(report, null, 2));
