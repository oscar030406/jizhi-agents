/**
 * 车间事件流 —— 造课等待期的多智能体工作流实时可视化数据源。
 *
 * 每条事件对应流水线上一次**真实发生**的阶段结果（诊断/检索/拼装/生成/审核/讲稿），
 * 由 use-scene-generator 在收到各 API 响应时推入。没跑的阶段没有事件——
 * 面板永不编造步骤，引擎没起时它自然退化为「生成/审核」两行。
 *
 * Transient（不持久化）：换课清空，刷新即失。它是过程可见性，不是记录。
 */

import { create } from 'zustand';

export type WorkshopTone = 'green' | 'blue' | 'purple' | 'yellow' | 'red' | 'neutral';

export interface WorkshopEvent {
  id: number;
  /** 所属场景标题，面板按它分组 */
  sceneTitle: string;
  text: string;
  /** 语义色：green=画像/完成 blue=检索 purple=拼装 yellow=审核 red=拦截/失败 */
  tone: WorkshopTone;
  at: number;
}

const MAX_EVENTS = 200;
let nextId = 0;

interface WorkshopState {
  events: WorkshopEvent[];
  push: (sceneTitle: string, text: string, tone?: WorkshopTone) => void;
  clear: () => void;
}

export const useWorkshopStore = create<WorkshopState>()((set) => ({
  events: [],
  push: (sceneTitle, text, tone = 'neutral') =>
    set((s) => ({
      events: [...s.events, { id: nextId++, sceneTitle, text, tone, at: Date.now() }].slice(
        -MAX_EVENTS,
      ),
    })),
  clear: () => set({ events: [] }),
}));
