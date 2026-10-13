/**
 * 回放负载发生器：模拟学生按 CodeBench 记录的到达时刻与间隔，经平台的 HTTP 路由、
 * 登录会话与派发器提交 /api/sched-replay。执行体在服务端按记录时长 sleep。
 *
 * 轨迹是论文仓 prechecks/platform_replay/ 导出的 CSV，每行一单：
 *   job, offset_us, service_us, <打分列>, student, pred_job, delta_us, gap_us[, limit_ms]
 *
 * 两种回放（--mode）：
 *   open    每单在 t0 + offset 提交，不管前一单回没回来
 *   closed  学生的第一单在 t0 + offset；之后每单：
 *             delta_us >= 0（看到结果才再交）：上一单的响应回到客户端后再等 delta
 *             delta_us <  0（结果出来前就又交了）：上一单提交后再等 gap（记录的两次提交间隔）
 *
 * 账号：学生 s 用 simu_s<s 四位>；--accounts round-robin:N 时第 j 单用 simu_s<j mod N>。
 * 会话 token 来自 seed-accounts.mjs login 写的 sessions.local.json。
 *
 * 用法：
 *   node experiments/scheduling/replay-trace.mjs --cell replay-k4-fcfs-open \
 *     --trace <csv> --score score_online_spjf_e_l2 --mode open --limit-ms 61000 \
 *     --accounts-dir experiments/scheduling/replay-accounts [--jobs 60]
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const need = (name) => {
  if (!args.has(name)) throw new Error(`缺参数 --${name}`);
  return args.get(name);
};

const BASE = new URL(args.get('base') ?? 'http://127.0.0.1:3210');
const CELL = need('cell');
const TRACE = resolve(need('trace'));
const SCORE = need('score');
const MODE = need('mode');
const ACCOUNTS_DIR = resolve(need('accounts-dir'));
const OUT_DIR = resolve(args.get('out') ?? 'experiments/scheduling/records');
const LIMIT_MS = args.has('limit-ms') ? Number(args.get('limit-ms')) : null;
const ROUND_ROBIN = args.has('accounts') ? Number(args.get('accounts').split(':')[1]) : 0;
const LEAD_MS = 3000;
if (!['open', 'closed'].includes(MODE)) throw new Error(`--mode 只能是 open 或 closed`);

const traceText = await readFile(TRACE, 'utf-8');
const [header, ...lines] = traceText.trim().split(/\r?\n/);
const columns = header.split(',');
let jobs = lines.map((line) => {
  const cells = line.split(',');
  return Object.fromEntries(columns.map((name, i) => [name, Number(cells[i])]));
});
if (args.has('jobs')) jobs = jobs.slice(0, Number(args.get('jobs')));
if (!columns.includes(SCORE)) throw new Error(`轨迹里没有打分列 ${SCORE}`);
if (!columns.includes('limit_ms') && LIMIT_MS === null) throw new Error('轨迹没有 limit_ms 列时要给 --limit-ms');
jobs.forEach((job, index) => {
  if (job.job !== index) throw new Error(`第 ${index} 行的 job 是 ${job.job}，轨迹要按 job 顺序`);
});

const sessions = JSON.parse(await readFile(join(ACCOUNTS_DIR, 'sessions.local.json'), 'utf-8'));
const accountOf = (job) =>
  `simu_s${String(ROUND_ROBIN ? job.job % ROUND_ROBIN : job.student).padStart(4, '0')}`;
for (const job of jobs) {
  if (!sessions[accountOf(job)]) throw new Error(`${accountOf(job)} 没有会话；先跑 seed-accounts.mjs login`);
}

const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
function post(path, body, cookie) {
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  return new Promise((done, fail) => {
    const req = http.request(
      {
        agent,
        method: 'POST',
        hostname: BASE.hostname,
        port: BASE.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          cookie: `jizhi_session=${cookie}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.setTimeout(0);
    req.on('error', fail);
    req.end(payload);
  });
}

await mkdir(OUT_DIR, { recursive: true });
const clientPath = join(OUT_DIR, `client-${CELL}.jsonl`);
const usagePath = join(OUT_DIR, `usage-${CELL}.jsonl`);

// 预热：带一个不存在的会话打一次，路由与账号后端编译、加载，但不进派发器（401）
const warm = await post('/api/sched-replay', {}, 'warm-up-not-a-session');
if (warm.status !== 401 || !warm.text.includes('未登录')) throw new Error(`预热应得 401，得到 HTTP ${warm.status} ${warm.text.slice(0, 200)}`);

// 机器负载：每 10 s 记一次全机 CPU 占用与空闲物理内存
let lastCpu = os.cpus().map((c) => c.times);
const usageTimer = setInterval(() => {
  const now = os.cpus().map((c) => c.times);
  let busy = 0;
  let total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i];
    const idle = t.idle - p.idle;
    const all = t.user + t.nice + t.sys + t.irq + t.idle - (p.user + p.nice + p.sys + p.irq + p.idle);
    busy += all - idle;
    total += all;
  });
  lastCpu = now;
  void appendFile(
    usagePath,
    `${JSON.stringify({ atMs: Date.now(), cpuPct: Number(((100 * busy) / total).toFixed(1)), freeGB: Number((os.freemem() / 2 ** 30).toFixed(2)) })}\n`,
  );
}, 10_000);

const t0 = performance.now() + LEAD_MS;
const t0Wall = Date.now() + LEAD_MS;
const children = new Map();
for (const job of jobs) {
  if (job.pred_job >= 0) {
    if (!children.has(job.pred_job)) children.set(job.pred_job, []);
    children.get(job.pred_job).push(job);
  }
}

let failures = 0;
const done = [];
function schedule(job, atPerf) {
  return new Promise((finish) => {
    setTimeout(() => finish(submit(job, atPerf)), Math.max(0, atPerf - performance.now()));
  });
}

async function submit(job, targetPerf) {
  const submittedPerf = performance.now();
  const submittedAtMs = Date.now();
  const followers = MODE === 'closed' ? children.get(job.job) ?? [] : [];
  const pending = followers
    .filter((child) => child.delta_us < 0)
    .map((child) => schedule(child, submittedPerf + child.gap_us / 1000));
  let status = 0;
  let error = '';
  try {
    const res = await post(
      '/api/sched-replay',
      {
        jobId: job.job,
        student: job.student,
        serviceMs: job.service_us / 1000,
        predictedCostS: job[SCORE],
        limitMs: columns.includes('limit_ms') ? job.limit_ms : LIMIT_MS,
      },
      sessions[accountOf(job)],
    );
    status = res.status;
    if (status !== 200 || JSON.parse(res.text).jobId !== job.job) error = res.text.slice(0, 200);
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const returnedPerf = performance.now();
  if (error) failures += 1;
  const row = {
    cell: CELL,
    jobId: job.job,
    student: job.student,
    account: accountOf(job),
    targetMs: targetPerf - t0,
    submittedMs: submittedPerf - t0,
    returnedMs: returnedPerf - t0,
    submittedAtMs,
    returnedAtMs: Date.now(),
    httpStatus: status,
    error,
  };
  done.push(row);
  await appendFile(clientPath, `${JSON.stringify(row)}\n`);
  if (done.length % 100 === 0) console.log(`[${CELL}] ${done.length}/${jobs.length} 返回，失败 ${failures}`);
  pending.push(
    ...followers
      .filter((child) => child.delta_us >= 0)
      .map((child) => schedule(child, returnedPerf + child.delta_us / 1000)),
  );
  await Promise.all(pending);
}

const roots = MODE === 'open' ? jobs : jobs.filter((job) => job.pred_job < 0);
await Promise.all(roots.map((job) => schedule(job, t0 + job.offset_us / 1000)));
clearInterval(usageTimer);

const manifest = {
  cell: CELL,
  base: BASE.origin,
  trace: TRACE,
  traceSha256: createHash('sha256').update(traceText).digest('hex'),
  score: SCORE,
  mode: MODE,
  jobs: jobs.length,
  returned: done.length,
  failures,
  accounts: ROUND_ROBIN ? `round-robin:${ROUND_ROBIN}` : 'one per student',
  limitMs: LIMIT_MS,
  t0WallMs: t0Wall,
  finishedAtMs: Date.now(),
  wallSeconds: (performance.now() - t0) / 1000,
  argv: process.argv.slice(2),
};
await writeFile(join(OUT_DIR, `manifest-${CELL}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[${CELL}] 完成 ${done.length} 单，失败 ${failures}，用时 ${manifest.wallSeconds.toFixed(0)} s`);
if (done.length !== jobs.length || failures) process.exitCode = 1;
