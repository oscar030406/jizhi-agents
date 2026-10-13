/**
 * 删掉调度实验建的测试账号（用户名以 loadtest_ 开头的那些），以及它们的会话。
 * 其余账号原样保留。删之前会把原文件备份成 accounts.json.bak-<时间戳>。
 *
 * 用法：
 *   node experiments/scheduling/remove-test-accounts.mjs --dry-run   # 只打印会删哪些
 *   node experiments/scheduling/remove-test-accounts.mjs             # 真删
 *
 * 跑之前先停掉本机课堂服务（stop-local.ps1），免得服务端同时在写这个文件。
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const PREFIX = 'loadtest_';
const dryRun = process.argv.includes('--dry-run');
const file = resolve(
  process.env.ACCOUNTS_DIR || 'apps/classroom/data/accounts',
  'accounts.json',
);

const db = JSON.parse(await readFile(file, 'utf-8'));
const doomed = db.accounts.filter((a) => String(a.username).startsWith(PREFIX));
if (!doomed.length) {
  console.log(`${file} 里没有 ${PREFIX}* 账号，什么也没做`);
  process.exit(0);
}
console.log(`会删掉 ${doomed.length} 个账号：`);
for (const account of doomed) console.log(`  ${account.username}`);
if (dryRun) {
  console.log('（--dry-run，文件没动）');
  process.exit(0);
}

const doomedIds = new Set(doomed.map((a) => a.id));
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await copyFile(file, backup);
db.accounts = db.accounts.filter((a) => !doomedIds.has(a.id));
db.sessions = (db.sessions ?? []).filter((s) => !doomedIds.has(s.accountId));
await writeFile(file, `${JSON.stringify(db, null, 1)}\n`, 'utf-8');
console.log(`已删除。原文件备份在 ${backup}`);
