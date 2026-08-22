/**
 * 朱批下划线（public-site-redesign §0-bis 评点本视觉）：把判官核验过的断言
 * 在讲义 HTML 里标出来——朱砂细下划线，点开眉批卡。
 *
 * 判官的 claim 是对原句的转述/截断（提示词只要求 80 字内），逐字子串匹配
 * 实测命中率 1/16——所以走句级模糊匹配：把块内文本按句切分，按字符 bigram
 * 重合度找最像的句子，达阈值才在整句上画线。达不到阈值的断言不标——
 * 真实的不完美 > 伪造的温度，宁可少标一句，不能画到判官没核过的句子上。
 *
 * 只做渲染层转换，不改存储数据。仅浏览器可用（DOMParser）。
 */

import type { AuditClaim } from '@/lib/generation/hallucination-audit';

/** 匹配下限：短于此的断言 bigram 太少，误伤率高，不标。 */
const MIN_MATCH_LEN = 8;

/** 断言 bigram 落在句子里的最低占比。0.6 = 六成字符对能在句中找到。 */
const MATCH_THRESHOLD = 0.6;

/** 断言文本 → 可比对文本：剥引号/句号/截断省略号。 */
export function claimNeedle(claim: string): string | null {
  let s = claim.trim().replace(/^[「"'『]/, '').replace(/[」"'』]$/, '');
  s = s.replace(/(…|\.\.\.)$/, '').replace(/[。．]$/, '').trim();
  return s.length >= MIN_MATCH_LEN ? s : null;
}

/** claim verdict → 下划线样式类。朱=核过，赭=存疑/打回（批次色语义）。 */
export function annotClass(verdict: AuditClaim['verdict']): string {
  if (verdict === 'supported') return 'annot-claim annot-zhu';
  if (verdict === 'uncertain') return 'annot-claim annot-zhe annot-dotted';
  return 'annot-claim annot-zhe';
}

const bigrams = (s: string): Set<string> => {
  const clean = s.replace(/[\s*_`#]+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
};

/** 断言 bigram 有多大比例能在候选句里找到（含截断友好：分母是断言侧）。 */
export function claimSentenceScore(needle: string, sentence: string): number {
  const a = bigrams(needle);
  if (!a.size) return 0;
  const b = bigrams(sentence);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
};

interface TextSlice {
  node: Text;
  /** 该文本节点在块级纯文本里的起点偏移。 */
  start: number;
}

/** 收集可批注文本节点（跳过 KaTeX 内部——公式内画线会撕坏排版）。 */
function collectText(root: Element): { slices: TextSlice[]; full: string } {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.parentElement as Element | null)?.closest('.katex')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const slices: TextSlice[] = [];
  let full = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    slices.push({ node: n as Text, start: full.length });
    full += n.nodeValue ?? '';
  }
  return { slices, full };
}

/** 纯文本 → 句子区间（含结尾标点），按中英文句界与换行切。 */
function sentenceRanges(full: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let from = 0;
  for (let i = 0; i < full.length; i++) {
    if ('。！？!?\n'.includes(full[i])) {
      if (i > from) ranges.push({ from, to: i + 1 });
      from = i + 1;
    }
  }
  if (from < full.length) ranges.push({ from, to: full.length });
  return ranges;
}

/** 把 [from,to) 纯文本区间对应的各文本节点片段包进批注 span（可能多枚）。 */
function wrapRange(
  root: Element,
  slices: TextSlice[],
  from: number,
  to: number,
  cls: string,
  index: number,
): boolean {
  const doc = root.ownerDocument;
  const jobs: Array<{ node: Text; ls: number; le: number }> = [];
  for (const { node, start } of slices) {
    const len = (node.nodeValue ?? '').length;
    const s = Math.max(from, start);
    const e = Math.min(to, start + len);
    if (s >= e) continue;
    if ((node.parentElement as Element | null)?.closest('[data-annot]')) return false;
    jobs.push({ node, ls: s - start, le: e - start });
  }
  let wrapped = false;
  for (const { node, ls, le } of jobs) {
    const piece = (node.nodeValue ?? '').slice(ls, le);
    if (!piece.trim()) continue;
    let target = node;
    if (ls > 0) target = target.splitText(ls);
    if (le - ls < (target.nodeValue ?? '').length) target.splitText(le - ls);
    const span = doc.createElement('span');
    span.setAttribute('class', cls);
    span.setAttribute('data-annot', String(index));
    // 朱批句点开是眉批卡（审核判词）。它是 cursor:pointer 的 span，
    // 2026-08-13 实测键盘完全够不着——WCAG 2.1.1 要求所有功能可由键盘操作。
    // 加 tabindex/role 让它进 Tab 序，回车空格由 lecture-scene-view 的 onKeyDown 接。
    span.setAttribute('tabindex', '0');
    span.setAttribute('role', 'button');
    target.before(span);
    span.appendChild(target);
    wrapped = true;
  }
  return wrapped;
}

/**
 * 在一段受控 HTML 里为断言画朱批。返回改写后的 HTML；一处都没匹配上时
 * 返回原串（引用相等，调用方可据此跳过 re-render）。
 * 每条断言只标最像的一句；已被别的断言占住的句子不重复标（span 不嵌套）。
 */
export function annotateClaimsInHtml(html: string, claims: readonly AuditClaim[]): string {
  if (!claims.length || typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return html;

  let touched = false;
  claims.forEach((claim, index) => {
    const needle = claimNeedle(claim.claim);
    if (!needle) return;
    // 每条断言重收集：前一条的 splitText 改变了节点结构，但纯文本与偏移不变
    const { slices, full } = collectText(root);
    let best: { from: number; to: number } | null = null;
    let bestScore = 0;
    for (const r of sentenceRanges(full)) {
      const score = claimSentenceScore(needle, full.slice(r.from, r.to));
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best || bestScore < MATCH_THRESHOLD) return;
    if (wrapRange(root, slices, best.from, best.to, annotClass(claim.verdict), index)) {
      touched = true;
    }
  });

  return touched ? root.innerHTML : html;
}
