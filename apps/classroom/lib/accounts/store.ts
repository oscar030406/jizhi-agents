/**
 * 账户存储（服务端）——用户名 + 密码的最简账户，无手机号/邮箱绑定。
 *
 * 设计取舍（2026-08-04 用户定调）：注册只要用户名和密码，密码规则宽松
 * （英文数字 ≥6 位）。账户 id 直接充当 `learnerKey`——上游的运行时与文档
 * 存储本来就按 learnerKey 分区，于是「课程 / 画像 / 学情随账户走」不需要
 * 额外的数据迁移层，登录即换分区。
 *
 * 密码用 scrypt 加盐哈希（Node 内置，无新依赖）；会话是随机 token，
 * 存库并下发 httpOnly cookie——浏览器拿不到 token 明文，也就无从伪造分区。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { Pool } from 'pg';

const scrypt = promisify(scryptCb);

/**
 * 角色是学习端与管理端之间唯一的桥。两个 C 端共用一套账户，进哪一端由它决定。
 * 不做权限矩阵：只有两个角色、两个入口，一张表就够，加抽象层是给自己找活干。
 */
import {
  activeFields,
  isEnvelope,
  toEnvelope,
  type ProfileEnvelope,
  updateProfile,
} from './profiles';

export const ROLES = ['learner', 'manager'] as const;
export type AccountRole = (typeof ROLES)[number];
export const DEFAULT_ROLE: AccountRole = 'learner';

export function normalizeRole(value: unknown): AccountRole {
  return ROLES.includes(value as AccountRole) ? (value as AccountRole) : DEFAULT_ROLE;
}

export interface Account {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  createdAt: string;
}

const SESSION_TTL_DAYS = 30;

let poolPromise: Promise<Pool> | null = null;

function connectionString(): string | undefined {
  return process.env.PERSISTENCE_DATABASE_URL || process.env.DATABASE_URL;
}

/**
 * 账户功能是否可用。**2026-08-14 起恒为 true**：没配数据库时走文件后备存储
 * （`./file-store.ts`，单进程、落 `data/accounts/`），本机零配置就能注册登录、
 * 进管理端。原来的「未配库就整套隐藏」让本地开发根本看不到登录入口，
 * 管理端在本机永远进不去。保留这个函数是因为 6 个文件 7 处调用把它当
 * 「系统在不在」的开关用（`app/admin/page.tsx`、`app/admin/course/[id]/page.tsx`、
 * `app/admin/knowledge/guard.tsx`、`app/api/auth/route.ts` 两处、
 * `app/api/knowledge/corpora/route.ts`、`lib/persistence/server-auth.ts`）——语义仍然成立，
 * 只是答案变成了永远在。想删它就得同时改这 6 个文件加一条单测，不是纯注释改动。
 * 每新增一个管理端入口这个数就涨一次，动手前自己 `grep -rn accountsEnabled` 复算。
 */
export function accountsEnabled(): boolean {
  return true;
}

