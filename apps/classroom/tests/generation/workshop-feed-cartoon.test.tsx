// @vitest-environment jsdom
/**
 * 车间面板的卡通接线：造课过程里主事角色要随环节更换。
 *
 * 只验渲染分支——真造课要几分钟且烧 API，不适合进测试。这里往 workshop store
 * 推不同语义色的事件，断言头部换的是对应角色的定稿卡通、且行内头像不再是手绘 SVG。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkshopFeed } from '@/components/generation/workshop-feed';
import { useWorkshopStore } from '@/lib/store/workshop';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<WorkshopFeed />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  useWorkshopStore.getState().clear();
});

/** 头部那张大图（主事角色的动作帧）。 */
function leadSrc() {
  return [...(container?.querySelectorAll('img') ?? [])]
    .map((e) => e.getAttribute('src') ?? '')
    .find((s) => /-act\d\.png$/.test(s));
}

describe('车间面板 · 主事角色卡通', () => {
  it('审核环节挂阿审，检索环节挂阿检——语义色换人也跟着换', () => {
    render();
    act(() => useWorkshopStore.getState().push('第一屏', '证据检索完成', 'blue'));
    expect(leadSrc()).toMatch(/ajian-act\d\.png/);

    act(() => useWorkshopStore.getState().push('第一屏', '事实审核中', 'yellow'));
    expect(leadSrc()).toMatch(/ashen-a-act\d\.png/);
  });

  it('行内头像用定稿半身卡通，不再是手绘 SVG', () => {
    render();
    act(() => useWorkshopStore.getState().push('第一屏', '学情画像已生成', 'green'));
    const busts = [...container!.querySelectorAll('img')]
      .map((e) => e.getAttribute('src') ?? '')
      .filter((s) => s.endsWith('-bust.png'));
    expect(busts).toContain('/agents/azhen-bust.png');
    // 手绘头像是 48×48 viewBox 的内联 svg，接完线不该再出现
    expect(container!.querySelectorAll('svg[viewBox="0 0 48 48"]').length).toBe(0);
  });

  it('neutral 事件没有主事角色，退回原来的脉冲点，不硬安一个人', () => {
    render();
    act(() => useWorkshopStore.getState().push('第一屏', '开始造课', 'neutral'));
    expect(leadSrc()).toBeUndefined();
    expect(container!.textContent).toContain('多智能体车间');
  });
});
