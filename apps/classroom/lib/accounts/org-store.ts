/**
 * 机构（组织）存储——多管理员各带各的学员与知识库，互不越界。
 *
 * 表结构骨架抄 better-auth organization 插件（organization / member / invitation
 * 三表 + session 挂 active org），流程语义按我们的约束改造（选型论证见
 * docs/04-research/auth-org-wheel-20260829.md）：
 * - **邀请码代替邮箱邀请**：比赛合规不收集邮箱/手机号，邀请码多次使用、可轮换，
 *   学员兑码入组（幂等）。
 * - **corpus 归属是引擎 marker 单一真源**：私库在首份原料落盘前写 marker；
 *   org_corpora 仅保留为发布迁移入口，运行时发现未迁移或冲突就显式阻断。
 * - **learnerKey（account.id）一行不动**：课程/画像/学情分区键保持原样，
 *   机构只是账户上的一层归属关系。
 * - 单一归属（P0 口径）：一个账户同时最多属于一个机构（org_members.account_id 唯一）；
 *   管理者建库即 owner，学员兑码即 member。
 *
 * 与 store.ts 同款 pg/文件双后端：配了数据库走 pg，否则落 data/accounts/orgs.json
 * （单进程假设，与账户文件后备同边界）。
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';

import type { Account } from './store';
import { withAccountFilesLock } from './file-lock';
import { readCorpusOwnerMarkers } from '@/lib/server/knowledge-center';

export interface Org {
  id: string;
  name: string;
  ownerAccountId: string;
  createdAt: string;
}

export interface OrgMember {
  accountId: string;
  username: string;
  displayName: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

export interface OrgView {
  org: Org & { memberRole: 'owner' | 'member' };
  /** 当前有效邀请码（仅 owner 可见，接口层负责裁剪）。 */
  inviteCode: string | null;
  memberCount: number;
}

/** 邀请码形态：JZ- 前缀 + 8 位大写 base32 风格，口播/板书都不容易抄错。 */
function newInviteCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return `JZ-${code}`;
}

// ---------------------------------------------------------------- pg backend

let poolPromise: Promise<Pool> | null = null;

function connectionString(): string | undefined {
  return process.env.PERSISTENCE_DATABASE_URL || process.env.DATABASE_URL;
}

function hasPgBackend(): boolean {
  return !!connectionString();
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const pool = new Pool({ connectionString: connectionString(), max: 4 });
      try {
        await initializeOrgSchema(pool);
        return pool;
      } catch (error) {
        await pool.end();
        throw error;
      }
    })().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }
  return poolPromise;
}

