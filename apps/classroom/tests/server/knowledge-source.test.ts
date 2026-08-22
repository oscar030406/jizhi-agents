/**
 * 「原件与处理过程」的读取层。跑的是真的引擎数据目录——这一层的全部难点就是
 * **反查规则对不对**（source_id ↔ 原件文件名），用假目录测等于测我自己写的假规则。
 *
 * 盘上没有语料时用例自己跳过并说明，不假装通过。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSourceFile, readSourceView } from '@/lib/server/knowledge-source';

const KB = path.join(
  process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data'),
  'knowledge_base',
);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('主域原件反查', () => {
  it('索引里每个 source_id 前缀都能落到一个原件文件上', async () => {
    if (!(await exists(path.join(KB, 'knowledge_index.jsonl')))) {
      console.warn('跳过：盘上没有主索引');
      return;
    }
    const view = await readSourceView('ai');
    expect(view).not.toBeNull();
    // orphans 非空 = 有块反查不到原件，反查规则漏了一种文件名形态。
    expect(view!.orphans).toEqual([]);
    expect(view!.totals.chunks).toBe(view!.indexChunks);
    expect(view!.totals.files).toBeGreaterThan(0);
    // 主域没走接入链，没有退回清单——「没有记录」与「退回 0 个」必须区分得开。
    expect(view!.rejected).toBeNull();
  });

  it('AgentGuide 那一支按下划线前缀命中，未入库的同目录文件块数为 0', async () => {
    if (!(await exists(path.join(KB, 'agentguide_docs')))) {
      console.warn('跳过：盘上没有 agentguide_docs');
      return;
    }
    const view = await readSourceView('ai');
    const group = view!.groups.find((g) => g.name === 'agentguide_docs');
    expect(group).toBeDefined();
    expect(group!.chunks).toBeGreaterThan(0);
    // 收进索引的只是其中一部分，其余「在盘未入库」。两种都得在清单里，不许静默丢。
    expect(group!.files.some((f) => f.chunks === 0)).toBe(true);
  });
});

describe('原文读取的路径闸', () => {
  it('读得到库内的原件，front-matter 原样保留', async () => {
    const file = path.join(KB, 'happy_llm_docs', 'hl01s01.md');
    if (!(await exists(file))) {
      console.warn('跳过：盘上没有 happy_llm_docs/hl01s01.md');
      return;
    }
    const detail = await readSourceFile('ai', 'happy_llm_docs/hl01s01.md');
    expect(detail?.text.startsWith('---')).toBe(true);
    expect(detail!.chunks.length).toBeGreaterThan(0);
    expect(detail!.chunks.every((c) => c.sourceId.startsWith('hl01s01#'))).toBe(true);
  });

  it('穿不出原件根目录', async () => {
    for (const rel of [
      '../../../package.json',
      '..\\..\\package.json',
      'happy_llm_docs/../../../../package.json',
      '/etc/passwd',
      'D:/UserData/Desktop/挑战杯/apps/classroom/package.json',
    ]) {
      expect(await readSourceFile('ai', rel)).toBeNull();
    }
  });

  it('非文本扩展名一律不给读', async () => {
    expect(await readSourceFile('ai', 'knowledge_index.jsonl')).toBeNull();
    expect(await readSourceFile('ai', 'knowledge_embeddings.npz')).toBeNull();
  });

  it('语料名不合法直接拒', async () => {
    expect(await readSourceFile('../ai', 'x.md')).toBeNull();
    expect(await readSourceView('../ai')).toBeNull();
  });
});

describe('扩展域原件反查', () => {
  it('source_dir 还在盘上的库，索引里每个 slug 都能落到原件上', async () => {
    let checked = 0;
    for (const corpus of ['vecdb', 'rag-adv', 'odoo', 'iotdb', 'pv-ops', 'cold-chain-ops']) {
      if (!(await exists(path.join(KB, `${corpus}_intake`, 'readiness.json')))) continue;
      const view = await readSourceView(corpus);
      if (!view?.rootExists) continue;
      checked += 1;
      expect(view.orphans, `${corpus} 有块反查不到原件`).toEqual([]);
      expect(view.rejected, `${corpus} 应有退回清单（可以是空数组）`).not.toBeNull();
      // 逐原件加总要等于索引里的块数。slug 碰撞时那几块是共用的，加总只能算一次——
      // 不去重的话 vecdb 会加出 853 块，比索引里实际的 807 块还多。
      expect(view.totals.chunks, `${corpus} 逐原件加总与索引对不上`).toBe(view.indexChunks);
    }
    if (checked === 0) console.warn('跳过：盘上没有任何扩展域的原件目录');
  });
});
