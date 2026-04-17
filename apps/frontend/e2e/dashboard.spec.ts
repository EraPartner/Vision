/**
 * Phase 2 visual parity baseline — Dashboard page.
 *
 * Captures a full-page screenshot of /dashboard after the app reaches
 * network-idle. Baseline is committed; the Phase 2 rewrite must not
 * cause pixel diff > config threshold.
 *
 * Assumes the dev stack is running (`bun run dev`) and the caller's
 * local DB has representative data. Flake-prone content (live clock,
 * animated skeletons) is masked via `mask:` locators if it becomes
 * noisy — keep this list tight to avoid masking real regressions.
 */

import { test, expect } from '@playwright/test';

test.describe('Dashboard visual parity', () => {
  test('baseline full-page render', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    // Give chart animations + transitions a moment to settle.
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot('dashboard.png', {
      fullPage: true,
    });
  });
});
