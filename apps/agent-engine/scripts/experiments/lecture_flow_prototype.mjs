/**
 * 讲义流原型（两段走第二段）—— 同一门课的「流式讲义 + 穿插交互教具」形态。
 *
 * 对照对象：persona2_zero_r1（模板槽位幻灯片版）。本脚本产出：
 *   data/eval/lecture_proto/lecture_zero_r1.md         讲义 markdown
 *   data/eval/lecture_proto/lecture_zero_r1.html       自包含 HTML（教具 iframe 内嵌）
 *   data/eval/zero_prior/lecture_zero_r1.materials.txt 评测臂材料（与 capture 同格式思路）
 *
 * 之后用 learning_eval 闭卷对照两形态（--fork-prefix lecture_zero）。
 * 布局结论出处：docs/04-research/slide_generation_research_20260803.md ——
 * 流式文档布局由渲染器排，溢出/重叠在构造上不可能；密度天然高于幻灯片。
 *
 * 用法（需 8001 引擎在跑、SILICONFLOW_API_KEY 就位、代理已剥）：
 *   node scripts/experiments/lecture_flow_prototype.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { callLLM } from '../learning_eval/llm.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = path.join(ROOT, 'data/eval/zero_prior/persona2_zero_r1.scenes.json');
const OUT_DIR = path.join(ROOT, 'data/eval/lecture_proto');
const MATERIALS_OUT = path.join(ROOT, 'data/eval/zero_prior/lecture_zero_r1.materials.txt');

const MODEL = process.env.LECTURE_MODEL || 'deepseek-ai/DeepSeek-V3.2';
const GROUNDING_URL = process.env.GROUNDING_URL || 'http://127.0.0.1:8001';
const GROUNDING_TOKEN = process.env.GROUNDING_TOKEN || 'demo-internal-token';

// ── 证据检索（与课堂 fetchEvidence 同一引擎端点）─────────────────────────
async function fetchEvidence(query) {
  try {
    const url = `${GROUNDING_URL}/internal/v1/personalize/evidence?${new URLSearchParams({
      query,
      top_k: '6',
      corpus: 'ai',
    })}`;
    const r = await fetch(url, {
      headers: { 'x-internal-token': GROUNDING_TOKEN },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const chunks = j?.data?.chunks ?? [];
    if (!chunks.length || j?.data?.missing_evidence_warning) return null;
    return chunks;
  } catch {
    return null;
  }
}

// ── 摘录注入（与课堂 injectExcerpts 同一格式与缰绳：每节≤2、全课去重回指）──
const PLACEHOLDER = /\{\{\s*摘录\s*[:：]\s*([A-Za-z0-9_#\-]+)\s*\}\}/g;
function injectExcerpts(md, chunks, usedIds) {
  const byId = new Map(chunks.map((c) => [c.source_id, c]));
  let injected = 0;
  return md.replace(PLACEHOLDER, (_m, sid) => {
    const chunk = byId.get(sid);
    if (!chunk) return '';
    if (usedIds.has(sid)) return `（本段教材前文已引用，见 [${sid}]）`;
    if (injected >= 2) return '';
    injected += 1;
    usedIds.add(sid);
    let body = chunk.content
      .replace(/^#{1,6}\s+.*$/gm, '')
      // 多行 $$...$$ 压成单行：blockquote 渲染按行拆文本节点，跨行公式
      // KaTeX 永远匹配不上（实测裸奔给用户看了）
      .replace(/\$\$([\s\S]*?)\$\$/g, (_m2, f) => `$$${f.replace(/\s*\n\s*/g, ' ').trim()}$$`)
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (body.length > 600) {
      body = body.slice(0, 600);
      // 截断不许落在公式中间：$$ 奇数个说明斩断了公式，回退到上一个完整块后
      if ((body.match(/\$\$/g) ?? []).length % 2 === 1) {
        body = body.slice(0, body.lastIndexOf('$$'));
      }
      body = body.trimEnd() + '…';
    }
    return `\n> 📖 ${body.replace(/\n/g, '\n> ')}\n> —— 摘自《${chunk.title}》[${sid}]\n`;
  });
}

const SYSTEM = `你是一位技术教材作者，为一节课的一个小节写讲义正文（markdown）。

铁律：
1. 讲义不是幻灯片要点，是连贯正文：小标题（###）+ 段落 + 必要的列表/代码/公式交错。
2. 每个机制必须带可验证的"为什么"，三选一至少占其一：
   - 因果链一步步走（"d_k 大 → 点积方差大 → softmax 饱和 → 梯度消失"）；
   - 带真实数字的手算微例（"分数 [8.0, 0.1] → softmax [0.9996, 0.0004]"）；
   - 参数后果（关键参数翻倍/砍半/去掉会发生什么）。
