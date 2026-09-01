/**
 * 领域接入就绪度表。
 *
 * 三道闸如实显示，过不了就显示过不了——这份报告的用途是告诉管理者
 * 「这批语料现在能教到什么程度」，粉饰它等于让人在不能教的领域上开课。
 *
 * 前置图分两级显示：章级（边来自语料显式交叉引用的不对称性，模型只复核）
 * 与节级（O(n²) 成对判定，只在没有结构信号时才跑）。两级不是冗余——
 * 前置关系存在于章之间，同一章里的节多半是兄弟。
 */

import Link from 'next/link';

import { isScratchCorpus } from '@/lib/knowledge/domain-registry';
import type { DomainIntake } from '@/lib/server/admin-overview';
import { tierLabel } from './difficulty-scale';

/**
 * `"L1-L3"` → `"1 级 – 3 级"`。转写共用 `tierLabel()`（路径图节点/图例/难度供给同一个），
 * 不在这里另起一套档位命名。内部档位码不上屏：读这张表的人问的是「分了几档」，
 * 不是「L 几到 L 几」。
 */
/**
 * 「这批语料的原文从哪来」。
 *
 * 两种来源，说法不一样：
 * - 从页面上传的：源目录是那次 run 的 `intake_runs/<run_id>/docs`，印一串 run 编号
 *   等于没说，直接说是这次接入上传的。
 * - 从磁盘上某个仓库接的：目录名是上游自己的名字，翻不成中文；单印末段（`Master`）
 *   看不出是哪一册，所以印末两段——`UserGuide/Master`。
 */
function sourceLabel(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  if (parts.includes('intake_runs')) return '本次接入时上传的文档';
  return parts.length ? '平台管理的外部资料源' : '—';
}

function tierRangeLabel(range: string): string {
  const parts = range.split('-').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return '—';
  return [...new Set(parts.map(tierLabel))].join(' – ');
}

function Gate({ ok, label }: { readonly ok: boolean; readonly label: string }) {
  return (
    <span
      className={
        ok
          ? 'rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
          : 'rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground'
      }
    >
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

export function DomainIntakeTable({ intakes }: { readonly intakes: readonly DomainIntake[] }) {
  const visibleIntakes = intakes.filter(
    (intake) =>
      !isScratchCorpus(intake.domain) &&
      !/(?:fullprobe|fullpath[-_]?probe|(?:^|[-_])probe(?:[-_]|$))/i.test(intake.domain),
  );
  if (visibleIntakes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
        还没有接入过领域。请由所属机构管理者在{' '}
        <Link href="/admin/knowledge" className="underline underline-offset-2 hover:text-foreground">
          知识库页面
        </Link>{' '}
        使用“接入新知识库”；系统处理后会显示就绪度报告。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {visibleIntakes.map((d) => (
        <div key={d.domain} className="rounded-xl border border-border bg-card p-4 shadow-card">
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">{d.domain}</h3>
              {d.scope && <p className="text-[11px] text-muted-foreground">{d.scope}</p>}
            </div>
            <span
              className={
                d.license.unknown
                  ? 'rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                  : 'rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground'
              }
            >
              {d.license.spdx}
              {d.license.unknown && ' · 待人工确认'}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            {[
              ['收进的文件', `${d.acceptedFiles}${d.rejectedFiles ? ` （退回 ${d.rejectedFiles}）` : ''}`],
              ['入库可检索', d.chunks ? `${d.chunks} 个片段` : '未入库'],
              ['切块', `${d.sections} 节`],
              ['概念词表', `${d.conceptCount} 个`],
              ['素材分档', d.tierRange ? tierRangeLabel(d.tierRange) : '—'],
              ['章级概念面', d.chapterCount ? `${d.chapterCount} 个` : '—'],
              [
                '章级前置边',
                d.candidateEdges
                  ? `${d.chapterEdges} / ${d.candidateEdges} 结构候选`
                  : '—',
              ],
              ['节级前置边', d.nodeEdges ? `${d.nodeEdges} 个概念有前置` : '—'],
              ['原文出自', sourceLabel(d.sourceDir)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[10px] text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 text-xs font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
            <Gate ok={d.gates.retrievable} label="闸零 可检索" />
            <Gate ok={d.gates.vocabulary} label="闸一 词表" />
            <Gate ok={d.gates.graph} label="闸二 前置闭包" />
            <Gate ok={d.gates.itemMapping} label="闸三 测项映射" />
            {!d.gates.retrievable && (
              <span className="text-[10px] text-amber-700 dark:text-amber-300">
                语料没进检索库——这个域现在生成课程无素材可取，前面几道闸过了也教不动
              </span>
            )}
            {!d.gates.itemMapping && (
              <span className="text-[10px] text-muted-foreground">
                测项映射未实现——相关概念的掌握度置信封顶且禁止跳过
              </span>
            )}
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            全部前置边未经人工签字，只作软前置，不拦人。这份报告不构成对前置图质量的效果承诺。
          </p>
        </div>
      ))}
    </div>
  );
}
