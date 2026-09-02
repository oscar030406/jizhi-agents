/**
 * 机构存储（文件后备）：建构、邀请码入组与轮换、成员移出、库归属与可见性。
 * 隔离主线的回归底线：A 机构的库对 B 机构学员必须不可见。
 */

import { promises as fs, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Account } from '@/lib/accounts/store';

let dir: string;
let previousGroundingUrl: string | undefined;
let previousGroundingToken: string | undefined;
let markerOwnership: Record<string, string> = {};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'org-store-'));
  process.env.ACCOUNTS_DIR = dir;
  delete process.env.PERSISTENCE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  previousGroundingUrl = process.env.GROUNDING_URL;
  previousGroundingToken = process.env.GROUNDING_TOKEN;
  process.env.GROUNDING_URL = 'http://engine.test';
  process.env.GROUNDING_TOKEN = 'test-token';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ ownership: markerOwnership }), { status: 200 }),
    ),
  );
  const now = '2026-09-01T00:00:00.000Z';
  const accounts = [
    ['mgr_a', 'mgr_a', 'manager'],
    ['mgr_b', 'mgr_b', 'manager'],
    ['stu_1', 'stu_1', 'learner'],
    ['stu_2', '学员乙', 'learner'],
    ['stu_3', '学员丙', 'learner'],
    ['stu_b', '学员丁', 'learner'],
    ['stu_race', '并发学员', 'learner'],
    ['stu_domain_race', '跨域并发学员', 'learner'],
    ['stu_legacy_target', '历史指派学员', 'learner'],
    ['stu_remove', '待移出学员', 'learner'],
    ['stu_orphan', '孤儿关系探针', 'learner'],
  ].map(([id, displayName, role]) => ({
    id,
    username: id,
    displayName,
    role,
    createdAt: now,
    password: 'unused',
    profile: null,
  }));
  writeFileSync(
    path.join(dir, 'accounts.json'),
    JSON.stringify({ accounts, sessions: [] }),
    'utf-8',
  );
});

afterEach(() => {
  markerOwnership = {};
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ACCOUNTS_DIR;
  vi.unstubAllGlobals();
  if (previousGroundingUrl === undefined) delete process.env.GROUNDING_URL;
  else process.env.GROUNDING_URL = previousGroundingUrl;
  if (previousGroundingToken === undefined) delete process.env.GROUNDING_TOKEN;
  else process.env.GROUNDING_TOKEN = previousGroundingToken;
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
    expect((await store.joinByCode(acct('mgr_b', 'manager'), code)).ok).toBe(false);

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
  it('引擎 marker 归属库仅本机构可见，公共库人人可见', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const orgB = await store.orgForAccount('mgr_b');

    markerOwnership = { iotdb: orgA!.id };
    expect((await store.setCorpusOrg('iotdb', orgA!.id, orgA!.id)).ok).toBe(false);
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

    // 引擎先释放 marker，账户层只清理旧表兼容行。
    markerOwnership = {};
    expect((await store.setCorpusOrg('iotdb', null, orgA!.id)).ok).toBe(true);
    const after = await store.corpusVisibilityFor('mgr_b');
    expect(after('iotdb')).toBe(true);
  });

  it('引擎 marker 与旧表冲突时显式阻断，不以后写覆盖', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const orgB = await store.orgForAccount('mgr_b');
    const file = path.join(dir, 'orgs.json');
    const original = readFileSync(file, 'utf-8');
    const db = JSON.parse(original) as { corpora: Array<Record<string, unknown>> };
    db.corpora.push({
      corpus: 'ownership-conflict',
      orgId: orgB!.id,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    writeFileSync(file, JSON.stringify(db, null, 1), 'utf-8');
    markerOwnership = { 'ownership-conflict': orgA!.id };
    try {
      await expect(store.corpusOwnership()).rejects.toThrow('引擎 marker 与旧表不一致');
    } finally {
      writeFileSync(file, original, 'utf-8');
    }
  });
});

