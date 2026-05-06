/**
 * Portfolio Summary Service
 *
 * Single source of truth for realtime portfolio totals and per-investment
 * summaries. Used by:
 *   - /api/info/portfolio-summary  (dashboard, performance headline cards)
 *   - portfolioPerformanceSnapshotService.getBreakdownSummary (legacy compat)
 *
 * All monetary values in the response are pre-converted to the requested
 * target currency to eliminate frontend FX drift across pages.
 */

import { query } from '../../database/connection.js';
import { convertToCurrency } from '../currency/currencyConversionService.js';
import {
  calculateCostBasis,
  calculateAccruedInterest,
  projectedAnnualInterest as calculateProjectedAnnualInterest,
} from '../../utils/portfolioMath.js';

const UNIT_BASED_CLASSES = new Set(['stock', 'etf', 'crypto', 'metals']);
const FIXED_INCOME_CLASSES = new Set(['savings', 'bond']);
const REAL_ESTATE_CLASS = 'real_estate';

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const round6 = (value) => Math.round(Number(value) * 1000000) / 1000000;

/**
 * Fetch active investments and their transactions, then compute per-investment
 * summaries plus aggregated totals — all pre-converted to targetCurrency.
 *
 * @param {string} targetCurrency
 * @returns {Promise<{ currency: string, computed_at: string, totals: object, summaries: object[] }>}
 */
export async function getPortfolioSummary(targetCurrency = 'EUR') {
  const target = (targetCurrency || 'EUR').toUpperCase();

  const [investmentsResult, txnResult] = await Promise.all([
    query(`
      SELECT i.*,
             COALESCE(i.currency, 'EUR') AS currency,
             COALESCE(i.current_price, 0) AS current_price,
             COALESCE(i.interest_rate, 0) AS interest_rate
      FROM investments i
      WHERE i.is_active = true
      ORDER BY i.name
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
      ORDER BY pt.date::date, pt.id
    `),
  ]);

  const txnsByInvestment = new Map();
  for (const txn of txnResult.rows) {
    const id = Number(txn.investment_id);
    if (!txnsByInvestment.has(id)) txnsByInvestment.set(id, []);
    txnsByInvestment.get(id).push(txn);
  }

  const summaries = await Promise.all(
    investmentsResult.rows.map((inv) =>
      buildInvestmentSummary(inv, txnsByInvestment.get(Number(inv.id)) ?? [], target)
    )
  );

  const totals = aggregateTotals(summaries);

  return {
    currency: target,
    computed_at: new Date().toISOString(),
    totals,
    summaries,
  };
}

/**
 * Compute a rich summary for a single investment, with all monetary fields
 * pre-converted to targetCurrency.
 *
 * @param {object} inv  raw investment row
 * @param {Array}  txns transaction rows for this investment
 * @param {string} targetCurrency
 */
