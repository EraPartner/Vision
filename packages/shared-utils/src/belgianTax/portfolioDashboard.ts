import { getTaxTable } from "./constants.ts";
import { buildPortfolioCostBreakdowns } from "./costBreakdown.ts";
import {
  yearOf,
  enrichInvestmentCosts,
  computeTobRecorded,
  computeTobAutoEstimate,
  computeTacrEstimate,
  computeRealizedGainSplit,
  computeReyndersEstimate,
  computeCgtEstimate,
  computeDividendWht,
  leaveOutUnconverted,
  type PortfolioTaxInvestment,
  type MaybeConvertFn,
  type UnconvertedFigures,
} from "./portfolioTax.ts";

export interface PortfolioDashboardInvestment extends PortfolioTaxInvestment {
  name: string;
  symbol?: string | null | undefined;
  unrealizedGain?: number;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Mirrors usePortfolioTaxData, including all-time gain/current-value estimates for a
 * historical year and original number accumulation order. Recorded costs/dividends/buy
 * legs and manual adjustment keys are filtered by the viewed year.
 *
 * `convert` returns undefined for a currency without an exchange rate. Such an
 * amount is left out (never converted 1:1 or at a guessed rate); the result
 * lists its currency in `unconvertedCurrencies` and every figure it feeds in
 * `incompleteFigures`. */
export function buildPortfolioTaxDashboard(input: {
  summaries: PortfolioDashboardInvestment[];
  year: number;
  currency: string;
  totalPIT: number;
  filingStatus: string;
  hasProfile: boolean;
  adjustments: unknown;
  classifications: unknown;
  convert: MaybeConvertFn;
}) {
  const { year, currency, totalPIT, filingStatus, hasProfile } = input;
  const missing: UnconvertedFigures = {
    currencies: new Set(),
    figures: new Set(),
  };
  const convertFor = (...figures: string[]) =>
    leaveOutUnconverted(input.convert, missing, ...figures);
  // Recorded costs feed the totals, the per-asset and per-investment tables.
  const convertCosts = convertFor(
    "totals",
    "taxByAssetClass",
    "investmentBreakdown",
  );
  const adjustments = record(input.adjustments);
  const classifications = record(input.classifications);
  // The web overlays the complete persisted classification entry. Reads never sanitize
  // or write settings; unknown properties also remain in the original CAS records.
  const summaries = input.summaries.map((inv) => ({
    ...inv,
    ...record(classifications[inv.id]),
  }));
  const enriched = summaries.map((inv) => {
    const manual = record(adjustments[`${year}:${inv.id}`]);
    return {
      ...inv,
      ...enrichInvestmentCosts(inv, year, convertCosts, {
        taxes: Number(manual.taxes) || 0,
        fees: Number(manual.fees) || 0,
      }),
    };
  });
  const totalTaxes = enriched.reduce((s, i) => s + i.taxes, 0);
  const totalFees = enriched.reduce((s, i) => s + i.fees, 0);
  const totalRecordedTaxes = enriched.reduce((s, i) => s + i.recordedTaxes, 0);
  const totalRecordedFees = enriched.reduce((s, i) => s + i.recordedFees, 0);
  const totalManualTaxes = enriched.reduce((s, i) => s + i.manualTaxes, 0);
  const totalManualFees = enriched.reduce((s, i) => s + i.manualFees, 0);
  const convertTotals = convertFor("totals");
  const totalRealizedGain = summaries.reduce(
    (s, i) => s + convertTotals(i.realizedGain || 0, i.currency),
    0,
  );
  const totalUnrealizedGain = summaries.reduce(
    (s, i) => s + convertTotals(i.unrealizedGain || 0, i.currency),
    0,
  );
  const breakdowns = buildPortfolioCostBreakdowns({
    summaries,
    year,
    convert: convertFor("taxBreakdown", "feeBreakdown"),
    manualTaxes: totalManualTaxes,
    manualFees: totalManualFees,
    labels: {
      capitalGainsTax: "tax.capitalGainsTax",
      dividendWithholding: "tax.dividendWithholding",
      transactionTax: "tax.transactionTax",
      otherTaxes: "tax.otherTaxes",
      manualTaxAdjustments: "tax.manualTaxAdjustments",
      brokerFees: "tax.brokerFees",
      managementFees: "tax.managementFees",
      otherFees: "tax.otherFees",
      manualFeeAdjustments: "tax.manualFeeAdjustments",
    },
  });
  const byAsset: Record<string, { taxes: number; fees: number }> = {};
  for (const inv of enriched) {
    byAsset[inv.assetClass] ??= { taxes: 0, fees: 0 };
    byAsset[inv.assetClass]!.taxes += inv.taxes;
    byAsset[inv.assetClass]!.fees += inv.fees;
  }
  const months: Record<
    string,
    { period: string; taxes: number; fees: number }
  > = {};
  const convertTrend = convertFor("yearlyCostTrend");
  for (const inv of summaries)
    for (const txn of inv.transactions) {
      if (yearOf(txn.date) !== year || !txn.date) continue;
      const period = txn.date.slice(0, 7);
      const month = (months[period] ??= { period, taxes: 0, fees: 0 });
      if (txn.type === "tax")
        month.taxes += convertTrend(Number(txn.amount) || 0, txn.currency);
      month.taxes += convertTrend(Number(txn.taxes) || 0, txn.currency);
      if (txn.type === "fee")
        month.fees += convertTrend(Number(txn.amount) || 0, txn.currency);
      month.fees += convertTrend(Number(txn.fees) || 0, txn.currency);
    }
  const table = getTaxTable(year);
  const cgtActive = table.capitalGainsTaxRate > 0;
  const split = computeRealizedGainSplit(
    summaries,
    convertFor("estimates.reyndersEstimate", "estimates.cgtEstimate"),
    cgtActive,
  );
  const dividend = computeDividendWht(
    summaries,
    year,
    table,
    convertFor("dividend"),
    filingStatus,
  );
  const estimates = {
    tobRecorded: computeTobRecorded(
      summaries,
      year,
      convertFor("estimates.tobRecorded"),
    ),
    tobAutoEstimate: computeTobAutoEstimate(
      summaries,
      year,
      table,
      convertFor("estimates.tobAutoEstimate"),
    ),
    tacrEstimate: computeTacrEstimate(
      summaries,
      table,
      convertFor("estimates.tacrEstimate"),
    ),
    reyndersEstimate: computeReyndersEstimate(split, table),
    cgtEstimate: computeCgtEstimate(split, table, filingStatus, cgtActive),
  };
  const convertRealizedGain = convertFor("investmentBreakdown");
  const rates = {
    securitiesAccountTaxRate: table.securitiesAccountTaxRate,
    capitalGainsTaxRate: table.capitalGainsTaxRate,
    reyndersTaxRate: table.reyndersTaxRate,
    dividendWHTRate: table.dividendWHTRate,
  };
  return {
    year,
    currency,
    isEmpty: summaries.length === 0,
    hasProfile,
    hasInKindIncomeUnclassified: summaries.some((inv) =>
      inv.transactions.some(
        (txn) =>
          txn.income_recognition_role === "included_in_units" &&
          txn.date?.startsWith(`${year}-`),
      ),
    ),
    totals: {
      totalTaxes,
      totalFees,
      totalTaxesAndFees: totalTaxes + totalFees,
      totalRecordedTaxes,
      totalRecordedFees,
      totalManualTaxes,
      totalManualFees,
      totalManualCosts: totalManualTaxes + totalManualFees,
      totalRealizedGain,
      totalUnrealizedGain,
      effectiveTaxRate:
        totalRealizedGain > 0 ? (totalTaxes / totalRealizedGain) * 100 : 0,
      totalPIT,
      portfolioTaxesPlusPIT: totalPIT + totalTaxes,
    },
    taxBreakdown: breakdowns.taxBreakdown.map(({ name, value }) => ({
      nameKey: name,
      value,
    })),
    feeBreakdown: breakdowns.feeBreakdown.map(({ name, value }) => ({
      nameKey: name,
      value,
    })),
    taxByAssetClass: Object.entries(byAsset)
      .map(([assetClass, { taxes, fees }]) => ({
        assetClass,
        taxes,
        fees,
        total: taxes + fees,
      }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total),
    investmentBreakdown: enriched
      .map((inv) => ({
        id: inv.id,
        name: inv.name,
        symbol: inv.symbol ?? null,
        assetClass: inv.assetClass,
        recordedTaxes: inv.recordedTaxes,
        recordedFees: inv.recordedFees,
        manualTaxes: inv.manualTaxes,
        manualFees: inv.manualFees,
        taxes: inv.taxes,
        fees: inv.fees,
        total: inv.total,
        realizedGain: convertRealizedGain(inv.realizedGain || 0, inv.currency),
        currency,
      }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total),
    yearlyCostTrend: Object.values(months).sort((a, b) =>
      a.period.localeCompare(b.period),
    ),
    dividend: {
      ...dividend,
      dividendExemption: table.dividendExemption,
    },
    estimates,
    taxTable: {
      ...rates,
      securitiesAccountTaxThreshold: table.securitiesAccountTaxThreshold,
      badgePercent: {
        securitiesAccountTaxRate: rates.securitiesAccountTaxRate * 100,
        capitalGainsTaxRate: rates.capitalGainsTaxRate * 100,
        reyndersTaxRate: rates.reyndersTaxRate * 100,
        dividendWHTRate: rates.dividendWHTRate * 100,
      },
    },
    summaries: summaries.map((inv) => ({
      id: inv.id,
      name: inv.name,
      symbol: inv.symbol ?? null,
      assetClass: inv.assetClass,
      currency: inv.currency ?? "EUR",
    })),
    unconvertedCurrencies: [...missing.currencies].sort(),
    incompleteFigures: [...missing.figures].sort(),
  };
}
