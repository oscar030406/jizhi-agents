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
        title: '先不生成，看做好的',
        text: '这一行是入口：说清教给谁、教什么，系统就开始造课。今天不用等它跑完，我把做好的先给你看。',
        anchor: ['[data-tour="hero-composer"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'diagnosis',
        title: '先看人，再定课',
        text: '我先看学的人是谁、基础在哪一档、要学到什么程度，难度、篇幅和例子都从这里定。下面那块有两门真实的课作对照。',
        anchor: ['[data-tour="learner-profile"]', '[data-tour="hero-subline"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'retrieval',
        title: '课是按前置图排的',
        text: '这些课不是按时间堆的，是按知识库里概念的先后关系分了阶。每一屏的资料我只从本域教材里翻，翻不到就停。',
        anchor: ['[data-tour="courses"]', '#courses'],
        side: 'top',
        align: 'center',
        optional: true,
      },
      {
        agent: 'judge',
        title: '点一下这个徽标',
        text: '每门课每一屏都有两位不同厂商的判官各审一遍，判词得引原文才算数。点开看看他们挑出了什么、改了哪一句。',
        anchor: ['[data-tour="audit-badge"]', '#courses a[href^="/classroom/"] [data-tour="audit-badge"]'],
        side: 'right',
        align: 'start',
        click: true,
        preventDefault: true,
        optional: true,
      },
      {
        agent: 'arbiter',
        title: '数字都带分子分母',
        text: '他们俩吵不完的归我。这三个数点进去都能复算，没过线的那个我们也照实写着。',
        anchor: ['[data-tour="metrics"]'],
        side: 'top',
        align: 'center',
      },
      {
        agent: 'decision',
        title: '进去答错一道题试试',
        text: '这是演示账号，不用注册。进去随便挑一门课，故意答错一题，看看课怎么给你改路。',
        anchor: ['[data-tour="demo-learner"]'],
        side: 'top',
        align: 'center',
        doneOnClick: true,
      },
      {
        agent: 'tutor',
        title: '管理者那一端',
        text: '投料建库、课指到人、读判词放行，都在管理端。引导到这就结束了，后面你自己逛；课堂里点「让导师考考我」能找到我。',
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
        text: '左边是这门课的屏：先讲，再练，然后测，答错了补，最后换个情境用一次。',
        anchor: ['[data-tour="scene-list"]'],
        side: 'right',
        align: 'start',
      },
      {
        agent: 'judge',
        title: '点开徽标',
        text: '这句话是谁判的、依据是哪一段教材、改前改后各是什么，都在里面。',
        anchor: ['[data-tour="claim-badge"]'],
        side: 'right',
        align: 'start',
        click: true,
        optional: true,
      },
      {
        agent: 'tutor',
        title: '让我考考你',
        text: '我会就这一页追问一个问题，你用自己的话答，我逐条对照要点告诉你哪里偏了。',
        anchor: ['[data-tour="tutor-quiz"]'],
        side: 'left',
        align: 'center',
        optional: true,
      },
      {
        agent: 'decision',
        title: '答错就改路',
        text: '测验答错那一刻，我来决定下一步给你什么：换个说法重讲、补两道题，还是往前走。依据会列出来。',
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
        title: '知识库是自己投的',
        text: '三个库里两个是管理者自己接入的。投料、切分、建图、体检，合格才对学员开放。',
        anchor: ['[data-tour="admin-corpora"]'],
        side: 'top',
        align: 'center',
      },
      {
        agent: 'arbiter',
        title: '接入记录',
        text: '每次投料跑了哪几站、每站多久、卡在哪，都留着。',
        anchor: ['[data-tour="admin-runs"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'diagnosis',
        title: '名册与指派',
        text: '学员在册、邀请码、课程指到人，都在这一页。',
        anchor: ['[data-tour="admin-org"]'],
        side: 'bottom',
        align: 'center',
      },
      {
        agent: 'decision',
        title: '机器没放行的课',
        text: '拦下来的课在这里。读完判词再决定放不放；放了会记下是谁、什么时候、核对了什么。',
        anchor: ['[data-tour="manual-release"]', '[data-tour="admin-audit-table"]'],
        side: 'top',
        align: 'center',
        optional: true,
      },
    ],
  },
};
