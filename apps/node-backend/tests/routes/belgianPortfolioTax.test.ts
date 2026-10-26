import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";
import { defaultHousehold } from "@vision/shared-utils/belgian-tax/settings";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@vision/shared-utils/belgian-tax/profileDefaults";
import {
  buildPortfolioTaxDashboard,
  type PortfolioDashboardInvestment,
} from "@vision/shared-utils/belgian-tax/portfolioDashboard";

vi.mock("../../src/services/settingsService.ts", () => ({
  default: { getAllWithBaselines: vi.fn() },
}));
vi.mock("../../src/repositories/investmentRepository.ts", () => ({
  investmentRepository: { getAllWithCount: vi.fn() },
}));
vi.mock("../../src/repositories/portfolioTransactionRepository.ts", () => ({
  portfolioTransactionRepository: { getAllByInvestmentIds: vi.fn() },
}));
vi.mock("../../src/services/portfolio/portfolioSummaryService.ts", () => ({
  getPortfolioSummary: vi.fn(),
}));
vi.mock("../../src/services/currency/currencyConversionService.ts", () => ({
  FALLBACK_RATES: { EUR: 1, USD: 0.9 },
  listLatestStoredRates: vi.fn(),
  // No stored historical rates: only rates stamped on a transaction are dated.
  getHistoricalRateIndex: vi.fn(() => Promise.resolve(new Map())),
}));
import settingsService from "../../src/services/settingsService.ts";
import { investmentRepository } from "../../src/repositories/investmentRepository.ts";
import { portfolioTransactionRepository } from "../../src/repositories/portfolioTransactionRepository.ts";
import { getPortfolioSummary } from "../../src/services/portfolio/portfolioSummaryService.ts";
import { listLatestStoredRates } from "../../src/services/currency/currencyConversionService.ts";
import router from "../../src/routes/belgianPortfolioTax.ts";

import { mockOf } from "../helpers/mockOf.ts";
const api = routeAgent(router, { mountPath: "/api/belgian-tax" });
const path = "/api/belgian-tax/portfolio-dashboard";
const live = defaultHousehold({
  ...DEFAULT_BELGIAN_TAX_PROFILE,
  taxYear: 2026,
  grossAnnualIncome: 60000,
  profileConfigured: true,
});
const settings = {
  belgian_tax_household_v2: live,
  belgian_tax_household_snapshots_v2: { 2025: { ...live, taxYear: 2025 } },
  belgian_tax_profile_snapshot_meta_v1: {
    2025: { frozenCalculation: { totalPIT: 1234 } },
  },
  portfolio_tax_adjustments_v1: {
    "2025:2": { taxes: "7", fees: 4, future: { keep: true } },
    "2026:2": { taxes: 80, fees: 90 },
  },
  portfolio_tax_classifications_v1: {
    "2": {
      subjectToReynders: true,
      reyndersInterestPortion: 0.25,
      future: 9.123,
    },
  },
};
type Holdings = Awaited<ReturnType<typeof getPortfolioSummary>>;
type Metadata = Awaited<
  ReturnType<typeof investmentRepository.getAllWithCount>
>;
type Transactions = Awaited<
  ReturnType<typeof portfolioTransactionRepository.getAllByInvestmentIds>
