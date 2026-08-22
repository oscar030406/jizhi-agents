'use client';

/**
 * 学习者档案切换器 —— 服务端档案的视图。
 *
 * ## 为什么重写（2026-08-18，用户点名的四条不满的正解）
 *
 * 旧版把「档案」实现为 **localStorage 里的匿名 learnerKey 分区**：切档案 = 换本地快照
 * + reload。那是**登录体系上线之前**的方案，`lib/runtime/learner-accounts.ts` 自己的注释
 * 也写着「真登录未来落地时，RuntimeStore.mergeLearner 是迁移路径」。真登录落地了，
 * 这条路径一直没走，于是：
 *
 * - **换不了**：切换只改本地，服务端 `profile` 不动；`lib/store/account.ts` 登录时又把
 *   服务端画像写回同一个 localStorage 键，**刷新即覆盖**，用户看到的就是「切了没用」。
 * - **换库无效**：`corpus` 是画像字段，生成链读画像；本地改了服务端没改，同上被覆盖。
 * - **报告与画像对不上**：首页读本地快照、`/report` 读服务端，两个数据源必然分叉。
 *
 * 现在服务端（`/api/profile`）是单一真源，本组件只做视图：列表、切换、新建、删除。
 *
 * ## 切换后为什么要 reload
 *
 * 生成链读的是 localStorage 的 `learnerProfile` 单键（`use-scene-generator.ts` 就地读，
 * 不走 props）。切档案后把新档案的字段写回那个键再整页 reload，是让**所有**读取方
 * （生成链、画像弹层、路径页）一次性看到新画像最省心的做法——挨个改成订阅式
 * 是另一单的活，这里不顺手做。
 */

import { useCallback, useEffect, useState } from 'react';
import { UserRound, Plus, Check, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('Learner Profiles');

/** 与生成链共用的单键。切换后写它再 reload，读取方无需改造。 */
const PROFILE_STORAGE_KEY = 'learnerProfile';

interface ProfileMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface ProfileView {
  profiles: ProfileMeta[];
  activeId: string;
  fields: Record<string, unknown> | null;
}

export function LearnerAccountSwitcher() {
  const [view, setView] = useState<ProfileView | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/profile');
      if (r.status === 401) {
        // 未登录：档案随账户走，没账户就没有档案可切——整个组件不出现，
        // 而不是给一个点了没反应的按钮。
        setAnonymous(true);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setView((await r.json()) as ProfileView);
    } catch (e) {
      log.warn(`档案清单读取失败：${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 所有写动作走同一个口子：出错就把服务端的话原样显示，不自己编文案。 */
  const act = async (body: Record<string, unknown>, thenReload: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as ProfileView & { error?: string };
      if (!r.ok) {
        setError(j.error ?? `操作失败（HTTP ${r.status}）`);
        setBusy(false);
        return;
      }
      setView(j);
      if (thenReload) {
        try {
          // 空档案写 null 而不是 {}：读取方用「有没有」判「填没填」。
          if (j.fields) window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(j.fields));
          else window.localStorage.removeItem(PROFILE_STORAGE_KEY);
        } catch {
          /* 存储不可用不影响服务端已经切好的事实 */
        }
        window.location.reload();
        return;
      }
      setBusy(false);
      setCreating(false);
      setNewName('');
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  if (anonymous || !view) return null;

  const currentName = view.profiles.find((p) => p.id === view.activeId)?.name ?? '默认档案';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
      >
        <UserRound className="size-4 text-green-deep" />
        <span className="flex-1 truncate text-left">{currentName}</span>
        <span className="text-xs text-muted-foreground">
          {view.profiles.length > 1 ? `${view.profiles.length} 个档案` : '切换档案'}
        </span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-card shadow-md p-1">
          {view.profiles.map((p) => (
            <div key={p.id} className="group flex items-center gap-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: 'activate', id: p.id }, true)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-muted/60',
                  p.id === view.activeId && 'font-medium',
                )}
              >
                <span className="flex-1 truncate text-left">{p.name}</span>
                {p.id === view.activeId && <Check className="size-3.5 shrink-0 text-green-deep" />}
              </button>
              {/* 只剩一份时不给删按钮——服务端也会拒，但让按钮先不出现比点了报错友好 */}
              {view.profiles.length > 1 && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`删除档案 ${p.name}`}
                  onClick={() => void act({ action: 'delete', id: p.id }, p.id === view.activeId)}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-red-deep focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          ))}
          {creating ? (
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) {
                    void act({ action: 'create', name: newName }, true);
                  }
                }}
                placeholder="档案名（如：转岗学员小李）"
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={busy || !newName.trim()}
                onClick={() => void act({ action: 'create', name: newName }, true)}
                className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
              >
                建
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted/60"
            >
              <Plus className="size-3.5" />
              新建学习者档案
            </button>
          )}
          {error && <p className="px-2.5 py-1 text-xs text-red-deep">{error}</p>}
        </div>
      )}
    </div>
  );
}