async function initializeOrgSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
        CREATE TABLE IF NOT EXISTS orgs (
          id               TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          owner_account_id TEXT NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS org_members (
          account_id TEXT PRIMARY KEY,
          org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          role       TEXT NOT NULL DEFAULT 'member',
          joined_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS org_members_org ON org_members(org_id);
        CREATE TABLE IF NOT EXISTS org_invitations (
          code       TEXT PRIMARY KEY,
          org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          created_by TEXT NOT NULL,
          disabled   BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS org_invitations_org ON org_invitations(org_id);
        CREATE TABLE IF NOT EXISTS org_assignments (
          id                 TEXT PRIMARY KEY,
          org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          course_id          TEXT NOT NULL,
          title              TEXT NOT NULL,
          domain             TEXT,
          assigned_by        TEXT NOT NULL,
          learner_account_id TEXT,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE org_assignments ADD COLUMN IF NOT EXISTS learner_account_id TEXT;
        ALTER TABLE org_assignments ADD COLUMN IF NOT EXISTS domain TEXT;
        CREATE INDEX IF NOT EXISTS org_assignments_org ON org_assignments(org_id);
        CREATE INDEX IF NOT EXISTS org_assignments_org_learner
          ON org_assignments(org_id, learner_account_id);
        CREATE TABLE IF NOT EXISTS org_corpora (
          corpus     TEXT PRIMARY KEY,
          org_id     TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

    const accountsTable = await client.query("SELECT to_regclass('accounts') AS table_name");
    if (!accountsTable.rows[0]?.table_name) {
      throw new Error('机构关系完整性审计失败：accounts 表不存在；未修改现存数据');
    }

    const audit = await client.query(`
      SELECT relation, record_id
        FROM (
          SELECT 'orgs.owner_account_id' AS relation, o.id AS record_id
            FROM orgs o LEFT JOIN accounts a ON a.id = o.owner_account_id
           WHERE a.id IS NULL
          UNION ALL
          SELECT 'org_members.org_id', m.account_id
            FROM org_members m LEFT JOIN orgs o ON o.id = m.org_id
           WHERE o.id IS NULL
          UNION ALL
          SELECT 'org_members.account_id', m.account_id
            FROM org_members m LEFT JOIN accounts a ON a.id = m.account_id
           WHERE a.id IS NULL
          UNION ALL
          SELECT 'org_members.role', m.account_id
            FROM org_members m
           WHERE m.role NOT IN ('owner', 'member')
          UNION ALL
          SELECT 'org_members.account_role', m.account_id
            FROM org_members m JOIN accounts a ON a.id = m.account_id
           WHERE (m.role = 'owner' AND a.role <> 'manager')
              OR (m.role = 'member' AND a.role <> 'learner')
          UNION ALL
          SELECT 'org_invitations.org_id', i.code
            FROM org_invitations i LEFT JOIN orgs o ON o.id = i.org_id
           WHERE o.id IS NULL
          UNION ALL
          SELECT 'org_invitations.created_by', i.code
            FROM org_invitations i LEFT JOIN accounts a ON a.id = i.created_by
           WHERE a.id IS NULL
          UNION ALL
          SELECT 'org_invitations.owner_membership', i.code
            FROM org_invitations i
            LEFT JOIN org_members m
              ON m.org_id = i.org_id AND m.account_id = i.created_by AND m.role = 'owner'
           WHERE m.account_id IS NULL
          UNION ALL
          SELECT 'org_assignments.org_id', a.id
            FROM org_assignments a LEFT JOIN orgs o ON o.id = a.org_id
           WHERE o.id IS NULL
          UNION ALL
          SELECT 'org_assignments.assigned_by', a.id
            FROM org_assignments a LEFT JOIN accounts actor ON actor.id = a.assigned_by
           WHERE actor.id IS NULL
          UNION ALL
          SELECT 'org_assignments.owner_membership', a.id
            FROM org_assignments a
            LEFT JOIN org_members actor
              ON actor.org_id = a.org_id
             AND actor.account_id = a.assigned_by
             AND actor.role = 'owner'
           WHERE actor.account_id IS NULL
          UNION ALL
          SELECT 'org_assignments.learner_account_id', a.id
            FROM org_assignments a LEFT JOIN accounts learner ON learner.id = a.learner_account_id
           WHERE a.learner_account_id IS NOT NULL AND learner.id IS NULL
          UNION ALL
          SELECT 'org_assignments.learner_membership', a.id
            FROM org_assignments a
            LEFT JOIN org_members learner
              ON learner.org_id = a.org_id
             AND learner.account_id = a.learner_account_id
             AND learner.role = 'member'
           WHERE a.learner_account_id IS NOT NULL AND learner.account_id IS NULL
          UNION ALL
          SELECT 'org_corpora.org_id', c.corpus
            FROM org_corpora c LEFT JOIN orgs o ON o.id = c.org_id
           WHERE o.id IS NULL
          UNION ALL
          SELECT 'orgs.owner_membership', o.id
            FROM orgs o
            LEFT JOIN org_members m
              ON m.org_id = o.id AND m.account_id = o.owner_account_id AND m.role = 'owner'
           WHERE m.account_id IS NULL
          UNION ALL
          SELECT 'org_members.owner_role', m.account_id
            FROM org_members m JOIN orgs o ON o.id = m.org_id
           WHERE m.role = 'owner' AND o.owner_account_id <> m.account_id
          UNION ALL
          SELECT 'org_assignments.duplicate_target', min(a.id)
            FROM org_assignments a
           WHERE a.learner_account_id IS NOT NULL
           GROUP BY a.org_id, a.course_id, a.learner_account_id
          HAVING count(*) > 1
        ) failures
       LIMIT 1
    `);
    if (audit.rowCount) {
      const failure = audit.rows[0];
      throw new Error(
        `机构关系完整性审计失败：${String(failure.relation)} 存在无效记录 ${String(failure.record_id)}；未修改现存数据`,
      );
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_unique_target
        ON org_assignments(org_id, course_id, learner_account_id)
        WHERE learner_account_id IS NOT NULL;

      DO $$
      DECLARE corpus_fk_name text;
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
           WHERE c.contype = 'f'
             AND c.conrelid = 'org_members'::regclass
             AND c.confrelid = 'orgs'::regclass
             AND a.attname = 'org_id'
        ) THEN
          ALTER TABLE org_members ADD CONSTRAINT org_members_org_id_fk
            FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
           WHERE c.contype = 'f'
             AND c.conrelid = 'org_invitations'::regclass
             AND c.confrelid = 'orgs'::regclass
             AND a.attname = 'org_id'
        ) THEN
          ALTER TABLE org_invitations ADD CONSTRAINT org_invitations_org_id_fk
            FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint c
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
           WHERE c.contype = 'f'
             AND c.conrelid = 'org_assignments'::regclass
             AND c.confrelid = 'orgs'::regclass
             AND a.attname = 'org_id'
        ) THEN
          ALTER TABLE org_assignments ADD CONSTRAINT org_assignments_org_id_fk
            FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'orgs_owner_account_fk' AND conrelid = 'orgs'::regclass
        ) THEN
          ALTER TABLE orgs ADD CONSTRAINT orgs_owner_account_fk
            FOREIGN KEY (owner_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'org_members_account_fk' AND conrelid = 'org_members'::regclass
        ) THEN
          ALTER TABLE org_members ADD CONSTRAINT org_members_account_fk
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'org_invitations_created_by_fk'
             AND conrelid = 'org_invitations'::regclass
        ) THEN
          ALTER TABLE org_invitations ADD CONSTRAINT org_invitations_created_by_fk
            FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'org_assignments_assigned_by_fk'
             AND conrelid = 'org_assignments'::regclass
        ) THEN
          ALTER TABLE org_assignments ADD CONSTRAINT org_assignments_assigned_by_fk
            FOREIGN KEY (assigned_by) REFERENCES accounts(id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'org_assignments_learner_fk'
             AND conrelid = 'org_assignments'::regclass
        ) THEN
          ALTER TABLE org_assignments ADD CONSTRAINT org_assignments_learner_fk
            FOREIGN KEY (learner_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'org_corpora_org_id_fk'
             AND conrelid = 'org_corpora'::regclass
             AND confrelid = 'orgs'::regclass
             AND confdeltype = 'r'
        ) THEN
          FOR corpus_fk_name IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = 'org_corpora'::regclass
               AND confrelid = 'orgs'::regclass
               AND contype = 'f'
          LOOP
            EXECUTE format('ALTER TABLE org_corpora DROP CONSTRAINT %I', corpus_fk_name);
          END LOOP;
          ALTER TABLE org_corpora ADD CONSTRAINT org_corpora_org_id_fk
            FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------- file backend

