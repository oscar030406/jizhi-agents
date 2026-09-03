/**
 * 已接入语料库的结论层。
 *
 * 就绪度报告本身（九栏明细 + 三道闸的逐条说明）在 `domain-intake-table.tsx` 里，
 * 那张表信息密度对，但当默认视图铺满整屏之后，管理者第一眼要的
 * 「几个库、哪个能教、哪个卡住了」反而要一行行数。所以这里只出结论：
 * 每个库一张卡，中文名 + 能不能教 + 四道闸过了几道，明细进折叠。
 *
 * 名字走 `lib/knowledge/domain-labels.ts` 的单一真源——语料 id（iotdb / odoo 这类）
 * 是接入时的目录名，不是给管理者看的。
 *
 * 喂进来的清单是 `readCorpusOverview()`（域注册清单 ∪ 接入体检报告），不再只有后者：
 * 内置主库没有体检报告，`gates` 为 null，卡面据此换成一行「内置主库 · 无接入体检记录」，
 * 不画闸位条。
 */

import { domainLabel } from '@/lib/knowledge/domain-labels';
import type { CorpusOverviewRow, DomainIntake } from '@/lib/server/admin-overview';

const GATES = ['可检索', '词表', '前置闭包', '测项映射'] as const;

/** 四道闸过了几道。闸零（可检索）不过 = 这个域生成课程时无素材可取，单独标出来。 */
export function gateCount(g: DomainIntake['gates']): number {
  return [g.retrievable, g.vocabulary, g.graph, g.itemMapping].filter(Boolean).length;
}

export function DomainIntakeSummary({
  intakes,
}: {
  readonly intakes: readonly CorpusOverviewRow[];
}) {
  if (intakes.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {intakes.map((d) => {
        // 没跑过接入链的库（内置主库）没有闸位。不画条、不算分母——
        // 「0/4 道闸」会被读成四道全没过，而实情是这四道压根没测过。
        if (!d.gates) {
          return (
            <div
              key={d.domain}
              className="rounded-2xl border border-border bg-card p-5 shadow-card"
            >
              <p className="text-base font-medium leading-snug">{domainLabel(d.domain)}</p>
              <p className="mt-4 flex items-baseline gap-1.5">
                <span className="text-3xl font-medium leading-none tracking-tight tabular-nums">
                  {d.chunks.toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">个片段入库可检索</span>
              </p>
              <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                内置主库 · 无接入体检记录
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                可用于生成课程
              </p>
            </div>
          );
        }
        const gates = d.gates;
        const passed = gateCount(gates);
        const flags = [gates.retrievable, gates.vocabulary, gates.graph, gates.itemMapping];
        return (
          <div key={d.domain} className="rounded-2xl border border-border bg-card p-5 shadow-card">
            <p className="text-base font-medium leading-snug">{domainLabel(d.domain)}</p>
            {/* 领域范围（「这个库要培养什么人」）08-18 从卡面撤下：六张卡各挂两行，
                首屏一半的字都是它，而它对「哪个库能教、哪个卡住了」这个判断不出力。
                原文没删，在同一区块折叠里的就绪度表上逐库照印（domain-intake-table.tsx）。 */}
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-3xl font-medium leading-none tracking-tight tabular-nums">
                {d.chunks.toLocaleString()}
              </span>
              <span className="text-xs text-muted-foreground">个片段入库可检索</span>
            </p>
            <div
              className="mt-4 flex items-center gap-1.5"
              title={GATES.map((g, i) => `${flags[i] ? '过' : '未过'} ${g}`).join(' · ')}
            >
              {flags.map((ok, i) => (
                <span
                  key={GATES[i]}
                  className={`h-1.5 flex-1 rounded-full ${ok ? 'bg-emerald-500' : 'bg-muted'}`}
                  aria-hidden
                />
              ))}
              <span className="ml-1 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {passed}/4 道闸
              </span>
            </div>
            {/* 闸零不过是唯一「现在就教不动」的情形，别的闸不过只是能力受限 */}
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {gates.retrievable ? '可用于生成课程' : '语料没进检索库，暂时生成不出课'}
            </p>
          </div>
        );
      })}
    </div>
  );
}
