/**
 * 课程一致性状态：屏与屏之间共享「做过什么」。
 *
 * 病是**重**不是忘：一门 PLC 课四段四个类比、同一个 150ms 阈值推演三遍、
 * 两个教具全是步进器——三件事同一个形状，每屏各自即兴。
 *
 * 所以传结构化清单（做过什么、别再做），不传滚动摘要——摘要治的是
 * 「忘了前文」，塞更多前文只会让重复更像样。
 */
import { describe, expect, it } from 'vitest';

import {
  coherenceDirective,
  emptyProgress,
  extractAnalogy,
  extractWorkedExample,
  type CourseFrame,
} from '@/lib/generation/course-coherence';

describe('类比抽取', () => {
  it('认出要点里的比喻', () => {
    expect(extractAnalogy(['扫描周期就像食堂的微波炉加热'])).toContain('食堂的微波炉');
    expect(extractAnalogy(['可以想象成一条流水线'])).toContain('流水线');
  });

  it('认不出就不硬造', () => {
    expect(extractAnalogy(['PLC 的扫描周期由三段组成'])).toBeUndefined();
    expect(extractAnalogy()).toBeUndefined();
  });
});

describe('数字例登记', () => {
  it('带单位的多个数字才算一次推演', () => {
    const got = extractWorkedExample('计算监视时间', ['任务耗时 80ms，余量 70ms，合计 150ms']);
    expect(got).toContain('80ms');
    expect(got).toContain('150ms');
  });

  it('单个数字构不成推演', () => {
    expect(extractWorkedExample('什么是扫描周期', ['默认值是 150ms'])).toBeNull();
  });

  it('裸数字（章节号、序号）不进登记', () => {
    // 不过滤的话清单会被「第 3 章」「第 1 步」塞满
    expect(extractWorkedExample('第 3 章 第 1 节', ['第 2 步操作'])).toBeNull();
  });
});

describe('指令拼装', () => {
  const frame: CourseFrame = {
    analogy: '就像食堂的微波炉',
    analogyMap: [{ from: '加热时间', to: '扫描周期' }],
    numericExamples: [{ concept: '监视时间', example: '80ms 任务 + 70ms 余量 = 150ms' }],
    conceptOrder: ['扫描周期', '监视时间', '诊断缓冲区'],
  };

  it('空状态不产出指令——第一屏没有可沿用的东西', () => {
    expect(coherenceDirective({}, emptyProgress())).toBe('');
  });

  it('类比与映射一并下发', () => {
    const out = coherenceDirective(frame, emptyProgress());
    expect(out).toContain('食堂的微波炉');
    expect(out).toContain('加热时间 ↔ 扫描周期');
    expect(out).toContain('不要另起炉灶');
  });

  it('已讲概念要求「可引用但不重新解释」', () => {
    const out = coherenceDirective(frame, { ...emptyProgress(), concepts: ['扫描周期'] });
    expect(out).toContain('扫描周期');
    expect(out).toContain('不要重新解释');
  });

  it('已演例子明说换角度也算重复', () => {
    const out = coherenceDirective(frame, {
      ...emptyProgress(),
      workedExamples: ['监视时间：80ms / 70ms / 150ms'],
    });
    expect(out).toContain('换个角度讲同一个例子也算重复');
  });

  it('还没讲的概念不许当已知用', () => {
    const out = coherenceDirective(frame, { ...emptyProgress(), concepts: ['扫描周期'] });
    expect(out).toContain('还没讲的概念');
    expect(out).toContain('诊断缓冲区');
  });

  it('清单有条数上限——塞满会挤掉写作空间', () => {
    const many = Array.from({ length: 30 }, (_, i) => `概念${i}`);
    const out = coherenceDirective({}, { ...emptyProgress(), concepts: many });
    // 上限是**每块** 8 条（多块时各截各的），不是全文 8 条
    const block = out.slice(out.indexOf('已讲过的概念'));
    expect((block.match(/·/g) ?? []).length).toBeLessThanOrEqual(8);
    // 截的是老的、留的是新的——最近讲过的才最可能被重复
    expect(out).toContain('概念29');
    expect(out).not.toContain('· 概念0');
  });
});

describe('真的接进生成链了', () => {
  it('batch 生成逐屏记账并下发', () => {
    // 清单形态最容易「建了没接线」——状态建好了、指令函数写好了，
    // 就是没人调。静态断言守住。
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib/server/classroom-generation.ts'), 'utf-8');
    expect(src).toContain('coherenceDirective(frame, progress)');
    expect(src).toContain('progress.concepts.push');
    expect(src).toContain('progress.workedExamples.push');
    // 类比原来是边生成边捡（`frame.analogy ??=`），现在归课程级框架、
    // 开跑前从整份大纲一次定死——边捡的东西会随生成顺序漂，而它恰恰要全课一致。
    expect(src).toContain('courseFrameFromOutlines(outlines)');
    expect(src).not.toContain('frame.analogy ??=');
  });
});
