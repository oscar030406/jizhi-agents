'use client';

/**
 * 项目带练页：一张已发布实操卡 → 按当前画像拆成的里程碑 → 逐段做、逐段由教练检查。
 *
 * 数据三份、各自独立取：项目卡（已发布清单）、带练路线（按画像生成，同档缓存）、
 * 进度（登录账户记在画像的 practiceProgress，未登录只记本地）。任一份取不到都
 * 如实显示原因，不用另外两份凑一个「看起来能用」的页面。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CheckCircle2, Circle, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

import type { GuideMilestone, PracticeGuidePayload } from '@/app/api/practice-guide/route';
import { MilestoneCoach } from '@/components/practice/milestone-coach';
import { SiteHeader } from '@/components/site-header';
import {
  licenseNote,
  usePublishedPractice,
  type PracticeProject,
} from '@/components/skills/practice-projects';
import { Button } from '@/components/ui/button';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { cn } from '@/lib/utils';

const LEVEL_LABEL: Record<PracticeProject['level'], string> = {
  starter: '第一个项目',
  advanced: '进阶',
  portfolio: '作品级',
};

type GuideState =
  | { kind: 'loading' }
  | { kind: 'ready'; payload: PracticeGuidePayload }
  | { kind: 'failed'; message: string };

type Progress = { done: number[]; updatedAt: string };

function progressKey(corpus: string, projectId: string) {
  return `${corpus}/${projectId}`;
}

/** 进度：本地先落，登录了再合并进账户画像。读时账户优先，本地兜底。 */
function useProgress(corpus: string, projectId: string) {
  const key = progressKey(corpus, projectId);
  const storageKey = `jizhi.practice.${key}`;
  const [progress, setProgress] = useState<Progress>({ done: [], updatedAt: '' });
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    // 本地快照在下一帧再落 state：服务端渲染没有 localStorage，首帧按空进度画，避免 hydration 不一致
    const frame = window.requestAnimationFrame(() => {
      try {
        const local = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Progress | null;
        if (alive && local?.done) setProgress(local);
      } catch {
        /* 本地读不到就从零开始 */
      }
    });
    (async () => {
      try {
        const res = await fetch('/api/profile', { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 401) {
          setSignedIn(false);
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as {
          fields?: { practiceProgress?: Record<string, Progress> } | null;
        };
        setSignedIn(true);
        const remote = body.fields?.practiceProgress?.[key];
        if (remote?.done) setProgress(remote);
      } catch {
        /* 账户读不到就按本地 */
      }
    })();
    return () => {
      alive = false;
      window.cancelAnimationFrame(frame);
    };
  }, [key, storageKey]);

  const markDone = useCallback(
    async (index: number) => {
      const next: Progress = {
        done: Array.from(new Set([...progress.done, index])).sort((a, b) => a - b),
        updatedAt: new Date().toISOString(),
      };
      setProgress(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      if (!signedIn) return;
      try {
        // 只合并 practiceProgress 这一格：先读当前画像再写，别把别的字段冲掉。
        const res = await fetch('/api/profile', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { fields?: Record<string, unknown> | null };
        const fields = body.fields ?? {};
        const merged = {
          ...((fields.practiceProgress as Record<string, Progress> | undefined) ?? {}),
          [key]: next,
        };
        await fetch('/api/profile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'update', fields: { ...fields, practiceProgress: merged } }),
        });
      } catch {
        /* 账户没写上不拦住继续做；本地已经记了 */
      }
    },
    [key, progress.done, signedIn, storageKey],
  );

  return { progress, markDone, signedIn };
}

export default function PracticeGuidePage() {
  const params = useParams<{ corpus: string; projectId: string }>();
  const corpus = decodeURIComponent(params.corpus ?? '');
  const projectId = decodeURIComponent(params.projectId ?? '');

  const practice = usePublishedPractice(corpus || null);
  const project = useMemo(
    () => (practice.kind === 'ready' ? practice.projects.find((p) => p.id === projectId) : undefined),
    [practice, projectId],
  );

  const [guide, setGuide] = useState<GuideState>({ kind: 'loading' });
  const [picked, setPicked] = useState<number | null>(null);
  const { progress, markDone, signedIn } = useProgress(corpus, projectId);

  const loadGuide = useCallback(
    async (refresh = false) => {
      setGuide({ kind: 'loading' });
      try {
        const res = await fetch('/api/practice-guide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ corpus, projectId, refresh }),
        });
        const body = (await res.json().catch(() => null)) as
          | { success?: boolean; data?: PracticeGuidePayload; error?: string; message?: string }
          | null;
        const payload = body?.data ?? (body as unknown as PracticeGuidePayload | null);
        if (!res.ok || !payload || !('guide' in payload)) {
          setGuide({ kind: 'failed', message: body?.message ?? body?.error ?? '带练路线没取到。' });
          return;
        }
        setGuide({ kind: 'ready', payload });
      } catch (error) {
        setGuide({ kind: 'failed', message: String(error) });
      }
    },
    [corpus, projectId],
  );

  useEffect(() => {
    if (!corpus || !projectId) return;
    // 取路线放到下一帧：effect 里直接 setState 会被 lint 拦，也免得和首帧渲染抢
    const frame = window.requestAnimationFrame(() => void loadGuide(false));
    return () => window.cancelAnimationFrame(frame);
  }, [corpus, projectId, loadGuide]);

  // 没手动选过就停在第一个没过关的里程碑；选过的以选的为准。派生量，不写 effect。
  const firstOpen =
    guide.kind === 'ready'
      ? guide.payload.guide.milestones.find((m) => !progress.done.includes(m.index))?.index
      : undefined;
  const current = picked ?? firstOpen ?? 1;

  const milestone: GuideMilestone | undefined =
    guide.kind === 'ready' ? guide.payload.guide.milestones.find((m) => m.index === current) : undefined;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader backHref="/skills" backLabel="返回岗位技能" maxWidth="max-w-6xl" />
      <main className="mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-6">
        {practice.kind === 'loading' && (
          <p className="text-sm text-muted-foreground">正在读取实操项目…</p>
        )}
        {practice.kind !== 'loading' && !project && (
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-sm font-medium">没有这个实操项目</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {practice.kind === 'ready'
                ? '它不在当前领域已发布的实操项目里，可能已被管理者下架。'
                : practice.reason}
            </p>
            <Link href="/skills" className="mt-3 inline-block text-sm underline underline-offset-4">
              回到岗位技能页
            </Link>
          </div>
        )}

        {project && (
          <>
            <ProjectHeader project={project} corpus={corpus} />

            {guide.kind === 'loading' && (
              <div className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在按画像拆里程碑。第一次要一两分钟，之后同一档画像直接打开。
              </div>
            )}
            {guide.kind === 'failed' && (
              <div className="mt-6 rounded-xl border border-border bg-card px-5 py-4">
                <p className="text-sm font-medium">带练路线没生成出来</p>
                <p className="mt-1 text-sm text-muted-foreground">{guide.message}</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => loadGuide(false)}>
                  再试一次
                </Button>
              </div>
            )}

            {guide.kind === 'ready' && (
              <>
                <GuideIntro payload={guide.payload} signedIn={signedIn} onRefresh={() => loadGuide(true)} />
                <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr]">
                  <MilestoneList
                    milestones={guide.payload.guide.milestones}
                    current={current}
                    done={progress.done}
                    onPick={setPicked}
                  />
                  {milestone && (
                    <div className="min-w-0 space-y-5">
                      <MilestoneDetail milestone={milestone} />
                      <MilestoneCoach
                        key={`${milestone.index}-${progress.done.includes(milestone.index)}`}
                        milestone={milestone}
                        projectName={project.name}
                        passed={progress.done.includes(milestone.index)}
                        tier={guide.payload.decisions.tier}
                        onPassed={() => void markDone(milestone.index)}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function ProjectHeader({ project, corpus }: { readonly project: PracticeProject; readonly corpus: string }) {
  return (
    <header>
      <p className="text-xs text-muted-foreground">
        {domainLabel(corpus)} · 实操项目 · {LEVEL_LABEL[project.level]} · 难度 {project.difficulty}/5 · {project.hours}
      </p>
      <h1 className="mt-1 text-2xl font-semibold leading-snug">{project.name}</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{project.why}</p>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{project.org}</span>
        <span>{licenseNote(project)}</span>
        {project.links.map((l) => (
          <a
            key={l.url}
            href={l.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-blue-deep underline underline-offset-2 hover:no-underline"
          >
            {l.label}
            <ExternalLink className="size-3" />
          </a>
        ))}
      </p>
    </header>
  );
}

function GuideIntro({
  payload,
  signedIn,
  onRefresh,
}: {
  readonly payload: PracticeGuidePayload;
  readonly signedIn: boolean | null;
  readonly onRefresh: () => void;
}) {
  const { guide, decisions, personalized } = payload;
  const total = guide.milestones.reduce((s, m) => s + m.minutes, 0);
  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-5" data-testid="guide-intro">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">做完你手里有什么</p>
          <p className="mt-1 text-sm leading-relaxed">{guide.overview}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onRefresh} title="按当前画像重新拆一遍">
          <RefreshCw className="size-3.5" />
          重拆
        </Button>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">为什么这样拆：</span>
        {guide.fit}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {guide.milestones.length} 段 · 约 {Math.round(total / 60)} 小时 · 姿态档 {decisions.tier} · 工程习惯按自评{' '}
        {decisions.engineering_level}/4 给 ·{' '}
        {personalized ? '按你账户里的画像拆的' : '按访客默认档拆的，登录后按你的画像重拆'}
        {signedIn === false && '（进度只记在这台浏览器里）'}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">节奏：</span>
        {guide.management.cadence} <span className="font-medium text-foreground">记录：</span>
        {guide.management.tracking}
      </p>
    </section>
  );
}

function MilestoneList({
  milestones,
  current,
  done,
  onPick,
}: {
  readonly milestones: GuideMilestone[];
  readonly current: number;
  readonly done: number[];
  readonly onPick: (index: number) => void;
}) {
  return (
    <nav aria-label="里程碑" className="lg:sticky lg:top-4 lg:self-start">
      <ol className="space-y-1">
        {milestones.map((m) => {
          const isDone = done.includes(m.index);
          const isCurrent = m.index === current;
          return (
            <li key={m.index}>
              <button
                type="button"
                onClick={() => onPick(m.index)}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  isCurrent ? 'bg-purple-soft text-purple-deep' : 'hover:bg-accent',
                )}
              >
                {isDone ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-deep" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                )}
                <span className="min-w-0">
                  <span className="block leading-snug">
                    {m.index}. {m.title}
                  </span>
                  <span className="block text-xs text-muted-foreground">约 {m.minutes} 分钟</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function MilestoneDetail({ milestone: m }: { readonly milestone: GuideMilestone }) {
  return (
    <article className="rounded-xl border border-border bg-card p-5" data-testid="milestone-detail">
      <p className="text-xs text-muted-foreground">第 {m.index} 段 · 约 {m.minutes} 分钟</p>
      <h2 className="mt-1 text-lg font-semibold leading-snug">{m.title}</h2>
      <p className="mt-2 text-sm leading-relaxed">{m.goal}</p>

      <Block title="要搭什么">
        <ul className="list-disc space-y-1 pl-5">
          {m.build.map((b, i) => (
            <li key={`${i}-${b.slice(0, 10)}`}>{b}</li>
          ))}
        </ul>
      </Block>
      <Block title="怎么做">
        <ol className="list-decimal space-y-1.5 pl-5">
          {m.how.map((h, i) => (
            <li key={`${i}-${h.slice(0, 10)}`}>{h}</li>
          ))}
        </ol>
      </Block>
      <Block title="做到什么算完成">
        <p>{m.acceptance}</p>
      </Block>
      <Block title="这一段练一个工程习惯">
        <p>
          <span className="rounded-full bg-blue-soft px-2 py-px text-xs font-medium text-blue-deep">
            {m.engineering_habit.title}
          </span>
        </p>
        <p className="mt-1.5">{m.engineering_habit.how}</p>
      </Block>
      {m.pitfalls.length > 0 && (
        <Block title="常见坑">
          <ul className="list-disc space-y-1 pl-5">
            {m.pitfalls.map((p, i) => (
              <li key={`${i}-${p.slice(0, 10)}`}>{p}</li>
            ))}
          </ul>
        </Block>
      )}
      {m.reading.length > 0 && (
        <Block title="卡住了读这几段教材">
          <ul className="space-y-1">
            {m.reading.map((r) => (
              <li key={r.source_id} className="text-muted-foreground">
                <span className="font-mono text-xs text-foreground">{r.source_id}</span>
                {r.why ? ` · ${r.why}` : ''}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </article>
  );
}

function Block({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="mt-4 text-sm leading-relaxed">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}
