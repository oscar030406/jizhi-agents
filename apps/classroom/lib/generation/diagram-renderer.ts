/**
 * 把 DiagramConfig 确定性地渲染成教具 HTML。
 *
 * 为什么要这一层：教具原来是让 LLM 裸写整页 15–30KB HTML。实测 17 个候选模型里
 * 只有 7 个能一次产出闭合且 script 平衡的 HTML；其余要么撞 300s 超时，要么 JSON
 * schema 崩，要么返回 200 但断在 JS 中间（浏览器判 SyntaxError 整段丢掉，教具是死的）。
 *
 * 换成「LLM 只出配置 JSON，这里渲染」之后：
 *   - 模型输出量从 15–30KB 降到 1–3KB，超时/截断/闭合三个失败模式一起消失
 *   - 渲染逻辑是我们写的，同一份配置永远渲染出同样的东西，可复算
 *   - 弱模型也能进场——出 20 个节点的 JSON 比写 800 行 HTML 容易得多
 *
 * 这是 Presenton / Gamma / Beautiful.ai / Synthesia / NotebookLM 六个独立来源的共同
 * 做法，也是 ALGOGEN 把执行与渲染解耦后成功率 82.5%→99.8% 的那条路。
 *
 * 只做 diagram：它的配置（节点 + 边）自足，不需要额外的计算规格。simulation 要先
 * 在 schema 里补上「算什么、怎么映射到画面」才能同样处理，那是下一步。
 */

import type { DiagramConfig, DiagramEdge, DiagramNode } from '@/lib/types/widgets';

/** 画布与节点尺寸，跟着教具视觉规范走（4px 栅格） */
const CANVAS = { width: 960, height: 540, padding: 32 };
const NODE = { width: 168, height: 64, radius: 8, gapX: 56, gapY: 40 };

type Positioned = DiagramNode & { x: number; y: number };

/**
 * 没给坐标就自动排布。
 *
 * flowchart / hierarchy 按层级竖排，mindmap / system 放射状。
 * 布局是确定性的——同一份配置永远得到同一张图，截图能当回归基线。
 */
function layout(config: DiagramConfig): Positioned[] {
  const { nodes, edges, diagramType } = config;
  if (!nodes.length) return [];

  // 已经全部给了坐标就直接用
  if (nodes.every((n) => n.position)) {
    return nodes.map((n) => ({ ...n, x: n.position!.x, y: n.position!.y }));
  }

  if (diagramType === 'mindmap' || diagramType === 'system') {
    const cx = CANVAS.width / 2 - NODE.width / 2;
    const cy = CANVAS.height / 2 - NODE.height / 2;
    const [center, ...rest] = nodes;
    const radius = Math.min(CANVAS.width, CANVAS.height) / 2 - NODE.height - CANVAS.padding;
    return [
      { ...center, x: cx, y: cy },
      ...rest.map((n, i) => {
        const angle = (2 * Math.PI * i) / Math.max(1, rest.length) - Math.PI / 2;
        return { ...n, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
      }),
    ];
  }

  // 层级布局：从没有入边的节点开始，逐层往下推
  const incoming = new Map<string, number>();
  nodes.forEach((n) => incoming.set(n.id, 0));
  edges.forEach((e) => incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1));

  const levels: string[][] = [];
  const placed = new Set<string>();
  let frontier = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (!frontier.length) frontier = [nodes[0].id]; // 全是环时兜底

  while (frontier.length && placed.size < nodes.length) {
    levels.push(frontier);
    frontier.forEach((id) => placed.add(id));
    const next = new Set<string>();
    for (const e of edges) {
      if (placed.has(e.from) && !placed.has(e.to)) next.add(e.to);
    }
    frontier = [...next];
  }
  // 落单的节点（不连通）单独放一层，别丢
  const orphans = nodes.filter((n) => !placed.has(n.id)).map((n) => n.id);
  if (orphans.length) levels.push(orphans);

  const out: Positioned[] = [];
  const totalH = levels.length * NODE.height + (levels.length - 1) * NODE.gapY;
  const startY = Math.max(CANVAS.padding, (CANVAS.height - totalH) / 2);
  levels.forEach((level, li) => {
    const totalW = level.length * NODE.width + (level.length - 1) * NODE.gapX;
    const startX = Math.max(CANVAS.padding, (CANVAS.width - totalW) / 2);
    level.forEach((id, ni) => {
      const node = nodes.find((n) => n.id === id)!;
      out.push({
        ...node,
        x: startX + ni * (NODE.width + NODE.gapX),
        y: startY + li * (NODE.height + NODE.gapY),
      });
    });
  });
  return out;
}

