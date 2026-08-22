/**
 * 幻灯片模板槽位制 —— 版式由人定，LLM 只填内容槽。
 *
 * 为什么：LLM 直排绝对坐标是已被业界判死的路线（无字形度量→溢出，
 * 组合碰撞→重叠，无视觉回路→密度失控）。Gamma/presenton/PPTAgent 的共同
 * 做法都是模板槽位/编辑式生成，坐标永远来自人写的版式。
 * 调研台账：docs/04-research/slide_generation_research_20260803.md
 *
 * 这里的展开器是确定性的：文本按字号/行高/盒宽实测折行，装不下先缩字号
 * 再截断——溢出和重叠在构造上不可能发生。
 */

export interface SlideSlotSpec {
  template: string;
  slots: Record<string, unknown>;
  remark?: string;
}

interface El {
  [k: string]: unknown;
}

export interface ExpandedSlide {
  background: { type: 'solid'; color: string };
  elements: El[];
}

// ── 画布与调色 ─────────────────────────────────────────────────────────
const W = 1000;
const H = 562.5;
const MARGIN = 60;
const CONTENT_W = W - MARGIN * 2; // 880
const TITLE_TOP = 44;
const BODY_TOP = 128;
const BODY_BOTTOM = H - 40;

// 米暖白底 + 暖灰文字 + 粉彩点缀（对齐设计语言 spec 的暖色相优先）
const C = {
  bg: '#fdfbf7',
  title: '#332f2b',
  body: '#45403a',
  muted: '#8a8378',
  cardFill: '#f5f1ea',
  accent: '#7c6bd6',
  softBlue: '#e8f1fb',
  softBlueDeep: '#3a6ea5',
  softYellow: '#fdf3d8',
  line: '#d8d2c8',
};

// ── 文本度量（与 slide-content 模板同一套规则）───────────────────────────
const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 代码块单行 → <p>。缩进靠 white-space: pre-wrap 保，不再把空格换成 &nbsp;。
 *
 * 旧写法 `.replace(/ /g, '&nbsp;')` 让每个空格在 DOM 里变成 U+00A0：屏幕上看着对，
 * 学习者一复制就得到满篇不间断空格，Python 直接 SyntaxError: invalid non-printable
 * character U+00A0（compile() 实测）。pre-wrap 同样保住缩进，且复制出来是真空格。
 * 空行用 <br>：空 <p> 会塌成 0 高，而 <br> 在 PPTX 导出里正好走 breakLine 分支。
 */
export const codeLineHtml = (line: string): string =>
  `<p style="font-size: 14px; font-family: Consolas, monospace; white-space: pre-wrap;">${
    esc(line) || '<br>'
  }</p>`;

/** 行数：CJK 按 (width-20)/font 每行字数估算，与模板 Rule 1/2 同源。 */
export function linesFor(text: string, width: number, font: number): number {
  const perLine = Math.max(1, Math.floor((width - 20) / font));
  return Math.max(1, Math.ceil(text.length / perLine));
}

export function textHeight(lines: number, font: number): number {
  return Math.round(lines * font * 1.5) + 20;
}

let seq = 0;
const id = (t: string): string => `${t}_tpl_${++seq}`;

function textEl(
  left: number,
  top: number,
  width: number,
  html: string,
  height: number,
  color = C.body,
  extra: El = {},
): El {
  return {
    id: id('text'),
    type: 'text',
    left,
    top,
    width,
    height,
    content: html,
    defaultFontName: '',
    defaultColor: color,
    ...extra,
  };
}

function p(text: string, font: number, opts: { bold?: boolean; color?: string } = {}): string {
  const style = `font-size: ${font}px;${opts.color ? ` color: ${opts.color};` : ''}`;
  const body = opts.bold ? `<strong>${esc(text)}</strong>` : esc(text);
  return `<p style="${style}">${body}</p>`;
}

/** 标题条：32px 主标题（超长自动降 28）＋左侧竖条强调。返回正文起始 y。 */
function titleBlock(els: El[], title: string): number {
  const font = title.length > 24 ? 28 : 32;
  const h = textHeight(linesFor(title, CONTENT_W - 20, font), font);
  els.push({
    id: id('shape'),
    type: 'shape',
    left: MARGIN,
    top: TITLE_TOP + 6,
    width: 6,
    height: h - 26,
    path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
    viewBox: [1, 1],
    fill: C.accent,
    fixedRatio: false,
  });
  els.push(textEl(MARGIN + 18, TITLE_TOP, CONTENT_W - 18, p(title, font, { bold: true }), h, C.title));
  return Math.max(BODY_TOP, TITLE_TOP + h + 18);
}

