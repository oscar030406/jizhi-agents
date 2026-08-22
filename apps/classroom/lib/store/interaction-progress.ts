import { create } from 'zustand';

/**
 * 课内互动完成进度（设计规格 3.2.2，配方⑤③）：分段计数的数据源。
 * 「答错也推进」——quiz 一交卷（无论对错）该段就点亮，永不回退。
 * 会话级内存态；持久层由 quiz runtime 的 attempt 状态兜底（已交卷的
 * 场景在水合到 reviewing 时会重新标记）。
 */
interface InteractionProgressState {
  completed: Record<string, true>;
  markDone: (sceneId: string) => void;
}

export const useInteractionProgress = create<InteractionProgressState>((set) => ({
  completed: {},
  markDone: (sceneId) =>
    set((s) => (s.completed[sceneId] ? s : { completed: { ...s.completed, [sceneId]: true } })),
}));
