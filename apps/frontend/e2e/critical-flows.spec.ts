/**
 * Playwright E2E — critical user flows that exercise frontend ↔ backend
 * contracts in a real browser. A backend-side schema change that breaks a
 * page should fail at least one of these tests.
 *
 * These tests run against the dev stack (frontend + backend via Docker
 * Compose in CI; local `bun run dev` otherwise). Visit each major page,
 * trigger a representative action, and assert the response renders.
 */
import { test, expect } from "@playwright/test";

// Each page: goto, then either assert its <h1> is visible or (for pages with no
// stable heading) wait for network idle — always asserting zero runtime errors.
// Local catalog: headings/paths here diverge from the a11y/network-drift
// catalog (e.g. Portfolio uses a stricter heading, and this set adds
// Stocks/Exchange-rates/Chat/Admin), so it is intentionally not shared.
const SMOKE_PAGES: Array<{ title: string; path: string; heading?: RegExp }> = [
    { title: "Dashboard", path: "/", heading: /^(dashboard|good (morning|afternoon|evening))/i },
    { title: "Transactions page", path: "/transactions", heading: /^transactions$/i },
    { title: "Categories page", path: "/categories", heading: /categories/i },
    { title: "Recipients page", path: "/recipients", heading: /recipients/i },
    { title: "Statistics page", path: "/statistics", heading: /statistics|analytics/i },
    { title: "Owes page", path: "/owes", heading: /who owes/i },
    { title: "Tax overview page", path: "/tax", heading: /tax overview/i },
    { title: "Portfolio overview page", path: "/portfolio", heading: /portfolio overview/i },
    { title: "Stocks page", path: "/portfolio/stocks" },
    { title: "Watchlist page", path: "/portfolio/watchlist", heading: /watchlist/i },
    { title: "Exchange rates page", path: "/admin/exchange-rates", heading: /exchange rates/i },
    { title: "AI Chat page", path: "/chat" },
    { title: "Admin overview", path: "/admin", heading: /admin overview/i },
];

test.describe("Page load smoke (catches backend ↔ frontend drift)", () => {
    for (const { title, path, heading } of SMOKE_PAGES) {
        test(`${title} renders without runtime errors`, async ({ page }) => {
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(e.message));
            await page.goto(path);
            if (heading) {
                await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
            } else {
                await page.waitForLoadState("networkidle");
            }
            expect(errors).toHaveLength(0);
        });
    }
});

test.describe("Mutation roundtrip (catches contract drift on writes)", () => {
    test("Create category → list refetches and shows new item", async ({ page }) => {
        await page.goto("/categories");
        await expect(page.getByRole("heading", { level: 1, name: /categories/i })).toBeVisible();

        const unique = `TEST_E2E_${Date.now()}`;
        await page.getByRole("button", { name: /add category/i }).first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByLabel(/general/i).fill(unique);
        await page.getByLabel(/detail/i).fill("AUTO");
        await page.getByRole("button", { name: /create/i }).click();
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
        // The newly-created category should appear after refetch
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });
    });

    test("Create recipient → list refetches and shows new item", async ({ page }) => {
        await page.goto("/recipients");
        await expect(page.getByRole("heading", { level: 1, name: /recipients/i })).toBeVisible();

        const unique = `Test_E2E_${Date.now()}`;
        await page.getByRole("button", { name: /add recipient/i }).first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByLabel(/^name$/i).fill(unique);
        await page.getByRole("button", { name: /^create$/i }).click();
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 4000 });
        await expect(page.getByText(unique).first()).toBeVisible({ timeout: 8000 });
    });
});
