'use client';

/**
 * 静态样例学情报告 (/demo/report) —— 未登录可见的证据页。
 *
 * 赛题第 (3) 项点名的三张图（知识盲区定位 / 资源难度匹配 / 学习路径规划）在
 * /report 页读登录用户的本机数据，访客全空。本页读预生成落盘的
 * public/demo-report.json（scripts/generate-demo-report.mjs 从引擎归档真 run
 * 提取，零模型调用），把同样的三张图静态呈现给未登录的评委。
 *
 * 视觉配方与 /report 同源（掌握度方块矩阵 / 难度横条 / 路径步骤），组件是
 * 简化重画——/report 的图表组件闭包在页面文件内部未导出，抽出会动到禁改文件。
 * JSON 404 ⇒ 显示空态说明，不摆占位数据。
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, Info, Target, TrendingUp } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SiteHeader } from '@/components/site-header';
import { conceptLabel } from '@/lib/knowledge/concept-labels';
import { cn } from '@/lib/utils';

/** scripts/generate-demo-report.mjs 落盘结构 */
interface DemoReport {
  profile: { presetId: string; name: string; background: string };
  learningGoal: string;
  diagnosisSummary: string;
  learningRisks: string[];
  masteryVector: Record<string, number>;
  weakConcepts: string[];
  difficultyBand: {
    recommended: string;
    items: Array<{ kind: 'quiz' | 'stage'; label: string; difficulty: string }>;
  };
  learningPath: {
    stages: Array<{
      title: string;
      difficulty: string;
      goals: string[];
      concepts: string[];
      estimatedHours: number | null;
      practiceTask: string;
      assessment: string;
    }>;
    prerequisites: string[];
    estimatedHours: number | null;
  };
  source: { runId: string; archivedAt: string; engines: Record<string, string> };
}

const levelRank = (level: string) => {
  const m = /^L([1-4])$/.exec(level);
  return m ? Number(m[1]) : 2;
};

/** 掌握度四阶紫色，与 /report 的 MasteryMatrix 同配方 */
const MASTERY_TIERS = ['尝试', '熟悉', '掌握', '精通'];
const MASTERY_TIER_BG = [
  'var(--purple-soft)',
  'color-mix(in oklab, var(--primary) 35%, var(--purple-soft))',
  'color-mix(in oklab, var(--primary) 65%, var(--purple-soft))',
  'var(--primary)',
];
const masteryTier = (v: number) => (v < 0.25 ? 0 : v < 0.5 ? 1 : v < 0.75 ? 2 : 3);

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
        <CardTitle className="flex items-center gap-2 text-lg font-medium">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-soft">
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

// ── 图 1：知识盲区定位（掌握度方块矩阵 + 薄弱点清单）─────────────────────────

