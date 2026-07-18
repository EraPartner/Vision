import { test, expect } from "@playwright/test";

// Visual regression tests — screenshots stored in e2e/__screenshots__/.
// In CI these run with --update-snapshots on every main push; baselines are
// uploaded as artifacts for review. Switch CI to compare mode once baselines
// are committed to the repo.

const SHOTS: Array<{ name: string; path: string; heading: RegExp; file: string }> = [
    { name: "dashboard", path: "/", heading: /dashboard/i, file: "dashboard.png" },
    { name: "transactions", path: "/transactions", heading: /transactions/i, file: "transactions.png" },
    { name: "import", path: "/import", heading: /import & export/i, file: "import.png" },
    { name: "planned payments", path: "/planned", heading: /planned payments/i, file: "planned.png" },
    { name: "portfolio overview", path: "/portfolio", heading: /portfolio overview/i, file: "portfolio.png" },
];

for (const { name, path, heading, file } of SHOTS) {
    test(`${name} screenshot`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await page.getByRole("heading", { name: heading }).waitFor();
        await expect(page).toHaveScreenshot(file, { fullPage: true });
    });
}
