/**
 * Portfolio Performance Snapshot Service
 *
 * Thin orchestrator — delegates snapshot computation/storage to snapshotBuilder,
 * exposes DB read helpers, and re-exports math utilities consumed by info routes.
 */

import { query } from '../database/connection.js';
import { convertToCurrency } from './currency/currencyConversionService.js';
import { calculateCostBasis, calculateAccruedInterest, computeMetrics, computeHeatmap } from '../utils/portfolioMath.js';
import { computeAndStoreSnapshots as _computeAndStoreSnapshots } from './portfolio/snapshotBuilder.js';

export { computeMetrics, computeHeatmap } from '../utils/portfolioMath.js';
export { computeAndStoreSnapshots } from './portfolio/snapshotBuilder.js';

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

  return result.rows[0] ?? null;
}

/**
 * Per-investment breakdown with all monetary values in targetCurrency.
 * Replaces the frontend usePortfolio() + exchange-rates fetch waterfall.
 *
 * @param {string} targetCurrency
 * @returns {Promise<object[]>}
 */
export async function getBreakdownSummary(targetCurrency = 'EUR') {
  const [investmentsResult, txnResult] = await Promise.all([
    query(`
      SELECT id, name, symbol, asset_class,
             COALESCE(currency, 'EUR') AS currency,
             COALESCE(current_price, 0) AS current_price,
             COALESCE(interest_rate, 0) AS interest_rate,
             is_active
      FROM investments
      WHERE is_active = true
      ORDER BY name
    `),
    query(`
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
    `),
  ]);

  const txnsByInvestment = new Map();
  for (const txn of txnResult.rows) {
    const id = Number(txn.investment_id);
    if (!txnsByInvestment.has(id)) txnsByInvestment.set(id, []);
    txnsByInvestment.get(id).push(txn);
  }

  return Promise.all(
    investmentsResult.rows.map(inv => buildSummary(inv, txnsByInvestment, targetCurrency))
  );
}

async function buildSummary(inv, txnsByInvestment, targetCurrency) {
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
    feesFieldAmount += Number(txn.fees) || 0;
    taxesFieldAmount += Number(txn.taxes) || 0;

    switch (txn.type) {
      case 'buy':          totalBuyAmount += amount; totalBuyOrGiftAmount += amount; break;
      case 'gift':         totalBuyOrGiftAmount += amount; break;
      case 'sell':         totalSellAmount += amount; break;
      case 'fee':          feeTxnAmount += amount; break;
      case 'tax':          taxTxnAmount += amount; break;
      case 'dividend':     totalDividends += amount; break;
      case 'interest':     totalInterestPaid += amount; break;
      case 'rent_income':  totalRent += amount; break;
      case 'appreciation': totalAppreciation += amount; break;
    }
  }

  const totalFees = feeTxnAmount + feesFieldAmount;
  const totalTaxes = taxTxnAmount + taxesFieldAmount;

  let currentValue = 0;
  let totalInvested = 0;
  let realizedGain = 0;
  let unrealizedGain = 0;
  let totalBuyCost = 0;

  if (isUnitBased) {
    const cb = calculateCostBasis(txns);
    const currentPrice = Number(inv.current_price) || 0;
    currentValue = cb.totalUnits * currentPrice;
    totalInvested = cb.totalCost;
    realizedGain = cb.realizedGain;
    unrealizedGain = cb.totalUnits > 0
      ? (currentPrice - cb.avgCostBasis) * cb.totalUnits : 0;
    totalBuyCost = cb.totalBuyCost;
  } else if (isFixedIncome) {
    totalInvested = totalBuyOrGiftAmount - totalSellAmount;
    totalBuyCost = totalBuyOrGiftAmount;
    const accruedInterest = calculateAccruedInterest(
      txns, totalInvested, Number(inv.interest_rate) || 0
    );
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
  const gainLoss = realizedGain + unrealizedGain + totalIncome - totalFees - totalTaxes;
  const gainLossPercent = totalBuyCost > 0 ? (gainLoss / totalBuyCost) * 100 : 0;

  const invCurrency = (inv.currency || 'EUR').toUpperCase();
  const convert = invCurrency !== targetCurrency.toUpperCase()
    ? (v) => convertToCurrency(v, invCurrency, targetCurrency)
    : (v) => Promise.resolve(v);

  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    id: Number(inv.id),
    name: inv.name,
    symbol: inv.symbol,
    assetClass: inv.asset_class,
    currency: inv.currency,
    currentValue: round2(await convert(currentValue)),
    totalInvested: round2(await convert(Math.abs(totalInvested))),
    gainLoss: round2(await convert(gainLoss)),
    gainLossPercent: round2(gainLossPercent),
  };
}

export default {
  computeAndStoreSnapshots: _computeAndStoreSnapshots,
  getSnapshots,
  getLatestSnapshot,
  computeMetrics,
  computeHeatmap,
  getBreakdownSummary,
};
