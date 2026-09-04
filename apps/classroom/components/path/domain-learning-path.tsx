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
 *   - 有路径 → 画概念前置图（components/path/concept-graph.tsx），掌握度是节点着色。
 *
 * 2026-09 改版：原来逐阶列概念卡，没测评过的账户看到的是一屏「尚未测评」，
 * 库里 66 个概念 51 条前置边一个都看不出来。现在结构上图，掌握度着色，
 * 概念详情（先修、证据出处、挂的课、造课入口）收进图右侧的面板。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';

import { loadLearnerProfile } from '@/components/generation/learner-profile-popover';
import { ConceptGraph, type ConceptGraphNode } from '@/components/path/concept-graph';
import { KnowledgeUniverse } from '@/components/path/knowledge-universe';
import { DomainPathNotice } from '@/components/path/domain-path-notice';
import { TrackPractice } from '@/components/path/track-practice';
import { EmptyState } from '@/components/ui/empty-state';
import { conceptLabel } from '@/lib/knowledge/concept-labels';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { useAccountProfile } from '@/lib/knowledge/account-profile';
import { useEffectiveDomainContext } from '@/lib/knowledge/use-domain-context';
import { REQUIREMENT_DRAFT_KEY } from '@/lib/hooks/use-draft-cache';

/** 引擎 `/internal/v1/personalize/domain-path/{corpus}` 的返回体（跨工单契约）。 */
export interface DomainPathConcept {
  id?: string;
  name: string;
  depth: number;
  prereq?: string[];
  /** 概念 id 形式的前置（连边用它，`prereq` 是给人看的名字） */
  prereq_ids?: string[];
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

/** 图的两种看法。默认 3D：一屏能看见教材/章节/证据块这三层，2D 只有概念。 */
type GraphView = 'universe' | 'prereq';
const VIEW_KEY = 'jizhi.path.graphView';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; detail?: string }
  | { kind: 'ok'; path: DomainPath };

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
  // 课程挂到哪个概念上由 /api/course-path 说（它汇总场景的概念票），不在前端拿标题瞎匹配：
  // 「概念名是课程标题的子串」这种口径在智能制造那 66 个概念上几乎全不命中。
  const [conceptOfCourse, setConceptOfCourse] = useState<Record<string, string | null>>({});
  // 初值直接在渲染时读：这段只在画像与领域都定下来之后才挂载，服务端渲染到不了这里，
  // 所以不会有 hydration 不一致。带 #universe 进来的（首页那条入口）一律先看 3D。
  const [view, setView] = useState<GraphView>(() => {
    if (typeof window === 'undefined' || window.location.hash === '#universe') return 'universe';
    try {
      return localStorage.getItem(VIEW_KEY) === 'prereq' ? 'prereq' : 'universe';
    } catch {
      return 'universe';
    }
  });

  const chooseView = useCallback((next: GraphView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* 记不住就下次还是默认视图，不影响本次浏览 */
    }
  }, []);

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

  useEffect(() => {
    let alive = true;
    fetch(`/api/course-path/${encodeURIComponent(corpus)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { courses?: Record<string, { concept: string | null }> } | null) => {
        if (!alive || !data?.courses) return;
        setConceptOfCourse(
          Object.fromEntries(Object.entries(data.courses).map(([id, v]) => [id, v.concept])),
        );
      })
      .catch(() => {
        /* 挂载关系拉不到就是节点上没有课程角标，图本身照常画 */
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

  /** 把引擎的阶段结构摊平成图的节点表：中文名、挂的课、掌握度状态在这里合。 */
  const graphNodes = useMemo<ConceptGraphNode[]>(() => {
    if (state.kind !== 'ok') return [];
    const titles = new Map(courses.map((c) => [c.id, c.title]));
    const attached = new Map<string, Array<{ id: string; title: string }>>();
    for (const [courseId, concept] of Object.entries(conceptOfCourse)) {
      if (!concept) continue;
      const title = titles.get(courseId);
      if (!title) continue;
      (attached.get(concept) ?? attached.set(concept, []).get(concept)!).push({
        id: courseId,
        title,
      });
    }
    return (state.path.stages ?? []).flatMap((stage) =>
      stage.concepts.map((concept) => {
        const id = concept.id ?? concept.name;
        // 概念表里有中文名就用它（AI 库的 id 是 llm_basics 这种内部代号，不能上屏）；
        // 表里没有再退回引擎给的 name，最后才是 id 原样——不编名字。
        const known = conceptLabel(id);
        return {
          id,
          label: known !== id ? known : concept.name || id,
          stage: stage.index,
          prereq: concept.prereq_ids ?? concept.prereq ?? [],
          status: concept.status,
          mastery: concept.mastery ?? null,
          confidence: concept.confidence ?? null,
          because: concept.because ?? null,
          section: concept.sections?.[0] ?? null,
          courses: attached.get(id) ?? [],
        };
      }),
    );
  }, [state, courses, conceptOfCourse]);

  // 掌握度已经在 domain-path 的返回体里了，3D 图不再单独去桥上要一遍——
  // 那会把 fetchLearnerBlueprint 那次诊断调用打两遍，换来同一份数据。
  const statusOfConcept = useMemo(
    () => Object.fromEntries(graphNodes.map((node) => [node.id, node.status])),
    [graphNodes],
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
      {/* 边数只在图左侧说一次，用真正画出来的那批边。引擎的 edge_count 与逐概念
          prereq_ids 展开后的条数不是同一个口径（智能制造 51 对 85），同屏印两个数
          没法解释，留画出来的那个。 */}
      {state.kind === 'ok' && (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {state.path.concept_count ?? 0} 个概念
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

      {state.kind === 'ok' && graphNodes.length > 0 && (
        <>
          <PersonalRouteSummary path={state.path} nodes={graphNodes} />
          <div role="tablist" aria-label="图的视图" className="mt-6 flex gap-2">
            {(
              [
                ['universe', '知识宇宙（3D）'],
                ['prereq', '前置图（2D）'],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => chooseView(key)}
                className={
                  view === key
                    ? 'rounded-md border border-primary/50 bg-primary/10 px-3 py-1.5 text-sm'
                    : 'rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground'
                }
              >
                {text}
              </button>
            ))}
          </div>
          {view === 'universe' ? (
            <KnowledgeUniverse
              corpus={corpus}
              courses={courses}
              conceptOfCourse={conceptOfCourse}
              statusOfConcept={statusOfConcept}
              onDraft={draftCourse}
            />
          ) : (
            <ConceptGraph nodes={graphNodes} onDraft={(node) => draftCourse(node.label)} />
          )}
        </>
      )}

      <TrackPractice
        corpus={corpus}
        courseTitles={Object.fromEntries(courses.map((course) => [course.id, course.title]))}
      />
    </>
  );
}

/**
 * 「我的当前路线」压成一条：四张几乎全空的阶段卡去掉了——没测评过的账户看到四张
 * 「本阶段尚无同源测评」，读者会以为这一页什么都没有。结构现在由图承担，
 * 这一条只说与账户有关的那几个数和当前推荐的概念。
 */
function PersonalRouteSummary({
  path,
  nodes,
}: {
  path: DomainPath;
  nodes: ReadonlyArray<ConceptGraphNode>;
}) {
  const counts = path.personalization?.counts ?? {};
  const current = nodes.filter((node) => node.status === 'current').map((node) => node.label);
  const measured = (path.personalization?.matched_mastery ?? 0) > 0;
  const first = nodes.filter((node) => node.stage === Math.min(...nodes.map((n) => n.stage)));
  return (
    <section
      aria-label="我的当前路线"
      className="mt-6 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="font-semibold">我的当前路线</p>
        <p className="min-w-0 flex-1 text-muted-foreground">
          {current.length
            ? `当前推荐：${current.slice(0, 3).join('、')}`
            : measured
              ? '本领域概念均已达标，没有待推进的节点。'
              : `还没有同源测评，路线从第 ${first[0]?.stage ?? 1} 阶的推荐概念开始：${first
                  .slice(0, 3)
                  .map((node) => node.label)
                  .join('、')}`}
        </p>
        <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
          已掌握 {counts.mastered ?? 0} · 当前推荐 {counts.current ?? 0} · 后续 {counts.future ?? 0}{' '}
          · 尚未测评 {counts.unmeasured ?? 0}
        </p>
      </div>
      {/* 这句连同引擎的 reason 一起保留：没有测评记录时得说清是「没测过」而不是「没内容」，
          这也是图上大片灰节点的唯一解释。 */}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        这是当前账户自己的路线：引擎只用账户级画像与测验掌握度移动游标，不改知识库已有概念和顺序。
        {measured ? '' : (path.personalization?.reason ?? '')}
      </p>
    </section>
  );
}
