'use client';

/**
 * 域级学习路径（学习端）。
 *
 * /path 对所有知识库展示引擎按索引与前置图排出来的阶段；AI 主库不再走手工
 * learning-path.json 旁路。
 *
 * 为什么是 client 组件：画像存在 localStorage（`loadLearnerProfile`），server component
 * 读不到。
 *
 * 三种终态必须能分辨（这正是本轮要修的病：它们曾被压成同一个「没有路径」）：
 *   - 引擎不可达/报错 → 「学习路径服务暂时不可用」，不冒充「这个域没有路径」；
 *   - `source=none` → 引擎给的 reason 原样上屏（该库没跑过接入流水线之类）；
 *   - 有路径 → 逐阶列概念，命中已生成课的可点进课堂，没课的给造课入口。
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Sparkles } from 'lucide-react';

import { loadLearnerProfile } from '@/components/generation/learner-profile-popover';
import { DomainPathNotice } from '@/components/path/domain-path-notice';
import { TrackPractice } from '@/components/path/track-practice';
import { EmptyState } from '@/components/ui/empty-state';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { truncateLabel } from '@/lib/knowledge/domain-registry';
import { useAccountProfile } from '@/lib/knowledge/account-profile';
import { useEffectiveDomainContext } from '@/lib/knowledge/use-domain-context';
import { REQUIREMENT_DRAFT_KEY } from '@/lib/hooks/use-draft-cache';
import { cn } from '@/lib/utils';

/** 引擎 `/internal/v1/personalize/domain-path/{corpus}` 的返回体（跨工单契约）。 */
export interface DomainPathConcept {
  id?: string;
  name: string;
  depth: number;
  prereq?: string[];
  /** 该概念入边的最低置信度；没有入边（入口概念）时为 null */
  confidence?: number | null;
  because?: string | null;
  sections?: string[];
  status?: PathStatus;
  mastery?: number;
}

type PathStatus = 'mastered' | 'current' | 'future' | 'unmeasured';

export interface DomainPathStage {
  index: number;
  title: string;
  concepts: DomainPathConcept[];
  status?: PathStatus;
}

export interface DomainPath {
  corpus: string;
  label?: string;
  /** index-graph/intake = 前置图排的；index-tags = 按索引标注覆盖厚度分档；none = 排不出 */
  source: 'index-graph' | 'intake' | 'index-tags' | 'none';
  generated_at?: string | null;
  run_id?: string | null;
  concept_count?: number;
  edge_count?: number;
  stages?: DomainPathStage[];
  reason?: string | null;
  caliber?: string;
  personalization?: {
    profile_present?: boolean;
    mastery_entries?: number;
    matched_mastery?: number;
    mastery_threshold?: number;
    counts?: Partial<Record<PathStatus, number>>;
    current?: string[];
    reason?: string | null;
    mastery_available?: boolean;
  };
}

interface CourseDomainEntry {
  domain: string;
  title: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; detail?: string }
  | { kind: 'ok'; path: DomainPath };

/** 与 app/path/page.tsx 同名常量同一口径：--ring 带 alpha 实测看不见，借 chart-2 顶上。 */
const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chart-2';

/** 概念名与课程标题的对齐口径：大小写与空格不敏感，其余原样比。 */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function DomainLearningPath({ children: _children }: { children?: React.ReactNode }) {
  // 指派解析前不能先画 AI children：残留 AI 画像 + 智能制造指派时，那会造成一次可见的错域闪屏。
  const profileState = useAccountProfile(loadLearnerProfile);
  const contextState = useEffectiveDomainContext(
    profileState.kind === 'ready' ? profileState.profile : null,
    profileState.kind === 'ready',
  );

  if (profileState.kind === 'error') {
    return <EmptyState title="当前账户画像暂时无法读取" hint={profileState.reason} />;
  }
  if (profileState.kind === 'loading' || contextState.kind === 'loading') {
    return <p className="mt-8 text-sm text-muted-foreground">正在确认当前学习领域…</p>;
  }
  if (contextState.kind === 'error') {
    return <EmptyState title="当前学习领域暂时无法确认" hint={contextState.reason} />;
  }
  const { context } = contextState;
  if (!context.domain) {
    return (
      <EmptyState
        title={
          context.status === 'assignment-unavailable'
            ? '机构课程暂不可用'
            : '机构指派课程的领域尚未确认'
        }
        hint={context.reason ?? '课程归属由引擎生成；归属产物补齐前不会展示其它领域的路径。'}
      />
    );
  }
  return <DomainPathBody corpus={context.domain} contextLabel={context.label} />;
}

