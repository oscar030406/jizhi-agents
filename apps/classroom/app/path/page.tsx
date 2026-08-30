// 学习路径全景页（server component）。
//
// 结构真源是 data/learning-path.json 的 tracks：三个模块，nodeIds 的顺序就是模块内
// 的展示顺序。页面不再按「岗位轨」切——同一个人学完模块一后走模块二还是模块三，
// 是并行的两条线，不是三份互相重叠 70% 的岗位清单。
//
// 沿用规格 learning-path-practice-spec §1.1「阶段感靠空间分区表达，依赖只在硬性处
// 画箭头；不做全连接依赖图」与 §1.5「不引图库」：连线由零依赖的内联 SVG 画，
// 见 ./dependency-edges.tsx，只画同一模块内的 prereq 边。
//
// 节点两态：
//   - 已生成（courseId 指向 data/classrooms 里真实存在的课）→ 可点，进课堂；
//   - 规划中（courseId 为 null、status=planned）→ 不可点、不计入门数统计里的「已生成」。
//     这是本页最容易失真的地方：规划中的课不许混进「N 门课 · 约 X 小时」的时长里，
//     所以时长只用已生成课的场景数算，规划中的门数单列一栏。
//
// 域感知：下面这棵树是 AI 域的策展路径，原样不动；画像选了别的知识库时由
// DomainLearningPath 整棵换成该域按前置图自动排的路径（引擎 domain-path 端点）。
// 判定放在那个 client 组件里而不是这里——画像存在 localStorage，server component 读不到；
// 本页只把策展树当 children 交过去。

import fs from 'node:fs/promises';
import path from 'node:path';
import Link from 'next/link';
import type { Metadata } from 'next';

import { listClassrooms } from '@/lib/server/classroom-storage';
import { EmptyState } from '@/components/ui/empty-state';
import { SiteHeader } from '@/components/site-header';

import { CourseMap } from './course-map';
import { DomainLearningPath } from '@/components/path/domain-learning-path';

export const metadata: Metadata = { title: '学习路径 · 集智' };
export const dynamic = 'force-dynamic';

interface PathNode {
  id: string;
  stage: string;
  title: string;
  audience?: string;
  difficulty?: number;
  prereq?: string[];
  courseId?: string | null;
  status?: string;
  requirement?: string;
  textbookRef?: string;
}

interface PathTrack {
  id: string;
  title: string;
  hint?: string;
  nodeIds: string[];
}

interface PathData {
  nodes: PathNode[];
  tracks: PathTrack[];
  extensionDomain?: { title: string; hint?: string; courseIds: string[] };
  plannedDirections?: Array<{ title: string; status: string }>;
}

async function loadPath(): Promise<PathData> {
  const raw = await fs.readFile(path.join(process.cwd(), 'data/learning-path.json'), 'utf-8');
  return JSON.parse(raw) as PathData;
}

interface PracticeProject {
  id: string;
  name: string;
  org?: string;
  hours?: string;
  courseIds?: string[];
  why?: string;
  links?: Array<{ label: string; url: string }>;
}

async function loadPractice(): Promise<PracticeProject[]> {
  const raw = await fs.readFile(path.join(process.cwd(), 'data/practice-projects.json'), 'utf-8');
  const parsed = JSON.parse(raw) as PracticeProject[] | { projects: PracticeProject[] };
  return Array.isArray(parsed) ? parsed : (parsed.projects ?? []);
}

/** 一节课的时长估算口径（全站唯一）：场景数 × 8 分钟。规划中的课没有场景，不参与。 */
const MINUTES_PER_SCENE = 8;

/** 难度星级按规格 §1.3 的 1-5 档渲染（原来按 3 档拼，难度 4 的节点会多出一颗星）。 */
const DIFFICULTY_MAX = 5;
function difficultyStars(n?: number) {
  const filled = Math.min(DIFFICULTY_MAX, Math.max(1, Math.round(n ?? 1)));
  return { text: '★'.repeat(filled) + '☆'.repeat(DIFFICULTY_MAX - filled), label: `难度 ${filled} / ${DIFFICULTY_MAX}` };
}

// focus 环。--ring 自带 0.4 alpha，再被 shadcn 的 ring-ring/50 折半，实测只有 1.26:1
// （canvas 取真实 sRGB 字节算的，亮暗都一样），键盘用户根本看不见，不满足 WCAG 2.4.7。
// 这里借 chart-2：它是调色板里唯一一个满不透明度的中性蓝（色相 260，和规格 2.8 给 ring
// 定的 255 同族），实测亮色 3.76:1、暗色 4.77:1，都过 1.4.11 的 3:1。
// ponytail: 借 chart token 是权宜。正解是把 globals.css 里 --ring 的 alpha 提到 1，
// 那之后这三处（本页 / app/skills/page.tsx / components/skills/practice-projects.tsx）
// 都能换回 focus-visible:ring-2 focus-visible:ring-ring。
const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chart-2';

