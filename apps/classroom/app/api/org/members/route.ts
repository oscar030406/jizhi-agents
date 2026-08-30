/**
 * 机构成员名册（owner 专用）：GET 列名册，DELETE 移出成员。
 * owner 本人不可被移出；移交所有权是 roadmap（P2）。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { membersOf, orgForAccount, removeMember } from '@/lib/accounts/org-store';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('OrgMembers API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function ownerOrg() {
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account) return { error: apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。') } as const;
  const org = await orgForAccount(account.id);
  if (!org || org.memberRole !== 'owner') {
    return { error: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以管理成员。') } as const;
  }
  return { account, org } as const;
}

export async function GET() {
  const gate = await ownerOrg();
  if ('error' in gate) return gate.error;
  return apiSuccess({ members: await membersOf(gate.org.id) });
}

export async function DELETE(req: NextRequest) {
  const gate = await ownerOrg();
  if ('error' in gate) return gate.error;
  const accountId = new URL(req.url).searchParams.get('accountId') ?? '';
  if (!accountId) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '缺 accountId。');
  const result = await removeMember(gate.org.id, accountId);
  if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
  log.info(`member ${accountId} removed from org ${gate.org.id}`);
  return apiSuccess({ removed: accountId });
}
