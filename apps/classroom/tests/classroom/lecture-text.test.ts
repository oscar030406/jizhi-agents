import { describe, expect, it } from 'vitest';
import { sceneLectureText } from '@/lib/classroom/lecture-text';
import type { Scene } from '@/lib/types/stage';

function slideScene(elements: unknown[]): Scene {
  return {
    id: 's1',
    stageId: 'st1',
    title: '注意力机制',
    type: 'slide',
    order: 0,
    content: { type: 'slide', canvas: { elements } },
    actions: [],
  } as unknown as Scene;
}

describe('sceneLectureText', () => {
  it('抽 text 元素纯文本，按版面序拼接，跳过非文本元素', () => {
    const text = sceneLectureText(
      slideScene([
        { type: 'image', src: 'data:x', top: 0 },
        { type: 'text', content: '<p>第二段：<strong>权重</strong>越高影响越大。</p>', top: 200 },
        { type: 'text', content: '<h2>注意力机制</h2>', top: 100 },
      ]),
    );
    expect(text).toContain('注意力机制');
    expect(text).toContain('权重 越高影响越大');
    expect(text.indexOf('注意力机制')).toBeLessThan(text.indexOf('权重'));
    expect(text).not.toContain('<');
  });

  it('无场景或无文本元素时返回空串（面板据此回落概念题库）', () => {
    expect(sceneLectureText(null)).toBe('');
    expect(sceneLectureText(slideScene([{ type: 'image', src: 'x' }]))).toBe('');
  });

  it('超长讲义截 3000 字（与引擎侧上限对齐）', () => {
    const long = `<p>${'字'.repeat(5000)}</p>`;
    expect(sceneLectureText(slideScene([{ type: 'text', content: long, top: 0 }])).length).toBe(3000);
  });
});
