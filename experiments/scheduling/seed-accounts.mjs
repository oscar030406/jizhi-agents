/**
 * 回放实验的测试账号：一个模拟学生一个账号，只建在实验目录的文件账号后端里。
 *
 * 两步：
 *   seed   服务停着时，往 <accounts-dir>/accounts.json 直接写 N 个学习者账号
 *          （用户名 simu_s0000 起，口令随机，scrypt `salt:hash` 与 lib/accounts/store.ts
 *          同一格式）。明文口令写进 <accounts-dir>/credentials.local.json。
 *          不走注册接口：注册每 15 分钟限 50 个。
 *   login  服务起着时，逐个走 POST /api/auth 登录（成功登录不计限流），
 *          把会话 token 写进 <accounts-dir>/sessions.local.json，各轮回放复用（30 天有效）。
 *
 * <accounts-dir> 整个被 .gitignore 忽略；拒绝指向课堂默认的 data/accounts，
 * 不碰原有的 accounts.json。起课堂进程时用 start-local.ps1 -AccountsDir 指过去。
 *
 * 用法：
 *   node experiments/scheduling/seed-accounts.mjs seed --accounts-dir experiments/scheduling/replay-accounts --count 1073
 *   node experiments/scheduling/seed-accounts.mjs login --accounts-dir experiments/scheduling/replay-accounts
 */

import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const [mode, ...rest] = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i].replace(/^--/, ''), rest[i + 1]);

const dir = resolve(args.get('accounts-dir'));
if (dir === resolve('apps/classroom/data/accounts')) {
  throw new Error('不能写课堂默认的账号目录；给一个实验目录');
}
const accountsFile = join(dir, 'accounts.json');
const credentialsFile = join(dir, 'credentials.local.json');
const sessionsFile = join(dir, 'sessions.local.json');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomPassword() {
  return [...randomBytes(20)].map((b) => ALNUM[b % ALNUM.length]).join('');
}

async function seed() {
  const count = Number(args.get('count'));
  if (existsSync(accountsFile)) throw new Error(`${accountsFile} 已存在；换目录或先删掉`);
  await mkdir(dir, { recursive: true });
  const usernames = Array.from({ length: count }, (_, i) => `simu_s${String(i).padStart(4, '0')}`);
  const credentials = {};
  const accounts = await Promise.all(
    usernames.map(async (username) => {
      const password = randomPassword();
      credentials[username] = password;
      const salt = randomBytes(16);
      const derived = await scrypt(password, salt, 64);
      return {
        id: `acct_${randomBytes(9).toString('hex')}`,
        username,
        displayName: username,
        password: `${salt.toString('hex')}:${derived.toString('hex')}`,
        role: 'learner',
        profile: null,
        createdAt: new Date().toISOString(),
      };
    }),
  );
  await writeFile(credentialsFile, `${JSON.stringify(credentials)}\n`, 'utf-8');
  await writeFile(accountsFile, JSON.stringify({ accounts, sessions: [] }, null, 1), 'utf-8');
  console.log(`写了 ${accounts.length} 个账号到 ${accountsFile}；口令在 ${credentialsFile}`);
}

function postJson(base, path, body) {
  const target = new URL(path, base);
  const payload = Buffer.from(JSON.stringify(body), 'utf-8');
  return new Promise((done, fail) => {
    const req = http.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      },
      (res) => {
        res.resume();
        res.on('end', () => done(res));
      },
    );
    req.on('error', fail);
    req.end(payload);
  });
}

async function login() {
  const base = args.get('base') ?? 'http://127.0.0.1:3210';
  const credentials = JSON.parse(await readFile(credentialsFile, 'utf-8'));
  const sessions = {};
  for (const [username, password] of Object.entries(credentials)) {
    const res = await postJson(base, '/api/auth', { action: 'login', username, password, role: 'learner' });
    if (res.statusCode !== 200) throw new Error(`${username} 登录失败：HTTP ${res.statusCode}`);
    const cookie = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('jizhi_session='));
    sessions[username] = cookie.split(';')[0].slice('jizhi_session='.length);
  }
  await writeFile(sessionsFile, `${JSON.stringify(sessions)}\n`, 'utf-8');
  console.log(`${Object.keys(sessions).length} 个账号登录完成；会话在 ${sessionsFile}`);
}

if (mode === 'seed') await seed();
else if (mode === 'login') await login();
else throw new Error('用法：seed-accounts.mjs seed|login --accounts-dir <目录> [...]');
