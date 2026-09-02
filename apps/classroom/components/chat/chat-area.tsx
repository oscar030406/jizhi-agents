'use client';

import {
  useImperativeHandle,
  forwardRef,
  useRef,
  useCallback,
  useState,
  useMemo,
  useEffect,
} from 'react';
import type { SessionType } from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action, DiscussionAction } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { buildLectureNotes } from '@/lib/chat/lecture-notes';
import { PanelRightClose, MessageSquare, GraduationCap, Send } from 'lucide-react';
import {
  useChatSessions,
  MANUAL_STOP_END_OPTIONS,
  type EndSessionOptions,
  type SessionCleanupPayload,
} from './use-chat-sessions';
import { SessionList } from './session-list';
import { LectureNotesView } from './lecture-notes-view';
import { TutorPanel } from './tutor-panel';

interface ChatAreaProps {
  className?: string;
  width?: number;
  onWidthChange?: (width: number) => void;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  activeBubbleId?: string | null;
  onActiveBubble?: (messageId: string | null) => void;
  onLiveSpeech?: (text: string | null, agentId?: string | null) => void;
  onSpeechProgress?: (ratio: number | null) => void;
  onThinking?: (state: { stage: string; agentId?: string } | null) => void;
  onCueUser?: (fromAgentId?: string, prompt?: string) => void;
  onLiveSessionError?: () => void;
  onSoftCloseSession?: (payload: SessionCleanupPayload) => void;
  onSoftClosingChange?: (softClosing: boolean, deadline?: number) => void;
  onStopSession?: (payload: SessionCleanupPayload) => void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
  ) => void;
  /** When provided and returns true, StreamBuffer holds on the current text item after reveal. */
  shouldHoldAfterReveal?: () => { holding: boolean; segmentDone: number } | boolean;
  currentSceneId?: string | null;
  currentActionIndex?: number | null;
  canJumpToAction?: (sceneId: string, actionIndex: number) => boolean;
  onJumpToAction?: (sceneId: string, actionIndex: number) => void;
  // ── 导学大一统（2026-08-03 用户定调：右侧只留导学，课堂对话/苏格拉底追问/
  // 笔记全并入，随讲义推进；底部圆桌条撤下，输入框搬进本栏）──
  /** 用户在导学栏输入并发送（原 Roundtable onMessageSend 语义） */
  onMessageSend?: (msg: string) => void;
  /** 输入框聚焦时暂停放映与讨论缓冲（原 Roundtable onInputActivate） */
  onInputActivate?: () => void;
  /** 待确认的讨论邀请（ProactiveCard 内嵌版数据源） */
  discussionRequest?: DiscussionAction | null;
  onDiscussionStart?: () => void;
  onDiscussionSkip?: () => void;
  /** 导师思考中指示（讨论轮转派发阶段） */
  thinkingState?: { stage: string; agentId?: string } | null;
  /** 导演点名用户发言 */
  isCueUser?: boolean;
}

