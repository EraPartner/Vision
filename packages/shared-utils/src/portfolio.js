/**
 * Portfolio math shared by the Vision backend and frontend.
 *
 * Single source of truth for cost-basis accounting (weighted-average / FIFO /
 * LIFO), fixed-income interest accrual, and the per-investment summary core.
 * Both apps previously hand-mirrored these (apps/node-backend/src/utils/
 * portfolioMath.js ↔ apps/frontend/src/hooks/portfolio/*) and drifted —
 * `.abs()` vs 0-clamp on totalInvested, missing FX, unwired cost-basis method.
 *
 * Pure functions only: no IO, no clock reads, no timezone dependency. "Today"
 * and FX multipliers are inputs; callers own conversion, rounding-on-emit, and
 * response shaping.
 */

import Decimal from 'decimal.js';
import {
  UNIT_BASED_ASSET_CLASSES,
  FIXED_INCOME_ASSET_CLASSES,
  REAL_ESTATE_ASSET_CLASS,
} from '@vision/types/assetClasses';
import { toDecimal, roundToCents, toNumber } from './money.js';

// Derived from the canonical subsets in @vision/types/assetClasses (widened to
// Set<string>: .has() probes raw row values).
const UNIT_BASED_CLASSES = new Set(/** @type {readonly string[]} */ (UNIT_BASED_ASSET_CLASSES));
const FIXED_INCOME_CLASSES = new Set(/** @type {readonly string[]} */ (FIXED_INCOME_ASSET_CLASSES));
const REAL_ESTATE_CLASS = REAL_ESTATE_ASSET_CLASS;

/** @typedef {'weighted_avg'|'fifo'|'lifo'} CostBasisMethod */

/**
 * Shared result shape returned by all cost-basis calculators.
 *
 * The `…Conv` fields are the same aggregates carried through a parallel
 * "converted" track: each transaction may bear an `fxMultiplier` (native →
 * target rate at the transaction's date), so converted cost basis is locked at
 * purchase-date FX and converted realized gains compare sell-date proceeds
 * against buy-date cost. When no transaction carries `fxMultiplier` (and no
 * `defaultFxMultiplier` is given) the converted track equals the native one.
 *
 * `_oversold` is set to `true` (and omitted otherwise) when a sell asked for more
 * units than were held: the numeric result still clamps the sell to the held
 * quantity, but the flag lets callers surface a warning (mirrors the
 * `_fxFellBack` convention used elsewhere).
 *
 * @typedef {{ totalUnits: number, totalCost: number, avgCostBasis: number, realizedGain: number, totalBuyCost: number, totalSellProceeds: number, totalCostConv: number, avgCostBasisConv: number, realizedGainConv: number, totalBuyCostConv: number, totalSellProceedsConv: number, _oversold?: boolean }} CostBasisResult
 */

/**
 * Whole-day count between two YYYY-MM-DD strings. Pure calendar math (UTC
 * parse on both ends), so the result is identical in every host timezone.
 *
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {number}
 */
export function daysBetweenYmd(fromYmd, toYmd) {
  const parse = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(toYmd) - parse(fromYmd)) / 86_400_000);
}

/**
 * Apply corporate-action events (split, merger, spinoff, return_of_capital) to
 * a lot array. Called by both FIFO and LIFO helpers.
 *
 * @param {{ units: Decimal, costBasis: Decimal, costBasisConv: Decimal }[]} lots
 * @param {string} type
 * @param {Decimal} units - new total units after split, or units received from spinoff
 * @param {Decimal} amount - proceeds for return_of_capital
 * @param {Decimal} totalUnits - current total units held
 * @returns {{ totalUnits: Decimal, lots: { units: Decimal, costBasis: Decimal, costBasisConv: Decimal }[] }}
 */
function applyEventToLots(lots, type, units, amount, totalUnits) {
  const ZERO = toDecimal(0);

  if (type === 'split' && totalUnits.gt(0) && units.gt(0)) {
    const ratio = units.dividedBy(totalUnits);
    return {
      totalUnits: units,
      lots: lots.map((lot) => ({ ...lot, units: lot.units.times(ratio) })),
    };
  }

  if (type === 'return_of_capital' && totalUnits.gt(0)) {
    const reductionPerUnit = amount.dividedBy(totalUnits);
    return {
      totalUnits,
      lots: lots.map((lot) => {
        const reduced = Decimal.max(ZERO, lot.costBasis.minus(reductionPerUnit.times(lot.units)));
        // Reduce the converted track proportionally so it keeps reflecting the
        // lot's original purchase-date FX rather than the ROC payment's rate.
        const factor = lot.costBasis.gt(0) ? reduced.dividedBy(lot.costBasis) : ZERO;
        return {
          ...lot,
          costBasis: reduced,
          costBasisConv: lot.costBasisConv.times(factor),
        };
      }),
    };
  }

  // merger / spinoff — treated as cost-basis-neutral events for now
  return { totalUnits, lots };
}

/**
 * Calculate weighted average cost basis using the moving-average method.
 * Buys and gifts increase the position; sells reduce it at the current avg cost.
 * Corporate actions (split, return_of_capital) adjust units / cost basis.
 *
 * @param {Array<{type: string, units?: number|string, amount?: number|string, fees?: number|string, taxes?: number|string, date: string, fxMultiplier?: number|string}>} txns
 * @param {{ defaultFxMultiplier?: number|string }} [opts]
 * @returns {CostBasisResult}
 */
