'use client';

/**
 * 生成式课程封面：Oboe 式程序化抽象图形（规格 §4.4-4.5）。
 *
 * 组合三层：粉彩渐变底（hash→5 色系）+ 同色系 deep 大几何形（圆/半圆/环/blob/三角，
 * 部分溢出裁切）+ 白圆片图标贴纸（按课程名关键词映射，微旋转）+ 课程名前 2 字
 * 低透明度装饰大字 + 可选波点/网格纹理。
 *
 * 全部视觉参数由 hash(name) 决定：同名同图、SSR/CSR 一致，不用 Math.random。
 * 颜色走 globals.css 的 soft/deep token，暗色模式自动适配。零新依赖。
 */

import { useId } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  Bot,
  Compass,
  Database,
  Eye,
  Layers,
  Lightbulb,
  MessageSquare,
  Network,
  Puzzle,
  Rocket,
  Search,
  Shield,
  Sigma,
  Sparkles,
  TrendingDown,
  Wrench,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// E2 三轮：砍掉 yellow/red 两个暖族——公共页基底换纯白冷色系后，
// 暖粉/米黄封面在页面上跳戏（“农家”观感来源之一）。hash 稳定性只在
// 同一族清单内成立，本次是有意换清单，全站封面配色会整体重排。
const COVER_FAMILIES = ['purple', 'blue', 'green'] as const;
type CoverFamily = (typeof COVER_FAMILIES)[number];

/** 与旧版 course-card 完全相同的 hash（保证已有封面颜色不变） */
function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** 确定性伪随机序列：同一 seed 每次产出同一串数（SSR/CSR 一致） */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 课程名 hash 到五组粉彩渐变之一：soft→soft 同色系相邻双色（配方⑱） */
export function courseCoverGradient(name: string): string {
  const family = COVER_FAMILIES[hashName(name) % COVER_FAMILIES.length];
  return `linear-gradient(135deg, var(--${family}-soft), color-mix(in oklab, var(--${family}-soft) 55%, var(--background)))`;
}

/** 课程名关键词 → 图标候选（命中第一条规则即用） */
const ICON_RULES: ReadonlyArray<[RegExp, LucideIcon]> = [
  [/注意力|attention|聚焦|focus/i, Eye],
  [/梯度|下降|gradient|损失|loss|优化|反向传播/i, TrendingDown],
  [/rag|检索|retrieval|搜索|search|召回/i, Search],
  [/agent|智能体|助手|自动化/i, Bot],
  [/工具|tool|mcp|函数调用/i, Wrench],
  [/transformer|架构|层|layer|编码器|解码器/i, Layers],
  [/缓存|cache|数据库|存储|kv|向量库/i, Database],
  [/神经|网络|network|图谱/i, Network],
  [/安全|对齐|safety|隐私|防护/i, Shield],
  [/数学|概率|统计|矩阵|向量|线性代数/i, Sigma],
  [/提示|prompt|对话|聊天|上下文/i, MessageSquare],
  [/入门|基础|导论|book|课程|教程/i, BookOpen],
];

/** 未命中关键词时的通用图标池（按 hash 取） */
const FALLBACK_ICONS: readonly LucideIcon[] = [Sparkles, Lightbulb, Compass, Rocket, Puzzle, Zap];

function pickIcon(name: string, rand: () => number): LucideIcon {
  for (const [pattern, icon] of ICON_RULES) {
    if (pattern.test(name)) return icon;
  }
  return FALLBACK_ICONS[Math.floor(rand() * FALLBACK_ICONS.length)];
}

/** 白圆片图标贴纸：微旋转，暗色下走 bg-card 自动变深 */
function Sticker({
  icon: Icon,
  family,
  rotate,
  style,
}: {
  icon: LucideIcon;
  family: CoverFamily;
  rotate: number;
  style: React.CSSProperties;
}) {
  return (
    <div
      className="absolute z-[2] flex size-12 items-center justify-center rounded-full bg-card shadow-sm ring-1 ring-black/5 dark:ring-white/10"
      style={{ ...style, transform: `rotate(${rotate}deg)` }}
    >
      <Icon className="size-5" style={{ color: `var(--${family}-deep)` }} />
    </div>
  );
}

/** 课程名前 1-2 字装饰大字：低透明度、溢出裁切在角落 */
function BigLetters({
  name,
  family,
  size,
  opacity,
  style,
}: {
  name: string;
  family: CoverFamily;
  size: number;
  opacity: number;
  style: React.CSSProperties;
}) {
  const letters = Array.from(name.trim()).slice(0, 2).join('');
  if (!letters) return null;
  return (
    <span
      className="absolute z-[1] font-bold leading-none whitespace-nowrap select-none"
      style={{ ...style, fontSize: size, opacity, color: `var(--${family}-deep)` }}
    >
      {letters}
    </span>
  );
}

