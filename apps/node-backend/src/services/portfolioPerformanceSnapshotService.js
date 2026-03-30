/**
 * Portfolio Performance Snapshot Service
 * 
 * Computes and stores daily portfolio performance snapshots.
 * Uses asset_price_history for market prices, portfolio_transactions for flows,
 * and belgian_inflation_rates for inflation adjustment.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currencyConversionService.js';
import { logger } from '../config/logger.js';

function sanitizeIsolatedDailySpikes(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 3) return Array.isArray(snapshots) ? snapshots : [];

  const sanitized = snapshots.map((s) => ({ ...s }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);

  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = Number(sanitized[i - 1]?.value);
    const current = Number(sanitized[i]?.value);
    const next = Number(sanitized[i + 1]?.value);

    if (!Number.isFinite(prev) || !Number.isFinite(current) || !Number.isFinite(next)) continue;
    if (prev <= 0 || current <= 0 || next <= 0) continue;

    const jump = Math.log(current / prev);
    const revert = Math.log(next / current);
    const bridge = Math.log(next / prev);

    const oppositeDirections = (jump > 0 && revert < 0) || (jump < 0 && revert > 0);
    const largeMove = Math.abs(jump) >= minJump && Math.abs(revert) >= minJump;
    const bridgeLooksNormal = Math.abs(bridge) <= neighborTolerance;

    const maxNeighbor = Math.max(prev, next);
    const minNeighbor = Math.min(prev, next);
    const localNeedleRatio = 1.8;
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor;

    if ((oppositeDirections && largeMove && bridgeLooksNormal) || localNeedlePeak || localNeedleTrough) {
      const geoMean = (a, b) => {
        const va = Number(a) || 0;
        const vb = Number(b) || 0;
        return va > 0 && vb > 0 ? Math.sqrt(va * vb) : (va + vb) / 2;
      };
      sanitized[i].value = geoMean(prev, next);
      sanitized[i].stocks_etfs_value = geoMean(
        sanitized[i - 1]?.stocks_etfs_value, sanitized[i + 1]?.stocks_etfs_value
      );
      sanitized[i].crypto_value = geoMean(
        sanitized[i - 1]?.crypto_value, sanitized[i + 1]?.crypto_value
      );
      sanitized[i].metals_value = geoMean(
        sanitized[i - 1]?.metals_value, sanitized[i + 1]?.metals_value
      );
    }
  }

  return sanitized;
}

async function getFirstDataDate() {
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
  return result.rows[0]?.first_data_date;
}

async function computeDailySnapshots(targetCurrency = 'EUR') {
  const firstDataDate = await getFirstDataDate();
  if (!firstDataDate) {
    logger.info('No portfolio data available for snapshots');
    return [];
  }

  const firstDataDateYmd = firstDataDate instanceof Date
    ? firstDataDate.toISOString().split('T')[0]
    : String(firstDataDate).split('T')[0];

  // 1. Get all unit-based investments
  const unitInvestmentsResult = await query(`
    SELECT
      i.id,
      COALESCE(i.currency, 'EUR') AS currency,
      COALESCE(i.current_price, 0) AS current_price,
      i.asset_class
    FROM investments i
    WHERE i.is_active = true
      AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
  `);

  // 2. Get ALL portfolio transactions (for invested capital tracking)
  const allTxResult = await query(`
    SELECT
      pt.investment_id,
      to_char(pt.date::date, 'YYYY-MM-DD') AS day,
      pt.type,
      COALESCE(pt.amount, 0) AS amount,
      COALESCE(pt.units, 0) AS units,
      COALESCE(pt.currency, i.currency, 'EUR') AS currency,
      pt.fx_rate_to_eur
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE pt.date >= $1::date
      AND pt.date <= CURRENT_DATE
    ORDER BY pt.date::date, pt.id
  `, [firstDataDateYmd]);

  // 3. Get price history from asset_price_history
  const priceHistoryResult = await query(`
    SELECT
      investment_id,
      to_char(price_date, 'YYYY-MM-DD') AS day,
      close_price
    FROM asset_price_history
    WHERE price_date >= $1::date
      AND price_date <= CURRENT_DATE
    ORDER BY investment_id, price_date
  `, [firstDataDateYmd]);

  // 4. Get inflation rates
  const inflationResult = await query(`
    SELECT
      to_char(month_date, 'YYYY-MM') AS month,
      monthly_rate
    FROM belgian_inflation_rates
    WHERE month_date >= $1::date
    ORDER BY month_date
  `, [firstDataDateYmd]);

  // Build lookup maps
  const investmentsById = new Map();
  for (const row of unitInvestmentsResult.rows) {
    investmentsById.set(Number(row.id), {
      id: Number(row.id),
      currency: row.currency,
      currentPrice: Number(row.current_price) || 0,
      assetClass: row.asset_class,
    });
  }

  // Price history: { investmentId: { day: price } }
  const priceHistoryByInvestment = {};
  for (const row of priceHistoryResult.rows) {
    const invId = Number(row.investment_id);
    if (!priceHistoryByInvestment[invId]) priceHistoryByInvestment[invId] = {};
    priceHistoryByInvestment[invId][row.day] = Number(row.close_price) || 0;
  }

  // Inflation: { month: rate }
  const inflationByMonth = new Map();
  for (const row of inflationResult.rows) {
    inflationByMonth.set(row.month, Number(row.monthly_rate) || 0);
  }

  // Group transactions by day
  const txByDay = {};
  for (const row of allTxResult.rows) {
    if (!txByDay[row.day]) txByDay[row.day] = [];
    txByDay[row.day].push({
      investmentId: Number(row.investment_id),
      type: row.type,
      amount: Number(row.amount) || 0,
      units: Number(row.units) || 0,
      currency: row.currency,
      fxRateToEur: row.fx_rate_to_eur ? Number(row.fx_rate_to_eur) : undefined,
    });
  }

  // Build FX rates lookup for currency conversion
  let fxRates = {};
  try {
    const fxResult = await query(`
      SELECT currency_code, rate_to_eur
      FROM exchange_rates
      WHERE is_latest = true
    `);
    for (const row of fxResult.rows) {
      fxRates[row.currency_code] = Number(row.rate_to_eur) || 1;
    }
  } catch { /* ignore */ }
  fxRates['EUR'] = 1;

  function convertAmount(amount, fromCurrency, fxRateToEur) {
    const from = (fromCurrency || 'EUR').toUpperCase();
    const to = targetCurrency.toUpperCase();
    if (from === to) return amount;
    const rateTo = fxRates[to] || 1;

    if (fxRateToEur !== undefined && Number.isFinite(fxRateToEur) && fxRateToEur > 0) {
      return (amount * fxRateToEur) / rateTo;
    }

    const rateFrom = fxRates[from] || 1;
    return (amount * rateFrom) / rateTo;
  }

  // Generate all days
  const allDays = [];
  const currentDate = new Date();
  const startDate = new Date(firstDataDateYmd);
  for (let d = new Date(startDate); d <= currentDate; d.setDate(d.getDate() + 1)) {
    allDays.push(d.toISOString().split('T')[0]);
  }

  // State tracking
  const unitsByInvestment = {};  // investmentId -> cumulative units
  let cumulativeInvested = 0;     // cumulative capital deployed (buys - sells)
  let cumulativeInflation = 1;
  let lastInflationMonth = '';
  const lastKnownPrice = {};      // investmentId -> last known price

  const snapshots = [];

  for (const day of allDays) {
    // Process transactions for this day
    const dayTxs = txByDay[day] || [];
    for (const tx of dayTxs) {
      const converted = convertAmount(tx.amount, tx.currency, tx.fxRateToEur);

      if (tx.type === 'buy' || tx.type === 'gift') {
        cumulativeInvested += converted;
        const inv = investmentsById.get(tx.investmentId);
        if (inv) {
          if (inv.assetClass === 'stock' || inv.assetClass === 'etf') stocksEtfsInvested += converted;
          else if (inv.assetClass === 'crypto') cryptoInvested += converted;
          else if (inv.assetClass === 'metals') metalsInvested += converted;
        }
        unitsByInvestment[tx.investmentId] = (unitsByInvestment[tx.investmentId] || 0) + tx.units;
        if (tx.units > 0 && tx.amount > 0) {
          lastKnownPrice[tx.investmentId] = tx.amount / tx.units;
        }
      } else if (tx.type === 'sell') {
        cumulativeInvested -= converted;
        const inv = investmentsById.get(tx.investmentId);
        if (inv) {
          if (inv.assetClass === 'stock' || inv.assetClass === 'etf') stocksEtfsInvested -= converted;
          else if (inv.assetClass === 'crypto') cryptoInvested -= converted;
          else if (inv.assetClass === 'metals') metalsInvested -= converted;
        }
        unitsByInvestment[tx.investmentId] = (unitsByInvestment[tx.investmentId] || 0) - tx.units;
        if (tx.units > 0 && tx.amount > 0) {
          lastKnownPrice[tx.investmentId] = tx.amount / tx.units;
        }
      }
      // income/dividends/fees/taxes don't change invested capital
    }

    // Compute portfolio value using market prices
    let totalValue = 0;
    let stocksEtfsValue = 0;
    let cryptoValue = 0;
    let metalsValue = 0;

    for (const inv of investmentsById.values()) {
      const units = unitsByInvestment[inv.id] || 0;
      if (units <= 0) continue;

      // Find price: historical > last known from earlier days > last tx price > current price
      let price = 0;
      const histPrices = priceHistoryByInvestment[inv.id] || {};

      if (histPrices[day]) {
        price = histPrices[day];
      } else {
        // Find most recent historical price before this day
        let bestDay = '';
        for (const pDay of Object.keys(histPrices)) {
          if (pDay <= day && pDay > bestDay) bestDay = pDay;
        }
        if (bestDay) {
          price = histPrices[bestDay];
        }
      }

      if (price <= 0 && lastKnownPrice[inv.id] > 0) {
        price = lastKnownPrice[inv.id];
      }
      if (price <= 0) {
        price = inv.currentPrice;
      }
      if (price <= 0) continue;

      // Update last known for forward-fill
      if (histPrices[day] && histPrices[day] > 0) {
        lastKnownPrice[inv.id] = histPrices[day];
      }

      const invValue = convertAmount(units * price, inv.currency);
      totalValue += invValue;

      if (inv.assetClass === 'stock' || inv.assetClass === 'etf') {
        stocksEtfsValue += invValue;
      } else if (inv.assetClass === 'crypto') {
        cryptoValue += invValue;
      } else if (inv.assetClass === 'metals') {
        metalsValue += invValue;
      }
    }

    // Apply monthly inflation
    const monthKey = day.slice(0, 7);
    if (monthKey !== lastInflationMonth) {
      const monthlyRate = inflationByMonth.get(monthKey) ?? 0;
      cumulativeInflation *= (1 + monthlyRate);
      lastInflationMonth = monthKey;
    }

    const inflationAdjustedValue = cumulativeInflation > 0 ? totalValue / cumulativeInflation : totalValue;

    snapshots.push({
      snapshot_date: day,
      invested: cumulativeInvested || 0,
      value: totalValue || 0,
      stocks_etfs_value: stocksEtfsValue || 0,
      crypto_value: cryptoValue || 0,
      metals_value: metalsValue || 0,
      stocks_etfs_invested: stocksEtfsInvested || 0,
      crypto_invested: cryptoInvested || 0,
      metals_invested: metalsInvested || 0,
      inflation_adjusted_value: inflationAdjustedValue || 0,
      cumulative_inflation: Math.round((cumulativeInflation - 1) * 10000) / 100,
    });
  }

  // Sanitize isolated spikes (Kinesis needle issue)
  const sanitized = sanitizeIsolatedDailySpikes(snapshots);

  // Compute gain/loss after sanitization
  for (const snap of sanitized) {
    snap.gain_loss = snap.value - snap.invested;
    snap.return_pct = snap.invested > 0 ? ((snap.value - snap.invested) / snap.invested) * 100 : 0;
    snap.inflation_adjusted_value = snap.value / (1 + snap.cumulative_inflation / 100) || snap.value;
  }

  return sanitized;
}

