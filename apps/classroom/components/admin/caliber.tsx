/**
 * 管理端的「口径与复算」折叠块。
 *
 * 08-16 用户评审：管理端「小字堆砌」。原因不是字小，是每一段结论后面都跟着
 * 三到五行口径原文，默认视图里结论被口径淹了。处理办法是分层不是删——
 * 口径、来源、复算命令一个字不少，全部收进这个折叠；默认视图只留结论与图。
 *
 * 折叠而不是 tooltip：评委要能点开、能截图、能照着命令复算，
 * hover 出来的浮层截不下也复制不了。
 */

import { ChevronDown } from 'lucide-react';

export function Caliber({
  summary = '口径与核验',
  children,
}: {
  readonly summary?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <details className="group mt-3 rounded-xl border border-border bg-card/70">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-purple-700 dark:text-purple-300">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
        {summary}
      </summary>
      <div className="space-y-2 border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