/** 当前用哪个后端。配了数据库用 pg（多进程安全），否则文件（单进程，本机/演示）。 */
function usePg(): boolean {
  return !!connectionString();
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    const url = connectionString();
    if (!url) throw new Error('accounts: PERSISTENCE_DATABASE_URL not configured');
    poolPromise = (async () => {
      const pool = new Pool({ connectionString: url, max: 4 });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          id           TEXT PRIMARY KEY,
          username     TEXT UNIQUE NOT NULL,
          display_name TEXT NOT NULL,
          password     TEXT NOT NULL,
          profile      JSONB,
          role         TEXT NOT NULL DEFAULT 'learner',
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- 已存在的库补列：CREATE TABLE IF NOT EXISTS 对老表不生效，
        -- 少了这一行，升级过的部署会在 INSERT 时报 column "role" does not exist。
        ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'learner';
        CREATE TABLE IF NOT EXISTS account_sessions (
          token      TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions(account_id);
      `);
      return pool;
    })().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }
  return poolPromise;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const derived = (await scrypt(password, Buffer.from(saltHex, 'hex'), 64)) as Buffer;
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** 用户名：3-24 位字母数字下划线；密码：6-64 位字母数字（用户定调的宽松口径）。 */
export function validateCredentials(
  username: string,
  password: string,
): { ok: true } | { ok: false; message: string } {
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    return { ok: false, message: '用户名需为 3-24 位字母、数字或下划线' };
  }
  if (!/^[A-Za-z0-9]{6,64}$/.test(password)) {
    return { ok: false, message: '密码需为 6-64 位字母或数字' };
  }
  return { ok: true };
}

export async function createAccount(
  username: string,
  password: string,
  role: AccountRole = DEFAULT_ROLE,
  displayName?: string,
): Promise<{ ok: true; account: Account } | { ok: false; message: string }> {
  if (!usePg()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.createAccount({
      id: `acct_${randomBytes(9).toString('hex')}`,
      username,
      passwordHash: await hashPassword(password),
      displayName: displayName?.trim() || username,
      role: normalizeRole(role),
    });
  }
  const pool = await getPool();
  const exists = await pool.query('SELECT 1 FROM accounts WHERE lower(username) = lower($1)', [
    username,
  ]);
  if (exists.rowCount) return { ok: false, message: '用户名已被占用' };

  const id = `acct_${randomBytes(9).toString('hex')}`;
  const password_hash = await hashPassword(password);
  const name = displayName?.trim() || username;
  const row = await pool.query(
    `INSERT INTO accounts (id, username, display_name, password, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, username, display_name, role, created_at`,
    [id, username, name, password_hash, normalizeRole(role)],
  );
  return { ok: true, account: rowToAccount(row.rows[0]) };
}

export async function authenticate(
  username: string,
  password: string,
): Promise<Account | null> {
  if (!usePg()) {
    const { fileBackend } = await import('./file-store');
    const found = await fileBackend.accountWithHash(username);
    if (!found) return null;
    return (await verifyPassword(password, found.passwordHash)) ? found.account : null;
  }
  const pool = await getPool();
  const row = await pool.query(
    'SELECT id, username, display_name, password, role, created_at FROM accounts WHERE lower(username) = lower($1)',
    [username],
  );
  if (!row.rowCount) return null;
  const record = row.rows[0] as Record<string, unknown>;
  const ok = await verifyPassword(password, String(record.password));
  return ok ? rowToAccount(record) : null;
}

export async function createSession(accountId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString('hex');
  const maxAge = SESSION_TTL_DAYS * 24 * 3600;
  if (!usePg()) {
    const { fileBackend } = await import('./file-store');
    await fileBackend.createSession(accountId, token, maxAge);
    return { token, maxAge };
  }
  const pool = await getPool();
  await pool.query(
    `INSERT INTO account_sessions (token, account_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
    [token, accountId, String(maxAge)],
  );
  return { token, maxAge };
}

export async function accountForSession(token: string | undefined): Promise<Account | null> {
  if (!token) return null;
  if (!usePg()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.accountForSession(token);
  }
  const pool = await getPool();
  const row = await pool.query(
    `SELECT a.id, a.username, a.display_name, a.role, a.created_at
       FROM account_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  return row.rowCount ? rowToAccount(row.rows[0]) : null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  if (!usePg()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.destroySession(token);
  }
  const pool = await getPool();
  await pool.query('DELETE FROM account_sessions WHERE token = $1', [token]);
}

/**
 * 读当前档案的扁平画像。
 *
 * 存储里放的是**多档案信封**（`./profiles.ts`），但这个函数仍然只吐当前那一份的
 * 扁平字段——所以生成链、report 页、`/api/auth` 这些既有读取方**一行都不用改**，
 * 拿到的东西与多档案改造前逐字相同。要整个信封走 `readProfileEnvelope`。
 */
export async function readProfile(accountId: string): Promise<unknown | null> {
  const env = await readProfileEnvelope(accountId);
  return env ? activeFields(env) : null;
}

/** 整个多档案信封（档案列表 + 当前档案 id）。旧扁平画像会就地迁移成一条默认档案。 */
export async function readProfileEnvelope(accountId: string): Promise<ProfileEnvelope | null> {
  const raw = await readRawProfile(accountId);
  // 账户存在但没画像时也给一个空信封：前端要能在「还没填」的状态下建档案、改字段。
  return toEnvelope(raw);
}

export async function writeProfileEnvelope(
  accountId: string,
  env: ProfileEnvelope,
): Promise<void> {
  await writeProfile(accountId, env);
}

/** 原样读那坨 JSON（可能是旧扁平画像，也可能是新信封）。 */
async function readRawProfile(accountId: string): Promise<unknown | null> {
  if (!usePg()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.readProfile(accountId);
  }
  const pool = await getPool();
  const row = await pool.query('SELECT profile FROM accounts WHERE id = $1', [accountId]);
  return row.rowCount ? (row.rows[0].profile ?? null) : null;
}

/**
 * 存当前档案的扁平画像。**只动当前那一份，其余档案原样保留。**
 *
 * 这个函数的老调用方（`/api/auth` 的 profile 动作、画像弹层的 800ms 防抖上行）
 * 传进来的一直是一份扁平画像。多档案改造后如果照旧原样落盘，
 * 就会把整个信封替换成一个扁平对象——**用户其余档案当场全没**。
 * 所以这里改成读-改-写：把 fields 写进 activeId 指向的那一条。
 *
 * 传 null（登出清档之类）仍然整份清掉，与改造前语义一致。
 */
export async function writeProfile(accountId: string, profile: unknown): Promise<void> {
  if (profile === null || profile === undefined) {
    await writeRawProfile(accountId, null);
    return;
  }
  // 已经是信封就直接落（`writeProfileEnvelope` 那条路），不要再包一层。
  if (isEnvelope(profile)) {
    await writeRawProfile(accountId, profile);
    return;
  }
  const env = toEnvelope(await readRawProfile(accountId));
  const target = env.profiles.find((p) => p.id === env.activeId) ?? env.profiles[0];
  const updated = updateProfile(env, target.id, { fields: profile as Record<string, unknown> });
  await writeRawProfile(accountId, updated.ok ? updated.env : env);
}

async function writeRawProfile(accountId: string, profile: unknown): Promise<void> {
  if (!usePg()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.writeProfile(accountId, profile);
  }
  const pool = await getPool();
  await pool.query('UPDATE accounts SET profile = $2 WHERE id = $1', [
    accountId,
    profile === null || profile === undefined ? null : JSON.stringify(profile),
  ]);
}

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: normalizeRole(row.role),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
