/**
 * Snapshot Builder
 *
 * Walks days from first portfolio transaction to today, accumulates invested
 * capital and market values per asset class, applies inflation adjustment,
 * sanitizes spikes, and bulk-inserts the result into
 * portfolio_performance_snapshots.
 */

import { query, withTransaction } from "../../database/connection.ts";
import { checkRows, queryOne, queryRows } from "../../database/rowContracts.ts";
import {
  firstDataDateRowSchema,
  fxRateRowSchema,
  snapshotFxHistoryRowSchema,
  snapshotInflationRowSchema,
  snapshotNonUnitInvestmentRowSchema,
  snapshotPriceHistoryRowSchema,
  snapshotUnitInvestmentRowSchema,
} from "../../database/rows/portfolio.ts";
import type {
  FxRateDbRow,
  SnapshotFxHistoryDbRow,
  SnapshotInflationDbRow,
  SnapshotNonUnitInvestmentDbRow,
  SnapshotPriceHistoryDbRow,
  SnapshotUnitInvestmentDbRow,
} from "../../database/rows/portfolio.ts";
import { logger } from "../../config/logger.ts";
import { portfolioTransactionRepository } from "../../repositories/portfolioTransactionRepository.ts";
import {
  sanitizeSnapshotSpikes,
  calendarDaysBetween,
  toYmd,
} from "../calculations/portfolioMath.ts";
import { toDecimal, roundMoney } from "../../lib/money.ts";
import { epochMsToUtcYmd } from "../../lib/dateFormat.ts";
import { todayAppDateString } from "../../lib/timezone.ts";
import {
  areLotsFullyAssigned,
  projectAssetTransferPartitions,
} from "@vision/shared-utils/portfolio";
import type { ProjectedCustodyTxn } from "@vision/shared-utils/portfolio";
import type { DecimalInput } from "../../lib/money.ts";
import { asPartitionedTxns } from "./portfolioTransactionRules.ts";

export type Decimal = import("decimal.js").default;

/**
 * Unit-priced (stock/etf/crypto/metals) `investments` row, as narrowed by the
 * day walk's seed query. Derived from the checked row schema.
 */
export type UnitInvestmentRow = SnapshotUnitInvestmentDbRow;

/**
 * Non-unit (savings/bond/real_estate) `investments` row, as narrowed by the
 * day walk's seed query.
 */
export type NonUnitInvestmentRow = SnapshotNonUnitInvestmentDbRow;

export type PriceHistoryRow = SnapshotPriceHistoryDbRow;

export type InflationRateRow = SnapshotInflationDbRow;

export type FxLatestRow = FxRateDbRow;

export type FxHistoryRow = SnapshotFxHistoryDbRow;

/**
 * `investmentsById` value — a {@link UnitInvestmentRow} with numeric fields
 * parsed (`id`, `current_price` → `currentPrice`).
 */
export interface ParsedUnitInvestment {
  id: number;
  currency: string;
  currentPrice: number;
  assetClass: string;
}

/**
 * `nonUnitInvestments` entry — a {@link NonUnitInvestmentRow} with numeric
 * fields parsed and `active_from` re-sliced to a bare 'YYYY-MM-DD'.
 */
export interface ParsedNonUnitInvestment {
  id: number;
  currency: string;
  currentPrice: number;
  interestRate: number;
  assetClass: string;
  activeFrom: string;
}

/**
 * `fxNeutralState` value — cost-weighted purchase-date FX accumulator (see the
 * day walk's m̄ comment).
 */
export interface FxNeutralAccumulator {
  weight: Decimal;
  weightedRate: Decimal;
}

/**
 * `nonUnitState` value — running invested/appreciation for one non-unit
 * investment across the day walk.
 */
export interface NonUnitRunningState {
  runningInvested: Decimal;
  runningAppreciation: Decimal;
  /** 'YYYY-MM-DD' */
  lastInterestDate: string | null;
  /** 'YYYY-MM-DD' */
  firstBuyDate: string | null;
}

/**
 * One replayed transaction, coerced from {@link
 * import('../../types/rows.ts').PortfolioMathTxRow} for the day walk (numeric
 * amounts and units retained as Decimal, `fx_rate_to_eur` collapsed to
 * `undefined` when unset).
 */
export interface SnapshotTxEntry {
  investmentId: number;
  id: number;
  type: string;
  amount: Decimal;
  units: Decimal;
  accountId: number | null;
  sourceAccountId?: number | undefined;
  destinationAccountId?: number | undefined;
  feeUnits: Decimal;
  currency: string;
  fxRateToEur: number | undefined;
}

/**
 * One day's computed snapshot, as pushed by the day walk and (for `gain_loss` /
 * `return_pct` / `inflation_adjusted_value`) rewritten after
 * `sanitizeSnapshotSpikes`. Money/percentage fields are plain numbers —
 * `roundMoney` converts the running Decimal accumulators before they reach
 * this shape.
 */
export interface SnapshotRow {
  /** 'YYYY-MM-DD' */
  snapshot_date: string;
  invested: number;
  value: number;
  value_fx_neutral: number;
  stocks_etfs_value: number;
  crypto_value: number;
  metals_value: number;
  cash_value: number;
  stocks_etfs_invested: number;
  crypto_invested: number;
  metals_invested: number;
  cumulative_inflation: number;
  inflation_adjusted_value: number;
  /** Added by the post-sanitize pass. */
  gain_loss?: number;
  /** Added by the post-sanitize pass. */
  return_pct?: number;
}

