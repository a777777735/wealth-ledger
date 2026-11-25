// Playwright E2E 設定（JavaScript，無 TypeScript）。
// 測試對象是本機 wrangler dev（http://127.0.0.1:8787），由 CI workflow 在背景啟動；
// 本機直接跑 `npx playwright test` 時，webServer 會自動啟動同一台伺服器，
// 若 8787 已有服務在跑則直接沿用（reuseExistingServer）。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    viewport: { width: 1280, height: 800 },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx wrangler dev --port 8787 --ip 127.0.0.1',
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: true,
    timeout: 120 * 1000,
  },
});
