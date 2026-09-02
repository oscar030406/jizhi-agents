'use client';

/**
 * 多智能体协同控制台 —— 赛题要求（2）的证据页。
 *
 * 七个职责分明的 Agent 组成「分析 → 生成 → 校验 → 决策」闭环。
 *
 * 页面顺序（2026-08-15 按用户反馈调过）：先讲**通用分工**——闭环示意与七个
 * Agent 的职责规格（谁管什么、用什么模型、输入输出），再看**某一门课的实例**。
 * 原来一进来先撞上某门课的生成情况，读的人不知道自己在看什么。
 *
 * 课程不再锁死在最新一门：顶部切换器从 /api/classroom 枚举已落库课程，
 * 选中的课在 store 里就用 store 的场景（含本次生成被拦下的场景），否则拉落库副本。
 *
 * 数据纪律：轨迹与指标全部读自 `scene.audit`（由 /api/generate/scene-audit 在
 * 生成管线里写入并随场景持久化）。没有 audit 的场景如实标注为"未经审核门禁"，
 * 绝不按通过计。任何一格拿不到数据都显示空态并说明原因，不用占位数字。
 *
 * 视觉规格：design-language-spec.md §3.5——首屏优先协同过程/决策记录、
 * 大数卡收敛到 4 个其余下钻（⑪），字号四档 + h-14 header + 留白分组（⑩），
 * 列表首尾圆角、行 hover bg-accent、展开行左侧 2px 紫条（⑯③）。
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Boxes, ChevronDown, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SiteHeader } from '@/components/site-header';
import { EmptyState } from '@/components/ui/empty-state';
import { AGENT_ART, AGENT_PERSONAS, type AgentKey } from '@/components/agents/agent-avatar';
// 目标正确率带从真源取，不在文案里抄数字（2026-08-28 清查 M2：曾写死 70%-85%，
// 与两个后端的 0.75–0.85 都对不上）。
import { TARGET_SUCCESS_MAX, TARGET_SUCCESS_MIN } from '@/lib/generation/selection';
import { summarizeGate } from '@/components/agents/gate-summary';
import { arbiterLabel, judgePanelLabel } from '@/components/agents/judge-labels';
import { fetchClassroomFromApi } from '@/lib/classroom/load-classroom';
import { useStageStore } from '@/lib/store';
import type { SceneAudit } from '@/lib/generation/hallucination-audit';
import type { Scene } from '@/lib/types/stage';

// ============================================================================
// 1. Agent 职责规格（系统说明，非运行数据）
// ============================================================================

interface AgentSpec {
  step: string;
  phase: string;
  name: string;
  /** 拟人化形象 key（头像 / 姓名 / 口头禅） */
  persona: AgentKey;
  /** 用什么模型 / 是否纯规则实现（可复算，不调模型）。 */
  engine: string;
  deterministic: boolean;
  input: string;
  output: string;
  source: string;
}

