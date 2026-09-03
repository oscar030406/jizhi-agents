/**
 * 三条引导的文案与锚点。文案是定稿，锚点按真实 DOM 的 data-tour 属性找；
 * 一个锚点给多个候选选择器，按顺序取第一个命中的，别的工单挪了元素只要留着属性就不断。
 */

import type { AgentKey } from '@/components/agents/agent-avatar';
import { useSettingsStore } from '@/lib/store/settings';

export type TourId = 'landing' | 'classroom' | 'admin';

export interface TourStep {
  agent: AgentKey;
  title: string;
  text: string;
  /** 候选选择器，按顺序取第一个命中的。 */
  anchor: string[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** 这一步要访客亲手点被高亮的元素才前进；「下一步」按钮隐藏。 */
  click?: boolean;
  /** 点击时拦掉元素默认行为（徽标在课程卡的链接里，不拦会跳走）。 */
  preventDefault?: boolean;
  /** 高亮的是一个会离开本页的按钮：点了就算引导完成，放行跳转。 */
  doneOnClick?: boolean;
  /** 锚点找不到时整步跳过（如课里没有测验页）。没标的锚点要等到出现为止。 */
  optional?: boolean;
}

export interface TourSpec {
  steps: TourStep[];
  /** 等锚点出现的上限；超时后可选步被丢弃。 */
  waitMs: number;
  /** 开跑前的准备（课堂要先把两侧栏拉开）。 */
  before?: () => void;
}

export const TOURS: Record<TourId, TourSpec> = {
  landing: {
    waitMs: 15000,
    steps: [
      {
        agent: 'generation',
        title: '一句需求，一门课',
        text: '这一行就是整个系统的入口，但今天你不用等它生成，我们先带你看已经做好的。',
        anchor: ['[data-tour="hero-composer"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'diagnosis',
        title: '个性化在这一端解决',
        text: '对象、基础、目标决定难度、篇幅和例子。换个人来，同一份教材长出不一样的课。',
        anchor: ['[data-tour="learner-profile"]', '[data-tour="hero-subline"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'retrieval',
        title: '课按前置图排成阶次',
        text: '这些课按知识库的前置图排成阶次，不是人工排的。每一屏的资料只从本域知识库取，取不到就停。',
        anchor: ['[data-tour="courses"]', '#courses'],
        side: 'top',
        align: 'center',
        optional: true,
      },
      {
        agent: 'judge',
        title: '两位判官各判一次',
        text: '点一下这个徽标。两位不同厂商的判官各判一次，判词必须逐字引原文才算数；找出错在哪一句，只改那一句。',
        anchor: ['[data-tour="audit-badge"]', '#courses a[href^="/classroom/"] [data-tour="audit-badge"]'],
        side: 'right',
        align: 'start',
        click: true,
        preventDefault: true,
        optional: true,
      },
      {
        agent: 'arbiter',
        title: '吵不完的归我',
        text: '两位判官吵不完的归我。三个数字都带分子分母，点进去能复算；没过线的那个我们也照写。',
        anchor: ['[data-tour="metrics"]'],
        side: 'top',
        align: 'center',
      },
      {
        agent: 'decision',
        title: '故意答错一道题',
        text: '进去以后故意答错一道题，看课怎么为你改路。这个按钮用的是演示账号，不用注册。',
        anchor: ['[data-tour="demo-learner"]'],
        side: 'top',
        align: 'center',
        doneOnClick: true,
      },
      {
        agent: 'tutor',
        title: '管理者那一端在这里',
        text: '投料建库、指派到人、读判词放行。引导到此为止，接下来你自由逛；课堂里点『让导师考考我』能找到我。',
        anchor: ['[data-tour="demo-manager"]'],
        side: 'top',
        align: 'center',
        doneOnClick: true,
      },
    ],
  },
  classroom: {
    waitMs: 25000,
    before: () => {
      const s = useSettingsStore.getState();
      s.setSidebarCollapsed(false);
      s.setChatAreaCollapsed(false);
    },
    steps: [
      {
        agent: 'generation',
        title: '这门课的目录',
        text: '课按学习动作排：讲、练、测、补、迁移。',
        anchor: ['[data-tour="scene-list"]'],
        side: 'right',
        align: 'start',
      },
      {
        agent: 'judge',
        title: '判定徽标',
        text: '点开看判定、理由和引用的资料。',
        anchor: ['[data-tour="claim-badge"]'],
        side: 'right',
        align: 'start',
        click: true,
        optional: true,
      },
      {
        agent: 'tutor',
        title: '导师追问',
        text: '我会根据这一页追问，用你自己的话回答。',
        anchor: ['[data-tour="tutor-quiz"]'],
        side: 'left',
        align: 'center',
        optional: true,
      },
      {
        agent: 'decision',
        title: '测验页',
        text: '答错那一刻，课开始为你改路；决策依据会列出来。',
        anchor: ['[data-tour="quiz-scene"]'],
        side: 'right',
        align: 'center',
        optional: true,
      },
    ],
  },
  admin: {
    waitMs: 10000,
    steps: [
      {
        agent: 'retrieval',
        title: '已接入语料库',
        text: '知识库不是预先灌好的，管理者自己投料，体检合格才开域。',
        anchor: ['[data-tour="admin-corpora"]'],
        side: 'top',
        align: 'center',
      },
      {
        agent: 'arbiter',
        title: '接入记录',
        text: '九站流水线全程留档。',
        anchor: ['[data-tour="admin-runs"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'diagnosis',
        title: '机构管理',
        text: '名册、邀请码、课程按人指派。',
        anchor: ['[data-tour="admin-org"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'decision',
        title: '人工放行',
        text: '机器没放行的课，由责任人读完判词再决定。',
        anchor: ['[data-tour="manual-release"]', '[data-tour="admin-audit-table"]'],
        side: 'top',
        align: 'center',
        optional: true,
      },
    ],
  },
};
