/**
 * 教材摘录块：识别拼装模式注入的固定格式文本并做功能性渲染。
 *
 * 注入格式由 lib/generation/evidence-grounding.ts 的 injectExcerpts() 定义：
 *   「📖 {正文}\n—— 摘自《{标题}》[{source_id}]」
 *   回指行：「（本段教材前文已引用，见 [{source_id}]）」
 * 这里只做渲染层转换，不改存储数据；检测精确匹配整段格式，
 * 普通含 📖 的文本（如语料标题）不会被误伤。
 */

import type { CSSProperties } from 'react';
import { Streamdown } from 'streamdown';
import { math } from '@streamdown/math';

export type ExcerptBlockData =
  | { kind: 'excerpt'; body: string; title: string; sourceId: string }
  | { kind: 'backref'; sourceId: string };

const EXCERPT_RE = /^📖\s*([\s\S]*\S)\s*——\s*摘自《([^《》]*)》\s*\[([^\]]+)\]\s*$/;
const BACKREF_RE = /^（本段教材前文已引用，见\s*\[([^\]]+)\]）$/;

/** 纯文本 → 摘录块数据；非摘录格式返回 null。 */
export function parseExcerptBlock(text: string): ExcerptBlockData | null {
  const trimmed = text.trim();
  const excerpt = EXCERPT_RE.exec(trimmed);
  if (excerpt) {
    return { kind: 'excerpt', body: excerpt[1], title: excerpt[2], sourceId: excerpt[3] };
  }
  const backref = BACKREF_RE.exec(trimmed);
  if (backref) {
    return { kind: 'backref', sourceId: backref[1] };
  }
  return null;
}

/** 元素 HTML content → 纯文本（块级闭合与 <br> 转换行，实体解码），再走 parseExcerptBlock。 */
export function parseExcerptFromHtml(html: string): ExcerptBlockData | null {
  if (!html.includes('📖') && !html.includes('本段教材前文已引用')) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return parseExcerptBlock(text);
}

const badgeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '0.7em',
  padding: '0 0.35em',
  borderRadius: '4px',
  border: '1px solid var(--blue-deep)',
  color: 'var(--blue-deep)',
  whiteSpace: 'nowrap',
};

// ── 摘录正文富渲染 ─────────────────────────────────────────────────────
//
// 教材语料本身就是 markdown。这里原本是一段手搓的转换：按 ``` 围栏切段 + KaTeX 处理
// $..$（08-03 修的是「公式 LaTeX 裸奔、围栏符号露出」两处实拍）。问题是它只覆盖了
// 两种构件，其余全部字面显示——2026-08-13 首页实拍 `**先修建议**`。
//
// 把 126 个已落库的摘录块数一遍，构件分布是：
//   `code` 65% · ``` 围栏 52% · **粗体** 37% · - 列表 26% · 1. 列表 15%
//   # 标题 13% · *斜体* 12% · [链接]() 12% · $公式$ 11% · 表格 2%
// 手搓那版只接住了围栏和公式两项。继续往正则里加就是重写一个 markdown 解析器，
// 所以改成复用站内已有的渲染器：`streamdown` + `@streamdown/math`，
// 与 `components/generation/live-lecture-draft.tsx` 同一套用法（那边也没引 styles.css）。
//
// 掉了什么：围栏原本是深底 `<pre>`（#332f2b），现在跟站内其他 markdown 一致。
// 换来的是另外六种构件不再裸奔，这笔划算。

/**
 * CommonMark 的 flanking 规则在中文标点上不闭合强调：`**要点**：` 里右侧的 `**`
 * 前面是汉字（非标点）、后面是全角冒号（标点），两个条件都不满足 right-flanking，
 * 于是整对星号原样留在正文里。换任何合规的 markdown 解析器都一样，不是 streamdown 的锅。
 *
 * 这不是边角情况：已落库的 126 个摘录块里 173 处粗体，**107 处（62%）紧跟中文标点**
 * ——教材写「1. **通用评测集**：」这种句式是常态。只换渲染器只能救回 38%。
 *
 * 只对**确实闭合不了**的那一类做定点替换（后面紧跟中文标点的），
 * 正常闭合的 66 处不碰，交给解析器照常走。streamdown 自带 rehype-raw + rehype-sanitize，
 * strong/em 属于白名单标签。
 */
