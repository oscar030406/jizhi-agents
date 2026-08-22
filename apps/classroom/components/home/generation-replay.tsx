'use client';

/**
 * 首屏右栏「过程回放」五帧（设计真源 docs/03-design/ui/landing-fusion-brief-20260815.md §3）。
 *
 * 替换掉原来的「实时渲染最新一门课」。原来那块的病根在选课逻辑：右栏取
 * `list[0]`——按 mtime 排序的最新一门，访客视角等于随机；放出来的又是一段裸讲义，
 * 与「核过、带出处」这个差异点无关（诊断见 landing-ia-proposal-20260810.md §2.1）。
 *
 * 本组件不生成任何东西，只回放一门真课已落盘的执行记录：
 *   课程 XndA0Gk4nC「大语言模型入门指南」/ 场景 scene_4S7Nr-n85x「逐步推理能力」。
 * 五帧的数据落点，逐帧可核：
 *   1 需求      data/learning-path.json 节点 llm-intro 的 requirement 字段（常量 REPLAY_REQUIREMENT，
 *               与该文件一字不差，回归测试 tests/home/generation-replay.test.ts 对着磁盘比）
 *   2 检索      scene.audit.sources[]（source_id + title，教材段落原样）
 *   3 讲义      scene.content 的正文，走 lib/classroom/lecture-text.ts 同一套抽取口径
 *   4 打回      scene.audit.claims[] 里带 fix 的条目（claim / reason / fix 三栏，
 *               版式与 audit-showcase.tsx 同源，不重新推导任何判定）
 *   5 发布      课程清单接口给的这门课的审核汇总（角标口径见 classroom-storage.ts 的 summarizeAudit）
 *
 * 挑帧纪律：`buildReplayFrames` 要求场景 verdict === 'revised' 且至少一条带 fix
 * 的断言、至少一段教材出处、讲义正文非空——任一缺失返回 null，整块不渲染。
 * 宁可首屏少一块，也不摆一个凑出来的回放。
 *
 * 自动步进（WO-E1）：默认自动播放，每帧停留时长写在 STEPS[].dwell 上，
 * 「审核打回」帧 8s 最长（简报 §3「高潮帧，停留最久」），其余 4.5-5s。
 * 鼠标移入或键盘焦点落在面板里就暂停（进度条同步停住），点帧签可跳。
 * prefers-reduced-motion 下五帧纵向并列、不自动播放、不做切换动画。
 *
 * layout 变体（WO-E1 交给用户挑，选定后收敛掉另一个）：
 *   'tabs'  横排帧签 + 帧内容淡入位移（默认）
 *   'stack' 五帧竖排卡叠，当前帧展开、其余折起
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpen, FileText, Gavel, PenLine, Send } from 'lucide-react';

import { CARD_RECIPE_STATIC } from '@/components/home/course-card';
import { GenerativeCover } from '@/components/home/generative-cover';
import { sceneLectureText } from '@/lib/classroom/lecture-text';
import { cn } from '@/lib/utils';
import type { Scene } from '@/lib/types/stage';

/** 回放取的那门课与那个场景，人工策展写死——不按 mtime 取「最新一门」。 */
export const REPLAY_COURSE_ID = 'XndA0Gk4nC';
export const REPLAY_SCENE_ID = 'scene_4S7Nr-n85x';

/**
 * 帧 1 的需求原文。真源是 apps/classroom/data/learning-path.json 里
 * `nodes[] where id === 'llm-intro'` 的 `requirement` 字段——那门课就是拿这句话生成的。
 * 这里抄一份常量而不是运行时读文件：这段是首屏，不值得为一个字符串多开一次请求。
 * 抄错的风险由 tests/home/generation-replay.test.ts 挡住（它直接读 JSON 比对）。
 */
export const REPLAY_REQUIREMENT =
  '面向零基础讲清楚大语言模型是什么：从语言模型讲到 LLM 的能力（上下文学习、指令遵循、逐步推理）与局限（幻觉），带一节文本怎么变成 token，配日常使用场景例子，不涉及数学推导与代码，节奏放慢';

/** 每帧右上角常驻的事实标签。只说这是什么，不评价我们自己。 */
const REPLAY_TAG = '真实生成记录回放';

/** 讲义帧只放开头一段，够看出「教材原文以摘录块嵌进正文」即可。 */
const LECTURE_CHARS = 200;

export interface ReplayCatch {
  claim: string;
  reason: string;
  fix: string;
}

export interface ReplayData {
  sceneTitle: string;
  /**
   * 该场景被判定时用的教材证据池，按章节标题合并。
   * 证据池里一个章节常有好几段（source_id 不同、title 相同），
   * 按 id 去重会在一帧里把同一个章节名重复印四遍，所以按标题合并、把段数写在 count 上。
   */
  sources: Array<{ title: string; count: number }>;
  /** 合并前的段落总数——「共 N 段」写的是这个，不是章节数 */
  sourceCount: number;
  lecture: string;
  catches: ReplayCatch[];
  rounds: number;
  judgeCount: number;
  totalClaims: number;
}

