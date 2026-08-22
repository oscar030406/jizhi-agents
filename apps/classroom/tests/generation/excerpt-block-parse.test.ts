import { describe, expect, test } from 'vitest';

import {
  parseExcerptBlock,
  parseExcerptFromHtml,
} from '@/components/slide-renderer/components/element/TextElement/ExcerptBlock';

describe('parseExcerptBlock', () => {
  test('注入格式 → 解析出 body/title/source_id', () => {
    const text = '📖 RAG 把检索结果拼进上下文。\n—— 摘自《Agentic RAG》[ag018#s2]';
    expect(parseExcerptBlock(text)).toEqual({
      kind: 'excerpt',
      body: 'RAG 把检索结果拼进上下文。',
      title: 'Agentic RAG',
      sourceId: 'ag018#s2',
    });
  });

  test('正文含 —— 摘自《》时取最后一处出处行', () => {
    const text = '📖 甲说：—— 摘自《假》[x] 不是出处。\n—— 摘自《真》[ag019#s4]';
    const parsed = parseExcerptBlock(text);
    expect(parsed).toMatchObject({ kind: 'excerpt', title: '真', sourceId: 'ag019#s4' });
  });

  test('回指行 → backref', () => {
    expect(parseExcerptBlock('（本段教材前文已引用，见 [ag018#s2]）')).toEqual({
      kind: 'backref',
      sourceId: 'ag018#s2',
    });
  });

  test('普通含 📖 文本不误伤', () => {
    expect(parseExcerptBlock('## 📖 详细对比')).toBeNull();
    expect(parseExcerptBlock('推荐阅读 📖 教材第三章')).toBeNull();
    expect(parseExcerptBlock('普通段落文本')).toBeNull();
  });
});

describe('parseExcerptFromHtml', () => {
  test('HTML 包裹的注入文本可解析（<p>/<br> 转换行、实体解码）', () => {
    const html = '<p>📖 A &amp; B 的关系<br>第二行</p><p>—— 摘自《教材》[ag005#s1]</p>';
    expect(parseExcerptFromHtml(html)).toEqual({
      kind: 'excerpt',
      body: 'A & B 的关系\n第二行',
      title: '教材',
      sourceId: 'ag005#s1',
    });
  });

  test('非摘录 HTML 原样返回 null', () => {
    expect(parseExcerptFromHtml('<p>普通正文</p>')).toBeNull();
  });
});
