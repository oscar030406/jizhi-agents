/**
 * 学习路径课程回填：把批量生成的课挂到 learning-path.json 的待生成节点
 * （courseId: null → 实际 id）。
 *
 * 课程落盘 JSON 不存 requirement（只有生成后的标题），映射唯一可靠来源是
 * 种子脚本日志的汇总行「✓ <id>  <requirement>」——需求文案与节点 requirement
 * 全等匹配，零误挂；文案改过就挂不上（特性：防改口径的课顶上旧节点）。
 *
 * 用法：node scripts/link-path-courses.mjs [--log tmp/seed_path_20260809.log] [--dry]
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PATH_FILE = path.join(ROOT, 'apps/classroom/data/learning-path.json');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const logArg = args[args.indexOf('--log') + 1];
const LOG_FILE = path.join(ROOT, args.includes('--log') ? logArg : 'tmp/seed_path_20260809.log');

const log = fs.readFileSync(LOG_FILE, 'utf-8');
const pairs = [...log.matchAll(/^✓ (\S+)\s{2}(.+)$/gm)].map((m) => ({
  id: m[1],
  requirement: m[2].trim(),
}));
if (!pairs.length) {
  console.error('日志里没有「✓ id  需求」汇总行——生成还没跑完，或全部失败。');
  process.exit(1);
}

const pathData = JSON.parse(fs.readFileSync(PATH_FILE, 'utf-8'));
let linked = 0;
const misses = [];
for (const node of pathData.nodes) {
  if (node.courseId || !node.requirement) continue;
  const hit = pairs.find((p) => p.requirement === node.requirement.trim());
  if (hit) {
    console.log(`[link] ${node.id} → ${hit.id}`);
    node.courseId = hit.id;
    linked += 1;
  } else {
    misses.push(node.id);
  }
}

console.log(`\n回填 ${linked} 个节点${misses.length ? `；未匹配：${misses.join(', ')}` : ''}`);
if (!dry && linked) {
  fs.writeFileSync(PATH_FILE, `${JSON.stringify(pathData, null, 2)}\n`, 'utf-8');
  console.log('learning-path.json 已写回');
}
