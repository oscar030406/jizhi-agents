import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountForSession,
  accountsEnabled,
  authenticate,
  authenticateAndCreateSession,
  createAccount,
  createSession,
  deleteAccount,
  destroySession,
  exportAccountData,
  readProfile,
  resetPassword,
  writeProfile,
} from '@/lib/accounts/store';
import {
  addAssignment,
  assignmentsOf,
  createOrg,
  joinByCode,
  membersOf,
  orgForAccount,
  setCorpusOrg,
} from '@/lib/accounts/org-store';

/**
 * 账户的文件后备存储：没配 PostgreSQL 时登录与管理端也要能用。
 *
 * 背景（2026-08-14）：本地 `.env.local` 的 `PERSISTENCE_DATABASE_URL` 注释着，
 * 原实现 `accountsEnabled()` 因此返回 false，整套登录 UI 隐藏——**本机根本
 * 看不到登录入口，按 role 门禁的管理端永远进不去**。文件后备补的就是这条路。
 *
 * 这批测试跑在「无数据库」环境（测试进程本来就没配 URL），走的就是文件后端，
 * 不用 mock。`ACCOUNTS_DIR` 指到临时目录，测试互不污染、不碰 `data/accounts/`。
 */

let dir: string;
let markerOwnership: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-'));
  process.env.ACCOUNTS_DIR = dir;
  delete process.env.PERSISTENCE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.GROUNDING_URL = 'http://engine.test';
  process.env.GROUNDING_TOKEN = 'test-token';
  markerOwnership = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ ownership: markerOwnership }), { status: 200 }),
    ),
  );
});

