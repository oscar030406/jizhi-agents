'use client';

/**
 * 岗位技能地图 · 企业内训与转岗培训入口 (/skills)
 *
 * The industry-extension face of the system: a training manager picks the job
 * their people are moving into, sees which of its skills the controlled
 * knowledge base can actually ground, and turns any skill into a course with
 * one click (the topic is dropped into the home page's requirement draft).
 *
 * Data discipline — three real sources, nothing else:
 *   1. `data/jobs/job_skill_map.json` (engine): job list, skill inventory and
 *      `market_stats` from the recruitment-dataset study (docs/job_market_research.md).
 *   2. The controlled knowledge base: a skill counts as covered only when
 *      retrieval returns a chunk above the engine's threshold, and the matching
 *      `source_id` is shown so the claim can be checked.
 *   3. The on-disk state of each domain corpus.
 * A domain with no corpus is labelled 尚未建设 with the path where it would
 * live — never padded with AI material. This page never falls back to sample
 * numbers.
 *
 * 取数顺序（引擎冷启动 ~60s、下线即挂，公共页不该等它）：
 *   1. `public/skill-map.json` —— 部署前用 scripts/generate-skill-map-snapshot.mjs
 *      从引擎同一个端点取回落盘的快照，秒开，与引擎在不在线无关；
 *   2. 再后台请求 `/api/skills`，引擎在线就换成实时数据，请求失败就静默保持快照。
 * 快照数据在角落标出生成时间。两条路返回同一形状，渲染代码只有一份。
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  Briefcase,
  ChevronDown,
  Database,
  GraduationCap,
  Loader2,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SiteHeader } from '@/components/site-header';
import {
  JOB_MAP_CORPUS,
  PracticeCard,
  projectsForJob,
  type PracticeProject,
} from '@/components/skills/practice-projects';
import { cn } from '@/lib/utils';
import { REQUIREMENT_DRAFT_KEY } from '@/lib/hooks/use-draft-cache';
import { conceptLabel } from '@/lib/knowledge/concept-labels';
import { corpusOf, domainLabel } from '@/lib/generation/learner-profile';
import { loadLearnerProfile } from '@/components/generation/learner-profile-popover';
import { ForeignDomainEmpty } from '@/components/skills/foreign-domain-empty';
import type { CorpusStatus, JobSkills, SkillCoverage } from '@/app/api/skills/route';

/** Shape of `market_stats` in data/jobs/job_skill_map.json. Every field optional:
 *  a tile renders only when its number is really there. */
interface MarketStats {
  sample?: string;
  demand_trend_share_of_ai_jobs?: Record<string, number>;
  yoy_burst?: string;
  education?: Record<string, number>;
  experience?: Record<string, number>;
  salary_monthly_mid_median?: number;
  skill_mention_share?: Record<string, number>;
  title_buckets?: Record<string, number>;
}

interface Provenance {
  generated_at?: string;
  method?: string;
  market_data_source?: string;
  sources?: string[];
}

interface SkillMapData {
  provenance?: Provenance;
  market_stats?: MarketStats;
  jobs: JobSkills[];
  corpora: CorpusStatus[];
  coverage_rule?: string;
  /** 这份图谱属于哪个领域（引擎按请求的域回带）。 */
  domain?: string;
  /** 该领域没有岗位数据时引擎给的原文说明，直接显示给学习者，不改写。 */
  reason?: string;
  /** 引擎当前不可达、接口给的是 app/api/skills/route.ts 里最后一次成功读取的数据时，
   *  由接口带回那次读取的时间。 */
  stale_from?: string;
  /** public/skill-map.json 的生成时间（scripts/generate-skill-map-snapshot.mjs 写入）。 */
  snapshot_at?: string;
  /** 取回时算的：这份数据是不是已经旧到该提示了。渲染期不许读时钟（react-hooks/purity），
   *  所以在 `loadSkillMap` 里判一次带上来。 */
  stale?: boolean;
}

