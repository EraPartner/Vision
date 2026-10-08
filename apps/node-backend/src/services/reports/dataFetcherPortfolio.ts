/**
 * Portfolio data fetcher for PDF report generation.
 *
 * Fetches all data sources in parallel using Promise.allSettled so a single
 * failing source does not abort the entire report. Each source returns null
 * on failure; section renderers handle null gracefully.
 */

import { query } from "../../database/connection.ts";
import {
  getSnapshots,
  getBreakdownSummary,
} from "../portfolioPerformanceSnapshotService.js";
import {
  convertWithRates,
  loadCurrentRates,
  getHistoricalRateIndex,
} from "../currency/currencyConversionService.ts";
import { todayAppDateString, firstOfMonthYmd } from "../../lib/timezone.ts";
import { logger } from "../../config/logger.ts";
import { findRateOnOrBeforeInIndex } from "../currency/rateFetcher.ts";
import { addAll, toNumber } from "../../lib/money.ts";

export type Period = { kind: 'ytd' }
  | { kind: 'rolling'; months: number }
  | { kind: 'custom'; from: string; to: string }
  | { kind: 'year'; year: number };

/** A row of `getSnapshots`' resolved array (portfolioPerformanceSnapshotService.js). */
export type SnapshotRow = Awaited<ReturnType<typeof getSnapshots>>[number];

/**
 * A row of `getBreakdownSummary`'s resolved array
 * (services/portfolio/portfolioSummaryService.js, re-exported here).
 *
 * Compatibility aliases are normalized once at the fetch boundary so section
 * renderers consume one camelCase shape.
 */
export type BreakdownRow = Awaited<ReturnType<typeof getBreakdownSummary>>[number];

export type DividendMonthRow = { year: number; month: number; amount: number };

export type DividendInvestmentRow = {
  investmentId: number; name: string; symbol: string | null; assetClass: string;
  total: number;
};

export type DividendData = { byMonth: DividendMonthRow[]; byInvestment: DividendInvestmentRow[]; totalInKindIncome: number; inKindIncomeCount: number };

export type PerformanceTrendPoint = {
  year: number; month: number; value: number; invested: number;
  inflationAdjustedValue: number; gainLoss: number; returnPct: number;
};

export type PerformanceTrendData = {
  points: PerformanceTrendPoint[];
  tablePoints: PerformanceTrendPoint[];
};

export type PortfolioExecutiveSummaryData = {
  totalValue: number;
  totalInvested: number;
  totalGainLoss: number;
  returnPct: number;
  inflationAdjustedValue: number;
  totalDividends: number;
  totalInKindIncome: number;
  inKindIncomeCount: number;
  holdingsCount: number;
  topHoldings: BreakdownRow[];
};

/**
 * Full result of {@link fetchPortfolioData} — the data payload portfolio
 * report section renderers consume.
 */
export type PortfolioReportData = {
  snapshots: SnapshotRow[] | null;
  breakdown: BreakdownRow[] | null;
  dividends: DividendData | null;
  performanceTrend: PerformanceTrendData | null;
  executiveSummary: PortfolioExecutiveSummaryData | null;
  period: Period;
  currency: string;
};

/**
 * One dividend row of {@link fetchDividends}' query. `amount` is NUMERIC, so pg
 * emits it as a string.
 */
type DividendTxRow = {
  investment_id: number;
  investment_name: string;
  symbol: string | null;
  asset_class: string;
  year: number;
  month: number;
  amount: string;
  currency: string;
  income_recognition_role: string | null;
  rate_date: string;
};

/** Unwrap a settled Promise result; log and return null on rejection. */
function unwrap<T>(result: PromiseSettledResult<T>, label: string): T | null {
  if (result.status === "fulfilled") return result.value;
  logger.warn(
    `[dataFetcherPortfolio] ${label} failed — section will be skipped`,
    { reason: result.reason?.message },
  );
  return null;
}

/** Normalize a portfolio breakdown row at the report boundary. */
function normalizeBreakdownRow(row: BreakdownRow): BreakdownRow {
  return {
    ...row,
    assetClass: row.assetClass ?? "other",
    currentValue: row.currentValue ?? 0,
    totalInvested: row.totalInvested ?? 0,
    gainLoss: row.gainLoss ?? 0,
    gainLossPercent: row.gainLossPercent ?? 0,
  };
}

