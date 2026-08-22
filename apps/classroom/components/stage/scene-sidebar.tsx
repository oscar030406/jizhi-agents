'use client';

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  PanelLeftClose,
  PieChart,
  Cpu,
  MousePointer2,
  BookOpen,
  Globe,
  AlertCircle,
  RefreshCw,
  Trophy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailInteractive } from '@/components/slide-renderer/components/ThumbnailInteractive';
import { useStageStore, useCanvasStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { Scene, SceneType, SlideContent, InteractiveContent } from '@/lib/types/stage';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { SceneAuditBadge } from '@/components/stage/scene-audit-badge';
import { MasteryStrip } from '@/components/stage/mastery-strip';
import { EmptyState } from '@/components/ui/empty-state';
import { isProceduralScene } from '@/lib/export/practice-guide';

/** 实践取向标题的宽松匹配。命中只说明「讲的是实践」，不代表有可执行步骤。 */
const PRACTICE_TITLE_RE = /实操|实践|动手|上手|操作步骤|代码演示|运行/;

/** 资源形态徽标（赛题第五(2)款点名的三种形态显式化）：
    定制讲义默认不标（就是主体）；实操段落、分阶测验、教具、实战任务标出。
    「分阶」依据=诊断蓝图的测验难度带按画像定档（agents 页学情诊断卡同口径）。

    「实操指南」只认正源形态 procedural-skill（判别复用实操指南导出的同一函数，
    口径变了两处一起变）。标题里带「实操/实践」但没有步骤序列结构的讲义页仍标出来，
    但文案降级为「实践建议」——它确实是实践取向的讲解，只是不是一份可照做的指南。

    返回 i18n 键而非文案，纯函数好单测（tests/components/scene-form-badge.test.ts）。 */
export function formBadgeKey(scene: Scene): string | null {
  if (isProceduralScene(scene)) return 'stage.formBadge.practice';
  if (scene.type === 'quiz') return 'stage.formBadge.quiz';
  if (scene.type === 'interactive') return 'stage.formBadge.interactive';
  if (scene.type === 'pbl') return 'stage.formBadge.pbl';
  if (PRACTICE_TITLE_RE.test(scene.title)) return 'stage.formBadge.practiceTip';
  return null;
}

interface SceneSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect?: (sceneId: string) => void;
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  readonly isCourseComplete?: boolean;
}

// 默认宽度移到 settings store（sidebarWidth: 220），这里不再留第二处
const MIN_WIDTH = 170;
const MAX_WIDTH = 400;

