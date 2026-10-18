/**
 * Deduplication Service
 */

import crypto from "crypto";
import Decimal from "decimal.js";
import { query, withSavepointIfInTransaction } from "../database/connection.ts";
import { logger } from "../config/logger.ts";
import { checkRows, queryRows } from "../database/rowContracts.ts";
import { idRowSchema } from "../database/rowSchemas.ts";
import { transactionIdRowSchema } from "../database/rows/ledger.ts";
import { epochMsToUtcYmd, toYmd } from "../lib/dateFormat.ts";

// Match ECMAScript String.trim() exactly, including historical untrimmed rows.
// PostgreSQL's default TRIM only removes ordinary spaces.
const manualMemoTrimSql = String.raw`BTRIM(t.memo, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')`;

// NUMERIC(18,4) rounds ties away from zero. Identity must represent the
// persisted value so equivalent inputs share both the lock and live predicate.
function manualAmountIdentity(amount: number | string): string {
  return new Decimal(amount)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
    .toString();
}

export interface FieldHashInput {
  /** genuine UTC-instant Date (see contract note below). */
  date: Date;
  amount: number | string;
  recipient?: string;
  memo?: string;
  rawData?: string;
}

// `transactionData.date` must be a genuine UTC-instant Date (e.g. from the
// import pipeline's parseDateFlexibleUtc) — `.toISOString()` extracts its UTC
// calendar day. Do NOT pass a pg-read DATE column here: those parse as
// local-midnight Date objects (see lib/dateFormat.ts) and would day-shift the
// hash on any host east of UTC.
function createTransactionHash(transactionData: FieldHashInput): string {
  let raw = transactionData.rawData;
  if (!raw) {
    raw = `${epochMsToUtcYmd(transactionData.date.getTime())}|${transactionData.amount}|${transactionData.recipient}|${transactionData.memo || ""}`;
  }
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

export interface ManualHashInput {
  date: string | Date;
  amount: number | string;
  recipientId?: number | string | null | undefined;
  memo?: string | null | undefined;
  bankAccount?: string | null | undefined;
  accountId?: number | string | null | undefined;
  currency?: string | null | undefined;
}

/**
 * Create a hash for a manually added transaction.
 */
function createManualTransactionHash({
  date,
  amount,
  recipientId,
  memo,
  bankAccount,
  accountId,
  currency,
}: ManualHashInput): string {
  const accountIdentity =
    accountId == null ? (bankAccount || "").toUpperCase() : `id:${accountId}`;
  const raw = JSON.stringify([
    "manual-v3",
    toYmd(date),
    manualAmountIdentity(amount),
    recipientId == null ? null : String(recipientId),
    (memo || "").trim().toUpperCase(),
    accountIdentity,
    (currency || "EUR").trim().toUpperCase(),
  ]);
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

/**
 * Serialize manual creates with the same versioned identity for the duration
 * of the caller's ambient transaction. This closes the check-then-insert race
 * without retaining a session lock if the request fails.
 */
export async function lockManualTransactionIdentity(
  input: ManualHashInput,
): Promise<void> {
  const hash = createManualTransactionHash(input);
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [hash]);
}

async function isDuplicate(transactionData: FieldHashInput): Promise<boolean> {
  // Same UTC-instant contract as createTransactionHash above:
  // transactionData.date must be a genuine UTC-instant Date, not a pg-read
  // local-midnight DATE column.
  //
  // Field-based dedup matches date + amount + recipient + memo so two
  // legitimate same-day same-amount same-vendor purchases are not collapsed.
  //
  // Match the recipient by name through a LEFT JOIN rather than a
  // `recipient_id = (SELECT ... LIMIT 1)` subquery: the subquery returned NULL
  // for an unknown name (so an otherwise-identical `recipient_id IS NULL` row
  // was never flagged) and its LIMIT-without-ORDER-BY was non-deterministic on
  // name collisions. COALESCE handles the no-recipient case symmetrically.
  const result = await query(
    `SELECT t.id FROM transactions t
     LEFT JOIN recipients r ON t.recipient_id = r.id
     WHERE t.date = $1 AND t.amount = $2
       AND COALESCE(UPPER(r.name), '') = $3
       AND COALESCE(TRIM(t.memo), '') = $4
       AND t.is_active = true
     LIMIT 1`,
    [
      epochMsToUtcYmd(transactionData.date.getTime()),
      transactionData.amount,
      (transactionData.recipient || "").toUpperCase(),
      (transactionData.memo || "").trim(),
    ],
  );
  return result.rows.length > 0;
}

async function isDuplicateByFields(
  date: string,
  amount: number | string,
  recipientName?: string,
  memo?: string,
): Promise<boolean> {
  const result = await query(
    `SELECT id FROM transactions t
     LEFT JOIN recipients r ON t.recipient_id = r.id
     WHERE t.date = $1 AND t.amount = $2 AND UPPER(r.name) = $3
       AND COALESCE(TRIM(t.memo), '') = $4 AND t.is_active = true
     LIMIT 1`,
    [date, amount, (recipientName || "").toUpperCase(), (memo || "").trim()],
  );
  return result.rows.length > 0;
}

/**
 * Check if a manually added transaction is a duplicate using the neutral claim table.
 */
export async function isManualDuplicate({
  date,
  amount,
  recipientId,
  memo,
  bankAccount,
  accountId,
  currency,
}: ManualHashInput): Promise<{
  isDuplicate: boolean;
  existingTransactionId: number | null;
}> {
  const hash = createManualTransactionHash({
    date,
    amount,
    recipientId,
    memo,
    bankAccount,
    accountId,
    currency,
  });

  // Claims are hints: edits can leave an old hash pointing at a different identity.
  // Validate the live fields even on a hash hit; legacy hashes fall through here too.
  const predicate = `t.date = $1 AND t.amount = $2
    AND t.recipient_id IS NOT DISTINCT FROM $3::integer
    AND UPPER(COALESCE(${manualMemoTrimSql}, '')) = $4
    AND (($6::integer IS NOT NULL AND t.account_id = $6)
      OR ($6::integer IS NULL AND COALESCE(UPPER(acct.name), '') = $5))
    AND UPPER(t.currency) = $7 AND t.is_active = true`;
  const identityParams = [
    toYmd(date),
    manualAmountIdentity(amount),
    recipientId ?? null,
    (memo || "").trim().toUpperCase(),
    (bankAccount || "").toUpperCase(),
    accountId ?? null,
    (currency || "EUR").trim().toUpperCase(),
  ];

  // Rows are checked after the try: a contract violation must fail loudly,
  // not fall through to field matching like a missing claim table does.
  let claimRows: unknown[] = [];
  try {
    // Only a live, active transaction blocks. The FK is ON DELETE SET NULL
    // (migration 0024), so a deleted transaction leaves its hash row behind
    // with transaction_id = NULL — without the join that dangling row would
    // block re-adding the identical transaction forever, with a ConflictError
    // pointing at nothing.
    const result = await withSavepointIfInTransaction(
      "sp_manual_dedup_claim_read",
      () =>
        query(
          `SELECT m.transaction_id
             FROM manual_transaction_dedup_claims m
             JOIN transactions t ON t.id = m.transaction_id AND t.is_active = true
             LEFT JOIN accounts acct ON acct.id = t.account_id
            WHERE m.deduplication_hash = $8 AND ${predicate}
            LIMIT 1`,
          [...identityParams, hash],
        ),
    );
    claimRows = result.rows;
  } catch (err) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code !== "42P01") {
      logger.warn("Unexpected error in manual dedup hash check", {
        error: pgErr.message,
        code: pgErr.code,
      });
    }
    // The expand migration may not exist yet — fall through to field matching.
  }
  const [claim] = checkRows(transactionIdRowSchema, claimRows);
  if (claim) {
    return { isDuplicate: true, existingTransactionId: claim.transaction_id };
  }

  // Fallback: field-based duplicate check (includes memo for accurate match).
  const [fieldMatch] = await queryRows(
    idRowSchema,
    `SELECT t.id FROM transactions t
     LEFT JOIN accounts acct ON acct.id = t.account_id
     WHERE ${predicate}
     LIMIT 1`,
    identityParams,
  );
  if (fieldMatch) {
    return { isDuplicate: true, existingTransactionId: fieldMatch.id };
  }

  return { isDuplicate: false, existingTransactionId: null };
}

