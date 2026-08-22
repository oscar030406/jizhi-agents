/**
 * Agent 拟人化头像 —— 手写国风简笔 SVG，零依赖。
 *
 * 七个 Agent 各绑一色一符号（色彩编码：绿诊断/蓝检索/紫生成/黄判官/橙仲裁/
 * 青决策/粉导学）。统一模板：soft 色圆脸 + deep 色眼睛腮红 + 国风头饰
 * （双髻/发髻加簪/方巾/幞头帽翅/花钿）+ 职责符号（听诊弧线/放大镜/铅笔三角/
 * 天平/印章/分叉路/问号）。风格对齐用户数字人卡通参考图的气质：圆润简笔、
 * 粗圆线、腮红亲和，不做复杂插画。颜色走 globals.css 语义变量，明暗模式
 * 自动跟随；橙/青/粉三档 globals 没有，用 color-mix 从现有 deep/soft 调出。
 */

import type { SVGProps } from 'react';

export type AgentKey =
  | 'diagnosis'
  | 'retrieval'
  | 'generation'
  | 'judge'
  | 'arbiter'
  | 'decision'
  | 'tutor';

export interface AgentPersona {
  /** 拟人名 */
  name: string;
  /** 对应的 Agent 职责名 */
  role: string;
  /** 口头禅（师门口气，不是产品标语） */
  motto: string;
  /** 圆脸底色（soft） */
  soft: string;
  /** 五官/头饰/符号色（deep） */
  deep: string;
}

export const AGENT_PERSONAS: Record<AgentKey, AgentPersona> = {
  diagnosis: {
    name: '阿诊',
    role: '学情诊断',
    motto: '别慌，我先看看你卡在哪',
    soft: 'var(--green-soft)',
    deep: 'var(--green-deep)',
  },
  retrieval: {
    name: '阿检',
    role: '知识检索',
    motto: '书上哪一页写的，我给你翻出来',
    soft: 'var(--blue-soft)',
    deep: 'var(--blue-deep)',
  },
  generation: {
    name: '阿讲',
    role: '内容生成',
    motto: '多难的东西，掰开了揉碎了给你讲',
    soft: 'var(--purple-soft)',
    deep: 'var(--purple-deep)',
  },
  judge: {
    name: '阿审',
    role: '审核',
    motto: '话要有出处，才立得住',
    soft: 'var(--yellow-soft)',
    deep: 'var(--yellow-deep)',
  },
  arbiter: {
    name: '阿裁',
    role: '仲裁',
    motto: '他俩吵不完的，到我这儿一锤定音',
    // globals 无橙：黄向红混出一档，明暗模式各自成立
    soft: 'color-mix(in srgb, var(--yellow-soft) 55%, var(--red-soft))',
    deep: 'color-mix(in srgb, var(--yellow-deep) 60%, var(--red-deep))',
  },
  decision: {
    name: '阿路',
    role: '反馈决策',
    motto: '这道坎迈不过去，咱换条道再上',
    // 青/蓝绿：蓝向绿混
    soft: 'color-mix(in srgb, var(--blue-soft) 55%, var(--green-soft))',
    deep: 'color-mix(in srgb, var(--blue-deep) 55%, var(--green-deep))',
  },
  tutor: {
    name: '阿问',
    role: '导学',
    motto: '答案不白给，我问着问着你就会了',
    // 粉/紫粉：紫向红混
    soft: 'color-mix(in srgb, var(--purple-soft) 55%, var(--red-soft))',
    deep: 'color-mix(in srgb, var(--purple-deep) 55%, var(--red-deep))',
  },
};

/**
 * 定稿立绘（public/agents/，rembg 去底 + 调色板压缩，透明底）。
 * bust=半身（方图，UI 头像）；full=全身立绘；actions=三动作分镜横条（2172×724）；
 * acts=分镜切出的单帧（高统一 512，宽各异 213~512，所以用固定高度+宽度自适应渲染）。
 * 审核是双胞胎设定：bust 有甲乙两张，全身与分镜只出了甲（乙与甲同衣异徽，小尺寸分不出）。
 * 小尺寸（≤40px）场景继续用下面的手写 SVG——真图缩到 32px 会糊，SVG 还能跟主题色。
 */
export const AGENT_ART: Record<
  AgentKey,
  { bust: string; full?: string; actions?: string; bustB?: string; acts?: [string, string, string] }
> = {
  diagnosis: {
    bust: '/agents/azhen-bust.png',
    full: '/agents/azhen-full.png',
    actions: '/agents/azhen-actions.png',
    acts: ['/agents/azhen-act1.png', '/agents/azhen-act2.png', '/agents/azhen-act3.png'],
  },
  retrieval: {
    bust: '/agents/ajian-bust.png',
    full: '/agents/ajian-full.png',
    actions: '/agents/ajian-actions.png',
    acts: ['/agents/ajian-act1.png', '/agents/ajian-act2.png', '/agents/ajian-act3.png'],
  },
  generation: {
    bust: '/agents/ajiang-bust.png',
    full: '/agents/ajiang-full.png',
    actions: '/agents/ajiang-actions.png',
    acts: ['/agents/ajiang-act1.png', '/agents/ajiang-act2.png', '/agents/ajiang-act3.png'],
  },
  judge: {
    bust: '/agents/ashen-a-bust.png',
    bustB: '/agents/ashen-b-bust.png',
    full: '/agents/ashen-a-full.png',
    actions: '/agents/ashen-a-actions.png',
    acts: ['/agents/ashen-a-act1.png', '/agents/ashen-a-act2.png', '/agents/ashen-a-act3.png'],
  },
  arbiter: {
    bust: '/agents/acai-bust.png',
    full: '/agents/acai-full.png',
    actions: '/agents/acai-actions.png',
    acts: ['/agents/acai-act1.png', '/agents/acai-act2.png', '/agents/acai-act3.png'],
  },
  decision: {
    bust: '/agents/alu-bust.png',
    full: '/agents/alu-full.png',
    actions: '/agents/alu-actions.png',
    acts: ['/agents/alu-act1.png', '/agents/alu-act2.png', '/agents/alu-act3.png'],
  },
  tutor: {
    bust: '/agents/awen-bust.png',
    full: '/agents/awen-full.png',
    actions: '/agents/awen-actions.png',
    acts: ['/agents/awen-act1.png', '/agents/awen-act2.png', '/agents/awen-act3.png'],
  },
};