async function buildInvestmentSummary(inv, txns, targetCurrency) {
  const isUnitBased = UNIT_BASED_CLASSES.has(inv.asset_class);
  const isFixedIncome = FIXED_INCOME_CLASSES.has(inv.asset_class);
  const isRealEstate = inv.asset_class === REAL_ESTATE_CLASS;

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

  let totalUnits = 0;
  let avgCostBasis = 0;
  let totalBuyCost;
  let totalSellProceeds;
  let realizedGain = 0;
  let unrealizedGain = 0;
  let currentValue;
  let totalInvested;
  let accruedInterest = 0;
  let projectedInterest = 0;

  if (isUnitBased) {
    const cb = calculateCostBasis(txns);
    totalUnits = cb.totalUnits;
    avgCostBasis = cb.avgCostBasis;
    totalBuyCost = cb.totalBuyCost;
    totalSellProceeds = cb.totalSellProceeds;
    totalInvested = cb.totalCost;
    realizedGain = cb.realizedGain;

    const currentPrice = Number(inv.current_price) || 0;
    currentValue = totalUnits * currentPrice;
    unrealizedGain = totalUnits > 0 ? (currentPrice - avgCostBasis) * totalUnits : 0;
  } else if (isFixedIncome) {
    totalInvested = totalBuyOrGiftAmount - totalSellAmount;
    totalBuyCost = totalBuyOrGiftAmount;
    totalSellProceeds = totalSellAmount;

    const interestRate = Number(inv.interest_rate) || 0;
    accruedInterest = calculateAccruedInterest(txns, totalInvested, interestRate);
    projectedInterest = calculateProjectedAnnualInterest(totalInvested, interestRate);

    currentValue = totalInvested + accruedInterest;
    realizedGain = totalInterestPaid;
    unrealizedGain = accruedInterest;
  } else if (isRealEstate) {
    totalInvested = totalBuyAmount - totalSellAmount;
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested + totalAppreciation;
    unrealizedGain = totalAppreciation;
    realizedGain = totalRent - totalFees - totalTaxes;
  } else {
    totalInvested = totalBuyAmount - totalSellAmount;
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested;
  }

  const totalIncome = totalDividends + totalInterestPaid + totalRent;
  const totalGain = realizedGain + unrealizedGain;
  const gainLoss = totalGain + totalIncome - totalFees - totalTaxes;
  const gainLossPercent = totalBuyCost > 0 ? (gainLoss / totalBuyCost) * 100 : 0;

  const invCurrency = (inv.currency || 'EUR').toUpperCase();
  // Resolve multiplier with a single rate lookup; multiply synchronously for all 17 fields.
  const multiplier = invCurrency === targetCurrency
    ? 1
    : await convertToCurrency(1, invCurrency, targetCurrency);
  const conv = (v) => v * multiplier;

  const convertedCurrentValue = conv(currentValue);
  const convertedTotalInvested = conv(Math.abs(totalInvested));
  const convertedTotalBuyCost = conv(totalBuyCost);
  const convertedTotalSellProceeds = conv(totalSellProceeds);
  const convertedTotalFees = conv(totalFees);
  const convertedTotalTaxes = conv(totalTaxes);
  const convertedTotalDividends = conv(totalDividends);
  const convertedTotalIncome = conv(totalIncome);
  const convertedRealizedGain = conv(realizedGain);
  const convertedUnrealizedGain = conv(unrealizedGain);
  const convertedTotalGain = conv(totalGain);
  const convertedGainLoss = conv(gainLoss);
  const convertedAccruedInterest = conv(accruedInterest);
  const convertedProjectedInterest = conv(projectedInterest);
  const convertedTotalAppreciation = conv(totalAppreciation);
  const convertedAvgCostBasis = conv(avgCostBasis);
  const convertedCurrentPrice = conv(Number(inv.current_price) || 0);

  return {
    // Identity passthrough — base investment fields the frontend already uses
    id: Number(inv.id),
    name: inv.name,
    symbol: inv.symbol,
    asset_class: inv.asset_class,
    assetClass: inv.asset_class,
    is_active: inv.is_active,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
    description: inv.description,
    notes: inv.notes,
    location: inv.location,
    municipality: inv.municipality,
    cadastral_income: inv.cadastral_income,
    municipality_tax_rate: inv.municipality_tax_rate,
    maturity_date: inv.maturity_date,
    maturityDate: inv.maturity_date,
    price_provider: inv.price_provider,
    price_provider_id: inv.price_provider_id,
    price_provider_url: inv.price_provider_url,
    price_provider_latest_url: inv.price_provider_latest_url,
    price_provider_latest_path: inv.price_provider_latest_path,
    price_provider_history_url: inv.price_provider_history_url,
    price_provider_history_path: inv.price_provider_history_path,
    price_provider_history_ts_path: inv.price_provider_history_ts_path,
    price_provider_history_price_path: inv.price_provider_history_price_path,
    price_updated_at: inv.price_updated_at,

    // The summary's display currency. All monetary fields below are expressed
    // in this currency. The investment's native currency is preserved as
    // `originalCurrency` so the UI can still display it as a label.
    currency: targetCurrency,
    originalCurrency: invCurrency,

    // Computed numerics — pre-converted to targetCurrency
    totalUnits: round6(totalUnits),
    currentPrice: round2(convertedCurrentPrice),
    current_price: round2(convertedCurrentPrice),
    interestRate: Number(inv.interest_rate) || 0,
    interest_rate: Number(inv.interest_rate) || 0,

    totalInvested: round2(convertedTotalInvested),
    totalBuyCost: round2(convertedTotalBuyCost),
    totalSellProceeds: round2(convertedTotalSellProceeds),
    currentValue: round2(convertedCurrentValue),
    totalFees: round2(convertedTotalFees),
    totalTaxes: round2(convertedTotalTaxes),
    totalDividends: round2(convertedTotalDividends),
    totalIncome: round2(convertedTotalIncome),

    avgCostBasis: round2(convertedAvgCostBasis),
    realizedGain: round2(convertedRealizedGain),
    unrealizedGain: round2(convertedUnrealizedGain),
    totalGain: round2(convertedTotalGain),
    gainLoss: round2(convertedGainLoss),
    gainLossPercent: round2(gainLossPercent),

    accruedInterest: round2(convertedAccruedInterest),
    projectedAnnualInterest: round2(convertedProjectedInterest),
    totalAppreciation: round2(convertedTotalAppreciation),
  };
}

