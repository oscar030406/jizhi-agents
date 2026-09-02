'use client';

/**
 * 未登录公共首页。设计真源：docs/03-design/ui/landing-fusion-brief-20260815.md
 * （§3 首屏右栏过程回放、§4 全页叙事线、§5 输入框行为），
 * 配色配方在 docs/03-design/ui/public-site-redesign-20260809.md §4。
 *
 * 信息架构：顶栏 → A Hero（承诺+输入框）→ A′ 过程回放 → B 引擎学习路径
 * → C 已发布课程墙 → 相关指标 → D 机制三卡「我们为什么可信」→ E FAQ
 * → 尾部 CTA → 页脚两列。
 * 路径升到课程区之前（2026-08-16）：先看「课是怎么排的」，再看「有哪些课」——
 * 原来第一眼给的是九门人工挑的课，看不出它们之间是什么关系。
 * 段落底色三轮换（§4.1）：白 / surface-warm / soft 粉彩，整段 section 换底；
 * 每段一个高饱和锚点（标题旁的 deep 色图标、指标数字、hero 的手绘圈注）。
 *
 * 赛题六项要求区已撤出本页（08-10 用户红线：产品页禁赛题口吻）。
 * 组件文件 six-requirements.tsx 保留，答辩自用，不挂公共导航。
 *
 * 路径只读引擎当前产物，课程墙只读已发布课程接口；失败时分别显示真实失败态。
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUp, BookOpen, Gavel, Hammer, PenLine, Quote } from 'lucide-react';
import { annotate } from 'rough-notation';

import { AccountMenu } from '@/components/account/account-menu';
import { CARD_RECIPE } from '@/components/home/course-card';
import { FaqSection } from '@/components/home/faq';
import { GenerationReplay, REPLAY_COURSE_ID } from '@/components/home/generation-replay';
import { GenerativeCover } from '@/components/home/generative-cover';
import { KeyMetrics } from '@/components/home/key-metrics';
import { PathOrDomainCard } from '@/components/home/learning-overview';
import { MechanismCards } from '@/components/home/mechanism-cards';
import publicMetrics from '@/components/home/public-metrics.json';
import { PracticeHighlights } from '@/components/home/practice-highlights';
import { SectionAnchor } from '@/components/home/section-anchor';
import {
  projectsForCourse,
  usePublishedPractice,
  type PracticeProject,
} from '@/components/skills/practice-projects';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/textarea';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';

const log = createLogger('PublicLanding');

/**
 * 首屏那条数字。三个数与口径都取自 `public-metrics.json`——那份文件是
 * `scripts/sync-public-metrics.mjs` 从 `apps/agent-engine/data/metrics.json` 生成的产物，
 * 与页面下方「相关指标」三张卡同源。这里一个数都不许手写：数字散在两处迟早对不上。
 * 口径只留一句最短的，完整口径在下方那三张卡和 /evidence 里，不在首屏重复。
 */
const HERO_FIGURES = [
  {
    label: '生成端幻觉率',
    value: publicMetrics.hallucination.percent,
    note: `${publicMetrics.hallucination.claims} 条可核陈述逐条对教材`,
  },
  {
    label: '画像适配准确率',
    value: publicMetrics.adaptation.percent,
    note: `${publicMetrics.adaptation.n} 组盲评`,
  },
  {
    label: '核心知识点覆盖率',
    value: publicMetrics.kcCoverage.percent,
    note: `${publicMetrics.kcCoverage.courses} 门金标课点名 ${publicMetrics.kcCoverage.total} 个点`,
  },
] as const;

export interface ClassroomSummary {
  id: string;
  title: string;
  description?: string;
  sceneCount: number;
  createdAt: string;
  audit: { claims: number; flagged: number; sources: number } | null;
}

