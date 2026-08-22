'use client';

/**
 * 子页共享极简顶栏：返回首页 + 主题切换。
 *
 * /compare /report /skills /agents /privacy 此前各自手写返回链接、没有主题
 * 入口——进了子页想切主题只能先回首页。样式与 app/page.tsx 的首页顶栏
 * 同配方（h-14、sticky、backdrop-blur，规格 2.4 统一 header）。
 * children 渲染在返回链接右侧，给需要附加上下文的页面用（如 /agents 的课程名）。
 */

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Monitor, Moon, Sun } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { cn } from '@/lib/utils';

const THEME_OPTIONS = [
  { value: 'light', icon: Sun, labelKey: 'settings.themeOptions.light' },
  { value: 'dark', icon: Moon, labelKey: 'settings.themeOptions.dark' },
  { value: 'system', icon: Monitor, labelKey: 'settings.themeOptions.system' },
] as const;

export function SiteHeader({
  backHref = '/',
  backLabel,
  maxWidth = 'max-w-6xl',
  children,
}: {
  backHref?: string;
  backLabel?: string;
  /** 容器宽度类，与各子页正文容器对齐（max-w-4xl / 5xl / 6xl） */
  maxWidth?: string;
  /**
   * 历史遗留：曾用于在非中文语种下给「正文未翻译」的页挂一条告知。
   * 2026-08-16 界面统一为简体中文、语言切换器撤除后这个告知不再有意义，
   * 已停止读取。属性本身留着只为让还在传它的调用方继续通过类型检查
   * （admin/** 由别的工单在改，本单不动），下次动那些页面时一并删掉。
   */
  localized?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const ActiveIcon = THEME_OPTIONS.find((o) => o.value === theme)?.icon ?? Sun;

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/85 backdrop-blur-md">
      <div
        className={cn(
          'mx-auto flex h-14 w-full items-center justify-between gap-3 px-4 sm:px-6',
          maxWidth,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={backHref}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {backLabel ?? t('generation.backToHome')}
          </Link>
          {children}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setThemeOpen((v) => !v)}
              aria-label={t('settings.theme')}
              title={t('settings.theme')}
              className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ActiveIcon className="size-4" />
            </button>
            {themeOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setThemeOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-2 min-w-[140px] overflow-hidden rounded-lg border border-border bg-popover shadow-dropdown dark:bg-surface-2 dark:shadow-none">
                  {THEME_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => {
                        setTheme(o.value);
                        setThemeOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-accent',
                        theme === o.value && 'bg-secondary text-primary',
                      )}
                    >
                      <o.icon className="size-4" />
                      {t(o.labelKey)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
