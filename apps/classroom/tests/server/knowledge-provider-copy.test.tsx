import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  corpora: [] as Array<Record<string, unknown>>,
  corpus: null as null | Record<string, unknown>,
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => <header>集智</header> }));
vi.mock('@/components/admin/caliber', () => ({
  Caliber: ({ summary, children }: { summary: string; children: ReactNode }) => (
    <section>
      <h3>{summary}</h3>
      {children}
    </section>
  ),
}));
vi.mock('@/components/admin/knowledge-center', () => ({
  CorpusCard: ({ corpus }: { corpus: { corpus: string } }) => <article>{corpus.corpus}</article>,
  FitnessLight: () => <div>素材状态</div>,
  StationRow: () => <li>系统已接收</li>,
  stamp: () => '2026-08-31 10:20:00 UTC',
}));
vi.mock('@/components/admin/knowledge-source', () => ({
  SourceFilesPanel: () => <section>原件可查看</section>,
}));
vi.mock('@/components/admin/corpus-preview-button', () => ({
  CorpusPreviewButton: () => <button type="button">预览学习端</button>,
}));
vi.mock('@/components/admin/practice-scout-panel', () => ({
  PracticeScoutPanel: () => <section>实操项目</section>,
}));
vi.mock('@/components/home/section-anchor', () => ({ SectionAnchor: () => null }));
vi.mock('@/app/admin/knowledge/start-intake', () => ({ StartIntake: () => <form>接入表单</form> }));
vi.mock('@/app/admin/knowledge/guard', () => ({
  managerAccount: async () => ({ id: 'manager', role: 'manager' }),
  Denied: () => <div>拒绝访问</div>,
}));
vi.mock('@/lib/accounts/org-store', () => ({ corpusVisibilityFor: async () => () => true }));
vi.mock('@/lib/server/domain-registry', () => ({ readDomainRegistry: async () => ({}) }));
vi.mock('@/lib/server/knowledge-center', () => ({
  isValidCorpusName: () => true,
  readCorpora: async () => mocks.corpora,
  readCorpus: async () => mocks.corpus,
}));
vi.mock('@/lib/server/knowledge-source', () => ({ readSourceView: async () => null }));

import CorpusDetailPage from '@/app/admin/knowledge/[corpus]/page';
import KnowledgeCenterPage from '@/app/admin/knowledge/page';

describe('知识库页面的提供方文案', () => {
  beforeEach(() => {
    mocks.corpora = [];
    mocks.corpus = null;
    mocks.notFound.mockClear();
  });

  it('总览空态让用户刷新或联系平台，不让用户检查服务器', async () => {
    const html = renderToStaticMarkup(await KnowledgeCenterPage());

    expect(html).toContain('联系平台维护人员');
    expect(html).toContain('不展示旧数据');
    expect(html).not.toMatch(/服务器上|本站运维|mtime|data[\\/]|knowledge_base[\\/]/i);
  });

  it('总览过滤 probe/fullprobe 测试库', async () => {
    mocks.corpora = [
      { corpus: 'fullprobe', available: true },
      { corpus: 'probe_fixture', available: true },
      { corpus: 'iotdb', available: true },
    ];
    const html = renderToStaticMarkup(await KnowledgeCenterPage());

    expect(html).toContain('iotdb');
    expect(html).not.toMatch(/fullprobe|probe_fixture/i);
  });

  it('详情保留真实状态与页面核验入口，不展示内部文件位置', async () => {
    mocks.corpus = {
      corpus: 'iotdb',
      scope: '工业时序数据库',
      updatedAt: '2026-08-31T10:20:00.000Z',
      chunks: 42,
      backend: 'tfidf',
      stations: [],
      gates: null,
      concepts: null,
      license: null,
      fitness: null,
    };

    const html = renderToStaticMarkup(
      await CorpusDetailPage({ params: Promise.resolve({ corpus: 'iotdb' }) }),
    );

    expect(html).toContain('最近处理时间');
    expect(html).toContain('系统已经收到');
    expect(html).toContain('联系平台维护人员');
    expect(html).not.toMatch(
      /服务器上|本站运维|mtime|data[\\/]|knowledge_base[\\/]|source_dir|source_id|front-matter|磁盘|复算/i,
    );
  });

  it('详情路由拒绝渲染 probe 测试库', async () => {
    await expect(
      CorpusDetailPage({ params: Promise.resolve({ corpus: 'fullpath-probe' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
