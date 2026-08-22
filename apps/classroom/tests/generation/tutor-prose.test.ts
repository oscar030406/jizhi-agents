/**
 * 导学口语里的 source_id 清理。
 *
 * 钉住实测那一句：「参考 [tu04#s2] 读到 query 函数时，注意看它怎么把问题向量
 * 和所有文档向量做比对。」——`tu04#s2` 是知识库 id，对学习者没有意义，
 * 而结构化引用走的是 explanation.source_ids（那一轮是空数组）。
 */

import { describe, expect, it } from 'vitest';

import { stripSourceIds } from '@/lib/generation/tutor-prose';

describe('导学口语清理 source_id', () => {
  it('删掉实测那一句里的标记，连同引导词', () => {
    const got = stripSourceIds(
      '参考 [tu04#s2] 读到 query 函数时，注意看它怎么把问题向量和所有文档向量做比对。',
    );
    expect(got).not.toContain('tu04#s2');
    expect(got).not.toContain('[');
    expect(got.startsWith('读到')).toBe(true);
  });

  it('裸写、不带方括号的也删', () => {
    expect(stripSourceIds('依据 ha08s03#s1，我们先看流程。')).not.toContain('#s');
  });

  it('句中多个标记一起删', () => {
    const got = stripSourceIds('见 [pg10#s1] 与 [tu04#s2]，两处讲的是同一件事。');
    expect(got).not.toContain('#s');
    expect(got).toContain('两处讲的是同一件事');
  });

  it('删完不留破碎标点', () => {
    const got = stripSourceIds('这一步，参考 [tu04#s2]，再往下读。');
    expect(got).not.toMatch(/，\s*，/);
    expect(got).not.toMatch(/^[，,、]/);
  });

  it('没有标记时原样返回——不做任何其他改写', () => {
    const s = '读到向量转换那一步时，盯住「为什么含义相近，数字就更近」这个核心直觉。';
    expect(stripSourceIds(s)).toBe(s);
  });

  it('不误伤正常的井号与方括号', () => {
    const s = '数组第 [0] 个元素，C# 是另一门语言。';
    expect(stripSourceIds(s)).toBe(s);
  });

  it('空串安全', () => {
    expect(stripSourceIds('')).toBe('');
  });
});
