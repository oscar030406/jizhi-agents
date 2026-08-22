/**
 * 工作台首屏两张卡的自测。
 *
 * 最要紧的一条：**路径卡不许写死主线条数/名字**。J8a 下一波会把 tracks 从三条岗位轨
 * 改成三模块，写死就得返工——所以这里拿一份**两条主线**的夹具跑同一套渲染，
 * 两条都要出现在 DOM 里，一条都不许丢、也不许多出写死的第三条。
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MasterySummaryCard,
  MyPathCard,
  summarizePath,
  type PathDataLike,
} from '@/components/home/learning-overview';
import realPath from '@/data/learning-path.json';

/** 两条主线的夹具：故意与线上三条不同名、不同数量 */
const TWO_TRACKS: PathDataLike = {
  nodes: [
    { id: 'n1', title: '第一门', courseId: 'c1' },
    { id: 'n2', title: '第二门', courseId: 'c2' },
    { id: 'n3', title: '第三门', courseId: null }, // 占位：还没生成
    { id: 'n4', title: '第四门', courseId: 'c4' },
  ],
  tracks: [
    { id: 't1', title: '甲线', nodeIds: ['n1', 'n2', 'n3'] },
    { id: 't2', title: '乙线', nodeIds: ['n1', 'n4'] },
  ],
};

describe('summarizePath', () => {
  it('学完/在学/待生成三种节点分别计数，下一门取第一门没学完的', () => {
    const { tracks, currentId } = summarizePath(TWO_TRACKS, { c1: 1, c2: 0.5 });
    expect(tracks.map((t) => t.id)).toEqual(['t1', 't2']);
    const [first, second] = tracks;
    expect(first).toMatchObject({ total: 3, done: 1, inProgress: 1, planned: 1 });
    expect(first.next).toMatchObject({ nodeId: 'n2', courseId: 'c2' });
    // 乙线只学过 c1（已学完），c4 没记录 ⇒ 下一门是 c4
    expect(second).toMatchObject({ total: 2, done: 1, inProgress: 0, planned: 0 });
    expect(second.next?.courseId).toBe('c4');
    // 学过的门数（含在学）最多的是甲线
    expect(currentId).toBe('t1');
  });

  it('没有学习记录时进度全 0，当前主线取第一条', () => {
    const { tracks, currentId } = summarizePath(TWO_TRACKS, {});
    expect(tracks.every((t) => t.done === 0 && t.inProgress === 0)).toBe(true);
    expect(currentId).toBe('t1');
    expect(tracks[0].next?.courseId).toBe('c1');
  });

  it('占位节点不算进已学完，也不会被选成下一门', () => {
    const { tracks } = summarizePath(TWO_TRACKS, { c1: 1, c2: 1 });
    expect(tracks[0]).toMatchObject({ done: 2, planned: 1 });
    expect(tracks[0].next).toBeUndefined(); // 只剩占位课 ⇒ 没有可直达的下一门
  });

  it('tracks 为空不炸', () => {
    expect(summarizePath({}, {})).toEqual({ tracks: [] });
  });

  it('线上那份 data/learning-path.json 能被同一套函数读出主线', () => {
    const { tracks } = summarizePath(realPath as PathDataLike, {});
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((t) => t.total > 0)).toBe(true);
  });
});

describe('MyPathCard', () => {
  it('两条主线的夹具下，两条主线名与下一门课链接都渲染出来（没写死三条）', () => {
    const html = renderToStaticMarkup(
      createElement(MyPathCard, { path: TWO_TRACKS, progressByCourseId: { c1: 1, c2: 0.5 } }),
    );
    expect(html).toContain('甲线');
    expect(html).toContain('乙线');
    expect(html).toContain('第二门');
    expect(html).toContain('/classroom/c2');
    expect(html).toContain('已学完 1 / 共 3 门');
    // 线上三条主线的名字一个都不该出现在这份夹具的渲染里
    expect(html).not.toContain('Agent 应用工程师');
  });

  it('默认读 data/learning-path.json，不传 path 也能渲染', () => {
    const html = renderToStaticMarkup(createElement(MyPathCard, { progressByCourseId: {} }));
    expect(html).toContain('我的学习路径');
    expect(html).toContain('/path');
  });
});

describe('MasterySummaryCard', () => {
  it('有测验记录时给出掌握数与薄弱点', () => {
    const html = renderToStaticMarkup(
      createElement(MasterySummaryCard, {
        profile: { conceptMastery: { 注意力机制: 0.85, 向量检索: 0.35, 梯度下降: 0.9 } },
      }),
    );
    expect(html).toContain('向量检索');
    expect(html).toContain('0.35');
    expect(html).toContain('/report');
  });

  it('没有测验记录时说清为什么空，而不是画个 0', () => {
    const html = renderToStaticMarkup(createElement(MasterySummaryCard, { profile: {} }));
    expect(html).toContain('还没有测验记录');
  });
});
