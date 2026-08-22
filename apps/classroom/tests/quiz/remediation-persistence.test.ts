/**
 * 补救场景插进课堂之后，刷新页面还在不在（WO-H4 第 3 件）。
 *
 * F1 交单时这一条只有读码结论。这里把它变成一次真的落盘→重载往返：
 * 走的是 `insertSceneAfter` → 脏标记 → `flushStageSave` → `saveStageData` →
 * 文档快照，再 `clearStore` 清空内存（等价于刷新丢掉运行时状态）→
 * `loadFromStorage` 从同一份文档读回来。中间只把 IndexedDB 那一层换成内存字典，
 * 快照拼装、order 重排、加载端的 migrateScene 全是真代码。
 *
 * 断言的不是「某个 spy 被调过」，是**读回来的场景数组**里有没有那一页、
 * 位置对不对、内容还能不能打开。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存里的「磁盘」：saveDocument 写进来，accessDocument 读出去。 */
const disk: { document: { stage: unknown; scenes: unknown[]; outline: unknown } | null } = {
  document: null,
};
let currentSceneOnDisk: string | null = null;

vi.mock('@/lib/document-store', () => {
  const store = {
    saveDocument: vi.fn(async (snapshot: typeof disk.document) => {
      disk.document = JSON.parse(JSON.stringify(snapshot));
    }),
    putScene: vi.fn(async () => {}),
    putStage: vi.fn(async () => {}),
  };
  return {
    getDocumentStore: async () => store,
    getLegacyDocumentStore: async () => null,
    mutateDocument: vi.fn(
      async (
        _stageId: string,
        callback: (document: unknown, documentStore: typeof store) => Promise<void>,
      ) => callback(disk.document, store),
    ),
    accessDocument: vi.fn(async () => ({ document: disk.document, legacyCurrentSceneId: null })),
    saveCurrentScene: vi.fn(async (_stageId: string, sceneId: string | null) => {
      currentSceneOnDisk = sceneId;
    }),
    loadCurrentScene: vi.fn(async () => ({ sceneId: currentSceneOnDisk })),
    clearCurrentScene: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/utils/chat-storage-lock', () => ({
  withRuntimeStorageSharedLock: (callback: () => unknown) => callback(),
  withRuntimeStorageExclusiveLockUntilSettled: (callback: () => unknown) => callback(),
}));
vi.mock('@/lib/utils/chat-storage', () => ({
  ChatStorageLockUnavailableError: class extends Error {},
  saveChatSessions: vi.fn(async () => true),
  loadChatSessions: vi.fn(async () => []),
  deleteChatSessions: vi.fn(async () => {}),
}));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: async (_stageId: string, scenes: unknown[]) => scenes,
}));
vi.mock('@/lib/pbl/v2/runtime/hydrate', () => ({
  hydratePBLScenesFromRuntime: async (_stageId: string, scenes: unknown[]) => scenes,
}));

import { flushStageSave, useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

const STAGE: Stage = { id: 'stage-h4', name: '注意力权重与温度参数', createdAt: 1, updatedAt: 1 };

function quizScene(): Scene {
  return {
    id: 'scene-quiz',
    stageId: STAGE.id,
    title: '知识检查',
    order: 1,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
  } as Scene;
}

function nextScene(): Scene {
  return {
    id: 'scene-after',
    stageId: STAGE.id,
    title: '小结',
    order: 2,
    type: 'slide',
    content: { type: 'slide', canvas: { id: 'canvas-after', elements: [] } },
  } as unknown as Scene;
}

/** 补救链最后一步交给 store 的那种场景。 */
function remediationScene(): Scene {
  return {
    id: 'scene-remediation',
    stageId: STAGE.id,
    title: '降维讲解：注意力权重与温度参数',
    order: 99,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: { id: 'canvas-remediation', elements: [{ id: 'el-1', type: 'text' }] },
    },
  } as unknown as Scene;
}

beforeEach(() => {
  disk.document = null;
  currentSceneOnDisk = null;
  useStageStore.getState().clearStore();
});

describe('插入的补救场景能不能扛过一次刷新', () => {
  it('插入 → 落盘 → 清空内存 → 重载：场景还在，位置在锚点后面，内容能打开', async () => {
    useStageStore.getState().setStage(STAGE);
    useStageStore.getState().setScenes([quizScene(), nextScene()]);
    useStageStore.getState().setCurrentSceneId('scene-quiz');

    useStageStore.getState().insertSceneAfter('scene-quiz', remediationScene());
    await flushStageSave();

    // 刷新：运行时状态全丢，只剩磁盘上那份文档
    useStageStore.getState().clearStore();
    expect(useStageStore.getState().scenes).toHaveLength(0);

    await useStageStore.getState().loadFromStorage(STAGE.id);

    const scenes = useStageStore.getState().scenes;
    expect(scenes.map((s) => s.id)).toEqual(['scene-quiz', 'scene-remediation', 'scene-after']);

    const restored = scenes.find((s) => s.id === 'scene-remediation')!;
    expect(restored.title).toBe('降维讲解：注意力权重与温度参数');
    expect(restored.order).toBe(2);
    // 「可打开」= 场景类型与内容体对得上，SceneRenderer 才不会渲染成读不出来的空态
    expect(restored.type).toBe('slide');
    expect(restored.content.type).toBe('slide');
  });

  it('没落盘就刷新会丢——这条用来证明上一条不是假绿', async () => {
    useStageStore.getState().setStage(STAGE);
    useStageStore.getState().setScenes([quizScene(), nextScene()]);
    await flushStageSave();

    useStageStore.getState().insertSceneAfter('scene-quiz', remediationScene());
    // 故意不 flush，直接刷新
    useStageStore.getState().clearStore();
    await useStageStore.getState().loadFromStorage(STAGE.id);

    expect(useStageStore.getState().scenes.map((s) => s.id)).toEqual([
      'scene-quiz',
      'scene-after',
    ]);
  });
});
