/**
 * 可执行验证桥（KR2）：场景内容生成后，把代码块与正文数值送引擎机械验算。
 *
 * 引擎侧零 LLM（隔离子进程跑代码三态判定 + AST 白名单复核数值等式），
 * 结果进车间面板：算错的数字、跑不通的代码在交付前就被点名，
 * 幻觉治理从「文本 claim 审核」延伸到「算得对不对」。
 * 失败语义与四桥一致：未配置/无可验内容不算失败；桥炸了走 onFailure。
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('Content Verify');

// 3 块代码 ×10s 沙箱 + 网络余量
const FETCH_TIMEOUT_MS = 40000;

export interface VerificationMeta {
  codePassed: number;
  codeFailed: number;
  codeUnverifiable: number;
  arithmeticChecked: number;
  arithmeticPassed: number;
  /** 已识别但无法在白名单解释器中安全求值；只告警，不冒充通过。 */
  arithmeticUnverifiable?: number;
  failures: string[];
  warnings?: string[];
}

// ── KR2 抽取伪影三修（2026-08-09，评测链同口径移植，task_00c0763d）──────
// 评测链在 6 门课上修过的三处假失败源，产品桥同病：
// ① KaTeX 渲染树剥标签把 10^7 摊平成 107 → 整棵树换回 TeX 源或按 msupsub 重建
// ② <sup>/<sub> 与字面 U+00A0 直接剥 → 上标补 ^、下标换 x、NBSP 换空格
// ③ 含行内 code 的中文散文被 font-family 误判成代码 → CJK 占比守卫

const unescapeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** 从 start（span 开标签处）括号计数扫到整棵 span 树闭合，返回结束偏移。 */
function spanTreeEnd(s: string, start: number): number {
  const re = /<span\b[^>]*>|<\/span>/g;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return re.lastIndex;
  }
  return s.length;
}

/** 简单 TeX → 可解析算式。转不动的记法留原样（引擎解析不了会跳过，无害）。 */
function detex(t: string): string {
  return unescapeEntities(t)
    .replace(/\\times/g, '*')
    .replace(/\\cdot/g, '*')
    .replace(/\\approx/g, '≈')
    .replace(/\^\{([^{}]+)\}/g, '^$1')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)')
    .replace(/\\[,;!:]|\\left|\\right/g, ' ');
}

/** 无 annotation 的 KaTeX html 树：msupsub 子树文本前补 ^（KaTeX 把指数放这个
    包装里）。下标也走 msupsub 会被误写成 ^：d_k→d^k 含字母解析不了自动跳过。 */
function flattenKatexHtml(block: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const j = block.indexOf('<span class="msupsub">', i);
    if (j === -1) {
      parts.push(block.slice(i).replace(/<[^>]+>/g, ''));
      break;
    }
    parts.push(block.slice(i, j).replace(/<[^>]+>/g, ''));
    const k = spanTreeEnd(block, j);
    const exponent = block
      .slice(j, k)
      .replace(/<[^>]+>/g, '')
      .trim();
    parts.push(exponent ? `^${exponent}` : '');
    i = k;
  }
  return unescapeEntities(parts.join('')).replace(/×/g, '*').replace(/−/g, '-');
}

const KATEX_ANNOT = /<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/;

/** 把整棵 KaTeX span 树换成其 TeX 源（有 annotation）或重建的算式（纯 html 树，
    md-to-elements 用 output:'html' 渲染就是这种）。剥标签摊平是评测实锤的假失败源。 */
function replaceKatexBlocks(s: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const j = s.indexOf('<span class="katex">', i);
    if (j === -1) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, j));
    const k = spanTreeEnd(s, j);
    const tree = s.slice(j, k);
    const annot = KATEX_ANNOT.exec(tree);
    out.push(` ${annot ? detex(annot[1]) : flattenKatexHtml(tree)} `);
    i = k;
  }
  return out.join('');
}