export async function computeAndStoreSnapshots(targetCurrency = 'EUR') {
  logger.info('Computing portfolio performance snapshots...');

  const snapshots = await computeDailySnapshots(targetCurrency);

  if (snapshots.length === 0) {
    logger.info('No snapshots to store');
    return [];
  }

  await query('DELETE FROM portfolio_performance_snapshots WHERE currency = $1', [targetCurrency]);

  // Batch insert for performance
  const BATCH_SIZE = 500;
  for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
    const batch = snapshots.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const snap of batch) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW())`);
      params.push(
        snap.snapshot_date,
        snap.invested,
        snap.value,
        snap.stocks_etfs_value,
        snap.crypto_value,
        snap.metals_value,
        0, // cash_value (deprecated)
        snap.gain_loss,
        snap.return_pct,
        targetCurrency,
        snap.inflation_adjusted_value,
      );
    }

    await query(`
      INSERT INTO portfolio_performance_snapshots (
        snapshot_date, invested, value, stocks_etfs_value, crypto_value,
        metals_value, cash_value, gain_loss, return_pct, currency,
        inflation_adjusted_value, computed_at
      ) VALUES ${values.join(', ')}
      ON CONFLICT (snapshot_date) DO UPDATE SET
        invested = EXCLUDED.invested,
        value = EXCLUDED.value,
        stocks_etfs_value = EXCLUDED.stocks_etfs_value,
        crypto_value = EXCLUDED.crypto_value,
        metals_value = EXCLUDED.metals_value,
        cash_value = EXCLUDED.cash_value,
        gain_loss = EXCLUDED.gain_loss,
        return_pct = EXCLUDED.return_pct,
        inflation_adjusted_value = EXCLUDED.inflation_adjusted_value,
        computed_at = NOW()
    `, params);
  }

  logger.info('Portfolio performance snapshots stored', { count: snapshots.length });
  return snapshots;
}

export async function getSnapshots(startDate, endDate, currency = 'EUR') {
  const result = await query(`
    SELECT
      snapshot_date,
      invested,
      value,
      stocks_etfs_value,
      crypto_value,
      metals_value,
      cash_value,
      gain_loss,
      return_pct,
      COALESCE(inflation_adjusted_value, value) AS inflation_adjusted_value,
      currency
    FROM portfolio_performance_snapshots
    WHERE currency = $1
      AND snapshot_date >= $2
      AND snapshot_date <= $3
    ORDER BY snapshot_date ASC
  `, [currency, startDate, endDate]);

  return result.rows;
}

export async function getLatestSnapshot(currency = 'EUR') {
  const result = await query(`
    SELECT * FROM portfolio_performance_snapshots
    WHERE currency = $1
    ORDER BY snapshot_date DESC
    LIMIT 1
  `, [currency]);

  return result.rows[0] || null;
}

export default {
  computeAndStoreSnapshots,
  getSnapshots,
  getLatestSnapshot,
};
