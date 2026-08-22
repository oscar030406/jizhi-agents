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
 *   node scripts/seed-path-courses.mjs                    # 全跑
 *   node scripts/seed-path-courses.mjs --base http://localhost:3000
 *   node scripts/seed-path-courses.mjs --only 0,2         # 只跑第 0、2 门
 *   node scripts/seed-path-courses.mjs --concurrency 2
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
  // 前置层（学习路径 learning-path-practice-spec-20260809.md §1.6）
  '面向零基础的 Python 第一课：变量、字符串、列表与 for 循环，配大量可直接运行的小例子，节奏放慢',
  '讲清楚 Python 的函数、字典与类：从写好一个函数到组织一个小程序，面向想做 AI 应用的初学者',
  '零基础讲清楚线性代数最核心的三件事：向量、矩阵乘法、维度，为理解注意力机制打底。纯讲义讲解，重几何直觉与图形化描述，不需要交互教具',
  '零基础讲清楚导数与链式法则：从切线斜率的直觉到梯度是什么，为理解梯度下降打底。纯讲义讲解，重几何直觉，不需要交互教具',
  // 基础层补
  '讲清楚大模型是怎么练出来的：预训练、SFT 指令微调、LoRA 各是什么、解决什么问题，重概念与流程，不涉及代码实现',
  // 方向层补
  '讲一节多 Agent 协作与编排：为什么要分工、状态图编排怎么工作、常见协作模式与失败模式，面向想做 Agent 应用的工程师',
  '讲清楚 RAG 检索质量怎么评估与改进：文档分块、召回、重排序与常用评测指标，面向 RAG 工程方向学习者',
  '讲一节大模型推理服务化与部署：从把模型包成 API 到吞吐与显存优化的核心取舍，面向部署方向初学者',
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
