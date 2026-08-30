import { defineConfig } from '@playwright/test';

/**
 * Config for integration tests that drive a real browser (MCP session, agent
 * executor). Separate from `playwright.unit.config.ts` so `npm test` stays a
 * fast, browser-free check, and separate from `playwright.config.ts` so these
 * do not fan out across three browser engines — they assert on behaviour that
 * is engine-independent, and chromium is what the runner defaults to.
 *
 * Run via `npm run test:integration`.
 */
export default defineConfig({
  testDir: './tests/integration',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  // Launching browsers and driving real pages is slower than the unit default.
  timeout: 60_000,
  projects: [{ name: 'integration' }],
});
