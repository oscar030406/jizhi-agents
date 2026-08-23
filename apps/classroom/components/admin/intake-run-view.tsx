'use client';

/**
 * 一次领域接入 run 的观看端：并行泳道 + 每站实数 + 事件流 + 回放。
 *
 * 三条设计约束，都是被这条流水线本身逼出来的：
 *
 * 1. **并行要看得见。** 编排器按依赖图发车，③检索索引 / ④知识整理 / ⑤金标 只依赖 ②，
 *    三站同时跑。所以泳道按「依赖波次」分组，同一波的站并排；时间条共用一根时间轴，
 *    区间重叠就是并行的证据，右侧的事件流里 seq 交错是同一件事的另一种看法。
 *    不做单条进度条——那会把并行画成串行。
 * 2. **只渲染事件里有的数。** 每站的 `detail` 有什么显示什么，没有的字段不出占位。
 * 3. **直播与回放同一条路。** 状态一律由「事件流前 n 条」推出来（`deriveView`），
 *    回放不是另做的动画，是拿当时的事件重演。读的是落盘的 events.jsonl，
 *    所以引擎停机后回放照常。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FirstCourseLauncher } from '@/components/admin/first-course-launcher';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  MinusCircle,
  Pause,
  Play,
} from 'lucide-react';

import type { IntakeEvent, IntakeRunRecord, StageStatus } from '@/lib/server/intake-runs';
import { deriveView, type StageView } from '@/lib/knowledge/intake-run-timeline';
import { domainLabel, hasDomainLabel } from '@/lib/knowledge/domain-labels';

const POLL_MS = 1500;
/** 回放按事件顺序等速走，不按真实时长——一次 run 的事件常常只差几毫秒，照真实时长演等于闪一下。 */
const REPLAY_MS = 280;

const STATUS_LABEL: Record<StageStatus, string> = {
  waiting: '等待上游',
  running: '进行中',
  done: '完成',
  partial: '部分完成',
  failed: '失败',
  skipped: '跳过',
  pending: '尚未接入',
};

const STATUS_CLASS: Record<StageStatus, string> = {
  waiting: 'bg-muted text-muted-foreground',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  skipped: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  pending: 'bg-muted text-muted-foreground',
};

const BAR_CLASS: Record<StageStatus, string> = {
  waiting: 'bg-muted',
  running: 'bg-sky-500/70',
  done: 'bg-emerald-500/70',
  partial: 'bg-amber-500/70',
  failed: 'bg-rose-500/70',
  skipped: 'bg-amber-500/50',
  pending: 'bg-muted',
};

/** 站号的圈号。超出范围就退回数字，不硬凑。 */
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
function station(order: number): string {
  return CIRCLED[order - 1] ?? String(order);
}

function StatusIcon({ status }: { readonly status: StageStatus }) {
  const cls = 'size-3.5 shrink-0';
  if (status === 'done') return <CheckCircle2 className={`${cls} text-emerald-600`} />;
  if (status === 'failed') return <AlertTriangle className={`${cls} text-rose-600`} />;
  if (status === 'running') return <Loader2 className={`${cls} animate-spin text-sky-600`} />;
  if (status === 'partial' || status === 'skipped' || status === 'pending')
    return <MinusCircle className={`${cls} text-amber-600`} />;
  return <Circle className={`${cls} text-muted-foreground`} />;
}

/**
 * 档位定义：接入表单里管理者用自己的话写的「学习者分几档、每档面向谁」，
 * 由 `intake_routes.py` 原样存进 run 记录的 `options.tier_definitions`。
 *
 * 老 run 没有这个字段（它是 08-16 才加的），所以拿不到就退回按 `tier_range` 数档数——
 * 界面上只出「分几档」这个数，不把 `tier_range` 那个内部档位码印上屏。
 */
type TierDef = { readonly label: string; readonly audience: string };

function readTierDefs(raw: unknown): TierDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { label, audience } = item as Record<string, unknown>;
    return [{ label: String(label ?? ''), audience: String(audience ?? '') }];
  });
}

