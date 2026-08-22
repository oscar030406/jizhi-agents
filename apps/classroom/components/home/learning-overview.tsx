'use client';

/**
 * 登录工作台首屏的两件：「我的学习路径」与「我的学情」。
 * （第三件「继续学习」复用已有的 ContinueHeroCard，没有另起。）
 *
 * ## 路径卡为什么读 JSON 而不是写死
 *
 * 路径主线的条数、名字、每条挂哪些课，全部现读 `data/learning-path.json`——
 * 读什么画什么。现在那份文件里是三条主线，改成两条或四条、改名字、改挂课，
 * 这张卡跟着变，不用改这里一行代码（自测见 tests/home/learning-overview.test.tsx，
 * 拿两条主线的夹具跑同一套函数）。
 *
 * ## 数字口径（都能复算，别在这儿造）
 *
 * - 「已学完 x / 共 N 门」：N = 该主线挂的、在 nodes 表里找得到的节点数；
 *   x = 其中 courseId 在**本机学习记录**里进度到最后一屏的门数。
 *   进度来自 `getResumeProgressByStages`（(当前页序号+1)/总页数），首页已经在算了，
 *   这里只是拿来用，没有第二套算法。「在学 y 门」= 本机有这门课的学习记录但还没到最后一屏
 *   （打开过就算在学，不假装它学完了）。
 * - 「y 门规划中」：节点没有 courseId（路径表里的占位课，status=planned）。
 *   措辞与 /path 上的占位卡对齐——同一个状态在两页上必须是同一个词。**不计入已学完**，
 *   也不假装它可以点。
 * - 学情摘要的 0.6 线：与 `/report` 的「实测盲区」同一条线，不是新拍的。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BarChart3, BookOpen, Route } from 'lucide-react';
import rawPathData from '@/data/learning-path.json';
import rawCourseDomains from '@/data/course-domains.json';
import { conceptLabel } from '@/lib/knowledge/concept-labels';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { cn } from '@/lib/utils';
import type { LearnerProfileFields } from '@/lib/types/generation';
import { CARD_RECIPE_STATIC } from './course-card';

export interface PathNodeLike {
  id: string;
  title: string;
  courseId?: string | null;
}

export interface PathTrackLike {
  id: string;
  title: string;
  nodeIds: string[];
}

export interface PathDataLike {
  nodes?: PathNodeLike[];
  tracks?: PathTrackLike[];
}

export interface TrackSummary {
  id: string;
  title: string;
  /** 主线挂的课程节点数（只算 nodes 表里找得到的） */
  total: number;
  /** 本机学习记录里已学到最后一屏的门数 */
  done: number;
  /** 本机有学习记录但还没学完的门数 */
  inProgress: number;
  /** 还没有课的占位节点（路径表里 courseId 为空） */
  planned: number;
  /** 下一门可直达的课：本主线里第一门「有课且没学完」的 */
  next?: { nodeId: string; title: string; courseId: string };
}

/** 学完判定：进度是 (当前页+1)/总页数，浮点除法留一点余量 */
const DONE_AT = 0.999;

/**
 * 主线进度汇总。纯函数，不碰存储不碰 DOM——测试直接喂夹具。
 *
 * `progressByCourseId` 只收**本机有学习记录的课**：键在里面 = 打开过，
 * 值 = 首页算好的续读进度（没读到过第二屏就是 0）。
 * `current` = 学过的门数（含在学）最多的那条主线，并列取路径表里靠前的；全为 0 时取第一条。
 */
