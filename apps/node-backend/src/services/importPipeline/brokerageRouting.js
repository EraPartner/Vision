/**
 * Brokerage statement routing (ADR-095): classify each parsed statement row into
 * the right target so one file populates both the cash ledger and the portfolio
 * without double-counting.
 *
 * Pure functions only — no IO. The commit step uses these to fan out a row to
 * portfolioTxRepo (+ the ADR-090 cash leg) or to a plain cash transaction.
 */

// Brokerage row kinds → routing target.
//  - deposit/withdrawal: external cash in/out of the sleeve → a plain cash
//    transaction (no trade, no leg).
//  - buy/sell/dividend/interest/fee/tax: a portfolio_transaction whose ADR-090
//    cash leg IS the cash effect — so the importer never also emits a standalone
//    cash row for these (the double-count guard).
// Lowercased external-cash kinds (+ common EN/NL/DE brokerage synonyms) → a plain
// cash transaction on the sleeve. Everything else cash-affecting (dividend, fee, …)
// rides on a trade's ADR-090 leg, so it is NOT listed here (that is the double-count guard).
// Split by direction: statement magnitudes are staged ABSOLUTE (the adapters
// strip the sign), so the ledger sign must be re-derived from the kind here.
// Without it every withdrawal was credited as a deposit — sleeve cash error
// grew 2× the withdrawn amount per row.
const CASH_INFLOW_KINDS = new Set([
  'deposit', 'deposits', 'cash deposit', 'transfer in',
  'storting', 'inleg', 'terugbetaling',
  'einzahlung',
]);
const CASH_OUTFLOW_KINDS = new Set([
  'withdrawal', 'withdrawals', 'cash withdrawal', 'transfer out',
  'opname',
  'auszahlung',
]);
const PORTFOLIO_KINDS = new Set(['buy', 'sell', 'dividend', 'interest', 'fee', 'tax']);

/**
 * @param {{ kind?: string }} row  parsed brokerage row (kind normalized by the adapter)
 * @returns {{ target: 'cash'|'portfolio'|'review', portfolioTxnType?: string, direction?: 1|-1 }}
 *   `direction` is set for cash targets: +1 credits the sleeve (deposit),
 *   −1 debits it (withdrawal).
 */
export function classifyBrokerageRow(row) {
  const kind = String(row?.kind || '').toLowerCase().trim();
  if (CASH_INFLOW_KINDS.has(kind)) return { target: 'cash', direction: 1 };
  if (CASH_OUTFLOW_KINDS.has(kind)) return { target: 'cash', direction: -1 };
  if (PORTFOLIO_KINDS.has(kind)) return { target: 'portfolio', portfolioTxnType: kind };
  // Unknown / ambiguous → block on review rather than guess (ADR-095).
  return { target: 'review' };
}

/**
 * Stable dedup key for a trade row, so re-importing the same statement is a
 * no-op. Cash rows dedup via the existing tx_hash partial-unique instead.
 *
 * @param {{ account_id:number|string, investment_id:number|string, date:string, kind:string, units?:number|string, amount?:number|string }} row
 * @returns {string}
 */
export function tradeDedupKey(row) {
  const norm = (v) => (v == null ? '' : String(v).trim());
  return [
    norm(row.account_id),
    norm(row.investment_id),
    norm(row.date),
    norm(row.kind).toLowerCase(),
    norm(row.units),
    norm(row.amount),
  ].join('|');
}