/** 讲义帧截断收尾：切在最后一个句读上，不把公式或词切成半截。 */
function trimAtSentence(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('：'));
  return at > cap / 2 ? cut.slice(0, at + 1) : cut;
}

/**
 * 从一门课的场景数组里取回放数据。纯函数，可测。
 * 合格判据（任一不满足返回 null，调用方整块不渲染）：
 *   - 指定 sceneId 存在且带审核记录，verdict === 'revised'；
 *   - 至少一条断言带 fix（帧 4 的三栏要填满）；
 *   - 至少一段教材出处（帧 2 要有东西可圈）；
 *   - 讲义正文非空（帧 3）。
 */
export function buildReplayFrames(scenes: Scene[], sceneId: string): ReplayData | null {
  const scene = scenes.find((s) => s.id === sceneId);
  const audit = scene?.audit;
  if (!scene || !audit || audit.verdict !== 'revised') return null;

  const catches: ReplayCatch[] = audit.claims
    .filter((c) => c.fix && c.reason)
    .map((c) => ({ claim: c.claim, reason: c.reason, fix: c.fix as string }));
  const raw = audit.sources ?? [];
  const byTitle = new Map<string, number>();
  for (const s of raw) byTitle.set(s.title, (byTitle.get(s.title) ?? 0) + 1);
  const lecture = trimAtSentence(sceneLectureText(scene), LECTURE_CHARS);

  if (catches.length === 0 || raw.length === 0 || lecture.length === 0) return null;

  return {
    sceneTitle: scene.title,
    sources: [...byTitle].map(([title, count]) => ({ title, count })),
    sourceCount: raw.length,
    lecture,
    catches,
    rounds: audit.rounds,
    judgeCount: audit.judgeModels?.length ?? 1,
    totalClaims: audit.totalClaims,
  };
}

interface CourseHead {
  id: string;
  title: string;
  sceneCount: number;
  audit: { claims: number; flagged: number; sources: number } | null;
}

/**
 * 五帧的视觉身份：每帧一个色系（design-language-spec §2.2 的语义表内取色），
 * 不再是五个灰盒子。dwell 是自动播放时这一帧的停留毫秒数。
 *   需求=黄（待办/进行中）· 检索=蓝（取材）· 讲义=紫（生成）
 *   打回=朱砂 annot-zhu（评点本批注色，简报点名的高潮帧）· 发布=绿（达成）
 * class 全部写成常量字符串：Tailwind 不扫描拼接出来的类名。
 */
const STEPS = [
  {
    icon: FileText,
    label: '需求',
    dwell: 4500,
    // E2 三轮：需求帧从黄换靛蓝——冷色页里米黄高亮跳戏（五帧叙事色仍互不重复）
    idle: 'text-indigo-700/60 dark:text-indigo-300/60',
    on: 'border-indigo-600 bg-indigo-50/80 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-300',
    bar: 'bg-indigo-600',
  },
  {
    icon: BookOpen,
    label: '检索教材',
    dwell: 5000,
    idle: 'text-blue-deep/60',
    on: 'border-blue-deep bg-blue-soft/70 text-blue-deep dark:bg-blue-soft/25',
    bar: 'bg-blue-deep',
  },
  {
    icon: PenLine,
    label: '写讲义',
    dwell: 5000,
    idle: 'text-purple-deep/60',
    on: 'border-purple-deep bg-purple-soft/70 text-purple-deep dark:bg-purple-soft/25',
    bar: 'bg-purple-deep',
  },
  {
    icon: Gavel,
    label: '审核打回',
    dwell: 8000,
    idle: 'text-annot-zhu/70',
    on: 'border-annot-zhu bg-red-soft/70 text-annot-zhu dark:bg-red-soft/40',
    bar: 'bg-annot-zhu',
  },
  {
    icon: Send,
    label: '发布',
    dwell: 5000,
    idle: 'text-green-deep/60',
    on: 'border-green-deep bg-green-soft/70 text-green-deep dark:bg-green-soft/25',
    bar: 'bg-green-deep',
  },
] as const;

