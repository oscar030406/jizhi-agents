'use client';

// 域级实操项目的共享客户端与展示卡。运行时唯一真源是 practice-scout 的已发布结果；
// 旧 data/practice-projects.json 不再进入任何选择器，避免绕过生成、审核与发布门禁。

import Link from 'next/link';
import { useEffect, useState } from 'react';

export interface PracticeProject {
  id: string;
  name: string;
  org: string;
  level: 'starter' | 'advanced' | 'portfolio';
  difficulty: number;
  hours: string;
  jobIds: string[];
  /** 引擎在当前领域候选课程中生成、并经服务端复验的课程边。 */
  courseIds: string[];
  prereq: string;
  steps: string[];
  cost: string;
  networkNote: string;
  why: string;
  acceptance: string;
  deliverable: string;
  resumeAdvice: string;
  links: Array<{ label: string; url: string }>;
  alternatives: string[];
  firsthand: boolean;
  /** 起草时从 GitHub 实拉的事实字段，模型无权改写。许可证要露出来：
      「无许可证信息」不等于可以随便拿来改，学习者照着做之前有权先知道。 */
  provenance?: { license?: string; stars?: number; pushed_at?: string };
}

/** 许可证一行。拉不到就说拉不到，不写「未知」当成一种许可证。 */
export function licenseNote(project: PracticeProject): string {
  const license = project.provenance?.license?.trim();
  if (!license || license === '无许可证信息') return '仓库未标注开源许可证';
  if (license === 'NOASSERTION') return '许可证未被 GitHub 识别';
  return `许可证 ${license}`;
}

const LEVEL_META: Record<PracticeProject['level'], { label: string; cls: string }> = {
  starter: { label: '第一个项目', cls: 'bg-green-soft text-green-deep' },
  advanced: { label: '进阶', cls: 'bg-blue-soft text-blue-deep' },
  portfolio: { label: '作品级', cls: 'bg-purple-soft text-purple-deep' },
};
const LEVEL_ORDER: PracticeProject['level'][] = ['starter', 'advanced', 'portfolio'];

export type PracticeLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; projects: PracticeProject[] }
  | { kind: 'missing'; reason: string }
  | { kind: 'unavailable'; reason: string };

