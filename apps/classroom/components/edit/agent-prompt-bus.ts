'use client';

/**
 * 编辑态「把一段文字发进 Edit with AI 面板」的极小总线。
 *
 * 场景侧栏的运行时错误角标（ThumbItem）离 AgentPanel 隔着两层组件树，而
 * assistant-ui 的 runtime 由 EditChromeRoot 持有、只传给了 RightRailTabs。
 * 与其把 runtime 一路 prop-drill 进 SlideNavRail，不如走一个 pending prompt
 * store：角标 send()，RightRailTabs 消费后展开面板、切到 AI tab、
 * runtime.thread.append() 触发正常的 onNew 流程。
 */
import { create } from 'zustand';

interface AgentPromptBusState {
  /** 待发送的 user message 文本；null 表示无。 */
  pending: string | null;
  send: (prompt: string) => void;
  clear: () => void;
}

export const useAgentPromptBus = create<AgentPromptBusState>((set) => ({
  pending: null,
  send: (prompt) => set({ pending: prompt }),
  clear: () => set({ pending: null }),
}));