export function calculateCostBasis(txns, opts = {}) {
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  const ZERO = toDecimal(0);
  const defaultFx = toDecimal(opts.defaultFxMultiplier ?? 1);
  let totalUnits = ZERO;
  let totalCost = ZERO;
  let totalCostConv = ZERO;
  let realizedGain = ZERO;
  let realizedGainConv = ZERO;
  let totalBuyCost = ZERO;
  let totalBuyCostConv = ZERO;
  let totalSellProceeds = ZERO;
  let totalSellProceedsConv = ZERO;
  let oversold = false;

  for (const txn of sorted) {
    const units = toDecimal(txn.units || 0);
    const amount = toDecimal(txn.amount || 0);
    const fees = toDecimal(txn.fees || 0);
    const taxes = toDecimal(txn.taxes || 0);
    const fx = txn.fxMultiplier !== undefined ? toDecimal(txn.fxMultiplier) : defaultFx;

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount.plus(fees).plus(taxes);
      totalUnits = totalUnits.plus(units);
      totalCost = totalCost.plus(buyCost);
      totalCostConv = totalCostConv.plus(buyCost.times(fx));
      totalBuyCost = totalBuyCost.plus(buyCost);
      totalBuyCostConv = totalBuyCostConv.plus(buyCost.times(fx));
    } else if (txn.type === 'sell') {
      if (units.gt(totalUnits)) oversold = true;
      if (totalUnits.gt(0) && units.gt(0)) {
        const sellUnits = Decimal.min(units, totalUnits);
        const sellRatio = units.gt(0) ? sellUnits.dividedBy(units) : ZERO;
        const avgCost = totalCost.dividedBy(totalUnits);
        const costOfSoldUnits = avgCost.times(sellUnits);
        const costOfSoldConv = totalCostConv.times(sellUnits).dividedBy(totalUnits);
        const netProceeds = amount.minus(fees).minus(taxes).times(sellRatio);
        realizedGain = realizedGain.plus(netProceeds.minus(costOfSoldUnits));
        realizedGainConv = realizedGainConv.plus(netProceeds.times(fx).minus(costOfSoldConv));
        totalUnits = totalUnits.minus(sellUnits);
        totalCost = totalCost.minus(costOfSoldUnits);
        totalCostConv = totalCostConv.minus(costOfSoldConv);
        totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio));
        totalSellProceedsConv = totalSellProceedsConv.plus(amount.times(sellRatio).times(fx));
      }
    } else if (txn.type === 'split' && totalUnits.gt(0) && units.gt(0)) {
      // units = new total post-split; cost basis is unchanged
      totalUnits = units;
    } else if (txn.type === 'return_of_capital' && totalUnits.gt(0)) {
      const reduced = Decimal.max(ZERO, totalCost.minus(amount));
      // Proportional reduction keeps the converted track at purchase-date FX.
      const factor = totalCost.gt(0) ? reduced.dividedBy(totalCost) : ZERO;
      totalCost = reduced;
      totalCostConv = totalCostConv.times(factor);
    }
  }

  const finalUnits = Decimal.max(ZERO, totalUnits);
  const finalCost = Decimal.max(ZERO, totalCost);
  const finalCostConv = Decimal.max(ZERO, totalCostConv);
  const avgCostBasis = finalUnits.gt(0) ? finalCost.dividedBy(finalUnits) : ZERO;

  return {
    ...(oversold ? { _oversold: true } : {}),
    totalUnits: toNumber(finalUnits),
    totalCost: toNumber(roundToCents(finalCost)),
    avgCostBasis: toNumber(avgCostBasis),
    realizedGain: toNumber(roundToCents(realizedGain)),
    totalBuyCost: toNumber(roundToCents(totalBuyCost)),
    totalSellProceeds: toNumber(roundToCents(totalSellProceeds)),
    totalCostConv: toNumber(roundToCents(finalCostConv)),
    avgCostBasisConv: toNumber(finalUnits.gt(0) ? finalCostConv.dividedBy(finalUnits) : ZERO),
    realizedGainConv: toNumber(roundToCents(realizedGainConv)),
    totalBuyCostConv: toNumber(roundToCents(totalBuyCostConv)),
    totalSellProceedsConv: toNumber(roundToCents(totalSellProceedsConv)),
  };
}

/**
 * Calculate FIFO (first-in, first-out) cost basis.
 * Sells exhaust the oldest lots first.
 *
 * @param {Array<{type: string, units?: number|string, amount?: number|string, fees?: number|string, taxes?: number|string, date: string, fxMultiplier?: number|string}>} txns
 * @param {{ defaultFxMultiplier?: number|string }} [opts]
 * @returns {CostBasisResult}
 */
/**
 * Lot-based cost basis (FIFO or LIFO). The two methods differ only in which lot
 * a sell consumes first — the head of the queue (FIFO) or the tail (LIFO, when
 * `fromEnd` is true). All other math is identical, so it lives here once
 * (SIMP-21). Golden-fixture-covered money math; keep the arithmetic verbatim.
 *
 * @param {PortfolioTxnLike[]} txns
 * @param {{ defaultFxMultiplier?: number|string }} opts
 * @param {{ fromEnd?: boolean }} config
 * @returns {CostBasisResult}
 */
