import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:3002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.CI ? 'pnpm build && pnpm start' : 'pnpm dev',
    url: 'http://localhost:3002',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Enable the MAIC Editor (Pro mode) so editor e2e can reach it. This is a
    // build-time NEXT_PUBLIC_* flag, so it must be set when the webServer runs
    // `pnpm build` (CI) or `pnpm dev` (local).
    //
    // ⚠ ENGINE_DATA_DIR 指向 e2e 的假引擎数据目录：**e2e 里 `/admin` 看到的全是
    //   fixture 数据，别拿 e2e 截图当线上证据。** 这个项目吃过「快照当真相」的亏。
    //
    //   为什么要挂：`/admin/knowledge/runs/<id>` 是服务端组件、直接读盘，
    //   `page.route` 的桩伸不进去；不给它盘上的数据，接入那一环就只能验到
    //   「请求被接受、URL 跟着跳」。这个 env 是 `lib/server/` 下六个读取方共用的
    //   （intake-runs / knowledge-center / knowledge-map / domain-registry /
    //   admin-overview / admin/generalization/data），它们读不到都是优雅降级，
    //   所以指过来零风险——代价是从此所有 spec 看到的 `/admin` 都是这棵 fixture 树。
    //   树里放了什么、为什么只放这些，见 e2e/fixtures/engine-data/README.md。
    env: {
      PORT: '3002',
      NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true',
      ENGINE_DATA_DIR: path.join(__dirname, 'e2e', 'fixtures', 'engine-data'),
    },
  },
});
