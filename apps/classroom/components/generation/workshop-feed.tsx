'use client';

/**
 * 车间面板 —— 造课等待期的多智能体工作流实时事件流。
 *
 * 数据源是 workshop store：每行对应流水线一次真实的阶段结果（学情诊断/证据检索/
 * 摘录拼装/内容生成/事实审核/讲稿），由 use-scene-generator 在收到各 API 响应时
 * 推入。行按场景标题分组，语义色随事件走（画像绿/检索蓝/拼装紫/审核黄/拦截红）。
 * 没有事件时渲染 null——面板永不编造步骤，缺哪个阶段就少哪一行。
 *
 * 头部挂「当前主事角色」：最新一条事件的语义色决定现在由谁在干活，卡通随之更换，
 * 三帧循环（act1 准备 / act2 动作 / act3 定格）让等待期有东西可看。角色与行内头像
 * 都用 public/agents 的定稿卡通，不再用手写 SVG。
 */

import { useEffect, useRef, useState } from 'react';
import { useWorkshopStore, type WorkshopTone } from '@/lib/store/workshop';
import { cn } from '@/lib/utils';
import { AGENT_ART, AGENT_PERSONAS, type AgentKey } from '@/components/agents/agent-avatar';

const TONE_CLASS: Record<WorkshopTone, string> = {
  green: 'bg-green-soft text-green-deep',
  blue: 'bg-blue-soft text-blue-deep',
  purple: 'bg-purple-soft text-purple-deep',
  yellow: 'bg-yellow-soft text-yellow-deep',
  red: 'bg-red-soft text-red-deep',
  neutral: 'bg-muted text-muted-foreground',
};

/** 语义色 → 拟人头像：绿=阿诊 蓝=阿检 紫=阿讲 黄=阿审 红(拦截)=阿裁；neutral 无主。 */
const TONE_AGENT: Partial<Record<WorkshopTone, AgentKey>> = {
  green: 'diagnosis',
  blue: 'retrieval',
  purple: 'generation',
  yellow: 'judge',
  red: 'arbiter',
};

/** 主事角色的三帧循环。造课要等好几分钟，静止一张图会显得卡住了。 */
function useActFrame(agent: AgentKey | null) {
  const [frame, setFrame] = useState<{ agent: AgentKey | null; index: number }>({
    agent,
    index: 0,
  });
  useEffect(() => {
    if (!agent) return;
    const iv = window.setInterval(
      () =>
        setFrame((current) => ({
          agent,
          index: current.agent === agent ? (current.index + 1) % 3 : 1,
        })),
      900,
    );
    return () => window.clearInterval(iv);
  }, [agent]);
  return frame.agent === agent ? frame.index : 0;
}

export function WorkshopFeed({ className }: { className?: string }) {
  const events = useWorkshopStore((s) => s.events);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 最新一条事件属于谁，现在就是谁在干活
  const lead = events.length ? (TONE_AGENT[events[events.length - 1].tone] ?? null) : null;
  const frameIndex = useActFrame(lead);

  // 新事件到达时贴底滚动，让最新一行始终可见。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (events.length === 0) return null;

  return (
    <div
      className={cn(
        'w-full max-w-2xl rounded-xl border border-border bg-card/80 backdrop-blur-sm',
        'shadow-sm overflow-hidden flex flex-col',
        className,
      )}
    >
      <div className="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2.5">
        {lead && AGENT_ART[lead].acts ? (
          <img
            src={AGENT_ART[lead].acts![frameIndex]}
            alt={`${AGENT_PERSONAS[lead].name}（${AGENT_PERSONAS[lead].role}）`}
            className="-my-1 h-12 w-auto shrink-0 object-contain"
          />
        ) : (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-deep opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-deep" />
          </span>
        )}
        <span className="min-w-0 text-xs font-medium text-muted-foreground">
          {lead ? (
            <>
              <span className="text-foreground">{AGENT_PERSONAS[lead].name}</span> 正在做
              {AGENT_PERSONAS[lead].role}
            </>
          ) : (
            '多智能体车间 · 各环节实时结果'
          )}
        </span>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-1 text-left">
        {events.map((e, i) => {
          const showTitle = i === 0 || events[i - 1].sceneTitle !== e.sceneTitle;
          const agent = TONE_AGENT[e.tone];
          return (
            <div key={e.id}>
              {showTitle && (
                <div className="mt-2 first:mt-0 mb-1 text-[11px] font-medium text-muted-foreground truncate">
                  {e.sceneTitle}
                </div>
              )}
              <div
                className={cn(
                  'flex items-start gap-1.5 rounded-md px-2.5 py-1 text-xs leading-relaxed break-words',
                  TONE_CLASS[e.tone],
                )}
              >
                {agent && (
                  <img
                    src={AGENT_ART[agent].bust}
                    alt={AGENT_PERSONAS[agent].name}
                    title={`${AGENT_PERSONAS[agent].name} · ${AGENT_PERSONAS[agent].role}`}
                    className="mt-px size-[18px] shrink-0 rounded-full object-cover"
                    loading="lazy"
                  />
                )}
                <span className="min-w-0 break-words">{e.text}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
