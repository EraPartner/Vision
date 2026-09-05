/**
 * Snapshot Builder
 *
 * Walks days from first portfolio transaction to today, accumulates invested
 * capital and market values per asset class, applies inflation adjustment,
 * sanitizes spikes, and bulk-inserts the result into
 * portfolio_performance_snapshots.
 */

import { query, withTransaction } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import { portfolioTransactionRepository } from "../../repositories/portfolioTransactionRepository.js";
import {
  sanitizeSnapshotSpikes,
  calendarDaysBetween,
  toYmd,
} from "../calculations/portfolioMath.js";
import { toDecimal, roundMoney } from "../../lib/money.js";
import { epochMsToUtcYmd } from "../../lib/dateFormat.js";
import { todayAppDateString } from "../../lib/timezone.js";
import { areLotsFullyAssigned } from "@vision/shared-utils/portfolio";

/** @typedef {import('decimal.js').default} Decimal */

/**
 * Unit-priced (stock/etf/crypto/metals) `investments` row, as narrowed by the
 * day walk's seed query.
 * @typedef {object} UnitInvestmentRow
 * @property {number} id
 * @property {string} currency `COALESCE(i.currency, 'EUR')`.
 * @property {string} current_price NUMERIC(18,6), `COALESCE(i.current_price, 0)` — pg emits NUMERIC as a string.
 * @property {string} asset_class
 */

/**
 * Non-unit (savings/bond/real_estate) `investments` row, as narrowed by the
 * day walk's seed query.
 * @typedef {object} NonUnitInvestmentRow
 * @property {number} id
 * @property {string} currency `COALESCE(i.currency, 'EUR')`.
 * @property {string} current_price NUMERIC(18,6), `COALESCE(i.current_price, 0)`.
 * @property {string} interest_rate NUMERIC(8,4), `COALESCE(i.interest_rate, 0)`.
 * @property {string} asset_class
 * @property {string} active_from 'YYYY-MM-DD' — `COALESCE(created_at::date, $1::date)::text`.
 */

/**
 * @typedef {object} PriceHistoryRow
 * @property {number} investment_id
 * @property {string} day 'YYYY-MM-DD' — `to_char(price_date, 'YYYY-MM-DD')`.
 * @property {string} close_price NUMERIC(18,6).
 */

/** @typedef {object} InflationRateRow
 * @property {string} month 'YYYY-MM' — `to_char(month_date, 'YYYY-MM')`.
 * @property {string} monthly_rate NUMERIC(10,8).
 */

/**
 * @typedef {object} FxLatestRow
 * @property {string} currency_code
 * @property {string} rate_to_eur NUMERIC(20,10).
 */

/**
 * @typedef {object} FxHistoryRow
 * @property {string} currency_code
 * @property {string} day 'YYYY-MM-DD' — `to_char(rate_date, 'YYYY-MM-DD')`.
 * @property {string} rate_to_eur NUMERIC(20,10).
 */

/**
 * `investmentsById` value — a {@link UnitInvestmentRow} with numeric fields
 * parsed (`id`, `current_price` → `currentPrice`).
 * @typedef {object} ParsedUnitInvestment
 * @property {number} id
 * @property {string} currency
 * @property {number} currentPrice
 * @property {string} assetClass
 */

/**
 * `nonUnitInvestments` entry — a {@link NonUnitInvestmentRow} with numeric
 * fields parsed and `active_from` re-sliced to a bare 'YYYY-MM-DD'.
 * @typedef {object} ParsedNonUnitInvestment
 * @property {number} id
 * @property {string} currency
 * @property {number} currentPrice
 * @property {number} interestRate
 * @property {string} assetClass
 * @property {string} activeFrom
 */

/**
 * `fxNeutralState` value — cost-weighted purchase-date FX accumulator (see the
 * day walk's m̄ comment).
 * @typedef {object} FxNeutralAccumulator
 * @property {Decimal} weight
 * @property {Decimal} weightedRate
 */

