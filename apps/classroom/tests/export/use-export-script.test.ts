import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  stageState: {
    stage: { id: 'stage-1', name: '课程' },
    scenes: [] as Scene[],
    generatingOutlines: [] as unknown[],
    failedOutlines: [] as unknown[],
  },
  mediaState: { tasks: {} as Record<string, { status: string; stageId?: string }> },
  saveAs: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
}));
vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({
  toast: { warning: mocks.warning, success: mocks.success, error: mocks.error },
}));
vi.mock('@/lib/store', () => ({ useStageStore: { getState: () => mocks.stageState } }));
vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: { getState: () => mocks.mediaState },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError }),
}));

import {
  buildMarkdown,
  buildScriptFileName,
  collectSceneScripts,
  ensureFullMediaExportReady,
  isFullMediaExportReady,
  isMediaFreeExportReady,
  useExportScript,
} from '@/lib/export/use-export-script';

const fallback = (order: number) => `幻灯片 ${order + 1}`;

function scene(partial: Record<string, unknown>): Scene {
  return { id: 's', stageId: 'st', title: '', order: 0, type: 'slide', ...partial } as Scene;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stageState.stage = { id: 'stage-1', name: '课程' };
  mocks.stageState.scenes = [
    scene({ id: 'scene-1', title: '导论', actions: [{ type: 'speech', text: '原讲稿' }] }),
  ];
  mocks.stageState.generatingOutlines = [];
  mocks.stageState.failedOutlines = [];
  mocks.mediaState.tasks = {};
});

describe('export readiness levels', () => {
  const readyState = {
    stage: { id: 'stage-1' },
    scenes: [{}],
    generatingOutlines: [],
    failedOutlines: [],
  };

  it('keeps media-free exports ready while media is pending or failed', () => {
    expect(isMediaFreeExportReady(readyState)).toBe(true);
    expect(
      isFullMediaExportReady(readyState, {
        pending: { status: 'pending', stageId: 'stage-1' },
      }),
    ).toBe(false);
    expect(
      isFullMediaExportReady(readyState, {
        failed: { status: 'failed', stageId: 'stage-1' },
      }),
    ).toBe(false);
  });

  it('requires done only for current-stage media', () => {
    expect(
      isFullMediaExportReady(readyState, {
        current: { status: 'done', stageId: 'stage-1' },
        otherStage: { status: 'failed', stageId: 'stage-2' },
      }),
    ).toBe(true);
  });

  it.each([
    ['no scenes', { ...readyState, scenes: [] }],
    ['outline generating', { ...readyState, generatingOutlines: [{}] }],
    ['outline failed', { ...readyState, failedOutlines: [{}] }],
  ])('blocks both readiness levels for %s', (_case, stageState) => {
    expect(isMediaFreeExportReady(stageState)).toBe(false);
    expect(isFullMediaExportReady(stageState, {})).toBe(false);
  });

  it('rechecks the store and blocks a stale full-export click', () => {
    expect(isFullMediaExportReady(mocks.stageState, mocks.mediaState.tasks)).toBe(true);
    mocks.mediaState.tasks = {
      image: { status: 'failed', stageId: 'stage-1' },
    };

    expect(ensureFullMediaExportReady('not-ready')).toBe(false);
    expect(mocks.warning).toHaveBeenCalledWith('not-ready');
  });
});

describe('useExportScript readiness', () => {
  it('rechecks readiness on click and blocks a stale enabled action', () => {
    const { exportScriptMd } = useExportScript();
    mocks.stageState.generatingOutlines = [{}];

    exportScriptMd();

    expect(mocks.warning).toHaveBeenCalledWith('share.notReady');
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('exports the latest scenes inserted after the action was rendered', async () => {
    const { exportScriptMd } = useExportScript();
    mocks.stageState.scenes.push(
      scene({
        id: 'scene-remediation',
        title: '补救场景',
        order: 1,
        actions: [{ type: 'speech', text: '补救讲稿' }],
      }),
    );

    exportScriptMd();

    expect(mocks.saveAs).toHaveBeenCalledOnce();
    const [blob] = mocks.saveAs.mock.calls[0] as unknown as [Blob, string];
    await expect(blob.text()).resolves.toContain('补救讲稿');
    expect(mocks.success).toHaveBeenCalledWith('export.exportSuccess');
  });

  it('still exports Markdown after media generation failed', () => {
    const { exportScriptMd } = useExportScript();
    mocks.mediaState.tasks = {
      image: { status: 'failed', stageId: 'stage-1' },
    };

    exportScriptMd();

    expect(mocks.saveAs).toHaveBeenCalledOnce();
    expect(mocks.warning).not.toHaveBeenCalledWith('share.notReady');
  });
});

describe('collectSceneScripts', () => {
  it('concatenates speech text in action order, skips non-speech and blank speech', () => {
    const scenes = [
      scene({
        id: 's1',
        title: '导论',
        order: 0,
        actions: [
          { type: 'speech', text: ' 第一句。 ' },
          { type: 'wb.open' },
          { type: 'speech', text: '' },
          { type: 'speech', text: '第二句。' },
        ],
      }),
    ];
    expect(collectSceneScripts(scenes, fallback)).toEqual([
      { sceneId: 's1', sceneTitle: '导论', sceneOrder: 0, text: '第一句。\n第二句。' },
    ]);
  });

  it('omits scenes with no speech text and falls back for empty titles', () => {
    const scenes = [
      scene({ id: 's1', order: 0, actions: [{ type: 'wb.open' }] }),
      scene({ id: 's2', order: 1, actions: [{ type: 'speech', text: '有话说' }] }),
      scene({ id: 's3', order: 2 }), // no actions at all
    ];
    const out = collectSceneScripts(scenes, fallback);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sceneId: 's2', sceneTitle: '幻灯片 2' });
  });
});

describe('buildMarkdown', () => {
  it('escapes heading injection in stage and scene titles', () => {
    const md = buildMarkdown('# 恶意课程', [
      { sceneId: 's1', sceneTitle: '\n# Injected', sceneOrder: 0, text: 'line1\n\nline2' },
    ]);
    expect(md.startsWith('# \\# 恶意课程')).toBe(true);
    expect(md).toContain('## \\# Injected');
    expect(md).toContain('line1');
    expect(md).toContain('line2');
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe('buildScriptFileName', () => {
  it('strips illegal characters and falls back when empty', () => {
    expect(buildScriptFileName('My: Course/Name')).toBe('My-CourseName-script.md');
    expect(buildScriptFileName('///:::')).toBe('script.md');
  });
});