/** 当前领域已发布实操项目。结果与 corpus 绑定，切域当帧即失效旧数组。 */
export function usePublishedPractice(corpus: string | null): PracticeLoadState {
  const [loaded, setLoaded] = useState<{
    corpus: string;
    state: PracticeLoadState;
  } | null>(null);

  useEffect(() => {
    if (!corpus) return;
    let alive = true;
    (async () => {
      try {
        const response = await fetch(`/api/practice-scout/${encodeURIComponent(corpus)}`, {
          cache: 'no-store',
        });
        const body = (await response.json().catch(() => null)) as {
          status?: string;
          projects?: PracticeProject[];
          reason?: string;
        } | null;
        if (!alive) return;
        if (!response.ok || body?.status === 'unavailable') {
          setLoaded({
            corpus,
            state: {
              kind: 'unavailable',
              reason:
                body?.reason ?? '实操项目服务暂时不可用，当前无法确认该领域是否已有生成结果。',
            },
          });
          return;
        }
        const projects = body?.projects ?? [];
        setLoaded({
          corpus,
          state: projects.length
            ? { kind: 'ready', projects }
            : {
                kind: 'missing',
                reason: body?.reason ?? '所属机构尚未生成并审核发布该领域的实操项目。',
              },
        });
      } catch {
        if (alive) {
          setLoaded({
            corpus,
            state: {
              kind: 'unavailable',
              reason: '实操项目服务暂时不可用，当前无法确认该领域是否已有生成结果。',
            },
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [corpus]);

  if (!corpus) {
    return { kind: 'missing', reason: '当前学习领域尚未确认，暂时没有可读取的实操项目。' };
  }
  return loaded?.corpus === corpus ? loaded.state : { kind: 'loading' };
}

// focus 环，口径见 app/path/page.tsx 同名常量：--ring 带 alpha，实测 1.26:1 看不见，
// 借满不透明度的中性蓝 chart-2 顶上。--ring 修好后三处一起换回。
const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chart-2';

export function projectsForJob(
  projects: readonly PracticeProject[],
  jobId: string,
): PracticeProject[] {
  return projects
    .filter((p) => p.jobIds.includes(jobId))
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level))
    .slice(0, 3); // 一技能点 ≤3 推荐（roadmap.sh/AWS 共性规律）
}

/**
 * 反向索引：一门课有哪些对口项目。边只落在发布项目侧（courseIds），这里运行时算，
 * 不往课程数据再写一份。按层级排序，不截断。
 */
export function projectsForCourse(
  projects: readonly PracticeProject[],
  courseId: string,
): PracticeProject[] {
  return projects
    .filter((p) => p.courseIds.includes(courseId))
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

/** 首页「动手实操」区每档取几张（starter 2 / advanced 2 / portfolio 1 压轴）。 */
const HOME_PICKS: Record<PracticeProject['level'], number> = {
  starter: 2,
  advanced: 2,
  portfolio: 1,
};

/**
 * 首页精选：每档按引擎发布顺序取前 N；发布顺序已经经过管理者审核，不再二次猜分。
 */
export function featuredProjects(projects: readonly PracticeProject[]): PracticeProject[] {
  return LEVEL_ORDER.flatMap((level) =>
    projects.filter((p) => p.level === level).slice(0, HOME_PICKS[level]),
  );
}

export function PracticeCard({
  project,
  courseTitles,
  corpus = 'ai',
}: {
  readonly project: PracticeProject;
  /** courseId → 课名。给了才渲染「相关课程」行；读不到课名时整行不出（不显示裸 id）。 */
  readonly courseTitles?: Record<string, string>;
  /** 带练页的路由要带域：项目 id 只在域内唯一。 */
  readonly corpus?: string;
}) {
  const meta = LEVEL_META[project.level];
  const relatedCourses = project.courseIds
    .map((id) => ({ id, title: courseTitles?.[id] }))
    .filter((c): c is { id: string; title: string } => Boolean(c.title));
  return (
    <details className="group rounded-lg border border-border bg-card">
      {/* 窄屏把项目名换到第二行独占整行：375px 视口下这一行只有 271px，
          层级徽标与星级/工时是定宽的，实测只剩 73px 留给项目名，
          「tiny-universe：白盒手搓 RAG/Agent」被截成看不出是什么。 */}
      <summary
        className={`flex cursor-pointer flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors duration-150 hover:bg-muted/50 [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}
      >
        <span className={`shrink-0 rounded-full px-2 py-px text-xs font-medium ${meta.cls}`}>
          {meta.label}
        </span>
        {/* 窄屏独占一行后就让它换行显示全名（最多两行），sm 以上回到单行截断 */}
        <span className="order-last w-full min-w-0 font-medium sm:order-none sm:w-auto sm:flex-1 sm:truncate">
          {project.name}
        </span>
        <span
          className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground sm:ml-0"
          aria-label={`难度 ${project.difficulty} / 5，约 ${project.hours}`}
        >
          {'★'.repeat(project.difficulty) + '☆'.repeat(Math.max(0, 5 - project.difficulty))} ·{' '}
          {project.hours}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border-subtle px-3 py-2.5 text-xs leading-relaxed">
        <p>{project.why}</p>
        {project.steps && project.steps.length > 0 && (
          <div>
            <p className="font-medium">操作步骤：</p>
            <ol className="mt-1 list-decimal space-y-1 pl-5">
              {project.steps.map((step, index) => (
                <li key={`${index}-${step}`}>{step}</li>
              ))}
            </ol>
          </div>
        )}
        <p>
          <span className="font-medium">前置：</span>
          {project.prereq} · <span className="font-medium">成本：</span>
          {project.cost}
        </p>
        {project.networkNote.startsWith('⚠') && (
          <p className="text-yellow-deep">{project.networkNote}</p>
        )}
        <p>
          <span className="font-medium">验收：</span>
          {project.acceptance}
        </p>
        <p>
          <span className="font-medium">做完有：</span>
          {project.deliverable}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">简历用法：</span>
          {project.resumeAdvice}
        </p>
        {relatedCourses.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">相关课程：</span>
            {relatedCourses.map((c) => (
              <Link
                key={c.id}
                href={`/classroom/${c.id}`}
                className={`inline-flex min-h-6 items-center rounded text-blue-deep underline underline-offset-2 hover:no-underline ${FOCUS_RING}`}
              >
                {c.title}
              </Link>
            ))}
          </p>
        )}
        {/* 外链改成 min-h-6 的 inline-flex：原来是纯行内文本，点击区只有 16px 高，
            不到 WCAG 2.5.8 的 24×24 */}
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
          <Link
            href={`/practice/${encodeURIComponent(corpus)}/${encodeURIComponent(project.id)}`}
            className={`inline-flex min-h-6 items-center rounded bg-purple-soft px-2 font-medium text-purple-deep ${FOCUS_RING}`}
          >
            带我做这个项目
          </Link>
          {project.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex min-h-6 items-center rounded text-blue-deep underline underline-offset-2 hover:no-underline ${FOCUS_RING}`}
            >
              {l.label} ↗
            </a>
          ))}
          <span className="text-muted-foreground">{licenseNote(project)}</span>
          {!project.firsthand && <span className="text-muted-foreground">（一手体验待验证）</span>}
        </p>
      </div>
    </details>
  );
}