describe('课程定向指派', () => {
  it('归档历史全体行，并按机构内学员隔离课程', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const orgB = await store.orgForAccount('mgr_b');
    expect(orgA).not.toBeNull();
    expect(orgB).not.toBeNull();

    const codeA = (await store.orgViewFor('mgr_a'))!.inviteCode!;
    const codeB = (await store.orgViewFor('mgr_b'))!.inviteCode!;
    expect((await store.joinByCode(acct('stu_3', 'learner'), codeA)).ok).toBe(true);
    expect((await store.joinByCode(acct('stu_b', 'learner'), codeB)).ok).toBe(true);

    // 旧版本没有 learnerAccountId；保留原始行，但不再广播给任何学员。
    const orgFile = path.join(dir, 'orgs.json');
    const legacyDb = JSON.parse(readFileSync(orgFile, 'utf-8')) as {
      assignments: Array<Record<string, unknown>>;
    };
    legacyDb.assignments.push({
      id: 'asg_legacy',
      orgId: orgA!.id,
      courseId: 'course-legacy',
      title: '历史全体课程',
      assignedBy: 'mgr_a',
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    writeFileSync(orgFile, JSON.stringify(legacyDb, null, 1), 'utf-8');

    expect(
      (await store.addAssignment(orgA!.id, 'course-ai', 'AI 课程', 'mgr_a', 'stu_2', 'ai')).ok,
    ).toBe(true);
    expect(
      (
        await store.addAssignment(
          orgA!.id,
          'course-mfg',
          '智能制造课程',
          'mgr_a',
          'stu_3',
          'smart-manufacturing',
        )
      ).ok,
    ).toBe(true);
    expect(
      (await store.addAssignment(orgB!.id, 'course-b', '乙方课程', 'mgr_b', 'stu_b', 'ai')).ok,
    ).toBe(true);

    const ownerA = await store.assignmentsOf(orgA!.id);
    expect(ownerA).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          courseId: 'course-ai',
          learnerAccountId: 'stu_2',
          learnerDisplayName: '学员乙',
        }),
        expect.objectContaining({
          courseId: 'course-mfg',
          learnerAccountId: 'stu_3',
          learnerDisplayName: '学员丙',
        }),
      ]),
    );
    expect(ownerA.some((assignment) => assignment.id === 'asg_legacy')).toBe(false);

    expect((await store.assignmentsOf(orgA!.id, 'stu_2')).map((a) => a.courseId)).toEqual([
      'course-ai',
    ]);
    expect((await store.assignmentsOf(orgA!.id, 'stu_3')).map((a) => a.courseId)).toEqual([
      'course-mfg',
    ]);
    expect((await store.assignmentsOf(orgB!.id, 'stu_b')).map((a) => a.courseId)).toEqual([
      'course-b',
    ]);
    const preserved = JSON.parse(readFileSync(orgFile, 'utf-8')) as {
      assignments: Array<{ id: string; learnerAccountId?: string | null }>;
    };
    expect(preserved.assignments.find((assignment) => assignment.id === 'asg_legacy')).toEqual(
      expect.objectContaining({ id: 'asg_legacy' }),
    );
  });

  it('并发重复指派幂等，成员移出与指派竞态不留悬空行', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const codeA = (await store.orgViewFor('mgr_a'))!.inviteCode!;
    expect((await store.joinByCode(acct('stu_race', 'learner'), codeA)).ok).toBe(true);

    const duplicated = await Promise.all([
      store.addAssignment(orgA!.id, 'course-race', '并发课程', 'mgr_a', 'stu_race', 'ai'),
      store.addAssignment(orgA!.id, 'course-race', '并发课程', 'mgr_a', 'stu_race', 'ai'),
    ]);
    expect(duplicated.every((result) => result.ok)).toBe(true);
    expect(new Set(duplicated.map((result) => (result.ok ? result.assignment.id : ''))).size).toBe(
      1,
    );
    expect(
      (await store.assignmentsOf(orgA!.id, 'stu_race')).filter(
        (assignment) => assignment.courseId === 'course-race',
      ),
    ).toHaveLength(1);

    const [, attempted] = await Promise.all([
      store.removeMember(orgA!.id, 'stu_race'),
      store.addAssignment(orgA!.id, 'course-after-remove', '移出后课程', 'mgr_a', 'stu_race', 'ai'),
    ]);
    expect(attempted.ok).toBe(false);
    expect(await store.assignmentsOf(orgA!.id, 'stu_race')).toEqual([]);
  });

  it('同一学员并发收到两个领域时只落盘一个领域', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const codeA = (await store.orgViewFor('mgr_a'))!.inviteCode!;
    expect((await store.joinByCode(acct('stu_domain_race', 'learner'), codeA)).ok).toBe(true);

    const results = await Promise.all([
      store.addAssignment(orgA!.id, 'course-ai-race', 'AI 课程', 'mgr_a', 'stu_domain_race', 'ai'),
      store.addAssignment(
        orgA!.id,
        'course-mfg-race',
        '智能制造课程',
        'mgr_a',
        'stu_domain_race',
        'smart-manufacturing',
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('其他领域') }),
    ]);
    const persisted = await store.assignmentsOf(orgA!.id, 'stu_domain_race');
    expect(persisted).toHaveLength(1);
    expect(new Set(persisted.map((assignment) => assignment.domain)).size).toBe(1);
  });

  it('迁移前定向指派没有领域时明确阻断新指派', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const codeA = (await store.orgViewFor('mgr_a'))!.inviteCode!;
    expect((await store.joinByCode(acct('stu_legacy_target', 'learner'), codeA)).ok).toBe(true);
    const orgFile = path.join(dir, 'orgs.json');
    const db = JSON.parse(readFileSync(orgFile, 'utf-8')) as {
      assignments: Array<Record<string, unknown>>;
    };
    db.assignments.push({
      id: 'asg_legacy_target',
      orgId: orgA!.id,
      courseId: 'course-legacy-target',
      title: '旧定向课程',
      assignedBy: 'mgr_a',
      learnerAccountId: 'stu_legacy_target',
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    writeFileSync(orgFile, JSON.stringify(db, null, 1), 'utf-8');

    expect(
      await store.addAssignment(
        orgA!.id,
        'course-new',
        '新课程',
        'mgr_a',
        'stu_legacy_target',
        'ai',
      ),
    ).toEqual({
      ok: false,
      message: '该学员现有指派缺少领域，请先撤回后重新指派',
    });
  });

  it('拒绝把课程指派给跨机构账户或机构 owner', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');

    expect(
      (await store.addAssignment(orgA!.id, 'course-cross', '越界课程', 'mgr_a', 'stu_b', 'ai')).ok,
    ).toBe(false);
    expect(
      (await store.addAssignment(orgA!.id, 'course-owner', '所有者课程', 'mgr_a', 'mgr_a', 'ai'))
        .ok,
    ).toBe(false);
  });

  it('移出成员时删除其全部定向指派，但不删除已归档的历史行', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const codeA = (await store.orgViewFor('mgr_a'))!.inviteCode!;
    expect((await store.joinByCode(acct('stu_remove', 'learner'), codeA)).ok).toBe(true);
    expect(
      (
        await store.addAssignment(
          orgA!.id,
          'course-remove',
          '待清理课程',
          'mgr_a',
          'stu_remove',
          'ai',
        )
      ).ok,
    ).toBe(true);

    expect((await store.removeMember(orgA!.id, 'stu_remove')).ok).toBe(true);
    const ownerView = await store.assignmentsOf(orgA!.id);
    expect(ownerView.some((assignment) => assignment.learnerAccountId === 'stu_remove')).toBe(
      false,
    );
    expect(ownerView.some((assignment) => assignment.id === 'asg_legacy')).toBe(false);
    const persisted = JSON.parse(readFileSync(path.join(dir, 'orgs.json'), 'utf-8')) as {
      assignments: Array<{ id: string }>;
    };
    expect(persisted.assignments.some((assignment) => assignment.id === 'asg_legacy')).toBe(true);
  });
});

