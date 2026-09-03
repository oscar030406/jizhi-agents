/**
 * 演示登录：POST { role: 'learner' | 'manager' }，服务端按角色解析成固定的演示账号，
 * 建会话的方式与 /api/auth 登录完全相同。不收用户名、不收密码，日志里也不出现凭证。
 */

import { NextRequest, NextResponse } from 'next/server';

import { DEMO_USERNAMES, type DemoRole } from '@/lib/accounts/demo';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/accounts/session';
import {
  accountByUsername,
  accountsEnabled,
  createSession,
  readProfile,
} from '@/lib/accounts/store';
import { credentialLimiter, trustedRequestSource } from '@/lib/accounts/credential-rate-limit';
import { createLogger } from '@/lib/logger';

const log = createLogger('Demo login API');

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!accountsEnabled()) {
    return NextResponse.json({ error: '本部署未启用账户系统' }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { role?: unknown };
  const role: DemoRole | null =
    body.role === 'learner' || body.role === 'manager' ? body.role : null;
  if (!role) {
    return NextResponse.json({ error: 'role 只能是 learner 或 manager' }, { status: 400 });
  }

  // 与注册同一把限流器：演示登录不验密码，不限流就是一个无限建会话的口子。
  const admission = await credentialLimiter.consume({
    namespace: 'demo',
    subject: role,
    source: trustedRequestSource(req.headers),
  });
  if (admission.kind === 'blocked') {
    return NextResponse.json(
      { error: '演示登录过于频繁，请稍后再试' },
      { status: 429, headers: { 'Retry-After': String(admission.retryAfterSeconds) } },
    );
  }

  try {
    const account = await accountByUsername(DEMO_USERNAMES[role]);
    if (!account || account.role !== role) {
      log.error(`demo account for ${role} missing or role mismatch`);
      return NextResponse.json({ error: '演示账号尚未就绪' }, { status: 503 });
    }
    const { token, maxAge } = await createSession(account.id);
    const profile = await readProfile(account.id);
    const res = NextResponse.json({ account: { ...account, demo: true }, profile });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));
    log.info(`Demo login: ${role}`);
    return res;
  } catch (error) {
    log.error('demo login failed:', error);
    return NextResponse.json({ error: '服务端处理失败' }, { status: 500 });
  }
}
