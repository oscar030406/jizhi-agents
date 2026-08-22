/**
 * 单课审核实录（管理端下钻）。
 *
 * 逐场景摊开审核账单：徽标 + 放行决策 + 逐条判词 + 辩论回放 + 教材出处。
 * 这一页几乎零新逻辑——数据在课程文件里本来就是这个形状，`/evidence` 的纠错卡
 * 只是从里面挑了一条展示，这里全部平铺。
 *
 * 诚实边界：修订只有断言级（原句 `claim` → 改文 `fix` 的文本对），场景全文的修订前
 * 版本没有存档，所以本页**不做全文 diff**。做了就是编。
 *
 * 视觉与 `/admin` 同一套（2026-08-16）：纯白基底、标题字阶拉开、场景卡 py-16 级留白，
 * 四格摘要用大数字。判词与辩论回放本来就在折叠里，这次只把「本场景用到的模型」
 * 那一小块并进同一层折叠，别在卡底留一行悬空小字。
 */

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ShieldAlert } from 'lucide-react';

import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import {
  arbiterLabel,
  judgePanelLabel,
  maskJudgeVerdict,
  modelDetailRows,
} from '@/components/agents/judge-labels';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { notableClaims } from '@/lib/server/admin-overview';
import { isValidClassroomId, readClassroom } from '@/lib/server/classroom-storage';
import { SiteHeader } from '@/components/site-header';

export const dynamic = 'force-dynamic';

