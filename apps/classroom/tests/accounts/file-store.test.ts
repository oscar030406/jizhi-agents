import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  accountForSession,
  accountsEnabled,
  authenticate,
  createAccount,
  createSession,
  destroySession,
  readProfile,
  writeProfile,
} from '@/lib/accounts/store';

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-'));
  process.env.ACCOUNTS_DIR = dir;
  delete process.env.PERSISTENCE_DATABASE_URL;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  delete process.env.ACCOUNTS_DIR;
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
});
