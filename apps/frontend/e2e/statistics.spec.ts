/**
 * Phase 2 visual parity baseline — Statistics page.
 *
 * Same contract as dashboard.spec.ts. Statistics is the other page that
 * consumes statisticsProcessing.ts + useFilteredDashboardStats; it must
 * render identically after the rewrite to /api/aggregations/*.
 */

import { test, expect } from '@playwright/test';

test.describe('Statistics visual parity', () => {
  test('baseline full-page render (no exclusions)', async ({ page }) => {
    await page.goto('/statistics');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot('statistics.png', {
      fullPage: true,
    });
  });
});
