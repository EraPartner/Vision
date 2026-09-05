/**
 * Tax data fetcher for PDF report generation.
 *
 * Fetches portfolio transactions for a tax year, aggregates by type/asset-class/
 * investment, and threads through optional Belgian tax profile data from the client.
 */

import { query } from "../../database/connection.js";
import {
  convertWithRates,
  loadCurrentRates,
  getHistoricalRateIndex,
} from "../currency/currencyConversionService.js";
import { findRateOnOrBeforeInIndex } from "../currency/rateFetcher.js";
import { getTaxTable } from "./belgianTaxTables.js";
import { todayAppDateString, firstOfMonthYmd } from "../../lib/timezone.js";
import { logger } from "../../config/logger.js";
import { addAll, toNumber } from "../../lib/money.js";

/** @param {...(number|string)} values */
const addMoney = (...values) => toNumber(addAll(values));

/**
 * @typedef {{ kind: 'ytd' }
 *   | { kind: 'rolling'; months: number }
 *   | { kind: 'custom'; from: string; to: string }
 *   | { kind: 'year'; year: number }
 * } Period
 */

/**
 * Belgian PIT tax profile the frontend may attach to a tax-report request
 * (routes/reports.js `taxProfileSchema`) — every field optional, since the
 * client may omit any of them.
 * @typedef {{
 *   filingStatus?: string,
 *   region?: string,
 *   taxYear?: number,
 * }} TaxProfile
 */

/**
 * Precomputed Belgian PIT figures the frontend may attach to a tax-report
 * request (routes/reports.js `precomputedPITSchema`) — computed client-side
 * so the report doesn't have to re-derive the bracket math.
 * @typedef {{
 *   taxableIncome?: number,
 *   totalTax?: number,
 *   brackets?: Array<{
 *     label?: string,
 *     rate?: number,
 *     taxableIncome?: number,
 *     taxAmount?: number,
 *   }>,
 * }} PrecomputedPIT
 */

/**
 * `portfolio_transactions` JOINed to `investments`, as selected by
 * `fetchTaxTransactions` below. `amount`/`taxes`/`fees` are NUMERIC columns
 * COALESCE-defaulted to 0 — pg still emits NUMERIC as a string even through
 * COALESCE with a numeric literal, so they stay strings here (parsed via
 * `Number()`/`convert()` below), matching `PortfolioMathTxRow` in types/rows.js.
 * @typedef {{
 *   id: number,
 *   investment_id: number,
 *   investment_name: string,
 *   symbol: string|null,
 *   asset_class: string,
 *   type: string,
 *   dividend_amount_convention: 'gross'|'net'|'unknown',
 *   amount: string,
 *   taxes: string,
 *   fees: string,
 *   currency: string,
 *   rate_date: string,
 *   year: number,
 *   month: number,
 * }} TaxTxnRow
 */

/**
 * One month's tax/fee totals, keyed 'YYYY-MM' in `byMonth`. Carries the four
 * split tax components (no combined `taxes` field — renderers sum
 * `tob + wht + sell + other` themselves).
 * @typedef {{
 *   year: number, month: number,
 *   tob: number, wht: number, sell: number, other: number, fees: number,
 * }} TaxMonthBucket
 */

/**
 * Per-asset-class tax/fee subtotal. `byAssetClass` (below) is an ARRAY of
 * these — renderers iterate it directly and label rows with `.assetClass`.
 * @typedef {{ assetClass: string, taxes: number, fees: number }} TaxAssetClassBucket
 */

/**
 * Per-investment tax/fee subtotal. `total` is the full cost figure
 * (`tob + wht + sell + other + fees`).
 * @typedef {{
 *   investmentId: number, name: string, symbol: string|null, assetClass: string,
 *   tob: number, wht: number, sell: number, other: number, fees: number, total: number,
 * }} TaxInvestmentBucket
 */

