import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  webServer: {
    command: 'node tests/fixtures/upstream.mjs',
    url: `${process.env.FEEDINK_FIXTURE_URL || 'http://127.0.0.1:8899'}/__health`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
  projects: [
    { name: 'api', testMatch: /api\.spec\.ts/ },
    { name: 'desktop', testMatch: /reader\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions: { executablePath } } },
    { name: 'mobile', testMatch: /reader\.spec\.ts/, use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, launchOptions: { executablePath } } },
    { name: 'tablet', testMatch: /reader\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true, launchOptions: { executablePath } } },
    ...(process.env.FEEDINK_TEST_WEBKIT === '1' ? [{ name: 'webkit', testMatch: /reader\.spec\.ts/, use: { ...devices['iPhone 13'], browserName: 'webkit' as const } }] : []),
  ],
});
