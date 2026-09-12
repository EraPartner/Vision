/**
 * Playwright E2E — critical user flows that exercise frontend ↔ backend
 * contracts in a real browser. A backend-side schema change that breaks a
 * page should fail at least one of these tests.
 *
 * These tests run against the native production stack in CI and `bun run dev`
 * locally. Visit each major page and
 * assert it renders without runtime errors. Write-path coverage (create /
 * edit / delete roundtrips) lives in `mutations-parity.spec.ts`.
 */
import { test, expect } from "./fixtures";

// Each page: goto, then either assert its <h1> is visible or (for pages with no
// stable heading) wait for network idle — always asserting zero runtime errors.
// Local catalog: headings/paths here diverge from the a11y/network-drift
// catalog (e.g. Portfolio uses a stricter heading, and this set adds
// Stocks/Exchange-rates/Chat/Admin), so it is intentionally not shared.
const SMOKE_PAGES: Array<{ title: string; path: string; heading?: RegExp }> = [
  {
    title: "Dashboard",
    path: "/",
    heading: /^(dashboard|good (morning|afternoon|evening))/i,
  },
  {
    title: "Transactions page",
    path: "/transactions",
    heading: /^transactions$/i,
  },
  { title: "Categories page", path: "/categories", heading: /categories/i },
  { title: "Recipients page", path: "/recipients", heading: /recipients/i },
  {
    title: "Statistics page",
    path: "/statistics",
    heading: /statistics|analytics/i,
  },
  { title: "Owes page", path: "/owes", heading: /who owes/i },
  { title: "Tax overview page", path: "/tax", heading: /tax overview/i },
  {
    title: "Portfolio overview page",
    path: "/portfolio",
    heading: /portfolio overview/i,
  },
  { title: "Stocks page", path: "/portfolio/stocks" },
  {
    title: "Watchlist page",
    path: "/research/watchlist",
    heading: /watchlist/i,
  },
  {
    title: "Exchange rates page",
    path: "/admin/exchange-rates",
    heading: /exchange rates/i,
  },
  { title: "AI Chat page", path: "/chat" },
  { title: "Admin overview", path: "/admin", heading: /admin overview/i },
];

test.describe("Page load smoke (catches backend ↔ frontend drift)", () => {
  for (const { title, path, heading } of SMOKE_PAGES) {
    test(`${title} renders without runtime errors`, async ({ page }) => {
      await page.goto(path);
      if (heading) {
        await expect(
          page.getByRole("heading", { level: 1, name: heading }),
        ).toBeVisible();
      } else {
        await page.waitForLoadState("networkidle");
      }
    });
  }
});

const RETIRED_DEEP_LINKS = [
  "/portfolio/exchange-rates",
  "/research/symbol/AAPL",
  "/portfolio/market?symbol=AAPL",
  "/portfolio/watchlist",
];

test.describe("Retired deep links", () => {
  for (const path of RETIRED_DEEP_LINKS) {
    test(`${path} renders Not Found without redirecting`, async ({ page }) => {
      await page.goto(path);

      await expect(
        page.getByRole("heading", { level: 1, name: /page not found/i }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(
        new URL(path, "http://vision").pathname,
      );
    });
  }

  test("the retired account query stays on the accounts hub", async ({
    page,
  }) => {
    await page.goto("/accounts?account=2");

    await expect(
      page.getByRole("heading", { level: 1, name: /^accounts$/i }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/accounts");
  });

  for (const settings of ["dashboard", "app"]) {
    test(`retired settings=${settings} does not open settings`, async ({
      page,
    }) => {
      await page.goto(`/transactions?settings=${settings}&from=bookmark`);

      await expect(
        page.getByRole("heading", { level: 1, name: /^transactions$/i }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      const url = new URL(page.url());
      expect(url.searchParams.has("settings")).toBe(false);
      expect(url.searchParams.get("from")).toBe("bookmark");
    });
  }
});
