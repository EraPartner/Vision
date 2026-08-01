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
 * On a multi-currency account only the account's OWN currency partition is
 * reconciled — that is the only currency `accounts.statement_balance` can be a
 * statement for, and it is the currency both outcomes are denominated in. See
 * the comment at the drift read below.
 *
 * Both are opt-in: the caller must name the mode. 'adjustment' follows the
 * 'opening' (0073) / 'trade' (0053) precedent so the row stays out of
 * income/spending aggregations and out of the ADR-083 transfer reconciler.
 */

import { query, withTransaction } from '../database/connection.js';
import {
  computedBalanceByCurrencyAggLateral,
  statementPartition,
} from '../repositories/accountBalanceSql.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { todayAppDateString } from '../lib/timezone.js';
import { roundToCents, toDecimal, toNumber } from '../lib/money.js';

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

  // The drift read and the adjustment INSERT / accept UPDATE must be atomic:
  // two concurrent adjustment reconciles would otherwise both read the same
  // drift and both insert, overshooting by exactly the drift. Lock the account
  // row FOR UPDATE first so the second request blocks, then re-reads a now-zero
  // drift and falls into the "already reconciled" guard below.
  return withTransaction(async () => {
    const lockRes = await query(
      `SELECT id FROM accounts WHERE id = $1 FOR UPDATE`,
      [accountId],
    );
    if (!lockRes.rows[0]) throw new NotFoundError(`Account ${accountId} not found`);

    // Statement figure + the live computed balance, per currency partition (the
    // same lateral the hub badge reads). The FOR UPDATE cannot ride on this
    // SELECT — the lateral aggregates, so the lock is taken separately above.
    const res = await query(
      `SELECT a.currency,
              a.statement_balance,
              bp.balance_parts
         FROM accounts a
         ${computedBalanceByCurrencyAggLateral({ account: 'a.id' })}
        WHERE a.id = $1`,
      [accountId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundError(`Account ${accountId} not found`);

    if (row.statement_balance == null) {
      throw new ValidationError('Account has no statement balance to reconcile against');
    }

    // Multi-currency: reconcile ONE partition — the reconciliation base, which
    // is the shared definition the hub badge and the reconcile dialog's
    // `reconcilable_balance` also read, so the figure resolved here is the one
    // the user was shown. `statement_balance` is a single figure sitting next to
    // `accounts.currency` and carrying a single date, so that is the only
    // currency it can be a statement for; measuring the drift against anything
    // else — a cross-currency Σ of bare amounts, or an FX-converted total that
    // moves with the daily rate — would not actually clear the badge. Every
    // single-currency account keeps its previous figure exactly (see
    // statementPartition). The other partitions are untouched: they have no
    // statement figure to reconcile against.
    const base = statementPartition(row.balance_parts, row.currency);
    const statement = Number(row.statement_balance);
    // Round the base to cents BEFORE differencing, mirroring the hub's
    // `reconcilable_balance` — the drift resolved here must equal the drift
    // the dialog displayed, even when the partition sum carries a 4-dp tail.
    const computed = toNumber(roundToCents(toDecimal(base.balance)));
    const drift = toNumber(toDecimal(statement).minus(toDecimal(computed)));

    if (Math.abs(drift) < DRIFT_EPSILON) {
      throw new ValidationError('Account is already reconciled (no drift to resolve)');
    }

    // APP_TIMEZONE calendar day (ADR-009), not UTC — otherwise a row created
    // between local midnight and ~02:00 east of UTC is stamped yesterday.
    const today = todayAppDateString();

    if (mode === 'accept') {
      // Adopt the reconciliation base — exactly the figure the dialog displayed
      // — as the statement of record; drift → 0. On an account whose declared
      // currency holds nothing the base is 0, and writing 0 is the honest
      // outcome: there is no balance in the statement's currency to adopt.
      // (The dialog shows that 0 as the base, so this is no longer a figure the
      // user never saw.)
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
        transaction: /** @type {object|null} */ (null),
      };
    }

    // mode === 'adjustment': stamp a descriptive delta row (no `balance`) so the
    // computed balance rises to meet the statement. The row is stamped in the
    // BASE's currency, not blindly in `accounts.currency`: on a mislabelled
    // single-currency account (USD rows under an account still declared EUR)
    // those differ, and a EUR adjustment would open a second partition instead
    // of moving the USD one the drift was measured against — leaving the badge
    // exactly where it was. They are the same code for every other account.
    const ins = await query(
      `INSERT INTO transactions
         (date, amount, currency, memo, account_id, is_transfer, transfer_source, is_active)
       VALUES ($1, $2, $3, $4, $5, true, 'adjustment', true)
       RETURNING id, amount, transfer_source`,
      [today, drift, base.currency, ADJUSTMENT_MEMO, accountId],
    );
    return {
      mode,
      drift: 0,
      statement_balance: statement,
      computed_balance: statement, // computed now equals statement after the delta
      transaction: ins.rows[0] || null,
    };
  });
}

export default { reconcileAccount, normalizeReconcile };
