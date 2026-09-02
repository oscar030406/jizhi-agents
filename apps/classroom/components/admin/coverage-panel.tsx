/**
 * 覆盖缺口 + 资源难度供给（赛题五(3)① 三张图里的另外两张，机构维度）。
 *
 * 「知识盲区定位」在赛题原文里说的是学习者的盲区，个人版在 `/report`。
 * 机构侧的对应物是**资源缺口**：金标里有、生成的课没讲到的知识点。
 * 两者不是同一件事，标题上分开写，别让读者以为这是学情。
 *
 * 「资源难度匹配曲线」的机构版**画不出来**：匹配曲线要把学习者分布与资源难度
 * 对起来，而我们没有跨人数据（设计稿第八节）。这里只出供给侧分布，
 * 并把这句限制印在图旁边。
 *
 * 金标分两批呈现：`frozen-v1`（教材 TOC 独立构建、专家审查、生成前冻结）是能对外的那批；
 * 事后补的草稿金标（draft-v1-posthoc）分数照出，但单独一组、写明不进对外数字。
 * 原来这两批混在一张表里，脚注却写着「分母是生成前冻结的金标」——那句话对一半的行是假的。
 */

import Link from 'next/link';

import type { CoverageRow } from '@/lib/server/knowledge-map';

import { Caliber } from './caliber';
import { TIER_BG, TIER_UNKNOWN_BG, tierLabel } from './difficulty-scale';

/** 达标线：90%。画在条上而不是只写在脚注里——读者要看的是「差多少」，不是背一个数 */
const TARGET = 90;

function CoverageRows({ rows }: { readonly rows: readonly CoverageRow[] }) {
  return (
    <>
      {rows.map((r) => {
        const pctNum = Math.round(r.coverage * 100);
        return (
          <div key={r.topic} className="border-b border-border/60 px-4 py-3 last:border-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-medium">{r.courseName || r.topic}</span>
              <span className="tabular-nums text-xs">
                {pctNum}%
                <span className="ml-1 text-[10px] text-muted-foreground">
                  （{Math.round(r.coverage * r.total)}/{r.total} 个知识成分）
                </span>
              </span>
            </div>
            <div className="relative mt-2 h-2 rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${pctNum >= TARGET ? 'bg-emerald-500' : 'bg-amber-500'}`}
                style={{ width: `${pctNum}%` }}
              />
              {/* 达标线画在条上面而不是只写在脚注：满格的绿条也要看得见这条线在哪 */}
              <span
                className="absolute inset-y-[-3px] w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
                style={{ left: `${TARGET}%` }}
                aria-hidden
              />
            </div>
            {r.missing.length > 0 && (
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                缺口：{r.missing.join('、')}
              </p>
            )}
            {/* 这条 run 测的课已经不在课程墙上 = 这个数是旧版课的成绩。
                不隐藏、不替换、也不补造新 summary（那等于写没跑过的数），
                只把事实标出来，读者自己判断该不该引用。 */}
            {!r.courseStillOnWall && (
              <p className="mt-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-2 py-1 text-[11px] leading-relaxed text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
                旧版课的成绩：
                <code className="mx-1 font-mono">{r.courseId}</code>
                已被重生成版取代，不在课程墙上。
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

export function CoveragePanel({ rows }: { readonly rows: readonly CoverageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
        还没有知识点覆盖率结果。平台完成评测后会在这里显示。
      </p>
    );
  }
  const frozen = rows.filter((r) => r.status === 'frozen-v1');
  const draft = rows.filter((r) => r.status !== 'frozen-v1');
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <CoverageRows rows={frozen} />
        {draft.length > 0 && (
          <>
            <p className="border-y border-dashed border-border bg-muted/40 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              以下 {draft.length} 个主题：课先生成、金标后补，分数只够自查，不进对外数字。
            </p>
            <CoverageRows rows={draft} />
          </>
        )}
      </div>
      <Caliber summary="展开口径：分母、达标线与数据来源">
        {draft.length > 0 && (
          <p>
            上面标注的那 {draft.length} 个主题，金标不是生成前冻结的，归档状态写作
            <span className="mx-1 font-mono">
              {[...new Set(draft.map((r) => r.status))].join('、')}
            </span>
            ——课先生成、金标后补。
          </p>
        )}
        <p>
          只列<strong className="font-medium">实测过</strong>的主题，共 {rows.length}{' '}
          个（其中生成前冻结金标 {frozen.length} 个）。 没跑过覆盖率的课不在这里，也不补 0
          或估计值。竖线是 {TARGET}% 达标线，绿色 = 过线。
          本表采用最近一次归档评测；上面“全局指标”的汇总覆盖率采用重生成后复测口径。
          个别复测尚未归档时，两处可能暂时不一致，以平台全局指标台账为准。
        </p>
      </Caliber>
    </div>
  );
}

export function DifficultySupply({
  tiers,
}: {
  readonly tiers: readonly { tier: string; concepts: string[] }[];
}) {
  const max = Math.max(1, ...tiers.map((t) => t.concepts.length));
  const total = tiers.reduce((a, t) => a + t.concepts.length, 0);
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-border bg-card p-4">
        {tiers.length === 0 ? (
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            系统暂时无法读取概念图谱，因此不展示旧数据。请刷新页面重试；反复出现请联系平台维护人员。
          </p>
        ) : (
          <ul className="space-y-3.5">
            {tiers.map((t) => (
              <li key={t.tier}>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-medium">{tierLabel(t.tier)}</span>
                  <span className="tabular-nums text-[11px] text-muted-foreground">
                    {t.concepts.length} / {total} 个概念
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${TIER_BG[t.tier] ?? TIER_UNKNOWN_BG}`}
                    style={{ width: `${(t.concepts.length / max) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Caliber summary="展开口径：这张分布图能说明什么、不能说明什么">
        <p>
          这是<strong className="font-medium">资源供给按难度档的分布</strong>
          ，不是「资源难度匹配曲线」。 那条曲线要把<strong className="font-medium">学习者</strong>
          的能力分布与资源难度对起来， 属于个人维度，可在{' '}
          <Link href="/report" className="underline underline-offset-2 hover:text-foreground">
            学习报告页面
          </Link>{' '}
          查看。 平台不汇总跨学习者数据，因此机构维度仅展示供给侧分布。
        </p>
        {total > 0 && (
          <>
            <p>
              难度档来自系统概念图谱，来源说明为“教材章节顺序 + 领域判断人工策展”，
              <strong className="font-medium">共 {total} 个概念</strong>——
              这是概念级的人工标注，不能拿来推断整个知识库（1704 个片段）的深浅。
              路径图里标「未标」的概念没有难度档，不在分母里；条的深浅与路径图左侧同一套色阶。
            </p>
            {/* 逐档概念名：默认视图里它是一大坨顿号串，收进来但一个不删 */}
            {tiers.map((t) => (
              <p key={t.tier}>
                <strong className="font-medium">{tierLabel(t.tier)}</strong>：
                {t.concepts.join('、')}
              </p>
            ))}
          </>
        )}
      </Caliber>
    </div>
  );
}
