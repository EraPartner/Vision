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

test.describe("Page load smoke (catches backend ↔ frontend drift)", () => {
    test("Dashboard renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1, name: /^(dashboard|good (morning|afternoon|evening))/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Transactions page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/transactions");
        await expect(page.getByRole("heading", { level: 1, name: /^transactions$/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Categories page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/categories");
        await expect(page.getByRole("heading", { level: 1, name: /categories/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Recipients page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/recipients");
        await expect(page.getByRole("heading", { level: 1, name: /recipients/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Statistics page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/statistics");
        await expect(page.getByRole("heading", { level: 1, name: /statistics|analytics/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Owes page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/owes");
        await expect(page.getByRole("heading", { level: 1, name: /who owes/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Tax overview page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/tax");
        await expect(page.getByRole("heading", { level: 1, name: /tax overview/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Portfolio overview page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/portfolio");
        await expect(page.getByRole("heading", { level: 1, name: /portfolio overview/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Stocks page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/portfolio/stocks");
        // Stocks page heading or empty state should appear
        await page.waitForLoadState("networkidle");
        expect(errors).toHaveLength(0);
    });

    test("Watchlist page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/portfolio/watchlist");
        await expect(page.getByRole("heading", { level: 1, name: /watchlist/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("Exchange rates page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/admin/exchange-rates");
        await expect(page.getByRole("heading", { level: 1, name: /exchange rates/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });

    test("AI Chat page renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/chat");
        await page.waitForLoadState("networkidle");
        expect(errors).toHaveLength(0);
    });

    test("Admin overview renders without runtime errors", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/admin");
        await expect(page.getByRole("heading", { level: 1, name: /admin overview/i })).toBeVisible();
        expect(errors).toHaveLength(0);
    });
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
