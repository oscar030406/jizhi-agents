'use client';

/**
 * 区 B'「系统的六项能力」枢纽区。
 *
 * 规格：docs/03-design/ui/public-site-redesign-20260809.md §2——六卡，每卡
 * 标题 → 机制一句话 → 真实数字 → 链到证据页（2026-08-10 文案去 AI 味批：
 * 赛题引文行删除，赛题映射只留在答辩材料）。
 *
 * 数字纪律：
 * - 卡 1（场景与适配）2026-08-16 改指学情报告的「你的课为什么长这样」：同题异人从
 *   独立对比页拆散内嵌后，访客能在自己那门课上看到定制归因，比看一个抽象的双人对照
 *   更直接。它原来那行数字读的是 /compare-showcase.json 的 differences.length，
 *   而报告是逐人生成的、没有对应的全站数字，所以这张卡改成不带数字：拿对照页的数字
 *   去标一个指向报告页的链接是错的归属；
 * - 卡 4 的断言/打回数由调用方从课程清单接口的 audit 现算后传进来（口径见
 *   lib/server/classroom-storage.ts 的 summarizeAudit：claims=Σ totalClaims，
 *   flagged=Σ 判定非 supported 的断言）。2026-08-13 之前这里手抄着「6 门课 536 条
 *   断言，122 条打回」，示例课重生成后没人回来改，实测已对不上（当时落盘 23 门课
 *   2231/587），所以改成现算，拿不到就不显示这一行；
 * - 卡 6 的覆盖率与区 E 台账同源（metrics.json：14 岗位 150 条技能，覆盖 51.3%）。
 */

import Link from 'next/link';
import { Briefcase, Gavel, GitCompareArrows, Route, ShieldCheck, Workflow } from 'lucide-react';

import { CARD_RECIPE } from '@/components/home/course-card';
import { cn } from '@/lib/utils';

interface RequirementCard {
  icon: typeof Gavel;
  /** 粉彩圆片配色（Tailwind 类必须写死，动态拼接会被 JIT 丢弃） */
  chip: string;
  title: string;
  mechanism: string;
  /** 真实数字/事实行；null 表示该卡数字来自运行时（见 runtime） */
  fact: string | null;
  /** 运行时数字的来源；对应的数据拿不到时整行不显示 */
  runtime?: 'audit';
  href: string;
}

/** 落盘课程的审核汇总，由调用方从 /api/classroom 现算后传入。 */
export interface CourseAuditTotals {
  courses: number;
  claims: number;
  flagged: number;
}

const CARDS: RequirementCard[] = [
  {
    icon: GitCompareArrows,
    chip: 'bg-blue-soft text-blue-deep',
    title: '场景与适配',
    mechanism: '同一个学习目标，换一份学习者画像就生成另一门课：难度、例子取材、代码配比都跟着变。',
    fact: '学情报告逐条说明每处定制来自画像的哪个字段',
    href: '/report#why-this-course',
  },
  {
    icon: Workflow,
    chip: 'bg-purple-soft text-purple-deep',
    title: '协同闭环',
    mechanism: '七个职责分明的智能体：检索接地 → 生成 → 双审核智能体核验 → 仲裁裁决。',
    fact: '每门课的执行轨迹逐步可查',
    href: '/agents',
  },
  {
    icon: Route,
    chip: 'bg-green-soft text-green-deep',
    title: '决策与反馈',
    // 「自动跳过」是过头话：只有交互式生成那条路传掌握度（服务端批量路径
    // classroom-generation.ts:481-491 传的是 undefined），判据也是单一阈值 0.7。
    // 改法照 docs/05-evidence/external-claims-redlines-20260813.md §7.2。
    mechanism: '测验结果回写学习者画像，下一门课生成时跳过已达标的部分（阈值 0.7）。',
    fact: '样例报告页含三张真实数据图',
    href: '/demo/report',
  },
  {
    icon: Gavel,
    chip: 'bg-red-soft text-red-deep',
    title: '辩论消幻觉',
    mechanism: '两个不同厂商的审核智能体逐条核验，判定分歧升级仲裁终审。',
    fact: null,
    runtime: 'audit', // 落盘课程的断言/打回汇总，由 audit 入参给
    href: '/evidence#audit-showcase',
  },
  {
    icon: ShieldCheck,
    chip: 'bg-yellow-soft text-yellow-deep',
    title: '数据合规',
    mechanism: '画像存在本地或本人账户；隐私说明按当前部署的实际配置生成。',
    fact: '披露页与实际存储配置同源',
    href: '/privacy',
  },
  {
    icon: Briefcase,
    chip: 'bg-blue-soft text-blue-deep',
    title: '行业延伸',
    mechanism: '岗位技能地图把课程内容对到真实岗位的技能要求上。',
    fact: '14 个岗位 150 条技能，证据覆盖率 51.3%',
    href: '/skills',
  },
];

export function SixRequirementsSection({ audit }: { audit?: CourseAuditTotals | null }) {
  return (
    // 段间距由 public-landing 的 SECTION 统一给（原来这里自带 mt-16，
    // 和外面的 py-14 叠出一个和别的段不一样的间距）
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">系统的六项能力</h2>
        <p className="text-xs text-muted-foreground">
          每项附机制说明与实测数字，点进去是完整记录
        </p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => {
          const Icon = card.icon;
          const runtimeFact =
            card.runtime === 'audit' && audit
              ? `${audit.courses} 门课 ${audit.claims} 条断言核验，${audit.flagged} 条被审核打回`
              : null;
          const fact = card.fact ?? runtimeFact;
          return (
            <Link
              key={card.title}
              href={card.href}
              className={cn(CARD_RECIPE, 'flex flex-col gap-2.5 p-5')}
              aria-label={`${card.title}：查看证据`}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-full',
                    card.chip,
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="text-sm font-semibold">{card.title}</span>
              </div>
              <p className="text-sm leading-relaxed">{card.mechanism}</p>
              {fact && <p className="text-sm font-medium tabular-nums">{fact}</p>}
              <span className="mt-auto pt-1 text-xs text-muted-foreground">查看证据 →</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