describe('文件持久化失败保护', () => {
  it('旧邀请码指向不存在机构时拒绝写入，不产生孤儿成员', async () => {
    const store = await import('@/lib/accounts/org-store');
    const file = path.join(dir, 'orgs.json');
    const original = readFileSync(file, 'utf-8');
    const db = JSON.parse(original) as {
      invitations: Array<Record<string, unknown>>;
      members: Array<{ accountId: string }>;
    };
    db.invitations.push({
      code: 'JZ-ORPHAN01',
      orgId: 'org-missing',
      createdBy: 'mgr_a',
      disabled: false,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    writeFileSync(file, JSON.stringify(db, null, 1), 'utf-8');
    try {
      expect((await store.joinByCode(acct('stu_orphan', 'learner'), 'JZ-ORPHAN01')).ok).toBe(false);
      const after = JSON.parse(readFileSync(file, 'utf-8')) as {
        members: Array<{ accountId: string }>;
      };
      expect(after.members.some((member) => member.accountId === 'stu_orphan')).toBe(false);
    } finally {
      writeFileSync(file, original, 'utf-8');
    }
  });

  it('JSON 解析失败时阻止认领写入，并保留原文件', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const file = path.join(dir, 'orgs.json');
    const original = readFileSync(file, 'utf-8');
    writeFileSync(file, '{broken', 'utf-8');
    try {
      await expect(store.setCorpusOrg('parse-error', null, orgA!.id)).rejects.toBeInstanceOf(
        SyntaxError,
      );
      expect(readFileSync(file, 'utf-8')).toBe('{broken');
    } finally {
      writeFileSync(file, original, 'utf-8');
    }
  });

  it('非 ENOENT 的读取错误直接上抛且不写文件', async () => {
    const store = await import('@/lib/accounts/org-store');
    const orgA = await store.orgForAccount('mgr_a');
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(denied);
    const write = vi.spyOn(fs, 'writeFile');
    try {
      await expect(store.setCorpusOrg('io-error', null, orgA!.id)).rejects.toBe(denied);
      expect(write).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});