>;
type Rates = Awaited<ReturnType<typeof listLatestStoredRates>>;
const rows = [
  { id: 1, name: "Active", symbol: "A", asset_class: "stock", is_active: true },
  {
    id: 2,
    name: "Archived",
    symbol: null,
    asset_class: "bond",
    is_active: false,
  },
];
const txnRows = [
  {
    id: 4,
    investment_id: 1,
    type: "buy",
    date: "2025-01-01",
    amount: 1000,
    taxes: 10,
    fees: 2,
    currency: "USD",
    fx_rate_to_eur: 0.4,
    dividend_amount_convention: "unknown",
  },
  {
    id: 3,
    investment_id: 2,
    type: "sell",
    date: "2025-02-01",
    amount: 100,
    taxes: 5,
    fees: 6,
    currency: "EUR",
    dividend_amount_convention: "unknown",
  },
  {
    id: 2,
    investment_id: 2,
    type: "dividend",
    date: "2025-03-01",
    amount: 70,
    taxes: 30,
    fees: null,
    currency: "EUR",
    dividend_amount_convention: "net",
  },
  {
    id: 1,
    investment_id: 2,
    type: "tax",
    date: "2026-02-01",
    amount: 99,
    taxes: 0,
    fees: 0,
    currency: "EUR",
    dividend_amount_convention: "unknown",
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
    settings,
    expected: {
      portfolio_tax_adjustments_v1: {
        exists: true,
        value: JSON.stringify(settings.portfolio_tax_adjustments_v1),
      },
      portfolio_tax_classifications_v1: {
        exists: true,
        value: settings.portfolio_tax_classifications_v1,
      },
    },
  });
  vi.mocked(investmentRepository).getAllWithCount.mockResolvedValue({
    rows,
    total: 502,
  } as unknown as Metadata);
  vi.mocked(
    portfolioTransactionRepository.getAllByInvestmentIds,
  ).mockResolvedValue(txnRows as unknown as Transactions);
  // Realized gains accumulate per year: 15,000 (stock) and 777 (bond) in 2025,
  // the same again in 2026, nothing before. A replay through a date returns
  // the gains up to that date; the lifetime summary (no date) all of them.
  const realizedThrough = (throughDate?: string) =>
    !throughDate || throughDate >= "2026-12-31"
      ? 2
      : throughDate >= "2025-12-31"
        ? 1
        : 0;
  vi.mocked(getPortfolioSummary).mockImplementation((_target, opts) => {
    const years = realizedThrough(opts?.throughDate);
    return Promise.resolve({
      summaries: [
        {
          ...rows[0],
          assetClass: "stock",
          currency: "EUR",
          currentValue: 2000000,
          realizedGain: 15000 * years,
          unrealizedGain: 40,
        },
        {
          ...rows[1],
          assetClass: "bond",
          currency: "EUR",
          currentValue: 888,
          realizedGain: 777 * years,
          unrealizedGain: 777,
        },
        {
          id: 999,
          assetClass: "stock",
          currency: "EUR",
          currentValue: 99999999,
          realizedGain: 99999999,
        },
      ],
      archivedPresentation: [
        {
          ...rows[1],
          assetClass: "bond",
          currency: "EUR",
          currentValue: 1000,
          realizedGain: 1000,
          unrealizedGain: 60,
        },
      ],
    } as unknown as Holdings);
  });
  vi.mocked(listLatestStoredRates).mockResolvedValue({
    rows: [{ currency_code: "USD", rate_to_eur: 0.8 }],
  } as unknown as Rates);
});