/** 快照多久算旧。判据口径本身会随引擎变（08-21 换过一次），两周没重新落盘就该提示。 */
const SNAPSHOT_STALE_MS = 14 * 24 * 3600 * 1000;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'ok'; data: SkillMapData };

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 静态快照的位置（scripts/generate-skill-map-snapshot.mjs 的产物）。 */
const SNAPSHOT_URL = '/skill-map.json';

/** 取一份技能地图数据；任何失败都返回 null，由调用方决定退到哪一路。 */
async function loadSkillMap(url: string): Promise<SkillMapData | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as SkillMapData;
    // 空 jobs + reason 是引擎的正式答案（该域未登记岗位数据），必须放行——
    // 当"没取到"退回快照，屏幕上就又是主域的 AI 岗位了。
    if (!data || (!data.jobs?.length && !data.reason)) return null;
    const asOf = data.snapshot_at ?? data.stale_from;
    data.stale = asOf ? Date.now() - Date.parse(asOf) > SNAPSHOT_STALE_MS : false;
    return data;
  } catch {
    return null;
  }
}

// focus 环，口径见 app/path/page.tsx 同名常量：--ring 带 alpha，实测 1.26:1 看不见，
// 借满不透明度的中性蓝 chart-2 顶上（亮 3.76 / 暗 4.77）。--ring 修好后三处一起换回。
const FOCUS_RING =
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chart-2';

// ─────────────────────────────────────────────────────────────────────────────
// Presentational helpers (mirrors /report so the two pages read as one system)
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed">{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function StatTile({
  icon: Icon,
  value,
  label,
  note,
}: {
  icon: React.ElementType;
  value: string;
  label: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{note}</div>
    </div>
  );
}

