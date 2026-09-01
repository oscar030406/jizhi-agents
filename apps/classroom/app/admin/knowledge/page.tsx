/**
 * 知识库中心 · 总览。
 *
 * 产品承诺是「机构接入自己的知识库、系统按它生成课程」。引擎侧六个语料库的状态一直在盘上，
 * 产品侧此前没有入口——这一页是那个入口，也是后面「换库生成 / 上传重建 / 流水线 run」
 * 几页的骨架。
 *
 * 数字全部现算自引擎数据目录里的产物文件（见 `lib/server/knowledge-center.ts` 的真源表），
 * 不经引擎进程：引擎停机时这一页照常出全量数据，不会闪「不可用」。
 *
 * ## 排序：接入在前，总览在后（2026-08-16 用户评审）
 *
 * 原来这一页把六张库卡片铺在最上面，「新增一个库」缩在页尾一个 14px 的小标题下。
 * 用户的原话是「重要程度倒置，换库入口仅在左上一小个按钮」——这一页存在的理由是
 * **机构能把自己的语料接进来**，库总览是接进来之后的结果。所以接入区升为置顶大区块
 * （说明 + 表单 + 花销全在同一屏），库总览排它后面。
 *
 * 视觉走公共页那套实拔公式（`docs/03-design/ui/reference-teardown-20260815.md`）：
 * 纯白基底、看得见的天蓝段落带、H1 44px / H2 28px、段落 py-16 级留白；
 * 口径与命令行全部进 `<Caliber>` 折叠，默认视图只留结论与表单。
 */

import Link from 'next/link';
import { Boxes, ScrollText, Upload } from 'lucide-react';

import { SiteHeader } from '@/components/site-header';
import { Caliber } from '@/components/admin/caliber';
import { CorpusCard } from '@/components/admin/knowledge-center';
import { SectionAnchor } from '@/components/home/section-anchor';
import { corpusVisibilityFor } from '@/lib/accounts/org-store';
import { isScratchCorpus } from '@/lib/knowledge/domain-registry';
import { redactCaliber } from '@/lib/metrics/redact-caliber';
import { readCorporaWithDrift } from '@/lib/server/knowledge-center';
import { cn } from '@/lib/utils';

import { Denied, managerAccount } from './guard';
import { StartIntake } from './start-intake';

export const dynamic = 'force-dynamic';

/** 公共页实拔出来的两条段落带（天蓝，chroma ≥0.1）。暗色下退回主题底色，不做二次调色。 */
const BAND_SOFT = 'bg-[rgb(228,238,253)] dark:bg-blue-soft';
const CONTAINER = 'mx-auto w-full max-w-6xl px-4 sm:px-6';

export default async function KnowledgeCenterPage() {
  const account = await managerAccount();
  if (!account) return <Denied />;
  const visible = await corpusVisibilityFor(account.id);
  const { corpora: allCorpora, drift: allDrift } = await readCorporaWithDrift(visible);
  const corpora = allCorpora.filter(
    (corpus) =>
      !isScratchCorpus(corpus.corpus) &&
      !/(?:fullprobe|fullpath[-_]?probe|(?:^|[-_])probe(?:[-_]|$))/i.test(corpus.corpus),
  );
  const drift = allDrift.filter(
    (note) =>
      !/(?:fullprobe|fullpath[-_]?probe|(?:^|[-_\s])probe(?:[-_\s]|$))/i.test(note),
  );
  const withIndex = corpora.filter((c) => c.available);

  return (
    <>
      <SiteHeader backHref="/admin" backLabel="回管理端" maxWidth="max-w-6xl" />
      <main className="bg-white dark:bg-background">
        <header className="pt-12 pb-4 sm:pt-16">
          <div className={CONTAINER}>
            <h1 className="text-[36px] font-medium leading-[1.1] tracking-[-0.02em] sm:text-[44px]">
              知识库
            </h1>

          </div>
        </header>

        {/* ── 接入区：这一页的主动作 ───────────────────────────────────── */}
        <section className={cn('py-14 sm:py-16', BAND_SOFT)}>
          <div className={CONTAINER}>
            <h2 className="flex items-center gap-2.5 text-[28px] font-semibold leading-snug tracking-tight">
              <SectionAnchor icon={Upload} />
              接入新知识库
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              接收清洗 → 切块入库 → 建索引 → 整理知识 → 派生金标，五站的数在过程中逐站可看。
            </p>

            <div className="mt-7 rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6">
              <StartIntake />
            </div>

            <Caliber summary="展开：每次接入留下的记录">
              <p>
                走这个表单接入的每一次都留了记录——哪一站什么时候跑的、跑出什么数、
                哪几站是同时跑的、失败的那次卡在哪。档位定义也存在同一份记录里。
              </p>
            </Caliber>

            <p className="mt-4 text-sm">
              <Link
                href="/admin/knowledge/runs"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 font-medium shadow-card transition-colors hover:bg-accent"
              >
                <ScrollText className="size-4" />
                看接入记录
              </Link>
            </p>
          </div>
        </section>

        {/* ── 库总览：接进来之后的结果 ─────────────────────────────────── */}
        <section className="py-14 sm:py-16">
          <div className={CONTAINER}>
            <h2 className="flex items-center gap-2.5 text-[28px] font-semibold leading-snug tracking-tight">
              <SectionAnchor icon={Boxes} />
              已有的库
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              共 {corpora.length} 个，其中 {withIndex.length} 个已建成可检索索引。
              生成课程时选哪个库，取的就是这里的索引。
            </p>

            <div className="mt-7">
              {corpora.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs leading-relaxed text-muted-foreground">
                  系统暂时无法读取知识库状态，因此不展示旧数据。请刷新页面重试；反复出现请联系平台维护人员。
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {corpora.map((c) => (
                    <CorpusCard key={c.corpus} corpus={c} />
                  ))}
                </div>
              )}
            </div>

            <Caliber summary="展开口径：每张卡的数字是怎么数出来的">
              <p>
                证据块数、就绪度与许可均来自系统最近一次处理结果；页面显示最近处理时间，无法确认的字段不展示。
              </p>
            </Caliber>

            {/* 公开页 /skills 的静态快照与当前磁盘对不上时说一声。不一致本身要可见：
                引擎在线时那一页会自动换成实时数据，引擎离线时访客看到的就是这份快照。 */}
            {drift.length > 0 ? (
              <section className="mt-6 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3">
                <p className="text-xs font-medium">公开页数据待更新</p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                  {drift.map((note) => (
                    <li key={note}>{redactCaliber(note)}</li>
                  ))}
                </ul>
                <Caliber summary="展开：为什么会落后、什么时候更新">
                  <p>
                    岗位技能地图页会优先显示已发布数据，服务可用时再读取最新结果；暂时不可用时仍保留已发布内容。
                  </p>
                  <p>
                    已发布数据会随平台更新刷新；如需提前处理，请联系平台维护人员。
                  </p>
                </Caliber>
              </section>
            ) : null}

            <p className="mt-8 text-[11px] text-muted-foreground">
              课程审核与全局指标在{' '}
              <Link href="/admin" className="underline underline-offset-2 hover:text-foreground">
                管理端总览
              </Link>
              。
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
