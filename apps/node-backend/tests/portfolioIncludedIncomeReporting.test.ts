import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import { mockLogger } from "./helpers/mockLogger.ts";
vi.mock("../src/database/connection.ts", () => mockConnection());
vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
vi.mock("../src/services/portfolioPerformanceSnapshotService.ts", () => ({
  getSnapshots: vi.fn(async () => []),
  getBreakdownSummary: vi.fn(async () => [
    {
      id: 1,
      name: "Synthetic asset",
      currentValue: 100,
      totalInvested: 0,
      gainLoss: 100,
      gainLossPercent: 0,
    },
  ]),
}));
vi.mock(
  "../src/services/currency/currencyConversionService.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/services/currency/currencyConversionService.ts")
      >();
    return {
      ...actual,
      loadCurrentRates: vi.fn(async () => ({ EUR: 1, USD: 0.5 })),
      getHistoricalRateIndex: vi.fn(
        async () => new Map([["USD", [{ date: "2021-02-05", rate: 0.8 }]]]),
      ),
    };
  },
);
import { query as rawQuery } from "../src/database/connection.ts";
import { getHistoricalRateIndex as rawGetHistoricalRateIndex } from "../src/services/currency/currencyConversionService.ts";
import { buildHistoricalRateIndex } from "../src/services/currency/rateFetcher.ts";
import { fetchPortfolioData } from "../src/services/reports/dataFetcherPortfolio.ts";

/** The structural slice of pg's query surface this fake implements. */
type FakeQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;
const query = rawQuery as unknown as Mock<FakeQuery>;
const getHistoricalRateIndex = vi.mocked(rawGetHistoricalRateIndex);
describe("descriptive income portfolio reporting", () => {
  it("keeps literal included income separate and converts it at its historical date", async () => {
    getHistoricalRateIndex.mockResolvedValue(
      buildHistoricalRateIndex([
        { currency_code: "USD", rate_date: "2021-02-05", rate_to_eur: "0.8" },
      ]),
    );
    query.mockResolvedValue({
      rows: [
        {
          investment_id: 1,
          investment_name: "Synthetic asset",
          symbol: "TEST",
          asset_class: "metals",
          year: 2021,
          month: 2,
          amount: "20",
          currency: "USD",
          rate_date: "2021-02-05",
          income_recognition_role: "included_in_units",
        },
        {
          investment_id: 2,
          investment_name: "Ordinary dividend",
          symbol: "DIV",
          asset_class: "stock",
          year: 2021,
          month: 2,
          amount: "10",
          currency: "EUR",
          rate_date: "2021-02-05",
          income_recognition_role: "standard",
        },
      ],
    });
    const report = await fetchPortfolioData("EUR", {
      kind: "year",
      year: 2021,
    });
    expect(report.dividends).toMatchObject({
      totalInKindIncome: 16,
      inKindIncomeCount: 1,
      byMonth: [{ year: 2021, month: 2, amount: 10 }],
      byInvestment: [{ investmentId: 2, total: 10 }],
    });
    expect(report.executiveSummary).toMatchObject({
      totalDividends: 10,
      totalInKindIncome: 16,
      inKindIncomeCount: 1,
    });
  });
});
