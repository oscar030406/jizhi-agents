/**
 * 接入表单的难度语义化：档数 ↔ 引擎档位码的映射层，以及档位定义在 run 页面上的显示。
 *
 * 会响的点有三个：
 * 1. 映射写反或写死（档数变了档位码不跟着变）——`tierRangeFor` 三条。
 * 2. 档位码漏回 DOM（旧版是表单 `defaultValue="L1-L3"`，用户看不懂那是什么）。
 * 3. 老 run 没有 `tier_definitions` 时退化成印内部档位码。
 *
 * 单独一个文件：`tests/server/admin-*.test.tsx` 是别人的，不进去抢。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { tierRangeFor } from '@/app/admin/knowledge/start-intake';
import { DomainIntakeTable } from '@/components/admin/domain-intake-table';
import { IntakeRunView } from '@/components/admin/intake-run-view';
import type { DomainIntake } from '@/lib/server/admin-overview';
import type { IntakeRunRecord } from '@/lib/server/intake-runs';

/** 裸档位码：`L1`–`L4` 独立成词。SVG 的 path 指令不在渲染结果的文本里，这里不必剥。 */
const TIER_CODE = /\bL[1-4]\b/;

describe('档数 → 引擎档位码', () => {
  it('分几档就切几层：2 档 → L1-L2，3 档 → L1-L3', () => {
    expect(tierRangeFor(2)).toBe('L1-L2');
    expect(tierRangeFor(3)).toBe('L1-L3');
  });

  it('1 档不写成区间；越界的档数夹回 1–4，不抛给引擎一个它解析不了的串', () => {
    expect(tierRangeFor(1)).toBe('L1');
    expect(tierRangeFor(0)).toBe('L1');
    expect(tierRangeFor(9)).toBe('L1-L4');
  });
});

function intake(over: Partial<DomainIntake>): DomainIntake {
  return {
    domain: '冷链仓储运维',
    scope: '冷链仓储的温区管理',
    acceptedFiles: 3,
    rejectedFiles: 0,
    chunks: 4,
    sections: 4,
    conceptCount: 0,
    tierRange: 'L1-L3',
    chapterCount: 0,
    candidateEdges: 0,
    chapterEdges: 0,
    nodeEdges: 0,
    sourceDir: 'D:\\refs\\iotdb-docs\\UserGuide\\Master',
    license: { spdx: 'CC-BY-SA-4.0', unknown: false },
    gates: { retrievable: true, vocabulary: false, graph: false, itemMapping: false },
    ...over,
  } as DomainIntake;
}

describe('就绪度表不印内部档位码', () => {
  it('L1-L3 转写成「1 级 – 3 级」，渲染结果里找不到裸档位码', () => {
    const html = renderToStaticMarkup(<DomainIntakeTable intakes={[intake({})]} />);
    expect(html).toContain('1 级 – 3 级');
    expect(html).not.toMatch(TIER_CODE);
  });

  it('外部资料只说明由平台管理，不展示接入机器路径', () => {
    const html = renderToStaticMarkup(<DomainIntakeTable intakes={[intake({})]} />);
    expect(html).toContain('平台管理的外部资料源');
    expect(html).not.toMatch(/D:\\|UserGuide[\\/]Master/);
  });

  it('页面上传来的语料不印 run 编号，说清是这次上传的', () => {
    const html = renderToStaticMarkup(
      <DomainIntakeTable
        intakes={[
          intake({ sourceDir: 'D:\\x\\knowledge_base\\intake_runs\\20260816T033452-2c7cae\\docs' }),
        ]}
      />,
    );
    expect(html).toContain('本次接入时上传的文档');
    expect(html).not.toContain('20260816T033452');
  });

  it('不把 probe/fullprobe 测试领域渲染到就绪度表', () => {
    const html = renderToStaticMarkup(
      <DomainIntakeTable
        intakes={[
          intake({ domain: 'fullprobe' }),
          intake({ domain: 'probe_fixture' }),
          intake({ domain: 'iotdb' }),
        ]}
      />,
    );
    expect(html).toContain('iotdb');
    expect(html).not.toMatch(/fullprobe|probe_fixture/i);
  });

  it('没量到档位区间就显示「—」，不兜底成某一档', () => {
    const html = renderToStaticMarkup(<DomainIntakeTable intakes={[intake({ tierRange: '' })]} />);
    expect(html).not.toMatch(TIER_CODE);
    expect(html).toContain('素材分档');
  });
});

/** 老 run 记录：`tier_definitions` 是 08-16 才加的，08-16 之前的 run 只有 `tier_range`。 */
function record(options: Record<string, unknown>): IntakeRunRecord {
  return {
    run_id: '20260815T181752-21882a',
    corpus: 'iotdb',
    scope: '时序数据库运维',
    status: 'done',
    created_at: '2026-08-15T18:17:52',
    finished_at: '2026-08-15T18:18:02',
    duration_ms: 10000,
    options,
    limits: {},
    files: [{ name: 'a.md', original: 'a.md', bytes: 10 }],
    stages: {},
    products: {},
    warnings: [],
    error: '',
  };
}

describe('run 页面的档位显示：老 run 也不印内部档位码', () => {
  it('没有 tier_definitions 就退回按 tier_range 数档数，档位码本身不上屏', () => {
    const html = renderToStaticMarkup(
      <IntakeRunView record={record({ tier_range: 'L1-L3' })} events={[]} />,
    );
    expect(html).toContain('学习者分 3 档');
    expect(html).not.toMatch(TIER_CODE);
  });

  it('有 tier_definitions 就按它数档、并把管理者写的原文逐档印出来', () => {
    const html = renderToStaticMarkup(
      <IntakeRunView
        record={record({
          tier_range: 'L1-L3',
          tier_definitions: [
            { label: '入门', audience: '没接触过这套系统的新人' },
            { label: '进阶', audience: '要独立处理现场问题的人' },
          ],
        })}
        events={[]}
      />,
    );
    // 档数以用户填的那层为准，不以折出来的 tier_range 为准（这里两者故意不一致）。
    expect(html).toContain('学习者分 2 档');
    expect(html).toContain('没接触过这套系统的新人');
    expect(html).not.toMatch(TIER_CODE);
  });
});
