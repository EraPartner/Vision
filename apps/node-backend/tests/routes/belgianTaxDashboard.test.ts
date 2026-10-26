import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";
import { defaultHousehold } from "@vision/shared-utils/belgian-tax/settings";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@vision/shared-utils/belgian-tax/profileDefaults";
import {
  computeHouseholdTax,
  toBelgianTaxCalculation,
} from "@vision/shared-utils/belgian-tax/household";
import { householdForRecordedIncome } from "@vision/shared-utils/belgian-tax/recordedIncomeAttribution";

vi.mock("../../src/services/settingsService.ts", () => ({
  default: { getAllWithBaselines: vi.fn() },
}));
vi.mock("../../src/services/calculations/aggregation/monthly.ts", () => ({
  computeMonthlySummary: vi.fn(),
}));
vi.mock("../../src/services/calculations/aggregation/categoryPivot.ts", () => ({
  computeCategoryPivot: vi.fn(),
}));
vi.mock("../../src/repositories/portfolioTransactionRepository.ts", () => ({
  portfolioTransactionRepository: { getRowsForPortfolioMath: vi.fn() },
}));
vi.mock("../../src/services/currency/currencyConversionService.ts", () => ({
  listLatestStoredRates: vi.fn(),
  // No stored historical rates: only rates stamped on a transaction are dated.
  getHistoricalRateIndex: vi.fn(async () => new Map()),
}));
import settingsService from "../../src/services/settingsService.ts";
import { computeMonthlySummary } from "../../src/services/calculations/aggregation/monthly.ts";
import { computeCategoryPivot } from "../../src/services/calculations/aggregation/categoryPivot.ts";
import { portfolioTransactionRepository } from "../../src/repositories/portfolioTransactionRepository.ts";
import { listLatestStoredRates } from "../../src/services/currency/currencyConversionService.ts";
import router from "../../src/routes/belgianTaxDashboard.ts";
import { must } from "../helpers/must.ts";

