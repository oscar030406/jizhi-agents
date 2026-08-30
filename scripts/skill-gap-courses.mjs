/**
 * 主岗位技能缺口补课：对「AI Agent 开发工程师」13 项技能中有库内证据但课程墙
 * 尚无对应课的 5 项，走服务端生成接口真跑成课（与 /skills 页「按此技能造课」
 * 同一套措辞与流水线）。
 *
 * 3 项语料缺口技能（Agent Harness Engineering / 自进化 Agent 与多平台运行时 /
 * 编码 Agent 与 AgentOS 工程实践）按 metrics.json job_skill_coverage_primary
 * 冻结口径如实留白，不硬造——库里没有证据的课等于让判官放空枪。
 *
 * 用法（生产在服务器上 nohup 跑）：
 *   node scripts/skill-gap-courses.mjs --base http://127.0.0.1:3210 --concurrency 2
 */

import process from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const BASE = args.base || 'http://localhost:3000';
const CONCURRENCY = Number(args.concurrency || 2);
const POLL_MS = 10_000;
const MAX_WAIT_MS = 50 * 60 * 1000;

const JOB = 'AI Agent 开发工程师';
const SKILLS = [
  'MCP 与 A2A 协议原理与工程实践',
  '多轮对话长期记忆优化策略',
  '企业级 Agent 平台与产品落地',
  'Agent 规划-执行-反思（Plan-Execute-Reflect）循环设计',
  'ReAct、CoT 与工具增强推理设计模式',
];

const REQUIREMENTS = SKILLS.map(
  (skill) => `面向「${JOB}」岗位的技能培训课：${skill}。学员为转岗/内训背景，请给出讲解、实操与测验。`,
);

const selected = args.only
  ? String(args.only).split(',').map((n) => REQUIREMENTS[Number(n)]).filter(Boolean)
  : REQUIREMENTS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateOne(requirement, index) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/generate-classroom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-locale': 'zh-CN' },
    body: JSON.stringify({ requirement }),
  });
  const body = await res.json();
  if (!res.ok || !body?.jobId) {
    console.log(`[${index}] 建单失败 HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return { requirement, ok: false, error: `create ${res.status}` };
  }
  const { jobId } = body;
  console.log(`[${index}] job=${jobId} 「${requirement.slice(0, 40)}…」`);

  let lastStep = '';
  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    const poll = await fetch(`${BASE}/api/generate-classroom/${jobId}`);
    const job = await poll.json();
    const step = `${job?.step ?? '?'} ${job?.progress ?? ''}% ${job?.message ?? ''}`;
    if (step !== lastStep) {
      console.log(`[${index}] ${Math.round((Date.now() - started) / 1000)}s ${step}`);
      lastStep = step;
    }
    if (job?.status === 'succeeded') {
      const id = job?.result?.id ?? '?';
      console.log(`[${index}] 完成 id=${id} 用时 ${Math.round((Date.now() - started) / 1000)}s`);
      return { requirement, ok: true, id, seconds: Math.round((Date.now() - started) / 1000) };
    }
    if (job?.status === 'failed') {
      console.log(`[${index}] 失败: ${job?.error ?? job?.message}`);
      return { requirement, ok: false, error: job?.error ?? job?.message };
    }
  }
  return { requirement, ok: false, error: 'timeout' };
}

const queue = selected.map((requirement, index) => ({ requirement, index }));
const results = [];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    results.push(await generateOne(item.requirement, item.index));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

console.log('\n=== 汇总 ===');
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.id ?? r.error}  ${r.requirement.slice(0, 60)}`);
}
