import { test, expect } from "./fixtures";

test("category pivot windows a long history while keeping every period reachable", async ({
  page,
}) => {
  const categoryPivot: Record<
    string,
    Array<{
      categoryId: number;
      categoryName: string;
      total: number;
      income: number;
      expense: number;
      transactionCount: number;
    }>
  > = {};
  const months: Array<{
    month: number;
    year: number;
    period_start: string;
    period_end: string;
    total_spending: number;
    total_income: number;
    net_amount: number;
    transaction_count: number;
  }> = [];

  for (let year = 2017; year <= 2026; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const period = `${year}-${String(month).padStart(2, "0")}`;
      categoryPivot[period] = [
        {
          categoryId: 11,
          categoryName: "FOOD: GROCERIES",
          total: -100,
          income: 0,
          expense: -100,
          transactionCount: 1,
        },
        {
          categoryId: 12,
          categoryName: "FOOD: RESTAURANT",
          total: -25,
          income: 0,
          expense: -25,
          transactionCount: 1,
        },
      ];
      months.push({
        month,
        year,
        period_start: `${period}-01`,
        period_end: `${period}-28`,
        total_spending: -125,
        total_income: 0,
        net_amount: -125,
        transaction_count: 2,
      });
    }
  }

  await page.route("**/api/aggregations/monthly-summary?**", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        data: {
          data: {
            months,
            summary: {
              total_spending: -15_000,
              total_income: 0,
              net_amount: -15_000,
              transaction_count: 240,
              period_start: "2017-01-01",
              period_end: "2026-12-31",
            },
          },
        },
      },
    });
  });

  await page.route("**/api/aggregations/category-pivot?**", async (route) => {
    await route.fulfill({
      json: { ok: true, data: { data: { categoryPivot } } },
    });
  });

  await page.route(
    "**/api/aggregations/recipient-insights?**",
    async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          data: { data: { topMerchants: [], monthOverMonth: [] } },
        },
      });
    },
  );

  await page.route(
    "**/api/aggregations/recipient-by-year?**",
    async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          data: { data: { recipientsByYear: {} } },
        },
      });
    },
  );

  await page.goto("/statistics");
  await page.getByRole("tab", { name: "Categories" }).click();
  const table = page.getByRole("table", { name: "Category Pivot Table" });
  await expect(table).toBeVisible({ timeout: 10_000 });

  const mountedPeriods = table.locator("[data-pivot-period]");
  const visiblePeriodValues = async () =>
    mountedPeriods.evaluateAll((elements) => [
      ...new Set(
        elements.map((element) => element.getAttribute("data-pivot-period")),
      ),
    ]);

  await expect
    .poll(visiblePeriodValues)
    .toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `2026-${String(index + 1).padStart(2, "0")}`,
      ),
    );
  expect(await mountedPeriods.count()).toBeLessThan(100);

  const navigation = page.getByRole("navigation", {
    name: "Category Pivot Table",
  });
  const previous = navigation.getByRole("button", { name: "Previous" });
  const next = navigation.getByRole("button", { name: "Next" });
  await expect(next).toBeDisabled();

  const reachedPeriods = new Set<string>();
  for (;;) {
    for (const period of await visiblePeriodValues()) {
      if (period) reachedPeriods.add(period);
    }
    if (await previous.isDisabled()) break;
    await previous.click();
  }

  expect(reachedPeriods.size).toBe(120);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect
    .poll(visiblePeriodValues)
    .toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `2017-${String(index + 1).padStart(2, "0")}`,
      ),
    );

  const stickyCategoryHeader = table.getByRole("columnheader", {
    name: "Category",
  });
  await expect
    .poll(() =>
      stickyCategoryHeader.evaluate(
        (element) => getComputedStyle(element).position,
      ),
    )
    .toBe("sticky");
});
