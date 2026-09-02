import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.JIZHI_PRODUCTION_BASE ?? 'https://jizhi.chenmingkun.cn';
const url = new URL(baseURL);
const isProduction =
  url.protocol === 'https:' &&
  url.hostname === 'jizhi.chenmingkun.cn' &&
  (!url.port || url.port === '443') &&
  url.pathname === '/';
const isLocal =
  url.protocol === 'http:' &&
  ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) &&
  url.pathname === '/';
if (!isProduction && !isLocal) {
  throw new Error('JIZHI_PRODUCTION_BASE 只允许生产站根地址或本机 HTTP 根地址');
}

export default defineConfig({
  testDir: './e2e/production',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 45_000 },
  outputDir: path.resolve(__dirname, '../../docs/06-defense/evidence/production-browser-artifacts'),
  reporter: [
    ['list'],
    ['./e2e/production/no-skipped-reporter.ts'],
    [
      'json',
      {
        outputFile: path.resolve(
          __dirname,
          '../../docs/06-defense/evidence/production-browser-report.json',
        ),
      },
    ],
  ],
  use: {
    baseURL: url.toString(),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'production-chromium', use: { ...devices['Desktop Chrome'] } }],
});
