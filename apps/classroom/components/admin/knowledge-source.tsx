'use client';

/**
 * 「原件与处理过程」的展示件：原件清单、每个原件切出多少块、被退回的文件与理由，
 * 点开能看原文和它切出的块。
 *
 * 两条纪律与知识库中心其余各页一致：
 * 1. **拿不到就留白并写明原因**，不出占位数据。所以「该库入库时未留退回记录」与
 *    「退回 0 个」在这里是两句不同的话。
 * 2. 数字旁边一律摆出它是从哪个文件数出来的，看的人能自己去磁盘核。
 *
 * 原文不做 markdown 渲染，按纯文本上屏——这一页要看的是**原件本身长什么样**
 * （front-matter、标题层级、表格），渲染过就核不了了。
 */

import { useCallback, useMemo, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { redactCaliber } from '@/lib/metrics/redact-caliber';
import type { SourceFileDetail, SourceFileRow, SourceView } from '@/lib/server/knowledge-source';

/** 一组默认先渲染多少行。odoo 一个库就有 962 个原件，全渲染没人看得完。 */
const PAGE = 60;

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 一行的状态：切出几块 / 被退回（理由）/ 在盘但没进索引。三者互斥。 */
function StatusCell({ row }: { readonly row: SourceFileRow }) {
  if (row.chunks > 0) {
    return (
      <span className="tabular-nums text-emerald-700 dark:text-emerald-300">{row.chunks} 块</span>
    );
  }
  if (row.rejected) {
    return (
      <span className="text-amber-700 dark:text-amber-300">
        退回 · {redactCaliber(row.rejected)}
      </span>
    );
  }
  return <span className="text-muted-foreground">已接收，未入库</span>;
}

function sourceSummary(view: SourceView): string {
  if (!view.rootLabel) return '系统未记录原件来源';
  if (view.rootLabel.split(/[\\/]/).includes('intake_runs')) return '本次接入时上传的文档';
  return view.external ? '平台管理的外部资料源' : '平台知识库资料源';
}

export function SourceFilesPanel({
  corpus,
  view,
}: {
  readonly corpus: string;
  readonly view: SourceView;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [detail, setDetail] = useState<SourceFileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (rel: string) => {
      setOpenFile(rel);
      setDetail(null);
      setError(null);
      try {
        const res = await fetch(
          `/api/knowledge/corpora/${encodeURIComponent(corpus)}/source?file=${encodeURIComponent(rel)}`,
        );
        const body = (await res.json()) as {
          success?: boolean;
          error?: string;
          file?: SourceFileDetail;
        };
        if (!res.ok || !body.success || !body.file) {
          setError(body.error || `读取失败（HTTP ${res.status}）`);
          return;
        }
        setDetail(body.file);
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取失败');
      }
    },
    [corpus],
  );

  /** 导出的是这一页上摆着的同一批数字，不另算一遍。 */
  const csv = useMemo(() => {
    const rows = [['文件', '字节', '切块数', '状态', '首块标题']];
    for (const g of view.groups) {
      for (const f of g.files) {
        rows.push([
          f.rel,
          String(f.bytes),
          String(f.chunks),
          f.chunks > 0
            ? '已入库'
            : f.rejected
              ? `退回：${redactCaliber(f.rejected)}`
              : '已接收，未入库',
          f.title ?? '',
        ]);
      }
    }
    return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  }, [view.groups]);

  const csvHref = useMemo(
    // BOM：Excel 不认无 BOM 的 UTF-8 CSV，中文文件名会花掉。
    () => `data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${csv}`)}`,
    [csv],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="text-[10px] text-muted-foreground">系统已接收原件</dt>
            <dd className="text-sm tabular-nums">
              {view.totals.files}
              <span className="ml-1 text-[10px] text-muted-foreground">
                {kb(view.totals.bytes)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted-foreground">切出的证据块</dt>
            <dd className="text-sm tabular-nums">{view.totals.chunks}</dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted-foreground">已接收未入库</dt>
            <dd className="text-sm tabular-nums">{view.totals.unindexed}</dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted-foreground">退回</dt>
            <dd className="text-sm tabular-nums">
              {view.rejected === null ? (
                <span className="text-[11px] text-muted-foreground">无记录</span>
              ) : (
                view.rejected.length
              )}
            </dd>
          </div>
        </dl>

        <p className="mt-4 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          原件来源：{sourceSummary(view)}
        </p>
        {view.rootLabel && !view.rootExists && (
          <p className="mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            系统当前无法读取这批原件。索引中的可追溯记录仍会显示；如需恢复原文查看，请联系平台维护人员。
          </p>
        )}
        {view.external && view.rootExists && (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            系统已从平台管理的外部资料源接收原件；索引与向量处理结果已纳入当前知识库。
          </p>
        )}
        {view.indexChunks !== view.totals.chunks && (
          <p className="mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            统计不一致：当前索引共 {view.indexChunks} 块，按原件加总 {view.totals.chunks} 块， 相差{' '}
            {Math.abs(view.indexChunks - view.totals.chunks)} 块。页面按当前索引统计。
          </p>
        )}
        {view.orphans.length > 0 && (
          <p className="mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            有 {view.orphans.length} 个索引条目暂时无法关联原件；数量与状态仍按索引统计。
          </p>
        )}
        {view.scopedOut && view.scopedOut.files.length > 0 && (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            接入时按范围排除了 {view.scopedOut.files.length} 个文件。
            {view.scopedOut.stillIndexed > 0 && (
              <span className="text-amber-700 dark:text-amber-300">
                {' '}
                其中 {view.scopedOut.stillIndexed} 个仍被当前索引收录；范围清单与索引状态不一致，
                页面按当前索引统计。
              </span>
            )}
          </p>
        )}

        {view.totals.files > 0 && (
          <a
            href={csvHref}
            download={`${corpus}-原件清单.csv`}
            className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[11px] transition-colors hover:bg-accent"
          >
            导出原件清单 CSV
          </a>
        )}
      </div>

      {/* 退回清单。分桶按理由原句计数——理由本身就是判据（格式不解析 / 小结类 /
          读取失败 / 疑似占位 / 内容重复），不在这里重新归一套类。 */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <h3 className="mb-2 text-xs font-medium">退回清单</h3>
        {view.rejected === null ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            该知识库由早期流程建立，未保留文件退回记录，因此这里无法列出退回详情。
          </p>
        ) : view.rejected.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            本次接入没有退回任何文件。
          </p>
        ) : (
          <>
            <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
              {view.rejectedBuckets.slice(0, 12).map((b) => (
                <li key={b.reason} className="flex gap-2">
                  <span className="w-10 shrink-0 text-right tabular-nums">{b.count}</span>
                  <span>{redactCaliber(b.reason)}</span>
                </li>
              ))}
            </ul>
            {view.rejectedBuckets.length > 12 && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                另有 {view.rejectedBuckets.length - 12} 类理由，逐条见下面各文件行。
              </p>
            )}
            <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
              系统接入规则负责格式初筛与内容去重；版本控制文件、依赖包和运行环境文件会自动跳过，
              既不接收也不计入原件总数。
            </p>
          </>
        )}
      </div>

      {view.groups.map((g) => {
        const showAll = expanded[g.name];
        const rows = showAll ? g.files : g.files.slice(0, PAGE);
        return (
          <details
            key={g.name}
            className="rounded-2xl border border-border bg-card p-5 shadow-card"
          >
            <summary className="cursor-pointer text-xs font-medium">
              {g.name}
              <span className="ml-2 font-normal text-muted-foreground">
                {g.files.length} 个原件 · {g.chunks} 块 · {kb(g.bytes)}
              </span>
            </summary>
            <ul className="mt-3 divide-y divide-border/60">
              {rows.map((f) => (
                <li key={f.rel} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px]">
                    {f.rel.slice(f.rel.indexOf('/') + 1)}
                  </span>
                  {f.title && (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                      {f.title}
                    </span>
                  )}
                  <span className="w-16 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                    {kb(f.bytes)}
                  </span>
                  <span className="w-40 shrink-0 text-right text-[11px]">
                    <StatusCell row={f} />
                  </span>
                  {f.readable ? (
                    <button
                      type="button"
                      onClick={() => void open(f.rel)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] transition-colors hover:bg-accent"
                    >
                      <FileText className="size-3" />
                      看原文
                    </button>
                  ) : (
                    <span className="w-[62px] shrink-0" aria-hidden />
                  )}
                  {f.collides.length > 0 && (
                    <p className="w-full text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
                      文件标识冲突，无法分别统计证据块：它与 {f.collides.join('、')} 共用同一标识，
                      上面的块数是这些文件的合计值。
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {!showAll && g.files.length > PAGE && (
              <button
                type="button"
                onClick={() => setExpanded((s) => ({ ...s, [g.name]: true }))}
                className="mt-3 rounded-full border border-border px-3 py-1 text-[11px] transition-colors hover:bg-accent"
              >
                显示全部 {g.files.length} 个
              </button>
            )}
          </details>
        );
      })}

      <Dialog open={openFile !== null} onOpenChange={(o) => !o && setOpenFile(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-all font-mono text-sm">{openFile}</DialogTitle>
            <DialogDescription className="text-[11px]">
              {detail
                ? `${kb(detail.bytes)} · 切出 ${detail.chunks.length} 块${detail.truncated ? ' · 正文超过 256 KB，只显示前 256 KB' : ''}`
                : error
                  ? '读取失败'
                  : '读取中'}
            </DialogDescription>
          </DialogHeader>

          {error && (
            <p className="text-[11px] text-rose-600 dark:text-rose-400">{redactCaliber(error)}</p>
          )}
          {!detail && !error && (
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              读取中
            </p>
          )}

          {detail && (
            <>
              {detail.chunks.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-medium">这个原件切出的块</h4>
                  <ul className="space-y-2">
                    {detail.chunks.map((c) => (
                      <li key={c.sourceId} className="rounded-lg bg-muted/50 px-3 py-2">
                        <p className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                          <span className="font-mono text-muted-foreground">{c.sourceId}</span>
                          <span className="font-medium">{c.title}</span>
                        </p>
                        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                          {c.excerpt}
                          {c.excerpt.length >= 80 && '…'}
                        </p>
                        {c.url && (
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mt-1 inline-block break-all font-mono text-[10px] text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
                          >
                            {c.url}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h4 className="mb-2 text-xs font-medium">原文（纯文本）</h4>
                <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-[10px] leading-relaxed">
                  {detail.text}
                </pre>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
