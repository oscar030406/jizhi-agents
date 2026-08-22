#!/usr/bin/env node
/**
 * 生成 /skills 页的静态数据快照（public/skill-map.json）。
 *
 * /skills 原本每次访问都直连多智能体引擎，引擎冷启动或下线时整页就没了。快照落盘后
 * 页面先读它秒开，引擎在线时再后台刷新成实时数据。
 *
 * 数据一个字不算：直接取引擎 `GET /internal/v1/personalize/skill-map` 的返回体
 * （app/api/skills/route.ts 调的是同一个端点），原样落盘 + 一个生成时间戳。
 * 岗位与技能清单来自引擎的 data/jobs/job_skill_map.json，覆盖判定来自受控知识库检索，
 * 语料库状态来自各索引文件的磁盘状态——这三样都随所连引擎的机器而变，所以要对着
 * 将来真正服务这个站点的那台引擎跑。
 *
 * 用法（在 apps/classroom 下）：
 *   node --env-file=.env.local scripts/generate-skill-map-snapshot.mjs
 * 或显式给地址：
 *   GROUNDING_URL=http://127.0.0.1:8001 GROUNDING_TOKEN=xxx node scripts/generate-skill-map-snapshot.mjs
 *
 * 部署流程里手动跑，跑完把 public/skill-map.json 一起发上去。不做定时刷新。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(HERE, '..', 'public', 'skill-map.json');

const BASE = (process.env.GROUNDING_URL ?? 'http://127.0.0.1:8001').replace(/\/$/, '');
const ENDPOINT = `${BASE}/internal/v1/personalize/skill-map`;

async function main() {
  const res = await fetch(ENDPOINT, {
    headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
    signal: AbortSignal.timeout(120_000), // 引擎冷启动要建检索索引，给足时间
  });
  if (!res.ok) {
    throw new Error(
      `引擎返回 ${res.status}：${ENDPOINT}\n` +
        '检查 GROUNDING_URL / GROUNDING_TOKEN（与 apps/classroom/.env.local 同名两项一致）',
    );
  }
  const payload = await res.json();
  const data = payload?.data;
  if (!data?.jobs?.length)
    throw new Error(`引擎返回里没有 jobs：${JSON.stringify(payload).slice(0, 200)}`);

  // 页面读的是扁平结构（app/api/skills/route.ts 的 apiSuccess 也是扁平的），
  // 两边同形，页面拿快照还是拿实时数据走的是同一段渲染代码。
  // 只写生成时间，不写来源地址：这份文件是 public/ 下的公开静态资源，任何人 GET
  // /skill-map.json 都能拿到，把引擎地址和内部端点路径写进去等于对外公布内部拓扑。
  // 来源地址只打在本地终端里（下面的 console.log），跑脚本的人自己看得见就够了。
  const snapshot = { ...data, snapshot_at: new Date().toISOString() };
  await writeFile(OUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');

  const skills = data.jobs.reduce((n, j) => n + j.skills.length, 0);
  const covered = data.jobs.reduce((n, j) => n + j.covered_count, 0);
  const builtCorpora = data.corpora.filter((c) => c.available).length;
  console.log(
    `已写入 ${OUT_PATH}\n  来源：${ENDPOINT}\n  岗位 ${data.jobs.length} 个，技能 ${skills} 条` +
      `（知识库可接地 ${covered} 条）\n  语料库已建设 ${builtCorpora}/${data.corpora.length}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