export function summarizePath(
  path: PathDataLike,
  progressByCourseId: Record<string, number>,
): { tracks: TrackSummary[]; currentId?: string } {
  const nodeById = new Map((path.nodes ?? []).map((n) => [n.id, n]));
  const tracks: TrackSummary[] = (path.tracks ?? []).map((track) => {
    const nodes = track.nodeIds.map((id) => nodeById.get(id)).filter((n): n is PathNodeLike => !!n);
    let done = 0;
    let inProgress = 0;
    let planned = 0;
    let next: TrackSummary['next'];
    for (const node of nodes) {
      if (!node.courseId) {
        planned += 1;
        continue;
      }
      const progress = progressByCourseId[node.courseId];
      if (progress !== undefined && progress >= DONE_AT) {
        done += 1;
        continue;
      }
      if (progress !== undefined) inProgress += 1;
      if (!next) next = { nodeId: node.id, title: node.title, courseId: node.courseId };
    }
    return { id: track.id, title: track.title, total: nodes.length, done, inProgress, planned, next };
  });
  if (tracks.length === 0) return { tracks };
  const touched = (t: TrackSummary) => t.done + t.inProgress;
  const currentId = tracks.reduce((best, t) => (touched(t) > touched(best) ? t : best), tracks[0]).id;
  return { tracks, currentId };
}

function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`已学完 ${done} 门，共 ${total} 门`}
    >
      <div className="h-full rounded-full bg-purple-deep/70" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 我的学习路径：当前主线 + 进度条 + 下一门课直达；其余主线折成一行一条 */
