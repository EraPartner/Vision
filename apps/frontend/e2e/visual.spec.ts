import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Visual regression tests — screenshots stored in e2e/__screenshots__/.
// This suite is manual because Linux CI and local macOS render different
// baselines. Run test:e2e:visual to add missing local snapshots or
// test:e2e:update-snapshots after an intentional visual change.

const SHOTS: Array<{
  name: string;
  path: string;
  heading: RegExp;
  file: string;
}> = [
  {
    name: "dashboard",
    path: "/",
    heading: /good (morning|afternoon|evening)/i,
    file: "dashboard.png",
  },
  {
    name: "transactions",
    path: "/transactions",
    heading: /transactions/i,
    file: "transactions.png",
  },
  {
    name: "import",
    path: "/import",
    heading: /import & export/i,
    file: "import.png",
  },
  {
    name: "planned payments",
    path: "/planned",
    heading: /planned payments/i,
    file: "planned.png",
  },
  {
    name: "portfolio overview",
    path: "/portfolio",
    heading: /portfolio overview/i,
    file: "portfolio.png",
  },
];

async function revealLazyContent(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settle = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    const step = Math.max(1, window.innerHeight - 100);

    for (
      let top = 0;
      top < document.documentElement.scrollHeight;
      top += step
    ) {
      window.scrollTo(0, top);
      await settle();
    }

    window.scrollTo(0, document.documentElement.scrollHeight);
    await settle();
    window.scrollTo(0, 0);
    await settle();
  });
}

for (const { name, path, heading, file } of SHOTS) {
  test(`${name} screenshot`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
    await page.addStyleTag({
      content:
        ".app-topbar { position: relative !important; top: auto !important; }",
    });
    await revealLazyContent(page);

    if (path === "/portfolio") {
      const calculatingSubtotals = page.getByText(
        "Calculating broker subtotals…",
        { exact: true },
      );
      await page.waitForTimeout(1_000);
      await calculatingSubtotals.waitFor({ state: "hidden", timeout: 15_000 });
    }
    await page.waitForTimeout(1_000);
    await expect(page).toHaveScreenshot(file, { fullPage: true });
  });
}
