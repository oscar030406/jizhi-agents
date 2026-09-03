import { NextRequest, NextResponse } from 'next/server';

import {
  accountForSession,
  authenticate,
  deleteAccount,
  validateCredentials,
} from '@/lib/accounts/store';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/accounts/session';
import { demoForbidden, isDemoAccount } from '@/lib/accounts/demo';
import { credentialLimiter, trustedRequestSource } from '@/lib/accounts/credential-rate-limit';
import { createLogger } from '@/lib/logger';

const log = createLogger('Account delete API');

export const runtime = 'nodejs';

export async function DELETE(req: NextRequest) {
  try {
    const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 });
    if (isDemoAccount(account)) return demoForbidden();

    let body: { password?: unknown };
    try {
      body = (await req.json()) as { password?: unknown };
    } catch {
      return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
    }
    if (typeof body.password !== 'string') {
      return NextResponse.json({ error: '请输入当前密码以确认删除' }, { status: 400 });
    }
    const credentialCheck = validateCredentials(account.username, body.password);
    if (!credentialCheck.ok) {
      return NextResponse.json({ error: '当前密码格式不正确' }, { status: 400 });
    }
    const verification = await credentialLimiter.attempt({
      namespace: 'sensitive',
      subject: account.id,
      source: trustedRequestSource(req.headers),
      verify: () => authenticate(account.username, body.password as string),
    });
    if (verification.kind === 'blocked') {
      return NextResponse.json(
        { error: '当前密码验证失败次数过多，请稍后再试' },
        {
          status: 429,
          headers: { 'Retry-After': String(verification.retryAfterSeconds) },
        },
      );
    }
    const verified = verification.kind === 'success' ? verification.value : null;
    if (!verified || verified.id !== account.id) {
      return NextResponse.json({ error: '当前密码不正确，账户未删除' }, { status: 403 });
    }

    const deleted = await deleteAccount(account.id);
    if (!deleted.ok) {
      const status =
        deleted.code === 'storage_topology' || deleted.code === 'ownership_unavailable'
          ? 503
          : deleted.code === 'not_found'
            ? 404
            : 409;
      return NextResponse.json({ error: deleted.message, code: deleted.code }, { status });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
    return response;
  } catch (error) {
    log.error('account deletion failed:', error);
    return NextResponse.json({ error: '账户删除失败，未确认完成' }, { status: 500 });
  }
}