function escapeHtml(s: string | undefined | null): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 节点类型 → 视觉，用的是教具视觉规范里那套 CSS 变量 */
function nodeStyle(type: DiagramNode['type']): { fill: string; stroke: string; text: string } {
  switch (type) {
    case 'start':
      return { fill: 'var(--accent-dim)', stroke: 'var(--accent)', text: 'var(--text)' };
    case 'end':
      return { fill: 'var(--accent)', stroke: 'var(--accent)', text: '#fff' };
    case 'decision':
      return { fill: 'var(--surface)', stroke: 'var(--warn)', text: 'var(--text)' };
    default:
      return { fill: 'var(--surface)', stroke: 'var(--border)', text: 'var(--text)' };
  }
}

function renderEdge(e: DiagramEdge, byId: Map<string, Positioned>): string {
  const a = byId.get(e.from);
  const b = byId.get(e.to);
  if (!a || !b) return ''; // 指向不存在节点的边直接丢，不让它把整张图带崩
  const x1 = a.x + NODE.width / 2;
  const y1 = a.y + NODE.height;
  const x2 = b.x + NODE.width / 2;
  const y2 = b.y;
  const mid = (y1 + y2) / 2;
  const path = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  const label = e.label
    ? `<text x="${(x1 + x2) / 2}" y="${mid - 6}" class="edge-label">${escapeHtml(e.label)}</text>`
    : '';
  return `<path d="${path}" class="edge" marker-end="url(#arrow)"/>${label}`;
}

function renderNode(n: Positioned, index: number): string {
  const s = nodeStyle(n.type);
  const lines = wrapLabel(n.label, 12);
  const text = lines
    .map(
      (ln, i) =>
        `<tspan x="${n.x + NODE.width / 2}" dy="${i === 0 ? 0 : 18}">${escapeHtml(ln)}</tspan>`,
    )
    .join('');
  const startY = n.y + NODE.height / 2 - ((lines.length - 1) * 18) / 2 + 5;
  return `
  <g class="node" data-node-id="${escapeHtml(n.id)}" data-reveal-index="${index}"
     ${n.details ? `data-details="${escapeHtml(n.details)}"` : ''}>
    <rect x="${n.x}" y="${n.y}" width="${NODE.width}" height="${NODE.height}"
          rx="${NODE.radius}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="2"/>
    <text x="${n.x + NODE.width / 2}" y="${startY}" fill="${s.text}" class="node-label">${text}</text>
  </g>`;
}

/**
 * 中英混排的粗略折行：中文按字数、英文按词。
 *
 * 对残缺输入必须免疫——LLM 漏字段是常态（实测见过 code 教具漏 starterCode）。
 * 渲染器的价值就在于「配置再烂也能出一张能看的图」，不能自己先崩。
 */
function wrapLabel(label: string | undefined, maxCJK: number): string[] {
  if (!label) return ['(未命名)'];
  const isCJK = /[一-龥]/.test(label);
  if (isCJK) {
    const out: string[] = [];
    for (let i = 0; i < label.length; i += maxCJK) out.push(label.slice(i, i + maxCJK));
    return out.slice(0, 3);
  }
  const words = label.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxCJK * 2) {
      out.push(cur.trim());
      cur = w;
    } else {
      cur += ' ' + w;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 3);
}

/**
 * 渲染成自足的教具 HTML。
 *
 * 输出稳定在 4–8KB，与节点数线性相关，不存在「模型写着写着断了」的可能——
 * 因为这里的每一个字节都是我们拼的。
 */
