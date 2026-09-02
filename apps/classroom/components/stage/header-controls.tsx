'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  ClipboardList,
  Download,
  FileDown,
  FileText,
  Loader2,
  Monitor,
  Moon,
  Package,
  Sun,
  Workflow,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useExportClassroom } from '@/lib/export/use-export-classroom';
import {
  ensureMediaFreeExportReady,
  isFullMediaExportReady,
  isMediaFreeExportReady,
  useExportScript,
} from '@/lib/export/use-export-script';
import { exportPracticeGuide, isProceduralScene } from '@/lib/export/practice-guide';
import { isVideoExportEnabled } from '@/lib/config/feature-flags';
import { useVideoRenderStore } from '@/lib/store/video-render';
import { CircularProgress } from '@/components/ui/circular-progress';
import { VideoExportMenu } from './video-export-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  /**
   * `default` — the chunky h-9 pill used in the playback Stage Header.
   * `compact` — slightly tighter padding for embedding in CommandBar's
   * right slot (Pro mode chrome already eats height, so the pill backs
   * off ring weight / blur to keep the CommandBar quiet).
   */
  readonly variant?: 'default' | 'compact';
}

/**
 * Stage-level global controls: theme picker, the 多智能体协同控制台 link,
 * the Pro Switch and the export menu. Extracted out of `Header` so the
 * Pro mode CommandBar can absorb the same affordances and the playback
 * Header doesn't need to stay mounted just to host them — Pro mode
 * therefore lands on a single top-chrome bar instead of stacking the
 * Stage Header above the EditShell CommandBar.
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so dropdown state and refs stay co-located here without
 * cross-instance leakage.
 */
