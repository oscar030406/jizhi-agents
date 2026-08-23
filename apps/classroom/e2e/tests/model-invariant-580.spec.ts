import { test, expect } from '../fixtures/base';
import { WorkbenchHomePage } from '../pages/workbench-home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

/**
 * #580 — 「有可用服务商 ⇔ 能造课」这条闸。
 *
 * State A：一个可用服务商都没有（keyless 的 ollama/lemonade 不填 baseUrl 不算数）
 *          → 造课按钮就算填了需求也不亮，**而且不弹 toast、不强开弹窗**。
 * State B：服务端下发了一个服务商 → 按钮亮，同样不弹 toast。
 *
 * ## 这条用例砍掉了什么，为什么
 *
 * 原来还断两样东西：State A 顶栏那个唯一的「Set up model」CTA，
 * 和 State B 顶栏的 `provider / model` 模型药丸。**这两样在产品里已经不存在了**——
 * 客户端的模型服务商设置面板整块撤掉了（服务商改由服务端 `/api/server-providers`
 * 下发），全仓搜不到 `settings.configureProvider` 的调用点，也搜不到任何
 * `llm-api-key-*` 输入框；顶栏现在只有主题、账号和几个页面链接。
 * 断一个已经删掉的 CTA，断的是过去，不是产品。
 *
 * 剩下的这一半不是凑数：`canGenerate = 需求非空 && hasUsableProvider`
 * （`app/page.tsx`）这条判据还活着，而且它才是 #580 真正要钉的不变量——
 * 「没有可用服务商时安静地不让造课」，不是「顶栏长什么样」。
 *
 * ## 为什么要先有会话
 *
 * 账户系统恒开，匿名访客拿到的是公共落地页，上面根本没有造课按钮，
 * State A / State B 都无从谈起。
 */

const SCREENSHOT_DIR = 'e2e/screenshots';

// fetchServerProviders 会 Object.keys() 读 tts/asr/pdf/image/video/webSearch，
// 少一个就抛、且被它自己的 try/catch 静默吞掉——桩必须回全形。
function serverProvidersBody(providers: Record<string, { models?: string[] }>) {
  return JSON.stringify({
    providers,
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
  });
}

// 单 worker 串行跑：共用一个 dev server，服务端服务商对账是异步的，并行会飘。
test.describe.configure({ mode: 'serial' });

test.describe('#580 model-selection invariant', () => {
  test('State A: 没有可用服务商 → 造课按钮不亮，且不弹 toast、不强开弹窗', async ({
    page,
    mockApi,
  }) => {
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: serverProvidersBody({}),
      }),
    );
    await page.addInitScript(
      (settings) => {
        localStorage.setItem('settings-storage', settings);
      },
      createSettingsStorage({
        modelId: '',
        providerId: 'openai',
        providersConfig: { openai: { apiKey: '' } },
        autoConfigApplied: true,
      }),
    );
    await mockApi.mockSignedIn();

    const home = new WorkbenchHomePage(page);
    await Promise.all([page.waitForResponse('**/api/server-providers'), home.goto()]);
    await expect(home.requirement, 'State A：没进到工作台（会话桩没生效）').toBeVisible();

    // 填了需求也不该亮：闸是 hasUsableProvider，不是「填没填字」。
    await home.fillRequirement('Explain how photosynthesis works');
    await expect(
      home.enterButton,
      'State A：一个可用服务商都没有，造课按钮却是可点的',
    ).toBeDisabled();

    // #580 的另一半：不许拿 toast 或强开的弹窗去催用户配服务商。
    await expect(page.locator('[data-sonner-toast]'), 'State A：弹了 toast').toHaveCount(0);
    await expect(page.getByRole('dialog'), 'State A：强开了弹窗').toHaveCount(0);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/580-state-a-no-provider.png`,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });

  test('State B: 服务端下发了服务商 → 造课按钮亮，且不弹 toast', async ({ page, mockApi }) => {
    await page.route('**/api/server-providers', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: serverProvidersBody({ openai: { models: ['gpt-4o', 'gpt-4o-mini'] } }),
      }),
    );
    await page.addInitScript(
      (settings) => {
        localStorage.setItem('settings-storage', settings);
      },
      createSettingsStorage({
        modelId: '',
        providerId: 'openai',
        providersConfig: { openai: { apiKey: '' } },
        autoConfigApplied: true,
      }),
    );
    await mockApi.mockSignedIn();

    const home = new WorkbenchHomePage(page);
    await Promise.all([page.waitForResponse('**/api/server-providers'), home.goto()]);
    await expect(home.requirement, 'State B：没进到工作台（会话桩没生效）').toBeVisible();

    // 本地那份 openai 只有空 apiKey，够不着「可用」；对账把服务端下发的
    // isServerConfigured + models 合进来之后才够。所以这一条断的是对账真的落了地。
    await home.fillRequirement('Explain how photosynthesis works');
    await expect(
      home.enterButton,
      'State B：服务端下发了服务商，造课按钮却还是灰的（服务商对账没把 isServerConfigured/models 合进本地配置）',
    ).toBeEnabled({ timeout: 15_000 });
    await expect(page.locator('[data-sonner-toast]'), 'State B：弹了 toast').toHaveCount(0);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/580-state-b-usable-provider.png`,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });
});
