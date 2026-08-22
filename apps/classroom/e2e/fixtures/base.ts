import { test as base } from '@playwright/test';
import { MockApi } from './mock-api';

type Fixtures = {
  mockApi: MockApi;
};

export const test = base.extend<Fixtures>({
  // 产品界面已统一简体中文，运行时不再嗅探 navigator.language（WO-J4）。
  // 但现有断言大量用英文 aria-label（'Theme' / 'Settings' / 'Set up model' /
  // 'Loading classroom...' 等），过去是靠 Chromium 默认 en-US 白拿的。
  // 语言检测收口后统一在这里种一次 locale，把这些断言钉住；
  // 换中文断言是另一件事，要能真跑 e2e（自带 3002 dev server）才做得了。
  page: async ({ page }, use) => {
    await page.addInitScript(() => localStorage.setItem('locale', 'en-US'));
    await use(page);
  },
  mockApi: async ({ page }, use) => {
    const mockApi = new MockApi(page);
    // Always mock server-providers — called on every page load by root layout
    await mockApi.mockServerProviders();
    await use(mockApi);
  },
});

export { expect } from '@playwright/test';