/**
 * 要点列表装配：给定可用高度，从 18px 起装；装不下降 16px；再装不下截断
 * 并在末行标注省略。返回元素与实际占高。截断是有损的，但绝不溢出。
 */
function bulletsEl(
  left: number,
  top: number,
  width: number,
  items: string[],
  maxBottom: number,
  lead?: string,
): El[] {
  const els: El[] = [];
  let y = top;
  if (lead) {
    const lh = textHeight(linesFor(lead, width, 18), 18);
    els.push(textEl(left, y, width, p(lead, 18), lh, C.body));
    y += lh + 8;
  }
  for (const font of [18, 16]) {
    const lines = items.map((t) => linesFor(`• ${t}`, width, font));
    const total = textHeight(lines.reduce((a, b) => a + b, 0), font);
    if (y + total <= maxBottom || font === 16) {
      let kept = items;
      let height = total;
      if (y + total > maxBottom) {
        // 16px 仍装不下：按行数逐条回退，末尾补省略标记
        kept = [];
        let acc = 0;
        for (const [i, t] of items.entries()) {
          const next = acc + lines[i];
          if (textHeight(next + 1, font) > maxBottom - y) break;
          kept.push(t);
          acc = next;
        }
        if (kept.length < items.length) kept.push(`…（其余 ${items.length - kept.length} 条见讲稿）`);
        height = textHeight(kept.map((t) => linesFor(`• ${t}`, width, font)).reduce((a, b) => a + b, 0) + 0, font);
      }
      const html = kept.map((t) => p(`• ${t}`, font)).join('');
      els.push(textEl(left, y, width, html, height, C.body));
      break;
    }
  }
  return els;
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asStr).filter(Boolean) : [];

// ── 模板 ───────────────────────────────────────────────────────────────

type TemplateFn = (slots: Record<string, unknown>) => El[];

