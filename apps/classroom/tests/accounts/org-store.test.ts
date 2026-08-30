/**
 * 机构存储（文件后备）：建构、邀请码入组与轮换、成员移出、库归属与可见性。
 * 隔离主线的回归底线：A 机构的库对 B 机构学员必须不可见。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Account } from '@/lib/accounts/store';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'org-store-'));
  process.env.ACCOUNTS_DIR = dir;
  delete process.env.PERSISTENCE_DATABASE_URL;
  delete process.env.DATABASE_URL;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ACCOUNTS_DIR;
});

function acct(id: string, role: 'manager' | 'learner'): Account {
  return { id, username: id, displayName: id, role, createdAt: new Date().toISOString() };
}

describe('机构：建构与邀请码', () => {
  it('管理者建构即 owner，自带邀请码；一人一构', async () => {
    const store = await import('@/lib/accounts/org-store');
    const created = await store.createOrg(acct('mgr_a', 'manager'), '甲方培训中心');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.view.org.memberRole).toBe('owner');
    expect(created.view.inviteCode).toMatch(/^JZ-/);
    expect(created.view.memberCount).toBe(1);

    const again = await store.createOrg(acct('mgr_a', 'manager'), '第二个');
    expect(again.ok).toBe(false);
  });

  it('学员兑码入组幂等；换机构被拒；轮换后旧码作废', async () => {
    const store = await import('@/lib/accounts/org-store');
    const view = await store.orgViewFor('mgr_a');
    const code = view!.inviteCode!;

    const joined = await store.joinByCode(acct('stu_1', 'learner'), code.toLowerCase());
    expect(joined.ok).toBe(true);
    // 幂等：同码再兑直接成功
    expect((await store.joinByCode(acct('stu_1', 'learner'), code)).ok).toBe(true);

    // B 机构与跨机构限制
    await store.createOrg(acct('mgr_b', 'manager'), '乙方学院');
    const bView = await store.orgViewFor('mgr_b');
    const cross = await store.joinByCode(acct('stu_1', 'learner'), bView!.inviteCode!);
    expect(cross.ok).toBe(false);

    // 轮换后旧码失效、新码可用
    const org = await store.orgForAccount('mgr_a');
    const fresh = await store.rotateInviteCode(org!.id, 'mgr_a');
    expect((await store.joinByCode(acct('stu_2', 'learner'), code)).ok).toBe(false);
    expect((await store.joinByCode(acct('stu_2', 'learner'), fresh)).ok).toBe(true);
  });

  it('owner 不可被移出；成员移出后不再属于机构', async () => {
    const store = await import('@/lib/accounts/org-store');
    const org = await store.orgForAccount('mgr_a');
    expect((await store.removeMember(org!.id, 'mgr_a')).ok).toBe(false);
    expect((await store.removeMember(org!.id, 'stu_1')).ok).toBe(true);
    expect(await store.orgForAccount('stu_1')).toBeNull();
  });
});

describe('知识库归属与可见性（隔离底线）', () => {
  it('归属库仅本机构可见；公共库人人可见；他机构不可抢占', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const orgB = await store.orgForAccount('mgr_b');

    expect((await store.setCorpusOrg('iotdb', orgA!.id, orgA!.id)).ok).toBe(true);
    // B 抢占 A 已占的库：拒
    expect((await store.setCorpusOrg('iotdb', orgB!.id, orgB!.id)).ok).toBe(false);

    const forA = await store.corpusVisibilityFor('mgr_a');
    const forB = await store.corpusVisibilityFor('mgr_b');
    const forStu2 = await store.corpusVisibilityFor('stu_2'); // A 机构成员
    const forAnon = await store.corpusVisibilityFor(null);

    expect(forA('iotdb')).toBe(true);
    expect(forStu2('iotdb')).toBe(true);
    expect(forB('iotdb')).toBe(false);
    expect(forAnon('iotdb')).toBe(false);
    // 公共库（无归属行）对所有人可见
    for (const f of [forA, forB, forStu2, forAnon]) expect(f('ai')).toBe(true);

    // 释放后回归公共
    expect((await store.setCorpusOrg('iotdb', null, orgA!.id)).ok).toBe(true);
    const after = await store.corpusVisibilityFor('mgr_b');
    expect(after('iotdb')).toBe(true);
  });
});