interface FileOrgDb {
  orgs: Array<{ id: string; name: string; ownerAccountId: string; createdAt: string }>;
  assignments: Array<{
    id: string;
    orgId: string;
    courseId: string;
    title: string;
    /** 缺失/null 是迁移前记录；新增指派必须有领域。 */
    domain?: string | null;
    assignedBy: string;
    /** 缺失/null 都是旧版的机构全体指派。 */
    learnerAccountId?: string | null;
    createdAt: string;
  }>;
  members: Array<{ accountId: string; orgId: string; role: 'owner' | 'member'; joinedAt: string }>;
  invitations: Array<{
    code: string;
    orgId: string;
    createdBy: string;
    disabled: boolean;
    createdAt: string;
  }>;
  corpora: Array<{ corpus: string; orgId: string; updatedAt: string }>;
}

function fileDbPath(): string {
  const dir = process.env.ACCOUNTS_DIR || path.join(process.cwd(), 'data', 'accounts');
  return path.join(dir, 'orgs.json');
}

async function loadFile(): Promise<FileOrgDb> {
  let serialized: string;
  try {
    serialized = await fs.readFile(fileDbPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { orgs: [], members: [], invitations: [], corpora: [], assignments: [] };
    }
    throw error;
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('机构账户数据格式损坏');
  const raw = parsed as Partial<Record<keyof FileOrgDb, unknown>>;
  if (
    !Array.isArray(raw.orgs) ||
    !Array.isArray(raw.assignments) ||
    !Array.isArray(raw.members) ||
    !Array.isArray(raw.invitations) ||
    !Array.isArray(raw.corpora)
  ) {
    throw new Error('机构账户数据格式损坏');
  }
  return raw as unknown as FileOrgDb;
}

async function saveFile(db: FileOrgDb): Promise<void> {
  const file = fileDbPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 1), 'utf-8');
  await fs.rename(tmp, file);
}

// ------------------------------------------------------------------- 业务面

/** 管理者建机构：一人一构（已是 owner 就报错），建成即生成首个邀请码。 */
export async function createOrg(
  owner: Account,
  name: string,
): Promise<{ ok: true; view: OrgView } | { ok: false; message: string }> {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 40) {
    return { ok: false, message: '机构名需为 2-40 个字符' };
  }
  const id = `org_${randomBytes(8).toString('hex')}`;
  const code = newInviteCode();
  if (hasPgBackend()) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        "SELECT id FROM accounts WHERE id = $1 AND role = 'manager' FOR UPDATE",
        [owner.id],
      );
      if (!account.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false, message: '管理者账户已不存在或身份不符' };
      }
      const existing = await client.query('SELECT org_id FROM org_members WHERE account_id = $1', [
        owner.id,
      ]);
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false, message: '该账号已在机构中，不能重复创建' };
      }
      await client.query('INSERT INTO orgs (id, name, owner_account_id) VALUES ($1, $2, $3)', [
        id,
        trimmed,
        owner.id,
      ]);
      await client.query(
        "INSERT INTO org_members (account_id, org_id, role) VALUES ($1, $2, 'owner')",
        [owner.id, id],
      );
      await client.query(
        'INSERT INTO org_invitations (code, org_id, created_by) VALUES ($1, $2, $3)',
        [code, id, owner.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    const created = await withAccountFilesLock(async () => {
      const { fileBackend } = await import('./file-store');
      const actualOwner = await fileBackend.accountById(owner.id);
      if (!actualOwner || actualOwner.role !== 'manager') {
        return { ok: false as const, message: '管理者账户已不存在或身份不符' };
      }
      const db = await loadFile();
      if (db.orgs.some((org) => org.ownerAccountId === owner.id)) {
        return { ok: false as const, message: '该账号的机构关系不完整，已停止写入' };
      }
      if (db.members.some((member) => member.accountId === owner.id)) {
        return { ok: false as const, message: '该账号已在机构中，不能重复创建' };
      }
      const now = new Date().toISOString();
      db.orgs.push({ id, name: trimmed, ownerAccountId: owner.id, createdAt: now });
      db.members.push({ accountId: owner.id, orgId: id, role: 'owner', joinedAt: now });
      db.invitations.push({
        code,
        orgId: id,
        createdBy: owner.id,
        disabled: false,
        createdAt: now,
      });
      await saveFile(db);
      return { ok: true as const };
    });
    if (!created.ok) return created;
  }
  const view = await orgViewFor(owner.id);
  return view ? { ok: true, view } : { ok: false, message: '创建后读取失败' };
}

