import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Smoke a11y check fails only on `critical` violations. `serious` color-contrast
// regressions are tracked separately — palette/contrast tuning is design work
// distinct from "page renders without breaking screen readers". The
// `aria-valid-attr-value` rule is also disabled because Radix Tabs lazy-mounts
// inactive panels, which trips axe's IDREF check despite being a deliberate
// (and accessible-on-activation) UI pattern.
async function checkA11y(page: Parameters<typeof AxeBuilder>[0]["page"]) {
    const results = await new AxeBuilder({ page })
        .disableRules(["aria-valid-attr-value"])
        .analyze();
    const blocking = results.violations.filter((v) => v.impact === "critical");
    expect(
        blocking,
        `A11y violations:\n${blocking.map((v) => `  [${v.impact}] ${v.id}: ${v.description}`).join("\n")}`,
    ).toHaveLength(0);
}

test("dashboard loads", async ({ page }) => {
    await page.goto("/");
    // Heading is a time-of-day greeting (Good morning/afternoon/evening) with
    // a "Dashboard" fallback — match either.
    await expect(
        page.getByRole("heading", { level: 1, name: /^(dashboard|good (morning|afternoon|evening))/i }),
    ).toBeVisible();
    await checkA11y(page);
});

test("transactions page loads", async ({ page }) => {
    await page.goto("/transactions");
    await expect(page.getByRole("heading", { level: 1, name: "Transactions", exact: true })).toBeVisible();
    await checkA11y(page);
});

test("import page loads", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByRole("heading", { level: 1, name: /import & export/i })).toBeVisible();
    await checkA11y(page);
});

test("planned payments page loads", async ({ page }) => {
    await page.goto("/planned");
    await expect(page.getByRole("heading", { level: 1, name: /planned payments/i })).toBeVisible();
    await checkA11y(page);
});

test("portfolio overview page loads", async ({ page }) => {
    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { level: 1, name: /portfolio overview/i })).toBeVisible();
    await checkA11y(page);
});
