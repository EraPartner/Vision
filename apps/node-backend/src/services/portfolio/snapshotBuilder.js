/**
 * Snapshot Builder
 *
 * Walks days from first portfolio transaction to today, accumulates invested
 * capital and market values per asset class, applies inflation adjustment,
 * sanitizes spikes, and bulk-inserts the result into
 * portfolio_performance_snapshots.
 */

import { query } from '../../database/connection.js';
import { convertToCurrency } from '../currencyConversionService.js';
import { logger } from '../../config/logger.js';
import { sanitizeSnapshotSpikes } from '../../utils/portfolioMath.js';

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

  const firstDateYmd = firstDataDate instanceof Date
    ? firstDataDate.toISOString().split('T')[0]
    : String(firstDataDate).split('T')[0];

  const [
    unitInvestmentsResult,
    allTxResult,
    fixedIncomeResult,
    priceHistoryResult,
    inflationResult,
    fxResult,
  ] = await Promise.all([
    query(`
      SELECT id, COALESCE(currency, 'EUR') AS currency,
             COALESCE(current_price, 0) AS current_price, asset_class
      FROM investments
      WHERE is_active = true
        AND asset_class IN ('stock', 'etf', 'crypto', 'metals')
    `),
    query(`
      SELECT pt.investment_id,
             to_char(pt.date::date, 'YYYY-MM-DD') AS day,
             pt.type,
             COALESCE(pt.amount, 0) AS amount,
             COALESCE(pt.units, 0) AS units,
             COALESCE(pt.currency, i.currency, 'EUR') AS currency,
             pt.fx_rate_to_eur
      FROM portfolio_transactions pt
      JOIN investments i ON i.id = pt.investment_id
      WHERE pt.date >= $1::date AND pt.date <= CURRENT_DATE
      ORDER BY pt.date::date, pt.id
    `, [firstDateYmd]),
    query(`
      SELECT id, COALESCE(currency, 'EUR') AS currency,
             COALESCE(current_price, 0) AS current_price,
             COALESCE(created_at::date, $1::date)::text AS active_from
      FROM investments
      WHERE is_active = true
        AND asset_class IN ('real_estate', 'savings', 'bond')
    `, [firstDateYmd]),
    query(`
      SELECT investment_id, to_char(price_date, 'YYYY-MM-DD') AS day, close_price
      FROM asset_price_history
      WHERE price_date >= $1::date AND price_date <= CURRENT_DATE
      ORDER BY investment_id, price_date
    `, [firstDateYmd]),
    query(`
      SELECT to_char(month_date, 'YYYY-MM') AS month, monthly_rate
      FROM belgian_inflation_rates
      WHERE month_date >= $1::date
      ORDER BY month_date
    `, [firstDateYmd]),
    query(`SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true`)
      .catch(() => ({ rows: [] })),
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

  const fixedIncomeInvestments = fixedIncomeResult.rows.map(row => ({
    id: Number(row.id),
    currency: row.currency,
    currentPrice: Number(row.current_price) || 0,
    activeFrom: String(row.active_from).split('T')[0],
  }));

  // { investmentId: { day: price } }
  const priceHistoryByInvestment = {};
  for (const row of priceHistoryResult.rows) {
    const invId = Number(row.investment_id);
    if (!priceHistoryByInvestment[invId]) priceHistoryByInvestment[invId] = {};
    priceHistoryByInvestment[invId][row.day] = Number(row.close_price) || 0;
  }

  const inflationByMonth = new Map(
    inflationResult.rows.map(row => [row.month, Number(row.monthly_rate) || 0])
  );

  const fxRates = { EUR: 1 };
  for (const row of fxResult.rows) {
    fxRates[row.currency_code] = Number(row.rate_to_eur) || 1;
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
    });
  }

  // --- Day walk helpers ---

  function convertAmount(amount, fromCurrency, fxRateToEur) {
    const from = (fromCurrency || 'EUR').toUpperCase();
    const to = targetCurrency.toUpperCase();
    if (from === to) return amount;
    const rateTo = fxRates[to] || 1;
    if (fxRateToEur !== undefined && Number.isFinite(fxRateToEur) && fxRateToEur > 0) {
      return (amount * fxRateToEur) / rateTo;
    }
    return (amount * (fxRates[from] || 1)) / rateTo;
  }

  function resolvePrice(inv, day, lastKnownPrice) {
    const histPrices = priceHistoryByInvestment[inv.id] || {};
    if (histPrices[day]) return histPrices[day];

    let bestDay = '';
    for (const pDay of Object.keys(histPrices)) {
      if (pDay <= day && pDay > bestDay) bestDay = pDay;
    }
    if (bestDay) return histPrices[bestDay];
    if (lastKnownPrice[inv.id] > 0) return lastKnownPrice[inv.id];
    return inv.currentPrice;
  }

  // --- Main day loop ---

  const allDays = [];
  const today = new Date();
  for (let d = new Date(firstDateYmd); d <= today; d.setDate(d.getDate() + 1)) {
    allDays.push(d.toISOString().split('T')[0]);
  }

  const unitsByInvestment = {};
  let cumulativeInvested = 0;
  let stocksEtfsInvested = 0;
  let cryptoInvested = 0;
  let metalsInvested = 0;
  let cumulativeInflation = 1;
  let lastInflationMonth = '';
  const lastKnownPrice = {};
  const snapshots = [];

  for (const day of allDays) {
    // Apply transactions
    for (const tx of txByDay[day] || []) {
      const converted = convertAmount(tx.amount, tx.currency, tx.fxRateToEur);
      const inv = investmentsById.get(tx.investmentId);

      if (tx.type === 'buy' || tx.type === 'gift') {
        cumulativeInvested += converted;
        if (inv?.assetClass === 'stock' || inv?.assetClass === 'etf') stocksEtfsInvested += converted;
        else if (inv?.assetClass === 'crypto') cryptoInvested += converted;
        else if (inv?.assetClass === 'metals') metalsInvested += converted;
        unitsByInvestment[tx.investmentId] = (unitsByInvestment[tx.investmentId] || 0) + tx.units;
        if (tx.units > 0 && tx.amount > 0) lastKnownPrice[tx.investmentId] = tx.amount / tx.units;
      } else if (tx.type === 'sell') {
        cumulativeInvested -= converted;
        if (inv?.assetClass === 'stock' || inv?.assetClass === 'etf') stocksEtfsInvested -= converted;
        else if (inv?.assetClass === 'crypto') cryptoInvested -= converted;
        else if (inv?.assetClass === 'metals') metalsInvested -= converted;
        unitsByInvestment[tx.investmentId] = (unitsByInvestment[tx.investmentId] || 0) - tx.units;
        if (tx.units > 0 && tx.amount > 0) lastKnownPrice[tx.investmentId] = tx.amount / tx.units;
      }
      // income / dividends / fees / taxes: don't alter invested capital
    }

    // Compute portfolio value
    let totalValue = 0;
    let stocksEtfsValue = 0;
    let cryptoValue = 0;
    let metalsValue = 0;

    for (const inv of investmentsById.values()) {
      const units = unitsByInvestment[inv.id] || 0;
      if (units <= 0) continue;

      const price = resolvePrice(inv, day, lastKnownPrice);
      if (price <= 0) continue;

      // Forward-fill last known price
      if ((priceHistoryByInvestment[inv.id] || {})[day] > 0) {
        lastKnownPrice[inv.id] = priceHistoryByInvestment[inv.id][day];
      }

      const invValue = convertAmount(units * price, inv.currency);
      totalValue += invValue;
      if (inv.assetClass === 'stock' || inv.assetClass === 'etf') stocksEtfsValue += invValue;
      else if (inv.assetClass === 'crypto') cryptoValue += invValue;
      else if (inv.assetClass === 'metals') metalsValue += invValue;
    }

    // Fixed-income: use current_price from active_from onward
    let fixedIncomeValue = 0;
    for (const inv of fixedIncomeInvestments) {
      if (day < inv.activeFrom || inv.currentPrice <= 0) continue;
      fixedIncomeValue += convertAmount(inv.currentPrice, inv.currency);
    }
    totalValue += fixedIncomeValue;

    // Inflation compounding (once per calendar month)
    const monthKey = day.slice(0, 7);
    if (monthKey !== lastInflationMonth) {
      cumulativeInflation *= (1 + (inflationByMonth.get(monthKey) ?? 0));
      lastInflationMonth = monthKey;
    }

    snapshots.push({
      snapshot_date: day,
      invested: cumulativeInvested || 0,
      value: totalValue || 0,
      stocks_etfs_value: stocksEtfsValue || 0,
      crypto_value: cryptoValue || 0,
      metals_value: metalsValue || 0,
      cash_value: fixedIncomeValue || 0,
      stocks_etfs_invested: stocksEtfsInvested || 0,
      crypto_invested: cryptoInvested || 0,
      metals_invested: metalsInvested || 0,
      cumulative_inflation: Math.round((cumulativeInflation - 1) * 10000) / 100,
      inflation_adjusted_value: cumulativeInflation > 0
        ? totalValue / cumulativeInflation : totalValue,
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

  await query('DELETE FROM portfolio_performance_snapshots WHERE currency = $1', [targetCurrency]);

  for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
    const batch = snapshots.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let p = 1;

    for (const snap of batch) {
      values.push(
        `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW())`
      );
      params.push(
        snap.snapshot_date, snap.invested, snap.value,
        snap.stocks_etfs_value, snap.crypto_value, snap.metals_value, snap.cash_value,
        snap.gain_loss, snap.return_pct, targetCurrency,
        snap.inflation_adjusted_value,
        snap.stocks_etfs_invested, snap.crypto_invested, snap.metals_invested,
      );
    }

    await query(`
      INSERT INTO portfolio_performance_snapshots (
        snapshot_date, invested, value,
        stocks_etfs_value, crypto_value, metals_value, cash_value,
        gain_loss, return_pct, currency,
        inflation_adjusted_value,
        stocks_etfs_invested, crypto_invested, metals_invested,
        computed_at
      ) VALUES ${values.join(', ')}
      ON CONFLICT (snapshot_date) DO UPDATE SET
        invested                = EXCLUDED.invested,
        value                   = EXCLUDED.value,
        stocks_etfs_value       = EXCLUDED.stocks_etfs_value,
        crypto_value            = EXCLUDED.crypto_value,
        metals_value            = EXCLUDED.metals_value,
        cash_value              = EXCLUDED.cash_value,
        gain_loss               = EXCLUDED.gain_loss,
        return_pct              = EXCLUDED.return_pct,
        inflation_adjusted_value= EXCLUDED.inflation_adjusted_value,
        stocks_etfs_invested    = EXCLUDED.stocks_etfs_invested,
        crypto_invested         = EXCLUDED.crypto_invested,
        metals_invested         = EXCLUDED.metals_invested,
        computed_at             = NOW()
    `, params);
  }

  logger.info('Portfolio performance snapshots stored', { count: snapshots.length });
  return snapshots;
}