/** 账户当前所属机构（owner 或 member），无归属返回 null。 */
export async function orgForAccount(
  accountId: string,
): Promise<(Org & { memberRole: 'owner' | 'member' }) | null> {
  if (hasPgBackend()) {
    const pool = await getPool();
    const row = await pool.query(
      `SELECT o.id, o.name, o.owner_account_id, o.created_at, m.role
         FROM org_members m JOIN orgs o ON o.id = m.org_id
        WHERE m.account_id = $1`,
      [accountId],
    );
    if (!row.rowCount) return null;
    const r = row.rows[0];
    return {
      id: String(r.id),
      name: String(r.name),
      ownerAccountId: String(r.owner_account_id),
      createdAt: new Date(String(r.created_at)).toISOString(),
      memberRole: r.role === 'owner' ? 'owner' : 'member',
    };
  }
  const db = await loadFile();
  const m = db.members.find((x) => x.accountId === accountId);
  if (!m) return null;
  const o = db.orgs.find((x) => x.id === m.orgId);
  if (!o) return null;
  return { ...o, memberRole: m.role };
}

/** owner 视角的机构总览（含当前邀请码）。 */
export async function orgViewFor(accountId: string): Promise<OrgView | null> {
  const org = await orgForAccount(accountId);
  if (!org) return null;
  if (hasPgBackend()) {
    const pool = await getPool();
    const [codeRow, countRow] = await Promise.all([
      pool.query(
        'SELECT code FROM org_invitations WHERE org_id = $1 AND NOT disabled ORDER BY created_at DESC LIMIT 1',
        [org.id],
      ),
      pool.query('SELECT count(*)::int AS n FROM org_members WHERE org_id = $1', [org.id]),
    ]);
    return {
      org,
      inviteCode:
        org.memberRole === 'owner' && codeRow.rowCount ? String(codeRow.rows[0].code) : null,
      memberCount: Number(countRow.rows[0].n),
    };
  }
  const db = await loadFile();
  const invite = db.invitations
    .filter((i) => i.orgId === org.id && !i.disabled)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    org,
    inviteCode: org.memberRole === 'owner' && invite ? invite.code : null,
    memberCount: db.members.filter((m) => m.orgId === org.id).length,
  };
}

/** 轮换邀请码：旧码全部作废，新码即时生效（owner 专用，接口层校验）。 */
export async function rotateInviteCode(orgId: string, byAccountId: string): Promise<string> {
  const code = newInviteCode();
  if (hasPgBackend()) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        `SELECT o.id
           FROM orgs o
           JOIN org_members m
             ON m.org_id = o.id AND m.account_id = $2 AND m.role = 'owner'
           JOIN accounts a ON a.id = m.account_id
          WHERE o.id = $1 AND o.owner_account_id = $2
          FOR UPDATE OF o, a`,
        [orgId, byAccountId],
      );
      if (!owner.rowCount) throw new Error('只有当前机构所有者可以轮换邀请码');
      await client.query('UPDATE org_invitations SET disabled = true WHERE org_id = $1', [orgId]);
      await client.query(
        'INSERT INTO org_invitations (code, org_id, created_by) VALUES ($1, $2, $3)',
        [code, orgId, byAccountId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return code;
  }
  await withAccountFilesLock(async () => {
    const { fileBackend } = await import('./file-store');
    const actor = await fileBackend.accountById(byAccountId);
    const db = await loadFile();
    const org = db.orgs.find((item) => item.id === orgId);
    const membership = db.members.find(
      (member) =>
        member.orgId === orgId && member.accountId === byAccountId && member.role === 'owner',
    );
    if (!actor || !org || org.ownerAccountId !== byAccountId || !membership) {
      throw new Error('只有当前机构所有者可以轮换邀请码');
    }
    for (const i of db.invitations) if (i.orgId === orgId) i.disabled = true;
    db.invitations.push({
      code,
      orgId,
      createdBy: byAccountId,
      disabled: false,
      createdAt: new Date().toISOString(),
    });
    await saveFile(db);
  });
  return code;
}

