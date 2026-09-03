import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  payload: null as null | Record<string, unknown>,
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => <header>集智</header> }));
vi.mock('@/app/admin/knowledge/guard', () => ({
  managerAccount: async () => ({ id: 'manager', role: 'manager' }),
  Denied: () => <div>拒绝访问</div>,
}));
vi.mock('@/components/admin/intake-run-view', () => ({
  IntakeRunView: ({ record }: { record: { corpus: string } }) => <div>{record.corpus}</div>,
}));
vi.mock('@/lib/server/domain-registry', () => ({ readDomainRegistry: async () => ({}) }));
vi.mock('@/lib/accounts/org-store', () => ({
  orgForAccount: async () => ({ id: 'org-a' }),
}));
vi.mock('@/lib/server/intake-runs', () => ({
  RUNS_DIR_LABEL: 'data/knowledge_base/intake_runs/',
  isValidRunId: () => true,
  listRuns: async (
    limit: number,
    ownerOrgId?: string | null,
    display: (run: Record<string, unknown>) => boolean = () => true,
  ) =>
    mocks.runs
      .filter((run) => !run.ownerOrgId || run.ownerOrgId === ownerOrgId)
      .filter(display)
      .slice(0, limit),
  readRunEvents: async () => mocks.payload,
  runVisibleTo: (owner: string | null | undefined, orgId: string | null) =>
    !owner || owner === orgId,
}));

import IntakeRunsPage from '@/app/admin/knowledge/runs/page';
import IntakeRunPage from '@/app/admin/knowledge/runs/[runId]/page';

function run(corpus: string, ownerOrgId = 'org-a') {
  return {
    runId: `20260831T120000-${corpus}`,
    corpus,
    ownerOrgId,
    scope: '课程资料',
    status: 'done',
    createdAt: '2026-08-31T12:00:00',
    files: 2,
    durationMs: 1000,
    stageCounts: { done: 5, failed: 0, skipped: 0, pending: 0 },
    error: 'failed at data/knowledge_base/fullprobe/run.json',
  };
}

function payload(corpus: string, truncated = false, ownerOrgId: string | null = 'org-a') {
  return {
    record: { corpus, ...(ownerOrgId ? { owner_org_id: ownerOrgId } : {}) },
    events: [],
    truncated,
    nextSeq: 2000,
  };
}

describe('知识库接入记录页的提供方文案', () => {
  beforeEach(() => {
    mocks.runs = [];
    mocks.payload = payload('iotdb');
    mocks.notFound.mockClear();
  });

  it('空态引导管理者从页面发起接入，不展示内部目录与文件名', async () => {
    const html = renderToStaticMarkup(await IntakeRunsPage());

    expect(html).toContain('知识库页面');
    expect(html).not.toMatch(/data[\\/]|run\.json|events\.jsonl|目录/);
  });

  it('列表不渲染 fullprobe/probe 测试语料记录', async () => {
    mocks.runs = [
      ...Array.from({ length: 30 }, (_, index) => run(`fullprobe-${index}`)),
      run('iotdb'),
    ];
    const html = renderToStaticMarkup(await IntakeRunsPage());

    expect(html).toContain('iotdb');
    expect(html).not.toMatch(/data[\\/]|knowledge_base[\\/]|fullpath-probe|fullprobe/i);
  });

  it('列表不渲染其他机构的接入记录', async () => {
    mocks.runs = [run('private-b', 'org-b'), run('iotdb')];
    const html = renderToStaticMarkup(await IntakeRunsPage());
    expect(html).toContain('iotdb');
    expect(html).not.toContain('private-b');
  });

  it('截断时提供页面可查看的后续事件入口，不让用户去服务器找', async () => {
    mocks.payload = payload('iotdb', true);
    const html = renderToStaticMarkup(
      await IntakeRunPage({ params: Promise.resolve({ runId: '20260831T120000-abcdef' }) }),
    );

    expect(html).toContain('查看下一批事件');
    expect(html).toContain('since=2000');
    expect(html).not.toMatch(/服务器上|本站运维|run\.json|events\.jsonl/);
  });

  it('详情路由拒绝渲染测试语料记录', async () => {
    mocks.payload = payload('fullpath-probe');

    await expect(
      IntakeRunPage({ params: Promise.resolve({ runId: '20260831T120000-abcdef' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('详情路由拒绝渲染其他机构的接入记录', async () => {
    mocks.payload = payload('private-b', false, 'org-b');
    await expect(
      IntakeRunPage({ params: Promise.resolve({ runId: '20260831T120000-abcdef' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // 没有所有者 = 平台自己跑的，口径与语料可见性一致（lib/server/intake-runs.ts 的 runVisibleTo）。
  // 原来这里判 404，盘上早于 owner_org_id 字段的那批 run 于是一条都翻不出来。
  it('详情路由渲染没有所有者的平台旧记录', async () => {
    mocks.payload = payload('iotdb', false, null);
    const html = renderToStaticMarkup(
      await IntakeRunPage({ params: Promise.resolve({ runId: '20260831T120000-abcdef' }) }),
    );
    expect(html).toContain('iotdb');
  });
});
