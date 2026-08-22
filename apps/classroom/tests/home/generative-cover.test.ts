/**
 * 生成式课程封面自测：
 * 1) 确定性——同名两次渲染输出完全一致（SSR/CSR 一致的前提）；
 * 2) 差异性——一批课程名要命中多个构图模板，不能全长一个样；
 * 3) 渐变导出兼容——course-card 的 courseCoverGradient 仍可用且确定。
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GenerativeCover } from '@/components/home/generative-cover';
import { courseCoverGradient } from '@/components/home/course-card';

const NAMES = [
  '注意力机制入门',
  '梯度下降与优化',
  'RAG 检索增强生成',
  'Agent 工具调用实战',
  'Transformer 架构解析',
  'KV 缓存与推理加速',
  '神经网络基础',
  '大模型安全与对齐',
  '概率论快速上手',
  '提示工程七讲',
];

function render(name: string): string {
  return renderToStaticMarkup(createElement(GenerativeCover, { name }));
}

describe('GenerativeCover', () => {
  it('同名两次渲染输出完全一致（确定性）', () => {
    for (const name of NAMES.slice(0, 3)) {
      expect(render(name)).toBe(render(name));
    }
  });

  it('十个课程名至少命中 3 种构图模板', () => {
    const templates = new Set(
      NAMES.map((name) => render(name).match(/data-template="(\d+)"/)?.[1]),
    );
    templates.delete(undefined);
    expect(templates.size).toBeGreaterThanOrEqual(3);
  });

  it('不同课程名产出不同封面', () => {
    const outputs = new Set(NAMES.map(render));
    expect(outputs.size).toBe(NAMES.length);
  });

  it('courseCoverGradient 保持导出且确定', () => {
    const g = courseCoverGradient('注意力机制入门');
    expect(g).toContain('linear-gradient');
    expect(g).toBe(courseCoverGradient('注意力机制入门'));
  });
});
