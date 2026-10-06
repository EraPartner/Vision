import { describe, it, expect, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.js", () => mockConnection());
import {
  FINANCIAL_ANALYSIS_DATASETS,
  executeFinancialAnalysis,
  __strictDatedConversion as strictDatedConversion,
} from "../src/services/analysisFinancialDatasets.js";
import { assertAnalysisDatasetReference } from "@vision/types/analysis-datasets";

describe("canonical financial analysis", () => {
  it("withholds valuation for missing market quotes while retaining basis and quantity", async () => {
    const query = vi.fn(async (sql) => ({
      rows: sql.includes("FROM investments WHERE")
        ? [
            {
              id: 1,
              name: "Example",
              asset_class: "stock",
              currency: "EUR",
              current_price: null,
            },
          ]
        : sql.includes("portfolio_transactions")
          ? [
              {
                id: 1,
                investment_id: 1,
                type: "buy",
                date: "2026-01-01",
                amount: "100",
                units: "10",
                currency: "EUR",
              },
            ]
          : [],
    }));
    const result = await executeFinancialAnalysis(
      {
        datasetId: "positions",
        fields: [
          "current_value",
          "total_invested",
          "total_units",
          "unrealized_gain",
          "gain_loss",
          "return_pct",
        ],
      },
      { deps: { query } },
    );
    expect(result.rows[0]).toEqual({
      current_value: null,
      total_invested: "100",
      total_units: "10",
      unrealized_gain: null,
      gain_loss: null,
      return_pct: null,
    });
    const scoped = await executeFinancialAnalysis(
      {
        datasetId: "positions",
        fields: [],
        measures: ["sum_total_units"],
        filters: [{ fieldId: "investment_id", operator: "eq", value: 1 }],
      },
      { deps: { query } },
    );
    expect(scoped.rows[0].sum_total_units).toBe("10");
    expect(scoped.declaredColumns[0].unit).toEqual({
      kind: "quantity",
      instrumentId: "1",
    });
    expect(result.coverage).toMatchObject({
      status: "partial",
      missingQuoteRows: 1,
      missingRateRows: 0,
    });
    expect(result.provenance.coverageReasons).toEqual(["market-quote-missing"]);
  });
  it("does not require market quotes for fixed income or closed market positions", async () => {
    const query = vi.fn(async (sql) => ({
      rows: sql.includes("FROM investments WHERE")
        ? [
            {
              id: 1,
              name: "Bond",
              asset_class: "bond",
              currency: "EUR",
              current_price: null,
              interest_rate: "0",
            },
            {
              id: 2,
              name: "Closed",
              asset_class: "stock",
              currency: "EUR",
              current_price: null,
            },
          ]
        : sql.includes("portfolio_transactions")
          ? [
              {
                id: 1,
                investment_id: 1,
                type: "buy",
                date: "2026-01-01",
                amount: "100",
                currency: "EUR",
              },
            ]
          : [],
    }));
    const result = await executeFinancialAnalysis(
      { datasetId: "positions", fields: ["investment_id", "current_value"] },
      { deps: { query } },
    );
    expect(result.rows).toEqual([
      { investment_id: 1, current_value: "100" },
      { investment_id: 2, current_value: "0" },
    ]);
    expect(result.coverage).toMatchObject({
      status: "complete",
      missingQuoteRows: 0,
    });
  });
  it("requires closing observations for benchmark prices and exchange rates", () => {
    for (const [id, field] of [
      ["benchmark-history", "close"],
      ["fx-history", "rate_to_eur"],
      ["benchmark-history", "return_pct"],
    ]) {
      const dataset = FINANCIAL_ANALYSIS_DATASETS.find(
        (item) => item.id === id,
      );
      expect(dataset.fields.find((item) => item.id === field)).toMatchObject({
        temporalKind: "stock",
        aggregation: "last",
      });
    }
  });
  it("declares closing valuation semantics and source dimensions in the catalog", () => {
    for (const id of ["portfolio-history", "broker-history"]) {
      const dataset = FINANCIAL_ANALYSIS_DATASETS.find(
        (item) => item.id === id,
      );
      for (const field of ["value", "invested", "gain_loss"]) {
        expect(dataset.fields.find((item) => item.id === field)).toMatchObject({
          temporalKind: "stock",
          aggregation: "last",
          unit: { kind: "money", currencyParameterId: "currency" },
        });
      }
      if (id === "broker-history")
        expect(
          dataset.fields.find((item) => item.id === "value").requiredTimeGroups,
        ).toEqual(["account_key"]);
    }
    expect(
      FINANCIAL_ANALYSIS_DATASETS.find(
        (item) => item.id === "positions",
      ).fields.find((item) => item.id === "total_units").unit,
    ).toEqual({ kind: "quantity", instrumentColumn: "investment_id" });
  });
  it("converts exact decimals using prior evidence and rejects missing history", () => {
    const rates = [
      { currency_code: "USD", rate_date: "2026-01-01", rate_to_eur: "0.9" },
      { currency_code: "USD", rate_date: "2026-02-01", rate_to_eur: "0.8" },
    ];
    expect(
      strictDatedConversion("100.01", "USD", "EUR", "2026-01-10", rates).value,
    ).toBe("90.009");
    expect(
      strictDatedConversion("10", "USD", "EUR", "2025-01-01", rates),
    ).toMatchObject({ value: null, coverage: "partial" });
  });
  it("uses the closing observation from the complete population before paging", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { date: "2026-01-01", currency: "EUR", value: "0.1" },
        { date: "2026-01-02", currency: "EUR", value: "0.2" },
      ],
    });
    const result = await executeFinancialAnalysis(
      {
        datasetId: "portfolio-history",
        fields: ["currency"],
        groups: ["currency"],
        measures: ["sum_value"],
      },
      { limit: 1, deps: { query } },
    );
    expect(result.rows).toEqual([{ currency: "EUR", sum_value: "0.2" }]);
    expect(result.window.hasMore).toBe(false);
    expect(query.mock.calls[0][0]).toContain("LIMIT 100001");
  });
  it("reuses an unfiltered source across pivot levels without reusing filtered results", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { date: "2026-01-01", currency: "EUR", value: "0.1" },
        { date: "2026-01-02", currency: "EUR", value: "0.2" },
      ],
    });
    const deps = { query, sourceCache: new Map() };
    const plan = { datasetId: "portfolio-history", measures: ["sum_value"] };
    const filtered = await executeFinancialAnalysis(
      {
        ...plan,
        filters: [{ fieldId: "date", operator: "eq", value: "2026-01-01" }],
      },
      { deps },
    );
    const complete = await executeFinancialAnalysis(
      { ...plan, fields: ["currency"], groups: ["currency"] },
      { deps },
    );
    expect(filtered.rows).toEqual([{ sum_value: "0.1" }]);
    expect(complete.rows).toEqual([{ currency: "EUR", sum_value: "0.2" }]);
    expect(query).toHaveBeenCalledTimes(1);
    await executeFinancialAnalysis({ ...plan, from: "2026-01-02" }, { deps });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("uses canonical partial-sale units and excludes unrelated private fields", async () => {
    const query = vi.fn(async (sql) => ({
      rows: sql.includes("FROM investments WHERE")
        ? [
            {
              id: 1,
              name: "Example",
              asset_class: "stock",
              currency: "EUR",
              current_price: "20",
              notes: "private",
            },
          ]
        : sql.includes("portfolio_transactions")
          ? [
              {
                id: 1,
                investment_id: 1,
                account_id: 1,
                type: "buy",
                date: "2026-01-01",
                amount: "100",
                units: "10",
                currency: "EUR",
              },
              {
                id: 2,
                investment_id: 1,
                account_id: 1,
                type: "sell",
                date: "2026-02-01",
                amount: "60",
                units: "4",
                currency: "EUR",
              },
            ]
          : [],
    }));
    const result = await executeFinancialAnalysis(
      {
        datasetId: "positions",
        fields: ["investment_id", "total_units", "current_value"],
      },
      { deps: { query } },
    );
    expect(result.rows).toEqual([
      { investment_id: 1, total_units: "6", current_value: "120" },
    ]);
    await expect(
      executeFinancialAnalysis(
        { datasetId: "positions", fields: ["notes"] },
        { deps: { query } },
      ),
    ).rejects.toThrow("Unsupported");
  });
  it("withholds money when FX evidence is absent", async () => {
    const query = vi.fn(async (sql) => ({
      rows: sql.includes("FROM investments WHERE")
        ? [
            {
              id: 1,
              name: "Example",
              asset_class: "stock",
              currency: "USD",
              current_price: "20",
            },
          ]
        : sql.includes("portfolio_transactions")
          ? [
              {
                id: 1,
                investment_id: 1,
                type: "buy",
                date: "2026-01-01",
                amount: "100",
                units: "10",
                currency: "USD",
              },
            ]
          : [],
    }));
    const result = await executeFinancialAnalysis(
      {
        datasetId: "positions",
        fields: ["current_value", "total_invested", "total_units"],
      },
      { deps: { query } },
    );
    expect(result.rows[0]).toMatchObject({
      current_value: null,
      total_invested: null,
      total_units: "10",
    });
    expect(result.coverage.status).toBe("partial");
  });
  it("rejects historic current-position valuation and mixed unit sums", async () => {
    await expect(
      executeFinancialAnalysis({
        datasetId: "positions",
        fields: ["total_units"],
        to: "2025-01-01",
      }),
    ).rejects.toThrow("historical date");
    await expect(
      executeFinancialAnalysis({
        datasetId: "positions",
        measures: ["sum_total_units"],
      }),
    ).rejects.toThrow("Units require");
  });
  it("exposes benchmark price returns with provider evidence", async () => {
    const fetchBenchmark = vi.fn().mockResolvedValue({
      provider: "fixture",
      data: {
        currency: "USD",
        points: [
          { time: Date.UTC(2026, 0, 1), close: 100 },
          { time: Date.UTC(2026, 0, 2), close: 110 },
        ],
      },
    });
    const result = await executeFinancialAnalysis(
      {
        datasetId: "benchmark-history",
        symbol: "TEST",
        fields: ["date", "close", "return_pct"],
      },
      { deps: { fetchBenchmark } },
    );
    expect(result.rows[1].return_pct).toBe("10");
    expect(result.provenance).toMatchObject({
      provider: "fixture",
      reportingCurrency: "USD",
    });
    expect(result.provenance.methodology).toContain("price-return");
  });
  it("rebases benchmark returns to the selected period and reports missing prices", async () => {
    const result = await executeFinancialAnalysis(
      {
        datasetId: "benchmark-history",
        symbol: "TEST",
        from: "2026-01-02",
        to: "2026-01-04",
        fields: ["date", "close", "return_pct"],
      },
      {
        deps: {
          fetchBenchmark: async () => ({
            data: {
              currency: "USD",
              points: [
                { time: Date.UTC(2026, 0, 1), close: 100 },
                { time: Date.UTC(2026, 0, 2), close: 200 },
                { time: Date.UTC(2026, 0, 3), close: 220 },
                { time: Date.UTC(2026, 0, 4), close: null },
              ],
            },
          }),
        },
      },
    );
    expect(result.rows.map((row) => row.return_pct)).toEqual(["0", "10", null]);
    expect(result.coverage).toMatchObject({
      status: "partial",
      sourceRows: 3,
      unavailableRows: 1,
    });
  });
  it("sums the latest broker value per account even when closing dates differ", async () => {
    const query = vi.fn(async (sql) => ({
      rows: sql.includes("to_regclass")
        ? [{ relation: "portfolio_broker_snapshots" }]
        : [
            {
              date: "2026-01-01",
              account_key: "A",
              currency: "EUR",
              value: "100",
            },
            {
              date: "2026-01-01",
              account_key: "B",
              currency: "EUR",
              value: "50",
            },
            {
              date: "2026-01-02",
              account_key: "A",
              currency: "EUR",
              value: "120",
            },
          ],
    }));
    const result = await executeFinancialAnalysis(
      {
        datasetId: "broker-history",
        fields: ["currency"],
        groups: ["currency"],
        measures: ["sum_value"],
      },
      { deps: { query } },
    );
    expect(result.rows).toEqual([{ currency: "EUR", sum_value: "170" }]);
  });
  it("reports unavailable historical observations and withholds a missing closing value", async () => {
    const result = await executeFinancialAnalysis(
      { datasetId: "portfolio-history", measures: ["sum_value"] },
      {
        deps: {
          query: async () => ({
            rows: [
              { date: "2026-01-01", currency: "EUR", value: "100" },
              { date: "2026-01-02", currency: "EUR", value: null },
            ],
          }),
        },
      },
    );
    expect(result.rows).toEqual([{ sum_value: null }]);
    expect(result.coverage).toMatchObject({
      status: "partial",
      unavailableRows: 1,
    });
    expect(result.provenance.coverageReasons).toContain(
      "financial-observation-missing",
    );
  });
  it("allows immutable saving refs without expanding SQL view registry", () => {
    expect(
      assertAnalysisDatasetReference({
        id: "positions",
        schemaVersion: 1,
        authorizationScope: "local-user-database",
      }).relation,
    ).toBe("service:positions@1");
  });
  it("does not invent a reporting currency for a benchmark with missing provider currency", async () => {
    const fetchBenchmark = vi.fn().mockResolvedValue({
      data: { points: [{ time: Date.UTC(2026, 0, 1), close: 100 }] },
    });
    const result = await executeFinancialAnalysis(
      { datasetId: "benchmark-history", symbol: "TEST", fields: ["close"] },
      { deps: { fetchBenchmark } },
    );
    expect(result.declaredColumns[0].unit).toEqual({
      kind: "money",
      currencyColumn: "currency",
    });
    expect(result.provenance.reportingCurrency).toBeNull();
    expect(result.coverage.status).toBe("partial");
  });
  it("withholds aggregates with missing contributors and sorts without floating point conversion", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { date: "2026-01-01", currency: "EUR", value: "9007199254740993.01" },
        { date: "2026-01-02", currency: "EUR", value: "9007199254740993.02" },
        { date: "2026-01-03", currency: "EUR", value: null },
      ],
    });
    const total = await executeFinancialAnalysis(
      { datasetId: "portfolio-history", measures: ["sum_value"] },
      { deps: { query } },
    );
    expect(total.rows[0].sum_value).toBeNull();
    const sorted = await executeFinancialAnalysis(
      {
        datasetId: "portfolio-history",
        fields: ["date", "value"],
        orderBy: [{ id: "value", direction: "desc" }],
      },
      { deps: { query } },
    );
    expect(
      sorted.rows.filter((row) => row.value !== null).map((row) => row.date),
    ).toEqual(["2026-01-02", "2026-01-01"]);
  });
  it("rejects nonexistent dates and source overflow before aggregation", async () => {
    await expect(
      executeFinancialAnalysis({
        datasetId: "portfolio-history",
        fields: ["date"],
        from: "2026-02-30",
      }),
    ).rejects.toThrow("Invalid financial date");
    const query = vi.fn().mockResolvedValue({ rows: Array(100001).fill({}) });
    await expect(
      executeFinancialAnalysis(
        { datasetId: "portfolio-history", measures: ["count"] },
        { deps: { query } },
      ),
    ).rejects.toThrow("source row limit");
  });
});
