/**
 * Snapshot Builder
 *
 * Walks days from first portfolio transaction to today, accumulates invested
 * capital and market values per asset class, applies inflation adjustment,
 * sanitizes spikes, and bulk-inserts the result into
 * portfolio_performance_snapshots.
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { sanitizeSnapshotSpikes, calendarDaysBetween, toYmd } from '../../utils/portfolioMath.js';
import { toDecimal, roundMoney } from '../../lib/money.js';
import { todayAppDateString } from '../../lib/timezone.js';

const FIXED_INCOME_ASSET_CLASSES = new Set(['savings', 'bond']);
const REAL_ESTATE_ASSET_CLASS = 'real_estate';
const NON_UNIT_ASSET_CLASSES = ['savings', 'bond', 'real_estate'];

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
 * @returns {Promise<object[]>}
 */
export async function computeDailySnapshots(targetCurrency = 'EUR') {
  const firstDataDate = await getFirstDataDate();
  if (!firstDataDate) {
    logger.info('No portfolio data available for snapshots');
    return [];
  }

  const firstDateYmd = toYmd(firstDataDate);

  // Upper bound for the walk AND the queries. Postgres CURRENT_DATE is the
  // DB-container day (UTC); between local midnight and 01:00/02:00 the walk
  // emitted today's snapshot while the queries excluded today's rows.
  const todayYmd = todayAppDateString();

  const [
    unitInvestmentsResult,
    allTxResult,
    fixedIncomeResult,
    priceHistoryResult,
    inflationResult,
    fxResult,
    fxHistoryResult,
  ] = await Promise.all([
    query(`
      SELECT i.id, COALESCE(i.currency, 'EUR') AS currency,
             COALESCE(i.current_price, 0) AS current_price, i.asset_class
      FROM investments i
      WHERE i.is_active = true
        AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
    `),
    query(`
      SELECT pt.investment_id,
             to_char(pt.date::date, 'YYYY-MM-DD') AS day,
             pt.type,
             COALESCE(pt.amount, 0) AS amount,
             COALESCE(pt.units, 0) AS units,
             COALESCE(pt.currency, i.currency, 'EUR') AS currency,
             pt.fx_rate_to_eur,
             pt.account_id
      FROM portfolio_transactions pt
      JOIN investments i ON i.id = pt.investment_id
      WHERE pt.date >= $1::date AND pt.date <= $2::date
      ORDER BY pt.date::date, pt.id
    `, [firstDateYmd, todayYmd]),
    query(`
      SELECT id, COALESCE(currency, 'EUR') AS currency,
             COALESCE(current_price, 0) AS current_price,
             COALESCE(interest_rate, 0) AS interest_rate,
             asset_class,
             COALESCE(created_at::date, $1::date)::text AS active_from
      FROM investments
      WHERE is_active = true
        AND asset_class::text = ANY($2::text[])
    `, [firstDateYmd, NON_UNIT_ASSET_CLASSES]),
    query(`
      SELECT investment_id, to_char(price_date, 'YYYY-MM-DD') AS day, close_price
      FROM asset_price_history
      WHERE price_date >= $1::date AND price_date <= $2::date
      ORDER BY investment_id, price_date
    `, [firstDateYmd, todayYmd]),
    query(`
      SELECT to_char(month_date, 'YYYY-MM') AS month, monthly_rate
      FROM belgian_inflation_rates
      WHERE month_date >= $1::date
      ORDER BY month_date
    `, [firstDateYmd]),
    query(`SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true`)
      .catch(() => ({ rows: [] })),
    // Historical FX so each day of the walk converts at the rate that applied
    // then, not today's. Sparse/empty is fine — convertAmount falls back to the
    // latest (is_latest) rate when no historical row precedes the day.
    query(`
      SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS day, rate_to_eur
      FROM exchange_rates
      WHERE rate_date >= $1::date
      ORDER BY currency_code, rate_date
    `, [firstDateYmd]).catch(() => ({ rows: [] })),
  ]);

  // --- Build lookup maps ---

  const investmentsById = new Map(
    unitInvestmentsResult.rows.map(row => [Number(row.id), {
      id: Number(row.id),
      currency: row.currency,
      currentPrice: Number(row.current_price) || 0,
      assetClass: row.asset_class,
    }])
  );

  // Non-unit investments (savings/bond/real_estate). Valued from transactions —
  // current_price is kept as a last-resort fallback only when no buy transactions
  // exist for the asset, mirroring how the live summary handles such cases.
  const nonUnitInvestments = fixedIncomeResult.rows.map(row => ({
    id: Number(row.id),
    currency: row.currency,
    currentPrice: Number(row.current_price) || 0,
    interestRate: Number(row.interest_rate) || 0,
    assetClass: row.asset_class,
    activeFrom: String(row.active_from).split('T')[0],
  }));
  const nonUnitInvestmentsById = new Map(nonUnitInvestments.map(inv => [inv.id, inv]));

  // { investmentId: { day: price } }  +  sorted day arrays for binary-search forward-fill
  const priceHistoryByInvestment = {};
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
    inflationResult.rows.map(row => [row.month, Number(row.monthly_rate) || 0])
  );

  const fxRates = { EUR: 1 };
  for (const row of fxResult.rows) {
    fxRates[row.currency_code] = Number(row.rate_to_eur) || 1;
  }

  // Historical rate_to_eur per currency, with sorted day arrays for binary-search
  // nearest-on-or-before lookup (mirrors the price-history forward-fill above).
  // { CURRENCY: { day: rate } } + { CURRENCY: [day, ...] }
  const fxHistoryByCurrency = {};
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
  const txByDay = {};
  for (const row of allTxResult.rows) {
    if (!txByDay[row.day]) txByDay[row.day] = [];
    txByDay[row.day].push({
      investmentId: Number(row.investment_id),
      type: row.type,
      amount: Number(row.amount) || 0,
      units: Number(row.units) || 0,
      currency: row.currency,
      fxRateToEur: row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined,
      // Per-account positioning (ADR-091): the lot's owning account ('unassigned'
      // for legacy NULLs). Used to split each day's value Σ accounts (ADR-100).
      accountKey: row.account_id == null ? 'unassigned' : String(Number(row.account_id)),
    });
  }

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
    const cur = (currency || 'EUR').toUpperCase();
    if (cur === 'EUR') return 1;
    const latest = fxRates[cur] > 0 ? fxRates[cur] : 1;
    if (!day || day === todayYmd) return latest;

    const byDay = fxHistoryByCurrency[cur];
    if (byDay) {
      if (byDay[day] > 0) return byDay[day];
      const days = fxHistorySortedDays[cur];
      let lo = 0;
      let hi = days.length - 1;
      let bestDay = '';
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
    const from = (fromCurrency || 'EUR').toUpperCase();
    const to = targetCurrency.toUpperCase();
    const amt = toDecimal(amount);
    if (from === to) return amt;
    const rateTo = to === 'EUR' ? 1 : rateToEurOnOrBefore(to, asOfDay);
    const rateFrom = (fxRateToEur !== undefined && Number.isFinite(fxRateToEur) && fxRateToEur > 0)
      ? fxRateToEur
      : rateToEurOnOrBefore(from, asOfDay);
    return amt.times(rateFrom).div(rateTo);
  }

  // Fallback unit price (tx.amount / tx.units) expressed in the INVESTMENT's
  // currency. lastKnownPrice is consumed as a price in inv.currency (it's later
  // converted via convertAmount(units*price, inv.currency, …) and is overwritten
  // by price-history values that are in inv.currency). Storing tx.amount/tx.units
  // raw mixed the transaction's currency in when tx.currency != inv.currency.
  function txFallbackPrice(tx, invCurrency, asOfDay) {
    const from = (tx.currency || 'EUR').toUpperCase();
    const to = (invCurrency || 'EUR').toUpperCase();
    const perUnit = tx.amount / tx.units;
    if (from === to) return perUnit;
    const rateFrom = (tx.fxRateToEur !== undefined && Number.isFinite(tx.fxRateToEur) && tx.fxRateToEur > 0)
      ? tx.fxRateToEur
      : rateToEurOnOrBefore(from, asOfDay);
    const rateTo = to === 'EUR' ? 1 : rateToEurOnOrBefore(to, asOfDay);
    return toDecimal(perUnit).times(rateFrom).div(rateTo).toNumber();
  }

  function resolvePrice(inv, day, lastKnownPrice) {
    const histPrices = priceHistoryByInvestment[inv.id];
    if (!histPrices) {
      return lastKnownPrice[inv.id] > 0 ? lastKnownPrice[inv.id] : inv.currentPrice;
    }
    if (histPrices[day]) return histPrices[day];

    // Binary search for the latest price day <= `day`
    const days = priceHistorySortedDays[inv.id];
    let lo = 0;
    let hi = days.length - 1;
    let bestDay = '';
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
  for (let d = new Date(firstDateYmd); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    allDays.push(d.toISOString().split('T')[0]);
  }

  const unitsByInvestment = {};
  // Per-account positioning (ADR-091/ADR-100): a relative weight per (investment,
  // account) — units for unit assets, net invested for non-unit — used to split
  // each day's per-investment value across accounts. Σ shares == 1 per investment,
  // so Σ accounts == the aggregate value by construction (the parity guarantee).
  const weightByAcctInv = new Map();
  const bumpWeight = (invId, acctKey, delta) => {
    let m = weightByAcctInv.get(invId);
    if (!m) { m = new Map(); weightByAcctInv.set(invId, m); }
    m.set(acctKey, (m.get(acctKey) || 0) + delta);
  };
  const splitByAccount = (target, invId, value) => {
    const m = weightByAcctInv.get(invId);
    if (!m) return;
    let totalW = 0;
    for (const w of m.values()) totalW += w > 0 ? w : 0;
    if (totalW <= 0) return;
    for (const [acctKey, w] of m) {
      if (w <= 0) continue;
      const share = toDecimal(w).div(totalW);
      target.set(acctKey, (target.get(acctKey) ?? toDecimal(0)).plus(value.times(share)));
    }
  };
  // Cost-weighted average purchase-date FX multiplier per unit investment:
  // m̄ = Σ(buyAmount_i × m_i) / Σ(buyAmount_i), where m_i is the txn-date
  // conversion to the target currency. Valuing units×price at m̄ instead of
  // the day's rate yields the FX-neutral series — `value − value_fx_neutral`
  // is the cumulative currency effect on current holdings. Sells reduce both
  // sums proportionally (m̄ of the remaining position is unchanged).
  const fxNeutralState = new Map();
  // Money accumulators stay Decimal — float drift compounds across a multi-year
  // day walk and is persisted into portfolio_performance_snapshots.
  let cumulativeInvested = toDecimal(0);
  let stocksEtfsInvested = toDecimal(0);
  let cryptoInvested = toDecimal(0);
  let metalsInvested = toDecimal(0);
  let cumulativeInflation = toDecimal(1);
  let lastInflationMonth = '';
  const lastKnownPrice = {};
  const snapshots = [];

  // Per-investment running state for non-unit assets (mirrors live summary
  // formulas so the latest snapshot reconciles with /portfolio-summary).
  //   fixed-income (savings/bond): value = runningInvested + accruedInterest
  //   real-estate:                 value = runningInvested + runningAppreciation
  // runningInvested is kept in target currency, accumulated using per-txn FX
  // (same convention as cumulativeInvested above).
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
      const converted = convertAmount(tx.amount, tx.currency, tx.fxRateToEur, day);
      const inv = investmentsById.get(tx.investmentId);
      const nonUnitInv = nonUnitInvestmentsById.get(tx.investmentId);
      const nonUnitS = nonUnitState.get(tx.investmentId);

      if (tx.type === 'buy' || tx.type === 'gift') {
        cumulativeInvested = cumulativeInvested.plus(converted);
        if (inv?.assetClass === 'stock' || inv?.assetClass === 'etf') stocksEtfsInvested = stocksEtfsInvested.plus(converted);
        else if (inv?.assetClass === 'crypto') cryptoInvested = cryptoInvested.plus(converted);
        else if (inv?.assetClass === 'metals') metalsInvested = metalsInvested.plus(converted);
        unitsByInvestment[tx.investmentId] = (unitsByInvestment[tx.investmentId] || 0) + tx.units;
        // Per-account weight: units for unit assets, net invested for non-unit.
        bumpWeight(tx.investmentId, tx.accountKey, inv ? tx.units : converted.toNumber());
        if (tx.units > 0 && tx.amount > 0) lastKnownPrice[tx.investmentId] = txFallbackPrice(tx, inv?.currency, day);

        if (inv && tx.amount > 0) {
          const fxs = fxNeutralState.get(tx.investmentId) ?? { weight: toDecimal(0), weightedRate: toDecimal(0) };
          fxs.weight = fxs.weight.plus(tx.amount);
          fxs.weightedRate = fxs.weightedRate.plus(converted); // amount × m_i
          fxNeutralState.set(tx.investmentId, fxs);
        }

        if (nonUnitS) {
          // Live summary: fixed-income uses buy+gift; real_estate uses buy only.
          const includeForInvested = nonUnitInv.assetClass !== REAL_ESTATE_ASSET_CLASS || tx.type === 'buy';
          if (includeForInvested) nonUnitS.runningInvested = nonUnitS.runningInvested.plus(converted);
          if (tx.type === 'buy' && !nonUnitS.firstBuyDate) nonUnitS.firstBuyDate = day;
        }
      } else if (tx.type === 'sell') {
        cumulativeInvested = cumulativeInvested.minus(converted);
        if (inv?.assetClass === 'stock' || inv?.assetClass === 'etf') stocksEtfsInvested = stocksEtfsInvested.minus(converted);
        else if (inv?.assetClass === 'crypto') cryptoInvested = cryptoInvested.minus(converted);
        else if (inv?.assetClass === 'metals') metalsInvested = metalsInvested.minus(converted);
        // Clamp oversells to held units (mirrors calculateCostBasis's
        // min(units, totalUnits)) so a later buy isn't offset by a negative.
        const heldUnits = unitsByInvestment[tx.investmentId] || 0;
        unitsByInvestment[tx.investmentId] = heldUnits > 0 ? Math.max(0, heldUnits - tx.units) : heldUnits;
        // Reduce the selling account's weight (the sell carries its account).
        bumpWeight(tx.investmentId, tx.accountKey, inv ? -tx.units : converted.negated().toNumber());
        if (tx.units > 0 && tx.amount > 0) lastKnownPrice[tx.investmentId] = txFallbackPrice(tx, inv?.currency, day);

        const fxs = fxNeutralState.get(tx.investmentId);
        if (fxs && heldUnits > 0 && tx.units > 0) {
          const factor = toDecimal(Math.max(0, heldUnits - tx.units)).div(heldUnits);
          fxs.weight = fxs.weight.times(factor);
          fxs.weightedRate = fxs.weightedRate.times(factor);
        }

        if (nonUnitS) nonUnitS.runningInvested = nonUnitS.runningInvested.minus(converted);
      } else if (tx.type === 'split') {
        // units = new total post-split; invested/cost basis is unchanged
        // (mirrors calculateCostBasis). Only applies once units are held.
        const heldUnits = unitsByInvestment[tx.investmentId] || 0;
        if (heldUnits > 0 && tx.units > 0) unitsByInvestment[tx.investmentId] = tx.units;
      } else if (tx.type === 'return_of_capital') {
        // Returns capital, reducing net invested (mirrors calculateCostBasis
        // reducing cost basis). Units are unchanged. Only while units are held.
        const heldUnits = unitsByInvestment[tx.investmentId] || 0;
        if (heldUnits > 0) {
          cumulativeInvested = cumulativeInvested.minus(converted);
          if (inv?.assetClass === 'stock' || inv?.assetClass === 'etf') stocksEtfsInvested = stocksEtfsInvested.minus(converted);
          else if (inv?.assetClass === 'crypto') cryptoInvested = cryptoInvested.minus(converted);
          else if (inv?.assetClass === 'metals') metalsInvested = metalsInvested.minus(converted);
        }
      } else if (tx.type === 'interest' && nonUnitS) {
        // Resets the accrual clock to match calculateAccruedInterest.
        nonUnitS.lastInterestDate = day;
      } else if (tx.type === 'appreciation' && nonUnitS) {
        nonUnitS.runningAppreciation = nonUnitS.runningAppreciation.plus(converted);
      }
      // income / dividends / fees / taxes: don't alter invested capital
    }

    // Compute portfolio value
    let totalValue = toDecimal(0);
    let totalValueFxNeutral = toDecimal(0);
    let stocksEtfsValue = toDecimal(0);
    let cryptoValue = toDecimal(0);
    let metalsValue = toDecimal(0);
    const valueByAccount = new Map(); // acctKey → Decimal (ADR-100 per-account split)

    const isLatestDay = day === todayYmd;

    for (const inv of investmentsById.values()) {
      const units = unitsByInvestment[inv.id] || 0;
      if (units <= 0) continue;

      // Latest day: use the live current_price so the headline snapshot value
      // always reconciles with /portfolio-summary, even if asset_price_history
      // lags behind a price refresh that updated investments.current_price.
      const price = isLatestDay && inv.currentPrice > 0
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
      const invValue = convertAmount(invValueNative, inv.currency, undefined, day);
      totalValue = totalValue.plus(invValue);
      splitByAccount(valueByAccount, inv.id, invValue);
      if (inv.assetClass === 'stock' || inv.assetClass === 'etf') stocksEtfsValue = stocksEtfsValue.plus(invValue);
      else if (inv.assetClass === 'crypto') cryptoValue = cryptoValue.plus(invValue);
      else if (inv.assetClass === 'metals') metalsValue = metalsValue.plus(invValue);

      // FX-neutral: value the position at its cost-weighted purchase-date
      // rate. Positions with no recorded buy amounts (e.g. price-only seeds)
      // have no purchase rate to lock — they contribute at the day's rate.
      const fxs = fxNeutralState.get(inv.id);
      const invValueNeutral = fxs && fxs.weight.gt(0)
        ? invValueNative.times(fxs.weightedRate).div(fxs.weight)
        : invValue;
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
        invValue = convertAmount(inv.currentPrice, inv.currency, undefined, day);
      }

      if (invValue.gt(0)) {
        fixedIncomeValue = fixedIncomeValue.plus(invValue);
        splitByAccount(valueByAccount, inv.id, invValue);
      }
    }
    totalValue = totalValue.plus(fixedIncomeValue);
    // Non-unit values accumulate invested capital at txn-date rates already,
    // so they are FX-neutral by construction — add them unchanged.
    totalValueFxNeutral = totalValueFxNeutral.plus(fixedIncomeValue);

    // Inflation compounding (once per calendar month)
    const monthKey = day.slice(0, 7);
    if (monthKey !== lastInflationMonth) {
      cumulativeInflation = cumulativeInflation.times(toDecimal(1).plus(inflationByMonth.get(monthKey) ?? 0));
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
      cumulative_inflation: roundMoney(cumulativeInflation.minus(1).times(100), 2),
      inflation_adjusted_value: cumulativeInflation.gt(0)
        ? roundMoney(totalValue.div(cumulativeInflation)) : roundMoney(totalValue),
      // Per-account holdings split (ADR-100). Σ value_by_account == value by
      // construction. Persisted by computeAndStoreSnapshots into the
      // portfolio_snapshot_accounts side table (migration 0074) so
      // getNetWorthByAccount reads it instead of replaying this day-walk.
      value_by_account: Object.fromEntries(
        [...valueByAccount].map(([k, v]) => [k, roundMoney(v)]),
      ),
    });
  }

  // Sanitize spike noise from raw price feeds
  const sanitized = sanitizeSnapshotSpikes(snapshots);

  // Compute gain/loss fields after sanitization
  for (const snap of sanitized) {
    snap.gain_loss = snap.value - snap.invested;
    snap.return_pct = snap.invested > 0
      ? ((snap.value - snap.invested) / snap.invested) * 100 : 0;
    snap.inflation_adjusted_value = snap.value / (1 + snap.cumulative_inflation / 100) || snap.value;
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
 * Whether the portfolio_snapshot_accounts side table exists (migration 0074).
 * Migrations are user-applied, so the writer degrades gracefully on databases
 * that haven't run it yet — the per-account split is simply not persisted and
 * getNetWorthByAccount falls back to a live replay.
 */
async function hasSnapshotAccountsTable() {
  const result = await query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'portfolio_snapshot_accounts'
    LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * Persist the per-account holdings split (ADR-100) for one currency inside the
 * caller's transaction. Atomic replace: DELETE + batched INSERTs, mirroring the
 * aggregate snapshot writer so the split never diverges from the snapshots it
 * accompanies. Rows are sparse — only accounts holding value on a day appear.
 *
 * @param {import('pg').PoolClient} client
 * @param {object[]} snapshots
 * @param {string} targetCurrency
 * @returns {Promise<number>} number of per-account rows written
 */
async function storeAccountSplit(client, snapshots, targetCurrency) {
  await client.query('DELETE FROM portfolio_snapshot_accounts WHERE currency = $1', [targetCurrency]);

  // Flatten each day's value_by_account map into (date, account_key, value) rows.
  const rows = [];
  for (const snap of snapshots) {
    const byAccount = snap.value_by_account || {};
    for (const [accountKey, value] of Object.entries(byAccount)) {
      const numeric = Number(value) || 0;
      if (numeric === 0) continue; // sparse: skip zero-value entries
      rows.push([snap.snapshot_date, accountKey, numeric]);
    }
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let p = 1;
    for (const [snapshotDate, accountKey, value] of batch) {
      values.push(`($${p++},$${p++},$${p++},$${p++},NOW())`);
      params.push(snapshotDate, targetCurrency, accountKey, value);
    }
    await client.query(`
      INSERT INTO portfolio_snapshot_accounts (snapshot_date, currency, account_key, value, computed_at)
      VALUES ${values.join(', ')}
      ON CONFLICT (snapshot_date, currency, account_key) DO UPDATE SET
        value = EXCLUDED.value, computed_at = NOW()
    `, params);
  }

  return rows.length;
}

/**
 * Recompute all daily snapshots and persist to portfolio_performance_snapshots.
 *
 * @param {string} targetCurrency
 * @returns {Promise<object[]>} Stored snapshots
 */
export async function computeAndStoreSnapshots(targetCurrency = 'EUR') {
  logger.info('Computing portfolio performance snapshots...');

  const snapshots = await computeDailySnapshots(targetCurrency);
  if (snapshots.length === 0) {
    logger.info('No snapshots to store');
    return [];
  }

  const includeFxNeutral = await hasFxNeutralColumn();
  if (!includeFxNeutral) {
    logger.warn('portfolio_performance_snapshots.value_fx_neutral missing — apply migration 0039 to store the FX-neutral series');
  }

  const includeAccountSplit = await hasSnapshotAccountsTable();
  if (!includeAccountSplit) {
    logger.warn('portfolio_snapshot_accounts missing — apply migration 0074 to persist the per-account split (getNetWorthByAccount will replay live until then)');
  }

  const columns = [
    'snapshot_date', 'invested', 'value',
    'stocks_etfs_value', 'crypto_value', 'metals_value', 'cash_value',
    'gain_loss', 'return_pct', 'currency',
    'inflation_adjusted_value',
    'stocks_etfs_invested', 'crypto_invested', 'metals_invested',
    ...(includeFxNeutral ? ['value_fx_neutral'] : []),
  ];
  const snapParams = (snap) => [
    snap.snapshot_date, snap.invested, snap.value,
    snap.stocks_etfs_value, snap.crypto_value, snap.metals_value, snap.cash_value,
    snap.gain_loss, snap.return_pct, targetCurrency,
    snap.inflation_adjusted_value,
    snap.stocks_etfs_invested, snap.crypto_invested, snap.metals_invested,
    ...(includeFxNeutral ? [snap.value_fx_neutral] : []),
  ];
  const updateSet = columns
    .filter((c) => c !== 'snapshot_date' && c !== 'currency')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat('computed_at = NOW()')
    .join(', ');

  // Atomic replace: DELETE + INSERTs in one transaction so concurrent readers
  // (e.g. /api/info/net-worth during startup warmup) see either fully-old or
  // fully-new state via Postgres MVCC — never an empty/partial table.
  await withTransaction(async (client) => {
    await client.query('DELETE FROM portfolio_performance_snapshots WHERE currency = $1', [targetCurrency]);

    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
      const batch = snapshots.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      let p = 1;

      for (const snap of batch) {
        values.push(`(${columns.map(() => `$${p++}`).join(',')},NOW())`);
        params.push(...snapParams(snap));
      }

      await client.query(`
        INSERT INTO portfolio_performance_snapshots (${columns.join(', ')}, computed_at)
        VALUES ${values.join(', ')}
        ON CONFLICT (snapshot_date, currency) DO UPDATE SET ${updateSet}
      `, params);
    }

    // Persist the per-account holdings split (ADR-100) in the same transaction,
    // so getNetWorthByAccount reads it instead of replaying the full day-walk.
    if (includeAccountSplit) {
      const accountRows = await storeAccountSplit(client, snapshots, targetCurrency);
      logger.info('Per-account snapshot split stored', { rows: accountRows });
    }
  });

  logger.info('Portfolio performance snapshots stored', { count: snapshots.length });
  return snapshots;
}
