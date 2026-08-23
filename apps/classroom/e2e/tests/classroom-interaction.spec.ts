import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

const TEST_STAGE_ID = 'e2e-test-stage';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/** Seed IndexedDB with stage + 3 scenes using raw IndexedDB API */
async function seedDatabase(page: import('@playwright/test').Page) {
  // Inject settings before navigating so it's available immediately on load
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
  }, SETTINGS_STORAGE);
  // locale 种子统一在 e2e/fixtures/base.ts 里下（英文断言：'Theme' / 'Light' / 'Fullscreen'）。

  // Navigate to home page first — this causes Dexie to open/create the DB at v8
  // with the correct schema. We wait for network idle to ensure Dexie is done.
  await page.goto('/', { waitUntil: 'networkidle' });

  // Now seed data by opening the DB at its current version (no upgrade).
  // Opening without a version number returns the current version without triggering
  // onupgradeneeded, so we can safely write to the already-initialized schema.
  const seedStageData = () =>
    page.evaluate(
      ({ stageId, theme }) => {
        return new Promise<void>((resolve, reject) => {
          // Open without specifying version — uses current DB version, no upgrade event
          const request = indexedDB.open('MAIC-Database');

          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
            const now = Date.now();

            tx.objectStore('stages').put({
              id: stageId,
              name: '光合作用',
              description: '',
              language: 'zh-CN',
              style: 'professional',
              createdAt: now,
              updatedAt: now,
            });

            // Scene content uses SlideContent shape: { type: 'slide', canvas: Slide }
            const makeSlideContent = (title: string, elId: string) => ({
              type: 'slide',
              canvas: {
                id: `slide-${elId}`,
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme,
                elements: [
                  {
                    type: 'text',
                    id: `el-${elId}`,
                    content: title,
                    left: 50,
                    top: 50,
                    width: 900,
                    height: 100,
                  },
                ],
              },
            });

            const scenes = [
              {
                id: 'scene-0',
                stageId,
                type: 'slide',
                title: '基本概念',
                order: 0,
                content: makeSlideContent('基本概念', '0'),
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'scene-1',
                stageId,
                type: 'slide',
                title: '光反应',
                order: 1,
                content: makeSlideContent('光反应', '1'),
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'scene-2',
                stageId,
                type: 'slide',
                title: '暗反应',
                order: 2,
                content: makeSlideContent('暗反应', '2'),
                createdAt: now,
                updatedAt: now,
              },
            ];
            for (const scene of scenes) {
              tx.objectStore('scenes').put(scene);
            }

            // Empty outlines = all scenes generated, no pending work
            // StageOutlinesRecord requires createdAt + updatedAt
            tx.objectStore('stageOutlines').put({
              stageId,
              outlines: [],
              createdAt: now,
              updatedAt: now,
            });

            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };

          request.onerror = () => reject(request.error);
        });
      },
      { stageId: TEST_STAGE_ID, theme: defaultTheme },
    );

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await seedStageData();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Execution context was destroyed') || attempt === 2) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