function DomainPathBody({ corpus, contextLabel }: { corpus: string; contextLabel?: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  // 概念 → 课程的映射用运行时归属（/api/course-domains 现读磁盘），不用构建期快照：
  // 新生成的课不在快照里，会在这一页上隐形（首页域课程卡踩过同一个坑）。
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/domain-path/${encodeURIComponent(corpus)}`, {
          cache: 'no-store',
        });
        const body = (await res.json().catch(() => null)) as {
          success?: boolean;
          path?: DomainPath;
          error?: string;
          details?: string;
        } | null;
        if (!alive) return;
        if (!res.ok || !body?.success || !body.path) {
          setState({
            kind: 'error',
            message: body?.error ?? '学习路径服务暂时不可用。',
            detail: body?.details,
          });
          return;
        }
        setState({ kind: 'ok', path: body.path });
      } catch (error) {
        if (alive)
          setState({ kind: 'error', message: '学习路径服务暂时不可用。', detail: String(error) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [corpus]);

  useEffect(() => {
    let alive = true;
    fetch('/api/course-domains')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, CourseDomainEntry> | null) => {
        if (!alive || !data) return;
        setCourses(
          Object.entries(data)
            .filter(([, v]) => v.domain === corpus)
            .map(([id, v]) => ({ id, title: v.title })),
        );
      })
      .catch(() => {
        /* 归属拉不到就只是没有课程直达链接，路径本身照常展示 */
      });
    return () => {
      alive = false;
    };
  }, [corpus]);

  // 域名优先用引擎给的 label（域注册清单里的中文名），它没给就走前端那张兜底表。
  // `|| ` 不是 `?? `：老库的 label 会退化成目录名同名的空串/占位，那不是名字。
  // 引擎给的 label 若只是目录名本身（如 ai），不算名字，走登记表的中文名。
  const engineLabel = state.kind === 'ok' ? (state.path.label?.trim() ?? '') : '';
  const label =
    (engineLabel && engineLabel.toLowerCase() !== corpus.toLowerCase() ? engineLabel : '') ||
    contextLabel ||
    domainLabel(corpus);

  /** 把概念交给首页生成入口：写需求草稿再跳转（形制同 /skills 的 pickSkill）。 */
  const draftCourse = useCallback(
    (concept: string) => {
      const topic = `面向「${label}」领域的课程：${concept}。请给出讲解、实操与测验。`;
      try {
        localStorage.setItem(REQUIREMENT_DRAFT_KEY, JSON.stringify(topic));
      } catch {
        /* localStorage 不可用时首页照样打开，只是没预填 */
      }
      router.push('/');
    },
    [label, router],
  );
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{label} · 学习路径</h1>
      {state.kind === 'ok' && ['index-graph', 'intake'].includes(state.path.source) && (
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          这条路径不是人工排的：概念取自该库接入时抽出的概念表，先后顺序由前置关系图的
          拓扑深度分档。同一阶内的概念没有先后，学完一阶再进下一阶。
        </p>
      )}
      {state.kind === 'ok' && (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {state.path.concept_count ?? 0} 个概念 · {state.path.edge_count ?? 0} 条前置边
          {state.path.run_id ? ' · 接入批次已记录' : ''}
          {state.path.generated_at
            ? ` · ${new Date(state.path.generated_at).toLocaleDateString('zh-CN')} 生成`
            : ''}
        </p>
      )}
      <DomainPathNotice
        corpus={corpus}
        caliber={state.kind === 'ok' ? state.path.caliber : undefined}
      />

      {state.kind === 'loading' && (
        <p className="mt-8 text-sm text-muted-foreground">正在取「{label}」的学习路径…</p>
      )}

      {/* 引擎挂了。这一条必须长得和「该域没有路径」不一样——否则学员会把服务故障
          当成结论，以为自己的库天生没有路径。 */}
      {state.kind === 'error' && (
        <div
          role="alert"
          className="mt-8 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm leading-relaxed"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            {state.message}这不表示「{label}」没有学习路径——是取路径的服务此刻没答上来，
            稍后刷新本页重试。
            {state.detail && (
              <span className="mt-1 block text-xs text-muted-foreground">{state.detail}</span>
            )}
          </span>
        </div>
      )}

      {/* 排不出路径。source=none 是引擎说的，阶段为空是它没说但结果一样——两种都落这里，
          不留一个「0 个概念」的光标题让人以为页面坏了。 */}
      {state.kind === 'ok' && (state.path.source === 'none' || !state.path.stages?.length) && (
        <div className="mt-8">
          <EmptyState
            title={`「${label}」还没有可排的学习路径`}
            hint={
              state.path.reason ??
              '所属机构尚未提供该领域的学习路径产物。学习路径必须由引擎基于本领域概念与前置关系生成；当前没有可展示结果。'
            }
          />
        </div>
      )}

      {state.kind === 'ok' && Boolean(state.path.stages?.length) && (
        <PersonalRouteSummary path={state.path} />
      )}

      {state.kind === 'ok' &&
        (state.path.stages ?? []).map((stage) => (
          <section key={stage.index} className="mt-10">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{stage.title}</h2>
              <StatusBadge status={stage.status} />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {stage.concepts.map((concept) => (
                <ConceptCard
                  key={concept.name}
                  concept={concept}
                  course={courses.find((c) => norm(c.title).includes(norm(concept.name)))}
                  onDraft={() => draftCourse(concept.name)}
                />
              ))}
            </div>
          </section>
        ))}

      <TrackPractice
        corpus={corpus}
        courseTitles={Object.fromEntries(courses.map((course) => [course.id, course.title]))}
      />
    </>
  );
}

function ConceptCard({
  concept,
  course,
  onDraft,
}: {
  concept: DomainPathConcept;
  course?: { id: string; title: string };
  onDraft: () => void;
}) {
  const prereq = concept.prereq ?? [];
  const section = concept.sections?.[0];
  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 shadow-card',
        concept.status === 'current' ? 'border-primary/60 bg-primary/5' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        {course ? (
          <Link
            href={`/classroom/${course.id}`}
            className={cn(
              'group flex min-w-0 items-center gap-2 font-medium hover:text-primary',
              FOCUS_RING,
            )}
          >
            <span className="min-w-0 truncate">{concept.name}</span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        ) : (
          <p className="min-w-0 truncate font-medium">{concept.name}</p>
        )}
        <StatusBadge status={concept.status} />
      </div>
      {course && (
        <p className="mt-1 truncate text-xs text-muted-foreground">已有课程：{course.title}</p>
      )}

      {prereq.length > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          先修：{prereq.join('、')}
        </p>
      )}
      {section && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          证据出处：{truncateLabel(section, 30)}
        </p>
      )}
      {/* 没有置信度分两种：真是入口概念（前置图排的），或这条路径压根不是前置图排的
          （source=index-tags 时按覆盖块数分档）。后者说「入口概念」是在陈述一个没算过的
          拓扑事实——引擎在 because 里写了真正的依据，用它。 */}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {typeof concept.confidence === 'number'
          ? `前置判定置信度 ${concept.confidence.toFixed(2)}`
          : concept.because || '入口概念，没有前置'}
      </p>
      {typeof concept.mastery === 'number' && (
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
          当前掌握度 {concept.mastery.toFixed(2)}
        </p>
      )}

      {!course && (
        <button
          type="button"
          onClick={onDraft}
          className={cn(
            'mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs',
            'transition-colors hover:bg-muted/60 active:bg-muted',
            FOCUS_RING,
          )}
        >
          <Sparkles className="size-3.5" />
          按此概念造课
        </button>
      )}
    </div>
  );
}

function PersonalRouteSummary({ path }: { path: DomainPath }) {
  const counts = path.personalization?.counts ?? {};
  return (
    <section
      aria-label="我的当前路线"
      className="mb-8 rounded-xl border border-primary/30 bg-primary/5 p-4 shadow-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">我的当前路线</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          已掌握 {counts.mastered ?? 0} · 当前推荐 {counts.current ?? 0} · 后续 {counts.future ?? 0}{' '}
          · 尚未测评 {counts.unmeasured ?? 0}
        </p>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        这是当前账户自己的路线：引擎只用账户级画像与测验掌握度移动游标，不改知识库已有概念和顺序。
        {path.personalization?.matched_mastery === 0
          ? (path.personalization.reason ?? '当前尚无与本路径概念 ID 同源的测评记录。')
          : ''}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {(path.stages ?? []).map((stage) => {
          const current = stage.concepts
            .filter((concept) => concept.status === 'current')
            .map((concept) => concept.name);
          return (
            <div key={stage.index} className="rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{stage.title}</p>
                <StatusBadge status={stage.status} />
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {current.length
                  ? `当前推荐：${current.slice(0, 3).join('、')}`
                  : stage.status === 'mastered'
                    ? '本阶段已掌握'
                    : stage.status === 'unmeasured'
                      ? '本阶段尚无同源测评'
                      : '完成前置内容后进入'}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status?: PathStatus }) {
  if (!status) return null;
  const label =
    status === 'mastered'
      ? '已掌握'
      : status === 'current'
        ? '当前推荐'
        : status === 'unmeasured'
          ? '尚未测评'
          : '后续节点';
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'mastered'
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : status === 'current'
            ? 'bg-primary/10 text-primary'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}
