#!/usr/bin/env node
/**
 * Turbopack 把 server external 包外部化成带哈希的别名（shiki-2963fa3a20578463 这类），
 * 靠 .next/node_modules/ 里的符号链接解析。这些链接由构建生成，指向**构建机绝对路径**，
 * .next 上传到服务器后全部悬空 —— 表现为对应路由 SSR 500（Failed to load external module）。
 *
 * 本脚本在 build 之后把这些链接改写成相对路径（../../node_modules/...），
 * 这样 .next 传到任何机器都命中该机自己的 node_modules，不用再人工 ln -sfn。
 *
 * 约束：
 * - 枚举读目录，不 grep chunk（jsx-<16hex> 是 styled-jsx 类名，是假阳性）。
 * - 只改链接指向，绝不解引用拷贝（sharp 带原生二进制，拷过去是构建机平台的）。
 * - 目标不存在 / 无权限建链接时告警但不失败，构建不该因为一个可选外部包挂掉。
 * - 幂等：已是相对路径的直接跳过。
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(appRoot, '.next', 'node_modules');

if (!existsSync(root)) {
  console.log('[relink] 没有 .next/node_modules，本次构建无外部化别名，跳过');
  process.exit(0);
}

// 别名有两层：顶层 <pkg>-<hash>，以及 @scope/ 下的 <pkg>-<hash>
const links = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
  const p = join(root, entry.name);
  if (entry.name.startsWith('@') && entry.isDirectory() && !entry.isSymbolicLink()) {
    for (const sub of readdirSync(p, { withFileTypes: true })) links.push(join(p, sub.name));
  } else {
    links.push(p);
  }
}

const name = (link) => relative(root, link).replaceAll('\\', '/');
let rebuilt = 0;
let skipped = 0;
let broken = 0;

for (const link of links) {
  if (!lstatSync(link).isSymbolicLink()) {
    console.log(`  跳过 ${name(link)}：不是符号链接`);
    skipped++;
    continue;
  }

  const target = readlinkSync(link);
  if (!isAbsolute(target)) {
    if (!existsSync(link)) {
      console.warn(`  告警 ${name(link)}：相对链接指向不存在的 ${target}（本机缺这个包？）`);
      broken++;
    } else {
      console.log(`  跳过 ${name(link)}：已是相对路径 ${target}`);
      skipped++;
    }
    continue;
  }

  if (!existsSync(target)) {
    console.warn(`  告警 ${name(link)}：目标不存在 ${target}，保持原样`);
    broken++;
    continue;
  }

  // 优先指向顶层 node_modules/<pkg>（它自己是指向 .pnpm 的软链），
  // 这样服务器上 pnpm 解出的版本号跟构建机不一致时也还能命中；顶层没有才退回 .pnpm 实路径。
  const pkg = target.replaceAll('\\', '/').split(/\/node_modules\//).pop();
  const hoisted = join(appRoot, 'node_modules', pkg);
  const dest = pkg && existsSync(hoisted) ? hoisted : target;
  const rel = relative(dirname(link), dest).replaceAll('\\', '/');
  const tmp = `${link}.relink-tmp`;
  try {
    try {
      unlinkSync(tmp);
    } catch {
      /* 上次跑到一半留下的残骸，没有就算了 */
    }
    // 先在临时名上建好再顶替，中途失败时原链接不受影响
    symlinkSync(rel, tmp, 'dir');
    unlinkSync(link);
    renameSync(tmp, link);
    console.log(`  重建 ${name(link)} -> ${rel}`);
    rebuilt++;
  } catch (err) {
    console.warn(`  告警 ${name(link)}：重建失败（${err.message}），保持绝对路径`);
    broken++;
  }
}

const unresolved = links.filter((l) => !existsSync(l)).map(name);
console.log(
  `[relink] 别名 ${links.length} 个：重建 ${rebuilt}、跳过 ${skipped}、告警 ${broken}` +
    (unresolved.length ? `；本机无法解析：${unresolved.join(', ')}` : '；全部可解析'),
);
