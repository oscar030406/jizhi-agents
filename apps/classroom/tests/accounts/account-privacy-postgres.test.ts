import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  insertUniqueViolation: false,
  markerOwnership: {} as Record<string, string>,
  ownershipUnavailable: false,
  ownerHasMember: false,
  persistedCorpus: null as string | null,
  usernameCollision: false,
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  release: vi.fn(),
  end: vi.fn(),
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    pg.queries.push({ sql, values });
    if (sql.includes('CREATE TABLE IF NOT EXISTS')) return { rowCount: null, rows: [] };
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes('SELECT lower(username) AS normalized_username')) {
      return pg.usernameCollision
        ? {
            rowCount: 1,
            rows: [{ normalized_username: 'alice', account_count: 2 }],
          }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_unique')) {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes("SELECT to_regclass('accounts')")) {
      return { rowCount: 1, rows: [{ table_name: 'accounts' }] };
    }
    if (sql.includes('SELECT relation, record_id')) return { rowCount: 0, rows: [] };
    if (sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_unique_target')) {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes('INSERT INTO accounts')) {
      if (pg.insertUniqueViolation) throw Object.assign(new Error('duplicate'), { code: '23505' });
      return {
        rowCount: 1,
        rows: [
          {
            id: values[0],
            username: values[1],
            display_name: values[2],
            role: values[4],
            created_at: '2026-09-01T00:00:00.000Z',
          },
        ],
      };
    }
    if (sql.includes('SELECT id FROM accounts WHERE id = $1 FOR UPDATE')) {
      return { rowCount: 1, rows: [{ id: values[0] }] };
    }
    if (sql.includes('UPDATE accounts SET password')) return { rowCount: 1, rows: [] };
    if (sql.includes('SELECT 1 FROM accounts WHERE id'))
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    if (sql.includes('FROM org_members m JOIN orgs o')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT profile FROM accounts')) {
      return { rowCount: 1, rows: [{ profile: { domain: 'ai', goal: '学习人工智能' } }] };
    }
    if (sql.includes('SELECT created_at, expires_at') && sql.includes('FROM account_sessions')) {
      return {
        rowCount: 1,
        rows: [
          {
            created_at: '2026-09-01T00:00:00.000Z',
            expires_at: '2026-10-01T00:00:00.000Z',
          },
        ],
      };
    }
    if (sql.includes('SELECT id, stage_id, kind, status')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 'runtime-1',
            stage_id: 'course-1',
            kind: 'quiz',
            status: 'active',
            created_at: '2026-09-01T00:00:00.000Z',
            updated_at: '2026-09-01T00:01:00.000Z',
            data: { score: 1 },
          },
        ],
      };
    }
    if (sql.includes('SELECT records.id, records.session_id')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 'record-1',
            session_id: 'runtime-1',
            seq: 0,
            scene_id: 'scene-1',
            created_at: '2026-09-01T00:00:30.000Z',
            data: { answer: 'A' },
          },
        ],
      };
    }
    if (sql.includes('SELECT id, name, description, interactive_mode')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 'course-1',
            name: '人工智能基础',
            description: null,
            interactive_mode: true,
            task_engine_mode: false,
            created_at: 1,
            updated_at: 2,
            data: { id: 'course-1' },
          },
        ],
      };
    }
    if (sql.includes('SELECT scenes.stage_id, scenes.id')) {
      return {
        rowCount: 1,
        rows: [{ stage_id: 'course-1', id: 'scene-1', scene_order: 0, data: { title: '导入' } }],
      };
    }
    if (sql.includes('SELECT outlines.stage_id')) {
      return { rowCount: 1, rows: [{ stage_id: 'course-1', data: { title: '大纲' } }] };
    }
    if (sql.includes('FROM account_sessions s JOIN accounts a')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT id, name FROM orgs WHERE owner_account_id')) {
      return { rowCount: 1, rows: [{ id: 'org-a', name: '甲方培训中心' }] };
    }
    if (sql.includes('SELECT account_id FROM org_members')) {
      return pg.ownerHasMember
        ? { rowCount: 1, rows: [{ account_id: 'learner-b' }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT corpus FROM org_corpora WHERE org_id = ANY')) {
      return pg.persistedCorpus
        ? { rowCount: 1, rows: [{ corpus: pg.persistedCorpus }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT corpus, org_id FROM org_corpora')) {
      return pg.persistedCorpus
        ? { rowCount: 1, rows: [{ corpus: pg.persistedCorpus, org_id: 'org-a' }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('SELECT to_regclass')) {
      return { rowCount: 1, rows: [{ table_name: String(values[0]) }] };
    }
    if (sql.includes('DELETE FROM accounts WHERE id')) return { rowCount: 1, rows: [] };
    if (sql.includes('DELETE FROM')) return { rowCount: 1, rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  }),
}));

vi.mock('pg', () => ({
  Pool: class {
    query(sql: string, values?: unknown[]) {
      return pg.query(sql, values);
    }

    async connect() {
      return { query: pg.query, release: pg.release };
    }

    async end() {
      pg.end();
    }
  },
}));

describe('账户隐私闭环 PostgreSQL 事务', () => {
  beforeEach(() => {
    pg.insertUniqueViolation = false;
    pg.markerOwnership = {};
    pg.ownershipUnavailable = false;
    pg.ownerHasMember = false;
    pg.persistedCorpus = null;
    pg.usernameCollision = false;
    pg.queries.length = 0;
    pg.query.mockClear();
    pg.release.mockClear();
    pg.end.mockClear();
    process.env.PERSISTENCE_DATABASE_URL = 'postgresql://test.invalid/jizhi';
    process.env.DATABASE_URL = 'postgresql://test.invalid/jizhi';
    process.env.GROUNDING_URL = 'http://engine.test';
    process.env.GROUNDING_TOKEN = 'test-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (pg.ownershipUnavailable) throw new Error('engine unavailable');
        return new Response(JSON.stringify({ ownership: pg.markerOwnership }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    delete process.env.PERSISTENCE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.GROUNDING_URL;
    delete process.env.GROUNDING_TOKEN;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('独立 owner 删除机构后，在同库事务清课程、运行记录、账户与全部会话', async () => {
    const { deleteAccount } = await import('@/lib/accounts/store');
    expect(await deleteAccount('owner-a')).toEqual({ ok: true });

    const sql = pg.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('DELETE FROM orgs WHERE id = $1');
    expect(sql).toContain('course_id IN (SELECT id FROM document_stages');
    expect(sql).toContain('stage_id IN (SELECT id FROM document_stages');
    expect(sql).toContain('DELETE FROM document_stages WHERE owner_account_id = $1');
    expect(sql).toContain('DELETE FROM runtime_sessions WHERE learner_key = $1');
    expect(sql).toContain('DELETE FROM accounts WHERE id = $1');
    expect(sql).toContain('COMMIT');
    expect(pg.release).toHaveBeenCalledTimes(3);
  });

  it('owner 仍有成员时在删除任何账户数据前拒绝', async () => {
    pg.ownerHasMember = true;
    const { deleteAccount } = await import('@/lib/accounts/store');
    expect(await deleteAccount('owner-a')).toMatchObject({
      ok: false,
      code: 'owner_has_members',
    });
    expect(pg.queries.some((query) => query.sql.includes('DELETE FROM accounts WHERE id'))).toBe(
      false,
    );
    expect(pg.queries.some((query) => query.sql.includes('DELETE FROM document_stages'))).toBe(
      false,
    );
  });

  it('账户库与学习数据库不同源时在任何写入前拒绝', async () => {
    process.env.DATABASE_URL = 'postgresql://test.invalid/learning';
    const { deleteAccount } = await import('@/lib/accounts/store');
    expect(await deleteAccount('owner-a')).toMatchObject({
      ok: false,
      code: 'storage_topology',
    });
    expect(pg.queries).toEqual([]);
  });

  it('读取会话前执行 PostgreSQL 到期清理', async () => {
    const { accountForSession } = await import('@/lib/accounts/store');
    expect(await accountForSession('expired-token')).toBeNull();
    const cleanup = pg.queries.find((query) =>
      query.sql.includes('DELETE FROM account_sessions WHERE expires_at <= now()'),
    );
    const lookup = pg.queries.findIndex((query) =>
      query.sql.includes('FROM account_sessions s JOIN accounts a'),
    );
    expect(cleanup).toBeDefined();
    expect(pg.queries.indexOf(cleanup!)).toBeLessThan(lookup);
  });

  it('PostgreSQL 导出包含当前账户课程与运行记录，但不读取密码或会话 token', async () => {
    const { exportAccountData } = await import('@/lib/accounts/store');
    const exported = await exportAccountData({
      id: 'learner-a',
      username: 'learner01',
      displayName: 'learner01',
      role: 'learner',
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    expect(exported.profile.profiles[0].fields).toMatchObject({ domain: 'ai' });
    expect(exported.serverLearningData.runtimeSessions[0]).toMatchObject({
      id: 'runtime-1',
      records: [{ id: 'record-1' }],
    });
    expect(exported.serverLearningData.documents[0]).toMatchObject({
      id: 'course-1',
      scenes: [{ id: 'scene-1' }],
      outline: { title: '大纲' },
    });
    const sql = pg.queries.map((query) => query.sql).join('\n');
    expect(sql).not.toMatch(/SELECT .*password/i);
    expect(sql).not.toMatch(/SELECT .*token/i);
  });

  it('重置密码与删除全部旧会话使用同一事务', async () => {
    const { resetPassword } = await import('@/lib/accounts/store');
    expect(await resetPassword('learner-a', 'newpass123')).toEqual({ ok: true });
    const sql = pg.queries.map((query) => query.sql);
    const lock = sql.findIndex((statement) => statement.includes('SELECT id FROM accounts'));
    const update = sql.findIndex((statement) => statement.includes('UPDATE accounts SET password'));
    const sessions = sql.findIndex((statement) =>
      statement.includes('DELETE FROM account_sessions WHERE account_id'),
    );
    const commit = sql.lastIndexOf('COMMIT');
    expect(lock).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(lock);
    expect(sessions).toBeGreaterThan(update);
    expect(commit).toBeGreaterThan(sessions);
  });

  it('注册直接依赖 lower(username) 唯一索引并处理 23505', async () => {
    pg.insertUniqueViolation = true;
    const { createAccount } = await import('@/lib/accounts/store');
    expect(await createAccount('Alice', 'pass123456')).toEqual({
      ok: false,
      message: '用户名已被占用',
    });
    expect(
      pg.queries.some((query) =>
        query.sql.includes('accounts_username_lower_unique ON accounts (lower(username))'),
      ),
    ).toBe(true);
    expect(
      pg.queries.some((query) =>
        query.sql.includes('SELECT 1 FROM accounts WHERE lower(username) = lower($1)'),
      ),
    ).toBe(false);
  });

  it('现存大小写用户名碰撞显式阻断且不改数据', async () => {
    pg.usernameCollision = true;
    const { accountForSession } = await import('@/lib/accounts/store');
    await expect(accountForSession('token')).rejects.toThrow(
      '账户完整性审计失败：用户名 alice 忽略大小写后存在 2 条记录；未修改现存数据',
    );
    expect(pg.queries.some((query) => query.sql.includes('INSERT INTO accounts'))).toBe(false);
    expect(pg.queries.some((query) => query.sql.includes('DELETE FROM accounts'))).toBe(false);
    expect(pg.end).toHaveBeenCalledTimes(1);
  });

  it('owner 的未迁移旧行、引擎活跃归属和归属服务故障都阻断删户', async () => {
    const { deleteAccount } = await import('@/lib/accounts/store');

    pg.persistedCorpus = 'db-private';
    expect(await deleteAccount('owner-a')).toMatchObject({
      ok: false,
      code: 'ownership_unavailable',
    });

    pg.persistedCorpus = null;
    pg.markerOwnership = { 'engine-private': 'org-a' };
    expect(await deleteAccount('owner-a')).toMatchObject({
      ok: false,
      code: 'owner_has_corpora',
    });

    pg.markerOwnership = {};
    pg.ownershipUnavailable = true;
    expect(await deleteAccount('owner-a')).toMatchObject({
      ok: false,
      code: 'ownership_unavailable',
    });
    expect(pg.queries.some((query) => query.sql.includes('DELETE FROM accounts WHERE id'))).toBe(
      false,
    );
  });
});
