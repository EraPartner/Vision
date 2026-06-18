/**
 * Trade cash legs (ADR-090): the paired transactions-ledger row a portfolio
 * trade moves through its account's cash sleeve.
 *
 * The leg is marked is_transfer=true (so the cross-cutting `AND NOT is_transfer`
 * exclusion keeps it out of income/spending) and transfer_source='trade' (so the
 * ADR-083 reconciler — which only touches transfer_source IS NULL or 'auto' —
 * never releases this single-sided leg as an orphan). It is linked to its trade
 * via portfolio_transaction_id (ON DELETE CASCADE removes it with the trade).
 */

import { query } from '../../database/connection.js';
import { toDecimal, toNumber } from '../../lib/money.js';

/**
 * Cash movement a trade produces on its sleeve, in the trade's currency.
 * Returns null for types with no cash movement (appreciation = unrealized,
 * gift = zero-cost injection, split = units-only).
 *
 *   buy   → −(amount + fees + taxes)   (cash leaves the sleeve)
 *   sell  → +(amount − fees − taxes)   (net proceeds enter the sleeve)
 *   dividend / interest / rent_income → +amount   (income into the sleeve)
 *   fee / tax → −amount                (cash leaves the sleeve)
 *
 * @param {{type:string, amount?:number|string, fees?:number|string, taxes?:number|string}} txn
 * @returns {number|null}
 */
export function computeTradeCashLegAmount(txn) {
  const amount = toDecimal(txn.amount ?? 0);
  const fees = toDecimal(txn.fees ?? 0);
  const taxes = toDecimal(txn.taxes ?? 0);

  switch (txn.type) {
    case 'buy':
      return toNumber(amount.plus(fees).plus(taxes).negated());
    case 'sell':
      return toNumber(amount.minus(fees).minus(taxes));
    case 'dividend':
    case 'interest':
    case 'rent_income':
      return toNumber(amount);
    case 'fee':
    case 'tax':
      return toNumber(amount.negated());
    default:
      return null; // appreciation, gift, split, … → no cash movement
  }
}

/**
 * Create the cash leg for a just-created portfolio transaction on the given cash
 * account (the trade's own sleeve, or a designated funding account for a
 * sleeve-less account). No-op when the trade has no cash movement, the amount is
 * zero, or no cash account was designated. Returns the new transaction id or
 * undefined.
 *
 * @param {{ portfolioTxn: object, cashAccountId: number|undefined, client?: object }} args
 */
export async function createTradeCashLeg({ portfolioTxn, cashAccountId, client }) {
  if (!cashAccountId || !portfolioTxn) return undefined;
  const legAmount = computeTradeCashLegAmount(portfolioTxn);
  if (legAmount === null || legAmount === 0) return undefined;

  const run = client ? client.query.bind(client) : query;
  const memo = `TRADE ${String(portfolioTxn.type).toUpperCase()}`;
  const result = await run(
    `INSERT INTO transactions
       (date, amount, currency, memo, account_id, is_transfer, transfer_source, portfolio_transaction_id, is_active)
     VALUES ($1, $2, $3, $4, $5, true, 'trade', $6, true)
     RETURNING id`,
    [
      portfolioTxn.date,
      legAmount,
      portfolioTxn.currency || 'EUR',
      memo,
      cashAccountId,
      portfolioTxn.id,
    ],
  );
  return result.rows[0]?.id;
}

/**
 * App-side cascade for the trade→leg link (ADR-090). `portfolio_transaction_id` is not a FK
 * (the inheritance/view schema can't support one), so deleting a portfolio transaction must
 * delete its cash leg(s) here. Returns the number of legs removed.
 *
 * @param {number} portfolioTxnId
 * @param {object} [client]
 */
export async function deleteTradeCashLegs(portfolioTxnId, client) {
  if (!portfolioTxnId) return 0;
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    'DELETE FROM transactions WHERE portfolio_transaction_id = $1',
    [portfolioTxnId],
  );
  return result.rowCount ?? 0;
}
