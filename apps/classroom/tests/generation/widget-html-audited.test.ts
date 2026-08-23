/**
 * 教具 HTML 里的教学文本要进出处审核门（判决书 P0 第 3 条）。
 *
 * `extractTeachingText` 走到 `html` 字段原本直接 `continue`，注释写着
 * 「Raw widget HTML is audited separately if ever needed」——
 * **那个 separately 从来没有发生**。实测一个 simulation 教具只抽出 6 个字（名字），
 * 正文全丢：六类自由 HTML 里写错的机制、编造的数字、无出处的归因，
 * 一条都不会被判官看到。
 *
 * 这是「注释写了代码没写」的又一例，而且伤害更隐蔽——注释暗示「另有安排」，
 * 读的人以为有别的地方在管。
 */
import { describe, expect, it } from 'vitest';

import { extractTeachingText } from '@/lib/generation/hallucination-audit';

const widget = (html: string) => ({ widgetType: 'simulation', name: '扫描周期演示', html });

describe('教具 HTML 送审', () => {
  it('正文进入待审文本，不再只剩一个名字', () => {
    const text = extractTeachingText(
      widget('<div><h2>PLC 扫描周期</h2><p>CPU 在每个扫描周期开始时读取输入映像区，执行用户程序后再写输出。</p></div>'),
    );
    expect(text).toContain('读取输入映像区');
    expect(text).toContain('PLC 扫描周期');
  });

  it('script 与 style 整块剥掉——判官不该去判 CSS', () => {
    const text = extractTeachingText(
      widget('<style>.wrap{color:red}</style><p>扫描周期由三段组成。</p><script>let hidden=1</script>'),
    );
    expect(text).toContain('扫描周期由三段组成');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('hidden');
  });

  it('标签与实体不进正文', () => {
    const text = extractTeachingText(widget('<p>a &lt; b &amp;&nbsp;c</p>'));
    expect(text).not.toContain('<p>');
    expect(text).toContain('a < b & c');
  });

  it('src 与 audioId 仍然跳过——那是管道不是内容', () => {
    const text = extractTeachingText({
      name: '一个够长的教具名字',
      src: 'https://example.invalid/very-long-url-that-should-not-be-audited',
      audioId: 'gen_audio_0123456789',
      html: '<p>这句是真正的教学内容，应当进审。</p>',
    });
    expect(text).toContain('这句是真正的教学内容');
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('gen_audio');
  });
});
