import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  assignments: new Map<
    string,
    {
      id: string;
      org_id: string;
      course_id: string;
      title: string;
      assigned_by: string;
      learner_account_id: string | null;
      learner_display_name: string | null;
      created_at: string;
    }
  >(),
  corpusOwners: new Map<string, string>(),
  members: new Set<string>(),
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    pg.queries.push({ sql, values });
    if (sql.includes('CREATE TABLE IF NOT EXISTS orgs')) return { rowCount: null, rows: [] };
    if (sql.includes('FROM org_assignments oa')) {
      const orgId = String(values[0]);
      const learnerId = values.length > 1 ? String(values[1]) : null;
      const excludesLegacy =
        values.length === 1
          ? sql.includes('oa.learner_account_id IS NOT NULL')
          : sql.includes('oa.learner_account_id = $2') && !sql.includes('IS NULL OR');
      const rows = [...pg.assignments.values()].filter(
        (row) =>
          row.org_id === orgId &&
          (!excludesLegacy || row.learner_account_id !== null) &&
          (learnerId === null ||
            row.learner_account_id === learnerId ||
            (!excludesLegacy && row.learner_account_id === null)),
      );
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('WITH target AS (') && sql.includes('INSERT INTO org_assignments')) {
      const [id, orgId, courseId, title, assignedBy, learnerId] = values.map(String);
      if (!pg.members.has(`${orgId}|${learnerId}`)) return { rowCount: 0, rows: [] };
      const key = `${orgId}|${courseId}|${learnerId}`;
      let row = pg.assignments.get(key);
      if (!row) {
        row = {
          id,
          org_id: orgId,
          course_id: courseId,
          title,
          assigned_by: assignedBy,
          learner_account_id: learnerId,
          learner_display_name: '学员乙',
          created_at: '2026-09-01T00:02:00.000Z',
        };
        pg.assignments.set(key, row);
      }
      return { rowCount: 1, rows: [row] };
    }
    if (sql.includes('INSERT INTO org_corpora')) {
      const [corpus, orgId, actorOrgId] = values.map(String);
      const owned = pg.corpusOwners.get(corpus);
      if (owned && owned !== actorOrgId) return { rowCount: 0, rows: [] };
      pg.corpusOwners.set(corpus, orgId);
      return { rowCount: 1, rows: [{ org_id: orgId }] };
    }
    if (sql.includes('DELETE FROM org_corpora')) {
      const [corpus, actorOrgId] = values.map(String);
      if (pg.corpusOwners.get(corpus) === actorOrgId) pg.corpusOwners.delete(corpus);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('WITH removed_member AS')) {
      const [orgId, learnerId] = values.map(String);
      const memberKey = `${orgId}|${learnerId}`;
      if (!pg.members.delete(memberKey)) return { rowCount: 1, rows: [{ removed_count: 0 }] };
      for (const [key, row] of pg.assignments) {
        if (row.org_id === orgId && row.learner_account_id === learnerId)
          pg.assignments.delete(key);
      }
      return { rowCount: 1, rows: [{ removed_count: 1 }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }),
}));

vi.mock('pg', () => ({
  Pool: class {
    query(sql: string, values?: unknown[]) {
      return pg.query(sql, values);
    }
  },
}));

