'use client';

/**
 * 学习者左侧功能栏。
 *
 * 登录后的学习端此前是一张长滚动页，路径 / 报告 / 岗位 / 审核实录 / 智能体分工
 * 藏在顶栏那排图标里——图标没有文字，评委三分钟里翻不出来这套系统有几块功能。
 * 这条栏把它们摆平，当前页高亮，收起后只剩图标（宽度记在 localStorage）。
 *
 * 公共变体（`variant="public"`，2026-09-04）：未登录的落地页也挂这条栏，
 * 去掉「我的画像 / 学情报告」这类要账号才有意义的项，底部账户块换成登录与注册。
 * 这样登录前后是同一套布局，访客不必先在顶栏一行文字链里找页——那行链在窄屏整条藏起来。
 * 管理端 /admin 保持原布局。路由一条不新建，全是已有的页。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Bot,
  Briefcase,
  BookOpen,
  Home,
  LogOut,
  Menu,
  PanelLeft,
  PanelLeftClose,
  Route,
  ShieldCheck,
  UserCog,
  X,
} from 'lucide-react';

import { SelfProfilePanel } from '@/components/generation/learner-profile-popover';
import { useAccountStore } from '@/lib/store/account';
import { cn } from '@/lib/utils';

const COLLAPSE_KEY = 'learnerRailCollapsed';

const ITEMS = [
  // 首页就是课程墙所在的页；已经在首页时这个链接把视图带到最近学习那一段。
  { href: '/#my-courses', match: '/', label: '我的课程', icon: BookOpen },
  { href: '/path', match: '/path', label: '学习路径', icon: Route },
  { href: '/report', match: '/report', label: '学情报告', icon: BarChart3 },
  { href: '/skills', match: '/skills', label: '岗位技能', icon: Briefcase },
  { href: '/evidence', match: '/evidence', label: '审核实录', icon: ShieldCheck },
  { href: '/agents', match: '/agents', label: '智能体分工', icon: Bot },
] as const;

/** 公共变体的项。没有账号也有意义的那几个去处，「课程」直接锚到课程墙。 */
const PUBLIC_ITEMS = [
  { href: '/', match: '/', label: '首页', icon: Home },
  { href: '/path', match: '/path', label: '学习路径', icon: Route },
  { href: '/#courses', match: '', label: '课程', icon: BookOpen },
  { href: '/skills', match: '/skills', label: '岗位技能', icon: Briefcase },
  { href: '/evidence', match: '/evidence', label: '审核实录', icon: ShieldCheck },
  { href: '/agents', match: '/agents', label: '智能体分工', icon: Bot },
] as const;

/** 当前项：浅紫底 + 深紫字，站内既有 token（功能卡的 chip 同一对），不加渐变不加色块。 */
const ACTIVE = 'bg-purple-soft text-purple-deep';
const IDLE = 'text-muted-foreground hover:bg-accent hover:text-foreground';

function RailNav({
  collapsed,
  pathname,
  variant,
  onOpenProfile,
  onNavigate,
}: {
  collapsed: boolean;
  pathname: string;
  variant: 'learner' | 'public';
  onOpenProfile: () => void;
  onNavigate?: () => void;
}) {
  const itemClass = (active: boolean) =>
    cn(
      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
      collapsed && 'justify-center px-0',
      active ? ACTIVE : IDLE,
    );

  if (variant === 'public') {
    return (
      <nav className="flex flex-col gap-0.5 overflow-y-auto p-2">
        {PUBLIC_ITEMS.map((item) => {
          const active = Boolean(item.match) && pathname === item.match;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
              className={itemClass(active)}
            >
              <item.icon className="size-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex flex-col gap-0.5 overflow-y-auto p-2">
      {ITEMS.map((item) => {
        const active = pathname === item.match;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            aria-current={active ? 'page' : undefined}
            className={itemClass(active)}
          >
            <item.icon className="size-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </Link>
        );
      })}
      <button
        type="button"
        data-tour="self-profile"
        onClick={() => {
          onOpenProfile();
          onNavigate?.();
        }}
        title={collapsed ? '我的画像' : undefined}
        className={cn(itemClass(false), 'w-full text-left')}
      >
        <UserCog className="size-4 shrink-0" />
        {!collapsed && <span className="truncate">我的画像</span>}
      </button>
    </nav>
  );
}

/**
 * 账户块钉在视口底：`mt-auto` 把它压到栏底，`sticky bottom-0` 让它在页面还没滚动时
 * 也留在视口内。**不要改回给整条栏写 `h-[100dvh]`**——首页顶上那条演示条把栏整体
 * 往下推了 32px，栏底就掉出屏幕，用户名和退出在首屏（也就是截图那一屏）根本看不见。
 */
function RailAccount({ collapsed, pinned }: { collapsed: boolean; pinned?: boolean }) {
  const { account, logout } = useAccountStore();
  if (!account) return null;
  return (
    <div
      className={cn(
        'border-t border-border/60 bg-background p-2',
        pinned && 'sticky bottom-0 mt-auto',
        collapsed && 'flex justify-center',
      )}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => void logout('/')}
          title={`${account.displayName} · 退出`}
          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="size-4" />
        </button>
      ) : (
        <div className="flex items-center justify-between gap-2 px-1.5 py-1">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {account.displayName}
          </span>
          <button
            type="button"
            onClick={() => void logout('/')}
            className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
          >
            退出
          </button>
        </div>
      )}
    </div>
  );
}

