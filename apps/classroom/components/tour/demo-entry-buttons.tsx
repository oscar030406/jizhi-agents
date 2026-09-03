'use client';

/**
 * 首屏输入框下方的两个演示入口：一键以演示账号进学习端 / 管理端，不用注册不用输密码。
 * 角色在服务端解析成固定账号（/api/auth/demo），这里只传 role。
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { adoptServerProfile } from '@/lib/store/account';

type Role = 'learner' | 'manager';

const BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground/85 shadow-card transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60';

export function DemoEntryButtons() {
  const [busy, setBusy] = useState<Role | null>(null);
  const [error, setError] = useState('');

  const enter = async (role: Role) => {
    setBusy(role);
    setError('');
    try {
      const res = await fetch('/api/auth/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; profile?: unknown };
      if (!res.ok) {
        setError(data.error ?? `演示账号暂不可用（HTTP ${res.status}）`);
        setBusy(null);
        return;
      }
      // 演示账号是共用的：不把访客浏览器里的匿名进度并进去，只按服务端档案对齐本地
      adoptServerProfile(data.profile);
      window.location.assign(role === 'manager' ? '/admin' : '/');
    } catch {
      setError('网络不通，请稍后再试');
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          data-tour="demo-learner"
          disabled={busy !== null}
          onClick={() => void enter('learner')}
          className={BUTTON}
        >
          {busy === 'learner' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          体验学习端（演示账号）
        </button>
        <button
          type="button"
          data-tour="demo-manager"
          disabled={busy !== null}
          onClick={() => void enter('manager')}
          className={BUTTON}
        >
          {busy === 'manager' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          体验管理端（演示账号）
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