/**
 * Reduce per-investment summaries into portfolio-wide totals.
 * All values are already in the same target currency, so straight summation.
 */
function aggregateTotals(summaries) {
  const acc = summaries.reduce(
    (a, s) => ({
      totalPortfolioValue: a.totalPortfolioValue + s.currentValue,
      totalInvested: a.totalInvested + s.totalBuyCost,
      totalGainLoss: a.totalGainLoss + s.gainLoss,
      totalRealizedGain: a.totalRealizedGain + s.realizedGain,
      totalUnrealizedGain: a.totalUnrealizedGain + s.unrealizedGain,
      totalGain: a.totalGain + s.totalGain,
      totalIncome: a.totalIncome + s.totalIncome,
      totalFees: a.totalFees + s.totalFees,
      totalTaxes: a.totalTaxes + s.totalTaxes,
    }),
    {
      totalPortfolioValue: 0,
      totalInvested: 0,
      totalGainLoss: 0,
      totalRealizedGain: 0,
      totalUnrealizedGain: 0,
      totalGain: 0,
      totalIncome: 0,
      totalFees: 0,
      totalTaxes: 0,
    }
  );

  const totalReturnPct = acc.totalInvested > 0
    ? (acc.totalGainLoss / acc.totalInvested) * 100
    : 0;

  return {
    totalPortfolioValue: round2(acc.totalPortfolioValue),
    totalInvested: round2(acc.totalInvested),
    totalGainLoss: round2(acc.totalGainLoss),
    totalRealizedGain: round2(acc.totalRealizedGain),
    totalUnrealizedGain: round2(acc.totalUnrealizedGain),
    totalGain: round2(acc.totalGain),
    totalIncome: round2(acc.totalIncome),
    totalFees: round2(acc.totalFees),
    totalTaxes: round2(acc.totalTaxes),
    totalReturnPct: round2(totalReturnPct),
  };
}

/**
 * Backward-compat narrow shape for /portfolio-performance.breakdownSummary.
 * Delegates to the same compute path so values can never diverge.
 */
export async function getBreakdownSummary(targetCurrency = 'EUR') {
  const { summaries } = await getPortfolioSummary(targetCurrency);
  return summaries.map((s) => ({
    id: s.id,
    name: s.name,
    symbol: s.symbol,
    assetClass: s.asset_class,
    currency: s.originalCurrency,
    currentValue: s.currentValue,
    totalInvested: s.totalInvested,
    gainLoss: s.gainLoss,
    gainLossPercent: s.gainLossPercent,
  }));
}
