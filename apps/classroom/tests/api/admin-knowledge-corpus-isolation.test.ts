/**
 * 管理端知识库只读 API 的机构隔离。
 *
 * 角色闸与机构闸是两件事：非 manager 仍按原口径 403；已经通过角色闸的 manager
 * 只能列出公共库和本机构私有库，点名读取他机构私有库时用 404 隐去存在性。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  accountsEnabled: true,
  account: { id: 'manager-a', role: 'manager' } as { id: string; role: string } | null,
  readSourceFile: vi.fn(),
}));

const ownership: Record<string, string> = {
  'private-a': 'org-a',
  'private-b': 'org-b',
};

const accountOrgs: Record<string, string> = {
  'manager-a': 'org-a',
  'manager-b': 'org-b',
};

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'session-token' }) }),
}));

vi.mock('@/lib/accounts/store', () => ({
  accountsEnabled: () => mocks.accountsEnabled,
  accountForSession: async () => mocks.account,
}));

vi.mock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'session' }));

vi.mock('@/lib/accounts/org-store', () => ({
  corpusVisibilityFor: async (accountId: string | null) => (corpus: string) => {
    const owner = ownership[corpus];
    return !owner || (accountId !== null && accountOrgs[accountId] === owner);
  },
}));

vi.mock('@/lib/server/knowledge-center', () => ({
  readCorpora: async () => [
    { corpus: 'public-corpus' },
    { corpus: 'private-a' },
    { corpus: 'private-b' },
  ],
}));

vi.mock('@/lib/server/knowledge-source', () => ({
  readSourceFile: mocks.readSourceFile,
}));

import { GET as listCorpora } from '@/app/api/knowledge/corpora/route';
import { GET as readCorpusSource } from '@/app/api/knowledge/corpora/[corpus]/source/route';

function sourceRequest(corpus: string) {
  return readCorpusSource(
    {
      nextUrl: new URL(`http://localhost/api/knowledge/corpora/${corpus}/source?file=guide.md`),
    } as NextRequest,
    { params: Promise.resolve({ corpus }) },
  );
}

describe('管理端知识库 API 的机构读隔离', () => {
  beforeEach(() => {
    mocks.accountsEnabled = true;
    mocks.account = { id: 'manager-a', role: 'manager' };
    mocks.readSourceFile.mockReset();
    mocks.readSourceFile.mockResolvedValue({ path: 'guide.md', text: 'engine-derived' });
  });

  it('列表只返回公共库和本机构私有库', async () => {
    const response = await listCorpora();
    const body = (await response.json()) as { corpora: Array<{ corpus: string }> };

    expect(response.status).toBe(200);
    expect(body.corpora.map((row) => row.corpus)).toEqual(['public-corpus', 'private-a']);
  });

  it.each(['public-corpus', 'private-a'])('%s 的原件可由 A 机构 manager 读取', async (corpus) => {
    const response = await sourceRequest(corpus);

    expect(response.status).toBe(200);
    expect(mocks.readSourceFile).toHaveBeenCalledWith(corpus, 'guide.md');
  });

  it('他机构私有库原件返回 404，且不触碰磁盘读取', async () => {
    const response = await sourceRequest('private-b');

    expect(response.status).toBe(404);
    expect(mocks.readSourceFile).not.toHaveBeenCalled();
  });

  it.each([
    ['anonymous', null],
    ['learner', { id: 'learner-a', role: 'learner' }],
  ])('%s 仍按原角色闸拒绝', async (_label, account) => {
    mocks.account = account;

    expect((await listCorpora()).status).toBe(403);
    expect((await sourceRequest('public-corpus')).status).toBe(403);
    expect(mocks.readSourceFile).not.toHaveBeenCalled();
  });
});
