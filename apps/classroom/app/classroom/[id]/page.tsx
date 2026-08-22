'use client';

import { Stage } from '@/components/stage';
import { SafetyNotice } from '@/components/stage/safety-notice';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { useWorkshopStore } from '@/lib/store/workshop';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useI18n } from '@/lib/hooks/use-i18n';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  applyClassroomStageAndScenes,
  defaultClassroomLoadDeps,
  runClassroomLoad,
  saveGeneratedAgentsForCurrentLoad,
} from '@/lib/classroom/load-classroom';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const classroomId = params?.id as string;

  const { loadFromStorage } = useStageStore();
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean = () => true) => {
      const loadToken = claimStageSceneLoadToken();
      const isCurrent = () => isEffectCurrent() && isCurrentStageSceneLoadToken(loadToken);

      await runClassroomLoad({
        classroomId,
        loadToken,
        isCurrent,
        loadFromStorage,
        getCurrentStage: () => useStageStore.getState().stage,
        fetchClassroom: defaultClassroomLoadDeps.fetchClassroom,
        applyFallbackScenes: (args) =>
          defaultClassroomLoadDeps.applyFallbackScenes({
            ...args,
            isCurrent,
            applyStageAndScenes: applyClassroomStageAndScenes,
          }),
        saveGeneratedAgents: (stageId, agents) =>
          saveGeneratedAgentsForCurrentLoad(stageId, agents, isCurrent),
        loadRestoredMediaTasks: defaultClassroomLoadDeps.loadRestoredMediaTasks,
        applyRestoredMediaTasks: defaultClassroomLoadDeps.applyRestoredMediaTasks,
        discardRestoredMediaTasks: defaultClassroomLoadDeps.discardRestoredMediaTasks,
        loadGeneratedAgentRecords: defaultClassroomLoadDeps.loadGeneratedAgentRecords,
        applyGeneratedAgentRecords: defaultClassroomLoadDeps.applyGeneratedAgentRecords,
        getSettings: () => useSettingsStore.getState(),
        getAgent: (id) => useAgentRegistry.getState().getAgent(id),
        restoreAgentSelection: defaultClassroomLoadDeps.restoreAgentSelection,
        setError,
        setLoading,
        log,
      });
    },
    [classroomId, loadFromStorage],
  );

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    /* eslint-disable react-hooks/set-state-in-effect -- Course switch must hide stale Stage before async load */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    generationStartedRef.current = false;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    // Clear the workshop feed so pipeline events from a previous course don't
    // show up under this one's generating view.
    useWorkshopStore.getState().clear();

    // 讲义流式草稿同族清理（2026-08-10 状态污染家族排查）：drafts 按场景 id
    // 键控，跨课不会显示串but会常驻内存——换课一并清。
    import('@/lib/store/lecture-draft').then((m) => m.useLectureDraftStore.getState().clear());

    let cancelled = false;
    loadClassroom(() => !cancelled);

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      cancelled = true;
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    if (loading || error || generationStartedRef.current) return;

    const state = useStageStore.getState();
    const { outlines, scenes, stage, generationComplete } = state;

    // Check if there are pending outlines. A finished deck is frozen for
    // editing: deleting a slide leaves its outline orphaned, but that must not
    // be treated as an interrupted generation and regenerated. Only resume
    // when generation has not completed.
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = !generationComplete && outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Load generation params from sessionStorage (stored by generation-preview before navigating)
      const genParamsStr = sessionStorage.getItem('generationParams');
      const params = genParamsStr ? JSON.parse(genParamsStr) : {};

      // Reconstruct imageMapping from IndexedDB using pdfImages storageIds
      const storageIds = (params.pdfImages || [])
        .map((img: { storageId?: string }) => img.storageId)
        .filter(Boolean);

      loadImageMapping(storageIds).then((imageMapping) => {
        generateRemaining({
          pdfImages: params.pdfImages,
          imageMapping,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            style: stage.style,
          },
          agents: params.agents,
          userProfile: params.userProfile,
          languageDirective: params.languageDirective || stage.languageDirective,
          // 职教任务引擎的闸门在服务端按 requirements.taskEngineMode 算，
          // 不带就等于关掉——stage.taskEngineMode 是造课时已经落库的字段，
          // 直接读它，不另开传参通道。
          requirements: {
            requirement: stage.name || '',
            taskEngineMode: stage.taskEngineMode === true,
          },
        });
      });
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      // The deck reached the classroom already fully materialized (e.g. a
      // single-slide course, or a deck whose last slide finished in
      // generation-preview), so generateRemaining's completion path never
      // ran. Record completion now so a later edit/delete is not treated as
      // an interrupted generation. No-op if already complete or not all
      // outlines have scenes.
      useStageStore.getState().markGenerationCompleteIfDone();
      // Resume media only for outlines that still have a scene. On a finished
      // deck the user may have deleted a slide, leaving an orphaned outline;
      // generating its media would waste API calls on a slide that is gone.
      const materializedOrders = new Set(scenes.map((s) => s.order));
      const materializedOutlines = outlines.filter((o) => materializedOrders.has(o.order));
      generateMediaForOutlines(materializedOutlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });
    }
  }, [loading, error, generateRemaining]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="h-screen flex flex-col overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center bg-background">
              <div className="text-center text-muted-foreground">
                <p>{t('common.loading')}</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center bg-background">
              <div className="text-center">
                <p className="text-destructive mb-4">
                  {t('common.error')}: {error}
                </p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    loadClassroom();
                  }}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  {t('common.retry')}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* 高危领域的安全提示（C21）：涉及实操的域一门课一条常驻横幅。
                  显示与否只看接入时管理者勾没勾「涉及实操」——从语料关键词判
                  实测全是误报（「性价比接地气」「高温度 Temperature」）。 */}
              <SafetyNotice />
              <Stage onRetryOutline={retrySingleOutline} />
            </>
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
