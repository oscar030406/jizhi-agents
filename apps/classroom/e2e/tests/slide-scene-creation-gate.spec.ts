import { test, expect } from '../fixtures/base';
import { WorkbenchHomePage } from '../pages/workbench-home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage, USABLE_PROVIDERS_CONFIG } from '../fixtures/test-data/settings';

// 造课按钮要「有一个可用的服务商」才亮：apiKey + baseUrl + 至少一个模型，缺一样点不动。
const SETTINGS_STORAGE = createSettingsStorage({
  sidebarCollapsed: false,
  providersConfig: USABLE_PROVIDERS_CONFIG,
});

/**
 * Scene creation is enabled in the slide editor: the inter-thumb "+" insertion
 * zones and the per-slide Duplicate menu item are exposed alongside reorder /
 * delete / rename. (Duplicated slides carry their actions; a blank inserted
 * slide is authored via the script timeline / MAIC Agent.) This test guards
 * that the entry points stay available — flip SCENE_CREATION_ENABLED off and it
 * fails.
 *
 * 造课这一段走登录后的工作台：账户系统恒开，匿名访客拿到的是公共落地页，
 * 上面没有造课按钮——旧写法从匿名首页点「进入课堂」，第一步就点不着。
 */
test.describe('Slide editor — scene creation (enabled)', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);
    await mockApi.setupGenerationMocks();
    // 造课入口只在登录后出现。这条用例不碰服务端账户库，用桩把会话查询接管掉。
    await mockApi.mockSignedIn();
  });

  test('Pro mode rail exposes insert + duplicate alongside rename/delete', async ({
    page,
  }, testInfo) => {
    // Generate a classroom through the mocked pipeline.
    const home = new WorkbenchHomePage(page);
    await home.goto();
    await home.fillRequirement('讲解光合作用');
    await home.submit();
    await page.waitForURL(/\/generation-preview/);

    const preview = new GenerationPreviewPage(page);
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);

    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 10_000 });

    // Enter Pro mode via the header Pro Switch.
    await page.getByRole('switch').click();

    // The slide nav rail replaces the playback sidebar in Pro mode.
    const rail = page.getByTestId('slide-nav-rail');
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // Insertion zones are present between thumbs.
    await expect(page.getByTestId('slide-nav-insert')).not.toHaveCount(0);

    // The per-slide overflow menu now has Rename + Duplicate + Delete (3 items).
    // Counting menuitems keeps the assertion locale-independent.
    await page.getByTestId('slide-nav-more').first().click();
    await expect(page.getByRole('menuitem')).toHaveCount(3);

    // Visual evidence, attached to the Playwright report.
    await testInfo.attach('pro-rail-scene-creation', {
      body: await rail.screenshot(),
      contentType: 'image/png',
    });
  });
});
