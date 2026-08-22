import { describe, expect, it } from 'vitest';

import { notableClaims, readAllCourseAudits } from '@/lib/server/admin-overview';
import { readClassroom } from '@/lib/server/classroom-storage';

/**
 * 下钻页摊哪些判词。
 *
 * 起因是 2026-08-14 逐条对管理端设计稿复审：`fix`（改文）字段全库 138 条，
 * 56 条判错里 55 条都有——**页面上一条都没渲染过**。设计稿 §2 区 C 与演示台本
 * 要的正是「原句 claim / 判词 reason / 改文 fix」三栏，数据一直在盘上，只是没接出来。
 *
 * 这里钉两件事：改文不许再被丢掉；判为「核实」但仍带改文的那 13 条也要进列表
 * （判官认了断言却仍给改写，那同样是一次真实的干预）。
 */

describe('notableClaims', () => {
  it('判错与存疑都收', () => {
    const rows = notableClaims([
      { verdict: 'incorrect' },
      { verdict: 'uncertain' },
      { verdict: 'supported' },
    ]);
    expect(rows.map((r) => r.verdict)).toEqual(['incorrect', 'uncertain']);
  });

  it('判为核实但带改文的也收——这条正是原来漏掉的那类', () => {
    const rows = notableClaims([{ verdict: 'supported', fix: '改成这样' }]);
    expect(rows).toHaveLength(1);
  });

  it('核实且无改文的不收，否则 2231 条断言全铺开没人读', () => {
    expect(notableClaims([{ verdict: 'supported' }])).toEqual([]);
    expect(notableClaims([{ verdict: 'supported', fix: '' }])).toEqual([]);
  });

  it('claims 缺失时返回空数组，不抛', () => {
    expect(notableClaims(undefined)).toEqual([]);
  });
});

describe('真课程数据：改文没有被漏掉', () => {
  it('全库带改文的判词，一条不落地进入下钻列表', async () => {
    const courses = await readAllCourseAudits();
    // 本机读不到课程目录时跳过——这条测的是真数据，没有真数据就没有结论
    if (courses.length === 0) return;

    let withFix = 0;
    let shown = 0;
    for (const c of courses) {
      const course = await readClassroom(c.id);
      for (const scene of course?.scenes ?? []) {
        const claims =
          ((scene as { audit?: { claims?: Array<{ verdict?: string; fix?: string }> } }).audit
            ?.claims) ?? [];
        withFix += claims.filter((x) => x.fix).length;
        shown += notableClaims(claims).filter((x) => x.fix).length;
      }
    }
    expect(withFix).toBeGreaterThan(0);
    expect(shown).toBe(withFix);
  });
});
