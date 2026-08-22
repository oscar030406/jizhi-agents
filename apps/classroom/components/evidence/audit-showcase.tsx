'use client';

/**
 * 区 C「审核抓错的记录」——Grammarly 式纠错卡
 * （公共页规格 docs/03-design/ui/public-site-redesign-20260809.md §3）。
 *
 * 数据源：不新开 API。右侧选择器的抓错数由调用方从课程清单接口的 audit.flagged 透传进来
 * （lib/server/classroom-storage.ts 的 summarizeAudit 已经数好，口径见 countCatches 注释）；
 * 左栏案例只在选中某门课时拉那一门的 GET /api/classroom?id=。
 * 原来是开 6 个并发把 23 门课的完整 JSON（约 3.5MB）全拉回浏览器只为算这个计数，
 * 而且 Promise.all settle 前整区不渲染，用户看空白。
 * 点选切换左栏该课的审核案例；无可展示案例的课显示零打回空态。
 * 单课挑选规则（pickAuditShowcase，纯函数可测）：
 *   1. 优先 verdict === 'revised' / 'flagged' 且有 fix 的场景（原句/改后句能填满）；
 *   2. 没有 → 退到 caveat 场景，标题改「审核智能体提出的保留意见」；
 *   3. 都没有 → 左栏显示该课空态（选择器仍可切走）。
 * 展示字段与 components/stage/scene-audit-badge.tsx 的展开面板同源（claim/reason/fix/debate），
 * 这里只是摘出来平铺，不重新推导任何判定。
 *
 * 展示纪律：模型全名不出现在本区任何位置，按面板顺序称「审核智能体甲/乙/仲裁」；
 * 教材出处 chip 用书名+章节样式（无教材原文数据，不做悬停摘录，不编内容）。
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Gavel } from 'lucide-react';

import { judgeRole, maskJudgeVerdict } from '@/components/agents/judge-labels';
import { CARD_RECIPE_STATIC } from '@/components/home/course-card';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import type { AuditClaim, DebateRound } from '@/lib/generation/hallucination-audit';
import type { Scene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('AuditShowcase');

export interface AuditShowcase {
  kind: 'revised' | 'caveat';
  courseId: string;
  courseTitle: string;
  sceneTitle: string;
  /** 展示行：revised 取带 fix 的断言，caveat 取 uncertain 断言 */
  claims: AuditClaim[];
  debate: DebateRound[];
  judgeModels: string[];
  arbiterModel?: string;
}

interface CourseLike {
  id: string;
  title: string;
  scenes: Scene[];
}

/**
 * 从一门课里挑展示样本。revised / flagged 场景按「带 fix 的断言数」取最多的一个——
 * fix 是三栏的第三栏，没有 fix 的场景填不满版式，不选。
 */
export function pickAuditShowcase(course: CourseLike): AuditShowcase | null {
  let revised: { scene: Scene; rows: AuditClaim[] } | null = null;
  let caveat: { scene: Scene; rows: AuditClaim[] } | null = null;

  for (const scene of course.scenes) {
    const audit = scene.audit;
    if (!audit) continue;
    if (audit.verdict === 'revised' || audit.verdict === 'flagged') {
      const rows = audit.claims.filter((c) => c.fix);
      if (rows.length > 0 && rows.length > (revised?.rows.length ?? 0)) {
        revised = { scene, rows };
      }
    } else if (audit.verdict === 'caveat' && !caveat) {
      const rows = audit.claims.filter((c) => c.verdict === 'uncertain' && c.reason);
      if (rows.length > 0) caveat = { scene, rows };
    }
  }

  const hit = revised ?? caveat;
  if (!hit) return null;
  const audit = hit.scene.audit!;
  return {
    kind: revised ? 'revised' : 'caveat',
    courseId: course.id,
    courseTitle: course.title,
    sceneTitle: hit.scene.title,
    claims: hit.rows.slice(0, 4),
    debate: (audit.debate ?? []).slice(0, 3),
    judgeModels: audit.judgeModels?.length ? audit.judgeModels : [audit.judgeModel],
    ...(audit.arbiterModel ? { arbiterModel: audit.arbiterModel } : {}),
  };
}

/**
 * 一门课的「抓错数」：全部场景审核记录里被判非 supported（判错 / 存疑）的断言数。
 * 与展示层同源直数 claims，不信任 SceneAudit 上的冗余计数字段。
 *
 * 组件本身不再调它——清单接口的 audit.flagged 就是这个数（classroom-storage.ts 的
 * summarizeAudit 同样按 `verdict !== 'supported'` 逐条数）。这里留作口径的书面定义与回归测试锚点。
 */
export function countCatches(scenes: Scene[]): number {
  let n = 0;
  for (const scene of scenes) {
    const audit = scene.audit;
    if (!audit) continue;
    n += audit.claims.filter((c) => c.verdict !== 'supported').length;
  }
  return n;
}

