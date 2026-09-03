/**
 * 机构成员名册（owner 专用）：GET 列名册，DELETE 移出成员。
 * owner 本人不可被移出；当前没有所有权移交入口。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession, resetPassword, validateCredentials } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { demoForbidden, isDemoAccount } from '@/lib/accounts/demo';
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
    return {
      error: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以管理成员。'),
    } as const;
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
  if (isDemoAccount(gate.account)) return demoForbidden();
  const accountId = new URL(req.url).searchParams.get('accountId') ?? '';
  if (!accountId) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '缺 accountId。');
  const result = await removeMember(gate.org.id, accountId);
  if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
  log.info(`member ${accountId} removed from org ${gate.org.id}`);
  return apiSuccess({ removed: accountId });
}

export async function PATCH(req: NextRequest) {
  const gate = await ownerOrg();
  if ('error' in gate) return gate.error;
  if (isDemoAccount(gate.account)) return demoForbidden();
  const body = (await req.json().catch(() => ({}))) as { accountId?: string; newPassword?: string };
  const accountId = String(body.accountId ?? '');
  const newPassword = String(body.newPassword ?? '');
  const roster = await membersOf(gate.org.id);
  const target = roster.find((m) => m.accountId === accountId);
  if (!target) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '该账户不在本机构。');
  if (target.role === 'owner') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '不能通过名册重置所有者自己的密码。');
  }
  const check = validateCredentials(target.username, newPassword);
  if (!check.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, check.message);
  const result = await resetPassword(accountId, newPassword);
  if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
  log.info(`password reset for ${accountId} by org ${gate.org.id} owner`);
  return apiSuccess({ reset: accountId });
}