function calculateCostBasisLotBased(txns, opts = {}, { fromEnd = false } = {}) {
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  const ZERO = toDecimal(0);
  const defaultFx = toDecimal(opts.defaultFxMultiplier ?? 1);
  /** @type {{ units: Decimal, costBasis: Decimal, costBasisConv: Decimal }[]} */
  // FIFO consumes from lots[head] forward (head advances); LIFO pops from the end;
  // buys push to the end. The active (unconsumed) lots are lots[head..]. This keeps
  // each buy/consume O(1) amortized instead of the previous per-op spread-copy
  // (which made a B-buy history O(B^2)); results are unchanged.
  let lots = [];
  let head = 0;
  let totalUnits = ZERO;
  let realizedGain = ZERO;
  let realizedGainConv = ZERO;
  let totalBuyCost = ZERO;
  let totalBuyCostConv = ZERO;
  let totalSellProceeds = ZERO;
  let totalSellProceedsConv = ZERO;
  let oversold = false;

  for (const txn of sorted) {
    const units = toDecimal(txn.units || 0);
    const amount = toDecimal(txn.amount || 0);
    const fees = toDecimal(txn.fees || 0);
    const taxes = toDecimal(txn.taxes || 0);
    const fx = txn.fxMultiplier !== undefined ? toDecimal(txn.fxMultiplier) : defaultFx;

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount.plus(fees).plus(taxes);
      lots.push({ units, costBasis: buyCost, costBasisConv: buyCost.times(fx) });
      totalUnits = totalUnits.plus(units);
      totalBuyCost = totalBuyCost.plus(buyCost);
      totalBuyCostConv = totalBuyCostConv.plus(buyCost.times(fx));
    } else if (txn.type === 'sell' && units.gt(0)) {
      if (units.gt(totalUnits)) oversold = true;
      const sellUnits = Decimal.min(units, totalUnits);
      const sellRatio = units.gt(0) ? sellUnits.dividedBy(units) : ZERO;
      const netProceeds = amount.minus(fees).minus(taxes).times(sellRatio);
      let unitsToSell = sellUnits;
      let costOfSold = ZERO;
      let costOfSoldConv = ZERO;

      while (unitsToSell.gt(0) && head < lots.length) {
        const idx = fromEnd ? lots.length - 1 : head;
        const lot = lots[idx];
        if (lot.units.lte(unitsToSell)) {
          costOfSold = costOfSold.plus(lot.costBasis);
          costOfSoldConv = costOfSoldConv.plus(lot.costBasisConv);
          unitsToSell = unitsToSell.minus(lot.units);
          if (fromEnd) lots.pop(); else head += 1;
        } else {
          const fraction = unitsToSell.dividedBy(lot.units);
          const lotCostUsed = lot.costBasis.times(fraction);
          const lotCostUsedConv = lot.costBasisConv.times(fraction);
          costOfSold = costOfSold.plus(lotCostUsed);
          costOfSoldConv = costOfSoldConv.plus(lotCostUsedConv);
          lots[idx] = {
            units: lot.units.minus(unitsToSell),
            costBasis: lot.costBasis.minus(lotCostUsed),
            costBasisConv: lot.costBasisConv.minus(lotCostUsedConv),
          };
          unitsToSell = ZERO;
        }
      }

      totalUnits = totalUnits.minus(sellUnits);
      realizedGain = realizedGain.plus(netProceeds.minus(costOfSold));
      realizedGainConv = realizedGainConv.plus(netProceeds.times(fx).minus(costOfSoldConv));
      totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio));
      totalSellProceedsConv = totalSellProceedsConv.plus(amount.times(sellRatio).times(fx));
    } else if (txn.type === 'split' || txn.type === 'merger' || txn.type === 'spinoff' || txn.type === 'return_of_capital') {
      // Events operate on the active lots only; rebase (head -> 0) with the fresh
      // array applyEventToLots returns.
      const result = applyEventToLots(lots.slice(head), txn.type, units, amount, totalUnits);
      totalUnits = result.totalUnits;
      lots = result.lots;
      head = 0;
    }
  }

  const activeLots = head > 0 ? lots.slice(head) : lots;
  const totalCost = activeLots.reduce((sum, lot) => sum.plus(lot.costBasis), ZERO);
  const totalCostConv = activeLots.reduce((sum, lot) => sum.plus(lot.costBasisConv), ZERO);
  const finalUnits = Decimal.max(ZERO, totalUnits);
  const finalCost = Decimal.max(ZERO, totalCost);
  const finalCostConv = Decimal.max(ZERO, totalCostConv);

  return {
    ...(oversold ? { _oversold: true } : {}),
    totalUnits: toNumber(finalUnits),
    totalCost: toNumber(roundToCents(finalCost)),
    avgCostBasis: toNumber(finalUnits.gt(0) ? finalCost.dividedBy(finalUnits) : ZERO),
    realizedGain: toNumber(roundToCents(realizedGain)),
    totalBuyCost: toNumber(roundToCents(totalBuyCost)),
    totalSellProceeds: toNumber(roundToCents(totalSellProceeds)),
    totalCostConv: toNumber(roundToCents(finalCostConv)),
    avgCostBasisConv: toNumber(finalUnits.gt(0) ? finalCostConv.dividedBy(finalUnits) : ZERO),
    realizedGainConv: toNumber(roundToCents(realizedGainConv)),
    totalBuyCostConv: toNumber(roundToCents(totalBuyCostConv)),
    totalSellProceedsConv: toNumber(roundToCents(totalSellProceedsConv)),
  };
}

export function calculateCostBasisFIFO(txns, opts = {}) {
  return calculateCostBasisLotBased(txns, opts, { fromEnd: false });
}

/**
 * Calculate LIFO (last-in, first-out) cost basis.
 * Sells exhaust the most-recently-acquired lots first.
 *
 * @param {Array<{type: string, units?: number|string, amount?: number|string, fees?: number|string, taxes?: number|string, date: string, fxMultiplier?: number|string}>} txns
 * @param {{ defaultFxMultiplier?: number|string }} [opts]
 * @returns {CostBasisResult}
 */
