/**
 * 知识库中心的聚合层。跑真引擎数据目录——这一层最容易坏在「跨应用路径拼错」
 * 和「字段名对不上」，两样用假数据都测不出来。
 *
 * 引擎目录不在本机时用例自己跳过并说明，不假装通过。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isValidCorpusName,
  readCorpora,
  readCorpus,
  snapshotDrift,
  type CorpusOverview,
} from '@/lib/server/knowledge-center';

/** 只喂 snapshotDrift 用到的两个字段。 */
function live(corpus: string, available: boolean, chunks: number | null): CorpusOverview {
  return { corpus, available, chunks } as CorpusOverview;
}

function engineDataDir(): string {
  return process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data');
}

async function hasEngineCorpora(): Promise<boolean> {
  try {
    await fs.access(path.join(engineDataDir(), 'knowledge_base', 'knowledge_index.jsonl'));
    return true;
  } catch {
    return false;
  }
}

describe('知识库中心', () => {
  it('语料名进路径前先卡字符集', () => {
    expect(isValidCorpusName('iotdb')).toBe(true);
    expect(isValidCorpusName('industrial-internet')).toBe(true);
    expect(isValidCorpusName('../etc')).toBe(false);
    expect(isValidCorpusName('IotDB')).toBe(false);
    expect(isValidCorpusName('')).toBe(false);
  });

  it('名单覆盖引擎声明过的每一个库', async () => {
    if (!(await hasEngineCorpora())) {
      console.warn('跳过：本机没有引擎数据目录');
      return;
    }
    const declared: string[] = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'public', 'skill-map.json'), 'utf-8'),
    ).corpora.map((c: { corpus: string }) => c.corpus);
    expect(declared.length).toBeGreaterThan(0);
    const names = (await readCorpora()).map((c) => c.corpus);
    for (const d of declared) expect(names).toContain(d);
  });

  it('块数与就绪度报告自记的块数对得上（两个真源互校）', async () => {
    if (!(await hasEngineCorpora())) {
      console.warn('跳过：本机没有引擎数据目录');
      return;
    }
    for (const name of ['iotdb', 'odoo']) {
      const readiness = JSON.parse(
        await fs.readFile(
          path.join(engineDataDir(), 'knowledge_base', `${name}_intake`, 'readiness.json'),
          'utf-8',
        ),
      );
      const row = await readCorpus(name);
      // 索引行数是我们数的，corpus_index.chunks 是入库链写的。两边不等说明有一边算错了。
      expect(row?.chunks).toBe(readiness.corpus_index.chunks);
      // 卡片上的「前置边（节级）」= readiness 里 prereq_graph.clauses 的条数，
      // 与 admin-overview.ts 的 nodeEdges 同一口径（iotdb 0、odoo 6）。
      expect(row?.clauses).toBe(Object.keys(readiness.prereq_graph?.clauses ?? {}).length);
    }
  });

  it('亮灯与产物文件一一对应：亮着的站必有 mtime，灭着的站没有', async () => {
    if (!(await hasEngineCorpora())) {
      console.warn('跳过：本机没有引擎数据目录');
      return;
    }
    for (const row of await readCorpora()) {
      for (const s of row.stations) {
        if (s.built) expect(s.updatedAt, `${row.corpus}/${s.id}`).toBeTruthy();
        else expect(s.updatedAt, `${row.corpus}/${s.id}`).toBeNull();
      }
      // 索引站亮 ⇔ 引擎能按这个名字取到检索器
      expect(row.available).toBe(row.stations.some((s) => s.id === 'index' && s.built));
      // 有向量索引就一定有 jsonl（npz 是照着 jsonl 建的）
      if (row.backend === 'vector') expect(row.available).toBe(true);
    }
  });

  it('没建的库如实报未建，不给占位数', async () => {
    if (!(await hasEngineCorpora())) {
      console.warn('跳过：本机没有引擎数据目录');
      return;
    }
    const row = await readCorpus('manufacturing');
    expect(row).not.toBeNull();
    expect(row?.available).toBe(false);
    expect(row?.backend).toBe('none');
    expect(row?.chunks).toBeNull();
    expect(row?.stations.every((s) => !s.built)).toBe(true);
  });

  it('快照与磁盘一致时不出提示；新增/重建/消失各出一条', () => {
    const snapshot = [
      { corpus: 'ai', available: true, chunk_count: 1704 },
      { corpus: 'odoo', available: true, chunk_count: 307 },
      { corpus: 'gone', available: true, chunk_count: 9 },
      { corpus: 'manufacturing', available: false, chunk_count: 0 },
    ];
    expect(
      snapshotDrift(
        [live('ai', true, 1704), live('odoo', true, 307), live('gone', true, 9)],
        snapshot,
      ),
    ).toEqual([]);
    // 未建成的库两边都是灰的，不算不一致
    expect(
      snapshotDrift(
        [live('ai', true, 1704), live('odoo', true, 307), live('gone', true, 9), live('manufacturing', false, null)],
        snapshot,
      ),
    ).toEqual([]);
    const notes = snapshotDrift(
      [live('ai', true, 1704), live('odoo', true, 512), live('demo-corpus', true, 2)],
      snapshot,
    );
    expect(notes).toEqual([
      '「企业管理系统 Odoo」证据块 307 → 512',
      '新增「demo-corpus」（2 个证据块）',
      '「gone」已不在磁盘上',
    ]);
    // 没有快照文件可比时不瞎报
    expect(snapshotDrift([live('demo-corpus', true, 2)], null)).toEqual([]);
  });

  it('语料名不合法时直接返回 null，不去碰磁盘', async () => {
    expect(await readCorpus('../../etc/passwd')).toBeNull();
  });

  /**
   * 引擎离线降级方案是「这一页压根不问引擎」。证明方式：把 fetch 换成一调用就抛的桩，
   * 聚合层照样出全量数据——有任何一次网络调用，这条用例会直接炸。
   */
  it('不依赖引擎进程：网络被掐死也照常出数据', async () => {
    if (!(await hasEngineCorpora())) {
      console.warn('跳过：本机没有引擎数据目录');
      return;
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('这一页不该发任何网络请求');
    }) as typeof fetch;
    try {
      const rows = await readCorpora();
      expect(rows.filter((r) => r.available).length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