export function GenerationReplay({
  course,
  layout = 'tabs',
}: {
  course: CourseHead;
  layout?: 'tabs' | 'stack';
}) {
  const [data, setData] = useState<ReplayData | null | undefined>(undefined);
  const [step, setStep] = useState(0);
  const [flat, setFlat] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setFlat(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  // 自动步进。reduced-motion（flat）下整段不装：那一档是五帧并列的静态版。
  // 数据没到之前也不走表——否则第一帧还没渲染出来计时器就已经跑掉两格。
  useEffect(() => {
    if (flat || paused || !data) return;
    const timer = window.setTimeout(
      () => setStep((s) => (s + 1) % STEPS.length),
      STEPS[step].dwell,
    );
    return () => window.clearTimeout(timer);
  }, [flat, paused, data, step]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/classroom?id=${encodeURIComponent(course.id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { classroom?: { scenes?: Scene[] } };
        const scenes = body.classroom?.scenes;
        if (!cancelled) {
          setData(Array.isArray(scenes) ? buildReplayFrames(scenes, REPLAY_SCENE_ID) : null);
        }
      } catch {
        if (!cancelled) setData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  // 拉不到 / 数据不合格 ⇒ 整块不上（空态纪律：不编）
  if (data === null) return null;
  if (data === undefined) {
    return (
      <div className={cn(CARD_RECIPE_STATIC, 'min-h-72 p-5 text-sm text-muted-foreground')}>
        正在读取这门课的生成记录…
      </div>
    );
  }

  const frames = [
    <Frame1 key="1" />,
    <Frame2 key="2" data={data} />,
    <Frame3 key="3" data={data} />,
    <Frame4 key="4" data={data} />,
    <Frame5 key="5" course={course} data={data} />,
  ];

  return (
    // 面板从背景里立起来：更深一档的投影 + 归属色描边（原来只有 shadow-card，
    // 与页面底色的台阶实测看不出来，整块像贴在纸上的表格）
    <div
      className={cn(
        CARD_RECIPE_STATIC,
        'overflow-hidden shadow-dropdown ring-1 ring-primary/15 dark:shadow-none',
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-purple-soft/50 px-5 py-2.5 dark:bg-purple-soft/25">
        <p className="text-xs font-medium text-purple-deep">
          {course.title} · 「{data.sceneTitle}」这一节是怎么来的
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">{REPLAY_TAG}</span>
      </div>

      {flat ? (
        // reduced-motion：五帧纵向并列，不做切换
        <ol className="divide-y divide-border">
          {frames.map((frame, i) => (
            <li key={STEPS[i].label} className="px-5 py-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                第 {i + 1} 步 · {STEPS[i].label}
              </p>
              {frame}
            </li>
          ))}
        </ol>
      ) : layout === 'stack' ? (
        // 变体「卡叠」：五帧竖排，当前帧展开其余折起。grid-rows 0fr↔1fr 是纯 CSS 的
        // 高度过渡写法（auto 高度不可过渡），reduced-motion 走不到这条分支。
        // 高度与 tabs 版对齐（41+57+380=478 ⇒ 这里 437），理由同 tabs 版：
        // 展开帧高度差两百多像素，不锁死整页会跟着自动播放上下跳
        <ol className="h-[437px] divide-y divide-border overflow-y-auto">
          {STEPS.map((s, i) => (
            <li key={s.label} className={cn(i === step && 'bg-muted/25')}>
              <button
                type="button"
                onClick={() => setStep(i)}
                aria-current={i === step ? 'step' : undefined}
                className="flex w-full items-center gap-2.5 px-5 py-2.5 text-left text-xs transition-colors hover:bg-accent/50 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors',
                    i === step ? s.on : cn('border-transparent bg-muted', s.idle),
                  )}
                >
                  <s.icon className="size-3.5" aria-hidden />
                </span>
                <span className={cn('font-medium', i === step ? 'text-foreground' : 'text-muted-foreground')}>
                  第 {i + 1} 步 · {s.label}
                </span>
                {i === step && !paused && (
                  <span aria-hidden className="ml-auto h-0.5 w-16 overflow-hidden rounded-full bg-border">
                    <span
                      key={step}
                      className={cn('replay-progress block h-full origin-left', s.bar)}
                      style={{ animationDuration: `${s.dwell}ms` }}
                    />
                  </span>
                )}
              </button>
              <div
                className={cn(
                  'grid transition-[grid-template-rows] duration-300 ease-out',
                  i === step ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                )}
              >
                <div className="overflow-hidden">
                  <div className="px-5 pb-4">{frames[i]}</div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <>
          <ol className="flex items-stretch border-b border-border">
            {STEPS.map((s, i) => (
              <li key={s.label} className="relative flex-1">
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  aria-current={i === step ? 'step' : undefined}
                  className={cn(
                    'flex w-full flex-col items-center gap-1 px-1 py-2.5 text-xs transition-colors',
                    'focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
                    // 选中态不只靠底色：底色差在浅色下只有 1.1:1 左右，配一条 2px 归属色底边
                    // 把状态指示撑到 3:1（同 audit-showcase 右栏那条竖条的修法）。
                    // 归属色改成每帧自己的色系（原来五格共用一个紫，等于没有身份）。
                    i === step
                      ? cn('border-b-2 font-medium', s.on)
                      : cn('border-b-2 border-transparent hover:bg-accent/60', s.idle),
                  )}
                >
                  <s.icon className="size-4" aria-hidden />
                  <span className={cn('leading-tight', i !== step && 'text-muted-foreground')}>
                    {s.label}
                  </span>
                </button>
                {/* 停留进度条：压在帧签底边上，走完就跳下一帧。暂停时整条不渲染，
                    「停住了」这件事本身就是暂停的反馈。 */}
                {i === step && !paused && (
                  <span
                    key={step}
                    aria-hidden
                    className={cn('replay-progress absolute inset-x-0 bottom-0 h-0.5 origin-left', s.bar)}
                    style={{ animationDuration: `${s.dwell}ms` }}
                  />
                )}
              </li>
            ))}
          </ol>
          {/* key={step} 让每次切帧重挂一次，淡入位移才会重放。
              高度写死不用 min-h：五帧自然高度差了 200px 以上（打回帧最高），
              自动播放时面板会每隔几秒撑高再缩回，整页跟着上下跳。
              固定 380px + 溢出滚动，换帧只换内容不换尺寸。
              内层 m-auto 而不是 justify-center：flex 居中 + 溢出会把超出的顶部
              推到滚不到的地方，auto margin 版本没有这个坑。 */}
          <div key={step} className="replay-frame-in flex h-[380px] flex-col overflow-y-auto px-5 py-4">
            <div className="m-auto w-full">{frames[step]}</div>
          </div>
        </>
      )}
    </div>
  );
}

function Frame1() {
  return (
    <>
      <p className="text-xs text-muted-foreground">学习者写下的需求</p>
      <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm leading-[1.75]">
        {REPLAY_REQUIREMENT}
      </p>
    </>
  );
}

function Frame2({ data }: { data: ReplayData }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        检索智能体圈定的教材段落——这一节判定时用的证据池共 {data.sourceCount} 段，
        分布在下面 {data.sources.length} 个章节
      </p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {data.sources.map((s) => (
          <li
            key={s.title}
            className="rounded-full border border-blue-deep/25 bg-blue-soft px-2.5 py-1 text-xs text-blue-deep"
          >
            {s.title}
            {s.count > 1 && <span className="ml-1 opacity-70">×{s.count}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function Frame3({ data }: { data: ReplayData }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        生成智能体写出的讲义正文开头（教材原文以摘录块嵌进正文，带 source id）
      </p>
      <p className="mt-2 border-l-2 border-border pl-3 text-sm leading-[1.75] text-foreground/85">
        {data.lecture}…
      </p>
    </>
  );
}

function Frame4({ data }: { data: ReplayData }) {
  const shown = data.catches.slice(0, 2);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        审核智能体逐条核验这一节的 {data.totalClaims} 条断言，打回 {data.catches.length} 条
        {data.rounds > 1 ? `，生成端改写后重审了第 ${data.rounds} 轮` : ''}
      </p>
      {/* 打回帧的朱砂：帧签、卡描边、被划掉的原句同一支笔（评点本立意） */}
      <div className="mt-2 space-y-3">
        {shown.map((c) => (
          <div key={c.claim} className="rounded-lg border border-annot-zhu/30 bg-red-soft/40 p-3">
            <p className="text-sm leading-relaxed text-annot-zhu line-through decoration-annot-zhu/50">
              {c.claim}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              审核理由：「{c.reason}」
            </p>
            <p className="mt-1.5 rounded bg-green-soft px-2 py-1.5 text-sm leading-relaxed text-green-deep">
              {c.fix}
            </p>
          </div>
        ))}
      </div>
      {data.catches.length > shown.length && (
        <p className="mt-2 text-xs text-muted-foreground">
          另有 {data.catches.length - shown.length} 条同样处理，进入课程后可详细查看。
        </p>
      )}
    </>
  );
}

function Frame5({ course, data }: { course: CourseHead; data: ReplayData }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {data.judgeCount} 个审核智能体判完，这一节随课发布——课程卡上的角标就是这次的记录
      </p>
      <Link
        href={`/classroom/${course.id}`}
        className={cn(CARD_RECIPE_STATIC, 'group mt-2 block overflow-hidden')}
      >
        <GenerativeCover name={course.title} className="h-20" />
        <div className="p-4">
          <h3 className="text-sm font-semibold group-hover:text-primary">{course.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{course.sceneCount} 个场景</p>
          {course.audit && (
            <p className="mt-2 text-xs text-muted-foreground">
              审核 {course.audit.claims} 条断言 · 打回 {course.audit.flagged} 条 · 引用{' '}
              {course.audit.sources} 段教材
            </p>
          )}
        </div>
      </Link>
    </>
  );
}