const stripHtml = (html: string): string =>
  unescapeEntities(
    replaceKatexBlocks(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      // 上/下标先于剥标签：<sup>7</sup> 直接剥会把 10⁷ 变成 107；
      // 下标换字母 x（变量标签绝不能变成数字，评测链同教训）
      .replace(/<sup[^>]*>\s*(\d+)\s*<\/sup>/gi, '^$1')
      .replace(/<sub[^>]*>[^<]*<\/sub>/gi, 'x')
      .replace(/<[^>]+>/g, ''),
  ).replace(/ /g, ' ');

type VerificationCollector = {
  codeBlocks: string[];
  texts: string[];
  codeSeen: Set<string>;
  textSeen: Set<string>;
};

function collector(): VerificationCollector {
  return { codeBlocks: [], texts: [], codeSeen: new Set(), textSeen: new Set() };
}

function pushUnique(list: string[], seen: Set<string>, value: string): void {
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  list.push(normalized);
}

function pushCode(out: VerificationCollector, value: string): void {
  pushUnique(out.codeBlocks, out.codeSeen, unescapeEntities(value));
}

/** 把 Markdown fenced code 从教学文字中分出来，避免同一段同时按代码和算式验两次。 */
function pushText(out: VerificationCollector, value: string): void {
  const withoutCode = value.replace(/```[^\r\n`]*\r?\n([\s\S]*?)```/g, (_match, code: string) => {
    pushCode(out, code);
    return ' ';
  });
  const text = /<[^>]+>/.test(withoutCode) ? stripHtml(withoutCode) : withoutCode.trim();
  pushUnique(out.texts, out.textSeen, text);
}

/** HTML 教具：可见正文走数值验算；pre/code 与可执行 script 单独归为代码。 */
function pushHtml(out: VerificationCollector, html: string): void {
  let visible = html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attrs: string, body: string) => {
      if (!/type\s*=\s*["']?(?:application\/json|application\/ld\+json|importmap)/i.test(attrs)) {
        pushCode(out, body);
      }
      return ' ';
    })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, body: string) => {
      pushCode(out, body.replace(/<\/?code\b[^>]*>/gi, ''));
      return ' ';
    });
  visible = visible.replace(/<!--([\s\S]*?)-->/g, ' ');
  pushText(out, visible);
}

const NON_CONTENT_KEYS = new Set([
  'id',
  'type',
  'url',
  'language',
  'widgetType',
  'mimeType',
  'fileUrl',
  'createdAt',
  'updatedAt',
]);

function isCodeField(key: string, parentType: unknown): boolean {
  return (
    /(?:^|_)(?:code|script|sourceCode|starterCode|solutionCode)$/i.test(key) ||
    (parentType === 'code' && key === 'solution')
  );
}

/** Quiz / Interactive / PBL 都是嵌套 JSON；只收字符串叶，数值对象本身不是断言。 */
function collectStructured(node: unknown, out: VerificationCollector, key = ''): void {
  if (typeof node === 'string') {
    if (/^(?:https?:|data:)/i.test(node.trim())) return;
    if (key === 'html') pushHtml(out, node);
    else pushText(out, node);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((value) => collectStructured(value, out, key));
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [childKey, value] of Object.entries(record)) {
    if (NON_CONTENT_KEYS.has(childKey)) continue;
    if (typeof value === 'string' && isCodeField(childKey, record.type)) {
      pushCode(out, value);
    } else {
      collectStructured(value, out, childKey);
    }
  }
}

/** 从幻灯片元素抽出（代码块, 可验文本）。复用原有 HTML/KaTeX 归一化。 */
export function extractVerifiables(elements: unknown[]): { codeBlocks: string[]; texts: string[] } {
  const out = collector();
  for (const el of elements) {
    const obj = el as {
      type?: string;
      content?: unknown;
      defaultFontName?: string;
      text?: { content?: unknown; defaultFontName?: string };
      data?: unknown;
      lines?: unknown;
      latex?: unknown;
    };
    if (obj.type === 'code') {
      const lines = Array.isArray(obj.lines) ? obj.lines : [];
      pushCode(
        out,
        lines
          .map((line) =>
            typeof (line as { content?: unknown }).content === 'string'
              ? String((line as { content: string }).content)
              : '',
          )
          .join('\n'),
      );
      continue;
    }
    if (obj.type === 'shape' && typeof obj.text?.content === 'string') {
      pushText(out, obj.text.content);
      continue;
    }
    if (obj.type === 'table' && Array.isArray(obj.data)) {
      obj.data
        .flatMap((row) => (Array.isArray(row) ? row : []))
        .forEach((cell) => {
          const value =
            (cell as { text?: unknown; content?: unknown }).text ??
            (cell as { content?: unknown }).content;
          if (typeof value === 'string') pushText(out, value);
        });
      continue;
    }
    if (obj.type === 'latex' && typeof obj.latex === 'string') {
      pushText(out, detex(obj.latex));
      continue;
    }
    if (obj.type !== 'text' || typeof obj.content !== 'string') continue;
    let mono =
      /consolas|monospace|courier/i.test(obj.defaultFontName ?? '') ||
      /font-family:\s*(consolas|monospace|courier)/i.test(obj.content);
    const text = stripHtml(obj.content).trim();
    if (!text) continue;
    // 段落里嵌一个行内 code span 就会命中 font-family——中文占比高的是散文
    // 不是代码，误进沙箱必然 SyntaxError 假失败（评测链同口径守卫）
    if (mono) {
      const cjk = (text.match(/[一-鿿]/g) ?? []).length;
      if (cjk / Math.max(1, text.length) > 0.3) mono = false;
    }
    if (mono) pushCode(out, text);
    else pushText(out, obj.content);
  }
  return { codeBlocks: out.codeBlocks, texts: out.texts };
}

/**
 * 同时兼容生成层内容（`{ elements }`）与落盘场景内容
 * （`{ type: 'slide', canvas: { elements } }`）。发布门禁必须复核学习者最终读到的
 * 那份场景，不能只认 scene-content 路由中的中间态。
 */
export function extractContentVerifiables(content: unknown): {
  codeBlocks: string[];
  texts: string[];
} {
  if (!content || typeof content !== 'object') return { codeBlocks: [], texts: [] };
  const obj = content as {
    elements?: unknown[];
    canvas?: { elements?: unknown[] };
  };
  const elements = Array.isArray(obj.elements)
    ? obj.elements
    : Array.isArray(obj.canvas?.elements)
      ? obj.canvas.elements
      : null;
  if (elements) return extractVerifiables(elements);

  const out = collector();
  collectStructured(content, out);
  return { codeBlocks: out.codeBlocks, texts: out.texts };
}

/** 是否有值得送验的内容（有代码块，或文本含数值等式候选）。
    预检故意放宽：含 =/≈、有数字、且出现运算符或 sqrt/exp/log 即送验——
    误报代价是一次 <1s 的桥调用，收得太紧曾把「sqrt(64)=8」拦在门外（实测）。 */
export function hasVerifiableContent(codeBlocks: string[], texts: string[]): boolean {
  if (codeBlocks.length > 0) return true;
  return texts.some(
    (t) =>
      (/[=≈]/.test(t) && /\d/.test(t) && /[+\-*/×÷^]|sqrt|exp|log/.test(t)) ||
      // 常见教学写法没有等号："softmax 后约为 [0.71, 0.29]"。只在同一段里
      // 同时出现 softmax、两个数值向量时送验，避免把概念性叙述误当算式。
      (/softmax/i.test(t) && (t.match(/\[[^\]]*\d[^\]]*\]/g) ?? []).length >= 2),
  );
}

/** 发布门禁与生成日志共用的失败口径：failed / unverifiable / warning 均不算通过。 */
export function verificationHasFailures(meta: VerificationMeta): boolean {
  return (
    meta.codeFailed > 0 ||
    meta.codeUnverifiable > 0 ||
    meta.arithmeticPassed < meta.arithmeticChecked ||
    (meta.arithmeticUnverifiable ?? 0) > 0 ||
    meta.failures.length > 0 ||
    (meta.warnings?.length ?? 0) > 0
  );
}

export async function verifyContent(
  codeBlocks: string[],
  texts: string[],
  onFailure?: (message: string) => void,
): Promise<VerificationMeta | null> {
  const base = process.env.GROUNDING_URL;
  if (!base) return null;
  if (!hasVerifiableContent(codeBlocks, texts)) return null;
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/verify-content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({ code_blocks: codeBlocks, texts }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!resp.ok) {
      onFailure?.(`可执行验证桥返回 HTTP ${resp.status}`);
      return null;
    }
    const payload = (await resp.json()) as {
      data?: {
        code_passed: number;
        code_failed: number;
        code_unverifiable: number;
        arithmetic: {
          checked: number;
          passed: number;
          failures: string[];
          unverifiable?: number;
          warnings?: string[];
        };
        code: Array<{ verdict: string; detail: string }>;
      };
    };
    const d = payload.data;
    if (!d) return null;
    // 教学片段 NameError=缺上下文不可验，不是代码算错（评测链同口径）。
    // 引擎侧已同改；这里再归一遍是给未更新的引擎兜底，幂等无副作用。
    const code = d.code.map((c) =>
      c.verdict === 'failed' && c.detail.startsWith('NameError')
        ? { ...c, verdict: 'unverifiable' }
        : c,
    );
    const failed = code.filter((c) => c.verdict === 'failed');
    const unverifiable = code.filter((c) => c.verdict === 'unverifiable');
    return {
      codePassed: code.filter((c) => c.verdict === 'passed').length,
      codeFailed: failed.length,
      codeUnverifiable: unverifiable.length,
      arithmeticChecked: d.arithmetic.checked,
      arithmeticPassed: d.arithmetic.passed,
      arithmeticUnverifiable: d.arithmetic.unverifiable ?? 0,
      failures: [
        ...failed.map((c) => `代码：${c.detail}`),
        ...d.arithmetic.failures.map((f) => `数值：${f}`),
      ].slice(0, 5),
      warnings: [
        ...unverifiable.map((c) => `代码：${c.detail || '无法安全执行'}`),
        ...(d.arithmetic.warnings ?? []).map((w) => `数值：${w}`),
      ].slice(0, 5),
    };
  } catch (err) {
    log.warn(`Content verification unavailable: ${String(err)}`);
    onFailure?.(`可执行验证桥不可达（${err instanceof Error ? err.name : 'error'}）`);
    return null;
  }
}
