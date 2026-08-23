/**
 * 判官拿到的待审文本必须是干净的人话。
 *
 * 线上实锤（2026-08-23，PLC 课屏 4）：那一屏有「STOP（机器强制断电停转）」
 * 事实错误，判官却抽出 **0 条断言**直接放行。
 *
 * 拿真实产物复现 `extractTeachingText`，前两行是：
 *
 *     0: Microsoft YaHei                              ← 字体名当教学内容
 *     1: <p style="font-size: 20px;"><strong>计算步骤…  ← 带 HTML 标签
 *
 * 判官不是瞎，是我们喂了它一堆管道零件：它得先在字体名和 `<p style=…>` 里
 * 找出哪些是人话。canvas 槽位形态的元素 `content` 就是讲义流转出的 HTML，
 * 而剥标签此前只在 `html` 字段上做过——同一份数据两种形态、处理只覆盖一种，
 * 又是形状歪那一族。
 *
 * fixture 是线上那一屏的真产物。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractTeachingText } from '@/lib/generation/hallucination-audit';

const scene = () =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/canvas-scene-audit.json'), 'utf-8'));

describe('判官待审文本去噪', () => {
  it('字体名这类管道字段不进待审文本', () => {
    const text = extractTeachingText(scene());
    expect(text).not.toContain('Microsoft YaHei');
    expect(text.split('\n')[0]).not.toMatch(/YaHei|Consolas|monospace/);
  });

  it('canvas 元素的 content 剥掉 HTML 标签', () => {
    const text = extractTeachingText(scene());
    expect(text).not.toContain('<p style');
    expect(text).not.toContain('</strong>');
  });

  it('正文本身完整留下——去噪不是删内容', () => {
    const text = extractTeachingText(scene());
    // 这一屏真正的教学内容，判官本该对它抽断言
    expect(text).toContain('计算步骤与验证');
    expect(text).toContain('气缸');
    // 去噪后 760 字（原 2068 里大半是标签与样式）。定 700 是留余量，
    // 掉到这条线以下说明剥标签把正文也剥了。
    expect(text.length).toBeGreaterThan(700);
  });

  it('管道字段名单里有字体相关键', () => {
    // 路障：删掉 fontName 判官就会重新看见字体名。
    const src = readFileSync(
      join(process.cwd(), 'lib/generation/hallucination-audit.ts'),
      'utf-8',
    );
    expect(src).toContain('PLUMBING_KEYS');
    expect(src).toMatch(/'fontName'/);
  });
});