export function LearnerRail({
  onOpenProfile,
  variant = 'learner',
}: {
  /**
   * 首页把画像状态握在自己手里（造课要用同一份），所以由它接管「我的画像」；
   * 不传就由本栏自己挂一块面板，子页（/report /skills）走这条。
   */
  onOpenProfile?: () => void;
  /** `public` = 未登录的落地页那一条：去掉要账号的项，底部换成登录入口。 */
  variant?: 'learner' | 'public';
}) {
  const pathname = usePathname() ?? '/';
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ownProfileOpen, setOwnProfileOpen] = useState(false);

  // 挂载后再读偏好：服务端渲染不出 localStorage，首帧按展开画，避免 hydration 不一致。
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'true');
      } catch {
        /* localStorage unavailable */
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const openProfile = onOpenProfile ?? (() => setOwnProfileOpen(true));

  return (
    <>
      {/* 整条栏跟着行高伸展（不写死 100dvh，见 RailAccount 的注释）：
          导航块 sticky 在顶、账户块 sticky 在底，滚动时两头都留在视口里。 */}
      <aside
        data-testid="learner-rail"
        className={cn(
          'hidden shrink-0 flex-col border-r border-border/60 bg-background lg:flex',
          collapsed ? 'w-14' : 'w-52',
        )}
      >
        <div className="sticky top-0 flex max-h-[100dvh] flex-col overflow-hidden">
          <div
            className={cn('flex items-center p-2', collapsed ? 'justify-center' : 'justify-end')}
          >
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? '展开功能栏' : '收起功能栏'}
              title={collapsed ? '展开功能栏' : '收起功能栏'}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          </div>
          {/* 公共变体不在栏里再放一次登录：顶栏右上角已经有 AccountMenu，一屏两个入口多余。 */}
          <RailNav
            collapsed={collapsed}
            pathname={pathname}
            variant={variant}
            onOpenProfile={openProfile}
          />
        </div>
        {variant === 'learner' && <RailAccount collapsed={collapsed} pinned />}
      </aside>

      {/* 窄屏：一个悬浮按钮 + 抽屉。放左下角是为了不和顶栏的字标、图标组抢位置；
          抬到 bottom-20 是因为开发模式下 Next 的调试徽标钉在左下角，压着它点不动。 */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="打开功能栏"
        className="fixed bottom-20 left-4 z-40 rounded-full border border-border bg-card p-2.5 text-muted-foreground shadow-card transition-colors hover:text-foreground lg:hidden"
      >
        <Menu className="size-4" />
      </button>
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 flex w-52 flex-col border-r border-border bg-background">
            <div className="flex items-center justify-end p-2">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭功能栏"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <RailNav
                collapsed={false}
                pathname={pathname}
                variant={variant}
                onOpenProfile={openProfile}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
            {variant === 'learner' && <RailAccount collapsed={false} />}
          </div>
        </div>
      )}

      {!onOpenProfile && variant === 'learner' && (
        <SelfProfilePanel
          showTrigger={false}
          open={ownProfileOpen}
          onOpenChange={setOwnProfileOpen}
        />
      )}
    </>
  );
}
