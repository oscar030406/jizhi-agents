import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string; className?: string }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'session' }) }) }));
vi.mock('@/lib/accounts/store', () => ({
  accountsEnabled: () => true,
  accountForSession: async () => ({ id: 'manager', role: 'manager', displayName: '管理者甲' }),
}));
vi.mock('@/lib/server/domain-registry', () => ({ readDomainRegistry: async () => ({}) }));
vi.mock('@/lib/server/admin-overview', () => ({
  readHeadlineMetrics: async () => [],
  readAllCourseAudits: async () => [],
  readDomainIntakes: async () => [],
  rollup: () => ({
    courses: 0,
    scenes: 0,
    audited: 0,
    claims: 0,
    incorrect: 0,
    uncertain: 0,
    incorrectRate: null,
    groundedRate: null,
    distinctSources: 0,
  }),
}));
vi.mock('@/lib/server/knowledge-map', () => ({
  readCoverageRuns: async () => [],
  readDifficultySupply: async () => [],
  readDomainMaps: async () => [],
}));
vi.mock('@/components/admin/caliber', () => ({
  Caliber: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/admin/course-table', () => ({ AdminCourseTable: () => null }));
vi.mock('@/components/admin/coverage-panel', () => ({
  CoveragePanel: () => null,
  DifficultySupply: () => null,
}));
vi.mock('@/components/admin/domain-intake-summary', () => ({ DomainIntakeSummary: () => null }));
vi.mock('@/components/admin/domain-intake-table', () => ({ DomainIntakeTable: () => null }));
vi.mock('@/components/admin/knowledge-map', () => ({ KnowledgeMap: () => null }));
vi.mock('@/components/admin/metric-band', () => ({ MetricBand: () => null }));
vi.mock('@/components/home/section-anchor', () => ({ SectionAnchor: () => null }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => <header>集智</header> }));

import AdminPage from '@/app/admin/page';

describe('管理端提供方文案与入口层级', () => {
  it('三个工作台入口在独立分区中以同级醒目卡片展示', async () => {
    const html = renderToStaticMarkup(await AdminPage());

    for (const href of ['/admin/knowledge/runs', '/admin/generalization', '/admin/org']) {
      expect(html).toMatch(
        new RegExp(`<a[^>]+href="${href}"[^>]+class="[^"]*rounded-xl[^"]*border[^"]*p-6[^"]*"`),
      );
    }
    expect(html).toContain('管理工作台');
    expect(html.indexOf('</section><section')).toBeLessThan(html.indexOf('管理工作台'));
    expect(html).toContain('sm:grid-cols-3');
  });

  it('总览用平台状态说明，不让管理者检查服务器或内部文件', async () => {
    const html = renderToStaticMarkup(await AdminPage());

    expect(html).not.toMatch(/本部署|服务器上|本站运维|课程文件|复算命令|墙钟/);
  });
});