const AGENTS: AgentSpec[] = [
  {
    step: '①',
    phase: '分析',
    name: '学情诊断 Agent',
    persona: 'diagnosis',
    engine: '规则 + 掌握度模型（无 LLM 采样）',
    deterministic: true,
    input:
      '学习者画像：目标领域、学历、身份来路、五维自评（编程/Python/Agent/RAG/工程化）、学习偏好、时间预算',
    output:
      '掌握度向量、薄弱概念、推荐难度档、学习风险、资源配比（支架深度 / 组件与图示配额 / 类比领域 / 篇幅档 / 测验难度带），每项附推导依据，可回溯到画像维度',
    source: '学习者画像、推导依据与个性化蓝图',
  },
  {
    step: '①',
    phase: '分析',
    name: '知识检索 Agent',
    persona: 'retrieval',
    engine: '受控知识库检索（无生成）',
    deterministic: true,
    input: '课程标题 + 场景标题与描述',
    output: '带来源编号的证据块、命中概念与证据摘要——同一份证据同时提供给生成与审核，构成事实边界',
    source: '知识库命中记录与正文摘录块',
  },
  {
    step: '②',
    phase: '生成',
    name: '内容生成 Agent',
    persona: 'generation',
    engine: '平台配置的课程内容生成模型，采样非确定',
    deterministic: false,
    input: '场景大纲 + 学情蓝图指令 + 证据事实边界（由前两个 Agent 注入，不改变原生课程结构）',
    output: '场景内容 JSON：幻灯片 / 测验 / 互动组件 / PBL',
    source: '场景生成记录与课程正文',
  },
  {
    step: '③',
    phase: '校验',
    name: '审核 Agent',
    persona: 'judge',
    engine: '两个异厂商审核模型，均独立于生成模型',
    deterministic: false,
    input: '生成出的教学文本 + 与生成同源的证据',
    output:
      '逐条断言判定（supported / uncertain / incorrect）→ 场景判定 → 门禁裁决：直接放行 / 带风险标记放行 / 拦截转人工。判错触发一轮定向修订后复审。两个审核智能体（甲/乙）异厂商配置、互不通气各自独立判定，判定一致即成共识，分歧才升级仲裁',
    source: '随课保存的逐条审核判词与修订记录',
  },
  {
    step: '③',
    phase: '校验',
    name: '仲裁 Agent',
    persona: 'arbiter',
    engine: '终审仲裁模型，独立于两个审核智能体与作者模型',
    deterministic: false,
    input: '两个审核智能体的分歧断言（含各自判定与理由）+ 作者模型答辩 + 参考资料',
    output:
      '逐条终审判定（supported / uncertain / incorrect，判错必附修正表述），只有仲裁裁定的错误才触发重写；未配置或裁决不可用时保留两个审核智能体中较严一方。门禁阈值与最终仲裁环节保持一致',
    source: '分歧断言、作者申辩与终审记录',
  },
  {
    step: '④',
    phase: '决策',
    name: '反馈决策 Agent',
    persona: 'decision',
    engine: '阈值仲裁（无 LLM 采样）',
    deterministic: true,
    input: '测验正确率 + 当前难度档 + 分概念得分',
    output:
      '四选一路由：降维解释 / 补充练习 / 进阶挑战 / 保持路线，附更新后的难度档、下一步动作与推导依据',
    source: '测验结果与下一步学习决策记录',
  },
  {
    step: '④',
    phase: '决策',
    name: '导学 Agent',
    persona: 'tutor',
    engine:
      '讲义驱动路径：探问与判分由模型根据当前讲义节生成，引用必须逐字锚定原文，引不出即丢弃；服务不可用时明确标记。题库路径：裁决走显式规则',
    deterministic: false,
    input: '当前讲义节正文 / 概念 + 本轮所需的完整答题历史 + 画像推荐难度档',
    output: `每轮：探测提问 → 判分 → 裁决（降维解释 / 推进 / 进阶挑战）附推导依据与掌握度估计。裁决绑定目标正确率带 ${Math.round(TARGET_SUCCESS_MIN * 100)}%-${Math.round(TARGET_SUCCESS_MAX * 100)}%（下界为 Math Garden 工程取值，上界为 Wilson 2019 的 85% 规则）：冲破带顶转进阶、跌破带底先降维。判分同时回传本小节的掌握度估计（带置信度），滚动修订学习者画像`,
    source: '导学回放、判分依据与掌握度更新记录',
  },
];

/** 阈值由 lib/generation/hallucination-audit.ts 定义，此处仅作展示说明。 */
const GATE_NOTE = '门禁阈值：事实性 ≥ 0.62 且幻觉率 ≤ 0.10 方可放行（与引擎仲裁 Agent 同参）';

/**
 * 可见的键盘焦点圈（WCAG 2.4.7）。
 *
 * 全局 `* { outline-ring/50 }` 只给了颜色没给宽度，实测焦点圈是 0.56px、
 * alpha 0.2 的蓝，跟背景的对比度 1.6–1.8:1，达不到 1.4.11 要求的 3:1，肉眼基本看不见。
 * `--ring` 自带 0.4 alpha，压到任何底色上都上不了 3:1，所以这里改用不透明的 `--primary`：
 * 实测亮色 6.94:1、暗色 3.57:1，两套主题都过线。
 * `--ring` 的 alpha 是全站问题，要在 globals.css 里改，本次不动。
 */
/*
 * 外扩版已删（2026-08-13）：globals.css 的 base 层现在给每个 :focus-visible 都补了
 * `outline: 2px solid var(--ring-solid)` + offset 2，与这里原来写的一模一样，
 * 只是颜色回到规格 2.8 定的中性蓝而不是 --primary。
 * 实测换过来暗色还更好：--primary 3.57:1 → --ring-solid 7.96:1。
 *
 * 下面这条**不能删**：外层 overflow-hidden 会把外扩的焦点圈整圈裁掉，
 * 全局规则处理不了这种，必须往内画。
 */