/**
 * Aggregated result of {@link fetchTaxTransactions}.
 * @typedef {{
 *   tobTotal: number,
 *   dividendWHTTotal: number,
 *   sellTaxTotal: number,
 *   otherTaxTotal: number,
 *   feesTotal: number,
 *   dividendsReceived: number,
 *   grossDividendBase: number|null,
 *   netDividendResult: number|null,
 *   unknownDividendConventionCount: number,
 *   byMonth: TaxMonthBucket[],
 *   byAssetClass: TaxAssetClassBucket[],
 *   byInvestment: TaxInvestmentBucket[],
 *   unconvertedCurrencies: string[],
 * }} TaxTransactionAggregates
 */

/**
 * Result of {@link fetchTaxData} — the full data payload tax-report section
 * renderers consume. The tax totals (`tobTotal`, `dividendWHTTotal`, etc.)
 * live at the TOP level here, unwrapped from `fetchTaxTransactions`'s result —
 * there is no nested `totals` object.
 * @typedef {{
 *   taxYear: number,
 *   startDate: string,
 *   endDate: string,
 *   currency: string,
 *   period: Period,
 *   periodNote: string | null,
 *   taxTables: import('./belgianTaxTables.js').TaxYearTable & { approximated?: boolean, approximatedFrom?: number },
 *   taxProfile: TaxProfile | undefined,
 *   precomputedPIT: PrecomputedPIT | undefined,
 *   tobTotal: number,
 *   dividendWHTTotal: number,
 *   sellTaxTotal: number,
 *   otherTaxTotal: number,
 *   feesTotal: number,
 *   dividendsReceived: number,
 *   grossDividendBase: number|null,
 *   netDividendResult: number|null,
 *   unknownDividendConventionCount: number,
 *   byMonth: TaxMonthBucket[],
 *   byAssetClass: TaxAssetClassBucket[],
 *   byInvestment: TaxInvestmentBucket[],
 *   unconvertedCurrencies: string[],
 * }} TaxReportData
 */

/**
 * Unwrap a settled Promise result; log and return null on rejection.
 *
 * @template T
 * @param {PromiseSettledResult<T>} result
 * @param {string} label
 * @returns {T | null}
 */
function unwrap(result, label) {
  if (result.status === "fulfilled") return result.value;
  logger.warn(`[dataFetcherTax] ${label} failed — section will be skipped`, {
    reason: result.reason?.message,
  });
  return null;
}

/**
 * Normalise a Period into a tax context (year-scoped).
 *
 * @param {Period} period
 * @returns {{ taxYear: number; startDate: string; endDate: string; periodNote: string | null }}
 */
function periodToTaxContext(period) {
  // APP_TIMEZONE calendar day + pure string math (see periodToDateRange in
  // dataFetcherPortfolio.js — same day-shift class).
  const today = todayAppDateString();
  const currentYear = Number(today.slice(0, 4));

  switch (period.kind) {
    case "ytd":
      return {
        taxYear: currentYear,
        startDate: `${currentYear}-01-01`,
        endDate: today,
        periodNote: null,
      };

    case "year":
      return {
        taxYear: period.year,
        startDate: `${period.year}-01-01`,
        endDate: `${period.year}-12-31`,
        periodNote: null,
      };

    case "rolling": {
      // Use current year; add note that period may span two calendar years
      const startDate = firstOfMonthYmd(today, -(period.months - 1));
      const startYear = Number(startDate.slice(0, 4));
      const note =
        startYear !== currentYear
          ? `Rolling ${period.months}-month window spans ${startYear}–${currentYear}; brackets use ${currentYear} rates.`
          : null;
      return {
        taxYear: currentYear,
        startDate,
        endDate: today,
        periodNote: note,
      };
    }

    case "custom": {
      const fromYear = Number(String(period.from).slice(0, 4));
      const toYear = Number(String(period.to).slice(0, 4));
      const taxYear = fromYear;
      const note =
        fromYear !== toYear
          ? `Custom date range spans ${fromYear}–${toYear}; brackets use ${fromYear} rates.`
          : null;
      return {
        taxYear,
        startDate: period.from,
        endDate: period.to,
        periodNote: note,
      };
    }

    default:
      return {
        taxYear: currentYear,
        startDate: `${currentYear}-01-01`,
        endDate: `${currentYear}-12-31`,
        periodNote: null,
      };
  }
}

