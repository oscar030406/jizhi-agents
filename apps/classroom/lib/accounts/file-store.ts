/**
 * 账户的文件后备存储——没配 PostgreSQL 时用它，让登录与管理端在本机零配置可用。
 *
 * ## 为什么要有这一层
 *
 * 原设计是「未配数据库时整套登录 UI 自动隐藏，不假装能用」。方向没错，但代价
 * 2026-08-14 暴露了：本地 `.env.local` 的 `PERSISTENCE_DATABASE_URL` 注释着，
 * 于是**本机开发根本看不到任何登录入口**，管理端（按 role 门禁）在本机永远进不去，
 * 演示与验收只能上有数据库的环境。账户能力本身（注册/登录/角色）并不依赖
 * Postgres 的任何特性——依赖的只是「一张小表」，文件完全够。
 *
 * ## 边界（用它之前必须知道）
 *
 * - **单进程假设**。写入走进程内互斥 + 临时文件原子替换，能扛住 dev server 的
 *   并发请求；扛不住多进程同写。生产多实例部署必须配数据库，这一层不是给它用的。
 * - 密码哈希与 pg 后端**同一套**（scrypt 加盐，格式 `salt:hash`），两边互认——
 *   将来把文件里的账户导入数据库不用重置密码。
 * - 落盘位置 `data/accounts/`（classroom 的 `.gitignore` 已整体忽略 `/data`，
 *   密码哈希不会进仓库）。测试用 `ACCOUNTS_DIR` 环境变量重定向。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Account, AccountRole } from './store';

interface FileAccount {
  id: string;
  username: string;
  displayName: string;
  /** scrypt `salt:hash`，与 pg 后端同格式。 */
  password: string;
  role: AccountRole;
  profile: unknown;
  createdAt: string;
}

interface FileSession {
  token: string;
  accountId: string;
  /** ISO 8601。过期会在每次读文件时顺手清掉。 */
  expiresAt: string;
}

interface FileDb {
  accounts: FileAccount[];
  sessions: FileSession[];
}

function dbFile(): string {
  const dir = process.env.ACCOUNTS_DIR || path.join(process.cwd(), 'data', 'accounts');
  return path.join(dir, 'accounts.json');
}

/** 进程内写互斥：所有改动排队执行，避免读-改-写互相覆盖。 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(op, op);
  // 队列本身吞错（防止一次失败卡死后续操作）；调用方拿到的 next 仍然会抛
  mutationQueue = next.catch(() => undefined);
  return next;
}

async function load(): Promise<FileDb> {
  try {
    const raw = JSON.parse(await fs.readFile(dbFile(), 'utf-8')) as Partial<FileDb>;
    const db: FileDb = {
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    };
    // 顺手清过期会话，别让文件无限膨胀
    const now = Date.now();
    db.sessions = db.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    return db;
  } catch {
    return { accounts: [], sessions: [] };
  }
}

async function save(db: FileDb): Promise<void> {
  const file = dbFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 1), 'utf-8');
  await fs.rename(tmp, file); // 原子替换：读到的永远是完整文件
}

function toAccount(a: FileAccount): Account {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: a.role,
    createdAt: a.createdAt,
  };
}

function findByUsername(db: FileDb, username: string): FileAccount | undefined {
  const lower = username.toLowerCase();
  return db.accounts.find((a) => a.username.toLowerCase() === lower);
}

export const fileBackend = {
  async createAccount(input: {
    id: string;
    username: string;
    passwordHash: string;
    displayName: string;
    role: AccountRole;
  }): Promise<{ ok: true; account: Account } | { ok: false; message: string }> {
    return enqueue(async () => {
      const db = await load();
      if (findByUsername(db, input.username)) {
        return { ok: false as const, message: '用户名已被占用' };
      }
      const record: FileAccount = {
        id: input.id,
        username: input.username,
        displayName: input.displayName,
        password: input.passwordHash,
        role: input.role,
        profile: null,
        createdAt: new Date().toISOString(),
      };
      db.accounts.push(record);
      await save(db);
      return { ok: true as const, account: toAccount(record) };
    });
  },

  /** 返回哈希与账户，密码核验留在调用方——scrypt 逻辑两个后端共用一份。 */
  async accountWithHash(
    username: string,
  ): Promise<{ account: Account; passwordHash: string } | null> {
    const db = await load();
    const record = findByUsername(db, username);
    return record ? { account: toAccount(record), passwordHash: record.password } : null;
  },

  async createSession(accountId: string, token: string, maxAgeSeconds: number): Promise<void> {
    return enqueue(async () => {
      const db = await load();
      db.sessions.push({
        token,
        accountId,
        expiresAt: new Date(Date.now() + maxAgeSeconds * 1000).toISOString(),
      });
      await save(db);
    });
  },

  async accountForSession(token: string): Promise<Account | null> {
    const db = await load();
    const session = db.sessions.find((s) => s.token === token && Date.parse(s.expiresAt) > Date.now());
    if (!session) return null;
    const record = db.accounts.find((a) => a.id === session.accountId);
    return record ? toAccount(record) : null;
  },

  async destroySession(token: string): Promise<void> {
    return enqueue(async () => {
      const db = await load();
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => s.token !== token);
      if (db.sessions.length !== before) await save(db);
    });
  },

  async readProfile(accountId: string): Promise<unknown | null> {
    const db = await load();
    return db.accounts.find((a) => a.id === accountId)?.profile ?? null;
  },

  async writeProfile(accountId: string, profile: unknown): Promise<void> {
    return enqueue(async () => {
      const db = await load();
      const record = db.accounts.find((a) => a.id === accountId);
      if (!record) return;
      record.profile = profile ?? null;
      await save(db);
    });
  },
};
