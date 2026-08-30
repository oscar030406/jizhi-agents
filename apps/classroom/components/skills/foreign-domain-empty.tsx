'use client';

/**
 * 非 AI 域的岗位技能页空态（D2）。
 *
 * 原来的形态是「一条注记 + 照常展示整张 AI 岗位图谱」。用户点名这个例子：
 * 学习者的画像选的是智能制造，页面却摆着一整套 AI 岗位的技能要求，
 * 顶上一行小字说「本页覆盖人工智能应用开发领域」。
 *
 * **那比什么都不显示更糟**——注记会被略过，图谱不会。学习者据此规划自己的
 * 学习方向，而那些岗位跟他的领域毫无关系。
 *
 * 所以非 AI 域直接换成空态主体，如实说清这个领域没有岗位要求数据。
 *
 * 文案里这句「管理员可以补传岗位/技能清单」是 2026-08-30 才敢重新写上的：在那之前
 * 写入侧恒为 None（管理端没有这一格，引擎也不收），许诺一个点不到的操作比直说没有更糟。
 * 现在这条路是通的——管理端「发起接入」表单有「岗位/技能要求」一格，引擎
 * `intake_routes.parse_job_requirements` 校形状后进 run options，⑧ 站写进域注册清单。
 * **但只有接入建库那一次能投**：追加文档不重算注册清单（引擎会当场拒），所以下面
 * 写的是「接入知识库时」，不是「随时可以补传」。这句话跟着代码走，那条路要是又断了，
 * 这里也要跟着改回去。
 *
 * 主域 AI 的岗位图谱来自几十 GB 招聘数据集 + 人工提炼，新库现场复刻不了——
 * 从语料硬派生只会造出看起来合理的假岗位，那比空着危险得多。
 */
import Link from 'next/link';
import { Briefcase, ArrowLeft } from 'lucide-react';

export function ForeignDomainEmpty({ label, reason }: { label: string; reason?: string }) {
  return (
    <section className="rounded-xl border border-border bg-surface px-6 py-10 text-center">
      <Briefcase className="mx-auto size-8 text-muted-foreground/60" />
      <h2 className="mt-4 text-base font-medium text-foreground">
        「{label}」还没有岗位要求数据
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {/* 引擎说得清楚就用引擎的原话，不改写、不润色——它知道这个域缺的到底是什么。 */}
        {reason ??
          '这个领域接入知识库时没有随附岗位／技能清单，所以这一页没有可列的岗位。个性化目前基于学情画像与语料结构，没有岗位维度的锚点。'}
      </p>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        现在能做的：回首页按课程逐门学，课程仍然只用这个领域的语料生成；
        该领域如果已经发布过实操项目，会列在本页上方。两条路都不依赖岗位数据。
      </p>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        想让这一页有岗位：管理员在给这个领域<strong className="font-medium">接入知识库时</strong>
        随附一份岗位/技能清单（发起接入表单里的「岗位/技能要求」一格），
        建成后这一页就按那份清单列岗位，并逐条标出本领域语料有没有对应的教材。
        已经建好的库要补这份清单，得在整库重建时投——往库里追加文档不会重算它。
      </p>
      <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground/80">
        这里不展示其它领域的岗位图谱——那些要求与你正在学的领域无关，
        摆在这里只会误导学习方向。
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm transition-colors hover:bg-accent"
        >
          <ArrowLeft className="size-3.5" />
          回首页看这个领域的课程
        </Link>
        {/* 画像弹层在首页右侧，没有独立 /profile 路由——原先链过去是 404（08-28 线上实走逮到）。 */}
        <Link
          href="/"
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          或回首页在画像里把知识库换回「跟随培训领域」
        </Link>
      </div>
    </section>
  );
}
