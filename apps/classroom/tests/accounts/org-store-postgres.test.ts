import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  auditFailure: false,
  assignments: new Map<
    string,
    {
      id: string;
      org_id: string;
      course_id: string;
      title: string;
      domain: string | null;
      assigned_by: string;
      learner_account_id: string | null;
      learner_display_name: string | null;
      created_at: string;
    }
  >(),
  corpusOwners: new Map<string, string>(),
  invitations: new Map<string, string>(),
  members: new Set<string>(),
  orgs: new Map<
    string,
    { id: string; name: string; owner_account_id: string; created_at: string }
  >(),
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  poolQueries: [] as string[],
  clientQueries: [] as Array<{ clientId: number; sql: string }>,
  connectCount: 0,
  release: vi.fn(),
  end: vi.fn(),
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    pg.queries.push({ sql, values });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes('CREATE TABLE IF NOT EXISTS orgs')) return { rowCount: null, rows: [] };
    if (sql.includes("SELECT to_regclass('accounts')")) {
      return { rowCount: 1, rows: [{ table_name: 'accounts' }] };
    }
    if (sql.includes('SELECT relation, record_id')) {
      return pg.auditFailure
        ? {
            rowCount: 1,
            rows: [{ relation: 'org_members.account_id', record_id: 'orphan-account' }],
          }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_unique_target')) {
      return { rowCount: null, rows: [] };
    }
    if (sql.includes("SELECT id FROM accounts WHERE id = $1 AND role = 'manager'")) {
      return { rowCount: 1, rows: [{ id: values[0] }] };
    }
    if (sql === 'SELECT org_id FROM org_members WHERE account_id = $1') {
      const accountId = String(values[0]);
      const membership = [...pg.members].find((entry) => entry.endsWith(`|${accountId}`));
      return membership
        ? { rowCount: 1, rows: [{ org_id: membership.split('|')[0] }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('INSERT INTO orgs')) {
      const [id, name, ownerId] = values.map(String);
      pg.orgs.set(id, {
        id,
        name,
        owner_account_id: ownerId,
        created_at: '2026-09-01T00:00:00.000Z',
      });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('INSERT INTO org_members') && sql.includes("'owner'")) {
      pg.members.add(`${String(values[1])}|${String(values[0])}`);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('INSERT INTO org_members') && sql.includes("'member'")) {
      const accountId = String(values[0]);
      const orgId = String(values[1]);
      const existing = [...pg.members].find((entry) => entry.endsWith(`|${accountId}`));
      if (existing) return { rowCount: 0, rows: [] };
      pg.members.add(`${orgId}|${accountId}`);
      return { rowCount: 1, rows: [{ org_id: orgId }] };
    }
    if (sql.includes('INSERT INTO org_invitations')) {
      pg.invitations.set(String(values[1]), String(values[0]));
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE org_invitations SET disabled = true')) {
      pg.invitations.delete(String(values[0]));
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('FROM org_members m JOIN orgs o')) {
      const accountId = String(values[0]);
      const membership = [...pg.members].find((entry) => entry.endsWith(`|${accountId}`));
      if (!membership) return { rowCount: 0, rows: [] };
      const org = pg.orgs.get(membership.split('|')[0]);
      return org
        ? {
            rowCount: 1,
            rows: [{ ...org, role: org.owner_account_id === accountId ? 'owner' : 'member' }],
          }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT code FROM org_invitations')) {
      const code = pg.invitations.get(String(values[0]));
      return code ? { rowCount: 1, rows: [{ code }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM org_invitations') && sql.includes('FOR UPDATE')) {
      const code = String(values[0]);
      const orgId = String(values[1]);
      return pg.invitations.get(orgId)?.toUpperCase() === code
        ? { rowCount: 1, rows: [{ org_id: orgId }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT org_id') && sql.includes('FROM org_invitations')) {
      const code = String(values[0]);
      const invitation = [...pg.invitations].find(
        ([, invitationCode]) => invitationCode.toUpperCase() === code,
      );
      return invitation
        ? { rowCount: 1, rows: [{ org_id: invitation[0] }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT count(*)::int AS n FROM org_members')) {
      const orgId = String(values[0]);
      return {
        rowCount: 1,
        rows: [{ n: [...pg.members].filter((entry) => entry.startsWith(`${orgId}|`)).length }],
      };
    }
    if (sql.includes('FOR UPDATE OF o, a')) {
      const [orgId, ownerId] = values.map(String);
      const org = pg.orgs.get(orgId);
      return org?.owner_account_id === ownerId && pg.members.has(`${orgId}|${ownerId}`)
        ? { rowCount: 1, rows: [{ id: orgId }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM orgs') && sql.includes('FOR UPDATE')) {
      const org = pg.orgs.get(String(values[0]));
      return org ? { rowCount: 1, rows: [org] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT role FROM accounts') && sql.includes('FOR UPDATE')) {
      const accountId = String(values[0]);
      return {
        rowCount: 1,
        rows: [{ role: accountId.startsWith('owner-') ? 'manager' : 'learner' }],
      };
    }
    if (sql.includes('FROM org_members m') && sql.includes('LEFT JOIN orgs o')) {
      const accountId = String(values[0]);
      const membership = [...pg.members].find((entry) => entry.endsWith(`|${accountId}`));
      const org = membership ? pg.orgs.get(membership.split('|')[0]) : null;
      return membership
        ? { rowCount: 1, rows: [{ org_id: membership.split('|')[0], name: org?.name ?? null }] }
        : { rowCount: 0, rows: [] };
    }
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
    if (sql.includes('SELECT actor_member.account_id AS actor_id')) {
      const [orgId, assignedBy, learnerId] = values.map(String);
      if (!pg.members.has(`${orgId}|${assignedBy}`) || !pg.members.has(`${orgId}|${learnerId}`)) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [{ actor_id: assignedBy, target_id: learnerId }] };
    }
    if (sql.includes('SELECT domain') && sql.includes('FROM org_assignments')) {
      const [orgId, learnerId] = values.map(String);
      const rows = [...pg.assignments.values()]
        .filter((row) => row.org_id === orgId && row.learner_account_id === learnerId)
        .map((row) => ({ domain: row.domain }));
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('WITH upserted AS (') && sql.includes('INSERT INTO org_assignments')) {
      const [id, orgId, courseId, title, domain, assignedBy, learnerId] = values.map(String);
      const key = `${orgId}|${courseId}|${learnerId}`;
      let row = pg.assignments.get(key);
      if (!row) {
        row = {
          id,
          org_id: orgId,
          course_id: courseId,
          title,
          domain,
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
      pg.poolQueries.push(sql);
      return pg.query(sql, values);
    }

    async connect() {
      const clientId = ++pg.connectCount;
      return {
        query(sql: string, values?: unknown[]) {
          pg.clientQueries.push({ clientId, sql });
          return pg.query(sql, values);
        },
        release: pg.release,
      };
    }

    async end() {
      pg.end();
    }
  },
}));

describe('机构存储 PostgreSQL 原子性与旧行归档', () => {
  beforeEach(() => {
    pg.auditFailure = false;
    pg.assignments.clear();
    pg.corpusOwners.clear();
    pg.invitations.clear();
    pg.members.clear();
    pg.orgs.clear();
    pg.queries.length = 0;
    pg.poolQueries.length = 0;
    pg.clientQueries.length = 0;
    pg.connectCount = 0;
    pg.release.mockClear();
    pg.end.mockClear();
    pg.query.mockClear();
    pg.members.add('org-a|learner-b');
    pg.members.add('org-a|owner-a');
    pg.orgs.set('org-a', {
      id: 'org-a',
      name: '甲方培训中心',
      owner_account_id: 'owner-a',
      created_at: '2026-09-01T00:00:00.000Z',
    });
    pg.invitations.set('org-a', 'JZ-TESTCODE');
    pg.assignments.set('org-a|course-ai|learner-b', {
      id: 'asg-target',
      org_id: 'org-a',
      course_id: 'course-ai',
      title: 'AI 课程',
      domain: 'ai',
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
      domain: null,
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

    const expansion = pg.queries.find((query) =>
      query.sql.includes('CREATE TABLE IF NOT EXISTS orgs'),
    );
    expect(expansion?.sql).toContain(
      'ALTER TABLE org_assignments ADD COLUMN IF NOT EXISTS learner_account_id TEXT',
    );
    expect(expansion?.sql).toContain(
      'ALTER TABLE org_assignments ADD COLUMN IF NOT EXISTS domain TEXT',
    );
    const constraints = pg.queries.find((query) =>
      query.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_unique_target'),
    );
    expect(constraints?.sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_unique_target',
    );
    expect(constraints?.sql).toContain('FOREIGN KEY (owner_account_id) REFERENCES accounts(id)');
    expect(constraints?.sql).toContain('FOREIGN KEY (account_id) REFERENCES accounts(id)');
    expect(constraints?.sql).toContain('FOREIGN KEY (assigned_by) REFERENCES accounts(id)');
    expect(constraints?.sql).toContain('FOREIGN KEY (learner_account_id) REFERENCES accounts(id)');
    expect(constraints?.sql).toContain('REFERENCES orgs(id) ON DELETE RESTRICT');
    const audit = pg.queries.find((query) => query.sql.includes('SELECT relation, record_id'));
    expect(audit?.sql).toContain('org_members.account_role');
    expect(audit?.sql).toContain('org_invitations.owner_membership');
    expect(audit?.sql).toContain('org_assignments.owner_membership');
    expect(audit?.sql).toContain('org_assignments.learner_membership');
  });

  it('现存机构孤儿关系只报审计错误，不静默删除', async () => {
    pg.auditFailure = true;
    const store = await import('@/lib/accounts/org-store');
    await expect(store.assignmentsOf('org-a')).rejects.toThrow(
      '机构关系完整性审计失败：org_members.account_id 存在无效记录 orphan-account；未修改现存数据',
    );
    expect(pg.queries.some((query) => query.sql.includes('DELETE FROM'))).toBe(false);
    expect(
      pg.queries.some((query) =>
        query.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_unique_target'),
      ),
    ).toBe(false);
    expect(pg.end).toHaveBeenCalledTimes(1);
  });

  it('锁定目标学员后检查领域并原子 UPSERT，重试返回同一行', async () => {
    const store = await import('@/lib/accounts/org-store');

    const first = await store.addAssignment(
      'org-a',
      'course-mfg',
      '智能制造课程',
      'owner-a',
      'learner-b',
      'ai',
    );
    const second = await store.addAssignment(
      'org-a',
      'course-mfg',
      '智能制造课程',
      'owner-a',
      'learner-b',
      'ai',
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
        query.sql.includes('WITH upserted AS (') &&
        query.sql.includes('INSERT INTO org_assignments'),
    );
    expect(writes).toHaveLength(2);
    expect(writes[0].sql).toContain('ON CONFLICT (org_id, course_id, learner_account_id)');
    expect(writes[0].values).toEqual([
      expect.stringMatching(/^asg_/),
      'org-a',
      'course-mfg',
      '智能制造课程',
      'ai',
      'owner-a',
      'learner-b',
    ]);
    const relation = pg.queries.find((query) =>
      query.sql.includes('SELECT actor_member.account_id AS actor_id'),
    );
    expect(relation?.sql).toContain("actor_member.role = 'owner'");
    expect(relation?.sql).toContain("target_member.role = 'member'");
    expect(relation?.sql).toContain(
      'FOR UPDATE OF actor_member, actor_account, target_member, target_account',
    );
    expect(
      pg.queries.some(
        (query) => query.sql.includes('SELECT domain') && query.sql.includes('FOR UPDATE'),
      ),
    ).toBe(true);

    expect(
      await store.addAssignment(
        'org-a',
        'course-cross',
        '越界课程',
        'owner-a',
        'learner-other-org',
        'ai',
      ),
    ).toEqual({ ok: false, message: '指派者或目标账户的机构关系已失效' });
    expect(
      pg.queries.some(
        (query) =>
          !query.sql.includes('SELECT relation, record_id') &&
          query.sql.includes('FROM org_members m JOIN accounts a'),
      ),
    ).toBe(false);
  });

  it('已有其他领域时在写入前回滚', async () => {
    const store = await import('@/lib/accounts/org-store');

    expect(
      await store.addAssignment(
        'org-a',
        'course-mfg',
        '智能制造课程',
        'owner-a',
        'learner-b',
        'smart-manufacturing',
      ),
    ).toEqual({
      ok: false,
      message: '该学员已有其他领域课程指派，请先撤回旧领域课程后再指派',
    });
    expect(
      pg.queries.some(
        (query) => query.sql.includes('INSERT INTO org_assignments') && query.values.length === 7,
      ),
    ).toBe(false);
    expect(pg.queries.some((query) => query.sql === 'ROLLBACK')).toBe(true);
  });

  it('邀请码入组在单一事务内按机构、邀请顺序加锁后写入', async () => {
    const store = await import('@/lib/accounts/org-store');
    const joined = await store.joinByCode(
      {
        id: 'learner-new',
        username: 'learner-new',
        displayName: '新学员',
        role: 'learner',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      'JZ-TESTCODE',
    );
    expect(joined).toMatchObject({ ok: true, org: { id: 'org-a' } });
    const joinClientId = pg.clientQueries.find(
      ({ sql }) => sql.includes('SELECT org_id') && sql.includes('FROM org_invitations'),
    )?.clientId;
    expect(joinClientId).toBeDefined();
    const transaction = pg.clientQueries
      .filter(({ clientId }) => clientId === joinClientId)
      .map(({ sql }) => sql);
    const orgLock = transaction.findIndex(
      (sql) => sql.includes('FROM orgs') && sql.includes('FOR UPDATE'),
    );
    const invitationLock = transaction.findIndex(
      (sql) => sql.includes('FROM org_invitations') && sql.includes('FOR UPDATE'),
    );
    const memberWrite = transaction.findIndex((sql) => sql.includes('INSERT INTO org_members'));
    expect(transaction[0]).toBe('BEGIN');
    expect(orgLock).toBeGreaterThan(0);
    expect(invitationLock).toBeGreaterThan(orgLock);
    expect(transaction[invitationLock]).toContain('NOT disabled');
    expect(memberWrite).toBeGreaterThan(invitationLock);
    expect(transaction.at(-1)).toBe('COMMIT');
    expect(pg.release).toHaveBeenCalled();
  });

  it('邀请码事务的无效码、非学员和跨机构分支均回滚并释放连接', async () => {
    const store = await import('@/lib/accounts/org-store');
    await store.orgViewFor('owner-a');
    const clientsBefore = new Set(pg.clientQueries.map(({ clientId }) => clientId));
    const releasesBefore = pg.release.mock.calls.length;
    const account = (id: string, role: 'manager' | 'learner') => ({
      id,
      username: id,
      displayName: id,
      role,
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    await expect(
      store.joinByCode(account('learner-new', 'learner'), 'JZ-INVALID'),
    ).resolves.toEqual({
      ok: false,
      message: '邀请码无效或已失效',
    });
    await expect(store.joinByCode(account('owner-a', 'manager'), 'JZ-TESTCODE')).resolves.toEqual({
      ok: false,
      message: '只有学习者账户可以加入机构',
    });
    pg.orgs.set('org-b', {
      id: 'org-b',
      name: '乙方培训中心',
      owner_account_id: 'owner-b',
      created_at: '2026-09-01T00:00:00.000Z',
    });
    pg.invitations.set('org-b', 'JZ-OTHERCODE');
    await expect(
      store.joinByCode(account('learner-b', 'learner'), 'JZ-OTHERCODE'),
    ).resolves.toEqual({
      ok: false,
      message: '该账号已在机构「甲方培训中心」中，不能加入其他机构',
    });

    const failedTransactions = [...new Set(pg.clientQueries.map(({ clientId }) => clientId))]
      .filter((clientId) => !clientsBefore.has(clientId))
      .map((clientId) =>
        pg.clientQueries.filter((query) => query.clientId === clientId).map(({ sql }) => sql),
      );
    expect(failedTransactions).toHaveLength(3);
    expect(failedTransactions.every((queries) => queries.at(-1) === 'ROLLBACK')).toBe(true);
    expect(pg.release).toHaveBeenCalledTimes(releasesBefore + 3);
  });

  it('新归属只允许入库链建立，释放时只清理匹配的旧表行', async () => {
    const store = await import('@/lib/accounts/org-store');
    pg.corpusOwners.set('shared', 'org-a');

    expect(await store.setCorpusOrg('shared', 'org-a', 'org-a')).toEqual({
      ok: false,
      message: '知识库归属只由成功的入库任务建立',
    });
    expect(await store.setCorpusOrg('shared', null, 'org-b')).toEqual({ ok: true });
    expect(pg.corpusOwners.get('shared')).toBe('org-a');
    expect(await store.setCorpusOrg('shared', null, 'org-a')).toEqual({ ok: true });
    expect(pg.corpusOwners.has('shared')).toBe(false);

    const claims = pg.queries.filter((query) => query.sql.includes('INSERT INTO org_corpora'));
    expect(claims).toHaveLength(0);
    expect(
      pg.queries.filter((query) => query.sql.includes('DELETE FROM org_corpora')),
    ).toHaveLength(2);
  });

  it('建机构与轮换邀请码各自在单一 PoolClient 事务内完成', async () => {
    const store = await import('@/lib/accounts/org-store');
    const created = await store.createOrg(
      {
        id: 'owner-new',
        username: 'owner-new',
        displayName: '新管理者',
        role: 'manager',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      '新机构',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rotated = await store.rotateInviteCode(created.view.org.id, 'owner-new');
    expect(rotated).toMatch(/^JZ-/);

    const createWrite = pg.clientQueries.find(({ sql }) => sql.startsWith('INSERT INTO orgs'));
    const rotateWrite = [...pg.clientQueries]
      .reverse()
      .find(({ sql }) => sql.includes('UPDATE org_invitations SET disabled = true'));
    expect(createWrite).toBeDefined();
    expect(rotateWrite).toBeDefined();
    const createTransaction = pg.clientQueries.filter(
      ({ clientId }) => clientId === createWrite?.clientId,
    );
    const rotateTransaction = pg.clientQueries.filter(
      ({ clientId }) => clientId === rotateWrite?.clientId,
    );
    expect(createTransaction.map(({ sql }) => sql)).toEqual(
      expect.arrayContaining([
        'BEGIN',
        expect.stringContaining('INSERT INTO orgs'),
        expect.stringContaining('INSERT INTO org_members'),
        expect.stringContaining('INSERT INTO org_invitations'),
        'COMMIT',
      ]),
    );
    expect(rotateTransaction.map(({ sql }) => sql)).toEqual(
      expect.arrayContaining([
        'BEGIN',
        expect.stringContaining('UPDATE org_invitations SET disabled = true'),
        expect.stringContaining('INSERT INTO org_invitations'),
        'COMMIT',
      ]),
    );
    expect(pg.poolQueries).not.toContain('BEGIN');
    expect(pg.poolQueries).not.toContain('COMMIT');
  });
});