/**
 * 从判官理由粗分错误类型（规格 §3 顶栏徽章）：
 * 含数值/数字/单位 → 红「事实性」；含术语/概念/定义 → 橙「术语」；其余 → 蓝「表述」。
 * 这是展示层的粗分类，不改变任何判定。
 */
export function classifyReason(reason: string): { label: string; cls: string } {
  if (/数值|数字|单位/.test(reason)) return { label: '事实性', cls: 'bg-red-soft text-red-deep' };
  if (/术语|概念|定义/.test(reason)) return { label: '术语', cls: 'bg-yellow-soft text-yellow-deep' };
  return { label: '表述', cls: 'bg-blue-soft text-blue-deep' };
}

/**
 * source_id → 书名+章节样式（`ha07s04#s8` → 《Hello-Agents》第7章）。
 * 前缀不认识就原样带「引用」前缀展示，不猜书名。
 */
const SOURCE_BOOKS: Record<string, string> = {
  ha: '《Hello-Agents》',
  hl: '《Happy-LLM》',
  d2l: '《动手学深度学习》',
  ag: '《AgentGuide》',
};

export function sourceLabel(sourceId: string): string {
  // d2l 在前：先匹配最长前缀，避免被短前缀截胡
  const m = /^(d2l|ha|hl|ag)(\d+)/.exec(sourceId);
  if (!m) return `引用 ${sourceId}`;
  return `${SOURCE_BOOKS[m[1]]} 第${parseInt(m[2], 10)}章`;
}

/**
 * 称谓与「模型名 → 判定」的脱敏都在 components/agents/judge-labels.ts，
 * 与 /agents 页、课堂角标弹层同一份。这里只是转出去，别在本文件另写一份。
 */
export { judgeRole, maskJudgeVerdict };

/** 选择器一行：课程 + 该课抓错数（调用方从清单接口的 audit.flagged 透传） */
export interface CourseAuditEntry {
  id: string;
  title: string;
  catchCount: number;
}

/** 选择器排序：抓错数降序，同数保持课程墙原序（Array.sort 稳定，入参已是墙上的顺序） */
export function sortAuditEntries<T extends { catchCount: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.catchCount - a.catchCount);
}

