/**
 * 管理端知识库 Server Component 的机构隔离。
 *
 * 总览不能把他机构私有库渲染成卡片，详情路由更不能先读盘再隐藏；跨机构点名访问
 * 必须在 readCorpus/readSourceView 之前走 notFound。
 */

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  account: { id: 'manager-a', role: 'manager' } as { id: string; role: string } | null,
  readCorpus: vi.fn(),
  readSourceView: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

const ownership: Record<string, string> = {
  'private-a': 'org-a',
  'private-b': 'org-b',
};

const accountOrgs: Record<string, string> = {
  'manager-a': 'org-a',
  'manager-b': 'org-b',
};

function visibleTo(accountId: string | null, corpus: string) {
  const owner = ownership[corpus];
  return !owner || (accountId !== null && accountOrgs[accountId] === owner);
}

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/app/admin/knowledge/guard', () => ({
  managerAccount: async () => mocks.account,
  Denied: () => <div>denied</div>,
}));

vi.mock('@/lib/accounts/org-store', () => ({
  corpusVisibilityFor: async (accountId: string | null) => (corpus: string) =>
    visibleTo(accountId, corpus),
}));

vi.mock('@/lib/server/knowledge-center', () => ({
  isValidCorpusName: (corpus: string) => /^[a-z0-9-]+$/.test(corpus),
  readCorporaWithDrift: async (visible: (corpus: string) => boolean = () => true) => ({
    corpora: [
      { corpus: 'public-corpus', available: true },
      { corpus: 'private-a', available: true },
      { corpus: 'private-b', available: true },
    ].filter((row) => visible(row.corpus)),
    drift: [],
  }),
  readCorpus: mocks.readCorpus,
}));

vi.mock('@/lib/server/knowledge-source', () => ({
  readSourceView: mocks.readSourceView,
}));

vi.mock('@/lib/server/domain-registry', () => ({ readDomainRegistry: async () => ({}) }));
vi.mock('@/lib/knowledge/domain-labels', () => ({
  domainLabel: (corpus: string) => corpus,
  hasDomainLabel: () => false,
}));

vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('@/components/home/section-anchor', () => ({ SectionAnchor: () => null }));
vi.mock('@/components/admin/caliber', () => ({
  Caliber: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/admin/knowledge-center', () => ({
  CorpusCard: ({ corpus }: { corpus: { corpus: string } }) => <div>{corpus.corpus}</div>,
  FitnessLight: () => null,
  StationRow: () => null,
  stamp: () => null,
}));
vi.mock('@/components/admin/knowledge-source', () => ({ SourceFilesPanel: () => null }));
vi.mock('@/components/admin/corpus-preview-button', () => ({ CorpusPreviewButton: () => null }));
vi.mock('@/components/admin/practice-scout-panel', () => ({ PracticeScoutPanel: () => null }));
vi.mock('@/app/admin/knowledge/start-intake', () => ({ StartIntake: () => null }));

import KnowledgeCenterPage from '@/app/admin/knowledge/page';
import CorpusDetailPage from '@/app/admin/knowledge/[corpus]/page';

function corpusRow(corpus: string) {
  return {
    corpus,
    available: true,
    chunks: 1,
    backend: 'tfidf',
    scope: null,
    license: null,
    concepts: null,
    clauses: null,
    gates: null,
    fitness: null,
    goldFiles: null,
    indexPath: `/engine/${corpus}/knowledge_index.jsonl`,
    updatedAt: null,
    stations: [],
  };
}

describe('管理端知识库页面的机构读隔离', () => {
  beforeEach(() => {
    mocks.account = { id: 'manager-a', role: 'manager' };
    mocks.notFound.mockClear();
    mocks.readCorpus.mockReset();
    mocks.readSourceView.mockReset();
    mocks.readCorpus.mockImplementation(async (corpus: string) => corpusRow(corpus));
    mocks.readSourceView.mockResolvedValue(null);
  });

  it('总览渲染公共库和本机构私有库，不渲染他机构私有库', async () => {
    const html = renderToStaticMarkup(await KnowledgeCenterPage());

    expect(html).toContain('public-corpus');
    expect(html).toContain('private-a');
    expect(html).not.toContain('private-b');
  });

  it.each(['public-corpus', 'private-a'])('%s 的详情对 A 机构 manager 可见', async (corpus) => {
    await expect(CorpusDetailPage({ params: Promise.resolve({ corpus }) })).resolves.toBeTruthy();
    expect(mocks.readCorpus).toHaveBeenCalledWith(corpus);
  });

  it('他机构私有库详情 404，且不读取库详情或原件清单', async () => {
    await expect(
      CorpusDetailPage({ params: Promise.resolve({ corpus: 'private-b' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mocks.readCorpus).not.toHaveBeenCalled();
    expect(mocks.readSourceView).not.toHaveBeenCalled();
  });

  it('非 manager 仍显示原有拒绝页，不读取语料', async () => {
    mocks.account = null;

    expect(renderToStaticMarkup(await KnowledgeCenterPage())).toContain('denied');
    expect(mocks.readCorpus).not.toHaveBeenCalled();
    expect(mocks.readSourceView).not.toHaveBeenCalled();
  });
});
