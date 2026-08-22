// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ExcerptBlockView,
  parseExcerptFromHtml,
} from '@/components/slide-renderer/components/element/TextElement/ExcerptBlock';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 教材摘录块渲染。
 *
 * 病灶（2026-08-13 线上首页实拍）：摘录框里 `**先修建议**` 与 `- 具备 Transformer…`
 * 字面显示。原实现只手搓了 ``` 围栏与 $..$ 公式两种构件，其余全裸奔。
 *
 * 把 126 个已落库摘录块数了一遍，构件分布：
 *   `code` 65% · 围栏 52% · **粗体** 37% · - 列表 26% · 1. 列表 15%
 *   # 标题 13% · *斜体* 12% · [链接]() 12% · $公式$ 11% · 表格 2%
 * 下面每条用例对应其中一种，钉住「不再有字面记号漏出去」。
 */

function render(body: string): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ExcerptBlockView
        block={{ kind: 'excerpt', body, title: '某教材 第1章', sourceId: 'x#1' }}
      />,
    );
  });
  return host;
}

/** 渲染器把粗体输出成 `<span class="font-semibold" data-streamdown="strong">` 而不是 `<strong>`，
 *  所以选择器按语义取而不是按标签名钉死——换渲染器时这一层不该跟着碎。 */
const BOLD_SEL = 'strong, b, [data-streamdown="strong"], .font-semibold';

describe('摘录正文的 markdown 构件', () => {
  const cases: Array<[string, string, (el: HTMLElement) => unknown]> = [
    ['粗体（换行闭合）', '**先修建议**\n\n先读第 2 章。', (el) => el.querySelector(BOLD_SEL)?.textContent],
    // 62% 的真实粗体是这一形态：右侧 `**` 紧跟全角标点，CommonMark flanking 规则不闭合
    ['粗体（紧跟中文标点）', '1. **通用评测集**：MMLU 等。', (el) => el.querySelector(BOLD_SEL)?.textContent],
    ['斜体（紧跟中文标点）', '这里的 *权重*，指注意力权重。', (el) => el.querySelector('em')?.textContent],
    ['行内代码', '在 `generate` 方法中取最后一个位置。', (el) => el.querySelector('code')?.textContent],
    ['无序列表', '- 具备 Transformer 基础。\n- 熟悉视觉编码器。', (el) => el.querySelectorAll('li').length],
    ['有序列表', '1. 先算注意力分数。\n2. 再做归一化。', (el) => el.querySelectorAll('ol li').length],
    ['标题', '## 本节目标\n\n建立总体学习地图。', (el) => el.querySelector('h2')?.textContent],
    ['斜体', '这里的 *权重* 指的是注意力权重。', (el) => el.querySelector('em')?.textContent],
    ['围栏代码', '示例：\n\n```python\nx = 1\n```', (el) => el.querySelector('pre')?.textContent],
  ];

  for (const [name, body, pick] of cases) {
    it(`渲染${name}，不留字面记号`, () => {
      const el = render(body);
      expect(pick(el)).toBeTruthy();
      // 记号本身不许出现在可见文本里
      const text = el.textContent ?? '';
      expect(text).not.toMatch(/\*\*|^\s*[-*] |`/m);
    });
  }

  it('出处行始终在，且不被正文吃掉', () => {
    const el = render('**要点**\n- 一\n- 二');
    expect(el.textContent).toContain('摘自《某教材 第1章》');
    expect(el.textContent).toContain('x#1');
  });

  it('纯文本摘录照常渲染', () => {
    const el = render('注意力机制有三个核心变量。');
    expect(el.textContent).toContain('注意力机制有三个核心变量');
  });
});

describe('parseExcerptFromHtml 的识别不受渲染改动影响', () => {
  it('认得注入格式', () => {
    const html = '<p>📖 **要点**<br>- 一</p><p>—— 摘自《某教材 第1章》[x#1]</p>';
    expect(parseExcerptFromHtml(html)).toMatchObject({
      kind: 'excerpt',
      title: '某教材 第1章',
      sourceId: 'x#1',
    });
  });

  it('普通含 📖 的文本不误伤', () => {
    expect(parseExcerptFromHtml('<p>📖 推荐书目</p>')).toBeNull();
  });
});
