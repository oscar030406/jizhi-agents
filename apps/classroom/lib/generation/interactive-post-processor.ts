import { createLogger } from '@/lib/logger';
import { scrubScaffoldHtml } from './adaptation-lint';

const log = createLogger('InteractiveHtml');

/**
 * Interactive HTML Post-Processor
 *
 * Ported from Python's PostProcessor class (learn-your-way/concept_to_html.py:287-385)
 *
 * Handles:
 * - LaTeX delimiter conversion ($$...$$ -> \[...\], $...$ -> \(...\))
 * - KaTeX CSS/JS injection with auto-render and MutationObserver
 * - Script tag protection during LaTeX conversion
 */

/**
 * Main entry point: post-process generated interactive HTML
 * Converts LaTeX delimiters and injects KaTeX rendering resources.
 *
 * 顺带清脚手架泄漏。第三轮同题对照课实测：讲义流与 canvas 槽位路都干净了，
 * 唯独教具那一屏五个原词「本段目标：」——**教具走的是 iframe HTML，
 * 跟幻灯片那两条路一个字节都不共用**，清除挂在 `generateSlideContent` 上
 * 天然盖不到它。挂在这里是因为教具 HTML 的出口只有这一个函数，
 * 挂各自的产生点会漏（今天已经因为这个漏过一次）。
 */
export function postProcessInteractiveHtml(html: string): string {
  // Convert LaTeX delimiters while protecting script tags
  let processed = convertLatexDelimiters(html);

  // Inject KaTeX resources if not already present
  if (!processed.toLowerCase().includes('katex')) {
    processed = injectKatex(processed);
  }

  // 元话语清除。scrubScaffoldHtml 自己护着 <script>/<style>，
  // 不会去动教具的逻辑，只动屏上给人读的那几行。
  const scrubbed = scrubScaffoldHtml(processed);
  if (!scrubbed.dropped.length) return processed;
  if (scrubbed.empty) {
    // 整页删完一个字不剩——教具页至少有脚本和按钮文字，走到这里必然是判错。
    // 幻灯片那边可以整条元素丢弃（还有兄弟元素兜着），这里没得丢，原样退回。
    log.warn(`[脚手架清除·教具] 删完整页无内容，判错的可能更大，原样保留`);
    return processed;
  }
  log.warn(`[脚手架清除·教具] 删掉 ${scrubbed.dropped.length} 段：${scrubbed.dropped.join(' | ')}`);
  return scrubbed.html;
}

/**
 * Convert LaTeX delimiters while protecting <script> tags.
 *
 * - Protects script blocks from modification
 * - Converts $$...$$ to \[...\] (display math)
 * - Converts $...$ to \(...\) (inline math)
 * - Restores script blocks after conversion
 */
function convertLatexDelimiters(html: string): string {
  const scriptBlocks: string[] = [];

  // Protect script tags by replacing them with placeholders
  let processed = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, (match) => {
    scriptBlocks.push(match);
    return `__SCRIPT_BLOCK_${scriptBlocks.length - 1}__`;
  });

  // Convert display math: $$...$$ -> \[...\]
  processed = processed.replace(/\$\$([^$]+)\$\$/g, '\\[$1\\]');

  // Convert inline math: $...$ -> \(...\)
  // Use non-greedy match and exclude newlines to avoid false positives
  processed = processed.replace(/\$([^$\n]+?)\$/g, '\\($1\\)');

  // Restore script blocks in a single pass. A replacer FUNCTION (not a string)
  // is safe even when script content contains `$` — a function's return value
  // is inserted literally, with no `$&`/`$1` substitution. The previous
  // indexOf+substring loop rebuilt the entire string once per block, i.e.
  // O(blocks × length), which balloons memory and blocks the event loop when
  // the generated widget HTML contains many <script> tags.
  processed = processed.replace(
    /__SCRIPT_BLOCK_(\d+)__/g,
    (whole, index) => scriptBlocks[Number(index)] ?? whole,
  );

  return processed;
}

/**
 * Inject KaTeX CSS, JS, auto-render, and MutationObserver before </head>.
 * Falls back to appending at end if </head> is not found.
 * 资产走本站 /vendor/katex/（大陆访问 jsdelivr 不稳）；srcDoc iframe 继承父文档
 * base URL，绝对路径解析到本站。
 */
function injectKatex(html: string): string {
  const katexInjection = `
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<script src="/vendor/katex/katex.min.js"></script>
<script src="/vendor/katex/contrib/auto-render.min.js"></script>
<script>
document.addEventListener("DOMContentLoaded", function() {
    const katexOptions = {
        delimiters: [
            {left: '\\\\[', right: '\\\\]', display: true},
            {left: '\\\\(', right: '\\\\)', display: false},
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
        ],
        throwOnError: false,
        strict: false,
        trust: true
    };

    let renderTimeout;
    function safeRender() {
        if (renderTimeout) clearTimeout(renderTimeout);
        renderTimeout = setTimeout(() => {
            renderMathInElement(document.body, katexOptions);
        }, 100);
    }

    renderMathInElement(document.body, katexOptions);

    const observer = new MutationObserver((mutations) => {
        let shouldRender = false;
        mutations.forEach((mutation) => {
            if (mutation.target &&
                mutation.target.className &&
                typeof mutation.target.className === 'string' &&
                mutation.target.className.includes('katex')) {
                return;
            }
            shouldRender = true;
        });

        if (shouldRender) {
            safeRender();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    setInterval(() => {
        const text = document.body.innerText;
        if (text.includes('\\\\(') || text.includes('$$')) {
            safeRender();
        }
    }, 2000);
});
</script>`;

  // Use indexOf + substring instead of String.replace() because the
  // katexInjection string contains '$' characters that .replace() would
  // interpret as special substitution patterns ($$ → $, $' → post-match text).
  const headCloseIdx = html.indexOf('</head>');
  if (headCloseIdx !== -1) {
    return (
      html.substring(0, headCloseIdx) +
      katexInjection +
      '\n</head>' +
      html.substring(headCloseIdx + 7)
    );
  }

  // Fallback: inject before </body> if </head> is missing
  const bodyCloseIdx = html.indexOf('</body>');
  if (bodyCloseIdx !== -1) {
    return (
      html.substring(0, bodyCloseIdx) +
      katexInjection +
      '\n</body>' +
      html.substring(bodyCloseIdx + 7)
    );
  }

  // Last resort: append at end
  return html + katexInjection;
}
