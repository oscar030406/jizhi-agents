'use client';

/**
 * 同题异人对比 (/compare)
 *
 * 同一学习目标 × 两个不同画像，引擎各跑一遍完整多智能体闭环，并排看两份材料
 * 到底差在哪：难度、每节篇幅、代码示例数、例子取材、多出来的补基础小节。
 * 每列还挂一条审核结果（事实性分数与断言条数），差异归因写成人话、最多三条。
 *
 * 默认展示预生成对照（public/compare-showcase.json，只读，2026-08-10 落盘）；
 * 现场跑的结果走同一套渲染，两者只差一行来源标注。
 *
 * 2026-08-15 重做（WO-C3）：只上界面能指得出来的事实，内部术语与手绘批注圈全部撤掉；
 * 画像从只有名字的下拉项摊成四张明细卡，耗时标注从预生成对照的实测值算出来。
 *
 * 2026-08-15 再改（WO-D3）：现场跑从公共页撤出。未登录访客只看预生成对照，
 * 画像集与发起表单整块不渲染（不是置灰）；登录用户不受影响。
 * `?job=` 深链不受登录态影响——GET 轮询是只读的，链接发给谁都能看结果。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, GitCompareArrows, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SiteHeader } from '@/components/site-header';
import { EmptyState } from '@/components/ui/empty-state';
import { useAccountStore } from '@/lib/store/account';
import { cn } from '@/lib/utils';
import {
  BASE_LABEL,
  LEVEL_LABELS,
  PRESETS,
  WANTS_LABEL,
  type ComparePreset,
} from '@/app/compare/presets';
import {
  auditLine,
  formatElapsed,
  formatMinutesRange,
  humanDifferences,
  isRealDiff,
  pickPair,
  resumeDecision,
  serialRunEstimate,
  stripConceptPrefix,
  type CompareEntry,
  type CompareReport,
} from '@/app/compare/report';

type ReportState =
  | { kind: 'idle' }
  | { kind: 'loading'; startedAt: number }
  | { kind: 'ok'; report: CompareReport }
  | { kind: 'error'; message: string };

// ── 归属色：画像 A 绑蓝粉彩、画像 B 绑黄粉彩 ────────────────────────────────

const OWNER = [
  {
    tag: '画像 A',
    chip: 'bg-blue-soft text-blue-deep',
    cardBorder: 'border-blue-deep/20',
    soft: 'bg-blue-soft',
    deepText: 'text-blue-deep',
  },
  {
    tag: '画像 B',
    chip: 'bg-yellow-soft text-yellow-deep',
    cardBorder: 'border-yellow-deep/20',
    soft: 'bg-yellow-soft',
    deepText: 'text-yellow-deep',
  },
] as const;

// ── 小组件 ───────────────────────────────────────────────────────────────────

function DimRow({
  label,
  differs,
  children,
}: {
  label: string;
  differs?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5 transition-colors hover:bg-accent">
      <span className="w-20 shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={cn('min-w-0 text-sm leading-relaxed', differs ? 'font-semibold' : 'font-medium')}
      >
        {children}
        {differs && (
          <span className="ml-1.5 align-middle text-xs font-normal text-muted-foreground">
            两列不同
          </span>
        )}
      </span>
    </div>
  );
}

/** 画像明细卡：五个基础分值 + 想要什么材料 + 自带的学习目标，全部摊开。 */
function PresetCard({ preset, selectedAs }: { preset: ComparePreset; selectedAs: number | null }) {
  const owner = selectedAs === null ? null : OWNER[selectedAs];
  return (
    <div
      className={cn('rounded-xl border bg-card p-4', owner ? owner.cardBorder : 'border-border')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{preset.name}</span>
        {owner && (
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', owner.chip)}>
            {owner.tag}
          </span>
        )}
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-muted-foreground">教育背景</dt>
          <dd className="min-w-0 leading-relaxed">{preset.background}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-muted-foreground">基础分值</dt>
          <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {LEVEL_LABELS.map(([key, label]) => (
              <span key={key} className="whitespace-nowrap">
                {label} <span className="font-medium tabular-nums">{preset.levels[key]}/4</span>
              </span>
            ))}
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-muted-foreground">想要的材料</dt>
          <dd className="min-w-0 leading-relaxed">{preset.wantsText}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-muted-foreground">学习目标</dt>
          <dd className="min-w-0 leading-relaxed text-muted-foreground">{preset.goal}</dd>
        </div>
      </dl>
    </div>
  );
}

function ProfileColumn({
  entry,
  other,
  owner,
  showAll,
}: {
  entry: CompareEntry;
  other: CompareEntry;
  owner: (typeof OWNER)[number];
  showAll: boolean;
}) {
  const { profile, resources } = entry;
  const mix = profile.resource_mix;
  const otherMix = other.profile.resource_mix;
  const otherHeadings = new Set(other.resources.section_headings);
  const uniqueCount = resources.section_headings.filter((h) => !otherHeadings.has(h)).length;
  const audit = auditLine(entry.full_run?.audit);

  return (
    <Card className={cn('gap-4', owner.cardBorder)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg font-medium">
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', owner.chip)}>
            {owner.tag}
          </span>
          {profile.name}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">{profile.background}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 审核结果：生成完还被核过一遍，这一行此前被界面丢掉了 */}
        {audit && (
          <p className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2 text-sm leading-relaxed text-muted-foreground">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-deep" />
            <span>审核：{audit}</span>
          </p>
        )}

        <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
          <DimRow
            label="难度"
            differs={isRealDiff(
              profile.recommended_difficulty,
              other.profile.recommended_difficulty,
            )}
          >
            {profile.recommended_difficulty}
          </DimRow>
          <DimRow
            label="每节篇幅"
            differs={isRealDiff(mix?.section_length_band, otherMix?.section_length_band)}
          >
            {mix?.section_length_band ? `${mix.section_length_band} 字` : '未返回'}
          </DimRow>
          <DimRow
            label="代码示例"
            differs={
              typeof mix?.code_example_count === 'number' &&
              typeof otherMix?.code_example_count === 'number' &&
              mix.code_example_count !== otherMix.code_example_count
            }
          >
            {typeof mix?.code_example_count === 'number'
              ? `每节 ${mix.code_example_count} 个`
              : '未返回'}
          </DimRow>
          <DimRow
            label="例子取自"
            differs={isRealDiff(mix?.analogy_domain, otherMix?.analogy_domain)}
          >
            {mix?.analogy_domain || '未返回'}
          </DimRow>
          <DimRow label="讲义">
            {uniqueCount > 0
              ? `${resources.section_count} 节，其中 ${uniqueCount} 节只有这一列有`
              : `${resources.section_count} 节，与另一列结构相同`}
          </DimRow>
        </div>

        {/* 讲义目录：首尾圆角列表，只有这一列有的小节标归属色 */}
        <div>
          <p className="mb-1.5 text-sm text-muted-foreground">{resources.lecture_title}</p>
          <ol className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
            {resources.section_headings.map((h, i) => {
              const unique = !otherHeadings.has(h);
              return (
                <li
                  key={`${i}-${h}`}
                  className={cn(
                    'px-3 py-2 text-sm leading-relaxed transition-colors',
                    unique
                      ? cn(owner.soft, owner.deepText)
                      : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {i + 1}. {stripConceptPrefix(h)}
                  {unique && (
                    <span className="ml-1.5 rounded-full bg-background/60 px-1.5 py-0.5 text-xs font-medium">
                      只有这一列有
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        {/* 其余维度折叠，由页面级「查看全部差异」展开 */}
        {showAll && (
          <div className="space-y-4">
            <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
              <DimRow label="实操任务">
                {resources.task_difficulty} · {resources.task_steps} 步
              </DimRow>
              <DimRow label="测验">
                {resources.quiz_count} 题（{resources.quiz_difficulties.join(' / ') || '—'}）
              </DimRow>
              {mix && (
                <DimRow label="教具与图示">
                  可交互教具 {mix.visual_widget_count ?? 0} 个 · 图示 {mix.diagram_count ?? 0} 个
                </DimRow>
              )}
            </div>

            {/* 只给条数：概念在数据层是内部英文枚举（agent_basics 之类），不上 UI */}
            {profile.weak_concepts.length > 0 && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                诊断认定有 {profile.weak_concepts.length} 个概念的掌握度不到线。
              </p>
            )}

            {(profile.content_strategy?.length ?? 0) > 0 && (
              <div>
                <p className="mb-1 text-sm text-muted-foreground">这门课打算怎么讲</p>
                <ul className="space-y-0.5">
                  {profile.content_strategy!.map((s, i) => (
                    <li key={i} className="text-sm leading-relaxed text-muted-foreground">
                      · {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 两列对照 + 人话归因 + 事实不变量。预生成与现场跑共用。 */
function ComparisonView({ report, sourceNote }: { report: CompareReport; sourceNote: string }) {
  const [showAll, setShowAll] = useState(false);
  const pair = pickPair(report.entries);
  if (!pair) return null;
  const lines = humanDifferences(pair[0], pair[1], report.differences);

  return (
    // id 保留给站内深链（components/home/six-requirements.tsx 指向 /compare#compare-showcase）
    <div id="compare-showcase" className="space-y-6 scroll-mt-20">
      <p className="text-sm text-muted-foreground">
        学习目标：<span className="font-medium text-foreground">{report.learning_goal}</span>
        {' · '}
        {sourceNote}
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {pair.map((entry, i) => (
          <ProfileColumn
            key={entry.profile.profile_id || i}
            entry={entry}
            other={pair[1 - i]}
            owner={OWNER[i]}
            showAll={showAll}
          />
        ))}
      </div>

      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
        >
          <ChevronDown
            className={cn('size-4 transition-transform duration-150', showAll && 'rotate-180')}
          />
          {showAll ? '收起次要差异' : '查看全部差异'}
        </Button>
      </div>

      <section>
        <div className="mb-1 flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-purple-soft">
            <GitCompareArrows className="size-4 text-purple-deep" />
          </span>
          <h2 className="text-lg font-medium">差异从哪来</h2>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          下面每条里的数字都取自两个画像的输入字段与这次生成的结果，可以逐个对回上面两列。
        </p>
        {lines.length === 0 ? (
          <EmptyState
            title="没检出结构化差异"
            hint="引擎逐字段比过之后，难度、篇幅、代码示例数、讲义结构都落在同一档。换两个背景差得更远的画像再跑一次。"
          />
        ) : (
          <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
            {lines.map((line, i) => (
              <p key={i} className="p-4 text-sm leading-relaxed transition-colors hover:bg-accent">
                {line}
              </p>
            ))}
          </div>
        )}

        {report.fact_invariance && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-muted p-3 text-sm leading-relaxed text-muted-foreground">
            {report.fact_invariance.passed ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-deep" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-yellow-deep" />
            )}
            <span>
              两份材料一起核了 {report.fact_invariance.checked_claims} 条断言：
              {report.fact_invariance.passed
                ? '引用都落在各自检索到的教材里，没有互相矛盾的说法。'
                : '检出疑似不一致，请查看事实一致性复核详情。'}
            </span>
          </p>
        )}
      </section>
    </div>
  );
}

// ── 页面 ─────────────────────────────────────────────────────────────────────

/**
 * 在飞的对比 job 记在 URL 查询串上，不进 history 栈（replaceState）——
 * 用户点返回应该回到上一页，而不是在同一页的几个 job 之间打转。
 */
function setJobParam(jobId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('job', jobId);
  window.history.replaceState(null, '', url);
}

function clearJobParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('job')) return;
  url.searchParams.delete('job');
  window.history.replaceState(null, '', url);
}

export default function ComparePage() {
  const [goal, setGoal] = useState('完成 RAG 文档问答 Agent');
  const [presetA, setPresetA] = useState<string>('zero_beginner');
  const [presetB, setPresetB] = useState<string>('backend_to_agent');
  const [state, setState] = useState<ReportState>({ kind: 'idle' });
  const [showcase, setShowcase] = useState<CompareReport | null>(null);
  // 驱动「已耗时」计时的空转 state；卸载时 aliveRef 置 false 终止轮询
  const [, setTick] = useState(0);
  const aliveRef = useRef(true);

  // 现场跑只给登录用户：一次跑十几分钟引擎时间，公共页不摆这个入口。
  // 账户未就绪（loading）时两态都不渲染，避免先闪一下表单再收回去。
  const { account, loading: accountLoading, refresh: refreshAccount } = useAccountStore();
  const canRun = !accountLoading && !!account;

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 预生成对照：只读 public/ 下的静态文件，绝不现场跑。
  // 多组主题可切换（scripts/generate-compare-showcase.mjs 配 COMPARE_OUT 逐组生成）；
  // 文件不在（404）就不渲染该组的切换项，一组都没有则整块不渲染。
  const [showcaseIdx, setShowcaseIdx] = useState(0);
  const [showcases, setShowcases] = useState<CompareReport[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 组清单由生成器维护（`scripts/generate-compare-showcase.mjs` 写完自己登记）。
      // 原先这里硬编码两个文件名——新域跑了对照也进不了这个数组，
      // 「新域建成后同题异人立即可用」（D30）就永远差最后一步。
      // 清单不在（老部署）就退回那两个固定文件，不让整块空掉。
      const files = await fetch('/compare-showcase.index.json')
        .then((r) => (r.ok ? (r.json() as Promise<{ files?: string[] }>) : null))
        .then((idx) =>
          Array.isArray(idx?.files) && idx.files.length > 0
            ? idx.files
            : ['/compare-showcase.json', '/compare-showcase-tools.json'],
        )
        .catch(() => ['/compare-showcase.json', '/compare-showcase-tools.json']);
      const loaded: CompareReport[] = [];
      for (const f of files) {
        try {
          const res = await fetch(f);
          if (!res.ok) continue;
          const body = (await res.json()) as CompareReport;
          if (Array.isArray(body.entries) && body.entries.length >= 2) loaded.push(body);
        } catch {
          /* 单个文件不可用 ⇒ 跳过该组 */
        }
      }
      if (!cancelled && loaded.length > 0) {
        setShowcases(loaded);
        setShowcase(loaded[0]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (showcases[showcaseIdx]) setShowcase(showcases[showcaseIdx]);
  }, [showcaseIdx, showcases]);

  // 秒表只在等待期间跑
  useEffect(() => {
    if (state.kind !== 'loading') return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [state.kind]);

  /**
   * 轮询一个已存在的 job 直到终态。
   *
   * 抽出来是为了刷新后能接回去：引擎跑完一次对比要十几分钟，原先 jobId 只活在
   * submit 的闭包里，用户一刷新或一离开，**结果其实还在后台跑完了**（job 存在
   * 服务端 `globalThis`，TTL 2 小时），但页面再也找不回来，只能从头再跑一遍。
   */
  const pollUntilDone = useCallback(async (jobId: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 10_000));
      if (!aliveRef.current) return;
      let poll: { status?: string; result?: Partial<CompareReport>; error?: string };
      try {
        const pr = await fetch(`/api/compare?job=${encodeURIComponent(jobId)}`);
        poll = (await pr.json()) as typeof poll;
        if (!pr.ok) {
          clearJobParam();
          setState({ kind: 'error', message: poll.error ?? '对比任务已丢失，请重试。' });
          return;
        }
      } catch {
        continue; // 单次轮询网络抖动不终止整个等待
      }
      if (poll.status === 'failed') {
        clearJobParam();
        setState({ kind: 'error', message: `引擎对比失败：${poll.error ?? '未知错误'}` });
        return;
      }
      if (poll.status === 'succeeded') {
        clearJobParam();
        const report = poll.result;
        if (!report?.entries || report.entries.length < 2) {
          setState({ kind: 'error', message: '引擎返回的对比结果不完整，请重试。' });
          return;
        }
        setState({ kind: 'ok', report: report as CompareReport });
        return;
      }
      // queued / running ⇒ 继续等
    }
  }, []);

  // 刷新/回退后接回在飞的 job：URL 里带 ?job= 就先拉一次拿 elapsedMs 重建秒表起点，
  // 再继续轮询。job 不在了（过期/服务重启）就静默清掉参数回到 idle——
  // 不弹错，用户可能只是分享了一条旧链接。
  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get('job');
    if (!jobId) return;
    let cancelled = false;
    void (async () => {
      try {
        const pr = await fetch(`/api/compare?job=${encodeURIComponent(jobId)}`);
        const poll = (await pr.json()) as Parameters<typeof resumeDecision>[0];
        if (cancelled || !aliveRef.current) return;
        const next = resumeDecision(poll, pr.ok, Date.now());
        if (next.kind === 'drop') {
          clearJobParam();
          return;
        }
        if (next.kind === 'ok') {
          clearJobParam();
          setState(next);
          return;
        }
        setState(next);
        void pollUntilDone(jobId);
      } catch {
        clearJobParam();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pollUntilDone]);

  const submit = async () => {
    if (!goal.trim()) {
      setState({ kind: 'error', message: '请先填写学习目标。' });
      return;
    }
    if (presetA === presetB) {
      setState({ kind: 'error', message: '请选择两个不同的画像——同一画像没有可比的差异。' });
      return;
    }
    setState({ kind: 'loading', startedAt: Date.now() });
    try {
      // 第一步：创建对比 job（引擎每画像跑完整闭环需数分钟，同步等待必超时）
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          learningGoal: goal.trim(),
          profiles: [{ preset_id: presetA }, { preset_id: presetB }],
        }),
      });
      const created = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !created.jobId) {
        setState({
          kind: 'error',
          message: created.error
            ? `创建对比任务失败：${created.error}`
            : '多智能体引擎未响应。请确认引擎服务已启动后重试。',
        });
        return;
      }

      // jobId 落进 URL：刷新、误触返回、把链接发给别人，都还能接回同一次运行
      setJobParam(created.jobId);

      // 第二步：每 10 秒轮询一次直到完成/失败
      await pollUntilDone(created.jobId);
    } catch (err) {
      setState({ kind: 'error', message: `请求失败：${String(err)}` });
    }
  };

  const liveReport = state.kind === 'ok' ? state.report : null;
  // 耗时估算从预生成对照里每个画像的实测 cost.duration_ms 现算，不写死数字
  const estimate = showcase ? serialRunEstimate(showcase.entries) : null;
  const estimateText = estimate ? formatMinutesRange(estimate.minMs, estimate.maxMs) : null;
  const showcaseDate = showcase?.generated_at?.slice(0, 10);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader localized={false} maxWidth="max-w-5xl" />

      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">同题异人对比</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            同一个学习目标，两个不同的人，引擎各完整生成一遍。并排看两份材料差在哪，
            以及这些差异对应画像里的哪个数值。
          </p>
        </div>

        {/* 对照区置顶：未登录时它本来就在这个位置（下面两块整块不渲染），登录后
            四张画像卡加发起表单有一屏多，把对照挤到折叠线以下，演示得先滚一段。
            这里改的是 DOM 顺序而不是 CSS order——视觉顺序与 Tab/朗读顺序保持一致。 */}
        {liveReport ? (
          <ComparisonView report={liveReport} sourceNote="这一次是刚刚现场生成的" />
        ) : (
          showcase && (
            <>
              {!canRun && !accountLoading && (
                <p className="rounded-xl border border-border bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                  下面这组对照是预先跑好的。换成自己的学习目标现场跑一遍要
                  {estimateText ?? '十几分钟'}的引擎时间，这部分放在登录之后。
                </p>
              )}
              {showcases.length > 1 && (
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="切换对照主题">
                  {showcases.map((s, i) => (
                    <button
                      key={s.learning_goal ?? i}
                      type="button"
                      role="tab"
                      aria-selected={i === showcaseIdx}
                      onClick={() => setShowcaseIdx(i)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        i === showcaseIdx
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      {s.learning_goal ?? `对照组 ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
              <ComparisonView
                report={showcase}
                sourceNote={`预先跑好的一组真实结果${showcaseDate ? `，${showcaseDate} 归档` : ''}`}
              />
            </>
          )
        )}

        {/* 画像集与发起表单：只有登录用户才有现场跑，未登录整块不渲染 */}
        {canRun && (
          <section>
            <h2 className="text-lg font-medium">可选的四个画像</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              按两件事分格：编程基础（Python 与工程实践的分值），以及想要什么样的材料
              （要例子和步骤，还是要设计图和接口）。两两组合正好四种，每种放一个。
              跑对比时用的是上面输入框里的目标，卡片里的学习目标是这个人原本想做的事。
            </p>
            <div className="mt-3 hidden grid-cols-2 gap-4 text-sm text-muted-foreground sm:grid">
              <span>{WANTS_LABEL.examples}</span>
              <span>{WANTS_LABEL.design}</span>
            </div>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <div key={p.id} className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    {BASE_LABEL[p.base]}
                    <span className="sm:hidden"> · {WANTS_LABEL[p.wants]}</span>
                  </p>
                  <PresetCard
                    preset={p}
                    selectedAs={presetA === p.id ? 0 : presetB === p.id ? 1 : null}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 表单 */}
        {canRun && (
          <Card>
            <CardContent className="space-y-4">
              <div>
                <label htmlFor="compare-goal" className="mb-1.5 block text-sm font-medium">
                  学习目标
                </label>
                <Input
                  id="compare-goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="例如：完成 RAG 文档问答 Agent"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    { owner: OWNER[0], value: presetA, set: setPresetA },
                    { owner: OWNER[1], value: presetB, set: setPresetB },
                  ] as const
                ).map((sel) => (
                  <div key={sel.owner.tag}>
                    <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          sel.owner.chip,
                        )}
                      >
                        {sel.owner.tag}
                      </span>
                    </label>
                    <Select value={sel.value} onValueChange={sel.set}>
                      <SelectTrigger className="w-full" aria-label={sel.owner.tag}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRESETS.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {/* 守卫在 submit() 里本来就有（空目标/同画像都提前返回，不会烧钱），
                但按钮看着可点、点了才报错是坏体验——把不可用的原因前置到按钮上。 */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  onClick={submit}
                  disabled={state.kind === 'loading' || !goal.trim() || presetA === presetB}
                  title={
                    !goal.trim()
                      ? '先填写学习目标'
                      : presetA === presetB
                        ? '请选择两个不同的画像'
                        : undefined
                  }
                  className="gap-1.5"
                >
                  {state.kind === 'loading' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <GitCompareArrows className="size-4" />
                  )}
                  {state.kind === 'loading' ? '引擎生成中…' : '开始对比'}
                </Button>
                {estimateText && (
                  <span className="text-sm text-muted-foreground">
                    两个画像一个跑完再跑下一个，{estimateText}。
                  </span>
                )}
              </div>
              {estimate && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  耗时按上面那份预生成对照里每个画像的实测值相加得出：
                  {showcase!.entries
                    .map((e) => formatElapsed(e.cost?.duration_ms ?? 0))
                    .join(' / ')}
                  {showcaseDate ? `（${showcaseDate} 归档）` : ''}。实际时长随模型响应速度浮动。
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {state.kind === 'loading' && (
          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted px-4 py-6 text-sm leading-relaxed text-muted-foreground">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
            <span>
              两个画像各跑一遍完整闭环（诊断 → 检索 → 生成 → 审核），一个跑完再跑下一个
              {estimateText ? `，${estimateText}` : ''}。这一页可以一直开着，
              刷新或关掉再回来也能接回同一次运行。
              <span className="mt-1 block font-medium text-foreground">
                已耗时 {formatElapsed(Date.now() - state.startedAt)}
              </span>
            </span>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex items-start gap-2 rounded-xl border border-red-deep/20 bg-red-soft px-4 py-3 text-sm leading-relaxed text-red-deep">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{state.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
