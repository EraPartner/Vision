/**
 * Playwright config — Phase 2 visual parity harness.
 *
 * Scope: Dashboard + Statistics pages only. Captures screenshot baselines
 * before the Phase 2 frontend rewrite (delete statisticsProcessing.ts +
 * split DashboardPage/StatisticsPage); asserts pixel parity after.
 *
 * Baseline workflow (one-time, local):
 *   1. `bun run dev` in one terminal (backend + frontend + live DB)
 *   2. `bun run e2e:update` in another — writes .png snapshots next to specs
 *   3. commit snapshots
 *
 * Post-rewrite verification:
 *   `bun run e2e` — diffs current render vs committed snapshots
 *
 * Threshold: 0.2% pixel diff, maxDiffPixels 100. Tuned for font-AA noise
 * without masking real UI regressions.
 *
 * Not wired into CI: baseline depends on live local DB. Phase 8 shadow-mode
 * numeric parity covers calc drift independently.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/frontend/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.VISION_E2E_BASE_URL || 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002,
      maxDiffPixels: 100,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
