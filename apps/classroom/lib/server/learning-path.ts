/**
 * 人工智能应用开发（主库 `ai`）学习路径的服务端读取口。
 *
 * 真源是 `data/learning-path.json`，也就是**数据目录**里的那一份（`CLASSROOMS_DIR` 的同级）。
 * 线上新课生成完之后，那份文件会被直接更新，不发版；所以每一次请求都现读磁盘，
 * 读不到才退回打包进来的那份（本地 clone、刚起的新机器）。
 * 本地开发时两者是同一个文件，行为一致。
 *
 * 阶次不再问引擎的拓扑分层。引擎那条路排出来的第一阶是「企业级 AI Agent 开发实战」、
 * 第四阶空着，21 门课因为反推不出概念被甩进「未归入路径」——它算的是概念图，
 * 不是教学顺序。教学顺序是人排的，就写在这份 JSON 的 `stages[].nodeIds` 里。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { corpusOwnership } from '@/lib/accounts/org-store';
import bundledPath from '@/data/learning-path.json';
import { pickPrimaryConcept } from '@/lib/evidence/scene-concepts';
import sceneConceptTable from '@/lib/evidence/data/scene-concepts.json';
import { CLASSROOMS_DIR, listClassrooms, readClassroom } from '@/lib/server/classroom-storage';
import type { ClassroomSummary } from '@/lib/server/classroom-storage';
import { canReadCourse, courseReaderForSession } from '@/lib/server/course-access';
import { readCourseDomains } from '@/lib/server/course-domains';

/** 这份路径描述的是哪个库。课程墙、`/api/course-path/ai`、岗位技能页共用。 */
export const CURATED_CORPUS = 'ai';

export type PathNodeStatus = 'live' | 'planned' | 'blocked';

export interface PathNode {
  id: string;
  stage: string;
  title: string;
  status: PathNodeStatus;
  courseId?: string | null;
  /** 同题重复生成的课，课程墙折叠到主课下。 */
  altCourseIds?: string[];
  /** 生成过但没过审核门禁的那一版。**不外发**，只用来判定这个节点在重生成。 */
  blockedCourseId?: string;
  difficulty?: number;
  prereq?: string[];
  requirement?: string;
  textbookRef?: string;
}

export interface PathStage {
  id: string;
  title: string;
  goal: string;
  link: string;
  nodeIds: string[];
}

export interface LearningPath {
  version?: string;
  stages: PathStage[];
  nodes: PathNode[];
  jobSkillCourses: {
    job_id: string;
    title: string;
    skills: Record<string, string[]>;
  };
}

/** 数据目录里的那一份。线上由另一条链在新课生成后覆盖，不随发版走。 */
export const LEARNING_PATH_FILE = path.join(path.dirname(CLASSROOMS_DIR), 'learning-path.json');

const FALLBACK = bundledPath as unknown as LearningPath;

/**
 * 现读磁盘上的学习路径。文件缺失或读坏了退回打包的那份——
 * 首页少一整面墙比晚几分钟看到新课更难解释。
 */
