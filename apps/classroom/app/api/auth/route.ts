/**
 * 账户接口：注册 / 登录 / 登出 / 当前身份 + 个性化档案读写。
 *
 * 一个路由文件承载全部动作（action 字段分发），避免为四个两行的处理器
 * 铺四个目录。会话走 httpOnly cookie；账户 id 即 learnerKey，因此登录后
 * 课程与运行时数据自动落到该账户的分区（见 lib/persistence/server-auth.ts）。
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  accountForSession,
  accountsEnabled,
  authenticate,
  createAccount,
  createSession,
  destroySession,
  normalizeRole,
  readProfile,
  validateCredentials,
  writeProfile,
} from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { corpusVisibilityFor } from '@/lib/accounts/org-store';
import { corpusOf } from '@/lib/generation/learner-profile';
import { createLogger } from '@/lib/logger';

const log = createLogger('Auth API');

export const runtime = 'nodejs';

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    // 线上是 https；本地 http 开发时 secure 会让 cookie 存不下，故按协议判定
    secure: process.env.NODE_ENV === 'production',
  };
}

async function profileForAccount(accountId: string, profile: unknown) {
  const corpus = corpusOf(profile as { corpus?: unknown; domain?: unknown } | null);
  if (!corpus) return profile;
  return (await corpusVisibilityFor(accountId))(corpus) ? profile : null;
}

/** GET：当前登录身份 + 档案。未登录返回 { account: null }，不报错。 */
export async function GET(req: NextRequest) {
  if (!accountsEnabled()) return NextResponse.json({ enabled: false, account: null });
  try {
    const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!account) return NextResponse.json({ enabled: true, account: null });
    const profile = await profileForAccount(account.id, await readProfile(account.id));
    return NextResponse.json({ enabled: true, account, profile });
  } catch (error) {
    log.error('session lookup failed:', error);
    return NextResponse.json({ enabled: true, account: null });
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
      const account =
        action === 'register'
          ? await (async () => {
              const created = await createAccount(username, password, role);
              return created.ok ? created.account : created.message;
            })()
          : await authenticate(username, password);

      if (typeof account === 'string') {
        return NextResponse.json({ error: account }, { status: 409 });
      }
      if (!account) {
        return NextResponse.json({ error: '用户名或密码不正确' }, { status: 401 });
      }
      // 登录时角色以库里的为准，客户端选的只用来对账：对不上就说清楚，
      // 不静默把人放进另一端——那会让学习者看见管理端的空壳，或反过来。
      if (action === 'login' && account.role !== role) {
        const label = account.role === 'manager' ? '管理者' : '学习者';
        return NextResponse.json(
          { error: `这个账号是${label}身份，请切到「${label}」再登录` },
          { status: 403 },
        );
      }

      const { token, maxAge } = await createSession(account.id);
      const profile = await profileForAccount(account.id, await readProfile(account.id));
      const res = NextResponse.json({ account, profile });
      res.cookies.set(SESSION_COOKIE, token, cookieOptions(maxAge));
      log.info(`${action === 'register' ? 'Registered' : 'Logged in'}: ${account.username}`);
      return res;
    }

    if (action === 'logout') {
      await destroySession(req.cookies.get(SESSION_COOKIE)?.value);
      const res = NextResponse.json({ ok: true });
      res.cookies.set(SESSION_COOKIE, '', cookieOptions(0));
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