/**
 * `nonUnitState` value — running invested/appreciation for one non-unit
 * investment across the day walk.
 * @typedef {object} NonUnitRunningState
 * @property {Decimal} runningInvested
 * @property {Decimal} runningAppreciation
 * @property {string|null} lastInterestDate 'YYYY-MM-DD'
 * @property {string|null} firstBuyDate 'YYYY-MM-DD'
 */

/**
 * One replayed transaction, coerced from {@link
 * import('../../types/rows.js').PortfolioMathTxRow} for the day walk (numeric
 * strings parsed to number, `fx_rate_to_eur` collapsed to `undefined` when unset).
 * @typedef {object} SnapshotTxEntry
 * @property {number} investmentId
 * @property {string} type
 * @property {number} amount
 * @property {number} units
 * @property {number|null} accountId
 * @property {string} currency
 * @property {number|undefined} fxRateToEur
 */

/**
 * One day's computed snapshot, as pushed by the day walk and (for `gain_loss` /
 * `return_pct` / `inflation_adjusted_value`) rewritten after
 * `sanitizeSnapshotSpikes`. Money/percentage fields are plain numbers —
 * `roundMoney` converts the running Decimal accumulators before they reach
 * this shape.
 * @typedef {object} SnapshotRow
 * @property {string} snapshot_date 'YYYY-MM-DD'
 * @property {number} invested
 * @property {number} value
 * @property {number} value_fx_neutral
 * @property {number} stocks_etfs_value
 * @property {number} crypto_value
 * @property {number} metals_value
 * @property {number} cash_value
 * @property {number} stocks_etfs_invested
 * @property {number} crypto_invested
 * @property {number} metals_invested
 * @property {number} cumulative_inflation
 * @property {number} inflation_adjusted_value
 * @property {number} [gain_loss] Added by the post-sanitize pass.
 * @property {number} [return_pct] Added by the post-sanitize pass.
 */

const FIXED_INCOME_ASSET_CLASSES = new Set(["savings", "bond"]);
const REAL_ESTATE_ASSET_CLASS = "real_estate";
const NON_UNIT_ASSET_CLASSES = ["savings", "bond", "real_estate"];

/** @returns {Promise<string|null>} ISO date string or null */
export async function getFirstDataDate() {
  const result = await query(`
    SELECT MIN(first_date)::date AS first_data_date
    FROM (
      SELECT MIN(date)::date AS first_date
      FROM portfolio_transactions
      UNION ALL
      SELECT MIN(COALESCE(created_at::date, CURRENT_DATE))::date AS first_date
      FROM investments
      WHERE is_active = true
    ) seed
  `);
  return result.rows[0]?.first_data_date ?? null;
}

/**
 * Build daily snapshots from first data date to today.
 * Pure data computation — no DB writes.
 *
 * @param {string} targetCurrency
 * @returns {Promise<SnapshotRow[]>}
 */
