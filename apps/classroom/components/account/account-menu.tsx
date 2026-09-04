'use client';

/**
 * 账户入口：未登录显示「登录 / 学习者注册」，登录后显示用户名与菜单（控制台 / 退出）。
 *
 * 注册只要用户名和密码（2026-08-04 用户定调：不绑手机号邮箱，密码 6 位以上
 * 字母数字即可）。
 *
 * `enabled` 来自 `/api/auth` GET，而它转发的 `accountsEnabled()` 自 2026-08-14 起
 * 恒为 true（没配库就走文件后备存储），所以 `!enabled` 那条分支实际不会触发。
 * 留着它是因为 `loading` 期间也要不渲染，两个条件本来就写在一起。
 *
 * 2026-08-12 加角色前置选择：填账号之前先选学习者还是管理者。角色是两个 C 端
 * 之间唯一的桥，选完直接落到对应那一端，不让人登录后自己去找入口。
 */

import { useEffect, useState } from 'react';
import {
  UserRound,
  LogOut,
  LayoutDashboard,
  Loader2,
  GraduationCap,
  ClipboardList,
} from 'lucide-react';
import Link from 'next/link';

import { useAccountStore, ROLE_HOME, type AccountRole } from '@/lib/store/account';
import { cn } from '@/lib/utils';

const ROLE_CARDS: ReadonlyArray<{
  readonly value: AccountRole;
  readonly label: string;
  readonly hint: string;
  readonly Icon: typeof GraduationCap;
}> = [
  {
    value: 'learner',
    label: '学习者',
    hint: '生成属于自己的课，按画像适配难度',
    Icon: GraduationCap,
  },
  {
    value: 'manager',
    label: '管理者',
    hint: '使用平台签发账户进入机构管理端',
    Icon: ClipboardList,
  },
];

export function AccountMenu({
  className,
  align = 'right',
}: {
  readonly className?: string;
  /**
   * 弹层贴哪一边。顶栏在页面右上角，弹层贴右；左功能栏里贴左，
   * 否则 288px 宽的面板会从 208px 宽的栏往屏幕外顶出去。
   */
  readonly align?: 'left' | 'right';
}) {
  const { enabled, account, loading, refresh, submit, logout } = useAccountStore();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [role, setRole] = useState<AccountRole | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading || !enabled) return null;

  const handleSubmit = async () => {
    if (!role) return;
    setError('');
    setBusy(true);
    const result = await submit(mode, username.trim(), password, role);
    setBusy(false);
    if (!result.ok) setError(result.message);
    // 成功时 submit 内部会跳转/重载，不需要收尾
  };

  const closePanel = () => {
    setOpen(false);
    setRole(null);
    setError('');
  };

  if (account) {
    return (
      <div className={cn('relative', className)}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
        >
          <UserRound className="size-3.5" />
          {account.displayName}
          {account.role === 'manager' && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              管理者
            </span>
          )}
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className={cn(
                'absolute top-full z-50 mt-1 w-40 rounded-xl border border-border bg-card p-1 shadow-card',
                align === 'left' ? 'left-0' : 'right-0',
              )}
            >
              <Link
                href={ROLE_HOME[account.role]}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs hover:bg-accent transition-colors"
              >
                <LayoutDashboard className="size-3.5" />
                {account.role === 'manager' ? '管理端' : '我的控制台'}
              </Link>
              <button
                onClick={() => void logout()}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors"
              >
                <LogOut className="size-3.5" />
                退出登录
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      <button
        onClick={() => setOpen(true)}
        className="rounded-full bg-purple-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-purple-700 active:scale-95 transition-all"
      >
        登录 / 学习者注册
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={closePanel} />
          <div
            className={cn(
              'absolute top-full z-50 mt-2 w-72 rounded-2xl border border-border bg-card p-4 shadow-card',
              align === 'left' ? 'left-0' : 'right-0',
            )}
          >
            {/* 第一步：选角色。没选之前不显示账号密码——先问「你是谁」再问「你是不是你」。 */}
            {!role ? (
              <div>
                <p className="mb-2.5 text-xs font-medium">你以什么身份进入？</p>
                <div className="space-y-1.5">
                  {ROLE_CARDS.map(({ value, label, hint, Icon }) => (
                    <button
                      key={value}
                      onClick={() => {
                        setRole(value);
                        setMode('login');
                        setError('');
                      }}
                      className="flex w-full items-start gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5 text-left hover:border-purple-400/60 hover:bg-accent transition-colors"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-purple-600" />
                      <span>
                        <span className="block text-xs font-medium">{label}</span>
                        <span className="block text-[10px] leading-relaxed text-muted-foreground">
                          {hint}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">
                  学习者可自主注册；管理者账户由平台签发并在服务器端创建。
                </p>
              </div>
            ) : (
              <>
                <button
                  onClick={() => {
                    setRole(null);
                    setError('');
                  }}
                  className="mb-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  ← {role === 'manager' ? '管理者' : '学习者'}（换身份）
                </button>
                <div className="mb-3 flex gap-1 rounded-lg bg-muted p-0.5">
                  {(['login', 'register'] as const)
                    .filter((m) => role === 'learner' || m === 'login')
                    .map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          setMode(m);
                          setError('');
                        }}
                        className={cn(
                          'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                          mode === m
                            ? 'bg-card shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {m === 'login' ? '登录' : '注册'}
                      </button>
                    ))}
                </div>

                {/* 真 <form>：密码管理器只认 form 里的 username/password 组合，
                回车提交也交给表单语义，不再手工监听按键。 */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy) void handleSubmit();
                  }}
                >
                  <div className="space-y-2">
                    <input
                      name="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="用户名（字母数字下划线）"
                      autoComplete="username"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400/60"
                    />
                    <input
                      name="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type="password"
                      placeholder="密码（6 位以上字母或数字）"
                      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400/60"
                    />
                  </div>

                  {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}

                  <button
                    type="submit"
                    disabled={busy || !username.trim() || !password}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-purple-600 py-2 text-xs font-medium text-white disabled:opacity-40 hover:bg-purple-700 active:scale-95 transition-all"
                  >
                    {busy && <Loader2 className="size-3.5 animate-spin" />}
                    {mode === 'login' ? '登录' : '注册并登录'}
                  </button>
                </form>

                <p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">
                  {role === 'manager'
                    ? '管理者账户不开放网页自注册；请使用平台签发的账户登录机构管理端。'
                    : '登录后，你的学习者画像与生成的课程会保存在账户上，换设备也能继续。未登录也能使用，数据只留在当前浏览器。'}
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