describe('机构存储 PostgreSQL 原子性与旧行归档', () => {
  beforeEach(() => {
    pg.assignments.clear();
    pg.corpusOwners.clear();
    pg.members.clear();
    pg.queries.length = 0;
    pg.query.mockClear();
    pg.members.add('org-a|learner-b');
    pg.assignments.set('org-a|course-ai|learner-b', {
      id: 'asg-target',
      org_id: 'org-a',
      course_id: 'course-ai',
      title: 'AI 课程',
      assigned_by: 'owner-a',
      learner_account_id: 'learner-b',
      learner_display_name: '学员乙',
      created_at: '2026-09-01T00:01:00.000Z',
    });
    pg.assignments.set('org-a|course-legacy|null', {
      id: 'asg-legacy',
      org_id: 'org-a',
      course_id: 'course-legacy',
      title: '历史全体课程',
      assigned_by: 'owner-a',
      learner_account_id: null,
      learner_display_name: null,
      created_at: '2026-08-31T00:00:00.000Z',
    });
    process.env.PERSISTENCE_DATABASE_URL = 'postgresql://test.invalid/jizhi';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.PERSISTENCE_DATABASE_URL;
    vi.resetModules();
  });

  it('扩展旧表、保留但不返回 NULL 行，并建立定向唯一约束', async () => {
    const store = await import('@/lib/accounts/org-store');

    expect((await store.assignmentsOf('org-a')).map((item) => item.courseId)).toEqual([
      'course-ai',
    ]);
    expect((await store.assignmentsOf('org-a', 'learner-b')).map((item) => item.courseId)).toEqual([
      'course-ai',
    ]);
    expect(pg.assignments.get('org-a|course-legacy|null')?.id).toBe('asg-legacy');

    const migration = pg.queries.find((query) =>
      query.sql.includes('CREATE TABLE IF NOT EXISTS orgs'),
    );
    expect(migration?.sql).toContain(
      'ALTER TABLE org_assignments ADD COLUMN IF NOT EXISTS learner_account_id TEXT',
    );
    expect(migration?.sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_unique_target',
    );
    expect(migration?.sql).toContain('WHERE learner_account_id IS NOT NULL');
  });

  it('用锁定成员的条件 UPSERT 原子指派，并发重试返回同一行', async () => {
    const store = await import('@/lib/accounts/org-store');

    const first = await store.addAssignment(
      'org-a',
      'course-mfg',
      '智能制造课程',
      'owner-a',
      'learner-b',
    );
    const second = await store.addAssignment(
      'org-a',
      'course-mfg',
      '智能制造课程',
      'owner-a',
      'learner-b',
    );
    expect(first).toMatchObject({
      ok: true,
      assignment: { learnerAccountId: 'learner-b', learnerDisplayName: '学员乙' },
    });
    expect(second).toMatchObject({
      ok: true,
      assignment: { id: first.ok ? first.assignment.id : '' },
    });

    const writes = pg.queries.filter(
      (query) =>
        query.sql.includes('WITH target AS (') && query.sql.includes('INSERT INTO org_assignments'),
    );
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain("role = 'member'");
    expect(writes[0].sql).toContain('FOR UPDATE');
    expect(writes[0].sql).toContain('ON CONFLICT (org_id, course_id, learner_account_id)');
    expect(writes[0].values).toEqual([
      expect.stringMatching(/^asg_/),
      'org-a',
      'course-mfg',
      '智能制造课程',
      'owner-a',
      'learner-b',
    ]);

    expect(
      await store.addAssignment(
        'org-a',
        'course-cross',
        '越界课程',
        'owner-a',
        'learner-other-org',
      ),
    ).toEqual({ ok: false, message: '目标账户不是本机构学员' });
    expect(
      pg.queries.some((query) => query.sql.includes('FROM org_members m JOIN accounts a')),
    ).toBe(false);
  });

  it('用条件 INSERT 原子认领，已被他机构占用时不覆盖', async () => {
    const store = await import('@/lib/accounts/org-store');

    expect(await store.setCorpusOrg('shared', 'org-a', 'org-a')).toEqual({ ok: true });
    expect(await store.setCorpusOrg('shared', 'org-b', 'org-b')).toEqual({
      ok: false,
      message: '该知识库已归属其他机构',
    });
    expect(pg.corpusOwners.get('shared')).toBe('org-a');

    const claims = pg.queries.filter((query) => query.sql.includes('INSERT INTO org_corpora'));
    expect(claims).toHaveLength(2);
    expect(claims[0].sql).toContain('ON CONFLICT (corpus) DO UPDATE');
    expect(claims[0].sql).toContain('WHERE org_corpora.org_id = $3');
    expect(pg.queries.some((query) => query.sql.includes('SELECT corpus, org_id'))).toBe(false);
  });
});
