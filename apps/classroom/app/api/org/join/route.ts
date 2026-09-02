/**
 * 学员兑邀请码入组。幂等：重复兑同一机构的码直接成功；
 * 已在别的机构会被拒（P0 单一归属口径）。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { joinByCode } from '@/lib/accounts/org-store';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('OrgJoin API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。');

  const body = (await req.json().catch(() => ({}))) as { code?: string };
  const code = String(body.code ?? '').trim();
  if (!code) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '请填写邀请码。');

  const result = await joinByCode(account, code);
  if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
  log.info(`${account.username} joined org ${result.org.id}`);
  return apiSuccess({ org: { id: result.org.id, name: result.org.name } });
}
