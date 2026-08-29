// /skills 每岗位「实践项目」区（learning-path-practice-spec §2.3）。
// 数据 data/practice-projects.json 静态 import（客户端页可用，13 卡体积可忽略）；
// 一岗 ≤3 张按层级排序；词条字段含验收标准/简历用法/网络警告（我们的增量字段）。

import Link from 'next/link';

import practiceData from '@/data/practice-projects.json';

export interface PracticeProject {
  id: string;
  name: string;
  org: string;
  level: 'starter' | 'advanced' | 'portfolio';
  difficulty: number;
  hours: string;
  jobIds: string[];
  /** 人工策展的课程边（data/practice-projects.json）：学完这门课能上手做这个项目。 */
  courseIds: string[];
  prereq: string;
  cost: string;
  networkNote: string;
  why: string;
  acceptance: string;
  deliverable: string;
  resumeAdvice: string;
  links: Array<{ label: string; url: string }>;
  alternatives: string[];
  firsthand: boolean;
}

const LEVEL_META: Record<PracticeProject['level'], { label: string; cls: string }> = {
  starter: { label: '第一个项目', cls: 'bg-green-soft text-green-deep' },
  advanced: { label: '进阶', cls: 'bg-blue-soft text-blue-deep' },
  portfolio: { label: '作品级', cls: 'bg-purple-soft text-purple-deep' },
};
const LEVEL_ORDER: PracticeProject['level'][] = ['starter', 'advanced', 'portfolio'];

const ALL_PROJECTS = (practiceData as { projects: PracticeProject[] }).projects;

/**
 * 这份静态策展数据（岗位图谱 + 13 个项目）属于哪个知识库。
 * 数据文件本身没有 domain 字段——它诞生于只有主库的年代。判断「当前域有没有
 * 岗位/策展数据」的分支一律引用这个常量，不许把 'ai' 直接写进业务逻辑
 * （2026-08-28 硬编码清查：skills 页曾写死 `!== 'ai'`）。
 * 外域的实操供给走引擎 practice-scout（GitHub 实搜起草 + 管理员审核），不读本文件。
 */
export const JOB_MAP_CORPUS = 'ai';

// focus 环，口径见 app/path/page.tsx 同名常量：--ring 带 alpha，实测 1.26:1 看不见，
// 借满不透明度的中性蓝 chart-2 顶上。--ring 修好后三处一起换回。
const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chart-2';

export function projectsForJob(jobId: string): PracticeProject[] {
  return ALL_PROJECTS
    .filter((p) => p.jobIds.includes(jobId))
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level))
    .slice(0, 3); // 一技能点 ≤3 推荐（roadmap.sh/AWS 共性规律）
}

/**
 * 反向索引：一门课有哪些对口项目。边只落在项目侧（courseIds），这里运行时算，
 * 不落第二份数据——课程 json 是冻结的策展物，不往里写。
 * 按层级排序，不截断：一门课挂到的项目最多 5 个（当前策展实测），全给。
 */
export function projectsForCourse(courseId: string): PracticeProject[] {
  return ALL_PROJECTS
    .filter((p) => p.courseIds.includes(courseId))
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

/** 首页区尾「全部 N 个实操项目」用的总数，别在页面里写死数字。 */
export const PRACTICE_PROJECT_TOTAL = ALL_PROJECTS.length;

/** 首页「动手实操」区每档取几张（starter 2 / advanced 2 / portfolio 1 压轴）。 */
const HOME_PICKS: Record<PracticeProject['level'], number> = {
  starter: 2,
  advanced: 2,
  portfolio: 1,
};

/**
 * 首页精选：每档按 `practice-projects.json` 里的排列顺序取前 N。
 *
 * 用文件顺序而不是难度或星数排——那份 json 是人工策展物，条目顺序本身就是策展顺序
 * （每档第一条是该档的代表作），再套一层算法排序等于把策展意图洗掉。
 */
export function featuredProjects(): PracticeProject[] {
  return LEVEL_ORDER.flatMap((level) =>
    ALL_PROJECTS.filter((p) => p.level === level).slice(0, HOME_PICKS[level]),
  );
}

export function PracticeCard({
  project,
  courseTitles,
}: {
  readonly project: PracticeProject;
  /** courseId → 课名。给了才渲染「相关课程」行；读不到课名时整行不出（不显示裸 id）。 */
  readonly courseTitles?: Record<string, string>;
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
        <span className={`shrink-0 rounded-full px-2 py-px text-xs font-medium ${meta.cls}`}>{meta.label}</span>
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
        <p><span className="font-medium">前置：</span>{project.prereq} · <span className="font-medium">成本：</span>{project.cost}</p>
        {project.networkNote.startsWith('⚠') && (
          <p className="text-yellow-deep">{project.networkNote}</p>
        )}
        <p><span className="font-medium">验收：</span>{project.acceptance}</p>
        <p><span className="font-medium">做完有：</span>{project.deliverable}</p>
        <p className="text-muted-foreground"><span className="font-medium">简历用法：</span>{project.resumeAdvice}</p>
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
          {!project.firsthand && <span className="text-muted-foreground">（一手体验待验证）</span>}
        </p>
      </div>
    </details>
  );
}
