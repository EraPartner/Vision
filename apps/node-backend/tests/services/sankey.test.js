import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockCurrencyConversion } from "../helpers/mockCurrencyConversion.js";

vi.mock("../../src/repositories/infoRepositorySankey.js", () => ({
  getSankeyAggregates: vi.fn(),
}));
vi.mock("../../src/services/currency/currencyConversionService.js", () =>
  mockCurrencyConversion(),
);
import { getSankeyAggregates } from "../../src/repositories/infoRepositorySankey.js";
import { convertRowsToEur } from "../../src/services/currency/currencyConversionService.js";
import { computeSankeyFlow } from "../../src/services/calculations/aggregation/sankey.js";

beforeEach(() => {
  getSankeyAggregates.mockReset();
  convertRowsToEur.mockReset();
});

describe("computeSankeyFlow (SQL-grouped rows)", () => {
  it("builds income → category links and a savings node from grouped, multi-currency rows", async () => {
    // SQL now returns one row per (category, currency, is_income) with SUM(ABS).
    getSankeyAggregates.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income: Salary",
        currency: "EUR",
        is_income: true,
        amount: "1000",
      },
      {
        category_id: 1,
        category_name: "Income: Salary",
        currency: "USD",
        is_income: true,
        amount: "100",
      },
      {
        category_id: 2,
        category_name: "Food: Groceries",
        currency: "EUR",
        is_income: false,
        amount: "300",
      },
      {
        category_id: 3,
        category_name: "Housing: Rent",
        currency: "EUR",
        is_income: false,
        amount: "400",
      },
    ]);
    convertRowsToEur.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income: Salary",
        is_income: true,
        amount_eur: 1000,
      },
      {
        category_id: 1,
        category_name: "Income: Salary",
        is_income: true,
        amount_eur: 90,
      },
      {
        category_id: 2,
        category_name: "Food: Groceries",
        is_income: false,
        amount_eur: 300,
      },
      {
        category_id: 3,
        category_name: "Housing: Rent",
        is_income: false,
        amount_eur: 400,
      },
    ]);

    const env = await computeSankeyFlow({ targetCurrency: "EUR", year: 2025 });
    const { nodes, links } = env.data;

    // Income = 1000 + 100*0.9 = 1090; spending = 300 + 400 = 700; savings = 390.
    const income = nodes.find((n) => n.id === "__income__");
    expect(income.value).toBe(1090);
    const savings = nodes.find((n) => n.id === "__savings__");
    expect(savings.value).toBe(390);

    const rentLink = links.find((l) => l.target === "cat:3");
    expect(rentLink.value).toBe(400);
    expect(links).toEqual(
      expect.arrayContaining([
        { source: "__income__", target: "__spending__", value: 700 },
        { source: "__spending__", target: "cat:3", value: 400 },
      ]),
    );

    expect(getSankeyAggregates).toHaveBeenCalledWith({
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
      excludedCategoryIds: [],
      excludedRecipientIds: [],
    });
  });

  it("keeps NULL and same-named real categories as distinct nodes", async () => {
    getSankeyAggregates.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income: Salary",
        currency: "EUR",
        is_income: true,
        amount: "1000",
      },
      {
        category_id: null,
        category_name: null,
        currency: "EUR",
        is_income: false,
        amount: "100",
      },
      {
        category_id: 7,
        category_name: "Uncategorised",
        currency: "EUR",
        is_income: false,
        amount: "200",
      },
      {
        category_id: 8,
        category_name: "Uncategorised",
        currency: "EUR",
        is_income: false,
        amount: "50",
      },
    ]);
    convertRowsToEur.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income: Salary",
        is_income: true,
        amount_eur: 1000,
      },
      {
        category_id: null,
        category_name: null,
        is_income: false,
        amount_eur: 100,
      },
      {
        category_id: 7,
        category_name: "Uncategorised",
        is_income: false,
        amount_eur: 200,
      },
      {
        category_id: 8,
        category_name: "Uncategorised",
        is_income: false,
        amount_eur: 50,
      },
    ]);

    const env = await computeSankeyFlow({ year: 2025 });

    expect(env.data.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "__uncategorised__", value: 100 }),
        expect.objectContaining({
          id: "cat:7",
          label: "Uncategorised",
          value: 200,
        }),
        expect.objectContaining({
          id: "cat:8",
          label: "Uncategorised",
          value: 50,
        }),
      ]),
    );
    expect(env.data.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "__uncategorised__", value: 100 }),
        expect.objectContaining({ target: "cat:7", value: 200 }),
      ]),
    );
  });

  it("balances an overspent year with an explicit funding-gap source", async () => {
    getSankeyAggregates.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income: Salary",
        currency: "EUR",
        is_income: true,
        amount: "100",
      },
      {
        category_id: 2,
        category_name: "Food",
        currency: "EUR",
        is_income: false,
        amount: "150",
      },
    ]);
    convertRowsToEur.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income: Salary",
        is_income: true,
        amount_eur: 100,
      },
      {
        category_id: 2,
        category_name: "Food",
        is_income: false,
        amount_eur: 150,
      },
    ]);

    const env = await computeSankeyFlow({ year: 2025 });
    expect(env.data.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "__income__", value: 100 }),
        expect.objectContaining({ id: "__funding_gap__", value: 50 }),
        expect.objectContaining({ id: "__spending__", value: 150 }),
      ]),
    );
    expect(env.data.nodes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "__savings__" })]),
    );
    expect(env.data.links).toEqual(
      expect.arrayContaining([
        { source: "__income__", target: "__spending__", value: 100 },
        { source: "__funding_gap__", target: "__spending__", value: 50 },
        { source: "__spending__", target: "cat:2", value: 150 },
      ]),
    );
  });

  it("conserves every internal flow after cent rounding, including sub-euro gaps", async () => {
    getSankeyAggregates.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income",
        currency: "EUR",
        is_income: true,
        amount: "1.005",
      },
      ...[2, 3, 4].map((category_id) => ({
        category_id,
        category_name: `Category ${category_id}`,
        currency: "EUR",
        is_income: false,
        amount: "0.335",
      })),
    ]);
    convertRowsToEur.mockResolvedValueOnce([
      {
        category_id: 1,
        category_name: "Income",
        is_income: true,
        amount_eur: 1.005,
      },
      {
        category_id: 2,
        category_name: "Category 2",
        is_income: false,
        amount_eur: 0.335,
      },
      {
        category_id: 3,
        category_name: "Category 3",
        is_income: false,
        amount_eur: 0.335,
      },
      {
        category_id: 4,
        category_name: "Category 4",
        is_income: false,
        amount_eur: 0.335,
      },
    ]);

    const env = await computeSankeyFlow({ year: 2025 });
    const { nodes, links } = env.data;
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "__income__", value: 1 }),
        expect.objectContaining({ id: "__funding_gap__", value: 0.02 }),
        expect.objectContaining({ id: "__spending__", value: 1.02 }),
      ]),
    );

    for (const node of nodes) {
      const incoming = links
        .filter((link) => link.target === node.id)
        .reduce((sum, link) => sum + Math.round(link.value * 100), 0);
      const outgoing = links
        .filter((link) => link.source === node.id)
        .reduce((sum, link) => sum + Math.round(link.value * 100), 0);
      if (incoming > 0 && outgoing > 0) expect(incoming).toBe(outgoing);
    }
  });
});
