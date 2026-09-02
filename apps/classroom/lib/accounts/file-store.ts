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
import { withAccountFilesLock } from './file-lock';

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

async function load(): Promise<FileDb> {
  let serialized: string;
  try {
    serialized = await fs.readFile(dbFile(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { accounts: [], sessions: [] };
    }
    throw error;
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('账户数据格式损坏');
  const raw = parsed as Partial<FileDb>;
  if (!Array.isArray(raw.accounts) || !Array.isArray(raw.sessions)) {
    throw new Error('账户数据格式损坏');
  }
  return { accounts: raw.accounts, sessions: raw.sessions };
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

function purgeExpiredSessions(db: FileDb, now = Date.now()): boolean {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  return db.sessions.length !== before;
}

export const fileBackend = {
  async createAccount(input: {
    id: string;
    username: string;
    passwordHash: string;
    displayName: string;
    role: AccountRole;
  }): Promise<{ ok: true; account: Account } | { ok: false; message: string }> {
    return withAccountFilesLock(async () => {
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

  async accountById(accountId: string): Promise<Account | null> {
    const db = await load();
    const record = db.accounts.find((account) => account.id === accountId);
    return record ? toAccount(record) : null;
  },

  async createSession(accountId: string, token: string, maxAgeSeconds: number): Promise<void> {
    return withAccountFilesLock(async () => {
      const db = await load();
      purgeExpiredSessions(db);
      if (!db.accounts.some((account) => account.id === accountId)) {
        throw new Error('账户不存在，不能创建会话');
      }
      db.sessions.push({
        token,
        accountId,
        expiresAt: new Date(Date.now() + maxAgeSeconds * 1000).toISOString(),
      });
      await save(db);
    });
  },

  async authenticateAndCreateSession(input: {
    username: string;
    token: string;
    maxAgeSeconds: number;
    expectedRole: AccountRole;
    verify: (passwordHash: string) => Promise<boolean>;
  }): Promise<
    | { kind: 'success'; account: Account; token: string; maxAge: number }
    | { kind: 'role-mismatch'; account: Account }
    | null
  > {
    return withAccountFilesLock(async () => {
      const db = await load();
      const record = findByUsername(db, input.username);
      if (!record || !(await input.verify(record.password))) return null;
      const account = toAccount(record);
      if (record.role !== input.expectedRole) return { kind: 'role-mismatch', account };
      purgeExpiredSessions(db);
      db.sessions.push({
        token: input.token,
        accountId: record.id,
        expiresAt: new Date(Date.now() + input.maxAgeSeconds * 1000).toISOString(),
      });
      await save(db);
      return {
        kind: 'success',
        account,
        token: input.token,
        maxAge: input.maxAgeSeconds,
      };
    });
  },

  async accountForSession(token: string): Promise<Account | null> {
    return withAccountFilesLock(async () => {
      const db = await load();
      const changed = purgeExpiredSessions(db);
      if (changed) await save(db);
      const session = db.sessions.find((item) => item.token === token);
      if (!session) return null;
      const record = db.accounts.find((account) => account.id === session.accountId);
      return record ? toAccount(record) : null;
    });
  },

  async destroySession(token: string): Promise<void> {
    return withAccountFilesLock(async () => {
      const db = await load();
      const before = db.sessions.length;
      db.sessions = db.sessions.filter((s) => s.token !== token);
      if (db.sessions.length !== before) await save(db);
    });
  },

  async resetPassword(
    accountId: string,
    passwordHash: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return withAccountFilesLock(async () => {
      const db = await load();
      const record = db.accounts.find((a) => a.id === accountId);
      if (!record) return { ok: false as const, message: '账户不存在' };
      record.password = passwordHash;
      db.sessions = db.sessions.filter((session) => session.accountId !== accountId);
      await save(db);
      return { ok: true as const };
    });
  },

  async readProfile(accountId: string): Promise<unknown | null> {
    const db = await load();
    return db.accounts.find((a) => a.id === accountId)?.profile ?? null;
  },

  async writeProfile(accountId: string, profile: unknown): Promise<void> {
    return withAccountFilesLock(async () => {
      const db = await load();
      const record = db.accounts.find((a) => a.id === accountId);
      if (!record) return;
      record.profile = profile ?? null;
      await save(db);
    });
  },

  async accountData(accountId: string): Promise<{
    profile: unknown;
    sessions: Array<{ expiresAt: string }>;
  } | null> {
    return withAccountFilesLock(async () => {
      const db = await load();
      const changed = purgeExpiredSessions(db);
      if (changed) await save(db);
      const account = db.accounts.find((item) => item.id === accountId);
      if (!account) return null;
      return {
        profile: account.profile ?? null,
        sessions: db.sessions
          .filter((session) => session.accountId === accountId)
          .map((session) => ({ expiresAt: session.expiresAt })),
      };
    });
  },

  async deleteAccount(accountId: string): Promise<boolean> {
    return withAccountFilesLock(async () => {
      const db = await load();
      const before = db.accounts.length;
      db.accounts = db.accounts.filter((account) => account.id !== accountId);
      if (db.accounts.length === before) return false;
      db.sessions = db.sessions.filter((session) => session.accountId !== accountId);
      await save(db);
      return true;
    });
  },
};
