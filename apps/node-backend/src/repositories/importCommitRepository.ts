import { sql } from "kysely";
import { z } from "zod";
import { checkedRows, db } from "../database/db.ts";
import { pgBigint, pgInt, pgTransactionId } from "../database/rowSchemas.ts";
import type { ImportedTransactionInput } from "./transactionRepository.ts";

export interface BulkImportRow extends ImportedTransactionInput {
  stagingId: string;
  memoNormalized: string;
  dedupOccurrence: number | null;
}

/**
 * Decimal text for a JSON-carried amount: a string passes through; a number is
 * sent as its JavaScript text, the form node-postgres sent PostgreSQL. The SQL
 * below reads it with dec_* / vision_numeric(), which refuse a JSON float.
 */
function decimalText(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/**
 * Called in the chunk transaction/savepoint. The unique index arbitrates
 * concurrent imports; the probe and the insert run in the caller's
 * withTransaction(), so no other writer can land a row between them.
 */
export async function commitFingerprintRows(rows: BulkImportRow[]) {
  const data = rows.map((row) => ({
    staging_id: row.stagingId,
    date: row.date,
    account_id: row.accountId,
    recipient_id: row.recipientId,
    category_id: row.categoryId,
    amount: decimalText(row.amount),
    memo: row.memo,
    normalized_memo: row.memoNormalized,
    currency: row.currency,
    balance: decimalText(row.balance),
    bank_sequence: row.bankSequence ?? null,
    comment: row.comment,
    import_batch_id: row.importBatchId,
    matched_pattern_id: row.matchedPatternId,
    source_record_hash: row.sourceRecordHash,
    dedup_fingerprint: row.dedupFingerprint,
    dedup_fingerprint_version: row.fingerprintVersion,
  }));
  // The legacy probe keeps PostgreSQL's comparisons: `amount` numerically
  // (dec_eq), `date` as canonical DATE text, the nullable keys null-safely
  // (IS), and the memo trimmed of the same characters BTRIM(memo, E' \t\n\r\f\013')
  // removed: space, tab, LF, CR, form feed and vertical tab.
  const identities = await checkedRows(
    z.object({
      staging_id: pgBigint,
      duplicate: z.boolean(),
      legacy_count: pgInt,
    }),
    sql`
    WITH input AS (
      SELECT j.value ->> 'staging_id' AS staging_id,
             j.value ->> 'date' AS date,
             j.value ->> 'account_id' AS account_id,
             j.value ->> 'recipient_id' AS recipient_id,
             j.value ->> 'amount' AS amount,
             j.value ->> 'normalized_memo' AS normalized_memo,
             j.value ->> 'currency' AS currency,
             j.value ->> 'dedup_fingerprint' AS dedup_fingerprint,
             j.value ->> 'dedup_fingerprint_version' AS dedup_fingerprint_version
        FROM json_each(${JSON.stringify(data)}) AS j
    )
    SELECT i.staging_id, (modern.id IS NOT NULL) AS "duplicate::bool", count(legacy.id) AS legacy_count
    FROM input i
    LEFT JOIN transactions modern ON modern.dedup_fingerprint_version = i.dedup_fingerprint_version
      AND modern.dedup_fingerprint = i.dedup_fingerprint
    LEFT JOIN transactions legacy ON modern.id IS NULL AND legacy.dedup_fingerprint IS NULL
      AND legacy.is_active = 1 AND legacy.date = i.date AND dec_eq(legacy.amount, i.amount)
      AND legacy.recipient_id IS i.recipient_id
      AND COALESCE(btrim(legacy.memo, char(32, 9, 10, 13, 12, 11)), '') = i.normalized_memo
      AND legacy.account_id IS i.account_id AND legacy.currency = i.currency
    GROUP BY i.staging_id, modern.id`,
  );
  const byId = new Map(identities.map((row) => [row.staging_id, row]));
  const seen = new Set<string>();
  const key = (row: BulkImportRow) =>
    `${row.fingerprintVersion}:${row.dedupFingerprint}`;
  const candidates = rows.filter((row) => {
    const identity = byId.get(row.stagingId);
    if (!identity)
      throw new Error("Import identity lookup omitted a staging row");
    if (
      identity.duplicate ||
      (row.dedupOccurrence != null &&
        row.dedupOccurrence <= identity.legacy_count) ||
      seen.has(key(row))
    )
      return false;
    seen.add(key(row));
    return true;
  });
  const candidateIds = new Set(candidates.map((row) => row.stagingId));
  // `WHERE true` keeps SQLite from reading ON CONFLICT as a join constraint of
  // the SELECT. Writes go through vision_numeric() at the column scales, the
  // assignment cast PostgreSQL applied.
  const inserted = candidates.length > 0
    ? await checkedRows(
        z.object({
          id: pgTransactionId,
          dedup_fingerprint: z.string(),
          dedup_fingerprint_version: pgInt,
        }),
        sql`
    INSERT INTO transactions (date, account_id, recipient_id, category_id, amount, memo, currency, balance,
      bank_sequence, comment, import_batch_id, matched_pattern_id, source_record_hash,
      dedup_fingerprint, dedup_fingerprint_version, is_active)
    SELECT i.value ->> 'date', i.value ->> 'account_id', i.value ->> 'recipient_id',
      i.value ->> 'category_id', vision_numeric(i.value ->> 'amount', 18, 4), i.value ->> 'memo',
      i.value ->> 'currency', vision_numeric(i.value ->> 'balance', 18, 4),
      vision_numeric(i.value ->> 'bank_sequence', 18, 0), i.value ->> 'comment',
      i.value ->> 'import_batch_id', i.value ->> 'matched_pattern_id',
      i.value ->> 'source_record_hash', i.value ->> 'dedup_fingerprint',
      i.value ->> 'dedup_fingerprint_version', 1
    FROM json_each(${JSON.stringify(
      data.filter((row) => candidateIds.has(row.staging_id)),
    )}) AS i
    WHERE true
    ON CONFLICT DO NOTHING RETURNING id, dedup_fingerprint, dedup_fingerprint_version`,
      )
    : [];
  const insertedByKey = new Map(
    inserted.map((row) => [
      `${row.dedup_fingerprint_version}:${row.dedup_fingerprint}`,
      row.id,
    ]),
  );
  const outcomes = rows.map((row) => ({
    stagingId: row.stagingId,
    transactionId: candidateIds.has(row.stagingId)
      ? insertedByKey.get(key(row))
      : undefined,
  }));
  const statuses = outcomes.map((row) => ({
    id: row.stagingId,
    status: row.transactionId == null ? "duplicate" : "committed",
  }));
  await sql`UPDATE import_staging_rows
       SET status = v.status, updated_at = now()
      FROM (SELECT CAST(value ->> 'id' AS INTEGER) AS id, value ->> 'status' AS status
              FROM json_each(${JSON.stringify(statuses)})) AS v
     WHERE import_staging_rows.id = v.id`.execute(db);
  return outcomes;
}
