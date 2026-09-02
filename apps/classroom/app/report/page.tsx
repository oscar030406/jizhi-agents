'use client';

/**
 * 个人学情与资源匹配度报告 (/report)
 *
 * The visible end of the personalization loop: everything the engine computed
 * about *this* learner, plus everything the audit gate recorded about *this*
 * course, laid out so a training manager can decide in one screen.
 *
 * Every number on this page comes from one of exactly three real sources —
 * the localStorage learner profile, the engine's blueprint endpoint (via
 * /api/adaptive/blueprint), and the persisted stage's scenes/outlines. There is
 * no seed data and no placeholder: a missing source renders an empty state that
 * names what is missing and how to supply it. The one derived column (per-scene
 * difficulty for non-quiz scenes) is labelled 估计 everywhere it appears.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import NumberFlow, { type Format } from '@number-flow/react';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  GitBranch,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SiteHeader } from '@/components/site-header';
import { EvidenceTrajectoryChart } from '@/components/report/evidence-trajectory-chart';
import { PathOrDomainCard } from '@/components/home/learning-overview';
import {
  CONFIDENCE_FLOOR,
  MASTERY_GATE,
  REVIEW_THRESHOLD,
  dueReviews,
  masteryMap,
  nextObjective,
  snapshotsFromProfile,
} from '@/lib/evidence/policy';
import { history, readLedger } from '@/lib/evidence/ledger';
import { measuredKey, type Evidence } from '@/lib/evidence/types';
import { inferKnowledgeType, qualitativePassed, replayRepetition } from '@/lib/evidence/spaced';
import { readMistakes, type MistakeEntry } from '@/lib/evidence/mistake-bank';
import { parseTier, rankRepractice } from '@/lib/quiz/item-selection';
import { belongsToDomain } from '@/lib/knowledge/use-course-domains';
import { applyEffectiveDomain, type EffectiveDomainContext } from '@/lib/knowledge/domain-context';
import { useAccountProfile } from '@/lib/knowledge/account-profile';
import {
  loadEffectiveDomainContext,
  type EffectiveDomainContextState,
} from '@/lib/knowledge/use-domain-context';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useStageStore } from '@/lib/store/stage';
import { listStages, loadStageData, type StageListItem } from '@/lib/utils/stage-storage';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline, LearnerProfileFields } from '@/lib/types/generation';
import type { LearnerBlueprint } from '@/lib/generation/learner-profile';
import { conceptLabel } from '@/lib/knowledge/concept-labels';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { DEFAULT_LEARNER_PROFILE } from '@/components/generation/learner-profile-popover';
import {
  humanizeEngineText,
  learnerTypeLabel,
  levelBandText,
  levelRank,
  levelText,
  whyThisCourse,
} from '@/app/report/attribution';

/**
 * 引擎自由文本上屏前统一走这里：档位记号换序数、概念 id 与学习者类型换中文名。
 * 词表是 `lib/knowledge/concept-labels.ts`（引擎 goal_concepts 的逆映射），
 * 认不出的词原样留着。
 *
 * 必须走：`diagnosis_summary`、`resource_mix.rationale`、`content_strategy` 这些
 * 字段里嵌着 `L3` / `agent_basics` / `systems_engineer`，而它们是数据不是源码——
 * 只 grep 源码会以为页面干净。
 */
const humanize = (text: string): string => humanizeEngineText(text, conceptLabel);

/** Outline quiz difficulty is recorded on the 'easy|medium|hard' scale. */
const QUIZ_RANK: Record<string, number> = { easy: 1, medium: 2, hard: 3 };

const SCENE_TYPE_LABEL: Record<string, string> = {
  slide: '讲解',
  quiz: '测验',
  interactive: '互动',
  pbl: '项目',
};

const SCAFFOLD_LABEL: Record<string, string> = {
  full: '完整支架（先类比铺垫，再分步拆解）',
  faded: '渐进支架（给骨架，留关键步骤）',
  minimal: '最小支架（直入机制与边界）',
};

const PROFILE_DIMENSIONS: Array<{ key: keyof LearnerProfileFields; label: string }> = [
  { key: 'programming_level', label: '编程' },
  { key: 'python_level', label: 'Python' },
  { key: 'agent_level', label: 'Agent' },
  { key: 'rag_level', label: 'RAG' },
  { key: 'engineering_level', label: '工程' },
];

const EDUCATION_LABEL: Record<string, string> = {
  high_school: '高中/中专',
  college: '专科',
  bachelor: '本科',
  master: '硕士及以上',
  other: '其他',
};

const PROFILE_STORAGE_KEY = 'learnerProfile';

type ReportProfile = LearnerProfileFields & {
  conceptMasteryByDomain?: Record<string, Record<string, number>>;
  conceptConfidenceByDomain?: Record<string, Record<string, number>>;
  conceptRecallByDomain?: Record<string, Record<string, number>>;
};

/**
 * Read the profile the user actually stored. Returns null when nothing was ever
 * saved — the page must not silently substitute DEFAULT_LEARNER_PROFILE and
 * present the result as "your" diagnosis.
 */
function readStoredProfile(): ReportProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    return { ...DEFAULT_LEARNER_PROFILE, ...(JSON.parse(raw) as ReportProfile) };
  } catch {
    return null;
  }
}

/**
 * 报告只消费当前有效领域的三张画像缓存。旧扁平表不带领域，无法证明归属；即使当前域
 * 是 AI 也不能拿它兜底，否则同名概念仍会把另一领域的历史值带进来。
 */
function profileForDomain(
  profile: ReportProfile | null,
  domain: string | null,
): ReportProfile | null {
  if (!profile || !domain) return null;
  const masteryByDomain = profile.conceptMasteryByDomain;
  if (!masteryByDomain || !Object.prototype.hasOwnProperty.call(masteryByDomain, domain))
    return null;
  return {
    ...profile,
    conceptMastery: masteryByDomain[domain] ?? {},
    conceptConfidence: profile.conceptConfidenceByDomain?.[domain] ?? {},
    conceptRecall: profile.conceptRecallByDomain?.[domain] ?? {},
  };
}

/**
 * The home page's profile popover writes DEFAULT_LEARNER_PROFILE to localStorage
 * on first mount, so "a profile exists" is not the same as "the learner filled
 * one in". An untouched default is still the profile generation would use, so it
 * is not hidden — but it is labelled, otherwise the page would present a
 * placeholder diagnosis as a personal one.
 */
