import { describe, expect, it } from "vitest";
import { __aggregatePortfolioExposure as aggregatePortfolioExposure } from "../src/services/portfolio/portfolioExposureService.js";

const fundDocument = (weight = "4") => ({
  contractVersion: 1,
  fund: {
    name: "World Fund",
    identifiers: [{ type: "proprietary", value: "world" }],
  },
  shareClass: {
    name: "World EUR",
    identifiers: [{ type: "isin", value: "IE00B4L5Y983" }],
    currency: "EUR",
  },
  source: {
    kind: "user-supplied-file",
    fileName: "world.csv",
    asOfDate: "2026-09-01",
    retrievedAt: "2026-09-02T00:00:00Z",
    license: { status: "user-provided", redistribution: "forbidden" },
  },
  holdings: [
    {
      provenance: { rowNumber: 2 },
      name: "Apple Inc.",
      identifiers: [{ type: "isin", value: "US0378331005" }],
      instrumentType: "equity",
      exposureKind: "direct",
      exposureStatus: "supported",
      weightPercent: weight,
      currency: "USD",
      countryCode: "US",
    },
  ],
  coverage: {
    status: "partial",
    reportedWeightPercent: weight,
    supportedWeightPercent: weight,
    unsupportedWeightPercent: "0",
    missingWeightPercent: String(100 - Number(weight)),
  },
  staleness: {
    evaluatedAt: "2026-09-14",
    maximumAgeDays: 30,
    ageDays: 13,
    status: "current",
  },
});

describe("portfolio exposure aggregation", () => {
  it("combines direct and fund issuer contributions without renormalizing uncovered weight", () => {
    const summary = {
      currency: "EUR",
      computed_at: "2026-09-14T10:00:00Z",
      totals: { totalPortfolioValue: 15300 },
      summaries: [
        { id: 1, name: "Fund A", asset_class: "etf", currentValue: 10000 },
        { id: 2, name: "Fund B", asset_class: "etf", currentValue: 5000 },
        { id: 3, name: "Apple", asset_class: "stock", currentValue: 300 },
      ],
    };
    const classification = {
      issuerId: "apple",
      issuerName: "Apple Inc.",
      sector: "Technology",
      issuerCountryCode: "US",
      sourceLabel: "Synthetic Demo mapping",
    };
    const sources = {
      classifications: [
        { ...classification, investmentId: 3 },
        {
          ...classification,
          identifierType: "isin",
          identifierValue: "US0378331005",
          identifierExchange: null,
        },
      ],
      documents: [
        { investmentId: 1, document: fundDocument("4") },
        { investmentId: 2, document: fundDocument("6") },
      ],
    };
    const result = aggregatePortfolioExposure(summary, sources);
    expect(result.issuer.rows[0]).toMatchObject({ id: "apple", amount: 1000 });
    expect(result.issuer.rows[0].weightPercent).toBe(6.54);
    expect(result.issuer.rows[0].contributions).toHaveLength(3);
    expect(result.uncoveredValue).toBe(14300);
    expect(result.uncoveredWeightPercent).toBe(93.46);
    expect(
      result.issuer.classifiedValue +
        result.issuer.unclassifiedValue +
        result.uncoveredValue +
        result.coveredCashValue,
    ).toBe(result.totalValue);
    expect(result.scopeNotes).toContain(
      "No economic foreign-exchange exposure is inferred.",
    );
  });

  it("keeps direct missing classifications unclassified and unexpanded ETFs uncovered", () => {
    const result = aggregatePortfolioExposure(
      {
        currency: "EUR",
        computed_at: "2026-09-14T10:00:00Z",
        totals: { totalPortfolioValue: 120 },
        summaries: [
          { id: 1, name: "Unknown ETF", asset_class: "etf", currentValue: 100 },
          {
            id: 2,
            name: "Unknown stock",
            asset_class: "stock",
            currentValue: 20,
          },
        ],
      },
      { classifications: [], documents: [] },
    );
    expect(result.uncoveredValue).toBe(100);
    expect(result.issuer.unclassifiedValue).toBe(20);
  });

  it("re-evaluates fund staleness at read time", () => {
    const document = fundDocument("4");
    const result = aggregatePortfolioExposure(
      {
        currency: "EUR",
        computed_at: "2026-11-01T10:00:00Z",
        totals: { totalPortfolioValue: 100 },
        summaries: [
          { id: 1, name: "Fund A", asset_class: "etf", currentValue: 100 },
        ],
      },
      {
        classifications: [
          {
            issuerId: "apple",
            issuerName: "Apple Inc.",
            identifierType: "isin",
            identifierValue: "US0378331005",
            identifierExchange: null,
          },
        ],
        documents: [{ investmentId: 1, document }],
      },
    );

    expect(document.staleness.status).toBe("current");
    expect(result.issuer.rows[0].contributions[0]).toMatchObject({
      sourceAsOfDate: "2026-09-01",
      stale: true,
    });
    expect(result.warnings[0]).toMatchObject({
      code: "STALE_FUND_SOURCE",
      evaluatedAt: "2026-11-01",
      ageDays: 61,
      maximumAgeDays: 30,
    });
    expect(result.fundSources[0]).toMatchObject({
      investmentName: "Fund A",
      asOfDate: "2026-09-01",
      evaluatedAt: "2026-11-01",
      stale: true,
    });
  });
});