function BlindSpotSection({ data }: { data: DemoReport }) {
  const entries = Object.entries(data.masteryVector).sort((a, b) => a[1] - b[1]);
  const weak = new Set(data.weakConcepts);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
        {entries.map(([concept, value]) => (
          <div
            key={concept}
            className="flex flex-col items-center gap-1"
            title={`${conceptLabel(concept)}：掌握度 ${value.toFixed(2)} · ${MASTERY_TIERS[masteryTier(value)]}${weak.has(concept) ? '（薄弱）' : ''}`}
          >
            <div
              className="aspect-square w-full rounded-lg"
              style={{ backgroundColor: MASTERY_TIER_BG[masteryTier(value)] }}
            />
            <span
              className={cn(
                'w-full truncate text-center text-xs',
                weak.has(concept) ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {conceptLabel(concept)}
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {value.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>尝试</span>
        {MASTERY_TIER_BG.map((c) => (
          <span key={c} className="size-3 rounded-[4px]" style={{ backgroundColor: c }} />
        ))}
        <span>精通</span>
        <span className="ml-2">色阶为掌握度四档，数据取自该 run 的 mastery_vector</span>
      </div>

      {data.weakConcepts.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-yellow-deep/20 bg-yellow-soft p-4">
          <p className="text-sm font-medium text-yellow-deep">
            引擎判定的知识盲区（weak_concepts）
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {data.weakConcepts.map(conceptLabel).join('、')}——学习路径的补齐顺序据此排定。
          </p>
        </div>
      )}
      {data.learningRisks.length > 0 && (
        <ul className="space-y-1">
          {data.learningRisks.map((r) => (
            <li key={r} className="text-xs leading-relaxed text-muted-foreground">
              · {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 图 2：资源难度匹配（横条：每条资源的难度 vs 推荐难度）───────────────────

function DifficultyMatchSection({ data }: { data: DemoReport }) {
  const rec = levelRank(data.difficultyBand.recommended);
  const items = data.difficultyBand.items;
  if (items.length === 0) return null;
  const matched = items.filter((it) => levelRank(it.difficulty) <= rec).length;
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {items.map((it, i) => {
          const rank = levelRank(it.difficulty);
          const over = rank > rec;
          return (
            <div key={`${it.label}-${i}`} className="flex items-center gap-2">
              <span
                className="w-40 shrink-0 truncate text-xs text-muted-foreground sm:w-56"
                title={it.label}
              >
                {it.kind === 'stage' ? '路径 · ' : ''}
                {it.label}
              </span>
              <div className="flex flex-1 gap-1">
                {[1, 2, 3, 4].map((lv) => (
                  <span
                    key={lv}
                    className="h-2 flex-1 rounded-full"
                    style={{
                      backgroundColor:
                        lv <= rank
                          ? over
                            ? 'var(--yellow-deep)'
                            : 'var(--primary)'
                          : 'var(--muted)',
                    }}
                  />
                ))}
              </div>
              <span
                className={cn(
                  'w-8 shrink-0 text-right text-xs tabular-nums',
                  over ? 'font-medium text-yellow-deep' : 'text-muted-foreground',
                )}
              >
                {it.difficulty}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-full bg-primary" />
          不超过推荐难度 {data.difficultyBand.recommended}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-full bg-yellow-deep" />
          高于推荐难度（进阶阶段刻意抬高）
        </span>
      </div>
      <p className="rounded-md bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">匹配结论：</span>
        推荐难度 {data.difficultyBand.recommended} 来自该 run 的学情诊断；{items.length}{' '}
        条资源（分阶测验题 + 路径阶段）中 {matched} 条落在推荐难度内，难度值全部是引擎当时写进
        run 的原值。
      </p>
    </div>
  );
}

// ── 图 3：学习路径规划（步骤列表）────────────────────────────────────────────

function LearningPathSection({ data }: { data: DemoReport }) {
  const { stages, prerequisites, estimatedHours } = data.learningPath;
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {stages.map((s, i) => (
          <div key={s.title} className="flex gap-3 rounded-xl border border-border/70 p-3.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-purple-soft text-sm font-semibold text-purple-deep">
              {i + 1}
            </span>
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{s.title}</p>
                <span className="rounded-full bg-blue-soft px-2 py-0.5 text-xs font-medium text-blue-deep">
                  {s.difficulty}
                </span>
                {s.estimatedHours !== null && (
                  <span className="text-xs text-muted-foreground">约 {s.estimatedHours}h</span>
                )}
              </div>
              {s.goals.length > 0 && (
                <ul className="space-y-0.5">
                  {s.goals.map((g) => (
                    <li key={g} className="text-xs leading-relaxed text-muted-foreground">
                      · {g}
                    </li>
                  ))}
                </ul>
              )}
              {s.concepts.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  覆盖概念：{s.concepts.map(conceptLabel).join('、')}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="rounded-md bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">路径依据：</span>
        阶段顺序、难度与工时由该 run 的 LearningPathPlannerAgent 产出
        {prerequisites.length > 0 && <>；前置要求：{prerequisites.join('、')}</>}
        {estimatedHours !== null && <>；总预估 {estimatedHours} 小时</>}。
      </p>
    </div>
  );
}

// ── 页面 ─────────────────────────────────────────────────────────────────────

export default function DemoReportPage() {
  const [data, setData] = useState<DemoReport | null | 'missing'>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/demo-report.json');
        if (!res.ok) {
          if (!cancelled) setData('missing');
          return;
        }
        const body = (await res.json()) as DemoReport;
        if (!cancelled) {
          setData(body.masteryVector && body.source?.runId ? body : 'missing');
        }
      } catch {
        if (!cancelled) setData('missing');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader localized={false} maxWidth="max-w-4xl" />
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">样例学情报告</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            知识盲区定位 · 资源难度匹配 · 学习路径规划——多智能体引擎一次真实生成的静态存档。
          </p>
        </div>

        {data === null && (
          <p className="py-12 text-center text-sm text-muted-foreground">正在读取样例数据…</p>
        )}
        {data === 'missing' && (
          <p className="rounded-xl border border-dashed border-border/70 p-8 text-center text-sm leading-relaxed text-muted-foreground">
            样例数据尚未生成。在 apps/classroom 下执行{' '}
            <code className="rounded bg-muted px-1">node scripts/generate-demo-report.mjs</code>{' '}
            即可从引擎归档 run 提取（零模型调用）。
          </p>
        )}

        {data !== null && data !== 'missing' && (
          <>
            {/* 显著说明条：这是真实 run 的静态存档，不是现场为访客算的 */}
            <p className="flex items-start gap-2 rounded-xl border border-blue-deep/20 bg-blue-soft p-4 text-sm leading-relaxed text-blue-deep">
              <Info className="mt-0.5 size-4 shrink-0" />
              <span>
                本页是样例画像「{data.profile.name}」的一次生成记录存档（run{' '}
                <code className="rounded bg-background/60 px-1 text-xs">
                  {data.source.runId.slice(0, 8)}
                </code>
                ，归档于 {data.source.archivedAt.slice(0, 10)}
                ）。登录后这里显示你自己的实时报告。
              </span>
            </p>

            <SectionCard
              icon={Target}
              title="样例画像"
              description="引擎预设画像之一；下面三张图全部由这份画像的一次真实闭环算出。"
            >
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <span className="rounded-full border px-2 py-0.5">
                    画像 · {data.profile.name}
                  </span>
                  <span className="rounded-full border px-2 py-0.5">
                    学习目标 · {data.learningGoal}
                  </span>
                  <span className="rounded-full border px-2 py-0.5">
                    背景 · {data.profile.background}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {data.diagnosisSummary}
                </p>
              </div>
            </SectionCard>

            <SectionCard
              icon={AlertTriangle}
              title="知识盲区定位"
              description="每个概念的掌握度取自该 run 的 mastery_vector；被引擎列入 weak_concepts 的加粗标出。"
            >
              <BlindSpotSection data={data} />
            </SectionCard>

            <SectionCard
              icon={TrendingUp}
              title="资源难度匹配"
              description="把这次生成的每条资源难度与学情诊断给出的推荐难度放在同一标尺上。"
            >
              <DifficultyMatchSection data={data} />
            </SectionCard>

            <SectionCard
              icon={GitBranch}
              title="学习路径规划"
              description="路径规划 Agent 按薄弱点排出的补齐顺序，每阶段带目标、覆盖概念与预估工时。"
            >
              <LearningPathSection data={data} />
            </SectionCard>

            <p className="pb-4 text-center text-xs text-muted-foreground">
              全部字段提取自引擎归档 run {data.source.runId}。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
