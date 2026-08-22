#!/usr/bin/env node
/**
 * 生成公共页区 D 的静态对照数据（public/compare-showcase.json）。
 *
 * 调本地 /api/compare：为两个预设画像各跑一遍完整多智能体闭环——真烧钱
 * （约 ¥1/画像）且要几分钟，所以结果落盘静态化，公共页只读文件不现场跑。
 *
 * 用法（需要 classroom 服务与引擎都在跑）：
 *   node scripts/generate-compare-showcase.mjs [baseUrl] [学习目标]
 *   默认 baseUrl=http://localhost:3000，学习目标=完成 RAG 文档问答 Agent
 *
 * 产物校验：entries 不足两条视为失败，不落盘——公共页读到旧文件也比读到
 * 半截结果好（组件对 entries<2 的文件同样按空态处理，双保险）。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';

// undici 默认 headersTimeout 5min——三画像串行闭环要 10min+，必炸 fetch failed
// （老坑：非流式长请求一律显式关 undici 双超时，AbortSignal 单独管总时长）。
const longHaul = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// 直连引擎而不走 /api/compare 代理：代理超时 30s，而 api 模式下每画像跑完整
// 闭环要几分钟——结构性必超时（线上「引擎未响应」病根即此）。本脚本是离线
// 静态化工具，直接打引擎内部端点并给足超时。
const ENGINE_URL = process.env.GROUNDING_URL ?? 'http://127.0.0.1:8001';
const ENGINE_TOKEN = process.env.AI_SERVICE_TOKEN ?? process.env.GROUNDING_TOKEN ?? 'demo-internal-token';
const LEARNING_GOAL = process.argv[3] ?? '完成 RAG 文档问答 Agent';
/** 同题三人三档（backend→data/learner_profiles/learner_profiles.json）：
 * 零基础 / 转行（有 Python 无 Agent）/ 后端进阶——与适配评测三档、提交包三组对齐 */
const PROFILES = [
  { preset_id: 'zero_beginner' },
  { preset_id: 'python_no_agent' },
  { preset_id: 'backend_to_agent' },
];

const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  process.env.COMPARE_OUT ?? 'compare-showcase.json',
);

async function main() {
  console.log(`调 ${ENGINE_URL}/internal/v1/personalize/compare（${PROFILES.length} 画像各跑完整闭环，需要几分钟）…`);
  const res = await fetch(`${ENGINE_URL.replace(/\/$/, '')}/internal/v1/personalize/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': ENGINE_TOKEN },
    body: JSON.stringify({ learningGoal: LEARNING_GOAL, profiles: PROFILES }),
    signal: AbortSignal.timeout(30 * 60 * 1000),
    dispatcher: longHaul,
  });

  if (res.status === 204 || !res.ok) {
    throw new Error(`引擎未响应或出错（HTTP ${res.status}）。确认引擎在 ${ENGINE_URL} 运行、token 正确后重试。`);
  }

  // 引擎内部端点包一层 {data:…}（原 /api/compare 代理替我们解过包）
  const raw = await res.json();
  const report = raw?.data ?? raw;
  if (!Array.isArray(report.entries) || report.entries.length < 2) {
    throw new Error('引擎返回的对比结果不完整（entries < 2），不落盘。');
  }

  const payload = { generated_at: new Date().toISOString(), ...report };
  await writeFile(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log(
    `已写入 ${OUT_PATH}\n  学习目标：${payload.learning_goal ?? LEARNING_GOAL}\n  画像：${report.entries
      .map((e) => e?.profile?.name ?? '?')
      .join(' vs ')}\n  差异归因：${report.differences?.length ?? 0} 条`,
  );
}

main().catch((err) => {
  console.error(`生成失败：${err.message ?? err}`);
  process.exit(1);
});