export interface ChatAreaRef {
  createSession: (type: SessionType, title: string) => Promise<string>;
  endSession: (sessionId: string, options?: EndSessionOptions) => Promise<void>;
  endActiveSession: (options?: EndSessionOptions) => Promise<void>;
  stopActiveSession: () => Promise<void>;
  continueActiveSoftClosingSession: () => boolean;
  softPauseActiveSession: () => Promise<void>;
  resumeActiveSession: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  startDiscussion: (request: DiscussionRequest) => Promise<void>;
  startLecture: (sceneId: string) => Promise<string>;
  addLectureMessage: (sessionId: string, action: Action, actionIndex: number) => void;
  getIsStreaming: () => boolean;
  getActiveSessionType: () => string | null;
  getLectureMessageId: (sessionId: string) => string | null;
  pauseBuffer: (sessionId: string) => void;
  resumeBuffer: (sessionId: string) => void;
  pauseActiveLiveBuffer: () => boolean;
  resumeActiveLiveBuffer: () => void;
  switchToTab: (tab: 'lecture' | 'chat' | 'tutor') => void;
}

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(
  (
    {
      className,
      width = DEFAULT_WIDTH,
      onWidthChange,
      collapsed = false,
      onCollapseChange,
      activeBubbleId,
      onActiveBubble,
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onLiveSessionError,
      onSoftCloseSession,
      onSoftClosingChange,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
      currentSceneId,
      currentActionIndex,
      canJumpToAction,
      onJumpToAction,
      onMessageSend,
      onInputActivate,
      discussionRequest,
      onDiscussionStart,
      onDiscussionSkip,
      thinkingState,
      isCueUser,
    },
    ref,
  ) => {
    const scenes = useStageStore((s) => s.scenes);
    const {
      sessions,
      activeSessionType,
      expandedSessionIds,
      isStreaming,
      createSession,
      endSession,
      endActiveSession,
      continueSoftClosingSession,
      confirmSoftClosingSession,
      softPauseActiveSession,
      resumeActiveSession,
      sendMessage,
      startDiscussion,
      startLecture,
      addLectureMessage,
      toggleSessionExpand,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
    } = useChatSessions({
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onActiveBubble,
      onLiveSessionError,
      onSoftCloseSession,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
    });

    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const [draft, setDraft] = useState('');

    // Derive lecture notes directly from scenes — updates reactively as scenes stream in.
    const lectureNotes = useMemo(() => buildLectureNotes(scenes), [scenes]);

    // Filter out lecture sessions for the Chat tab
    const chatSessions = useMemo(() => sessions.filter((s) => s.type !== 'lecture'), [sessions]);

    // Whether there's an active discussion/QA session (for amber dot on Chat tab)
    const hasActiveChatSession = useMemo(
      () => chatSessions.some((s) => s.status === 'active'),
      [chatSessions],
    );

    const softClosingChatSession = useMemo(
      () => chatSessions.find((s) => s.status === 'soft-closing'),
      [chatSessions],
    );

    useEffect(() => {
      onSoftClosingChange?.(
        Boolean(softClosingChatSession),
        softClosingChatSession?.softCloseDeadline,
      );
    }, [softClosingChatSession, onSoftClosingChange]);

    // Wrap endSession for QA/Discussion: also notify parent for engine cleanup
    const handleEndSession = useCallback(
      async (sessionId: string) => {
        const session = chatSessions.find((candidate) => candidate.id === sessionId);
        if (session?.status === 'soft-closing') {
          const payload = await confirmSoftClosingSession(sessionId);
          if (payload) onStopSession?.(payload);
          return;
        }
        await endSession(sessionId, MANUAL_STOP_END_OPTIONS);
        onStopSession?.({ sessionId, source: 'manual_stop' });
      },
      [chatSessions, confirmSoftClosingSession, endSession, onStopSession],
    );

    const handleStopActiveSession = useCallback(async () => {
      const active = chatSessions.find(
        (session) => session.status === 'active' || session.status === 'soft-closing',
      );
      if (active) await handleEndSession(active.id);
    }, [chatSessions, handleEndSession]);

    const handleContinueActiveSoftClosingSession = useCallback((): boolean => {
      const softClosing = chatSessions.find((session) => session.status === 'soft-closing');
      return softClosing ? continueSoftClosingSession(softClosing.id) : false;
    }, [chatSessions, continueSoftClosingSession]);

    // 导学单栏后无标签页可切；保留 no-op 以稳住 ChatAreaRef 契约
    // （PlaybackChromeRoot 的调用点无需同步改动）。
    const switchToTab = useCallback((_tab: 'lecture' | 'chat' | 'tutor') => {}, []);

    const handleSend = useCallback(() => {
      const msg = draft.trim();
      if (!msg) return;
      setDraft('');
      onMessageSend?.(msg);
    }, [draft, onMessageSend]);

    useImperativeHandle(ref, () => ({
      createSession,
      endSession,
      endActiveSession,
      stopActiveSession: handleStopActiveSession,
      continueActiveSoftClosingSession: handleContinueActiveSoftClosingSession,
      softPauseActiveSession,
      resumeActiveSession,
      sendMessage,
      startDiscussion,
      startLecture,
      addLectureMessage,
      getIsStreaming: () => isStreaming,
      getActiveSessionType: () => activeSessionType,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
      switchToTab,
    }));

    // 拖拽改宽。与 components/stage/scene-sidebar.tsx、
    // components/edit/SlideNavRail/SlideNavRail.tsx 同一套：Pointer Events +
    // setPointerCapture。原来绑 document 的 mousemove/mouseup 有两个问题——
    // 触屏根本不触发，指针移出窗口/切标签时 mouseup 也不触发，侧栏卡在「还在拖」。
    // 移动期间直接写 DOM 的 style.width，pointerup 时才提交一次 onWidthChange
    // （宽度存 settings store，每次 move 都写会连带整棵右栏重渲染）。
    const panelRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{
      startX: number;
      startWidth: number;
      lastWidth: number;
      pointerId: number;
    } | null>(null);

    const handleDragStart = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 同一次 pointerdown 里不该失败；真失败了窗口内拖拽仍可用，不中断手势
        }
        dragRef.current = {
          startX: e.clientX,
          startWidth: width,
          lastWidth: width,
          pointerId: e.pointerId,
        };
        isDraggingRef.current = true;
        setIsDragging(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      },
      [width],
    );

    // 右栏靠右，手柄在左边缘：往左拖变宽，所以 delta 取 startX − clientX
    const handleDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, drag.startWidth + (drag.startX - e.clientX)),
      );
      drag.lastWidth = next;
      if (panelRef.current) panelRef.current.style.width = `${next}px`;
    }, []);

    const handleDragEnd = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || e.pointerId !== drag.pointerId) return;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // pointercancel 可能已经先释放过了
        }
        onWidthChange?.(drag.lastWidth);
        dragRef.current = null;
        isDraggingRef.current = false;
        setIsDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      },
      [onWidthChange],
    );

    // 键盘改宽（WCAG 2.1.1）。与 scene-sidebar 同一套：方向键 16px 一档、
    // Shift 加速到 48px、Home/End 到两端。注意本栏靠右，左键是「变宽」。
    const resizeOnKey = useCallback(
      (e: React.KeyboardEvent) => {
        const step = e.shiftKey ? 48 : 16;
        const next =
          e.key === 'ArrowLeft'
            ? width + step
            : e.key === 'ArrowRight'
              ? width - step
              : e.key === 'Home'
                ? MAX_WIDTH
                : e.key === 'End'
                  ? MIN_WIDTH
                  : null;
        if (next === null) return;
        e.preventDefault();
        onWidthChange?.(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
      },
      [width, onWidthChange],
    );

    const displayWidth = collapsed ? 0 : width;

    return (
      <div
        ref={panelRef}
        style={{
          width: displayWidth,
          transition: isDragging ? 'none' : 'width 0.3s ease',
        }}
        className={cn(
          // 右栏底：卡白掺 12% yellow-soft 的几乎不可见暖 tint，与画布纯白拉开层次（色调回暖微调）
          'bg-[color-mix(in_oklab,var(--yellow-soft)_12%,var(--card))] border-l border-border flex flex-col shrink-0 z-20 overflow-visible',
          // 窄屏（<768px）导学栏改成浮层，理由同 scene-sidebar：并排放不下，
          // 外层 overflow-hidden 会把画布和本栏右侧一起裁掉（375px 下量到裁掉 165px）。
          'absolute inset-y-0 right-0 shadow-dropdown md:relative md:inset-auto md:shadow-none',
          className,
        )}
      >
        {/* 拖拽手柄：视觉仍是 6px 细线，命中区放宽到 16px 并往左让出 5px。
            touch-action: none 是触屏上用 Pointer Events 的前提，否则横向拖会被
            浏览器当成滚动手势吃掉。 */}
        {!collapsed && (
          <div
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            onPointerCancel={handleDragEnd}
            onKeyDown={resizeOnKey}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整导学栏宽度"
            aria-valuenow={width}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            tabIndex={0}
            style={{ touchAction: 'none' }}
            className="absolute -left-[5px] top-0 bottom-0 w-4 cursor-col-resize z-50 group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500"
          >
            <div className="absolute right-0 top-0 bottom-0 w-1.5 hover:bg-purple-400/30 dark:hover:bg-purple-600/30 group-active:bg-purple-500/40 transition-colors" />
            <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-border group-hover:bg-purple-400 dark:group-hover:bg-purple-500 transition-colors" />
          </div>
        )}

        <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
          {/* ── 导学单栏（2026-08-03 定稿）：讲解流为骨架，讨论/邀请卡/导师考核
              内嵌进当前小节，底部常驻输入框。原 笔记/对话 两标签废除。 ── */}
          <div className="h-10 flex items-center gap-2 shrink-0 mt-3 mb-1 px-4">
            <GraduationCap className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            {/* 引擎桥功能统一中文文案（与 adaptive 决策卡同口径），不走 i18n */}
            <span className="flex-1">
              <span className="text-sm font-semibold">导学</span>
              {/* 职责收敛（tutor-consolidation §二）：栏内一切提问/讲解/判分由
                  导学智能体统一决策，教学角色只是它的表达人格 */}
              <span className="ml-2 text-[10px] text-muted-foreground">
                导学智能体驱动 · 教学人格代言
              </span>
            </span>
            {hasActiveChatSession && (
              <span className="flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
            )}
            {onCollapseChange && (
              <button
                onClick={() => onCollapseChange(true)}
                className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-muted text-muted-foreground hover:bg-accent hover:text-foreground active:scale-90 transition-all duration-200"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            )}
          </div>

          <LectureNotesView
            notes={lectureNotes}
            currentSceneId={currentSceneId}
            currentActionIndex={currentActionIndex}
            canJumpToAction={canJumpToAction}
            onJumpToAction={onJumpToAction}
            currentSceneExtras={
              <div className="mt-2 space-y-2">
                {/* 讨论邀请卡（原圆桌 ProactiveCard 的内嵌版） */}
                {discussionRequest && (
                  <div className="rounded-lg border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-900/15 px-3 py-2">
                    <div className="flex items-start gap-1.5 mb-1.5">
                      <MessageSquare className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                      <span className="text-[12px] leading-snug text-amber-800 dark:text-amber-200">
                        {discussionRequest.topic}
                      </span>
                    </div>
                    <div className="flex gap-2 pl-5">
                      <button
                        onClick={onDiscussionStart}
                        className="px-2.5 py-1 text-[11px] font-medium rounded-full bg-amber-500 text-white hover:bg-amber-600 active:scale-95 transition-all"
                      >
                        参与讨论
                      </button>
                      <button
                        onClick={onDiscussionSkip}
                        className="px-2.5 py-1 text-[11px] font-medium rounded-full bg-muted text-muted-foreground hover:bg-accent active:scale-95 transition-all"
                      >
                        跳过
                      </button>
                    </div>
                  </div>
                )}

                {/* 课堂讨论/问答会话流（随当前小节内嵌） */}
                {chatSessions.length > 0 && (
                  <SessionList
                    sessions={chatSessions}
                    expandedSessionIds={expandedSessionIds}
                    isStreaming={isStreaming}
                    activeBubbleId={activeBubbleId}
                    onToggleExpand={toggleSessionExpand}
                    onEndSession={handleEndSession}
                    onContinueSession={continueSoftClosingSession}
                  />
                )}
                {thinkingState && (
                  <p className="pl-1 text-[11px] text-muted-foreground animate-pulse">
                    导师正在思考…
                  </p>
                )}

                {/* 导师考核（动态追问：导师考学生，非学生问导师） */}
                <TutorPanel currentSceneId={currentSceneId} />
                <div ref={bottomRef} />
              </div>
            }
          />

          {/* 常驻输入框：随讲义随时插话（原圆桌输入的迁入） */}
          <div className="shrink-0 border-t border-border-subtle px-3 py-2.5">
            {isCueUser && (
              <p className="mb-1.5 text-[11px] text-purple-600 dark:text-purple-400">
                老师在等你回答——直接输入你的想法
              </p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => onInputActivate?.()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={1}
                placeholder="向课堂提问，或回答老师的问题…"
                // 焦点环原来是 1px purple-400/60，实测叠在输入框底上只有 1.9:1，
                // 达不到 1.4.11 对焦点指示的 3:1。换成 2px 不透明 purple-500（实测 3.5:1）。
                className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-relaxed focus:outline-2 focus:outline-offset-1 focus:outline-purple-500 placeholder:text-muted-foreground/60"
              />
              <button
                onClick={handleSend}
                disabled={!draft.trim()}
                aria-label="发送"
                className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center bg-purple-600 text-white disabled:opacity-40 hover:bg-purple-700 active:scale-95 transition-all"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

ChatArea.displayName = 'ChatArea';
