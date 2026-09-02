/**
 * 知识库中心的聚合层。跑真引擎数据目录——这一层最容易坏在「跨应用路径拼错」
 * 和「字段名对不上」，两样用假数据都测不出来。
 *
 * 引擎目录不在本机时用例自己跳过并说明，不假装通过。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  isValidCorpusName,
  readCorpusOwnerMarkers,
  releaseCorpusOwnerMarker,
  readCorpora,
  readCorpus,
} from '@/lib/server/knowledge-center';
import { readDomainRegistry } from '@/lib/server/domain-registry';

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
    const declared = Object.keys((await readDomainRegistry()).entries);
    expect(declared.length).toBeGreaterThan(0);
    const names = (await readCorpora()).map((c) => c.corpus);
    for (const d of declared) expect(names).toContain(d);
  });

  it('块数与就绪度报告自记的块数对得上（两个真源互校）', async () => {
    if (!(await hasEngineCorpora())) {
      console.warn('跳过：本机没有引擎数据目录');
      return;
    }
    // 遍历盘上真有的扩展库，不写死名单（odoo 被删那天这条就是这么红的）。
    // 这一条要证的是「索引行数与就绪度自记的块数两个真源互校」，
    // 有几个库就校几个。
    const live = (await fs.readdir(path.join(engineDataDir(), 'knowledge_base', 'corpora')))
      .filter((n) => !n.startsWith('.'))
      .sort();
    for (const name of live) {
      let readiness;
      try {
        readiness = JSON.parse(
          await fs.readFile(
            path.join(engineDataDir(), 'knowledge_base', `${name}_intake`, 'readiness.json'),
            'utf-8',
          ),
        );
      } catch {
        continue; // 这个库没有就绪度报告（旧命令行管线建的），无从互校
      }
      const row = await readCorpus(name);
      // 索引行数是我们数的，corpus_index.chunks 是入库链写的。两边不等说明有一边算错了。
      expect(row?.chunks).toBe(readiness.corpus_index.chunks);
      // 卡片上的「前置边（节级）」= readiness 里 prereq_graph.clauses 的条数，
      // 与 admin-overview.ts 的 nodeEdges 同一口径。
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

  it('语料名不合法时直接返回 null，不去碰磁盘', async () => {
    expect(await readCorpus('../../etc/passwd')).toBeNull();
  });

  it('归属读取与释放只走带内部令牌的引擎边界', async () => {
    const previousUrl = process.env.GROUNDING_URL;
    const previousToken = process.env.GROUNDING_TOKEN;
    process.env.GROUNDING_URL = 'http://engine.test';
    process.env.GROUNDING_TOKEN = 'secret-token';
    const engineFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ownership: { 'new-domain': 'org-a' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ released: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ownership: {} }), { status: 200 }));
    vi.stubGlobal('fetch', engineFetch);
    try {
      expect(Object.fromEntries(await readCorpusOwnerMarkers())).toEqual({ 'new-domain': 'org-a' });
      expect(await releaseCorpusOwnerMarker('new-domain', 'org-b')).toBe(false);
      expect(await releaseCorpusOwnerMarker('new-domain', 'org-a')).toBe(true);
      expect((await readCorpusOwnerMarkers()).has('new-domain')).toBe(false);
      expect(engineFetch.mock.calls.map(([url]) => url)).toEqual([
        'http://engine.test/api/domain-intake/corpus-owners',
        'http://engine.test/api/domain-intake/corpus-owners/new-domain',
        'http://engine.test/api/domain-intake/corpus-owners/new-domain',
        'http://engine.test/api/domain-intake/corpus-owners',
      ]);
      expect((engineFetch.mock.calls[0][1] as RequestInit).headers).toEqual({
        'x-internal-token': 'secret-token',
      });
      expect((engineFetch.mock.calls[2][1] as RequestInit).headers).toEqual({
        'x-internal-token': 'secret-token',
        'x-jizhi-owner-org': 'org-a',
      });
    } finally {
      vi.unstubAllGlobals();
      if (previousUrl === undefined) delete process.env.GROUNDING_URL;
      else process.env.GROUNDING_URL = previousUrl;
      if (previousToken === undefined) delete process.env.GROUNDING_TOKEN;
      else process.env.GROUNDING_TOKEN = previousToken;
    }
  });

  it('引擎归属接口不可达时失败关闭，不把私有库回退成公共库', async () => {
    const previousUrl = process.env.GROUNDING_URL;
    const previousToken = process.env.GROUNDING_TOKEN;
    process.env.GROUNDING_URL = 'http://engine.test';
    process.env.GROUNDING_TOKEN = 'secret-token';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('engine unavailable')));
    try {
      await expect(readCorpusOwnerMarkers()).rejects.toThrow('engine unavailable');
    } finally {
      vi.unstubAllGlobals();
      if (previousUrl === undefined) delete process.env.GROUNDING_URL;
      else process.env.GROUNDING_URL = previousUrl;
      if (previousToken === undefined) delete process.env.GROUNDING_TOKEN;
      else process.env.GROUNDING_TOKEN = previousToken;
    }
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
