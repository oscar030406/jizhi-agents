/**
 * 学习路径补课：按 apps/classroom/data/learning-path.json 里节点的 requirement 原文
 * 走服务端生成接口真跑成课，跑完用 /api/classroom（学习者发布门的出口）验一遍能不能上墙。
 *
 * 与 scripts/skill-gap-courses.mjs 同一条流水线，区别只有两点：需求文本取自
 * learning-path.json 的 requirement 字段（一个字不改写），以及跑完带一道门禁复核。
 *
 * 用法（生产在服务器上 nohup 跑）：
 *   node scripts/generate-path-courses.mjs --base http://127.0.0.1:3210 \
 *     --nodes prob-entropy,tokenization-embedding --concurrency 2 --as-manager
 *
 * `--as-manager` 用演示管理者会话建单，草稿因此带上 ownerOrgId（甲方培训中心）。
 * 这一格决定草稿能不能走仲裁三出口的第三条「人工复核放行」——没有它，机器门一挡，
 * 这门课就没有第二条路。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const BASE = args.base || 'http://127.0.0.1:3210';
const CONCURRENCY = Number(args.concurrency || 2);
const PATH_JSON = args.path || path.join(process.cwd(), 'apps/classroom/data/learning-path.json');
const POLL_MS = 20_000;
const MAX_WAIT_MS = 90 * 60 * 1000;

const nodes = JSON.parse(fs.readFileSync(PATH_JSON, 'utf8')).nodes;
const wanted = String(args.nodes || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!wanted.length) {
  console.error('要 --nodes a,b,c');
  process.exit(1);
}
const targets = wanted.map((id) => {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`learning-path.json 里没有节点 ${id}`);
  if (!node.requirement) throw new Error(`节点 ${id} 没有 requirement`);
  return node;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(stamp(), ...a);

/**
 * 演示管理者会话。**不建单则草稿没有 ownerOrgId，就走不了仲裁三出口的第三条**
 * （人工复核放行只认课程所属机构的所有者，见 app/api/classroom/release/route.ts
 * 的 courseVisibleToOrg）。`/api/auth/demo` 按角色解析成固定演示账号、不收密码，
 * 与管理端页面登录同一条路。
 */
let COOKIE = '';
async function loginManager() {
  // 参数解析出来的键是原样的 `as-manager`，不是驼峰——写错了不会报错，只会静默跳过登录，
  // 草稿照样生成但没有 ownerOrgId，人工放行那条路直接没了。所以这里断言而不是 return。
  if (!args['as-manager']) return;
  const res = await fetch(`${BASE}/api/auth/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'manager' }),
  });
  if (!res.ok) throw new Error(`演示管理者登录失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  COOKIE = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const who = await res.json();
  log(`已登录管理者会话：${who?.account?.username ?? '?'}（role=${who?.account?.role ?? '?'}）`);
}
const auth = () => (COOKIE ? { Cookie: COOKIE } : {});

/**
 * 门禁复核：课在**匿名** /api/classroom 里出现 = 过了 decideCourseLearnerRelease。
 * 这里故意不带会话——带上管理者 cookie 会连本机构的草稿一起列出来，那问的就不是
 * 「学习者能不能看到」了。
 */
async function isReleased(id) {
  const res = await fetch(`${BASE}/api/classroom`);
  const body = await res.json();
  return (body?.classrooms ?? []).some((c) => c.id === id);
}

async function generateOne(node) {
  if (args['as-manager'] && !COOKIE) throw new Error('要求管理者会话但没拿到 cookie，拒绝裸建单');
  const started = Date.now();
  const res = await fetch(`${BASE}/api/generate-classroom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-locale': 'zh-CN', ...auth() },
    body: JSON.stringify({ requirement: node.requirement }),
  });
  const body = await res.json();
  if (!res.ok || !body?.jobId) {
    log(`[${node.id}] 建单失败 HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return { node: node.id, ok: false, error: `create ${res.status}` };
  }
  log(`[${node.id}] job=${body.jobId} 「${node.requirement.slice(0, 36)}…」`);

  let lastStep = '';
  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    const job = await (
      await fetch(`${BASE}/api/generate-classroom/${body.jobId}`, { headers: auth() })
    ).json();
    const step = `${job?.step ?? '?'} ${job?.progress ?? ''}% ${job?.message ?? ''}`;
    if (step !== lastStep) {
      log(`[${node.id}] ${Math.round((Date.now() - started) / 1000)}s ${step}`);
      lastStep = step;
    }
    if (job?.status === 'succeeded') {
      const id = job?.result?.id ?? '';
      const released = id ? await isReleased(id) : false;
      log(`[${node.id}] 完成 job=${body.jobId} id=${id} 门禁=${released ? '过' : '未过'} 用时 ${Math.round((Date.now() - started) / 1000)}s`);
      return { node: node.id, ok: true, jobId: body.jobId, id, released };
    }
    if (job?.status === 'failed') {
      // 发布门在生成任务内部就判了：过不了的课照样落盘成草稿，id 在 job.classroomId 里
      // （job.result 只有成功时才有）。把它带出来，报告里才能指到那一版。
      const draft = job?.classroomId ?? '';
      log(`[${node.id}] 失败 draft=${draft || '无'}: ${job?.error ?? job?.message}`);
      return { node: node.id, ok: false, jobId: body.jobId, draft, error: job?.error ?? job?.message };
    }
  }
  return { node: node.id, ok: false, jobId: body.jobId, error: 'timeout' };
}

const ATTEMPTS = Number(args.attempts || 1);

await loginManager();

const queue = [...targets];
const results = [];
async function worker() {
  while (queue.length) {
    const node = queue.shift();
    let last;
    // 同一节点连试 ATTEMPTS 次：教学质量合同与语义对齐判定都过模型，同一份 requirement
    // 两次跑出的大纲不一样，失败里有相当一部分是抽样运气。过了就不再试。
    for (let i = 1; i <= ATTEMPTS; i += 1) {
      last = await generateOne(node);
      if (last.ok && last.released) break;
      if (i < ATTEMPTS) log(`[${node.id}] 第 ${i} 次没过，重试`);
    }
    results.push(last);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

console.log('\n=== 汇总 ===');
for (const r of results) {
  console.log(
    `${r.ok ? (r.released ? '✓ live' : '△ blocked') : '✗ fail'}\t${r.node}\t${r.id || r.draft || '-'}\tjob=${r.jobId ?? '-'}\t${r.ok ? '' : String(r.error).slice(0, 120)}`,
  );
}
