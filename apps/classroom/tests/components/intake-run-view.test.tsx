// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { IntakeRunView } from '@/components/admin/intake-run-view';
import type { IntakeEvent, IntakeRunRecord } from '@/lib/server/intake-runs';

/**
 * 观看端对 ⑥⑦ 两站的渲染（WO-H1 第 3、4 件）。
 *
 * 钉三件：⑥⑦ 的 detail 字段有中文名（不是裸的 english_key）、run 头上有试跑开关的状态、
 * ② 站块数偏少时提醒那一句在、块数够时不在。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function slot(order: number, label: string, deps: string[], detail: unknown) {
  return {
    order,
    label,
    deps,
    optional: false,
    status: 'done' as const,
    started_at: null,
    finished_at: null,
    duration_ms: 1200,
    detail: detail as Record<string, unknown>,
    error: '',
  };
}

function fixture(chunks: number, trialRun: boolean): [IntakeRunRecord, IntakeEvent[]] {
  const record: IntakeRunRecord = {
    run_id: '20260816T101010-abcdef',
    corpus: 'tsdb-probe',
    scope: '时序数据库运维',
    status: 'done',
    created_at: '2026-08-16T10:10:10',
    finished_at: '2026-08-16T10:22:10',
    duration_ms: 720_000,
    options: { tier_range: 'L1-L3', build_vector: false, trial_run: trialRun },
    limits: {},
    files: [{ name: 'a.md', original: 'a.md', bytes: 10 }],
    stages: {
      chunk: slot(2, '切块入库', [], { sections: 3, chunks }),
      trial: slot(6, '试跑课程', ['chunk'], {
        course_title: '时序数据库运维：写入与查询',
        scenes: 4,
        planned_scenes: 4,
        cost: { llm_calls: 41, total_tokens: 308_785 },
        paths: { beginner: 'trial_courses/beginner.json', advanced: 'trial_courses/advanced.json' },
      }),
      metrics: slot(7, '指标复测', ['trial'], {
        hallucination: { claims_checked: 20, supported: 18 },
        coverage: {
          per_tier: {
            beginner: { hits: 2, gold_total: 4 },
            advanced: { hits: 3, gold_total: 4 },
          },
        },
        personalization: {
          blind_tier_judge: {
            ran: true,
            hit: 3,
            total: 4,
            rows: [{ scene: '写入路径', truth: 'beginner', guess: 'advanced' }],
          },
        },
      }),
    },
    products: {},
    warnings: [],
    error: '',
  };
  const base = { run_id: record.run_id, iso: '', kind: 'stage_done' };
  const events: IntakeEvent[] = [
    {
      ...base,
      seq: 0,
      ts: 100,
      stage: 'chunk',
      message: '切块入库 完成',
      detail: record.stages.chunk.detail,
      status: 'done',
    },
    {
      ...base,
      seq: 1,
      ts: 200,
      stage: 'trial',
      message: '试跑课程 完成',
      detail: record.stages.trial.detail,
      status: 'done',
    },
    {
      ...base,
      seq: 2,
      ts: 300,
      stage: 'metrics',
      message: '指标复测 完成',
      detail: record.stages.metrics.detail,
      status: 'done',
    },
    { ...base, seq: 3, ts: 300, stage: 'run', kind: 'run_done', message: 'run 完成' },
  ];
  return [record, events];
}

function render(chunks: number, trialRun: boolean): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const [record, events] = fixture(chunks, trialRun);
  act(() => {
    createRoot(host).render(<IntakeRunView record={record} events={events} />);
  });
  return host.textContent ?? '';
}

describe('接入 run 观看端 · ⑥⑦', () => {
  it('⑥⑦ 的 detail 字段出中文名，run 头写明试跑开关', () => {
    const text = render(40, true);
    expect(text).toContain('试跑体检 开');
    expect(text).toContain('试跑课题');
    expect(text).toContain('模型调用');
    expect(text).toContain('受检断言');
    expect(text).toContain('盲评判档');
    // 裸键不许上屏
    expect(text).not.toContain('course_title');
    expect(text).not.toContain('claims_checked');
  });

  it('试跑没开时头上写「关」', () => {
    expect(render(40, false)).toContain('试跑体检 关');
  });

  it('② 站块数偏少时提醒，够了不提醒', () => {
    expect(render(6, true)).toContain('证据块偏少');
    expect(render(12, true)).not.toContain('证据块偏少');
  });

  it('盲评的 rows 不会被贴成「向量条数」', () => {
    expect(render(40, true)).not.toContain('向量条数');
  });

  it('档位名在键位和值位都出中文', () => {
    const text = render(40, true);
    // 键位：⑥ 的 paths、⑦ 的 per_tier
    expect(text).toContain('入门档');
    expect(text).toContain('进阶档');
    // 值位：盲评那一行的 truth / guess
    expect(text).toContain('实际档位 入门档');
    expect(text).toContain('判官判的档位 进阶档');
  });
});
