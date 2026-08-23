/**
 * canvas 槽位路的脚手架清除。
 *
 * 讲义流有 `runAdaptationLintLoop`，槽位路与自由版面路此前一条机械检查都没跑——
 * 线上那一屏四个「本段目标：」就是从槽位路出去的。**同一份内容两种形态、
 * 处理只覆盖一种**，这一族的第 N 次。
 */
import { describe, expect, it } from 'vitest';

import { scrubScaffoldHtml } from '@/lib/generation/adaptation-lint';

describe('canvas 元素脚手架清除', () => {
  it('删掉元话语段，正文留下', () => {
    const html =
      '<p><strong>本段目标：说明什么是循环监视时间。</strong></p>' +
      '<p>PLC 每个扫描周期都有时间上限，超过就报错停机。</p>' +
      '<p>默认 150ms，可以在参数页改。</p>';
    const out = scrubScaffoldHtml(html);
    expect(out.dropped).toHaveLength(1);
    expect(out.html).not.toContain('本段目标');
    expect(out.html).toContain('扫描周期都有时间上限');
    expect(out.html).toContain('默认 150ms');
  });

  it('换了马甲的也删', () => {
    const html =
      '<p>导读：本段通过食堂排队类比，解释什么是程序周期。</p>' +
      '<p>扫描周期指 PLC 跑完一圈用户程序所需的时间。</p>' +
      '<p>它受程序长度和 CPU 速度影响。</p>';
    expect(scrubScaffoldHtml(html).html).not.toContain('导读');
  });

  it('安全阀：删完不足一半就整个放弃', () => {
    // 整屏几乎全是元话语——删了就剩一句，宁可留着让人看见问题
    const html = '<p><strong>本段目标：讲清楚定时器。</strong></p><p>好。</p>';
    const out = scrubScaffoldHtml(html);
    expect(out.dropped).toHaveLength(0);
    expect(out.html).toBe(html);
  });

  it('干净正文原样返回（同一个字符串引用）', () => {
    const html = '<p>定时器用于延时控制。</p>';
    expect(scrubScaffoldHtml(html).html).toBe(html);
  });

  it('三路出口挂在同一处——各路各挂会漏', () => {
    // 路障：`generateSlideContent` 是讲义/槽位/自由版面三条路的共同出口，
    // 清除挂在这里。谁把它拆回各路各挂，这条会提醒他漏一条等于没挂。
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/generation/scene-generator.ts'),
      'utf-8',
    );
    expect(src).toContain('generateSlideContentRaw');
    expect(src).toMatch(/scrubScaffoldHtml/);
  });
});
