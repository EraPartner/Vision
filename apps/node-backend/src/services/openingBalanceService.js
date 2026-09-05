/**
 * Opening-balance anchor (ADR-094 second addendum, D4).
 *
 * The 2026-06-25 addendum made `transactions.balance` import-pipeline-only, which
 * left manual/cash-only accounts (a wallet, an account whose bank has no CSV
 * export) with no way to seed an opening balance. D4 adds one guarded, server-side
 * exception: this service stamps a single system anchor row per (account, currency)
 * with amount=0, a server-written `balance`, is_transfer=true and
 * transfer_source='opening' (migration 0073's new CHECK value, following ADR-090's
 * 'trade' precedent), owned by the shared system recipient (`recipient_id` is NOT
 * NULL and an anchor has no payee). Because the row is is_transfer=true it stays out of
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

import { z } from "zod";
import { query, withTransaction } from "../database/connection.js";
import accountRepository from "../repositories/accountRepository.js";
import { recipientRepository } from "../repositories/recipientRepository.js";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";
import { assertCurrency, assertYmd } from "../lib/validation.js";
import { toWireDate } from "../lib/dateFormat.js";

const OPENING_MEMO = "OPENING BALANCE";

/* ── Zod schema (schema → safeParse → ValidationError, settings.js idiom) ── */

// LOOSE: only the three payload fields are typed; the caller reads nothing else.
const openingBalanceBodySchema = z.looseObject({
  balance: z.unknown().transform((value, ctx) => {
    const balance = Number(value);
    if (value == null || value === "" || !Number.isFinite(balance)) {
      ctx.addIssue({
        code: "custom",
        message: "balance is required and must be a number",
      });
      return z.NEVER;
    }
    return balance;
  }),
  date: z.unknown().transform((value, ctx) => {
    const date = String(value ?? "");
    if (!date) {
      ctx.addIssue({
        code: "custom",
        message: "date is required and must be an ISO date (YYYY-MM-DD)",
      });
      return z.NEVER;
    }
    // assertYmd also parse-checks the calendar (rejects e.g. 2026-13-40), which
    // a bare regex lets through to fail the Postgres DATE cast as a 500.
    try {
      assertYmd(date, "date");
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: /** @type {Error} */ (err).message,
      });
      return z.NEVER;
    }
    return date;
  }),
  // Shared ISO-4217 guard: absent/empty input returns undefined, so the
  // account's own currency applies — same fallback as the old inline check.
  currency: z
    .unknown()
    .transform((value, ctx) => {
      try {
        return assertCurrency(value);
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: /** @type {Error} */ (err).message,
        });
        return z.NEVER;
      }
    })
    .optional(),
});

/**
 * Validate + normalize the opening-balance payload against the account.
 * Pure (no I/O) so it can be unit-tested directly.
 *
 * @param {{ balance:unknown, date:unknown, currency?:unknown }} body
 * @param {{ currency?:string }} account
 * @returns {{ balance:number, date:string, currency:string }}
 */
function normalizeOpeningBalance(body, account) {
  const result = openingBalanceBodySchema.safeParse(body ?? {});
  if (!result.success) {
    const msg = result.error.issues.map((issue) => issue.message).join("; ");
    throw new ValidationError(msg);
  }
  const { balance, date, currency } = result.data;
  return {
    balance,
    date,
    currency: currency ?? (account?.currency || "EUR").toUpperCase(),
  };
}

export { normalizeOpeningBalance as __normalizeOpeningBalance };

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

  // The earliest-activity read, the "does an anchor already exist?" check, and
  // the upsert must be atomic: two concurrent calls would otherwise both see no
  // existing anchor and both INSERT, minting two anchors for one
  // (account, currency) — the one-anchor invariant is backed only by a CHECK.
  // Lock the account row FOR UPDATE first so the second caller blocks, then
  // re-runs the CTE's `existing` SELECT against the now-committed anchor and
  // takes the UPDATE branch. The partial unique index (migration
  // 0077_opening_anchor_unique_index) is the defense-in-depth backstop.
  return withTransaction(async () => {
    await query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [
      accountId,
    ]);

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
    // pg reads MIN(date) as a JS Date (no setTypeParser override); String(Date)
    // yields "Wed Jul 01", which is never lexically <= an ISO "YYYY-MM-DD" — the
    // warning was dead code. Normalize to a calendar-day string before comparing.
    const earliest = toWireDate(earliestRes.rows[0]?.earliest);
    const warning =
      earliest && earliest <= date
        ? "Opening-balance date does not precede existing activity; a later import-stamped balance will override this anchor."
        : null;

    // `recipient_id` is NOT NULL (migration 0001) and an anchor has no payee, so
    // the INSERT branch owns it with the shared system recipient. The UPDATE
    // branch deliberately leaves the column alone: re-running the action must
    // not overwrite a recipient the user has since set on the existing anchor.
    const systemRecipientId = await recipientRepository.getOrCreateSystemId();

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
            (date, amount, balance, currency, memo, account_id, recipient_id,
             is_transfer, transfer_source, is_active)
          SELECT $4, 0, $2, $3, $5, $1, $6, true, 'opening', true
           WHERE NOT EXISTS (SELECT 1 FROM existing)
          RETURNING *
       )
       SELECT * FROM updated
       UNION ALL
       SELECT * FROM inserted`,
      [accountId, balance, currency, date, OPENING_MEMO, systemRecipientId],
    );

    return { transaction: upsertRes.rows[0] || null, warning };
  });
}

export default { setOpeningBalance, normalizeOpeningBalance };
