/**
 * 首页「动手实操」区。落地设计冻结在 `.claude/workorders/WO-N1-practice-visibility.md`
 * 的「半张 A 落地设计」节。
 *
 * 数据与 /skills 同源：只展示引擎生成并经管理者审核发布的项目。首页卡面直接展开
 * 3–6 个操作步骤和验收标准，访客不必先进入岗位页才能判断项目能不能真正动手。
 */

import Link from 'next/link';
import { Hammer } from 'lucide-react';

import { CARD_RECIPE } from '@/components/home/course-card';
import { SectionAnchor } from '@/components/home/section-anchor';
import {
  featuredProjects,
  type PracticeLoadState,
  type PracticeProject,
} from '@/components/skills/practice-projects';
import { cn } from '@/lib/utils';

const LEVEL_LABEL: Record<PracticeProject['level'], { label: string; cls: string }> = {
  starter: { label: '第一个项目', cls: 'bg-green-soft text-green-deep' },
  advanced: { label: '进阶', cls: 'bg-blue-soft text-blue-deep' },
  portfolio: { label: '作品级', cls: 'bg-purple-soft text-purple-deep' },
};

// 焦点环口径与 practice-projects.tsx 一致：--ring 带 alpha，实测 1.26:1 看不见，
// 借满不透明度的中性蓝 chart-2 顶上。--ring 修好后几处一起换回。
const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chart-2';

const LINK =
  `inline-flex min-h-6 items-center rounded text-blue-deep underline underline-offset-2 ` +
  `hover:no-underline ${FOCUS_RING}`;

function HighlightCard({
  project,
  courseTitles,
}: {
  readonly project: PracticeProject;
  /** courseId → 课名。读不到课名的边整条不出，不显示裸 id（沿用 PracticeCard 的做法）。 */
  readonly courseTitles?: Record<string, string>;
}) {
  const meta = LEVEL_LABEL[project.level];
  // 首页卡面窄，对口课程最多摆两条；全部关系在 /skills 与课堂内的「动手做」区块里。
  const related = project.courseIds
    .map((id) => ({ id, title: courseTitles?.[id] }))
    .filter((c): c is { id: string; title: string } => Boolean(c.title))
    .slice(0, 2);
  return (
    <div className={cn(CARD_RECIPE, 'flex h-full flex-col gap-2 p-4')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`shrink-0 rounded-full px-2 py-px text-xs font-medium ${meta.cls}`}>
          {meta.label}
        </span>
        <span className="text-xs text-muted-foreground">{project.hours}</span>
      </div>
      <h3 className="text-sm font-semibold leading-snug">{project.name}</h3>
      <p className="text-xs text-muted-foreground">{project.org}</p>
      <p className="text-xs leading-relaxed">
        <span className="font-medium">做到什么算完成：</span>
        {project.acceptance}
      </p>
      <div className="text-xs leading-relaxed">
        <p className="font-medium">操作步骤：</p>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          {project.steps.map((step, index) => (
            <li key={`${index}-${step}`}>{step}</li>
          ))}
        </ol>
      </div>
      {related.length > 0 && (
        <p className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs">
          <span className="text-muted-foreground">对口课程</span>
          {related.map((c) => (
            <Link key={c.id} href={`/classroom/${c.id}`} className={LINK}>
              {c.title}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}

export function PracticeHighlights({
  state,
  courseTitles,
}: {
  readonly state: PracticeLoadState;
  readonly courseTitles?: Record<string, string>;
}) {
  const readyProjects = state.kind === 'ready' ? state.projects : [];
  const projects = featuredProjects(readyProjects);
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-[28px] font-semibold leading-snug">
          <SectionAnchor icon={Hammer} />
          动手实操
        </h2>
        {state.kind === 'ready' && (
          <Link href="/skills" className={`${LINK} shrink-0 text-sm`}>
            全部 {readyProjects.length} 个实操项目 →
          </Link>
        )}
      </div>
      {state.kind === 'ready' ? (
        <>
          <div className="mt-2 flex items-start justify-between gap-6">
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              这些项目由引擎从真实开源仓库中检索生成，并经管理者逐条审核发布。每项都写清操作步骤、
              验收标准和对口课程。
            </p>
            <img
              src="/illustrations/ill-path.png"
              alt=""
              aria-hidden
              loading="lazy"
              className="hidden h-20 w-auto shrink-0 object-contain sm:block"
            />
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <HighlightCard key={p.id} project={p} courseTitles={courseTitles} />
            ))}
          </div>
        </>
      ) : (
        <p
          className="mt-4 rounded-xl border border-border bg-card px-5 py-4 text-sm leading-relaxed text-muted-foreground"
          data-testid="practice-highlights-status"
        >
          {state.kind === 'missing'
            ? state.reason
            : state.kind === 'unavailable'
              ? state.reason
              : '正在读取已审核发布的实操项目…'}
        </p>
      )}
    </>
  );
}
