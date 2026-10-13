/**
 * 调度实验的负载发生器：建 N 个测试账号，再用 N 个脚本用户按给定的需求规则打请求。
 *
 * 一个「cell」＝ 一种策略 × 一种需求规则跑一轮。服务端那边的策略、k、承诺、上限
 * 由起服务时的 SCHED_* 环境变量决定（见 ../../docs/调度实验改动说明.md），
 * 这个脚本不改服务端配置，只负责发请求和记客户端这一侧的时间。
 *
 * 需求规则（--think）：
 *   open         开环：按 --schedule 的到达时刻表发，前一单回没回来都不影响下一单
 *   independent  闭环，思考时间与上一单的代价无关（指数分布，均值 --think-mean）
 *   wait-scaled  闭环，思考时间随上一次的等待增长：mean + slope × 上次等待
 *
 * 作业类（--mix，按概率抽）：
 *   guide      POST /api/practice-guide     真模型调用，实测 90-230 秒，上限 170 秒
 *   blueprint  POST /api/adaptive/blueprint 真模型调用，实测中位数 8 秒，上限 25 秒
 *
 * 用法示例（先按 README 起好本机服务）：
 *   node experiments/scheduling/run-cell.mjs --cell smoke-fcfs --users 3 --jobs 8 \
 *     --think independent --think-mean 20 --mix guide=0.25,blueprint=0.75
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args.set(token.slice(2), next && !next.startsWith('--') ? next : 'true');
}
const arg = (name, fallback) => (args.has(name) ? args.get(name) : fallback);
const num = (name, fallback) => Number(arg(name, fallback));

const BASE = arg('base', 'http://127.0.0.1:3210').replace(/\/$/, '');
const CELL = arg('cell', 'unlabelled');
const USERS = num('users', 3);
const JOBS = num('jobs', 8);
const THINK_RULE = arg('think', 'independent');
const THINK_MEAN_S = num('think-mean', 20);
const THINK_SLOPE = num('think-slope', 0.5);
const CORPUS = arg('corpus', 'ai');
const OUT_DIR = resolve(arg('out', 'experiments/scheduling/records'));
const SCHEDULE = arg('schedule', '');
const SEED = num('seed', 20260923);
// 测试账号的口令由这个串派生。账号只存在于本机 apps/classroom/data/accounts/accounts.json，
// 不是任何真人的凭证；换掉它就是换一批账号。
const ACCOUNT_SALT = arg('account-salt', 'sched-experiment-local-only');
// 这一轮最多跑多久（秒）；到点就不再发新单，只把在飞的等回来。0 = 不设上限。
const MAX_SECONDS = num('max-seconds', 0);

// 固定顺序的作业类清单，比按概率抽更省：小样本下抽签可能一个长作业都抽不到
const PATTERN = String(arg('pattern', '')).split(',').map((s) => s.trim()).filter(Boolean);
const mix = String(arg('mix', 'guide=0.25,blueprint=0.75'))
  .split(',')
  .map((part) => part.split('='))
  .map(([name, weight]) => ({ name, weight: Number(weight) }));
const mixTotal = mix.reduce((sum, item) => sum + item.weight, 0);

/**
 * 走 node:http 而不是 fetch：队列深的时候一单要等好几分钟才回，
 * 而 fetch 底下的 undici 默认 300 秒收不到响应头就报 UND_ERR_HEADERS_TIMEOUT，
 * 会把还在排队的 job 从客户端这一侧砍掉。node:http 不带这个默认超时。
 */
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

