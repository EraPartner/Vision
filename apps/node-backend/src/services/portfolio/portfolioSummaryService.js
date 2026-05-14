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
import { toDecimal, addAll, multiply, divide, roundMoney } from '../../lib/money.js';

const UNIT_BASED_CLASSES = new Set(['stock', 'etf', 'crypto', 'metals']);
const FIXED_INCOME_CLASSES = new Set(['savings', 'bond']);
const REAL_ESTATE_CLASS = 'real_estate';

const round2 = (value) => roundMoney(value, 2);
const round6 = (value) => roundMoney(value, 6);

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

  // Resolve the FX multiplier once per *distinct* investment currency rather
  // than once per investment — buildInvestmentSummary then runs synchronously.
  const distinctCurrencies = [
    ...new Set(investmentsResult.rows.map((inv) => (inv.currency || 'EUR').toUpperCase())),
  ];
  const multiplierByCurrency = new Map();
  await Promise.all(
    distinctCurrencies.map(async (cur) => {
      multiplierByCurrency.set(
        cur,
        cur === target ? 1 : await convertToCurrency(1, cur, target)
      );
    })
  );

  const summaries = investmentsResult.rows.map((inv) =>
    buildInvestmentSummary(inv, txnsByInvestment.get(Number(inv.id)) ?? [], target, multiplierByCurrency)
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
 * @param {Map<string, number>} multiplierByCurrency  FX multiplier per investment currency
 */
function buildInvestmentSummary(inv, txns, targetCurrency, multiplierByCurrency) {
  const isUnitBased = UNIT_BASED_CLASSES.has(inv.asset_class);
  const isFixedIncome = FIXED_INCOME_CLASSES.has(inv.asset_class);
  const isRealEstate = inv.asset_class === REAL_ESTATE_CLASS;

  // All running sums are kept as Decimal — IEEE-754 drift on money paths
  // compounds across many transactions before the single round-on-emit below.
  let totalDividends = toDecimal(0);
  let totalInterestPaid = toDecimal(0);
  let totalRent = toDecimal(0);
  let totalAppreciation = toDecimal(0);
  let totalBuyAmount = toDecimal(0);
  let totalBuyOrGiftAmount = toDecimal(0);
  let totalSellAmount = toDecimal(0);
  let feeTxnAmount = toDecimal(0);
  let taxTxnAmount = toDecimal(0);
  let feesFieldAmount = toDecimal(0);
  let taxesFieldAmount = toDecimal(0);

  for (const txn of txns) {
    const amount = toDecimal(txn.amount);
    feesFieldAmount = feesFieldAmount.plus(toDecimal(txn.fees));
    taxesFieldAmount = taxesFieldAmount.plus(toDecimal(txn.taxes));

    switch (txn.type) {
      case 'buy':          totalBuyAmount = totalBuyAmount.plus(amount); totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount); break;
      case 'gift':         totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount); break;
      case 'sell':         totalSellAmount = totalSellAmount.plus(amount); break;
      case 'fee':          feeTxnAmount = feeTxnAmount.plus(amount); break;
      case 'tax':          taxTxnAmount = taxTxnAmount.plus(amount); break;
      case 'dividend':     totalDividends = totalDividends.plus(amount); break;
      case 'interest':     totalInterestPaid = totalInterestPaid.plus(amount); break;
      case 'rent_income':  totalRent = totalRent.plus(amount); break;
      case 'appreciation': totalAppreciation = totalAppreciation.plus(amount); break;
    }
  }

  const totalFees = feeTxnAmount.plus(feesFieldAmount);
  const totalTaxes = taxTxnAmount.plus(taxesFieldAmount);

  let totalUnits = toDecimal(0);
  let avgCostBasis = toDecimal(0);
  let totalBuyCost;
  let totalSellProceeds;
  let realizedGain = toDecimal(0);
  let unrealizedGain = toDecimal(0);
  let currentValue;
  let totalInvested;
  let accruedInterest = toDecimal(0);
  let projectedInterest = toDecimal(0);

  if (isUnitBased) {
    const cb = calculateCostBasis(txns);
    totalUnits = toDecimal(cb.totalUnits);
    avgCostBasis = toDecimal(cb.avgCostBasis);
    totalBuyCost = toDecimal(cb.totalBuyCost);
    totalSellProceeds = toDecimal(cb.totalSellProceeds);
    totalInvested = toDecimal(cb.totalCost);
    realizedGain = toDecimal(cb.realizedGain);

    const currentPrice = toDecimal(inv.current_price);
    currentValue = totalUnits.times(currentPrice);
    unrealizedGain = totalUnits.gt(0)
      ? currentPrice.minus(avgCostBasis).times(totalUnits)
      : toDecimal(0);
  } else if (isFixedIncome) {
    totalInvested = totalBuyOrGiftAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyOrGiftAmount;
    totalSellProceeds = totalSellAmount;

    const interestRate = Number(inv.interest_rate) || 0;
    accruedInterest = toDecimal(calculateAccruedInterest(txns, totalInvested.toNumber(), interestRate));
    projectedInterest = toDecimal(calculateProjectedAnnualInterest(totalInvested.toNumber(), interestRate));

    currentValue = totalInvested.plus(accruedInterest);
    realizedGain = totalInterestPaid;
    unrealizedGain = accruedInterest;
  } else if (isRealEstate) {
    totalInvested = totalBuyAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested.plus(totalAppreciation);
    unrealizedGain = totalAppreciation;
    realizedGain = totalRent.minus(totalFees).minus(totalTaxes);
  } else {
    totalInvested = totalBuyAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested;
  }

  const totalIncome = totalDividends.plus(totalInterestPaid).plus(totalRent);
  const totalGain = realizedGain.plus(unrealizedGain);
  const gainLoss = totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes);
  const gainLossPercent = totalBuyCost.gt(0)
    ? divide(gainLoss, totalBuyCost).times(100)
    : toDecimal(0);

  const invCurrency = (inv.currency || 'EUR').toUpperCase();
  // Multiplier was resolved once per distinct currency by the caller.
  const multiplier = multiplierByCurrency.get(invCurrency) ?? 1;
  const conv = (v) => multiply(v, multiplier);

  const convertedCurrentValue = conv(currentValue);
  const convertedTotalInvested = conv(totalInvested.abs());
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
  const acc = {
    totalPortfolioValue: addAll(summaries.map((s) => s.currentValue)),
    totalInvested: addAll(summaries.map((s) => s.totalBuyCost)),
    totalGainLoss: addAll(summaries.map((s) => s.gainLoss)),
    totalRealizedGain: addAll(summaries.map((s) => s.realizedGain)),
    totalUnrealizedGain: addAll(summaries.map((s) => s.unrealizedGain)),
    totalGain: addAll(summaries.map((s) => s.totalGain)),
    totalIncome: addAll(summaries.map((s) => s.totalIncome)),
    totalFees: addAll(summaries.map((s) => s.totalFees)),
    totalTaxes: addAll(summaries.map((s) => s.totalTaxes)),
  };

  const totalReturnPct = acc.totalInvested.gt(0)
    ? divide(acc.totalGainLoss, acc.totalInvested).times(100)
    : toDecimal(0);

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
