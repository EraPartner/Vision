/**
 * Cross-workspace data assembly (ADR-098) — the IO layer that gathers the
 * Budgeting + Portfolio inputs the pure cores in `crossWorkspaceAnalytics.js`
 * consume. Kept separate from those cores so the math stays pure/unit-tested and
 * only this file touches the DB.
 *
 *  - assembleRebalanceInputs: actual sleeve values (portfolio, rolled up to the
 *    allocation-sleeve vocabulary) + available cash (Σ spendable account computed
 *    balances, FX-converted).
 */

import { query } from '../database/connection.js';
import { convertToCurrency } from './currency/currencyConversionService.js';
import { getPortfolioSummary } from './portfolio/portfolioSummaryService.js';
import { toDecimal, toNumber, roundToCents } from '../lib/money.js';
import { COMPUTED_BALANCE_LATERAL } from '../repositories/accountBalanceSql.js';

// Roll the fine-grained `asset_class` taxonomy up into the coarse allocation
// sleeves the classic-portfolio presets target (CLASSIC_PORTFOLIOS uses
// stocks/bonds/gold/...). Without this the preset keys never match a real asset
// class, so every plan deploys cash into phantom €0 sleeves. Equity ETFs roll
// into `stocks` and precious metals into `gold`; unmapped classes (crypto,
// real_estate, savings) keep their own key and simply carry a 0% target.
const SLEEVE_ROLLUP = Object.freeze({
  stock: 'stocks',
  etf: 'stocks',
  bond: 'bonds',
  metals: 'gold',
});

/**
 * Actual sleeve values (Σ current value, target currency) keyed by the coarse
 * allocation sleeve (asset_class rolled up via SLEEVE_ROLLUP to match the
 * classic-portfolio target vocabulary), plus the deployable cash from spendable
 * accounts, so `rebalanceDeployment` lines actuals up against the target weights.
 *
 * @param {{ currency?: string }} args
 * @returns {Promise<{ currency: string, actualValues: Record<string, number>, availableCash: number, cashAccounts: Array<{ id:number, name:string, currency:string, balance:number }> }>}
 */
export async function assembleRebalanceInputs({ currency = 'EUR' } = {}) {
  const target = (currency || 'EUR').toUpperCase();

  const { summaries } = await getPortfolioSummary(target);
  const actualValues = /** @type {Record<string, number>} */ ({});
  // getPortfolioSummary's JSDoc return type is deliberately loose
  // (`summaries: object[]`) since portfolioSummaryService.js is outside this
  // ratchet slice — narrow locally to the two fields this loop actually reads.
  const typedSummaries = /** @type {Array<{ asset_class?: string, currentValue?: number }>} */ (summaries);
  for (const s of typedSummaries) {
    const assetClass = s.asset_class || 'other';
    const key = /** @type {string} */ (SLEEVE_ROLLUP[/** @type {keyof typeof SLEEVE_ROLLUP} */ (assetClass)] ?? assetClass);
    actualValues[key] = toNumber(roundToCents(toDecimal(actualValues[key] ?? 0).plus(toDecimal(s.currentValue ?? 0))));
  }

  // Available cash = the deployable balance of every spendable, active account
  // (ADR-089 `spendable` flag), each converted to the target currency. Uses the
  // account's computed balance (ADR-094) — the same anchored running balance the
  // accounts hub and dashboard show (latest stamped statement balance, which
  // embeds the opening balance, advanced by subsequent unstamped activity) —
  // via the shared COMPUTED_BALANCE_LATERAL helper.
  const { rows } = await query(
    `SELECT a.id, a.name, a.currency,
            COALESCE(lb.balance, 0) AS balance
       FROM accounts a
       ${COMPUTED_BALANCE_LATERAL}
      WHERE a.spendable = true AND a.is_active = true
      ORDER BY a.name`,
  );

  const cashAccounts = [];
  let availableCash = toDecimal(0);
  for (const r of rows) {
    const acctCurrency = (r.currency || 'EUR').toUpperCase();
    const native = Number(r.balance) || 0;
    const converted = acctCurrency === target ? native : await convertToCurrency(native, acctCurrency, target);
    availableCash = availableCash.plus(toDecimal(converted));
    cashAccounts.push({ id: Number(r.id), name: r.name, currency: acctCurrency, balance: toNumber(roundToCents(toDecimal(converted))) });
  }

  return {
    currency: target,
    actualValues,
    availableCash: toNumber(roundToCents(availableCash)),
    cashAccounts,
  };
}

export default { assembleRebalanceInputs };
