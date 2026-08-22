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
  matchCourse,
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
