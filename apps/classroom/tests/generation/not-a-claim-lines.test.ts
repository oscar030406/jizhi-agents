/**
 * 不是教学断言的行，别送审。
 *
 * ## 两类，处置不同
 *
 * 【一 · 提示词回声】生成器有时把提示词里的硬要求原样写进正文。交付前会被修订环
 * 清掉、学习者看不到，**但审核看得到**：判官与数字旁路把它们逐条抽成断言判「存疑」。
 *
 * 2026-08-24 实测（`G8moMoVeFb`，带证据生成的一门 RAG 课，证据块 25）：
 * 14 条存疑里 **10 条**是这么来的。**存疑率被自己的提示词顶高了**，
 * 而它正是我们用来论证「泛化域差在检索覆盖」的那个指标。
 *
 * 【二 · 摘录缺口说明】`（这里本应引用教材 [xxx#s1]，…）` 是 `excerptGap()`
 * **故意留给学习者看的**，用来避免指代悬空（原注释：「学习者至少知道这里本该有
 * 引用、可以去查那个出处」）。**它必须留在正文里** —— 这里只把它挡在审核之外，
 * 不从内容里删。判它真假没有意义：它是系统说明，不是关于世界的断言。
 *
 * 这条区分搞错的代价不对称：清错了是删掉用户该看的东西，漏挡只是数字难看。
 */
import { describe, expect, it } from 'vitest';

import {
  dropNonClaimSentences,
  extractTeachingText,
  isAuditableLine,
} from '@/lib/generation/hallucination-audit';

describe('提示词回声不当断言', () => {
  it('挡掉三种回声', () => {
    for (const line of [
      '- 【零基础硬要求】单个段落新术语不超过 2 个——宁可多分几段慢慢讲，不许术语连发；',
      '- 每页最多 1-2 个摘录占位符，选**承载推导和因果**的那几段，不要全部塞进去；',
      '选承载推导和因果的那几段',
    ]) {
      expect(isAuditableLine(line), line.slice(0, 24)).toBe(false);
    }
  });

  it('正常教学正文照旧送审', () => {
    for (const line of [
      '检索增强生成把外部资料放进上下文，让模型有据可依。',
      '高速计数器直接在硬件层计数，不受扫描周期限制。',
      '每页最多放两张图，超过就分屏。', // 形似但不是我们的指令
      '这一段要讲清楚新术语的来历。',
    ]) {
      expect(isAuditableLine(line), line.slice(0, 20)).toBe(true);
    }
  });
});

describe('摘录缺口说明：留在正文，挡在审核外', () => {
  const gap = '（这里本应引用教材 [ha08s01#s2]，这一屏引用已达上限，完整原文见该出处）';

  it('不送审——它是系统说明，不是关于世界的断言', () => {
    expect(isAuditableLine(gap)).toBe(false);
  });

  it('三种缺口理由都挡住（同一个 excerptGap 出口，理由不同）', () => {
    for (const why of [
      '这一屏引用已达上限，完整原文见该出处',
      '此处没有交代引用意图，原文未直接贴出',
      '但那段原文与这里讲的不咬合，贴上去反而误导',
    ]) {
      expect(isAuditableLine(`（这里本应引用教材 [tu01#s1]，${why}）`)).toBe(false);
    }
  });

  it('审核看到的正文里没有它，但这条测的只是审核侧——内容侧不许删', () => {
    // 这里只能证明「审核抽不到它」。「内容里还留着」由 excerptGap 的调用方保证，
    // 那条路径本测试不碰——**改动只在审核侧，内容一个字没动**。
    const content = {
      elements: [{ content: `<p>${gap}</p><p>检索增强生成让模型有据可依。</p>` }],
    };
    const text = extractTeachingText(content);
    expect(text).not.toContain('本应引用教材');
    expect(text).toContain('检索增强生成让模型有据可依');
  });
});

describe('连坐是这条改动最危险的失败形态', () => {
  it('一句回声不许把同段的正常正文带走', () => {
    // 失败方式不对称：漏挡只是数字难看，连坐是**整屏漏审**。
    // 实测栽过两次：① 一版整段判，一屏抽成空串；
    // ② 句读表里没有 `）`，而摘录缺口说明整句就是一对括号，跟后文切不开。
    const text =
      '（这里本应引用教材 [ha08s01#s2]，这一屏引用已达上限，完整原文见该出处）' +
      '检索增强生成把外部资料放进上下文。模型于是有据可依。';
    const kept = dropNonClaimSentences(text);
    expect(kept).toContain('检索增强生成把外部资料放进上下文');
    expect(kept).toContain('模型于是有据可依');
    expect(kept).not.toContain('本应引用教材');
  });

  it('回声夹在正文中间也只摘它自己', () => {
    const text =
      '第一句是正经教学内容。- 【零基础硬要求】单个段落新术语不超过 2 个；第三句也是正经内容。';
    const kept = dropNonClaimSentences(text);
    expect(kept).toContain('第一句是正经教学内容');
    expect(kept).toContain('第三句也是正经内容');
    expect(kept).not.toContain('零基础硬要求');
  });

  it('整段都是正经内容时原样返回，不做任何切割', () => {
    const text = '检索增强生成把外部资料放进上下文。模型于是有据可依。';
    expect(dropNonClaimSentences(text)).toBe(text);
  });

  it('整段确实只有一句回声时返回空——那时候没有可留的', () => {
    expect(dropNonClaimSentences('- 【零基础硬要求】单个段落新术语不超过 2 个；')).toBe('');
  });
});
