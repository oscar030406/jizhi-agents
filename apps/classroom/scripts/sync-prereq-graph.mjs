/**
 * 把引擎侧造好的前置图同步进 classroom。
 *
 * 图的真源是 `apps/agent-engine/data/knowledge_base/prereq_graph.json`
 * （由 `scripts/build_prereq_graph.py` 造）。classroom 侧要能在构建期直接 import，
 * 所以复制一份到 `lib/generation/data/`——**复制的是产物不是真源**，
 * 改图一律去引擎侧重跑，不要直接编辑这边的副本。
 *
 * 同步时剥掉 `_audit`（逐对判词，几百 KB，运行时用不上，留在引擎侧可查）。
 *
 *   node scripts/sync-prereq-graph.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../../agent-engine/data/knowledge_base/prereq_graph.json');
const TARGET = resolve(here, '../lib/generation/data/prereq-graph.json');

const raw = JSON.parse(readFileSync(SOURCE, 'utf8'));
const slim = {};
for (const [domain, payload] of Object.entries(raw)) {
  if (domain.startsWith('_')) continue;
  const { _audit, ...rest } = payload;
  slim[domain] = rest;
  const edges = Object.keys(rest.clauses ?? {}).length;
  console.log(`${domain}: ${rest.items?.length ?? 0} 概念，${edges} 个概念有前置`);
}

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, JSON.stringify(slim, null, 1) + '\n', 'utf8');
console.log(`落盘 ${TARGET}`);