export function MyPathCard({
  progressByCourseId,
  path = rawPathData as PathDataLike,
  className,
}: {
  progressByCourseId: Record<string, number>;
  path?: PathDataLike;
  className?: string;
}) {
  const { tracks, currentId } = summarizePath(path, progressByCourseId);
  const current = tracks.find((t) => t.id === currentId);
  const others = tracks.filter((t) => t.id !== currentId);

  return (
    <section
      className={cn(
        'overflow-hidden [background-image:linear-gradient(to_bottom,color-mix(in_oklab,var(--purple-soft)_45%,transparent),transparent_40%)]',
        CARD_RECIPE_STATIC,
        className,
      )}
    >
      <div className="h-1 w-full bg-purple-deep/50" />
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-lg font-medium">
            <Route className="size-4 text-purple-deep" />
            我的学习路径
          </p>
          <Link
            href="/path"
            className="shrink-0 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            全部路径
          </Link>
        </div>

        {!current ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            路径表里还没有主线（data/learning-path.json 的 tracks 为空）。补上后这里会自动显示。
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="font-medium text-foreground">{current.title}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  已学完 {current.done} / 共 {current.total} 门
                  {current.inProgress > 0 && ` · 在学 ${current.inProgress} 门`}
                  {current.planned > 0 && `（其中 ${current.planned} 门规划中）`}
                </p>
              </div>
              <ProgressBar done={current.done} total={current.total} />
            </div>

            {current.next ? (
              <Link
                href={`/classroom/${current.next.courseId}`}
                className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block text-xs text-muted-foreground">下一门</span>
                  <span className="block truncate text-sm font-medium text-foreground">
                    {current.next.title}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
                这条主线上已生成的课都学完了。
                <Link href="/path" className="ml-1 text-foreground underline underline-offset-2">
                  看看别的主线
                </Link>
              </p>
            )}

            {others.length > 0 && (
              <div className="space-y-2 border-t border-border/50 pt-3">
                {others.map((t) => (
                  <Link
                    key={t.id}
                    href="/path"
                    className="flex items-center gap-3 rounded-md px-1 py-1 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.title}</span>
                    <ProgressBar done={t.done} total={t.total} className="h-1 w-20 shrink-0" />
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {t.done}/{t.total}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * 域工作区（首页最小实现）：画像选了非 AI 语料库时，路径卡换成该域的课程卡。
 *
 * ## 为什么路径卡要让位
 *
 * `learning-path.json` 是 AI 领域专属的教研产物（30 个节点全部锚 AI 教材章节）。
 * 画像切到企业管理系统 Odoo 之类的库以后还展示 AI 路径，学习者的感知就是
 * 「换库毫无效果」——这正是被抓过的线上问题。没有为每个域造路径之前，
 * 诚实的做法是：有课列课，没课就说清楚没有、并把人引到生成入口。
 *
 * ## 课程归属从哪来
 *
 * `data/course-domains.json`，由 `scripts/build-course-domains.mjs` 从每门课
 * 引用的 source_id 推导（路径内课程一律 ai；详见脚本头注释）。新增课程后
 * 重跑脚本即可，这里读什么画什么。
 */
interface CourseDomainEntry {
  domain: string;
  title: string;
}

export function DomainCoursesCard({
  corpus,
  courseDomains,
  progressByCourseId = {},
  className,
}: {
  corpus: string;
  /** 测试注入用。缺省时先用打包快照出首帧，再被 /api/course-domains 的运行时推导覆盖。 */
  courseDomains?: Record<string, CourseDomainEntry>;
  progressByCourseId?: Record<string, number>;
  className?: string;
}) {
  // 归属主从：运行时推导（/api/course-domains，现读磁盘）为主，打包快照为首帧兜底。
  // 快照是构建时的世界——投币新建的课不在里面；此前只读快照，新域的课在这张卡上隐形。
  const [runtimeDomains, setRuntimeDomains] = useState<Record<string, CourseDomainEntry> | null>(
    null,
  );
  useEffect(() => {
    if (courseDomains) return; // 测试注入了就不拉
    let alive = true;
    fetch('/api/course-domains')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data && typeof data === 'object')
          setRuntimeDomains(data as Record<string, CourseDomainEntry>);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [courseDomains]);

  const label = domainLabel(corpus);
  const effective =
    courseDomains ?? runtimeDomains ?? (rawCourseDomains as Record<string, CourseDomainEntry>);
  const courses = Object.entries(effective)
    .filter(([, v]) => v.domain === corpus)
    .map(([id, v]) => ({ id, title: v.title, progress: progressByCourseId[id] }));
  const done = courses.filter((c) => (c.progress ?? 0) >= DONE_AT).length;

  return (
    <section
      className={cn(
        'overflow-hidden [background-image:linear-gradient(to_bottom,color-mix(in_oklab,var(--purple-soft)_45%,transparent),transparent_40%)]',
        CARD_RECIPE_STATIC,
        className,
      )}
    >
      <div className="h-1 w-full bg-purple-deep/50" />
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-lg font-medium">
            <BookOpen className="size-4 text-purple-deep" />
            {label} · 领域课程
          </p>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {courses.length > 0 ? `已学完 ${done} / 共 ${courses.length} 门` : '当前知识库'}
          </span>
        </div>

        {courses.length > 0 ? (
          <ul className="space-y-2">
            {courses.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/classroom/${c.id}`}
                  className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {c.title}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {c.progress !== undefined && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {c.progress >= DONE_AT ? '已学完' : `${Math.round(c.progress * 100)}%`}
                      </span>
                    )}
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
            「{label}」领域还没有生成课程。用上方输入框描述你的学习需求，
            生成这个领域的第一门课——生成会从该库的教材取证据。
          </p>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          学习路径目前只覆盖人工智能应用开发领域；其他领域按课程逐门学习。
          在画像里把知识库换回「跟随培训领域」即可回到路径视图。
        </p>
      </div>
    </section>
  );
}

/**
 * 路径卡的域感知入口：AI 域（含未选库=跟随培训领域）走原路径卡，
 * 非 AI 域换 DomainCoursesCard。首页只需要换这个调用点，别的行为不变。
 */
export function PathOrDomainCard({
  corpus,
  progressByCourseId,
  className,
}: {
  corpus?: string;
  progressByCourseId: Record<string, number>;
  className?: string;
}) {
  const effective = corpus?.trim();
  if (!effective || effective === 'ai') {
    return <MyPathCard progressByCourseId={progressByCourseId} className={className} />;
  }
  return (
    <DomainCoursesCard
      corpus={effective}
      progressByCourseId={progressByCourseId}
      className={className}
    />
  );
}

/** 与 /report「实测盲区」同一条线：低于它算薄弱点 */
const WEAK_BELOW = 0.6;

/** 我的学情：掌握概念数 + 薄弱点，一行进 /report */
export function MasterySummaryCard({
  profile,
  className,
}: {
  profile: LearnerProfileFields;
  className?: string;
}) {
  const entries = Object.entries(profile.conceptMastery ?? {}).sort((a, b) => a[1] - b[1]);
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
      <div className="h-1 w-full bg-blue-deep/40" />
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
