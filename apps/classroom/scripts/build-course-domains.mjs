#!/usr/bin/env node
/**
 * 从每门课 scenes 引用的 source_id 推导课程所属知识域，落 data/course-domains.json。
 *
 * 判定规则（与语料库 source_id 命名现实对齐，见各库 knowledge_index.jsonl）：
 * - 具身智能语料：短前缀 em（em01s02#s3 形态）
 * - 工业时序数据库（IoTDB）：含 ainode/iotdb/timecho 特征或 table-/sql- 类长 id 且命中 iotdb 索引
 * - 企业管理软件（Odoo）：content-/applications- 类长 id
 * - 其余短前缀（ha/hl/pg/ag/dl 等）与向量库/RAG 进阶语料 → ai 主域
 * 一门课按引用计数取多数域；无引用（纯 slide 老课）默认 ai。
 *
 * 用法：node scripts/build-course-domains.mjs   （在 apps/classroom 下）
 * 重跑安全：全量重写输出文件。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const classroomsDir = join(root, 'data', 'classrooms');
const outPath = join(root, 'data', 'course-domains.json');

// 学习路径是 AI 域专属：路径挂着的课一律判 ai，覆盖引用计数。
// （具身语料以 embodied_docs 并入主索引，AI 课引用 em 块是正常现象——
// 例如「大模型上下文与 KV 缓存」大量引具身文档但它是路径内的 AI 课。）
const pathData = JSON.parse(readFileSync(join(root, 'data', 'learning-path.json'), 'utf-8'));
const pathCourseIds = new Set(
  (pathData.nodes ?? []).map((n) => n.courseId).filter(Boolean),
);

const SID_RE = /"([a-z][a-z0-9-]{1,60})#s\d+"/g;

function domainOfSid(sid) {
  if (/^em\d/.test(sid)) return 'embodied';
  if (/^(table|sql|ainode|iotdb|timecho|deployment-and-maintenance|user-manual)/.test(sid))
    return 'iotdb';
  if (/^(content|applications|administration|developer)/.test(sid)) return 'odoo';
  return 'ai';
}

const result = {};
for (const f of readdirSync(classroomsDir).filter((f) => f.endsWith('.json'))) {
  const raw = readFileSync(join(classroomsDir, f), 'utf-8');
  const counts = {};
  for (const m of raw.matchAll(SID_RE)) {
    const d = domainOfSid(m[1]);
    counts[d] = (counts[d] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const id = f.replace(/\.json$/, '');
  let title = id;
  try {
    title = JSON.parse(raw)?.stage?.name ?? id;
  } catch {}
  const domain = pathCourseIds.has(id) ? 'ai' : top ? top[0] : 'ai';
  result[id] = { domain, title, refs: counts };
}

writeFileSync(outPath, JSON.stringify(result, null, 1), 'utf-8');
const byDomain = {};
for (const [, v] of Object.entries(result)) byDomain[v.domain] = (byDomain[v.domain] ?? 0) + 1;
console.log('courses:', Object.keys(result).length, 'by domain:', byDomain);
