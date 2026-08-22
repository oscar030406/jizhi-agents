// @vitest-environment jsdom
/**
 * 课堂侧栏的默认展开判据（WO-H4 第 5 件）。
 *
 * 现状是三档宽屏进来都收起，演示要先手点一下。改成宽屏默认展开，
 * 但人手动收起过就一切照人选的来——这两条分支在这里各跑一遍。
 * 视口档位取实测用的那几档（1440/1600/1920）加上下界与窄屏。
 */
import { describe, expect, it } from 'vitest';
import { shouldAutoOpenSidebar } from '@/components/edit/PlaybackChromeRoot';

describe('侧栏默认展开判据', () => {
  it.each([1280, 1440, 1600, 1920])('没动过 + %ipx 宽屏 → 展开', (width) => {
    expect(shouldAutoOpenSidebar(null, width)).toBe(true);
  });

  it.each([375, 768, 1024, 1279])('没动过 + %ipx 窄屏 → 维持收起', (width) => {
    expect(shouldAutoOpenSidebar(null, width)).toBe(false);
  });

  it.each([1440, 1920])('人手动动过 + %ipx → 不覆盖人选的', (width) => {
    expect(shouldAutoOpenSidebar('1', width)).toBe(false);
  });
});