/** 学员兑码入组。幂等：已在同一机构直接成功；在别的机构则报错（先退出）。 */
export async function joinByCode(
  account: Account,
  code: string,
): Promise<{ ok: true; org: Org } | { ok: false; message: string }> {
  const normalized = code.trim().toUpperCase();
  if (hasPgBackend()) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = await client.query(
        `SELECT org_id
           FROM org_invitations
          WHERE upper(code) = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [normalized],
      );
      const candidateOrgId = candidate.rows[0]?.org_id ? String(candidate.rows[0].org_id) : null;
      if (!candidateOrgId) {
        await client.query('ROLLBACK');
        return { ok: false, message: '邀请码无效或已失效' };
      }

      const target = await client.query(
        `SELECT id, name, owner_account_id, created_at
           FROM orgs
          WHERE id = $1
          FOR UPDATE`,
        [candidateOrgId],
      );
      const invitation = await client.query(
        `SELECT org_id
           FROM org_invitations
          WHERE upper(code) = $1 AND org_id = $2 AND NOT disabled
          FOR UPDATE`,
        [normalized, candidateOrgId],
      );
      if (!target.rowCount || !invitation.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false, message: '邀请码无效或已失效' };
      }

      const actualAccount = await client.query(
        'SELECT role FROM accounts WHERE id = $1 FOR UPDATE',
        [account.id],
      );
      if (!actualAccount.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false, message: '账户已不存在，请重新登录' };
      }
      if (actualAccount.rows[0].role !== 'learner') {
        await client.query('ROLLBACK');
        return { ok: false, message: '只有学习者账户可以加入机构' };
      }

      const inserted = await client.query(
        `INSERT INTO org_members (account_id, org_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (account_id) DO NOTHING
         RETURNING org_id`,
        [account.id, candidateOrgId],
      );
      if (!inserted.rowCount) {
        const current = await client.query(
          `SELECT m.org_id, o.name
             FROM org_members m
             LEFT JOIN orgs o ON o.id = m.org_id
            WHERE m.account_id = $1`,
          [account.id],
        );
        const currentOrgId = current.rows[0]?.org_id ? String(current.rows[0].org_id) : null;
        if (currentOrgId !== candidateOrgId) {
          await client.query('ROLLBACK');
          return {
            ok: false,
            message: current.rows[0]?.name
              ? `该账号已在机构「${String(current.rows[0].name)}」中，不能加入其他机构`
              : '机构关系已变化，请刷新后重试',
          };
        }
      }

      const org = {
        id: String(target.rows[0].id),
        name: String(target.rows[0].name),
        ownerAccountId: String(target.rows[0].owner_account_id),
        createdAt: new Date(String(target.rows[0].created_at)).toISOString(),
      };
      await client.query('COMMIT');
      return { ok: true, org };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return withAccountFilesLock(async () => {
    const { fileBackend } = await import('./file-store');
    const actualAccount = await fileBackend.accountById(account.id);
    if (!actualAccount) {
      return { ok: false as const, message: '账户已不存在，请重新登录' };
    }
    if (actualAccount.role !== 'learner') {
      return { ok: false as const, message: '只有学习者账户可以加入机构' };
    }
    const db = await loadFile();
    const invite = db.invitations.find(
      (item) => item.code.toUpperCase() === normalized && !item.disabled,
    );
    if (!invite) return { ok: false as const, message: '邀请码无效或已失效' };
    const org = db.orgs.find((item) => item.id === invite.orgId);
    if (!org) {
      return { ok: false as const, message: '邀请码指向的机构不存在，已停止写入' };
    }
    const current = db.members.find((member) => member.accountId === account.id);
    if (current && current.orgId !== invite.orgId) {
      const currentOrg = db.orgs.find((org) => org.id === current.orgId);
      return {
        ok: false as const,
        message: currentOrg
          ? `该账号已在机构「${currentOrg.name}」中，不能加入其他机构`
          : '机构关系数据不完整，已停止写入',
      };
    }
    if (!current) {
      db.members.push({
        accountId: account.id,
        orgId: invite.orgId,
        role: 'member',
        joinedAt: new Date().toISOString(),
      });
      await saveFile(db);
    }
    return { ok: true as const, org };
  });
}

/** 成员名册（owner 专用）。用户名/昵称 join 自 accounts。 */
export async function membersOf(orgId: string): Promise<OrgMember[]> {
  if (hasPgBackend()) {
    const pool = await getPool();
    const rows = await pool.query(
      `SELECT m.account_id, m.role, m.joined_at, a.username, a.display_name
         FROM org_members m JOIN accounts a ON a.id = m.account_id
        WHERE m.org_id = $1 ORDER BY m.role DESC, m.joined_at ASC`,
      [orgId],
    );
    return rows.rows.map((r) => ({
      accountId: String(r.account_id),
      username: String(r.username),
      displayName: String(r.display_name),
      role: r.role === 'owner' ? 'owner' : 'member',
      joinedAt: new Date(String(r.joined_at)).toISOString(),
    }));
  }
  const db = await loadFile();
  const members = db.members.filter((m) => m.orgId === orgId);
  const out: OrgMember[] = [];
  for (const m of members) {
    // 文件后备没有按 id 查的接口面；直接读文件账户表
    const acct = await fileAccountById(m.accountId);
    out.push({
      accountId: m.accountId,
      username: acct?.username ?? m.accountId,
      displayName: acct?.displayName ?? m.accountId,
      role: m.role,
      joinedAt: m.joinedAt,
    });
  }
  return out.sort((a, b) =>
    a.role === b.role ? a.joinedAt.localeCompare(b.joinedAt) : a.role === 'owner' ? -1 : 1,
  );
}

async function fileAccountById(
  id: string,
): Promise<{ username: string; displayName: string } | null> {
  const { fileBackend } = await import('./file-store');
  const account = await fileBackend.accountById(id);
  return account ? { username: account.username, displayName: account.displayName } : null;
}

/** 移出成员并清理其定向课程（owner 专用；历史全体指派保留）。 */
export async function removeMember(
  orgId: string,
  accountId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (hasPgBackend()) {
    const pool = await getPool();
    const res = await pool.query(
      `WITH removed_member AS (
         DELETE FROM org_members
          WHERE org_id = $1 AND account_id = $2 AND role <> 'owner'
         RETURNING account_id
       ), removed_assignments AS (
         DELETE FROM org_assignments
          WHERE org_id = $1
            AND learner_account_id IN (SELECT account_id FROM removed_member)
       )
       SELECT count(*)::int AS removed_count FROM removed_member`,
      [orgId, accountId],
    );
    return Number(res.rows[0]?.removed_count ?? 0) > 0
      ? { ok: true }
      : { ok: false, message: '成员不存在或为机构所有者' };
  }
  return withAccountFilesLock(async () => {
    const db = await loadFile();
    const before = db.members.length;
    db.members = db.members.filter(
      (m) => !(m.orgId === orgId && m.accountId === accountId && m.role !== 'owner'),
    );
    if (db.members.length === before)
      return { ok: false as const, message: '成员不存在或为机构所有者' };
    db.assignments = db.assignments.filter(
      (assignment) => !(assignment.orgId === orgId && assignment.learnerAccountId === accountId),
    );
    await saveFile(db);
    return { ok: true as const };
  });
}

export interface AccountOrganizationData {
  organization: {
    id: string;
    name: string;
    role: 'owner' | 'member';
    createdAt: string;
  } | null;
  assignmentsReceived: Array<{
    id: string;
    courseId: string;
    title: string;
    createdAt: string;
  }>;
}

/** 只导出当前账户自身的机构关系与收到的指派，不带其他成员名册或邀请码。 */
export async function accountOrganizationData(accountId: string): Promise<AccountOrganizationData> {
  const org = await orgForAccount(accountId);
  if (!org) return { organization: null, assignmentsReceived: [] };
  const assignments = await assignmentsOf(org.id, accountId);
  return {
    organization: {
      id: org.id,
      name: org.name,
      role: org.memberRole,
      createdAt: org.createdAt,
    },
    assignmentsReceived: assignments.map((assignment) => ({
      id: assignment.id,
      courseId: assignment.courseId,
      title: assignment.title,
      createdAt: assignment.createdAt,
    })),
  };
}

/** 文件后备删户：owner 有成员时拒绝；owner 独自一人时删除整机构。 */
export async function deleteFileAccountOrganizationData(accountId: string): Promise<
  | { ok: true }
  | {
      ok: false;
      code: 'owner_has_members' | 'owner_has_corpora' | 'ownership_unavailable';
      message: string;
    }
> {
  if (hasPgBackend()) {
    throw new Error('文件账户删除不能在 PostgreSQL 后端执行');
  }

  return withAccountFilesLock(async () => {
    const db = await loadFile();
    const owned = db.orgs.filter((org) => org.ownerAccountId === accountId);
    for (const org of owned) {
      if (db.members.some((member) => member.orgId === org.id && member.accountId !== accountId)) {
        return {
          ok: false as const,
          code: 'owner_has_members' as const,
          message: `机构「${org.name}」仍有成员，请先移出全部成员`,
        };
      }
    }

    const ownedIds = new Set(owned.map((org) => org.id));
    if (ownedIds.size > 0) {
      let ownership: Map<string, string>;
      try {
        ownership = await corpusOwnership();
      } catch {
        return {
          ok: false as const,
          code: 'ownership_unavailable' as const,
          message: '知识库归属服务暂不可用，平台无法确认私有库状态，账户未删除',
        };
      }
      const active = [...ownership].find(([, orgId]) => ownedIds.has(orgId));
      if (active) {
        return {
          ok: false as const,
          code: 'owner_has_corpora' as const,
          message: `机构仍有私有知识库「${active[0]}」，请先释放知识库归属`,
        };
      }
    }
    const changed =
      ownedIds.size > 0 ||
      db.members.some((member) => member.accountId === accountId) ||
      db.assignments.some(
        (assignment) =>
          assignment.learnerAccountId === accountId || assignment.assignedBy === accountId,
      ) ||
      db.invitations.some((invitation) => invitation.createdBy === accountId);
    if (!changed) return { ok: true as const };

    db.orgs = db.orgs.filter((org) => !ownedIds.has(org.id));
    db.members = db.members.filter(
      (member) => !ownedIds.has(member.orgId) && member.accountId !== accountId,
    );
    db.assignments = db.assignments.filter(
      (assignment) =>
        !ownedIds.has(assignment.orgId) &&
        assignment.learnerAccountId !== accountId &&
        assignment.assignedBy !== accountId,
    );
    db.invitations = db.invitations.filter(
      (invitation) => !ownedIds.has(invitation.orgId) && invitation.createdBy !== accountId,
    );
    await saveFile(db);
    return { ok: true as const };
  });
}

// ------------------------------------------------------- 知识库归属与可见性

/** 全部归属关系：corpus → orgId。引擎 marker 是唯一运行真源。 */
export async function corpusOwnership(): Promise<Map<string, string>> {
  const markers = await readCorpusOwnerMarkers();
  let legacy: Map<string, string>;
  if (hasPgBackend()) {
    const pool = await getPool();
    const rows = await pool.query('SELECT corpus, org_id FROM org_corpora');
    legacy = new Map(rows.rows.map((r) => [String(r.corpus), String(r.org_id)] as const));
  } else {
    const db = await loadFile();
    legacy = new Map(db.corpora.map((c) => [c.corpus, c.orgId] as const));
  }
  for (const [corpus, legacyOwner] of legacy) {
    const markerOwner = markers.get(corpus);
    if (!markerOwner) {
      throw new Error(`知识库归属迁移未完成：${corpus} 缺少引擎 marker`);
    }
    if (markerOwner !== legacyOwner) {
      throw new Error(`知识库归属冲突：${corpus} 的引擎 marker 与旧表不一致`);
    }
  }
  return markers;
}

/** 清理已由引擎释放的旧表行；新归属只能由入库链建立。 */
export async function setCorpusOrg(
  corpus: string,
  orgId: string | null,
  actorOrgId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (orgId !== null) return { ok: false, message: '知识库归属只由成功的入库任务建立' };
  if (hasPgBackend()) {
    const pool = await getPool();
    await pool.query('DELETE FROM org_corpora WHERE corpus = $1 AND org_id = $2', [
      corpus,
      actorOrgId,
    ]);
    return { ok: true };
  }
  return withAccountFilesLock(async () => {
    const db = await loadFile();
    if (!db.orgs.some((org) => org.id === actorOrgId)) {
      return { ok: false as const, message: '机构关系已失效，不能修改知识库归属' };
    }
    db.corpora = db.corpora.filter(
      (entry) => !(entry.corpus === corpus && entry.orgId === actorOrgId),
    );
    await saveFile(db);
    return { ok: true as const };
  });
}

/**
 * 账户可见的知识库过滤器：公共库（无归属行）人人可见；有归属的只有本机构成员可见。
 * 未登录/无机构 = 只见公共库。返回判定函数，调用方拿它过滤任何 corpus 列表。
 */
export async function corpusVisibilityFor(
  accountId: string | null,
): Promise<(corpus: string) => boolean> {
  const ownership = await corpusOwnership();
  if (ownership.size === 0) return () => true;
  const org = accountId ? await orgForAccount(accountId) : null;
  return (corpus: string) => {
    const owner = ownership.get(corpus);
    return !owner || (org !== null && owner === org.id);
  };
}

// ----------------------------------------------------------------- 课程指派

export interface OrgAssignment {
  id: string;
  courseId: string;
  title: string;
  domain: string | null;
  assignedBy: string;
  /** 迁移前的 null 行只作历史归档，不进入任何清单。 */
  learnerAccountId: string | null;
  learnerDisplayName: string | null;
  createdAt: string;
}

/**
 * 机构指派清单：不传 learnerAccountId 时供 owner 查看全部；传入时只返回
 * 该学员的定向指派。旧 learner_account_id=NULL 行原样保留，但查询层统一归档。
 */
export async function assignmentsOf(
  orgId: string,
  learnerAccountId?: string,
): Promise<OrgAssignment[]> {
  if (hasPgBackend()) {
    const pool = await getPool();
    const rows =
      learnerAccountId === undefined
        ? await pool.query(
            `SELECT oa.id, oa.course_id, oa.title, oa.domain, oa.assigned_by, oa.learner_account_id,
                  COALESCE(a.display_name, oa.learner_account_id) AS learner_display_name,
                  oa.created_at
             FROM org_assignments oa
            LEFT JOIN accounts a ON a.id = oa.learner_account_id
            WHERE oa.org_id = $1
              AND oa.learner_account_id IS NOT NULL
            ORDER BY oa.created_at DESC`,
            [orgId],
          )
        : await pool.query(
            `SELECT oa.id, oa.course_id, oa.title, oa.domain, oa.assigned_by, oa.learner_account_id,
                  COALESCE(a.display_name, oa.learner_account_id) AS learner_display_name,
                  oa.created_at
             FROM org_assignments oa
            LEFT JOIN accounts a ON a.id = oa.learner_account_id
            WHERE oa.org_id = $1
              AND oa.learner_account_id = $2
            ORDER BY oa.created_at DESC`,
            [orgId, learnerAccountId],
          );
    return rows.rows.map((r) => ({
      id: String(r.id),
      courseId: String(r.course_id),
      title: String(r.title),
      domain: r.domain === null || r.domain === undefined ? null : String(r.domain),
      assignedBy: String(r.assigned_by),
      learnerAccountId: r.learner_account_id === null ? null : String(r.learner_account_id),
      learnerDisplayName: r.learner_display_name === null ? null : String(r.learner_display_name),
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
  }
  const db = await loadFile();
  const assignments = db.assignments
    .filter(
      (a) =>
        a.orgId === orgId &&
        a.learnerAccountId != null &&
        (learnerAccountId === undefined || a.learnerAccountId === learnerAccountId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return Promise.all(
    assignments.map(async (a) => {
      const targetId = a.learnerAccountId ?? null;
      const target = targetId ? await fileAccountById(targetId) : null;
      return {
        id: a.id,
        courseId: a.courseId,
        title: a.title,
        domain: a.domain ?? null,
        assignedBy: a.assignedBy,
        learnerAccountId: targetId,
        learnerDisplayName: targetId ? (target?.displayName ?? targetId) : null,
        createdAt: a.createdAt,
      };
    }),
  );
}

/** 指派一门课给本机构的一名学员；同一目标已有同课时幂等。 */
export async function addAssignment(
  orgId: string,
  courseId: string,
  title: string,
  byAccountId: string,
  learnerAccountId: string,
  domain: string,
): Promise<{ ok: true; assignment: OrgAssignment } | { ok: false; message: string }> {
  const cleanCourse = courseId.trim();
  const cleanTitle = title.trim();
  const cleanLearner = learnerAccountId.trim();
  const cleanDomain = domain.trim();
  if (!cleanCourse || !cleanTitle) return { ok: false, message: '课程与标题不能为空' };
  if (!cleanLearner) return { ok: false, message: '请选择本机构学员' };
  if (!cleanDomain) return { ok: false, message: '课程领域不能为空' };
  const id = `asg_${randomBytes(6).toString('hex')}`;
  if (hasPgBackend()) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const relation = await client.query(
        `SELECT actor_member.account_id AS actor_id, target_member.account_id AS target_id
           FROM org_members actor_member
           JOIN accounts actor_account ON actor_account.id = actor_member.account_id
           JOIN org_members target_member ON target_member.org_id = actor_member.org_id
           JOIN accounts target_account ON target_account.id = target_member.account_id
          WHERE actor_member.org_id = $1
            AND actor_member.account_id = $2
            AND actor_member.role = 'owner'
            AND actor_account.role = 'manager'
            AND target_member.account_id = $3
            AND target_member.role = 'member'
            AND target_account.role = 'learner'
          FOR UPDATE OF actor_member, actor_account, target_member, target_account`,
        [orgId, byAccountId, cleanLearner],
      );
      if (!relation.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false, message: '指派者或目标账户的机构关系已失效' };
      }
      const existing = await client.query(
        `SELECT domain
           FROM org_assignments
          WHERE org_id = $1 AND learner_account_id = $2
          FOR UPDATE`,
        [orgId, cleanLearner],
      );
      if (existing.rows.some((row) => !String(row.domain ?? '').trim())) {
        await client.query('ROLLBACK');
        return { ok: false, message: '该学员现有指派缺少领域，请先撤回后重新指派' };
      }
      if (existing.rows.some((row) => String(row.domain).trim() !== cleanDomain)) {
        await client.query('ROLLBACK');
        return { ok: false, message: '该学员已有其他领域课程指派，请先撤回旧领域课程后再指派' };
      }
      const rows = await client.query(
        `WITH upserted AS (
           INSERT INTO org_assignments
             (id, org_id, course_id, title, domain, assigned_by, learner_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, course_id, learner_account_id)
             WHERE learner_account_id IS NOT NULL
           DO UPDATE SET id = org_assignments.id
           RETURNING id, course_id, title, domain, assigned_by, learner_account_id, created_at
         )
         SELECT upserted.*,
                COALESCE(accounts.display_name, upserted.learner_account_id) AS learner_display_name
           FROM upserted
           LEFT JOIN accounts ON accounts.id = upserted.learner_account_id`,
        [id, orgId, cleanCourse, cleanTitle, cleanDomain, byAccountId, cleanLearner],
      );
      await client.query('COMMIT');
      const row = rows.rows[0];
      return {
        ok: true,
        assignment: {
          id: String(row.id),
          courseId: String(row.course_id),
          title: String(row.title),
          domain: String(row.domain),
          assignedBy: String(row.assigned_by),
          learnerAccountId: String(row.learner_account_id),
          learnerDisplayName: String(row.learner_display_name),
          createdAt: new Date(String(row.created_at)).toISOString(),
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return withAccountFilesLock(async () => {
    const { fileBackend } = await import('./file-store');
    const [actor, target] = await Promise.all([
      fileBackend.accountById(byAccountId),
      fileBackend.accountById(cleanLearner),
    ]);
    const db = await loadFile();
    if (
      !actor ||
      !target ||
      actor.role !== 'manager' ||
      target.role !== 'learner' ||
      !db.members.some(
        (member) =>
          member.orgId === orgId && member.accountId === byAccountId && member.role === 'owner',
      ) ||
      !db.members.some(
        (member) =>
          member.orgId === orgId && member.accountId === cleanLearner && member.role === 'member',
      )
    ) {
      return { ok: false as const, message: '指派者或目标账户的机构关系已失效' };
    }
    const existing = db.assignments.filter(
      (entry) => entry.orgId === orgId && entry.learnerAccountId === cleanLearner,
    );
    if (existing.some((entry) => !entry.domain?.trim())) {
      return { ok: false as const, message: '该学员现有指派缺少领域，请先撤回后重新指派' };
    }
    if (existing.some((entry) => entry.domain?.trim() !== cleanDomain)) {
      return {
        ok: false as const,
        message: '该学员已有其他领域课程指派，请先撤回旧领域课程后再指派',
      };
    }
    let assignment = db.assignments.find(
      (entry) =>
        entry.orgId === orgId &&
        entry.courseId === cleanCourse &&
        entry.learnerAccountId === cleanLearner,
    );
    if (!assignment) {
      assignment = {
        id,
        orgId,
        courseId: cleanCourse,
        title: cleanTitle,
        domain: cleanDomain,
        assignedBy: byAccountId,
        learnerAccountId: cleanLearner,
        createdAt: new Date().toISOString(),
      };
      db.assignments.push(assignment);
      await saveFile(db);
    }
    return {
      ok: true as const,
      assignment: {
        id: assignment.id,
        courseId: assignment.courseId,
        title: assignment.title,
        domain: assignment.domain ?? null,
        assignedBy: assignment.assignedBy,
        learnerAccountId: cleanLearner,
        learnerDisplayName: target.displayName,
        createdAt: assignment.createdAt,
      },
    };
  });
}

/** 撤回指派（owner 专用）。 */
export async function removeAssignment(orgId: string, assignmentId: string): Promise<boolean> {
  if (hasPgBackend()) {
    const pool = await getPool();
    const res = await pool.query('DELETE FROM org_assignments WHERE org_id = $1 AND id = $2', [
      orgId,
      assignmentId,
    ]);
    return !!res.rowCount;
  }
  return withAccountFilesLock(async () => {
    const db = await loadFile();
    const before = db.assignments.length;
    db.assignments = db.assignments.filter((a) => !(a.orgId === orgId && a.id === assignmentId));
    if (db.assignments.length === before) return false;
    await saveFile(db);
    return true;
  });
}
