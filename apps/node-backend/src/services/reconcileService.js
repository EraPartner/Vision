/**
 * Drift reconciliation (ADR-094, Phase C — accounts rewrite).
 *
 * The drift badge surfaces `statement_balance − computed_balance`. Historically
 * the only way to clear it was Edit → Advanced (hand-edit the statement figures).
 * This service backs the reconcile dialog opened from the badge, resolving a drift
 * one of two explicit ways:
 *
 *   - mode 'accept'     — treat the computed (ledger) balance as truth. Rewrites
 *                         the stored statement figures to the computed balance and
 *                         stamps today's as-of date; drift collapses to 0. No
 *                         ledger rows are created.
 *   - mode 'adjustment' — treat the statement as truth: the ledger is missing the
 *                         difference. Creates ONE server-side ledger row with
 *                         amount = drift, `balance` left NULL (it is NOT an anchor,
 *                         so the ADR-094 anchor+delta computed balance stays honest
 *                         — the descriptive-only default is preserved),
 *                         is_transfer=true and transfer_source='adjustment'
 *                         (migration 0075). computed rises to meet statement; drift
 *                         collapses to 0.
 *
 * Both are opt-in: the caller must name the mode. 'adjustment' follows the
 * 'opening' (0073) / 'trade' (0053) precedent so the row stays out of
 * income/spending aggregations and out of the ADR-083 transfer reconciler.
 */

import { query } from '../database/connection.js';
import { COMPUTED_BALANCE_LATERAL } from '../repositories/accountBalanceSql.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { todayAppDateString } from '../lib/timezone.js';

const ADJUSTMENT_MEMO = 'BALANCE ADJUSTMENT';
const VALID_MODES = new Set(['accept', 'adjustment']);

// Drifts below this (in the account currency's minor units) are treated as
// already reconciled — floating-point noise should never mint a 0.00 adjustment
// row or a no-op statement rewrite.
const DRIFT_EPSILON = 0.005;

/**
 * Validate the reconcile payload.
 * Pure (no I/O) so it can be unit-tested directly.
 *
 * @param {{ mode?:unknown }} body
 * @returns {{ mode:'accept'|'adjustment' }}
 */
export function normalizeReconcile(body) {
  const mode = String(body?.mode ?? '');
  if (!VALID_MODES.has(mode)) {
    throw new ValidationError("mode is required and must be 'accept' or 'adjustment'");
  }
  return { mode: /** @type {'accept'|'adjustment'} */ (mode) };
}

/**
 * Reconcile an account's drift.
 *
 * @param {number} accountId
 * @param {{ mode:'accept'|'adjustment' }} body
 * @returns {Promise<{ mode:string, drift:number, statement_balance:number, computed_balance:number, transaction:(object|null) }>}
 */
export async function reconcileAccount(accountId, body) {
  const { mode } = normalizeReconcile(body);

  // Statement figure + the live computed balance (same lateral the hub/drift use).
  const res = await query(
    `SELECT a.currency,
            a.statement_balance,
            COALESCE(lb.balance, 0) AS computed_balance
       FROM accounts a
       ${COMPUTED_BALANCE_LATERAL}
      WHERE a.id = $1`,
    [accountId],
  );
  const row = res.rows[0];
  if (!row) throw new NotFoundError(`Account ${accountId} not found`);

  if (row.statement_balance == null) {
    throw new ValidationError('Account has no statement balance to reconcile against');
  }

  const statement = Number(row.statement_balance);
  const computed = Number(row.computed_balance);
  const drift = statement - computed;

  if (Math.abs(drift) < DRIFT_EPSILON) {
    throw new ValidationError('Account is already reconciled (no drift to resolve)');
  }

  // APP_TIMEZONE calendar day (ADR-009), not UTC — otherwise a row created
  // between local midnight and ~02:00 east of UTC is stamped yesterday.
  const today = todayAppDateString();

  if (mode === 'accept') {
    // Adopt the computed balance as the statement of record; drift → 0.
    const upd = await query(
      `UPDATE accounts
          SET statement_balance = $2, statement_balance_date = $3, updated_at = NOW()
        WHERE id = $1
      RETURNING statement_balance`,
      [accountId, computed, today],
    );
    return {
      mode,
      drift: 0,
      statement_balance: Number(upd.rows[0].statement_balance),
      computed_balance: computed,
      transaction: null,
    };
  }

  // mode === 'adjustment': stamp a descriptive delta row (no `balance`) so the
  // computed balance rises to meet the statement.
  const ins = await query(
    `INSERT INTO transactions
       (date, amount, currency, memo, account_id, is_transfer, transfer_source, is_active)
     VALUES ($1, $2, $3, $4, $5, true, 'adjustment', true)
     RETURNING id, amount, transfer_source`,
    [today, drift, row.currency, ADJUSTMENT_MEMO, accountId],
  );
  return {
    mode,
    drift: 0,
    statement_balance: statement,
    computed_balance: statement, // computed now equals statement after the delta
    transaction: ins.rows[0] || null,
  };
}

export default { reconcileAccount, normalizeReconcile };
