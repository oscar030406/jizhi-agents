'use client';

/** 登录工作台首屏的引擎路径摘要与当前领域学情。 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BarChart3, Route } from 'lucide-react';
import { conceptLabel } from '@/lib/knowledge/concept-labels';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { cn } from '@/lib/utils';
import type { LearnerProfileFields } from '@/lib/types/generation';
import { CARD_RECIPE_STATIC } from './course-card';

type PathPreview = {
  label?: string;
  source?: string;
  reason?: string | null;
  stages?: Array<{
    title?: string;
    concepts?: Array<{ name?: string; status?: string }>;
  }>;
  personalization?: {
    counts?: Partial<Record<'mastered' | 'current' | 'future' | 'unmeasured', number>>;
    reason?: string | null;
  };
};

type PathPreviewState =
  | { kind: 'loading' }
  | { kind: 'error'; domain: string; message: string }
  | { kind: 'ready'; domain: string; path: PathPreview };

/** 首页只展示引擎路径摘要；完整图统一进入 /path。 */
export function PathOrDomainCard({ corpus, className }: { corpus?: string; className?: string }) {
  const effective = corpus?.trim();
  const [requestState, setRequestState] = useState<PathPreviewState>({ kind: 'loading' });

  useEffect(() => {
    if (!effective) return;
    let alive = true;
    void fetch(`/api/domain-path/${encodeURIComponent(effective)}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          success?: boolean;
          path?: PathPreview;
          error?: string;
        } | null;
        if (!response.ok || !body?.success || !body.path) {
          throw new Error(body?.error ?? '学习路径服务暂时不可用');
        }
        if (alive) setRequestState({ kind: 'ready', domain: effective, path: body.path });
      })
      .catch((error: unknown) => {
        if (alive)
          setRequestState({
            kind: 'error',
            domain: effective,
            message: error instanceof Error ? error.message : '学习路径服务暂时不可用',
          });
      });
    return () => {
      alive = false;
    };
  }, [effective]);

  const state: PathPreviewState = !effective
    ? { kind: 'error', domain: '', message: '当前学习领域尚未确认。' }
    : requestState.kind !== 'loading' && requestState.domain === effective
      ? requestState
      : { kind: 'loading' };

  const stages = state.kind === 'ready' ? (state.path.stages ?? []) : [];
  const allConcepts = stages.flatMap((stage) => stage.concepts ?? []);
  const current = allConcepts.filter((concept) => concept.status === 'current');
  const preview = (current.length ? current : (stages[0]?.concepts ?? [])).slice(0, 3);
  const counts = state.kind === 'ready' ? state.path.personalization?.counts : undefined;
  // 引擎对内置主库回的 label 就是库 id（"ai"），给人看要换成注册表里的中文名；
  // 引擎给了真名（接入库）就用引擎的。domainLabel 查不到时原样回 id，不会变空。
  const engineLabel = state.kind === 'ready' ? (state.path.label?.trim() ?? '') : '';
  const label =
    engineLabel && engineLabel !== effective ? engineLabel : effective ? domainLabel(effective) : '';

  return (
    <section
      className={cn(
        'overflow-hidden [background-image:linear-gradient(to_bottom,color-mix(in_oklab,var(--purple-soft)_45%,transparent),transparent_40%)]',
        CARD_RECIPE_STATIC,
        className,
      )}
    >
      <div className="h-0.5 w-full bg-purple-deep/50" />
      <div className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-lg font-medium">
            <Route className="size-4 text-purple-deep" />
            {label ? `${label} · 我的学习路径` : '我的学习路径'}
          </p>
          <Link
            href="/path"
            className="shrink-0 text-sm text-muted-foreground hover:text-foreground"
          >
            查看全景
          </Link>
        </div>

        {state.kind === 'loading' && (
          <p className="text-sm text-muted-foreground">正在读取引擎生成的当前领域路径…</p>
        )}
        {state.kind === 'error' && (
          <p role="alert" className="text-sm leading-relaxed text-destructive">
            {state.message}；不会改用其它领域或旧路径。
          </p>
        )}
        {state.kind === 'ready' && (state.path.source === 'none' || stages.length === 0) && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {state.path.reason ?? '当前领域尚未形成可发布的学习路径。'}
          </p>
        )}
        {state.kind === 'ready' && stages.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {stages.length} 个阶段 · {allConcepts.length} 个概念
              {counts &&
                ` · 已会 ${counts.mastered ?? 0} · 当前 ${counts.current ?? 0} · 待学 ${counts.future ?? 0} · 未测 ${counts.unmeasured ?? 0}`}
            </p>
            {preview.length > 0 && (
              <ul className="space-y-1.5">
                {preview.map((concept, index) => (
                  <li
                    key={`${concept.name ?? 'concept'}-${index}`}
                    className="text-sm text-foreground"
                  >
                    {concept.name ? conceptLabel(concept.name) : '未命名概念'}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              路径由当前知识库的概念与前置关系生成，并随本领域学习证据更新。
            </p>
            <Link
              href="/path#universe"
              className="inline-block text-xs text-purple-deep hover:underline"
            >
              打开知识宇宙 →
            </Link>
            {state.path.personalization?.reason && (
              <p role="status" className="text-xs leading-relaxed text-yellow-deep">
                {state.path.personalization.reason}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** 与 /report「实测盲区」同一条线：低于它算薄弱点 */
const WEAK_BELOW = 0.6;

/** 我的学情：掌握概念数 + 薄弱点，一行进 /report */
export function MasterySummaryCard({
  profile,
  effectiveDomain,
  className,
}: {
  profile: LearnerProfileFields;
  effectiveDomain: string;
  className?: string;
}) {
  const entries = Object.entries(profile.conceptMasteryByDomain?.[effectiveDomain] ?? {}).sort(
    (a, b) => a[1] - b[1],
  );
  const weak = entries.filter(([, v]) => v < WEAK_BELOW);
  const mastered = entries.length - weak.length;

  return (
    <section
      className={cn(
        'overflow-hidden [background-image:linear-gradient(to_bottom,color-mix(in_oklab,var(--blue-soft)_45%,transparent),transparent_40%)]',
        CARD_RECIPE_STATIC,
        className,
      )}
    >
      <div className="h-0.5 w-full bg-blue-deep/40" />
      <div className="space-y-3 p-5">
        <p className="flex items-center gap-2 text-lg font-medium">
          <BarChart3 className="size-4 text-blue-deep" />
          我的学情
        </p>

        {entries.length === 0 ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            还没有测验记录。课里做完一次小测，这里会出现你的掌握度与薄弱点。
          </p>
        ) : (
          <>
            <div className="flex items-baseline gap-4">
              <p className="text-sm text-muted-foreground">
                已掌握
                <span className="mx-1 text-2xl font-semibold tabular-nums text-foreground">
                  {mastered}
                </span>
                个知识点
              </p>
              <p className="text-sm text-muted-foreground">
                待补
                <span className="mx-1 text-2xl font-semibold tabular-nums text-foreground">
                  {weak.length}
                </span>
                个
              </p>
            </div>
            {weak.length > 0 && (
              <ul className="space-y-1">
                {weak.slice(0, 3).map(([concept, v]) => (
                  <li key={concept} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {conceptLabel(concept)}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {v.toFixed(2)}
                    </span>
                  </li>
                ))}
                {weak.length > 3 && (
                  <li className="text-xs text-muted-foreground">还有 {weak.length - 3} 个</li>
                )}
              </ul>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              掌握度来自课程测验成绩的累积（低于 {WEAK_BELOW} 算薄弱点）。
            </p>
          </>
        )}

        <Link
          href="/report"
          className="inline-flex items-center gap-1 rounded-md text-sm text-foreground underline underline-offset-4 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          看完整学情报告
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}
