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

import { query } from "../database/connection.js";
import { convertToCurrency } from "./currency/currencyConversionService.js";
import { getPortfolioSummary } from "./portfolio/portfolioSummaryService.js";
import { toDecimal, toNumber, roundToCents } from "../lib/money.js";
import { computedBalanceByCurrencyAggLateral } from "../repositories/accountBalanceSql.js";
import { todayAppDateString } from "../lib/timezone.js";

// Roll the fine-grained `asset_class` taxonomy up into the coarse allocation
// sleeves the classic-portfolio presets target (CLASSIC_PORTFOLIOS uses
// stocks/bonds/gold/...). Without this the preset keys never match a real asset
// class, so every plan deploys cash into phantom €0 sleeves. Equity ETFs roll
// into `stocks` and precious metals into `gold`; unmapped classes (crypto,
// real_estate, savings) keep their own key and simply carry a 0% target.
const SLEEVE_ROLLUP = Object.freeze({
  stock: "stocks",
  etf: "stocks",
  bond: "bonds",
  metals: "gold",
});

/**
 * Actual sleeve values (Σ current value, target currency) keyed by the coarse
 * allocation sleeve (asset_class rolled up via SLEEVE_ROLLUP to match the
 * classic-portfolio target vocabulary), plus the deployable cash from spendable
 * accounts, so `rebalanceDeployment` lines actuals up against the target weights.
 *
 * Each `cashAccounts` entry names BOTH currencies in play, because they differ:
 * `balance` is the account's cash converted into the target currency (it is a
 * summand of `availableCash`), while `accountCurrency` is only the account's own
 * declared code. The entry used to carry the latter under a bare `currency`,
 * which read as the denomination of the `balance` beside it and would label a
 * EUR-converted figure "USD".
 *
 * @param {{ currency?: string }} args
 * @returns {Promise<{ currency: string, actualValues: Record<string, number>, availableCash: number, cashAccounts: Array<{ id:number, name:string, accountCurrency:string, balance:number, balanceCurrency:string }> }>}
 */
export async function assembleRebalanceInputs({ currency = "EUR" } = {}) {
  const target = (currency || "EUR").toUpperCase();

  const { summaries } = await getPortfolioSummary(target);
  const actualValues = /** @type {Record<string, number>} */ ({});
  // getPortfolioSummary's JSDoc return type is deliberately loose
  // (`summaries: object[]`) since portfolioSummaryService.js is outside this
  // ratchet slice — narrow locally to the two fields this loop actually reads.
  const typedSummaries =
    /** @type {Array<{ asset_class?: string, currentValue?: number }>} */ (
      summaries
    );
  for (const s of typedSummaries) {
    const assetClass = s.asset_class || "other";
    const key = /** @type {string} */ (
      SLEEVE_ROLLUP[/** @type {keyof typeof SLEEVE_ROLLUP} */ (assetClass)] ??
        assetClass
    );
    actualValues[key] = toNumber(
      roundToCents(
        toDecimal(actualValues[key] ?? 0).plus(toDecimal(s.currentValue ?? 0)),
      ),
    );
  }

  // Available cash = the deployable balance of every spendable, active account
  // (ADR-089 `spendable` flag), each converted to the target currency. Uses the
  // account's computed balance (ADR-094) — the same anchored running balance the
  // accounts hub and dashboard show (latest stamped statement balance, which
  // embeds the opening balance, advanced by subsequent unstamped activity) —
  // via the shared per-currency helper.
  //
  // Per CURRENCY PARTITION, not per account: the unpartitioned lateral summed a
  // EUR amount and a USD amount as bare numbers and this loop then converted the
  // total at the single rate of `a.currency` (100 EUR + 100 USD at 0.5 → 100
  // deployable instead of 150). Each partition is converted on its own and the
  // per-account converted total is what lands in `cashAccounts` / availableCash.
  // Single-currency accounts have exactly one partition and are unaffected; the
  // aggregated (one row per account) form keeps `cashAccounts` one entry per
  // account, including a spendable account with no ledger rows at all (NULL
  // parts → a 0 entry, as before).
  const { rows } = await query(
    `SELECT a.id, a.name, a.currency, bp.balance_parts
       FROM accounts a
       ${computedBalanceByCurrencyAggLateral({ account: "a.id", asOfDate: "$1::date" })}
      WHERE a.spendable = true AND a.is_active = true
      ORDER BY a.name`,
    [todayAppDateString()],
  );

  const cashAccounts = [];
  let availableCash = toDecimal(0);
  for (const r of rows) {
    const acctCurrency = (r.currency || "EUR").toUpperCase();
    /** @type {Array<{ currency: string, balance: string }>} */
    const partitions = r.balance_parts ?? [];
    let accountTotal = toDecimal(0);
    for (const part of partitions) {
      const partCurrency = (part.currency || "EUR").toUpperCase();
      const native = toNumber(toDecimal(part.balance));
      const converted =
        partCurrency === target
          ? native
          : await convertToCurrency(native, partCurrency, target);
      accountTotal = accountTotal.plus(toDecimal(converted));
    }
    availableCash = availableCash.plus(accountTotal);
    // Both currencies are named explicitly: `balance` is the per-account total
    // CONVERTED into `target` (that is what makes it summable into
    // `availableCash`), and the account's own declared code is a separate,
    // separately-named field. A single `currency` key next to a money figure
    // reads as that figure's denomination, so carrying the account code there
    // mislabelled every foreign-currency account's converted balance.
    cashAccounts.push({
      id: Number(r.id),
      name: r.name,
      accountCurrency: acctCurrency,
      balance: toNumber(roundToCents(accountTotal)),
      balanceCurrency: target,
    });
  }

  return {
    currency: target,
    actualValues,
    availableCash: toNumber(roundToCents(availableCash)),
    cashAccounts,
  };
}

export default { assembleRebalanceInputs };