/**
 * Fetch and aggregate tax-related portfolio transactions for the given date range.
 *
 * @param {string} targetCurrency
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<TaxTransactionAggregates>}
 */
async function fetchTaxTransactions(targetCurrency, startDate, endDate) {
  const result = await /** @type {Promise<{ rows: TaxTxnRow[] }>} */ (
    query(
      `
    SELECT
      pt.id,
      pt.investment_id,
      i.name AS investment_name,
      i.symbol,
      i.asset_class,
      pt.type,
      pt.dividend_amount_convention,
      COALESCE(pt.amount, 0)  AS amount,
      COALESCE(pt.taxes,  0)  AS taxes,
      COALESCE(pt.fees,   0)  AS fees,
      COALESCE(pt.currency, i.currency, 'EUR') AS currency,
      to_char(pt.date::date, 'YYYY-MM-DD') AS rate_date,
      EXTRACT(YEAR  FROM pt.date::date)::int AS year,
      EXTRACT(MONTH FROM pt.date::date)::int AS month
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE pt.date::date BETWEEN $1 AND $2
      AND (pt.taxes > 0 OR pt.fees > 0 OR pt.type IN ('dividend', 'tax', 'fee'))
    ORDER BY pt.date
    LIMIT 100000
  `,
      [startDate, endDate],
    )
  );

  // Aggregation accumulators
  let tobTotal = 0;
  let dividendWHTTotal = 0;
  let sellTaxTotal = 0;
  let otherTaxTotal = 0;
  let feesTotal = 0;
  let dividendsReceived = 0;
  let grossDividendBase = 0;
  let netDividendResult = 0;
  let unknownDividendConventionCount = 0;

  /** @type {Map<string, TaxMonthBucket>} */
  const byMonthMap = new Map(); // key: 'YYYY-MM'
  /** @type {Map<string, TaxAssetClassBucket>} */
  const byAssetClass = new Map();
  /** @type {Map<number, TaxInvestmentBucket>} */
  const byInvestment = new Map();

  // Currencies for which no rate (historical or current) could be resolved, so a
  // row was summed into the target total at an unconverted 1:1 rate. Surfaced so
  // the PDF can annotate the figure as approximate instead of silently reporting
  // e.g. 1000 KRW as 1000 EUR. (ADR-085.)
  /** @type {Set<string>} */
  const missingRateCurrencies = new Set();

  // Belgian tax values foreign-currency income and transactions at the exchange rate
  // on the date the income was collected / the transaction took place — not today's
  // rate. The TOB (stock-exchange tax) guidance is explicit ("the ECB rate of the day
  // the transaction took place") and foreign movable income (dividends/interest) is
  // taxable at its date of collection. So each row converts at its transaction-date
  // rate, falling back to the current rate only when no historical rate is stored on or
  // before that date (e.g. a brand-new transaction before the FX backfill runs). See
  // ADR-085.
  const currentRates = await loadCurrentRates();
  const toCur = String(targetCurrency || "EUR")
    .toUpperCase()
    .trim();

  const relevantCurrencies = [
    ...new Set([
      ...result.rows.map((r) =>
        String(r.currency || "EUR")
          .toUpperCase()
          .trim(),
      ),
      toCur,
    ]),
  ].filter((c) => c && c !== "EUR");

  // Shared process-level index cache (see getHistoricalRateIndex) avoids
  // reloading the full exchange_rates history and rebuilding the index per call.
  let historicalIndex = new Map();
  if (relevantCurrencies.length > 0) {
    historicalIndex = await getHistoricalRateIndex(relevantCurrencies);
  }

  // Rate-to-EUR for a currency on a given date: the stored historical rate on or
  // before the date when available, else the current rate. EUR is always 1.
  /**
   * @param {string} code
   * @param {string} dateStr
   */
  const rateToEurForDate = (code, dateStr) => {
    const c = String(code || "EUR")
      .toUpperCase()
      .trim();
    if (c === "EUR") return 1;
    const historical = findRateOnOrBeforeInIndex(historicalIndex, c, dateStr);
    if (historical !== undefined) return historical;
    return currentRates[c];
  };

  for (const row of result.rows) {
    // Normalize the source currency ONCE so the skip-guard and the rowRates keys
    // can't disagree for mixed-case/whitespace currency strings.
    const cur = String(row.currency || "EUR")
      .toUpperCase()
      .trim();
    const rowDate = row.rate_date;
    // Per-row rate table built from the transaction-date rates, so convertWithRates
    // applies the same conversion math and unsupported-currency handling as the live
    // path — only the rate source (historical vs current) differs.
    const fromRate = rateToEurForDate(cur, rowDate);
    const rowRates = {
      EUR: 1,
      [cur]: fromRate,
      [toCur]: rateToEurForDate(toCur, rowDate),
    };
    // No rate resolved for a non-target foreign currency → convertWithRates will
    // sum it 1:1. Record it so the report can flag the total as approximate.
    if (
      cur !== toCur &&
      cur !== "EUR" &&
      (fromRate === undefined || fromRate === null)
    ) {
      missingRateCurrencies.add(cur);
    }
    /** @param {string} v */
    const convert = (v) =>
      cur !== toCur
        ? convertWithRates(Number(v), cur, toCur, rowRates)
        : Number(v);

    const taxes = convert(row.taxes);
    const fees = convert(row.fees);
    const amount = convert(row.amount);

    // Classify taxes by transaction type. Belgian TOB (beurstaks) is levied on
    // BOTH legs of an exchange transaction — "transfer and acquisition" are
    // each taxable (FOD Financiën) — so a sell's pt.taxes is TOB exactly like
    // a buy's. It was previously bucketed into sellTaxTotal and rendered as
    // "Capital Gains / Sell Tax": with Belgian CGT at 0% through 2025, a
    // nonzero line under that label was materially misleading (it was TOB all
    // along) and the TOB line under-reported by the whole sell side.
    let tobAmt = 0,
      whtAmt = 0,
      sellAmt = 0,
      otherAmt = 0;
    switch (row.type) {
      case "buy":
      case "sell":
        tobAmt = taxes;
        break;
      case "dividend":
        whtAmt = taxes;
        dividendsReceived = addMoney(dividendsReceived, amount);
        if (row.dividend_amount_convention === "gross") {
          grossDividendBase = addMoney(grossDividendBase, amount);
          netDividendResult = addMoney(netDividendResult, amount, -taxes);
        } else if (row.dividend_amount_convention === "net") {
          grossDividendBase = addMoney(grossDividendBase, amount, taxes);
          netDividendResult = addMoney(netDividendResult, amount);
        } else {
          unknownDividendConventionCount += 1;
        }
        break;
      case "tax":
        otherAmt = amount; // 'tax' type transactions record the tax amount itself
        break;
      default:
        otherAmt = taxes;
    }

    tobTotal = addMoney(tobTotal, tobAmt);
    dividendWHTTotal = addMoney(dividendWHTTotal, whtAmt);
    sellTaxTotal = addMoney(sellTaxTotal, sellAmt);
    otherTaxTotal = addMoney(otherTaxTotal, otherAmt);
    feesTotal = addMoney(feesTotal, fees);

    const monthKey = `${row.year}-${String(row.month).padStart(2, "0")}`;
    if (!byMonthMap.has(monthKey)) {
      byMonthMap.set(monthKey, {
        year: row.year,
        month: row.month,
        tob: 0,
        wht: 0,
        sell: 0,
        other: 0,
        fees: 0,
      });
    }
    const mo = byMonthMap.get(monthKey);
    mo.tob = addMoney(mo.tob, tobAmt);
    mo.wht = addMoney(mo.wht, whtAmt);
    mo.sell = addMoney(mo.sell, sellAmt);
    mo.other = addMoney(mo.other, otherAmt);
    mo.fees = addMoney(mo.fees, fees);

    const ac = row.asset_class ?? "other";
    if (!byAssetClass.has(ac))
      byAssetClass.set(ac, { assetClass: ac, taxes: 0, fees: 0 });
    const acBucket = byAssetClass.get(ac);
    acBucket.taxes = addMoney(
      acBucket.taxes,
      tobAmt,
      whtAmt,
      sellAmt,
      otherAmt,
    );
    acBucket.fees = addMoney(acBucket.fees, fees);

    const invId = row.investment_id;
    if (!byInvestment.has(invId)) {
      byInvestment.set(invId, {
        investmentId: invId,
        name: row.investment_name,
        symbol: row.symbol,
        assetClass: ac,
        tob: 0,
        wht: 0,
        sell: 0,
        other: 0,
        fees: 0,
        total: 0,
      });
    }
    const inv = byInvestment.get(invId);
    inv.tob = addMoney(inv.tob, tobAmt);
    inv.wht = addMoney(inv.wht, whtAmt);
    inv.sell = addMoney(inv.sell, sellAmt);
    inv.other = addMoney(inv.other, otherAmt);
    inv.fees = addMoney(inv.fees, fees);
    inv.total = addMoney(inv.total, tobAmt, whtAmt, sellAmt, otherAmt, fees);
  }

  return {
    tobTotal,
    dividendWHTTotal,
    sellTaxTotal,
    otherTaxTotal,
    feesTotal,
    dividendsReceived,
    grossDividendBase:
      unknownDividendConventionCount > 0 ? null : grossDividendBase,
    netDividendResult:
      unknownDividendConventionCount > 0 ? null : netDividendResult,
    unknownDividendConventionCount,
    byMonth: [...byMonthMap.values()].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    ),
    byAssetClass: [...byAssetClass.values()].sort((a, b) =>
      addAll([b.taxes, b.fees]).comparedTo(addAll([a.taxes, a.fees])),
    ),
    byInvestment: [...byInvestment.values()].sort((a, b) => b.total - a.total),
    // Foreign currencies that were summed at an unconverted 1:1 rate (no FX rate
    // available). Empty when every row converted cleanly.
    unconvertedCurrencies: [...missingRateCurrencies].sort(),
  };
}