const templates: Record<string, TemplateFn> = {
  /** 标题+导语+要点。slots: title, lead?, bullets[] */
  'title-bullets'(s) {
    const els: El[] = [];
    const y = titleBlock(els, asStr(s.title));
    els.push(...bulletsEl(MARGIN, y, CONTENT_W, asArr(s.bullets), BODY_BOTTOM, asStr(s.lead) || undefined));
    return els;
  },

  /** 双栏对照。slots: title, leftTitle, leftBullets[], rightTitle, rightBullets[] */
  'two-column'(s) {
    const els: El[] = [];
    const y = titleBlock(els, asStr(s.title));
    const colW = (CONTENT_W - 40) / 2;
    for (const [i, side] of (['left', 'right'] as const).entries()) {
      const x = MARGIN + i * (colW + 40);
      const head = asStr(s[`${side}Title`]);
      const hh = textHeight(1, 20);
      els.push({
        id: id('shape'),
        type: 'shape',
        left: x,
        top: y,
        width: colW,
        height: hh + 4,
        path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
        viewBox: [1, 1],
        fill: i === 0 ? C.softBlue : C.softYellow,
        fixedRatio: false,
      });
      els.push(textEl(x + 10, y + 2, colW - 20, p(head, 20, { bold: true }), hh, C.title));
      els.push(...bulletsEl(x, y + hh + 14, colW, asArr(s[`${side}Bullets`]), BODY_BOTTOM));
    }
    return els;
  },

  /** 对比/映射表。slots: title, lead?, headers[], rows[][] */
  'compare-table'(s) {
    const els: El[] = [];
    let y = titleBlock(els, asStr(s.title));
    const lead = asStr(s.lead);
    if (lead) {
      const lh = textHeight(linesFor(lead, CONTENT_W, 16), 16);
      els.push(textEl(MARGIN, y, CONTENT_W, p(lead, 16), lh, C.muted));
      y += lh + 10;
    }
    const headers = asArr(s.headers);
    const rawRows = Array.isArray(s.rows) ? (s.rows as unknown[]) : [];
    const rows = rawRows.map((r) => (Array.isArray(r) ? r.map(asStr) : [asStr(r)]));
    const cols = Math.max(headers.length, ...rows.map((r) => r.length), 1);
    const rowH = 34;
    const maxRows = Math.max(1, Math.floor((BODY_BOTTOM - y) / rowH) - 1);
    const keptRows = rows.slice(0, maxRows);
    const cell = (t: string, i: number, bold = false): Record<string, unknown> => ({
      id: id('c'),
      colspan: 1,
      rowspan: 1,
      text: t,
      style: bold ? { bold: true, backcolor: C.cardFill } : undefined,
    });
    const data = [
      headers.length ? headers.map((h, i) => cell(h, i, true)) : undefined,
      ...keptRows.map((r) =>
        Array.from({ length: cols }, (_, i) => cell(r[i] ?? '', i)),
      ),
    ].filter(Boolean);
    els.push({
      id: id('table'),
      type: 'table',
      left: MARGIN,
      top: y,
      width: CONTENT_W,
      height: (data as unknown[]).length * rowH,
      colWidths: Array.from({ length: cols }, () => 1 / cols),
      data,
      outline: { width: 2, style: 'solid', color: C.line },
    });
    return els;
  },

  /** 横向流程条。slots: title, lead?, steps[{label, desc?}] 3-6 步 */
  'flow-steps'(s) {
    const els: El[] = [];
    let y = titleBlock(els, asStr(s.title));
    const lead = asStr(s.lead);
    if (lead) {
      const lh = textHeight(linesFor(lead, CONTENT_W, 16), 16);
      els.push(textEl(MARGIN, y, CONTENT_W, p(lead, 16), lh, C.muted));
      y += lh + 12;
    }
    const raw = Array.isArray(s.steps) ? (s.steps as unknown[]) : [];
    const steps = raw
      .map((st) =>
        typeof st === 'string'
          ? { label: st, desc: '' }
          : { label: asStr((st as El)?.label), desc: asStr((st as El)?.desc) },
      )
      .filter((st) => st.label)
      .slice(0, 6);
    const n = Math.max(steps.length, 1);
    const gap = 28;
    const nodeW = Math.floor((CONTENT_W - gap * (n - 1)) / n);
    const nodeH = 64;
    for (const [i, st] of steps.entries()) {
      const x = MARGIN + i * (nodeW + gap);
      els.push({
        id: id('shape'),
        type: 'shape',
        left: x,
        top: y,
        width: nodeW,
        height: nodeH,
        path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
        viewBox: [1, 1],
        fill: i === steps.length - 1 ? C.softBlue : C.cardFill,
        fixedRatio: false,
      });
      els.push(
        textEl(x + 8, y + 8, nodeW - 16, p(`${i + 1}. ${st.label}`, 16, { bold: true }), textHeight(linesFor(st.label, nodeW - 16, 16), 16), C.title),
      );
      if (i < steps.length - 1) {
        els.push({
          id: id('line'),
          type: 'line',
          left: x + nodeW + 4,
          top: y + nodeH / 2,
          width: 3,
          start: [0, 0],
          end: [gap - 8, 0],
          style: 'solid',
          color: C.accent,
          points: ['', 'arrow'],
        });
      }
    }
    y += nodeH + 20;
    const descs = steps.filter((st) => st.desc).map((st) => `${st.label}：${st.desc}`);
    if (descs.length) els.push(...bulletsEl(MARGIN, y, CONTENT_W, descs, BODY_BOTTOM));
    return els;
  },

  /** 例题精讲。slots: title, problem, steps[], takeaway? */
  'worked-example'(s) {
    const els: El[] = [];
    let y = titleBlock(els, asStr(s.title));
    const problem = asStr(s.problem);
    const ph = textHeight(linesFor(problem, CONTENT_W - 24, 18), 18);
    els.push({
      id: id('shape'),
      type: 'shape',
      left: MARGIN,
      top: y,
      width: CONTENT_W,
      height: ph + 16,
      path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
      viewBox: [1, 1],
      fill: C.softYellow,
      fixedRatio: false,
    });
    els.push(textEl(MARGIN + 12, y + 8, CONTENT_W - 24, p(`例：${problem}`, 18, { bold: true }), ph, C.title));
    y += ph + 28;
    const steps = asArr(s.steps).map((t, i) => `第 ${i + 1} 步：${t}`);
    const takeaway = asStr(s.takeaway);
    const bottom = takeaway ? BODY_BOTTOM - 56 : BODY_BOTTOM;
    els.push(...bulletsEl(MARGIN, y, CONTENT_W, steps, bottom));
    if (takeaway) {
      const th = textHeight(linesFor(takeaway, CONTENT_W - 24, 16), 16);
      els.push(
        textEl(MARGIN, BODY_BOTTOM - th - 8, CONTENT_W, p(`▸ ${takeaway}`, 16, { bold: true, color: C.accent }), th + 8, C.accent, { fill: C.cardFill }),
      );
    }
    return els;
  },

  /** 教材摘录页。slots: title, intro, excerptId */
  excerpt(s) {
    const els: El[] = [];
    let y = titleBlock(els, asStr(s.title));
    const intro = asStr(s.intro);
    if (intro) {
      const ih = textHeight(linesFor(intro, CONTENT_W, 16), 16);
      els.push(textEl(MARGIN, y, CONTENT_W, p(intro, 16), ih, C.muted));
      y += ih + 10;
    }
    // 大盒留给注入器：evidence-grounding 按盒预算裁字，出处行渲染端保底
    els.push(
      textEl(MARGIN, y, CONTENT_W, `<p style="font-size: 16px;">{{摘录:${esc(asStr(s.excerptId))}}}</p>`, Math.max(240, BODY_BOTTOM - y), C.body),
    );
    return els;
  },

  /** 代码页。slots: title, lead?, code, points[] */
  code(s) {
    const els: El[] = [];
    let y = titleBlock(els, asStr(s.title));
    const lead = asStr(s.lead);
    if (lead) {
      const lh = textHeight(linesFor(lead, CONTENT_W, 16), 16);
      els.push(textEl(MARGIN, y, CONTENT_W, p(lead, 16), lh, C.muted));
      y += lh + 10;
    }
    const points = asArr(s.points);
    const codeLines = asStr(s.code).split('\n').filter((l) => l.trim() !== '');
    const lineH = 22;
    const reservedForPoints = points.length ? Math.min(points.length, 3) * 30 + 16 : 0;
    const maxCodeLines = Math.max(3, Math.floor((BODY_BOTTOM - y - reservedForPoints - 24) / lineH));
    const kept = codeLines.slice(0, maxCodeLines);
    if (kept.length < codeLines.length) kept.push(`# …共 ${codeLines.length} 行，其余见讲稿`);
    const codeH = kept.length * lineH + 24;
    const codeHtml = kept.map(codeLineHtml).join('');
    els.push(textEl(MARGIN, y, CONTENT_W, codeHtml, codeH, '#e8e4dd', { fill: '#332f2b', lineHeight: 1.4 }));
    y += codeH + 16;
    if (points.length) els.push(...bulletsEl(MARGIN, y, CONTENT_W, points.slice(0, 3), BODY_BOTTOM));
    return els;
  },

  /** 公式页。slots: title, latex, whyPoints[] */
  formula(s) {
    const els: El[] = [];
    let y = titleBlock(els, asStr(s.title));
    const latex = asStr(s.latex);
    const fh = 100;
    els.push({
      id: id('latex'),
      type: 'latex',
      left: MARGIN,
      top: y,
      width: CONTENT_W,
      height: fh,
      latex,
      color: C.title,
      align: 'center',
    });
    y += fh + 24;
    els.push(...bulletsEl(MARGIN, y, CONTENT_W, asArr(s.whyPoints), BODY_BOTTOM));
    return els;
  },
};

export const SLIDE_TEMPLATE_IDS = Object.keys(templates);

/** 槽位 → 完整幻灯片 DSL。未知模板/展开异常返回 null，调用方回退自由版面。 */
export function expandSlideTemplate(spec: SlideSlotSpec): ExpandedSlide | null {
  const fn = templates[spec.template];
  if (!fn) return null;
  try {
    const elements = fn(spec.slots ?? {});
    if (!elements.length) return null;
    return { background: { type: 'solid', color: C.bg }, elements };
  } catch {
    return null;
  }
}
