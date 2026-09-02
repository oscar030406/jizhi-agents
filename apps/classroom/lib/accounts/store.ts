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
import { withAccountFilesLock } from './file-lock';

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
let learningPoolPromise: Promise<Pool> | null = null;
let learningPoolUrl: string | null = null;

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
function hasPostgres(): boolean {
  return !!connectionString();
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    const url = connectionString();
    if (!url) throw new Error('accounts: PERSISTENCE_DATABASE_URL not configured');
    poolPromise = (async () => {
      const pool = new Pool({ connectionString: url, max: 4 });
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`
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
          const collision = await client.query(`
          SELECT lower(username) AS normalized_username, count(*)::int AS account_count
            FROM accounts
           GROUP BY lower(username)
          HAVING count(*) > 1
           LIMIT 1
        `);
          if (collision.rowCount) {
            const row = collision.rows[0];
            throw new Error(
              `账户完整性审计失败：用户名 ${String(row.normalized_username)} 忽略大小写后存在 ${String(row.account_count)} 条记录；未修改现存数据`,
            );
          }
          try {
            await client.query(
              'CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_unique ON accounts (lower(username))',
            );
          } catch (error) {
            if ((error as { code?: string }).code === '23505') {
              throw new Error(
                '账户完整性审计失败：检测到并发写入的大小写用户名碰撞；未修改现存数据',
              );
            }
            throw error;
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        await pool.end();
        throw error;
      }
      return pool;
    })().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }
  return poolPromise;
}

async function getLearningPool(): Promise<Pool | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (url === connectionString()) return getPool();
  if (!learningPoolPromise || learningPoolUrl !== url) {
    learningPoolUrl = url;
    learningPoolPromise = Promise.resolve(new Pool({ connectionString: url, max: 4 })).catch(
      (error) => {
        learningPoolPromise = null;
        learningPoolUrl = null;
        throw error;
      },
    );
  }
  return learningPoolPromise;
}

async function tableExists(queryable: Pick<Pool, 'query'>, table: string): Promise<boolean> {
  const result = await queryable.query('SELECT to_regclass($1) AS table_name', [table]);
  return result.rows[0]?.table_name != null;
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
  if (!hasPostgres()) {
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
  const id = `acct_${randomBytes(9).toString('hex')}`;
  const password_hash = await hashPassword(password);
  const name = displayName?.trim() || username;
  try {
    const row = await pool.query(
      `INSERT INTO accounts (id, username, display_name, password, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, display_name, role, created_at`,
      [id, username, name, password_hash, normalizeRole(role)],
    );
    return { ok: true, account: rowToAccount(row.rows[0]) };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, message: '用户名已被占用' };
    }
    throw error;
  }
}

export async function authenticate(username: string, password: string): Promise<Account | null> {
  if (!hasPostgres()) {
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

export type AuthenticatedSession =
  | { kind: 'success'; account: Account; token: string; maxAge: number }
  | { kind: 'role-mismatch'; account: Account };

/** 密码核验、角色核对与建会话在同一账户锁内完成；密码重置不能从两步之间穿过。 */
export async function authenticateAndCreateSession(
  username: string,
  password: string,
  expectedRole: AccountRole,
): Promise<AuthenticatedSession | null> {
  const token = randomBytes(32).toString('hex');
  const maxAge = SESSION_TTL_DAYS * 24 * 3600;
  if (!hasPostgres()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.authenticateAndCreateSession({
      username,
      token,
      maxAgeSeconds: maxAge,
      expectedRole,
      verify: (passwordHash) => verifyPassword(password, passwordHash),
    });
  }

  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      `SELECT id, username, display_name, password, role, created_at
         FROM accounts
        WHERE lower(username) = lower($1)
        FOR UPDATE`,
      [username],
    );
    if (!row.rowCount || !(await verifyPassword(password, String(row.rows[0].password)))) {
      await client.query('COMMIT');
      return null;
    }
    const account = rowToAccount(row.rows[0]);
    if (account.role !== expectedRole) {
      await client.query('COMMIT');
      return { kind: 'role-mismatch', account };
    }
    await client.query('DELETE FROM account_sessions WHERE expires_at <= now()');
    await client.query(
      `INSERT INTO account_sessions (token, account_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [token, account.id, String(maxAge)],
    );
    await client.query('COMMIT');
    return { kind: 'success', account, token, maxAge };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createSession(accountId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString('hex');
  const maxAge = SESSION_TTL_DAYS * 24 * 3600;
  if (!hasPostgres()) {
    const { fileBackend } = await import('./file-store');
    await fileBackend.createSession(accountId, token, maxAge);
    return { token, maxAge };
  }
  const pool = await getPool();
  await pool.query('DELETE FROM account_sessions WHERE expires_at <= now()');
  await pool.query(
    `INSERT INTO account_sessions (token, account_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
    [token, accountId, String(maxAge)],
  );
  return { token, maxAge };
}

export async function accountForSession(token: string | undefined): Promise<Account | null> {
  if (!token) return null;
  if (!hasPostgres()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.accountForSession(token);
  }
  const pool = await getPool();
  await pool.query('DELETE FROM account_sessions WHERE expires_at <= now()');
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
  if (!hasPostgres()) {
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

export async function writeProfileEnvelope(accountId: string, env: ProfileEnvelope): Promise<void> {
  await writeProfile(accountId, env);
}

/** 原样读那坨 JSON（可能是旧扁平画像，也可能是新信封）。 */
async function readRawProfile(accountId: string): Promise<unknown | null> {
  if (!hasPostgres()) {
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
  if (!hasPostgres()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.writeProfile(accountId, profile);
  }
  const pool = await getPool();
  await pool.query('UPDATE accounts SET profile = $2 WHERE id = $1', [
    accountId,
    profile === null || profile === undefined ? null : JSON.stringify(profile),
  ]);
}

/**
 * 管理员重置成员密码（机构场景：无邮箱/手机号找回体系下的唯一兜底）。
 * 归属校验在接口层（只有机构 owner 对本机构 member 可用），这里只管落盘。
 */
export async function resetPassword(
  accountId: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const hash = await hashPassword(newPassword);
  if (!hasPostgres()) {
    const { fileBackend } = await import('./file-store');
    return fileBackend.resetPassword(accountId, hash);
  }
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [
      accountId,
    ]);
    if (!account.rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, message: '账户不存在' };
    }
    await client.query('UPDATE accounts SET password = $2 WHERE id = $1', [accountId, hash]);
    await client.query('DELETE FROM account_sessions WHERE account_id = $1', [accountId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function serverLearningData(accountId: string) {
  const pool = await getLearningPool();
  if (!pool) return { configured: false, runtimeSessions: [], documents: [] };

  const [runtimeSessionsTable, runtimeRecordsTable, stagesTable, scenesTable, outlinesTable] =
    await Promise.all([
      tableExists(pool, 'runtime_sessions'),
      tableExists(pool, 'runtime_records'),
      tableExists(pool, 'document_stages'),
      tableExists(pool, 'document_scenes'),
      tableExists(pool, 'document_outlines'),
    ]);
  if (runtimeSessionsTable !== runtimeRecordsTable) {
    throw new Error('服务端学习记录表不完整，无法导出');
  }
  if (new Set([stagesTable, scenesTable, outlinesTable]).size > 1) {
    throw new Error('服务端课程表不完整，无法导出');
  }

  const runtimeSessions = runtimeSessionsTable
    ? await pool.query(
        `SELECT id, stage_id, kind, status, created_at, updated_at, data
           FROM runtime_sessions
          WHERE learner_key = $1
          ORDER BY created_at, id`,
        [accountId],
      )
    : { rows: [] as Record<string, unknown>[] };
  const runtimeRecords = runtimeRecordsTable
    ? await pool.query(
        `SELECT records.id, records.session_id, records.seq, records.scene_id,
                records.created_at, records.data
           FROM runtime_records AS records
           JOIN runtime_sessions AS sessions ON sessions.id = records.session_id
          WHERE sessions.learner_key = $1
          ORDER BY records.session_id, records.seq`,
        [accountId],
      )
    : { rows: [] as Record<string, unknown>[] };
  const recordsBySession = new Map<string, Record<string, unknown>[]>();
  for (const row of runtimeRecords.rows as Record<string, unknown>[]) {
    const sessionId = String(row.session_id);
    const records = recordsBySession.get(sessionId) ?? [];
    records.push({
      id: String(row.id),
      seq: Number(row.seq),
      sceneId: row.scene_id === null ? null : String(row.scene_id),
      createdAt: String(row.created_at),
      data: row.data,
    });
    recordsBySession.set(sessionId, records);
  }

  const stages = stagesTable
    ? await pool.query(
        `SELECT id, name, description, interactive_mode, task_engine_mode,
                created_at, updated_at, data
           FROM document_stages
          WHERE owner_account_id = $1
          ORDER BY created_at, id`,
        [accountId],
      )
    : { rows: [] as Record<string, unknown>[] };
  const scenes = scenesTable
    ? await pool.query(
        `SELECT scenes.stage_id, scenes.id, scenes.scene_order, scenes.data
           FROM document_scenes AS scenes
           JOIN document_stages AS stages ON stages.id = scenes.stage_id
          WHERE stages.owner_account_id = $1
          ORDER BY scenes.stage_id, scenes.scene_order, scenes.id`,
        [accountId],
      )
    : { rows: [] as Record<string, unknown>[] };
  const outlines = outlinesTable
    ? await pool.query(
        `SELECT outlines.stage_id, outlines.data
           FROM document_outlines AS outlines
           JOIN document_stages AS stages ON stages.id = outlines.stage_id
          WHERE stages.owner_account_id = $1`,
        [accountId],
      )
    : { rows: [] as Record<string, unknown>[] };
  const scenesByStage = new Map<string, Record<string, unknown>[]>();
  for (const row of scenes.rows as Record<string, unknown>[]) {
    const stageId = String(row.stage_id);
    const entries = scenesByStage.get(stageId) ?? [];
    entries.push({ id: String(row.id), order: Number(row.scene_order), data: row.data });
    scenesByStage.set(stageId, entries);
  }
  const outlinesByStage = new Map(
    (outlines.rows as Record<string, unknown>[]).map((row) => [String(row.stage_id), row.data]),
  );

  return {
    configured: true,
    runtimeSessions: (runtimeSessions.rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      stageId: String(row.stage_id),
      kind: String(row.kind),
      status: String(row.status),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      data: row.data,
      records: recordsBySession.get(String(row.id)) ?? [],
    })),
    documents: (stages.rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: row.description === null ? null : String(row.description),
      interactiveMode: row.interactive_mode === null ? null : Boolean(row.interactive_mode),
      taskEngineMode: row.task_engine_mode === null ? null : Boolean(row.task_engine_mode),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      data: row.data,
      scenes: scenesByStage.get(String(row.id)) ?? [],
      outline: outlinesByStage.get(String(row.id)) ?? null,
    })),
  };
}

/** 当前账户可携出的完整服务端数据；永不导出密码哈希或会话 token。 */
export async function exportAccountData(account: Account) {
  let rawProfile: unknown;
  let sessions: Array<{ createdAt: string | null; expiresAt: string }>;
  if (!hasPostgres()) {
    const { fileBackend } = await import('./file-store');
    const stored = await fileBackend.accountData(account.id);
    if (!stored) throw new Error('账户不存在');
    rawProfile = stored.profile;
    sessions = stored.sessions.map((session) => ({ createdAt: null, ...session }));
  } else {
    const pool = await getPool();
    const [profileRow, sessionRows] = await Promise.all([
      pool.query('SELECT profile FROM accounts WHERE id = $1', [account.id]),
      pool.query(
        `SELECT created_at, expires_at
           FROM account_sessions
          WHERE account_id = $1 AND expires_at > now()
          ORDER BY created_at`,
        [account.id],
      ),
    ]);
    if (!profileRow.rowCount) throw new Error('账户不存在');
    rawProfile = profileRow.rows[0].profile ?? null;
    sessions = sessionRows.rows.map((row) => ({
      createdAt: new Date(String(row.created_at)).toISOString(),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    }));
  }

  const [orgStore, learningData] = await Promise.all([
    import('./org-store'),
    serverLearningData(account.id),
  ]);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    account,
    profile: toEnvelope(rawProfile),
    sessions,
    organization: await orgStore.accountOrganizationData(account.id),
    serverLearningData: learningData,
  };
}

export type DeleteAccountResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'owner_has_members'
        | 'owner_has_corpora'
        | 'ownership_unavailable'
        | 'storage_topology'
        | 'not_found';
      message: string;
    };

/** 删除账户、全部会话、账户课程与运行记录；机构 owner 有成员时拒绝。 */
export async function deleteAccount(accountId: string): Promise<DeleteAccountResult> {
  const accountUrl = connectionString();
  const learningUrl = process.env.DATABASE_URL;
  if (accountUrl && learningUrl && accountUrl !== learningUrl) {
    return {
      ok: false,
      code: 'storage_topology',
      message: '账户数据与学习数据位于不同数据库，平台无法保证原子删除，请联系维护人员',
    };
  }

  if (!hasPostgres()) {
    const { fileBackend } = await import('./file-store');
    const { deleteFileAccountOrganizationData } = await import('./org-store');
    return withAccountFilesLock(async () => {
      if (!(await fileBackend.accountById(accountId))) {
        return { ok: false as const, code: 'not_found' as const, message: '账户不存在' };
      }
      const orgResult = await deleteFileAccountOrganizationData(accountId);
      if (!orgResult.ok) return orgResult;
      return (await fileBackend.deleteAccount(accountId))
        ? { ok: true as const }
        : { ok: false as const, code: 'not_found' as const, message: '账户不存在' };
    });
  }

  // org-store 负责建机构表；实际删除放到下面同一个数据库事务，避免半删。
  const orgStore = await import('./org-store');
  await orgStore.orgForAccount(accountId);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [
      accountId,
    ]);
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'not_found', message: '账户不存在' };
    }

    const owned = await client.query(
      'SELECT id, name FROM orgs WHERE owner_account_id = $1 FOR UPDATE',
      [accountId],
    );
    for (const org of owned.rows) {
      const otherMember = await client.query(
        'SELECT account_id FROM org_members WHERE org_id = $1 AND account_id <> $2 LIMIT 1 FOR UPDATE',
        [org.id, accountId],
      );
      if (otherMember.rowCount) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          code: 'owner_has_members',
          message: `机构「${String(org.name)}」仍有成员，请先移出全部成员`,
        };
      }
    }
    if (owned.rowCount) {
      const ownedIds = new Set(owned.rows.map((org) => String(org.id)));
      let ownership: Map<string, string>;
      try {
        ownership = await orgStore.corpusOwnership();
      } catch {
        await client.query('ROLLBACK');
        return {
          ok: false,
          code: 'ownership_unavailable',
          message: '知识库归属服务暂不可用，平台无法确认私有库状态，账户未删除',
        };
      }
      const active = [...ownership].find(([, orgId]) => ownedIds.has(orgId));
      if (active) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          code: 'owner_has_corpora',
          message: `机构仍有私有知识库「${active[0]}」，请先释放知识库归属`,
        };
      }
    }
    for (const org of owned.rows) {
      await client.query('DELETE FROM orgs WHERE id = $1', [org.id]);
    }
    await client.query(
      'DELETE FROM org_assignments WHERE learner_account_id = $1 OR assigned_by = $1',
      [accountId],
    );
    await client.query('DELETE FROM org_invitations WHERE created_by = $1', [accountId]);
    await client.query('DELETE FROM org_members WHERE account_id = $1', [accountId]);
    const hasDocuments = await tableExists(client, 'document_stages');
    const hasRuntime = await tableExists(client, 'runtime_sessions');
    if (hasDocuments) {
      await client.query(
        `DELETE FROM org_assignments
          WHERE course_id IN (SELECT id FROM document_stages WHERE owner_account_id = $1)`,
        [accountId],
      );
      if (hasRuntime) {
        await client.query(
          `DELETE FROM runtime_sessions
            WHERE stage_id IN (SELECT id FROM document_stages WHERE owner_account_id = $1)`,
          [accountId],
        );
      }
      await client.query('DELETE FROM document_stages WHERE owner_account_id = $1', [accountId]);
    }
    if (hasRuntime) {
      await client.query('DELETE FROM runtime_sessions WHERE learner_key = $1', [accountId]);
    }
    const deleted = await client.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    if (!deleted.rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'not_found', message: '账户不存在' };
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
