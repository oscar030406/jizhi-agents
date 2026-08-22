/**
 * 一次性数据修复：剥掉讲义正文段落末尾残留的字数自注（「…其实不然。(33)」）。
 *
 * 来源：讲义提示词 lecture-scene-content/system.md 规则 9 给了段落「19–41 汉字」
 * 的双边区间，模型偶发把自己数出来的字数当成输出的一部分写进段落末尾。不是每门课
 * 都犯，2026-08-16 这批 9 门里只有一门中招，所以按数据修，没动共用提示词——改提示词
 * 会让同一批里前后生成的课不同源。
 *
 * 在原始文本上替换，不 parse/stringify：整份重新序列化会把没中招的课也改一遍缩进，
 * diff 里看不出真正改了什么。判据三条同时成立才算字数自注：
 *   ① 紧跟句末标点 。！？；② 括号里 2-3 位数字（列表序号是 1 位且在段首）；
 *   ③ 后面紧接段落收尾（`</p>`、换行转义或字符串结束引号）。
 * 这三条在当日 25 门落盘课上只命中一门 15 处，其余 24 门零命中。
 *
 * 用法：node scripts/strip-course-charcount.mjs [--dry]
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const DIR = path.join(process.cwd(), 'apps', 'classroom', 'data', 'classrooms');
const NOTE = /([。！？])[（(]\d{2,3}[)）](?=(?:<\/p>|\\n|"))/g;

let files = 0;
let hits = 0;
for (const name of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const file = path.join(DIR, name);
  const before = readFileSync(file, 'utf-8');
  const n = (before.match(NOTE) ?? []).length;
  if (!n) continue;
  files += 1;
  hits += n;
  console.log(`${DRY ? '[dry] ' : ''}${name}：剥掉 ${n} 处字数自注`);
  if (!DRY) writeFileSync(file, before.replace(NOTE, '$1'));
}
console.log(`${DRY ? '--dry：未写盘；' : ''}命中 ${files} 门课 ${hits} 处`);
