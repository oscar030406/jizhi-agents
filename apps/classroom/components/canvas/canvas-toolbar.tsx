'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  BookOpen,
  PencilLine,
  LayoutList,
  MessageSquare,
  Volume1,
  Volume2,
  VolumeX,
  Repeat,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { useLectureViewStore } from '@/lib/store/lecture-view';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSoftCloseCountdown } from '@/components/chat/use-soft-close-countdown';

export interface CanvasToolbarProps {
  readonly currentSceneIndex: number;
  readonly scenesCount: number;
  readonly engineState: 'idle' | 'playing' | 'paused';
  readonly isLiveSession?: boolean;
  readonly isSoftClosing?: boolean;
  readonly softCloseDeadline?: number;
  readonly whiteboardOpen: boolean;
  readonly sidebarCollapsed?: boolean;
  readonly chatCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
  readonly onToggleChat?: () => void;
  readonly onPrevSlide: () => void;
  readonly onNextSlide: () => void;
  readonly onPlayPause: () => void;
  readonly onWhiteboardClose: () => void;
  readonly showStopDiscussion?: boolean;
  readonly onStopDiscussion?: () => void;
  readonly onContinueDiscussion?: () => void;
  readonly isPresenting?: boolean;
  readonly onTogglePresentation?: () => void;
  readonly className?: string;
  // Audio/playback controls
  readonly ttsEnabled?: boolean;
  readonly ttsMuted?: boolean;
  readonly ttsVolume?: number;
  readonly onToggleMute?: () => void;
  readonly onVolumeChange?: (volume: number) => void;
  readonly autoPlayLecture?: boolean;
  readonly onToggleAutoPlay?: () => void;
  readonly playbackSpeed?: number;
  readonly onCycleSpeed?: () => void;
}

/* Compact control button — 暖灰语义 token（规格2.1⑬） */
const ctrlBtn = cn(
  'relative w-7 h-7 rounded-md flex items-center justify-center',
  'transition-all duration-150 outline-none cursor-pointer',
  'hover:bg-accent active:scale-90',
);

/* Subtle separator */
function CtrlDivider() {
  return <div className="w-px h-3 bg-border-subtle mx-0.5 shrink-0" />;
}

/* Volume icon based on level */
function VolumeIcon({
  muted,
  volume,
  disabled,
}: {
  muted: boolean;
  volume: number;
  disabled: boolean;
}) {
  const cls = 'w-3.5 h-3.5';
  if (disabled || muted || volume === 0) return <VolumeX className={cls} />;
  if (volume < 0.5) return <Volume1 className={cls} />;
  return <Volume2 className={cls} />;
}

