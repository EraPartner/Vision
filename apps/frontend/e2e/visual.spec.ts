import { test, expect } from "@playwright/test";

// Visual regression tests — screenshots stored in e2e/__screenshots__/.
// In CI these run with --update-snapshots on every main push; baselines are
// uploaded as artifacts for review. Switch CI to compare mode once baselines
// are committed to the repo.

test("dashboard screenshot", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: /dashboard/i }).waitFor();
    await expect(page).toHaveScreenshot("dashboard.png", { fullPage: true });
});

test("transactions screenshot", async ({ page }) => {
    await page.goto("/transactions");
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: /transactions/i }).waitFor();
    await expect(page).toHaveScreenshot("transactions.png", { fullPage: true });
});

test("import screenshot", async ({ page }) => {
    await page.goto("/import");
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: /import & export/i }).waitFor();
    await expect(page).toHaveScreenshot("import.png", { fullPage: true });
});

test("planned payments screenshot", async ({ page }) => {
    await page.goto("/planned");
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: /planned payments/i }).waitFor();
    await expect(page).toHaveScreenshot("planned.png", { fullPage: true });
});

test("portfolio overview screenshot", async ({ page }) => {
    await page.goto("/portfolio");
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: /portfolio overview/i }).waitFor();
    await expect(page).toHaveScreenshot("portfolio.png", { fullPage: true });
});
