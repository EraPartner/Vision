/**
 * Opening-balance anchor (ADR-094 second addendum, D4).
 *
 * The 2026-06-25 addendum made `transactions.balance` import-pipeline-only, which
 * left manual/cash-only accounts (a wallet, an account whose bank has no CSV
 * export) with no way to seed an opening balance. D4 adds one guarded, server-side
 * exception: this service stamps a single system anchor row per (account, currency)
 * with amount=0, a server-written `balance`, is_transfer=true and
 * transfer_source='opening' (migration 0073's new CHECK value, following ADR-090's
 * 'trade' precedent). Because the row is is_transfer=true it stays out of
 * income/spending aggregations, and transfer_source='opening' keeps the ADR-083
 * reconciler (which only touches NULL/'auto') from pairing it.
 *
 * The generic POST /api/transactions / PATCH surface stays balance-free — the
 * write protection is untouched; this is the single, auditable exception. The
 * planned zero-amount-transaction rejection must likewise exempt
 * transfer_source='opening' rows: they are legitimately zero-amount.
 *
 * Invoking the action again UPDATEs the existing anchor rather than adding a
 * second (one anchor per account+currency). By anchor+delta semantics a later
 * stamped `balance` always wins, so an anchor dated after existing activity is
 * inert — the service returns a `warning` in that case.
 */

import { query } from '../database/connection.js';
import accountRepository from '../repositories/accountRepository.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

const OPENING_MEMO = 'OPENING BALANCE';

/**
 * Validate + normalize the opening-balance payload against the account.
 * Pure (no I/O) so it can be unit-tested directly.
 *
 * @param {{ balance:unknown, date:unknown, currency?:unknown }} body
 * @param {{ currency?:string }} account
 * @returns {{ balance:number, date:string, currency:string }}
 */
export function normalizeOpeningBalance(body, account) {
  const balance = Number(body?.balance);
  if (body?.balance == null || body?.balance === '' || !Number.isFinite(balance)) {
    throw new ValidationError('balance is required and must be a number');
  }

  const date = String(body?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError('date is required and must be an ISO date (YYYY-MM-DD)');
  }

  let currency;
  if (body?.currency != null && body.currency !== '') {
    currency = String(body.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationError('currency must be a 3-letter ISO code');
    }
  } else {
    currency = (account?.currency || 'EUR').toUpperCase();
  }

  return { balance, date, currency };
}

/**
 * Set (create or update) the opening-balance anchor for an account+currency.
 *
 * @param {number} accountId
 * @param {{ balance:number|string, date:string, currency?:string }} body
 * @returns {Promise<{ transaction:object, warning:(string|null) }>}
 */
export async function setOpeningBalance(accountId, body) {
  const account = await accountRepository.getById(accountId);
  if (!account) throw new NotFoundError(`Account ${accountId} not found`);

  const { balance, date, currency } = normalizeOpeningBalance(body, account);

  // Warn when the anchor does not precede the account's real activity: a later
  // import-stamped balance wins, leaving a mid-history anchor inert.
  const earliestRes = await query(
    `SELECT MIN(date) AS earliest
       FROM transactions
      WHERE account_id = $1
        AND is_active = true
        AND currency = $2
        AND (transfer_source IS DISTINCT FROM 'opening')`,
    [accountId, currency],
  );
  const earliest = earliestRes.rows[0]?.earliest;
  const warning =
    earliest && String(earliest).slice(0, 10) <= date
      ? 'Opening-balance date does not precede existing activity; a later import-stamped balance will override this anchor.'
      : null;

  // Single atomic upsert: UPDATE the existing (account, currency) anchor if one
  // exists, else INSERT. `balance` is server-stamped here — the one sanctioned
  // exception to the ADR-094 import-pipeline-only write protection.
  const upsertRes = await query(
    `WITH existing AS (
        SELECT id FROM transactions
         WHERE account_id = $1 AND transfer_source = 'opening' AND currency = $3
         LIMIT 1
     ),
     updated AS (
        UPDATE transactions t
           SET balance = $2, date = $4, memo = $5, amount = 0, is_active = true
          FROM existing
         WHERE t.id = existing.id
        RETURNING t.*
     ),
     inserted AS (
        INSERT INTO transactions
          (date, amount, balance, currency, memo, account_id, is_transfer, transfer_source, is_active)
        SELECT $4, 0, $2, $3, $5, $1, true, 'opening', true
         WHERE NOT EXISTS (SELECT 1 FROM existing)
        RETURNING *
     )
     SELECT * FROM updated
     UNION ALL
     SELECT * FROM inserted`,
    [accountId, balance, currency, date, OPENING_MEMO],
  );

  return { transaction: upsertRes.rows[0] || null, warning };
}

export default { setOpeningBalance, normalizeOpeningBalance };
