/**
 * 域级实操项目：管理员审核发布（POST，勾选的条目集合整体生效）。
 *
 * projectIds 空数组 = 全部下架。角色闸与 draft 桥同一道。
 */

import type { NextRequest } from 'next/server';

import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('PracticeScoutApprove API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;
  const access = await requireCorpusVisible(corpus, { manage: true });
  if (!access.ok) return access.response;
  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '实操项目服务暂不可用。');
  }
  const payload = await req.json().catch(() => null);
  if (!payload || !Array.isArray(payload.projectIds)) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'projectIds 必须是数组。');
  }
  try {
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({ projectIds: payload.projectIds }),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    if (!resp.ok) {
      log.warn(`approve HTTP ${resp.status} for ${corpus}: ${body.detail ?? ''}`);
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '实操项目服务未能完成发布。');
    }
    return apiSuccess({ draft: body });
  } catch (error) {
    log.warn(`approve failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '实操项目服务暂不可用，发布未生效。');
  }
}
