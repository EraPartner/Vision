/**
 * Import pipeline — VALIDATE
 *
 * Reads staging rows (status='pending'), validates required fields,
 * computes separate source provenance and versioned occurrence identity, and
 * marks each row 'validated' or 'error'. Repeated equal rows remain valid.
 */

import { query } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import {
  assignImportIdentities,
  budgetingIdentityBase,
} from "../importIdentity.js";

/**
 * @typedef {import('../../types/rows.js').ImportStagingRow} ImportStagingRow
 * @typedef {import('./index.js').ImportBatchId} ImportBatchId
 * @typedef {import('./index.js').ImportProgressCallback} ImportProgressCallback
 */

const VALIDATE_CHUNK = 500;

/**
 * The projection validate.js reads. `tx_date` is `to_char`-ed to a
 * 'YYYY-MM-DD' string rather than selected raw (see the comment below), so it
 * overrides the raw DATE on {@link ImportStagingRow}.
 *
 * @typedef {Pick<ImportStagingRow,
 *   'id'|'row_index'|'amount'|'recipient_raw'|'memo'|'currency'|'raw_data'|'bank_account'|'balance'>
 *   & { tx_date: string|null, source_id?: string|null, adapter_name: string }} PendingStagingRow
 */

/**
 * Run the validate phase: reject unusable rows, hash the rest, and flag
 * intra-batch duplicates.
 *
 * @param {{ batchId: ImportBatchId, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ validated: number, duplicates: number, errors: number }>}
 */
export async function validateBatch({ batchId, onProgress }) {
  await query(`UPDATE import_batches SET status = 'validating' WHERE id = $1`, [
    batchId,
  ]);

  // tx_date via to_char, matching commit.js: read raw, a pg DATE arrives as a
  // server-local-midnight Date whose toISOString() (in the fallback hash below)
  // rolls back a day east of UTC — and silently changes fallback hashes if the
  // server timezone ever changes between imports.
  const { rows: batchRows } = await query(
    `SELECT s.id, s.row_index, s.status, to_char(s.tx_date, 'YYYY-MM-DD') AS tx_date,
            s.amount, s.recipient_raw, s.memo, s.currency, s.raw_data,
            s.bank_account, s.balance,
            s.source_transaction_id AS source_id, b.adapter_name
       FROM import_staging_rows s
       JOIN import_batches b ON b.id = s.batch_id
      WHERE s.batch_id = $1
      ORDER BY s.row_index ASC`,
    [batchId],
  );

  const pending = batchRows.filter(
    (row) => row.status == null || row.status === "pending",
  );
  const total = pending.length;
  let seen = 0;
  let errors = 0;
  let duplicates = 0;
  const identities = assignImportIdentities(batchRows, (row) =>
    budgetingIdentityBase(row, row.adapter_name),
  );
  const identityById = new Map(
    batchRows.map((row, index) => [String(row.id), identities[index]]),
  );

  if (onProgress) onProgress({ phase: "validating", current: 0, total });

  for (let start = 0; start < total; start += VALIDATE_CHUNK) {
    const chunk = pending.slice(start, start + VALIDATE_CHUNK);
    /** @type {string[]} */
    const ids = [];
    /** @type {string[]} */
    const statuses = [];
    /** @type {(string|null)[]} */
    const txHashes = [];
    /** @type {(string|null)[]} */
    const sourceRecordHashes = [];
    /** @type {(number|null)[]} */
    const fingerprintVersions = [];
    /** @type {(number|null)[]} */
    const occurrences = [];
    /** @type {(string|null)[]} */
    const errorMessages = [];
    for (let chunkIndex = 0; chunkIndex < chunk.length; chunkIndex++) {
      const row = /** @type {PendingStagingRow} */ (chunk[chunkIndex]);
      const identity = identityById.get(String(row.id));
      const issue = validateRow(row);
      ids.push(row.id);
      if (issue) {
        errors++;
        statuses.push("error");
        txHashes.push(null);
        sourceRecordHashes.push(identity.sourceRecordHash);
        fingerprintVersions.push(null);
        occurrences.push(null);
        errorMessages.push(issue);
      } else {
        statuses.push("validated");
        // Compatibility write: the legacy unique tx_hash receives the new,
        // occurrence-distinct fingerprint. Historical tx_hash rows are never
        // rewritten or reinterpreted.
        txHashes.push(identity.fingerprint);
        sourceRecordHashes.push(identity.sourceRecordHash);
        fingerprintVersions.push(identity.version);
        occurrences.push(identity.occurrence);
        errorMessages.push(null);
      }
    }
    await query(
      `UPDATE import_staging_rows s
          SET status        = v.status,
              tx_hash       = v.tx_hash,
              source_record_hash = v.source_record_hash,
              dedup_fingerprint = v.tx_hash,
              dedup_fingerprint_version = v.fingerprint_version,
              dedup_occurrence = v.occurrence,
              error_message = v.error_message
         FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::smallint[], $6::integer[], $7::text[])
              AS v(id, status, tx_hash, source_record_hash, fingerprint_version, occurrence, error_message)
        WHERE s.id = v.id`,
      [
        ids,
        statuses,
        txHashes,
        sourceRecordHashes,
        fingerprintVersions,
        occurrences,
        errorMessages,
      ],
    );
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
 * @param {PendingStagingRow} row
 * @returns {string|null} the rejection reason, or null when the row is usable
 */
function validateRow(row) {
  if (!row.tx_date) return "missing tx_date";
  if (row.amount == null) return "missing amount";
  const n = Number(row.amount);
  if (!Number.isFinite(n)) return "invalid amount";
  return null;
}