/** 国风头饰：双丸子髻 */
const BUNS = (
  <>
    <circle cx={13} cy={9.5} r={4} fill="currentColor" stroke="none" />
    <circle cx={35} cy={9.5} r={4} fill="currentColor" stroke="none" />
  </>
);

/** 国风头饰 + 点缀，按 agent 变体（统一圆润简笔，不做复杂插画）。 */
const HEADS: Record<AgentKey, React.ReactNode> = {
  // 双丸子髻
  diagnosis: BUNS,
  // 发髻 + 斜簪（翻书的书生气）
  retrieval: (
    <>
      <circle cx={24} cy={6.5} r={4.5} fill="currentColor" stroke="none" />
      <path d="M 27.5 5 L 35.5 2.5" />
    </>
  ),
  // 方巾（讲学先生）
  generation: (
    <rect x={15} y={3.5} width={18} height={6} rx={2.5} fill="currentColor" stroke="none" />
  ),
  // 幞头帽 + 两侧帽翅（判官）
  judge: (
    <>
      <rect x={15.5} y={3.5} width={17} height={6} rx={2.5} fill="currentColor" stroke="none" />
      <path d="M 14.5 6.5 H 7.5 M 33.5 6.5 H 40.5" />
    </>
  ),
  // 高髻 + 反向簪（得比判官压得住场）
  arbiter: (
    <>
      <circle cx={24} cy={6} r={5} fill="currentColor" stroke="none" />
      <path d="M 20.5 4.5 L 12.5 2" />
    </>
  ),
  // 双丸子髻
  decision: BUNS,
  // 双丸子髻 + 眉心花钿
  tutor: (
    <>
      {BUNS}
      <path d="M 24 13.2 L 25.6 15 L 24 16.8 L 22.4 15 Z" fill="currentColor" stroke="none" />
    </>
  ),
};

/** 职责符号，占脸下半区（嘴的位置），线条统一圆帽圆角。 */
const MARKS: Record<AgentKey, React.ReactNode> = {
  // 听诊弧线 + 听诊头
  diagnosis: (
    <>
      <path d="M 17 32 Q 24 38.5 31 32.5" />
      <circle cx={31.8} cy={32} r={1.9} fill="currentColor" stroke="none" />
    </>
  ),
  // 放大镜
  retrieval: (
    <>
      <circle cx={21.5} cy={32} r={3.4} />
      <path d="M 24.2 34.7 L 28.5 38.5" />
    </>
  ),
  // 铅笔尖三角
  generation: <polygon points="19.5,31 28.5,31 24,38" fill="currentColor" strokeWidth={2} />,
  // 天平横梁
  judge: <path d="M 16 31.5 H 32 M 24 31.5 V 36.5" />,
  // 印章方
  arbiter: <rect x={19.5} y={30} width={9} height={7.5} rx={2} fill="currentColor" stroke="none" />,
  // 分叉路
  decision: <path d="M 24 38 V 33.5 M 24 33.5 L 20 30 M 24 33.5 L 28 30" />,
  // 问号
  tutor: (
    <>
      <path d="M 21 30.8 Q 21 28.3 24 28.3 Q 27 28.3 27 30.6 Q 27 32.4 24 33 L 24 34.3" />
      <circle cx={24} cy={37.1} r={1.6} fill="currentColor" stroke="none" />
    </>
  ),
};

export function AgentAvatar({
  agent,
  size = 32,
  ...rest
}: { agent: AgentKey; size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  const p = AGENT_PERSONAS[agent];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={`${p.name}（${p.role} Agent）`}
      {...rest}
    >
      {/* 圆脸下移，给头饰留位 */}
      <circle
        cx={24}
        cy={26.5}
        r={19}
        strokeWidth={1.5}
        style={{ fill: p.soft, stroke: p.deep, strokeOpacity: 0.35 }}
      />
      <g
        style={{ color: p.deep }}
        stroke="currentColor"
        fill="none"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {HEADS[agent]}
        {/* 眼睛 + 腮红（参考图的 chibi 亲和感） */}
        <circle cx={17.5} cy={23} r={2.3} fill="currentColor" stroke="none" />
        <circle cx={30.5} cy={23} r={2.3} fill="currentColor" stroke="none" />
        <circle cx={13.5} cy={28} r={2} fill="currentColor" stroke="none" opacity={0.25} />
        <circle cx={34.5} cy={28} r={2} fill="currentColor" stroke="none" opacity={0.25} />
        {MARKS[agent]}
      </g>
    </svg>
  );
}
