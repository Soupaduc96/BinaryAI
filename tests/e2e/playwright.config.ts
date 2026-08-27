/**
 * Playwright configuration. Inert until `@playwright/test` is installed --
 * see README.md in this directory.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Both processes are needed: the dashboard is a client of the API, and the
  // point of these tests is that the two agree.
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://127.0.0.1:4000/health',
      cwd: '../..',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'npm run dev:web',
      url: 'http://127.0.0.1:3000',
      cwd: '../..',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
});
