/**
 * 概念难度档的有序色阶（L1 → L4，浅 → 深），学习路径图与难度供给共用一套。
 *
 * 为什么是单色蓝按明度分档：难度是**有序量**，不是四类互不相干的东西。
 * 原来 L1/L2/L3 用的是绿/蓝/紫三色，读起来像三个类别；而且 L4 在色表里根本没有条目
 * （知识库里 deployment 就是 L4），落到 `currentColor` 上，画出来是一条正文色的条，
 * 看着像最重要的一档，其实是「没配色」。
 *
 * 明暗两套各选各的档位——暗底上反过来「越难越亮」，不是把亮色方案翻个个儿。
 * 两套都过了 dataviz 的 ordinal 校验（单色相、明度单调、相邻 ΔL ≥ 0.06、浅端压得住底色）：
 *   亮：blue-400/500/700/900，压在 --muted 上 2.38:1
 *   暗：blue-700/500/400/200，压在暗色 --muted 上 2.21:1
 *
 * 不用 emerald/amber/sky/rose：那四个色位是判词四档的语义（见 course-table.tsx 头注），
 * 难度不是判词，借它们的色等于借它们的意思。
 */

/** SVG 用（节点左侧难度条） */
export const TIER_FILL: Record<string, string> = {
  L1: 'fill-blue-400 dark:fill-blue-700',
  L2: 'fill-blue-500 dark:fill-blue-500',
  L3: 'fill-blue-700 dark:fill-blue-400',
  L4: 'fill-blue-900 dark:fill-blue-200',
};

/** HTML 用（图例色块、难度供给的条） */
export const TIER_BG: Record<string, string> = {
  L1: 'bg-blue-400 dark:bg-blue-700',
  L2: 'bg-blue-500 dark:bg-blue-500',
  L3: 'bg-blue-700 dark:bg-blue-400',
  L4: 'bg-blue-900 dark:bg-blue-200',
};

/** 没标难度的概念不给色阶上的颜色——空着才是实话，给个颜色就等于替它定了一档 */
export const TIER_UNKNOWN_BG = 'bg-muted-foreground/30';

/**
 * 上屏的档位名。
 *
 * 内部档位码是 `L1`–`L4`（`concept_graph.json` 的 `difficulty` 字段原样），
 * 但档位码是我们内部的东西，界面上给管理者看「L3」他得先问一句这是几档。
 * 这里只做转写不做命名——「L3」→「3 级」，不给它安「进阶」「高阶」这类
 * 我们没有依据的语义标签（档位的语义边界没量过，安名字就是替数据下结论）。
 *
 * 路径图节点、图例、难度供给三处共用这一个转换，改这里三处一起变。
 */
export function tierLabel(tier: string): string {
  if (!tier || tier === '—') return '未标';
  const m = /^L(\d+)$/.exec(tier);
  return m ? `${m[1]} 级` : tier;
}