export function SceneSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
  onRetryOutline,
  isCourseComplete,
}: SceneSidebarProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { scenes, currentSceneId, setCurrentSceneId, generatingOutlines, generationStatus } =
    useStageStore();
  const failedOutlines = useStageStore.use.failedOutlines();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  const [retryingOutlineId, setRetryingOutlineId] = useState<string | null>(null);

  const handleRetryOutline = async (outlineId: string) => {
    if (!onRetryOutline) return;
    setRetryingOutlineId(outlineId);
    try {
      await onRetryOutline(outlineId);
    } finally {
      setRetryingOutlineId(null);
    }
  };

  // 拖拽改宽。这一套照抄 components/edit/SlideNavRail/SlideNavRail.tsx——
  // 那边已经从 document mousemove/mouseup 改成 Pointer Events + setPointerCapture，
  // 同一个组件里解决同一个问题两遍没有意义。改动带来三件事：
  //   1. 触屏和手写笔能拖了（mousedown 系列在触屏上根本不触发）
  //   2. 指针移出窗口、切标签、被系统抢焦点时 pointerup/pointercancel 照样回到手柄，
  //      而 document mouseup 在这些情况下不触发，侧栏会卡在「还在拖」的状态直到重挂载
  //   3. 宽度进 settings store 持久化——折叠状态本来就在里面，宽度不在，
  //      拖完一刷新弹回 220px
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const setSidebarWidth = useSettingsStore((s) => s.setSidebarWidth);
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    lastWidth: number;
    pointerId: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // 只认左键，右键/中键不拖
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 按规范只会抛 InvalidPointerId，同一次 pointerdown 里不该发生。
        // 真失败了窗口内拖拽仍然可用，所以不中断手势。
      }
      dragRef.current = {
        startX: e.clientX,
        startWidth: sidebarWidth,
        lastWidth: sidebarWidth,
        pointerId: e.pointerId,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      setIsDragging(true);
    },
    [sidebarWidth],
  );

  // 拖动期间直接写 DOM 的 style.width，绕开 React 一轮渲染——手柄才跟得住光标。
  // 最终宽度在 pointerup 时一次性提交进 store。
  const handleDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startWidth + (e.clientX - drag.startX)));
    drag.lastWidth = next;
    if (railRef.current) railRef.current.style.width = `${next}px`;
  }, []);

  const handleDragEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // pointercancel 可能已经先释放过了
      }
      setSidebarWidth(drag.lastWidth);
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsDragging(false);
    },
    [setSidebarWidth],
  );

  // 手柄原来只认指针事件，键盘用户改不了宽度（WCAG 2.1.1）。补齐 window-splitter
  // 的最小形态：左右方向键每次 16px（与站内间距基数一致），Home/End 直接到两端。
  const resizeOnKey = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 48 : 16;
      const next =
        e.key === 'ArrowLeft'
          ? sidebarWidth - step
          : e.key === 'ArrowRight'
            ? sidebarWidth + step
            : e.key === 'Home'
              ? MIN_WIDTH
              : e.key === 'End'
                ? MAX_WIDTH
                : null;
      if (next === null) return;
      e.preventDefault();
      setSidebarWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
    },
    [sidebarWidth, setSidebarWidth],
  );

  const getSceneTypeIcon = (type: SceneType) => {
    const icons = {
      slide: BookOpen,
      quiz: PieChart,
      interactive: MousePointer2,
      pbl: Cpu,
    };
    return icons[type] || BookOpen;
  };

  const formBadge = (scene: Scene): string | null => {
    const key = formBadgeKey(scene);
    return key ? t(key) : null;
  };

  // 侧栏三种缩略图卡片（已生成页 / 生成中占位 / 结课占位）原来都是 `<div onClick>`，
  // 实测 tabIndex=-1、role=null——键盘完全够不着，只能用鼠标翻页（WCAG 2.1.1）。
  // 不换成 <button>：卡片里嵌了教具 iframe 和重试按钮，套进 button 是非法嵌套。
  // 共用一个键盘激活器，三处行为一致，别在每个卡片里各写一份。
  const activateOnKey = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); // 空格默认滚动整条列表
    fn();
  };
  // 焦点环：2px 实线 purple-500，实测对卡片底 3.5:1（亮）/ 3.2:1（暗），过 1.4.11 的 3:1
  const FOCUS_RING =
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500';

  const displayWidth = collapsed ? 0 : sidebarWidth;

  // 窄屏（<768px）侧栏改成浮层。三栏并排在 375px 下量到：侧栏 220 + 导学 320
  // 超出视口，外层 overflow-hidden 把画布挤成 0 宽、侧栏被顶到 x=-168 且滚不回来。
  // 浮层之后画布拿回整宽，侧栏盖在上面，用它自带的折叠按钮关掉。
  return (
    <div
      ref={railRef}
      style={{
        width: displayWidth,
        transition: isDragging ? 'none' : 'width 0.3s ease',
      }}
      className="bg-card border-r border-border flex flex-col shrink-0 z-20 overflow-visible absolute inset-y-0 left-0 shadow-dropdown md:relative md:inset-auto md:shadow-none"
    >
      {/* 拖拽手柄。视觉仍是那条 6px 细线，但命中区放宽到 16px 并往右让出 5px
          （-right-[5px] + w-4）——6px 的目标触屏按不中，鼠标也难瞄。
          touch-action: none 是 Pointer Events 在触屏上的必要条件，否则浏览器
          会把横向拖当成滚动手势自己吃掉。 */}
      {!collapsed && (
        <div
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onKeyDown={resizeOnKey}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          tabIndex={0}
          style={{ touchAction: 'none' }}
          className={cn(
            'absolute -right-[5px] top-0 bottom-0 w-4 cursor-col-resize z-50 group flex justify-end',
            FOCUS_RING,
          )}
        >
          <div className="w-1.5 h-full hover:bg-purple-400/30 dark:hover:bg-purple-600/30 group-active:bg-purple-500/40 transition-colors" />
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-purple-400 dark:group-hover:bg-purple-500 transition-colors" />
        </div>
      )}

      <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
        {/* Logo Header */}
        <div className="h-10 flex items-center justify-between shrink-0 relative mt-3 mb-1 px-3">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 cursor-pointer rounded-lg px-1.5 -mx-1.5 py-1 -my-1 hover:bg-accent active:scale-[0.97] transition-all duration-150"
            title={t('generation.backToHome')}
          >
            <span className="font-serif text-lg font-semibold tracking-[0.12em] text-foreground">
              集智
            </span>
          </button>
          <button
            onClick={() => onCollapseChange(true)}
            className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-muted text-muted-foreground hover:bg-accent hover:text-foreground active:scale-90 transition-all duration-200"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* 掌握条：这门课学到哪了 + 下一步。全新学习者无数据时自己不渲染。 */}
        <MasteryStrip scenes={scenes} />

        {/* Scenes List */}
        <div
          data-testid="scene-list"
          className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-2 scrollbar-hide pt-1"
        >
          {scenes.map((scene, index) => {
            const isActive = currentSceneId === scene.id;
            const Icon = getSceneTypeIcon(scene.type);
            const isSlide = scene.type === 'slide';
            const isInteractive = scene.type === 'interactive';
            const slideContent = isSlide ? (scene.content as SlideContent) : null;
            const interactiveContent = isInteractive ? (scene.content as InteractiveContent) : null;

            const select = () =>
              onSceneSelect ? onSceneSelect(scene.id) : setCurrentSceneId(scene.id);

            return (
              <div
                key={scene.id}
                data-testid="scene-item"
                role="button"
                tabIndex={0}
                aria-current={isActive ? 'true' : undefined}
                aria-label={`第 ${index + 1} 页 ${scene.title}`}
                onClick={select}
                onKeyDown={activateOnKey(select)}
                className={cn(
                  'group relative rounded-lg transition-all duration-200 cursor-pointer flex flex-col gap-1 p-1.5',
                  FOCUS_RING,
                  // 选中态：purple-soft 底 + 同色系 deep 描边（规格2.2⑲）
                  isActive ? 'bg-purple-soft ring-1 ring-purple-deep/20' : 'hover:bg-accent',
                )}
              >
                {/* Scene Header */}
                <div className="flex justify-between items-center px-2 pt-0.5">
                  <div className="flex items-center gap-2 max-w-full">
                    <span
                      className={cn(
                        'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                        isActive
                          ? 'bg-primary text-primary-foreground dark:text-white'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {index + 1}
                    </span>
                    <span
                      data-testid="scene-title"
                      className={cn(
                        'text-xs font-bold truncate transition-colors',
                        isActive
                          ? 'text-purple-deep'
                          : 'text-muted-foreground group-hover:text-foreground',
                      )}
                    >
                      {scene.title}
                    </span>
                    {formBadge(scene) && (
                      <span className="shrink-0 rounded-full bg-blue-soft px-1.5 py-px text-[9px] font-medium text-blue-deep">
                        {formBadge(scene)}
                      </span>
                    )}
                    <SceneAuditBadge audit={scene.audit} />
                  </div>
                </div>

                {/* Thumbnail */}
                <div className="relative aspect-video w-full rounded overflow-hidden bg-gray-100 dark:bg-gray-800 ring-1 ring-black/5 dark:ring-white/5">
                  <div className="absolute inset-0 flex items-center justify-center">
                    {isSlide && slideContent ? (
                      <SlideThumbnail
                        slide={slideContent.canvas}
                        viewportSize={viewportSize}
                        viewportRatio={viewportRatio}
                        size={Math.max(100, sidebarWidth - 28)}
                      />
                    ) : scene.type === 'quiz' ? (
                      /* Quiz: question bar + 2x2 option grid */
                      <div className="w-full h-full bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/20 p-2 flex flex-col">
                        <div className="h-1.5 w-4/5 bg-orange-200/70 dark:bg-orange-700/30 rounded-full mb-1.5" />
                        <div className="flex-1 grid grid-cols-2 gap-1">
                          {[0, 1, 2, 3].map((i) => (
                            <div
                              key={i}
                              className={cn(
                                'rounded flex items-center gap-1 px-1',
                                i === 1
                                  ? 'bg-orange-400/20 dark:bg-orange-500/20 border border-orange-300/50 dark:border-orange-600/30'
                                  : 'bg-white/60 dark:bg-white/5 border border-orange-100/60 dark:border-orange-800/20',
                              )}
                            >
                              <div
                                className={cn(
                                  'w-1.5 h-1.5 rounded-full shrink-0',
                                  i === 1
                                    ? 'bg-orange-400 dark:bg-orange-500'
                                    : 'bg-orange-200 dark:bg-orange-700/50',
                                )}
                              />
                              <div
                                className={cn(
                                  'h-1 rounded-full flex-1',
                                  i === 1
                                    ? 'bg-orange-300/60 dark:bg-orange-600/40'
                                    : 'bg-orange-100/80 dark:bg-orange-800/30',
                                )}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : scene.type === 'interactive' && interactiveContent?.html ? (
                      /* Interactive: live iframe preview */
                      <ThumbnailInteractive
                        content={interactiveContent}
                        size={Math.max(100, sidebarWidth - 28)}
                      />
                    ) : scene.type === 'interactive' ? (
                      /* Interactive: browser window with chrome + content */
                      <div className="w-full h-full bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20 p-1.5 flex flex-col">
                        <div className="flex items-center gap-1 mb-1 pb-1 border-b border-emerald-200/40 dark:border-emerald-700/20">
                          <div className="flex gap-0.5">
                            <div className="w-1 h-1 rounded-full bg-red-300 dark:bg-red-500/60" />
                            <div className="w-1 h-1 rounded-full bg-amber-300 dark:bg-amber-500/60" />
                            <div className="w-1 h-1 rounded-full bg-green-300 dark:bg-green-500/60" />
                          </div>
                          <div className="h-1.5 flex-1 bg-emerald-200/40 dark:bg-emerald-700/30 rounded-full ml-0.5" />
                        </div>
                        <div className="flex-1 flex gap-1">
                          <div className="w-1/4 space-y-1 pt-0.5">
                            {[1, 2, 3].map((i) => (
                              <div
                                key={i}
                                className="h-0.5 w-full bg-emerald-200/60 dark:bg-emerald-700/30 rounded-full"
                              />
                            ))}
                          </div>
                          <div className="flex-1 bg-emerald-100/40 dark:bg-emerald-800/20 rounded flex items-center justify-center border border-emerald-200/40 dark:border-emerald-700/20">
                            <Globe className="w-4 h-4 text-emerald-300/80 dark:text-emerald-600/50" />
                          </div>
                        </div>
                      </div>
                    ) : scene.type === 'pbl' ? (
                      /* PBL: kanban board with 3 columns */
                      <div className="w-full h-full bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/20 p-1.5 flex flex-col">
                        <div className="flex items-center gap-1 mb-1.5">
                          <div className="w-1.5 h-1.5 rounded bg-blue-300 dark:bg-blue-600" />
                          <div className="h-1 w-8 bg-blue-200/60 dark:bg-blue-700/30 rounded-full" />
                        </div>
                        <div className="flex-1 flex gap-1 overflow-hidden">
                          {[0, 1, 2].map((col) => (
                            <div
                              key={col}
                              className="flex-1 bg-white/50 dark:bg-white/5 rounded p-0.5 flex flex-col gap-0.5"
                            >
                              <div
                                className={cn(
                                  'h-0.5 w-3 rounded-full mb-0.5',
                                  col === 0
                                    ? 'bg-blue-300/70'
                                    : col === 1
                                      ? 'bg-amber-300/70'
                                      : 'bg-green-300/70',
                                )}
                              />
                              {Array.from({
                                length: col === 0 ? 3 : col === 1 ? 2 : 1,
                              }).map((_, i) => (
                                <div
                                  key={i}
                                  className="h-2 w-full bg-blue-100/60 dark:bg-blue-800/20 rounded border border-blue-200/30 dark:border-blue-700/20"
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      /* Fallback */
                      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-gray-50 dark:bg-gray-800 text-gray-300 dark:text-gray-500">
                        <Icon className="w-4 h-4" />
                        <span className="text-[9px] font-bold uppercase tracking-wider opacity-80">
                          {scene.type}
                        </span>
                      </div>
                    )}

                    {isSlide && (
                      <div
                        className={cn(
                          'absolute inset-0 bg-purple-500/0 transition-colors',
                          isActive
                            ? 'bg-purple-500/0'
                            : 'group-hover:bg-black/5 dark:group-hover:bg-white/5',
                        )}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Single placeholder for the next generating page (clickable) */}
          {generatingOutlines.length > 0 &&
            (() => {
              const outline = generatingOutlines[0];
              const isFailed = failedOutlines.some((f) => f.id === outline.id);
              const isRetrying = retryingOutlineId === outline.id;
              const isPaused = generationStatus === 'paused';
              const isActive = currentSceneId === PENDING_SCENE_ID;

              const selectPending = () => {
                if (isFailed) return;
                if (onSceneSelect) onSceneSelect(PENDING_SCENE_ID);
                else setCurrentSceneId(PENDING_SCENE_ID);
              };

              return (
                <div
                  key={`generating-${outline.id}`}
                  role={isFailed ? undefined : 'button'}
                  tabIndex={isFailed ? undefined : 0}
                  aria-label={`第 ${scenes.length + 1} 页 ${outline.title}（${isPaused ? t('stage.paused') : t('stage.generating')}）`}
                  onClick={selectPending}
                  onKeyDown={activateOnKey(selectPending)}
                  className={cn(
                    'group relative rounded-lg flex flex-col gap-1 p-1.5 transition-all duration-200',
                    FOCUS_RING,
                    isFailed ? 'opacity-100 cursor-default' : 'cursor-pointer hover:bg-accent',
                    !isFailed && !isActive && 'opacity-60',
                    isActive && !isFailed && 'bg-purple-soft ring-1 ring-purple-deep/20 opacity-100',
                  )}
                >
                  {/* Scene Header */}
                  <div className="flex justify-between items-center px-2 pt-0.5">
                    <div className="flex items-center gap-2 max-w-full">
                      <span
                        className={cn(
                          'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                          isActive && !isFailed
                            ? 'bg-primary text-primary-foreground dark:text-white'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {scenes.length + 1}
                      </span>
                      <span
                        className={cn(
                          'text-xs font-bold truncate transition-colors',
                          isActive && !isFailed
                            ? 'text-purple-deep'
                            : isFailed
                              ? 'text-foreground'
                              : 'text-muted-foreground',
                        )}
                      >
                        {outline.title}
                      </span>
                    </div>
                  </div>

                  {/* Skeleton Thumbnail */}
                  <div
                    className={cn(
                      'relative aspect-video w-full rounded overflow-hidden ring-1',
                      isFailed
                        ? 'bg-red-50/30 dark:bg-red-950/10 ring-red-100 dark:ring-red-900/20'
                        : 'bg-gray-100 dark:bg-gray-800 ring-black/5 dark:ring-white/5',
                    )}
                  >
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                      {isFailed ? (
                        <div className="flex items-center gap-1 text-xs font-medium text-red-500/90 dark:text-red-400">
                          {onRetryOutline ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRetryOutline(outline.id);
                              }}
                              disabled={isRetrying}
                              className="p-1 -ml-1 rounded-md hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95 disabled:opacity-50 disabled:active:scale-100"
                              title={t('generation.retryScene')}
                            >
                              <RefreshCw
                                className={cn('w-3.5 h-3.5', isRetrying && 'animate-spin')}
                              />
                            </button>
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {isRetrying
                              ? t('generation.retryingScene')
                              : t('stage.generationFailed')}
                          </span>
                        </div>
                      ) : (
                        <>
                          <div
                            className={cn(
                              'h-2 w-3/5 bg-gray-200 dark:bg-gray-700 rounded',
                              !isPaused && 'animate-pulse',
                            )}
                          />
                          <div
                            className={cn(
                              'h-1.5 w-2/5 bg-gray-200 dark:bg-gray-700 rounded',
                              !isPaused && 'animate-pulse',
                            )}
                          />
                          <span className="text-[9px] font-medium text-gray-500 dark:text-gray-400 mt-0.5">
                            {isPaused ? t('stage.paused') : t('stage.generating')}
                          </span>
                        </>
                      )}
                    </div>
                    {!isFailed && !isPaused && (
                      <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/40 dark:via-white/10 to-transparent" />
                    )}
                  </div>
                </div>
              );
            })()}

          {/* Course-complete placeholder (shown when outline is exhausted) */}
          {isCourseComplete &&
            generatingOutlines.length === 0 &&
            (() => {
              const isActive = currentSceneId === PENDING_SCENE_ID;
              const selectComplete = () =>
                onSceneSelect ? onSceneSelect(PENDING_SCENE_ID) : setCurrentSceneId(PENDING_SCENE_ID);
              return (
                <div
                  key="course-complete-slot"
                  role="button"
                  tabIndex={0}
                  aria-current={isActive ? 'true' : undefined}
                  aria-label={t('stage.courseComplete')}
                  onClick={selectComplete}
                  onKeyDown={activateOnKey(selectComplete)}
                  className={cn(
                    'group relative rounded-lg flex flex-col gap-1 p-1.5 transition-all duration-200 cursor-pointer hover:bg-amber-50/60 dark:hover:bg-amber-900/10',
                    FOCUS_RING,
                    !isActive && 'opacity-80',
                    isActive &&
                      'bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-700 opacity-100',
                  )}
                >
                  <div className="flex justify-between items-center px-2 pt-0.5">
                    <div className="flex items-center gap-2 max-w-full">
                      <span
                        className={cn(
                          'text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                          isActive
                            ? 'bg-amber-500 dark:bg-amber-400 text-white shadow-sm shadow-amber-500/30'
                            : 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {scenes.length + 1}
                      </span>
                      <span
                        className={cn(
                          'text-xs font-bold truncate transition-colors',
                          isActive
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-amber-600 dark:text-amber-400',
                        )}
                      >
                        {t('stage.courseComplete')}
                      </span>
                    </div>
                  </div>
                  <div
                    className={cn(
                      'relative aspect-video w-full rounded overflow-hidden ring-1 flex items-center justify-center transition-all',
                      'bg-amber-50/80 dark:bg-amber-950/20',
                      isActive
                        ? 'ring-amber-300 dark:ring-amber-700'
                        : 'ring-amber-100 dark:ring-amber-900/40',
                    )}
                  >
                    {/* soft radial glow */}
                    <div
                      className="absolute inset-0"
                      style={{
                        background:
                          'radial-gradient(circle at 50% 55%, rgba(251, 191, 36, 0.14), transparent 65%)',
                      }}
                    />
                    {/* sparkles (subtle) */}
                    <svg
                      viewBox="0 0 20 20"
                      className="absolute top-1 right-1.5 w-1.5 h-1.5 text-amber-300/70 dark:text-amber-400/60"
                      aria-hidden
                    >
                      <path
                        d="M10 1 L12 8 L19 10 L12 12 L10 19 L8 12 L1 10 L8 8 Z"
                        fill="currentColor"
                      />
                    </svg>
                    <svg
                      viewBox="0 0 20 20"
                      className="absolute bottom-1 left-1.5 w-1 h-1 text-amber-300/60 dark:text-amber-400/50"
                      aria-hidden
                    >
                      <path
                        d="M10 1 L12 8 L19 10 L12 12 L10 19 L8 12 L1 10 L8 8 Z"
                        fill="currentColor"
                      />
                    </svg>
                    <Trophy
                      className="relative w-8 h-8 text-amber-500 dark:text-amber-400"
                      strokeWidth={1.6}
                    />
                  </div>
                </div>
              );
            })()}
          {/* 一页都没有、也没有在生成的终态：整条侧栏原来是空白，看不出是加载没完
              还是这门课就是空的。判据只看「有没有页 + 有没有在生成」，不看 null。 */}
          {scenes.length === 0 && generatingOutlines.length === 0 && !isCourseComplete && (
            <EmptyState title="这门课还没有页面" hint="生成中断或全部失败了，回首页重新造一门，或换一门课进来。" />
          )}
        </div>

        {/* Spacer to push toggle button area */}
        <div className="mt-auto" />
      </div>
    </div>
  );
}
