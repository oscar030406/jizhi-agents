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

import { cookies } from 'next/headers';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('DomainPath API');

/** 引擎那侧要读 readiness.json + 前置图现算拓扑分层，冷启动比只读清单慢。 */
const TIMEOUT_MS = 15_000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;

  // 归属别的机构的库直接 403：不是「没有路径」，是「你不该看见这个库」——
  // 两件事的文案不同，压成一句会让学员以为库空着。
  try {
    const { corpusVisibilityFor } = await import('@/lib/accounts/org-store');
    const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
    const visible = await corpusVisibilityFor(account?.id ?? null);
    if (!visible(corpus)) {
      return apiError(
        API_ERROR_CODES.UNAUTHORIZED,
        403,
        '这个知识库归属别的机构，你的账户看不到它的学习路径。',
      );
    }
  } catch (error) {
    // 账户系统没启用（本地/无库部署）时这里必然抛：那种部署本来就没有机构隔离，
    // 放行是原有行为，不因为闸装不上就把整条路径挡死。
    log.warn(`visibility gate skipped for ${corpus}: ${String(error)}`);
  }

  const base = process.env.GROUNDING_URL;
  if (!base) {
    return apiError(
      API_ERROR_CODES.PROVIDER_DISABLED,
      503,
      '未配置引擎地址（GROUNDING_URL），域级学习路径要引擎在线。',
    );
  }
  try {
    const resp = await fetch(
      `${base.replace(/\/$/, '')}/internal/v1/personalize/domain-path/${encodeURIComponent(corpus)}`,
      {
        headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
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
        `引擎返回 HTTP ${resp.status}`,
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
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        502,
        '学习路径服务没有给出路径数据。',
        '引擎返回 200，但信封里没有 data',
      );
    }
    return apiSuccess({ path });
  } catch (error) {
    log.warn(`domain path failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '学习路径服务暂时不可用。', String(error));
  }
}
