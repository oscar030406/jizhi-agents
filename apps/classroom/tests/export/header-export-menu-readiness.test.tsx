import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stageState: {
    stage: { id: 'stage-1', name: '课程' },
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-1',
        title: '实操',
        order: 0,
        type: 'interactive',
        content: { type: 'interactive', widgetType: 'procedural-skill', html: '<p>guide</p>' },
      },
    ],
    outlines: [],
    generatingOutlines: [] as unknown[],
    failedOutlines: [] as unknown[],
  },
  mediaState: {
    tasks: {
      image: { status: 'failed', stageId: 'stage-1' },
    } as Record<string, { status: string; stageId?: string }>,
  },
  setState: vi.fn(),
  warning: vi.fn(),
  exportPPTX: vi.fn(),
  exportResourcePack: vi.fn(),
  exportClassroomZip: vi.fn(),
  exportScriptMd: vi.fn(),
  exportPracticeGuide: vi.fn(),
  exportVideo: vi.fn(),
  renderVideo: vi.fn(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: vi.fn(),
    useRef: <T,>(initial: T) => ({ current: initial }),
    useState: <T,>(_initial: T) => [true, mocks.setState] as const,
  };
});
vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
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
  return { useMediaGenerationStore };
});
vi.mock('@/lib/store/video-render', () => ({
  useVideoRenderStore: (selector: (state: { status: string; percent: number }) => unknown) =>
    selector({ status: 'idle', percent: 0 }),
}));
vi.mock('@/lib/export/use-export-pptx', () => ({
  useExportPPTX: () => ({
    exporting: false,
    exportPPTX: mocks.exportPPTX,
    exportResourcePack: mocks.exportResourcePack,
  }),
}));
vi.mock('@/lib/export/use-export-classroom', () => ({
  useExportClassroom: () => ({ exporting: false, exportClassroomZip: mocks.exportClassroomZip }),
}));
vi.mock('@/lib/export/use-export-script', async () => {
  const actual = await vi.importActual<typeof import('@/lib/export/use-export-script')>(
    '@/lib/export/use-export-script',
  );
  return { ...actual, useExportScript: () => ({ exportScriptMd: mocks.exportScriptMd }) };
});
vi.mock('@/lib/export/practice-guide', () => ({
  isProceduralScene: (scene: { content?: { widgetType?: string } }) =>
    scene.content?.widgetType === 'procedural-skill',
  exportPracticeGuide: mocks.exportPracticeGuide,
}));
vi.mock('@/lib/config/feature-flags', () => ({ isVideoExportEnabled: () => true }));
vi.mock('@/lib/video-export-app/use-export-video', () => ({
  useExportVideo: () => ({ exporting: false, exportVideo: mocks.exportVideo }),
}));
vi.mock('@/lib/video-export-app/use-render-video', () => ({
  useRenderVideo: () => ({
    rendering: false,
    percent: 0,
    etaMs: null,
    options: { resolution: '1080p', fps: 30, quality: 'balanced' },
    setOptions: vi.fn(),
    renderVideo: mocks.renderVideo,
  }),
}));

import { isValidElement } from 'react';
import { HeaderControls } from '@/components/stage/header-controls';
import { VideoExportMenu } from '@/components/stage/video-export-menu';

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  return [node, ...flatten((node.props as { children?: ReactNode }).children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isValidElement(node)) return '';
  return textOf((node.props as { children?: ReactNode }).children);
}

function button(elements: ReactElement[], label: string): ReactElement {
  const found = elements.find((element) => element.type === 'button' && textOf(element) === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function buttonProps(element: ReactElement): {
  'aria-label'?: string;
  disabled?: boolean;
  onClick: () => void;
} {
  return element.props as {
    'aria-label'?: string;
    disabled?: boolean;
    onClick: () => void;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stageState.generatingOutlines = [];
  mocks.stageState.failedOutlines = [];
  mocks.mediaState.tasks = {
    image: { status: 'failed', stageId: 'stage-1' },
  };
});

describe('header export menu readiness', () => {
  it('opens for media-free downloads while complete package items stay disabled', () => {
    const elements = flatten(HeaderControls({}));
    const trigger = elements.find(
      (element) =>
        element.type === 'button' && buttonProps(element)['aria-label'] === 'export.pptx',
    );

    expect(trigger && buttonProps(trigger).disabled).toBe(false);
    expect(buttonProps(button(elements, '导出讲稿 (.md)')).disabled).not.toBe(true);
    expect(
      buttonProps(button(elements, 'stage.exportPracticeGuidestage.exportPracticeGuideHint'))
        .disabled,
    ).not.toBe(true);
    expect(buttonProps(button(elements, 'export.pptxshare.notReady')).disabled).toBe(true);
    expect(buttonProps(button(elements, 'export.resourcePackshare.notReady')).disabled).toBe(true);
    expect(buttonProps(button(elements, 'export.classroomZipshare.notReady')).disabled).toBe(true);
  });

  it('rechecks a media-free guide click against current stage generation state', () => {
    const elements = flatten(HeaderControls({}));
    const guide = button(elements, 'stage.exportPracticeGuidestage.exportPracticeGuideHint');
    mocks.stageState.generatingOutlines = [{}];

    buttonProps(guide).onClick();

    expect(mocks.warning).toHaveBeenCalledWith('share.notReady');
    expect(mocks.exportPracticeGuide).not.toHaveBeenCalled();
  });

  it('disables video ZIP and MP4 actions and explains notReady', () => {
    const elements = flatten(VideoExportMenu({ fullMediaReady: false, onClose: vi.fn() }));

    expect(buttonProps(button(elements, 'export.videoRenderMp4')).disabled).toBe(true);
    expect(buttonProps(button(elements, 'export.videoDownloadZip')).disabled).toBe(true);
    expect(elements.some((element) => textOf(element) === 'share.notReady')).toBe(true);
  });
});
