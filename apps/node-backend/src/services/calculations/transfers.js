/**
 * Internal-transfer matching (ADR-083). Pure — no DB / IO.
 *
 * A transfer is a pair of equal-and-opposite transactions on two *different*
 * own accounts within a small date window. A pair auto-confirms only when the
 * match is mutually unambiguous (exactly one candidate inflow for the outflow
 * AND exactly one candidate outflow for that inflow); anything contended is
 * returned as a suggestion for the user to resolve. This keeps auto-marking
 * conservative and pushes ambiguity to the UI rather than guessing.
 */

const DAY_MS = 86_400_000;
/** @param {Date|string} d */
const toMs = (d) => (d instanceof Date ? d : new Date(d)).getTime();
/** @param {import('../../types/rows.js').TransactionRow} t */
const ccyOf = (t) => t.currency || 'EUR';

/**
 * Resolve candidate (outId, inId) pairs into unambiguous auto-pairs and
 * ambiguous suggestions.
 * @param {{outId:number, inId:number}[]} candidatePairs
 * @returns {{autoPairs:{outId:number,inId:number}[], suggestions:{outId:number,candidateInIds:number[]}[]}}
 */
export function resolveTransferMatches(candidatePairs) {
  /** @type {Map<number, number[]>} */
  const outToIns = new Map();
  /** @type {Map<number, number[]>} */
  const inToOuts = new Map();
  for (const { outId, inId } of candidatePairs) {
    if (!outToIns.has(outId)) outToIns.set(outId, []);
    if (!inToOuts.has(inId)) inToOuts.set(inId, []);
    outToIns.get(outId).push(inId);
    inToOuts.get(inId).push(outId);
  }

  const autoPairs = [];
  const usedIn = new Set();
  for (const [outId, ins] of outToIns) {
    if (ins.length === 1 && inToOuts.get(ins[0]).length === 1) {
      autoPairs.push({ outId, inId: ins[0] });
      usedIn.add(ins[0]);
    }
  }

  const autoOut = new Set(autoPairs.map((p) => p.outId));
  const suggestions = [];
  for (const [outId, ins] of outToIns) {
    if (autoOut.has(outId)) continue;
    const candidateInIds = ins.filter((id) => !usedIn.has(id));
    if (candidateInIds.length) suggestions.push({ outId, candidateInIds });
  }

  return { autoPairs, suggestions };
}

/**
 * Build candidate pairs from a transaction list, then resolve them. Used for
 * tests and small / backfill sets; the reconciliation service builds candidate
 * pairs in SQL for scale and calls {@link resolveTransferMatches} directly.
 *
 * Only "open" rows participate: active, not already a transfer, not manually
 * decided, non-zero amount, attributed to an account. Account identity is the
 * `account_id` FK (ADR-088 — the reconciliation service's SQL sibling,
 * `listTransferCandidatePairs`, keys on the same column), never the retired
 * `bank_account` string.
 * @param {Array<import('../../types/rows.js').TransactionRow>} transactions
 * @param {{windowDays?:number}} [opts]
 */
export function findTransferMatches(transactions, { windowDays = 3 } = {}) {
  const open = transactions.filter(
    (t) =>
      t.is_active !== false &&
      !t.is_transfer &&
      t.transfer_source == null &&
      Number(t.amount) !== 0 &&
      t.account_id != null,
  );
  const outs = open.filter((t) => Number(t.amount) < 0);
  const ins = open.filter((t) => Number(t.amount) > 0);
  const win = windowDays * DAY_MS;

  const candidatePairs = [];
  for (const o of outs) {
    for (const i of ins) {
      if (Number(i.amount) !== -Number(o.amount)) continue;
      if (ccyOf(i) !== ccyOf(o)) continue;
      if (i.account_id === o.account_id) continue;
      if (Math.abs(toMs(i.date) - toMs(o.date)) > win) continue;
      candidatePairs.push({ outId: o.id, inId: i.id });
    }
  }
  return resolveTransferMatches(candidatePairs);
}
