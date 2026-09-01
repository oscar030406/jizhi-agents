import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/site-header', () => ({
  SiteHeader: () => <header>集智</header>,
}));

vi.mock('@/components/account/account-menu', () => ({
  AccountMenu: () => <button type="button">账户</button>,
}));

import PrivacyPage from '@/app/privacy/page';
import EvidencePage from '@/app/evidence/page';
import { StationRow } from '@/components/admin/knowledge-center';
import { SourceFilesPanel } from '@/components/admin/knowledge-source';
import { MyPathCard } from '@/components/home/learning-overview';
import { PublicLanding } from '@/components/home/public-landing';
import type { SourceView } from '@/lib/server/knowledge-source';

const render = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('面向使用者的部署文案', () => {
  it('隐私页把浏览器数据说成“当前浏览器”，且不暴露默认服务商或内部数据路径', () => {
    const html = render(<PrivacyPage />);

    expect(html).toContain('当前浏览器');
    expect(html).toContain('学习者端不提供服务商或模型选择');
    expect(html).toContain('平台模型连接信息');
    expect(html).toContain('所属机构管理者');
    expect(html).not.toMatch(/本机|硅基流动|本机默认模型|访客可选择|data\/knowledge_base/i);
  });

  it('公开审核回放保留审核与导学证据，但没有底部指标台账', () => {
    const html = render(<EvidencePage />);

    expect(html).toContain('审核实录');
    expect(html).toContain('一轮导学的完整回放');
    expect(html).not.toContain('实测指标台账');
  });

  it('公开课程输入只询问学习需求，不再渲染课堂角色控件', () => {
    const html = render(<PublicLanding />);

    expect(html).toContain('aria-label="学习需求"');
    expect(html).not.toContain('课堂角色');
  });

  it('首页学习路径空态引导等待机构课程规划，不展示内部数据文件', () => {
    const html = render(<MyPathCard progressByCourseId={{}} path={{ nodes: [], tracks: [] }} />);

    expect(html).toContain('所属机构补齐课程规划后');
    expect(html).not.toMatch(/data[\\/]learning-path\.json|tracks 为空/i);
  });

  it('知识库管线显示接收状态与最近处理时间，不显示服务器路径或测试产物名', () => {
    const html = render(
      <StationRow
        station={{
          id: 'index',
          label: '建索引',
          what: '建立检索索引',
          built: true,
          path: 'D:\\data\\knowledge_base\\fullpath-probe\\index.jsonl',
          updatedAt: '2026-08-31T10:20:00.000Z',
          detail: '共 42 块',
        }}
      />,
    );

    expect(html).toContain('系统已接收');
    expect(html).toContain('最近处理时间');
    expect(html).not.toMatch(/D:\\|data[\\/]|fullpath-probe|mtime|盘上/i);
  });

  it('知识库原件区通过页面查看和导出，不展示接入机器路径', () => {
    const view: SourceView = {
      corpus: 'iotdb',
      rootLabel: 'D:\\data\\knowledge_base\\fullprobe\\docs',
      rootExists: false,
      external: true,
      groups: [
        {
          name: '用户指南',
          bytes: 32,
          chunks: 0,
          files: [
            {
              rel: '用户指南/intro.md',
              bytes: 32,
              chunks: 0,
              title: '简介',
              rejected: null,
              readable: true,
              collides: [],
            },
          ],
        },
      ],
      totals: { files: 1, bytes: 32, chunks: 0, unindexed: 1 },
      indexChunks: 0,
      orphans: [],
      rejected: [],
      rejectedBuckets: [],
      scopedOut: null,
    };
    const html = render(<SourceFilesPanel corpus="iotdb" view={view} />);

    expect(html).toContain('系统当前无法读取这批原件');
    expect(html).toContain('导出原件清单 CSV');
    expect(html).toContain('看原文');
    expect(html).not.toMatch(/D:\\|data[\\/]|fullprobe|本机|盘上/i);
  });
});