const FIXED_INCOME_ASSET_CLASSES = new Set(["savings", "bond"]);
const REAL_ESTATE_ASSET_CLASS = "real_estate";
const NON_UNIT_ASSET_CLASSES = ["savings", "bond", "real_estate"];
const SNAPSHOT_SLEEVE_BY_ASSET_CLASS: Readonly<Record<string, string>> =
  Object.freeze({
    stock: "stocks_etfs",
    etf: "stocks_etfs",
    crypto: "crypto",
    metals: "metals",
  });
const SNAPSHOT_SLEEVES = ["stocks_etfs", "crypto", "metals"];

function createSleeveAccumulator(): Map<string, Decimal> {
  return new Map(SNAPSHOT_SLEEVES.map((sleeve) => [sleeve, toDecimal(0)]));
}

/** @param amount signed amount to add */
function addToSleeve(
  accumulator: Map<string, Decimal>,
  assetClass: string | undefined,
  amount: Decimal,
): void {
  const sleeve = SNAPSHOT_SLEEVE_BY_ASSET_CLASS[String(assetClass)];
  if (!sleeve) return;
  // Every sleeve is seeded by createSleeveAccumulator.
  accumulator.set(sleeve, accumulator.get(sleeve)!.plus(amount));
}

/** The part of `value` before the first "T" (`value.split("T")[0]`). */
function dayPart(value: string): string {
  const separator = value.indexOf("T");
  return separator === -1 ? value : value.slice(0, separator);
}

/**
 * Binary search of an ascending 'YYYY-MM-DD' list for the latest day on or
 * before `day`; "" when every day is later (or the list is empty).
 */
