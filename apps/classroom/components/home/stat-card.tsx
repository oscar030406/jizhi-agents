/**
 * 数字三件套卡（public-site-redesign §4.3 + §0-bis 人文十律）：
 * 粉彩圆片图标 → 主题深色大数字（tnum）→ 同屏口径小字。
 * 铁律：数字必须来自 metrics.json 真源，口径（caliber）跟着数字走，
 * 脱离口径的数字禁止用本组件上页。
 */

import type { LucideIcon } from 'lucide-react';

import { CARD_RECIPE_STATIC } from '@/components/home/course-card';

export interface StatCardProps {
  readonly value: string;
  readonly label: string;
  /** 口径限定语，与数字同屏渲染——传空串也会渲染空行，刻意不做可选。 */
  readonly caliber: string;
  readonly icon: LucideIcon;
  /** 粉彩圆片底色 class，如 'bg-purple-soft' */
  readonly soft: string;
  /** 数字/图标深色 class，如 'text-purple-deep' */
  readonly deep: string;
}

export function StatCard({ value, label, caliber, icon: Icon, soft, deep }: StatCardProps) {
  return (
    <div className={`${CARD_RECIPE_STATIC} flex gap-3 p-4`}>
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${soft}`} aria-hidden>
        <Icon className={`size-5 ${deep}`} />
      </span>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className={`mt-1 text-4xl font-bold tabular-nums [font-feature-settings:'tnum'] ${deep}`}>
          {value}
        </dd>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{caliber}</p>
      </div>
    </div>
  );
}
