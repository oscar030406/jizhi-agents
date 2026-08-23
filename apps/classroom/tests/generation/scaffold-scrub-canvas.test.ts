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

  it('删掉过半也照删——阈值护错过一次对象，不留了', () => {
    const html = Array.from(
      { length: 5 },
      (_, i) =>
        `<p><strong>本段目标：讲第 ${i + 1} 件事。</strong></p>` +
        `<p>定时器第 ${i + 1} 段正文，讲的是延时控制怎么配。</p>`,
    ).join('');
    const out = scrubScaffoldHtml(html);
    expect(out.dropped).toHaveLength(5);
    expect(out.empty).toBe(false);
    expect(out.html).not.toContain('本段目标');
    expect(out.html).toContain('延时控制怎么配');
  });

  it('整条都是脚手架时报 empty，不自己决定丢不丢', () => {
    // 屏 2 真产物的形状：一个元素的全部内容就是一行标签。
    // 「丢了会不会把屏清空」要看兄弟元素，那是调用方的视野，这里只如实报。
    const out = scrubScaffoldHtml('<p><strong>本段目标：讲清楚定时器。</strong></p>');
    expect(out.empty).toBe(true);
    expect(out.dropped).toHaveLength(1);
  });

  it('还剩正文就不叫 empty', () => {
    const out = scrubScaffoldHtml(
      '<p><strong>本段目标：讲清楚定时器。</strong></p><p>定时器把输出推迟一段时间。</p>',
    );
    expect(out.empty).toBe(false);
    expect(out.html).toContain('推迟一段时间');
  });

  it('教具的 <script> 里匹配上了也不动——删 JS 是把教具删坏', () => {
    const html = [
      '<p>本段目标：讲清楚定时器。</p>',
      '<p>定时器把输出推迟一段时间，这段时间叫预设值，单位毫秒。</p>',
      '<p>常见预设值是 150ms，可以在参数页里改成别的数。</p>',
      '<script>',
      "const HINTS = ['本段目标：先量电压', '导读：再看电流'];",
      'function render() { return HINTS.join(); }',
      '</script>',
    ].join('\n');
    const out = scrubScaffoldHtml(html);
    expect(out.html).toContain("const HINTS = ['本段目标：先量电压'");
    expect(out.html).toContain('function render()');
    // 屏上给人读的那一行仍然要删
    expect(out.dropped).toHaveLength(1);
    expect(out.html).not.toContain('<p>本段目标');
  });

  it('教具路真的接上了——路障', () => {
    // 教具走 iframe HTML，跟幻灯片两条路一个字节都不共用；
    // 清除挂在 generateSlideContent 上天然盖不到它（第三轮实测漏的就是这条）。
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'lib/generation/interactive-post-processor.ts'),
      'utf-8',
    );
    expect(src).toContain('scrubScaffoldHtml');
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
