/**
 * Portfolio Performance Snapshot Service
 * 
 * Computes and stores daily portfolio performance snapshots.
 * Uses asset_price_history for market prices, portfolio_transactions for flows,
 * and belgian_inflation_rates for inflation adjustment.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur, convertToCurrency } from '../services/currencyConversionService.js';
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

  // 3. Get fixed-income investments (real_estate, savings, bond) — value stored as current_price
  const fixedIncomeResult = await query(`
    SELECT
      i.id,
      COALESCE(i.currency, 'EUR') AS currency,
      COALESCE(i.current_price, 0) AS current_price,
      COALESCE(i.created_at::date, $1::date)::text AS active_from
    FROM investments i
    WHERE i.is_active = true
      AND i.asset_class IN ('real_estate', 'savings', 'bond')
  `, [firstDataDateYmd]);

  const fixedIncomeInvestments = fixedIncomeResult.rows.map(row => ({
    id: Number(row.id),
    currency: row.currency,
    currentPrice: Number(row.current_price) || 0,
    activeFrom: String(row.active_from).split('T')[0],
  }));

  // 4. Get price history from asset_price_history
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
  let stocksEtfsInvested = 0;
  let cryptoInvested = 0;
  let metalsInvested = 0;
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

    // Add fixed-income value (current_price applied from active_from date onward)
    let fixedIncomeValue = 0;
    for (const inv of fixedIncomeInvestments) {
      if (day < inv.activeFrom) continue;
      if (inv.currentPrice <= 0) continue;
      fixedIncomeValue += convertAmount(inv.currentPrice, inv.currency);
    }
    totalValue += fixedIncomeValue;

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
      cash_value: fixedIncomeValue || 0,
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
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW())`);
      params.push(
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
      );
    }

    await query(`
      INSERT INTO portfolio_performance_snapshots (
        snapshot_date, invested, value, stocks_etfs_value, crypto_value,
        metals_value, cash_value, gain_loss, return_pct, currency,
        inflation_adjusted_value, stocks_etfs_invested, crypto_invested,
        metals_invested, computed_at
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
        stocks_etfs_invested = EXCLUDED.stocks_etfs_invested,
        crypto_invested = EXCLUDED.crypto_invested,
        metals_invested = EXCLUDED.metals_invested,
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
      COALESCE(stocks_etfs_invested, 0) AS stocks_etfs_invested,
      COALESCE(crypto_invested, 0) AS crypto_invested,
      COALESCE(metals_invested, 0) AS metals_invested,
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

/**
 * Compute overall portfolio metrics from the full snapshot array.
 * Ported from PerformancePage.tsx overallMetrics useMemo.
 */
export function computeMetrics(snapshots) {
  if (!snapshots || snapshots.length < 1) return null;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  const firstDate = new Date(first.snapshot_date);
  const lastDate = new Date(last.snapshot_date);
  const days = Math.max(1, Math.round((lastDate - firstDate) / (1000 * 60 * 60 * 24)));

  const totalInvested = parseFloat(last.invested);
  const currentValue = parseFloat(last.value);
  const totalGainLoss = parseFloat(last.gain_loss);
  const inflationAdjustedValue = parseFloat(last.inflation_adjusted_value);

  const totalReturnPct = totalInvested > 0
    ? (totalGainLoss / totalInvested) * 100
    : 0;

  const years = days / 365.25;
  const annualizedReturn = totalInvested > 0 && years > 0 && currentValue > 0
    ? (Math.pow(currentValue / totalInvested, 1 / years) - 1) * 100
    : 0;

  const realReturnPct = totalInvested > 0
    ? ((inflationAdjustedValue - totalInvested) / totalInvested) * 100
    : 0;

  const cumulativeInflation = currentValue > 0 && inflationAdjustedValue > 0
    ? ((currentValue / inflationAdjustedValue) - 1) * 100
    : 0;

  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    currentValue: round2(currentValue),
    totalInvested: round2(totalInvested),
    totalGainLoss: round2(totalGainLoss),
    totalReturnPct: round2(totalReturnPct),
    annualizedReturn: round2(Number.isFinite(annualizedReturn) ? annualizedReturn : 0),
    realReturnPct: round2(realReturnPct),
    cumulativeInflation: Math.round(cumulativeInflation * 10) / 10,
  };
}

/**
 * Compute monthly returns heatmap from the full snapshot array.
 * Uses contribution-adjusted formula: change in value/invested ratio,
 * which isolates investment performance from cash flow effects.
 */