export function calculateCostBasisLIFO(txns, opts = {}) {
  return calculateCostBasisLotBased(txns, opts, { fromEnd: true });
}

/**
 * Dispatch to the correct cost-basis calculator based on `method`.
 *
 * @param {Array} txns
 * @param {CostBasisMethod} [method]
 * @param {{ defaultFxMultiplier?: number|string }} [opts]
 * @returns {CostBasisResult}
 */
export function calculateCostBasisByMethod(txns, method, opts = {}) {
  if (method === 'fifo') return calculateCostBasisFIFO(txns, opts);
  if (method === 'lifo') return calculateCostBasisLIFO(txns, opts);
  return calculateCostBasis(txns, opts); // default: weighted_avg
}

/**
 * Calculate accrued simple interest for fixed-income assets.
 * Clock starts from last interest payment date, or first buy if no payments yet.
 *
 * @param {Array<{type: string, date: string}>} txns
 * @param {number} principal - Current invested principal
 * @param {number} interestRate - Annual rate as a percentage (e.g. 3.5 for 3.5%)
 * @param {string} todayYmd - "today" as YYYY-MM-DD in the caller's business timezone
 * @returns {number} Accrued interest amount
 */
export function calculateAccruedInterest(txns, principal, interestRate, todayYmd) {
  if (!interestRate || principal <= 0) return 0;

  const sortedDesc = [...txns].sort((a, b) => b.date.localeCompare(a.date));
  const lastInterestTxn = sortedDesc.find((t) => t.type === 'interest');
  const firstBuyTxn = [...txns]
    .filter((t) => t.type === 'buy')
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const startDate = lastInterestTxn?.date || firstBuyTxn?.date;
  if (!startDate) return 0;

  const daysSinceStart = Math.max(0, daysBetweenYmd(startDate, todayYmd));

  return toNumber(
    toDecimal(principal)
      .times(toDecimal(interestRate).div(100).div(365))
      .times(daysSinceStart)
  );
}

/**
 * Calculate projected annual interest for fixed-income assets.
 *
 * @param {number} principal
 * @param {number} ratePercent - Annual rate as a percentage
 * @returns {number}
 */
export function projectedAnnualInterest(principal, ratePercent) {
  if (!ratePercent || principal <= 0) return 0;
  return toNumber(toDecimal(principal).times(toDecimal(ratePercent).div(100)));
}

/**
 * Per-investment summary math core — the calculation half of the backend's
 * buildInvestmentSummary and the frontend's buildSummary, expressed once.
 *
 * Everything is computed in the investment's native currency and returned as
 * Decimal instances; the caller applies FX conversion and rounding on emit.
 *
 * FX attribution (`converted` in the result): when transactions carry an
 * `fxMultiplier` (native → target rate at the transaction's date) and opts
 * carries `fxMultiplierNow` (native → target today), the core also returns the
 * summary in target currency with invested capital locked at purchase-date
 * rates, the total gain including the FX component, and that gain decomposed
 * into `assetGain` (native performance at today's rate) plus `fxGain` (the
 * residual currency effect). With no FX inputs `converted` equals the native
 * fields — callers that don't care can ignore it.
 *
 * @param {{ asset_class: string, current_price?: number|string, interest_rate?: number|string }} inv
 * @param {Array<object>} txns transaction rows ({type, amount, units, fees, taxes, date, fxMultiplier?})
 * @param {{ costBasisMethod?: CostBasisMethod, todayYmd: string, fxMultiplierNow?: number|string }} opts
 * @returns {Record<string, Decimal> & { converted: Record<string, Decimal> }}
 */