function request(method, url, options = {}) {
  const headers = options.headers || {};
  const body = options.body === undefined ? null : options.body;
  const target = new URL(url);
  const payload = body === null ? null : Buffer.from(body, 'utf-8');
  return new Promise((done, fail) => {
    const req = http.request(
      {
        agent,
        method,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: payload
          ? { ...headers, 'content-length': String(payload.length) }
          : headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          done({
            status: res.statusCode || 0,
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.setTimeout(0);
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 每个座位一条独立的随机流：第 s 个用户的第 j 次思考时间只由 (SEED, s, j) 决定，
 * 与别的座位跑得快慢无关。同一个 SEED 下，几个 cell 抽到的是同一串数，
 * 需求的差别就只来自规则本身与反馈。
 */
function seatStream(seat) {
  let state = (SEED ^ ((seat + 1) * 2654435761)) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const expDraw = (draw, mean) => -Math.log(1 - draw()) * mean;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** 只在没给 --pattern 时才用得到的抽签流 */
const mixDraw = seatStream(-1);

function pickClass(index) {
  if (PATTERN.length) return PATTERN[index % PATTERN.length];
  let x = mixDraw() * mixTotal;
  for (const item of mix) {
    x -= item.weight;
    if (x <= 0) return item.name;
  }
  return mix[mix.length - 1].name;
}

async function derivePassword(username) {
  const { createHash } = await import('node:crypto');
  return `lt${createHash('sha256').update(`${username}:${ACCOUNT_SALT}`).digest('hex').slice(0, 14)}`;
}

/**
 * 一个测试用户：过 app 自己的注册接口建号（已存在就登录），再写一份画像。
 * 画像里的时间预算决定引擎要拆几段里程碑，也就是规模代理的主项，所以按用户分档。
 */
async function makeUser(index) {
  const username = `loadtest_u${String(index).padStart(3, '0')}`;
  const password = await derivePassword(username);
  const post = (payload, extra) =>
    request('POST', `${BASE}/api/auth`, {
      headers: { 'content-type': 'application/json', ...(extra || {}) },
      body: JSON.stringify(payload),
    });

  let attempt = await post({ action: 'register', username, password, role: 'learner' });
  if (!attempt.ok) {
    attempt = await post({ action: 'login', username, password, role: 'learner' });
  }
  if (!attempt.ok) {
    throw new Error(`账号 ${username} 既注册不了也登录不上：HTTP ${attempt.status} ${attempt.text.slice(0, 200)}`);
  }
  const cookie = []
    .concat(attempt.headers['set-cookie'] ?? [])
    .map((line) => line.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error(`账号 ${username} 没拿到会话 cookie`);

  // 时间预算 4 / 10 / 24 小时 → 引擎分别拆 3 / 4 / 5-6 段里程碑
  const budgets = [4, 10, 24];
  const profile = {
    corpus: CORPUS,
    role: 'student',
    programming_level: 1 + (index % 3),
    agent_level: 1 + (index % 2),
    engineering_level: 1 + (index % 4),
    time_budget_hours: budgets[index % budgets.length],
  };
  const saved = await post({ action: 'save-profile', profile }, { cookie });
  if (!saved.ok) throw new Error(`账号 ${username} 写画像失败：HTTP ${saved.status}`);
  return { username, cookie, profile };
}

let projects = [];
async function loadProjects() {
  const resp = await request('GET', `${BASE}/api/practice-scout/${encodeURIComponent(CORPUS)}`);
  const body = parseJson(resp.text);
  projects = (body?.data?.projects ?? body?.projects ?? []).map((p) => p.id).filter(Boolean);
  if (!projects.length) throw new Error(`${CORPUS} 域下没有已发布的实操项目，带练类跑不了`);
}

/** 一单：发请求，等结果回来，记客户端这一侧的时间。不存提示词与生成正文。 */
async function submit(user, jobClass, index) {
  const submitId = randomUUID();
  const started = Date.now();
  let url;
  let body;
  if (jobClass === 'guide') {
    url = `${BASE}/api/practice-guide`;
    // refresh 必须为真，否则同档第二次命中引擎缓存，秒回，就不是一次真调用了
    body = { corpus: CORPUS, projectId: projects[index % projects.length], refresh: true };
  } else {
    url = `${BASE}/api/adaptive/blueprint`;
    body = {
      // 目标串每单不同：蓝图在引擎侧按整份请求做缓存，重复就不是真调用了
      learningGoal: `${GOALS[index % GOALS.length]}（变体 ${submitId.slice(0, 8)}）`,
      profile: user.profile,
    };
  }
  let status = 0;
  let bytes = 0;
  let ok = false;
  let error = '';
  try {
    const resp = await request('POST', url, {
      headers: { 'content-type': 'application/json', cookie: user.cookie },
      body: JSON.stringify(body),
    });
    status = resp.status;
    bytes = resp.text.length;
    ok = resp.ok;
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const finished = Date.now();
  return {
    cell: CELL,
    submitId,
    user: user.username,
    jobClass,
    requestBytes: JSON.stringify(body).length,
    responseBytes: bytes,
    submittedAtMs: started,
    returnedAtMs: finished,
    roundTripMs: finished - started,
    httpStatus: status,
    ok,
    error,
  };
}

const GOALS = [
  '搞懂检索增强生成的整条链路',
  '学会给智能体写工具调用',
  '把注意力机制从查询键值讲清楚',
  '弄明白温度参数怎么影响生成',
  '理解梯度下降与学习率的关系',
  '掌握上下文窗口与键值缓存',
  '会用向量库做语义检索',
  '能独立跑通一次模型微调',
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const clientPath = resolve(OUT_DIR, `client-${CELL}.jsonl`);
  const manifestPath = resolve(OUT_DIR, `manifest-${CELL}.json`);
  await mkdir(dirname(clientPath), { recursive: true });

  await loadProjects();
  const users = [];
  for (let i = 0; i < USERS; i += 1) users.push(await makeUser(i + 1));
  console.log(`[${CELL}] ${users.length} 个测试账号就绪，域 ${CORPUS}，已发布项目 ${projects.length} 个`);

  const startedAt = Date.now();
  let issued = 0;
  const rows = [];
  const deadlineMs = MAX_SECONDS > 0 ? startedAt + MAX_SECONDS * 1000 : Infinity;
  const take = () => (issued < JOBS && Date.now() < deadlineMs ? issued++ : -1);

  async function record(row) {
    rows.push(row);
    await appendFile(clientPath, `${JSON.stringify(row)}\n`, 'utf-8');
    console.log(
      `[${CELL}] ${row.jobClass} #${rows.length}/${JOBS} ${row.user} ` +
        `${(row.roundTripMs / 1000).toFixed(1)}s HTTP ${row.httpStatus}${row.error ? ` ${row.error}` : ''}`,
    );
  }

  if (THINK_RULE === 'open') {
    if (!SCHEDULE) throw new Error('开环需要 --schedule <到达时刻表.csv>');
    const offsets = (await readFile(resolve(SCHEDULE), 'utf-8'))
      .split(/\r?\n/)
      .map((line) => line.split(',')[0].trim())
      .filter((v) => v && !Number.isNaN(Number(v)))
      .map(Number)
      .slice(0, JOBS);
    const t0 = Date.now();
    const flying = offsets.map(async (offset, index) => {
      await sleep(t0 + offset * 1000 - Date.now());
      const user = users[index % users.length];
      await record(await submit(user, pickClass(index), index));
    });
    await Promise.all(flying);
  } else {
    const loops = users.map(async (user, seat) => {
      const draw = seatStream(seat);
      for (;;) {
        const index = take();
        if (index < 0) return;
        const row = await submit(user, pickClass(index), index);
        await record(row);
        if (issued >= JOBS) return;
        // 规则 (iii)：上一次等得越久，这次就想得越久。往返时长就是这个用户
        // 感知到的「等了多久」——它把排队也算进去，正是需求要对之做出反应的量。
        const mean =
          THINK_RULE === 'wait-scaled'
            ? THINK_MEAN_S + THINK_SLOPE * (row.roundTripMs / 1000)
            : THINK_MEAN_S;
        await sleep(expDraw(draw, mean) * 1000);
      }
    });
    await Promise.all(loops);
  }

  const manifest = {
    cell: CELL,
    base: BASE,
    corpus: CORPUS,
    users: users.map((u) => u.username),
    jobsRequested: JOBS,
    jobsIssued: rows.length,
    maxSeconds: MAX_SECONDS || null,
    stoppedOnDeadline: MAX_SECONDS > 0 && rows.length < JOBS,
    thinkRule: THINK_RULE,
    thinkMeanS: THINK_MEAN_S,
    thinkSlope: THINK_SLOPE,
    mix: PATTERN.length ? null : mix.map((m) => `${m.name}=${m.weight}`).join(','),
    pattern: PATTERN.length ? PATTERN.join(',') : null,
    seed: SEED,
    schedule: SCHEDULE || null,
    startedAtMs: startedAt,
    finishedAtMs: Date.now(),
    wallSeconds: (Date.now() - startedAt) / 1000,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  console.log(`[${CELL}] 完成 ${rows.length} 单，用时 ${manifest.wallSeconds.toFixed(0)} s`);
  console.log(`[${CELL}] 客户端记录 ${clientPath}`);
  console.log(`[${CELL}] 清单 ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
