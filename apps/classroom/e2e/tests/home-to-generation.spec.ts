import type { Page } from '@playwright/test';

import { test, expect } from '../fixtures/base';
import { WorkbenchHomePage } from '../pages/workbench-home.page';
import { createSettingsStorage, USABLE_PROVIDERS_CONFIG } from '../fixtures/test-data/settings';

/**
 * 首页这一段的两条：**造课入口的登录闸**，以及**开合浮层不许把页面挤一下**。
 *
 * 这个文件过去整条红在同一个地方：断言里那个 `img[alt="OpenMAIC"]` 的字标，
 * 在品牌换成「集智」时就删了；而且它是从**匿名首页**开始造课的——账户系统恒开
 * （`accountsEnabled()` 直接 return true），匿名访客拿到的是公共落地页，
 * 上面根本没有造课按钮。两条都是产品变了、断言没跟上。
 *
 * 顺手把这道闸本身变成被验的东西：第一条先看匿名落地页确实没有造课入口，
 * 再拿到会话看工作台上有——这正是当时让七条用例集体红掉的那件事，
 * 之前一条用例都没盯着它。
 *
 * 与 full-happy-path.spec.ts 的分工：那条从**已登录**开始，一路跑到课堂；
 * 这条只管首页这一段（登录闸 + 提交跳转 + 浮层不挤版）。
 */

/** 造课按钮的启用判据是「有一个可用的模型服务商」——要 apiKey + baseUrl + 至少一个模型。 */
const SETTINGS_STORAGE = createSettingsStorage({ providersConfig: USABLE_PROVIDERS_CONFIG });

interface BodySpacing {
  paddingRight: string;
  marginRight: string;
}

async function readBodySpacing(page: Page): Promise<BodySpacing> {
  return page.evaluate(() => {
    const styles = getComputedStyle(document.body);
    return {
      paddingRight: styles.paddingRight,
      marginRight: styles.marginRight,
    };
  });
}

async function expectBodyScrollState(page: Page, initialSpacing: BodySpacing, locked: boolean) {
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
      paddingRight: initialSpacing.paddingRight,
      marginRight: initialSpacing.marginRight,
    });
}

test.describe('Home → Generation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);
    // locale 种子统一在 e2e/fixtures/base.ts 里下（造课按钮的 en-US 文案是 "Enter Classroom"）。
  });

  test('造课入口只在登录后出现，填完需求能提交到生成页', async ({ page, mockApi }) => {
    // 生成页一挂载就自动开跑，桩必须先于导航装好。
    await mockApi.setupGenerationMocks();

    const home = new WorkbenchHomePage(page);

    // ── 匿名：公共落地页 ────────────────────────────────────────────────
    await home.goto();
    await expect(
      // 落地页上这个按钮有两处（顶栏与页尾 CTA），只断顶栏那一个。
      page.locator('header').getByRole('button', { name: '登录 / 注册' }),
      '匿名首页没出登录入口（这一页应该是公共落地页）',
    ).toBeVisible();
    await expect(
      home.enterButton,
      '匿名首页上出现了造课按钮——账户闸漏了（accountsEnabled 恒 true 时访客不该能造课）',
    ).toHaveCount(0);

    // ── 拿到会话：工作台 ────────────────────────────────────────────────
    await mockApi.mockSignedIn();
    await home.goto();

    await expect(
      home.wordmark,
      '登录后首页顶栏没出「集智」字标（多半是会话没拿到，还停在落地页）',
    ).toBeVisible();
    await expect(home.requirement, '登录后首页没出需求输入框').toBeVisible();
    await expect(home.enterButton, '需求还空着，造课按钮不该是可点的').toBeDisabled();

    // ── 填需求 → 提交 → 跳生成页 ────────────────────────────────────────
    await home.fillRequirement('讲解光合作用');
    await expect(
      home.enterButton,
      '填完需求后造课按钮仍未启用（settings 桩里的服务商不算「可用」：要 apiKey + baseUrl + 至少一个模型）',
    ).toBeEnabled();

    await home.submit();
    await page.waitForURL(/\/generation-preview/);
    expect(page.url()).toContain('/generation-preview');
  });

  test('打开学习者画像浮层不改变 body 的横向留白', async ({ page, mockApi }) => {
    // 这条原来开的是设置弹窗。客户端的模型服务商设置面板已经整块撤掉了
    // （现在服务商由服务端下发，`/api/server-providers`），页面上再没有那个齿轮，
    // 也没有任何一个 Radix **模态**弹层。工作台上还在的 Radix 浮层只剩画像 Popover，
    // 所以这条守的是它这一半：非模态浮层开合时，body 既不该被打上
    // `data-scroll-locked`，也不该被塞进补偿滚动条的 padding-right（那会让整页横跳一下）。
    await mockApi.mockSignedIn();

    const home = new WorkbenchHomePage(page);
    await home.goto();
    await expect(home.requirement, '没进到工作台（会话桩没生效）').toBeVisible();

    const initialBodySpacing = await readBodySpacing(page);

    await home.profileTrigger.click();
    await expect(home.corpusSelect, '画像浮层没打开').toBeVisible();
    await expectBodyScrollState(page, initialBodySpacing, false);
  });
});
