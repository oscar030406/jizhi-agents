'use client';

/**
 * 公共首页「相关指标」三条（工单 WO-C1 §4 用户 08-15 点名）。
 *
 * 首页只列这三条，其余（外部数据集上的检测层 F1、仲裁挡下的比例、岗位技能证据覆盖、
 * 学习增益对照、领域泛化…）留在 /evidence 的完整台账里——不是撤数据，是首页不列。
 * 完整台账的组件是 components/evidence/metrics-ledger.tsx，本文件不重复它的口径长段。
 *
 * 数字纪律（与台账同一条）：值只能来自 apps/agent-engine/data/metrics.json。
 * 本页**不再手抄那些数字**——三张卡的每个数都来自 public-metrics.json，那份文件由
 * `node scripts/sync-public-metrics.mjs` 从 metrics.json 生成（构建期常量，import 进来，
 * 运行时不碰引擎，公共页零引擎依赖照旧）。改数：改 metrics.json → 跑同步脚本 →
 * 跑 `python apps/agent-engine/scripts/check_metrics.py`。
 *
 * 逐条对照（字段 → 本页写法）：
 *   api_hallucination_v2      口径含「576 条可核断言 / 57 个真 LLM run，12 条判无据」
 *                             → 首页拆成分子分母的人话，百分数按 12/576 算（同步脚本里
 *                               拿 value 0.021 校验，对不上就报错）
 *   adaptation_accuracy_2a    85.2%，n=108
 *                             → 首页只写点估计与样本量；置信区间那一整段全口径留在
 *                               /evidence 台账与 docs/05-evidence/adaptation-ci-honest-reporting-20260813.md，
 *                               那两处一个字都不动，这里只是首页的详略取舍
 *   kc_coverage_v1            汇总 48/50 = 96.0%（6 门金标课）
 *                             → 用汇总口径，不用逐门数（单门分母 6-11，小分母不承诺置信度）
 *
 * 措辞上不写「随机抽」：断言是从讲义里逐句抽取后判定的，不是随机抽样，
 * 写「随机」等于凭空给评测加一条它没有的方法学声明。
 */

import Link from 'next/link';

import { CARD_RECIPE_STATIC } from '@/components/home/course-card';
import m from '@/components/home/public-metrics.json';
import { cn } from '@/lib/utils';

const METRICS = [
  {
    name: '生成端幻觉率',
    value: m.hallucination.percent,
    soft: 'bg-red-soft',
    deep: 'text-red-deep',
    plain: `${m.hallucination.runs} 次真实生成里抽出 ${m.hallucination.claims} 条可核陈述，逐条对教材核验，${m.hallucination.unsupported} 条在教材里找不到依据。`,
  },
  {
    name: '学习者画像适配准确率',
    value: m.adaptation.percent,
    soft: 'bg-purple-soft',
    deep: 'text-purple-deep',
    plain: `${m.adaptation.n} 组盲评：判定的人看不到画像，只看资源本身判难度档，与目标档一致算命中。`,
  },
  {
    name: '核心知识点覆盖率',
    value: m.kcCoverage.percent,
    soft: 'bg-green-soft',
    deep: 'text-green-deep',
    plain: `${m.kcCoverage.courses} 门课对着生成前就冻结的知识点清单点名，${m.kcCoverage.total} 个点讲到了 ${m.kcCoverage.hit} 个。`,
  },
] as const;

export function KeyMetrics() {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[28px] font-semibold leading-snug">相关指标</h2>
        <Link
          href="/evidence"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
        >
          每个数的完整口径与复算命令 →
        </Link>
      </div>
      <dl className="mt-5 grid gap-4 sm:grid-cols-3">
        {METRICS.map((m) => (
          <div key={m.name} className={cn(CARD_RECIPE_STATIC, 'p-5')}>
            <dt className="text-sm text-muted-foreground">{m.name}</dt>
            <dd
              className={cn(
                'mt-1 text-3xl font-semibold tabular-nums [font-feature-settings:\'tnum\']',
                m.deep,
              )}
            >
              {m.value}
            </dd>
            <dd className="mt-2 text-xs leading-[1.75] text-muted-foreground">{m.plain}</dd>
            <div className={cn('mt-3 h-1 w-10 rounded-full', m.soft)} aria-hidden />
          </div>
        ))}
      </dl>
    </>
  );
}