function isUntouchedDefault(p: LearnerProfileFields): boolean {
  const keys = Object.keys(DEFAULT_LEARNER_PROFILE) as Array<keyof LearnerProfileFields>;
  return keys.every((k) => p[k] === DEFAULT_LEARNER_PROFILE[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived course facts
// ─────────────────────────────────────────────────────────────────────────────

interface CourseData {
  stage: Stage;
  scenes: Scene[];
  outlines: SceneOutline[];
}

interface SceneDifficulty {
  scene: Scene;
  index: number;
  rank: number;
  /** True when no difficulty was ever recorded for this scene and we derived one. */
  estimated: boolean;
  basis: string;
}

/**
 * Per-scene difficulty on the engine's L1–L4 scale.
 *
 * Only quiz outlines carry a recorded difficulty (`quizConfig.difficulty`), and
 * even that lives on the easy/medium/hard scale, so it is converted. Every other
 * scene kind has no stored difficulty at all: it is derived from the learner's
 * own quiz difficulty band by scene kind and flagged `estimated`, which the
 * chart renders as a hollow marker and states in the caption.
 */
function sceneDifficulty(
  scene: Scene,
  outline: SceneOutline | undefined,
  band: number[],
): Omit<SceneDifficulty, 'scene' | 'index'> {
  const recorded = outline?.quizConfig?.difficulty;
  if (recorded && QUIZ_RANK[recorded] !== undefined) {
    return {
      rank: QUIZ_RANK[recorded],
      estimated: false,
      basis: `大纲记录的测验难度 ${recorded} → ${levelText(QUIZ_RANK[recorded])}`,
    };
  }
  const lo = Math.min(...band);
  const hi = Math.max(...band);
  const mid = (lo + hi) / 2;
  const byType: Record<string, number> = { slide: lo, interactive: mid, quiz: mid, pbl: hi };
  const rank = byType[scene.type] ?? mid;
  return {
    rank: Math.min(4, Math.max(1, rank)),
    estimated: true,
    basis: `无记录难度，按「${SCENE_TYPE_LABEL[scene.type] ?? scene.type}」场景在测验难度带第 ${lo}–${hi} 档内估计`,
  };
}

interface AuditSummary {
  audited: number;
  total: number;
  grounded: number;
  claims: number;
  flagged: number;
  blocked: number;
  warned: number;
  published: number;
}

function summarizeAudits(scenes: Scene[]): AuditSummary {
  const s: AuditSummary = {
    audited: 0,
    total: scenes.length,
    grounded: 0,
    claims: 0,
    flagged: 0,
    blocked: 0,
    warned: 0,
    published: 0,
  };
  for (const scene of scenes) {
    const audit = scene.audit;
    if (!audit) continue;
    s.audited += 1;
    if (audit.grounded) s.grounded += 1;
    s.claims += audit.totalClaims;
    s.flagged += audit.flaggedCount;
    if (audit.decision === 'block_pending_review') s.blocked += 1;
    else if (audit.decision === 'publish_with_warnings') s.warned += 1;
    else s.published += 1;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ─────────────────────────────────────────────────────────────────────────────

function EstimateTag() {
  return (
    <span className="ml-1 rounded border border-yellow-deep/40 bg-yellow-soft px-1 py-px text-xs font-medium text-yellow-deep">
      估计
    </span>
  );
}

/**
 * 口径折叠壳。
 *
 * 用户 08-16 评审：报告页默认视图被口径小字糊住，结论反而找不到。做法与管理端
 * 同一条（J1 的 components/admin/caliber.tsx）——**数据一条不删，只是默认收起**：
 * 图注、推导依据、词表来源全部进这里，展开随时可核。
 */
function Caliber({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-lg border border-border/70 bg-muted/30 p-2.5">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground marker:content-none">
        <span className="inline-block transition-transform group-open:rotate-90">›</span> {summary}
      </summary>
      <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

/** 核心大数卡（⑪㉑）：0 → 真实值上升入场一次，≤300ms，交给 NumberFlow。 */
function StatCard({
  label,
  value,
  format,
  prefix,
  suffix,
}: {
  label: string;
  value: number;
  format?: Format;
  prefix?: string;
  suffix?: string;
}) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <div className="rounded-xl border bg-card p-5 shadow-card">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        <NumberFlow
          value={shown}
          format={format}
          prefix={prefix}
          suffix={suffix}
          transformTiming={{ duration: 300, easing: 'ease-out' }}
          spinTiming={{ duration: 300, easing: 'ease-out' }}
          opacityTiming={{ duration: 150, easing: 'ease-out' }}
        />
      </p>
    </div>
  );
}

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Target;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-[22px] font-semibold leading-snug">
          {/* 区块题行色彩锚点：报告页语义蓝 soft 底图标章（色调回暖微调） */}
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-soft">
            <Icon className="size-4 text-blue-deep" />
          </span>
          {title}
        </CardTitle>
        <CardDescription className="text-sm leading-relaxed">{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart 1 — 知识盲区定位
// ─────────────────────────────────────────────────────────────────────────────

function BlindSpotChart({ bp }: { bp: LearnerBlueprint }) {
  const entries = Object.entries(bp.mastery_vector).sort((a, b) => a[1] - b[1]);
  if (entries.length === 0) {
    return (
      <EmptyState
        title="学情诊断未返回掌握度向量"
        hint="学情诊断本次没有产出掌握度向量，无法定位盲区。可稍后点右上角「重新计算」重试。"
      />
    );
  }

  const weak = new Set(bp.weak_concepts);
  const gapByConcept = new Map(
    (bp.blueprint?.skill_gaps ?? []).map((g) => [g.concept, g] as const),
  );

  const rowH = 30;
  const padTop = 18;
  const padBottom = 24;
  const labelW = 128;
  const barX = labelW + 8;
  const barW = 360;
  const height = padTop + entries.length * rowH + padBottom;
  const width = barX + barW + 96;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full text-foreground"
          // 原来钉死 min-w-520，比 viewBox 的 592 还窄——窄屏下既照样横向滚动，
          // 又把字压到 7.9px。改成按自身宽度兜底：滚动距离一样，字回到 1:1。
          style={{ minWidth: `${width}px` }}
          role="img"
          aria-label="知识盲区定位图"
        >
          {/* gridlines at 0 / .25 / .5 / .75 / 1 */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line
                x1={barX + barW * t}
                y1={padTop - 6}
                x2={barX + barW * t}
                y2={height - padBottom + 2}
                stroke="currentColor"
                strokeWidth={1}
                opacity={t === 0 ? 0.35 : 0.12}
              />
              <text
                x={barX + barW * t}
                y={height - padBottom + 14}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                opacity={0.55}
              >
                {t.toFixed(2)}
              </text>
            </g>
          ))}

          {entries.map(([concept, mastery], i) => {
            const y = padTop + i * rowH;
            const isWeak = weak.has(concept);
            const gap = gapByConcept.get(concept);
            const w = Math.max(2, barW * Math.min(1, Math.max(0, mastery)));
            return (
              <g key={concept}>
                <text
                  x={labelW}
                  y={y + 13}
                  textAnchor="end"
                  fontSize={11}
                  fill="currentColor"
                  opacity={isWeak ? 1 : 0.75}
                  fontWeight={isWeak ? 600 : 400}
                >
                  {conceptLabel(concept)}
                </text>
                <rect
                  x={barX}
                  y={y + 3}
                  width={barW}
                  height={14}
                  rx={3}
                  fill="currentColor"
                  opacity={0.07}
                />
                {gap?.target_mastery !== undefined && (
                  <line
                    x1={barX + barW * Math.min(1, gap.target_mastery)}
                    y1={y + 1}
                    x2={barX + barW * Math.min(1, gap.target_mastery)}
                    y2={y + 19}
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeDasharray="3 2"
                    opacity={0.65}
                  />
                )}
                <rect
                  x={barX}
                  y={y + 3}
                  width={w}
                  height={14}
                  rx={3}
                  fill={isWeak ? 'var(--primary)' : 'currentColor'}
                  opacity={isWeak ? 1 : 0.35}
                />
                <text
                  x={barX + barW + 8}
                  y={y + 14}
                  fontSize={10}
                  fill="currentColor"
                  opacity={0.8}
                >
                  {mastery.toFixed(2)}
                  {gap ? ` · 缺口 ${gap.gap.toFixed(2)}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-primary" />
          薄弱概念（引擎判定）
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-foreground/35" />
          已掌握
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-0.5 bg-foreground/65" />
          目标掌握度
        </span>
        <span>横轴为掌握度 0–1，全部取自学情诊断</span>
      </div>

      {(bp.blueprint?.skill_gaps ?? []).length > 0 && (
        <div className="space-y-2 rounded-xl border border-yellow-deep/20 bg-yellow-soft p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-yellow-deep">
              待补齐的薄弱点 — 这是下一步待办，不是错误
            </p>
            <Button variant="outline" size="sm" asChild className="text-xs">
              <a href="#learning-path">去补这 {(bp.blueprint?.skill_gaps ?? []).length} 个点</a>
            </Button>
          </div>
          <ul className="space-y-1.5">
            {(bp.blueprint?.skill_gaps ?? []).map((g) => (
              <li key={g.concept} className="text-sm leading-relaxed">
                <span className="font-medium text-foreground">{conceptLabel(g.concept)}</span>
                <span className="text-muted-foreground">
                  {' '}
                  缺口 {g.gap.toFixed(2)} — {humanize(g.reason)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {bp.learning_risks.length > 0 && (
        <p className="text-xs text-muted-foreground">
          学情诊断标注的学习风险：{bp.learning_risks.map(humanize).join(' · ')}
        </p>
      )}
    </div>
  );
}

/**
 * 实测掌握度（证据动态层）。与上面引擎推断的 mastery_vector 不同源：这里是
 * 当前有效领域的证据账本经 fold 导出的 estimate 缓存，是答出来的，不是引擎推断的。
 */
/**
 * 到期复习与下一步（掌握策略层）。与上面两块不同源：这里消费的是证据折叠出的
 * 三元组（估计/置信/可提取度），判定规则见 lib/evidence/policy.ts——
 * 估计过线且置信过下限才算掌握，已掌握但可提取度衰减的进复习队列。
 * 旧画像没有置信表时按 0 处理，所以这块可能显示「没有已掌握项」——那是
 * 诚实结论（证据不足），不是数据丢了。
 */
function ReviewNextBlock({
  profile,
  domain,
}: {
  profile: LearnerProfileFields | null;
  domain: string;
}) {
  // 错题置顶的原料：最近一次判定失分的测项。从账本读最新一条证据的 outcome，
  // 与轨迹图同源；账本读失败时显式未覆盖，不拿其它领域或旧扁平画像补排序依据。
  const [errorProne, setErrorProne] = useState<ReadonlySet<string>>(new Set());
  const [errorKind, setErrorKind] = useState<ReadonlyMap<string, string>>(new Map());
  const [qualitative, setQualitative] = useState<ReadonlySet<string>>(new Set());
  const [plan, setPlan] = useState<ReadonlyMap<string, number>>(new Map());
  const [ledgerState, setLedgerState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [renderedAt] = useState(Date.now);
  useEffect(() => {
    let alive = true;
    readLedger()
      .then((ledger) => {
        if (!alive) return;
        const byKey = new Map<string, Evidence[]>();
        for (const e of history(ledger)) {
          if (e.measured.kind !== 'concept' || e.measured.domain !== domain) continue;
          // 键必须与画像缓存三张表同形——那边是**裸概念名**（profile-bridge:
          // `key = m.measured.concept`）。此前用带命名空间的 measuredKey，
          // errorProne.has() 永远假，错题置顶与错因提示全哑（验收实测抓到）。
          const key = e.measured.kind === 'concept' ? e.measured.concept : measuredKey(e.measured);
          (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(e);
        }
        const bad: Array<[string, string | undefined]> = [];
        const passed = new Set<string>();
        const nextAt = new Map<string, number>();
        for (const [key, evs] of byKey) {
          evs.sort((a, b) => a.source.at.localeCompare(b.source.at));
          const last = evs[evs.length - 1];
          if (last.verdict.outcome !== 'correct') bad.push([key, last.verdict.errorType]);
          if (qualitativePassed(evs)) passed.add(key);
          const state = replayRepetition(
            evs.map((e) => ({
              atMs: Date.parse(e.source.at),
              correct: e.verdict.outcome === 'correct',
            })),
            inferKnowledgeType(evs),
          );
          if (state) nextAt.set(key, state.nextReviewAt);
        }
        setErrorProne(new Set(bad.map(([k]) => k)));
        setErrorKind(new Map(bad.filter(([, t]) => t).map(([k, t]) => [k, t!])));
        setQualitative(passed);
        setPlan(nextAt);
        setLedgerState('ready');
      })
      .catch(() => {
        if (alive) setLedgerState('error');
      });
    return () => {
      alive = false;
    };
  }, [domain]);
  if (ledgerState === 'loading') {
    return <p className="text-xs text-muted-foreground">正在读取当前领域的证据账本…</p>;
  }
  if (ledgerState === 'error') {
    return (
      <p className="rounded-md border border-dashed border-border/70 p-2.5 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">当前领域的复习证据未覆盖：</span>
        证据账本暂时无法读取；没有回退到全域历史或旧扁平画像。
      </p>
    );
  }
  const snapshots = snapshotsFromProfile(profile ?? {});
  if (Object.keys(snapshots).length === 0) return null;
  const opts = { errorProne, qualitative };
  const due = dueReviews(snapshots, opts).slice(0, 5);
  const orderedKeys = Object.entries(snapshots)
    .sort((a, b) => b[1].estimate - a[1].estimate)
    .map(([k]) => k);
  const step = nextObjective(orderedKeys, snapshots, opts);
  const map = masteryMap(orderedKeys, snapshots, opts);
  // 复习排期：已掌握项的下次复习日期（类型化间隔调度器重放履历得出），最近的在前。
  const schedule = map.items
    .filter((it) => it.status === 'mastered' && plan.has(it.key))
    .map((it) => ({ key: it.key, at: plan.get(it.key)! }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 5);
  const fmtDue = (at: number): string => {
    const days = Math.ceil((at - renderedAt) / (24 * 60 * 60 * 1000));
    return days <= 0 ? '已到期' : `${days} 天后`;
  };
  // 错因分型（DeepTutor 粗分提炼）指补救方向：空答=不会→重讲；答错=会用错→订正练习。
  const kindHint = (key: string): string => {
    const kind = errorKind.get(key);
    if (kind === 'metacognitive') return '，上次多为空答——建议先看讲解再练';
    if (kind === 'application') return '，上次答了但错——建议直接订正练习';
    if (kind === 'mixed') return '，上次空答与答错都有';
    return '';
  };
  const stepLabel =
    step.action === 'review'
      ? `复习「${conceptLabel(step.key)}」${kindHint(step.key)}`
      : step.action === 'probe'
        ? `试探「${conceptLabel(step.key)}」——会了就跳过`
        : step.action === 'practice'
          ? `继续练「${conceptLabel(step.key)}」${kindHint(step.key)}`
          : '当前测过的主题全部过门';
  return (
    <div className="space-y-2 rounded-md border border-border/70 p-2.5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">到期复习与下一步：</span>
        掌握 = 估计 ≥ {MASTERY_GATE} 且置信 ≥ {CONFIDENCE_FLOOR}
        （一两次答对撑不起置信，不算掌握），或导师对话中判定解释到位（定性门）；
        已掌握但可提取度跌破 {REVIEW_THRESHOLD} 的主题进入复习队列。
      </p>
      <p className="text-xs tabular-nums text-muted-foreground">
        掌握地图：已掌握 {map.counts.mastered} · 学习中 {map.counts.learning} · 未测{' '}
        {map.counts.new}（共 {map.counts.total}）
      </p>
      <p className="text-xs text-foreground">
        建议下一步：{stepLabel}
        <span className="ml-1 text-muted-foreground">（{step.reason}）</span>
      </p>
      {schedule.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            复习排期（按知识类型的间隔序列重放作答史得出）：
          </p>
          {schedule.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground" title={conceptLabel(s.key)}>
                {conceptLabel(s.key)}
              </span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                {fmtDue(s.at)}
              </span>
            </div>
          ))}
        </div>
      )}
      {due.length > 0 && (
        <div className="space-y-1">
          {due.map((t) => (
            <div key={t.key} className="flex items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground" title={conceptLabel(t.key)}>
                {conceptLabel(t.key)}
              </span>
              {t.errorProne && (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-foreground">
                  最近错过
                </span>
              )}
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                可提取度 {t.recall.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 错题本（DeepTutor Question Bank 提炼）：交卷时答错的题连同解析、你的答案、
 * 正确答案的本机回放。解析在作答界面不展示（防泄答案），错后到这里才看得到——
 * 这正是它进错题本的价值。空答与答错分开标（补救方向不同）。
 */
function MistakeBankBlock({
  profile,
  domain,
}: {
  profile: LearnerProfileFields | null;
  domain: string;
}) {
  const [mistakes, setMistakes] = useState<MistakeEntry[]>([]);
  /* eslint-disable react-hooks/set-state-in-effect -- localStorage 错题需在有效领域变化后重新分桶 */
  useEffect(() => {
    // 没写领域的旧错题无法证明归属，不能猜成 AI；只展示与当前有效领域严格相等的记录。
    setMistakes(readMistakes().filter((m) => m.domain === domain));
  }, [domain]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /**
   * 重练顺序：先答错的、后空答的，同类内按 Fisher 信息量降序
   * （`lib/quiz/item-selection.ts` 的 `rankRepractice`）。
   *
   * 原来是按时间倒序平铺——那回答的是「最近错了什么」，而这一块要回答的是
   * 「现在先重练哪一道」。两者不是一回事：最近错的那道可能是个手滑，
   * 而三天前那道正卡在他能力边上。
   *
   * 空答排在答错之后不是 MFI 带来的，是既有判据（`lib/quiz/grading.ts`）：
   * 空答是「不知道」该降档重讲，答了但错是「会用错」才该加练订正。
   *
   * 能力用当前有效领域画像的 `conceptMastery` **整体均值**，不按题目主题取。
   * 理由是键空间不可靠——这张表的键是概念名，跨域同名会撞、与错题的主题也对不上
   * （学情报告的下一步面板里记着同一件事：不要拿它当主题级判据用）。
   * 取均值是把它当「这个人现在大概什么水平」用，这一层它站得住。
   * 一条数据都没有时不编——`hasMastery` 为假就退回原来的时间序。
   */
  const masteryValues = Object.values(profile?.conceptMastery ?? {}).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const hasMastery = masteryValues.length > 0;
  const ordered = useMemo(() => {
    if (!hasMastery) return mistakes;
    const mean = masteryValues.reduce((a, b) => a + b, 0) / masteryValues.length;
    const rank = new Map(
      rankRepractice(
        mistakes.map((m, i) => ({
          // 用下标当 id：错题本里 questionId 会跨屏重名（不同课的 q1）。
          id: String(i),
          ...(parseTier(m.tier) ? { tier: parseTier(m.tier)! } : {}),
          ...(m.questionType ? { type: m.questionType } : {}),
          ...(m.optionCount ? { options: m.optionCount } : {}),
          answered: m.answered,
        })),
        mean,
      ).map((pick, order) => [pick.id, order] as const),
    );
    return [...mistakes]
      .map((m, i) => ({ m, order: rank.get(String(i)) ?? Number.MAX_SAFE_INTEGER }))
      .sort((x, y) => x.order - y.order)
      .map((x) => x.m);
  }, [mistakes, hasMastery, masteryValues]);

  if (mistakes.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-border/70 p-2.5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">错题本（{mistakes.length} 条）：</span>
        最近答错的题与解析。空答标「未作答」——那是「还不会」，建议先回讲解；
        答了但错建议直接订正重做。
        {hasMastery
          ? '排序按现在最值得重练的先后，不按时间。'
          : '还没有足够的掌握度数据，暂按时间倒序。'}
      </p>
      <div className="space-y-1.5">
        {ordered.slice(0, 6).map((m) => (
          <details key={`${m.at}-${m.questionId}`} className="group text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-2">
              <span className="truncate text-foreground/90">{m.prompt}</span>
              {!m.answered && (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  未作答
                </span>
              )}
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {m.sceneTitle}
              </span>
            </summary>
            <div className="mt-1 space-y-0.5 rounded bg-muted/50 p-2 text-muted-foreground">
              {m.userAnswer && <p>你的答案：{m.userAnswer}</p>}
              {m.correctAnswer && <p className="text-foreground/80">正确答案：{m.correctAnswer}</p>}
              {m.analysis && <p>解析：{m.analysis}</p>}
              {!m.analysis && <p>本题未附解析。</p>}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function QuizMasteryBlock({ profile }: { profile: LearnerProfileFields | null }) {
  const entries = Object.entries(profile?.conceptMastery ?? {}).sort((a, b) => a[1] - b[1]);
  if (entries.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border/70 p-2.5 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">实测盲区（来自测验）：</span>
        暂无数据——完成当前领域课程中的测验后生成。证据账本会按领域折叠出掌握度，低于 0.6
        的主题在此突出显示。
      </p>
    );
  }
  const weak = entries.filter(([, v]) => v < 0.6);
  return (
    <div className="space-y-2 rounded-md border border-border/70 p-2.5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">实测盲区（来自测验）：</span>
        以下掌握度来自当前有效领域的证据账本折叠结果，与上图引擎推断值不同源。
        {weak.length > 0
          ? `低于 0.6 的 ${weak.length} 个主题为实测薄弱点。`
          : '当前没有低于 0.6 的主题。'}
      </p>
      <div className="space-y-1.5">
        {entries.map(([concept, v]) => (
          // 窄屏让概念名独占一行（w-full 触发换行），进度条与数值落到第二行。
          // 否则 375px 下条子只剩 67px 宽，长短对比看不出来。
          <div key={concept} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={cn(
                'w-full shrink-0 truncate text-xs sm:w-40',
                v < 0.6 ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
              title={conceptLabel(concept)}
            >
              {conceptLabel(concept)}
            </span>
            <div className="h-1.5 flex-1 rounded-full bg-muted">
              <div
                className={cn('h-1.5 rounded-full', v < 0.6 ? 'bg-primary' : 'bg-foreground/35')}
                style={{ width: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%` }}
              />
            </div>
            <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
              {v.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 你的课为什么长这样 —— 单人版差异归因
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 对比页回答「两个人的课差在哪」，这里回答「我的课为什么是这个样子」。
 * 归因逻辑在 `app/report/attribution.ts`（纯函数，可测）；这里只负责渲染。
 *
 * 概念中文名在 `lib/knowledge/concept-labels.ts`（引擎 goal_concepts 的逆映射），
 * 薄弱概念先在这里换名再传进去——不让归因模块再抄一份词表。
 */
function WhyThisCourse({
  bp,
  profile,
  course,
}: {
  bp: LearnerBlueprint;
  profile: LearnerProfileFields;
  course: CourseData | null;
}) {
  const rows = whyThisCourse({
    profile,
    bp,
    weakConcepts: bp.weak_concepts.map(conceptLabel),
    courseName: course?.stage.name,
    humanize,
  });
  if (rows.length === 0) {
    return (
      <EmptyState
        title="本次诊断没有可归因的字段"
        hint="学情诊断这次没返回资源配比与薄弱概念（引擎降级时会这样）。点右上角「重新计算」再试。"
      />
    );
  }
  return (
    <ol className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
      {rows.map((r) => (
        <li key={r.dimension} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
          <span className="shrink-0 text-sm font-medium sm:w-28">{r.dimension}</span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm leading-relaxed">{r.observation}</span>
            {r.because.length > 0 && (
              <span className="block text-xs text-muted-foreground">
                因为：{r.because.join(' · ')}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart 2 — 资源难度匹配曲线
// ─────────────────────────────────────────────────────────────────────────────

function DifficultyCurveChart({
  bp,
  course,
  profile,
}: {
  bp: LearnerBlueprint;
  course: CourseData;
  profile: LearnerProfileFields | null;
}) {
  // quiz 决策写回的动态难度（单点当前值）。历史轨迹本机未存，故只画当前标记，
  // 不伪造一条曲线。eloRating 由 quiz-view 写回但未进 LearnerProfileFields 类型。
  const dynDifficulty =
    profile?.currentDifficulty && /^L[1-4]$/.test(profile.currentDifficulty)
      ? profile.currentDifficulty
      : null;
  const eloRating = (profile as (LearnerProfileFields & { eloRating?: number }) | null)?.eloRating;
  const band = (bp.blueprint?.resource_mix?.quiz_difficulty_band ?? []).map(levelRank);
  const effectiveBand = band.length > 0 ? band : [levelRank(bp.recommended_difficulty)];
  const baseline = levelRank(bp.recommended_difficulty);
  const bandLo = Math.min(...effectiveBand);
  const bandHi = Math.max(...effectiveBand);

  const outlineById = new Map(course.outlines.map((o) => [o.id, o] as const));
  const outlineByOrder = new Map(course.outlines.map((o) => [o.order, o] as const));

  const points: SceneDifficulty[] = [...course.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene, index) => {
      const outline =
        (scene.outlineId ? outlineById.get(scene.outlineId) : undefined) ??
        outlineByOrder.get(scene.order);
      return { scene, index, ...sceneDifficulty(scene, outline, effectiveBand) };
    });

  if (points.length === 0) {
    return <EmptyState title="本课程还没有场景" hint="课程生成完成后再来查看难度匹配曲线。" />;
  }

  // 纵轴刻度写「第 N 档」（引擎的 L1–L4 是内部记号，序数不丢信息又不用解释），
  // 比原来的两字符宽，左边距跟着从 34 放到 48，否则刻度被画布左缘裁掉。
  const padL = 48;
  const padR = 16;
  const padT = 14;
  const padB = 34;
  const plotW = Math.max(360, points.length * 46);
  const plotH = 170;
  const width = padL + plotW + padR;
  const height = padT + plotH + padB;

  const x = (i: number) =>
    padL + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
  const y = (rank: number) => padT + plotH - ((rank - 0.6) / 3.8) * plotH;

  // L1–L4 是四个离散档位，不是连续量：场景 3 是 L2、场景 4 是 L3，中间不存在 L2.5。
  // 折线会在两点之间画出一段并不存在的过渡，所以这里画阶梯——每个场景占一段平台，
  // 换档在两场景的中点竖着跳。平台的半宽就是相邻场景间距的一半。
  const half = points.length > 1 ? plotW / (points.length - 1) / 2 : plotW / 4;
  const clampX = (v: number) => Math.min(padL + plotW, Math.max(padL, v));
  const above = points.filter((p) => p.rank > bandHi).length;
  const below = points.filter((p) => p.rank < bandLo).length;
  const estimated = points.filter((p) => p.estimated).length;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full text-foreground"
          style={{ minWidth: `${Math.min(width, 900)}px` }}
          role="img"
          aria-label="资源难度匹配阶梯图"
        >
          {/* learner capability band */}
          <rect
            x={padL}
            y={y(bandHi)}
            width={plotW}
            height={Math.max(4, y(bandLo) - y(bandHi))}
            fill="var(--primary)"
            opacity={0.12}
          />
          {/* y axis */}
          {[1, 2, 3, 4].map((r) => (
            <g key={r}>
              <line
                x1={padL}
                y1={y(r)}
                x2={padL + plotW}
                y2={y(r)}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.12}
              />
              <text
                x={padL - 8}
                y={y(r) + 3}
                textAnchor="end"
                fontSize={10}
                fill="currentColor"
                opacity={0.6}
              >
                第 {r} 档
              </text>
            </g>
          ))}
          {/* baseline */}
          <line
            x1={padL}
            y1={y(baseline)}
            x2={padL + plotW}
            y2={y(baseline)}
            stroke="var(--primary)"
            strokeWidth={1.5}
            strokeDasharray="5 3"
          />
          <text x={padL + 4} y={y(baseline) - 5} fontSize={9} fill="var(--primary)">
            能力基线 {levelText(baseline)}
          </text>
          {/* 当前自适应难度（quiz 决策写回的动态单点） */}
          {dynDifficulty && (
            <>
              <line
                x1={padL}
                y1={y(levelRank(dynDifficulty))}
                x2={padL + plotW}
                y2={y(levelRank(dynDifficulty))}
                stroke="var(--yellow-deep)"
                strokeWidth={1.5}
                strokeDasharray="2 3"
              />
              <text
                x={padL + plotW - 4}
                y={y(levelRank(dynDifficulty)) - 5}
                textAnchor="end"
                fontSize={9}
                fill="var(--yellow-deep)"
              >
                当前自适应难度 {levelText(levelRank(dynDifficulty))}
                {typeof eloRating === 'number' ? ` · Elo ${Math.round(eloRating)}` : ''}
              </text>
            </>
          )}

          {/* 换档竖线：只表示「这里换了档」，不带数据含义，所以比平台淡。 */}
          {points.slice(1).map((p, i) => {
            const prev = points[i];
            if (prev.rank === p.rank) return null;
            const xm = (x(prev.index) + x(p.index)) / 2;
            return (
              <line
                key={`jump-${p.scene.id}`}
                x1={xm}
                y1={y(prev.rank)}
                x2={xm}
                y2={y(p.rank)}
                stroke="var(--primary)"
                strokeWidth={2}
                opacity={0.45}
              />
            );
          })}
          {/* 每个场景一段平台。估计值画点线，与空心点是同一件事的两个表达。
              点线而不是虚线：上面那条「能力基线」已经占了长虚线（5 3），
              两种线都是紫色，再用相近的虚线就分不出「参考线」和「估计值」了。 */}
          {points.map((p) => (
            <line
              key={`plateau-${p.scene.id}`}
              x1={clampX(x(p.index) - half)}
              y1={y(p.rank)}
              x2={clampX(x(p.index) + half)}
              y2={y(p.rank)}
              stroke="var(--primary)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={p.estimated ? '0.1 4' : undefined}
              opacity={p.estimated ? 0.8 : 1}
            />
          ))}

          {points.map((p) => {
            const outOfRange = p.rank > bandHi || p.rank < bandLo;
            const color =
              p.rank > bandHi
                ? 'var(--yellow-deep)'
                : p.rank < bandLo
                  ? 'var(--muted-foreground)'
                  : 'var(--primary)';
            return (
              <g key={p.scene.id}>
                <circle
                  cx={x(p.index)}
                  cy={y(p.rank)}
                  r={outOfRange ? 5 : 4}
                  fill={p.estimated ? 'transparent' : color}
                  stroke={color}
                  strokeWidth={2}
                />
                <title>
                  {`${p.index + 1}. ${p.scene.title}\n难度 ${levelText(p.rank)}${p.estimated ? '（估计）' : ''}\n依据：${p.basis}`}
                </title>
                <text
                  x={x(p.index)}
                  y={padT + plotH + 14}
                  textAnchor="middle"
                  fontSize={9}
                  fill="currentColor"
                  opacity={0.55}
                >
                  {p.index + 1}
                </text>
              </g>
            );
          })}
          <text
            x={padL + plotW / 2}
            y={height - 4}
            textAnchor="middle"
            fontSize={9}
            fill="currentColor"
            opacity={0.5}
          >
            课程场景序号
          </text>
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-primary/15" />
          学习者能力区间第 {bandLo}–{bandHi} 档
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-yellow-deep" />
          高于能力
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-muted-foreground" />
          低于能力
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="26" height="10" aria-hidden className="shrink-0 text-primary">
            <line
              x1="1"
              y1="5"
              x2="25"
              y2="5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="0.1 4"
            />
            <circle cx="13" cy="5" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          空心点 + 点线段 = 估计值
        </span>
      </div>

      <p className="text-base leading-relaxed">
        <span className="font-medium">匹配结论：</span>
        {above === 0 && below === 0
          ? `${points.length} 个场景全部落在第 ${bandLo}–${bandHi} 档能力区间内，难度编排与学情一致。`
          : `${points.length} 个场景中 ${above} 个高于能力区间、${below} 个低于能力区间；高出的部分建议追加前置铺垫，低于的部分可压缩或跳过。`}
        {estimated > 0 ? (
          <span className="text-muted-foreground">
            {' '}
            其中 <span className="font-medium text-yellow-deep">{estimated} 个为估计值</span>
            （图上画成空心点加点线平台）。
          </span>
        ) : null}
      </p>

      <Caliber summary="口径与画法依据">
        画成阶梯而不是折线，是因为难度是四个离散档位、不是连续量——场景之间不存在「第 2.5 档」，
        折线画出来的那段斜坡是不存在的值。每个场景占一段平台，换档在两场景中点竖着跳。
        能力基线与能力区间来自引擎的学情诊断（推荐难度 / 测验难度带）。
        场景难度中只有测验场景有大纲记录值（easy/medium/hard 换算为第 1/2/3 档）；本课程{' '}
        {points.length} 个场景里有 {estimated} 个无记录难度，按场景类型在能力区间内保守取值。
        {dynDifficulty
          ? ' 橙色虚线为最近一次测验决策写回的当前自适应难度（单点现状；当前账户尚无历史轨迹，难度变化曲线随学习积累后呈现）。'
          : ' 完成测验后，此图会额外标出测验决策写回的当前自适应难度（随学习积累形成变化轨迹）。'}
      </Caliber>

      {/* 点的标题与取值依据原来只在 SVG <title> 里，触屏和投影拿不到（NN/g tooltip 指南）。
          搬成页面上可展开的列表，沿用下方审核明细同一套 details 写法。 */}
      <details className="rounded-lg border border-border/70 p-2.5">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          逐点取值依据（{points.length} 个场景，其中 {estimated} 个为估计值）
        </summary>
        <div className="mt-2 divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
          {points.map((p) => (
            // 窄屏必须上下堆：右列那句取值依据有三十来字，配 shrink-0 时实测撑到 395px，
            // 而外层列表在 375px 视口下只有 271px 且是 overflow-hidden——依据会被直接裁掉，
            // 而这一段本来就是为了让触屏用户不靠悬停也能看到依据才搬出来的。
            <div
              key={p.scene.id}
              className="flex flex-col gap-0.5 px-3 py-2 text-xs md:flex-row md:items-start md:justify-between md:gap-3"
            >
              <span className="min-w-0 flex-1">
                <span className="tabular-nums text-muted-foreground">{p.index + 1}. </span>
                {p.scene.title}
              </span>
              <span className="text-muted-foreground md:shrink-0 md:text-right">
                {levelText(p.rank)}
                {p.estimated ? '（估计）' : ''} · {p.basis}
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

type BlueprintState =
  | { kind: 'loading' }
  | { kind: 'ok'; bp: LearnerBlueprint }
  | { kind: 'no-profile' }
  | { kind: 'no-course' }
  | { kind: 'domain-unavailable'; reason: string }
  | { kind: 'offline' };

type CourseState =
  | { kind: 'loading' }
  | { kind: 'ok'; course: CourseData }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

export default function ReportPage() {
  const accountProfileState = useAccountProfile<ReportProfile>(readStoredProfile);
  const [stages, setStages] = useState<StageListItem[] | null>(null);
  const [stageId, setStageId] = useState<string | null | undefined>(undefined);
  const [profile, setProfile] = useState<ReportProfile | null>(null);
  const [domainContextState, setDomainContextState] = useState<EffectiveDomainContextState>({
    kind: 'loading',
  });
  const [courseState, setCourseState] = useState<CourseState>({ kind: 'loading' });
  const [bpState, setBpState] = useState<BlueprintState>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [recomputing, setRecomputing] = useState(false);
  // 这一轮加载是不是「重新计算」按钮触发的。用 ref 不用 state：它只是给下面那个
  // effect 读的一次性标记，进 deps 会让 effect 多跑一轮。首次加载和切课时它是 false，
  // 所以不会弹 toast。
  const manualRef = useRef(false);

  // Resolve the profile + which classroom to report on. `useSearchParams` would
  // force a Suspense boundary; the raw query string is the same information.
  useEffect(() => {
    if (accountProfileState.kind === 'loading') return;
    let cancelled = false;
    if (accountProfileState.kind === 'error') {
      setDomainContextState({ kind: 'error', reason: accountProfileState.reason });
      setProfile(null);
      setStages([]);
      setStageId(null);
      return;
    }
    (async () => {
      const stored = accountProfileState.profile;
      const [resolved, loadedStages] = await Promise.all([
        loadEffectiveDomainContext(stored),
        listStages().catch(() => [] as StageListItem[]),
      ]);
      if (cancelled) return;
      setDomainContextState(resolved);
      setProfile(
        stored && resolved.kind === 'ready'
          ? applyEffectiveDomain(stored, resolved.context)
          : stored,
      );

      let list = loadedStages;
      if (resolved.kind !== 'ready') {
        list = [];
      } else {
        const { context } = resolved;
        const domains = resolved.courseDomains ?? {};
        if (!context.domain) {
          // 已有画像或机构指派、却解析不出领域时，不能再拿第一门（通常是 AI）课程顶上。
          if (stored || context.assignment) list = [];
        } else if (context.assignment) {
          // 最新指派只负责定域；报告选择器保留该 learner 在本领域收到的全部可用课程。
          const assignedCourseIds = new Set(context.courseIds ?? [context.assignment.courseId]);
          list = list.filter((stage) => assignedCourseIds.has(stage.id));
        } else if (context.isAi) {
          list = list.filter((stage) => belongsToDomain(stage.id, context.domain!, domains));
        } else {
          // 已知非 AI 域必须有运行时归属证据才展示；缺表时不能把全量 AI 课程放回来。
          list = list.filter((stage) => {
            const entry = domains[stage.id];
            return (entry?.corpus ?? entry?.domain ?? '') === context.domain;
          });
        }
      }
      if (cancelled) return;
      setStages(list);
      const wanted = new URLSearchParams(window.location.search).get('stageId');
      const pick = (wanted && list.some((s) => s.id === wanted) ? wanted : list[0]?.id) ?? null;
      setStageId(pick);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountProfileState]);

  // Load the classroom, then ask the engine for the blueprint.
  useEffect(() => {
    if (stageId === undefined || domainContextState.kind === 'loading') return;
    let cancelled = false;
    const manual = manualRef.current;

    // 每个终止分支都从这里收口：转圈停在真实结果上，提示语说的就是这一轮真的发生了什么。
    // 旧写法是按钮里挂一个固定 900ms 的 setTimeout 弹「已重新计算」，与
    // /api/adaptive/blueprint 的返回没有任何关系——引擎挂起时（lib/generation/
    // learner-profile.ts 的 FETCH_TIMEOUT_MS = 25_000）用户 0.9 秒看到绿色成功提示，
    // 之后最长再等 25 秒才看到「引擎离线」的空态。而且它的判据读的是闭包里那份旧
    // courseState，切课之后重算会反向弹「当前没有课程可分析」。
    const finish = (announce?: () => void) => {
      if (!manual) return;
      manualRef.current = false;
      setRecomputing(false);
      announce?.();
    };

    (async () => {
      if (!profile) {
        setCourseState({ kind: 'none' });
        setBpState({ kind: 'no-profile' });
        finish(() => toast.warning('还没有学习者画像，先在首页填写再重新计算'));
        return;
      }
      if (domainContextState.kind === 'error') {
        setCourseState({ kind: 'error', message: domainContextState.reason });
        setBpState({ kind: 'domain-unavailable', reason: domainContextState.reason });
        finish(() => toast.error(domainContextState.reason));
        return;
      }
      if (!domainContextState.context.domain) {
        const reason = domainContextState.context.reason ?? '当前课程的有效领域尚未由引擎确认。';
        setCourseState({ kind: 'error', message: reason });
        setBpState({ kind: 'domain-unavailable', reason });
        finish(() => toast.error(reason));
        return;
      }
      if (stageId === null) {
        setCourseState({ kind: 'none' });
        setBpState({ kind: 'no-course' });
        finish(() => toast.warning('当前没有课程可分析——先在首页生成一门课'));
        return;
      }
      setCourseState({ kind: 'loading' });
      setBpState({ kind: 'loading' });

      let course: CourseData | null = null;
      try {
        // Prefer the live store when it already holds this classroom (client-side
        // navigation from the classroom page); otherwise read the persisted copy.
        const store = useStageStore.getState();
        if (store.stage?.id === stageId && store.scenes.length > 0) {
          course = { stage: store.stage, scenes: store.scenes, outlines: store.outlines };
        } else {
          const data = await loadStageData(stageId);
          if (data) {
            course = {
              stage: data.stage,
              scenes: data.scenes,
              outlines: data.outline?.outlines ?? [],
            };
          }
        }
      } catch (err) {
        if (cancelled) {
          finish();
          return;
        }
        setCourseState({ kind: 'error', message: String(err) });
        finish(() => toast.error(`读取课程失败：${String(err)}`));
        return;
      }
      if (cancelled) {
        // 组件已卸载或已被下一轮加载接管：不提示，但要把转圈复位，否则按钮卡在「计算中…」。
        finish();
        return;
      }

      if (!course) {
        setCourseState({ kind: 'none' });
        setBpState({ kind: 'no-course' });
        finish(() => toast.warning('当前没有课程可分析——先在首页生成一门课'));
        return;
      }
      setCourseState({ kind: 'ok', course });

      try {
        const res = await fetch('/api/adaptive/blueprint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ learningGoal: course.stage.name, profile }),
        });
        if (cancelled) {
          finish();
          return;
        }
        if (!res.ok || res.status === 204) {
          setBpState({ kind: 'offline' });
          finish(() => toast.error('引擎离线，学情数据不可用——确认引擎服务已启动后再试'));
          return;
        }
        const payload = (await res.json()) as { blueprint?: LearnerBlueprint };
        if (cancelled) {
          finish();
          return;
        }
        if (payload.blueprint) {
          setBpState({ kind: 'ok', bp: payload.blueprint });
          finish(() => toast.success('已按当前画像重新计算'));
        } else {
          setBpState({ kind: 'offline' });
          finish(() => toast.error('引擎返回了空的诊断结果，学情数据不可用'));
        }
      } catch {
        if (cancelled) {
          finish();
          return;
        }
        setBpState({ kind: 'offline' });
        finish(() => toast.error('引擎离线，学情数据不可用——确认引擎服务已启动后再试'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [domainContextState, profile, reloadKey, stageId]);

  const course = courseState.kind === 'ok' ? courseState.course : null;
  const bp = bpState.kind === 'ok' ? bpState.bp : null;
  const mix = bp?.blueprint?.resource_mix ?? null;
  const effectiveContext: EffectiveDomainContext | null =
    domainContextState.kind === 'ready' ? domainContextState.context : null;
  const effectiveDomain = effectiveContext?.domain ?? null;
  const effectiveDomainName =
    effectiveContext?.label ?? (effectiveDomain ? domainLabel(effectiveDomain) : '领域待确认');
  const isAiDomain = effectiveContext?.isAi === true;
  const domainProfile = profileForDomain(profile, effectiveDomain);

  // 核心大数（⑪）：全部从页内已有数据推算，不引新数据源。
  const dynLevel =
    profile?.currentDifficulty && /^L[1-4]$/.test(profile.currentDifficulty)
      ? profile.currentDifficulty
      : null;
  const masteryValues = bp ? Object.values(bp.mastery_vector) : [];
  const avgMastery = masteryValues.length
    ? masteryValues.reduce((a, b) => a + b, 0) / masteryValues.length
    : 0;
  const blueprintFallback = useCallback(() => {
    if (bpState.kind === 'loading') {
      return (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在向学情诊断 Agent 请求…
        </div>
      );
    }
    if (bpState.kind === 'no-profile') {
      return (
        <EmptyState
          title="尚未填写学习者画像"
          hint="本页所有学情结论都由画像算出，没有画像就没有可信的结论。请回首页点右上角「学习者画像」填写领域、学历、身份与五维自评，再回到本页。"
        />
      );
    }
    if (bpState.kind === 'no-course') {
      return (
        <EmptyState
          title="还没有课程"
          hint="学情诊断以课程主题为学习目标，请先在首页生成一门课程。"
        />
      );
    }
    if (bpState.kind === 'domain-unavailable') {
      return (
        <EmptyState
          title={
            effectiveContext?.status === 'assignment-unavailable'
              ? '机构课程暂不可用'
              : '当前课程的有效领域尚未确认'
          }
          hint={`${bpState.reason} 学情报告不会改用 AI 画像或 AI 诊断代替。`}
        />
      );
    }
    if (effectiveDomain && !isAiDomain) {
      return (
        <EmptyState
          title="所属机构尚未提供该领域的学情数据"
          hint={`当前没有可用的「${effectiveDomainName}」学情引擎产物（也可能是诊断服务暂时不可用）；系统没有改用 AI 学情代替。机构补齐产物或服务恢复后可重新计算。`}
        />
      );
    }
    return (
      <EmptyState
        title="引擎离线，学情数据不可用"
        hint="多智能体引擎未响应。请确认引擎服务已启动后点右上角「重新计算」。"
      />
    );
  }, [bpState, effectiveContext?.status, effectiveDomain, effectiveDomainName, isAiDomain]);

  const audit = course ? summarizeAudits(course.scenes) : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* 共享极简顶栏：返回 + 语言 + 主题（components/site-header.tsx） */}
      <SiteHeader localized={false} maxWidth="max-w-5xl" />
      {/* 字阶与留白照公共页那套（H1 28px 级、区块间距拉到 py-12/space-y-8）：
          用户 08-16 评审说这页「排版混乱、小字堆砌」，病根一半是行距字阶都挤在一档里。 */}
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-12 sm:px-6">
        {/* header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-semibold leading-snug tracking-tight">
              个人学情与资源匹配度报告
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              数据来源仅三处：当前账户的学习者画像、多智能体引擎诊断结果、本课程已生成的场景与审核记录。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {stages && stages.length > 1 && (
              <select
                value={stageId ?? ''}
                onChange={(e) => setStageId(e.target.value)}
                className="max-w-[14rem] rounded-md border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label="选择课程"
              >
                {stages.map((s) => (
                  <option className="bg-background text-foreground" key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
            {/* 反馈是必须的：没课程时重算会立刻返回空态，界面零变化，
                用户会以为按钮点不动（线上实拍反馈）。转圈 + 结果提示。
                提示由上面那个加载 effect 在真实终止分支里发，这里只负责发起。 */}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={recomputing}
              onClick={() => {
                manualRef.current = true;
                setRecomputing(true);
                setReloadKey((k) => k + 1);
              }}
            >
              <RefreshCw className={cn('size-3.5', recomputing && 'animate-spin')} />
              {recomputing ? '计算中…' : '重新计算'}
            </Button>
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="space-y-8"
        >
          {/* ── 0. 核心大数（⑪㉑）── */}
          {/* 等待中先占位，别让四张卡凭空插进来把下面整片推下去。
              条件必须是 bpState.kind === 'loading'，**不能写 bp === null**——
              no-profile / no-course / offline 三个终态下 bp 同样是 null，
              按 null 写会让骨架卡永久停在那里假装数据还在路上，
              那正是本页自己反对的事（下面「不会用默认画像冒充你的画像」同一条原则）。 */}
          {bpState.kind === 'loading' && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden>
              {['覆盖概念数', '平均掌握度', '薄弱概念数', '当前难度'].map((label) => (
                <div key={label} className="rounded-xl border bg-card p-5 shadow-card">
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="mt-1 h-8 w-16 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          )}
          {bp && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="覆盖概念数" value={masteryValues.length} />
              <StatCard
                label="平均掌握度"
                value={avgMastery}
                format={{ style: 'percent', maximumFractionDigits: 0 }}
              />
              <StatCard label="薄弱概念数" value={bp.weak_concepts.length} />
              <StatCard
                label="当前难度"
                value={levelRank(dynLevel ?? bp.recommended_difficulty)}
                prefix="第 "
                suffix=" 档"
              />
            </div>
          )}

          {/* ── 1. 画像摘要条 ── */}
          <SectionCard
            icon={Target}
            title="画像摘要"
            description="左半是你为当前账户填写的画像，右半是多智能体引擎据此给出的学情诊断。"
          >
            {!profile ? (
              <EmptyState
                title="尚未填写学习者画像"
                hint="回首页点右上角「学习者画像」填写后再来；本页不会用默认画像冒充你的画像。"
              />
            ) : (
              <div className="space-y-3">
                {isAiDomain && isUntouchedDefault(profile) && (
                  <p className="flex items-start gap-2 rounded-lg border border-yellow-deep/20 bg-yellow-soft p-3 text-sm leading-relaxed text-yellow-deep">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      当前画像与系统默认值完全一致——说明你还没有改过它。下面的诊断结论是基于这份默认画像算出来的，
                      不是针对你本人的。请回首页点右上角「学习者画像」按实际情况修改，再回来点「重新计算」。
                    </span>
                  </p>
                )}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      <span className="rounded-full border px-2 py-0.5">
                        有效领域 · {effectiveDomainName}
                      </span>
                      {effectiveContext?.source === 'course-assignment' && (
                        <span className="rounded-full border px-2 py-0.5">来源 · 当前课程指派</span>
                      )}
                      <span className="rounded-full border px-2 py-0.5">
                        学历 ·{' '}
                        {EDUCATION_LABEL[profile.education ?? ''] ?? profile.education ?? '未填'}
                      </span>
                      <span className="rounded-full border px-2 py-0.5">
                        身份 · {profile.role || '未填'}
                      </span>
                      {profile.time_budget_hours !== undefined && (
                        <span className="rounded-full border px-2 py-0.5">
                          预算 · {profile.time_budget_hours}h
                        </span>
                      )}
                    </div>
                    {isAiDomain ? (
                      <div className="space-y-1.5">
                        {PROFILE_DIMENSIONS.map((d) => {
                          const v = (profile[d.key] as number) ?? 0;
                          return (
                            <div key={String(d.key)} className="flex items-center gap-2">
                              <span className="w-14 shrink-0 text-xs text-muted-foreground">
                                {d.label}
                              </span>
                              <div className="flex flex-1 gap-1">
                                {[0, 1, 2, 3, 4].map((lv) => (
                                  <span
                                    key={lv}
                                    className={cn(
                                      'h-1.5 flex-1 rounded-full',
                                      lv <= v ? 'bg-primary' : 'bg-muted',
                                    )}
                                  />
                                ))}
                              </div>
                              <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
                                {v}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rounded-md border border-dashed border-border/70 p-2.5 text-xs leading-relaxed text-muted-foreground">
                        本领域能力维度以学情引擎产物为准；旧领域画像中的自评维度不会在此展示。
                      </p>
                    )}
                    {profile.learning_preference && (
                      <p className="text-xs text-muted-foreground">
                        学习偏好：{profile.learning_preference}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
                    {bp ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded-full bg-purple-soft px-2 py-0.5 font-medium text-purple-deep">
                            学习者类型 · {learnerTypeLabel(bp.blueprint?.learner_type) || '未返回'}
                          </span>
                          <span className="rounded-full bg-blue-soft px-2 py-0.5 font-medium text-blue-deep">
                            推荐难度 · {levelText(levelRank(bp.recommended_difficulty))}
                          </span>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {humanize(bp.diagnosis_summary)}
                        </p>
                        {bp.blueprint?.refined_goal && (
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            <span className="font-medium text-foreground">目标细化：</span>
                            {humanize(bp.blueprint.refined_goal)}
                          </p>
                        )}
                      </>
                    ) : (
                      blueprintFallback()
                    )}
                  </div>
                </div>
              </div>
            )}
          </SectionCard>

          {/* ── 1.5 你的课为什么长这样（单人版差异归因）── */}
          <div id="why-this-course" className="scroll-mt-6">
            <SectionCard
              icon={Sparkles}
              title="你的课为什么长这样"
              description="每一条都是「这门课的某个做法 ← 你画像里的哪个字段」。字段缺就不写那一条，不补占位。"
            >
              {bp && profile ? (
                isAiDomain ? (
                  <WhyThisCourse bp={bp} profile={profile} course={course} />
                ) : (
                  <div className="space-y-2 rounded-lg border border-border/70 p-3 text-sm">
                    <p className="leading-relaxed">{humanize(bp.diagnosis_summary)}</p>
                    {(mix?.rationale ?? []).map((reason) => (
                      <p key={reason} className="text-xs leading-relaxed text-muted-foreground">
                        {humanize(reason)}
                      </p>
                    ))}
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      本段只展示学情引擎返回的「{effectiveDomainName}」诊断，
                      不套用其它领域的固定自评维度。
                    </p>
                  </div>
                )
              ) : (
                blueprintFallback()
              )}
            </SectionCard>
          </div>

          {/* ── 2. 知识盲区定位图 ── */}
          <SectionCard
            icon={AlertTriangle}
            title="知识盲区定位"
            description="每个概念的掌握度取自引擎的学情诊断；被判为薄弱的用强调色突出、其余压成灰色，并标出目标掌握度与缺口。"
          >
            <div className="space-y-4">
              {bp ? <BlindSpotChart bp={bp} /> : blueprintFallback()}
              {domainProfile ? (
                <>
                  <QuizMasteryBlock profile={domainProfile} />
                  <ReviewNextBlock
                    key={effectiveDomain}
                    profile={domainProfile}
                    domain={effectiveDomain!}
                  />
                </>
              ) : (
                <EmptyState
                  title="当前领域的证据画像未覆盖"
                  hint={
                    effectiveDomain
                      ? `当前档案没有「${effectiveDomainName}」的分域掌握度；本页没有使用旧的全域扁平画像代替。完成该领域测验并成功写回证据后再查看。`
                      : '当前有效领域尚未确认；本页没有展示任何全域扁平画像。'
                  }
                />
              )}
              {effectiveDomain && (
                <MistakeBankBlock profile={domainProfile} domain={effectiveDomain} />
              )}
            </div>
          </SectionCard>

          {/* ── 3. 资源难度匹配曲线 ── */}
          <SectionCard
            icon={TrendingUp}
            title="资源难度匹配"
            description="把课程各场景的难度与学习者能力区间画在同一张图上，一眼看出哪些场景超出或低于学习者水平。"
          >
            {bp && course ? (
              <DifficultyCurveChart bp={bp} course={course} profile={profile} />
            ) : courseState.kind === 'ok' ? (
              blueprintFallback()
            ) : courseState.kind === 'loading' ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在读取课程…
              </div>
            ) : courseState.kind === 'error' ? (
              blueprintFallback()
            ) : (
              <EmptyState
                title="没有可分析的课程"
                hint="请先在首页生成一门课程；本页只分析真实存在的课程场景，不会画示意曲线。"
              />
            )}
          </SectionCard>

          {/* ── 4. 当前领域全景路径（与首页、/path 同源） ── */}
          <div id="learning-path" className="scroll-mt-6">
            <SectionCard
              icon={GitBranch}
              title="当前领域全景学习路径"
              description="报告、首页与路径页读取同一份引擎产物；机构切换课程领域后，这里随有效领域一起切换。"
            >
              <PathOrDomainCard corpus={effectiveDomain ?? undefined} className="shadow-none" />
            </SectionCard>
          </div>

          {/* ── 5. 学情证据时间轨迹 ── */}
          <div id="evidence-trajectory" className="scroll-mt-6">
            <SectionCard
              icon={Activity}
              title="学情证据时间轨迹"
              description="上面三张图画的是当前状态，这一张画的是发生过什么：每个点是一次真实判定，来自测验与导学的证据流。"
            >
              <EvidenceTrajectoryChart domain={effectiveDomain ?? undefined} />
            </SectionCard>
          </div>

          {/* ── 6. 资源匹配度小结 ── */}
          <SectionCard
            icon={BookOpen}
            title="资源配比与推导依据"
            description="引擎按画像算出的资源配比计划，每条都附它自己的推导链。"
          >
            {!bp ? (
              blueprintFallback()
            ) : !mix ? (
              <EmptyState
                title="学情诊断未返回资源配比"
                hint="本次诊断没有返回资源配比（引擎降级时会这样），因此没有可展示的配比计划。"
              />
            ) : (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    {
                      label: '支架档',
                      value: SCAFFOLD_LABEL[mix.scaffold_level] ?? mix.scaffold_level,
                    },
                    { label: '教具数量', value: `${mix.visual_widget_count} 个` },
                    { label: '示意图数量', value: `${mix.diagram_count} 个` },
                    { label: '代码示例数', value: `${mix.code_example_count} 个` },
                    { label: '类比领域', value: mix.analogy_domain },
                    { label: '每节篇幅', value: `${mix.section_length_band} 字` },
                    {
                      label: '测验难度带',
                      value: levelBandText(mix.quiz_difficulty_band) || '未指定',
                    },
                  ].map((item) => (
                    <div key={item.label} className="rounded-lg border border-border/70 p-2.5">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        {item.label}
                      </p>
                      <p className="mt-0.5 text-xs font-medium leading-snug">{item.value}</p>
                    </div>
                  ))}
                </div>

                {mix.rationale.length > 0 && (
                  <div className="space-y-1.5 rounded-lg border border-purple-deep/20 bg-purple-soft/60 p-3">
                    <p className="text-xs font-medium text-purple-deep">
                      这些配比是怎么从画像算出来的（引擎给的推导链）
                    </p>
                    {mix.rationale.map((r, i) => (
                      <p key={i} className="text-xs leading-relaxed text-muted-foreground">
                        {i + 1}. {humanize(r)}
                      </p>
                    ))}
                  </div>
                )}

                {(bp.blueprint?.content_strategy?.length ||
                  bp.blueprint?.practice_strategy?.length ||
                  bp.blueprint?.assessment_strategy?.length) && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    {[
                      { title: '内容策略', items: bp.blueprint?.content_strategy ?? [] },
                      { title: '练习策略', items: bp.blueprint?.practice_strategy ?? [] },
                      { title: '评估策略', items: bp.blueprint?.assessment_strategy ?? [] },
                    ].map((col) => (
                      <div key={col.title} className="rounded-lg border border-border/70 p-2.5">
                        <p className="text-xs font-medium">{col.title}</p>
                        <ul className="mt-1 space-y-0.5">
                          {col.items.map((it, i) => (
                            <li key={i} className="text-xs leading-relaxed text-muted-foreground">
                              · {humanize(it)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </SectionCard>

          {/* ── 6. 内容可信度小结 ── */}
          <SectionCard
            icon={ShieldCheck}
            title="内容可信度小结"
            description="汇总本课程各场景生成时留下的幻觉审核记录，与学情无关，只看内容本身。"
          >
            {!course ? (
              <EmptyState title="没有可统计的课程" hint="请先在首页生成一门课程。" />
            ) : !audit || audit.audited === 0 ? (
              <EmptyState
                title="本课程场景没有携带审核记录"
                hint={`共 ${course.scenes.length} 个场景，都没有审核记录——通常是课程生成于审核门接入之前。重新生成一次即可带上。`}
              />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    {
                      testid: 'audit-summary-audited',
                      label: '已审核场景',
                      value: `${audit.audited}/${audit.total}`,
                      tone: 'text-foreground',
                    },
                    {
                      testid: 'audit-summary-grounded',
                      label: '证据接地率',
                      value: `${Math.round((audit.grounded / audit.audited) * 100)}%`,
                      tone:
                        audit.grounded === audit.audited ? 'text-green-deep' : 'text-yellow-deep',
                    },
                    {
                      testid: 'audit-summary-claims',
                      label: '核验断言数',
                      value: String(audit.claims),
                      tone: 'text-foreground',
                    },
                    {
                      testid: 'audit-summary-flagged',
                      label: '标记 / 拦截',
                      value: `${audit.flagged} / ${audit.blocked}`,
                      tone: audit.blocked > 0 ? 'text-destructive' : 'text-foreground',
                    },
                  ].map((k) => (
                    <div
                      key={k.label}
                      data-testid={k.testid}
                      className="rounded-lg border border-border/70 p-2.5"
                    >
                      <p className="text-xs text-muted-foreground">{k.label}</p>
                      <p className={cn('mt-0.5 text-lg font-semibold tabular-nums', k.tone)}>
                        {k.value}
                      </p>
                    </div>
                  ))}
                </div>

                <p className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm leading-relaxed">
                  {audit.blocked > 0 ? (
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-deep" />
                  )}
                  <span>
                    {audit.audited} 个场景经过独立的审核智能体核验，共核 {audit.claims} 条事实断言，
                    其中 {audit.grounded} 个场景由受控知识库接地；
                    {audit.blocked > 0
                      ? `有 ${audit.blocked} 个场景被拦截转人工复核，${audit.warned} 个带风险标记放行——建议先处理被拦截的场景再交付。`
                      : audit.warned > 0
                        ? `无场景被拦截，${audit.warned} 个带风险标记放行（超出资料覆盖范围的断言已在课件上标注），可以交付。`
                        : '无场景被拦截或标记，全部直接放行，可以交付。'}
                  </span>
                </p>

                <details className="rounded-lg border border-border/70 p-2.5">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    逐场景审核明细（{audit.audited} 条）
                  </summary>
                  {/* ⑯ 首尾圆角列表：外层圆角裁切，内部 divide 分隔，条目无独立边框 */}
                  <div className="mt-2 divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
                    {course.scenes
                      .filter((s) => s.audit)
                      .map((s) => (
                        // 同上：窄屏上下堆。右列固定占约 200px，375px 视口下留给场景标题
                        // 只剩五十来 px，标题被 truncate 到看不出是哪一节。
                        <div
                          key={s.id}
                          className="flex flex-col gap-0.5 px-3 py-2 text-xs transition-colors hover:bg-accent md:flex-row md:items-start md:justify-between md:gap-3"
                        >
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          <span className="text-muted-foreground md:shrink-0">
                            {s.audit!.totalClaims} 断言 · {s.audit!.verdict} ·{' '}
                            <span
                              className={cn(
                                s.audit!.decision === 'block_pending_review'
                                  ? 'text-destructive'
                                  : s.audit!.decision === 'publish_with_warnings'
                                    ? 'text-yellow-deep'
                                    : 'text-green-deep',
                              )}
                            >
                              {s.audit!.decision === 'block_pending_review'
                                ? '拦截复核'
                                : s.audit!.decision === 'publish_with_warnings'
                                  ? '带标记放行'
                                  : '直接放行'}
                            </span>
                          </span>
                        </div>
                      ))}
                  </div>
                </details>
              </div>
            )}
          </SectionCard>

          <p className="pb-4 text-center text-xs text-muted-foreground">
            标有
            <EstimateTag />
            的数值为按规则推导的估计值，规则见对应图注。
          </p>
        </motion.div>
      </div>
    </div>
  );
}
