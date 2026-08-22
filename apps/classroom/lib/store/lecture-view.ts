/**
 * 讲义视图开关（同课双形态 lite）。
 *
 * 讲义流评测方向性占优（开卷 1.40 vs 幻灯片 1.15，eval_rerun 第 5 节）但未显著，
 * 全量转正不做；lite 版=课堂内提供「阅读形态」：同一门课的板书+讲稿+摘录
 * 渲染成流式讲义。transient——刷新即关，不持久化。
 */

import { create } from 'zustand';

interface LectureViewState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

export const useLectureViewStore = create<LectureViewState>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));