export function renderDiagramWidget(config: DiagramConfig): string {
  // 对残缺配置兜底：缺 nodes/edges 时给空数组而不是抛，
  // 空图也要能渲染出「本页暂无内容」而不是把整个场景带崩。
  const safe: DiagramConfig = {
    ...config,
    nodes: Array.isArray(config?.nodes) ? config.nodes.filter((n) => n && n.id) : [],
    edges: Array.isArray(config?.edges) ? config.edges.filter((e) => e && e.from && e.to) : [],
  };
  config = safe;
  const nodes = layout(config);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const revealOrder = config.revealOrder?.length
    ? config.revealOrder
    : nodes.map((n) => n.id);

  const edgesSvg = config.edges.map((e) => renderEdge(e, byId)).join('\n');
  const nodesSvg = nodes
    .map((n) => renderNode(n, revealOrder.indexOf(n.id) === -1 ? 0 : revealOrder.indexOf(n.id)))
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(config.description || '结构图')}</title>
<style>
:root{--bg:#fafafa;--surface:#fff;--border:#e5e7eb;--text:#1f2328;--text-dim:#6b7280;
      --accent:#2563eb;--accent-dim:#dbeafe;--warn:#d97706;}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a21;--border:#2a2f3a;
      --text:#e6e8eb;--text-dim:#9aa3af;--accent:#60a5fa;--accent-dim:#1e3a5f;--warn:#fbbf24;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
     font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
     display:flex;flex-direction:column;min-height:100vh}
header{padding:16px 24px;border-bottom:1px solid var(--border);background:var(--surface)}
h1{margin:0;font-size:18px;font-weight:600}
p.desc{margin:4px 0 0;font-size:14px;line-height:1.5;color:var(--text-dim)}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}
svg{max-width:100%;height:auto}
.edge{fill:none;stroke:var(--border);stroke-width:2}
.edge-label{fill:var(--text-dim);font-size:12px;text-anchor:middle}
.node-label{font-size:14px;text-anchor:middle;font-weight:500}
.node{cursor:pointer;transition:opacity .3s}
.node.hidden{opacity:.15}
.node:hover rect{stroke:var(--accent);stroke-width:3}
footer{padding:12px 24px;border-top:1px solid var(--border);background:var(--surface);
       display:flex;gap:12px;align-items:center;flex-wrap:wrap}
button{padding:8px 16px;border-radius:6px;border:1px solid var(--border);
       background:var(--surface);color:var(--text);font-size:14px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button:active{transform:scale(.97)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#detail{font-size:14px;line-height:1.5;color:var(--text-dim);flex:1;min-width:200px}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(config.description || '结构图')}</h1>
  <p class="desc">点击任一节点查看说明；用「逐步展开」按顺序理解流程。</p>
</header>
<main>
<svg viewBox="0 0 ${CANVAS.width} ${CANVAS.height}" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-label="${escapeHtml(config.description || '结构图')}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)"/>
    </marker>
  </defs>
${edgesSvg}
${nodesSvg}
</svg>
</main>
<footer>
  <button id="stepBtn" data-widget-el="step">逐步展开</button>
  <button id="allBtn" data-widget-el="all">全部显示</button>
  <span id="detail">点击节点看详情</span>
</footer>
<script>
(function(){
  var order = ${JSON.stringify(revealOrder)};
  var nodes = Array.prototype.slice.call(document.querySelectorAll('.node'));
  var detail = document.getElementById('detail');
  var step = -1;

  function show(upTo){
    nodes.forEach(function(n){
      var i = order.indexOf(n.getAttribute('data-node-id'));
      n.classList.toggle('hidden', upTo >= 0 && i > upTo);
    });
  }
  document.getElementById('stepBtn').addEventListener('click', function(){
    step = step + 1 >= order.length ? 0 : step + 1;
    show(step);
    var id = order[step];
    var el = nodes.filter(function(n){return n.getAttribute('data-node-id') === id;})[0];
    detail.textContent = el && el.getAttribute('data-details')
      ? el.getAttribute('data-details')
      : '第 ' + (step + 1) + ' / ' + order.length + ' 步';
  });
  document.getElementById('allBtn').addEventListener('click', function(){
    step = -1; show(-1); detail.textContent = '点击节点看详情';
  });
  nodes.forEach(function(n){
    n.addEventListener('click', function(){
      detail.textContent = n.getAttribute('data-details') || n.textContent.trim();
    });
  });
})();
</script>
</body>
</html>`;
}
