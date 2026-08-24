/**
 * 生成指令不许漏进讲稿。
 *
 * ## 这条钉的是什么
 *
 * 整课路给正文生成器拼四段指令（证据摘录、蓝图、课程一致性）。它们原来是
 * **原地累加到 `safeOutline.description`** 上的，而同一个 outline 后面又被喂给
 * 讲稿生成器（`generateSceneActions(p.safeOutline, …)`）——于是讲稿把指令
 * 当正文写了进去，审核再把它们逐条抽成断言判「存疑」。
 *
 * 2026-08-24 实测（P4 走读产物 `_ZbcAPo3x8`，ai 域 RAG 课）：17 条存疑里
 * **7 条**是这么来的：
 *
 *   - 【零基础硬要求】单个段落新术语不超过 2 个——宁可多分几段慢慢讲，不许术语连发；
 *   - 每页最多 1-2 个摘录占位符，选**承载推导和因果**的那几段，不要全部塞进去；
 *   - （这里本应引用教材 [ha08s04#s1]，这一屏引用已达上限，完整原文见该出处）
 *
 * 交付的讲稿是干净的（修订环把它们清掉了），学习者听不到——**所以光看产物发现不了**。
 * 害处在读数：**存疑率被这些非断言顶高了四成**，而存疑率正是我们用来判断
 * 「泛化域差在检索覆盖」的那个指标。量具被自己的提示词污染了。
 *
 * ## 为什么是源码扫描而不是行为测试
 *
 * 那段拼装在整课生成的大闭包里，没有可单独调用的出口；为它拆函数的改动面
 * 比这个 bug 本身还大。这条守的是**别再原地改写那一格**——形态明确、
 * 复发形态也明确，扫源码就够。真行为由 P4 走读那一轮人工核过。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () => readFileSync(join(process.cwd(), 'lib/server/classroom-generation.ts'), 'utf-8');

describe('生成指令只给正文生成器，不落到 outline 上', () => {
  it('不许再原地改写 safeOutline.description', () => {
    // 匹配赋值，不匹配读取：`safeOutline.description ?? ''` 这类读法是正常的。
    const assignments = src().match(/safeOutline\.description\s*=(?!=)/g) ?? [];
    expect(
      assignments,
      '原地改写会让讲稿生成器拿到带指令的 description——指令会被写进讲稿、' +
        '再被审核抽成断言判存疑，把存疑率顶高四成。改成拼一个 outlineForContent。',
    ).toEqual([]);
  });

  it('正文生成器拿带指令的那一份，讲稿生成器拿原始 outline', () => {
    const s = src();
    expect(s).toMatch(/generateSceneContent\(\s*outlineForContent\s*,/);
    // 讲稿两处调用（审核门开/关各一处）都必须用没加过指令的 safeOutline。
    const actionCalls = s.match(/generateSceneActions\(\s*([A-Za-z.]+)\s*,/g) ?? [];
    expect(actionCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of actionCalls) {
      expect(call).not.toContain('outlineForContent');
    }
  });

  it('指令原文确实来自这几个拼装函数——词表跟着真源走', () => {
    // 这三段字面量是上面那 7 条垃圾断言的出处。它们搬家了这条会红，
    // 提醒来人重新确认「指令有没有又漏进讲稿」，而不是默默失效。
    const evidence = readFileSync(
      join(process.cwd(), 'lib/generation/evidence-grounding.ts'),
      'utf-8',
    );
    const lint = readFileSync(join(process.cwd(), 'lib/generation/adaptation-lint.ts'), 'utf-8');
    expect(evidence).toContain('每页最多 1-2 个摘录占位符');
    expect(evidence).toContain('这一屏引用已达上限');
    expect(lint).toContain('【零基础硬要求】');
  });
});