describe("Portfolio Tax authoritative dashboard", () => {
  it("retains frozen PIT, tax-year gains, transaction-date FX, canonical archived gains, and selected-year adjustments", async () => {
    const res = await api.get(path).query({ year: 2025, currency: "eur" });
    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "year")).toBe(2025);
    expect(bodyAt(res, "data", "currency")).toBe("EUR");
    // The USD buy converts at its stamped transaction-date rate 0.4 (ADR-085),
    // not today's 0.8: taxes 10 → 4, fees 2 → 0.8, amount 1,000 → 400.
    // Recorded taxes 4 + 5 (sell) + 30 (dividend) = 39; fees 0.8 + 6 = 6.8.
    expect(bodyAt(res, "data", "totals")).toMatchObject({
      totalRecordedTaxes: 39,
      totalRecordedFees: 6.8,
      totalManualTaxes: 7,
      totalManualFees: 4,
      totalManualCosts: 11,
      totalTaxes: 46,
      totalFees: 10.8,
      totalPIT: 1234,
      portfolioTaxesPlusPIT: 1280,
      // 2025's realized gains only (the lifetime summary holds 2026's too).
      // Archived holding comes from the dated-FX canonical summary (777), not
      // the current-rate archivedPresentation (1000 / 60) the service ignores.
      totalRealizedGain: 15777,
      totalUnrealizedGain: 817,
    });
    expect(bodyAt(res, "data", "yearlyCostTrend")).toEqual([
      { period: "2025-01", taxes: 4, fees: 0.8 },
      { period: "2025-02", taxes: 5, fees: 6 },
      { period: "2025-03", taxes: 30, fees: 0 },
    ]);
    expect(bodyAt(res, "data", "estimates")).toMatchObject({
      // TOB on both legs (WDRT art. 122): buy taxes 4 + the bond sell's 5.
      tobRecorded: 9,
      // stock buy 400 × 0.35% = 1.4 + bond sell 100 × 0.12% = 0.12.
      tobAutoEstimate: 1.52,
      tacrEstimate: 3001.332,
      reyndersEstimate: 58.275,
      cgtEstimate: 0,
    });
    // The bond sell's 5 is its TOB: no capital-gains tax exists in 2025.
    expect(bodyAt(res, "data", "taxBreakdown")).toEqual(
      expect.arrayContaining([{ nameKey: "tax.transactionTax", value: 9 }]),
    );
    expect(bodyAt(res, "data", "taxBreakdown")).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nameKey: "tax.capitalGainsTax" }),
      ]),
    );
    expect(bodyAt(res, "data", "dividend")).toMatchObject({
      grossDividendBase: 100,
      dividendWhtReclaim: 30,
      dividendWhtNetCost: 0,
    });
    expect(bodyAt(res, "data", "investmentBreakdown", 0)).toMatchObject({
      id: 2,
      assetClass: "bond",
      realizedGain: 777,
      currency: "EUR",
    });
    expect(mockOf(investmentRepository, "getAllWithCount")).toHaveBeenCalledWith({
      limit: 500,
      offset: 0,
      active: false,
    });
    expect(
      portfolioTransactionRepository.getAllByInvestmentIds,
    ).toHaveBeenCalledWith({ investmentIds: [1, 2], perInvestmentLimit: 1000 });
    expect(getPortfolioSummary).toHaveBeenCalledWith("EUR", {
      activeInvestmentsOnly: false,
    });
  });
  it("returns exact CAS baselines and preserves unknown settings properties", async () => {
    const res = await api.get(path).query({ year: 2025 });
    expect(bodyAt(res, "data", "records", 0)).toEqual({
      key: "portfolio_tax_adjustments_v1",
      value: settings.portfolio_tax_adjustments_v1,
      expected: {
        exists: true,
        value: JSON.stringify(settings.portfolio_tax_adjustments_v1),
      },
    });
    expect(bodyAt(res, "data", "records", 1, "value")).toEqual(
      settings.portfolio_tax_classifications_v1,
    );
  });
  it("uses the live year when omitted, with current year adjustments and CGT table", async () => {
    const res = await api.get(path);
    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "year")).toBe(2026);
    expect(bodyAt(res, "data", "totals", "totalManualCosts")).toBe(170);
    expect(bodyAt(res, "data", "estimates", "cgtEstimate")).toBe(558.275);
    expect(bodyAt(res, "data", "taxTable", "badgePercent")).toEqual({
      securitiesAccountTaxRate: 0.15,
      capitalGainsTaxRate: 10,
      reyndersTaxRate: 30,
      dividendWHTRate: 30,
    });
  });
  it("converts recorded costs to non-EUR target and labels all amounts consistently", async () => {
    const res = await api.get(path).query({ year: 2025, currency: "USD" });
    // Summary amounts in this fixture are already target-converted by the mocked service.
    expect(bodyAt(res, "data", "totals", "totalRecordedTaxes")).toBe(53.75);
    expect(bodyAt(res, "data", "investmentBreakdown", 0, "currency")).toBe(
      "USD",
    );
  });
  it("leaves an amount without a stored rate out and flags the figures it feeds", async () => {
    vi.mocked(
      portfolioTransactionRepository.getAllByInvestmentIds,
    ).mockResolvedValue([
      // Without a stamped rate: a stamped rate would convert it at that date.
      { ...txnRows[0], currency: "XYZ", fx_rate_to_eur: null },
    ] as unknown as Transactions);
    const res = await api.get(path).query({ year: 2025 });
    // Never the original amount 1:1 (ADR-216): left out, currency and figures flagged.
    expect(bodyAt(res, "data", "totals", "totalRecordedTaxes")).toBe(0);
    expect(bodyAt(res, "data", "unconvertedCurrencies")).toEqual(["XYZ"]);
    expect(bodyAt(res, "data", "incompleteFigures")).toEqual(
      expect.arrayContaining(["totals", "taxBreakdown", "yearlyCostTrend"]),
    );
  });
  it("returns empty holdings success without inventing a profile", async () => {
    vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
      settings: {
        belgian_tax_household_v2: defaultHousehold(DEFAULT_BELGIAN_TAX_PROFILE),
      },
      expected: {},
    });
    vi.mocked(investmentRepository).getAllWithCount.mockResolvedValue({
      rows: [],
      total: 0,
    });
    const res = await api.get(path);
    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "isEmpty")).toBe(true);
    expect(bodyAt(res, "data", "hasProfile")).toBe(false);
    expect(bodyAt(res, "data", "records", 0)).toEqual({
      key: "portfolio_tax_adjustments_v1",
      value: null,
      expected: { exists: false },
    });
  });
  it.each([
    "year=abc",
    "year=1899",
    "year=2201",
    "year=2025&year=2026",
    "currency=EURO",
    "currency=USD&currency=EUR",
  ])("rejects malformed or repeated scalar inputs %s", async (query) => {
    expect((await api.get(`${path}?${query}`)).status).toBe(400);
    expect(getPortfolioSummary).not.toHaveBeenCalled();
  });
  it("propagates source failures instead of empty successful dashboards", async () => {
    vi.mocked(listLatestStoredRates).mockRejectedValue(
      new Error("fixture FX unavailable"),
    );
    const res = await api.get(path);
    expect(res.status).toBe(500);
    expect(bodyAt(res, "ok")).toBe(false);
  });
  it("rejects a listed holding without a canonical summary rather than dropping it", async () => {
    vi.mocked(getPortfolioSummary).mockResolvedValue({
      summaries: [rows[0]],
      archivedPresentation: [{ ...rows[1], realizedGain: 1000 }],
    } as unknown as Holdings);
    expect((await api.get(path)).status).toBe(500);
  });
  it("rejects malformed frozen PIT instead of replacing filed numbers", async () => {
    vi.mocked(settingsService).getAllWithBaselines.mockResolvedValue({
      settings: {
        ...settings,
        belgian_tax_profile_snapshot_meta_v1: {
          2025: { frozenCalculation: { grossIncome: 100 } },
        },
      },
      expected: {},
    });
    expect((await api.get(path).query({ year: 2025 })).status).toBe(500);
  });
});