const FOCUS_RING_INSET =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-primary';

// ============================================================================
// 2. 闭环示意（纯 SVG，跟随明暗模式）
// ============================================================================

const PHASES: Array<{ x: number; label: string; agents: string[] }> = [
  { x: 20, label: '① 分析', agents: ['学情诊断 Agent', '知识检索 Agent'] },
  { x: 260, label: '② 生成', agents: ['内容生成 Agent'] },
  { x: 500, label: '③ 校验', agents: ['审核 Agent', '仲裁 Agent'] },
  { x: 740, label: '④ 决策', agents: ['反馈决策 Agent', '导学 Agent'] },
];

function LoopDiagram() {
  return (
    <svg
      viewBox="0 0 960 152"
      className="w-full h-auto"
      role="img"
      aria-label="分析、生成、校验、决策四阶段横向流水线，决策结果回流至分析形成闭环"
    >
      {PHASES.map((p, i) => (
        <g key={p.label}>
          <rect
            x={p.x}
            y={16}
            width={200}
            height={64}
            rx={10}
            className="fill-purple-soft stroke-purple-deep/30"
            strokeWidth={1.5}
          />
          <text
            x={p.x + 100}
            y={p.agents.length > 1 ? 36 : 44}
            textAnchor="middle"
            className="fill-foreground"
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            {p.label}
          </text>
          {p.agents.map((a, j) => (
            <text
              key={a}
              x={p.x + 100}
              y={(p.agents.length > 1 ? 53 : 63) + j * 15}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 11 }}
            >
              {a}
            </text>
          ))}
          {i < PHASES.length - 1 && (
            <g>
              <line
                x1={p.x + 202}
                y1={48}
                x2={p.x + 232}
                y2={48}
                strokeWidth={1.5}
                className="stroke-muted-foreground/60"
              />
              <polygon
                points={`${p.x + 240},48 ${p.x + 230},43 ${p.x + 230},53`}
                className="fill-muted-foreground/60 stroke-none"
              />
            </g>
          )}
        </g>
      ))}

      {/* 闭环回流：决策结果回注下一轮分析 */}
      <path
        d="M 840 82 L 840 108 Q 840 120 828 120 L 132 120 Q 120 120 120 108 L 120 90"
        fill="none"
        strokeWidth={1.5}
        strokeDasharray="5 4"
        className="stroke-primary/60"
      />
      <polygon points="120,80 114,91 126,91" className="fill-primary/60" />
      <text
        x={480}
        y={142}
        textAnchor="middle"
        className="fill-muted-foreground"
        style={{ fontSize: 11 }}
      >
        闭环回流 · 决策产出的新难度档与补练路线回注下一轮学情诊断
      </text>
    </svg>
  );
}

// ============================================================================
// 3. 真实执行轨迹（读 scene.audit）
// ============================================================================

const VERDICT_LABEL: Record<SceneAudit['verdict'], { text: string; cls: string }> = {
  pass: { text: '通过', cls: 'text-green-deep' },
  caveat: { text: '存疑已标注', cls: 'text-yellow-deep' },
  revised: { text: '判错后已修订', cls: 'text-blue-deep' },
  flagged: { text: '仍有错误 / 审核未完成', cls: 'text-red-deep' },
};

const DECISION_LABEL: Record<SceneAudit['decision'], { text: string; cls: string }> = {
  publish: { text: '直接放行', cls: 'border-green-deep/20 bg-green-soft text-green-deep' },
  publish_with_warnings: {
    text: '带风险标记放行',
    cls: 'border-yellow-deep/20 bg-yellow-soft text-yellow-deep',
  },
  block_pending_review: {
    text: '拦截 · 转人工复核',
    cls: 'border-red-deep/20 bg-red-soft text-red-deep',
  },
};

/**
 * IndexedDB 里可能存着早于「门禁裁决」字段的旧审核记录（decision/rationale 缺失）。
 * 直接查表会拿到 undefined 再取 .cls 而整页崩溃，所以两处查表都给兜底：
 * 缺什么就如实说缺什么，不猜一个裁决出来。
 */
