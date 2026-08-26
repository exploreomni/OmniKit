import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const requestedPort = Number.parseInt(process.env.OMNIKIT_BROWSER_TEST_PORT || '4178', 10);
const port = Number.isSafeInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65_535
  ? requestedPort
  : 4178;
const browserTestRoot = process.env.OMNIKIT_BROWSER_TEST_ROOT
  || join(tmpdir(), `omnikit-browser-tests-${port}`);

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}/api/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      OMNIKIT_NO_BROWSER: 'true',
      OMNIKIT_VAULT_PATH: join(browserTestRoot, 'vault.enc'),
      OMNIKIT_JOB_HISTORY_PATH: join(browserTestRoot, 'jobs.json'),
    },
  },
});
