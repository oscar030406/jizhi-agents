/**
 * 知识库中心 · 单库详情：入库管线五站建到哪、各站产物是哪个文件、什么时候更新的。
 *
 * 「迭代更新可视化」的第一层就是每站的 mtime——现在没有任务系统，产物文件的修改时间
 * 是磁盘上唯一能拿到的「上次更新」。等流水线 run 有记录了，每站底下再挂事件流
 * （扩展位留在 `components/admin/knowledge-center.tsx` 的 `StationRow` 里）。
 *
 * 不做的：不显示进度百分比、不显示历史版本。两者都需要任务记录，现在没有，编一个更糟。
 */

import { notFound } from 'next/navigation';

import { SiteHeader } from '@/components/site-header';
import { FitnessLight, StationRow, stamp } from '@/components/admin/knowledge-center';
import { SourceFilesPanel } from '@/components/admin/knowledge-source';
import { CorpusPreviewButton } from '@/components/admin/corpus-preview-button';
import { PracticeScoutPanel } from '@/components/admin/practice-scout-panel';
import { corpusVisibilityFor } from '@/lib/accounts/org-store';
import { domainLabel, hasDomainLabel } from '@/lib/knowledge/domain-labels';
import { isScratchCorpus } from '@/lib/knowledge/domain-registry';
import { redactCaliber } from '@/lib/metrics/redact-caliber';
import { isValidCorpusName, readCorpus } from '@/lib/server/knowledge-center';
import { readSourceView } from '@/lib/server/knowledge-source';

import { Denied, managerAccount } from '../guard';

export const dynamic = 'force-dynamic';

const BACKEND_NOTE: Record<string, string> = {
  vector: '向量索引已建（bge-m3）。查询嵌入不可用时检索自动降级 TF-IDF，不会失败。',
  tfidf:
    '目前只有关键词索引，检索走 TF-IDF；语义检索用的向量索引还没建。如需升级，请联系平台维护人员。',
  none: '这个库还没建成索引，系统按这个名字取不到检索器；用它生成课程时没有素材可引。先在「接入新知识库」把这个库跑完。',
};

