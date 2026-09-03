/**
 * 首屏输入框的匹配判据（components/home/public-landing.tsx）。
 *
 * 本单要治的病：原来命中不了就 `courses[0]` 兜底跳「最新一门」，
 * 访客看到的是随便一门课伪装成命中。所以这里最重要的一条断言是
 * **没命中就返回 null**——它红了说明兜底逻辑又回来了。
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type ClassroomSummary,
  groupSameTitle,
  matchCourse,
  pickSampleChips,
  rankByOverlap,
} from '@/components/home/public-landing';

const make = (id: string, title: string): ClassroomSummary => ({
  id,
  title,
  sceneCount: 1,
  createdAt: '2026-01-01',
  audit: null,
});

const COURSES = [
  make('c-rag', 'RAG 检索增强生成入门'),
  make('c-attn', 'Transformer 注意力机制详解'),
  make('c-agent', 'Agent 工具调用实战'),
];

describe('matchCourse：只认包含关系，不赌模糊匹配', () => {
  it('输入是课名的一段 → 命中那门课', () => {
    expect(matchCourse('注意力机制', COURSES)?.id).toBe('c-attn');
  });

  it('大小写与中英标点归一后再比', () => {
    expect(matchCourse('rag、检索增强生成', COURSES)?.id).toBe('c-rag');
  });

  it('输入整句包含课名 → 也算命中', () => {
    expect(matchCourse('我想学 Agent 工具调用实战，最好有例子', COURSES)?.id).toBe('c-agent');
  });

  it('沾不上边 → null，不兜底跳任何一门', () => {
    expect(matchCourse('怎么做红烧肉', COURSES)).toBeNull();
  });

  it('一个字符不算命中', () => {
    expect(matchCourse('A', COURSES)).toBeNull();
  });

  it('课程清单为空 → null', () => {
    expect(matchCourse('注意力机制', [])).toBeNull();
  });
});

describe('rankByOverlap：空态里的「最接近三门」', () => {
  it('最多给 3 门，且不改变「没命中」这个事实', () => {
    const closest = rankByOverlap('注意力和检索', COURSES);
    expect(closest).toHaveLength(3);
    expect(matchCourse('注意力和检索', COURSES)).toBeNull();
  });

  it('课少于 3 门时有几门给几门', () => {
    expect(rankByOverlap('检索', COURSES.slice(0, 2))).toHaveLength(2);
  });
});

describe('人工策展的名单指向真实落盘的课', () => {
  it('三条示例 chip 的课程 id 都能在 data/classrooms 里找到', () => {
    const onDisk = new Set(
      readdirSync(resolve(process.cwd(), 'data/classrooms'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5)),
    );
    // chip 的 id 写死在组件里，这里照抄一份做交叉核对——两边同时改错的概率远低于单边漂移
    for (const id of ['GsElavl9Nz', 'LnnLswdN1c', '0K904gtPQP']) {
      expect(onDisk.has(id), `chip 指向的课 ${id} 不在落盘目录里`).toBe(true);
    }
  });
});

/**
 * 同题折叠与示例 chip 去重。
 *
 * 病灶：课程墙按时间排，同一句需求生成的 5 门「RAG 如何减少幻觉」连着摆，
 * 首屏三个 chip 也恰好全是这一门。折叠只在展示层做——**一门课都不许消失**，
 * 所以最要紧的断言是 rep + others 加起来等于原始门数。
 */
describe('groupSameTitle', () => {
  const c = (id: string, title: string, flagged: number | null, sceneCount = 5) => ({
    id,
    title,
    sceneCount,
    createdAt: '2026-01-01',
    audit: flagged === null ? null : { claims: 10, flagged, sources: 1 },
  });

  it('同题只出一张代表卡，其余进 others，一门不丢', () => {
    const groups = groupSameTitle([
      c('a', 'RAG 如何减少幻觉', 10),
      c('b', 'RAG 如何减少幻觉', 5),
      c('c', '注意力机制计算详解', 3),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].rep.id).toBe('b'); // 打回最少的当代表
    expect(groups[0].others.map((x) => x.id)).toEqual(['a']);
    expect(groups.reduce((n, g) => n + 1 + g.others.length, 0)).toBe(3);
  });

  it('打回数相同时取场景数多的；没有审核账单的排最后', () => {
    const groups = groupSameTitle([
      c('few', '同一门', 2, 5),
      c('many', '同一门', 2, 12),
      c('unaudited', '同一门', null, 99),
    ]);
    expect(groups[0].rep.id).toBe('many');
    expect(groups[0].others.map((x) => x.id)).toEqual(['few', 'unaudited']);
  });
});

describe('pickSampleChips', () => {
  const c = (id: string, title: string) => ({
    id,
    title,
    sceneCount: 5,
    createdAt: '2026-01-01',
    audit: null,
  });
  const pool = [
    c('r1', 'RAG 如何减少幻觉'),
    c('r2', 'RAG 如何减少幻觉'),
    c('r3', 'RAG 如何减少幻觉'),
    c('a1', '注意力机制计算详解'),
    c('n1', '神经网络与反向传播入门'),
  ];

  it('没有阶次时至少保证三个标题互不相同', () => {
    const chips = pickSampleChips(pool);
    expect(chips.map((x) => x.title)).toEqual([
      'RAG 如何减少幻觉',
      '注意力机制计算详解',
      '神经网络与反向传播入门',
    ]);
  });

  it('有阶次时优先摊到不同阶', () => {
    const chips = pickSampleChips(pool, [
      { index: 1, title: '第 1 阶', conceptIds: [], courseIds: ['n1'] },
      { index: 2, title: '第 2 阶', conceptIds: [], courseIds: ['a1'] },
      { index: 3, title: '第 3 阶', conceptIds: [], courseIds: ['r1', 'r2', 'r3'] },
    ]);
    expect(chips.map((x) => x.id)).toEqual(['r1', 'a1', 'n1']);
  });
});
