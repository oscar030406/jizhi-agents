/**
 * 管理端信息分层的两条有分支的逻辑（2026-08-16）：
 *
 * 1. 指标卡「唯一那句限定语」挑得对不对——挑错了，样本量与置信区间就掉进折叠里，
 *    卡面只剩一个裸百分数，正是 08-13 定的规矩要挡的那种展示。
 * 2. 语料库结论卡的名字必须走 `domain-labels.ts`，不能把接入目录名（iotdb / odoo）
 *    直接印在管理者眼前。
 *
 * 视觉本身（字阶、段落带、留白）不在这里验，那要拔真实 DOM 的 computed style。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DomainIntakeSummary, gateCount } from '@/components/admin/domain-intake-summary';
import { MetricBand, qualifierLine } from '@/components/admin/metric-band';
import type { DomainIntake, MetricEntry } from '@/lib/server/admin-overview';

describe('指标卡的唯一一句限定语', () => {
  it('数字行自己带了分母或区间，就不再补一句', () => {
    // 适配准确率：n 与 CI 都在主数字后面的括号里
    expect(
      qualifierLine(
        '85.2%（95% CI 77.8–92.6%，n=108，下界未达 85%）——rubric v4 三判官全量多数决',
        '口径 v4：108 组 = 3 档画像 × 12 主题 × 3 实例。',
      ),
    ).toBe('');
    // 覆盖率：分母在主数字前面（「汇总 48/50 =」）
    expect(qualifierLine('汇总 48/50 = 96.0%（6 门金标课）；逐门：RAG 9/9', '核心知识点覆盖率。')).toBe('');
  });

  it('裸百分数的指标，从口径原文里挑带分母/区间的那一句', () => {
    const line = qualifierLine(
      '2.1%',
      '真实 LLM 生成端，口径 v2（2026-08-04 重建）。断言级：576 条可核断言/57 个真 LLM run，12 条判无据；95%CI [0.012,0.036]。含 weak 的宽口径上界 0.023。',
    );
    // 挑的是第二句：它带样本量与区间；第一句只有口径版本号
    expect(line).toBe('断言级：576 条可核断言/57 个真 LLM run，12 条判无据；95%CI [0.012,0.036]。');
    // 是原文照搬，不是改写
    expect(line.length).toBeLessThan(60);
  });

  it('口径里一句带分母的都没有，就退回第一句，不留空白', () => {
    expect(qualifierLine('3.4%', '这个指标还没有写口径。')).toBe('这个指标还没有写口径。');
    expect(qualifierLine('3.4%', '')).toBe('');
  });
});

/**
 * 08-16 退单：卡面只印一句限定语，但台账 value 分隔符后面那截不是「不印」而是被**删了**。
 * 这条守的是「收进折叠 ≠ 删」——两条真台账原文，逐段在 DOM 里搜得到。
 */
describe('台账 value 一个字不删', () => {
  const totals = {
    courses: 1,
    scenes: 1,
    audited: 1,
    claims: 1,
    incorrect: 0,
    uncertain: 0,
    incorrectRate: 0,
    groundedRate: 1,
    distinctSources: 1,
  };

  function band(value: string, caliber = '口径。') {
    const m: MetricEntry = { id: 'x', value, caliber, source: 'run xyz' };
    return renderToStaticMarkup(<MetricBand metrics={[m]} totals={totals} />);
  }

  it('数字行已带分母（卡面无限定语）时，detail 进折叠而不是消失', () => {
    const html = band(
      '85.2%（95% CI 77.8–92.6%，n=108，下界未达 85%）——rubric v4 三判官全量多数决，12 主题 × 9 画像。精确二项检验 P(X≥92 | n=108, p=0.85) = 0.545，样本对「真值高于 85%」的证据量为零。',
    );
    expect(html).toContain('精确二项检验');
    expect(html).toContain('证据量为零');
    // 折叠里，不在卡面
    expect(html).toContain('展开口径原文与复算命令');
  });

  it('覆盖率的六门逐门数字一门都不能少', () => {
    const html = band(
      '汇总 48/50 = 96.0%（6 门金标课）；逐门：RAG 9/9、Softmax温度 7/7、KV缓存 7/7、VLA 6/6、注意力 9/10、ROS2 10/11——全部 ≥90% 达标线',
    );
    for (const s of ['RAG 9/9', 'Softmax温度 7/7', 'KV缓存 7/7', 'VLA 6/6', '注意力 9/10', 'ROS2 10/11']) {
      expect(html).toContain(s);
    }
  });

  it('detail 已经当上卡面那句限定语时，折叠里不重复印一遍', () => {
    const html = band('88.9%——48/54，run 20260811-012228');
    expect(html.match(/48\/54/g)).toHaveLength(1);
  });
});

function intake(over: Partial<DomainIntake> = {}): DomainIntake {
  return {
    domain: 'iotdb',
    scope: '工业时序数据库运维与开发',
    sourceDir: 'D:/corpora/Master',
    license: { spdx: 'Apache-2.0', unknown: false },
    acceptedFiles: 230,
    rejectedFiles: 0,
    sections: 3070,
    conceptCount: 12,
    chapterCount: 35,
    chapterEdges: 8,
    candidateEdges: 35,
    nodeEdges: 4,
    gates: { retrievable: true, vocabulary: true, graph: true, itemMapping: false },
    chunks: 3202,
    tierRange: 'L1-L3',
    ...over,
  };
}

describe('语料库结论卡', () => {
  it('卡上是中文显示名，不是接入目录名', () => {
    const html = renderToStaticMarkup(<DomainIntakeSummary intakes={[intake()]} />);
    expect(html).toContain('时序数据库 IoTDB');
    // 目录名（全小写的 id）不上屏
    expect(html).not.toMatch(/(^|[^\w-])iotdb([^\w-]|$)/);
    expect(html).toContain('3,202');
    expect(html).toContain('3/4 道闸');
    expect(html).toContain('可用于生成课程');
  });

  it('闸零不过 = 现在生成不出课，这一句要直接可见', () => {
    const html = renderToStaticMarkup(
      <DomainIntakeSummary
        intakes={[
          intake({
            gates: { retrievable: false, vocabulary: true, graph: false, itemMapping: false },
            chunks: 0,
          }),
        ]}
      />,
    );
    expect(html).toContain('时序数据库 IoTDB');
    expect(html).toContain('语料没进检索库，暂时生成不出课');
    expect(html).toContain('1/4 道闸');
  });

  it('没有接入记录时整块不渲染', () => {
    expect(renderToStaticMarkup(<DomainIntakeSummary intakes={[]} />)).toBe('');
  });

  it('闸数就是四个布尔里为真的个数', () => {
    expect(gateCount({ retrievable: true, vocabulary: true, graph: true, itemMapping: true })).toBe(4);
    expect(gateCount({ retrievable: false, vocabulary: false, graph: false, itemMapping: false })).toBe(0);
  });
});
