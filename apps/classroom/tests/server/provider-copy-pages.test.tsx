import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/site-header', () => ({ SiteHeader: () => <header>集智</header> }));
vi.mock('@/app/admin/knowledge/guard', () => ({ managerAccount: async () => ({ id: 'manager' }) }));
vi.mock('@/lib/server/admin-overview', () => ({
  readHeadlineMetrics: async () => [
    {
      id: 'api_hallucination_v2',
      value: '2.08%',
      caliber: '真实生成端，576 条可核断言，12 条判无据。',
      source: 'data/eval/fullprobe/metrics.json',
    },
  ],
}));
vi.mock('@/app/admin/generalization/data', () => ({
  readGeneralizationPanels: async () => [],
  readOtherCorpora: async () => [],
  readRunArtifacts: async () => [],
  redactCaliber: (text: string) => text,
}));

import GeneralizationPage from '@/app/admin/generalization/page';

describe('领域泛化页的提供方文案', () => {
  it('保留指标口径与可查看产物入口，不展示复算路径或服务器操作指引', async () => {
    const html = renderToStaticMarkup(await GeneralizationPage());

    expect(html).toContain('2.08%');
    expect(html).toContain('真实生成端');
    expect(html).toContain('平台维护人员');
    expect(html).not.toMatch(
      /data[\\/]|knowledge_base[\\/]|trial_courses[\\/]|readiness\.json|sources_manifest\.csv|本站运维|服务器上|复算命令/i,
    );
  });
});
