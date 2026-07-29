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
import { buildHistoricalRateIndex, findRateOnOrBeforeInIndex } from '../currency/rateFetcher.js';
import { buildInvestmentSummaryCore } from '@vision/shared-utils/portfolio';
import { settingsRepository } from '../../repositories/settingsRepository.js';
import { portfolioTransactionRepository } from '../../repositories/portfolioTransactionRepository.js';
import { todayAppDateString } from '../../lib/timezone.js';
import { toDecimal, addAll, multiply, divide, roundMoney } from '../../lib/money.js';

/** @typedef {import('@vision/shared-utils/money').DecimalInput} DecimalInput */
/** @typedef {import('decimal.js').default} Decimal */

/** @param {DecimalInput} value */
const round2 = (value) => roundMoney(value, 2);
/** @param {DecimalInput} value */
const round6 = (value) => roundMoney(value, 6);

const COST_BASIS_METHODS = new Set(['weighted_avg', 'fifo', 'lifo']);

/** @typedef {import('@vision/shared-utils/portfolio').CostBasisMethod} CostBasisMethod */

/**
 * `investments` row from `SELECT i.*, COALESCE(...)` above — same shape as
 * {@link import('../../types/rows.js').InvestmentRow} except `current_price`
 * and `interest_rate` are COALESCE-defaulted (never null) and NOT coerced to
 * number here — still pg NUMERIC strings, parsed downstream with `Number()`.
 * @typedef {Omit<import('../../types/rows.js').InvestmentRow, 'current_price'|'interest_rate'> & {
 *   current_price: string,
 *   interest_rate: string,
 *   description?: undefined,
 * }} RawInvestmentRow
 */
// `description` is NOT an `investments` column (see 0001_initial_database_schema.py)
// — buildInvestmentSummary's `description: inv.description` below has always
// evaluated to `undefined`. Typed as such (rather than dropped) to keep this
// slice behavior-preserving; flagged in the ratchet report as a probable dead
// field for the orchestrator to triage.

/**
 * A {@link import('../../types/rows.js').PortfolioMathTxRow} after
 * `annotateTransactionFxMultipliers`: every txn used downstream also carries
 * an `fxMultiplier` (its currency → target multiplier, resolved at its date)
 * and, when neither the stamped nor a historical rate could be resolved,
 * `_fxFellBack: true`.
 * @typedef {import('../../types/rows.js').PortfolioMathTxRow & {
 *   fxMultiplier?: number,
 *   _fxFellBack?: boolean,
 * }} AnnotatedTxRow
 */

/**
 * Resolve the user's configured cost-basis method (Settings → General).
 * Falls back to weighted_avg on missing/invalid values or repository errors —
 * a summary must never fail because a setting row is malformed.
 *
 * @returns {Promise<CostBasisMethod>}
 */
async function resolveCostBasisMethod() {
  try {
    const value = await settingsRepository.get('cost_basis_method');
    return COST_BASIS_METHODS.has(value) ? /** @type {CostBasisMethod} */ (value) : 'weighted_avg';
  } catch {
    return 'weighted_avg';
  }
}

/**
 * Fetch active investments and their transactions, then compute per-investment
 * summaries plus aggregated totals — all pre-converted to targetCurrency.
 *
 * @param {string} targetCurrency
 * @returns {Promise<{
 *   currency: string,
 *   computed_at: string,
 *   totals: ReturnType<typeof aggregateTotals>,
 *   summaries: ReturnType<typeof buildInvestmentSummary>[],
 *   byAccount: ReturnType<typeof aggregateByAccount>,
 * }>}
 */
