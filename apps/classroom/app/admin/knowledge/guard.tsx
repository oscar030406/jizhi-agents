/**
 * 知识库中心两个页面共用的登录闸。判据与 `/admin` 一致：管理者账号才进。
 *
 * 没有复用 `/admin/page.tsx` 里那份同名逻辑是有意的——那一页另有人在改，
 * 从它里面抽公共件会把两条改动缠到一起。等两边都稳定了再合并成一份。
 */

import Link from 'next/link';
import { cookies } from 'next/headers';
import { ArrowLeft, ShieldAlert } from 'lucide-react';

import type { Account } from '@/lib/accounts/store';
import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';

export async function managerAccount(): Promise<Account | null> {
  if (!accountsEnabled()) return null;
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  return account?.role === 'manager' ? account : null;
}

export function Denied() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-card">
        <ShieldAlert className="mx-auto mb-3 size-8 text-amber-600" />
        <h1 className="mb-2 text-lg font-semibold">知识库</h1>
        <p className="text-sm text-muted-foreground">
          知识库中心只对管理者账号开放。请在首页右上角以「管理者」身份登录。
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs transition-colors hover:bg-accent"
        >
          <ArrowLeft className="size-3.5" />
          回首页
        </Link>
      </div>
    </main>
  );
}
