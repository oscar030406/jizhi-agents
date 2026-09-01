/**
 * 域级学习路径：学习端读引擎按前置图排出来的阶段。
 *
 * **要过机构可见性闸**。路径里是这个库的概念名与教材出处——归属某个机构的私有教材，
 * 目录结构本身就是它不愿外传的东西。学习端的取数口此前只有两个（/api/domains、
 * /api/skills）都做了过滤，这是第三个；隔离轴要列全，漏一个就等于没隔离
 * （已经在「A 混进 B」这类事故上栽过，修一根留兄弟是那次的教训）。
 *
 * 公共库（没有归属行）对所有人开放，行为与过滤前一致。
 *
 * **和 practice-scout 不一样的一点**：引擎不可达时这里如实报错，不回空路径。
 * 「引擎挂了」和「这个域确实没跑过接入流水线、没有路径」在学习端是两件事，
 * 后者引擎自己会用 source=none + reason 说清楚；桥把前者也压成空路径，
 * 学员看到的就是「这个域没有路径」——那是编造出来的结论。
 */

import type { NextRequest } from 'next/server';

import curatedPath from '@/data/learning-path.json';
import { readProfile } from '@/lib/accounts/store';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { PATH_HOME_DOMAIN } from '@/lib/server/course-domains';
import { createLogger } from '@/lib/logger';

const log = createLogger('DomainPath API');

/** 引擎那侧要读 readiness.json + 前置图现算拓扑分层，冷启动比只读清单慢。 */
const TIMEOUT_MS = 15_000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;

  const access = await requireCorpusVisible(corpus);
  if (!access.ok) return access.response;

  const base = process.env.GROUNDING_URL;
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '学习路径服务尚未启用。');
  }
  try {
    const storedProfile = access.account ? await readProfile(access.account.id) : null;
    const profile: Record<string, unknown> =
      storedProfile && typeof storedProfile === 'object' && !Array.isArray(storedProfile)
        ? { ...(storedProfile as Record<string, unknown>), domain: corpus, corpus }
        : { domain: corpus, corpus };
    const conceptMastery =
      profile.conceptMastery &&
      typeof profile.conceptMastery === 'object' &&
      !Array.isArray(profile.conceptMastery)
        ? profile.conceptMastery
        : {};
    const resp = await fetch(
      `${base.replace(/\/$/, '')}/internal/v1/personalize/domain-path/${encodeURIComponent(corpus)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
        },
        body: JSON.stringify({
          corpus,
          profile,
          conceptMastery,
          ...(corpus === PATH_HOME_DOMAIN ? { curatedPath } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      log.warn(`domain path HTTP ${resp.status} for ${corpus}: ${detail.slice(0, 200)}`);
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        502,
        '学习路径服务返回错误，暂时取不到该领域的路径。',
      );
    }
    // 引擎那侧的路由用 `ApiResponse` 信封包了一层（`{code, message, data, traceId}`），
    // 与 skill-map 那条桥一样要拆到 data 才是路径本体；直接透传信封的话，前端拿到的
    // stages 是 undefined——看起来就是「这个域没有路径」，又是一次静默兜底。
    const payload = (await resp.json()) as { data?: unknown } | null;
    const path =
      payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
    if (!path || typeof path !== 'object') {
      log.warn(`domain path empty envelope for ${corpus}`);
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '学习路径服务没有给出路径数据。');
    }
    return apiSuccess({ path });
  } catch (error) {
    log.warn(`domain path failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '学习路径服务暂时不可用。');
  }
}