/** 中英标点、空白、大小写归一后再比对——「RAG检索」和「rag 检索」是同一件事。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s，。、；：！？,.;:!?（）()「」【】\-_/]/g, '');
}

/**
 * 需求 → 真课：只认整串包含，不做模糊打分（简报 §5「不赌模糊匹配」）。
 *
 * 判据是二选一的包含关系：归一化后课名包含输入，或输入包含课名。
 * 两条都不成立就是没命中——**不兜底跳最新一门**。原来那个 pickClosestCourse
 * 按字符重合度挑「最像的一门」，挑不出就 `courses[0]`，等于随便给一门课还装成命中，
 * 这是首屏输入框「并没有起到它的功能」的直接原因。
 * 输入短于 2 个字符一律不算命中（单个「A」能包进一半课名）。
 */
export function matchCourse(
  requirement: string,
  courses: ClassroomSummary[],
): ClassroomSummary | null {
  const q = normalize(requirement);
  if (q.length < 2) return null;
  // 课名长的优先：「RAG 检索质量评估与优化」比「RAG 检索增强生成入门」更贴一句长需求，
  // 而两者都包不进短输入时长度不影响结果
  const sorted = [...courses].sort((a, b) => b.title.length - a.title.length);
  return (
    sorted.find((c) => {
      const t = normalize(c.title);
      return t.includes(q) || q.includes(t);
    }) ?? null
  );
}

/**
 * 没命中时给「最接近的 3 门」。按字符重合度排，纯粹是给个由头，
 * **不能当命中用**——所以它只出现在空态卡里，永远不作为跳转目标。
 */
