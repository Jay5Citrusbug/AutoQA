import { defineConfig, devices } from '@playwright/test';

/**
 * Dedicated config for auto-verifying AutoQA-generated specs.
 * Kept separate from the main config so `npm test` / the app's own specs are unaffected.
 * Test-data env vars (QA_ and TEST_ prefixed) are inherited from the spawning process.
 */
export default defineConfig({
  testDir: './generated-tests',
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [['json'], ['line']],
  timeout: 120_000,
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