/** `"L1-L3"` → 3。数的是区间里最大的那个档号，与引擎 `tier_bounds()` 同一条口径。 */
function tierCount(raw: unknown): number {
  const found = String(raw ?? '').match(/\d+/g);
  return found ? Math.max(...found.map(Number)) : 0;
}

function ms(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

/** 事件时间相对 run 起点的偏移，秒。 */
function offset(ts: number, start: number | null): string {
  return start === null ? '' : `+${(ts - start).toFixed(3)}s`;
}

// ── detail 渲染：事件里有什么就显示什么 ──────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
  accepted_files: '收进文件',
  accepted_chars: '正文字符',
  rejected: '退回',
  license: '许可',
  spdx: '许可标识',
  evidence: '判据',
  unknown: '未找到声明',
  sections: '切出节',
  chunks: '证据块',
  index_path: '索引文件',
  sample_chunk: '样本块',
  concept_tags: '概念标签',
  backend: '检索后端',
  probe_query: '样本查询',
  probe_hits: '命中',
  probe_top_score: '首条得分',
  probe_warning: '检索告警',
  path: '产物',
  rows: '向量条数',
  dim: '维度',
  readiness_path: '就绪度报告',
  concepts: '概念词表',
  prereq_clauses: '前置边（节级）',
  human_signoff_required: '待人工签核',
  vocabulary_note: '词表说明',
  gold_dir: '金标目录',
  topics: '主题',
  knowledge_components: '知识点',
  dropped_topics: '因知识点不足丢弃的主题',
  frozen_at: '冻结时间',
  // ⑥ 试跑课程
  course_title: '试跑课题',
  gold_topic: '金标主题',
  courses: '产出档位数',
  scenes: '产出屏数',
  planned_scenes: '计划屏数',
  failures: '生成失败',
  budget_halt: '预算闸',
  paths: '课程产物',
  sample_note: '口径声明',
  cost: '成本计量',
  llm_calls: '模型调用',
  input_tokens: '输入 token',
  output_tokens: '输出 token',
  engine_tokens: '引擎侧 token',
  total_tokens: 'token 合计',
  budget_tokens: 'token 预算',
  // ⑦ 指标复测
  hallucination: '幻觉抽检',
  coverage: '覆盖复测',
  personalization: '个性化跟随',
  claims_checked: '受检断言',
  supported: '判为有据',
  incorrect: '判为有误',
  uncertain: '判为存疑',
  supported_rate: '有据占比',
  judge_evidence_pool: '判官资料块',
  judge_evidence_from_new_corpus: '其中出自新库',
  sample_claims: '断言样例',
  claim: '断言',
  verdict: '判定',
  sourceIds: '引用来源',
  gold_total: '金标知识点总数',
  frozen_gold: '冻结金标',
  per_tier: '分档',
  hits: '讲到',
  mentions_only: '仅提及',
  missed: '未讲到',
  comparable: '可对比',
  reason: '原因',
  differing_dimensions: '有差异的维度',
  differences: '差异逐条',
  examples: '差异例',
  dimension: '维度',
  observation: '观察到',
  because: '归因',
  blind_tier_judge: '盲评判档',
  ran: '已跑',
  hit: '命中',
  total: '总数',
  scene: '屏',
  truth: '实际档位',
  guess: '判官判的档位',
  error: '出错',
};

/**
 * 档位名（引擎 `TRIAL_TIERS` 里的 label）。它在 detail 里两种身份都出现：
 * ⑥ 的 `paths`、⑦ 的 `per_tier` 拿它当键，⑦ 盲评的 `truth` / `guess` 拿它当值。
 * 所以键和值两条路都要过一遍，否则总有一边裸英文上屏。
 */
const TIER_LABEL: Record<string, string> = {
  beginner: '入门档',
  advanced: '进阶档',
};

/**
 * `rows` 在两处出现且含义不同：向量旁路站是条数（数字），盲评判档是逐条记录（数组）。
 * 一张扁平表盖不住，按值的形状分一次——只此一例，不为它开第二张表。
 */
