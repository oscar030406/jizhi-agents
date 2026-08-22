'use client';

import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { Whiteboard } from '@/components/whiteboard';
import { CanvasToolbar } from '@/components/canvas/canvas-toolbar';
import type { CanvasToolbarProps } from '@/components/canvas/canvas-toolbar';
import type { Scene, StageMode } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ClassroomCompletePageConnected } from '@/components/scene-renderers/classroom-complete';
import { WorkshopFeed } from '@/components/generation/workshop-feed';
import { SceneCompanion } from '@/components/agents/scene-companion';
import { LectureView } from '@/components/lecture-view';
import { LiveLectureDraft } from '@/components/generation/live-lecture-draft';
import { useLectureDraftStore } from '@/lib/store/lecture-draft';
import { useStageStore } from '@/lib/store';
import { useWorkshopStore, type WorkshopTone } from '@/lib/store/workshop';

interface CanvasAreaProps extends CanvasToolbarProps {
  readonly currentScene: Scene | null;
  readonly mode: StageMode;
  readonly hideToolbar?: boolean;
  readonly isPendingScene?: boolean;
  readonly isCourseComplete?: boolean;
  readonly isGenerationFailed?: boolean;
  readonly onRetryGeneration?: () => void;
  /** 场景切换闸门，透传到 SceneRenderer → QuizView 的「跳转过去」。 */
  readonly onRequestSceneSwitch?: (sceneId: string) => Promise<boolean>;
}

export function CanvasArea({
  currentScene,
  currentSceneIndex,
  scenesCount,
  mode,
  engineState,
  isLiveSession,
  isSoftClosing,
  softCloseDeadline,
  whiteboardOpen,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onPlayPause,
  onWhiteboardClose,
  isPresenting,
  onTogglePresentation,
  showStopDiscussion,
  onStopDiscussion,
  onContinueDiscussion,
  hideToolbar,
  isPendingScene,
  isCourseComplete,
  isGenerationFailed,
  onRetryGeneration,
  onRequestSceneSwitch,
}: CanvasAreaProps) {
  const { t } = useI18n();
  // 讲义真形态（2026-08-03 定稿）：slide 场景=讲义阅读页，拆掉 16:9 卡片壳/
  // 页码水印/中央播放浮层，全高滚动文档流。播放控制只留工具栏按钮。
  const isLectureScene = currentScene?.type === 'slide';

  return (
    <div className="w-full h-full flex flex-col bg-background group/canvas">
      {/* Slide area — takes remaining space */}
      <div
        className={cn(
          'flex-1 min-h-0 relative overflow-hidden transition-colors duration-500',
          !isLectureScene && 'flex items-center justify-center p-2',
          currentScene?.type === 'interactive' ? 'bg-blue-soft/30' : 'bg-background',
        )}
      >
        {/* 画布边框语言统一：rounded-xl border + shadow-card（规格2.3/2.5⑭）；
            讲义场景无壳全宽 */}
        <div
          className={cn(
            'overflow-hidden relative',
            isLectureScene
              ? 'w-full h-full bg-background'
              : 'aspect-[16/9] h-full max-h-full max-w-full bg-card shadow-card rounded-xl transition-all duration-700',
            !isLectureScene &&
              (currentScene?.type === 'interactive'
                ? 'border border-blue-deep/20'
                : 'border border-border'),
          )}
        >
          {/* Whiteboard Layer */}
          <div className="absolute inset-0 z-[110] pointer-events-none">
            <SceneProvider>
              <Whiteboard isOpen={whiteboardOpen} onClose={onWhiteboardClose} />
            </SceneProvider>
          </div>

          {/* Scene Content */}
          {currentScene && !whiteboardOpen && (
            <div className="absolute inset-0">
              <SceneProvider>
                <SceneRenderer
                  scene={currentScene}
                  mode={mode}
                  onRequestSceneSwitch={onRequestSceneSwitch}
                />
              </SceneProvider>
            </div>
          )}

          {/* Pending Scene Loading / Completion Overlay */}
          <AnimatePresence>
            {isPendingScene && !currentScene && isCourseComplete && (
              <motion.div
                key="course-complete"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="absolute inset-0"
              >
                <ClassroomCompletePageConnected />
              </motion.div>
            )}
            {isPendingScene && !currentScene && !isCourseComplete && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
                className="absolute inset-0 z-[105] flex flex-col items-center justify-center gap-5 p-6 bg-card"
              >
                {isGenerationFailed ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
                      <svg
                        className="w-6 h-6 text-red-400 dark:text-red-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                        />
                      </svg>
                    </div>
                    <span className="text-sm text-red-500 dark:text-red-400 font-medium">
                      {t('stage.generationFailed')}
                    </span>
                    {onRetryGeneration && (
                      <button
                        onClick={onRetryGeneration}
                        className="mt-1 px-4 py-1.5 text-xs font-medium rounded-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95"
                      >
                        {t('generation.retryScene')}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex w-full max-w-2xl flex-col items-center gap-4">
                    {/* 造课直播：下一页讲义流式成稿实时可读（等待期即阅读期）。
                        无草稿时退回骨架逐块点亮（规格3.1第6条⑨）。 */}
                    <PendingSceneLive onRetry={onRetryGeneration} />
                  </div>
                )}
                {/* 车间面板：流水线各阶段的真实事件流。无事件时自渲染 null，
                    退化回原本的纯 spinner 视图（永不编造步骤）。 */}
                <WorkshopFeed className="max-h-[55%]" />
              </motion.div>
            )}
          </AnimatePresence>

          {/* 导学引路小人：右侧导学栏收着时，阿问站在留白处招手，点一下把栏拉开。
              放在画布里而不是视口上，栏一展开画布变窄，她自己让位（也会随即退场）。 */}
          <SceneCompanion
            scene={currentScene ?? null}
            chatCollapsed={chatCollapsed}
            onToggleChat={onToggleChat}
          />

          {/* Scene Number Badge（讲义阅读页不叠水印） */}
          {currentScene && !isLectureScene && (
            <div className="absolute top-4 right-4 text-foreground/10 font-black text-4xl pointer-events-none select-none mix-blend-multiply dark:mix-blend-screen">
              {(currentSceneIndex + 1).toString().padStart(2, '0')}
            </div>
          )}
        </div>
      </div>

      {/* 讲义视图 overlay（同课双形态 lite）：store 驱动，零 props 钻孔 */}
      <LectureView />

      {/* ── Canvas Toolbar — in document flow, only when not merged into roundtable ── */}
      {!hideToolbar && (
        <CanvasToolbar
          className={cn('shrink-0 h-9 px-2', 'bg-card', 'border-t border-border-subtle')}
          currentSceneIndex={currentSceneIndex}
          scenesCount={scenesCount}
          engineState={engineState}
          isLiveSession={isLiveSession}
          isSoftClosing={isSoftClosing}
          softCloseDeadline={softCloseDeadline}
          whiteboardOpen={whiteboardOpen}
          sidebarCollapsed={sidebarCollapsed}
          chatCollapsed={chatCollapsed}
          onToggleSidebar={onToggleSidebar}
          onToggleChat={onToggleChat}
          onPrevSlide={onPrevSlide}
          onNextSlide={onNextSlide}
          onPlayPause={onPlayPause}
          onWhiteboardClose={onWhiteboardClose}
          isPresenting={isPresenting}
          onTogglePresentation={onTogglePresentation}
          showStopDiscussion={showStopDiscussion}
          onStopDiscussion={onStopDiscussion}
          onContinueDiscussion={onContinueDiscussion}
        />
      )}
    </div>
  );
}

