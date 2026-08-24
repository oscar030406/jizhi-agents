/**
 * 全课类比要从第一屏的成品正文里定调。
 *
 * ## 病在哪
 *
 * `coherenceDirective` 的招牌那一条是【全课统一类比】——「这门课自始至终用同一个
 * 类比，不要另起炉灶换新比喻」。它只在 `frame.analogy` 存在时才拼进提示词，
 * 而 `frame = courseFrameFromOutlines(outlines)` 是去**大纲的 keyPoints** 里找
 * 「就像 / 好比 / 相当于」。
 *
 * 大纲要点的规格是三个短名词短语（模板原样：`["调节推力大小", "观察速度变化",
 * "实现软着陆"]`），**从头到尾没有一处要求写类比**，那个形状也装不下一句「就像……」。
 * 于是 `frame.analogy` 基本恒为 undefined，**那条指令从来没发出去过**。
 *
 * 2026-08-23 实测（`S7-1200 高速计数器原理`，产品默认形态、连贯层开着）——
 * 六屏六个不同喻体：人眼 / 上课分心 / 人工清点 / 发身份证 / 超速相机 / 超市计数器。
 * 正是那条指令明令禁止的形态。
 */
import { describe, expect, it } from 'vitest';

import {
  analogyFromGeneratedText,
  courseFrameFromOutlines,
} from '@/lib/generation/course-coherence';

describe('大纲里抠不出类比——这是病根', () => {
  it('大纲要点是短名词短语，装不下「就像……」', () => {
    const frame = courseFrameFromOutlines([
      { id: '1', title: '课程导入', keyPoints: ['调节推力大小', '观察速度变化', '实现软着陆'] },
      { id: '2', title: '核心概念', keyPoints: ['行星轨道运动', '行星相对大小'] },
    ]);
    expect(frame.analogy).toBeUndefined();
  });
});

describe('从成品正文里定调', () => {
  it('抠得出第一处比喻', () => {
    const text = '高速计数器直接在硬件层计数。就像超市门口独立的计数器。所以扫描周期再长也不会漏计。';
    expect(analogyFromGeneratedText(text)).toBe('就像超市门口独立的计数器');
  });

  it('六种比喻标记都认', () => {
    for (const mark of ['就像', '好比', '相当于', '类比成', '可以想象成', '把它想成']) {
      const got = analogyFromGeneratedText(`先讲清楚这件事。${mark}一台自动售货机。`);
      expect(got, `标记「${mark}」应当认得出`).toBe(`${mark}一台自动售货机`);
    }
  });

  it('喻体里带逗号时整段收进来，上限 24 字——判据是 ANALOGY_MARK 定的，这里只是钉住它', () => {
    // 一版用例写成「在逗号处断」，那是我对判据的想当然，不是代码的行为。
    // 收整段有它的道理：后面各屏要照抄这句话当统一类比，断在半截就成了别的意思。
    const got = analogyFromGeneratedText('就像超市门口独立的计数器，不管店长在忙什么，它自己一直在数。');
    expect(got).toBe('就像超市门口独立的计数器，不管店长在忙什么，它自己一');
    expect(got!.length).toBeLessThanOrEqual(2 + 24);
  });

  it('抠不出来就返回 undefined——不硬造', () => {
    // 硬造的比喻比没有更糟：它会把后面所有屏锚死在一个可能不合适的喻体上。
    const text = '高速计数器直接在硬件层计数，不受扫描周期限制。配置时要选对输入通道。';
    expect(analogyFromGeneratedText(text)).toBeUndefined();
  });

  it('空正文不炸也不造', () => {
    expect(analogyFromGeneratedText('')).toBeUndefined();
    expect(analogyFromGeneratedText('   \n  ')).toBeUndefined();
  });

  it('太短的片段不当句子——避免把标题里的半截话当成比喻', () => {
    // 6 字符下限：`就像` 后面至少要跟两个字才构成喻体（ANALOGY_MARK 自己的下限），
    // 这里挡的是被标点切碎的残片。
    expect(analogyFromGeneratedText('就像。这一屏讲计数器。')).toBeUndefined();
  });

  it('取第一处，不取最后一处——定调靠先出现的那个', () => {
    const text = '开头说：就像水管里的水流。后面又说：好比高速公路上的车流。';
    expect(analogyFromGeneratedText(text)).toBe('就像水管里的水流');
  });
});
