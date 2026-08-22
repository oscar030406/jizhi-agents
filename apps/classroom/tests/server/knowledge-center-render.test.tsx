/**
 * 总览卡的服务端渲染检查：喂**真**聚合数据，看工单点名的字段是不是真出现在卡上。
 *
 * 单独一个 .tsx 文件（不并进 admin-render.test.tsx）是为了不与正在改 /admin 的人抢文件。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CorpusCard } from '@/components/admin/knowledge-center';
import { readCorpus } from '@/lib/server/knowledge-center';

describe('语料库总览卡', () => {
  it('就绪度两个字段（节级前置边、金标目录）都在卡上，数字与聚合层一致', async () => {
    const row = await readCorpus('iotdb');
    if (!row || row.clauses === null) {
      console.warn('跳过：本机没有 iotdb 的就绪度报告');
      return;
    }
    const html = renderToStaticMarkup(<CorpusCard corpus={row} />);
    expect(html).toContain('前置边（节级）');
    expect(html).toContain('覆盖率金标');
    expect(html).toContain(`${row.goldFiles} 个主题文件`);
  });

  it('没建的库：金标那格写「未建」，不补 0 以外的占位', async () => {
    const row = await readCorpus('manufacturing');
    if (!row) return;
    const html = renderToStaticMarkup(<CorpusCard corpus={row} />);
    expect(row.goldFiles).toBeNull();
    expect(html).toContain('未建');
  });
});
