import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stageState = {
    stage: { id: 'stage-1', name: '课程' },
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-1',
        title: '第一页',
        order: 0,
        type: 'slide',
        content: { type: 'slide', canvas: { width: 960, height: 540, elements: [] } },
      },
    ],
    generatingOutlines: [],
    failedOutlines: [],
  };
  return {
    stageState,
    mediaState: {
      tasks: {
        image: { status: 'done', stageId: 'stage-1' },
      } as Record<string, { status: string; stageId?: string }>,
    },
    warning: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    saveAs: vi.fn(),
    buildExportZip: vi.fn(),
    startRender: vi.fn(),
    setState: vi.fn(),
  };
});

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useRef: <T>(initial: T) => ({ current: initial }),
  useState: <T>(initial: T) => [initial, mocks.setState] as const,
}));
vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({
  toast: {
    warning: mocks.warning,
    loading: mocks.loading,
    success: mocks.success,
    error: mocks.error,
    info: mocks.info,
  },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/store', () => {
  const useStageStore = Object.assign(
    (selector: (state: typeof mocks.stageState) => unknown) => selector(mocks.stageState),
    { getState: () => mocks.stageState },
  );
  return { useStageStore };
});
vi.mock('@/lib/store/media-generation', () => {
  const useMediaGenerationStore = Object.assign(
    (selector: (state: typeof mocks.mediaState) => unknown) => selector(mocks.mediaState),
    { getState: () => mocks.mediaState },
  );
  return { useMediaGenerationStore, isMediaPlaceholder: () => false };
});
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      viewportSize: () => 960,
      viewportRatio: () => 0.5625,
    },
  },
}));
vi.mock('@/lib/store/video-render', () => {
  const state = {
    status: 'idle',
    percent: 0,
    etaMs: null,
    options: { resolution: '1080p', fps: 30, quality: 'balanced' },
    setOptions: vi.fn(),
    startRender: mocks.startRender,
  };
  return { useVideoRenderStore: (selector: (value: typeof state) => unknown) => selector(state) };
});
vi.mock('@/lib/video-export-app/build-export-zip', () => ({
  buildExportZip: mocks.buildExportZip,
  NoScenesError: class NoScenesError extends Error {},
  sanitizeFilename: (value: string) => value,
  VIDEO_RESOLUTIONS: { '1080p': { width: 1920, height: 1080 } },
}));

import { useExportClassroom } from '@/lib/export/use-export-classroom';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useExportVideo } from '@/lib/video-export-app/use-export-video';
import { useRenderVideo } from '@/lib/video-export-app/use-render-video';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mediaState.tasks = {
    image: { status: 'done', stageId: 'stage-1' },
  };
});

describe('full export click-time readiness', () => {
  it.each(['failed', 'pending'])(
    'blocks every stale full-export action after media becomes %s',
    async (status) => {
      const pptx = useExportPPTX();
      const classroom = useExportClassroom();
      const videoZip = useExportVideo();
      const videoMp4 = useRenderVideo();

      mocks.mediaState.tasks = {
        image: { status, stageId: 'stage-1' },
      };

      pptx.exportPPTX();
      pptx.exportResourcePack();
      await classroom.exportClassroomZip();
      await videoZip.exportVideo();
      videoMp4.renderVideo();

      expect(mocks.warning).toHaveBeenCalledTimes(5);
      expect(mocks.warning).toHaveBeenCalledWith('share.notReady');
      expect(mocks.loading).not.toHaveBeenCalled();
      expect(mocks.saveAs).not.toHaveBeenCalled();
      expect(mocks.buildExportZip).not.toHaveBeenCalled();
      expect(mocks.startRender).not.toHaveBeenCalled();
    },
  );
});
