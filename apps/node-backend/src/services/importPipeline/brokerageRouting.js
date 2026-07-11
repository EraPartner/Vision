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
// cash transaction on the sleeve. Split by direction so the commit step can stamp
// the sign: money INTO the sleeve is +|amount|, money OUT is -|amount|. Everything
// else cash-affecting (dividend, fee, …) rides on a trade's ADR-090 leg, so it is
// NOT listed here (that is the double-count guard).
const CASH_IN_KINDS = new Set([
  'deposit', 'deposits', 'cash deposit', 'transfer in',
  'storting', 'inleg', 'einzahlung',
]);
const CASH_OUT_KINDS = new Set([
  'withdrawal', 'withdrawals', 'cash withdrawal', 'transfer out',
  'opname', 'terugbetaling', 'auszahlung',
]);
const CASH_ONLY_KINDS = new Set([...CASH_IN_KINDS, ...CASH_OUT_KINDS]);
const PORTFOLIO_KINDS = new Set(['buy', 'sell', 'dividend', 'interest', 'fee', 'tax']);

/**
 * Signed direction for a cash-only brokerage kind: +1 for money entering the
 * sleeve (deposit / transfer-in), -1 for money leaving (withdrawal /
 * transfer-out). Mirrors CASH_ONLY_KINDS so the two never drift. Since the
 * generic adapter stores every amount as an absolute magnitude, this is the
 * single source of a cash row's sign — without it a withdrawal credits the
 * sleeve instead of debiting it. Unrecognised kinds default to +1 (import as a
 * credit rather than silently flipping an unknown row).
 *
 * @param {string} kind  raw kind string (e.g. staging `type_raw`)
 * @returns {1|-1}
 */
export function cashDirection(kind) {
  const k = String(kind || '').toLowerCase().trim();
  return CASH_OUT_KINDS.has(k) ? -1 : 1;
}

/**
 * @param {{ kind?: string }} row  parsed brokerage row (kind normalized by the adapter)
 * @returns {{ target: 'cash'|'portfolio'|'review', portfolioTxnType?: string }}
 */
export function classifyBrokerageRow(row) {
  const kind = String(row?.kind || '').toLowerCase().trim();
  if (CASH_ONLY_KINDS.has(kind)) return { target: 'cash' };
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