test.describe('Classroom Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await seedDatabase(page);
  });

  test('loads classroom and switches scenes', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    // Sidebar shows 3 scenes
    await expect(classroom.sidebarScenes).toHaveCount(3, { timeout: 10_000 });

    // First scene title visible
    await expect(classroom.getSceneTitle(0)).toContainText('基本概念');

    // Click second scene
    await classroom.clickScene(1);

    // Verify second scene is now active — heading in the top bar shows the current scene name
    await expect(page.getByRole('heading', { name: '光反应' })).toBeVisible();
  });

  /**
   * 圆桌输入框的草稿：长草稿不许把输入条撑爆，关掉再开草稿还在。
   *
   * 这条用例原来打的是圆桌的**非放映**分支（`roundtable-non-presentation-*`）。
   * 那套 DOM 现在进不去了：2026-08-03「导学大一统」之后，圆桌只在放映态挂载
   * （`PlaybackChromeRoot` 里的 `mode === 'playback' && isPresenting`），
   * 而圆桌组件一进去就 `if (isPresenting) return 放映分支`——非放映那半棵树
   * 一个渲染路径都没有了；常规播放的输入已经迁到右栏导学（`chat-area.tsx`）。
   * 所以断言跟着搬到**放映态的输入条**：同一个 T 键、同一份草稿状态，
   * 只是高度上限从 100px 变成 80px，且靠 `field-sizing: content` 自己长而不是 JS 改内联高度。
   *
   * 放映态要真的进全屏（`requestFullscreen`），Playwright 的 Chromium 支持，
   * 点击带用户手势所以不会被浏览器策略拒掉。
   */
  test('放映态输入条：长草稿封顶 80px，关掉再开草稿还在', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 15_000 });

    // 圆桌只在放映态挂载，T 键的监听器也在圆桌里——不先进放映，按 T 什么都不会发生。
    await page.getByRole('button', { name: 'Fullscreen' }).click();
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement), {
        timeout: 10_000,
        message: '没能进入放映态（全屏请求被拒）',
      })
      .toBe(true);

    await page.keyboard.press('T');
    const textarea = page.getByPlaceholder('Type your message...', { exact: true });
    await expect(textarea, '按 T 没打开圆桌输入条').toBeVisible();

    const readMetrics = () =>
      textarea.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          computedMaxHeight: style.maxHeight,
          computedFieldSizing: style.getPropertyValue('field-sizing'),
          boundingRectHeight: element.getBoundingClientRect().height,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        };
      });

    const initialMetrics = await readMetrics();
    expect(initialMetrics.computedMaxHeight, '输入条没有高度上限，长草稿会把它撑爆').toBe('80px');

    const longDraft = Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`).join('\n');
    await textarea.fill(longDraft);
    await expect
      .poll(async () => (await readMetrics()).scrollHeight > (await readMetrics()).clientHeight, {
        message: '24 行草稿没有溢出——说明它把输入条撑高了，而不是被上限截住',
      })
      .toBe(true);
    const longDraftMetrics = await readMetrics();

    await test.info().attach('presentation textarea metrics', {
      body: JSON.stringify({ initialMetrics, longDraftMetrics }, null, 2),
      contentType: 'application/json',
    });

    const metricSummary = JSON.stringify({ initialMetrics, longDraftMetrics });
    expect(
      longDraftMetrics.boundingRectHeight,
      `长草稿把输入条撑过了 80px 上限：${metricSummary}`,
    ).toBeLessThanOrEqual(80);

    // 短草稿要缩回去：高度是跟着内容走的，不是一路只涨不落。
    await textarea.fill('Short line');
    await expect
      .poll(async () => (await readMetrics()).clientHeight)
      .toBeLessThan(longDraftMetrics.clientHeight);

    // 关掉再开，草稿还在——Escape 只收面板，不清空已经写的字。
    await textarea.fill(longDraft);
    await page.keyboard.press('Escape');
    await expect(textarea).toBeHidden();

    await page.keyboard.press('T');
    await expect(textarea).toBeVisible();
    await expect(textarea, 'Escape 之后再开，草稿被清空了').toHaveValue(longDraft);
    await expect
      .poll(async () => (await readMetrics()).boundingRectHeight)
      .toBeLessThanOrEqual(80);
  });

  test('课堂顶栏主题菜单开合不改变 body 的横向留白', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    const initialBodySpacing = await page.evaluate(() => {
      const styles = getComputedStyle(document.body);
      return {
        paddingRight: styles.paddingRight,
        marginRight: styles.marginRight,
      };
    });

    const expectBodyScrollState = async (locked: boolean) => {
      await expect
        .poll(() =>
          page.evaluate(() => ({
            locked: document.body.hasAttribute('data-scroll-locked'),
            paddingRight: getComputedStyle(document.body).paddingRight,
            marginRight: getComputedStyle(document.body).marginRight,
          })),
        )
        .toEqual({
          locked,
          paddingRight: initialBodySpacing.paddingRight,
          marginRight: initialBodySpacing.marginRight,
        });
    };

    // 语言切换器已于 2026-08-16 撤除（界面统一简体中文），原本这里先开一次
    // 语言菜单。设置弹窗这一半也没了：客户端的模型服务商设置面板整块撤掉了
    // （服务商改由服务端 `/api/server-providers` 下发），课堂顶栏现在只剩
    // 主题菜单、协同控制台链接、Pro 开关和导出——**全站再没有一个可达的
    // Radix 模态弹层**，`locked: true` 那一半没有承载它的界面了。
    //
    // 剩下主题菜单这一半仍然值钱：它是 `modal={false}` 的 Radix 菜单，
    // 一旦有人把它改成模态，Radix 会给 body 打上 `data-scroll-locked` 并塞进
    // 补偿滚动条的 padding-right，整页横跳一下——这条就是钉住这件事的。
    await page.getByRole('button', { name: 'Theme' }).click();
    await expect(page.getByRole('menuitem', { name: 'Light' })).toBeVisible();
    await expectBodyScrollState(false);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Light' })).toBeHidden();
    // 收起来之后也要复原：菜单关掉却留下 padding，同样是横跳。
    await expectBodyScrollState(false);
  });
});
