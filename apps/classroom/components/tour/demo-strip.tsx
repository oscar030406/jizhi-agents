'use client';

/** 演示会话期间页面顶部的一条细提示；「退出」登出并回首页。 */

import { useEffect } from 'react';

import { useAccountStore } from '@/lib/store/account';

export function DemoStrip() {
  const { account, loading, refresh, logout } = useAccountStore();
  useEffect(() => {
    if (loading) void refresh();
  }, [loading, refresh]);
  if (!account?.demo) return null;
  return (
    <div
      data-tour="demo-strip"
      className="flex h-8 w-full shrink-0 items-center justify-center gap-2 bg-yellow-soft px-3 text-xs text-foreground/80"
    >
      <span>演示账号，多人共用，请不要填写真实信息</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => void logout('/')}
        className="underline underline-offset-4 hover:text-foreground"
      >
        退出
      </button>
    </div>
  );
}