const VERDICT_LABEL: Record<string, { readonly label: string; readonly cls: string }> = {
  pass: { label: '通过', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
  caveat: { label: '超资料覆盖（已标注）', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  revised: { label: '判错后已修订', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
  flagged: { label: '打回待人工', cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200' },
};

const CLAIM_LABEL: Record<string, string> = {
  supported: '核实',
  uncertain: '存疑',
  incorrect: '判错',
};

/**
 * 门禁裁决枚举的中文名。措辞照抄 `components/stage/scene-audit-badge.tsx`
 * （学员端同一枚举已在那里中文化），两处要改一起改。
 * 认不出的枚举原样印，不吞——枚举变了要看得见。
 */
const DECISION_LABEL: Record<string, string> = {
  publish: '直接放行',
  publish_with_warnings: '带风险标记放行',
  block_pending_review: '拦截·转人工复核',
};

interface AuditClaim {
  claim?: string;
  verdict?: string;
  reason?: string;
  /**
   * 判错之后改成了什么。**这一栏原来漏渲染了**：2026-08-14 逐条对设计稿复审时发现，
   * 23 门课里 138 条判词带 `fix`（56 条判错里 55 条有），页面上一条都没显示——
   * 而设计稿 §2 区 C 与演示台本要的正是「原句 claim / 判词 reason / 改文 fix」三栏。
   * 数据一直在盘上，只是没接出来。
   */
  fix?: string;
  decidedBy?: string;
  sourceIds?: string[];
}

interface AuditDebate {
  claim?: string;
  judgeVerdicts?: string[];
  defense?: string;
  arbiterVerdict?: string;
  rationale?: string;
}

interface SceneAudit {
  verdict?: string;
  totalClaims?: number;
  incorrectCount?: number;
  uncertainCount?: number;
  decision?: string;
  rationale?: string;
  grounded?: boolean;
  evidenceCount?: number;
  rounds?: number;
  durationMs?: number;
  judgeModels?: string[];
  arbiterModel?: string;
  claims?: AuditClaim[];
  debate?: AuditDebate[];
}

export default async function AdminCoursePage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!accountsEnabled()) notFound();
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24 text-center">
        <ShieldAlert className="mx-auto mb-3 size-8 text-amber-600" />
        <p className="text-sm text-muted-foreground">管理端只对管理者账号开放。</p>
      </main>
    );
  }
  if (!isValidClassroomId(id)) notFound();
  const course = await readClassroom(id);
  if (!course) notFound();

  const scenes = (course.scenes ?? []).filter(
    (s) => (s as { audit?: SceneAudit }).audit,
  ) as Array<{ title?: string; audit: SceneAudit }>;

  return (
    <>
      {/* 与 /admin 同一条顶栏，返回目标改成管理端而不是首页 */}
      <SiteHeader backHref="/admin" backLabel="回管理端" maxWidth="max-w-4xl" />
      <main className="bg-white dark:bg-background">
      <div className="mx-auto max-w-4xl px-4 pb-20 pt-12 sm:px-6 sm:pt-16">
      <h1 className="text-[32px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[40px]">
        {course.stage?.name ?? id}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {scenes.length} / {course.scenes?.length ?? 0} 个场景有审核账单
      </p>

      <div className="mt-10 space-y-5">
        {scenes.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs leading-relaxed text-muted-foreground">
            这门课的场景都没有审核账单——课程生成时没有跑审核链，存档里就没有判词。
            管理端只摊开存档里已有的记录，不追溯补算。
          </p>
        )}
        {scenes.map((scene, i) => {
          const a = scene.audit;
          const badge = VERDICT_LABEL[a.verdict ?? ''] ?? {
            label: a.verdict ?? '未判',
            cls: 'bg-muted text-muted-foreground',
          };
          const notable = notableClaims(a.claims);
          return (
            <section key={i} className="rounded-2xl border border-border bg-card p-6 shadow-card">
              <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-medium leading-snug">
                  {i + 1}. {scene.title ?? '未命名场景'}
                </h2>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.cls}`}>
                  {badge.label}
                </span>
              </div>

              <dl className="mb-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                {[
                  ['断言', String(a.totalClaims ?? 0)],
                  ['判错 / 存疑', `${a.incorrectCount ?? 0} / ${a.uncertainCount ?? 0}`],
                  ['接地', a.grounded ? `是（${a.evidenceCount ?? 0} 条证据）` : '否'],
                  ['轮次 / 耗时', `${a.rounds ?? 0} 轮 · ${Math.round((a.durationMs ?? 0) / 1000)}s`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] text-muted-foreground">{label}</dt>
                    <dd className="mt-1 text-lg font-medium leading-none tabular-nums tracking-tight">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {a.decision && (
                <p className="mb-4 rounded-lg bg-muted px-3 py-2.5 text-xs leading-relaxed">
                  <span className="font-medium">放行决策：</span>
                  <span>{DECISION_LABEL[a.decision] ?? a.decision}</span>
                  {a.rationale && <span className="text-muted-foreground"> —— {a.rationale}</span>}
                </p>
              )}

              {notable.length > 0 && (
                <details className="mb-2" open={notable.length <= 3}>
                  <summary className="cursor-pointer text-xs font-medium text-purple-700 dark:text-purple-300">
                    判错 / 存疑 / 被改过文的判词 {notable.length} 条
                  </summary>
                  <ul className="mt-3 space-y-2">
                    {notable.map((c, j) => (
                      <li key={j} className="rounded-lg border border-border px-3 py-2.5">
                        <p className="text-xs leading-relaxed">{c.claim}</p>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                          <span className="font-medium">
                            {CLAIM_LABEL[c.verdict ?? ''] ?? c.verdict}
                          </span>
                          {c.decidedBy && ` · ${c.decidedBy}`}
                          {c.reason && ` —— ${c.reason}`}
                        </p>
                        {/* 改文单独一行、带左边线：它与上面两行不是同一类信息——
                            claim 是原句、reason 是为什么判、fix 是改成了什么。
                            混进上一行会让人以为改文也是判词的一部分。 */}
                        {c.fix && (
                          <p className="mt-2 border-l-2 border-sky-400 pl-2.5 text-[11px] leading-relaxed dark:border-sky-500">
                            <span className="font-medium">改文：</span>
                            <span className="text-muted-foreground">{c.fix}</span>
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {(a.debate ?? []).length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-purple-700 dark:text-purple-300">
                    辩论回放 {a.debate?.length} 条
                  </summary>
                  <ul className="mt-3 space-y-2">
                    {(a.debate ?? []).map((d, j) => (
                      <li key={j} className="rounded-lg border border-border px-3 py-2.5">
                        <p className="text-xs leading-relaxed">{d.claim}</p>
                        {(d.judgeVerdicts ?? []).map((v, k) => (
                          <p key={k} className="mt-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                            {maskJudgeVerdict(v, k)}
                          </p>
                        ))}
                        {d.defense && (
                          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                            <span className="font-medium">申辩：</span>
                            {d.defense}
                          </p>
                        )}
                        {d.arbiterVerdict && (
                          <p className="mt-1.5 text-[11px] leading-relaxed">
                            <span className="font-medium">仲裁：</span>
                            {CLAIM_LABEL[d.arbiterVerdict] ?? d.arbiterVerdict}
                            {d.rationale && (
                              <span className="text-muted-foreground"> —— {d.rationale}</span>
                            )}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {(a.judgeModels ?? []).length > 0 && (
                <div className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
                  <p>
                    {judgePanelLabel(a.judgeModels ?? [])}
                    {a.arbiterModel && ` · 终审 ${arbiterLabel(a.arbiterModel)}`}
                  </p>
                  <details className="mt-1.5">
                    <summary className="cursor-pointer">详情：本场景用到的模型</summary>
                    <ul className="mt-1.5 space-y-0.5">
                      {modelDetailRows(a.judgeModels ?? [], a.arbiterModel).map((row) => (
                        <li key={row.role}>
                          {row.role}
                          <span className="ml-1 font-mono break-all">{row.model}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
            </section>
          );
        })}
      </div>
      </div>
      </main>
    </>
  );
}
