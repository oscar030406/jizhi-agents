/**
 * 每门课属于哪个知识域——**现读磁盘算出来**，不再靠手跑脚本落一份 json。
 *
 * 以前这份归属由构建期脚本生成静态 JSON：
 * 新建一门课、接一个新库，都得有人记得回来重跑一次脚本，忘了首页的域课程卡就少一门课。
 * 这正是「工程师替系统干活」的那一段，所以搬到运行时。
 *
 * ## 判定规则（优先级从高到低）
 *
 * 1. **课程自己记的出身**（`stage.origin.corpus` / `generation.profile.corpus`）。
 *    生成时选了哪个库就是哪个域，这是最直接的证据。
 * 1.5 **人工学习路径收了它**（`data/learning-path.json` 的 courseId / altCourseIds /
 *    blockedCourseId）。教研把这门课排进 AI 主线，就是一条比前缀投票强的人工判据。
 * 2. **引用的 source_id 前缀多数域**。存量课（2026 上半年那批）没有出身记录，
 *    只能从引用里反推。前缀表是手工维护的 AI 域清单，对投币新建的库必然反推错。
 * 3. 都没有 → `unknown`。**不冒充主域。**
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
 *
 * ## 2026-09-04：路径判据以规则 1.5 的形式回来了
 *
 * 上面那次改动把「路径上的课判 ai」整条删掉，代价在课程墙上显出来了：36 门公开课里
 * 21 门（Python 两门、线代、导数、概率、神经网络、梯度下降那一批）既没有出身记录，
 * source_id 前缀也不在手工表里，全被判成 `unknown`，于是 AI 课程墙上一门都不显示。
 *
 * 所以路径判据回来，但**位置不同**：排在课程自己记的出身之后。它现在只做它本来该做的事
 * ——纠正前缀投票的空档，不再改写课程写下的出身。`c3HH74qwAH` / `sVnMPbeeXn`
 * 那种「自己记着别的库又挂在路径上」的课，仍然按自己记的出身走。
 */

/** 判不出来。**不冒充主域**——冒充会让一门来路不明的课混进主域课程卡。 */
export const UNKNOWN_DOMAIN = 'unknown';
/** 出身记的库已经不在注册清单里（库被删了）。课还在，出处已经没了。 */
export const RETIRED_DOMAIN = 'retired';
/** 人工学习路径描述的库。规则 1.5 命中时判给它。 */
export const CURATED_PATH_DOMAIN = 'ai';

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

/** 存量课程 source_id 前缀 → 域。新课程以自身 origin 为强证据。 */
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

/**
 * 一门课的域归属。上面三条规则就写在这一个表达式里，导出是为了能单测——
 * 盘上现有的课覆盖不全（没有「不在路径上又显式选了非 ai 库」的课）。
 */
export function courseDomainOf(
  data: Pick<PersistedClassroomData, 'scenes' | 'generation'> & {
    id?: string;
    stage?: { origin?: { corpus?: string; domain?: string } };
  },
  /**
   * 现存的库名集合（注册清单）。传了才判得出 `retired`；不传就跳过这一判，
   * 不假装库都还在——判不了就别判，这与 `unknown` 是同一条纪律。
   */
  liveCorpora?: ReadonlySet<string>,
  /**
   * 人工学习路径收了哪些课（`lib/server/learning-path.ts` 的 `pathCourseIds`）。
   * 不传就跳过规则 1.5。
   */
  pathCourseIds?: ReadonlySet<string>,
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
  // ①.5 人工路径收了它。只在课程没写下自己的出身时才轮到这一条。
  if (data.id && pathCourseIds?.has(data.id)) return CURATED_PATH_DOMAIN;
  // ② 前缀投票。认不出的前缀不投票，全认不出就当没有信号。
  // ③ 什么都没有 → unknown，不冒充主域。
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

  // 现存库名。清单读不到就返回空视图——那时 `liveCorpora` 传 undefined，
  // 跳过 retired 判定，而不是把所有课都判成 retired。
  const { readDomainRegistry } = await import('@/lib/server/domain-registry');
  const registry = await readDomainRegistry().catch(() => null);
  const liveCorpora = registry ? new Set(Object.keys(registry.entries)) : undefined;
  // 动态导入：learning-path.ts 反过来要用 readCourseDomains，静态互引会成环。
  const { readLearningPath, pathCourseIds } = await import('@/lib/server/learning-path');
  const onPath = await readLearningPath()
    .then(pathCourseIds)
    .catch(() => undefined);
  const rows = await Promise.all(
    files.map(async (file) => {
      const id = file.replace(/\.json$/, '');
      if (!isValidClassroomId(id)) return null;
      const data = await readClassroom(id).catch(() => null);
      if (!data?.stage || !Array.isArray(data.scenes)) return null;

      const domain = courseDomainOf({ ...data, id }, liveCorpora, onPath);
      return [id, { domain, title: data.stage.name ?? id }] as const;
    }),
  );

  return Object.fromEntries(rows.filter((r): r is NonNullable<typeof r> => r !== null));
}
