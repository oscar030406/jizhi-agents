/**
 * 域级实操项目：管理员审核发布（POST，勾选的条目集合整体生效）。
 *
 * projectIds 空数组 = 全部下架。角色闸与 draft 桥同一道。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('PracticeScoutApprove API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ corpus: string }> },
) {
  if (!accountsEnabled()) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '本部署未启用账户，管理端接口不开放。');
  }
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '实操项目发布只对管理者账号开放。');
  }
  const { corpus } = await params;
  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '未配置引擎地址（GROUNDING_URL）。');
  }
  const payload = await req.json().catch(() => null);
  if (!payload || !Array.isArray(payload.projectIds)) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'projectIds 必须是数组。');
  }
  try {
    const resp = await fetch(
      `${base}/api/practice-scout/${encodeURIComponent(corpus)}/approve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
        },
        body: JSON.stringify({ projectIds: payload.projectIds }),
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      },
    );
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    if (!resp.ok) {
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, body.detail || `引擎返回 HTTP ${resp.status}`);
    }
    return apiSuccess({ draft: body });
  } catch (error) {
    log.warn(`approve failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '引擎不可达，发布未生效。');
  }
}
