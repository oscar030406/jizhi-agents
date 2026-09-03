/**
 * 管理端总览。
 *
 * 赛题五(3)① 要求「支持生成可视化的个人学情与资源匹配度报告……帮助**培训管理者**
 * 或学习者直观决策」。个人维度是 `/report`，本页补机构维度——两者合起来才接住
 * 「培训管理者」这四个字。
 *
 * 版面顺序按「管理者进来要先做什么、再看什么」排（2026-08-18 用户验收后重排）：
 *   0 接入新库——本页唯一的实心大按钮，接入记录与领域泛化作它的跟随链接
 *   A 已接入语料库（结论卡在外，就绪度九栏明细在折叠里）
 *   B 全局口径数字 + 课程墙实时汇总
 *   C 课程审核账单表，按判错数降序，点行下钻
 *
 * 2026-09-03 用户两次点名删掉页尾的「资源体检」与「学习路径」两区：前者讲的是资源侧
 * 覆盖缺口与难度供给，与本页其余部分（库、指标、审核账单）不是同一个决策；后者整区
 * 只有一句话加一条去 /path 的链接，路径页本身在顶栏就能到。删的是入口，
 * 覆盖缺口的数据照旧喂给审核账单表那一列（readCoverageRuns 还在）。
 *
 * 数字纪律：只有 metrics.json（带口径原文）与课程文件实时计算两个来源，
 * 读不到显示「—」。这一页不受 check_metrics.py 管辖，更不许硬编码。
 *
 * 视觉与信息分层（2026-08-16 用户评审：「排版混乱、小字堆砌、可视化差」）：
 * - 走公共页那套实拔出来的公式（`docs/03-design/ui/reference-teardown-20260815.md`）：
 *   纯白基底、看得见的天蓝段落带、全页一支高饱和锚点（`SectionAnchor` 那颗紫→靛渐变方片）、
 *   H2 28px、段落 py-16 级留白。原来整页是 `text-sm` 标题 + `text-[10px]` 正文，
 *   六个区块靠 `mb-10` 挤在一起，字阶压根没拉开。
 * - 默认视图只见结论与图；口径原文、来源、复算命令全部进 `<Caliber>` 折叠——
 *   **一个字不删**，只是不再糊在脸上。08-18 又收了一轮：各区块标题下那句 `lead`
 *   凡是标题已经说清的就删、说不清的并进同区的 `<Caliber>`（体检、路径图两处），
 *   删掉的只有重复，搬走的都还在折叠里。
 * - 语料库名走 `lib/knowledge/domain-labels.ts` 的单一真源，界面上不出现接入目录名。
 *
 * 这是服务端组件：聚合要读引擎目录与全部课程文件，放客户端等于把整个课程库
 * 拉给浏览器。交互只有若干 <details>，不值得为它上客户端。
 */

import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Building2,
  Gavel,
  Globe2,
  History,
  ShieldAlert,
  Upload,
} from 'lucide-react';

import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import {
  readAllCourseAudits,
  readCorpusOverview,
  readDomainIntakes,
  readHeadlineMetrics,
  rollup,
} from '@/lib/server/admin-overview';
import { readCoverageRuns } from '@/lib/server/knowledge-map';
import { Caliber } from '@/components/admin/caliber';
import { AdminCourseTable } from '@/components/admin/course-table';
import { DomainIntakeSummary } from '@/components/admin/domain-intake-summary';
import { DomainIntakeTable } from '@/components/admin/domain-intake-table';
import { MetricBand } from '@/components/admin/metric-band';
import { SectionAnchor } from '@/components/home/section-anchor';
import { SiteHeader } from '@/components/site-header';
import { DemoStrip } from '@/components/tour/demo-strip';
import { ReplayTourLink } from '@/components/tour/replay-tour-link';
import { TourAutoStart } from '@/components/tour/tour-auto-start';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * 两条段落带。原来是公共页实拔的天蓝（chroma ≥0.1），问题有两个：
 * 一是全站中性色是暖的（--muted 245,243,238），一条冷蓝色带压在暖白上是两套灰；
 * 二是整幅换底的高饱和色块在管理端这种信息密集页上抢视觉中心，把注意力从
 * 数字和表格上拉走。改用主题自带的中性档，段落分隔照旧（白 / muted 两级明度差
 * 仍然看得出来），只是不再喊。暗色沿用同一组 token，不做二次调色。
 */
const BAND_WARM = 'bg-muted/50 dark:bg-background';
const BAND_SOFT = 'bg-muted dark:bg-muted/40';
const CONTAINER = 'mx-auto w-full max-w-6xl px-4 sm:px-6';