function labelOf(key: string, value?: unknown): string {
  if (key === 'rows') return Array.isArray(value) ? '逐条' : '向量条数';
  return FIELD_LABEL[key] ?? TIER_LABEL[key] ?? key;
}

/** 值侧的同一张表。非档位值原样返回。 */
function textOf(value: unknown): string {
  const text = String(value);
  return TIER_LABEL[text] ?? text;
}

function isPathish(key: string, value: string): boolean {
  return /path|dir|_at$/.test(key) || value.includes('/');
}

function Value({ field, value }: { readonly field: string; readonly value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground">无</span>;
  }
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value}</span>;
  if (typeof value === 'string') {
    const text = textOf(value);
    return (
      <span className={isPathish(field, value) ? 'break-all font-mono text-[10px]' : ''}>
        {text.length > 240 ? `${text.slice(0, 240)}…` : text}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground">0 条</span>;
    return (
      <ul className="space-y-0.5">
        {value.map((item, i) => (
          <li key={i}>
            {item !== null && typeof item === 'object'
              ? Object.entries(item as Record<string, unknown>)
                  .map(([k, v]) => `${labelOf(k, v)} ${textOf(v)}`)
                  .join(' · ')
              : textOf(item)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <dl className="space-y-0.5">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className="flex gap-1.5">
          <dt className="shrink-0 text-muted-foreground">{labelOf(k, v)}</dt>
          <dd className="min-w-0">
            <Value field={k} value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * ② 站切出的块数低于这个数就提醒一句。**经验值，不是硬标准**：
 * 接地闸本身只要求每次检索至少 2 块，卡住试跑的不是闸而是供给——
 * 实测 6 块的库试跑因证据不足接不住，12 块的库跑完了全链。
 */
const THIN_CORPUS_CHUNKS = 12;

function StageCard({ stage }: { readonly stage: StageView }) {
  const signoff = stage.detail?.human_signoff_required === true;
  const entries = Object.entries(stage.detail ?? {});
  const chunks = stage.id === 'chunk' ? stage.detail?.chunks : undefined;
  const thin = typeof chunks === 'number' && stage.status === 'done' && chunks < THIN_CORPUS_CHUNKS;
  return (
    <section
      data-testid="intake-run-stage"
      className="rounded-2xl border border-border bg-card p-4 shadow-card"
    >
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-sm font-medium">
          <span className="mr-1 text-muted-foreground">{station(stage.order)}</span>
          {stage.label}
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASS[stage.status]}`}
        >
          {STATUS_LABEL[stage.status]}
        </span>
        {ms(stage.durationMs) && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {ms(stage.durationMs)}
          </span>
        )}
        {stage.overlaps.length > 0 && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] text-purple-800 dark:bg-purple-900/40 dark:text-purple-200">
            与另外 {stage.overlaps.length} 站同时在跑
          </span>
        )}
      </header>

      {signoff && (
        <p className="mb-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          前置图待人工签核。这一站抽出的前置关系由模型判定，签字之前一律只作软前置——
          用来给未掌握的教材块排序，不当硬性先修条件。
        </p>
      )}

      {thin && (
        <p className="mb-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          证据块偏少（{String(chunks)} 块），试跑大概率因证据不足而无法接地。
          {THIN_CORPUS_CHUNKS} 块是经验值不是硬标准：实测 6 块的库接不住、
          {THIN_CORPUS_CHUNKS} 块的库跑完了全链。要跑 ⑥⑦ 的话先把素材加厚。
        </p>
      )}

      {stage.status === 'failed' && stage.error && (
        <p className="mb-2 rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-900 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-200">
          {stage.error}
        </p>
      )}

      {(stage.status === 'skipped' || stage.status === 'pending') && stage.message && (
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{stage.message}</p>
      )}

      {stage.progress.length > 0 && (
        <ul className="mb-2 space-y-1 border-l border-border/70 pl-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {stage.progress.map((p) => (
            <li key={p.seq}>{p.message}</li>
          ))}
        </ul>
      )}

      {entries.length > 0 && (
        <dl className="space-y-1 text-[11px] leading-relaxed">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">{labelOf(key, value)}</dt>
              <dd className="min-w-0 flex-1">
                <Value field={key} value={value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// ── 泳道 ───────────────────────────────────────────────────────────────────

function Lane({
  stage,
  start,
  span,
}: {
  readonly stage: StageView;
  readonly start: number | null;
  readonly span: number;
}) {
  const geometry =
    stage.startTs !== null && start !== null && span > 0
      ? {
          left: `${((stage.startTs - start) / span) * 100}%`,
          width: `${Math.max((((stage.endTs ?? stage.startTs) - stage.startTs) / span) * 100, 1.5)}%`,
        }
      : null;
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex w-52 shrink-0 items-center gap-1.5">
        <StatusIcon status={stage.status} />
        <span className="text-[11px] text-muted-foreground">{station(stage.order)}</span>
        <span className="truncate text-xs">{stage.label}</span>
      </div>
      <div className="relative h-4 flex-1 rounded bg-muted/50">
        {geometry && (
          <div
            className={`absolute inset-y-0 rounded ${BAR_CLASS[stage.status]}`}
            style={geometry}
            title={`${stage.label} ${ms(stage.durationMs) ?? ''}`}
          />
        )}
        {!geometry && (
          <span className="absolute inset-y-0 left-2 flex items-center text-[10px] text-muted-foreground">
            {STATUS_LABEL[stage.status]}
          </span>
        )}
      </div>
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {ms(stage.durationMs) ?? ''}
      </span>
    </div>
  );
}

// ── 主件 ───────────────────────────────────────────────────────────────────

export function IntakeRunView({
  record: initialRecord,
  events: initialEvents,
}: {
  readonly record: IntakeRunRecord;
  readonly events: IntakeEvent[];
}) {
  const [record, setRecord] = useState(initialRecord);
  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState<number | null>(null); // null = 钉在末尾（直播 / 看完整结果）
  const [replaying, setReplaying] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const nextSeq = useRef(
    initialEvents.length ? initialEvents[initialEvents.length - 1].seq + 1 : 0,
  );

  const live = record.status === 'running';
  const shown = cursor ?? events.length;
  const view = useMemo(() => deriveView(record, events, shown), [record, events, shown]);

  // 直播：轮询增量。run 不再是 running 就停——事件已经全在盘上，再轮询也拿不到新的。
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const resp = await fetch(
          `/api/knowledge/intake-runs/${record.run_id}/events?since=${nextSeq.current}`,
          { cache: 'no-store' },
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as {
          events?: IntakeEvent[];
          nextSeq?: number;
          record?: IntakeRunRecord;
        };
        if (cancelled) return;
        setPollError(null);
        if (data.events?.length) {
          nextSeq.current = data.nextSeq ?? nextSeq.current;
          setEvents((prev) => [...prev, ...(data.events ?? [])]);
        }
        // run.json 每次事件落盘时都被重写，跟着一起换：每站的 duration_ms 只有它有。
        if (data.record) setRecord(data.record);
      } catch (err) {
        if (!cancelled) setPollError(String(err));
      }
    };
    const timer = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, record.run_id]);

  // 回放：游标一条一条往前走。到末尾自停。
  useEffect(() => {
    if (!replaying) return;
    const timer = setInterval(() => {
      setCursor((prev) => {
        const next = (prev ?? 0) + 1;
        if (next >= events.length) {
          setReplaying(false);
          return events.length;
        }
        return next;
      });
    }, REPLAY_MS);
    return () => clearInterval(timer);
  }, [replaying, events.length]);

  const startReplay = useCallback(() => {
    setCursor(0);
    setReplaying(true);
  }, []);

  const span = view.startTs !== null && view.endTs !== null ? view.endTs - view.startTs : 0;
  const finale = view.finale;
  const cleaned = (finale?.cleaned as string[] | undefined) ?? [];
  const parallel = view.stages.filter((s) => s.overlaps.length > 0);
  const options = record.options ?? {};
  const tierDefs = readTierDefs(options.tier_definitions);

  return (
    <div className="space-y-8">
      {/* run 头：状态、口径、失败原因 */}
      <section
        className={`rounded-2xl border p-5 shadow-card ${
          view.runStatus === 'failed'
            ? 'border-rose-300/70 bg-rose-50/60 dark:border-rose-800/60 dark:bg-rose-950/30'
            : 'border-border bg-card'
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2
            className={
              hasDomainLabel(record.corpus)
                ? 'text-base font-semibold'
                : 'font-mono text-base font-semibold'
            }
          >
            {domainLabel(record.corpus)}
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              view.runStatus === 'queued'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                : STATUS_CLASS[
                    (view.runStatus === 'running' ? 'running' : view.runStatus) as StageStatus
                  ]
            }`}
          >
            {view.runStatus === 'queued'
              ? '排队中'
              : view.runStatus === 'running'
                ? '进行中'
                : view.runStatus === 'done'
                  ? '完成'
                  : '失败'}
          </span>
          {view.runStatus === 'queued' && view.queueNote && (
            <span className="text-[11px] text-amber-700 dark:text-amber-300">{view.queueNote}</span>
          )}
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {record.files.length} 个文件
            {ms(view.runMs) && ` · 墙钟 ${ms(view.runMs)}`}
          </span>
        </div>
        {record.scope && <p className="mt-1 text-sm text-muted-foreground">{record.scope}</p>}
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/80">{record.corpus} · {record.run_id}</p>

        <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            学习者分 {tierDefs.length || tierCount(options.tier_range)} 档
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            向量索引 {options.build_vector ? '开' : '关'}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            概念抽取 {options.extract_concepts ? '开' : '关'}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            试跑体检 {options.trial_run ? '开' : '关'}
          </span>
        </div>

        {tierDefs.length > 0 && (
          <dl className="mt-3 space-y-1 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed">
            {tierDefs.map((t, i) => (
              <div key={i} className="flex gap-2">
                <dt className="shrink-0 font-medium">
                  第 {i + 1} 档{t.label && `「${t.label}」`}
                </dt>
                <dd className="text-muted-foreground">{t.audience || '（没填）'}</dd>
              </div>
            ))}
          </dl>
        )}

        {view.runStatus === 'failed' && (
          <div className="mt-3 rounded-lg border border-rose-300/70 bg-white/70 px-3 py-2 text-xs leading-relaxed dark:border-rose-800/60 dark:bg-black/20">
            <p className="font-medium text-rose-800 dark:text-rose-200">
              卡在 {view.stages.find((s) => s.status === 'failed')?.label ?? '未知站'}：
              {record.error || String(finale?.error ?? '') || '（原因未记录）'}
            </p>
            <p className="mt-1 text-muted-foreground">
              {cleaned.length > 0
                ? `已清掉这次建的半成品：${cleaned.join('、')}`
                : '没有需要清理的半成品——失败发生在动盘之前，磁盘上没留下这个库。'}
            </p>
          </div>
        )}

        {record.warnings?.length > 0 && (
          <ul className="mt-3 space-y-1 text-[11px] text-amber-700 dark:text-amber-300">
            {record.warnings.map((w) => (
              <li key={w}>旁路告警：{w}</li>
            ))}
          </ul>
        )}

        {pollError && (
          <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-300">
            事件拉取暂时失败（{pollError}），下一轮会重试；已经拿到的事件不受影响。
          </p>
        )}
      </section>

      {/* 泳道 */}
      <section>
        <h2 className="mb-1 text-sm font-medium">流水线</h2>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          按依赖波次分组：同一波里的站互不依赖，编排器同时发车。时间条共用一根时间轴， 左端是 run
          起点、右端是最后一条事件——条子在横向上重叠，就是那几站真的同时在跑。
          {parallel.length > 0 && `本次有 ${parallel.length} 站的运行区间与别的站重叠。`}
          {view.stageMsTotal > 0 && view.runMs !== null && (
            <>
              {' '}
              各站耗时合计 {ms(view.stageMsTotal)}，run 墙钟 {ms(view.runMs)}
              {view.stageMsTotal > view.runMs && '（合计大于墙钟，差额就是并行叠掉的部分）'}。
            </>
          )}
        </p>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
          {view.waves.map((group) => (
            <div key={group.wave} className="border-b border-border/60 py-2 last:border-b-0">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                第 {group.wave + 1} 波 · {group.stages.length} 站
                {/* 「并行」只在这一波真有两站跑起来时才写。同一波但都被跳过的，
                    互不依赖是事实、并行不是——不给没发生的事贴标签。 */}
                {group.stages.filter((s) => s.startTs !== null).length > 1 && '（并行）'}
              </p>
              {group.stages.map((s) => (
                <Lane key={s.id} stage={s} start={view.startTs} span={span} />
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* 每站实数 */}
      <section>
        <h2 className="mb-1 text-sm font-medium">每站产出</h2>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          一站一张卡，字段取自这次 run 的事件 detail。
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {view.stages.map((s) => (
            <StageCard key={s.id} stage={s} />
          ))}
        </div>
      </section>

      {/* 产物 */}
      {Object.keys(record.products ?? {}).length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium">落盘产物</h2>
          <ul className="space-y-1 rounded-2xl border border-border bg-card p-4 font-mono text-[10px] shadow-card">
            {Object.entries(record.products).map(([key, value]) => (
              <li key={key} className="break-all">
                <span className="mr-2 font-sans text-muted-foreground">{key}</span>
                {value}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 第三段：库建成后直接发起这个领域的第一门课。
          三段串成一条时间线——七站建库、⑧站个性化注册、这里出第一课，
          管理者不换页就能看全程（用户定的「饮料机能工作 + 工作被看见」两件平级交付物）。 */}
      {record.status === 'done' && (
        <FirstCourseLauncher corpus={record.corpus} scope={record.scope || undefined} />
      )}

      {/* 事件流 + 回放 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">事件流</h2>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {shown} / {events.length} 条
          </span>
          {!live && events.length > 0 && (
            <>
              <button
                type="button"
                onClick={replaying ? () => setReplaying(false) : startReplay}
                className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] transition-colors hover:bg-accent"
              >
                {replaying ? <Pause className="size-3" /> : <Play className="size-3" />}
                {replaying ? '暂停' : '回放'}
              </button>
              <input
                type="range"
                min={0}
                max={events.length}
                value={shown}
                onChange={(e) => {
                  setReplaying(false);
                  setCursor(Number(e.target.value));
                }}
                aria-label="回放进度"
                className="h-1 w-40 accent-purple-500"
              />
              {cursor !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setReplaying(false);
                    setCursor(null);
                  }}
                  className="text-[11px] text-muted-foreground underline underline-offset-2"
                >
                  回到最终态
                </button>
              )}
            </>
          )}
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          回放读的是这次 run 落盘的全量事件，按事件顺序等速重演（不按真实时长——一次 run 的
          相邻事件常常只差几毫秒）。上面的泳道与每站产出跟着游标一起回到当时的样子。
        </p>
        <ol
          data-testid="intake-run-events"
          className="max-h-96 space-y-1 overflow-y-auto rounded-2xl border border-border bg-card p-4 font-mono text-[11px] leading-relaxed shadow-card"
        >
          {events.slice(0, shown).map((e) => (
            <li key={e.seq} className="flex gap-2">
              <span className="w-8 shrink-0 tabular-nums text-muted-foreground">{e.seq}</span>
              <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                {offset(e.ts, view.startTs)}
              </span>
              <span className="w-20 shrink-0 truncate text-muted-foreground">{e.stage}</span>
              <span className="min-w-0 flex-1 break-words font-sans">{e.message}</span>
            </li>
          ))}
          {shown === 0 && <li className="text-muted-foreground">（游标在起点，还没有事件）</li>}
        </ol>
      </section>
    </div>
  );
}