const api = routeAgent(router, { mountPath: "/api/belgian-tax" });
const path = "/api/belgian-tax/dashboard";
const profile = {
  ...DEFAULT_BELGIAN_TAX_PROFILE,
  taxYear: 2025,
  grossAnnualIncome: 60000,
  taxIncomeCategoryIds: [1],
  profileConfigured: true,
};
function household() {
  return defaultHousehold(profile);
}
function months(values: [number, number, number][]) {
  return {
    data: {
      months: values.map(([year, month, income]) => ({
        year,
        month,
        total_income: income,
        total_spending: 0,
        net_amount: income,
        transaction_count: 1,
        period_start: null,
        period_end: null,
      })),
      unconverted_count: 0,
      unconverted_currencies: [] as string[],
      summary: {
        total_income: values.reduce((s, v) => s + v[2], 0),
        total_spending: 0,
        net_amount: 0,
        transaction_count: values.length,
        period_start: null,
        period_end: null,
      },
    },
    meta: { source: "live", computedAt: "fixture" },
  };
}
function cell(income: number, owner?: { partner?: number; joint?: number }) {
  return {
    categoryId: 2,
    categoryName: "Salary",
    categoryPathIds: [1, 2],
    categoryPathSegments: ["Income", "Salary"],
    income,
    total: income,
    expense: 0,
    transactionCount: 1,
    ...(owner ? { incomeByOwner: owner } : {}),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
    settings: { belgian_tax_household_v2: household() },
    expected: {},
  });
  vi.mocked(computeMonthlySummary).mockResolvedValue(
    months([
      [2025, 1, 1000],
      [2025, 2, 3000],
    ]),
  );
  vi.mocked(computeCategoryPivot).mockResolvedValue({
    data: {
      unconverted_count: 0,
      unconverted_currencies: [],
      categoryPivot: { "2025-01": [cell(1000)], "2025-02": [cell(3000)] },
    },
    meta: { source: "live", computedAt: "fixture" },
  });
  vi.mocked(
    portfolioTransactionRepository.getRowsForPortfolioMath,
  ).mockResolvedValue([]);
  vi.mocked(listLatestStoredRates).mockResolvedValue({ rows: [] });
});
describe("Native Tax dashboard source contract", () => {
  it("selects ancestor categories and prorates a single server PIT estimate over the live window", async () => {
    const response = await api
      .get(path)
      .query({
        start_date: "2024-03-01",
        end_date: "2026-02-28",
        excluded_category_ids: [7, 8],
        excluded_recipient_ids: 9,
      })
      .expect(200);
    const data = bodyAt(response, "data") as {
      monthlyIncomeTax: { income: number; estimatedTax: number }[];
      yearlyIncome: { income: number }[];
      hasIncomeSources: boolean;
    };
    expect(data.hasIncomeSources).toBe(true);
    expect(data.yearlyIncome[0]?.income).toBe(4000);
    expect(data.monthlyIncomeTax[0]?.estimatedTax).toBeCloseTo(
      (data.monthlyIncomeTax[1]?.estimatedTax ?? 0) / 3,
      10,
    );
    expect(computeCategoryPivot).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2024-03-01",
        endDate: "2026-02-28",
        excludedCategoryIds: [7, 8],
        excludedRecipientIds: [9],
        targetCurrency: "EUR",
      }),
    );
  });
  it("scales filed PIT by frozen gross and keeps partial frozen trend fields verbatim", async () => {
    vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_household_v2: { ...household(), taxYear: 2026 },
        belgian_tax_profile_snapshot_meta_v1: {
          "2025": {
            frozenCalculation: { grossIncome: 8000, totalPIT: 800 },
            filing: { reference: "synthetic" },
          },
        },
      },
      expected: {},
    });
    const response = await api.get(path).query({ year: 2025 }).expect(200);
    expect(bodyAt(response, "data", "monthlyIncomeTax")).toEqual([
      { period: "2025-01", income: 1000, estimatedTax: 100 },
      { period: "2025-02", income: 3000, estimatedTax: 300 },
    ]);
    expect(bodyAt(response, "data", "yearlyIncome", 0, "estimatedTax")).toBe(
      400,
    );
    expect(
      bodyAt(response, "data", "yearCalculations", 1, "calculation"),
    ).toEqual({ grossIncome: 8000, totalPIT: 800 });
    expect(bodyAt(response, "data", "yearCalculations", 1, "isFiled")).toBe(
      true,
    );
    expect(bodyAt(response, "data", "householdBreakdownRows")).toEqual([]);
  });
  it("attributes partner/joint recorded income before computing PIT and household row totals", async () => {
    const input = defaultHousehold({
      ...profile,
      filingStatus: "married_joint",
      spouseProfessionalIncome: 30000,
    });
    const partnerB = must(input.partners.find((p) => p.id === "B"), "input.partners.find((p) => p.id === \"B\")");
    partnerB.activities = must(input.partners[0], "input.partners[0]").activities.map((a, index) => ({
      ...a,
      id: `act_synthetic_b_${index}`,
      grossIncome: 30000,
    }));
    vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
      settings: { belgian_tax_household_v2: input },
      expected: {},
    });
    vi.mocked(computeMonthlySummary).mockResolvedValue(
      months([[2025, 1, 100000]]),
    );
    vi.mocked(computeCategoryPivot).mockResolvedValue({
      data: {
        unconverted_count: 0,
        unconverted_currencies: [],
        categoryPivot: {
          "2025-01": [cell(100000, { partner: 20000, joint: 20000 })],
        },
      },
      meta: { source: "live", computedAt: "fixture" },
    });
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "recordedIncomeByPartner")).toEqual({
      A: 70000,
      B: 30000,
    });
    const attributed = must(householdForRecordedIncome(input, 100000, {
      partner: 20000,
      joint: 20000,
    }), "householdForRecordedIncome(input, 100000, { partner: 2000...");
    const expected = toBelgianTaxCalculation(
      computeHouseholdTax(attributed),
      attributed,
    );
    expect(
      bodyAt(response, "data", "yearlyIncome", 0, "estimatedTax"),
    ).toBeCloseTo(expected.totalPIT, 8);
    const rows = bodyAt(response, "data", "householdBreakdownRows") as {
      partnerAmounts: Record<string, number>;
      household: number;
    }[];
    for (const row of rows)
      expect(row.household).toBeCloseTo(
        (row.partnerAmounts.A ?? 0) + (row.partnerAmounts.B ?? 0),
        10,
      );
  });
  it("includes inactive portfolio recorded costs with latest stored FX and no manual adjustment double count", async () => {
    vi.mocked(
      portfolioTransactionRepository.getRowsForPortfolioMath,
    ).mockResolvedValue([
      {
        type: "tax",
        date: "2025-01-01",
        amount: 100,
        taxes: 2,
        fees: 0,
        currency: "USD",
      },
      {
        type: "buy",
        date: "2025-02-01",
        amount: 2000,
        taxes: 3,
        fees: 5,
        currency: "EUR",
      },
      {
        type: "tax",
        date: "2024-01-01",
        amount: 900,
        taxes: 0,
        fees: 0,
        currency: "EUR",
      },
    ] as never);
    vi.mocked(listLatestStoredRates).mockResolvedValue({
      rows: [{ currency_code: "USD", rate_to_eur: "0.8" }] as never,
    });
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "portfolioTaxesForYear")).toBeCloseTo(
      84.6,
      10,
    );
    expect(
      portfolioTransactionRepository.getRowsForPortfolioMath,
    ).toHaveBeenCalledWith({ activeInvestmentsOnly: false });
    expect(
      (bodyAt(response, "data", "yearCalculations") as { year: number }[]).map(
        (y) => y.year,
      ),
    ).toContain(2024);
  });
  it("converts a recorded portfolio tax at its transaction-date rate", async () => {
    vi.mocked(
      portfolioTransactionRepository.getRowsForPortfolioMath,
    ).mockResolvedValue([
      {
        type: "tax",
        date: "2025-01-01",
        amount: 100,
        taxes: 0,
        fees: 0,
        currency: "USD",
        fx_rate_to_eur: "0.5",
      },
    ] as never);
    vi.mocked(listLatestStoredRates).mockResolvedValue({
      rows: [{ currency_code: "USD", rate_to_eur: "0.8" }] as never,
    });
    const response = await api.get(path).expect(200);
    // 100 USD at the 0.5 stamped on 2025-01-01 (ADR-085), not today's 0.8.
    expect(bodyAt(response, "data", "portfolioTaxesForYear")).toBe(50);
  });
  it("returns failed financial reads as errors rather than an empty setup prompt", async () => {
    vi.mocked(computeCategoryPivot).mockRejectedValue(
      new Error("synthetic read failed"),
    );
    await api.get(path).expect(500);
  });
  it("keeps the income-source CTA flag while deriving fallback chart income from successful statistics", async () => {
    const live = defaultHousehold({
      ...profile,
      taxIncomeCategoryIds: [],
      profileConfigured: false,
      grossAnnualIncome: 0,
    });
    vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
      settings: { belgian_tax_household_v2: live },
      expected: {},
    });
    const response = await api.get(path).expect(200);
    expect(bodyAt(response, "data", "hasIncomeSources")).toBe(false);
    expect(bodyAt(response, "data", "hasStatsData")).toBe(true);
    expect(bodyAt(response, "data", "isEmpty")).toBe(false);
    expect(bodyAt(response, "data", "recordedIncomeByPartner")).toBeNull();
    expect(bodyAt(response, "data", "yearlyIncome", 0, "income")).toBe(4000);
  });
  it("uses the historical snapshot's income categories and limits its monthly reserve to that year", async () => {
    const live = defaultHousehold({
      ...profile,
      taxYear: 2026,
      taxIncomeCategoryIds: [99],
    });
    const historical = household();
    vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_household_v2: live,
        belgian_tax_household_snapshots_v2: { "2025": historical },
      },
      expected: {},
    });
    vi.mocked(computeMonthlySummary).mockResolvedValue(
      months([
        [2025, 1, 1000],
        [2026, 1, 9000],
      ]),
    );
    vi.mocked(computeCategoryPivot).mockResolvedValue({
      data: {
        unconverted_count: 0,
        unconverted_currencies: [],
        categoryPivot: { "2025-01": [cell(1000)], "2026-01": [cell(9000)] },
      },
      meta: { source: "live", computedAt: "fixture" },
    });
    const response = await api.get(path).query({ year: 2025 }).expect(200);
    expect(bodyAt(response, "data", "isHistorical")).toBe(true);
    expect(bodyAt(response, "data", "hasIncomeSources")).toBe(true);
    expect(
      (
        bodyAt(response, "data", "monthlyIncomeTax") as { period: string }[]
      ).map((m) => m.period),
    ).toEqual(["2025-01"]);
    expect(bodyAt(response, "data", "exportProfile", "taxYear")).toBe(2025);
    expect(
      bodyAt(response, "data", "exportProfile", "taxIncomeCategoryIds"),
    ).toEqual([1]);
  });
  it("converts recorded portfolio taxes into the requested target and flags a currency without a stored rate", async () => {
    vi.mocked(
      portfolioTransactionRepository.getRowsForPortfolioMath,
    ).mockResolvedValue([
      {
        type: "tax",
        date: "2025-01-01",
        amount: 80,
        taxes: 0,
        fees: 0,
        currency: "EUR",
      },
      {
        type: "buy",
        date: "2025-02-01",
        amount: 1000,
        taxes: 12,
        fees: 0,
        currency: "XYZ",
      },
    ] as never);
    vi.mocked(listLatestStoredRates).mockResolvedValue({
      rows: [{ currency_code: "USD", rate_to_eur: "0.8" }] as never,
    });
    const response = await api.get(path).query({ currency: "usd" }).expect(200);
    expect(bodyAt(response, "data", "currency")).toBe("USD");
    // 80 EUR at 0.8 is 100 USD; the 12 XYZ have no stored rate and are left
    // out and flagged, never added 1:1.
    expect(bodyAt(response, "data", "portfolioTaxesForYear")).toBe(100);
    expect(bodyAt(response, "data", "unconvertedCurrencies")).toEqual(["XYZ"]);
    expect(bodyAt(response, "data", "incompleteFigures")).toEqual([
      "portfolioTaxesForYear",
      "totalTaxIncludingPortfolio",
      "totalTaxIncludingPropertyEstimate",
    ]);
    expect(computeMonthlySummary).toHaveBeenCalledWith(
      expect.objectContaining({ targetCurrency: "USD" }),
    );
  });
  it.each([
    { year: "2025abc" },
    { currency: "US" },
    { year: [2025, 2026] },
    { start_date: "2025-02-30" },
    { start_date: "2025-02-02", end_date: "2025-01-01" },
    { excluded_category_ids: "1e3" },
    { excluded_recipient_ids: "12abc" },
    { start: "2025-01-01" },
  ])("rejects invalid request %j", async (query) => {
    await api.get(path).query(query).expect(400);
    expect(computeMonthlySummary).not.toHaveBeenCalled();
  });
});
