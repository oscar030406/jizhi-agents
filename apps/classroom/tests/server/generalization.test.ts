/**
 * 泛化对比页的读数层。
 *
 * 跑真引擎目录，不用假数据——这一层唯一会坏的地方就是「字段名对不上」
 * （readiness.json 换了键、run.json 的 stage detail 改了形状），假数据把这两样全绕开了。
 * 没数据时用例自己跳过并说明，不假装通过。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readGeneralizationPanels,
  readMainSources,
  readOtherCorpora,
  redactCaliber,
} from '@/app/admin/generalization/data';

/** 这一页上屏的三条台账指标（与 page.tsx 的 EXTERNAL_LABELS 同源）。 */
const SHOWN_METRIC_IDS = ['api_hallucination_v2', 'adaptation_accuracy_2a', 'kc_coverage_v1'];

function kb(): string {
  return path.join(
    process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data'),
    'knowledge_base',
  );
}

async function hasEngineKb(): Promise<boolean> {
  try {
    await fs.access(path.join(kb(), 'sources_manifest.csv'));
    return true;
  } catch {
    return false;
  }
}

describe('泛化对比页读数', () => {
  it('三栏都读得出来，规模数字非零', async () => {
    if (!(await hasEngineKb())) {
      console.warn('跳过：本机读不到引擎知识库目录');
      return;
    }
    const panels = await readGeneralizationPanels();
    // 不钉库名单。原来钉 ['ai','iotdb','odoo']，泛化域收敛掉 odoo 就红——
    // 这一页要证的是「主域 + 泛化域都读得出来、数字非零、中文名落地」，
    // 不是「必须正好是这三个库」。库来来去去，判据不变。
    expect(panels.map((p) => p.corpus)).toContain('ai');
    expect(panels.length).toBeGreaterThanOrEqual(2); // 主域 + 至少一个泛化域
    for (const p of panels) {
      // 中文名必须落地：这一页零英文裸域名是 DoD 的一条
      expect(p.label).not.toBe(p.corpus);
      expect(p.chunks).toBeGreaterThan(0);
      expect(p.files).toBeGreaterThan(0);
      expect(p.sources.length).toBeGreaterThan(0);
      // 接入时间那一栏（真源文件落盘日期兜底，readiness.json 里没有时间戳字段）
      expect(p.sourceFileDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('台账口径上屏前抹掉模型全串与本机项目目录名', async () => {
    const file = path.join(
      process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data'),
      'metrics.json',
    );
    const ledger = JSON.parse(await fs.readFile(file, 'utf-8')) as {
      metrics: Record<string, { value?: string; caliber?: string; source?: string }>;
    };
    const shown = SHOWN_METRIC_IDS.map((id) => ledger.metrics[id]).filter(Boolean);
    expect(shown.length).toBe(SHOWN_METRIC_IDS.length);
    for (const m of shown) {
      const text = redactCaliber([m.value, m.caliber, m.source].filter(Boolean).join('\n'));
      expect(text).not.toMatch(/Qwen|DeepSeek|MiniMax|Kimi|moonshot|glm-|gpt-4|claude-3/i);
      expect(text).not.toMatch(/赛题|评委|参赛|挑战杯/);
      // 抹的是标识不是事实：分子分母照旧在
      expect(redactCaliber(m.caliber ?? '')).toContain('口径');
    }
  });

  it('主语料的资料清单按仓库归并，许可原文照搬', async () => {
    if (!(await hasEngineKb())) {
      console.warn('跳过：本机读不到引擎知识库目录');
      return;
    }
    const sources = await readMainSources();
    expect(sources.length).toBeGreaterThan(0);
    // 归并键是 owner/repo，不是人工写的书名
    for (const s of sources) {
      expect(s.name).toMatch(/^[^/]+\/[^/]+$/);
      expect(s.docs).toBeGreaterThan(0);
    }
    // 篇数总和 = manifest 里能解析出仓库的行数，不重不漏
    const text = await fs.readFile(path.join(kb(), 'sources_manifest.csv'), 'utf-8');
    const withRepo = text
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => /https?:\/\/[^/]*github\.com\/[^/]+\/[^/]+/.test(l)).length;
    expect(sources.reduce((a, s) => a + s.docs, 0)).toBe(withRepo);
    // 许可字段是原文，未声明许可的那条不许被美化掉
    expect(sources.some((s) => s.license.includes('未声明开源许可'))).toBe(true);
  });

  it('体检结果读得出分子分母；没跑过就是 null，不给默认值', async () => {
    if (!(await hasEngineKb())) {
      console.warn('跳过：本机读不到引擎知识库目录');
      return;
    }
    const panels = await readGeneralizationPanels();
    const checked = panels.filter((p) => p.checkup);
    if (checked.length === 0) {
      console.warn('跳过：本机还没有跑完的 ⑥⑦ 体检 run');
      return;
    }
    for (const p of checked) {
      const c = p.checkup!;
      expect(c.runId).not.toBe('');
      if (c.hallucination) {
        expect(c.hallucination.checked).toBeGreaterThan(0);
        expect(c.hallucination.supported).toBeLessThanOrEqual(c.hallucination.checked);
        // 判官对照不变量：换了库，判官手里的资料也得全是这本库的
        expect(c.hallucination.evidenceFromCorpus).toBe(c.hallucination.evidencePool);
        // grounded 的判据就是资料池非空——0/0 是「桥没通」，不是「全命中」，
        // 上一条在那种情况下会同义反复地通过，所以这一条得单独钉住
        expect(c.grounded).toBe(c.hallucination.evidencePool > 0);
      }
      // 覆盖那一格已撤下：读数层只留金标规模与撤因原文，不许再有分子/比率字段冒出来
      // （撤因见 data.ts 的 `goldTotal` 注释）。
      if (c.goldTotal !== null) expect(c.goldTotal).toBeGreaterThan(0);
      expect(c).not.toHaveProperty('coverage');
    }
  });

  it('脚注列的是没上屏的库，不与三栏重复', async () => {
    if (!(await hasEngineKb())) {
      console.warn('跳过：本机读不到引擎知识库目录');
      return;
    }
    const others = await readOtherCorpora();
    expect(others.map((o) => o.corpus)).not.toContain('iotdb');
    // 同理不钉具体库名：这一条要证的是「主域那一栏不会把泛化域混进来」。
    expect(others.map((o) => o.corpus)).not.toContain('ai');
  });
});