const CJK_PUNCT = '。，：；！？、）》」』】…';
const CJK_BOLD = new RegExp(`\\*\\*([^*\\n]+)\\*\\*(?=[${CJK_PUNCT}])`, 'g');
const CJK_ITALIC = new RegExp(`(?<!\\*)\\*([^*\\n]+)\\*(?=[${CJK_PUNCT}])`, 'g');

function closeCjkEmphasis(md: string): string {
  return md.replace(CJK_BOLD, '<strong>$1</strong>').replace(CJK_ITALIC, '<em>$1</em>');
}

/** 摘录正文：整段交给站内 markdown 渲染器，数学走 math 插件。 */
function ExcerptBody({ body }: { readonly body: string }) {
  return (
    <Streamdown
      plugins={{ math }}
      // 摘录盒子矮，块间距按 0.5em 收紧；首尾去边距免得盒内上下留白不均
      className="[&_*]:!leading-relaxed [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0 [&>*]:!my-2 [&_li]:!my-0.5 [&_h1]:!text-[1.1em] [&_h2]:!text-[1.05em] [&_h3]:!text-[1em]"
    >
      {closeCjkEmphasis(body)}
    </Streamdown>
  );
}

/** 摘录块 / 回指行的只读渲染。 */
export function ExcerptBlockView({ block }: { readonly block: ExcerptBlockData }) {
  if (block.kind === 'backref') {
    return (
      <p
        style={{ fontSize: '0.75em', fontStyle: 'italic', color: 'var(--muted-foreground)' }}
      >
        本段教材前文已引用，见 <span style={badgeStyle}>{block.sourceId}</span>
      </p>
    );
  }
  return (
    <blockquote
      style={{
        borderLeft: '3px solid var(--blue-deep)',
        background: 'var(--blue-soft)',
        color: 'var(--foreground)',
        borderRadius: '0 6px 6px 0',
        padding: '0.6em 0.8em',
        // 右/上/下三边原来没有任何界线，块底与页底实测只差 1.09:1（亮）/ 1.37:1（暗），
        // 整块几乎是「浮」在正文里的。补一圈 inset 细描边把边界画出来——
        // 用 inset box-shadow 而不是 border，是因为这个盒子在幻灯片画布上是定高的
        // （注入端按盒预算裁过字），加真 border 会多吃 2px 高度把最后一行挤没。
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--blue-deep) 26%, transparent)',
        // 评点本人文层（§0-bis 署名与出处律）：教材原文走衬线，与讲义正文
        // （黑体系）在字形上区分「引的」和「写的」；代码围栏仍是等宽不受影响。
        fontFamily:
          "Georgia, 'Times New Roman', 'Source Han Serif SC', 'Noto Serif SC', SimSun, serif",
        // 盒内弹性布局：正文吃剩余空间、溢出裁掉，出处行永远可见。
        // 注入端已按盒预算裁字（evidence-grounding.ts），这里是兜底——
        // 宁可正文少一行，不能让整块滑出画布把出处也带走。
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* 交给 markdown 渲染器之后不能再留 pre-wrap：块级元素自带换行，
          两者叠加会把每个段落之间的空行再翻一倍。 */}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
        <ExcerptBody body={block.body} />
      </div>
      <div
        style={{
          marginTop: '0.5em',
          textAlign: 'right',
          fontSize: '0.75em',
          fontStyle: 'italic',
          color: 'var(--blue-deep)',
          flexShrink: 0,
        }}
      >
        —— 摘自《{block.title}》 <span style={badgeStyle}>{block.sourceId}</span>
      </div>
    </blockquote>
  );
}