export function computeHeatmap(snapshots) {
  if (!snapshots || snapshots.length < 2) {
    return { years: [], data: {}, maxAbsPct: 0 };
  }

  // Group by month — take last snapshot of each month
  const byMonth = new Map();
  for (const s of snapshots) {
    const date = typeof s.snapshot_date === 'string' ? s.snapshot_date : s.snapshot_date.toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    byMonth.set(month, s);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const years = [...new Set(monthKeys.map(k => parseInt(k.slice(0, 4))))].sort();
  const data = {};
  const monthlyReturns = [];

  for (const year of years) {
    data[year] = Array(12).fill(null);
  }

  for (let i = 1; i < monthKeys.length; i++) {
    const prev = byMonth.get(monthKeys[i - 1]);
    const curr = byMonth.get(monthKeys[i]);
    const year = parseInt(monthKeys[i].slice(0, 4));
    const monthIdx = parseInt(monthKeys[i].slice(5, 7)) - 1;

    const prevValue = parseFloat(prev.value);
    const prevInvested = parseFloat(prev.invested);
    const currValue = parseFloat(curr.value);
    const currInvested = parseFloat(curr.invested);

    let monthlyReturn = null;
    if (prevInvested > 0 && currInvested > 0 && prevValue > 0) {
      // Contribution-adjusted: change in value-to-invested ratio
      // Cancels out cash flow effects (deposits/withdrawals)
      monthlyReturn = ((currValue / currInvested) / (prevValue / prevInvested) - 1) * 100;
    }

    const rounded = monthlyReturn !== null ? Math.round(monthlyReturn * 100) / 100 : null;
    data[year][monthIdx] = rounded;
    if (rounded !== null) {
      monthlyReturns.push(Math.abs(rounded));
    }
  }

  return {
    years,
    data,
    maxAbsPct: monthlyReturns.length > 0 ? Math.max(...monthlyReturns) : 0,
  };
}

/**
 * Calculate weighted average cost basis (FIFO-like weighted method).
 * Ported from usePortfolio.ts calculateCostBasis.
 */
function calculateCostBasis(txns) {
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  let totalUnits = 0;
  let totalCost = 0;
  let realizedGain = 0;
  let totalBuyCost = 0;
  let totalSellProceeds = 0;

  for (const txn of sorted) {
    const units = Number(txn.units) || 0;
    const amount = Number(txn.amount) || 0;
    const fees = Number(txn.fees) || 0;
    const taxes = Number(txn.taxes) || 0;

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount + fees + taxes;
      totalUnits += units;
      totalCost += buyCost;
      totalBuyCost += buyCost;
    } else if (txn.type === 'sell') {
      if (totalUnits > 0 && units > 0) {
        const sellUnits = Math.min(units, totalUnits);
        const sellRatio = units > 0 ? sellUnits / units : 0;
        const avgCost = totalCost / totalUnits;
        const costOfSoldUnits = avgCost * sellUnits;
        const netProceeds = (amount - fees - taxes) * sellRatio;
        realizedGain += netProceeds - costOfSoldUnits;
        totalUnits -= sellUnits;
        totalCost -= costOfSoldUnits;
        totalSellProceeds += amount;
      }
    }
  }

  return {
    totalUnits: Math.max(0, totalUnits),
    totalCost: Math.max(0, totalCost),
    avgCostBasis: totalUnits > 0 ? totalCost / totalUnits : 0,
    realizedGain,
    totalBuyCost,
    totalSellProceeds,
  };
}

/**
 * Calculate accrued interest for fixed income assets.
 * Ported from usePortfolio.ts calculateAccruedInterest.
 */
