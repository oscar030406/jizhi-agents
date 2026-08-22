import { describe, test, expect } from 'vitest';
import { mdToElements, cleanLectureMarkdown } from '@/lib/generation/md-to-elements';

const MD = `### 缩放的动机

d_k 变大时点积方差随之变大，softmax 会饱和。看一组真实数字：分数 [8.0, 0.1]。

- 第一点：方差与 $d_k$ 成正比
- 第二点：除以 $\\sqrt{d_k}$ 把方差拉回 1

$$\\text{Attention}(Q,K,V)=\\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$

\`\`\`python
import math
print(math.sqrt(64))
\`\`\`

{{摘录:hl07s02#s1}}

结尾段落，含 3 个字的裸数字与 \`行内代码\`。`;

describe('mdToElements', () => {
  const { elements, background } = mdToElements(MD);

  test('产出单栏 text 元素序列，top 严格递增', () => {
    expect(elements.length).toBeGreaterThanOrEqual(6);
    expect(elements.every((el) => el.type === 'text')).toBe(true);
    const tops = elements.map((el) => el.top as number);
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThan(tops[i - 1]);
    expect(background.color).toBe('#fdfbf7');
  });

  test('标题加粗、代码块走 Consolas 深底、公式渲成 KaTeX html', () => {
    const heading = elements[0];
    expect(heading.content).toContain('<strong>');
    const code = elements.find((el) => el.defaultFontName === 'Consolas');
    expect(code).toBeDefined();
    expect(String(code!.content)).toContain('math.sqrt(64)');
    expect(code!.fill).toBe('#332f2b');
    const katexBlocks = elements.filter((el) => String(el.content).includes('katex'));
    expect(katexBlocks.length).toBeGreaterThanOrEqual(2); // 行内 $..$ + 块级 $$..$$
  });

  test('代码块复制出来能直接跑：不留 &nbsp;，缩进靠 pre-wrap', () => {
    const { elements: els } = mdToElements('```python\ndef f(a, b):\n    return a + b\n```');
    const code = String(els.find((el) => el.defaultFontName === 'Consolas')!.content);
    expect(code).not.toContain('&nbsp;');
    expect(code).toContain('white-space: pre-wrap');
    // 浏览器取到的纯文本必须是真空格——U+00A0 会让 Python 报 invalid non-printable
    const pasted = (code.match(/<p[^>]*>(.*?)<\/p>/g) ?? [])
      .map((p) => p.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&'))
      .join('\n');
    expect(pasted).toBe('def f(a, b):\n    return a + b');
  });

  test('摘录占位符独立成元素，盒预算够 injectExcerpts 用', () => {
    const excerpt = elements.find((el) => String(el.content).includes('{{摘录:hl07s02#s1}}'));
    expect(excerpt).toBeDefined();
    expect(excerpt!.width).toBeGreaterThanOrEqual(760);
    expect(excerpt!.height).toBeGreaterThanOrEqual(240);
  });

  test('哨兵不误吞正文里的裸数字', () => {
    const last = elements[elements.length - 1];
    expect(String(last.content)).toContain('3 个字');
    expect(String(last.content)).toContain('<code');
  });

  test('HTML 转义：正文尖括号不能裸奔', () => {
    const { elements: els } = mdToElements('a < b 且 x > y 的情况');
    expect(String(els[0].content)).toContain('a &lt; b');
  });

  test('图片语法整行丢弃、行内剥成替代文字、单星斜体转 em（用户实拍三连）', () => {
    const { elements: els } = mdToElements(
      '前文段落。\n\n![交叉熵曲线](https://upload.wikimedia.org/xx.png)\n\n' +
        '嵌在句中的 ![小图](https://x.io/a.png) 也一样。\n\n*x轴：预测概率p，y轴：损失*',
    );
    const all = els.map((e) => String(e.content)).join('');
    expect(all).not.toContain('wikimedia');
    expect(all).not.toContain('![');
    expect(all).toContain('嵌在句中的 小图 也一样');
    expect(all).toContain('<em>x轴：预测概率p，y轴：损失</em>');
    expect(els).toHaveLength(3); // 独立图片行不产元素
  });
});

describe('cleanLectureMarkdown', () => {
  test('剥整体围栏包裹、配平奇数围栏', () => {
    const wrapped = '```markdown\n' + MD + '\n```';
    const md = cleanLectureMarkdown(wrapped, '缩放的动机');
    expect(md).not.toBeNull();
    expect(md!.startsWith('```')).toBe(false);
    const odd = cleanLectureMarkdown(MD + '\n```python\nx = 1', '任意');
    expect(((odd ?? '').match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  test('复写的同名小节标题去重；过短返回 null', () => {
    const md = cleanLectureMarkdown(`## 缩放的动机\n\n${'正文'.repeat(40)}`, '缩放的动机');
    expect(md).not.toBeNull();
    expect(md!.startsWith('#')).toBe(false);
    expect(cleanLectureMarkdown('太短', '标题')).toBeNull();
  });
});
