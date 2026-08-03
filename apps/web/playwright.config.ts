import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The server is **not** started here. `pnpm verify:e2e` owns the whole stack — Supabase, Temporal,
 * a reset and seeded database, and the web server — and starting a second one from a `webServer`
 * block would either collide on port 3000 or, worse, quietly run the specs against a build with a
 * different database behind it. `reuseExistingServer` cannot distinguish those two cases, so the
 * config simply requires the stack to already be up and fails loudly when it is not.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: fileURLToPath(new URL('./e2e', import.meta.url)),
  outputDir: fileURLToPath(new URL('./test-results', import.meta.url)),
  // Serial. Every spec signs in as the same seeded demo user and edits the same seeded board, so
  // parallel workers would race on `revision_no` and fail for reasons no spec author wrote down.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