export function buildInvestmentSummaryCore(inv, txns, { costBasisMethod = 'weighted_avg', todayYmd, fxMultiplierNow = 1 }) {
  const isUnitBased = UNIT_BASED_CLASSES.has(inv.asset_class);
  const isFixedIncome = FIXED_INCOME_CLASSES.has(inv.asset_class);
  const isRealEstate = inv.asset_class === REAL_ESTATE_CLASS;

  const ZERO = toDecimal(0);
  const mNow = toDecimal(fxMultiplierNow ?? 1);
  // Unannotated transactions convert at today's rate — with no per-txn rates
  // the converted track degrades exactly to the pre-FX-attribution behavior.
  const txnFx = (txn) => (txn.fxMultiplier !== undefined ? toDecimal(txn.fxMultiplier) : mNow);

  // All running sums are kept as Decimal — IEEE-754 drift on money paths
  // compounds across many transactions before the caller's round-on-emit.
  let totalDividends = ZERO;
  let totalInterestPaid = ZERO;
  let totalRent = ZERO;
  let totalAppreciation = ZERO;
  let totalBuyAmount = ZERO;
  let totalBuyOrGiftAmount = ZERO;
  let totalSellAmount = ZERO;
  let totalReturnOfCapital = ZERO;
  let feeTxnAmount = ZERO;
  let taxTxnAmount = ZERO;
  let feesFieldAmount = ZERO;
  let taxesFieldAmount = ZERO;

  // Converted (transaction-date rate) twins of the sums above.
  let totalDividendsC = ZERO;
  let totalInterestPaidC = ZERO;
  let totalRentC = ZERO;
  let totalBuyAmountC = ZERO;
  let totalBuyOrGiftAmountC = ZERO;
  let totalSellAmountC = ZERO;
  let totalReturnOfCapitalC = ZERO;
  let feeTxnAmountC = ZERO;
  let taxTxnAmountC = ZERO;
  let feesFieldAmountC = ZERO;
  let taxesFieldAmountC = ZERO;

  for (const txn of txns) {
    const amount = toDecimal(txn.amount);
    const fx = txnFx(txn);
    feesFieldAmount = feesFieldAmount.plus(toDecimal(txn.fees));
    taxesFieldAmount = taxesFieldAmount.plus(toDecimal(txn.taxes));
    feesFieldAmountC = feesFieldAmountC.plus(toDecimal(txn.fees).times(fx));
    taxesFieldAmountC = taxesFieldAmountC.plus(toDecimal(txn.taxes).times(fx));

    switch (txn.type) {
      case 'buy':          totalBuyAmount = totalBuyAmount.plus(amount); totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount); totalBuyAmountC = totalBuyAmountC.plus(amount.times(fx)); totalBuyOrGiftAmountC = totalBuyOrGiftAmountC.plus(amount.times(fx)); break;
      case 'gift':         totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount); totalBuyOrGiftAmountC = totalBuyOrGiftAmountC.plus(amount.times(fx)); break;
      case 'sell':         totalSellAmount = totalSellAmount.plus(amount); totalSellAmountC = totalSellAmountC.plus(amount.times(fx)); break;
      case 'fee':          feeTxnAmount = feeTxnAmount.plus(amount); feeTxnAmountC = feeTxnAmountC.plus(amount.times(fx)); break;
      case 'tax':          taxTxnAmount = taxTxnAmount.plus(amount); taxTxnAmountC = taxTxnAmountC.plus(amount.times(fx)); break;
      case 'dividend':     totalDividends = totalDividends.plus(amount); totalDividendsC = totalDividendsC.plus(amount.times(fx)); break;
      case 'interest':     totalInterestPaid = totalInterestPaid.plus(amount); totalInterestPaidC = totalInterestPaidC.plus(amount.times(fx)); break;
      case 'rent_income':  totalRent = totalRent.plus(amount); totalRentC = totalRentC.plus(amount.times(fx)); break;
      case 'appreciation': totalAppreciation = totalAppreciation.plus(amount); break;
      // Unit-based classes fold return_of_capital into cost basis via the
      // cost-basis calculator; non-unit classes (savings/bond/real_estate) have
      // no lot machinery, so accumulate it here and subtract from invested below.
      case 'return_of_capital': totalReturnOfCapital = totalReturnOfCapital.plus(amount); totalReturnOfCapitalC = totalReturnOfCapitalC.plus(amount.times(fx)); break;
    }
  }

  const totalFees = feeTxnAmount.plus(feesFieldAmount);
  const totalTaxes = taxTxnAmount.plus(taxesFieldAmount);
  const totalFeesC = feeTxnAmountC.plus(feesFieldAmountC);
  const totalTaxesC = taxTxnAmountC.plus(taxesFieldAmountC);

  let totalUnits = ZERO;
  let avgCostBasis = ZERO;
  let totalBuyCost;
  let totalSellProceeds;
  let realizedGain = ZERO;
  let unrealizedGain = ZERO;
  let currentValue;
  let totalInvested;
  let accruedInterest = ZERO;
  let projectedInterest = ZERO;

  // Converted-track equivalents (invested locked at purchase-date rates).
  let avgCostBasisC = ZERO;
  let totalBuyCostC;
  let totalSellProceedsC;
  let realizedGainC = ZERO;
  let totalInvestedC;

  if (isUnitBased) {
    const cb = calculateCostBasisByMethod(txns, costBasisMethod, { defaultFxMultiplier: mNow });
    totalUnits = toDecimal(cb.totalUnits);
    avgCostBasis = toDecimal(cb.avgCostBasis);
    totalBuyCost = toDecimal(cb.totalBuyCost);
    totalSellProceeds = toDecimal(cb.totalSellProceeds);
    totalInvested = toDecimal(cb.totalCost);
    realizedGain = toDecimal(cb.realizedGain);

    avgCostBasisC = toDecimal(cb.avgCostBasisConv);
    totalBuyCostC = toDecimal(cb.totalBuyCostConv);
    totalSellProceedsC = toDecimal(cb.totalSellProceedsConv);
    totalInvestedC = toDecimal(cb.totalCostConv);
    realizedGainC = toDecimal(cb.realizedGainConv);

    const currentPrice = toDecimal(inv.current_price);
    currentValue = totalUnits.times(currentPrice);
    unrealizedGain = totalUnits.gt(0)
      ? currentPrice.minus(avgCostBasis).times(totalUnits)
      : ZERO;
  } else if (isFixedIncome) {
    totalInvested = totalBuyOrGiftAmount.minus(totalSellAmount).minus(totalReturnOfCapital);
    totalBuyCost = totalBuyOrGiftAmount;
    totalSellProceeds = totalSellAmount;
    totalInvestedC = totalBuyOrGiftAmountC.minus(totalSellAmountC).minus(totalReturnOfCapitalC);
    totalBuyCostC = totalBuyOrGiftAmountC;
    totalSellProceedsC = totalSellAmountC;

    const interestRate = Number(inv.interest_rate) || 0;
    accruedInterest = toDecimal(calculateAccruedInterest(txns, totalInvested.toNumber(), interestRate, todayYmd));
    projectedInterest = toDecimal(projectedAnnualInterest(totalInvested.toNumber(), interestRate));

    currentValue = totalInvested.plus(accruedInterest);
    // Interest received is income (already in totalIncome below), exactly like
    // dividends — feeding it into realizedGain too double-counted it in gainLoss.
    realizedGain = ZERO;
    unrealizedGain = accruedInterest;
  } else if (isRealEstate) {
    totalInvested = totalBuyAmount.minus(totalSellAmount).minus(totalReturnOfCapital);
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    totalInvestedC = totalBuyAmountC.minus(totalSellAmountC).minus(totalReturnOfCapitalC);
    totalBuyCostC = totalBuyAmountC;
    totalSellProceedsC = totalSellAmountC;
    currentValue = totalInvested.plus(totalAppreciation);
    unrealizedGain = totalAppreciation;
    // Rent is income (folded into totalIncome below), not a realized gain, and
    // fees/taxes are already subtracted once in the shared gainLoss line. Feeding
    // rent−fees−taxes into realizedGain here double-counted all three.
    realizedGain = ZERO;
  } else {
    totalInvested = totalBuyAmount.minus(totalSellAmount).minus(totalReturnOfCapital);
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    totalInvestedC = totalBuyAmountC.minus(totalSellAmountC).minus(totalReturnOfCapitalC);
    totalBuyCostC = totalBuyAmountC;
    totalSellProceedsC = totalSellAmountC;
    currentValue = totalInvested;
  }

  const totalIncome = totalDividends.plus(totalInterestPaid).plus(totalRent);
  const totalGain = realizedGain.plus(unrealizedGain);
  // For unit-based assets the per-row fees/taxes *columns* are already folded
  // into cost basis by the calculators (buys add them, sells subtract them),
  // so subtracting totalFees/totalTaxes (= fee/tax tx-types + those columns)
  // would count them twice. Only the standalone fee/tax transaction *types*
  // sit outside cost basis. Other branches keep the full subtraction because
  // their totalInvested excludes the fees/taxes columns.
  const gainLoss = isUnitBased
    ? totalGain.plus(totalIncome).minus(feeTxnAmount).minus(taxTxnAmount)
    : totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes);
  const gainLossPercent = totalBuyCost.gt(0)
    ? gainLoss.div(totalBuyCost).times(100)
    : ZERO;

  // Clamp at 0 rather than abs(): for fixed-income/real-estate totalInvested =
  // buys − sells can be legitimately negative (sold above contributions), and
  // abs() silently flipped that to a positive "invested" figure. (Unit-based
  // already clamps in the cost-basis calculators.)
  const clampedInvested = totalInvested.gt(0) ? totalInvested : ZERO;

  // ── Converted summary (FX attribution) ──────────────────────────────────
  // Value is what the holding is worth in target currency TODAY; invested is
  // what was paid AT the time. Their difference therefore includes the FX
  // component; assetGain isolates native performance and fxGain the residual.
  const currentValueC = currentValue.times(mNow);
  const totalIncomeC = totalDividendsC.plus(totalInterestPaidC).plus(totalRentC);
  const unrealizedGainC = currentValueC.minus(totalInvestedC);
  const totalGainC = realizedGainC.plus(unrealizedGainC);
  const gainLossC = isUnitBased
    ? totalGainC.plus(totalIncomeC).minus(feeTxnAmountC).minus(taxTxnAmountC)
    : totalGainC.plus(totalIncomeC).minus(totalFeesC).minus(totalTaxesC);
  const assetGainC = gainLoss.times(mNow);
  const fxGainC = gainLossC.minus(assetGainC);
  const gainLossPercentC = totalBuyCostC.gt(0)
    ? gainLossC.div(totalBuyCostC).times(100)
    : ZERO;
  const clampedInvestedC = totalInvestedC.gt(0) ? totalInvestedC : ZERO;

  return {
    totalUnits,
    avgCostBasis,
    totalInvested: clampedInvested,
    totalBuyCost,
    totalSellProceeds,
    currentValue,
    realizedGain,
    unrealizedGain,
    totalGain,
    gainLoss,
    gainLossPercent,
    totalFees,
    totalTaxes,
    feeTxnAmount,
    taxTxnAmount,
    totalDividends,
    totalInterestPaid,
    totalRent,
    totalAppreciation,
    totalIncome,
    accruedInterest,
    projectedAnnualInterest: projectedInterest,
    converted: {
      currentValue: currentValueC,
      totalInvested: clampedInvestedC,
      totalBuyCost: totalBuyCostC,
      totalSellProceeds: totalSellProceedsC,
      avgCostBasis: avgCostBasisC,
      realizedGain: realizedGainC,
      unrealizedGain: unrealizedGainC,
      totalGain: totalGainC,
      gainLoss: gainLossC,
      gainLossPercent: gainLossPercentC,
      assetGain: assetGainC,
      fxGain: fxGainC,
      totalFees: totalFeesC,
      totalTaxes: totalTaxesC,
      totalDividends: totalDividendsC,
      totalIncome: totalIncomeC,
    },
  };
}

