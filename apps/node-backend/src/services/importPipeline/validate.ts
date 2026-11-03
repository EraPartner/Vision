/**
 * Import pipeline — VALIDATE
 *
 * Reads staging rows (status='pending'), validates required fields,
 * computes separate source provenance and versioned occurrence identity, and
 * marks each row 'validated' or 'error'. Repeated equal rows remain valid.
 */

import { z } from "zod";
import { sql } from "kysely";
import { checkedRows, db } from "../../database/db.ts";
import { logger } from "../../config/logger.ts";
import {
  assignImportIdentities,
  budgetingIdentityBase,
} from "../importIdentity.ts";
import { pendingStagingRowSchema } from "../../database/rows/imports.ts";
import type { PendingStagingRow } from "../../database/rows/imports.ts";
import type { ImportBatchId, ImportProgressCallback } from "./index.ts";
import { requiredValue } from "../requiredValue.ts";

const VALIDATE_CHUNK = 500;

/**
 * The projection validate.js reads (`pendingStagingRowSchema`). `tx_date` is
 * `to_char`-ed to a 'YYYY-MM-DD' string rather than selected raw (see the
 * comment below), so it overrides the raw DATE of a staging row.
 */
/**
 * Run the validate phase: reject unusable rows, hash the rest, and flag
 * intra-batch duplicates.
 */
export async function validateBatch({
  batchId,
  onProgress,
}: {
  batchId: ImportBatchId;
  onProgress?: ImportProgressCallback | undefined;
}): Promise<{ validated: number; duplicates: number; errors: number }> {
  await db
    .updateTable("import_batches")
    .set({ status: "validating" })
    .where("id", "=", String(batchId))
    .execute();

  // tx_date via to_char, matching commit.js: read raw, a pg DATE arrives as a
  // server-local-midnight Date whose toISOString() (in the fallback hash below)
  // rolls back a day east of UTC — and silently changes fallback hashes if the
  // server timezone ever changes between imports.
  const batchRows = await checkedRows(
    pendingStagingRowSchema,
    sql`SELECT s.id, s.row_index, s.status, to_char(s.tx_date, 'YYYY-MM-DD') AS tx_date,
            s.amount, s.recipient_raw, s.memo, s.currency, s.raw_data,
            s.bank_account, s.balance,
            s.source_transaction_id AS source_id, b.adapter_name
       FROM import_staging_rows s
       JOIN import_batches b ON b.id = s.batch_id
      WHERE s.batch_id = ${batchId}
      ORDER BY s.row_index ASC`,
  );

  const pending = batchRows.filter(
    (row) => row.status === "pending",
  );
  const total = pending.length;
  let seen = 0;
  let errors = 0;
  const duplicates = 0;
  const identities = assignImportIdentities(batchRows, (row) =>
    budgetingIdentityBase(row, row.adapter_name),
  );
  const identityById = new Map(
    batchRows.map((row, index) => [row.id, identities[index]]),
  );

  if (onProgress) onProgress({ phase: "validating", current: 0, total });

  for (let start = 0; start < total; start += VALIDATE_CHUNK) {
    const chunk = pending.slice(start, start + VALIDATE_CHUNK);
    const updates: Array<{
      id: string;
      status: string;
      fingerprint: string | null;
      source_record_hash: string | null;
      fingerprint_version: number | null;
      occurrence: number | null;
      error_message: string | null;
    }> = [];
    for (const row of chunk) {
      // Every pending row is one of batchRows, which keyed identityById.
      const identity = requiredValue(
        identityById.get(row.id),
        "every pending row is one of batchRows, which keyed identityById",
      );
      const issue = validateRow(row);
      if (issue) {
        errors++;
        updates.push({
          id: row.id,
          status: "error",
          fingerprint: null,
          source_record_hash: identity.sourceRecordHash,
          fingerprint_version: null,
          occurrence: null,
          error_message: issue,
        });
      } else {
        updates.push({
          id: row.id,
          status: "validated",
          fingerprint: identity.fingerprint,
          source_record_hash: identity.sourceRecordHash,
          fingerprint_version: identity.version,
          occurrence: identity.occurrence,
          error_message: null,
        });
      }
    }
    // One statement per chunk: the rows travel as one JSON array.
    await sql`UPDATE import_staging_rows
          SET status        = v.status,
              source_record_hash = v.source_record_hash,
              dedup_fingerprint = v.fingerprint,
              dedup_fingerprint_version = v.fingerprint_version,
              dedup_occurrence = v.occurrence,
              error_message = v.error_message,
              updated_at = now()
         FROM (SELECT CAST(value ->> 'id' AS INTEGER) AS id,
                      value ->> 'status' AS status,
                      value ->> 'fingerprint' AS fingerprint,
                      value ->> 'source_record_hash' AS source_record_hash,
                      value ->> 'fingerprint_version' AS fingerprint_version,
                      value ->> 'occurrence' AS occurrence,
                      value ->> 'error_message' AS error_message
                 FROM json_each(${JSON.stringify(updates)})) AS v
        WHERE import_staging_rows.id = v.id`.execute(db);
    seen += chunk.length;
    if (onProgress) onProgress({ phase: "validating", current: seen, total });
  }

  // `total`, `errors`, and `duplicates` are row counts (not currency), so plain
  // integer arithmetic is correct here — exempt from the monetary-arithmetic rule.
  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  const validated = total - errors - duplicates;
  logger.info("[pipeline:validate] done", {
    batchId,
    total,
    validated,
    duplicates,
    errors,
  });
  return { validated, duplicates, errors };
}

/**
 * What a staged row needs to be committable. Messages are the stored
 * `error_message`; key order is check order, so the first issue is the reason.
 */
const usableStagingRowSchema = z.object({
  tx_date: z
    .string({ error: "missing tx_date" })
    .min(1, { error: "missing tx_date" }),
  // NUMERIC arrives from pg as a string.
  amount: z
    .union([z.string(), z.number()], { error: "missing amount" })
    .refine((amount) => Number.isFinite(Number(amount)), {
      error: "invalid amount",
    }),
});

/**
 * @returns the rejection reason, or null when the row is usable
 */
function validateRow(row: PendingStagingRow): string | null {
  const result = usableStagingRowSchema.safeParse(row);
  if (result.success) return null;
  // A failed parse always carries at least one issue.
  const [issue] = result.error.issues;
  return issue ? issue.message : "invalid staging row";
}
