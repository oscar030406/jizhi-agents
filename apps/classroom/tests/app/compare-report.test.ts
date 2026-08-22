import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/app/compare/presets';
import {
  auditLine,
  formatMinutesRange,
  humanDifferences,
  pickPair,
  serialRunEstimate,
  stripConceptPrefix,
  type CompareReport,
} from '@/app/compare/report';

/**
 * 对比页重做（WO-C3）的验收测试。
 *
 * 三件事都拿磁盘上的真实数据测，不造 fixture：
 * 预生成对照 `public/compare-showcase.json` 是唯一的真实 compare 返回体，
 * 画像明细的真源是引擎的 learner_profiles.json。
 */

const ROOT = resolve(__dirname, '../..');

const showcase = JSON.parse(
  readFileSync(resolve(ROOT, 'public/compare-showcase.json'), 'utf-8'),
) as CompareReport;

interface EngineProfile {
  id: string;
  name: string;
  background: string;
  programming_level: number;
  python_level: number;
  agent_level: number;
  rag_level: number;
  engineering_level: number;
  learning_goal: string;
  learning_preference: string;
}

const engineProfiles = JSON.parse(
  readFileSync(resolve(ROOT, '../agent-engine/data/learner_profiles/learner_profiles.json'), 'utf-8'),
) as EngineProfile[];

// ── 画像卡明细必须与引擎真吃的字段一一对应 ─────────────────────────────────

