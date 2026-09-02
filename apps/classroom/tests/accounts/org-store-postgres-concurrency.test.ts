import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.JIZHI_TEST_POSTGRES_URL ?? '';
const describeWithPostgres = databaseUrl ? describe : describe.skip;

async function waitForBlockedQuery(pool: Pool, applicationName: string, fragment: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
          AND query LIKE $2
        LIMIT 1`,
      [applicationName, `%${fragment}%`],
    );
    if (blocked.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`未观察到等待行锁的查询：${fragment}`);
}

describeWithPostgres('机构邀请码 PostgreSQL 并发锁序', () => {
  const schema = `jizhi_invite_race_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `${schema}_store`;
  const previousPersistenceUrl = process.env.PERSISTENCE_DATABASE_URL;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let adminPool: Pool;
  let setupPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    scopedUrl.searchParams.set('application_name', applicationName);
    process.env.PERSISTENCE_DATABASE_URL = scopedUrl.toString();
    delete process.env.DATABASE_URL;

    const setupUrl = new URL(scopedUrl);
    setupUrl.searchParams.set('application_name', `${schema}_setup`);
    setupPool = new Pool({ connectionString: setupUrl.toString() });
    await setupPool.query('CREATE TABLE accounts (id TEXT PRIMARY KEY, role TEXT NOT NULL)');
    await setupPool.query(
      `INSERT INTO accounts (id, role)
       VALUES ('owner-race', 'manager'), ('learner-race', 'learner')`,
    );
  });

  afterAll(async () => {
    if (previousPersistenceUrl === undefined) delete process.env.PERSISTENCE_DATABASE_URL;
    else process.env.PERSISTENCE_DATABASE_URL = previousPersistenceUrl;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await setupPool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
    vi.resetModules();
  });

  it('轮换先取得机构锁时，已读取旧码的并发兑码会在邀请复核处失败', async () => {
    const store = await import('@/lib/accounts/org-store');
    const owner = {
      id: 'owner-race',
      username: 'owner-race',
      displayName: '并发测试管理者',
      role: 'manager' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const learner = {
      id: 'learner-race',
      username: 'learner-race',
      displayName: '并发测试学员',
      role: 'learner' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const created = await store.createOrg(owner, '并发测试机构');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldCode = created.view.inviteCode!;

    const blocker = await setupPool.connect();
    let blockerReleased = false;
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM orgs WHERE id = $1 FOR UPDATE', [created.view.org.id]);
    try {
      const rotation = store.rotateInviteCode(created.view.org.id, owner.id);
      await waitForBlockedQuery(adminPool, applicationName, 'FOR UPDATE OF o, a');

      const joiningWithOldCode = store.joinByCode(learner, oldCode);
      await waitForBlockedQuery(
        adminPool,
        applicationName,
        'SELECT id, name, owner_account_id, created_at',
      );

      await blocker.query('COMMIT');
      blockerReleased = true;
      const newCode = await rotation;
      await expect(joiningWithOldCode).resolves.toEqual({
        ok: false,
        message: '邀请码无效或已失效',
      });
      await expect(store.joinByCode(learner, newCode)).resolves.toMatchObject({ ok: true });
    } finally {
      if (!blockerReleased) await blocker.query('ROLLBACK');
      blocker.release();
    }
  }, 20_000);
});
