/**
 * 一次接入 run 的详情：并行泳道、每站实数、事件流回放。
 *
 * 服务端把 run.json 与全量事件一次读出来交给客户端件——首屏不需要等一轮轮询，
 * 而且 run 已经结束时这一页压根不会再发请求（引擎停机后回放照常可用的原因）。
 * run 还在跑时，客户端件按 seq 增量轮询 `/api/knowledge/intake-runs/<id>/events`。
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SiteHeader } from '@/components/site-header';
import { IntakeRunView } from '@/components/admin/intake-run-view';
import { isValidRunId, readRunEvents } from '@/lib/server/intake-runs';

import { Denied, managerAccount } from '../../guard';

export const dynamic = 'force-dynamic';

export default async function IntakeRunPage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  if (!(await managerAccount())) return <Denied />;
  if (!isValidRunId(runId)) notFound();
  // 一次 run 的事件是十几到几十条，一次全取；超过 2000 条才截断，届时页面顶部会显示。
  const payload = await readRunEvents(runId, 0, 2000);
  if (!payload) notFound();

  return (
    <>
      <SiteHeader
        backHref="/admin/knowledge/runs"
        backLabel="回 run 列表"
        maxWidth="max-w-4xl"
      />
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <IntakeRunView record={payload.record} events={payload.events} />

        {payload.truncated && (
          <p className="mt-6 text-[11px] text-amber-700 dark:text-amber-300">
            这次 run 的事件超过 2000 条，本页只取了前 2000 条。完整事件在磁盘上的 events.jsonl 里。
          </p>
        )}

        <p className="mt-8 text-[11px] leading-relaxed text-muted-foreground">
          这一页读的是 run 目录下的两个文件：<code className="font-mono">run.json</code>{' '}
          是每站的状态与耗时，
          <code className="font-mono">events.jsonl</code> 是一行一条的事件。 回到{' '}
          <Link
            href="/admin/knowledge"
            className="underline underline-offset-2 hover:text-foreground"
          >
            知识库
          </Link>{' '}
          看这个库现在建到哪一站。
        </p>
      </main>
    </>
  );
}
