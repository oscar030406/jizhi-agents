/**
 * 知识库中心 · 接入 run 列表。
 *
 * 为什么是独立一页而不是挂在某个库的详情页下：一次 run 建的是**新库**，run 在前、库在后；
 * 失败的 run 压根不留库（半成品会被清掉），挂在库下面就永远看不到它。而演示纪律要求
 * 失败的那一次也得能翻出来看。所以 run 自成一条时间线，库详情页那边只挂链接。
 *
 * 路由上 `runs` 这一段是静态段，会盖过同级的 `[corpus]` 动态段——也就是说语料库不能
 * 叫 `runs`（引擎侧这个名字合法，但在这一页会被遮住）。这一条写在这里备查。
 *
 * 数据读的是引擎数据目录里的 run.json，不问引擎进程（`lib/server/intake-runs.ts`）。
 */

import Link from 'next/link';

import { SiteHeader } from '@/components/site-header';
import { isScratchCorpus } from '@/lib/knowledge/domain-registry';
import { domainLabel, hasDomainLabel } from '@/lib/knowledge/domain-labels';
import { redactCaliber } from '@/lib/metrics/redact-caliber';
import { listRuns } from '@/lib/server/intake-runs';

import { Denied, managerAccount } from '../guard';

export const dynamic = 'force-dynamic';

const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  running: {
    label: '进行中',
    cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  },
  done: {
    label: '完成',
    cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  },
  failed: {
    label: '失败',
    cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  },
};

function when(iso: string | null): string {
  return iso ? iso.slice(0, 19).replace('T', ' ') : '';
}

export default async function IntakeRunsPage() {
  if (!(await managerAccount())) return <Denied />;
  // run 行的库名走 domainLabel，先灌域注册清单（同 admin 总览页的补法）
  const { readDomainRegistry } = await import('@/lib/server/domain-registry');
  await readDomainRegistry().catch(() => null);
  const runs = (await listRuns(30)).filter(
    (run) =>
      !isScratchCorpus(run.corpus) &&
      !/(?:fullprobe|fullpath[-_]?probe|(?:^|[-_])probe(?:[-_]|$))/i.test(run.corpus),
  );

  return (
    <>
      <SiteHeader
        backHref="/admin/knowledge"
        backLabel="回知识库"
        maxWidth="max-w-4xl"
      />
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">接入记录</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            每次接入会把一批文档处理成新的语料库。点开记录可查看各站状态、耗时、处理结果与事件回放。
          </p>
        </header>

        {runs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs leading-relaxed text-muted-foreground">
            <p>还没有接入记录。</p>
            <p className="mt-2">
              请回到知识库页面使用“接入新知识库”；系统接收后会在这里显示各站状态、耗时和事件回放。
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {runs.map((run) => {
              const status = RUN_STATUS[run.status] ?? {
                label: run.status,
                cls: 'bg-muted text-muted-foreground',
              };
              return (
                <li key={run.runId}>
                  <Link
                    href={`/admin/knowledge/runs/${run.runId}`}
                    className="block rounded-2xl border border-border bg-card p-4 shadow-card transition-colors hover:border-purple-400/60"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h2
                        className={
                          hasDomainLabel(run.corpus)
                            ? 'text-sm font-medium'
                            : 'font-mono text-sm font-medium'
                        }
                      >
                        {domainLabel(run.corpus)}
                      </h2>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${status.cls}`}
                      >
                        {status.label}
                      </span>
                    </div>
                    {run.scope && (
                      <p className="mt-1 text-[11px] text-muted-foreground">{run.scope}</p>
                    )}
                    <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
                      {when(run.createdAt)} · {run.files} 个文件
                      {run.durationMs !== null && ` · 总耗时 ${run.durationMs} ms`}
                      {` · 完成 ${run.stageCounts.done} 站`}
                      {run.stageCounts.failed > 0 && ` · 失败 ${run.stageCounts.failed} 站`}
                      {run.stageCounts.skipped > 0 && ` · 跳过 ${run.stageCounts.skipped} 站`}
                      {run.stageCounts.pending > 0 && ` · 尚未接入 ${run.stageCounts.pending} 站`}
                    </p>
                    {run.error && (
                      <p className="mt-1 text-[11px] leading-relaxed text-rose-700 dark:text-rose-300">
                        {redactCaliber(run.error)}
                      </p>
                    )}
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                      {run.corpus} · {run.runId}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
