/**
 * Cross-workspace data assembly (ADR-098) — the IO layer that gathers the
 * Budgeting + Portfolio inputs the pure cores in `crossWorkspaceAnalytics.js`
 * consume. Kept separate from those cores so the math stays pure/unit-tested and
 * only this file touches the DB.
 *
 *  - assembleRebalanceInputs: actual sleeve values (portfolio, rolled up to the
 *    allocation-sleeve vocabulary) + available cash (Σ spendable account computed
 *    balances, FX-converted).
 *  - assembleUnifiedTaxItems: owner-allocated portfolio dividends/interest +
 *    realized gains for a tax year; the caller supplies earned income (the
 *    frontend already holds the authoritative tax-profile gross).
 *
 * The realized-gain figure is INDICATIVE — it values each in-year sale at the
 * holding's current weighted-average cost basis, not the basis at sale time
 * (ADR-098: this is a composed *view*, not a tax re-derivation).
 */

import { query } from '../database/connection.js';
import { convertToCurrency } from './currency/currencyConversionService.js';
import { getPortfolioSummary } from './portfolio/portfolioSummaryService.js';
import { toDecimal, toNumber, roundToCents } from '../lib/money.js';

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
  for (const s of summaries) {
    const assetClass = s.asset_class || 'other';
    const key = SLEEVE_ROLLUP[assetClass] ?? assetClass;
    actualValues[key] = toNumber(roundToCents(toDecimal(actualValues[key] ?? 0).plus(toDecimal(s.currentValue ?? 0))));
  }

  // Available cash = the deployable balance of every spendable, active account
  // (ADR-089 `spendable` flag), each converted to the target currency. Uses the
  // account's computed balance (ADR-094: the latest active transaction's running
  // balance, which includes the opening balance) — the same figure the accounts
  // hub and dashboard show — not Σ(amount), which omits the opening balance.
  const { rows } = await query(
    `SELECT a.id, a.name, a.currency,
            COALESCE(lb.balance, 0) AS balance
       FROM accounts a
       LEFT JOIN LATERAL (
         SELECT t.balance FROM transactions t
         WHERE t.account_id = a.id AND t.is_active = true AND t.balance IS NOT NULL
         ORDER BY t.date DESC, t.id DESC
         LIMIT 1
       ) lb ON true
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

/**
 * Owner-allocated tax items for `year`. Portfolio dividends/interest and realized
 * gains are sourced from `portfolio_transactions` and attributed to the owner of
 * the holding's account (`me` | `partner` | `joint`; unassigned → `me`). The
 * caller passes earned income (kind `earned_income`) since the tax-profile gross
 * lives in the frontend.
 *
 * @param {{ year: number, currency?: string, earnedIncome?: number, earnedIncomeOwner?: string }} args
 * @returns {Promise<Array<{ amount:number, owner:string, kind:string }>>}
 */
export async function assembleUnifiedTaxItems({ year, currency = 'EUR', earnedIncome = 0, earnedIncomeOwner = 'me' }) {
  const target = (currency || 'EUR').toUpperCase();
  const items = [];

  const earned = Number(earnedIncome) || 0;
  if (earned > 0) {
    items.push({ amount: toNumber(roundToCents(toDecimal(earned))), owner: normalizeOwner(earnedIncomeOwner), kind: 'earned_income' });
  }

  // Dividend + interest income recorded in the year, per owning account.
  const incomeRows = await query(
    `SELECT COALESCE(a.owner, 'me') AS owner,
            COALESCE(pt.currency, i.currency, 'EUR') AS currency,
            COALESCE(SUM(pt.amount), 0) AS total
       FROM portfolio_transactions pt
       JOIN investments i ON i.id = pt.investment_id
       LEFT JOIN accounts a ON a.id = pt.account_id
      WHERE pt.type IN ('dividend', 'interest')
        AND EXTRACT(YEAR FROM pt.date::date) = $1
      GROUP BY a.owner, COALESCE(pt.currency, i.currency, 'EUR')`,
    [year],
  );
  for (const r of incomeRows.rows) {
    const cur = (r.currency || 'EUR').toUpperCase();
    const native = Number(r.total) || 0;
    if (native === 0) continue;
    const converted = cur === target ? native : await convertToCurrency(native, cur, target);
    items.push({ amount: toNumber(roundToCents(toDecimal(converted))), owner: normalizeOwner(r.owner), kind: 'dividend_income' });
  }

  // Realized gains: value each in-year sale at the holding's CURRENT weighted-avg
  // cost basis (indicative; see file header). avgCostBasis from the summary is
  // already in the target currency, so the whole computation stays in `target`.
  const { summaries } = await getPortfolioSummary(target);
  const avgCostByInvestment = new Map(summaries.map((s) => [Number(s.id), Number(s.avgCostBasis) || 0]));

  const sellRows = await query(
    `SELECT pt.investment_id,
            COALESCE(a.owner, 'me') AS owner,
            COALESCE(pt.currency, i.currency, 'EUR') AS currency,
            COALESCE(pt.amount, 0) AS amount,
            COALESCE(pt.units, 0) AS units
       FROM portfolio_transactions pt
       JOIN investments i ON i.id = pt.investment_id
       LEFT JOIN accounts a ON a.id = pt.account_id
      WHERE pt.type = 'sell'
        AND EXTRACT(YEAR FROM pt.date::date) = $1`,
    [year],
  );
  const gainByOwner = new Map();
  for (const r of sellRows.rows) {
    const cur = (r.currency || 'EUR').toUpperCase();
    const proceedsNative = Number(r.amount) || 0;
    const proceeds = cur === target ? proceedsNative : await convertToCurrency(proceedsNative, cur, target);
    const cost = (Number(r.units) || 0) * (avgCostByInvestment.get(Number(r.investment_id)) ?? 0);
    const owner = normalizeOwner(r.owner);
    gainByOwner.set(owner, toDecimal(gainByOwner.get(owner) ?? 0).plus(toDecimal(proceeds)).minus(toDecimal(cost)));
  }
  for (const [owner, gain] of gainByOwner) {
    const value = toNumber(roundToCents(gain));
    if (value !== 0) items.push({ amount: value, owner, kind: 'realized_gains' });
  }

  return items;
}

function normalizeOwner(owner) {
  return owner === 'partner' || owner === 'joint' ? owner : 'me';
}

export default { assembleRebalanceInputs, assembleUnifiedTaxItems };
