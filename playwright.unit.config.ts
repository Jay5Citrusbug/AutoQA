import { defineConfig } from '@playwright/test';

/**
 * Config for pure-logic unit tests (parser, generator). These import no browser,
 * so a single non-browser project keeps them fast. Run via `npm test`.
 */
export default defineConfig({
  testDir: './tests/unit',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'line' : 'list',
  projects: [{ name: 'unit' }],
});