/** 波点/网格纹理：inline SVG pattern，currentColor 随色系走，暗色自动适配 */
function Texture({ kind, family }: { kind: 'dots' | 'grid'; family: CoverFamily }) {
  const id = useId();
  return (
    <svg
      aria-hidden
      className="absolute inset-0 h-full w-full"
      style={{ color: `var(--${family}-deep)`, opacity: 0.07 }}
    >
      <defs>
        {kind === 'dots' ? (
          <pattern id={id} width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="3" cy="3" r="1.6" fill="currentColor" />
          </pattern>
        ) : (
          <pattern id={id} width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0H0v24" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        )}
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

const TEMPLATE_COUNT = 5;

export function GenerativeCover({
  name,
  className,
}: {
  readonly name: string;
  readonly className?: string;
}) {
  const hash = hashName(name);
  const rand = mulberry32(hash);
  const family = COVER_FAMILIES[hash % COVER_FAMILIES.length];
  const template = Math.floor(rand() * TEMPLATE_COUNT);
  const Icon = pickIcon(name, rand);
  const deep = `var(--${family}-deep)`;

  // 各模板共用的确定性参数：微旋转、位置抖动、大字号与透明度
  const rotate = Math.round((rand() - 0.5) * 12); // -6°~6°
  const jx = Math.round((rand() - 0.5) * 24); // 位置抖动 ±12px
  const jy = Math.round((rand() - 0.5) * 24);
  const letterSize = 120 + Math.round(rand() * 40); // 120-160px
  const letterOpacity = 0.08 + rand() * 0.04; // 8-12%
  const shapeRotate = Math.round((rand() - 0.5) * 40); // 大形体旋转 ±20°

  return (
    <div
      aria-hidden
      data-template={template}
      data-family={family}
      className={cn('relative h-full w-full overflow-hidden', className)}
      style={{ background: courseCoverGradient(name) }}
    >
      {template === 0 && (
        <>
          {/* 模板 0「日出大圆」：大圆溢出右上角 + 左下贴纸 + 右下角大字 */}
          <div
            className="absolute rounded-full"
            style={{
              width: 170,
              height: 170,
              top: -60 + jy,
              right: -50 + jx,
              background: deep,
              opacity: 0.24,
            }}
          />
          <div
            className="absolute rounded-full"
            style={{ width: 26, height: 26, bottom: 42, right: 88 + jx, background: deep, opacity: 0.4 }}
          />
          <Sticker icon={Icon} family={family} rotate={rotate} style={{ left: 18, bottom: 26 }} />
          <BigLetters
            name={name}
            family={family}
            size={letterSize}
            opacity={letterOpacity}
            style={{ right: -14, bottom: -30 }}
          />
        </>
      )}

      {template === 1 && (
        <>
          {/* 模板 1「地平线」：波点纹理 + 底部升起的大半圆 + 左上贴纸 + 右上大字 */}
          <Texture kind="dots" family={family} />
          <div
            className="absolute"
            style={{
              width: '120%',
              height: '58%',
              left: '-10%',
              bottom: -18 + jy / 2,
              background: deep,
              opacity: 0.18,
              borderRadius: '100% 100% 0 0',
            }}
          />
          <Sticker icon={Icon} family={family} rotate={rotate} style={{ left: 20, top: 22 }} />
          <BigLetters
            name={name}
            family={family}
            size={letterSize}
            opacity={letterOpacity}
            style={{ right: -10, top: -34 }}
          />
        </>
      )}

      {template === 2 && (
        <>
          {/* 模板 2「圆环」：粗描边大环溢出左侧 + 小实心点 + 右侧贴纸 + 左下大字 */}
          <div
            className="absolute rounded-full"
            style={{
              width: 160,
              height: 160,
              left: -55 + jx,
              top: 10 + jy,
              border: `22px solid ${deep}`,
              opacity: 0.26,
            }}
          />
          <div
            className="absolute rounded-full"
            style={{ width: 18, height: 18, top: 26, right: 64 + jx / 2, background: deep, opacity: 0.45 }}
          />
          <Sticker icon={Icon} family={family} rotate={rotate} style={{ right: 22, top: '50%', marginTop: -24 }} />
          <BigLetters
            name={name}
            family={family}
            size={letterSize}
            opacity={letterOpacity}
            style={{ left: -8, bottom: -32 }}
          />
        </>
      )}

      {template === 3 && (
        <>
          {/* 模板 3「有机 blob」：网格纹理 + 不规则圆角 blob 溢出右侧 + 左下贴纸 + 左上大字 */}
          <Texture kind="grid" family={family} />
          <div
            className="absolute"
            style={{
              width: 165,
              height: 150,
              right: -50 + jx,
              top: '50%',
              marginTop: -75 + jy,
              background: deep,
              opacity: 0.22,
              borderRadius: '50% 50% 20% 80% / 55% 45% 60% 40%',
              transform: `rotate(${shapeRotate}deg)`,
            }}
          />
          <Sticker icon={Icon} family={family} rotate={rotate} style={{ left: 18, bottom: 24 }} />
          <BigLetters
            name={name}
            family={family}
            size={letterSize}
            opacity={letterOpacity}
            style={{ left: -12, top: -30 }}
          />
        </>
      )}

      {template === 4 && (
        <>
          {/* 模板 4「山坡三角」：大三角溢出左下 + 右上小圆点缀 + 右上贴纸 + 居右大字 */}
          <div
            className="absolute"
            style={{
              width: 175,
              height: 155,
              left: -45 + jx,
              bottom: -40 + jy / 2,
              background: deep,
              opacity: 0.2,
              clipPath: 'polygon(0% 100%, 45% 0%, 100% 100%)',
              transform: `rotate(${shapeRotate / 2}deg)`,
            }}
          />
          <div
            className="absolute rounded-full"
            style={{ width: 34, height: 34, top: -10, right: 96 + jx, background: deep, opacity: 0.3 }}
          />
          <Sticker icon={Icon} family={family} rotate={rotate} style={{ right: 20, top: 20 }} />
          <BigLetters
            name={name}
            family={family}
            size={letterSize}
            opacity={letterOpacity}
            style={{ right: -6, bottom: -28 }}
          />
        </>
      )}
    </div>
  );
}