/** Build the monthly chart and table model once at the data boundary. */
function buildPerformanceTrendData(
  snapshots: SnapshotRow[] | null,
): PerformanceTrendData | null {
  if (!snapshots?.length) return null;

  const byMonth = new Map<string, SnapshotRow>();
  for (const snapshot of snapshots) {
    const date = new Date(snapshot.snapshot_date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    byMonth.set(key, snapshot);
  }

  const points = [...byMonth.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, snapshot]) => {
      const date = new Date(snapshot.snapshot_date);
      const value = Number(snapshot.value ?? 0);
      const invested = Number(snapshot.invested ?? 0);
      return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        value,
        invested,
        inflationAdjustedValue: Number(
          snapshot.inflation_adjusted_value ?? value,
        ),
        gainLoss: value - invested,
        returnPct: Number(snapshot.return_pct ?? 0),
      };
    });

  return { points, tablePoints: points.slice(-12) };
}

/** Build the KPI and top-holdings model once at the data boundary. */
function buildPortfolioExecutiveSummaryData(
  breakdown: BreakdownRow[] | null,
  snapshots: SnapshotRow[] | null,
  dividends: DividendData | null,
): PortfolioExecutiveSummaryData | null {
  if (!breakdown?.length && !snapshots?.length) return null;

  const totalValue = toNumber(
    addAll((breakdown ?? []).map((investment) => investment.currentValue ?? 0)),
  );
  const totalInvested = toNumber(
    addAll(
      (breakdown ?? []).map((investment) => investment.totalInvested ?? 0),
    ),
  );
  const totalGainLoss = toNumber(
    addAll((breakdown ?? []).map((investment) => investment.gainLoss ?? 0)),
  );

  const latest = snapshots?.length ? snapshots[snapshots.length - 1] : null;
  const returnPct = latest
    ? Number(latest.return_pct ?? 0)
    : totalInvested > 0
      ? (totalGainLoss / totalInvested) * 100
      : 0;

  return {
    totalValue,
    totalInvested,
    totalGainLoss,
    returnPct,
    inflationAdjustedValue: latest
      ? Number(latest.inflation_adjusted_value ?? totalValue)
      : totalValue,
    totalDividends: toNumber(
      addAll((dividends?.byMonth ?? []).map((month) => month.amount ?? 0)),
    ),
    totalInKindIncome: dividends?.totalInKindIncome ?? 0,
    inKindIncomeCount: dividends?.inKindIncomeCount ?? 0,
    holdingsCount: breakdown?.length ?? 0,
    topHoldings: [...(breakdown ?? [])]
      .sort(
        (left, right) =>
          Number(right.currentValue ?? 0) - Number(left.currentValue ?? 0),
      )
      .slice(0, 5),
  };
}

/** Convert a Period to a concrete { startDate, endDate } range (ISO date strings). */
export function periodToDateRange(period: Period): { startDate: string; endDate: string } {
  // All boundaries derive from the APP_TIMEZONE calendar day via pure string
  // math — local-Date + toISOString() shifted rolling starts to the last day
  // of the previous month in UTC+ zones.
  const today = todayAppDateString();
  const year = Number(today.slice(0, 4));

  switch (period.kind) {
    case "ytd":
      return { startDate: `${year}-01-01`, endDate: today };
    case "rolling":
      return {
        startDate: firstOfMonthYmd(today, -(period.months - 1)),
        endDate: today,
      };
    case "custom":
      return { startDate: period.from, endDate: period.to };
    case "year":
      return {
        startDate: `${period.year}-01-01`,
        endDate: `${period.year}-12-31`,
      };
    default:
      return { startDate: `${year - 1}-01-01`, endDate: today };
  }
}

/**
 * Fetch dividend transactions grouped by month and by investment, converted
 * to the target currency.
 */