function latestDayOnOrBefore(days: readonly string[], day: string): string {
  let lo = 0;
  let hi = days.length - 1;
  let bestDay = "";
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = days[mid];
    // lo <= mid <= hi stay inside the list; the guard only narrows the type.
    if (candidate === undefined) break;
    if (candidate <= day) {
      bestDay = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return bestDay;
}

/** @returns the first data day (a pg DATE, local midnight) or null */
export async function getFirstDataDate(): Promise<Date | null> {
  const row = await queryOne(
    firstDataDateRowSchema,
    `
    SELECT MIN(first_date)::date AS first_data_date
    FROM (
      SELECT MIN(date)::date AS first_date
      FROM portfolio_transactions
      UNION ALL
      SELECT MIN(COALESCE(created_at::date, CURRENT_DATE))::date AS first_date
      FROM investments
      WHERE is_active = true
    ) seed
  `,
  );
  return row?.first_data_date ?? null;
}

/**
 * Build daily snapshots from first data date to today.
 * Pure data computation — no DB writes.
 */
export async function computeDailySnapshots(
  targetCurrency: string = "EUR",
): Promise<SnapshotRow[]> {
  const firstDataDate = await getFirstDataDate();
  if (!firstDataDate) {
    logger.info("No portfolio data available for snapshots");
    return [];
  }

  const firstDateYmd = toYmd(firstDataDate);

  // Upper bound for the walk AND the queries. Postgres CURRENT_DATE is the
  // DB-container day (UTC); between local midnight and 01:00/02:00 the walk
  // emitted today's snapshot while the queries excluded today's rows.
  const todayYmd = todayAppDateString();

  const [
    unitInvestmentRows,
    allTxRows,
    fixedIncomeRows,
    priceHistoryRows,
    inflationRows,
    fxResult,
    fxHistoryResult,
  ] = await Promise.all([
    queryRows(
      snapshotUnitInvestmentRowSchema,
      `
      SELECT i.id, COALESCE(i.currency, 'EUR') AS currency,
             COALESCE(i.current_price, 0) AS current_price, i.asset_class
      FROM investments i
      WHERE i.is_active = true
        AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
    `,
    ),
    portfolioTransactionRepository.getRowsForPortfolioMath({
      dateFrom: firstDateYmd,
      dateTo: todayYmd,
      sellsLastWithinDay: true,
    }),
    queryRows(
      snapshotNonUnitInvestmentRowSchema,
      `
      SELECT id, COALESCE(currency, 'EUR') AS currency,
             COALESCE(current_price, 0) AS current_price,
             COALESCE(interest_rate, 0) AS interest_rate,
             asset_class,
             COALESCE(created_at::date, $1::date)::text AS active_from
      FROM investments
      WHERE is_active = true
        AND asset_class::text = ANY($2::text[])
    `,
      [firstDateYmd, NON_UNIT_ASSET_CLASSES],
    ),
    queryRows(
      snapshotPriceHistoryRowSchema,
      `
      SELECT investment_id, to_char(price_date, 'YYYY-MM-DD') AS day, close_price
      FROM asset_price_history
      WHERE price_date >= $1::date AND price_date <= $2::date
      ORDER BY investment_id, price_date
    `,
      [firstDateYmd, todayYmd],
    ),
    queryRows(
      snapshotInflationRowSchema,
      `
      SELECT to_char(month_date, 'YYYY-MM') AS month, monthly_rate
      FROM belgian_inflation_rates
      WHERE month_date >= $1::date
      ORDER BY month_date
    `,
      [firstDateYmd],
    ),
    // A failed FX read degrades to "no rates" (the .catch), but a row that
    // breaks its contract must still surface, so the check runs after it.
    query(
      `SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true`,
    ).catch(() => ({ rows: [] as unknown[] })),
    // Historical FX so each day of the walk converts at the rate that applied
    // then, not today's. Sparse/empty is fine — convertAmount falls back to the
    // latest (is_latest) rate when no historical row precedes the day.
    query(
      `
      SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS day, rate_to_eur
      FROM exchange_rates
      WHERE rate_date >= $1::date
      ORDER BY currency_code, rate_date
    `,
      [firstDateYmd],
    ).catch(() => ({ rows: [] as unknown[] })),
  ]);
  const fxRows: FxLatestRow[] = checkRows(fxRateRowSchema, fxResult.rows);
  const fxHistoryRows: FxHistoryRow[] = checkRows(
    snapshotFxHistoryRowSchema,
    fxHistoryResult.rows,
  );

  // --- Build lookup maps ---

  const investmentsById = new Map(
    unitInvestmentRows.map((row): [number, ParsedUnitInvestment] => [
      Number(row.id),
      {
        id: Number(row.id),
        currency: row.currency,
        currentPrice: Number(row.current_price) || 0,
        assetClass: row.asset_class,
      },
    ]),
  );

  // Non-unit investments (savings/bond/real_estate). Valued from transactions —
  // current_price is kept as a last-resort fallback only when no buy transactions
  // exist for the asset, mirroring how the live summary handles such cases.
  const nonUnitInvestments = fixedIncomeRows.map(
    (row): ParsedNonUnitInvestment => ({
      id: Number(row.id),
      currency: row.currency,
      currentPrice: Number(row.current_price) || 0,
      interestRate: Number(row.interest_rate) || 0,
      assetClass: row.asset_class,
      activeFrom: dayPart(String(row.active_from)),
    }),
  );
  const nonUnitInvestmentsById = new Map(
    nonUnitInvestments.map((inv) => [inv.id, inv]),
  );

  // { investmentId: { day: price } }  +  sorted day arrays for binary-search forward-fill
  const priceHistoryByInvestment: Record<number, Record<string, number>> = {};
  const priceHistorySortedDays: Record<number, string[]> = {};
  for (const row of priceHistoryRows) {
    const invId = Number(row.investment_id);
    let byDay = priceHistoryByInvestment[invId];
    let days = priceHistorySortedDays[invId];
    if (!byDay || !days) {
      byDay = {};
      days = [];
      priceHistoryByInvestment[invId] = byDay;
      priceHistorySortedDays[invId] = days;
    }
    byDay[row.day] = Number(row.close_price) || 0;
    days.push(row.day);
  }
  // Rows arrive ORDER BY investment_id, price_date — sorted per investment.
  // Sort defensively so binary-search forward-fill is correct even if query order changes.
  for (const days of Object.values(priceHistorySortedDays)) {
    days.sort();
  }

  const inflationByMonth = new Map(
    inflationRows.map((row) => [row.month, Number(row.monthly_rate) || 0]),
  );

  const fxRates: Record<string, number> = { EUR: 1 };
  for (const row of fxRows) {
    fxRates[row.currency_code] = Number(row.rate_to_eur) || 1;
  }

  // Historical rate_to_eur per currency, with sorted day arrays for binary-search
  // nearest-on-or-before lookup (mirrors the price-history forward-fill above).
  // { CURRENCY: { day: rate } } + { CURRENCY: [day, ...] }
  const fxHistoryByCurrency: Record<string, Record<string, number>> = {};
  const fxHistorySortedDays: Record<string, string[]> = {};
  for (const row of fxHistoryRows) {
    const cur = row.currency_code;
    if (!cur) continue;
    const rate = Number(row.rate_to_eur) || 0;
    if (rate <= 0) continue;
    let byDay = fxHistoryByCurrency[cur];
    let days = fxHistorySortedDays[cur];
    if (!byDay || !days) {
      byDay = {};
      days = [];
      fxHistoryByCurrency[cur] = byDay;
      fxHistorySortedDays[cur] = days;
    }
    byDay[row.day] = rate;
    days.push(row.day);
  }
  for (const days of Object.values(fxHistorySortedDays)) {
    days.sort();
  }

  // { day: tx[] }
  // Histories without custody replay same-day acquisitions before sells, so
  // legacy oversells cannot leave phantom units after a later buy. Custody
  // histories retain the shared event-ID order required by the lot replay.
  const txByDay: Record<string, SnapshotTxEntry[]> = {};
  const custodyInvestments = new Set(
    allTxRows
      .filter((row) =>
        ["asset_transfer", "asset_adjustment"].includes(row.type),
      )
      .map((row) => Number(row.investment_id)),
  );
  for (const row of allTxRows) {
    (txByDay[row.day] ??= []).push({
      investmentId: Number(row.investment_id),
      id: Number(row.id ?? 0),
      type: row.type,
      amount: toDecimal(row.amount || 0),
      units: toDecimal(row.units || 0),
      accountId: row.account_id == null ? null : Number(row.account_id),
      sourceAccountId:
        row.source_account_id == null
          ? undefined
          : Number(row.source_account_id),
      destinationAccountId:
        row.destination_account_id == null
          ? undefined
          : Number(row.destination_account_id),
      feeUnits: toDecimal(row.fee_units || 0),
      currency: row.currency,
      fxRateToEur:
        row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined,
    });
  }
  // Custody events share trade IDs and must keep their original chronology.
  // Histories without custody retain sell-last replay for legacy oversells.
  for (const dayTxs of Object.values(txByDay)) {
    dayTxs.sort(
      (a, b) =>
        a.investmentId - b.investmentId ||
        (custodyInvestments.has(a.investmentId)
          ? a.id - b.id
          : (a.type === "sell" ? 1 : 0) - (b.type === "sell" ? 1 : 0)),
    );
  }

  const txnsByInvestment = new Map<
    number,
    { type: string; date: string; account_id: number | null }[]
  >();
  for (const rows of Object.values(txByDay)) {
    for (const tx of rows) {
      const bucket = txnsByInvestment.get(tx.investmentId);
      const assignmentRow = {
        type: tx.type,
        date: "",
        account_id: tx.accountId,
      };
      if (bucket) bucket.push(assignmentRow);
      else txnsByInvestment.set(tx.investmentId, [assignmentRow]);
    }
  }
  const fullyAssignedUnitInvestments = new Set(
    [...txnsByInvestment.entries()]
      .filter(
        ([investmentId, rows]) =>
          investmentsById.has(investmentId) && areLotsFullyAssigned(rows),
      )
      .map(([investmentId]) => investmentId),
  );
  const adjustmentLegs = new Map<string, ProjectedCustodyTxn>();
  for (const investmentId of custodyInvestments) {
    if (!fullyAssignedUnitInvestments.has(investmentId))
      throw new Error("Asset custody snapshot history is not fully assigned");
    const originalRows = allTxRows
      .filter((row) => Number(row.investment_id) === investmentId)
      .map((row) => ({
        ...row,
        date: row.day,
        fxMultiplier: convertAmount(
          1,
          row.currency,
          row.fx_rate_to_eur == null ? undefined : Number(row.fx_rate_to_eur),
          row.day,
        ).toFixed(),
      }));
    for (const legs of projectAssetTransferPartitions(
      asPartitionedTxns(originalRows),
    ).values())
      for (const leg of legs)
        if (["asset_fee", "unit_reversal"].includes(leg.type))
          adjustmentLegs.set(`${investmentId}:${Number(leg.id)}`, leg);
  }

  // --- Day walk helpers ---

  /**
   * rate_to_eur for `currency` as of `day`: the most recent historical rate on or
   * before `day`, falling back to the latest (is_latest) rate when no historical
   * row precedes it (or no history is loaded). The latest day always uses the
   * latest rate so the headline snapshot reconciles with /portfolio-summary.
   *
   * @param day YYYY-MM-DD
   */
  function rateToEurOnOrBefore(currency: string, day?: string): number {
    const cur = (currency || "EUR").toUpperCase();
    if (cur === "EUR") return 1;
    const latestRate = fxRates[cur];
    const latest = latestRate !== undefined && latestRate > 0 ? latestRate : 1;
    if (!day || day === todayYmd) return latest;

    const byDay = fxHistoryByCurrency[cur];
    if (byDay) {
      const exactRate = byDay[day];
      if (exactRate !== undefined && exactRate > 0) return exactRate;
      const bestDay = latestDayOnOrBefore(fxHistorySortedDays[cur] ?? [], day);
      const bestRate = bestDay ? byDay[bestDay] : undefined;
      if (bestRate !== undefined && bestRate > 0) return bestRate;
    }
    return latest;
  }

  /**
   * Convert `amount` from `fromCurrency` to the target currency as of `asOfDay`.
   * Prefers the rate stored on the transaction (`fxRateToEur`); otherwise uses the
   * historical rate that applied on `asOfDay` (not today's). For invested capital
   * pass the transaction date; for market value pass the day being valued.
   *
   * @param fxRateToEur rate stored at transaction time
   * @param asOfDay YYYY-MM-DD the conversion applies to
   * @returns converted amount as Decimal
   */
  function convertAmount(
    amount: DecimalInput,
    fromCurrency: string,
    fxRateToEur?: number,
    asOfDay?: string,
  ): Decimal {
    const from = (fromCurrency || "EUR").toUpperCase();
    const to = targetCurrency.toUpperCase();
    const amt = toDecimal(amount);
    if (from === to) return amt;
    const rateTo = to === "EUR" ? 1 : rateToEurOnOrBefore(to, asOfDay);
    const rateFrom =
      fxRateToEur !== undefined &&
      Number.isFinite(fxRateToEur) &&
      fxRateToEur > 0
        ? fxRateToEur
        : rateToEurOnOrBefore(from, asOfDay);
    return amt.times(rateFrom).div(rateTo);
  }

  // Fallback unit price (tx.amount / tx.units) expressed in the INVESTMENT's
  // currency. lastKnownPrice is consumed as a price in inv.currency (it's later
  // converted via convertAmount(units*price, inv.currency, …) and is overwritten
  // by price-history values that are in inv.currency). Storing tx.amount/tx.units
  // raw mixed the transaction's currency in when tx.currency != inv.currency.
  function txFallbackPrice(
    tx: SnapshotTxEntry,
    invCurrency: string | undefined,
    asOfDay: string,
  ): number {
    const from = (tx.currency || "EUR").toUpperCase();
    const to = (invCurrency || "EUR").toUpperCase();
    const perUnit = tx.amount.div(tx.units);
    if (from === to) return perUnit.toNumber();
    const rateFrom =
      tx.fxRateToEur !== undefined &&
      Number.isFinite(tx.fxRateToEur) &&
      tx.fxRateToEur > 0
        ? tx.fxRateToEur
        : rateToEurOnOrBefore(from, asOfDay);
    const rateTo = to === "EUR" ? 1 : rateToEurOnOrBefore(to, asOfDay);
    return toDecimal(perUnit).times(rateFrom).div(rateTo).toNumber();
  }

  function resolvePrice(
    inv: ParsedUnitInvestment,
    day: string,
    lastKnownPrice: Record<number, number>,
  ): number {
    const histPrices = priceHistoryByInvestment[inv.id];
    const lastKnown = lastKnownPrice[inv.id];
    const hasLastKnown = lastKnown !== undefined && lastKnown > 0;
    if (!histPrices) {
      return hasLastKnown ? lastKnown : inv.currentPrice;
    }
    const exactPrice = histPrices[day];
    if (exactPrice) return exactPrice;

    // Binary search for the latest price day <= `day`. Every sorted day is a
    // key of histPrices (both are filled from the same rows).
    const bestDay = latestDayOnOrBefore(
      priceHistorySortedDays[inv.id] ?? [],
      day,
    );
    const bestPrice = bestDay ? histPrices[bestDay] : undefined;
    if (bestPrice !== undefined) return bestPrice;
    if (hasLastKnown) return lastKnown;
    return inv.currentPrice;
  }

  // --- Main day loop ---

  // todayYmd (hoisted above the queries) ends the walk on the APP_TIMEZONE
  // calendar day, matching the query bounds (ADR-009).
  const allDays: string[] = [];
  const today = new Date(todayYmd);
  for (
    let d = new Date(firstDateYmd);
    d <= today;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    allDays.push(epochMsToUtcYmd(d.getTime()));
  }

  const unitsByInvestment: Record<number, Decimal> = {};
  const unitsByInvestmentPartition = new Map<
    number,
    Map<number | null | undefined, Decimal>
  >();
  // Cost-weighted average purchase-date FX multiplier per unit investment:
  // m̄ = Σ(buyAmount_i × m_i) / Σ(buyAmount_i), where m_i is the txn-date
  // conversion to the target currency. Valuing units×price at m̄ instead of
  // the day's rate yields the FX-neutral series — `value − value_fx_neutral`
  // is the cumulative currency effect on current holdings. Sells reduce both
  // sums proportionally (m̄ of the remaining position is unchanged).
  const fxNeutralState = new Map<
    number,
    Map<number | null | undefined, FxNeutralAccumulator>
  >();

  const partitionKey = (tx: SnapshotTxEntry) =>
    fullyAssignedUnitInvestments.has(tx.investmentId) ? tx.accountId : null;
  const partitionUnits = (investmentId: number) => {
    let partitions = unitsByInvestmentPartition.get(investmentId);
    if (!partitions) {
      partitions = new Map();
      unitsByInvestmentPartition.set(investmentId, partitions);
    }
    return partitions;
  };
  const refreshTotalUnits = (investmentId: number) => {
    unitsByInvestment[investmentId] = [
      ...partitionUnits(investmentId).values(),
    ].reduce((heldUnits, units) => heldUnits.plus(units), toDecimal(0));
  };
  const neutralPartitions = (investmentId: number) => {
    let partitions = fxNeutralState.get(investmentId);
    if (!partitions) {
      partitions = new Map();
      fxNeutralState.set(investmentId, partitions);
    }
    return partitions;
  };
  // Money accumulators stay Decimal — float drift compounds across a multi-year
  // day walk and is persisted into portfolio_performance_snapshots.
  let cumulativeInvested = toDecimal(0);
  const investedBySleeve = createSleeveAccumulator();
  let cumulativeInflation = toDecimal(1);
  let lastInflationMonth = "";
  const lastKnownPrice: Record<number, number> = {};
  const snapshots: SnapshotRow[] = [];

  // Per-investment running state for non-unit assets (mirrors live summary
  // formulas so the latest snapshot reconciles with /portfolio-summary).
  //   fixed-income (savings/bond): value = runningInvested + accruedInterest
  //   real-estate:                 value = runningInvested + runningAppreciation
  // runningInvested is kept in target currency, accumulated using per-txn FX
  // (same convention as cumulativeInvested above).
  const nonUnitState = new Map<number, NonUnitRunningState>();
  for (const inv of nonUnitInvestments) {
    nonUnitState.set(inv.id, {
      runningInvested: toDecimal(0),
      runningAppreciation: toDecimal(0),
      lastInterestDate: null,
      firstBuyDate: null,
    });
  }

  for (const day of allDays) {
    // Apply transactions. Invested capital converts at the rate on the
    // transaction's own day (or the stored fx_rate_to_eur), not today's.
    for (const tx of txByDay[day] || []) {
      const converted = convertAmount(
        tx.amount,
        tx.currency,
        tx.fxRateToEur,
        day,
      );
      const inv = investmentsById.get(tx.investmentId);
      const nonUnitInv = nonUnitInvestmentsById.get(tx.investmentId);
      const nonUnitS = nonUnitState.get(tx.investmentId);

      if (tx.type === "buy" || tx.type === "gift") {
        cumulativeInvested = cumulativeInvested.plus(converted);
        addToSleeve(investedBySleeve, inv?.assetClass, converted);
        const key = partitionKey(tx);
        const partitionState = partitionUnits(tx.investmentId);
        partitionState.set(
          key,
          (partitionState.get(key) ?? toDecimal(0)).plus(tx.units),
        );
        refreshTotalUnits(tx.investmentId);
        if (tx.units.gt(0) && tx.amount.gt(0))
          lastKnownPrice[tx.investmentId] = txFallbackPrice(
            tx,
            inv?.currency,
            day,
          );

        if (inv && tx.amount.gt(0)) {
          const states = neutralPartitions(tx.investmentId);
          const fxs = states.get(key) ?? {
            weight: toDecimal(0),
            weightedRate: toDecimal(0),
          };
          fxs.weight = fxs.weight.plus(tx.amount);
          fxs.weightedRate = fxs.weightedRate.plus(converted); // amount × m_i
          states.set(key, fxs);
        }

        if (nonUnitS) {
          // Live summary: fixed-income uses buy+gift; real_estate uses buy only.
          // nonUnitState is seeded from the same rows as nonUnitInvestmentsById.
          const includeForInvested =
            nonUnitInv!.assetClass !== REAL_ESTATE_ASSET_CLASS ||
            tx.type === "buy";
          if (includeForInvested)
            nonUnitS.runningInvested = nonUnitS.runningInvested.plus(converted);
          if (tx.type === "buy" && !nonUnitS.firstBuyDate)
            nonUnitS.firstBuyDate = day;
        }
      } else if (tx.type === "asset_transfer") {
        if (!fullyAssignedUnitInvestments.has(tx.investmentId))
          throw new Error(
            "Asset transfer snapshot history is not fully assigned",
          );
        const states = partitionUnits(tx.investmentId);
        const sourceUnits = states.get(tx.sourceAccountId) ?? toDecimal(0);
        if (tx.units.gt(sourceUnits))
          throw new Error(
            "Asset transfer exceeds source holdings during snapshot replay",
          );
        const received = tx.units.minus(tx.feeUnits);
        states.set(tx.sourceAccountId, sourceUnits.minus(tx.units));
        states.set(
          tx.destinationAccountId,
          (states.get(tx.destinationAccountId) ?? toDecimal(0)).plus(received),
        );
        const neutral = neutralPartitions(tx.investmentId);
        const source = neutral.get(tx.sourceAccountId);
        if (source && sourceUnits.gt(0)) {
          const grossRatio = tx.units.div(sourceUnits);
          const netRatio = received.div(tx.units);
          const movedWeight = source.weight.times(grossRatio);
          const movedRate = source.weightedRate.times(grossRatio);
          source.weight = source.weight.minus(movedWeight);
          source.weightedRate = source.weightedRate.minus(movedRate);
          const destination = neutral.get(tx.destinationAccountId) ?? {
            weight: toDecimal(0),
            weightedRate: toDecimal(0),
          };
          destination.weight = destination.weight.plus(
            movedWeight.times(netRatio),
          );
          destination.weightedRate = destination.weightedRate.plus(
            movedRate.times(netRatio),
          );
          neutral.set(tx.destinationAccountId, destination);
        }
        refreshTotalUnits(tx.investmentId);
      } else if (tx.type === "asset_adjustment") {
        const leg = adjustmentLegs.get(`${tx.investmentId}:${tx.id}`);
        if (!leg) throw new Error("Asset adjustment allocation is unavailable");
        const key = partitionKey(tx);
        const states = partitionUnits(tx.investmentId);
        const held = states.get(key) ?? toDecimal(0);
        if (tx.units.gt(held))
          throw new Error("Asset adjustment exceeds snapshot holdings");
        states.set(key, held.minus(tx.units));
        refreshTotalUnits(tx.investmentId);
        const neutral = neutralPartitions(tx.investmentId).get(key);
        if (neutral && leg.type === "asset_fee") {
          // Snapshot FX weights use principal, while canonical lot basis also
          // includes purchase fees/taxes. Remove each consumed original
          // principal at its original FX, without creating a capital flow.
          // Adjustment legs always carry the lots they consumed, and each lot
          // names an acquisition from this same replayed history.
          for (const lot of leg.consumedLots!) {
            const acquisition = allTxRows.find(
              (row) => Number(row.id) === Number(lot.acquisitionId),
            )!;
            const originalCost = toDecimal(acquisition.amount || 0)
              .plus(acquisition.fees || 0)
              .plus(acquisition.taxes || 0);
            const principalRatio = originalCost.gt(0)
              ? toDecimal(acquisition.amount || 0).div(originalCost)
              : toDecimal(0);
            neutral.weight = neutral.weight.minus(
              lot.costBasis.times(principalRatio),
            );
            neutral.weightedRate = neutral.weightedRate.minus(
              lot.costBasisConv.times(principalRatio),
            );
          }
        }
      } else if (tx.type === "sell") {
        // Clamp oversells to held units (mirrors calculateCostBasis's
        // min(units, totalUnits)) so a later buy isn't offset by a negative.
        // The live calculators also scale proceeds by consumed/requested units;
        // apply that ratio to invested cash flow so snapshot gain stays aligned.
        const key = partitionKey(tx);
        const partitionState = partitionUnits(tx.investmentId);
        const heldUnits = partitionState.get(key) ?? toDecimal(0);
        const consumedUnits = heldUnits.lte(tx.units) ? heldUnits : tx.units;
        const effectiveConverted =
          inv && tx.units.gt(0)
            ? converted.times(consumedUnits.div(tx.units))
            : converted;
        cumulativeInvested = cumulativeInvested.minus(effectiveConverted);
        addToSleeve(
          investedBySleeve,
          inv?.assetClass,
          effectiveConverted.negated(),
        );
        partitionState.set(key, heldUnits.minus(consumedUnits));
        refreshTotalUnits(tx.investmentId);
        if (tx.units.gt(0) && tx.amount.gt(0))
          lastKnownPrice[tx.investmentId] = txFallbackPrice(
            tx,
            inv?.currency,
            day,
          );

        const fxs = fxNeutralState.get(tx.investmentId)?.get(key);
        if (fxs && heldUnits.gt(0) && tx.units.gt(0)) {
          const factor = heldUnits.minus(consumedUnits).div(heldUnits);
          fxs.weight = fxs.weight.times(factor);
          fxs.weightedRate = fxs.weightedRate.times(factor);
        }

        if (nonUnitS)
          nonUnitS.runningInvested = nonUnitS.runningInvested.minus(converted);
      } else if (tx.type === "split") {
        // units = new total post-split; invested/cost basis is unchanged
        // (mirrors calculateCostBasis). Only applies once units are held.
        const heldUnits = unitsByInvestment[tx.investmentId] ?? toDecimal(0);
        if (heldUnits.gt(0) && tx.units.gt(0)) {
          const partitions = partitionUnits(tx.investmentId);
          const entries = [...partitions.entries()].filter(([, units]) =>
            units.gt(0),
          );
          let allocated = toDecimal(0);
          entries.forEach(([key, units], index) => {
            const nextUnits =
              index === entries.length - 1
                ? tx.units.minus(allocated)
                : units.div(heldUnits).times(tx.units);
            allocated = allocated.plus(nextUnits);
            partitions.set(key, nextUnits);
          });
          refreshTotalUnits(tx.investmentId);
        }
      } else if (tx.type === "return_of_capital") {
        // Returns capital, reducing net invested (mirrors calculateCostBasis
        // reducing cost basis). Units are unchanged.
        const heldUnits = unitsByInvestment[tx.investmentId] ?? toDecimal(0);
        if (heldUnits.gt(0)) {
          cumulativeInvested = cumulativeInvested.minus(converted);
          addToSleeve(investedBySleeve, inv?.assetClass, converted.negated());
        } else if (nonUnitS) {
          // Non-unit classes (savings/bond/real_estate) hold no units, so the
          // heldUnits gate never fires. Mirror the sell branch: reduce net
          // invested, so invested/value stop being overstated forever after a
          // return of capital.
          cumulativeInvested = cumulativeInvested.minus(converted);
          nonUnitS.runningInvested = nonUnitS.runningInvested.minus(converted);
        }
      } else if (tx.type === "interest" && nonUnitS) {
        // Resets the accrual clock to match calculateAccruedInterest.
        nonUnitS.lastInterestDate = day;
      } else if (tx.type === "appreciation" && nonUnitS) {
        nonUnitS.runningAppreciation =
          nonUnitS.runningAppreciation.plus(converted);
      }
      // income / dividends / fees / taxes: don't alter invested capital
    }

    // Compute portfolio value
    let totalValue = toDecimal(0);
    let totalValueFxNeutral = toDecimal(0);
    const valueBySleeve = createSleeveAccumulator();

    const isLatestDay = day === todayYmd;

    for (const inv of investmentsById.values()) {
      const units = unitsByInvestment[inv.id] ?? toDecimal(0);
      if (units.lte(0)) continue;

      // Latest day: use the live current_price so the headline snapshot value
      // always reconciles with /portfolio-summary, even if asset_price_history
      // lags behind a price refresh that updated investments.current_price.
      const price =
        isLatestDay && inv.currentPrice > 0
          ? inv.currentPrice
          : resolvePrice(inv, day, lastKnownPrice);
      if (price <= 0) continue;

      // Forward-fill last known price
      const dayPrice = priceHistoryByInvestment[inv.id]?.[day];
      if (dayPrice !== undefined && dayPrice > 0) {
        lastKnownPrice[inv.id] = dayPrice;
      }

      // Market value converts at the rate on the day being valued (latest day
      // uses the latest rate, so the headline value still reconciles).
      const invValueNative = toDecimal(units).times(price);
      const invValue = convertAmount(
        invValueNative,
        inv.currency,
        undefined,
        day,
      );
      totalValue = totalValue.plus(invValue);
      addToSleeve(valueBySleeve, inv.assetClass, invValue);

      // FX-neutral: value the position at its cost-weighted purchase-date
      // rate. Positions with no recorded buy amounts (e.g. price-only seeds)
      // have no purchase rate to lock — they contribute at the day's rate.
      const fxs = fxNeutralState.get(inv.id);
      let invValueNeutral = toDecimal(0);
      if (fxs) {
        const heldPartitions = partitionUnits(inv.id);
        for (const [key, held] of heldPartitions) {
          if (held.lte(0)) continue;
          const state = fxs.get(key);
          const nativePartValue = toDecimal(held).times(price);
          invValueNeutral = invValueNeutral.plus(
            state?.weight.gt(0)
              ? nativePartValue.times(state.weightedRate).div(state.weight)
              : convertAmount(nativePartValue, inv.currency, undefined, day),
          );
        }
      } else {
        invValueNeutral = invValue;
      }
      totalValueFxNeutral = totalValueFxNeutral.plus(invValueNeutral);
    }

    // Non-unit assets — value mirrors live summary formulas exactly.
    let fixedIncomeValue = toDecimal(0);
    for (const inv of nonUnitInvestments) {
      // Seeded for every non-unit investment before the walk.
      const state = nonUnitState.get(inv.id)!;
      const isFixedIncome = FIXED_INCOME_ASSET_CLASSES.has(inv.assetClass);
      const isRealEstate = inv.assetClass === REAL_ESTATE_ASSET_CLASS;

      let invValue;
      if (isFixedIncome) {
        // accruedInterest = principal × dailyRate × days(startDate → day)
        let accrued = toDecimal(0);
        if (inv.interestRate > 0 && state.runningInvested.gt(0)) {
          const startDate = state.lastInterestDate || state.firstBuyDate;
          if (startDate) {
            const days = Math.max(0, calendarDaysBetween(startDate, day));
            const dailyRate = toDecimal(inv.interestRate).div(100).div(365);
            accrued = state.runningInvested.times(dailyRate).times(days);
          }
        }
        invValue = state.runningInvested.plus(accrued);
      } else if (isRealEstate) {
        invValue = state.runningInvested.plus(state.runningAppreciation);
      } else {
        invValue = state.runningInvested;
      }

      // Fallback: investments with no transactions yet — preserve legacy behaviour
      // of showing current_price from active_from so we don't regress users who
      // entered a current_price without seed transactions.
      if (invValue.lte(0) && day >= inv.activeFrom && inv.currentPrice > 0) {
        invValue = convertAmount(
          inv.currentPrice,
          inv.currency,
          undefined,
          day,
        );
      }

      if (invValue.gt(0)) {
        fixedIncomeValue = fixedIncomeValue.plus(invValue);
      }
    }
    totalValue = totalValue.plus(fixedIncomeValue);
    // Non-unit values accumulate invested capital at txn-date rates already,
    // so they are FX-neutral by construction — add them unchanged.
    totalValueFxNeutral = totalValueFxNeutral.plus(fixedIncomeValue);

    // Inflation compounding (once per calendar month)
    const monthKey = day.slice(0, 7);
    if (monthKey !== lastInflationMonth) {
      cumulativeInflation = cumulativeInflation.times(
        toDecimal(1).plus(inflationByMonth.get(monthKey) ?? 0),
      );
      lastInflationMonth = monthKey;
    }

    snapshots.push({
      snapshot_date: day,
      invested: roundMoney(cumulativeInvested),
      value: roundMoney(totalValue),
      value_fx_neutral: roundMoney(totalValueFxNeutral),
      stocks_etfs_value: roundMoney(valueBySleeve.get("stocks_etfs")),
      crypto_value: roundMoney(valueBySleeve.get("crypto")),
      metals_value: roundMoney(valueBySleeve.get("metals")),
      cash_value: roundMoney(fixedIncomeValue),
      stocks_etfs_invested: roundMoney(investedBySleeve.get("stocks_etfs")),
      crypto_invested: roundMoney(investedBySleeve.get("crypto")),
      metals_invested: roundMoney(investedBySleeve.get("metals")),
      cumulative_inflation: roundMoney(
        cumulativeInflation.minus(1).times(100),
        2,
      ),
      inflation_adjusted_value: cumulativeInflation.gt(0)
        ? roundMoney(totalValue.div(cumulativeInflation))
        : roundMoney(totalValue),
    });
  }

  // Sanitize spike noise from raw price feeds
  const sanitized: SnapshotRow[] = sanitizeSnapshotSpikes(snapshots);

  // Compute gain/loss fields after sanitization
  for (const snap of sanitized) {
    snap.gain_loss = snap.value - snap.invested;
    snap.return_pct =
      snap.invested > 0
        ? ((snap.value - snap.invested) / snap.invested) * 100
        : 0;
    snap.inflation_adjusted_value =
      snap.value / (1 + snap.cumulative_inflation / 100) || snap.value;
  }

  return sanitized;
}

const BATCH_SIZE = 500;

/**
 * Whether the snapshots table has the value_fx_neutral column (migration 0039).
 * Migrations are user-applied, so the writer degrades gracefully on databases
 * that haven't run it yet — the FX-neutral series is simply not persisted.
 */
async function hasFxNeutralColumn(): Promise<boolean> {
  const result = await query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'portfolio_performance_snapshots'
      AND column_name = 'value_fx_neutral'
    LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * Recompute all daily snapshots and persist to portfolio_performance_snapshots.
 *
 * @returns Stored snapshots
 */
export async function computeAndStoreSnapshots(
  targetCurrency: string = "EUR",
): Promise<SnapshotRow[]> {
  logger.info("Computing portfolio performance snapshots...");

  const snapshots = await computeDailySnapshots(targetCurrency);
  if (snapshots.length === 0) {
    logger.info("No snapshots to store");
    return [];
  }

  const includeFxNeutral = await hasFxNeutralColumn();
  if (!includeFxNeutral) {
    logger.warn(
      "portfolio_performance_snapshots.value_fx_neutral missing — apply migration 0039 to store the FX-neutral series",
    );
  }

  const columns = [
    "snapshot_date",
    "invested",
    "value",
    "stocks_etfs_value",
    "crypto_value",
    "metals_value",
    "cash_value",
    "gain_loss",
    "return_pct",
    "currency",
    "inflation_adjusted_value",
    "stocks_etfs_invested",
    "crypto_invested",
    "metals_invested",
    ...(includeFxNeutral ? ["value_fx_neutral"] : []),
  ];
  const snapParams = (snap: SnapshotRow) => [
    snap.snapshot_date,
    snap.invested,
    snap.value,
    snap.stocks_etfs_value,
    snap.crypto_value,
    snap.metals_value,
    snap.cash_value,
    snap.gain_loss,
    snap.return_pct,
    targetCurrency,
    snap.inflation_adjusted_value,
    snap.stocks_etfs_invested,
    snap.crypto_invested,
    snap.metals_invested,
    ...(includeFxNeutral ? [snap.value_fx_neutral] : []),
  ];
  const updateSet = columns
    .filter((c) => c !== "snapshot_date" && c !== "currency")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat("computed_at = NOW()")
    .join(", ");

  // Atomic replace: DELETE + INSERTs in one transaction so concurrent readers
  // (e.g. /api/info/net-worth during startup warmup) see either fully-old or
  // fully-new state via Postgres MVCC — never an empty/partial table.
  await withTransaction(async (client) => {
    await client.query(
      "DELETE FROM portfolio_performance_snapshots WHERE currency = $1",
      [targetCurrency],
    );

    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
      const batch = snapshots.slice(i, i + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      for (const snap of batch) {
        values.push(`(${columns.map(() => `$${p++}`).join(",")},NOW())`);
        params.push(...snapParams(snap));
      }

      await client.query(
        `
        INSERT INTO portfolio_performance_snapshots (${columns.join(", ")}, computed_at)
        VALUES ${values.join(", ")}
        ON CONFLICT (snapshot_date, currency) DO UPDATE SET ${updateSet}
      `,
        params,
      );
    }
  });

  logger.info("Portfolio performance snapshots stored", {
    count: snapshots.length,
  });
  return snapshots;
}
