/**
 * Phase F4 — accessibility scans on key pages with axe.
 *
 * Catches regressions in: missing labels, low contrast, ARIA misuse, focus
 * traps, missing landmarks. Limited to WCAG 2.1 A/AA rule set so noise is
 * actionable.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PAGES: Array<{ name: string; path: string; heading: RegExp }> = [
    { name: "Dashboard", path: "/", heading: /^(dashboard|good (morning|afternoon|evening))/i },
    { name: "Transactions", path: "/transactions", heading: /^transactions$/i },
    { name: "Categories", path: "/categories", heading: /categories/i },
    { name: "Recipients", path: "/recipients", heading: /recipients/i },
    { name: "Statistics", path: "/statistics", heading: /statistics|analytics/i },
    { name: "Owes", path: "/owes", heading: /who owes/i },
    { name: "PortfolioOverview", path: "/portfolio", heading: /portfolio/i },
    { name: "Watchlist", path: "/portfolio/watchlist", heading: /watchlist/i },
    { name: "Planned", path: "/planned", heading: /planned payments/i },
];

test.describe("Phase F4 — a11y axe scans (WCAG 2.1 A/AA)", () => {
    for (const { name, path, heading } of PAGES) {
        test(`${name} has no critical or serious a11y violations`, async ({ page }) => {
            await page.goto(path);
            await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
            // Wait for late content (translations + charts)
            await page.waitForLoadState("networkidle");

            const results = await new AxeBuilder({ page })
                .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
                // Charts/canvas/3rd-party widgets often noise; scope to main content
                .exclude("canvas")
                .exclude("[data-axe-skip]")
                // Radix Tabs lazy-mounts inactive panels; the tab triggers'
                // aria-controls reference IDs that aren't in DOM until the panel
                // is selected. axe flags this as critical even though the panel
                // becomes accessible on activation. Skip the IDREF check.
                .disableRules(["aria-valid-attr-value"])
                .analyze();

            // Gate on critical AND serious (raised from critical-only). This
            // suite runs in the scheduled e2e workflow, not PR CI, so a newly
            // surfaced serious issue is reported nightly without blocking merges.
            const blocking = results.violations.filter(
                (v) => v.impact === "critical" || v.impact === "serious",
            );
            if (blocking.length > 0) {
                console.log(
                    "Blocking a11y violations (critical/serious):",
                    JSON.stringify(blocking, null, 2),
                );
            }
            expect(blocking).toHaveLength(0);
        });
    }
});
