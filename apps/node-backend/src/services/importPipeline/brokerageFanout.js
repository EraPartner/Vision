/**
 * Brokerage statement fan-out (ADR-095) — the "dangerous part": route one parsed
 * statement into the cash ledger AND the portfolio, link each trade to its ADR-090
 * cash leg, and dedup both sides so re-import is a no-op.
 *
 * The double-count guard: a trade contributes EXACTLY ONE cash movement — its
 * auto-created cash leg — never a second standalone cash row. Only external cash
 * movements (deposit/withdrawal) become plain cash transactions; buy/sell/
 * dividend/interest/fee/tax become portfolio_transactions whose leg IS the cash
 * effect. Unknown kinds block on review rather than guess.
 *
 * `planBrokerageFanout` is pure (classification + dedup keys + leg amounts);
 * `commitBrokerageFanout` applies it through the existing per-row-atomic import
 * pattern (ADR-078) with field-based dedup for idempotency.
 */

import { query } from '../../database/connection.js';
import portfolioTransactionRepository from '../../repositories/portfolioTransactionRepository.js';
import { createTradeCashLeg, computeTradeCashLegAmount } from '../portfolio/tradeCashLegService.js';
import { classifyBrokerageRow, tradeDedupKey } from './brokerageRouting.js';

const cashDedupKey = (accountId, row) =>
  [accountId, String(row.date || '').trim(), String(row.amount ?? '').trim(), String(row.memo || '').trim()].join('|');

/**
 * Classify each row and shape it for commit. Pure — no IO. Rows missing the data
 * their target needs (a trade without an investment_id; any unknown kind) are
 * routed to `review` so the staged review blocks them rather than guessing.
 *
 * @param {number} accountId  the brokerage account every row lands on
 * @param {Array<object>} rows  parsed statement rows (kind normalized by the adapter)
 */
export function planBrokerageFanout(accountId, rows = []) {
  const cash = [];
  const trades = [];
  const review = [];

  for (const row of rows) {
    const { target, portfolioTxnType } = classifyBrokerageRow(row);
    if (target === 'cash') {
      cash.push({ row, dedupKey: cashDedupKey(accountId, row) });
    } else if (target === 'portfolio') {
      if (row.investment_id == null) {
        review.push({ row, reason: 'unresolved instrument' });
        continue;
      }
      const typed = { ...row, type: portfolioTxnType, account_id: accountId };
      trades.push({
        row: typed,
        dedupKey: tradeDedupKey({ ...row, account_id: accountId, kind: portfolioTxnType }),
        // The single cash effect of this trade (null = no cash movement, e.g. a split).
        legAmount: computeTradeCashLegAmount(typed),
      });
    } else {
      review.push({ row, reason: 'unknown row kind' });
    }
  }

  return { cash, trades, review };
}

async function cashRowExists(accountId, row) {
  const r = await query(
    `SELECT 1 FROM transactions
      WHERE account_id = $1 AND date = $2::date AND amount = $3 AND COALESCE(memo, '') = COALESCE($4, '') AND is_active = true
      LIMIT 1`,
    [accountId, row.date, Number(row.amount), row.memo || ''],
  );
  return r.rows.length > 0;
}

async function tradeRowExists(accountId, row) {
  const r = await query(
    `SELECT 1 FROM portfolio_transactions
      WHERE account_id = $1 AND investment_id = $2 AND date = $3::date AND type = $4::portfolio_txn_type
        AND COALESCE(units, 0) = COALESCE($5, 0) AND amount = $6
      LIMIT 1`,
    [accountId, row.investment_id, row.date, row.type, row.units != null ? Number(row.units) : null, Number(row.amount)],
  );
  return r.rows.length > 0;
}

/**
 * Apply a fan-out: insert deduped cash rows, create deduped trades + their cash
 * legs. Idempotent (field-based dedup + an intra-statement guard). Per-row atomic,
 * matching the ADR-078 portfolio commit — a single bad row is recorded, not fatal.
 *
 * @param {{ accountId:number, rows:Array<object> }} args
 * @returns {Promise<{ cash:number, trades:number, legs:number, duplicates:number, review:number, errors:number }>}
 */
export async function commitBrokerageFanout({ accountId, rows }) {
  const plan = planBrokerageFanout(accountId, rows);
  const seen = new Set();
  let cash = 0; let trades = 0; let legs = 0; let duplicates = 0; let errors = 0;

  for (const { row, dedupKey } of plan.cash) {
    if (seen.has(dedupKey) || await cashRowExists(accountId, row)) { duplicates++; continue; }
    seen.add(dedupKey);
    try {
      await query(
        `INSERT INTO transactions (date, amount, currency, memo, account_id, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [row.date, Number(row.amount), row.currency || 'EUR', row.memo || null, accountId],
      );
      cash++;
    } catch {
      errors++;
    }
  }

  for (const { row, dedupKey, legAmount } of plan.trades) {
    if (seen.has(dedupKey) || await tradeRowExists(accountId, row)) { duplicates++; continue; }
    seen.add(dedupKey);
    try {
      const created = await portfolioTransactionRepository.create(/** @type {any} */ ({
        investment_id: row.investment_id,
        type: row.type,
        date: row.date,
        amount: row.amount != null ? Number(row.amount) : undefined,
        units: row.units != null ? Number(row.units) : undefined,
        price_per_unit: row.price_per_unit != null ? Number(row.price_per_unit) : undefined,
        fees: row.fees != null ? Number(row.fees) : 0,
        taxes: row.taxes != null ? Number(row.taxes) : 0,
        currency: row.currency || 'EUR',
        fx_rate_to_eur: row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined,
        account_id: accountId,
      }));
      trades++;
      // The trade's single cash movement (ADR-090). createTradeCashLeg no-ops when
      // legAmount is null/zero (split, gift), so no spurious cash row is produced.
      if (legAmount != null && legAmount !== 0) {
        const legId = await createTradeCashLeg({ portfolioTxn: { ...created, ...row, id: created?.id }, cashAccountId: accountId });
        if (legId) legs++;
      }
    } catch {
      errors++;
    }
  }

  return { cash, trades, legs, duplicates, review: plan.review.length, errors };
}

export default { planBrokerageFanout, commitBrokerageFanout };
