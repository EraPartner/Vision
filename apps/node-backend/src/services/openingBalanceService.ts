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

import { looseText } from "../lib/looseText.ts";
import { z } from "zod";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow } from "../database/db.ts";
import {
  transactionKeyRowSchema,
  transactionRowSchema,
} from "../database/rowSchemas.ts";
import { earliestDateRowSchema } from "../database/rows/ledger.ts";
import accountRepository from "../repositories/accountRepository.ts";
import { recipientRepository } from "../repositories/recipientRepository.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import { assertCurrency, assertYmd } from "../lib/validation.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import type { TransactionRow } from "../types/rows.ts";
import { storedCurrencyCode } from "../lib/currencyCode.ts";
import type { AccountId, CurrencyCode } from "@vision/types/brands";

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
    const date = looseText(value ?? "");
    if (!date) {
      ctx.addIssue({
        code: "custom",
        message: "date is required and must be an ISO date (YYYY-MM-DD)",
      });
      return z.NEVER;
    }
    // assertYmd also parse-checks the calendar (rejects e.g. 2026-13-40), which
    // a bare regex lets through to fail the DATE column check as a 500.
    try {
      assertYmd(date, "date");
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : String(err),
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
          message: err instanceof Error ? err.message : String(err),
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
 * @param body unvalidated wire payload `{ balance, date, currency? }`.
 */
function normalizeOpeningBalance(
  body: unknown,
  account: { currency?: CurrencyCode | null } | null | undefined,
): { balance: number; date: string; currency: CurrencyCode } {
  const result = openingBalanceBodySchema.safeParse(body ?? {});
  if (!result.success) {
    const msg = result.error.issues.map((issue) => issue.message).join("; ");
    throw new ValidationError(msg);
  }
  const { balance, date, currency } = result.data;
  return {
    balance,
    date,
    currency: currency ?? storedCurrencyCode(account?.currency),
  };
}

export { normalizeOpeningBalance as __normalizeOpeningBalance };

/**
 * Set (create or update) the opening-balance anchor for an account+currency.
 *
 * @param body unvalidated wire payload `{ balance, date, currency? }`.
 */
export async function setOpeningBalance(
  accountId: AccountId,
  body: unknown,
): Promise<{ transaction: TransactionRow | null; warning: string | null }> {
  const account = await accountRepository.getById(accountId);
  if (!account) throw new NotFoundError(`Account ${accountId} not found`);

  const { balance, date, currency } = normalizeOpeningBalance(body, account);

  // The earliest-activity read, the "does an anchor already exist?" check, and
  // the write must be atomic: two concurrent calls would otherwise both see no
  // existing anchor and both INSERT, minting two anchors for one
  // (account, currency). They run in one BEGIN IMMEDIATE transaction on the
  // single writer (ADR-263), so a second caller starts only after the first
  // committed, finds its anchor and takes the UPDATE branch (PostgreSQL got
  // the same from FOR UPDATE on the account row). The partial unique index
  // (migration 0077_opening_anchor_unique_index) is the defense-in-depth
  // backstop.
  return withTransaction(async () => {
    // Warn when the anchor does not precede the account's real activity: a later
    // import-stamped balance wins, leaving a mid-history anchor inert.
    const earliestRow = await checkedRow(
      earliestDateRowSchema,
      sql`SELECT MIN(date) AS "earliest::date"
            FROM transactions
           WHERE account_id = ${accountId}
             AND is_active = true
             AND currency = ${currency}
             AND transfer_source IS NOT 'opening'`,
    );
    // MIN(date) reads as a local-midnight Date; String(Date) yields
    // "Wed Jul 01", which is never lexically <= an ISO "YYYY-MM-DD". Normalize
    // to a calendar-day string before comparing.
    const earliest = toWireDate(earliestRow?.earliest);
    const warning =
      earliest && earliest <= date
        ? "Opening-balance date does not precede existing activity; a later import-stamped balance will override this anchor."
        : null;

    // `recipient_id` is NOT NULL (migration 0001) and an anchor has no payee, so
    // the INSERT branch owns it with the shared system recipient. The UPDATE
    // branch deliberately leaves the column alone: re-running the action must
    // not overwrite a recipient the user has since set on the existing anchor.
    const systemRecipientId = await recipientRepository.getOrCreateSystemId();

    // UPDATE the existing (account, currency) anchor if one exists, else
    // INSERT, in this transaction. `balance` is server-stamped here — the one
    // sanctioned exception to the ADR-094 import-pipeline-only write
    // protection. Money binds as decimal text: String() of the number is the
    // text node-postgres sent, and vision_numeric() applies the NUMERIC(18,4)
    // assignment cast. updated_at is set in the statement so RETURNING shows
    // it (the SQLite trigger writes it after the row).
    const balanceText = String(balance);
    const existing = await checkedRow(
      transactionKeyRowSchema,
      sql`SELECT id FROM transactions
           WHERE account_id = ${accountId} AND transfer_source = 'opening'
             AND currency = ${currency}
           LIMIT 1`,
    );
    const upserted = existing
      ? await checkedRow(
          transactionRowSchema,
          sql`UPDATE transactions
                 SET balance = vision_numeric(${balanceText}, 18, 4), date = ${date},
                     memo = ${OPENING_MEMO}, amount = vision_numeric(0, 18, 4),
                     is_active = true, updated_at = now()
               WHERE id = ${existing.id}
              RETURNING *`,
        )
      : await checkedRow(
          transactionRowSchema,
          sql`INSERT INTO transactions
                (date, amount, balance, currency, memo, account_id, recipient_id,
                 is_transfer, transfer_source, is_active)
              VALUES (${date}, vision_numeric(0, 18, 4), vision_numeric(${balanceText}, 18, 4),
                      ${currency}, ${OPENING_MEMO}, ${accountId}, ${systemRecipientId},
                      true, 'opening', true)
              RETURNING *`,
        );

    return { transaction: upserted ?? null, warning };
  });
}
