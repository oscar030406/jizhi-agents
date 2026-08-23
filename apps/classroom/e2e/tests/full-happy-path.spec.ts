import { test, expect } from '../fixtures/base';
import { WorkbenchHomePage } from '../pages/workbench-home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage, USABLE_PROVIDERS_CONFIG } from '../fixtures/test-data/settings';

/**
 * 首页造课 → 生成 → 课堂的最短闭环。
 *
 * 与 knowledge-to-report.spec.ts 的分工：那条验的是「接进来的库一路走到报告」，
 * 要真账号、要管理端；这条只验造课这条主干走不走得通，全程桩，不落任何服务端状态。
 *
 * 这条用例过去红在三个地方，都是产品变了而断言没跟上：
 *
 * 1. 断 `img[alt="OpenMAIC"]`。品牌换成「集智」时那张图就删了，现在顶栏是纯文字字标。
 * 2. 从匿名首页造课。账户系统恒开（`accountsEnabled()` 直接 return true），
 *    匿名访客拿到的是公共落地页，上面根本没有需求输入框——不先有会话，第一步就点不着。
 * 3. settings 桩里的服务商缺 models。`isLLMProviderConfigured` 要 apiKey + endpoint +
 *    至少一个模型，少一样造课按钮就是灰的，后面整条链一步都走不到。
 *
 * 三处都改断言侧，产品一行没动。
 */

/** 造课按钮的启用判据要求服务商「可用」，所以默认那份缺 models 的配置在这里必须覆盖掉。 */
const SETTINGS_STORAGE = createSettingsStorage({
  sidebarCollapsed: false,
  providersConfig: USABLE_PROVIDERS_CONFIG,
});

test.describe('Full Happy Path', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    // Pre-seed settings in localStorage (all tests do this)
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);

    // 造课入口只在登录后出现。这条用例不碰服务端账户库，用桩把会话查询接管掉。
    await mockApi.mockSignedIn();

    // Set up generation API mocks BEFORE any navigation —
    // generation auto-starts when generation-preview mounts.
    await mockApi.setupGenerationMocks();
  });

  test('home → generation-preview → classroom with scene navigation', async ({ page }) => {
    // ── Phase 1: Home page ──────────────────────────────────────────────
    const home = new WorkbenchHomePage(page);
    await home.goto();

    // Core UI elements visible
    await expect(home.wordmark, '首页顶栏没出「集智」字标（多半是没拿到会话，落到公共落地页了）')
      .toBeVisible();
    await expect(home.requirement, '首页没出需求输入框').toBeVisible();
    await expect(home.enterButton, '需求还空着，造课按钮不该是可点的').toBeDisabled();

    // Fill requirement text → submit button activates
    await home.fillRequirement('讲解光合作用');
    await expect(
      home.enterButton,
      '填完需求后造课按钮仍未启用（settings 桩里的服务商不算「可用」：要 apiKey + baseUrl + 至少一个模型）',
    ).toBeEnabled();

    // Submit → navigate to generation-preview
    await home.submit();
    await page.waitForURL(/\/generation-preview/);

    // ── Phase 2: Generation preview ─────────────────────────────────────
    const preview = new GenerationPreviewPage(page);

    // Generation progress UI should be visible
    await expect(preview.stepTitle).toBeVisible();

    // Wait for mocked generation to complete and auto-redirect to classroom
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);

    // ── Phase 3: Classroom ──────────────────────────────────────────────
    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();

    // At least one scene should be visible in the sidebar
    await expect(classroom.sidebarScenes.first()).toBeVisible({ timeout: 10_000 });

    // First scene title should match mock data
    await expect(classroom.getSceneTitle(0)).toContainText('光合作用');

    // If more than one scene item is rendered, verify scene switching works
    const sceneCount = await classroom.sidebarScenes.count();
    if (sceneCount > 1) {
      await classroom.clickScene(1);
      // Verify the clicked scene is visible (active)
      await expect(classroom.sidebarScenes.nth(1)).toBeVisible();
    }
  });
});