afterEach(() => {
  delete process.env.ACCOUNTS_DIR;
  delete process.env.GROUNDING_URL;
  delete process.env.GROUNDING_TOKEN;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('无数据库时账户系统照常可用', () => {
  it('accountsEnabled 恒为 true——登录入口不再因为没配库而隐藏', () => {
    expect(accountsEnabled()).toBe(true);
  });

  it('注册 → 登录 → 会话 → 登出 全链路', async () => {
    const created = await createAccount('teacher01', 'pass123456', 'manager');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.account.role).toBe('manager');

    // 密码对才放行；错的拿不到账户而不是报错
    expect(await authenticate('teacher01', 'wrong12345')).toBeNull();
    const authed = await authenticate('teacher01', 'pass123456');
    expect(authed?.id).toBe(created.account.id);

    const { token } = await createSession(created.account.id);
    const bySession = await accountForSession(token);
    expect(bySession?.username).toBe('teacher01');
    expect(bySession?.role).toBe('manager');

    await destroySession(token);
    expect(await accountForSession(token)).toBeNull();
  });

  it('用户名不区分大小写去重——两个后端同一口径', async () => {
    expect((await createAccount('Alice', 'pass123456')).ok).toBe(true);
    const dup = await createAccount('alice', 'other123456');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.message).toContain('占用');
    // 登录同样不区分大小写
    expect(await authenticate('ALICE', 'pass123456')).not.toBeNull();
  });

  it('非法角色落回 learner，不落库一个未知角色', async () => {
    const created = await createAccount('bob01', 'pass123456', 'admin' as never);
    expect(created.ok && created.account.role).toBe('learner');
  });

  it('档案随账户走：写入后读回同一份', async () => {
    const created = await createAccount('carol01', 'pass123456');
    if (!created.ok) throw new Error('unreachable');
    expect(await readProfile(created.account.id)).toBeNull();
    await writeProfile(created.account.id, { domain: 'ai', education: '本科' });
    expect(await readProfile(created.account.id)).toEqual({ domain: 'ai', education: '本科' });
  });

  it('数据真的落了盘：换一次“进程”（重新读文件）账户还在', async () => {
    const created = await createAccount('dave01', 'pass123456', 'manager');
    if (!created.ok) throw new Error('unreachable');
    const { token } = await createSession(created.account.id);
    // 文件后端无进程内缓存，每次操作都重读文件——这里再查一遍等价于重启后查
    expect((await accountForSession(token))?.username).toBe('dave01');
    expect((await authenticate('dave01', 'pass123456'))?.role).toBe('manager');
  });

  it('并发注册不互相覆盖——写入走队列', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createAccount(`user${i}x`, 'pass123456')),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    // 全部都能登录，说明没有一次写覆盖掉另一次
    for (let i = 0; i < 8; i += 1) {
      expect(await authenticate(`user${i}x`, 'pass123456')).not.toBeNull();
    }
  });

  it('过期会话在下一次账户请求时从服务端文件清理', async () => {
    const created = await createAccount('expired01', 'pass123456');
    if (!created.ok) throw new Error('unreachable');
    const { token } = await createSession(created.account.id);
    const file = join(dir, 'accounts.json');
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as {
      sessions: Array<{ expiresAt: string }>;
    };
    stored.sessions[0].expiresAt = '2000-01-01T00:00:00.000Z';
    writeFileSync(file, JSON.stringify(stored), 'utf-8');

    expect(await accountForSession(token)).toBeNull();
    expect((JSON.parse(readFileSync(file, 'utf-8')) as { sessions: unknown[] }).sessions).toEqual(
      [],
    );
  });

  it('重置密码与删除全部旧会话在同一文件临界区落盘', async () => {
    const created = await createAccount('reset01', 'oldpass123');
    if (!created.ok) throw new Error('unreachable');
    const first = await createSession(created.account.id);
    const second = await createSession(created.account.id);

    expect(await resetPassword(created.account.id, 'newpass123')).toEqual({ ok: true });
    expect(await authenticate('reset01', 'oldpass123')).toBeNull();
    expect(await authenticate('reset01', 'newpass123')).not.toBeNull();
    expect(await accountForSession(first.token)).toBeNull();
    expect(await accountForSession(second.token)).toBeNull();
  });

  it('旧密码登录与密码重置并发时不会留下可用旧凭据会话', async () => {
    const created = await createAccount('resetRace', 'oldpass123');
    if (!created.ok) throw new Error('unreachable');

    const [login] = await Promise.all([
      authenticateAndCreateSession('resetRace', 'oldpass123', 'learner'),
      resetPassword(created.account.id, 'newpass123'),
    ]);

    if (login?.kind === 'success') {
      expect(await accountForSession(login.token)).toBeNull();
    }
    expect(await authenticate('resetRace', 'oldpass123')).toBeNull();
    expect(await authenticate('resetRace', 'newpass123')).not.toBeNull();
  });

  it('导出不含密码与 token，删成员账户同时清会话、档案、机构关系和指派', async () => {
    const owner = await createAccount('owner01', 'pass123456', 'manager');
    const learner = await createAccount('learner01', 'pass654321', 'learner');
    if (!owner.ok || !learner.ok) throw new Error('unreachable');
    const org = await createOrg(owner.account, '甲方培训中心');
    if (!org.ok || !org.view.inviteCode) throw new Error('unreachable');
    expect(await joinByCode(learner.account, org.view.inviteCode)).toMatchObject({ ok: true });
    expect(
      await addAssignment(
        org.view.org.id,
        'course-ai',
        '人工智能基础',
        owner.account.id,
        learner.account.id,
        'ai',
      ),
    ).toMatchObject({ ok: true });
    await writeProfile(learner.account.id, { domain: 'ai', goal: '系统学习人工智能' });
    const { token } = await createSession(learner.account.id);

    const exported = await exportAccountData(learner.account);
    expect(exported.organization).toMatchObject({
      organization: { name: '甲方培训中心', role: 'member' },
      assignmentsReceived: [{ courseId: 'course-ai', title: '人工智能基础' }],
    });
    expect(exported.profile.profiles[0].fields).toMatchObject({ domain: 'ai' });
    expect(exported.serverLearningData).toEqual({
      configured: false,
      runtimeSessions: [],
      documents: [],
    });
    expect(JSON.stringify(exported)).not.toContain('pass654321');
    expect(JSON.stringify(exported)).not.toContain(token);
    expect(JSON.stringify(exported)).not.toContain(owner.account.id);

    expect(await deleteAccount(learner.account.id)).toEqual({ ok: true });
    expect(await authenticate('learner01', 'pass654321')).toBeNull();
    expect(await accountForSession(token)).toBeNull();
    expect((await membersOf(org.view.org.id)).map((member) => member.accountId)).toEqual([
      owner.account.id,
    ]);
    expect(await assignmentsOf(org.view.org.id)).toEqual([]);
  });

  it('机构 owner 仍有成员时拒绝删户；成员清空后可删且不留机构孤儿', async () => {
    const owner = await createAccount('owner02', 'pass123456', 'manager');
    const learner = await createAccount('learner02', 'pass654321', 'learner');
    if (!owner.ok || !learner.ok) throw new Error('unreachable');
    const org = await createOrg(owner.account, '乙方智造学院');
    if (!org.ok || !org.view.inviteCode) throw new Error('unreachable');
    await joinByCode(learner.account, org.view.inviteCode);

    expect(await deleteAccount(owner.account.id)).toMatchObject({
      ok: false,
      code: 'owner_has_members',
    });
    expect(await authenticate('owner02', 'pass123456')).not.toBeNull();

    expect(await deleteAccount(learner.account.id)).toEqual({ ok: true });
    expect(await deleteAccount(owner.account.id)).toEqual({ ok: true });
    expect(await orgForAccount(owner.account.id)).toBeNull();
    expect(await authenticate('owner02', 'pass123456')).toBeNull();
  });

  it('owner 有私库时 409 语义阻断，归属服务不可用时也不删除', async () => {
    const owner = await createAccount('owner03', 'pass123456', 'manager');
    if (!owner.ok) throw new Error('unreachable');
    const org = await createOrg(owner.account, '私库机构');
    if (!org.ok) throw new Error('unreachable');
    markerOwnership = { 'private-ai': org.view.org.id };
    expect(await deleteAccount(owner.account.id)).toMatchObject({
      ok: false,
      code: 'owner_has_corpora',
    });
    expect(await authenticate('owner03', 'pass123456')).not.toBeNull();

    markerOwnership = {};
    expect(await setCorpusOrg('private-ai', null, org.view.org.id)).toEqual({ ok: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('engine unavailable');
      }),
    );
    expect(await deleteAccount(owner.account.id)).toMatchObject({
      ok: false,
      code: 'ownership_unavailable',
    });
    expect(await authenticate('owner03', 'pass123456')).not.toBeNull();
  });

  it('删户与入组、指派并发时不留下已删除账户的机构关系', async () => {
    const owner = await createAccount('owner04', 'pass123456', 'manager');
    const first = await createAccount('race01', 'pass123456', 'learner');
    const second = await createAccount('race02', 'pass123456', 'learner');
    if (!owner.ok || !first.ok || !second.ok) throw new Error('unreachable');
    const org = await createOrg(owner.account, '并发机构');
    if (!org.ok || !org.view.inviteCode) throw new Error('unreachable');
    await joinByCode(first.account, org.view.inviteCode);
    await joinByCode(second.account, org.view.inviteCode);

    await Promise.all([
      addAssignment(
        org.view.org.id,
        'course-before-delete',
        '删除前指派',
        owner.account.id,
        first.account.id,
        'ai',
      ),
      joinByCode(first.account, org.view.inviteCode),
      deleteAccount(first.account.id),
    ]);
    await Promise.all([
      deleteAccount(second.account.id),
      joinByCode(second.account, org.view.inviteCode),
      addAssignment(
        org.view.org.id,
        'course-after-delete',
        '删除后指派',
        owner.account.id,
        second.account.id,
        'ai',
      ),
    ]);

    const persisted = JSON.parse(readFileSync(join(dir, 'orgs.json'), 'utf-8')) as {
      members: Array<{ accountId: string }>;
      assignments: Array<{ learnerAccountId?: string | null }>;
    };
    for (const accountId of [first.account.id, second.account.id]) {
      expect(await orgForAccount(accountId)).toBeNull();
      expect(persisted.members.some((member) => member.accountId === accountId)).toBe(false);
      expect(
        persisted.assignments.some((assignment) => assignment.learnerAccountId === accountId),
      ).toBe(false);
    }
  });

  it('账户文件损坏时显式失败，不回退成空库', async () => {
    writeFileSync(join(dir, 'accounts.json'), '{broken', 'utf-8');
    await expect(authenticate('alice', 'pass123456')).rejects.toBeInstanceOf(SyntaxError);
  });
});
