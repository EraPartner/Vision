import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function checkA11y(page: Parameters<typeof AxeBuilder>[0]["page"]) {
    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(
        critical,
        `A11y violations:\n${critical.map((v) => `  [${v.impact}] ${v.id}: ${v.description}`).join("\n")}`,
    ).toHaveLength(0);
}

test("dashboard loads", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
    await checkA11y(page);
});

test("transactions page loads", async ({ page }) => {
    await page.goto("/transactions");
    await expect(page.getByRole("heading", { name: /transactions/i })).toBeVisible();
    await checkA11y(page);
});

test("import page loads", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: /import & export/i })).toBeVisible();
    await checkA11y(page);
});

test("planned payments page loads", async ({ page }) => {
    await page.goto("/planned");
    await expect(page.getByRole("heading", { name: /planned payments/i })).toBeVisible();
    await checkA11y(page);
});

test("portfolio overview page loads", async ({ page }) => {
    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: /portfolio overview/i })).toBeVisible();
    await checkA11y(page);
});
