/**
 * Portfolio Performance Snapshot Service
 * 
 * Computes and stores daily portfolio performance snapshots for the performance page.
 * This pre-computes data that was previously calculated client-side.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currencyConversionService.js';
import { logger } from '../config/logger.js';

function sanitizeIsolatedDailySpikes(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 3) return Array.isArray(snapshots) ? snapshots : [];

  const sanitized = snapshots.map((snapshot) => ({ ...snapshot }));
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
      sanitized[i].value = Math.sqrt(prev * next);
      sanitized[i].stocks_etfs_value = Math.sqrt(
        Number(sanitized[i - 1]?.stocks_etfs_value || 0) * Number(sanitized[i + 1]?.stocks_etfs_value || 0)
      ) || 0;
      sanitized[i].crypto_value = Math.sqrt(
        Number(sanitized[i - 1]?.crypto_value || 0) * Number(sanitized[i + 1]?.crypto_value || 0)
      ) || 0;
      sanitized[i].metals_value = Math.sqrt(
        Number(sanitized[i - 1]?.metals_value || 0) * Number(sanitized[i + 1]?.metals_value || 0)
      ) || 0;
      sanitized[i].cash_value = Math.sqrt(
        Number(sanitized[i - 1]?.cash_value || 0) * Number(sanitized[i + 1]?.cash_value || 0)
      ) || 0;
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

  const cashFlowsResult = await query(`
    WITH bounds AS (
      SELECT $1::date AS start_date, CURRENT_DATE AS end_date
    ),
    days AS (
      SELECT generate_series(start_date, end_date, interval '1 day')::date AS day
      FROM bounds
    ),
    currencies AS (
      SELECT DISTINCT COALESCE(currency, 'EUR') AS currency
      FROM portfolio_transactions
    ),
    tx_daily AS (
      SELECT
        pt.date::date AS day,
        COALESCE(pt.currency, 'EUR') AS currency,
        COALESCE(SUM(CASE WHEN pt.type IN ('buy', 'gift') THEN pt.amount ELSE 0 END), 0) AS buys,
        COALESCE(SUM(CASE WHEN pt.type = 'sell' THEN pt.amount ELSE 0 END), 0) AS sells,
        COALESCE(SUM(CASE WHEN pt.type IN ('dividend', 'interest', 'rent_income') THEN pt.amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN pt.type = 'appreciation' THEN pt.amount ELSE 0 END), 0) AS appreciation,
        COALESCE(SUM(CASE WHEN pt.type = 'fee' THEN pt.amount ELSE 0 END), 0) AS fees,
        COALESCE(SUM(CASE WHEN pt.type = 'tax' THEN pt.amount ELSE 0 END), 0) AS taxes
      FROM portfolio_transactions pt
      LEFT JOIN investments i ON i.id = pt.investment_id
      WHERE pt.date >= (SELECT start_date FROM bounds)
        AND pt.date <= (SELECT end_date FROM bounds)
        AND (
          i.id IS NULL
          OR i.asset_class NOT IN ('stock', 'etf', 'crypto', 'metals')
        )
      GROUP BY pt.date::date, COALESCE(pt.currency, 'EUR')
    ),
    tx_series AS (
      SELECT
        d.day,
        c.currency,
        COALESCE(td.buys, 0) AS buys,
        COALESCE(td.sells, 0) AS sells,
        COALESCE(td.income, 0) AS income,
        COALESCE(td.appreciation, 0) AS appreciation,
        COALESCE(td.fees, 0) AS fees,
        COALESCE(td.taxes, 0) AS taxes
      FROM days d
      CROSS JOIN currencies c
      LEFT JOIN tx_daily td ON td.day = d.day AND td.currency = c.currency
    ),
    tx_cumulative AS (
      SELECT
        day,
        currency,
        SUM(buys) OVER (PARTITION BY currency ORDER BY day) AS cum_buys,
        SUM(sells) OVER (PARTITION BY currency ORDER BY day) AS cum_sells,
        SUM(income) OVER (PARTITION BY currency ORDER BY day) AS cum_income,
        SUM(appreciation) OVER (PARTITION BY currency ORDER BY day) AS cum_appreciation,
        SUM(fees) OVER (PARTITION BY currency ORDER BY day) AS cum_fees,
        SUM(taxes) OVER (PARTITION BY currency ORDER BY day) AS cum_taxes
      FROM tx_series
    )
    SELECT
      to_char(day, 'YYYY-MM-DD') AS day,
      currency,
      (cum_buys - cum_sells + cum_income + cum_appreciation - cum_fees - cum_taxes) AS value
    FROM tx_cumulative
    ORDER BY day, currency
  `, [firstDataDateYmd]);

  const cashFlowsConverted = await convertRowsToEur(
    cashFlowsResult.rows.map(r => ({
      ...r,
      amount: parseFloat(r.value || 0),
    })),
    targetCurrency,
    { useHistoricalRatesByDate: true, dateField: 'day' }
  );

  const cashByDay = {};
  for (const row of cashFlowsConverted) {
    const key = row.day;
    if (!cashByDay[key]) cashByDay[key] = 0;
    cashByDay[key] += row.amount_eur;
  }

  const unitInvestmentsResult = await query(`
    SELECT
      i.id,
      COALESCE(i.currency, 'EUR') AS currency,
      COALESCE(i.current_price, 0) AS current_price,
      COALESCE(i.price_provider, 'manual') AS price_provider,
      i.price_provider_id,
      i.symbol,
      i.asset_class,
      MIN(pt.date)::date AS first_tx_date,
      COALESCE(i.created_at::date, MIN(pt.date)::date, $1::date) AS created_date
    FROM investments i
    LEFT JOIN portfolio_transactions pt
      ON pt.investment_id = i.id
      AND pt.date >= $1::date
      AND pt.date <= CURRENT_DATE
    WHERE i.is_active = true
      AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
    GROUP BY
      i.id,
      i.currency,
      i.current_price,
      i.price_provider,
      i.price_provider_id,
      i.symbol,
      i.asset_class,
      i.created_at
  `, [firstDataDateYmd]);

  const unitDeltasResult = await query(`
    SELECT
      pt.investment_id,
      to_char(pt.date::date, 'YYYY-MM-DD') AS day,
      COALESCE(SUM(
        CASE
          WHEN pt.type IN ('buy', 'gift') THEN COALESCE(pt.units, 0)
          WHEN pt.type = 'sell' THEN -COALESCE(pt.units, 0)
          ELSE 0
        END
      ), 0) AS unit_delta
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE i.is_active = true
      AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
      AND pt.date >= $1::date
      AND pt.date <= CURRENT_DATE
      AND pt.type IN ('buy', 'gift', 'sell')
    GROUP BY pt.investment_id, pt.date::date
    ORDER BY pt.investment_id, pt.date::date
  `, [firstDataDateYmd]);

  const unitDeltasByInvestment = {};
  for (const row of unitDeltasResult.rows) {
    const investmentId = Number(row.investment_id);
    if (!unitDeltasByInvestment[investmentId]) unitDeltasByInvestment[investmentId] = {};
    unitDeltasByInvestment[investmentId][row.day] = Number(row.unit_delta) || 0;
  }

  const unitPriceByInvestmentDateResult = await query(`
    SELECT
      pt.investment_id,
      to_char(pt.date::date, 'YYYY-MM-DD') AS day,
      COALESCE(
        NULLIF(
          SUM(
            CASE
              WHEN COALESCE(pt.units, 0) > 0
                AND COALESCE(
                  NULLIF(pt.price_per_unit, 0),
                  NULLIF(pt.amount, 0) / NULLIF(pt.units, 0),
                  0
                ) > 0
              THEN
                COALESCE(
                  NULLIF(pt.price_per_unit, 0),
                  NULLIF(pt.amount, 0) / NULLIF(pt.units, 0),
                  0
                ) * COALESCE(pt.units, 0)
              ELSE 0
            END
          ),
          0
        ) / NULLIF(
          SUM(
            CASE
              WHEN COALESCE(pt.units, 0) > 0
                AND COALESCE(
                  NULLIF(pt.price_per_unit, 0),
                  NULLIF(pt.amount, 0) / NULLIF(pt.units, 0),
                  0
                ) > 0
              THEN COALESCE(pt.units, 0)
              ELSE 0
            END
          ),
          0
        ),
        0
      ) AS unit_price
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE i.is_active = true
      AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
      AND pt.date >= $1::date
      AND pt.date <= CURRENT_DATE
      AND pt.type IN ('buy', 'gift', 'sell')
    GROUP BY pt.investment_id, pt.date::date
    ORDER BY pt.investment_id, pt.date::date
  `, [firstDataDateYmd]);

  const unitPriceByInvestment = {};
  for (const row of unitPriceByInvestmentDateResult.rows) {
    const investmentId = Number(row.investment_id);
    if (!unitPriceByInvestment[investmentId]) unitPriceByInvestment[investmentId] = {};
    unitPriceByInvestment[investmentId][row.day] = Number(row.unit_price) || 0;
  }

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

  const priceHistoryByInvestment = {};
  for (const row of priceHistoryResult.rows) {
    const investmentId = Number(row.investment_id);
    if (!priceHistoryByInvestment[investmentId]) priceHistoryByInvestment[investmentId] = {};
    priceHistoryByInvestment[investmentId][row.day] = Number(row.close_price) || 0;
  }

  const investments = unitInvestmentsResult.rows.map(row => ({
    id: Number(row.id),
    currency: row.currency,
    currentPrice: Number(row.current_price) || 0,
    priceProvider: row.price_provider,
    priceProviderId: row.price_provider_id,
    symbol: row.symbol,
    assetClass: row.asset_class,
    firstTxDate: row.first_tx_date,
    createdDate: row.created_date,
  }));

  const allDays = [];
  const currentDate = new Date();
  const startDate = new Date(firstDataDateYmd);
  for (let d = new Date(startDate); d <= currentDate; d.setDate(d.getDate() + 1)) {
    allDays.push(d.toISOString().split('T')[0]);
  }

  const snapshots = [];

  for (const day of allDays) {
    let invested = 0;
    let value = 0;
    let stocksEtfsValue = 0;
    let cryptoValue = 0;
    let metalsValue = 0;
    let cashValue = cashByDay[day] || 0;

    for (const inv of investments) {
      const startInvDate = inv.createdDate instanceof Date
        ? inv.createdDate.toISOString().split('T')[0]
        : String(inv.createdDate).split('T')[0];

      if (day < startInvDate) continue;

      let units = 0;
      const deltas = unitDeltasByInvestment[inv.id] || {};
      for (const [txDay, delta] of Object.entries(deltas)) {
        if (txDay <= day) units += delta;
      }

      if (units <= 0) continue;

      let price = 0;
      const historicalPrices = priceHistoryByInvestment[inv.id] || {};
      const txPrices = unitPriceByInvestment[inv.id] || {};

      if (historicalPrices[day]) {
        price = historicalPrices[day];
      } else {
        let lastKnownPrice = 0;
        for (const [pDay, pVal] of Object.entries(historicalPrices)) {
          if (pDay <= day) lastKnownPrice = pVal;
        }
        if (lastKnownPrice > 0) {
          price = lastKnownPrice;
        } else {
          let lastTxPrice = 0;
          for (const [tDay, tVal] of Object.entries(txPrices)) {
            if (tDay <= day) lastTxPrice = tVal;
          }
          price = lastTxPrice;
        }
      }

      const invValue = units * price;
      value += invValue;
      invested += units * price;

      if (inv.assetClass === 'stock' || inv.assetClass === 'etf') {
        stocksEtfsValue += invValue;
      } else if (inv.assetClass === 'crypto') {
        cryptoValue += invValue;
      } else if (inv.assetClass === 'metals') {
        metalsValue += invValue;
      }
    }

    invested += cashValue;
    value += cashValue;

    snapshots.push({
      snapshot_date: day,
      invested: invested || 0,
      value: value || 0,
      stocks_etfs_value: stocksEtfsValue || 0,
      crypto_value: cryptoValue || 0,
      metals_value: metalsValue || 0,
      cash_value: cashValue || 0,
    });
  }

  const sanitized = sanitizeIsolatedDailySpikes(snapshots);

  for (const snap of sanitized) {
    snap.gain_loss = snap.value - snap.invested;
    snap.return_pct = snap.invested > 0 ? ((snap.value - snap.invested) / snap.invested) * 100 : 0;
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

  for (const snap of snapshots) {
    await query(`
      INSERT INTO portfolio_performance_snapshots (
        snapshot_date, invested, value, stocks_etfs_value, crypto_value,
        metals_value, cash_value, gain_loss, return_pct, currency, computed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (snapshot_date) DO UPDATE SET
        invested = EXCLUDED.invested,
        value = EXCLUDED.value,
        stocks_etfs_value = EXCLUDED.stocks_etfs_value,
        crypto_value = EXCLUDED.crypto_value,
        metals_value = EXCLUDED.metals_value,
        cash_value = EXCLUDED.cash_value,
        gain_loss = EXCLUDED.gain_loss,
        return_pct = EXCLUDED.return_pct,
        computed_at = NOW()
    `, [
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
    ]);
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