// ── ADR-108: partitioned per-broker positions & P&L ─────────────────────────

/** Transaction types that create or consume lots (whole-lot broker tagging). */
export const LOT_TXN_TYPES = new Set(['buy', 'gift', 'sell']);

/**
 * Whether an investment's lots are fully broker-assigned (ADR-108 transition
 * rule): every lot-bearing row (buy/gift/sell) carries a non-null account_id.
 * Vacuously true with no lot rows — there is nothing left to assign.
 *
 * A NULL-account SELL also blocks full assignment: under partitioned math it
 * could only consume from the (empty) unassigned partition, which would emit
 * garbage partitions — exactly what the transition rule exists to prevent.
 *
 * @param {Array<{ type: string, account_id?: number|string|null }>} txns
 * @returns {boolean}
 */
export function areLotsFullyAssigned(txns) {
  return txns.every((t) => !LOT_TXN_TYPES.has(t.type) || t.account_id != null);
}

/** @param {{ account_id?: number|string|null }} txn @returns {number|null} */
const partitionKeyOf = (txn) => (txn.account_id == null ? null : Number(txn.account_id));

/**
 * Split an investment's transactions into per-(investment, account) partition
 * streams that the existing cost-basis calculators can replay UNCHANGED
 * (ADR-108: buys/gifts create lots in their row's account, sells consume
 * same-account lots, corporate actions apply investment-wide).
 *
 * Row routing:
 *  - buy / gift / sell → their own account's partition (NULL = unassigned).
 *  - split → rewritten per partition. The row's `units` is the new GLOBAL
 *    post-split total, which is meaningless inside one partition, so each
 *    partition holding units gets a synthetic split whose `units` is that
 *    partition's own new total (global ratio × partition units; the last
 *    holding partition takes `units − Σ others` so the totals sum exactly).
 *  - return_of_capital → allocated across partitions proportional to units
 *    held at that date — the same per-unit reduction the lot-based global
 *    engine applies — with the exact-sum remainder on the last partition.
 *  - merger / spinoff → engine no-ops today; routed to their own account's
 *    partition verbatim so future semantics (and fees) stay in one place.
 *  - everything else (dividend/interest/fee/tax/rent/appreciation) → its own
 *    account's partition.
 *
 * Rewritten corporate-action rows carry `fees: 0` / `taxes: 0`; the original
 * row is kept in ITS account's partition as an engine no-op (`units: 0` /
 * `amount: 0`) so per-row fees/taxes stay counted exactly once across
 * partitions (Σ partitions ≡ flat replay for every linear sum).
 *
 * Unit availability mirrors the calculators: sells consume at most what their
 * partition holds; splits only rescale when units are actually held.
 *
 * @param {Array<Record<string, any>>} txns one investment's transactions
 * @returns {Map<number|null, Array<Record<string, any>>>} partition key (account id or null) → rows
 */
