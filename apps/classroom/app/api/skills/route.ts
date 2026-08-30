/**
 * Job-skill map proxy (/skills page data source).
 *
 * Forwards to the multi-agent engine's `skill-map` endpoint, which assembles
 * three real assets and nothing else: the job/skill inventory and recruitment
 * statistics in `data/jobs/job_skill_map.json`, the controlled knowledge base
 * (skill coverage = a retrieval hit with a source id), and the on-disk state of
 * each domain corpus. No numbers are computed here.
 *
 * `?domain=`（或 `?corpus=`）透传给引擎：图谱是分域的，没登记岗位数据的领域拿回
 * `jobs: []` 加一句 `reason`，这条路把它原样带出去，不改成主域数据也不当失败吞掉。
 *
 * Degrades to 204 when the engine is unreachable. `/skills` doesn't wait on this
 * route at all: it renders `public/skill-map.json` (the pre-computed snapshot)
 * first and only swaps in this route's answer when it arrives, so an offline
 * engine costs freshness, never the page.
 */

import { createLogger } from '@/lib/logger';
import { apiSuccess } from '@/lib/server/api-response';

const log = createLogger('Skill Map');

// 这条路由必须每次都真去问引擎。`fetch` 上的 `cache: 'no-store'` 只管住了对引擎那一跳，
// 管不住 Next 对**路由处理器自身**的缓存——2026-08-19 实测：引擎侧把语料名单从 10 个
// 收敛到 6 个并重启后，直连引擎拿到 6 个，同一时刻走这条代理仍是 10 个，就是这里缓存的
// 旧响应。语料名单随接入流水线变化，缓存住等于对外报一份过期的库清单。
export const dynamic = 'force-dynamic';

export interface SkillCoverage {
  skill: string;
  covered: boolean;
  score: number;
  source_id: string;
  source_title: string;
}

export interface JobSkills {
  job_id: string;
  title: string;
  summary: string;
  core_concepts: string[];
  skills: SkillCoverage[];
  covered_count: number;
}

export interface CorpusStatus {
  corpus: string;
  available: boolean;
  chunk_count: number;
  index_path: string;
}

export interface SkillMapPayload {
  provenance: Record<string, unknown>;
  market_stats: Record<string, unknown>;
  jobs: JobSkills[];
  corpora: CorpusStatus[];
  coverage_rule: string;
  /** 这份图谱属于哪个领域（引擎按请求的 domain 回带）。 */
  domain?: string;
  /** 该领域没有岗位数据时引擎给的原文说明。jobs 为空 + 有 reason 是答案，不是失败。 */
  reason?: string;
}

// 最后一次成功数据的进程内兜底：引擎重启/部署窗口期不给访客看"离线"空白。
// 这不是缓存造假——是真数据+获取时间，引擎恢复后下一次请求即刷新。
// **按域分桶**：图谱随域不同，共用一个槽位会把 A 域的岗位当成 B 域的兜底答案回出去。
const lastGood = new Map<string, { data: SkillMapPayload; fetchedAt: string }>();
// 上限：`domain` 直接来自 query，写什么引擎都会正常应答（jobs 空 + reason），于是每个
// 没见过的 `?domain=` 都在进程里留一份，长到多大只取决于访客敲了多少种拼法。盘上的库是
// 个位数，超过就整桶丢——重建的代价只是那一批域下一次请求拿不到兜底数据。
const LAST_GOOD_MAX = 16;

async function filterCorpora(data: SkillMapPayload): Promise<SkillMapPayload> {
  // 机构可见性（2026-08-30）：画像下拉的库名单从这里出，归属库只给本机构成员。
  try {
    const { cookies } = await import('next/headers');
    const { accountForSession } = await import('@/lib/accounts/store');
    const { SESSION_COOKIE } = await import('@/lib/accounts/session');
    const { corpusVisibilityFor } = await import('@/lib/accounts/org-store');
    const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
    const visible = await corpusVisibilityFor(account?.id ?? null);
    return { ...data, corpora: data.corpora.filter((c) => visible(c.corpus)) };
  } catch {
    return data; // 会话层异常时按公共视图放行——公共库本就人人可见
  }
}

export async function GET(request: Request) {
  const base = process.env.GROUNDING_URL;
  if (!base) return new Response(null, { status: 204 });
  // 问的是哪个域，就原样带给引擎。不带 = 永远拿主域岗位回来，学习端再怎么判也只能
  // 在浏览器里"假装"外域为空——诚实必须由数据源给出，不能由页面事后遮。
  const params = new URL(request.url).searchParams;
  const domain = (params.get('domain') ?? params.get('corpus') ?? '').trim();
  const query = domain ? `?domain=${encodeURIComponent(domain)}` : '';
  const cached = lastGood.get(domain);
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/skill-map${query}`, {
      headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
      // 引擎那侧整表算一次要 ~38 秒（14 岗 150 项技能逐条检索，带嵌入调用），
      // 之后有 lru_cache、后续请求 3 毫秒。15 秒的旧超时刚好卡在中间：客户端放弃了，
      // 引擎却仍把这一轮算完并填了缓存——白等一次还拿不到数。抬过冷启动耗时，
      // 首次请求就能拿到实时数据。页面本来就先渲染静态快照再替换，等的这段不挡人。
      signal: AbortSignal.timeout(60000),
      cache: 'no-store',
    });
    if (!resp.ok) {
      if (cached) return apiSuccess({ ...(await filterCorpora(cached.data)), stale_from: cached.fetchedAt } as unknown as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    const data = (await resp.json() as { data?: SkillMapPayload }).data;
    // jobs 为空但带 reason 的，是引擎在明说"这个域没登记岗位数据"——那是答案。
    // 当 204 吞掉，页面就退回主域快照，等于拿 AI 岗位冒充别的领域。
    if (!data || (!data.jobs?.length && !data.reason)) return new Response(null, { status: 204 });
    // 已有的域刷新自己那一格，不算新增，不该因为满了就把大家一起清掉
    if (!lastGood.has(domain) && lastGood.size >= LAST_GOOD_MAX) lastGood.clear();
    lastGood.set(domain, { data, fetchedAt: new Date().toISOString() });
    log.info(
      `Skill map${domain ? ` (${domain})` : ''}: ${data.jobs?.length ?? 0} jobs, ` +
        `${data.corpora.filter((c) => c.available).length}/${data.corpora.length} corpora built` +
        `${data.reason ? ` — ${data.reason}` : ''}`,
    );
    return apiSuccess((await filterCorpora(data)) as unknown as Record<string, unknown>);
  } catch (err) {
    log.warn(`Skill map unavailable: ${String(err)}`);
    if (cached) return apiSuccess({ ...(await filterCorpora(cached.data)), stale_from: cached.fetchedAt } as unknown as Record<string, unknown>);
    return new Response(null, { status: 204 });
  }
}
