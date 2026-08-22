'use client';

/**
 * 首页课程卡（设计语言规格 v1 · 3.1）：
 * - 粉彩渐变封面兜底（课程名 hash 到五组 soft→soft 同色系渐变，配方⑱）
 * - 4px 进度细条压封面底边（轨道 purple-soft / 填充 green-solid，配方⑱③）
 * - 卡片配方：rounded-xl border bg-card shadow-card，hover 只加 drop-shadow（配方⑭⑮）
 * - 暗色下禁阴影，hover 走边框升档（规格 2.7，配方⑰）
 */

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Atom, Copy, Pencil, Sparkles, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { GenerativeCover } from '@/components/home/generative-cover';
import { toast } from 'sonner';
import type { Slide } from '@openmaic/dsl';
import type { StageListItem } from '@/lib/utils/stage-storage';

/** 卡片统一配方（规格 3.1 第 3/5 条 + 2.7 暗色纪律） */
export const CARD_RECIPE =
  'rounded-xl border border-border bg-card shadow-card dark:shadow-none ' +
  'transition-[filter,border-color] duration-150 hover:drop-shadow-card-hover ' +
  'dark:hover:drop-shadow-none dark:hover:border-white/20';

/** 静置卡片（无 hover 反馈）配方 */
export const CARD_RECIPE_STATIC = 'rounded-xl border border-border bg-card shadow-card dark:shadow-none';

// 渐变实现已并入生成式封面（单一真源），此处保留导出兼容既有引用
export { courseCoverGradient } from '@/components/home/generative-cover';

/**
 * 课程封面：有首页缩略图用缩略图，否则生成式抽象封面兜底；4px 进度细条永远压底边。
 * progress 未知时只画轨道（进度是装饰信息，缺失不装样子）。
 */
export function CourseCover({
  name,
  slide,
  progress,
  className,
  children,
}: {
  name: string;
  slide?: Slide;
  progress?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)}>
      {/* 无缩略图时兜底生成式抽象封面；有缩略图时它也垫在底层，加载期不露白 */}
      <GenerativeCover name={name} className="absolute inset-0" />
      {slide && width > 0 && (
        <SlideThumbnail
          slide={slide}
          size={width}
          viewportSize={slide.viewportSize ?? 1000}
          viewportRatio={slide.viewportRatio ?? 0.5625}
        />
      )}
      {/* 4px 进度细条：轨道 purple-soft，填充 green-solid（配方⑱⑤③） */}
      <div className="absolute inset-x-0 bottom-0 z-10 h-1 bg-purple-soft">
        {progress != null && progress > 0 && (
          <div
            className="h-full bg-green-solid"
            style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
          />
        )}
      </div>
      {children}
    </div>
  );
}

export function CourseCard({
  classroom,
  slide,
  progress,
  formatDate,
  onDelete,
  onRename,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onClick,
}: {
  classroom: StageListItem;
  slide?: Slide;
  progress?: number;
  formatDate: (ts: number) => string;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => void;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  const isTaskEngineMode = classroom.taskEngineMode === true;
  const showModeBadge = classroom.interactiveMode || isTaskEngineMode;
  const ModeBadgeIcon = isTaskEngineMode ? Sparkles : Atom;
  const modeBadgeLabel = isTaskEngineMode ? 'Vocational Mode' : t('toolbar.interactiveModeLabel');

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNameDraft(classroom.name);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== classroom.name) {
      onRename(classroom.id, trimmed);
    }
    setEditing(false);
  };

  return (
    // 整卡可点，所以整卡也得能用键盘：role+tabIndex+回车/空格，否则最近学习里的课
    // 只能用鼠标打开（卡内的重命名/删除本来就是 button，各自可聚焦）。
    // 确认删除态下卡片不可点，同时退出 Tab 序，免得回车误触发进课。
    <div
      role="button"
      tabIndex={confirmingDelete ? -1 : 0}
      aria-label={classroom.name}
      className={cn('group flex min-h-[350px] cursor-pointer flex-col overflow-hidden', CARD_RECIPE)}
      onClick={confirmingDelete ? undefined : onClick}
      onKeyDown={(e) => {
        // 只认落在卡片本身的按键：卡内的重命名输入框、删除/改名按钮的回车空格
        // 会冒泡上来，不拦就会顺手把课打开
        if (e.target !== e.currentTarget) return;
        if (confirmingDelete || editing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* 封面：固定 h-[168px]，渐变兜底 + 进度细条（配方⑱） */}
      <CourseCover
        name={classroom.name}
        slide={slide}
        progress={progress}
        className="h-[168px] shrink-0"
      >
        {showModeBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={modeBadgeLabel}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'absolute bottom-3 left-2 z-10 inline-flex size-5 items-center justify-center rounded-full bg-card/80 backdrop-blur-sm',
                  isTaskEngineMode
                    ? 'text-yellow-deep ring-1 ring-yellow-deep/35'
                    : 'text-blue-deep ring-1 ring-blue-deep/30',
                )}
              >
                <ModeBadgeIcon className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              sideOffset={-4}
              collisionPadding={0}
              className="text-xs"
            >
              {modeBadgeLabel}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Delete / rename — top-right, only on hover */}
        <AnimatePresence>
          {!confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {/* opacity-0 + group-hover 显形的按钮同时也是可聚焦的：键盘 Tab 走到这里
                  焦点落在一个看不见的按钮上（2.4.7）。补 focus-visible:opacity-100，
                  顺手也让触屏用户能用——触屏没有 hover，这两个按钮原来永远不显形。 */}
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-2 size-7 rounded-full bg-black/30 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-destructive/80 hover:text-white"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(classroom.id, e);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-11 size-7 rounded-full bg-black/30 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/50 hover:text-white"
                onClick={startRename}
              >
                <Pencil className="size-3.5" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline delete confirmation overlay */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-sm font-medium text-white/90">
                {t('classroom.deleteConfirmTitle')}?
              </span>
              <div className="flex gap-2">
                <button
                  className="rounded-lg bg-white/15 px-3.5 py-1 text-sm font-medium text-white/80 backdrop-blur-sm transition-colors hover:bg-white/25"
                  onClick={onCancelDelete}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="rounded-lg bg-destructive/90 px-3.5 py-1 text-sm font-medium text-white transition-colors hover:bg-destructive"
                  onClick={onConfirmDelete}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CourseCover>

      {/* 信息区：标题正文档 + 元信息辅助档（规格 2.4） */}
      <div className="flex flex-1 flex-col gap-2 p-5">
        {editing ? (
          <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={commitRename}
              maxLength={100}
              placeholder={t('classroom.renamePlaceholder')}
              className="w-full border-b border-primary/60 bg-transparent text-base font-medium text-foreground outline-none placeholder:text-muted-foreground/40"
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                className="line-clamp-2 min-w-0 cursor-text text-base font-medium text-foreground"
                onDoubleClick={startRename}
              >
                {classroom.name}
              </p>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              sideOffset={4}
              className="!max-w-[min(90vw,32rem)] break-words whitespace-normal"
            >
              <div className="flex items-center gap-1.5">
                <span className="break-all">{classroom.name}</span>
                <button
                  className="shrink-0 rounded p-0.5 transition-colors hover:bg-foreground/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(classroom.name);
                    toast.success(t('classroom.nameCopied'));
                  }}
                >
                  <Copy className="size-3 opacity-60" />
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        <div className="mt-auto">
          <span className="inline-flex items-center rounded-full bg-purple-soft px-2 py-0.5 text-xs font-medium text-purple-deep">
            {classroom.sceneCount} {t('classroom.slides')} · {formatDate(classroom.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}