export function partitionTxnsByAccount(txns) {
  const ZERO = toDecimal(0);
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  /** @type {Map<number|null, Array<Record<string, any>>>} */
  const partitions = new Map();
  /** @type {Map<number|null, Decimal>} */
  const held = new Map();

  /** @param {number|null} key @param {Record<string, any>} row */
  const push = (key, row) => {
    let rows = partitions.get(key);
    if (!rows) {
      rows = [];
      partitions.set(key, rows);
    }
    rows.push(row);
  };
  const totalHeld = () => [...held.values()].reduce((sum, h) => sum.plus(h), ZERO);
  // The fee/tax-carrying residual of a rewritten corporate action; omitted when
  // there is nothing to carry, so rewriting cannot mint empty partitions.
  const carriesFeesOrTaxes = (txn) =>
    !toDecimal(txn.fees || 0).eq(0) || !toDecimal(txn.taxes || 0).eq(0);

  for (const txn of sorted) {
    const key = partitionKeyOf(txn);

    if (txn.type === 'buy' || txn.type === 'gift') {
      push(key, txn);
      held.set(key, (held.get(key) ?? ZERO).plus(toDecimal(txn.units || 0)));
    } else if (txn.type === 'sell') {
      push(key, txn);
      const before = held.get(key) ?? ZERO;
      held.set(key, before.minus(Decimal.min(toDecimal(txn.units || 0), before)));
    } else if (txn.type === 'split') {
      const newGlobalUnits = toDecimal(txn.units || 0);
      const before = totalHeld();
      if (before.gt(0) && newGlobalUnits.gt(0)) {
        const ratio = newGlobalUnits.dividedBy(before);
        const holders = [...held.entries()].filter(([, h]) => h.gt(0));
        let allocated = ZERO;
        holders.forEach(([holderKey, holderUnits], i) => {
          const partitionNewTotal = i === holders.length - 1
            ? newGlobalUnits.minus(allocated)
            : holderUnits.times(ratio);
          allocated = allocated.plus(partitionNewTotal);
          held.set(holderKey, partitionNewTotal);
          push(holderKey, { ...txn, units: partitionNewTotal, fees: 0, taxes: 0 });
        });
      }
      if (carriesFeesOrTaxes(txn)) push(key, { ...txn, units: 0 });
    } else if (txn.type === 'return_of_capital') {
      const amount = toDecimal(txn.amount || 0);
      const unitsNow = totalHeld();
      if (unitsNow.gt(0) && !amount.eq(0)) {
        const holders = [...held.entries()].filter(([, h]) => h.gt(0));
        let allocated = ZERO;
        holders.forEach(([holderKey, holderUnits], i) => {
          const share = i === holders.length - 1
            ? amount.minus(allocated)
            : amount.times(holderUnits).dividedBy(unitsNow);
          allocated = allocated.plus(share);
          push(holderKey, { ...txn, amount: share, fees: 0, taxes: 0 });
        });
      }
      if (carriesFeesOrTaxes(txn)) push(key, { ...txn, amount: 0 });
    } else {
      push(key, txn);
    }
  }

  return partitions;
}