export async function computeDailySnapshots(targetCurrency = "EUR") {
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
    unitInvestmentsResult,
    allTxRows,
    fixedIncomeResult,
    priceHistoryResult,
    inflationResult,
    fxResult,
    fxHistoryResult,
  ] = await Promise.all([
    /** @type {Promise<{ rows: UnitInvestmentRow[] }>} */ (
      query(`
      SELECT i.id, COALESCE(i.currency, 'EUR') AS currency,
             COALESCE(i.current_price, 0) AS current_price, i.asset_class
      FROM investments i
      WHERE i.is_active = true
        AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
    `)
    ),
    portfolioTransactionRepository.getRowsForPortfolioMath({
      dateFrom: firstDateYmd,
      dateTo: todayYmd,
      sellsLastWithinDay: true,
    }),
    /** @type {Promise<{ rows: NonUnitInvestmentRow[] }>} */ (
      query(
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
      )
    ),
    /** @type {Promise<{ rows: PriceHistoryRow[] }>} */ (
      query(
        `
      SELECT investment_id, to_char(price_date, 'YYYY-MM-DD') AS day, close_price
      FROM asset_price_history
      WHERE price_date >= $1::date AND price_date <= $2::date
      ORDER BY investment_id, price_date
    `,
        [firstDateYmd, todayYmd],
      )
    ),
    /** @type {Promise<{ rows: InflationRateRow[] }>} */ (
      query(
        `
      SELECT to_char(month_date, 'YYYY-MM') AS month, monthly_rate
      FROM belgian_inflation_rates
      WHERE month_date >= $1::date
      ORDER BY month_date
    `,
        [firstDateYmd],
      )
    ),
    /** @type {Promise<{ rows: FxLatestRow[] }>} */ (
      query(
        `SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true`,
      ).catch(() => ({ rows: /** @type {FxLatestRow[]} */ ([]) }))
    ),
    // Historical FX so each day of the walk converts at the rate that applied
    // then, not today's. Sparse/empty is fine — convertAmount falls back to the
    // latest (is_latest) rate when no historical row precedes the day.
    /** @type {Promise<{ rows: FxHistoryRow[] }>} */ (
      query(
        `
      SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS day, rate_to_eur
      FROM exchange_rates
      WHERE rate_date >= $1::date
      ORDER BY currency_code, rate_date
    `,
        [firstDateYmd],
      ).catch(() => ({ rows: /** @type {FxHistoryRow[]} */ ([]) }))
    ),
  ]);

  // --- Build lookup maps ---

  const investmentsById = new Map(
    unitInvestmentsResult.rows.map((row) => [
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
  const nonUnitInvestments = fixedIncomeResult.rows.map((row) => ({
    id: Number(row.id),
    currency: row.currency,
    currentPrice: Number(row.current_price) || 0,
    interestRate: Number(row.interest_rate) || 0,
    assetClass: row.asset_class,
    activeFrom: String(row.active_from).split("T")[0],
  }));
  const nonUnitInvestmentsById = new Map(
    nonUnitInvestments.map((inv) => [inv.id, inv]),
  );

  // { investmentId: { day: price } }  +  sorted day arrays for binary-search forward-fill
  /** @type {Record<number, Record<string, number>>} */
  const priceHistoryByInvestment = {};
  /** @type {Record<number, string[]>} */
  const priceHistorySortedDays = {};
  for (const row of priceHistoryResult.rows) {
    const invId = Number(row.investment_id);
    if (!priceHistoryByInvestment[invId]) {
      priceHistoryByInvestment[invId] = {};
      priceHistorySortedDays[invId] = [];
    }
    priceHistoryByInvestment[invId][row.day] = Number(row.close_price) || 0;
    priceHistorySortedDays[invId].push(row.day);
  }
  // Rows arrive ORDER BY investment_id, price_date — sorted per investment.
  // Sort defensively so binary-search forward-fill is correct even if query order changes.
  for (const days of Object.values(priceHistorySortedDays)) {
    days.sort();
  }

  const inflationByMonth = new Map(
    inflationResult.rows.map((row) => [
      row.month,
      Number(row.monthly_rate) || 0,
    ]),
  );

  /** @type {Record<string, number>} */
  const fxRates = { EUR: 1 };
  for (const row of fxResult.rows) {
    fxRates[row.currency_code] = Number(row.rate_to_eur) || 1;
  }

  // Historical rate_to_eur per currency, with sorted day arrays for binary-search
  // nearest-on-or-before lookup (mirrors the price-history forward-fill above).
  // { CURRENCY: { day: rate } } + { CURRENCY: [day, ...] }
  /** @type {Record<string, Record<string, number>>} */
  const fxHistoryByCurrency = {};
  /** @type {Record<string, string[]>} */
  const fxHistorySortedDays = {};
  for (const row of fxHistoryResult.rows) {
    const cur = row.currency_code;
    if (!cur) continue;
    const rate = Number(row.rate_to_eur) || 0;
    if (rate <= 0) continue;
    if (!fxHistoryByCurrency[cur]) {
      fxHistoryByCurrency[cur] = {};
      fxHistorySortedDays[cur] = [];
    }
    fxHistoryByCurrency[cur][row.day] = rate;
    fxHistorySortedDays[cur].push(row.day);
  }
  for (const days of Object.values(fxHistorySortedDays)) {
    days.sort();
  }

  // { day: tx[] }
  // Within a day, replay buys/gifts/splits before sells so a sell can never be
  // applied against units its own-day buy hasn't established yet (which would
  // clamp the buy away and mint phantom units — e.g. after an earlier buy was
  // deleted). Mirrors the query's ORDER BY sell-last key; kept defensively in JS
  // (per the same pattern as the price-history sort) so the day-walk stays
  // correct regardless of raw row order.
  /** @type {Record<string, SnapshotTxEntry[]>} */
  const txByDay = {};
  for (const row of allTxRows) {
    if (!txByDay[row.day]) txByDay[row.day] = [];
    txByDay[row.day].push({
      investmentId: Number(row.investment_id),
      type: row.type,
      amount: Number(row.amount) || 0,
      units: Number(row.units) || 0,
      accountId: row.account_id == null ? null : Number(row.account_id),
      currency: row.currency,
      fxRateToEur:
        row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined,
    });
  }
  // Stable sort each day: non-sells (buy/gift/split/…) first, sells last.
  for (const dayTxs of Object.values(txByDay)) {
    dayTxs.sort(
      (a, b) => (a.type === "sell" ? 1 : 0) - (b.type === "sell" ? 1 : 0),
    );
  }

  const txnsByInvestment = new Map();
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

  // --- Day walk helpers ---

  /**
   * rate_to_eur for `currency` as of `day`: the most recent historical rate on or
   * before `day`, falling back to the latest (is_latest) rate when no historical
   * row precedes it (or no history is loaded). The latest day always uses the
   * latest rate so the headline snapshot reconciles with /portfolio-summary.
   *
   * @param {string} currency
   * @param {string} [day] YYYY-MM-DD
   * @returns {number}
   */
  function rateToEurOnOrBefore(currency, day) {
    const cur = (currency || "EUR").toUpperCase();
    if (cur === "EUR") return 1;
    const latest = fxRates[cur] > 0 ? fxRates[cur] : 1;
    if (!day || day === todayYmd) return latest;

    const byDay = fxHistoryByCurrency[cur];
    if (byDay) {
      if (byDay[day] > 0) return byDay[day];
      const days = fxHistorySortedDays[cur];
      let lo = 0;
      let hi = days.length - 1;
      let bestDay = "";
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (days[mid] <= day) {
          bestDay = days[mid];
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (bestDay && byDay[bestDay] > 0) return byDay[bestDay];
    }
    return latest;
  }

  /**
   * Convert `amount` from `fromCurrency` to the target currency as of `asOfDay`.
   * Prefers the rate stored on the transaction (`fxRateToEur`); otherwise uses the
   * historical rate that applied on `asOfDay` (not today's). For invested capital
   * pass the transaction date; for market value pass the day being valued.
   *
   * @param {number|string|import('decimal.js').default} amount
   * @param {string} fromCurrency
   * @param {number} [fxRateToEur] rate stored at transaction time
   * @param {string} [asOfDay] YYYY-MM-DD the conversion applies to
   * @returns {import('decimal.js').default} converted amount as Decimal
   */
  function convertAmount(amount, fromCurrency, fxRateToEur, asOfDay) {
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
  /**
   * @param {SnapshotTxEntry} tx
   * @param {string|undefined} invCurrency
   * @param {string} asOfDay
   * @returns {number}
   */
  function txFallbackPrice(tx, invCurrency, asOfDay) {
    const from = (tx.currency || "EUR").toUpperCase();
    const to = (invCurrency || "EUR").toUpperCase();
    const perUnit = tx.amount / tx.units;
    if (from === to) return perUnit;
    const rateFrom =
      tx.fxRateToEur !== undefined &&
      Number.isFinite(tx.fxRateToEur) &&
      tx.fxRateToEur > 0
        ? tx.fxRateToEur
        : rateToEurOnOrBefore(from, asOfDay);
    const rateTo = to === "EUR" ? 1 : rateToEurOnOrBefore(to, asOfDay);
    return toDecimal(perUnit).times(rateFrom).div(rateTo).toNumber();
  }

  /**
   * @param {ParsedUnitInvestment} inv
   * @param {string} day
   * @param {Record<number, number>} lastKnownPrice
   * @returns {number}
   */
  function resolvePrice(inv, day, lastKnownPrice) {
    const histPrices = priceHistoryByInvestment[inv.id];
    if (!histPrices) {
      return lastKnownPrice[inv.id] > 0
        ? lastKnownPrice[inv.id]
        : inv.currentPrice;
    }
    if (histPrices[day]) return histPrices[day];

    // Binary search for the latest price day <= `day`
    const days = priceHistorySortedDays[inv.id];
    let lo = 0;
    let hi = days.length - 1;
    let bestDay = "";
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (days[mid] <= day) {
        bestDay = days[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (bestDay) return histPrices[bestDay];
    if (lastKnownPrice[inv.id] > 0) return lastKnownPrice[inv.id];
    return inv.currentPrice;
  }

  // --- Main day loop ---

  // todayYmd (hoisted above the queries) ends the walk on the APP_TIMEZONE
  // calendar day, matching the query bounds (ADR-009).
  const allDays = [];
  const today = new Date(todayYmd);
  for (
    let d = new Date(firstDateYmd);
    d <= today;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    allDays.push(epochMsToUtcYmd(d.getTime()));
  }

  /** @type {Record<number, number>} */
  const unitsByInvestment = {};
  /** @type {Map<number, Map<number|null, number>>} */
  const unitsByInvestmentPartition = new Map();
  // Cost-weighted average purchase-date FX multiplier per unit investment:
  // m̄ = Σ(buyAmount_i × m_i) / Σ(buyAmount_i), where m_i is the txn-date
  // conversion to the target currency. Valuing units×price at m̄ instead of
  // the day's rate yields the FX-neutral series — `value − value_fx_neutral`
  // is the cumulative currency effect on current holdings. Sells reduce both
  // sums proportionally (m̄ of the remaining position is unchanged).
  /** @type {Map<number, Map<number|null, FxNeutralAccumulator>>} */
  const fxNeutralState = new Map();

  const partitionKey = (tx) =>
    fullyAssignedUnitInvestments.has(tx.investmentId) ? tx.accountId : null;
  const partitionUnits = (investmentId) => {
    let partitions = unitsByInvestmentPartition.get(investmentId);
    if (!partitions) {
      partitions = new Map();
      unitsByInvestmentPartition.set(investmentId, partitions);
    }
    return partitions;
  };
  const refreshTotalUnits = (investmentId) => {
    unitsByInvestment[investmentId] = [
      ...partitionUnits(investmentId).values(),
    ].reduce((heldUnits, units) => heldUnits + units, 0);
  };
  const neutralPartitions = (investmentId) => {
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
  let stocksEtfsInvested = toDecimal(0);
  let cryptoInvested = toDecimal(0);
  let metalsInvested = toDecimal(0);
  let cumulativeInflation = toDecimal(1);
  let lastInflationMonth = "";
  /** @type {Record<number, number>} */
  const lastKnownPrice = {};
  /** @type {SnapshotRow[]} */
  const snapshots = [];

  // Per-investment running state for non-unit assets (mirrors live summary
  // formulas so the latest snapshot reconciles with /portfolio-summary).
  //   fixed-income (savings/bond): value = runningInvested + accruedInterest
  //   real-estate:                 value = runningInvested + runningAppreciation
  // runningInvested is kept in target currency, accumulated using per-txn FX
  // (same convention as cumulativeInvested above).
  /** @type {Map<number, NonUnitRunningState>} */
  const nonUnitState = new Map();
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
        if (inv?.assetClass === "stock" || inv?.assetClass === "etf")
          stocksEtfsInvested = stocksEtfsInvested.plus(converted);
        else if (inv?.assetClass === "crypto")
          cryptoInvested = cryptoInvested.plus(converted);
        else if (inv?.assetClass === "metals")
          metalsInvested = metalsInvested.plus(converted);
        const key = partitionKey(tx);
        const partitionState = partitionUnits(tx.investmentId);
        partitionState.set(key, (partitionState.get(key) || 0) + tx.units);
        refreshTotalUnits(tx.investmentId);
        if (tx.units > 0 && tx.amount > 0)
          lastKnownPrice[tx.investmentId] = txFallbackPrice(
            tx,
            inv?.currency,
            day,
          );

        if (inv && tx.amount > 0) {
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
          const includeForInvested =
            nonUnitInv.assetClass !== REAL_ESTATE_ASSET_CLASS ||
            tx.type === "buy";
          if (includeForInvested)
            nonUnitS.runningInvested = nonUnitS.runningInvested.plus(converted);
          if (tx.type === "buy" && !nonUnitS.firstBuyDate)
            nonUnitS.firstBuyDate = day;
        }
      } else if (tx.type === "sell") {
        // Clamp oversells to held units (mirrors calculateCostBasis's
        // min(units, totalUnits)) so a later buy isn't offset by a negative.
        // The live calculators also scale proceeds by consumed/requested units;
        // apply that ratio to invested cash flow so snapshot gain stays aligned.
        const key = partitionKey(tx);
        const partitionState = partitionUnits(tx.investmentId);
        const heldUnits = partitionState.get(key) || 0;
        const consumedUnits = Math.min(heldUnits, tx.units);
        const effectiveConverted =
          inv && tx.units > 0
            ? converted.times(toDecimal(consumedUnits).div(tx.units))
            : converted;
        cumulativeInvested = cumulativeInvested.minus(effectiveConverted);
        if (inv?.assetClass === "stock" || inv?.assetClass === "etf")
          stocksEtfsInvested = stocksEtfsInvested.minus(effectiveConverted);
        else if (inv?.assetClass === "crypto")
          cryptoInvested = cryptoInvested.minus(effectiveConverted);
        else if (inv?.assetClass === "metals")
          metalsInvested = metalsInvested.minus(effectiveConverted);
        partitionState.set(key, Math.max(0, heldUnits - tx.units));
        refreshTotalUnits(tx.investmentId);
        if (tx.units > 0 && tx.amount > 0)
          lastKnownPrice[tx.investmentId] = txFallbackPrice(
            tx,
            inv?.currency,
            day,
          );

        const fxs = fxNeutralState.get(tx.investmentId)?.get(key);
        if (fxs && heldUnits > 0 && tx.units > 0) {
          const factor = toDecimal(heldUnits - consumedUnits).div(heldUnits);
          fxs.weight = fxs.weight.times(factor);
          fxs.weightedRate = fxs.weightedRate.times(factor);
        }

        if (nonUnitS)
          nonUnitS.runningInvested = nonUnitS.runningInvested.minus(converted);
      } else if (tx.type === "split") {
        // units = new total post-split; invested/cost basis is unchanged
        // (mirrors calculateCostBasis). Only applies once units are held.
        const heldUnits = unitsByInvestment[tx.investmentId] || 0;
        if (heldUnits > 0 && tx.units > 0) {
          const partitions = partitionUnits(tx.investmentId);
          const entries = [...partitions.entries()].filter(
            ([, units]) => units > 0,
          );
          let allocated = 0;
          entries.forEach(([key, units], index) => {
            const nextUnits =
              index === entries.length - 1
                ? tx.units - allocated
                : (units / heldUnits) * tx.units;
            allocated += nextUnits;
            partitions.set(key, nextUnits);
          });
          refreshTotalUnits(tx.investmentId);
        }
      } else if (tx.type === "return_of_capital") {
        // Returns capital, reducing net invested (mirrors calculateCostBasis
        // reducing cost basis). Units are unchanged.
        const heldUnits = unitsByInvestment[tx.investmentId] || 0;
        if (heldUnits > 0) {
          cumulativeInvested = cumulativeInvested.minus(converted);
          if (inv?.assetClass === "stock" || inv?.assetClass === "etf")
            stocksEtfsInvested = stocksEtfsInvested.minus(converted);
          else if (inv?.assetClass === "crypto")
            cryptoInvested = cryptoInvested.minus(converted);
          else if (inv?.assetClass === "metals")
            metalsInvested = metalsInvested.minus(converted);
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
    let stocksEtfsValue = toDecimal(0);
    let cryptoValue = toDecimal(0);
    let metalsValue = toDecimal(0);

    const isLatestDay = day === todayYmd;

    for (const inv of investmentsById.values()) {
      const units = unitsByInvestment[inv.id] || 0;
      if (units <= 0) continue;

      // Latest day: use the live current_price so the headline snapshot value
      // always reconciles with /portfolio-summary, even if asset_price_history
      // lags behind a price refresh that updated investments.current_price.
      const price =
        isLatestDay && inv.currentPrice > 0
          ? inv.currentPrice
          : resolvePrice(inv, day, lastKnownPrice);
      if (price <= 0) continue;

      // Forward-fill last known price
      if ((priceHistoryByInvestment[inv.id] || {})[day] > 0) {
        lastKnownPrice[inv.id] = priceHistoryByInvestment[inv.id][day];
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
      if (inv.assetClass === "stock" || inv.assetClass === "etf")
        stocksEtfsValue = stocksEtfsValue.plus(invValue);
      else if (inv.assetClass === "crypto")
        cryptoValue = cryptoValue.plus(invValue);
      else if (inv.assetClass === "metals")
        metalsValue = metalsValue.plus(invValue);

      // FX-neutral: value the position at its cost-weighted purchase-date
      // rate. Positions with no recorded buy amounts (e.g. price-only seeds)
      // have no purchase rate to lock — they contribute at the day's rate.
      const fxs = fxNeutralState.get(inv.id);
      let invValueNeutral = toDecimal(0);
      if (fxs) {
        const heldPartitions = partitionUnits(inv.id);
        for (const [key, held] of heldPartitions) {
          if (held <= 0) continue;
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
      const state = nonUnitState.get(inv.id);
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
      stocks_etfs_value: roundMoney(stocksEtfsValue),
      crypto_value: roundMoney(cryptoValue),
      metals_value: roundMoney(metalsValue),
      cash_value: roundMoney(fixedIncomeValue),
      stocks_etfs_invested: roundMoney(stocksEtfsInvested),
      crypto_invested: roundMoney(cryptoInvested),
      metals_invested: roundMoney(metalsInvested),
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
  /** @type {SnapshotRow[]} */
  const sanitized = sanitizeSnapshotSpikes(snapshots);

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
async function hasFxNeutralColumn() {
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
 * @param {string} targetCurrency
 * @returns {Promise<SnapshotRow[]>} Stored snapshots
 */
export async function computeAndStoreSnapshots(targetCurrency = "EUR") {
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
  /** @param {SnapshotRow} snap */
  const snapParams = (snap) => [
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
      const values = [];
      const params = [];
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