export function AuditShowcaseSection({ courses }: { courses: CourseAuditEntry[] }) {
  const entries = useMemo(() => sortAuditEntries(courses), [courses]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // undefined = 该课详情还在拉；null = 拉到了但没有可展示案例（或拉失败）
  const [showcase, setShowcase] = useState<AuditShowcase | null | undefined>(undefined);

  // 默认选抓错数最多的一门（entries 已按抓错数降序）
  const selected = entries.find((e) => e.id === selectedId) ?? entries[0];
  const selectedCourseId = selected?.id;
  const selectedTitle = selected?.title;

  useEffect(() => {
    if (!selectedCourseId) return;
    let cancelled = false;
    setShowcase(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/classroom?id=${encodeURIComponent(selectedCourseId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { classroom?: { scenes?: Scene[] } };
        const scenes = body.classroom?.scenes;
        if (cancelled) return;
        setShowcase(
          Array.isArray(scenes)
            ? pickAuditShowcase({ id: selectedCourseId, title: selectedTitle ?? '', scenes })
            : null,
        );
      } catch (error) {
        log.warn(`拉取课程 ${selectedCourseId} 失败：${String(error)}`);
        if (!cancelled) setShowcase(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCourseId, selectedTitle]);

  // 空态纪律：没有课程清单 ⇒ 整区不渲染，不编占位
  if (!selected) return null;

  const title = showcase?.kind === 'caveat' ? '审核智能体提出的保留意见' : '审核抓错的记录';

  // 审核智能体称谓按面板顺序映射（甲/乙），模型全名不落地
  const judgeNames = showcase?.judgeModels.map((_, i) => judgeRole(i)).join(' + ') ?? '';

  return (
    <section id="audit-showcase" className="mt-16">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Gavel className="size-5 text-purple-deep" aria-hidden />
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">
          出自
          <Link
            href={`/classroom/${selected.id}`}
            className="mx-1 underline decoration-border underline-offset-2 hover:text-foreground"
          >
            {selected.title}
          </Link>
          的审核记录，原样展示
        </p>
      </div>

      <div className="mt-5 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        {/* 左栏：选中课程的纠错卡流（或零打回空态） */}
        <div className="min-w-0">
          {showcase ? (
            <AuditCaseCards showcase={showcase} judgeNames={judgeNames} />
          ) : showcase === undefined ? (
            // 确实在飞（selectedCourseId 变了、详情还没回）才走这一支
            <div
              className={cn(
                CARD_RECIPE_STATIC,
                'px-5 py-10 text-center text-sm leading-relaxed text-muted-foreground',
              )}
            >
              正在读取该课的审核记录…
            </div>
          ) : selected.catchCount > 0 ? (
            <EmptyState
              title="这门课没有可完整展示的改写案例"
              hint={`审核记录里有 ${selected.catchCount} 条被判非通过的断言，但没有哪个场景能同时填满原句、改后句、审核理由三栏。换一门课看看。`}
            />
          ) : (
            <EmptyState
              title="这门课审核零打回"
              hint="审核智能体逐条核验后未抓出需要改写的断言。课程列表里带「抓错」徽标的那些有改写案例。"
            />
          )}
        </div>

        {/* 右栏：课程选择列表（课名 + 抓错数徽标，抓错数降序） */}
        <aside className="overflow-hidden rounded-xl border border-border">
          <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            按课程查看（{entries.length} 门，按抓错数排序）
          </p>
          <ul className="max-h-[32rem] divide-y divide-border-subtle overflow-y-auto">
            {entries.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(e.id)}
                  aria-pressed={e.id === selected.id}
                  className={cn(
                    // 焦点环：全局 --ring 带 0.4 透明度、控件基类再 ring-ring/50 减半，
                    // 这些原生 button 拿到的是 outline-style:auto + 近乎全透明的环，
                    // 实测合成后 1.22:1，浅色下截图里根本看不见。补一条不透明描边。
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors',
                    'focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-purple-deep',
                    // 选中态：原先只靠 bg-accent，与未选中底色只差 1.13:1（暗色 1.91），
                    // WCAG 1.4.11 对状态指示要求 3:1。加一条 3px 的归属色竖条撑起这个差。
                    // 未选中行留同宽透明竖条、左内边距一律 9+3=12（= px-3），切换时文字不跳。
                    e.id === selected.id
                      ? 'border-l-[3px] border-purple-deep bg-accent pl-[9px] font-medium'
                      : 'border-l-[3px] border-transparent pl-[9px] hover:bg-accent/60 active:bg-accent',
                  )}
                >
                  <span className="min-w-0 truncate">{e.title}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                      e.catchCount > 0
                        ? 'bg-red-soft text-red-deep'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {e.catchCount > 0 ? `抓错 ${e.catchCount}` : '零打回'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  );
}

/** 选中课程的案例展示：纠错卡流 + 仲裁分歧 + 判官脚注（三栏版式原样复用） */
function AuditCaseCards({ showcase, judgeNames }: { showcase: AuditShowcase; judgeNames: string }) {
  return (
    <div>
      {/* 竖排纠错卡流：默认 3 张（规格 §3） */}
      <div className="space-y-4">
        {showcase.claims.slice(0, 3).map((c, i) => {
          const kind = classifyReason(c.reason);
          const revised = Boolean(c.fix);
          return (
            <div key={i} className={cn(CARD_RECIPE_STATIC, 'overflow-hidden')}>
              {/* 顶栏：错误类型徽章 + 灰字场景名 */}
              <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', kind.cls)}>
                  {kind.label}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  「{showcase.sceneTitle}」场景
                </span>
              </div>

              <div className="space-y-2 px-5 py-4">
                {/* 原句：有改写才画删除线；保留意见的原句没被替换，不装成被删了 */}
                <p
                  className={cn(
                    'rounded-lg px-3 py-2 text-sm leading-relaxed',
                    revised
                      ? 'bg-red-soft text-red-deep line-through decoration-red-deep/50'
                      : 'bg-yellow-soft text-yellow-deep',
                  )}
                >
                  {c.claim}
                </p>
                {/* 改后句（绿底）；caveat 没有改写，如实写处理方式 */}
                <p className="rounded-lg bg-green-soft px-3 py-2 text-sm leading-relaxed text-green-deep">
                  {c.fix ?? '未改写；已标注「超出资料覆盖」随课发布'}
                </p>

                {/* 审核理由一行引语体 */}
                <p className="border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
                  审核理由：「{c.reason}」
                </p>

                {/* 教材出处 chip：书名+章节样式；无原文数据，不做悬停摘录 */}
                {!!c.sourceIds?.length && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {c.sourceIds.map((id) => (
                      <span
                        key={id}
                        className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {sourceLabel(id)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 仲裁分歧：两判官不一致时的完整裁决链，字段直读 audit.debate */}
      {showcase.debate.length > 0 && (
        <div className={cn(CARD_RECIPE_STATIC, 'mt-4 bg-muted/40 px-5 py-4')}>
          <p className="text-xs font-medium text-purple-deep">
            仲裁 {showcase.debate.length} 条分歧
          </p>
          <ul className="mt-2 space-y-2.5">
            {showcase.debate.map((d, i) => (
              <li key={i} className="text-xs leading-relaxed">
                <span className="text-foreground/80">{d.claim}</span>
                <span className="block text-muted-foreground">
                  审核分歧：{d.judgeVerdicts.map(maskJudgeVerdict).join('；')}
                </span>
                <span className="block text-muted-foreground">作者答辩：{d.defense}</span>
                <span className="block font-medium text-purple-deep">仲裁终审：{d.rationale}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        由 {judgeNames} 独立核验。课堂里每个场景的角标都能展开同样的逐条记录。
      </p>
    </div>
  );
}
