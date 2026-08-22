/**
 * 公共课程墙的种子课：走服务端批量生成接口真跑几门课，产物直接落
 * apps/classroom/data/classrooms/*.json（未登录首页的课程墙读这个目录）。
 *
 * 为什么走服务端接口而不是从浏览器导：服务端这条路径与客户端主链同一套
 * 生成器（讲义真形态）、同一套接地检索、同一支异族判官团，产物直接是
 * 持久化格式，不需要从 IndexedDB 里捞再转格式。
 *
 * 媒体一律不开（图片/视频/TTS）——服务端生成的媒体是绝对地址，本机跑出来
 * 的课迁到线上会指向 localhost。
 *
 * 用法：
 *   node scripts/seed-public-courses.mjs                    # 全跑
 *   node scripts/seed-public-courses.mjs --base http://localhost:3000
 *   node scripts/seed-public-courses.mjs --only 0,2         # 只跑第 0、2 门
 *   node scripts/seed-public-courses.mjs --concurrency 2
 */

import process from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const BASE = args.base || 'http://localhost:3000';
const CONCURRENCY = Number(args.concurrency || 3);
const POLL_MS = 10_000;
// 一门 6-8 场景的课实测 25-40 分钟（每个场景=内容生成+三判官审核+可能的修订）
const MAX_WAIT_MS = 50 * 60 * 1000;

// 选题一律落在已建库的语料域内（happy-llm / hello-agents / d2l / agentguide）。
// 库外选题会拿不到证据，课程卡上的"引用 K 段教材"就是 0，不如不放。
const REQUIREMENTS = [
  '给零基础转行学员讲清楚 RAG 检索增强生成，配可运行示例',
  '为后端工程师设计一节 Agent 工具调用实战课',
  '讲清楚 Transformer 的注意力机制，从查询-键-值讲到多头',
  '用生活类比讲明白 softmax 与温度参数怎么影响生成',
  '面向初学者讲清楚梯度下降和学习率怎么选',
  '讲一节大模型上下文窗口与 KV 缓存的课',
];

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
  console.log(`[${index}] job=${jobId} 「${requirement}」`);

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
  console.log(`${r.ok ? '✓' : '✗'} ${r.id ?? r.error}  ${r.requirement}`);
}
