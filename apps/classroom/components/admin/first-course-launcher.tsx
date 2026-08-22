'use client';

/**
 * 投币机第三段：建库成功后，从时间线直接发起这个新领域的第一门课。
 *
 * 用户把要做的事定成了两件平级的交付物——「饮料机能工作」和「这个工作被看见」。
 * 前两段（领域知识处理七站、个性化注册⑧站）都在 run 的事件流里，看得见；
 * 第三段原来是断的：库建成了，管理者得自己离开这一页、去首页、填需求、才能造出第一门课，
 * 中间发生了什么在这条时间线上完全看不到。
 *
 * 这个组件把断点接上：一键用新库发起一次真实的批量生成，拿到课号就给出入口。
 * 那条链已经有骨架先落盘（大纲一出来课就存在）与逐屏追加落盘，所以点进去看到的
 * 不是转圈，是这门课一屏屏长出来——等待本身就是可看的东西。
 *
 * 只在 run 成功后出现。库没建好时后端会拦（`corpusUnavailableReason`），
 * 这里不重复判一遍——两处判据会长歪，以后端为准。
 */
import { useState } from 'react';
import Link from 'next/link';
import { Loader2, PlayCircle, ExternalLink } from 'lucide-react';
import { domainLabel } from '@/lib/knowledge/domain-labels';

type Phase = 'idle' | 'starting' | 'running' | 'ready' | 'failed';

export function FirstCourseLauncher({ corpus, scope }: { corpus: string; scope?: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [classroomId, setClassroomId] = useState<string | null>(null);
  const [note, setNote] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setPhase('starting');
    setError(null);
    try {
      const res = await fetch('/api/generate-classroom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 需求就用接入时填的「这个域要培养什么人」——那是管理者自己写的话，
          // 比我们替他编一个主题诚实。没填就退回一句最朴素的。
          requirement: scope
            ? `面向${scope}的入门课程，从这个领域最基础的概念讲起。`
            : `${domainLabel(corpus)}的入门课程，从这个领域最基础的概念讲起。`,
          agentMode: 'api',
          learnerProfile: { corpus },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        jobId?: string;
        error?: string;
      };
      if (!res.ok || !body.jobId) {
        setPhase('failed');
        setError(body.error ?? `发起失败（HTTP ${res.status}）`);
        return;
      }
      setPhase('running');
      poll(body.jobId);
    } catch (e) {
      setPhase('failed');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 轮询到拿着课号就够——课在骨架落盘那一刻就能进去看，不必等整门课跑完。 */
  const poll = async (jobId: string) => {
    for (let i = 0; i < 360; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const r = await fetch(`/api/generate-classroom/${jobId}`).catch(() => null);
      if (!r?.ok) continue;
      const j = (await r.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        classroomId?: string;
        scenesGenerated?: number;
        totalScenes?: number;
        error?: string;
      };
      if (j.message) {
        setNote(
          j.totalScenes
            ? `${j.message}（已落盘 ${j.scenesGenerated ?? 0}/${j.totalScenes} 屏）`
            : j.message,
        );
      }
      if (j.classroomId && !classroomId) {
        setClassroomId(j.classroomId);
        setPhase('ready'); // 课已经存在，可以进去看它长出来
      }
      if (j.status === 'succeeded') {
        setNote(`这门课已经跑完（${j.scenesGenerated ?? 0} 屏）`);
        return;
      }
      if (j.status === 'failed') {
        setPhase('failed');
        setError(j.error ?? '生成失败');
        return;
      }
    }
    setNote('轮询超时，任务可能仍在跑——去课程墙看看这门课在不在');
  };

  return (
    <section className="mt-6 rounded-xl border border-border bg-surface p-4">
      <h2 className="text-sm font-medium text-foreground">第三段 · 这个领域的第一门课</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        库已经建好了。点一下用它生成第一门课——大纲出来课就存在，可以进去看着每一屏
        长出来，不用等整门课跑完。生成过程由七个智能体协同完成，课堂里的车间面板逐条直播。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase === 'idle' && (
          <button
            type="button"
            onClick={start}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
          >
            <PlayCircle className="size-3.5" />
            用「{domainLabel(corpus)}」生成第一门课
          </button>
        )}

        {(phase === 'starting' || phase === 'running') && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {phase === 'starting' ? '正在发起…' : note || '生成中…'}
          </span>
        )}

        {phase === 'ready' && classroomId && (
          <>
            <Link
              href={`/classroom/${classroomId}`}
              target="_blank"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-accent"
            >
              进课堂看它生成
              <ExternalLink className="size-3 text-muted-foreground" />
            </Link>
            <span className="text-xs text-muted-foreground">{note}</span>
          </>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs leading-relaxed text-red-600 dark:text-red-400">{error}</p>
      )}
    </section>
  );
}