/** Horizontal share bars — pure SVG-free flexbox, no chart dependency. */
function ShareBars({ data, highlight }: { data: Record<string, number>; highlight?: string[] }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(([, v]) => v), 0.0001);
  return (
    <div className="space-y-1.5">
      {rows.map(([key, value]) => (
        // 窄屏让技能名独占一行（w-full 触发换行），条子与百分比落到第二行。
        // 375px 视口下卡片内容只有 295px，技能名占 160px 后条子只剩 71px，
        // 而「LangChain / LangGraph 等编排框架」这种名字仍会被 truncate 掉尾巴。
        <div key={key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {/* 键是引擎概念 id（`agent_basics` 这种），过一遍概念中文名的单一真源；
              表里没有的（`python`、`finetune(课程仅理论)`）按约定原样出。 */}
          <span
            className="w-full shrink-0 truncate text-muted-foreground sm:w-40"
            title={conceptLabel(key)}
          >
            {conceptLabel(key)}
          </span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
            {/* 条子颜色实测：原来的 blue-500/60 在亮色卡片上只有 2.1:1、emerald-500/70 只有
                1.95:1，达不到 1.4.11 的 3:1。换成 chart-2（亮 3.76 / 暗 4.77）与
                green-solid（规格 2.2 指定的进度达成绿，亮 3.5 / 暗 5.23）。 */}
            <span
              className={cn(
                'block h-full rounded-full',
                highlight?.includes(key) ? 'bg-green-solid' : 'bg-chart-2',
              )}
              style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
            />
          </span>
          <span className="w-12 shrink-0 text-right tabular-nums text-foreground">{pct(value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Demand trend — hand-drawn SVG columns (no chart library, per project rule). */
function TrendChart({ data }: { data: Record<string, number> }) {
  const rows = Object.entries(data).sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(...rows.map(([, v]) => v), 0.0001);
  // 柱宽/间距按 12px 轴标签的实际占位定：「2025(1-7月)」在 12px 下约 73px，
  // 列距（w+gap）必须比它宽，否则相邻年份的标签会粘在一起
  const w = 60;
  const gap = 28;
  const h = 96;
  const width = rows.length * w + (rows.length - 1) * gap;
  return (
    <div className="overflow-x-auto pb-1">
      <svg
        viewBox={`0 0 ${width} ${h + 36}`}
        width={width}
        height={h + 36}
        role="img"
        aria-label="大模型相关岗位占 AI 招聘集的比例趋势"
      >
        {rows.map(([year, value], i) => {
          const x = i * (w + gap);
          const barH = Math.max(2, (value / max) * h);
          return (
            <g key={year}>
              {/* 柱色实测：原来的 #3b82f6 + opacity .7 在亮色卡片上只有 2.43:1，
                  换成 chart-2 满不透明（亮 3.76 / 暗 4.77），两个主题都过 3:1 */}
              <rect x={x} y={h - barH} width={w} height={barH} rx={4} className="fill-chart-2" />
              <text x={x + w / 2} y={h - barH - 6} textAnchor="middle" fontSize={12} className="fill-foreground tabular-nums">
                {pct(value)}
              </text>
              <text x={x + w / 2} y={h + 18} textAnchor="middle" fontSize={12} className="fill-muted-foreground tabular-nums">
                {year.replace('_partial', '(1-7月)')}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 岗位卡
// ─────────────────────────────────────────────────────────────────────────────

function JobCard({
  job,
  open,
  onToggle,
  onPickSkill,
  courseTitles,
}: {
  job: JobSkills;
  open: boolean;
  onToggle: () => void;
  onPickSkill: (job: JobSkills, skill: SkillCoverage) => void;
  courseTitles: Record<string, string>;
}) {
  const total = job.skills.length;
  const ratio = total ? job.covered_count / total : 0;
  return (
    <div className="rounded-lg border border-border/70">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
          'hover:bg-muted/40 active:bg-muted/60',
          FOCUS_RING,
        )}
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          {/* 窄屏让岗位名独占一行：375px 下这一行只有 271px，徽标定宽 100px 出头，
              留给「大模型推理与部署工程师」的位置不够，会被 truncate 掉尾巴 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-sm font-medium">{job.title}</span>
            <span className="shrink-0 rounded-full border border-border px-2 py-px text-xs tabular-nums text-muted-foreground">
              知识库可接地 {job.covered_count}/{total}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {job.summary}
          </p>
          {/* 进度条实测：emerald-500/70 在亮色卡片上只有 1.95:1，换成规格 2.2 的
              进度达成绿 green-solid（亮 3.5 / 暗 5.23），条本身也是唯一的量化通道，
              所以同时把数字写进 aria-label */}
          <span
            className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`知识库可接地 ${job.covered_count} / ${total} 项技能`}
          >
            <span
              className="block h-full rounded-full bg-green-solid"
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </span>
        </div>
        <ChevronDown
          className={cn(
            'mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="space-y-1 border-t border-border/70 px-3 py-2.5">
          {/* 实践项目区（learning-path-practice-spec §2.3）：站外真项目策展，
              一岗 ≤3 张按层级排序；学完课去练，做完有作品 */}
          {projectsForJob(job.job_id).length > 0 && (
            <div className="mb-4 space-y-2">
              <p className="px-1 text-xs font-medium text-muted-foreground">
                实践项目 · 学完课去练，做完有作品
              </p>
              {projectsForJob(job.job_id).map((p) => (
                <PracticeCard key={p.id} project={p} courseTitles={courseTitles} />
              ))}
            </div>
          )}
          {job.skills.map((s) => (
            <button
              key={s.skill}
              type="button"
              onClick={() => onPickSkill(job, s)}
              title={
                s.covered
                  ? `知识库命中 ${s.source_title}（${s.source_id}，相似度 ${s.score}）— 点击按此技能造课`
                  : `知识库未检索到可用证据（最高相似度 ${s.score}）— 仍可造课，但内容不接地，课堂徽标会显示未接地`
              }
              className={cn(
                'group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
                'hover:bg-muted/60 active:bg-muted',
                FOCUS_RING,
              )}
            >
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  s.covered ? 'bg-green-solid' : 'bg-muted-foreground/50',
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs">{s.skill}</span>
              <span
                className={cn(
                  'shrink-0 text-xs tabular-nums',
                  // 「可接地」这一档原来是 emerald-600/400，亮色下实测 3.77:1，不到正文
                  // 要求的 4.5:1。换成 green-deep（亮 6.85 / 暗 9.91）——green-solid
                  // 只有 3.43，够当色块不够当文字。
                  s.covered ? 'text-green-deep' : 'text-muted-foreground',
                )}
              >
                {s.covered ? s.source_id : '暂无语料'}
              </span>
              {/* 箭头原来只在 hover 出现，键盘用户永远看不到 */}
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function SkillsPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** 画像选定的知识库。岗位图谱是 JOB_MAP_CORPUS 专有数据（几十 GB 招聘数据集 +
   *  人工提炼），别的领域摆它只会误导学习方向——外域岗位区换空态。
   *  外域的实操项目则有自己的供给线：管理端 GitHub 实搜起草、审核发布后这里可见。
   *
   *  取域走 `corpusOf`（检索/判官/诊断三路共用的口径：显式选的库优先、缺了看培训领域）。
   *  原来直接读 `.corpus`，画像只选了培训领域没单独选库时拿到空串，于是学智能制造的人
   *  被判成"非外域"，照样看整张 AI 岗位图谱。
   *  null = 还没读到画像（localStorage 只能在客户端读），此时先不发请求，
   *  免得先按空域问一遍引擎再按真域重问。 */
  const [profileCorpus, setProfileCorpus] = useState<string | null>(null);
  useEffect(() => {
    setProfileCorpus(corpusOf(loadLearnerProfile()) ?? '');
  }, []);
  const corpus = profileCorpus ?? '';
  /** 外域已发布的实操项目（引擎 practice-scout 真源，管理员审核后才有内容）。 */
  const [domainPractice, setDomainPractice] = useState<PracticeProject[]>([]);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 项目卡「相关课程」的课名。课程边（courseIds）在 data/practice-projects.json 里，
  // 课名只在 data/classrooms/ 的课文件里——本页是客户端组件读不到磁盘，
  // 走本站 /api/classroom（读盘，与引擎无关）取一次清单。取不到就不渲染那一行，
  // 项目卡其余部分照旧，不显示裸课程 id。
  const [courseTitles, setCourseTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/classroom');
        if (!res.ok) return;
        const body = (await res.json()) as { classrooms?: Array<{ id: string; title: string }> };
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const c of body.classrooms ?? []) map[c.id] = c.title;
        setCourseTitles(map);
      } catch {
        /* 读不到课名就保持空表：「相关课程」整行不渲染 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 重新读取时不回到 loading：屏幕上已有的数据留着，取回新的再换，中间不闪空屏。
  useEffect(() => {
    if (profileCorpus === null) return; // 等画像读出来再取，见 profileCorpus 的注释
    let cancelled = false;
    (async () => {
      // 快照先上屏：与引擎在不在线无关，不等它。
      const snapshot = await loadSkillMap(SNAPSHOT_URL);
      if (cancelled) return;
      if (snapshot) setState({ kind: 'ok', data: snapshot });
      // 引擎在线就换成实时数据；拿不到就保持快照，不改屏幕上的任何东西。
      // 带上域：外域拿回的是空 jobs + reason，页面据此换空态，不再靠客户端猜。
      const live = await loadSkillMap(`/api/skills?domain=${encodeURIComponent(profileCorpus)}`);
      if (cancelled) return;
      if (live) setState({ kind: 'ok', data: live });
      else if (!snapshot) setState((prev) => (prev.kind === 'ok' ? prev : { kind: 'offline' }));
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, profileCorpus]);

  /** Hand the skill to the home page: write its requirement draft, then navigate. */
  const pickSkill = useCallback(
    (job: JobSkills, skill: SkillCoverage) => {
      const topic =
        `面向「${job.title}」岗位的技能培训课：${skill.skill}。` +
        `学员为转岗/内训背景，请给出讲解、实操与测验。`;
      try {
        localStorage.setItem(REQUIREMENT_DRAFT_KEY, JSON.stringify(topic));
      } catch {
        /* localStorage unavailable — the home page still opens, just unfilled */
      }
      router.push('/');
    },
    [router],
  );

  const data = state.kind === 'ok' ? state.data : null;
  const market = data?.market_stats ?? {};
  const prov = data?.provenance ?? {};
  const exp = market.experience ?? {};
  const juniorShare = (exp['1-3年'] ?? 0) + (exp['经验不限'] ?? 0);
  // 屏幕上这份数是哪一刻的：快照有生成时间，接口的兜底数据有读取时间，实时数据两者都没有。
  const asOf = data?.snapshot_at ?? data?.stale_from ?? null;
  // 快照是部署时落盘的。放着不提示，引擎离线时访客看到的就是一份没人知道有多旧的图谱。
  const asOfStale = Boolean(asOf && data?.stale);

  // 空态判据以服务端为准：引擎说这个域没有岗位数据（jobs 空 + reason），就是没有。
  // 客户端那句只当降级——引擎还没答上来的头几百毫秒里，别让主域快照先糊到外域学员脸上。
  const serverEmpty = Boolean(data && !data.jobs?.length && data.reason);
  const clientForeign = Boolean(corpus) && corpus !== JOB_MAP_CORPUS;
  const foreignDomain = serverEmpty || clientForeign;

  useEffect(() => {
    if (!foreignDomain) {
      setDomainPractice([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/practice-scout/${encodeURIComponent(corpus)}`);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setDomainPractice((body?.projects ?? []) as PracticeProject[]);
      } catch {
        // 引擎不在线就当没有——空态照常，不报错
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [foreignDomain, corpus]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* 共享极简顶栏：返回 + 语言 + 主题（components/site-header.tsx） */}
      <SiteHeader localized={false} maxWidth="max-w-5xl" />
      {/* 区块间距 24px、区块内最大 16px：相邻层级差 1.5 倍以上，分组才读得出来 */}
      <div className="mx-auto max-w-5xl space-y-6 px-4 pb-24 pt-6 sm:px-6">
        {/* 非 AI 域：整页换空态主体（见 ForeignDomainEmpty 的注释）。
            原来是「一条注记 + 照常展示整张 AI 图谱」——注记会被略过，图谱不会。 */}
        {/* header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              岗位技能地图 · 企业内训与转岗培训
            </h1>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              数据来源：引擎的岗位技能清单与招聘数据统计、受控知识库的检索结果、各领域语料库的当前状态。
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              <RefreshCw className="size-3.5" />
              重新读取
            </Button>
            {asOf && (
              <p className="text-xs text-muted-foreground tabular-nums">
                数据截至{' '}
                {new Date(asOf).toLocaleString('zh-CN', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            )}
            {asOfStale && (
              <p className="max-w-xs text-right text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                这份数据可能不是最新的，系统恢复实时读取后会自动更新。
              </p>
            )}
          </div>
        </div>

        {foreignDomain && domainPractice.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-1 text-sm font-medium">「{domainLabel(corpus)}」实操项目</h2>
            <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
              从 GitHub 实时搜索、经管理员逐条审核后发布的真实开源项目。星数、许可、
              链接均来自搜索时的实拉数据。
            </p>
            <div className="space-y-2">
              {domainPractice.map((p) => (
                <PracticeCard key={p.id} project={p} />
              ))}
            </div>
          </section>
        )}
        {foreignDomain && (
          <ForeignDomainEmpty
            label={domainLabel(corpus || data?.domain)}
            reason={serverEmpty ? data?.reason : undefined}
          />
        )}

        {!foreignDomain && state.kind === 'loading' && (
          <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取岗位技能地图…
          </div>
        )}

        {!foreignDomain && state.kind === 'offline' && (
          <EmptyState
            title="岗位技能地图暂时读不到"
            hint="静态快照与多智能体引擎都没有返回数据。点「重新读取」再试一次。"
          />
        )}

        {!foreignDomain && data && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="space-y-6"
          >
            {/* ── 1. 岗位市场事实 ── */}
            <SectionCard
              icon={TrendingUp}
              title="岗位市场事实"
              description={`统计口径：${market.sample ?? '未提供样本口径'}。${
                prov.market_data_source ?? ''
              }`}
            >
              {Object.keys(market).length === 0 ? (
                <EmptyState
                  title="引擎未返回市场统计"
                  hint="引擎数据中没有市场统计字段，本卡片留空。"
                />
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {market.yoy_burst && (
                      <StatTile
                        icon={TrendingUp}
                        // The multiple is read out of the engine's own string —
                        // no number on this page is typed by hand.
                        value={market.yoy_burst.match(/（([^）]+)）/)?.[1] ?? '见下'}
                        label="需求跃迁"
                        note={`${market.yoy_burst}（同一数据集内跨年对比）`}
                      />
                    )}
                    {market.education?.['本科'] !== undefined && (
                      <StatTile
                        icon={GraduationCap}
                        value={pct(market.education['本科'])}
                        label="学历要求 · 本科"
                        note={`硕士 ${pct(market.education['硕士'] ?? 0)}、大专 ${pct(
                          market.education['大专'] ?? 0,
                        )}——门槛落在职业培训可达区间`}
                      />
                    )}
                    {juniorShare > 0 && (
                      <StatTile
                        icon={Briefcase}
                        value={pct(juniorShare)}
                        label="经验要求 ≤3 年 / 不限"
                        note={`1-3年 ${pct(exp['1-3年'] ?? 0)} + 经验不限 ${pct(
                          exp['经验不限'] ?? 0,
                        )}——转岗人群的窗口`}
                      />
                    )}
                    {market.salary_monthly_mid_median !== undefined && (
                      <StatTile
                        icon={Wallet}
                        value={`${(market.salary_monthly_mid_median / 1000).toFixed(1)}k`}
                        label="月薪中位数"
                        note="薪资区间中位数的中位，货币单位：元/月"
                      />
                    )}
                  </div>

                  {market.demand_trend_share_of_ai_jobs && (
                    <div>
                      <p className="mb-2 text-xs font-medium">
                        大模型相关岗位占 AI 招聘集比例（逐年）
                      </p>
                      <TrendChart data={market.demand_trend_share_of_ai_jobs} />
                    </div>
                  )}

                  {market.skill_mention_share && (
                    <div>
                      <p className="mb-2 text-xs font-medium">JD 高频技能提及率</p>
                      <ShareBars data={market.skill_mention_share} />
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        这份技能分布就是下方岗位技能地图与我们概念图的对照基准：
                        课程概念覆盖到的技能项在这里都能找到对应的真实提及率。
                      </p>
                    </div>
                  )}

                  <p className="text-xs leading-relaxed text-muted-foreground">
                    口径、清洗规则与复算脚本见引擎仓库 <code>docs/job_market_research.md</code>
                    （§2 筛选口径、§6 复算）。下方岗位与技能清单另有来源，其提炼方式为：
                    {prov.method ?? '见 job_skill_map.json 的 _provenance'}。
                  </p>
                </div>
              )}
            </SectionCard>

            {/* ── 2. 岗位技能地图 ── */}
            <SectionCard
              icon={Briefcase}
              title="岗位技能地图"
              description={`${data.jobs.length} 个岗位，点开任一岗位可看它的技能项；${
                data.coverage_rule ?? ''
              } 点击任一技能即以它为主题去造课。`}
            >
              {/* 岗位与学习路径的对应关系。路径本身按三个模块递进排（真源
                  data/learning-path.json 的 tracks），岗位是模块组合出来的一层映射，
                  所以这里只用一句话交代，不再单独铺一张岗位轨的图。 */}
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                和学习路径的对应关系：模块一（大模型基础）是所有岗位的共同底座，
                再加模块二（检索与知识工程）对应 RAG 与知识工程岗，
                再加模块三（智能体工程）对应 Agent 应用岗，三个模块都学完对应全栈 AI 应用工程师。
              </p>
              <div className="space-y-2">
                {data.jobs.map((job) => (
                  <JobCard
                    key={job.job_id}
                    job={job}
                    open={openJob === job.job_id}
                    onToggle={() => setOpenJob(openJob === job.job_id ? null : job.job_id)}
                    onPickSkill={pickSkill}
                    courseTitles={courseTitles}
                  />
                ))}
              </div>
              <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50/70 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  「可接地」只表示受控知识库里有可引用的证据（附 source_id
                  可复核），不等于已有成课；标灰的技能照样能造课，只是内容无证据约束，
                  课堂里会显示「未接地」徽标。
                </span>
              </p>
            </SectionCard>

            {/* ── 3. 语料库建设状态 ── */}
            <SectionCard
              icon={Database}
              title="各领域语料库建设状态"
              description="学习者画像里的「培训领域」或「知识库」决定检索用哪个语料库。未建设的领域检索返回空。"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {data.corpora.map((c) => (
                  <div
                    key={c.corpus}
                    className={cn(
                      'rounded-lg border p-3',
                      c.available
                        ? 'border-emerald-400/60 bg-emerald-50/40 dark:border-emerald-700/50 dark:bg-emerald-950/20'
                        : 'border-dashed border-border/70',
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{domainLabel(c.corpus)}</span>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-px text-xs',
                          c.available
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {c.available ? `已建设 · ${c.chunk_count} 条证据块` : '尚未建设'}
                      </span>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {c.index_path}
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {c.available
                        ? '检索、审核与生成的事实边界都取自该语料库。'
                        : '选择该领域生成课程时，检索返回空，课堂徽标显示「未接地」。建设方式：把该领域文档放进上述目录同级的 docs/ 后重建索引并同步到服务。'}
                    </p>
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* ── 4. 怎么用 ── */}
            <SectionCard
              icon={Sparkles}
              title="企业内训 / 转岗培训怎么用"
              description="换语料库即换领域，流程不变——同一套多智能体管线服务不同行业。"
            >
              <ol className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">① 定岗位</span>
                  ：在上面的岗位技能地图里选目标岗位（转岗要去的岗、内训要补的岗），
                  按技能项逐条造课；缺口大的技能优先。
                </li>
                <li>
                  <span className="font-medium text-foreground">② 填画像</span>
                  ：首页右上角「学习者画像」里选培训领域与五维自评。领域决定检索语料库，
                  自评决定难度档、支架深度与类比域——同一技能给不同背景的人会生成不同的课。
                </li>
                <li>
                  <span className="font-medium text-foreground">③ 造课</span>
                  ：检索 Agent 从该领域语料库取证据块 → 生成器只在证据边界内讲 →
                  审核智能体逐条核对断言 → 裁决决定放行/警告/拦截。企业自有 SOP、设备手册、
                  合规文件进语料库后，生成内容就被圈死在企业口径内。
                </li>
                <li>
                  <span className="font-medium text-foreground">④ 换行业</span>
                  ：把该行业语料放进{' '}
                  <code className="font-mono">data/knowledge_base/corpora/&lt;领域&gt;/docs/</code>
                  ，重建索引并同步到服务，画像里选中该领域即可——管线、UI、审核门禁一行不用改。
                  标「尚未建设」的领域缺的只是语料：补上语料、重建索引即可启用，不需要改代码。
                </li>
              </ol>
            </SectionCard>
          </motion.div>
        )}
      </div>
    </div>
  );
}