export async function getPortfolioSummary(targetCurrency = 'EUR') {
  const target = (targetCurrency || 'EUR').toUpperCase();

  const costBasisMethod = await resolveCostBasisMethod();
  const todayYmd = todayAppDateString();

  const [investmentsResult, txnRows] = await Promise.all([
    /** @type {Promise<{ rows: RawInvestmentRow[] }>} */ (query(`
      SELECT i.*,
             COALESCE(i.currency, 'EUR') AS currency,
             COALESCE(i.current_price, 0) AS current_price,
             COALESCE(i.interest_rate, 0) AS interest_rate
      FROM investments i
      WHERE i.is_active = true
      ORDER BY i.name
    `)),
    /** @type {Promise<AnnotatedTxRow[]>} */ (
      portfolioTransactionRepository.getRowsForPortfolioMath({ activeInvestmentsOnly: true })
    ),
  ]);

  const txnsByInvestment = new Map();
  for (const txn of txnRows) {
    const id = Number(txn.investment_id);
    if (!txnsByInvestment.has(id)) txnsByInvestment.set(id, []);
    txnsByInvestment.get(id).push(txn);
  }

  // Resolve the FX multiplier once per *distinct* currency rather than once
  // per investment — buildInvestmentSummary then runs synchronously. Both
  // investment currencies (current-value conversion) and transaction
  // currencies (per-txn fallback) are needed.
  const distinctCurrencies = [
    ...new Set([
      ...investmentsResult.rows.map((inv) => (inv.currency || 'EUR').toUpperCase()),
      ...txnRows.map((txn) => (txn.currency || 'EUR').toUpperCase()),
    ]),
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

  // Historical rates for every involved currency (plus the target), so each
  // transaction converts at the rate of ITS date — invested capital must not
  // move when today's rate does (the FX-attribution contract).
  const historicalIndex = await loadHistoricalRateIndex(distinctCurrencies, target);
  annotateTransactionFxMultipliers(txnRows, target, historicalIndex, multiplierByCurrency);

  const summaries = investmentsResult.rows.map((inv) =>
    buildInvestmentSummary(inv, txnsByInvestment.get(Number(inv.id)) ?? [], target, multiplierByCurrency, {
      costBasisMethod,
      todayYmd,
    })
  );

  const totals = aggregateTotals(summaries);
  const byAccount = aggregateByAccount(
    investmentsResult.rows,
    txnsByInvestment,
    target,
    multiplierByCurrency,
    { costBasisMethod, todayYmd },
  );

  return {
    currency: target,
    computed_at: new Date().toISOString(),
    totals,
    summaries,
    byAccount,
  };
}

/**
 * Per-account holdings breakdown (ADR-091 / ADR-093 supersession): split each
 * investment's lots by account_id, run the SAME per-investment math per group,
 * and aggregate market value / cost / gain per account. By construction Σ byAccount
 * equals the per-investment totals (locked by a parity test). Unassigned lots
 * (account_id NULL) collapse into a single { account_id: null } row. Names are
 * resolved by the caller (the accounts list) — this returns ids only.
 *
 * @param {RawInvestmentRow[]} investmentRows
 * @param {Map<number, AnnotatedTxRow[]>} txnsByInvestment
 * @param {string} target
 * @param {Map<string, number>} multiplierByCurrency
 * @param {{ costBasisMethod: CostBasisMethod, todayYmd: string }} opts
 */
function aggregateByAccount(investmentRows, txnsByInvestment, target, multiplierByCurrency, opts) {
  /** @type {Map<number|null, { account_id: number|null, currentValue: Decimal, totalInvested: Decimal, gainLoss: Decimal }>} */
  const acc = new Map(); // account_id (or null) → aggregate
  for (const inv of investmentRows) {
    const txns = txnsByInvestment.get(Number(inv.id)) ?? [];
    /** @type {Map<number|null, AnnotatedTxRow[]>} */
    const groups = new Map();
    for (const txn of txns) {
      const key = txn.account_id == null ? null : Number(txn.account_id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(txn);
    }
    for (const [accountId, groupTxns] of groups) {
      const s = buildInvestmentSummary(inv, groupTxns, target, multiplierByCurrency, opts);
      const cur = acc.get(accountId) ?? {
        account_id: accountId,
        currentValue: toDecimal(0),
        totalInvested: toDecimal(0),
        gainLoss: toDecimal(0),
      };
      cur.currentValue = cur.currentValue.plus(s.currentValue);
      cur.totalInvested = cur.totalInvested.plus(s.totalBuyCost);
      cur.gainLoss = cur.gainLoss.plus(s.gainLoss);
      acc.set(accountId, cur);
    }
  }
  return [...acc.values()]
    .map((a) => ({
      account_id: a.account_id,
      currentValue: round2(a.currentValue),
      totalInvested: round2(a.totalInvested),
      gainLoss: round2(a.gainLoss),
    }))
    .sort((x, y) => y.currentValue - x.currentValue);
}

/**
 * Load all stored historical rates for the involved currencies into an
 * in-memory index (sorted per currency, binary-searched per lookup).
 *
 * @param {string[]} currencies
 * @param {string} target
 * @returns {Promise<import('../../types/rows.js').HistoricalRateIndex>}
 */
async function loadHistoricalRateIndex(currencies, target) {
  const relevant = [...new Set([...currencies, target])].filter((c) => c && c !== 'EUR');
  if (relevant.length === 0) return new Map();
  /** @type {{ rows: Array<Pick<import('../../types/rows.js').ExchangeRateRow, 'currency_code'|'rate_to_eur'> & { rate_date: string }> }} */
  const result = await query(
    `SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_to_eur
     FROM exchange_rates
     WHERE currency_code = ANY($1::text[])
     ORDER BY currency_code ASC, rate_date ASC`,
    [relevant]
  );
  return buildHistoricalRateIndex(result.rows || []);
}

/**
 * Attach `fxMultiplier` (txn currency → target at the txn's date) to each
 * transaction row, preferring the rate stamped on the transaction
 * (fx_rate_to_eur). Rows whose historical rate is unresolvable fall back to
 * today's rate and are flagged so the response can disclose it.
 *
 * @param {AnnotatedTxRow[]} txns
 * @param {string} target
 * @param {import('../../types/rows.js').HistoricalRateIndex} historicalIndex
 * @param {Map<string, number>} multiplierByCurrency
 */
function annotateTransactionFxMultipliers(txns, target, historicalIndex, multiplierByCurrency) {
  for (const txn of txns) {
    const txnCurrency = (txn.currency || 'EUR').toUpperCase();
    if (txnCurrency === target) {
      txn.fxMultiplier = 1;
      continue;
    }

    const stampedRate = Number(txn.fx_rate_to_eur);
    const rateFrom = Number.isFinite(stampedRate) && stampedRate > 0
      ? stampedRate
      : findRateOnOrBeforeInIndex(historicalIndex, txnCurrency, txn.date);
    const rateTo = target === 'EUR'
      ? 1
      : findRateOnOrBeforeInIndex(historicalIndex, target, txn.date);

    if (rateFrom !== undefined && rateTo !== undefined && rateTo > 0) {
      txn.fxMultiplier = rateFrom / rateTo;
    } else {
      txn.fxMultiplier = multiplierByCurrency.get(txnCurrency) ?? 1;
      txn._fxFellBack = true;
    }
  }
}

/**
 * Compute a rich summary for a single investment, with all monetary fields
 * pre-converted to targetCurrency.
 *
 * The math lives in @vision/shared-utils/portfolio (buildInvestmentSummaryCore)
 * and is shared verbatim with the frontend hook — only FX conversion, rounding
 * and response shaping happen here. Flow amounts (invested, buy cost, fees,
 * income, realized gains) convert at their transaction-date rates; holdings
 * values (current value/price, accrued interest) convert at today's rate. The
 * resulting gain therefore includes the FX component, decomposed into
 * assetGain + fxGain (ADR: FX attribution).
 *
 * @param {RawInvestmentRow} inv  raw investment row
 * @param {AnnotatedTxRow[]}  txns transaction rows for this investment (fxMultiplier-annotated)
 * @param {string} targetCurrency
 * @param {Map<string, number>} multiplierByCurrency  FX multiplier per currency
 * @param {{ costBasisMethod: CostBasisMethod, todayYmd: string }} opts
 */
function buildInvestmentSummary(inv, txns, targetCurrency, multiplierByCurrency, opts) {
  const invCurrency = (inv.currency || 'EUR').toUpperCase();
  // Multiplier was resolved once per distinct currency by the caller.
  const multiplier = multiplierByCurrency.get(invCurrency) ?? 1;

  const core = buildInvestmentSummaryCore(inv, txns, { ...opts, fxMultiplierNow: multiplier });
  const cv = core.converted;
  /** @param {DecimalInput} v */
  const conv = (v) => multiply(v, multiplier);

  const convertedCurrentValue = cv.currentValue;
  const convertedTotalInvested = cv.totalInvested;
  const convertedTotalBuyCost = cv.totalBuyCost;
  const convertedTotalSellProceeds = cv.totalSellProceeds;
  const convertedTotalFees = cv.totalFees;
  const convertedTotalTaxes = cv.totalTaxes;
  const convertedTotalDividends = cv.totalDividends;
  const convertedTotalIncome = cv.totalIncome;
  const convertedRealizedGain = cv.realizedGain;
  const convertedUnrealizedGain = cv.unrealizedGain;
  const convertedTotalGain = cv.totalGain;
  const convertedGainLoss = cv.gainLoss;
  const convertedAvgCostBasis = cv.avgCostBasis;
  const convertedAccruedInterest = conv(core.accruedInterest);
  const convertedProjectedInterest = conv(core.projectedAnnualInterest);
  const convertedTotalAppreciation = conv(core.totalAppreciation);
  const convertedCurrentPrice = conv(Number(inv.current_price) || 0);
  const { totalUnits } = core;
  const gainLossPercent = cv.gainLossPercent;
  const usedFallbackRate = txns.some((t) => t._fxFellBack === true);

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

    // FX attribution: gainLoss = assetGain (native performance at today's
    // rate) + fxGain (currency effect). nativeCurrentValue is the holding's
    // value in its own currency, untouched by FX.
    assetGain: round2(cv.assetGain),
    fxGain: round2(cv.fxGain),
    nativeCurrentValue: round2(core.currentValue),
    usedFallbackRate,

    accruedInterest: round2(convertedAccruedInterest),
    projectedAnnualInterest: round2(convertedProjectedInterest),
    totalAppreciation: round2(convertedTotalAppreciation),
  };
}

/**
 * Reduce per-investment summaries into portfolio-wide totals.
 * All values are already in the same target currency, so straight summation.
 */
// Note on the "invested" definition (see TODO audit): `totalInvested` here sums
// per-investment `totalBuyCost`, which for unit-based assets is gross cash in
// INCLUDING acquisition fees/taxes (calculateCostBasis folds them in), and for
// fixed-income/real-estate is the buy/gift amount only. The frontend mirror
// matches. Treat this as "gross buy cost (acquisition costs included where the
// asset class records them per-row)"; documented here rather than re-grained to
// avoid changing every reported invested figure.
/** @param {ReturnType<typeof buildInvestmentSummary>[]} summaries */
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
    totalAssetGain: addAll(summaries.map((s) => s.assetGain)),
    totalFxGain: addAll(summaries.map((s) => s.fxGain)),
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
    totalAssetGain: round2(acc.totalAssetGain),
    totalFxGain: round2(acc.totalFxGain),
    totalReturnPct: round2(totalReturnPct),
    usedFallbackRate: summaries.some((s) => s.usedFallbackRate === true),
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
    assetGain: s.assetGain,
    fxGain: s.fxGain,
    nativeCurrentValue: s.nativeCurrentValue,
    usedFallbackRate: s.usedFallbackRate,
  }));
}