export function HeaderControls({
  mode,
  canEdit,
  onToggleEditMode,
  variant = 'default',
}: HeaderControlsProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  // Export plumbing — uses the stage / media task stores to check
  // readiness, then hands off to the export hooks. Available in both
  // playback and edit chrome so the icon's screen position is stable
  // across mode swaps (was previously in `Header` only, missing from
  // CommandBar's right cluster).
  const scenes = useStageStore((s) => s.scenes);
  const stage = useStageStore((s) => s.stage);
  const stageId = stage?.id;
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const { exporting: isExportingZip, exportClassroomZip } = useExportClassroom();
  const { exportScriptMd } = useExportScript();
  const videoExportEnabled = isVideoExportEnabled();
  // Video render lives in a global store so its progress ring stays on the
  // export button even after the menu closes / scenes switch mid-render.
  const videoRendering = useVideoRenderStore(
    (s) => s.status === 'compiling' || s.status === 'rendering',
  );
  const videoRenderPercent = useVideoRenderStore((s) => s.percent);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  const readinessState = { stage, scenes, generatingOutlines, failedOutlines };
  const mediaFreeExportReady = isMediaFreeExportReady(readinessState);
  const fullMediaExportReady = isFullMediaExportReady(readinessState, mediaTasks);

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (exportMenuOpen && exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    },
    [exportMenuOpen],
  );
  useEffect(() => {
    if (!exportMenuOpen) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen, handleClickOutside]);

  const compact = variant === 'compact';

  // Self-contained spacing so the control cluster is identical regardless of
  // host. The playback Header (`gap-4`) and the edit CommandBar's trailing
  // slot (`gap-2`) would otherwise impose different inter-control spacing on
  // these fragment children, making the pill/switch/export cluster visibly
  // shift width and position across the mode swap. A fixed internal gap keeps
  // the cluster pixel-stable; both hosts pad to `px-8`, so the right edge
  // anchors identically too.
  // 窄屏收紧间距：375px 下量到这一簇 354px 宽，把导出按钮顶到 x=379（视口外），
  // 标题被压成 0 宽。gap 减半 + 下面隐藏「专业模式」四个字，够把导出按钮拉回来。
  return (
    <div className="flex items-center gap-2 md:gap-4">
      <div
        className={cn(
          'shrink-0 flex items-center gap-1 rounded-full border border-border bg-card',
          compact ? 'px-1.5 py-1' : 'px-2 py-1.5',
        )}
      >
        {/* Theme — Portal-backed DropdownMenu so its menu portals to body
            and never gets clipped by an ancestor's overflow-hidden. Non-modal keeps
            Radix from body scroll-locking a fixed-height classroom layout. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              className="p-2 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-all group"
              aria-label={t('settings.theme')}
            >
              {theme === 'light' && <Sun className="w-4 h-4" />}
              {theme === 'dark' && <Moon className="w-4 h-4" />}
              {theme === 'system' && <Monitor className="w-4 h-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[140px]">
            <DropdownMenuItem
              onSelect={() => setTheme('light')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'light' && 'bg-purple-soft text-primary',
              )}
            >
              <Sun className="w-4 h-4" />
              {t('settings.themeOptions.light')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('dark')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'dark' && 'bg-purple-soft text-primary',
              )}
            >
              <Moon className="w-4 h-4" />
              {t('settings.themeOptions.dark')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('system')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'system' && 'bg-purple-soft text-primary',
              )}
            >
              <Monitor className="w-4 h-4" />
              {t('settings.themeOptions.system')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 多智能体协同控制台 — 只读证据页，新标签打开，不打断课堂播放。 */}
        <Link
          href={stageId ? `/agents?classroom=${stageId}` : '/agents'}
          target="_blank"
          rel="noopener"
          title={t('stage.agentConsole')}
          aria-label={t('stage.agentConsole')}
          className="p-2 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-all"
        >
          <Workflow className="w-4 h-4" />
        </Link>
      </div>

      {/* Pro Switch — toggle property: on/off both clickable, not a
          one-way "Done" button. Disabled only when the current scene
          can't be entered (pending/generating/etc.). Fades in with its
          host bar on the mode swap (no cross-bar layoutId morph: the
          playback Header and edit CommandBar have different left-side
          widths, so morphing made the pill visibly drift). */}
      {onToggleEditMode && (
        <label
          className={cn(
            'shrink-0 inline-flex items-center gap-2.5 rounded-full border transition-colors duration-200',
            'bg-card',
            compact ? 'h-8 px-2.5' : 'h-9 px-3',
            mode === 'edit' ? 'border-violet-500/60 dark:border-violet-400/60' : 'border-border',
            !canEdit && mode !== 'edit'
              ? 'opacity-60 cursor-not-allowed'
              : 'cursor-pointer hover:border-violet-400/60 dark:hover:border-violet-500/50',
          )}
          // When disabled (e.g. the course-complete placeholder), explain why
          // on hover and point the user to a real scene instead of a bare
          // "Edit course" label they can't act on.
          title={
            !canEdit && mode !== 'edit'
              ? t('stage.proModeDisabledHint')
              : mode === 'edit'
                ? t('stage.doneEditing')
                : t('stage.editCourse')
          }
        >
          <span
            className={cn(
              // 窄屏只留开关本体，文字让位给导出按钮；label 上的 title 与 Switch 的
              // aria-label 仍然说明它是什么，读屏和悬停都不受影响。
              'hidden md:inline text-[11px] font-bold uppercase tracking-[0.14em] tabular-nums select-none transition-colors duration-200',
              mode === 'edit' ? 'text-violet-600 dark:text-violet-300' : 'text-muted-foreground',
            )}
          >
            {t('edit.proMode')}
          </span>
          <Switch
            checked={mode === 'edit'}
            onCheckedChange={onToggleEditMode}
            disabled={!canEdit && mode !== 'edit'}
            aria-label={mode === 'edit' ? t('stage.doneEditing') : t('stage.editCourse')}
            className="data-[state=checked]:bg-violet-600 dark:data-[state=checked]:bg-violet-500"
          />
        </label>
      )}

      {/* Export / Download — lives to the right of the Pro Switch.
          Not a chrome-level toggle so it stays outside the theme/console
          pill; kept as a separate sibling sitting between the Pro Switch
          and the right edge of the chrome. */}
      <div className="relative" ref={exportRef}>
        <button
          onClick={() => {
            if (
              ensureMediaFreeExportReady(t('share.notReady')) &&
              !isExporting &&
              !isExportingZip
            ) {
              setExportMenuOpen(!exportMenuOpen);
            }
          }}
          disabled={!mediaFreeExportReady || isExporting || isExportingZip}
          title={
            mediaFreeExportReady
              ? isExporting || isExportingZip
                ? t('export.exporting')
                : t('export.pptx')
              : t('share.notReady')
          }
          className={cn(
            'shrink-0 p-2 rounded-full transition-all',
            mediaFreeExportReady && !isExporting && !isExportingZip
              ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'text-muted-foreground/50 cursor-not-allowed opacity-50',
          )}
          aria-label={t('export.pptx')}
        >
          {isExporting || isExportingZip ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : videoRendering ? (
            // Persistent ring: video render runs in the background; keep it
            // visible on the button whether or not the menu is open.
            <CircularProgress value={videoRenderPercent} size={20} className="text-primary" />
          ) : (
            <Download className="w-4 h-4" />
          )}
        </button>
        {exportMenuOpen && (
          <div className="absolute top-full mt-2 right-0 bg-popover border border-border rounded-lg shadow-dropdown overflow-hidden z-50 min-w-[200px]">
            <button
              onClick={() => {
                setExportMenuOpen(false);
                exportPPTX();
              }}
              disabled={!fullMediaExportReady || isExporting}
              title={!fullMediaExportReady ? t('share.notReady') : undefined}
              className="w-full px-4 py-2.5 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FileDown className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <div>{t('export.pptx')}</div>
                {!fullMediaExportReady && (
                  <div className="text-xs text-muted-foreground">{t('share.notReady')}</div>
                )}
              </div>
            </button>
            {/* 讲稿导出 — 把各页 speech 旁白汇成一份 Markdown。文案中文
                （export.scriptMd 未进 locale 词表，与页内其他中文注释同一口径）。 */}
            <button
              onClick={() => {
                setExportMenuOpen(false);
                exportScriptMd();
              }}
              className="w-full px-4 py-2.5 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2.5"
            >
              <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>导出讲稿 (.md)</span>
            </button>
            <button
              onClick={() => {
                setExportMenuOpen(false);
                exportResourcePack();
              }}
              disabled={!fullMediaExportReady || isExporting}
              title={!fullMediaExportReady ? t('share.notReady') : undefined}
              className="w-full px-4 py-2.5 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Package className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <div>{t('export.resourcePack')}</div>
                <div className="text-xs text-muted-foreground">
                  {fullMediaExportReady ? t('export.resourcePackDesc') : t('share.notReady')}
                </div>
              </div>
            </button>
            {scenes.some(isProceduralScene) && (
              <button
                onClick={() => {
                  if (!ensureMediaFreeExportReady(t('share.notReady'))) return;
                  setExportMenuOpen(false);
                  const { stage, scenes: currentScenes, outlines } = useStageStore.getState();
                  exportPracticeGuide(
                    stage?.name || t('common.untitledCourse'),
                    currentScenes,
                    outlines,
                    stage?.origin?.corpus?.trim() || stage?.origin?.domain?.trim(),
                  );
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2.5"
              >
                <ClipboardList className="w-4 h-4 text-muted-foreground shrink-0" />
                <div>
                  <div>{t('stage.exportPracticeGuide')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('stage.exportPracticeGuideHint')}
                  </div>
                </div>
              </button>
            )}
            <button
              onClick={() => {
                setExportMenuOpen(false);
                exportClassroomZip();
              }}
              disabled={!fullMediaExportReady || isExportingZip}
              title={!fullMediaExportReady ? t('share.notReady') : undefined}
              className="w-full px-4 py-2.5 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Archive className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <div>{t('export.classroomZip')}</div>
                <div className="text-xs text-muted-foreground">
                  {fullMediaExportReady ? t('export.classroomZipDesc') : t('share.notReady')}
                </div>
              </div>
            </button>
            {videoExportEnabled && (
              <VideoExportMenu
                fullMediaReady={fullMediaExportReady}
                onClose={() => setExportMenuOpen(false)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
