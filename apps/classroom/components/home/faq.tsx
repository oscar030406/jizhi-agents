'use client';

/**
 * 公共页 FAQ 五问（public-site-redesign §1）。原生 <details> 手风琴，零依赖。
 *
 * 答案里的数字与 apps/agent-engine/data/metrics.json 真源一致（api_hallucination_v2：
 * 576 条可核断言 / 57 个真 LLM run / 12 条判无据 / 2.08%），改数先改真源。
 * 首页只写分子分母这一层，区间与覆盖限制在 /evidence 的台账里，本页不复述术语。
 */

import { ChevronDown } from 'lucide-react';

const FAQS = [
  {
    q: '这些课真的是 AI 生成的吗？',
    a:
      '是。每门课都由多智能体流水线生成，第一屏几分钟内就绪、其余场景在你学习时继续生成。审核智能体的核验记录跟着课走：' +
      '课程卡上「审核 N 条断言」「审核打回 M 条」的角标，进入课程后可详细查看。',
  },
  {
    q: '课程内容的数据从哪来？',
    a:
      '事实来源限定在入库的受控教材：检索智能体先圈出相关段落，生成智能体只在这个范围内写讲义，' +
      '教材原文以摘录块嵌进正文并标注出处。你自己的学习数据去向另见「隐私与数据」页。',
  },
  {
    q: 'AI 幻觉怎么治？',
    a:
      '生成后逐条抽出可核事实断言，交两个不同厂商的审核智能体互不通气各自核验，分歧升级仲裁终审，' +
      '判错触发定向重写后复审。自己测过一轮：57 次真实生成里抽出 576 条可核陈述逐条对教材核验，' +
      '12 条在教材里找不到依据，占 2.08%。这个数覆盖了什么、没覆盖什么，证据页里写清楚了。',
  },
  {
    q: '不同人看到的课为什么不一样？',
    a:
      '生成前会读学习者画像：背景、目标和前测结果。同一句需求，对不同画像生成的讲解深度、' +
      '类比和练习都不同。「课程对比」页把两份画像的真实产出并排对照，差异处有手绘标注。',
  },
  {
    q: '免费吗？',
    a:
      '浏览已生成的课不需要登录，也不收费。当场生成一门课要真实调用多个大模型（第一屏几分钟内可看，全课在后台陆续完成），' +
      '所以只对登录用户开放，在登录后的工作台发起。',
  },
] as const;

export function FaqSection() {
  return (
    <>
      <h2 className="text-[28px] font-semibold leading-snug">常见疑问</h2>
      <div className="mt-3">
        {FAQS.map((item) => (
          // 内边距原来挂在 details 上，可点的 summary 只有 20px 高——视觉上一整块，
          // 实际能点的只有中间那一行。把 py 移到 summary 自己身上，点击区就等于看到的区域
          // （也顺带过了 24px 的点击目标线）。
          <details key={item.q} className="group border-b border-border">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-4 text-sm font-semibold focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
              {item.q}
              <ChevronDown
                className="size-4 shrink-0 text-muted-foreground transition-transform duration-fast group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <p className="mb-4 max-w-3xl text-sm leading-[1.75] text-muted-foreground">{item.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}
