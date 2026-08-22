'use client';

/**
 * 导学一轮静态回放（赛题第五(4)款②「动态追问与启发式交互导学」的未登录证据）。
 *
 * 只读预生成落盘的 public/tutor-replay.json——一轮真实调用的存档：引擎从公开课
 * 讲义现生成探问 → 学习者答错一半 → 判官对照讲义原文裁决（verdict + because 链
 * + 降维解释 + 原句引用）。绝不现场调引擎，也不摆演示台词；JSON 404 ⇒ 整块不渲染
 * （与 /compare 读 public/compare-showcase.json 同一模式）。
 *
 * 组件不自挂首页；挂载点由公共页归属线决定（根元素 id="tutor-replay" 供锚链）。
 */

import { useEffect, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';

import { cn } from '@/lib/utils';

/** scratchpad 生成脚本落盘结构（一轮 ask + verdict 的拼装） */
interface TutorReplay {
  sceneTitle: string;
  courseTitle: string;
  question: string;
  expectedPoints: string[];
  learnerAnswer: string;
  verdict: 'correct' | 'partial' | 'incorrect';
  because: string[];
  explanation: string;
  quote: string;
  source: { traceId: string; generatedAt: string };
}

const VERDICT_META: Record<TutorReplay['verdict'], { label: string; cls: string }> = {
  correct: { label: '判定 · 正确', cls: 'bg-green-soft text-green-deep' },
  partial: { label: '判定 · 部分正确', cls: 'bg-yellow-soft text-yellow-deep' },
  incorrect: { label: '判定 · 有误', cls: 'bg-red-soft text-red-deep' },
};

export function TutorReplaySection() {
  const [data, setData] = useState<TutorReplay | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/tutor-replay.json');
        if (!res.ok) return; // 文件未生成 ⇒ 整块不渲染
        const body = (await res.json()) as TutorReplay;
        if (!cancelled && body.question && body.verdict && VERDICT_META[body.verdict]) {
          setData(body);
        }
      } catch {
        /* 静态文件不可用 ⇒ 保持空态 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;
  const verdict = VERDICT_META[data.verdict];

  return (
    <section id="tutor-replay" className="mx-auto max-w-3xl px-4 sm:px-6">
      <div className="mb-5 space-y-1.5">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-purple-soft">
            <MessageCircleQuestion className="size-4 text-purple-deep" />
          </span>
          导学不是单向播放：系统会追问你
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          一轮导学的静态回放：引擎从公开课「{data.courseTitle}」的「{data.sceneTitle}
          」讲义现场生成探问，学习者答错一半，审核智能体对照讲义原文给出裁决与降维解释。
        </p>
      </div>

      <div className="space-y-3">
        {/* 探问气泡（引擎侧，靠左） */}
        <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border/70 bg-card p-3.5 shadow-card">
          <p className="mb-1 text-xs font-medium text-purple-deep">导学 Agent · 探问</p>
          <p className="text-sm leading-relaxed">{data.question}</p>
        </div>

        {/* 学习者作答气泡（靠右） */}
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-purple-soft p-3.5">
          <p className="mb-1 text-xs font-medium text-purple-deep">学习者作答</p>
          <p className="text-sm leading-relaxed">{data.learnerAnswer}</p>
        </div>

        {/* 裁决卡 */}
        <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-card">
          <span
            className={cn(
              'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
              verdict.cls,
            )}
          >
            {verdict.label}
          </span>

          {data.because.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                裁决依据（逐条对照判分要点）
              </p>
              <ul className="space-y-1.5">
                {data.because.map((b) => {
                  // 判分要点的三种走向按前缀识别，给一眼可辨的符号
                  const mark = b.startsWith('命中')
                    ? { sym: '✓', cls: 'text-green-deep bg-green-soft' }
                    : b.startsWith('部分')
                      ? { sym: '~', cls: 'text-yellow-deep bg-yellow-soft' }
                      : { sym: '✗', cls: 'text-red-deep bg-red-soft' };
                  return (
                    <li key={b} className="flex gap-2 text-sm leading-relaxed text-muted-foreground">
                      <span
                        className={cn(
                          'mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                          mark.cls,
                        )}
                      >
                        {mark.sym}
                      </span>
                      <span>{b}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {data.explanation && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">降维解释</p>
              <p className="text-sm leading-relaxed">{data.explanation}</p>
            </div>
          )}

          {data.quote && (
            <blockquote className="border-l-2 border-purple-deep/40 bg-muted/50 py-2 pl-3 pr-2 text-sm leading-relaxed text-muted-foreground">
              讲义原句：{data.quote}
            </blockquote>
          )}
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        本回放为一次引擎调用的存档（trace{' '}
        <code className="rounded bg-muted px-1">{data.source.traceId.slice(0, 8)}</code>，
        {data.source.generatedAt.slice(0, 10)} 生成）。登录进课后，探问会跟着你正在读的小节走。
      </p>
    </section>
  );
}
