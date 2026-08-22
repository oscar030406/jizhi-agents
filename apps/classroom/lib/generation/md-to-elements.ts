/**
 * 讲义 markdown → 单栏幻灯片 DSL（text 元素序列，top 递增假布局）。
 *
 * 为什么走 DSL 容器而不是直存 md：injectExcerpts（按盒预算裁字）、幻觉审核门、
 * KR2 可执行验算、教师 Pro 编辑器、PPTX 导出全部吃 elements——转成 text 元素
 * 序列后这五条链路零改动兼容。单栏布局天然没有双栏线性化交错的 hazard。
 *
 * 支持的 md 子集与生成端提示词（lecture-scene-content）约定一致：
 * ###/#### 小标题、段落、- 列表、``` 代码围栏、$..$/$$..$$ 公式、
 * **粗体**、`行内代码`、独立成行的 {{摘录:id}} 占位符。
 */

import katex from 'katex';
import { codeLineHtml, linesFor, textHeight } from './slide-templates';

interface El {
  [k: string]: unknown;
}

export interface LectureSlide {
  background: { type: 'solid'; color: string };
  elements: El[];
}

// 与 slide-templates 同一画布口径
const MARGIN = 60;
const CONTENT_W = 880;
const GAP = 14;

const C = {
  bg: '#fdfbf7',
  title: '#332f2b',
  body: '#45403a',
  codeBg: '#332f2b',
  codeFg: '#e8e4dd',
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 数学段占位哨兵：NUL 包夹的序号。正文不可能含 NUL，裸数字（"共 3 行"）不会被误吞。
const SENTINEL = String.fromCharCode(0);
const SENTINEL_RE = new RegExp(`${SENTINEL}([0-9]+)${SENTINEL}`, 'g');

/** 行内变换：先摘出数学段防止转义，其余转义后应用粗体/行内代码。 */
function inline(raw: string): string {
  const parts: string[] = [];
  // $...$ 内联公式（不跨行，不允许空内容）
  const withMath = raw.replace(/\$([^$\n]+)\$/g, (_m, f: string) => {
    parts.push(katex.renderToString(f, { throwOnError: false, output: 'html' }));
    return `${SENTINEL}${parts.length - 1}${SENTINEL}`;
  });
  const html = esc(withMath)
    // 行内图片语法剥掉只留替代文字（模型没有配图能力，编出来的外链一律不渲染）
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // 单星斜体（用户实拍：*x轴：…* 整段星号裸奔）。放在粗体之后，剩余成对单星才算
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(
      /`([^`]+)`/g,
      '<code style="font-family: Consolas, monospace; background: #f0ebe2; padding: 0 3px; border-radius: 3px;">$1</code>',
    );
  return html.replace(SENTINEL_RE, (_m, i: string) => parts[Number(i)] ?? '');
}

const EXCERPT_LINE = /^\{\{\s*摘录\s*[:：]\s*[^}]+\}\}$/;

/**
 * markdown 正文 → 元素序列。top 递增的"假布局"：阅读端（LectureSceneView）
 * 按 top 排序线性化，几何只服务于摘录盒预算 / PPTX 导出 / Pro 编辑器。
 */
export function mdToElements(md: string): LectureSlide {
  const elements: El[] = [];
  let y = 40;

  const push = (html: string, height: number, extra: El = {}): void => {
    elements.push({
      type: 'text',
      left: MARGIN,
      top: y,
      width: CONTENT_W,
      height,
      content: html,
      defaultFontName: '',
      defaultColor: C.body,
      ...extra,
    });
    y += height + GAP;
  };

  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // 空行
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 代码围栏
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉闭合围栏（或文件尾）
      const kept = buf.length ? buf : [''];
      const html = kept.map(codeLineHtml).join('');
      push(html, kept.length * 22 + 24, {
        defaultFontName: 'Consolas',
        defaultColor: C.codeFg,
        fill: C.codeBg,
        lineHeight: 1.4,
      });
      continue;
    }

    // $$ 块级公式（单行或跨行到闭合 $$）
    if (line.trim().startsWith('$$')) {
      let formula = line.trim();
      while (!/\$\$\s*$/.test(formula) || formula === '$$') {
        i += 1;
        if (i >= lines.length) break;
        formula += ` ${lines[i].trim()}`;
      }
      i += 1;
      const body = formula.replace(/^\$\$/, '').replace(/\$\$\s*$/, '').trim();
      const html = katex.renderToString(body, {
        throwOnError: false,
        displayMode: true,
        output: 'html',
      });
      push(`<p style="font-size: 18px; text-align: center;">${html}</p>`, 90);
      continue;
    }

    // 独立成行的图片语法整行丢弃：模型没有配图能力，编出来的多是死链/幻觉 URL
    // （用户实拍：维基百科图链原文糊脸）。行内混排的图片由 inline() 剥成替代文字。
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(line.trim())) {
      i += 1;
      continue;
    }

    // 摘录占位符独立成行：大盒留给 injectExcerpts 按盒预算注入。
    // 阅读流无物理画布，盒高只影响预算反算——给足（640 ≈ 1100+ 字），
    // 截断交给注入端的句界+公式配平逻辑。
    if (EXCERPT_LINE.test(line.trim())) {
      push(`<p style="font-size: 16px;">${line.trim()}</p>`, 640);
      i += 1;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const font = [28, 24, 20, 18][h[1].length - 1];
      push(
        `<p style="font-size: ${font}px;"><strong>${inline(h[2])}</strong></p>`,
        textHeight(linesFor(h[2], CONTENT_W, font), font),
        { defaultColor: C.title },
      );
      i += 1;
      continue;
    }

    // 列表（连续 -/* 行归成一个元素）
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trimEnd())) {
        items.push(lines[i].trimEnd().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      const html = items.map((t) => `<p style="font-size: 16px;">• ${inline(t)}</p>`).join('');
      const totalLines = items.reduce((a, t) => a + linesFor(`• ${t}`, CONTENT_W, 16), 0);
      push(html, textHeight(totalLines, 16));
      continue;
    }

    // 引用行（连续 > 归成一段）
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trimEnd().startsWith('> ')) {
        quote.push(lines[i].trimEnd().slice(2));
        i += 1;
      }
      const text = quote.join(' ');
      push(
        `<p style="font-size: 15px; font-style: italic;">${inline(text)}</p>`,
        textHeight(linesFor(text, CONTENT_W, 15), 15),
      );
      continue;
    }

    // 普通段落
    push(
      `<p style="font-size: 16px;">${inline(line)}</p>`,
      textHeight(linesFor(line, CONTENT_W, 16), 16),
    );
    i += 1;
  }

  return { background: { type: 'solid', color: C.bg }, elements };
}

/**
 * 生成响应清洗：剥整体 ```markdown 围栏包裹、配平奇数围栏、
 * 去掉模型不听话复写的小节同名标题。空返回 null 让调用方回退。
 */
export function cleanLectureMarkdown(response: string, sceneTitle: string): string | null {
  let md = response.trim();
  if (/^```(markdown)?\s*$/.test(md.split('\n')[0] ?? '')) {
    const body = md.split('\n').slice(1);
    if (/^```\s*$/.test(body[body.length - 1] ?? '')) body.pop();
    md = body.join('\n').trim();
  }
  // 围栏配平：奇数个 ``` 会把后续内容全吞进代码块
  const fenceCount = (md.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) md += '\n```';
  // 模型复写小节标题时去重（外层已有标题）
  md = md.replace(/^#{1,4}\s*(.+)\s*\n+/, (m, head: string) =>
    head.trim() === sceneTitle.trim() ? '' : m,
  );
  md = md.trim();
  return md.length >= 50 ? md : null;
}
