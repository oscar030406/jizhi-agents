/**
 * Job-skill map proxy (/skills page data source).
 *
 * Forwards to the multi-agent engine's `skill-map` endpoint, which assembles
 * three real assets and nothing else: the job/skill inventory and recruitment
 * statistics in `data/jobs/job_skill_map.json`, the controlled knowledge base
 * (skill coverage = a retrieval hit with a source id), and the on-disk state of
 * each domain corpus. No numbers are computed here.
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
}

// 最后一次成功数据的进程内兜底：引擎重启/部署窗口期不给访客看"离线"空白。
// 这不是缓存造假——是真数据+获取时间，引擎恢复后下一次请求即刷新。
let lastGood: { data: SkillMapPayload; fetchedAt: string } | null = null;

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

export async function GET() {
  const base = process.env.GROUNDING_URL;
  if (!base) return new Response(null, { status: 204 });
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/skill-map`, {
      headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
      // 引擎那侧整表算一次要 ~38 秒（14 岗 150 项技能逐条检索，带嵌入调用），
      // 之后有 lru_cache、后续请求 3 毫秒。15 秒的旧超时刚好卡在中间：客户端放弃了，
      // 引擎却仍把这一轮算完并填了缓存——白等一次还拿不到数。抬过冷启动耗时，
      // 首次请求就能拿到实时数据。页面本来就先渲染静态快照再替换，等的这段不挡人。
      signal: AbortSignal.timeout(60000),
      cache: 'no-store',
    });
    if (!resp.ok) {
      if (lastGood) return apiSuccess({ ...(await filterCorpora(lastGood.data)), stale_from: lastGood.fetchedAt } as unknown as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    const payload = (await resp.json()) as { data?: SkillMapPayload };
    if (!payload.data?.jobs?.length) return new Response(null, { status: 204 });
    lastGood = { data: payload.data, fetchedAt: new Date().toISOString() };
    log.info(
      `Skill map: ${payload.data.jobs.length} jobs, ` +
        `${payload.data.corpora.filter((c) => c.available).length}/${payload.data.corpora.length} corpora built`,
    );
    return apiSuccess((await filterCorpora(payload.data)) as unknown as Record<string, unknown>);
  } catch (err) {
    log.warn(`Skill map unavailable: ${String(err)}`);
    if (lastGood) return apiSuccess({ ...(await filterCorpora(lastGood.data)), stale_from: lastGood.fetchedAt } as unknown as Record<string, unknown>);
    return new Response(null, { status: 204 });
  }
}
