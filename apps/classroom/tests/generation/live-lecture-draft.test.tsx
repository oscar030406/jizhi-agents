// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveLectureDraft } from '@/components/generation/live-lecture-draft';
import { useLectureDraftStore } from '@/lib/store/lecture-draft';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('LiveLectureDraft', () => {
  test('无草稿渲 null；有草稿渲 markdown 且 $$..$$ 走 KaTeX（用户两次实拍的裸奔病）', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<LiveLectureDraft />);
    });
    expect(host.innerHTML).toBe('');

    await act(async () => {
      const s = useLectureDraftStore.getState();
      s.begin('o1', '交叉熵公式解析');
      s.append('o1', '### 标题\n\n正文段落。\n\n$$ L = -\\sum_{i=1}^{C} y_i \\log(p_i) $$\n');
    });

    expect(host.textContent).toContain('讲义正在成稿');
    expect(host.textContent).toContain('正文段落');
    // 数学必须渲成 KaTeX，不允许 LaTeX 源码裸奔。
    // （不能断言 textContent 不含 \sum——KaTeX 的 MathML annotation 保留 TeX 源）
    expect(host.querySelector('.katex')).toBeTruthy();
    expect(host.textContent).toContain('∑');
  });
});