/**
 * Fetch all data required for a tax PDF report.
 *
 * @param {string} currency  Target currency (e.g. "EUR")
 * @param {Period} period
 * @param {{ taxProfile?: TaxProfile; precomputedPIT?: PrecomputedPIT }} [extra]
 * @returns {Promise<TaxReportData>}
 */
export async function fetchTaxData(
  currency,
  period,
  { taxProfile, precomputedPIT } = {},
) {
  const { taxYear, startDate, endDate, periodNote } =
    periodToTaxContext(period);
  const taxTables = getTaxTable(taxYear);

  const [txnsResult] = await Promise.allSettled([
    fetchTaxTransactions(currency, startDate, endDate),
  ]);

  const txns = unwrap(txnsResult, "fetchTaxTransactions");

  return {
    taxYear,
    startDate,
    endDate,
    currency,
    period,
    periodNote,
    taxTables,
    taxProfile: taxProfile ?? undefined,
    precomputedPIT: precomputedPIT ?? undefined,
    tobTotal: txns?.tobTotal ?? 0,
    dividendWHTTotal: txns?.dividendWHTTotal ?? 0,
    sellTaxTotal: txns?.sellTaxTotal ?? 0,
    otherTaxTotal: txns?.otherTaxTotal ?? 0,
    feesTotal: txns?.feesTotal ?? 0,
    dividendsReceived: txns?.dividendsReceived ?? 0,
    grossDividendBase: txns?.grossDividendBase ?? null,
    netDividendResult: txns?.netDividendResult ?? null,
    unknownDividendConventionCount: txns?.unknownDividendConventionCount ?? 0,
    byMonth: txns?.byMonth ?? [],
    byAssetClass: txns?.byAssetClass ?? [],
    byInvestment: txns?.byInvestment ?? [],
    unconvertedCurrencies: txns?.unconvertedCurrencies ?? [],
  };
}
