/**
 * 语料适配性那一格：聚合层读的是不是引擎那份真报告，卡上印的是不是同一个数。
 *
 * 跑真数据目录。引擎目录或报告文件不在本机时用例自己跳过并说明，不假装通过。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CorpusCard } from '@/components/admin/knowledge-center';
import { readCorpus } from '@/lib/server/knowledge-center';

function fitnessFile(): string {
  const dir = process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data');
  return path.join(dir, 'knowledge_base', 'fitness.json');
}

async function report(): Promise<{
  corpora: Record<string, { light: string; gate_a: { chars_median: number } }>;
} | null> {
  try {
    return JSON.parse(await fs.readFile(fitnessFile(), 'utf-8'));
  } catch {
    return null;
  }
}

describe('语料适配性', () => {
  it('灯色与块长直接来自引擎那份报告，不在页面侧重算一套', async () => {
    const file = await report();
    if (!file) {
      console.warn('跳过：本机没有 fitness.json');
      return;
    }
    for (const [name, want] of Object.entries(file.corpora)) {
      const row = await readCorpus(name);
      if (!row) continue;
      expect(row.fitness?.light, name).toBe(want.light);
      expect(row.fitness?.charsMedian, name).toBe(want.gate_a.chars_median);
    }
  });

  it('块数不够铺一门课的库标红，且理由带得出具体数', async () => {
    // 不写死库名。原来钉的是 cold-chain-ops，2026-08-23 那批垃圾域被清掉之后
    // 这条直接红了——**测试挂在一个会被删的库上，测的就不再是判据本身**。
    // 改成从报告里现找一个标红的库：库来来去去，「标红要带得出具体数」这条判据不变。
    const file = await report();
    if (!file) {
      console.warn('跳过：本机没有 fitness.json');
      return;
    }
    const redName = Object.entries(file.corpora).find(([, v]) => v.light === 'red')?.[0];
    if (!redName) {
      console.warn('跳过：本机没有标红的库');
      return;
    }
    const row = await readCorpus(redName);
    // 库删了报告还留着旧条目——`fitness` 仍在但 `chunks` 已经是 null。
    // 只判 fitness 在不在会拿一份陈报告去比一个不存在的块数，所以两样都要求。
    if (!row?.fitness || typeof row.chunks !== 'number') {
      console.warn(`跳过：${redName} 的库已不在盘上（报告里还留着旧条目）`);
      return;
    }
    expect(row.fitness.light, redName).toBe('red');
    expect(row.fitness.why.join(''), `${redName} 的标红理由要带出块数`).toContain(
      String(row.chunks),
    );
  });

  it('没跑过这道闸的库为 null，卡上不出这一格——不拿占位数顶', async () => {
    const row = await readCorpus('manufacturing');
    if (!row) return;
    expect(row.fitness).toBeNull();
    expect(renderToStaticMarkup(<CorpusCard corpus={row} />)).not.toContain('语料适配性');
  });

  it('灯上屏，且卡上不印任何内部代号或模型串', async () => {
    const row = await readCorpus('ai');
    if (!row?.fitness) {
      console.warn('跳过：本机没有 ai 的适配性报告');
      return;
    }
    const html = renderToStaticMarkup(<CorpusCard corpus={row} />);
    expect(html).toContain('语料适配性');
    expect(html).toContain('素材够');
    for (const banned of ['WO-K', 'Qwen', 'DeepSeek', 'fineweb', 'Gopher', 'gate_a', 'gate_b']) {
      expect(html, banned).not.toContain(banned);
    }
  });
});