3. 有可运行代码就贴真实代码块（python fence），别写伪代码碎片。
4. 数学表达式用 $...$ 或 $$...$$。
5. 若下方给了参考资料清单，正文中需要引用教材原文处写占位符 {{摘录:资料id}}，
   独立成行；每节最多 2 个；你自己的文字不得复述摘录里的具体事实，只写导读与衔接。
6. 中文写作，句子长短交错；禁止"总而言之""让我们一起"这类套话，禁止空洞排比。
7. 只输出这一小节的 markdown 正文，不要输出小节大标题（外层会加 ## 标题）。`;

function userPrompt(sceneTitle, boardLines, chunks) {
  const menu = chunks?.length
    ? `\n\n参考资料清单（占位符可选 id）：\n${chunks
        .map((c) => `- {{摘录:${c.source_id}}} —— ${c.title}（${c.content.length} 字）`)
        .join('\n')}`
    : '';
  return (
    `小节标题：${sceneTitle}\n` +
    `该小节在幻灯片版里的板书要点（供内容对齐，不要照抄成要点清单）：\n` +
    boardLines.map((l) => `- ${l}`).join('\n') +
    menu +
    `\n\n写出这一小节的讲义正文（400-800 字，含至少一个"为什么"证据件）。`
  );
}

// ── 受控 markdown → HTML（只支持我们规定的子集，无第三方依赖）────────────
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listBuf = [];
  let quoteBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul>${listBuf.map((l) => `<li>${l}</li>`).join('')}</ul>`);
      listBuf = [];
    }
  };
  const flushQuote = () => {
    if (quoteBuf.length) {
      out.push(`<blockquote>${quoteBuf.join('<br>')}</blockquote>`);
      quoteBuf = [];
    }
  };
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (/^<!--WIDGET:\d+-->$/.test(line.trim())) {
      flushList();
      flushQuote();
      out.push(line.trim());
      continue;
    }
    if (line.startsWith('> ')) {
      flushList();
      quoteBuf.push(inline(line.slice(2)));
      continue;
    }
    flushQuote();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      listBuf.push(inline(line.replace(/^[-*]\s+/, '')));
      continue;
    }
    flushList();
    if (line.trim() === '') continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  flushQuote();
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return out.join('\n');
}

function htmlShell(title, bodyHtml) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: "Source Han Serif SC", Georgia, serif; background: #fdfbf7; color: #332f2b;
         max-width: 760px; margin: 0 auto; padding: 48px 24px 96px; line-height: 1.85; }
  h1 { font-size: 1.9em; border-bottom: 2px solid #e5ded2; padding-bottom: .4em; }
  h2 { font-size: 1.4em; margin-top: 2.2em; }
  h3 { font-size: 1.12em; margin-top: 1.6em; color: #4a453f; }
  blockquote { border-left: 3px solid #7c6bd6; background: #f3effc; margin: 1em 0;
               padding: .7em 1em; border-radius: 0 8px 8px 0; font-size: .95em; }
  pre { background: #332f2b; color: #e8e4dd; padding: 1em; border-radius: 10px;
        overflow-x: auto; font-size: .88em; line-height: 1.55; }
  code { font-family: Consolas, monospace; }
  p > code { background: #f0ebe2; padding: 0 .3em; border-radius: 4px; }
  iframe.widget { width: 100%; height: 660px; border: 1px solid #d8d2c8; border-radius: 12px;
                  background: #fff; margin: 1.2em 0; }
  .widget-label { font-size: .85em; color: #8a8378; margin-bottom: .3em; }
</style>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],ignoredTags:['script','noscript','style','textarea','pre','code','iframe']});"></script>
</head><body>
${bodyHtml}
</body></html>`;
}

// ── 主流程 ─────────────────────────────────────────────────────────────
// --render-only：跳过 LLM，用已存在的 md 重出 HTML/materials（渲染层调试省钱）
const RENDER_ONLY = process.argv.includes('--render-only');
const course = JSON.parse(fs.readFileSync(SOURCE, 'utf-8'));
console.log(`讲义流原型：${course.courseTitle}（${course.scenes.length} 场景，模型 ${MODEL}）`);

// 从 materials.txt 提取各页板书行，作为内容对齐输入
const materials = fs.readFileSync(
  path.join(ROOT, 'data/eval/zero_prior/persona2_zero_r1.materials.txt'),
  'utf-8',
);
const pageBlocks = materials.split(/^===== 第 \d+ 页：.*=====$/m).slice(1);
const boardByIndex = pageBlocks.map((b) =>
  [...b.matchAll(/^\[板书\] (.*)$/gm)].map((m) => m[1]),
);

const usedIds = new Set();
const mdParts = [`# ${course.courseTitle}（讲义版）`];
const widgets = [];