function Denied({ reason }: { readonly reason: string }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-card">
        <ShieldAlert className="mx-auto mb-3 size-8 text-amber-600" />
        <h1 className="mb-2 text-lg font-semibold">管理端</h1>
        <p className="text-sm text-muted-foreground">{reason}</p>
        <Link
          href="/"
          className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs hover:bg-accent transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          回首页
        </Link>
      </div>
    </main>
  );
}

/**
 * 一个区块。标题 28px + 一颗锚点，标题下最多一句结论——
 * 结论之外的话进 children 里的 `<Caliber>`，不挂在这里。
 */
function Section({
  icon,
  title,
  lead,
  band,
  children,
}: {
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly title: string;
  readonly lead?: string;
  readonly band?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={cn('py-14 sm:py-16', band)}>
      <div className={CONTAINER}>
        <h2 className="flex items-center gap-2.5 text-[28px] font-semibold leading-snug tracking-tight">
          <SectionAnchor icon={icon} />
          {title}
        </h2>
        {lead && <p className="mt-3 text-sm text-muted-foreground">{lead}</p>}
        <div className="mt-7">{children}</div>
      </div>
    </section>
  );
}

export default async function AdminPage() {
  if (!accountsEnabled()) {
    return <Denied reason="本站暂未启用账户系统与管理端。" />;
  }
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account) {
    return <Denied reason="管理端需要登录。请在首页右上角以「管理者」身份登录。" />;
  }
  if (account.role !== 'manager') {
    return <Denied reason="当前账号是学习者身份。管理端只对管理者账号开放。" />;
  }

  // 先灌域注册清单：本页语料卡标题走 domainLabel，服务端内存视图没人灌时
  // 新库上屏就是裸英文目录名（smart-manufacturing 08-30 线上实测撞上，
  // 与知识库中心同样先灌实时域注册表，避免首屏显示裸目录名。
  const { readDomainRegistry } = await import('@/lib/server/domain-registry');
  await readDomainRegistry().catch(() => null);

  const [metrics, courses, intakes, coverage] = await Promise.all([
    readHeadlineMetrics(),
    readAllCourseAudits(),
    readDomainIntakes(),
    readCoverageRuns(),
  ]);
  const totals = rollup(courses);
  /**
   * 就绪度表的标题用中文名。表组件本身归 J2 一线在改，这里在数据层把
   * 接入目录名换成 `domain-labels.ts` 里登记的显示名——同一张真源表，
   * 换个消费点，不在两处各维护一份翻译。
   */
  const labeledIntakes = intakes.map((d) => ({ ...d, domain: domainLabel(d.domain) }));
  // 卡片清单不等于体检报告清单：内置主库没走过接入链，只有域注册清单认识它。
  const corpora = await readCorpusOverview(intakes);

  return (
    <>
      {/* 换掉手写的回链：管理者登录后 ROLE_HOME 直接落这一页（lib/store/account.ts），
          没有顶栏就意味着想切暗色得先退回首页。SiteHeader 是站内其余子页
          共用的那一条。root layout 已在最外层挂了 ThemeProvider 与 I18nProvider，
          服务端组件里渲染这个客户端组件没问题。 */}
      <DemoStrip />
      <SiteHeader maxWidth="max-w-6xl">
        <ReplayTourLink id="admin" />
      </SiteHeader>
      <TourAutoStart id="admin" />
      {/* 纯白基底：`--background` 是 lab(98.3) 暖白，整页垫一层米色底味正是
          「农家」观感的基音（四家参考站实拔全是纯白）。 */}
      <main className="bg-white dark:bg-background">
        <header className="pt-12 pb-4 sm:pt-16">
          <div className={CONTAINER}>
            <h1 className="text-[36px] font-medium leading-[1.1] tracking-[-0.02em] sm:text-[44px]">
              管理端
            </h1>
            <p className="mt-3 text-base text-muted-foreground">{account.displayName}</p>
          </div>
        </header>

        {/* ── 主操作：接入新库 ──────────────────────────────────────────
            用户 08-18 线上验收：「主要功能换库入口仍被局限在一个小框」。
            原来它是标题右边一颗 pill，和「领域泛化」并排，读起来像次级导航；
            首屏被四张对外指标卡占满，管理者进来第一眼看到的是评测数字而不是能做的事。
            现在换库独占标题正下方一条段落带，按钮是全页唯一的实心大按钮，
            三个常驻入口另设独立工作台区，与接入操作并列。
            动线：进管理端 →「接入新知识库」→ 填表「发起接入」→「确认发起」= 3 次点击。 */}
        <section className={cn('py-10 sm:py-12', BAND_SOFT)}>
          <div className={cn(CONTAINER, 'flex flex-wrap items-center justify-between gap-6')}>
            <div className="min-w-0">
              <h2 className="flex items-center gap-2.5 text-[28px] font-semibold leading-snug tracking-tight">
                <SectionAnchor icon={Upload} />
                接入新的知识库
              </h2>
              <p className="mt-3 text-sm text-muted-foreground">
                交一批文档进来，接入链跑完它就是一个能生成课程的库。
              </p>
            </div>
            <Link
              href="/admin/knowledge"
              className="inline-flex items-center gap-2.5 rounded-full bg-foreground px-7 py-3.5 text-base font-medium text-background shadow-card transition-opacity hover:opacity-90"
            >
              <Upload className="size-5" />
              接入新知识库
            </Link>
          </div>
        </section>

        {/* 常驻工作台独立成区，不依附于「接入新知识库」操作。 */}
        <section className="border-b border-border/70 py-10 sm:py-12">
          <div className={CONTAINER}>
            <h2 className="text-[28px] font-semibold leading-snug tracking-tight">管理工作台</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              接入记录、跨域体检和机构供给分别进入独立工作区。
            </p>
          </div>
          <div className={cn(CONTAINER, 'mt-6 grid gap-4 sm:grid-cols-3')}>
            {(
              [
                {
                  href: '/admin/knowledge/runs',
                  icon: History,
                  tour: 'admin-runs',
                  title: '接入记录',
                  desc: '每次投料的九站流水线直播与留档',
                },
                {
                  href: '/admin/generalization',
                  icon: Globe2,
                  tour: undefined,
                  title: '领域泛化',
                  desc: '跨域重建的指标对比与体检判词',
                },
                {
                  href: '/admin/org',
                  icon: Building2,
                  tour: 'admin-org',
                  title: '机构管理',
                  desc: '邀请码、成员名册、课程指派与库归属',
                },
              ] as const
            ).map(({ href, icon: Icon, tour, title, desc }) => (
              <Link
                key={href}
                href={href}
                data-tour={tour}
                className="group flex items-center gap-4 rounded-xl border border-border bg-white p-6 shadow-card transition-colors hover:border-foreground/30 dark:bg-background"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-blue-soft text-blue-deep dark:bg-muted dark:text-foreground">
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-lg font-semibold leading-snug">{title}</span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                    {desc}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>

        {/* 库状态是管理者进来要的第一个数字，排在主操作正下方（工单 N7 目标 2）。 */}
        <Section icon={Boxes} title="已接入语料库">
          <div data-tour="admin-corpora">
            <DomainIntakeSummary intakes={corpora} />
          </div>
          <div className="mt-4">
            <Caliber summary="展开明细：每个库的就绪度报告（九栏 + 四道闸）">
              <p>
                接入链的六站：分诊 → 切块 → 许可 → 概念词表 → 前置图 → 难度。
                换新领域时只有输入参数不同，接入链本身一个字不改——同一条链路可以直接用在别的领域上。
              </p>
              <p>
                前置边的方向精度已经量过：跨两个陌生领域抽检 21 条，正确 10 条（47.6%），
                <strong className="font-medium">没到可用线</strong>。错的几乎全是「详见 / 参见」
                这类指路型引用被当成了前置。所以这些边只作选点建议，不拦人，
                也不构成「换个领域就能教」的承诺。
              </p>
              <div className="pt-1">
                <DomainIntakeTable intakes={labeledIntakes} />
              </div>
            </Caliber>
          </div>
        </Section>

        {/* 对外指标不是管理者的决策数字，从首屏让位到主操作与库状态之后。
            卡面内容一个字没动——n、置信区间、口径原文照旧在原位。 */}
        <Section icon={Activity} title="全局指标" band={BAND_WARM}>
          <MetricBand metrics={metrics} totals={totals} />
          <Caliber summary="展开口径：这一页的数字从哪来">
            <p>
              本页数字只采用平台已归档的评测结果与当前课程审核记录；无法读取时显示「—」，
              不使用旧结果补位。每张卡均可展开查看指标口径与来源。
            </p>
          </Caliber>
        </Section>

        <Section icon={Gavel} title="资源审核账单" lead="点任意一行看逐条判词。">
          <div data-tour="admin-audit-table">
            <AdminCourseTable courses={courses} coverage={coverage} />
          </div>
          <Caliber summary="展开口径：四列数字各自的分母">
            <p>
              表按判错数降序。判错（incorrect）与存疑（uncertain）分列——两者口径不同，
              压成一个「抓错数」会抹平语义。
            </p>
            <p>
              覆盖率只对有金标清单的课出数，其余「—」；生成时长为任务实际经过时间，
              <strong className="font-medium">带并发标记的课程不能当作独占运行耗时</strong>。
            </p>
          </Caliber>
        </Section>
      </main>
    </>
  );
}