async function fetchDividends(
  targetCurrency: string,
  startDate: string,
  endDate: string,
): Promise<DividendData> {
  const result = await query<DividendTxRow>(
    `
    SELECT
      pt.investment_id,
      i.name AS investment_name,
      i.symbol,
      i.asset_class,
      EXTRACT(YEAR  FROM pt.date::date)::int AS year,
      EXTRACT(MONTH FROM pt.date::date)::int AS month,
      COALESCE(pt.amount, 0) AS amount,
      COALESCE(pt.currency, i.currency, 'EUR') AS currency, pt.income_recognition_role,
      to_char(pt.date,'YYYY-MM-DD') AS rate_date
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE pt.type = 'dividend'
      AND pt.date::date BETWEEN $1 AND $2
    ORDER BY year, month
    LIMIT 100000
  `,
    [startDate, endDate],
  );

  // Convert each row and aggregate
  const byMonthMap = new Map<string, number>();
  const byInvestmentMap = new Map<number, DividendInvestmentRow>();
  const rates = await loadCurrentRates();
  const inKind = result.rows.filter(
    (row) => row.income_recognition_role === "included_in_units",
  );
  const currencies = [
    ...new Set([
      ...inKind.map((row) => row.currency),
      targetCurrency,
    ]),
  ].filter((code) => code !== "EUR");
  const historicalIndex =
    inKind.length && currencies.length
      ? await getHistoricalRateIndex(currencies)
      : new Map();
  let totalInKindIncome = addAll([]);
  for (const row of result.rows) {
    if (row.income_recognition_role === "included_in_units") {
      const dateRates: Record<string, number> = { EUR: 1 };
      for (const code of currencies)
        dateRates[code] =
          findRateOnOrBeforeInIndex(historicalIndex, code, row.rate_date) ??
          rates[code];
      totalInKindIncome = addAll([
        totalInKindIncome,
        convertWithRates(
          Number(row.amount),
          row.currency,
          targetCurrency,
          dateRates,
        ),
      ]);
      continue;
    }
    const converted =
      row.currency !== targetCurrency
        ? convertWithRates(
            Number(row.amount),
            row.currency,
            targetCurrency,
            rates,
          )
        : Number(row.amount);

    const monthKey = `${row.year}-${String(row.month).padStart(2, "0")}`;
    byMonthMap.set(monthKey, (byMonthMap.get(monthKey) ?? 0) + converted);

    const invKey = row.investment_id;
    let invEntry = byInvestmentMap.get(invKey);
    if (!invEntry) {
      invEntry = {
        investmentId: invKey,
        name: row.investment_name,
        symbol: row.symbol,
        assetClass: row.asset_class,
        total: 0,
      };
      byInvestmentMap.set(invKey, invEntry);
    }
    invEntry.total += converted;
  }

  const byMonth = [...byMonthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, amount]) => {
      const [yr, mo] = key.split("-").map(Number);
      return { year: yr, month: mo, amount };
    });

  const byInvestment = [...byInvestmentMap.values()].sort(
    (a, b) => b.total - a.total,
  );

  return {
    byMonth,
    byInvestment,
    totalInKindIncome: toNumber(totalInKindIncome),
    inKindIncomeCount: inKind.length,
  };
}

/**
 * Fetch all data required for a portfolio PDF report in parallel.
 *
 * @param currency  Target currency (e.g. "EUR")
 */
export async function fetchPortfolioData(
  currency: string,
  period: Period,
): Promise<PortfolioReportData> {
  const { startDate, endDate } = periodToDateRange(period);

  const [snapshotsResult, breakdownResult, dividendsResult] =
    await Promise.allSettled([
      getSnapshots(startDate, endDate, currency),
      getBreakdownSummary(currency),
      fetchDividends(currency, startDate, endDate),
    ]);

  const snapshots = unwrap(snapshotsResult, "getSnapshots");
  const rawBreakdown = unwrap(breakdownResult, "getBreakdownSummary");
  const breakdown = rawBreakdown?.map(normalizeBreakdownRow) ?? rawBreakdown;
  const dividends = unwrap(dividendsResult, "fetchDividends");

  return {
    snapshots,
    breakdown,
    dividends,
    performanceTrend: buildPerformanceTrendData(snapshots),
    executiveSummary: buildPortfolioExecutiveSummaryData(
      breakdown,
      snapshots,
      dividends,
    ),
    period,
    currency,
  };
}

export {
  normalizeBreakdownRow as __normalizeBreakdownRow,
  buildPerformanceTrendData as __buildPerformanceTrendData,
  buildPortfolioExecutiveSummaryData as __buildPortfolioExecutiveSummaryData,
};