export function CanvasToolbar({
  currentSceneIndex,
  scenesCount,
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
  showStopDiscussion,
  onStopDiscussion,
  onContinueDiscussion,
  isPresenting,
  onTogglePresentation,
  className,
  ttsEnabled,
  ttsMuted,
  ttsVolume = 1,
  onToggleMute,
  onVolumeChange,
  autoPlayLecture,
  onToggleAutoPlay,
  playbackSpeed = 1,
  onCycleSpeed,
}: CanvasToolbarProps) {
  const { t } = useI18n();
  const remainingSoftCloseSeconds = useSoftCloseCountdown(softCloseDeadline);
  const canGoPrev = currentSceneIndex > 0;
  const canGoNext = currentSceneIndex < scenesCount - 1;
  const showPlayPause = !isLiveSession;

  const whiteboardElementCount = useStageStore(
    (s) => s.stage?.whiteboard?.[0]?.elements?.length || 0,
  );

  // Volume slider hover state
  const [volumeHover, setVolumeHover] = useState(false);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const volumeContainerRef = useRef<HTMLDivElement>(null);

  const handleVolumeEnter = useCallback(() => {
    clearTimeout(volumeTimerRef.current);
    setVolumeHover(true);
  }, []);

  const handleVolumeLeave = useCallback(() => {
    volumeTimerRef.current = setTimeout(() => setVolumeHover(false), 300);
  }, []);

  // Cleanup volume hover timer on unmount
  useEffect(() => () => clearTimeout(volumeTimerRef.current), []);

  // Effective volume for display
  const effectiveVolume = ttsMuted ? 0 : ttsVolume;
  const presentationLabel = isPresenting ? t('stage.exitFullscreen') : t('stage.fullscreen');

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* ── Left: sidebar toggle + page indicator ── */}
      <div className="flex items-center gap-1 shrink-0 pl-1">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              sidebarCollapsed ? 'text-muted-foreground/70' : 'text-foreground/80',
            )}
            aria-label="Toggle sidebar"
          >
            <LayoutList className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="text-[11px] text-muted-foreground tabular-nums select-none font-medium">
          {currentSceneIndex + 1}
          <span className="opacity-35 mx-px">/</span>
          {scenesCount}
        </span>
      </div>

      <CtrlDivider />

      {/* ── Center: unified playback controls ── */}
      <div className="flex-1 flex items-center justify-center min-w-0">
        <div
          className={cn(
            'inline-flex items-center gap-0.5 px-1 h-7',
            isPresenting
              ? '' /* Single visual layer in fullscreen — buttons sit inside outer pill directly */
              : 'bg-muted rounded-lg',
          )}
        >
          {/* Volume with vertical popover slider */}
          {onToggleMute && (
            <div
              ref={volumeContainerRef}
              className="relative flex items-center"
              onMouseEnter={handleVolumeEnter}
              onMouseLeave={handleVolumeLeave}
            >
              <button
                onClick={onToggleMute}
                disabled={!ttsEnabled}
                className={cn(
                  ctrlBtn,
                  'w-6 h-6',
                  !ttsEnabled
                    ? 'text-muted-foreground/40 cursor-not-allowed'
                    : ttsMuted
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                )}
                aria-label={ttsMuted ? 'Unmute' : 'Mute'}
              >
                <VolumeIcon muted={!!ttsMuted} volume={ttsVolume} disabled={!ttsEnabled} />
              </button>

              {/* Vertical volume slider (pops up above) */}
              <div
                className={cn(
                  'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex flex-col items-center',
                  'transition-all duration-200 ease-out pointer-events-none opacity-0',
                  volumeHover && ttsEnabled && 'pointer-events-auto opacity-100',
                )}
              >
                <div className="bg-card border border-border rounded-lg shadow-dropdown px-2 py-2.5 flex flex-col items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground tabular-nums font-medium select-none">
                    {Math.round(effectiveVolume * 100)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={effectiveVolume}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      onVolumeChange?.(v);
                      if (v > 0 && ttsMuted) onToggleMute?.();
                    }}
                    className={cn(
                      'appearance-none cursor-pointer',
                      'h-16 w-1 rounded-full',
                      'bg-muted',
                      '[writing-mode:vertical-lr] [direction:rtl]',
                      '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3',
                      '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary',
                      '[&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer',
                      '[&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3',
                      '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0',
                    )}
                  />
                </div>
                {/* Arrow pointing down */}
                <div className="w-2 h-2 bg-card border-b border-r border-border rotate-45 -mt-[5px]" />
              </div>
            </div>
          )}

          {/* Speed */}
          {onCycleSpeed && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onCycleSpeed}
                    className={cn(
                      'w-8 h-5 rounded flex items-center justify-center',
                      'transition-all duration-150 outline-none cursor-pointer',
                      'text-[11px] font-semibold tabular-nums leading-none',
                      'active:scale-90',
                      playbackSpeed !== 1
                        ? 'text-primary bg-purple-soft'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    aria-label="Playback speed"
                  >
                    {playbackSpeed === 1.5 ? '1.5x' : `${playbackSpeed}x`}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('roundtable.speed')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <CtrlDivider />

          {/* Prev scene */}
          {scenesCount > 1 && (
            <button
              onClick={onPrevSlide}
              disabled={!canGoPrev}
              className={cn(
                ctrlBtn,
                'w-6 h-6 text-muted-foreground disabled:opacity-20 disabled:pointer-events-none',
              )}
              aria-label="Previous scene"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Play / Pause / Stop Discussion */}
          {showStopDiscussion && onStopDiscussion ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStopDiscussion();
                }}
                className={cn(
                  'flex items-center gap-1.5 h-6 px-2.5 rounded-md',
                  'bg-red-500/10 dark:bg-red-400/10 text-red-600 dark:text-red-400',
                  'text-[11px] font-semibold whitespace-nowrap',
                  'hover:bg-red-500/20 dark:hover:bg-red-400/20 active:scale-95 transition-all cursor-pointer',
                )}
                title={t('roundtable.stopDiscussion')}
              >
                <span className="inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
                {t('roundtable.stopDiscussion')}
              </button>
              {isSoftClosing && onContinueDiscussion && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onContinueDiscussion();
                  }}
                  className="flex items-center gap-1.5 h-6 px-2.5 rounded-md border border-purple-deep/20 bg-purple-soft text-primary text-[11px] font-semibold whitespace-nowrap hover:bg-purple-soft/70 active:scale-95 transition-all cursor-pointer"
                  title={t('roundtable.softClosing')}
                >
                  {t('roundtable.softClosing')}
                  {remainingSoftCloseSeconds !== undefined && (
                    <span className="text-[9px] font-medium tabular-nums text-muted-foreground">
                      {remainingSoftCloseSeconds}s
                    </span>
                  )}
                </button>
              )}
            </div>
          ) : showPlayPause ? (
            <button
              onClick={onPlayPause}
              className={cn(
                ctrlBtn,
                'w-7 h-6',
                engineState === 'playing' ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-label={engineState === 'playing' ? 'Pause' : 'Play'}
            >
              {engineState === 'playing' ? (
                <Pause className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5 ml-px" />
              )}
            </button>
          ) : null}

          {/* Next scene */}
          {scenesCount > 1 && (
            <button
              onClick={onNextSlide}
              disabled={!canGoNext}
              className={cn(
                ctrlBtn,
                'w-6 h-6 text-muted-foreground disabled:opacity-20 disabled:pointer-events-none',
              )}
              aria-label="Next scene"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}

          <CtrlDivider />

          {/* Auto-play */}
          {onToggleAutoPlay && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onToggleAutoPlay}
                    className={cn(
                      ctrlBtn,
                      'w-8 h-6',
                      autoPlayLecture ? 'text-primary' : 'text-muted-foreground',
                    )}
                    aria-label="Auto-play"
                  >
                    <Repeat className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {autoPlayLecture ? t('roundtable.autoPlayOff') : t('roundtable.autoPlay')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* 讲义视图（同课双形态 lite）：store 直连，零 props */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              useLectureViewStore.getState().toggle();
            }}
            className={cn(ctrlBtn, 'w-6 h-6 text-muted-foreground')}
            title={t('stage.lectureView')}
            aria-label={t('stage.lectureView')}
          >
            <BookOpen className="w-3.5 h-3.5" />
          </button>

          {/* Whiteboard */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onWhiteboardClose();
            }}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              whiteboardOpen ? 'text-primary' : 'text-muted-foreground',
            )}
            title={whiteboardOpen ? t('whiteboard.minimize') : t('whiteboard.open')}
          >
            <PencilLine className="w-3.5 h-3.5" />
            {!whiteboardOpen && whiteboardElementCount > 0 && (
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-primary rounded-full" />
            )}
          </button>
        </div>
      </div>

      {/* ── Right: fullscreen + chat toggle ── */}
      <div className="flex items-center justify-end gap-px shrink-0 pr-1">
        <CtrlDivider />
        {onTogglePresentation && (
          <button
            onClick={onTogglePresentation}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              isPresenting ? 'text-primary' : 'text-muted-foreground',
            )}
            aria-label={presentationLabel}
            title={presentationLabel}
          >
            {isPresenting ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {onToggleChat && (
          <button
            onClick={onToggleChat}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              chatCollapsed ? 'text-muted-foreground/70' : 'text-foreground/80',
            )}
            aria-label="Toggle chat"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
