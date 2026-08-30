/**
 * 机构总览与管理动作（面向企业供给能力的账户层，2026-08-30）。
 *
 * GET  —— 当前账号的机构视图：owner 拿全量（含邀请码与成员数），member 拿机构名，
 *          无归属拿 { org: null }。学习端首页与管理端共用这一读口。
 * POST —— action 分发（与 /api/auth 同款单文件路由风格）：
 *          create { name }：manager 建机构（一人一构，建成即有首个邀请码）；
 *          rotate：owner 轮换邀请码（旧码全部作废）。
 *
 * 设计脉络见 docs/04-research/auth-org-wheel-20260829.md：表结构骨架取自
 * better-auth organization 插件，邀请信道按无邮箱约束改为邀请码。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { createOrg, orgViewFor, rotateInviteCode } from '@/lib/accounts/org-store';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('Org API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function sessionAccount() {
  return accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function GET() {
  const account = await sessionAccount();
  if (!account) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。');
  const view = await orgViewFor(account.id);
  if (!view) return apiSuccess({ org: null });
  // 邀请码只给 owner；member 只知道自己在哪个机构
  const isOwner = view.org.memberRole === 'owner';
  return apiSuccess({
    org: {
      id: view.org.id,
      name: view.org.name,
      role: view.org.memberRole,
      memberCount: view.memberCount,
      inviteCode: isOwner ? view.inviteCode : null,
    },
  });
}

export async function POST(req: NextRequest) {
  const account = await sessionAccount();
  if (!account) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。');

  const body = (await req.json().catch(() => ({}))) as { action?: string; name?: string };
  if (body.action === 'create') {
    if (account.role !== 'manager') {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有管理者账号可以创建机构。');
    }
    const result = await createOrg(account, String(body.name ?? ''));
    if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
    log.info(`org created: ${result.view.org.id} by ${account.username}`);
    return apiSuccess({
      org: {
        id: result.view.org.id,
        name: result.view.org.name,
        role: 'owner',
        memberCount: result.view.memberCount,
        inviteCode: result.view.inviteCode,
      },
    });
  }
  if (body.action === 'rotate') {
    const view = await orgViewFor(account.id);
    if (!view || view.org.memberRole !== 'owner') {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以轮换邀请码。');
    }
    const code = await rotateInviteCode(view.org.id, account.id);
    log.info(`invite code rotated for org ${view.org.id}`);
    return apiSuccess({ inviteCode: code });
  }
  return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, `未知 action: ${body.action}`);
}