export function rankByOverlap(
  requirement: string,
  courses: ClassroomSummary[],
  n = 3,
): ClassroomSummary[] {
  const chars = new Set(normalize(requirement));
  return [...courses]
    .map((course) => {
      const title = normalize(`${course.title}${course.description ?? ''}`);
      let score = 0;
      for (const ch of new Set(title)) if (chars.has(ch)) score += 1;
      return { course, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.course);
}

/** rough-notation 手绘圈注（§4.5）：参数照抄 /compare 页 RoughMark 的口径。 */
function RoughCircle({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const mark = annotate(ref.current, {
      type: 'circle',
      color: 'var(--purple-deep)',
      strokeWidth: 1.5,
      padding: 5,
      iterations: 2,
      multiline: true,
      animationDuration: 400,
      animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    mark.show();
    return () => mark.remove();
  }, []);
  return <span ref={ref}>{children}</span>;
}

function AuditBadges({ audit }: { audit: NonNullable<ClassroomSummary['audit']> }) {
  // 刻意不写「N/N 通过」：verdict 有 caveat/revised/flagged 多档，
  // 压成百分比会抹平语义。打回条数本身就是卖点。
  //
  // 减密度（WO-E1 §2）：卡面默认只留最有力的一条「审核打回 N 条」，
  // 另两条收进 hover/focus 展开——九张卡 × 三条角标是课程墙上文字最密的一块。
  // 一个字都没改，只是默认不铺开。
  return (
    <div className="mt-3 text-xs">
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-soft px-2 py-0.5 text-foreground/80">
        <Gavel className="size-3" aria-hidden />
        审核打回 {audit.flagged} 条
      </span>
      <span className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out group-hover:grid-rows-[1fr] group-focus-visible:grid-rows-[1fr]">
        <span className="overflow-hidden">
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-purple-soft px-2 py-0.5 text-foreground/80">
              审核 {audit.claims} 条断言
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-soft px-2 py-0.5 text-foreground/80">
              <Quote className="size-3" aria-hidden />
              引用 {audit.sources} 段教材
            </span>
          </span>
        </span>
      </span>
    </div>
  );
}

/** 课程墙的一组卡（模块内一组、扩展域一组，卡面完全一样）。 */
function CourseGrid({
  courses,
  practiceProjects,
}: {
  courses: ClassroomSummary[];
  practiceProjects: PracticeProject[];
}) {
  return (
    <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {courses.map((course) => {
        const linkedProjects = projectsForCourse(practiceProjects, course.id);
        return (
          <li key={course.id}>
            <Link
              href={`/classroom/${course.id}`}
              className={cn(
                CARD_RECIPE,
                'group block overflow-hidden transition-[filter,border-color,transform] hover:-translate-y-1',
              )}
            >
              {/* 生成式封面（§4.4）：hover 微缩放给「可进入」的物理暗示。
                saturate 提一档：封面的粉彩字母在纯白基底上显灰（农家感来源之一）。 */}
              <div className="overflow-hidden saturate-[1.3]">
                <GenerativeCover
                  name={course.title}
                  className="h-24 transition-transform duration-slow group-hover:scale-105"
                />
              </div>
              {/* 卡面留白加大（WO-E1 §2）：p-4→p-5，课名 sm→base */}
              <div className="p-5">
                <h3 className="line-clamp-2 text-base font-semibold transition-colors group-hover:text-primary">
                  {course.title}
                </h3>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{course.sceneCount} 个场景</span>
                  {/* 课程边只由当前已发布项目的 courseIds 反查，不在课程数据里落第二份。 */}
                  {linkedProjects.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-soft px-2 py-0.5 text-foreground/80">
                      <Hammer className="size-3" aria-hidden />配 {linkedProjects.length} 个实操
                    </span>
                  )}
                </p>
                {course.audit && <AuditBadges audit={course.audit} />}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 变体开关（WO-E1 交付到「用户挑」为止，选定后这段连同另一支实现一起删）：
 *   ?anchor=zhu   全页锚点色从紫换成朱砂（评点本本命色）
 *   ?replay=stack 右栏回放从横排帧签换成竖排卡叠
 * 锚点变体不逐个组件改 class，而是在公共页根节点上覆写 token——
 * 全页吃 --primary / --purple-* 的地方一起翻，不会漏掉哪一处。
 */
const VARIANT_STYLE = `
[data-anchor='zhu']{--primary:var(--annot-zhu);--purple-deep:var(--annot-zhu);--purple-soft:var(--red-soft);}
@keyframes replay-progress{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.replay-progress{animation:replay-progress linear forwards}
@keyframes replay-frame-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.replay-frame-in{animation:replay-frame-in 320ms ease-out both}
`;

/** 居中收窄容器：全宽换底 section 里的内容统一走这个宽度。 */
const CONTAINER = 'mx-auto w-full max-w-6xl px-6';

/**
 * 全宽段落的统一节奏：上下各 64px，段与段相接就是 128px 的大区段间距。
 *
 * dark:bg-background 是暗色层次的修法：surface-warm 在暗色下是 oklch(0.19)，
 * 而卡片底 bg-card 是 oklch(0.205)，实测两者对比只有 1.007:1——换底带把卡片
 * 的明度台阶整个吃掉了。暗色下让它退回页底色，把台阶还给卡片。
 * SOFT 档在暗色下反过来要全不透明（/40 叠在页底只差 1.06:1，等于没换底）。
 */
/**
 * E2 三轮（computed style 实拔四家后修正，数据在 e2/teardown 记录）：
 * - 基底一律纯白（四家全是 rgb(255,255,255)；我们的 --background 是 lab(98.3) 暖白，
 *   整页垫了一层米色底味——公共页根节点直接 bg-white 压掉）
 * - 段落带要「看得见的天蓝」：Duolingo 实测 rgb(221,244,255) chroma 0.133、
 *   Gamma 天蓝→白纵向渐变。第一版冷白 chroma 0.008 淡到等于没换
 * - 渐变稀少而干净：Gamma 整幅只有一条纵向天蓝→白；不做糊雾 blob
 * 暖纸色（surface-warm）留给课堂阅读页——评点本语境在那里才成立。
 */
const SECTION = 'py-20';
const SECTION_WARM = 'py-20 bg-[rgb(240,245,253)] dark:bg-background';
const SECTION_SOFT = 'py-20 bg-[rgb(228,238,253)] dark:bg-blue-soft';

/** 顶栏导航项：py-1 把 20px 的裸链接撑到 28px 点击区，圆角为焦点环留形。 */
const NAV_LINK =
  'rounded-md px-2 py-1 transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none';

export function PublicLanding() {
  const router = useRouter();
  const practiceState = usePublishedPractice('ai');
  const practiceProjects = practiceState.kind === 'ready' ? practiceState.projects : [];
  const [requirement, setRequirement] = useState('');
  const [missed, setMissed] = useState(false);
  const [courses, setCourses] = useState<ClassroomSummary[]>([]);
  // 三态分开记：在飞 / 拉到了 / 拉失败。只有 loaded 布尔时，接口挂掉与真没课
  // 都走「courses 为空 ⇒ 整块不渲染」，访客看到的是课程墙凭空消失。
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // 变体选择只在客户端读 URL：服务端渲染拿不到 search，写在 state 里免得两边不一致
  const [anchorVariant, setAnchorVariant] = useState<'purple' | 'zhu'>('purple');
  const [replayLayout, setReplayLayout] = useState<'tabs' | 'stack'>('tabs');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('anchor') === 'zhu') setAnchorVariant('zhu');
    if (q.get('replay') === 'stack') setReplayLayout('stack');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/classroom');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { classrooms?: ClassroomSummary[] };
        if (cancelled) return;
        setCourses(body.classrooms ?? []);
        setListState('ready');
      } catch (error) {
        log.warn(`公共课程墙加载失败，按失败态渲染：${String(error)}`);
        if (!cancelled) setListState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const wallCount = courses.length;
  const replayCourse = courses.find((c) => c.id === REPLAY_COURSE_ID);
  // 实操卡上的「对口课程」要显示课名而不是裸 id。课程接口没返回时这里是空表，
  // 实操区照常渲染，只是不出那一行——沿用 PracticeCard 的做法。
  const courseTitles = Object.fromEntries(courses.map((c) => [c.id, c.title]));

  const submit = () => {
    const hit = matchCourse(requirement, courses);
    if (hit) {
      router.push(`/classroom/${hit.id}`);
      return;
    }
    setMissed(true);
  };

  return (
    <div className="w-full bg-white dark:bg-background" data-anchor={anchorVariant}>
      <style dangerouslySetInnerHTML={{ __html: VARIANT_STYLE }} />
      {/* 顶栏：品牌位 + 账号入口。导航词用外人能懂的说法——
          「同题异人」「技能地图」是内部叫法，访客读不出指向什么页 */}
      <header className={`${CONTAINER} flex h-16 items-center justify-between`}>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-wide">集智</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            多智能体生成带出处的课
          </span>
        </div>
        <nav className="hidden items-center gap-3 text-sm text-muted-foreground md:flex">
          <Link href="/path" className={NAV_LINK}>
            学习路径
          </Link>
          <a href="#courses" className={NAV_LINK}>
            课程
          </a>
          <Link href="/evidence" className={NAV_LINK}>
            审核实录
          </Link>
          {/* 「课程对比」撤出导航（2026-08-16）：同题异人已经拆散内嵌——生成入口选画像时
              有「画像影响预览」，生成完在 /report 有「你的课为什么长这样」。让访客先去看
              一个抽象的双人对照，不如在他自己那门课上直接看到。/compare 路由仍在，可直达。 */}
          <Link href="/agents" className={NAV_LINK}>
            智能体分工
          </Link>
          <Link href="/skills" className={NAV_LINK}>
            岗位技能
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          <AccountMenu />
        </div>
      </header>

      {/* 区 A —— 承诺（E2 换骨架：NotebookLM 式单栏居中大字。
          病根复盘：E1 在双栏骨架里把 H1 调到 48px 就到顶了——532px 栏宽装不下更大的字。
          参考站的「感觉」住在骨架里（Brilliant 76px / NotebookLM 88px、单栏、巨量留白），
          所以这一版把栏拆了：整幅宽度给标题，回放面板下移成独立区块。） */}
      <section className="relative overflow-hidden">
        {/* 原来这里垫了一条 Gamma 式的天蓝→白纵向渐变。撤掉：它是纯装饰，
            冷蓝压在全站暖白底上本身就是两套灰，而且把「营销落地页」的味道带进了
            一个学校和企业要天天用的工具页。首屏的重心交给标题和输入框，底不说话。 */}
        <div className={`${CONTAINER} relative flex flex-col items-center pb-24 pt-16 text-center`}>
          {/* hero kicker：朱批色细下划线呼应评点本视觉 */}
          <p className="mb-5 text-sm font-semibold tracking-wide text-annot-zhu">
            <span className="border-b border-annot-zhu/50 pb-0.5">
              我们不发明知识，只做教材的搬运工
            </span>
          </p>
          {/* 68px：全幅宽下「生成一整门带出处的课」十个字 680px，max-w-3xl 内一行放下。
              中文笔画密，不追英文站 88px 的量级，68 是可读与气势的平衡点。 */}
          {/* 基档 32px：375 宽视口减 padding 剩 ~327px，「生成一整门带出处的课」十字
              32×10=320 恰好一行；44px 起步会在词中间被硬折。 */}
          {/* 字重 500 + 收字距：Brilliant 76px/w500/-1.4px、NotebookLM 88px/w500 实拔同款；
              600 在 68px 上发闷，500 收字距更接近参考站的「利落」。 */}
          <h1 className="text-[32px] font-medium leading-[1.15] tracking-[-0.02em] sm:text-[56px] lg:text-[68px]">
            一句需求，
            <br />
            生成一整门<RoughCircle>带出处</RoughCircle>的课
          </h1>
          {/* 副标：标题只说做什么，这一行说给谁做。访客第一屏看不出对象是机构还是个人，
              就会按个人订阅工具来读我们。一行讲完，不展开。 */}
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
            给学校和企业培训部门用的课程生产线
          </p>

          {/* 输入框改成「作曲器」形态：框内左下口径小字 + 右下 CTA，
              参考 Kimi/NotebookLM 的产品即输入框。全首屏只有这一个交互主体。 */}
          <div className="mt-10 w-full max-w-2xl text-left">
            {/* 玻璃质感：半透明白 + 背景模糊，让极光从卡片底下透出来 */}
            <div className="rounded-2xl border border-white/60 bg-card/75 shadow-card backdrop-blur-xl transition-shadow focus-within:shadow-dropdown dark:border-border">
              <Textarea
                value={requirement}
                onChange={(e) => {
                  setRequirement(e.target.value);
                  setMissed(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="想学什么？例如：Transformer 注意力机制"
                className="min-h-24 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                aria-label="学习需求"
              />
              <div className="flex items-end justify-between gap-3 px-3 pb-3">
                <p className="text-xs leading-[1.6] text-muted-foreground">
                  已经生成过的课直接打开；没有的课由多智能体流水线现场生成，第一屏就绪即可进入课堂、其余场景边学边生成，需登录发起。
                </p>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!requirement.trim() || listState !== 'ready'}
                  /* 原来是紫→蓝渐变的胶囊。渐变纯装饰，而且这颗按钮是全站唯一
                     不走 --primary 的实心按钮，同一个动作在登录前后两个样子。
                     换成主色实心 + 与站内按钮同一档圆角，重量不变，只是不再自成一派。 */
                  className="bg-primary text-primary-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-5 py-2.5 text-base font-medium shadow-card transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-75"
                >
                  找这门课 <ArrowUp className="size-4 rotate-90" aria-hidden />
                </button>
              </div>
            </div>

            {courses.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 text-xs">
                <span className="text-muted-foreground">或者直接看已发布课程：</span>
                {courses.slice(0, 3).map((course) => (
                  <Link
                    key={course.id}
                    href={`/classroom/${course.id}`}
                    className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {course.title}
                  </Link>
                ))}
              </div>
            )}

            {/* 首屏数字条 + 一个免登录的旁路入口。
                访客第一屏现在只能选「输入点什么」，输不出来就走了；这条给两样东西：
                这套东西被量过（三个数），以及不想输入也能先看一门成品（右侧链接）。
                做法上刻意压重量——小字、单行、竖线分隔、无卡片无色块，
                重心留给上面那个输入框。数字全部来自 public-metrics.json，见上方常量。 */}
            <div className="border-border/60 mt-6 border-t pt-4">
              <dl className="grid grid-cols-3">
                {HERO_FIGURES.map((f, i) => (
                  <div
                    key={f.label}
                    className={cn('px-4 first:pl-0 last:pr-0', i > 0 && 'border-border border-l')}
                  >
                    <dt className="text-muted-foreground text-xs">
                      <span className="text-foreground mr-1 text-sm font-medium tabular-nums">
                        {f.value}
                      </span>
                      {f.label}
                    </dt>
                    <dd className="text-muted-foreground/70 mt-0.5 text-[11px] leading-snug">
                      {f.note}
                    </dd>
                  </div>
                ))}
              </dl>
              <a
                href="#courses"
                className="text-muted-foreground hover:text-foreground mt-3 inline-block text-xs underline-offset-4 transition-colors hover:underline"
              >
                先看一门已生成的课 →
              </a>
            </div>

            {/* 没命中的诚实空态：不假装跳对了，把最接近的三门摆出来让人自己挑 */}
            {missed && (
              <div className="mt-4 rounded-lg border border-dashed border-border/70 p-4">
                <p className="text-sm font-medium">还没有这门课</p>
                <p className="mt-1 text-xs leading-[1.75] text-muted-foreground">
                  课程墙上的课都是已经生成并发布的。登录后可以按你这句需求定制生成一门。
                  下面是现有课里与你输入字面最接近的三门：
                </p>
                <ul className="mt-3 grid gap-2 sm:grid-cols-3">
                  {rankByOverlap(requirement, courses).map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/classroom/${c.id}`}
                        className={cn(CARD_RECIPE, 'block p-3 text-xs font-medium')}
                      >
                        {c.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 区 A′ —— 过程回放（E2 从 hero 右栏下移成独立区块：它是最硬的证据，
          但证据不配当首屏主角——首屏主角是承诺。取不到合格数据时整块不渲染。 */}
      {replayCourse && (
        <section className={SECTION_WARM}>
          <div className={CONTAINER}>
            <h2 className="flex items-center justify-center gap-2.5 text-center text-[28px] font-semibold leading-snug">
              <SectionAnchor icon={PenLine} />
              一门课是怎么生成出来的
            </h2>
            <div className="mx-auto mt-6 max-w-3xl">
              <GenerationReplay course={replayCourse} layout={replayLayout} />
            </div>
          </div>
        </section>
      )}

      {/* 区 B —— 公共 AI 库的引擎路径；不读取旧静态路径。 */}
      <section className={SECTION}>
        <div className={CONTAINER}>
          <PathOrDomainCard corpus="ai" />
        </div>
      </section>

      {/* 区 C —— 已发布课程墙。列表本身已经过可见性与发布状态过滤。 */}
      <section id="courses" className={cn('scroll-mt-20', SECTION_WARM)}>
        <div className={CONTAINER}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="flex items-center gap-2.5 text-[28px] font-semibold leading-snug">
              <SectionAnchor icon={BookOpen} />
              已经生成的课
            </h2>
            {wallCount > 0 && (
              <p className="text-xs text-muted-foreground">
                角标是这门课的审核记录，进入课程后可详细查看
              </p>
            )}
          </div>
          {listState === 'loading' && (
            <p className="mt-5 text-sm text-muted-foreground">正在读取课程墙…</p>
          )}
          {listState === 'failed' && (
            <div className="mt-5">
              <EmptyState
                title="读不到课程清单"
                hint="课程墙的数据这次没有正常返回。刷新页面重试；反复读不到就是本站的课程服务暂时不可用，稍后再来。"
              />
            </div>
          )}
          {listState === 'ready' && wallCount === 0 && (
            <div className="mt-5">
              <EmptyState
                title="课程墙上还没有课"
                hint="这套系统的课程由多智能体现场生成并通过审核后发布。本站目前还没有已发布课程；登录后可在工作台发起生成。"
              />
            </div>
          )}
          {listState === 'ready' && wallCount > 0 && (
            <div className="mt-6">
              <CourseGrid courses={courses} practiceProjects={practiceProjects} />
            </div>
          )}
        </div>
      </section>

      {/* 动手实操 —— 只消费 AI 域由引擎生成并经管理者审核发布的结果。 */}
      <section className={SECTION}>
        <div className={CONTAINER}>
          <PracticeHighlights state={practiceState} courseTitles={courseTitles} />
        </div>
      </section>

      {/* 相关指标 —— 只列赛题三指标，其余留在 /evidence 的完整台账 */}
      <section className={SECTION_SOFT}>
        <div className={CONTAINER}>
          <KeyMetrics />
        </div>
      </section>

      {/* 区 D —— 机制三卡「我们为什么可信」 */}
      <section className={SECTION}>
        <div className={CONTAINER}>
          <MechanismCards />
        </div>
      </section>

      {/* 区 E —— FAQ，surface-warm 换底档 */}
      <section className={SECTION_WARM}>
        <div className={CONTAINER}>
          <FaqSection />
        </div>
      </section>

      {/* 尾部 CTA —— soft 粉彩换底档。AccountMenu 在账户系统未启用时自渲染 null，
          此时只剩标语，不给用户一个点了会报错的按钮。 */}
      <section className={cn('bg-[rgb(233,232,253)] dark:bg-purple-soft', SECTION)}>
        <div className={`${CONTAINER} flex flex-col items-center gap-4 text-center`}>
          <h2 className="text-[32px] font-semibold leading-snug">下一门课，从你的一句需求开始</h2>
          <p className="max-w-xl text-sm leading-[1.75] text-muted-foreground">
            注册后，学习者画像与生成的课程会保存在账户上，换设备也能继续。
          </p>
          <AccountMenu />
        </div>
      </section>

      {/* 页脚两列：产品 / 数据与核验。
          原来「证据」这个栏目名概括不明——访客不知道点进去是什么，换成说清内容的词。
          原来第三列「关于集智」那段介绍已删：品牌位、hero、机制三卡都在说同一件事，
          页脚再复述一遍是纯冗余。 */}
      <footer className="border-t border-border">
        <div className={`${CONTAINER} grid gap-8 py-10 text-xs sm:grid-cols-2`}>
          <div>
            <p className="font-semibold">产品</p>
            <ul className="mt-3 space-y-2 text-muted-foreground">
              <li>
                <a href="#courses" className="hover:text-foreground">
                  课程墙
                </a>
              </li>
              {/* 顶栏导航 md 以下整条隐藏，学习路径在窄屏只剩主线卡一个入口，页脚补上 */}
              <li>
                <Link href="/path" className="hover:text-foreground">
                  学习路径
                </Link>
              </li>
              {/* 「课程对比」同步撤出页脚，理由见顶栏导航那条注释。 */}
              <li>
                <Link href="/skills" className="hover:text-foreground">
                  岗位技能
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="font-semibold">数据与核验</p>
            <ul className="mt-3 space-y-2 text-muted-foreground">
              <li>
                <Link href="/evidence" className="hover:text-foreground">
                  审核实录
                </Link>
              </li>
              <li>
                <Link href="/agents" className="hover:text-foreground">
                  智能体分工
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="hover:text-foreground">
                  隐私与数据
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div
          className={`${CONTAINER} border-t border-border/60 py-4 text-center text-xs text-muted-foreground`}
        >
          {/* ICP 备案位：全仓未找到本站备案号（nginx 配置不在本仓）。备案下来后
              在这里补：<a href="https://beian.miit.gov.cn/">X ICP 备 XXXXXXXX 号</a>，
              绝不先挂占位号。 */}
          <span>集智 · 多智能体课程生成</span>
        </div>
      </footer>
    </div>
  );
}
