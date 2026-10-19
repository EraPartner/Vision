import { z } from "zod";
import { query } from "../database/connection.ts";
import { queryRows } from "../database/rowContracts.ts";
import { pgBigint, pgInt } from "../database/rowSchemas.ts";
import type { ImportedTransactionInput } from "./transactionRepository.ts";

export interface BulkImportRow extends ImportedTransactionInput {
  stagingId: string;
  memoNormalized: string;
  dedupOccurrence: number | null;
}

/** Called in the chunk transaction/savepoint. The unique index arbitrates concurrent imports. */
export async function commitFingerprintRows(rows: BulkImportRow[]) {
  const data = rows.map((row) => ({
    staging_id: row.stagingId,
    date: row.date,
    account_id: row.accountId,
    recipient_id: row.recipientId,
    category_id: row.categoryId,
    amount: row.amount,
    memo: row.memo,
    normalized_memo: row.memoNormalized,
    currency: row.currency,
    balance: row.balance,
    bank_sequence: row.bankSequence ?? null,
    comment: row.comment,
    import_batch_id: row.importBatchId,
    matched_pattern_id: row.matchedPatternId,
    source_record_hash: row.sourceRecordHash,
    dedup_fingerprint: row.dedupFingerprint,
    dedup_fingerprint_version: row.fingerprintVersion,
  }));
  const identities = await queryRows(
    z.object({
      staging_id: pgBigint,
      duplicate: z.boolean(),
      legacy_count: pgInt,
    }),
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(staging_id bigint, date date, account_id integer,
        recipient_id integer, amount numeric, normalized_memo text, currency text,
        dedup_fingerprint text, dedup_fingerprint_version smallint)
    )
    SELECT i.staging_id, (modern.id IS NOT NULL) AS duplicate, count(legacy.id)::int AS legacy_count
    FROM input i
    LEFT JOIN transactions modern ON modern.dedup_fingerprint_version = i.dedup_fingerprint_version
      AND modern.dedup_fingerprint = i.dedup_fingerprint
    LEFT JOIN transactions legacy ON modern.id IS NULL AND legacy.dedup_fingerprint IS NULL
      AND legacy.is_active = true AND legacy.date = i.date AND legacy.amount = i.amount
      AND legacy.recipient_id IS NOT DISTINCT FROM i.recipient_id
      AND COALESCE(BTRIM(legacy.memo, E' \\t\\n\\r\\f\\013'), '') = i.normalized_memo
      AND legacy.account_id IS NOT DISTINCT FROM i.account_id AND legacy.currency = i.currency
    GROUP BY i.staging_id, modern.id`,
    [JSON.stringify(data)],
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
  const inserted = candidates.length > 0
    ? await queryRows(
        z.object({
          id: pgInt,
          dedup_fingerprint: z.string(),
          dedup_fingerprint_version: pgInt,
        }),
        `
    INSERT INTO transactions (date, account_id, recipient_id, category_id, amount, memo, currency, balance,
      bank_sequence, comment, import_batch_id, matched_pattern_id, source_record_hash,
      dedup_fingerprint, dedup_fingerprint_version, is_active)
    SELECT date, account_id, recipient_id, category_id, amount, memo, currency, balance,
      bank_sequence, comment, import_batch_id, matched_pattern_id, source_record_hash,
      dedup_fingerprint, dedup_fingerprint_version, true
    FROM jsonb_to_recordset($1::jsonb) AS i(date date, account_id integer, recipient_id integer,
      category_id integer, amount numeric, memo text, currency text, balance numeric, bank_sequence numeric,
      comment text, import_batch_id bigint, matched_pattern_id integer, source_record_hash text,
      dedup_fingerprint text, dedup_fingerprint_version smallint)
    ON CONFLICT DO NOTHING RETURNING id, dedup_fingerprint, dedup_fingerprint_version`,
        [
          JSON.stringify(
            data.filter((row) => candidateIds.has(row.staging_id)),
          ),
        ],
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
  await query(
    `UPDATE import_staging_rows s SET status = v.status
    FROM unnest($1::bigint[], $2::text[]) AS v(id, status) WHERE s.id = v.id`,
    [
      outcomes.map((row) => row.stagingId),
      outcomes.map((row) =>
        row.transactionId == null ? "duplicate" : "committed",
      ),
    ],
  );
  return outcomes;
}
