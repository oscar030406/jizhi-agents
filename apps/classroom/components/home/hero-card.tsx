'use client';

/**
 * 「继续上次」英雄卡（设计语言规格 v1 · 3.1 第 1/2 条）：
 * - col-span-full，读最近学习第一条；打开首页即知道下一步（配方①）
 * - 全页唯一的实心紫大按钮，拟物按压配方照抄规格（配方③④）
 * - 封面 + 4px 进度细条复用课程卡封面（配方⑱）
 */

import Link from 'next/link';
import { Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Slide } from '@openmaic/dsl';
import type { StageListItem } from '@/lib/utils/stage-storage';
import { CARD_RECIPE, CourseCover } from './course-card';

/** 拟物按压主 CTA（规格 3.1 第 2 条，配方④）：全站只此一处 */
export const HERO_CTA_RECIPE =
  'bg-primary text-primary-foreground border-b-4 border-[#5b21a8] rounded-2xl ' +
  'active:border-b-0 active:translate-y-[2px] transition-all duration-75';

export function ContinueHeroCard({
  classroom,
  slide,
  progress,
  formatDate,
}: {
  classroom: StageListItem;
  slide?: Slide;
  progress?: number;
  formatDate: (ts: number) => string;
}) {
  return (
    <section
      className={cn(
        // 英雄卡底：purple-soft → 白的极浅渐变（色调回暖微调），叠在 bg-card 上。
        // 任意属性写法：bg-gradient-to-br 会被 tailwind-merge 判定与 bg-card 冲突而互吞
        'col-span-full flex flex-col overflow-hidden sm:flex-row',
        '[background-image:linear-gradient(135deg,color-mix(in_oklab,var(--purple-soft)_45%,transparent),transparent)]',
        CARD_RECIPE,
      )}
    >
      <CourseCover
        name={classroom.name}
        slide={slide}
        progress={progress}
        className="h-[168px] w-full shrink-0 sm:w-[300px]"
      />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 p-5 sm:px-8">
        <p className="text-sm text-muted-foreground">继续上次</p>
        <h1 className="truncate text-2xl font-semibold text-foreground">{classroom.name}</h1>
        <p className="text-sm text-muted-foreground">
          {classroom.sceneCount} 页 · 上次学习 {formatDate(classroom.updatedAt)}
          {progress != null && progress > 0 && ` · 已学 ${Math.min(100, Math.round(progress * 100))}%`}
        </p>
        <div className="mt-3">
          <Link
            href={`/classroom/${classroom.id}`}
            className={cn(
              'inline-flex h-12 items-center gap-2 px-8 text-base font-medium',
              HERO_CTA_RECIPE,
            )}
          >
            <Play className="size-4 fill-current" />
            继续学习
          </Link>
        </div>
      </div>
    </section>
  );
}
