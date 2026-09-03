'use client';

/**
 * 审核实录页（/evidence）。
 *
 * 首页太长的分流承接（2026-08-09 用户反馈）：判官纠错卡、导学一轮回放、
 * 数字台账三个重证据区块从首页搬到这里；首页的六项枢纽卡与页脚链过来。
 * 全部内容与首页时代同源：真实 run 存档 + metrics.json 单一真源。
 */

import { useEffect, useState } from 'react';

import { SiteHeader } from '@/components/site-header';
import { EmptyState } from '@/components/ui/empty-state';
import { AuditShowcaseSection, type CourseAuditEntry } from '@/components/evidence/audit-showcase';
import { MetricsLedgerSection } from '@/components/evidence/metrics-ledger';
import { TutorReplaySection } from '@/components/evidence/tutor-replay';

export default function EvidencePage() {
  // 纠错卡挑选需要课程清单（AuditShowcaseSection 在首页由课程墙喂）。
  // 清单接口每门课已带 audit.flagged（非 supported 的断言数），直接当抓错数透传，
  // 不要再窄化成 {id,title}——那样组件只能靠拉全库 JSON 把这个数重算一遍。
  const [courses, setCourses] = useState<CourseAuditEntry[]>([]);
  // 清单三态分开记。原先只有 courses：在飞、拉失败、真没课，三种情况的
  // courses 都是空数组，而 AuditShowcaseSection 拿到空数组直接不渲染——
  // 用户看到的是「这一区块凭空少了一段」，分不清是还没到还是坏了。
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/classroom');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          classrooms?: Array<{ id: string; title: string; audit: { flagged: number } | null }>;
        };
        if (!cancelled) {
          setCourses(
            (body.classrooms ?? []).map((c) => ({
              id: c.id,
              title: c.title,
              catchCount: c.audit?.flagged ?? 0,
            })),
          );
          setListState('ready');
        }
      } catch {
        if (!cancelled) setListState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-[100dvh] w-full bg-background">
      <SiteHeader localized={false} />
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        <div className="pt-8">
          <h1 className="text-2xl font-semibold">审核实录</h1>
          <p className="mt-2 max-w-3xl text-sm leading-[1.75] text-muted-foreground">
            这里存放审核智能体批改的原句与修订，以及一轮导学的完整回放， 均取自生成过程的存档。
          </p>
        </div>

        {courses.length > 0 ? (
          <AuditShowcaseSection courses={courses} />
        ) : listState === 'loading' ? (
          // 只有「确实在飞」才走这一支；下面两支都是终态，用共享空态收口
          <p className="mt-16 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm leading-relaxed text-muted-foreground">
            正在读取课程清单…
          </p>
        ) : (
          <div className="mt-16">
            {listState === 'failed' ? (
              <EmptyState
                title="读不到课程清单"
                hint="课程清单这次没有正常返回。刷新页面重试；反复读不到就是本站的课程服务暂时不可用，稍后再来。"
              />
            ) : (
              <EmptyState
                title="课程墙上还没有课"
                hint="也就没有审核记录可看。先在首页生成一门课程，审核智能体的逐条判词会随课存档，再回到这里。"
              />
            )}
          </div>
        )}

        <div className="mt-16">
          <TutorReplaySection />
        </div>

        {/* 指标台账 2026-09-03 挂回来：文件一直在盘上（metrics.json 有 12 条 citations
            指向它），只是页面把渲染调用撤了，于是「值 / 口径 / 复算命令」三列谁也看不到。
            锚点 id="metrics-ledger" 在组件根上，深链照旧可用。 */}
        <MetricsLedgerSection />
      </main>
    </div>
  );
}
