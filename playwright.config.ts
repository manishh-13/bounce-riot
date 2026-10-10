import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.BOUNCE_BASE_URL || 'http://127.0.0.1:4381',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    },
  },
  webServer: process.env.BOUNCE_BASE_URL ? undefined : [
    { command: 'npm run dev', url: 'http://127.0.0.1:4381', reuseExistingServer: !process.env.CI, timeout: 30000 },
    { command: 'npm run signal', url: 'http://127.0.0.1:4382/health', reuseExistingServer: !process.env.CI, timeout: 30000 },
  ],
});
