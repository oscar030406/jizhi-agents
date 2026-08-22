/**
 * 每门课属于哪个知识域——**现读磁盘算出来**，不再靠手跑脚本落一份 json。
 *
 * 以前这份归属在 `data/course-domains.json`，由 `scripts/build-course-domains.mjs` 生成：
 * 新建一门课、接一个新库，都得有人记得回来重跑一次脚本，忘了首页的域课程卡就少一门课。
 * 这正是「工程师替系统干活」的那一段，所以搬到运行时。
 *
 * ## 判定规则（优先级从高到低）
 *
 * 1. **学习路径里的课一律判 `ai`**，覆盖后面所有依据。这条是从原脚本原样搬过来的：
 *    `learning-path.json` 是 AI 领域专属的教研产物，路径上挂的就是 AI 课。具身语料以
 *    `embodied_docs/` 并进了主索引，AI 课引用 `em` 块是正常现象（「大模型上下文与 KV 缓存」
 *    大量引具身文档，但它是路径内的 AI 课），按引用计数会误判成 embodied。
 * 2. **课程自己记的 `generation.profile.corpus`**。生成时选了哪个库就是哪个域，
 *    这是最直接的证据——新库生成的课不用任何前缀规则就能归对位。
 * 3. **引用的 source_id 前缀多数域**。存量课（2026 年上半年那批）没有 `generation` 字段，
 *    只能从引用里反推。前缀表与原脚本一致。
 * 4. 都没有（纯 slide 老课，零引用）→ `ai`。
 *
 * 实测：43 个课程文件上，本函数的结果与 `build-course-domains.mjs` 的产物逐门一致。
 */

import { promises as fs } from 'node:fs';

import {
  CLASSROOMS_DIR,
  collectSourceIds,
  isValidClassroomId,
  readClassroom,
  type PersistedClassroomData,
} from '@/lib/server/classroom-storage';

/** 首页域课程卡要的两个字段。与它原先从 json 读到的形状一致。 */
export interface CourseDomain {
  domain: string;
  title: string;
}

/** source_id 前缀 → 域。前缀表与 `scripts/build-course-domains.mjs` 同一份。 */
function domainOfSourceId(sid: string): string {
  if (/^em\d/.test(sid)) return 'embodied';
  if (/^(table|sql|ainode|iotdb|timecho|deployment-and-maintenance|user-manual)/.test(sid))
    return 'iotdb';
  if (/^(content|applications|administration|developer)/.test(sid)) return 'odoo';
  return 'ai';
}

/** 路径上挂着的课程 id。路径表读不到就是空集合——那时规则 1 自然不生效。 */
async function pathCourseIds(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(`${process.cwd()}/data/learning-path.json`, 'utf-8');
    const nodes = (JSON.parse(raw) as { nodes?: Array<{ courseId?: string }> }).nodes ?? [];
    return new Set(nodes.map((n) => n.courseId).filter((id): id is string => Boolean(id)));
  } catch {
    return new Set();
  }
}

/**
 * 一门课的域归属。上面那四条规则就写在这一个表达式里，导出是为了能单测——
 * 盘上现有的课覆盖不全（没有「不在路径上又显式选了非 ai 库」的课）。
 *
 * `onPath` = 这门课挂在学习路径上。
 */
export function courseDomainOf(
  data: Pick<PersistedClassroomData, 'scenes' | 'generation'>,
  onPath: boolean,
): string {
  if (onPath) return 'ai';
  return (
    data.generation?.profile?.corpus?.trim() ||
    majorityDomain(collectSourceIds(data.scenes)) ||
    'ai'
  );
}

/** 引用的 source_id 里占多数的那个域。零引用返回 null。 */
function majorityDomain(sourceIds: Set<string>): string | null {
  const counts = new Map<string, number>();
  for (const sid of sourceIds) {
    const d = domainOfSourceId(sid.split('#')[0]);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [d, n] of counts) if (n > bestN) [best, bestN] = [d, n];
  return best;
}

/**
 * 全部课程的域归属：课程 id → { domain, title }。
 *
 * 单个课文件读坏了跳过它，不让整张表消失（与 `listClassrooms()` 同款纪律）。
 * 课程目录不存在时返回空对象，调用方据此出空态。
 */
export async function readCourseDomains(): Promise<Record<string, CourseDomain>> {
  let files: string[];
  try {
    files = (await fs.readdir(CLASSROOMS_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return {};
  }

  const onPath = await pathCourseIds();
  const rows = await Promise.all(
    files.map(async (file) => {
      const id = file.replace(/\.json$/, '');
      if (!isValidClassroomId(id)) return null;
      const data = await readClassroom(id).catch(() => null);
      if (!data?.stage || !Array.isArray(data.scenes)) return null;

      const domain = courseDomainOf(data, onPath.has(id));
      return [id, { domain, title: data.stage.name ?? id }] as const;
    }),
  );

  return Object.fromEntries(rows.filter((r): r is NonNullable<typeof r> => r !== null));
}