describe('预设画像', () => {
  it('每个字段都对得上引擎的 learner_profiles.json，一个字都不新造', () => {
    for (const p of PRESETS) {
      const src = engineProfiles.find((e) => e.id === p.id);
      expect(src, `引擎里找不到画像 ${p.id}`).toBeDefined();
      expect(p.name).toBe(src!.name);
      expect(p.background).toBe(src!.background);
      expect(p.goal).toBe(src!.learning_goal);
      expect(p.wantsText).toBe(src!.learning_preference);
      expect(p.levels).toEqual({
        programming: src!.programming_level,
        python: src!.python_level,
        agent: src!.agent_level,
        rag: src!.rag_level,
        engineering: src!.engineering_level,
      });
    }
  });

  it('两轴四格，每格恰好一个画像', () => {
    const cells = PRESETS.map((p) => `${p.base}/${p.wants}`);
    expect(new Set(cells).size).toBe(4);
    expect(cells).toHaveLength(4);
  });

  it('轴一的分格判据从画像分值量得出来：弱格两项都 ≤2，强格 Python ≥3 且工程 ≥2', () => {
    for (const p of PRESETS) {
      if (p.base === 'weak') {
        expect(p.levels.python).toBeLessThanOrEqual(2);
        expect(p.levels.engineering).toBeLessThanOrEqual(2);
      } else {
        expect(p.levels.python).toBeGreaterThanOrEqual(3);
        expect(p.levels.engineering).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('赶比赛演示那个画像已经删掉', () => {
    expect(PRESETS.map((p) => p.id)).not.toContain('competition_sprint');
  });
});

// ── 页面上不许出现的内部词 ───────────────────────────────────────────────────

describe('对比页文案', () => {
  const source = ['page.tsx', 'presets.ts', 'report.ts']
    .map((f) => readFileSync(resolve(ROOT, 'app/compare', f), 'utf-8'))
    .join('\n');

  it.each(['类比域', '支架', '竞赛冲刺'])('全页不出现「%s」', (term) => {
    expect(source).not.toContain(term);
  });

  it('没过关的概念只给条数，不把内部枚举逐个列出来', () => {
    expect(source).not.toContain('没过关 · ');
    expect(source).not.toContain('weak_concepts.map');
  });
});

// ── 小节标题：内部概念 id 不上 UI ───────────────────────────────────────────

describe('stripConceptPrefix', () => {
  const pair = pickPair(showcase.entries)!;
  const rendered = pair.flatMap((e) => e.resources.section_headings.map(stripConceptPrefix));

  it('预生成对照的每个小节标题渲染出来都不带英文枚举前缀', () => {
    expect(rendered.length).toBeGreaterThan(0);
    for (const h of rendered) {
      expect(h, `「${h}」仍带概念 id 前缀`).not.toMatch(/^[a-z][a-z0-9_]*\s*[-–—:：]/);
      expect(h).not.toContain('目标概念');
      expect(h).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it('三种前缀写法都剥得掉', () => {
    expect(stripConceptPrefix('【目标概念：rag】RAG如何工作？快递分拣的智慧')).toBe(
      'RAG如何工作？快递分拣的智慧',
    );
    expect(stripConceptPrefix('目标概念：agent_basics - Agent是什么？')).toBe('Agent是什么？');
    expect(stripConceptPrefix('agent_basics：工具调用与状态循环的接口契约')).toBe(
      '工具调用与状态循环的接口契约',
    );
    expect(stripConceptPrefix('目标概念：langgraph & guardrails - 构建可审核的流程')).toBe(
      '构建可审核的流程',
    );
  });

  it('中文标注和正常标题一个字不动', () => {
    expect(stripConceptPrefix('【综合示例】组装你的第一个问答助手')).toBe(
      '【综合示例】组装你的第一个问答助手',
    );
    expect(stripConceptPrefix('执行流与观测：流式响应与状态记录')).toBe(
      '执行流与观测：流式响应与状态记录',
    );
    expect(stripConceptPrefix('agent 的三个部件：模型、工具、记忆')).toBe(
      'agent 的三个部件：模型、工具、记忆',
    );
  });

  it('剥完为空就退回原文，不给空标题', () => {
    expect(stripConceptPrefix('rag：')).toBe('rag：');
  });
});

// ── 审核行：返回体里一直有，界面此前丢掉了 ───────────────────────────────────

describe('auditLine', () => {
  it('预生成对照的每一列都能挂出审核行', () => {
    for (const entry of showcase.entries) {
      const line = auditLine(entry.full_run?.audit);
      expect(line, `${entry.profile.name} 没渲染出审核行`).toMatch(
        /^事实性 \d\.\d\d\/1 · 断言 \d+ 条，\d+ 条对得上引用的教材片段$/,
      );
    }
  });

  it('缺字段就不渲染，不补 0 也不写占位', () => {
    expect(auditLine(null)).toBeNull();
    expect(auditLine({})).toBeNull();
    expect(auditLine({ factuality_score: 0.9 })).toBeNull();
    expect(auditLine({ claims_total: 8 })).toBeNull();
  });

  it('没有 claims_supported 时只报总数', () => {
    expect(auditLine({ factuality_score: 1, claims_total: 7 })).toBe('事实性 1.00/1 · 断言 7 条');
  });
});

// ── 耗时估算：数字从实测值算，不写死 ─────────────────────────────────────────

describe('serialRunEstimate', () => {
  it('从预生成对照的实测 duration_ms 算出两画像串行区间', () => {
    const est = serialRunEstimate(showcase.entries);
    expect(est).not.toBeNull();
    const ms = showcase.entries.map((e) => e.cost!.duration_ms!).sort((a, b) => a - b);
    expect(est!.minMs).toBe(ms[0] + ms[1]);
    expect(est!.maxMs).toBe(ms[ms.length - 2] + ms[ms.length - 1]);
    expect(est!.minMs).toBeLessThanOrEqual(est!.maxMs);
  });

  it('实测值不足两个就返回 null——宁可不标也不编', () => {
    expect(serialRunEstimate([])).toBeNull();
    expect(serialRunEstimate([{ cost: { duration_ms: 1000 } } as never])).toBeNull();
    expect(
      serialRunEstimate([{ cost: null } as never, { full_run: null } as never]),
    ).toBeNull();
  });

  it('区间两端取整后相同就只写一个数', () => {
    expect(formatMinutesRange(600_000, 600_000)).toBe('约 10 分钟');
    expect(formatMinutesRange(819_881, 1_081_705)).toBe('约 14–18 分钟');
  });
});

// ── 差异归因：≤3 条，全人话 ─────────────────────────────────────────────────

describe('humanDifferences', () => {
  const pair = pickPair(showcase.entries)!;
  const lines = humanDifferences(pair[0], pair[1], showcase.differences);

  it('三列的预生成对照取首尾两个画像', () => {
    expect(pair[0].profile.profile_id).toBe('zero_beginner');
    expect(pair[1].profile.profile_id).toBe('backend_to_agent');
  });

  it('最多三条', () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(humanDifferences(pair[0], pair[1], showcase.differences, 1)).toHaveLength(1);
  });

  it('没有机器腔：不出现「因为 X=0.00」这类句式，也不出现内部枚举值', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/掌握向量/);
      expect(line).not.toMatch(/=\d/);
      expect(line).not.toMatch(/guided_beginner|systems_engineer|scaffold|full\/|minimal/);
    }
  });

  it('每条都带得出分子分母或具体取材，指得回画像字段', () => {
    expect(lines[0]).toContain('编程基础 0/4');
    expect(lines[0]).toContain('4/4');
    expect(lines.join('\n')).toContain('生活场景');
  });

  it('引擎没判出差异的维度不硬写', () => {
    expect(humanDifferences(pair[0], pair[1], [])).toEqual([]);
  });

  it('两列同一维度值相同就跳过该条', () => {
    const same = humanDifferences(pair[0], pair[0], showcase.differences);
    expect(same.every((l) => !l.includes('难度一个定在'))).toBe(true);
  });
});
