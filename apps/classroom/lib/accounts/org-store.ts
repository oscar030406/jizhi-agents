/**
 * 机构（组织）存储——多管理员各带各的学员与知识库，互不越界。
 *
 * 表结构骨架抄 better-auth organization 插件（organization / member / invitation
 * 三表 + session 挂 active org），流程语义按我们的约束改造（选型论证见
 * docs/04-research/auth-org-wheel-20260829.md）：
 * - **邀请码代替邮箱邀请**：比赛合规不收集邮箱/手机号，邀请码多次使用、可轮换，
 *   学员兑码入组（幂等）。
 * - **corpus 归属表存目录名字符串**：知识库在磁盘上是目录（knowledge-center readdir
 *   枚举），pg 里没有实体表；org_corpora 无归属行 = 公共库，存量三库零迁移。
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

function usePg(): boolean {
  return !!connectionString();
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const pool = new Pool({ connectionString: connectionString(), max: 4 });
      await pool.query(`
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
        CREATE TABLE IF NOT EXISTS org_corpora (
          corpus     TEXT PRIMARY KEY,
          org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      return pool;
    })().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }
  return poolPromise;
}

// -------------------------------------------------------------- file backend

interface FileOrgDb {
  orgs: Array<{ id: string; name: string; ownerAccountId: string; createdAt: string }>;
  members: Array<{ accountId: string; orgId: string; role: 'owner' | 'member'; joinedAt: string }>;
  invitations: Array<{ code: string; orgId: string; createdBy: string; disabled: boolean; createdAt: string }>;
  corpora: Array<{ corpus: string; orgId: string; updatedAt: string }>;
}

function fileDbPath(): string {
  const dir = process.env.ACCOUNTS_DIR || path.join(process.cwd(), 'data', 'accounts');
  return path.join(dir, 'orgs.json');
}

let fileQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = fileQueue.then(op, op);
  fileQueue = next.catch(() => undefined);
  return next;
}

async function loadFile(): Promise<FileOrgDb> {
  try {
    const raw = JSON.parse(await fs.readFile(fileDbPath(), 'utf-8')) as Partial<FileOrgDb>;
    return {
      orgs: Array.isArray(raw.orgs) ? raw.orgs : [],
      members: Array.isArray(raw.members) ? raw.members : [],
      invitations: Array.isArray(raw.invitations) ? raw.invitations : [],
      corpora: Array.isArray(raw.corpora) ? raw.corpora : [],
    };
  } catch {
    return { orgs: [], members: [], invitations: [], corpora: [] };
  }
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
  const existing = await orgForAccount(owner.id);
  if (existing) return { ok: false, message: '该账号已在机构中，先退出或移交后再创建' };

  const id = `org_${randomBytes(8).toString('hex')}`;
  const code = newInviteCode();
  if (usePg()) {
    const pool = await getPool();
    await pool.query('BEGIN');
    try {
      await pool.query('INSERT INTO orgs (id, name, owner_account_id) VALUES ($1, $2, $3)', [
        id, trimmed, owner.id,
      ]);
      await pool.query(
        "INSERT INTO org_members (account_id, org_id, role) VALUES ($1, $2, 'owner')",
        [owner.id, id],
      );
      await pool.query(
        'INSERT INTO org_invitations (code, org_id, created_by) VALUES ($1, $2, $3)',
        [code, id, owner.id],
      );
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } else {
    await enqueue(async () => {
      const db = await loadFile();
      const now = new Date().toISOString();
      db.orgs.push({ id, name: trimmed, ownerAccountId: owner.id, createdAt: now });
      db.members.push({ accountId: owner.id, orgId: id, role: 'owner', joinedAt: now });
      db.invitations.push({ code, orgId: id, createdBy: owner.id, disabled: false, createdAt: now });
      await saveFile(db);
    });
  }
  const view = await orgViewFor(owner.id);
  return view ? { ok: true, view } : { ok: false, message: '创建后读取失败' };
}

/** 账户当前所属机构（owner 或 member），无归属返回 null。 */
export async function orgForAccount(accountId: string): Promise<(Org & { memberRole: 'owner' | 'member' }) | null> {
  if (usePg()) {
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
  if (usePg()) {
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
      inviteCode: org.memberRole === 'owner' && codeRow.rowCount ? String(codeRow.rows[0].code) : null,
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
  if (usePg()) {
    const pool = await getPool();
    await pool.query('UPDATE org_invitations SET disabled = true WHERE org_id = $1', [orgId]);
    await pool.query(
      'INSERT INTO org_invitations (code, org_id, created_by) VALUES ($1, $2, $3)',
      [code, orgId, byAccountId],
    );
    return code;
  }
  await enqueue(async () => {
    const db = await loadFile();
    for (const i of db.invitations) if (i.orgId === orgId) i.disabled = true;
    db.invitations.push({
      code, orgId, createdBy: byAccountId, disabled: false, createdAt: new Date().toISOString(),
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
  const current = await orgForAccount(account.id);

  let target: { orgId: string } | null = null;
  if (usePg()) {
    const pool = await getPool();
    const row = await pool.query(
      'SELECT org_id FROM org_invitations WHERE upper(code) = $1 AND NOT disabled',
      [normalized],
    );
    target = row.rowCount ? { orgId: String(row.rows[0].org_id) } : null;
  } else {
    const db = await loadFile();
    const invite = db.invitations.find((i) => i.code.toUpperCase() === normalized && !i.disabled);
    target = invite ? { orgId: invite.orgId } : null;
  }
  if (!target) return { ok: false, message: '邀请码无效或已失效' };

  if (current) {
    if (current.id === target.orgId) return { ok: true, org: current };
    return { ok: false, message: `该账号已在机构「${current.name}」中，先退出再加入新机构` };
  }

  if (usePg()) {
    const pool = await getPool();
    await pool.query(
      "INSERT INTO org_members (account_id, org_id, role) VALUES ($1, $2, 'member') ON CONFLICT (account_id) DO NOTHING",
      [account.id, target.orgId],
    );
  } else {
    await enqueue(async () => {
      const db = await loadFile();
      if (!db.members.some((m) => m.accountId === account.id)) {
        db.members.push({
          accountId: account.id, orgId: target!.orgId, role: 'member',
          joinedAt: new Date().toISOString(),
        });
        await saveFile(db);
      }
    });
  }
  const org = await orgForAccount(account.id);
  return org ? { ok: true, org } : { ok: false, message: '入组后读取失败' };
}

/** 成员名册（owner 专用）。用户名/昵称 join 自 accounts。 */
export async function membersOf(orgId: string): Promise<OrgMember[]> {
  if (usePg()) {
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
  const { fileBackend } = await import('./file-store');
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
  void fileBackend; // 保持依赖显式
  return out.sort((a, b) => (a.role === b.role ? a.joinedAt.localeCompare(b.joinedAt) : a.role === 'owner' ? -1 : 1));
}

async function fileAccountById(id: string): Promise<{ username: string; displayName: string } | null> {
  try {
    const dir = process.env.ACCOUNTS_DIR || path.join(process.cwd(), 'data', 'accounts');
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'accounts.json'), 'utf-8')) as {
      accounts?: Array<{ id: string; username: string; displayName: string }>;
    };
    const a = (raw.accounts ?? []).find((x) => x.id === id);
    return a ? { username: a.username, displayName: a.displayName } : null;
  } catch {
    return null;
  }
}

/** 移出成员（owner 专用；owner 本人不可移出——移交功能是 P2）。 */
export async function removeMember(
  orgId: string,
  accountId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (usePg()) {
    const pool = await getPool();
    const res = await pool.query(
      "DELETE FROM org_members WHERE org_id = $1 AND account_id = $2 AND role <> 'owner'",
      [orgId, accountId],
    );
    return res.rowCount ? { ok: true } : { ok: false, message: '成员不存在或为机构所有者' };
  }
  return enqueue(async () => {
    const db = await loadFile();
    const before = db.members.length;
    db.members = db.members.filter(
      (m) => !(m.orgId === orgId && m.accountId === accountId && m.role !== 'owner'),
    );
    if (db.members.length === before) return { ok: false as const, message: '成员不存在或为机构所有者' };
    await saveFile(db);
    return { ok: true as const };
  });
}

// ------------------------------------------------------- 知识库归属与可见性

/** 全部归属关系：corpus → orgId。无行 = 公共库。 */
export async function corpusOwnership(): Promise<Map<string, string>> {
  if (usePg()) {
    const pool = await getPool();
    const rows = await pool.query('SELECT corpus, org_id FROM org_corpora');
    return new Map(rows.rows.map((r) => [String(r.corpus), String(r.org_id)]));
  }
  const db = await loadFile();
  return new Map(db.corpora.map((c) => [c.corpus, c.orgId]));
}

/** 认领/释放知识库（owner 专用；认领他org已占的库报错）。 */
export async function setCorpusOrg(
  corpus: string,
  orgId: string | null,
  actorOrgId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const owned = (await corpusOwnership()).get(corpus);
  if (owned && owned !== actorOrgId) return { ok: false, message: '该知识库已归属其他机构' };
  if (usePg()) {
    const pool = await getPool();
    if (orgId === null) {
      await pool.query('DELETE FROM org_corpora WHERE corpus = $1 AND org_id = $2', [corpus, actorOrgId]);
    } else {
      await pool.query(
        `INSERT INTO org_corpora (corpus, org_id) VALUES ($1, $2)
         ON CONFLICT (corpus) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()`,
        [corpus, orgId],
      );
    }
    return { ok: true };
  }
  return enqueue(async () => {
    const db = await loadFile();
    db.corpora = db.corpora.filter((c) => c.corpus !== corpus);
    if (orgId !== null) {
      db.corpora.push({ corpus, orgId, updatedAt: new Date().toISOString() });
    }
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
