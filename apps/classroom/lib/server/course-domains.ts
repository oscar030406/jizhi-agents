/**
 * 每门课属于哪个知识域——**现读磁盘算出来**，不再靠手跑脚本落一份 json。
 *
 * 以前这份归属在 `data/course-domains.json`，由 `scripts/build-course-domains.mjs` 生成：
 * 新建一门课、接一个新库，都得有人记得回来重跑一次脚本，忘了首页的域课程卡就少一门课。
 * 这正是「工程师替系统干活」的那一段，所以搬到运行时。
 *
 * ## 判定规则（优先级从高到低）
 *
 * 1. **课程自己记的出身**（`stage.origin.corpus` / `generation.profile.corpus`）。
 *    生成时选了哪个库就是哪个域，这是最直接的证据。
 * 2. **学习路径里的课判 `ai`**——但**只压得过下面那条弱信号，压不过第 1 条**。
 *    `learning-path.json` 是 AI 领域专属的教研产物；它存在的理由只是纠正前缀投票：
 *    具身语料并进了主索引，AI 课引用 `em` 块是正常现象（「大模型上下文与 KV 缓存」
 *    大量引具身文档），按引用计数会误判成 embodied。
 * 3. **引用的 source_id 前缀多数域**。存量课（2026 上半年那批）没有出身记录，
 *    只能从引用里反推。前缀表是手工维护的 AI 域清单，对投币新建的库必然反推错。
 * 4. 都没有 → `unknown`。**不冒充主域。**
 *
 * 另有一条与上面正交：出身记的库**已经不在注册清单里**（库被删了）→ `retired`。
 *
 * ## 这里改过一次，原因值得留着
 *
 * 原来规则 1 是「路径上的课一律判 ai，覆盖后面所有依据」，规则 4 是「都没有 → ai」。
 * 2026-08-23 垃圾域清理时撞出口径打架：`c3HH74qwAH` 自己记着 `rag-adv`、
 * `sVnMPbeeXn` 自己记着 `vecdb`，但两门都挂在学习路径上，于是被规则 1 碾成 `ai`——
 * **课堂侧的域视图与课程自身的出处记录给出两个答案**。
 *
 * 根因不是「查不到就回退」，是**弱信号的纠偏规则压过了强信号**。所以规则 1 降到
 * 第 2 位：它本来就只为纠正前缀投票而存在，没有理由去改写课程自己写下的出身。
 *
 * 规则 4 的 `ai` 是另一种形态的同一个病——查不到就冒充主域。实测盘上 41 门课
 * **没有一门**走到这条兜底（30 门在路径上、5 门有出身记录、6 门靠前缀投票），
 * 所以改成 `unknown` 对现有数据零影响：它拦的是将来那门「什么都没有」的课。
 */

/** 判不出来。**不冒充主域**——冒充会让一门来路不明的课混进主域课程卡。 */
export const UNKNOWN_DOMAIN = 'unknown';
/** 出身记的库已经不在注册清单里（库被删了）。课还在，出处已经没了。 */
export const RETIRED_DOMAIN = 'retired';

/**
 * 学习路径数据（data/learning-path.json）所属的域。路径表目前是单文件、只为主域
 * 策展——「挂在路径上」这条归域规则因此只在这个域内成立。给第二个域建路径时，
 * 路径表必须先按域组织，这个常量随之变成查表；在那之前把假设写在这里，
 * 不散进判断逻辑（2026-08-28 清查 M7：曾内联 'ai'）。
 */
export const PATH_HOME_DOMAIN = 'ai';

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

/** source_id 前缀 → 域。真源 data/domain-prefixes.json（build-course-domains.mjs 读同一份）。 */
import prefixTable from '@/data/domain-prefixes.json';

const PREFIX_RULES: Array<{ re: RegExp; domain: string }> = prefixTable.rules.map((r) => ({
  re: new RegExp(r.pattern),
  domain: r.domain,
}));

function domainOfSourceId(sid: string): string | null {
  for (const rule of PREFIX_RULES) if (rule.re.test(sid)) return rule.domain;
  // 认不出的前缀**不投 ai 一票**。这张表是手工维护的，新建库的前缀一律不在表里——
  // 让它们默认投给主域，等于每建一个新库就往 ai 里掺一批不属于它的课。
  return null;
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
  data: Pick<PersistedClassroomData, 'scenes' | 'generation'> & {
    stage?: { origin?: { corpus?: string; domain?: string } };
  },
  onPath: boolean,
  /**
   * 现存的库名集合（注册清单）。传了才判得出 `retired`；不传就跳过这一判，
   * 不假装库都还在——判不了就别判，这与 `unknown` 是同一条纪律。
   */
  liveCorpora?: ReadonlySet<string>,
): string {
  // ① 课自己记的出身。客户端生成的课只有 `stage.origin` 这一条：
  //    它不走服务端 `generation` 那份记录。
  const own =
    data.stage?.origin?.corpus?.trim() ||
    data.stage?.origin?.domain?.trim() ||
    data.generation?.profile?.corpus?.trim() ||
    '';
  if (own) {
    // 库被删了就如实说「出处没了」，不退回主域冒充。
    return liveCorpora && !liveCorpora.has(own) ? RETIRED_DOMAIN : own;
  }
  // ② 路径上的课判路径所属域。**只压前缀投票**——它存在的理由就是纠正投票误判，
  //    没有理由去改写课程自己写下的出身（那条已经在上面返回了）。
  if (onPath) return PATH_HOME_DOMAIN;
  // ③ 前缀投票。认不出的前缀不投票，全认不出就当没有信号。
  // ④ 什么都没有 → unknown，不冒充主域。
  return majorityDomain(collectSourceIds(data.scenes)) ?? UNKNOWN_DOMAIN;
}

/** 引用的 source_id 里占多数的那个域。零引用返回 null。 */
function majorityDomain(sourceIds: Set<string>): string | null {
  const counts = new Map<string, number>();
  for (const sid of sourceIds) {
    const d = domainOfSourceId(sid.split('#')[0]);
    if (!d) continue; // 认不出的前缀弃权，不投给主域
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
  // 现存库名。清单读不到就返回空视图——那时 `liveCorpora` 传 undefined，
  // 跳过 retired 判定，而不是把所有课都判成 retired。
  const { readDomainRegistry } = await import('@/lib/server/domain-registry');
  const registry = await readDomainRegistry().catch(() => null);
  const liveCorpora = registry ? new Set(Object.keys(registry.entries)) : undefined;
  const rows = await Promise.all(
    files.map(async (file) => {
      const id = file.replace(/\.json$/, '');
      if (!isValidClassroomId(id)) return null;
      const data = await readClassroom(id).catch(() => null);
      if (!data?.stage || !Array.isArray(data.scenes)) return null;

      const domain = courseDomainOf(data, onPath.has(id), liveCorpora);
      return [id, { domain, title: data.stage.name ?? id }] as const;
    }),
  );

  return Object.fromEntries(rows.filter((r): r is NonNullable<typeof r> => r !== null));
}