describe("Portfolio Tax pure presentation parity", () => {
  const build = (summaries: PortfolioDashboardInvestment[], year = 2026) =>
    buildPortfolioTaxDashboard({
      summaries,
      year,
      currency: "EUR",
      totalPIT: 1200,
      filingStatus: "single",
      hasProfile: true,
      adjustments: {},
      classifications: {},
      convert: (value) => value,
    });
  it("keeps explicit tax/fee bucket precedence distinct from recorded aggregate costs", () => {
    const data = build([
      {
        id: 1,
        name: "Special",
        assetClass: "stock",
        transactions: [
          { type: "tax", date: "2026-01-01", amount: 10, taxes: 2 },
          { type: "fee", date: "2026-01-02", amount: 20, fees: 3 },
          { type: "deposit", date: "2026-02-01", amount: 50 },
        ],
      },
    ]);
    expect(data.totals.totalRecordedTaxes).toBe(12);
    expect(data.totals.totalRecordedFees).toBe(23);
    expect(data.taxBreakdown).toEqual([
      { nameKey: "tax.otherTaxes", value: 10 },
    ]);
    expect(data.feeBreakdown).toEqual([
      { nameKey: "tax.managementFees", value: 20 },
    ]);
    expect(data.yearlyCostTrend).toEqual([
      { period: "2026-01", taxes: 12, fees: 23 },
      { period: "2026-02", taxes: 0, fees: 0 },
    ]);
  });
  it("excludes included-in-units dividends and retains null unknown-convention values", () => {
    const data = build([
      {
        id: 1,
        name: "Yield",
        assetClass: "etf",
        transactions: [
          {
            type: "dividend",
            date: "2026-01-01",
            amount: 70,
            taxes: 30,
            dividend_amount_convention: "unknown",
          },
          {
            type: "dividend",
            date: "2026-01-02",
            amount: 900,
            income_recognition_role: "included_in_units",
          },
          {
            type: "dividend",
            date: "2025-01-02",
            amount: 800,
            income_recognition_role: "included_in_units",
          },
        ],
      },
    ]);
    expect(data.hasInKindIncomeUnclassified).toBe(true);
    expect(data.dividend).toMatchObject({
      totalDividendIncome: 70,
      grossDividendWht: 30,
      grossDividendBase: null,
      dividendWhtReclaim: null,
      dividendWhtNetCost: null,
      unknownDividendConventionCount: 1,
    });
    expect(
      build([
        {
          id: 1,
          name: "Old",
          assetClass: "etf",
          transactions: [
            {
              type: "dividend",
              date: "2025-01-01",
              income_recognition_role: "included_in_units",
            },
          ],
        },
      ]).hasInKindIncomeUnclassified,
    ).toBe(false);
  });
  it("converts per-investment realized gains on the server for table display", () => {
    const data = buildPortfolioTaxDashboard({
      summaries: [
        {
          id: 1,
          name: "USD",
          assetClass: "stock",
          currency: "USD",
          realizedGain: 100,
          transactions: [],
        },
      ],
      year: 2026,
      currency: "EUR",
      totalPIT: 0,
      filingStatus: "single",
      hasProfile: false,
      adjustments: { "2026:1": { taxes: 2 } },
      classifications: {},
      convert: (value, currency) => (currency === "USD" ? value * 0.8 : value),
    });
    expect(data.investmentBreakdown[0]).toMatchObject({
      realizedGain: 80,
      currency: "EUR",
      taxes: 2,
    });
  });
});
