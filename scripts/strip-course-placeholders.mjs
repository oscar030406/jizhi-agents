/**
 * 一次性数据修复：把已落盘课程的讲稿台词里残留的 {{摘录:xxx}} 剥掉。
 *
 * 这批课是在 processActions 加剥离之前生成的（占位符协议只对板书正文生效，
 * 台词没有注入环节，占位符会原样念给学习者）。之后生成的课不再需要跑这个脚本。
 * 口径与 lib/generation/evidence-grounding.ts 的 stripExcerptPlaceholders 一致。
 *
 * 用法：node scripts/strip-course-placeholders.mjs [--dry]
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const DIR = path.join(process.cwd(), 'apps', 'classroom', 'data', 'classrooms');
const PLACEHOLDER = /\{\{\s*摘录\s*[:：]\s*([A-Za-z0-9_#\-]+)\s*\}\}/g;

const strip = (text) =>
  text.includes('{{') ? text.replace(PLACEHOLDER, '').replace(/\s{2,}/g, ' ').trim() : text;

let files = 0;
let touched = 0;
for (const name of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const file = path.join(DIR, name);
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  let count = 0;
  for (const scene of data.scenes ?? []) {
    for (const action of scene.actions ?? []) {
      if (typeof action.text !== 'string') continue;
      const next = strip(action.text);
      if (next !== action.text) {
        action.text = next;
        count += 1;
      }
    }
  }
  files += 1;
  if (count) {
    touched += count;
    if (!DRY) writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`${DRY ? '[dry] ' : ''}${name}: 剥掉 ${count} 处`);
  }
}
console.log(`\n${files} 门课，共处理 ${touched} 处占位符${DRY ? '（未写盘）' : ''}`);
