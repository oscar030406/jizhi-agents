#!/usr/bin/env node
/**
 * 把「人工智能应用开发」（主库 ai）的岗位技能地图导出成快照，落到
 * `apps/classroom/data/skill-map-ai.json`。
 *
 * 为什么要快照：/skills 页与首页的岗位技能摘要原来都等 `/api/skills?domain=ai`，
 * 而那条路要转给引擎逐条技能做检索，冷启动实测 ~38 秒（14 岗 150 项技能）。
 * 主库的技能清单和覆盖判定几周才动一次，没有理由让每个访客替它等一次冷启动。
 * 快照跟着仓库走，页面首屏直接渲染；「重新读取」按钮仍然去问引擎实时结果。
 *
 * 用法（dev server 或线上都行，默认打本机 3210）：
 *   node scripts/export-skill-map.mjs
 *   SKILL_MAP_ORIGIN=https://jizhi.chenmingkun.cn node scripts/export-skill-map.mjs
 *
 * 引擎不可达时 /api/skills 会回 204 或最后一次成功数据；两种情况都不覆盖已有快照，
 * 直接非零退出——宁可用旧快照，也不要写进去一份空的。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = process.env.SKILL_MAP_ORIGIN ?? 'http://127.0.0.1:3210';
const DOMAIN = process.env.SKILL_MAP_DOMAIN ?? 'ai';
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  `skill-map-${DOMAIN}.json`,
);

const url = `${ORIGIN.replace(/\/$/, '')}/api/skills?domain=${encodeURIComponent(DOMAIN)}`;
const resp = await fetch(url, { cache: 'no-store' });
if (resp.status === 204) {
  console.error(`${url} 返回 204：引擎不可达，快照未改动。`);
  process.exit(1);
}
if (!resp.ok) {
  console.error(`${url} 返回 HTTP ${resp.status}，快照未改动。`);
  process.exit(1);
}
const body = await resp.json();
if (!Array.isArray(body?.jobs) || body.jobs.length === 0) {
  console.error(`${url} 没有返回岗位数据，快照未改动。`);
  process.exit(1);
}
if (body.stale_from) {
  console.error(`${url} 回的是 ${body.stale_from} 那次的兜底数据，不是实时结果，快照未改动。`);
  process.exit(1);
}

const { success: _success, ...payload } = body;
const snapshot = { exported_at: new Date().toISOString(), source: url, ...payload };
await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
const skills = body.jobs.reduce((n, job) => n + job.skills.length, 0);
console.log(`已写入 ${OUT}：${body.jobs.length} 个岗位、${skills} 项技能。`);