function calculateAccruedInterest(txns, principal, interestRate) {
  if (!interestRate || principal <= 0) return 0;

  const sortedDesc = [...txns].sort((a, b) => b.date.localeCompare(a.date));
  const lastInterestTxn = sortedDesc.find(t => t.type === 'interest');
  const firstBuyTxn = [...txns]
    .filter(t => t.type === 'buy')
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const startDate = lastInterestTxn?.date || firstBuyTxn?.date;
  if (!startDate) return 0;

  const start = new Date(startDate);
  const now = new Date();
  const daysSinceStart = Math.max(0, (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

  const dailyRate = interestRate / 100 / 365;
  return principal * dailyRate * daysSinceStart;
}

/**
 * Get per-investment breakdown summary with all values in target currency.
 * Replaces the frontend's usePortfolio() + exchange-rates fetch waterfall.
 */
export async function getBreakdownSummary(targetCurrency = 'EUR') {
  // 1. Fetch all active investments
  const investmentsResult = await query(`
    SELECT id, name, symbol, asset_class, COALESCE(currency, 'EUR') AS currency,
           COALESCE(current_price, 0) AS current_price,
           COALESCE(interest_rate, 0) AS interest_rate,
           is_active
    FROM investments
    WHERE is_active = true
    ORDER BY name
  `);

  // 2. Fetch all portfolio transactions
  const txnResult = await query(`
    SELECT pt.id, pt.investment_id, pt.type,
           COALESCE(pt.amount, 0) AS amount,
           COALESCE(pt.units, 0) AS units,
           COALESCE(pt.fees, 0) AS fees,
           COALESCE(pt.taxes, 0) AS taxes,
           to_char(pt.date::date, 'YYYY-MM-DD') AS date,
           COALESCE(pt.currency, i.currency, 'EUR') AS currency
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE i.is_active = true
    ORDER BY pt.date
  `);

  const investments = investmentsResult.rows;
  const transactions = txnResult.rows;

  // Group transactions by investment_id
  const txnsByInvestment = new Map();
  for (const txn of transactions) {
    const id = Number(txn.investment_id);
    if (!txnsByInvestment.has(id)) txnsByInvestment.set(id, []);
    txnsByInvestment.get(id).push(txn);
  }

  const summaries = [];

  for (const inv of investments) {
    const txns = txnsByInvestment.get(Number(inv.id)) ?? [];
    const isUnitBased = ['stock', 'etf', 'crypto', 'metals'].includes(inv.asset_class);
    const isFixedIncome = ['savings', 'bond'].includes(inv.asset_class);
    const isRealEstate = inv.asset_class === 'real_estate';

    let totalDividends = 0;
    let totalInterestPaid = 0;
    let totalRent = 0;
    let totalAppreciation = 0;
    let totalBuyAmount = 0;
    let totalBuyOrGiftAmount = 0;
    let totalSellAmount = 0;
    let feeTxnAmount = 0;
    let taxTxnAmount = 0;
    let feesFieldAmount = 0;
    let taxesFieldAmount = 0;

    for (const txn of txns) {
      const amount = Number(txn.amount) || 0;
      const fees = Number(txn.fees) || 0;
      const taxes = Number(txn.taxes) || 0;
      feesFieldAmount += fees;
      taxesFieldAmount += taxes;

      if (txn.type === 'buy') { totalBuyAmount += amount; totalBuyOrGiftAmount += amount; }
      else if (txn.type === 'gift') { totalBuyOrGiftAmount += amount; }
      else if (txn.type === 'sell') { totalSellAmount += amount; }
      else if (txn.type === 'fee') { feeTxnAmount += amount; }
      else if (txn.type === 'tax') { taxTxnAmount += amount; }
      else if (txn.type === 'dividend') { totalDividends += amount; }
      else if (txn.type === 'interest') { totalInterestPaid += amount; }
      else if (txn.type === 'rent_income') { totalRent += amount; }
      else if (txn.type === 'appreciation') { totalAppreciation += amount; }
    }

    const totalFees = feeTxnAmount + feesFieldAmount;
    const totalTaxes = taxTxnAmount + taxesFieldAmount;

    let currentValue = 0;
    let totalInvested = 0;
    let realizedGain = 0;
    let unrealizedGain = 0;
    let totalBuyCost = 0;

    if (isUnitBased) {
      const costBasis = calculateCostBasis(txns);
      const currentPrice = Number(inv.current_price) || 0;
      currentValue = costBasis.totalUnits * currentPrice;
      totalInvested = costBasis.totalCost;
      realizedGain = costBasis.realizedGain;
      unrealizedGain = costBasis.totalUnits > 0
        ? (currentPrice - costBasis.avgCostBasis) * costBasis.totalUnits : 0;
      totalBuyCost = costBasis.totalBuyCost;
    } else if (isFixedIncome) {
      totalInvested = totalBuyOrGiftAmount - totalSellAmount;
      totalBuyCost = totalBuyOrGiftAmount;
      const interestRate = Number(inv.interest_rate) || 0;
      const accruedInterest = calculateAccruedInterest(txns, totalInvested, interestRate);
      currentValue = totalInvested + accruedInterest;
      realizedGain = totalInterestPaid;
      unrealizedGain = accruedInterest;
    } else if (isRealEstate) {
      totalInvested = totalBuyAmount - totalSellAmount;
      totalBuyCost = totalBuyAmount;
      currentValue = totalInvested + totalAppreciation;
      unrealizedGain = totalAppreciation;
      realizedGain = totalRent - totalFees - totalTaxes;
    } else {
      totalInvested = totalBuyAmount - totalSellAmount;
      currentValue = totalInvested;
      totalBuyCost = totalBuyAmount;
    }

    const totalIncome = totalDividends + totalInterestPaid + totalRent;
    const totalGain = realizedGain + unrealizedGain;
    const gainLoss = totalGain + totalIncome - totalFees - totalTaxes;
    const gainLossPercent = totalBuyCost > 0 ? (gainLoss / totalBuyCost) * 100 : 0;

    // Convert to target currency
    const invCurrency = (inv.currency || 'EUR').toUpperCase();
    const convert = invCurrency !== targetCurrency.toUpperCase()
      ? (v) => convertToCurrency(v, invCurrency, targetCurrency)
      : (v) => Promise.resolve(v);

    summaries.push({
      id: Number(inv.id),
      name: inv.name,
      symbol: inv.symbol,
      assetClass: inv.asset_class,
      currency: inv.currency,
      currentValue: Math.round(await convert(currentValue) * 100) / 100,
      totalInvested: Math.round(await convert(Math.abs(totalInvested)) * 100) / 100,
      gainLoss: Math.round(await convert(gainLoss) * 100) / 100,
      gainLossPercent: Math.round(gainLossPercent * 100) / 100,
    });
  }

  return summaries;
}

export default {
  computeAndStoreSnapshots,
  getSnapshots,
  getLatestSnapshot,
  computeMetrics,
  computeHeatmap,
  getBreakdownSummary,
};
