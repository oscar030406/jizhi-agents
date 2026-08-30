'use client';

/**
 * 首页画像卡下的机构归属条：已入组显示机构名；未入组给一格邀请码输入。
 * 入组成功后整页刷新——所属机构变化会改变可见知识库清单（/api/domains 过滤），
 * 让画像下拉与域工作区立刻吃到新视图，比逐组件通知可靠。
 */

import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';

export function OrgBadge() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'none' }
    | { kind: 'member'; name: string }
    | { kind: 'anon' }
  >({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch('/api/org', { cache: 'no-store' });
        if (resp.status === 401) {
          if (alive) setState({ kind: 'anon' });
          return;
        }
        const body = await resp.json();
        if (!alive) return;
        setState(body?.org ? { kind: 'member', name: body.org.name } : { kind: 'none' });
      } catch {
        if (alive) setState({ kind: 'anon' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === 'loading' || state.kind === 'anon') return null;

  if (state.kind === 'member') {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Building2 className="size-3" /> 机构：{state.name}
      </p>
    );
  }

  const join = async () => {
    setBusy(true);
    setError('');
    try {
      const resp = await fetch('/api/org/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await resp.json();
      if (!resp.ok) setError(body?.error?.message ?? body?.error ?? '邀请码无效');
      else window.location.reload();
    } catch {
      setError('网络错误，可重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <Building2 className="size-3 text-muted-foreground" />
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="有机构邀请码？在此输入"
          className="h-7 w-44 rounded border border-border bg-background px-2 text-[11px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && code.trim()) void join();
          }}
        />
        <button
          type="button"
          disabled={busy || !code.trim()}
          onClick={() => void join()}
          className="h-7 rounded border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          加入
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
