'use client';

/**
 * 机制三卡「我们为什么可信」（public-site-redesign §1；标题与位置按
 * landing-fusion-brief-20260815 §4 改，本区在课程墙与指标之后，不再是首屏第二块）。
 *
 * 每卡 = 概念插图 + 主张一句 + 依据一句。依据写的是流水线里真实发生的事，
 * 不写形容词——数字都有口径，见首页「相关指标」与 /evidence 的完整台账。
 * 插图是定稿资产（public/illustrations/README.md），语义与卡一一对应，
 * 装饰性图片 alt 留空、aria-hidden，读屏不重复念主张。
 */

import { ShieldCheck } from 'lucide-react';

import { CARD_RECIPE_STATIC } from '@/components/home/course-card';
import { SectionAnchor } from '@/components/home/section-anchor';

const MECHANISMS = [
  {
    art: '/illustrations/ill-kb-intake.png',
    title: '受控教材接地',
    claim: '只从选定的教材取材。',
    basis:
      '检索智能体先从入库教材里挑出相关段落，生成智能体只在这个范围内写讲义；教材原文以摘录块嵌进正文并标注出处。',
  },
  {
    art: '/illustrations/ill-dual-audit.png',
    title: '双审核智能体辩论',
    claim: '每条断言过两道独立核验。',
    basis:
      '两个审核智能体来自不同厂商，互不通气各自判定；一致才算共识，分歧升级仲裁终审，判错触发定向重写后复审。',
  },
  {
    art: '/illustrations/ill-provenance.png',
    title: '出处逐句可查',
    claim: '审核记录跟着课走。',
    basis:
      '课程卡上「审核 N 条断言 / 审核打回 M 条 / 引用 K 段教材」取自那一次生成的真实记录，进入课程后可详细查看。',
  },
] as const;

export function MechanismCards() {
  return (
    <>
      <h2 className="flex items-center gap-2.5 text-[28px] font-semibold leading-snug">
        <SectionAnchor icon={ShieldCheck} />
        我们为什么可信
      </h2>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {MECHANISMS.map((m) => (
          <div key={m.title} className={`${CARD_RECIPE_STATIC} p-5`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 静态定稿插图 */}
            <img
              src={m.art}
              alt=""
              aria-hidden
              loading="lazy"
              className="mx-auto h-28 w-auto object-contain"
            />
            <h3 className="mt-3 text-sm font-semibold">{m.title}</h3>
            <p className="mt-1 text-sm text-foreground/85">{m.claim}</p>
            <p className="mt-2 text-xs leading-[1.75] text-muted-foreground">{m.basis}</p>
          </div>
        ))}
      </div>
    </>
  );
}
