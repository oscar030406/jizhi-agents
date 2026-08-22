/**
 * 讲义流式草稿 store —— 「边生成边读」的数据面。
 *
 * 生成端（scene-content 流式分支）逐 token 推 md 增量，等待界面
 * （canvas 待生成遮罩 / generation-preview 直播面板）订阅渲染：
 * 用户等待期即阅读期（2026-08-04 提速批三段，依据
 * docs/04-research/generation_latency_research_20260804.md 第 2 条）。
 *
 * 按 outlineId 分键——场景并行预取（并发 3）时多份草稿同时在写。
 * 换课/重开生成时 clear。
 */

import { create } from 'zustand';

export interface LectureDraft {
  title: string;
  md: string;
  done: boolean;
}

interface LectureDraftState {
  drafts: Record<string, LectureDraft>;
  begin: (outlineId: string, title: string) => void;
  append: (outlineId: string, chunk: string) => void;
  finish: (outlineId: string) => void;
  clear: () => void;
}

export const useLectureDraftStore = create<LectureDraftState>((set) => ({
  drafts: {},
  begin: (outlineId, title) =>
    set((s) => ({ drafts: { ...s.drafts, [outlineId]: { title, md: '', done: false } } })),
  append: (outlineId, chunk) =>
    set((s) => {
      const cur = s.drafts[outlineId];
      if (!cur) return s;
      return { drafts: { ...s.drafts, [outlineId]: { ...cur, md: cur.md + chunk } } };
    }),
  finish: (outlineId) =>
    set((s) => {
      const cur = s.drafts[outlineId];
      if (!cur) return s;
      return { drafts: { ...s.drafts, [outlineId]: { ...cur, done: true } } };
    }),
  clear: () => set({ drafts: {} }),
}));
