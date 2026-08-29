/**
 * 域归属不许静默回退主域。
 *
 * 2026-08-23 垃圾域清理撞出的口径打架：`c3HH74qwAH` 自己记着 `rag-adv`、
 * `sVnMPbeeXn` 自己记着 `vecdb`，但两门都挂在学习路径上，被「路径上的课一律判 ai」
 * 碾成 `ai`——**课堂侧的域视图与课程自身的出处记录给出两个答案**。
 *
 * 根因不是「查不到就回退」，是**弱信号的纠偏规则压过了强信号**：
 * 路径规则本来只为纠正前缀投票误判而存在，没有理由改写课程自己写下的出身。
 */
import { describe, expect, it } from 'vitest';

import {
  courseDomainOf,
  RETIRED_DOMAIN,
  UNKNOWN_DOMAIN,
} from '@/lib/server/course-domains';

const course = (over: Record<string, unknown> = {}) =>
  ({ scenes: [], ...over }) as Parameters<typeof courseDomainOf>[0];

describe('课程自己记的出身最大', () => {
  it('路径上的课，也不许改写它自己记的库', () => {
    // 这就是 c3HH74qwAH 的原形
    const c = course({ stage: { origin: { corpus: 'rag-adv' } } });
    expect(courseDomainOf(c, true)).toBe('rag-adv');
  });

  it('服务端生成记录里的库同样压得过路径规则', () => {
    const c = course({ generation: { profile: { corpus: 'vecdb' } } });
    expect(courseDomainOf(c, true)).toBe('vecdb');
  });
});

describe('em 前缀归主库', () => {
  it('引 em 块的课路径内外都判 ai（2026-08-28 起 em 规则直接映射主库，不再靠路径纠偏）', () => {
    const c = course({ scenes: [{ audit: { sources: [{ source_id: 'em1#s2' }] } }] });
    expect(courseDomainOf(c, true)).toBe('ai');
    expect(courseDomainOf(c, false)).toBe('ai');
  });
});

describe('判不出来就说判不出来', () => {
  it('什么信号都没有 → unknown，不冒充主域', () => {
    expect(courseDomainOf(course(), false)).toBe(UNKNOWN_DOMAIN);
  });

  it('认不出的前缀不投票给 ai', () => {
    // 投币新建的库前缀一律不在手工前缀表里。默认投主域等于每建一个新库
    // 就往 ai 里掺一批不属于它的课。
    const c = course({ scenes: [{ audit: { sources: [{ source_id: 'brand-new-lib#s1' }] } }] });
    expect(courseDomainOf(c, false)).toBe(UNKNOWN_DOMAIN);
  });
});

describe('库被删了如实标 retired', () => {
  const live = new Set(['ai', 'iotdb', 'odoo']);

  it('出身记的库不在清单里 → retired', () => {
    const c = course({ stage: { origin: { corpus: 'vecdb' } } });
    expect(courseDomainOf(c, false, live)).toBe(RETIRED_DOMAIN);
  });

  it('库还在就照常返回库名', () => {
    const c = course({ stage: { origin: { corpus: 'iotdb' } } });
    expect(courseDomainOf(c, false, live)).toBe('iotdb');
  });

  it('清单读不到时跳过这一判，不把所有课都判成 retired', () => {
    const c = course({ stage: { origin: { corpus: 'vecdb' } } });
    expect(courseDomainOf(c, false, undefined)).toBe('vecdb');
  });
});

describe('两门孤儿课已经删掉', () => {
  it('课程目录里不该再有它们', async () => {
    const { promises: fs } = await import('node:fs');
    for (const id of ['c3HH74qwAH', 'sVnMPbeeXn']) {
      await expect(fs.stat(`data/classrooms/${id}.json`)).rejects.toThrow();
    }
  });

  it('学习路径的节点留着，只摘掉了 courseId', async () => {
    const { promises: fs } = await import('node:fs');
    const lp = JSON.parse(await fs.readFile('data/learning-path.json', 'utf-8')) as {
      nodes?: Array<{ id: string; courseId?: string }>;
    };
    const ids = (lp.nodes ?? []).map((n) => n.id);
    // 教研产物不随某一次实例化一起删
    expect(ids).toContain('vector-search');
    expect(ids).toContain('rag-advanced');
    const linked = (lp.nodes ?? []).map((n) => n.courseId).filter(Boolean);
    expect(linked).not.toContain('c3HH74qwAH');
    expect(linked).not.toContain('sVnMPbeeXn');
  });
});
