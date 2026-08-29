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
 * 所以非 AI 域直接换成空态主体，如实说清两件事：这个领域没有岗位要求数据、
 * 这件事怎么补（管理员在接入时传一份岗位/技能要求文件）。
 *
 * 主域 AI 的岗位图谱来自几十 GB 招聘数据集 + 人工提炼，新库现场复刻不了——
 * 从语料硬派生只会造出看起来合理的假岗位，那比空着危险得多。
 */
import Link from 'next/link';
import { Briefcase, ArrowLeft } from 'lucide-react';

export function ForeignDomainEmpty({ label }: { label: string }) {
  return (
    <section className="rounded-xl border border-border bg-surface px-6 py-10 text-center">
      <Briefcase className="mx-auto size-8 text-muted-foreground/60" />
      <h2 className="mt-4 text-base font-medium text-foreground">
        「{label}」还没有岗位要求说明
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        这个领域的个性化目前基于学情画像与语料结构，没有岗位维度的锚点。
        管理员在接入知识库时可以补传一份岗位／技能要求文件，之后这一页会按那份文件
        列出岗位与对应能力项。
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