const UNKNOWN_VERDICT = { text: '该记录没有门禁结论', cls: 'text-muted-foreground' };
const UNKNOWN_DECISION = {
  text: '无门禁裁决记录',
  cls: 'border-border bg-muted text-muted-foreground',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-sm break-words">{children}</div>
    </div>
  );
}

/** 轨迹行：摘要常显，细节点击下钻；展开行左侧 2px 紫条（⑪③⑯）。 */
function TraceRow({ scene, index }: { scene: Scene; index: number }) {
  const [open, setOpen] = useState(false);
  const audit = scene.audit;
  const verdictLabel = audit ? (VERDICT_LABEL[audit.verdict] ?? UNKNOWN_VERDICT) : UNKNOWN_VERDICT;
  const decisionLabel = audit
    ? (DECISION_LABEL[audit.decision] ?? UNKNOWN_DECISION)
    : UNKNOWN_DECISION;
  return (
    <div
      className={cn(
        'border-l-2 transition-colors',
        open ? 'border-l-primary bg-secondary/50' : 'border-l-transparent hover:bg-accent',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-4 py-3 text-left',
          'transition-colors active:bg-secondary',
          FOCUS_RING_INSET,
        )}
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="mr-2 text-sm tabular-nums text-muted-foreground">#{index + 1}</span>
          <span className="text-sm font-medium break-words">{scene.title || '（未命名场景）'}</span>
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {scene.type}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {audit ? (
            <span className={cn('text-sm font-medium', verdictLabel.cls)}>{verdictLabel.text}</span>
          ) : (
            <span className="text-sm text-yellow-deep">未经审核门禁</span>
          )}
          <ChevronDown
            className={cn(
              'size-4 text-muted-foreground transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4">
          {!audit ? (
            <p className="rounded-xl border border-yellow-deep/20 bg-yellow-soft px-3 py-2 text-sm leading-relaxed text-yellow-deep">
              该场景保存时没有审核记录，因此无法给出审核结论。
            </p>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
                <Field label="证据接地">
                  {audit.grounded ? (
                    <span className="text-green-deep">已接地 · {audit.evidenceCount} 条证据</span>
                  ) : (
                    <span className="text-yellow-deep">未接地（知识库未命中或引擎离线）</span>
                  )}
                </Field>
                <Field label="断言 / 标记">
                  <span className="tabular-nums">
                    {audit.totalClaims} / {audit.flaggedCount}
                  </span>
                  {audit.totalClaims > 0 && (
                    <span className="text-muted-foreground">
                      {' '}
                      （存疑 {audit.uncertainCount} · 判错 {audit.incorrectCount}）
                    </span>
                  )}
                </Field>
                <Field label="审核智能体">
                  <span className="break-all">
                    {judgePanelLabel(
                      audit.judgeModels?.length ? audit.judgeModels : [audit.judgeModel],
                    )}
                  </span>
                </Field>
                <Field label="审核轮次">
                  <span className="tabular-nums">{audit.rounds} 轮</span>
                </Field>
                <Field label="耗时">
                  <span className="tabular-nums">{(audit.durationMs / 1000).toFixed(1)}s</span>
                </Field>
              </div>
              <div className={cn('rounded-xl border px-3 py-2', decisionLabel.cls)}>
                <p className="text-sm font-medium">门禁裁决：{decisionLabel.text}</p>
                {/* 层次靠字重拉开，不靠 opacity：yellow-deep 压到 90% 后与 yellow-soft 只剩 3.83:1。 */}
                <p className="mt-1 text-sm leading-relaxed">
                  {audit.rationale ??
                    '这条审核记录生成于门禁裁决启用前，只保留断言判定，没有放行或拦截结论。'}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 4. 页面
// ============================================================================

function Metric({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-card dark:shadow-none">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
      {/* 原本是 muted-foreground/70，实测亮色 3.05:1、暗色 4.22:1，都够不到正文 4.5:1 */}
      {hint && <div className="mt-1 text-sm text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** 切换器的一项：只要选课需要的字段，不拉整门课。 */
interface CourseOption {
  id: string;
  title: string;
  sceneCount: number;
}

function AgentsConsole() {
  const params = useSearchParams();
  const scenes = useStageStore((s) => s.scenes);
  const stage = useStageStore((s) => s.stage);
  const loadFromStorage = useStageStore((s) => s.loadFromStorage);
  const classroomId = params.get('classroom') ?? stage?.id ?? null;
  const triedRef = useRef(false);
  // 首屏若要去 IndexedDB 取数，先标记为"读取中"，避免闪一下"没有数据"的假空态。
  const [resolving, setResolving] = useState(() => Boolean(classroomId) && scenes.length === 0);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(classroomId);
  // 切到别的课时的落库副本。带 id 是为了区分"这份是选中那门课的"和"上一门课的残留"。
  const [remote, setRemote] = useState<{ id: string; name: string; scenes: Scene[] } | null>(null);
  const [remoteState, setRemoteState] = useState<'idle' | 'loading' | 'failed'>('idle');

  // 本页常在新标签打开（store 是空的），按 ?classroom= 从 IndexedDB 补一次。
  // 失败不弹错：下面的空态会说明拿不到数据的原因。
  useEffect(() => {
    if (triedRef.current || !classroomId) return;
    triedRef.current = true;
    if (useStageStore.getState().scenes.length > 0) return;
    void loadFromStorage(classroomId)
      .catch(() => {})
      .finally(() => setResolving(false));
  }, [classroomId, loadFromStorage]);

  // store 晚一步 hydrate 出 stage 时把选中项补上；用户已经选过就不覆盖。
  useEffect(() => {
    if (classroomId) setSelectedId((cur) => cur ?? classroomId);
  }, [classroomId]);

  // 课程清单（落库课程，与首页课程墙同源）。没有 ?classroom= 时默认选最新一门
  // ——清单按 createdAt 倒序返回，第一项即最新。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/classroom');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { classrooms?: CourseOption[] };
        if (cancelled) return;
        const list = body.classrooms ?? [];
        setCourses(list);
        setListState('ready');
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      } catch {
        if (!cancelled) setListState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 选中课在 store 里（刚生成完 / 从课堂页跳过来）就用 store 的那份：
  // 只有它带得出本次生成被门禁拦下、没进课堂的场景。
  const storeOwnsSelected = Boolean(selectedId) && stage?.id === selectedId && scenes.length > 0;

  useEffect(() => {
    if (!selectedId || storeOwnsSelected || resolving) return;
    let cancelled = false;
    setRemoteState('loading');
    void fetchClassroomFromApi(selectedId)
      .then((payload) => {
        if (cancelled) return;
        if (!payload) {
          setRemoteState('failed');
          return;
        }
        setRemote({
          id: selectedId,
          name: payload.stage?.name ?? selectedId,
          scenes: payload.scenes,
        });
        setRemoteState('idle');
      })
      .catch(() => {
        if (!cancelled) setRemoteState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, storeOwnsSelected, resolving]);

  const remoteHit = remote?.id === selectedId ? remote : null;
  const activeScenes = storeOwnsSelected ? scenes : (remoteHit?.scenes ?? []);
  const activeTitle = storeOwnsSelected
    ? stage?.name
    : (remoteHit?.name ?? courses.find((c) => c.id === selectedId)?.title);
  // store 里那门课可能还没落库（访客自己刚生成的），清单里没有就补进切换器，
  // 否则下拉框显示的和页面正在看的对不上。
  const options: CourseOption[] =
    stage?.id && !courses.some((c) => c.id === stage.id)
      ? [{ id: stage.id, title: stage.name || stage.id, sceneCount: scenes.length }, ...courses]
      : courses;
  const loadingCourse = (resolving && selectedId === classroomId) || remoteState === 'loading';

  const ordered = [...activeScenes].sort((a, b) => a.order - b.order);
  const audits = ordered.map((s) => s.audit).filter((a): a is SceneAudit => Boolean(a));
  // Scenes the gate refused. They are absent from `scenes` by construction, so
  // the counter below cannot be derived from audits — without this list a block
  // leaves no trace and "拦截保交付" has nothing to point at.
  const blockedScenes = useStageStore((s) => s.blockedScenes);
  // 被拦下的场景是本次生成留在 store 里的现场记录，跟着 store 那门课走；
  // 看别的课时不能把它们算到人家头上。
  const sessionBlocked = storeOwnsSelected ? blockedScenes : [];
  const gate = summarizeGate(ordered);
  const totals = audits.reduce(
    (acc, a) => ({
      claims: acc.claims + a.totalClaims,
      flagged: acc.flagged + a.flaggedCount,
      grounded: acc.grounded + (a.grounded ? 1 : 0),
      blocked: acc.blocked + (a.decision === 'block_pending_review' ? 1 : 0),
      ms: acc.ms + a.durationMs,
    }),
    { claims: 0, flagged: 0, grounded: 0, blocked: 0, ms: 0 },
  );
  // 判官型号取自真实审核记录；没跑过审核就不写模型名。
  // `judgeModels` 是交叉验证后的判官组（可能多个）；旧记录只有单数 judgeModel，
  // 两个来源都收进来，否则双判官跑过之后控制台只会显示判官 1。
  const judgeModels = [
    ...new Set(audits.flatMap((a) => (a.judgeModels?.length ? a.judgeModels : [a.judgeModel]))),
  ].filter(Boolean);
  const arbiterModels = [
    ...new Set(audits.map((a) => a.arbiterModel).filter((m): m is string => Boolean(m))),
  ];
  // 仲裁过的分歧总数：debate 为 undefined 表示该场景没跑交叉验证（单判官），
  // 为 [] 表示跑了但两判官全一致——两者含义不同，不能都当 0 处理。
  const crossValidated = audits.filter((a) => a.debate !== undefined).length;
  const disputesArbitrated = audits.reduce((sum, a) => sum + (a.debate?.length ?? 0), 0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* 共享极简顶栏（components/site-header.tsx）；课程名与返回课堂作为附加上下文 */}
      <SiteHeader localized={false} maxWidth="max-w-6xl">
        <div className="flex min-w-0 items-center gap-2">
          <Boxes className="size-5 shrink-0 text-purple-deep" />
          <span className="truncate text-sm text-muted-foreground">
            {activeTitle || '多智能体协同控制台'}
          </span>
          {selectedId && (
            <Link
              href={`/classroom/${selectedId}`}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              )}
            >
              返回课堂
            </Link>
          )}
        </div>
      </SiteHeader>

      {/* 区块间距走 48（4px 基数的档位表里 40 不是一档），与块内 12/16 拉开 3 倍以上 */}
      <div className="mx-auto max-w-6xl space-y-12 px-4 py-8 sm:px-6">
        {/* 页标题 */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">多智能体协同控制台</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            七个 Agent 组成「分析 → 生成 → 校验 → 决策」流程。先看它们各自管什么、
            怎么衔接，再往下选一门课看这套流程在那门课上跑出来的记录。
          </p>
        </div>

        {/* 师门全员：全身立绘横排。立绘是定稿资产（public/agents/README.md），
            透明底直接压在卡面上；横向可滚，窄屏不挤爆。 */}
        <section>
          <div className="overflow-x-auto rounded-xl border border-border bg-card p-5 shadow-card dark:shadow-none">
            <div className="flex min-w-[720px] items-end justify-between gap-2">
              {(
                [
                  'diagnosis',
                  'retrieval',
                  'generation',
                  'judge',
                  'arbiter',
                  'decision',
                  'tutor',
                ] as AgentKey[]
              ).map((k) => {
                const p = AGENT_PERSONAS[k];
                const art = AGENT_ART[k];
                return (
                  <figure key={k} className="flex w-0 grow flex-col items-center gap-2">
                    <img
                      src={art.full ?? art.bust}
                      alt={`${p.name}（${p.role}）全身立绘`}
                      className="h-36 w-auto object-contain drop-shadow-sm sm:h-44"
                      loading="lazy"
                    />
                    <figcaption className="text-center">
                      <span className="block text-sm font-medium">{p.name}</span>
                      <span className="block text-xs text-muted-foreground">{p.role}</span>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          </div>
        </section>

        {/* 系统说明：闭环示意 */}
        <section>
          <h2 className="mb-3 text-lg font-medium">协同闭环</h2>
          <div className="overflow-x-auto rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="min-w-[640px]">
              <LoopDiagram />
            </div>
          </div>
        </section>

        {/* 系统说明：Agent 职责分工 */}
        <section>
          <h2 className="mb-3 text-lg font-medium">Agent 职责分工</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {AGENTS.map((a) => {
              const persona = AGENT_PERSONAS[a.persona];
              return (
                <div
                  key={a.name}
                  className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-5 shadow-card dark:shadow-none"
                >
                  <div className="flex items-center gap-2.5">
                    {/* 审核智能体是双胞胎设定（甲/乙互不通气），甲乙两张半身像叠一起。
                        56px 起用定稿立绘；手写 SVG 只留给 ≤40px 的场景。 */}
                    {a.persona === 'judge' ? (
                      <span className="flex shrink-0 -space-x-4">
                        <img
                          src={AGENT_ART.judge.bust}
                          alt="阿审甲（审核 Agent）"
                          className="size-14 rounded-full bg-muted/40 object-cover"
                          loading="lazy"
                        />
                        <img
                          src={AGENT_ART.judge.bustB ?? AGENT_ART.judge.bust}
                          alt="阿审乙（审核 Agent）"
                          className="size-14 rounded-full bg-muted/40 object-cover"
                          loading="lazy"
                        />
                      </span>
                    ) : (
                      <img
                        src={AGENT_ART[a.persona].bust}
                        alt={`${persona.name}（${persona.role} Agent）`}
                        className="size-14 shrink-0 rounded-full bg-muted/40 object-cover"
                        loading="lazy"
                      />
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {persona.name} · {a.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        「{persona.motto}」
                      </span>
                    </span>
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {a.step} {a.phase}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs',
                        a.deterministic
                          ? 'bg-green-soft text-green-deep'
                          : 'bg-yellow-soft text-yellow-deep',
                      )}
                    >
                      {a.deterministic ? '规则实现' : '模型采样'}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {a.engine}
                    </span>
                  </div>

                  <Field label="输入">{a.input}</Field>
                  <Field label="输出">{a.output}</Field>
                  <div className="mt-auto pt-1 text-xs text-muted-foreground">核验：{a.source}</div>
                </div>
              );
            })}
            <div className="flex flex-col justify-center gap-2 rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <GitBranch className="size-4" />
                闭环怎么闭上的
              </div>
              <p className="leading-relaxed">
                诊断与检索结果在不改变原生课程结构的前提下注入生成器；生成结果必须过审核 Agent
                才进入播放队列；测验作答再由决策 Agent 折回难度档与补练路线，回到诊断。
              </p>
              <p className="text-sm text-muted-foreground">{GATE_NOTE}</p>
            </div>
          </div>
        </section>

        {/* 具体课程实例：选一门课看这套流程真跑出来的记录 */}
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 className="text-lg font-medium">课程执行轨迹</h2>
            {options.length > 0 && (
              <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                查看课程
                <select
                  value={selectedId ?? ''}
                  onChange={(e) => setSelectedId(e.target.value)}
                  className={cn(
                    'max-w-[18rem] truncate rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground',
                    FOCUS_RING_INSET,
                  )}
                  aria-label="选择要查看协同记录的课程"
                >
                  {options.map((c) => (
                    <option className="bg-background text-foreground" key={c.id} value={c.id}>
                      {c.title}（{c.sceneCount} 个场景）
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {listState === 'failed' && (
            <p className="mb-3 text-sm text-yellow-deep">
              课程清单暂时读不到，只能看当前这一门。刷新页面可以重试。
            </p>
          )}
          {remoteState === 'failed' && (
            <p className="mb-3 text-sm text-yellow-deep">
              这门课的数据暂时读不到，换一门课或刷新页面重试。
            </p>
          )}

          {ordered.length === 0 && loadingCourse ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              正在读取课程数据…
            </div>
          ) : ordered.length === 0 ? (
            /* 空态复用共享组件（components/ui/empty-state.tsx），CTA 单独跟在下面 */
            <div className="space-y-4">
              <EmptyState
                title="没有可展示的执行轨迹"
                hint={
                  selectedId
                    ? '这门课读不到已保存的场景数据（课程尚未生成完成，或数据只在另一台设备 / 另一个浏览器上）。可以用上面的切换器换一门课。'
                    : '本页需要一门已生成的课程作为数据源。先造一节课，再从课堂页顶栏的「多智能体协同控制台」入口进来。'
                }
              />
              <div className="text-center">
                <Link
                  href="/"
                  className={cn(
                    // text-primary-foreground 在暗色下是近黑（#171717），压在紫色 primary 上只有
                    // 3.57:1；白字实测 5.01:1，亮色下与原来的近白色观感一致。
                    'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-white transition-colors hover:bg-primary/90',
                  )}
                >
                  去生成一节课
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 门禁结果写成一句话。原来是「10/10 经过审核门禁」大数卡 + 「全部场景均有
                  审核记录」的小字，用户看不出这两个数分别是什么、也看不出有没有没过的
                  （2026-08-15 反馈）。分桶口径见 components/agents/gate-summary.ts。 */}
              <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm leading-relaxed">
                {gate.sentence}
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric value={String(totals.claims)} label="核验断言总数" />
                <Metric value={String(totals.flagged)} label="被标记断言" hint="存疑 + 判错" />
                <Metric
                  value={`${totals.grounded}/${audits.length}`}
                  label="已接地场景"
                  hint="分母为有审核记录的场景"
                />
                {sessionBlocked.length > 0 && (
                  <Metric
                    value={String(sessionBlocked.length)}
                    label="被拦下未进课堂的场景"
                    hint="本次生成现场记录"
                  />
                )}
              </div>

              {/* 本课真正跑了哪几个审核智能体：原来挂在上方「Agent 职责分工」的审核卡里，
                  那一节现在是通用说明，课程实例的数字挪到这里。 */}
              {audits.length > 0 && (
                <div className="grid gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 sm:grid-cols-2">
                  <Field label="本课实际审核智能体">
                    {judgeModels.length > 0 ? (
                      <span className="break-all text-green-deep">
                        {judgePanelLabel(judgeModels)}
                        {judgeModels.length > 1 && '（交叉验证）'}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">审核记录里没有模型名</span>
                    )}
                  </Field>
                  {/* 交叉验证 / 仲裁的真实战果。debate 为 undefined = 该场景走单判官，
                      为 [] = 跑了交叉验证但两判官全一致——如实区分，不把后者说成没跑。 */}
                  {crossValidated > 0 && (
                    <Field label="交叉验证与仲裁">
                      <span className="text-purple-deep">
                        {crossValidated}/{audits.length} 个场景由两个审核智能体交叉验证，共仲裁{' '}
                        {disputesArbitrated} 条分歧
                        {arbiterModels.length > 0 &&
                          ` · 终审 ${arbiterModels.map(arbiterLabel).join('、')}`}
                      </span>
                      {disputesArbitrated === 0 && (
                        <span className="block text-muted-foreground">
                          本次两个审核智能体判定完全一致，无需仲裁
                        </span>
                      )}
                    </Field>
                  )}
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                {/* 场景总数与接地数已经在上面的句子和卡片里，这里只剩耗时 */}
                本课审核总耗时 {(totals.ms / 1000).toFixed(1)}s
              </p>

              {/* The gate's only evidence surface: a blocked scene is absent from
                  the classroom, so if it is not listed here it left no trace. */}
              {sessionBlocked.length > 0 && (
                <div className="rounded-xl border border-red-deep/20 bg-red-soft px-4 py-3">
                  <p className="text-sm font-medium text-red-deep">
                    门禁拦截记录（{sessionBlocked.length} 个场景未进入课堂）
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {sessionBlocked.map((b, i) => (
                      /* 三层信息靠字重区分：red-deep 压到 75% 只剩 3.89:1，压到 80% 是 4.16:1，
                         都过不了正文 4.5:1，所以全部用满色。 */
                      <li key={i} className="text-sm leading-relaxed text-red-deep">
                        <span className="font-medium">{b.title}</span>
                        <span className="block">{b.audit.rationale}</span>
                        <span className="block">
                          断言 {b.audit.totalClaims} 条 · 判错 {b.audit.incorrectCount} 条 ·{' '}
                          {judgePanelLabel(
                            b.audit.judgeModels?.length
                              ? b.audit.judgeModels
                              : [b.audit.judgeModel],
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-sm text-red-deep">
                    这些场景被审核门禁拦下、未进入课堂，可在生成页重试。课堂因此会少若干节。
                  </p>
                </div>
              )}

              {audits.length === 0 && (
                <p className="rounded-xl border border-yellow-deep/20 bg-yellow-soft px-4 py-3 text-sm leading-relaxed text-yellow-deep">
                  本课程所有场景都没有审核记录，断言 / 标记 / 拦截三项为空。
                  这批场景没有随课保存审核记录，无法据此判断质量。
                </p>
              )}

              {/* 轨迹列表：首尾圆角配方，行下钻（⑯⑪） */}
              <div className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border-subtle">
                {ordered.map((scene, i) => (
                  <TraceRow key={scene.id} scene={scene} index={i} />
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
          加载中…
        </div>
      }
    >
      <AgentsConsole />
    </Suspense>
  );
}