/**
 * Claim a manually added transaction hash in provider-neutral metadata.
 */
export async function recordManualTransactionDedupClaim({
  date,
  amount,
  recipientId,
  memo,
  bankAccount,
  accountId,
  currency,
  transactionId,
}: ManualHashInput & {
  categoryId?: number | string | null;
  comment?: string | null;
  transactionId: number | string;
}): Promise<void> {
  const hash = createManualTransactionHash({
    date,
    amount,
    recipientId,
    memo,
    bankAccount,
    accountId,
    currency,
  });

  try {
    // DO UPDATE (not DO NOTHING): re-adding a previously deleted transaction
    // re-claims its dangling hash row, so the hash points at the live row again.
    await withSavepointIfInTransaction("sp_manual_dedup_claim_write", () =>
      query(
        `INSERT INTO manual_transaction_dedup_claims
           (deduplication_hash, transaction_id, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (deduplication_hash) DO UPDATE
           SET transaction_id = EXCLUDED.transaction_id,
               updated_at = now()`,
        [hash, transactionId],
      ),
    );
  } catch (err) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code !== "42P01") {
      logger.warn("Unexpected error recording manual raw transaction", {
        error: pgErr.message,
        code: pgErr.code,
      });
      throw err;
    }
    // The expand migration may not exist yet — field matching still protects
    // the create path during a rolling application/database deployment.
  }
}

export {
  createTransactionHash as __createTransactionHash,
  createManualTransactionHash as __createManualTransactionHash,
  isDuplicate,
  isDuplicateByFields as __isDuplicateByFields,
};