// Every additive InvestmentSummaryCore field. avgCostBasis / gainLossPercent
// (both tracks) are ratios and re-derived after summation instead.
const ADDITIVE_CORE_FIELDS = [
  'totalUnits', 'totalInvested', 'totalBuyCost', 'totalSellProceeds', 'currentValue',
  'realizedGain', 'unrealizedGain', 'totalGain', 'gainLoss', 'totalFees', 'totalTaxes',
  'feeTxnAmount', 'taxTxnAmount', 'totalDividends', 'totalInterestPaid', 'totalRent',
  'totalAppreciation', 'totalIncome', 'accruedInterest', 'projectedAnnualInterest',
];
const ADDITIVE_CONVERTED_FIELDS = [
  'currentValue', 'totalInvested', 'totalBuyCost', 'totalSellProceeds', 'realizedGain',
  'unrealizedGain', 'totalGain', 'gainLoss', 'assetGain', 'fxGain', 'totalFees',
  'totalTaxes', 'totalDividends', 'totalIncome',
];

/**
 * Reduce per-partition cores into one investment-level core: additive fields
 * sum; avg cost basis and return % are re-derived from the summed aggregates,
 * exactly as the flat core derives them.
 *
 * @param {ReturnType<typeof buildInvestmentSummaryCore>[]} cores
 * @returns {ReturnType<typeof buildInvestmentSummaryCore>}
 */
function aggregatePartitionCores(cores) {
  const ZERO = toDecimal(0);
  /** @type {Record<string, any>} */
  const agg = { converted: {} };
  for (const field of ADDITIVE_CORE_FIELDS) {
    agg[field] = cores.reduce((sum, c) => sum.plus(c[field]), ZERO);
  }
  for (const field of ADDITIVE_CONVERTED_FIELDS) {
    agg.converted[field] = cores.reduce((sum, c) => sum.plus(c.converted[field]), ZERO);
  }
  agg.avgCostBasis = agg.totalUnits.gt(0) ? agg.totalInvested.dividedBy(agg.totalUnits) : ZERO;
  agg.gainLossPercent = agg.totalBuyCost.gt(0) ? agg.gainLoss.div(agg.totalBuyCost).times(100) : ZERO;
  agg.converted.avgCostBasis = agg.totalUnits.gt(0)
    ? agg.converted.totalInvested.dividedBy(agg.totalUnits)
    : ZERO;
  agg.converted.gainLossPercent = agg.converted.totalBuyCost.gt(0)
    ? agg.converted.gainLoss.div(agg.converted.totalBuyCost).times(100)
    : ZERO;
  return /** @type {ReturnType<typeof buildInvestmentSummaryCore>} */ (agg);
}

/**
 * ADR-108 partition-aware summary core. Returns the investment-level core plus
 * the per-(investment, account) partition cores it decomposes into, and the
 * `fullyAssigned` transition flag.
 *
 * Semantics by case:
 *  - Unit-based, lots fully assigned, ≥2 partitions: each partition replays
 *    the SAME lot engine (the user's configured method) on its own stream —
 *    sells consume same-account lots — and the investment core is the exact
 *    partition sum, so Σ partitions ≡ investment totals BY CONSTRUCTION.
 *  - Unit-based, lots fully assigned, ≤1 partition: flat replay (identical by
 *    definition — the one partition IS the whole history), attributed to the
 *    single partition's account.
 *  - Unit-based with unassigned lots (transition rule): flat GLOBAL replay,
 *    unchanged legacy math; the whole investment is attributed to the
 *    unassigned (null) partition so no wrong per-broker figures can be shown.
 *  - Non-unit-based (no lot machinery; accrued interest is non-linear in the
 *    transaction stream, so per-row splitting cannot sum to the global
 *    figure): flat replay, attributed whole to its single account when every
 *    row names the same one, else to the unassigned partition.
 *
 * @param {{ asset_class: string, current_price?: number|string, interest_rate?: number|string }} inv
 * @param {Array<Record<string, any>>} txns
 * @param {{ costBasisMethod?: CostBasisMethod, todayYmd: string, fxMultiplierNow?: number|string }} opts
 * @returns {{
 *   core: ReturnType<typeof buildInvestmentSummaryCore>,
 *   partitions: Array<{ accountId: number|null, core: ReturnType<typeof buildInvestmentSummaryCore> }>,
 *   fullyAssigned: boolean,
 * }}
 */
export function buildInvestmentSummaryCorePartitioned(inv, txns, opts) {
  const isUnitBased = UNIT_BASED_CLASSES.has(inv.asset_class);

  if (!isUnitBased) {
    const core = buildInvestmentSummaryCore(inv, txns, opts);
    const accountKeys = new Set(txns.map(partitionKeyOf));
    const fullyAssigned = txns.length === 0
      || (accountKeys.size === 1 && !accountKeys.has(null));
    const accountId = txns.length > 0 && fullyAssigned ? [...accountKeys][0] : null;
    return {
      core,
      partitions: txns.length > 0 ? [{ accountId, core }] : [],
      fullyAssigned,
    };
  }

  const fullyAssigned = areLotsFullyAssigned(txns);
  if (!fullyAssigned) {
    const core = buildInvestmentSummaryCore(inv, txns, opts);
    return {
      core,
      partitions: txns.length > 0 ? [{ accountId: null, core }] : [],
      fullyAssigned: false,
    };
  }

  const streams = partitionTxnsByAccount(txns);
  if (streams.size <= 1) {
    const core = buildInvestmentSummaryCore(inv, txns, opts);
    const accountId = streams.size === 1 ? [...streams.keys()][0] : null;
    return {
      core,
      partitions: streams.size === 1 ? [{ accountId, core }] : [],
      fullyAssigned: true,
    };
  }

  const partitions = [...streams.entries()].map(([accountId, rows]) => ({
    accountId,
    core: buildInvestmentSummaryCore(inv, rows, opts),
  }));
  return {
    core: aggregatePartitionCores(partitions.map((p) => p.core)),
    partitions,
    fullyAssigned: true,
  };
}