export default async function PathPage() {
  const [pathData, courses, practice] = await Promise.all([loadPath(), listClassrooms(), loadPractice()]);
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const nodeById = new Map(pathData.nodes.map((n) => [n.id, n]));

  /** 一个模块的门数与时长。ready/planned 分开数，时长只算 ready。 */
  const summarize = (track: PathTrack) => {
    const nodes = track.nodeIds
      .map((id) => nodeById.get(id))
      .filter((n): n is PathNode => Boolean(n));
    let ready = 0;
    let minutes = 0;
    for (const n of nodes) {
      const course = n.courseId ? courseById.get(n.courseId) : undefined;
      if (!course) continue;
      ready += 1;
      minutes += course.sceneCount * MINUTES_PER_SCENE;
    }
    return { nodes, total: nodes.length, ready, planned: nodes.length - ready, minutes };
  };
  const summaries = pathData.tracks.map((t) => ({ track: t, ...summarize(t) }));
  const allTotal = summaries.reduce((a, s) => a + s.total, 0);
  const allReady = summaries.reduce((a, s) => a + s.ready, 0);
  const allMinutes = summaries.reduce((a, s) => a + s.minutes, 0);

  const extension = pathData.extensionDomain;
  const extensionCourses = (extension?.courseIds ?? [])
    .map((id) => courseById.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader localized={false} maxWidth="max-w-5xl" />
      {/* 左右留白与 /report、/skills 对齐：窄屏 px-4，sm 以上 px-6 */}
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-6 sm:px-6">
        <DomainLearningPath>
          <h1 className="text-2xl font-semibold tracking-tight">学习路径全景</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            课程按三个模块排：模块一是大模型基础，学完它之后，模块二（检索与知识工程）
            和模块三（智能体工程）可以并行走，两边互有引用。已生成的课可直接进入，
            标「规划中」的课还没有生成。已掌握的内容可以跳过。
          </p>

          {/* 路径表读到了但是空的（data/learning-path.json 缺节点）：说清是数据的问题，
              别只留一个标题让人以为页面坏了。这是终态不是加载态，所以不放骨架。 */}
          {pathData.nodes.length === 0 && (
            <div className="mt-8">
              <EmptyState
                title="路径表里还没有课程节点"
                hint="课程序列取自 data/learning-path.json 的 nodes 字段，当前为空。往里补节点后刷新本页即可。"
              />
            </div>
          )}

          {/* 三模块概览。数字口径：门数 = 模块挂的节点数；「已生成」= courseId 指向的课
              真的在盘上；时长只由已生成课的场景数算出来，规划中的课不折算时长。 */}
          {summaries.length > 0 && (
            <>
              <section className="mt-8 grid gap-4 sm:grid-cols-3">
                {summaries.map((s) => (
                  <div key={s.track.id} className="rounded-xl border border-border bg-card p-4 shadow-card">
                    <h2 className="font-semibold">{s.track.title}</h2>
                    {s.track.hint && (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.track.hint}</p>
                    )}
                    <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                      共 {s.total} 门课 · 已生成 {s.ready} 门，约 {Math.round(s.minutes / 60)} 小时
                      {s.planned > 0 && (
                        <>
                          <br />
                          其中 {s.planned} 门规划中，还没有生成
                        </>
                      )}
                    </p>
                  </div>
                ))}
              </section>
              <p className="mt-3 text-xs tabular-nums text-muted-foreground">
                主线合计 {allTotal} 门课，已生成 {allReady} 门（约 {Math.round(allMinutes / 60)} 小时），
                规划中 {allTotal - allReady} 门。
              </p>
            </>
          )}

          {/* 模块内节点流。顺序取 tracks[].nodeIds，不再按 stage 过滤后按落盘顺序排。 */}
          {summaries.map(({ track, nodes }) => {
            if (!nodes.length) return null;
            // 只取两端都在本模块内的硬依赖边；跨模块的留给卡片上的「先修：」文字
            const inTrack = new Set(nodes.map((n) => n.id));
            const edges = nodes.flatMap((n) =>
              (n.prereq ?? [])
                .filter((p) => inTrack.has(p))
                .map((p) => [p, n.id] as const),
            );
            // 拓扑分层（借管理端知识图谱同一思路：层号 = 1 + max(前置层号)）。
            // 原来的两列网格让依赖线斜穿卡片间隙，先修关系读不出来；分层后同层横排、
            // 依赖只在层间垂直向下，连线自然短而直。nodeIds 未必严格拓扑序
            // （llm-intro 有意提前），所以迭代到不动点而不是单趟。
            const layerOf = new Map<string, number>();
            for (const n of nodes) layerOf.set(n.id, 0);
            for (let pass = 0; pass < nodes.length; pass++) {
              let changed = false;
              for (const n of nodes) {
                const ps = (n.prereq ?? []).filter((p) => inTrack.has(p));
                const want = ps.length ? Math.max(...ps.map((p) => layerOf.get(p) ?? 0)) + 1 : 0;
                if (want > (layerOf.get(n.id) ?? 0)) {
                  layerOf.set(n.id, want);
                  changed = true;
                }
              }
              if (!changed) break;
            }
            const layers: PathNode[][] = [];
            for (const n of nodes) {
              const l = layerOf.get(n.id) ?? 0;
              (layers[l] ??= []).push(n);
            }
            // 层内序号 + 图节点数据（组件只管画，数据在这拼好）
            const mapNodes = layers.flatMap((layerNodes, layer) =>
              layerNodes.map((n, slot) => {
                const course = n.courseId ? courseById.get(n.courseId) : undefined;
                return {
                  id: n.id,
                  title: n.title,
                  layer,
                  slot,
                  difficulty: n.difficulty ?? 1,
                  courseId: course ? course.id : null,
                  sceneCount: course?.sceneCount,
                  audience: n.audience,
                  prereqTitles: (n.prereq ?? [])
                    .map((p) => nodeById.get(p)?.title)
                    .filter((x): x is string => Boolean(x)),
                };
              }),
            );
            return (
              <section key={track.id} className="mt-12">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="text-xl font-semibold tracking-tight">{track.title}</h2>
                  {track.hint && <span className="text-xs text-muted-foreground">{track.hint}</span>}
                </div>
                <CourseMap nodes={mapNodes} edges={edges} />
                {(() => {
                  // 学练结合：把对口课程落在本模块的实操项目挂到图下。
                  // 对口关系来自 data/practice-projects.json 的 courseIds（与首页/技能页同一真源）。
                  const trackCourseIds = new Set(
                    nodes.map((n) => n.courseId).filter((x): x is string => Boolean(x)),
                  );
                  const trackPractice = practice.filter((p) =>
                    (p.courseIds ?? []).some((id) => trackCourseIds.has(id)),
                  );
                  if (trackPractice.length === 0) return null;
                  return (
                    <div className="mt-3 rounded-xl border border-border bg-card/60 p-4">
                      <p className="text-sm font-medium">
                        学到这里可以动手
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          对口本模块课程的开源实操项目，完成标准见
                          <Link href="/skills" className="mx-1 underline underline-offset-2">
                            岗位技能页
                          </Link>
                        </span>
                      </p>
                      <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                        {trackPractice.map((p) => {
                          const anchorCourse = (p.courseIds ?? []).find((id) => trackCourseIds.has(id));
                          const anchorTitle = anchorCourse
                            ? nodes.find((n) => n.courseId === anchorCourse)?.title
                            : undefined;
                          return (
                            <li key={p.id} className="text-xs leading-relaxed text-muted-foreground">
                              {p.links?.[0]?.url ? (
                                <a
                                  href={p.links[0].url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium text-foreground underline decoration-border underline-offset-2 hover:text-primary hover:decoration-current"
                                >
                                  {p.name}
                                </a>
                              ) : (
                                <span className="font-medium text-foreground">{p.name}</span>
                              )}
                              {p.hours ? ` · ${p.hours}` : ''}
                              {anchorTitle ? `（学完「${anchorTitle}」可上手）` : ''}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}
              </section>
            );
          })}

          {/* 扩展域：不在主线里，单独一节说清它为什么在这一页上。 */}
          {extension && extensionCourses.length > 0 && (
            <section className="mt-12">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-xl font-semibold tracking-tight">{extension.title}</h2>
                {extension.hint && <span className="text-xs text-muted-foreground">{extension.hint}</span>}
              </div>
              <div className="mt-4 grid gap-6 sm:grid-cols-2">
                {extensionCourses.map((c) => (
                  <Link
                    key={c.id}
                    href={`/classroom/${c.id}`}
                    className={`group relative rounded-xl border border-border bg-card p-4 shadow-card transition duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:border-foreground/25 ${FOCUS_RING}`}
                  >
                    <h3 className="font-medium group-hover:text-primary">{c.title}</h3>
                    <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                      {c.sceneCount} 个场景 · 约 {c.sceneCount * MINUTES_PER_SCENE} 分钟
                      {c.audit ? ` · 审核 ${c.audit.claims} 条断言` : ''}
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {pathData.plannedDirections?.length ? (
            <p className="mt-12 text-xs leading-relaxed text-muted-foreground">
              {pathData.plannedDirections.map((d) => `${d.title}（${d.status}）`).join(' · ')}
              ，语料建成后上线。
            </p>
          ) : null}
        </DomainLearningPath>
      </main>
    </div>
  );
}