/**
 * 生成等待骨架 —— 课程骨架逐块点亮（规格 3.1 第 6 条⑨）。
 *
 * 标题条 + 内容块×3，各绑定流水线一个阶段（诊断绿/检索蓝/拼装紫/审核黄），
 * 语义色与 workshop-feed 行一致。workshop store 出现对应色事件即视为该阶段
 * 已有产出，块从 muted 脉动过渡到粉彩；无事件时整组保持 muted 脉动。
 * 只读真实事件，永不编造进度。
 */
const SKELETON_STAGES: ReadonlyArray<{ tone: WorkshopTone; lit: string; block: string }> = [
  { tone: 'green', lit: 'bg-green-soft', block: 'h-5 w-3/5' },
  { tone: 'blue', lit: 'bg-blue-soft', block: 'h-9 w-full' },
  { tone: 'purple', lit: 'bg-purple-soft', block: 'h-9 w-full' },
  { tone: 'yellow', lit: 'bg-yellow-soft', block: 'h-9 w-11/12' },
];

function GenerationSkeleton() {
  const events = useWorkshopStore((s) => s.events);
  return (
    <div className="w-full space-y-2.5" aria-hidden>
      {SKELETON_STAGES.map(({ tone, lit, block }) => {
        const isLit = events.some((e) => e.tone === tone);
        return (
          <div
            key={tone}
            className={cn(
              'rounded-lg transition-colors duration-300',
              block,
              isLit ? lit : 'bg-muted animate-pulse',
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * 待生成区主体：有讲义草稿在流→直播成稿（等待期即阅读期）；
 * 无草稿（quiz/interactive 场景或流未开始）→骨架逐块点亮。
 * 生成循环没在跑（中断/刷新后 resume 掉链）时露出重试入口——
 * 「永远生成中」且无按钮是实测翻过的车（2026-08-04 主线收尾）。
 */
function PendingSceneLive({ onRetry }: { readonly onRetry?: () => void }) {
  const { t } = useI18n();
  const hasDraft = useLectureDraftStore((s) =>
    Object.values(s.drafts).some((d) => !d.done && d.md.trim().length > 0),
  );
  const generationStatus = useStageStore((s) => s.generationStatus);
  const stalled = generationStatus !== 'generating' && generationStatus !== 'completed';
  if (hasDraft) return <LiveLectureDraft />;
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4">
      <GenerationSkeleton />
      <motion.span
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.3 }}
        className="text-sm text-muted-foreground font-medium"
      >
        {stalled ? t('stage.generationStalled') : t('stage.generatingNextPage')}
      </motion.span>
      {stalled && onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-1.5 text-xs font-medium rounded-full bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-colors active:scale-95"
        >
          {t('stage.regenerateScene')}
        </button>
      )}
    </div>
  );
}