for (const [i, scene] of course.scenes.entries()) {
  if (scene.type === 'interactive') {
    widgets.push({ index: widgets.length, title: scene.title, html: scene.content?.html ?? '' });
    mdParts.push(
      `\n## ${scene.title}\n\n【交互教具】动手改参数，验证上一节的推导在数值上真的成立。\n\n<!--WIDGET:${widgets.length - 1}-->\n`,
    );
    continue;
  }
  if (RENDER_ONLY) continue;
  if (scene.type === 'quiz') {
    mdParts.push(`\n## ${scene.title}\n\n【知识检查】本节配套测验在课堂内完成，讲义不重复题目。\n`);
    continue;
  }
  const board = boardByIndex[i] ?? [];
  const chunks = await fetchEvidence(scene.title);
  process.stdout.write(`  [${i + 1}/${course.scenes.length}] ${scene.title} 生成中…`);
  let md = await callLLM(MODEL, SYSTEM, userPrompt(scene.title, board, chunks ?? []), {
    maxTokens: 2500,
  });
  md = md.trim();
  // 整体被 ```markdown 包裹时剥壳（只在首行是围栏时动，别误伤正文代码块）
  if (/^```(markdown)?\s*$/.test(md.split('\n')[0] ?? '')) {
    const body = md.split('\n').slice(1);
    if (/^```\s*$/.test(body[body.length - 1] ?? '')) body.pop();
    md = body.join('\n').trim();
  }
  // 围栏配平：本节 ``` 行数为奇数会把后续所有小节吞进一个 <pre>——强制闭合
  const fenceCount = (md.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) md += '\n```';
  if (chunks) md = injectExcerpts(md, chunks, usedIds);
  // 双保险：ASCII id 之外，模型会原样照抄示例（{{摘录:资料id}} 中文 id 漏网）
  md = md.replace(PLACEHOLDER, '').replace(/\{\{\s*摘录[^}]*\}\}/g, '');
  // 模型不听"别输出小节标题"的话，会再写一个同名 ###——去重
  md = md.replace(/^#{1,4}\s*(.+)\s*\n+/, (m, h) => (h.trim() === scene.title ? '' : m));
  mdParts.push(`\n## ${scene.title}\n\n${md}\n`);
  console.log(' ok');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const fullMd = RENDER_ONLY
  ? fs.readFileSync(path.join(OUT_DIR, 'lecture_zero_r1.md'), 'utf-8')
  : mdParts.join('\n');
if (!RENDER_ONLY) fs.writeFileSync(path.join(OUT_DIR, 'lecture_zero_r1.md'), fullMd);

// HTML：widget 占位符替换为 iframe srcdoc 内嵌
let bodyHtml = mdToHtml(fullMd);
for (const w of widgets) {
  // 课堂 widget 里的「资料摘录」占位框等课堂渲染器来填，srcdoc 裸嵌没人填，
  // 会露出 "Waiting for renderer" 破相——原型环境直接藏掉。
  // ponytail: 讲义流若转正，教具要走课堂 widget 渲染器（含摘录填充协议），srcdoc 是权宜
  const patched = `<style>.citation-box{display:none!important}</style>${w.html}`;
  const srcdoc = patched.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // 替换必须用函数：widget 源码里满是 $ 序列（${...}），当替换串会触发
  // String.replace 的 $&/$' 回引语法，把整段文档重复注入（实测炸过一次）。
  bodyHtml = bodyHtml.replace(
    `<!--WIDGET:${w.index}-->`,
    () =>
      `<div class="widget-label">交互教具 · ${w.title}——点「下一步」逐段展开，配合上文推导对照着看</div>\n<iframe class="widget" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>`,
  );
}
fs.writeFileSync(path.join(OUT_DIR, 'lecture_zero_r1.html'), htmlShell(course.courseTitle, bodyHtml));

// 评测臂材料：讲义全文（widget 用一行占位说明，与幻灯片材料的"教具说明"对等）
const materialsTxt = fullMd
  .replace(/<!--WIDGET:(\d+)-->/g, (_m, n) => `[交互教具] ${widgets[+n]?.title ?? ''}`)
  .replace(/^```.*$/gm, '')
  .replace(/[#>*`]/g, '')
  .replace(/\n{3,}/g, '\n\n');
fs.writeFileSync(MATERIALS_OUT, materialsTxt);

console.log(`\n讲义 markdown → ${path.join(OUT_DIR, 'lecture_zero_r1.md')}`);
console.log(`自包含 HTML   → ${path.join(OUT_DIR, 'lecture_zero_r1.html')}`);
console.log(`评测臂材料    → ${MATERIALS_OUT}`);
console.log(`教具内嵌 ${widgets.length} 个，摘录引用 ${usedIds.size} 段`);
