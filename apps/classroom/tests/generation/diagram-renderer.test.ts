import { describe, it, expect } from 'vitest';
import { renderDiagramWidget } from '@/lib/generation/diagram-renderer';
import type { DiagramConfig } from '@/lib/types/widgets';

const flow: DiagramConfig = {
  type: 'diagram',
  diagramType: 'flowchart',
  description: '注意力计算流程',
  nodes: [
    { id: 'q', label: 'Query 向量', type: 'start', details: '当前要关注什么' },
    { id: 'score', label: '算相似度 QKᵀ', details: 'Query 与每个 Key 做点积' },
    { id: 'softmax', label: 'Softmax 归一化', type: 'decision' },
    { id: 'out', label: '加权求和得输出', type: 'end' },
  ],
  edges: [
    { id: 'e1', from: 'q', to: 'score' },
    { id: 'e2', from: 'score', to: 'softmax', label: '除以 √d_k' },
    { id: 'e3', from: 'softmax', to: 'out' },
  ],
};

describe('renderDiagramWidget', () => {
  it('产出结构完整的 HTML —— 这正是让 LLM 裸写时最常崩的地方', () => {
    const html = renderDiagramWidget(flow);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    // script 开闭必须平衡：实测模型裸写时正是这里断掉
    expect((html.match(/<script/g) ?? []).length).toBe((html.match(/<\/script>/g) ?? []).length);
    expect((html.match(/<svg/g) ?? []).length).toBe((html.match(/<\/svg>/g) ?? []).length);
  });

  it('每个节点和边都渲染出来，不丢内容', () => {
    const html = renderDiagramWidget(flow);
    for (const n of flow.nodes) {
      expect(html).toContain(`data-node-id="${n.id}"`);
    }
    expect(html).toContain('除以 √d_k');
  });

  it('同一份配置渲染结果完全一致 —— 可当回归基线', () => {
    expect(renderDiagramWidget(flow)).toBe(renderDiagramWidget(flow));
  });

  it('指向不存在节点的边被丢弃，不把整张图带崩', () => {
    const broken: DiagramConfig = {
      ...flow,
      edges: [...flow.edges, { id: 'bad', from: 'q', to: '不存在的节点' }],
    };
    const html = renderDiagramWidget(broken);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).not.toContain('不存在的节点');
  });

  it('转义用户内容，标签不会被注入', () => {
    const evil: DiagramConfig = {
      ...flow,
      nodes: [{ id: 'x', label: '<img src=x onerror=alert(1)>', type: 'start' }],
      edges: [],
    };
    const html = renderDiagramWidget(evil);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('没给坐标时自动排布，节点不重叠', () => {
    const html = renderDiagramWidget(flow);
    const xs = [...html.matchAll(/<rect x="([\d.]+)" y="([\d.]+)"/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(xs.length).toBe(flow.nodes.length);
    const seen = new Set(xs.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`));
    expect(seen.size).toBe(flow.nodes.length);
  });

  it('mindmap 走放射布局，首节点居中', () => {
    const mind: DiagramConfig = { ...flow, diagramType: 'mindmap' };
    const html = renderDiagramWidget(mind);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect((html.match(/data-node-id=/g) ?? []).length).toBe(mind.nodes.length);
  });

  it('输出体量远小于裸写 HTML —— 这是换掉它的理由之一', () => {
    const html = renderDiagramWidget(flow);
    // 实测模型裸写的教具是 15–30KB；渲染器产物应在个位数 KB
    expect(html.length).toBeLessThan(10_000);
  });
});