export default async function CorpusDetailPage({
  params,
}: {
  readonly params: Promise<{ corpus: string }>;
}) {
  const { corpus: name } = await params;
  const account = await managerAccount();
  if (!account) return <Denied />;
  if (!isValidCorpusName(name)) notFound();
  if (
    isScratchCorpus(name) ||
    /(?:fullprobe|fullpath[-_]?probe|(?:^|[-_])probe(?:[-_]|$))/i.test(name)
  )
    notFound();
  const visible = await corpusVisibilityFor(account.id);
  if (!visible(name)) notFound();
  // 页标题走 domainLabel，先灌域注册清单（同 admin 总览页的补法）
  const { readDomainRegistry } = await import('@/lib/server/domain-registry');
  await readDomainRegistry().catch(() => null);
  const corpus = await readCorpus(name);
  if (!corpus) notFound();
  const sources = await readSourceView(name);

  const updated = stamp(corpus.updatedAt);
  const built = corpus.stations.filter((s) => s.built).length;

  return (
    <>
      <SiteHeader
        backHref="/admin/knowledge"
        backLabel="回知识库"
        maxWidth="max-w-4xl"
      />
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <header className="mb-8">
          {/* 中文名走 `lib/knowledge/domain-labels.ts` 的单一真源；库 id 仍然印出来，
              因为下面的复算命令与磁盘路径都用它，抹掉 id 反而不能照着核。
              没登记中文名的库（开放集，接入链随时会造新的）就只印 id，不编一个。 */}
          <h1 className="text-xl font-semibold tracking-tight">{domainLabel(corpus.corpus)}</h1>
          {hasDomainLabel(corpus.corpus) && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">{corpus.corpus}</p>
          )}
          {corpus.scope && <p className="mt-1 text-sm text-muted-foreground">{corpus.scope}</p>}
          <p className="mt-2 text-xs text-muted-foreground">
            五站中 {built} 站有产物
            {corpus.chunks !== null && ` · ${corpus.chunks} 个证据块`}
            {updated && ` · 最近处理时间 ${updated}`}
          </p>
          <p className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {BACKEND_NOTE[corpus.backend]}
          </p>
          {/* §7.1 承诺的「一键切换至该知识库视角预览学习端」。审计发现从未实现，这里补上。 */}
          <CorpusPreviewButton corpus={corpus.corpus} />
        </header>

        <section className="mb-10">
          <h2 className="mb-1 text-sm font-medium">入库管线</h2>
          <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground">
            亮灯表示系统已经收到这一站的处理结果，并显示最近处理时间。亮灯不代表质量——质量看下面的就绪度闸位。
          </p>
          <ol className="space-y-5 border-l border-border/70 pl-1">
            {corpus.stations.map((s) => (
              <StationRow key={s.id} station={s} />
            ))}
          </ol>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-sm font-medium">就绪度</h2>
          {corpus.gates ? (
            <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                {([
                  ['闸零 可检索', corpus.gates.retrievable],
                  ['闸一 概念词表', corpus.gates.vocabulary],
                  ['闸二 前置图连通', corpus.gates.graph],
                  ['闸三 测项映射', corpus.gates.itemMapping],
                ] as const).map(([label, ok]) => (
                  <div key={label}>
                    <dt className="text-[10px] text-muted-foreground">{label}</dt>
                    <dd className={`text-sm ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                      {ok ? '过' : '未过'}
                    </dd>
                  </div>
                ))}
              </dl>
              <ul className="mt-4 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {corpus.concepts !== null && <li>抽出概念 {corpus.concepts} 个。</li>}
                <li>
                  前置边人工确认 {corpus.gates.reviewedEdges} 条
                  {corpus.gates.reviewedEdges === 0 &&
                    '——全部只作软前置，用于给未掌握的教材块排序，不当硬性先修条件'}
                  。
                </li>
                {!corpus.gates.itemMapping && (
                  <li>
                    闸三未过：测项映射未实现，这个库里概念的掌握度置信封顶、且不允许跳过。
                  </li>
                )}
                {corpus.license && (
                  <li>
                    许可 {corpus.license.spdx}
                    {corpus.license.unknown && '（源目录里没找到许可声明，待人工确认后再对外用）'}。
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-xs leading-relaxed text-muted-foreground">
              这个库没有就绪度报告。主语料 ai 建于入库链之前，其余没有报告的就是还没跑过入库链。
              闸位由入库链产出，跑过之后这一栏才会有内容。
            </p>
          )}
        </section>

        {/* 语料适配性。上屏的只有一句结论 + 灯，画像与最低分清单收进折叠——
            这几个数没有通过效果标定，摊在正文里会被当成质量结论用。 */}
        {corpus.fitness && (
          <section className="mb-10">
            <h2 className="mb-3 text-sm font-medium">素材量</h2>
            <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
              <FitnessLight fitness={corpus.fitness} withWhy />
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                判据只有一条：一门课中位 10 屏、每屏取 6 块，同一块不重复用的话要 60 块才铺得满，
                最长的一门（13 屏）要 78 块。这一格不参与拦截，红灯的库照样能选来生成。
              </p>

              {corpus.fitness.notes.length > 0 && (
                <ul className="mt-4 space-y-1 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground">
                  {corpus.fitness.notes.map((n) => (
                    <li key={n}>· {redactCaliber(n)}</li>
                  ))}
                </ul>
              )}

              <details className="mt-4 border-t border-border/60 pt-3">
                <summary className="cursor-pointer text-[11px] font-medium">
                  展开：块长画像、抽样打分，以及这两项为什么不判灯
                </summary>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                  <div>
                    <dt className="text-[10px] text-muted-foreground">块长中位</dt>
                    <dd className="text-sm tabular-nums">{corpus.fitness.charsMedian} 字符</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-muted-foreground">短于 50 字符</dt>
                    <dd className="text-sm tabular-nums">{corpus.fitness.shortPct}%</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-muted-foreground">带标题路径</dt>
                    <dd className="text-sm tabular-nums">{corpus.fitness.titledPct}%</dd>
                  </div>
                  {corpus.fitness.edu && (
                    <div>
                      <dt className="text-[10px] text-muted-foreground">抽样打分均分</dt>
                      <dd className="text-sm tabular-nums">
                        {corpus.fitness.edu.mean ?? '—'}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          / 5（抽 {corpus.fitness.edu.scored} 块）
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                  这两项原本是想用来提前判断素材好不好，拿三个已经跑过效果测量的库去标定，
                  结果没标住：效果最差的那一版素材，块长和打分反而比效果更好的那一版高。
                  所以它们留在这里只作画像，不作结论，也不参与判灯。
                  {corpus.fitness.edu &&
                    ' 打分那把尺子的档位定义是给中小学网页素材写的，对着操作手册类文档系统性偏低。'}
                </p>
                {corpus.fitness.lowest.length > 0 && (
                  <>
                    <p className="mt-4 text-[11px] font-medium">
                      抽样里分最低的 {corpus.fitness.lowest.length} 块（只列出来给人看，不会删）
                    </p>
                    <ul className="mt-2 space-y-2">
                      {corpus.fitness.lowest.map((s) => (
                        <li
                          key={`${s.title}-${s.excerpt.slice(0, 24)}`}
                          className="rounded-lg bg-muted/50 px-3 py-2"
                        >
                          <p className="text-[11px] font-medium">
                            <span className="mr-2 tabular-nums text-muted-foreground">
                              {s.score} 分
                            </span>
                            {s.title}
                          </p>
                          {s.reason && (
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              {redactCaliber(s.reason)}
                            </p>
                          )}
                          <p className="mt-1 line-clamp-2 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
                            {s.excerpt}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {corpus.fitness.measuredAt && (
                  <p className="mt-3 text-[10px] tabular-nums text-muted-foreground">
                    最近评测 {stamp(corpus.fitness.measuredAt)}
                  </p>
                )}
              </details>
            </div>
          </section>
        )}

        {/* 域级实操项目：GitHub 实搜 + 模型起草 + 管理员勾选发布（7.3 机制的实操侧）。 */}
        <PracticeScoutPanel corpus={corpus.corpus} />

        {/* 原件与处理过程。回答的是「这个库的原文件到底是哪些、你们对它做了什么」——
            上面五站只说产物文件在不在盘上，这一段把产物拆回到逐个原件。 */}
        <section className="mb-10">
          <h2 className="mb-1 text-sm font-medium">原件与处理过程</h2>
          <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground">
            每个原件切出多少块，是数索引里 source_id 的前缀数出来的；退回清单直接读就绪度报告，
            没有记录就写没有记录。原文按纯文本上屏，不做 markdown 渲染——这一页要看的是原件本身
            长什么样（front-matter、标题层级、表格），渲染过就核不了了。
          </p>
          {sources?.rootLabel ? (
            <SourceFilesPanel corpus={corpus.corpus} view={sources} />
          ) : (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-xs leading-relaxed text-muted-foreground">
              系统暂时无法确认这个知识库的原件来源，因此不提供原文查看。接入状态与已有索引仍按实际结果展示；如需补齐来源，请联系平台维护人员。
            </p>
          )}
        </section>

        <details className="rounded-2xl border border-border bg-card p-5 text-xs shadow-card">
          <summary className="cursor-pointer text-sm font-medium">这些数字是怎么数出来的</summary>
          <p className="mt-3 leading-relaxed text-muted-foreground">
            证据块数来自系统索引统计，每一站显示最近处理时间，素材量来自定期语料体检。
            可查看的原件与处理结果会在上方“原件与处理过程”中提供；需要进一步核验时，请联系平台维护人员。
          </p>
        </details>
      </main>
    </>
  );
}
