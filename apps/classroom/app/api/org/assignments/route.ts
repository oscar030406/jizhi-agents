/**
 * 机构课程指派：owner 指派/撤回，成员读取（学员首页「机构指派」卡的数据源）。
 * 指派只登记（courseId + 标题快照），不复制课程——学员点进的就是那门课本体。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { addAssignment, assignmentsOf, orgForAccount, removeAssignment } from '@/lib/accounts/org-store';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('OrgAssignments API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function gate(needOwner: boolean) {
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account) return { error: apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。') } as const;
  const org = await orgForAccount(account.id);
  if (!org) return { error: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '不在任何机构中。') } as const;
  if (needOwner && org.memberRole !== 'owner') {
    return { error: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以管理指派。') } as const;
  }
  return { account, org } as const;
}

export async function GET() {
  const g = await gate(false);
  if ('error' in g) return g.error;
  return apiSuccess({ assignments: await assignmentsOf(g.org.id), orgName: g.org.name });
}

export async function POST(req: NextRequest) {
  const g = await gate(true);
  if ('error' in g) return g.error;
  const body = (await req.json().catch(() => ({}))) as { courseId?: string; title?: string };
  const result = await addAssignment(g.org.id, String(body.courseId ?? ''), String(body.title ?? ''), g.account.id);
  if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
  log.info(`assignment ${result.assignment.id} (${result.assignment.courseId}) in org ${g.org.id}`);
  return apiSuccess({ assignment: result.assignment });
}

export async function DELETE(req: NextRequest) {
  const g = await gate(true);
  if ('error' in g) return g.error;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!id) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '缺 id。');
  const removed = await removeAssignment(g.org.id, id);
  if (!removed) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '指派不存在。');
  return apiSuccess({ removed: id });
}
