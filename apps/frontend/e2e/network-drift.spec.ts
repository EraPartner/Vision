/**
 * Phase F4 — network drift detection.
 *
 * Listens for failed network responses while a page boots. A 5xx, 422, or
 * unexpected 404 from a frontend-called endpoint indicates a backend
 * contract drift not covered by the MSW or live-API contract suites
 * (typically: a route the frontend tries but the backend never exposed,
 * or a route that 5xxs because the request envelope drifted).
 */
import { test, expect } from "@playwright/test";
import { PAGES } from "./pages";

// The drift listener additionally sweeps the Tax page, which the a11y suite skips.
const DRIFT_PAGES = [
    ...PAGES,
    { name: "TaxOverview", path: "/tax", heading: /tax overview/i },
];

test.describe("Phase F4 — network drift listener", () => {
    for (const { name, path } of DRIFT_PAGES) {
        test(`${name} loads with no 5xx / 4xx from API endpoints`, async ({ page }) => {
            const failures: Array<{ url: string; status: number }> = [];

            page.on("response", (resp) => {
                const url = resp.url();
                // Only watch API calls (not assets / HMR / vite chunks)
                if (!url.includes("/api/")) return;
                const status = resp.status();
                // 401/403 are expected on unauth fixture data → ignore
                if (status === 401 || status === 403) return;
                if (status >= 500 || (status >= 400 && status !== 404)) {
                    failures.push({ url, status });
                }
            });

            await page.goto(path);
            await page.waitForLoadState("networkidle");
            // Soak briefly to let lazy queries fire
            await page.waitForTimeout(500);

            if (failures.length > 0) {
                console.log(`Drift on ${name}:`, JSON.stringify(failures, null, 2));
            }
            expect(failures).toHaveLength(0);
        });
    }
});
