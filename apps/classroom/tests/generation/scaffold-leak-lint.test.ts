/**
 * 提示词脚手架泄漏拦截。
 *
 * 线上实锤（2026-08-23，PLC 课屏 4）：四段逐字渲染「**本段目标：……**」加粗领句——
 * 段落规划标签进了学习者视野。
 *
 * grep 提示词里没有「本段目标」这个词：不是模板漏了变量，是**模型对
 * 「每段先明确目标」这类指令的表演性服从**，把规划过程当产物写了出来。
 * 改提示词治不了（换个说法照样写），只能机械拦。
 */
import { describe, expect, it } from 'vitest';

import { findScaffoldLeak, lintAdaptation } from '@/lib/generation/adaptation-lint';

describe('脚手架泄漏', () => {
  it('抓住线上真实出现的那一句', () => {
    const md = [
      '## 循环监视时间',
      '',
      '**本段目标：说明什么是循环监视时间以及为什么需要它。**',
      '',
      'PLC 每个扫描周期都有时间上限。',
    ].join('\n');
    const hit = findScaffoldLeak(md);
    expect(hit).not.toBeNull();
    expect(hit?.quote).toContain('本段目标');
  });

  it.each([
    '本节目标：介绍三种设定方式。',
    '**段落规划：先讲现象再讲机制**',
    '输出格式：分三点回答。',
    '第一段：讲清楚扫描周期的定义。',
  ])('也抓其它变体：%s', (line) => {
    expect(findScaffoldLeak(`正文一段。\n${line}\n正文二段。`)).not.toBeNull();
  });

  it.each([
    // 同题对照课实测的马甲：拦掉「本段目标」后模型换的说法
    '导读：本段通过食堂排队类比，解释什么是循环周期监视时间。',
    '**P7:** 循环监视时间的设定',
    '屏 3：扫描周期',
    '写作思路：先讲现象再讲机制。',
    '这里先说结论。本屏将带你把三个参数一次设完。',
  ])('抓住换了马甲的元话语：%s', (line) => {
    expect(findScaffoldLeak(`正文一段。
${line}
正文二段。`)).not.toBeNull();
  });

  it.each([
    // 1704 块主语料上量出来的教材正经写法，一条都不许拦
    '本节将讨论三种设定方式。',
    '本章介绍 PLC 的基本结构。',
    '下面这段代码会把定时器复位。',
    '定义：循环监视时间是一个扫描周期的时间上限。',
    '注意：超时会直接停机。',
    '步骤：先进参数页，再改阈值。',
    '例：设 80ms 任务留 70ms 余量。',
  ])('不误伤教材正经写法：%s', (line) => {
    expect(findScaffoldLeak(`正文一段。
${line}
正文二段。`)).toBeNull();
  });

  it('不误伤教材里正经的小节标题', () => {
    // 「学习目标」是教材常见的正经小节，不是元话语——一起拦就会把好内容判错
    const legit = [
      '## 学习目标',
      '',
      '读完这一节，你应当能独立设定循环监视时间。',
      '',
      '本章的目标读者是刚接触 PLC 的电气维修人员。',
      '',
      '我们的目标是把扫描周期讲清楚。',
    ].join('\n');
    expect(findScaffoldLeak(legit)).toBeNull();
  });

  it('判 A 类且与档位无关——任何档位都不该有', () => {
    const md = '**本段目标：讲清楚定时器。**\n\n定时器用于延时控制。';
    for (const tier of [null, 'L1', 'L2', 'L3'] as const) {
      const report = lintAdaptation(md, tier);
      const hit = report.violations.find((v) => v.ruleId === 'SCAFFOLD-LEAK');
      expect(hit, `档位 ${tier} 漏了`).toBeTruthy();
      expect(hit?.cls).toBe('A');
    }
  });

  it('干净正文不报', () => {
    const md = '## 循环监视时间\n\nPLC 每个扫描周期都有时间上限，超过就报错停机。';
    expect(lintAdaptation(md, 'L1').violations.some((v) => v.ruleId === 'SCAFFOLD-LEAK')).toBe(
      false,
    );
  });
});