export async function readLearningPath(): Promise<LearningPath> {
  try {
    const raw = await fs.readFile(LEARNING_PATH_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as LearningPath;
    if (parsed?.stages?.length && parsed?.nodes?.length) return parsed;
  } catch {
    /* 数据目录里没有这份文件：用打包进来的那份 */
  }
  return FALLBACK;
}

/** 路径上出现过的全部课程 id（主课、同题课、被门禁挡下那一版）。 */
export function pathCourseIds(data: LearningPath): Set<string> {
  const ids = new Set<string>();
  for (const node of data.nodes ?? []) {
    if (node.courseId) ids.add(node.courseId);
    for (const alt of node.altCourseIds ?? []) ids.add(alt);
    if (node.blockedCourseId) ids.add(node.blockedCourseId);
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// 课程墙
// ─────────────────────────────────────────────────────────────────────────────

/** 事后反推表：新课在生成时就把概念写进场景，老课只有这张表。两条都用。 */
const DERIVED: Record<string, { votes?: Record<string, number> }> =
  (sceneConceptTable as { scenes?: Record<string, { votes?: Record<string, number> }> }).scenes ??
  {};

/** 一门课的主概念：全部场景的概念票相加取最高，并列按码点定序（同 pickPrimaryConcept）。 */
function primaryConcept(scenes: ReadonlyArray<Record<string, unknown>>): string | null {
  const votes: Record<string, number> = {};
  for (const scene of scenes) {
    const own = (scene.concepts as { votes?: Record<string, number> } | undefined)?.votes;
    const table = DERIVED[String(scene.id ?? '')]?.votes;
    for (const [name, n] of Object.entries(own ?? table ?? {})) {
      votes[name] = (votes[name] ?? 0) + n;
    }
  }
  return pickPrimaryConcept(votes);
}

/** 课程墙上的一个节点。live 出课卡，planned / blocked 出一张不可点的占位卡。 */
export interface WallNode {
  id: string;
  title: string;
  /** restricted = 课在盘上、已放行，但只对所属机构可见（管理者人工复核放行的课都是这样） */
  status: PathNodeStatus | 'restricted';
  /** live 才有；planned / blocked 一律 null（被门禁挡下那一版不外发）。 */
  courseId: string | null;
  altCourseIds: string[];
}

export interface WallStage {
  index: number;
  id: string;
  title: string;
  goal: string;
  link: string;
  /** 阶内展示顺序的唯一真源，直接照 `stages[].nodeIds` 摆。 */
  nodes: WallNode[];
  courseIds: string[];
  plannedTitles: string[];
  blockedTitles: string[];
  /** 已放行但只对所属机构可见的课（访客看不到内容，只看到有这么一门） */
  restrictedTitles: string[];
}

export interface CuratedPath {
  corpus: string;
  source: 'curated';
  version: string | null;
  stages: WallStage[];
  /** 本库里没被任何节点收走的已发布课。**照样上墙**，不藏。 */
  ungroupedCourseIds: string[];
  /** courseId → 主概念 + 生成期画像摘要（首页「画像改变了什么」用）。 */
  courses: Record<string, { concept: string | null; tier?: string; profileFields?: string[] }>;
}

/**
 * 课程墙的服务端产物：当前会话看得见的已发布课 + 按人工阶次摆好的路径。
 *
 * 课的可见性判据与 `/api/classroom` 完全一致（机构隔离 + 定向指派），
 * 看不见的课不进任何一阶，也不进「未归入路径」。
 */
export async function readCuratedWall(sessionToken?: string): Promise<{
  classrooms: ClassroomSummary[];
  path: CuratedPath;
}> {
  const [learningPath, domains, summaries, ownership, reader] = await Promise.all([
    readLearningPath(),
    readCourseDomains(),
    listClassrooms({ learnerReleasedOnly: true }),
    corpusOwnership(),
    courseReaderForSession(sessionToken),
  ]);

  const classrooms: ClassroomSummary[] = [];
  const courses: CuratedPath['courses'] = {};
  const visibleInCorpus = new Set<string>();

  for (const summary of summaries) {
    const classroom = await readClassroom(summary.id).catch(() => null);
    if (!classroom || !canReadCourse(summary.id, classroom, reader, ownership)) continue;
    classrooms.push(summary);
    if (domains[summary.id]?.domain !== CURATED_CORPUS) continue;
    visibleInCorpus.add(summary.id);
    const meta = classroom.generation;
    courses[summary.id] = {
      concept: primaryConcept(
        (classroom.scenes ?? []) as unknown as Array<Record<string, unknown>>,
      ),
      ...(meta?.presentationTier ? { tier: meta.presentationTier } : {}),
      // domain/corpus 是取材范围不是画像自评，摘要里不算一项。
      ...(meta?.profile
        ? {
            profileFields: Object.entries(meta.profile)
              .filter(([k, v]) => k !== 'domain' && k !== 'corpus' && v !== undefined)
              .map(([k]) => k),
          }
        : {}),
    };
  }

  const nodeById = new Map((learningPath.nodes ?? []).map((n) => [n.id, n]));
  // 盘上有、本会话看不见的 live 课：先查一遍，map 里就不用 await
  const restricted = new Set<string>();
  for (const node of learningPath.nodes ?? []) {
    if (node.status !== 'live' || !node.courseId || visibleInCorpus.has(node.courseId)) continue;
    const onDisk = await readClassroom(node.courseId).catch(() => null);
    if (onDisk) restricted.add(node.courseId);
  }
  const claimed = new Set<string>();
  const stages: WallStage[] = (learningPath.stages ?? []).map((stage, i) => {
    const nodes: WallNode[] = [];
    for (const nodeId of stage.nodeIds ?? []) {
      const node = nodeById.get(nodeId);
      if (!node) continue;
      if (node.status === 'live' && node.courseId) {
        // 这门课这个会话看不见：课在盘上就说「机构内课」（管理者复核放行的课只对本机构
        // 开放，访客换演示账号能看），盘上都没有才整个节点不出。不退化成「规划中」——
        // 那会把一门真有的课说成还没做。
        if (!visibleInCorpus.has(node.courseId)) {
          if (restricted.has(node.courseId)) {
            nodes.push({ id: node.id, title: node.title, status: 'restricted', courseId: null, altCourseIds: [] });
          }
          continue;
        }
        const alts = (node.altCourseIds ?? []).filter((id) => visibleInCorpus.has(id));
        claimed.add(node.courseId);
        for (const alt of alts) claimed.add(alt);
        nodes.push({
          id: node.id,
          title: node.title,
          status: 'live',
          courseId: node.courseId,
          altCourseIds: alts,
        });
        continue;
      }
      nodes.push({
        id: node.id,
        title: node.title,
        status: node.status === 'blocked' ? 'blocked' : 'planned',
        courseId: null,
        altCourseIds: [],
      });
    }
    return {
      index: i + 1,
      id: stage.id,
      title: stage.title,
      goal: stage.goal,
      link: stage.link,
      nodes,
      courseIds: nodes.flatMap((n) => (n.courseId ? [n.courseId, ...n.altCourseIds] : [])),
      plannedTitles: nodes.filter((n) => n.status === 'planned').map((n) => n.title),
      blockedTitles: nodes.filter((n) => n.status === 'blocked').map((n) => n.title),
      restrictedTitles: nodes.filter((n) => n.status === 'restricted').map((n) => n.title),
    };
  });

  return {
    classrooms,
    path: {
      corpus: CURATED_CORPUS,
      source: 'curated',
      version: learningPath.version ?? null,
      stages,
      ungroupedCourseIds: [...visibleInCorpus].filter((id) => !claimed.has(id)),
      courses,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 岗位技能 ×「已有课」
// ─────────────────────────────────────────────────────────────────────────────

/** `data/skill-map-ai.json` 快照里，某一岗每项技能有没有受控语料可接地。 */
export function skillCoverageOf(
  snapshot: {
    jobs?: Array<{ job_id?: string; skills?: Array<{ skill?: string; covered?: boolean }> }>;
  },
  jobId = 'agent_engineer',
): Map<string, boolean> {
  const job = (snapshot.jobs ?? []).find((j) => j.job_id === jobId);
  return new Map(
    (job?.skills ?? [])
      .filter((s): s is { skill: string; covered?: boolean } => Boolean(s.skill))
      .map((s) => [s.skill, Boolean(s.covered)]),
  );
}

export interface JobSkillRow {
  skill: string;
  /** 快照里这项技能有没有受控语料可接地。快照里没有这项技能时是 null。 */
  covered: boolean | null;
  courses: Array<{ title: string; courseId: string | null }>;
}

/**
 * 「AI Agent 开发工程师」13 项技能各自对应哪些节点，以及那些节点有没有成课。
 * 技能顺序照 `jobSkillCourses.skills` 的书写顺序，不按覆盖率重排。
 */
export function jobSkillRows(
  data: LearningPath,
  coverage: ReadonlyMap<string, boolean> = new Map(),
): JobSkillRow[] {
  const nodeById = new Map((data.nodes ?? []).map((n) => [n.id, n]));
  return Object.entries(data.jobSkillCourses?.skills ?? {}).map(([skill, nodeIds]) => ({
    skill,
    covered: coverage.has(skill) ? coverage.get(skill)! : null,
    courses: nodeIds.flatMap((id) => {
      const node = nodeById.get(id);
      if (!node) return [];
      return [
        {
          title: node.title,
          courseId: node.status === 'live' && node.courseId ? node.courseId : null,
        },
      ];
    }),
  }));
}
