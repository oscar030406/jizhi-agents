/**
 * 账户接口：注册 / 登录 / 登出 / 当前身份 + 个性化档案读写。
 *
 * 一个路由文件承载全部动作（action 字段分发），避免为四个两行的处理器
 * 铺四个目录。会话走 httpOnly cookie；账户 id 即 learnerKey，因此登录后
 * 课程与运行时数据自动落到该账户的分区（见 lib/persistence/server-auth.ts）。
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  type Account,
  accountForSession,
  accountsEnabled,
  authenticateAndCreateSession,
  createAccount,
  createSession,
  destroySession,
  normalizeRole,
  readProfile,
  validateCredentials,
  writeProfile,
} from '@/lib/accounts/store';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/accounts/session';
import { corpusVisibilityFor } from '@/lib/accounts/org-store';
import { isDemoAccount } from '@/lib/accounts/demo';
import { credentialLimiter, trustedRequestSource } from '@/lib/accounts/credential-rate-limit';
import { corpusOf } from '@/lib/generation/learner-profile';
import { createLogger } from '@/lib/logger';

const log = createLogger('Auth API');

export const runtime = 'nodejs';

async function profileForAccount(accountId: string, profile: unknown) {
  const corpus = corpusOf(profile as { corpus?: unknown; domain?: unknown } | null);
  if (!corpus) return profile;
  return (await corpusVisibilityFor(accountId))(corpus) ? profile : null;
}

/** GET：当前登录身份 + 档案。未登录返回 { account: null }，不报错。 */
export async function GET(req: NextRequest) {
  const capabilities = { serverLearningData: Boolean(process.env.DATABASE_URL) };
  if (!accountsEnabled()) return NextResponse.json({ enabled: false, account: null, capabilities });
  try {
    const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!account) return NextResponse.json({ enabled: true, account: null, capabilities });
    const profile = await profileForAccount(account.id, await readProfile(account.id));
    return NextResponse.json({
      enabled: true,
      account: isDemoAccount(account) ? { ...account, demo: true } : account,
      profile,
      capabilities,
    });
  } catch (error) {
    log.error('session lookup failed:', error);
    return NextResponse.json({ error: '会话读取失败' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!accountsEnabled()) {
    return NextResponse.json({ error: '本部署未启用账户系统' }, { status: 503 });
  }
  let body: {
    action?: string;
    username?: string;
    password?: string;
    role?: unknown;
    profile?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const action = body.action;
  try {
    if (action === 'register' || action === 'login') {
      const username = (body.username ?? '').trim();
      const password = body.password ?? '';
      const check = validateCredentials(username, password);
      if (!check.ok) return NextResponse.json({ error: check.message }, { status: 400 });

      const role = normalizeRole(body.role);
      let account: Account | string | null;
      let authenticatedSession: { token: string; maxAge: number } | null = null;
      if (action === 'register') {
        if (role === 'manager') {
          return NextResponse.json(
            { error: '管理者账户由平台签发并在服务器端创建，公共注册仅开放学习者。' },
            { status: 403 },
          );
        }
        const admission = await credentialLimiter.consume({
          namespace: 'register',
          subject: username,
          source: trustedRequestSource(req.headers),
        });
        if (admission.kind === 'blocked') {
          return NextResponse.json(
            { error: '注册请求过多，请稍后再试' },
            {
              status: 429,
              headers: { 'Retry-After': String(admission.retryAfterSeconds) },
            },
          );
        }
        const created = await createAccount(username, password, role);
        account = created.ok ? created.account : created.message;
      } else {
        const login = await credentialLimiter.attempt({
          namespace: 'login',
          subject: username,
          source: trustedRequestSource(req.headers),
          verify: () => authenticateAndCreateSession(username, password, role),
        });
        if (login.kind === 'blocked') {
          return NextResponse.json(
            { error: '登录失败次数过多，请稍后再试' },
            {
              status: 429,
              headers: { 'Retry-After': String(login.retryAfterSeconds) },
            },
          );
        }
        if (login.kind !== 'success') {
          account = null;
        } else if (login.value.kind === 'role-mismatch') {
          const label = login.value.account.role === 'manager' ? '管理者' : '学习者';
          return NextResponse.json(
            { error: `这个账号是${label}身份，请切到「${label}」再登录` },
            { status: 403 },
          );
        } else {
          account = login.value.account;
          authenticatedSession = login.value;
        }
      }

      if (typeof account === 'string') {
        return NextResponse.json({ error: account }, { status: 409 });
      }
      if (!account) {
        return NextResponse.json({ error: '用户名或密码不正确' }, { status: 401 });
      }
      // 登录时角色以库里的为准，客户端选的只用来对账：对不上就说清楚，
      // 不静默把人放进另一端——那会让学习者看见管理端的空壳，或反过来。
      const { token, maxAge } = authenticatedSession ?? (await createSession(account.id));
      const profile = await profileForAccount(account.id, await readProfile(account.id));
      const res = NextResponse.json({ account, profile });
      res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));
      log.info(`${action === 'register' ? 'Registered' : 'Logged in'}: ${account.username}`);
      return res;
    }

    if (action === 'logout') {
      await destroySession(req.cookies.get(SESSION_COOKIE)?.value);
      const res = NextResponse.json({ ok: true });
      res.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
      return res;
    }

    if (action === 'save-profile') {
      const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
      if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 });
      const corpus = corpusOf(body.profile as { corpus?: unknown; domain?: unknown } | null);
      if (corpus && !(await corpusVisibilityFor(account.id))(corpus)) {
        return NextResponse.json({ error: '当前账户无权使用该知识库。' }, { status: 403 });
      }
      await writeProfile(account.id, body.profile ?? null);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `未知 action: ${action}` }, { status: 400 });
  } catch (error) {
    log.error(`auth action "${action}" failed:`, error);
    return NextResponse.json({ error: '服务端处理失败' }, { status: 500 });
  }
}
