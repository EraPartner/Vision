/**
 * Import pipeline — COMMIT
 *
 * Drains 'matched' staging rows into canonical `transactions`. Performs
 * versioned fingerprint deduplication with a bounded field-count fallback for
 * canonical rows created before fingerprints existed. Uses chunked
 * BEGIN/COMMIT so partial failures roll back cleanly on a chunk boundary
 * without losing prior committed chunks.
 *
 * Post-chunk: updates `import_batches` counters (`rows_imported`,
 * `rows_duplicate`, `rows_error`).
 *
 * Each row uses a savepoint so a bad row does not poison valid siblings. The
 * partial unique fingerprint index is the concurrent-import race guard.
 */

import {
  query,
  withSavepointIfInTransaction,
  withTransaction,
} from "../../database/connection.js";
import {
  clearTransactionCountCache,
  transactionRepository,
} from "../../repositories/transactionRepository.js";
import { accountRepository } from "../../repositories/accountRepository.js";
import {
  markStagingRowCommitted,
  markStagingRowDuplicate,
  markStagingRowError,
} from "../../repositories/importBatchRepository.js";
import { logger } from "../../config/logger.js";
import { formatDateToYmd } from "../../lib/dateFormat.js";
import { autoLinkTransactions } from "../plannedMatchService.js";
import { getAdapter } from "./adapters/index.js";

/**
 * @typedef {import('../../types/rows.js').ImportStagingRow} ImportStagingRow
 * @typedef {import('./index.js').ImportBatchId} ImportBatchId
 * @typedef {import('./index.js').ImportProgressCallback} ImportProgressCallback
 */

/**
 * A row that has been committed by this run and is therefore a candidate for
 * planned-payment auto-linking.
 * @typedef {{ id: number, recipient_id: number|null, amount: string|null, transaction_date: string }} InsertedRow
 */

/**
 * Per-chunk outcome, identical in shape from both the batched and the per-row
 * path so the caller cannot tell which ran.
 * @typedef {{ imported: number, duplicates: number, errors: number, inserted: InsertedRow[] }} ChunkResult
 */

const COMMIT_CHUNK = 1000;

const ROW_SAVEPOINT = "sp_commit_row";

// error_message for a row that reaches commit with no recipient: the matcher
// could not resolve one (match.js stamps such rows 'matched' with a NULL
// resolved_recipient_id so they stay reviewable) and the user committed
// without assigning one in review.
const UNRESOLVED_RECIPIENT_MESSAGE =
  "unresolved recipient — no recipient was matched or assigned in review";

/**
 * The currency this pipeline will actually STORE for a row — and therefore the
 * only value the dup check may compare against, on both sides.
 *
 * `transactions.currency` is NOT NULL (migration 0046), so both insert sites
 * default a missing import currency to EUR; keying on the raw staging value
 * instead would make a currency-less row (KBC with a blank cell) never match
 * the 'EUR' row its own first import wrote, and re-importing the same file
 * would duplicate the whole ledger. This is that default, in one place, used
 * by the probe and by both writes.
 *
 * TRIMMED before defaulting: the column is VARCHAR(3), and Postgres silently
 * drops trailing spaces on assignment to varchar(n) — so an untrimmed
 * 'EUR ' would key as 'EUR ' while storing as 'EUR', and every re-import
 * would miss the dup check and duplicate the row. Every shipped adapter
 * already trims its currency cell; the trim here is what makes probe == write
 * hold by construction rather than by adapter convention. Case is NOT
 * normalized: a lowercase or malformed cell should keep failing the 0046
 * CHECK loudly, not be silently rewritten.
 *
 * @param {string|null|undefined} currency `import_staging_rows.currency`
 * @returns {string}
 */
function currencyKeyOf(currency) {
  return (currency ?? "").trim() || "EUR";
}

/**
 * Derive the values the commit path needs from a staging row. Shared by both
 * the batched planner and the per-row fallback so they cannot drift.
 *
 * @param {any} row
 * @returns {{
 *   row: any, dateStr: string, recipientId: number|null, memoNorm: string,
 *   accountId: number|null, currencyKey: string,
 *   sourceRecordHash: string|null, dedupFingerprint: string|null,
 *   fingerprintVersion: number|null, dedupOccurrence: number|null,
 *   idStr: string, idValid: boolean, categoryId: number|null, patternId: number|null,
 * }}
 */
function deriveRow(row) {
  // tx_date arrives as a 'YYYY-MM-DD' string (the SELECT uses to_char).
  // The Date branch is defensive only: node-postgres parses DATE columns
  // into a server-local-midnight Date, so use LOCAL getters — toISOString()
  // would roll back a day for any TZ east of UTC.
  const dateStr =
    row.tx_date instanceof Date
      ? formatDateToYmd(row.tx_date)
      : String(row.tx_date).slice(0, 10);

  const recipientId =
    row.user_override_recipient_id ?? row.resolved_recipient_id ?? null;

  // import_staging_rows.id is BIGSERIAL — the pg driver returns BIGINT values
  // as strings to preserve int64 precision, so the value here is a string of
  // digits (or, defensively, a JS integer). Reject any other shape before it
  // reaches repository or staging-row writes, and make the batched and per-row
  // paths reject exactly the same rows.
  const idStr = String(row.id);

  return {
    row,
    dateStr,
    recipientId,
    memoNorm: (row.memo ?? "").trim(),
    // Stamped onto the row by resolveChunkAccounts (commitChunk, inside the
    // chunk transaction) before commit: the label resolved to its
    // account id (ADR-088). null when the row carries no usable label.
    accountId: row.resolved_account_id ?? null,
    currencyKey: currencyKeyOf(row.currency),
    sourceRecordHash: row.source_record_hash || null,
    dedupFingerprint: row.dedup_fingerprint || null,
    fingerprintVersion: row.dedup_fingerprint_version ?? null,
    dedupOccurrence: row.dedup_occurrence ?? null,
    idStr,
    idValid: /^\d+$/.test(idStr),
    // ADR-046: per-row override beats recipient default. Both may be null
    // (truly uncategorized), in which case the runtime COALESCE in
    // transactionRepository falls back to the recipient default at read.
    categoryId:
      row.override_category_id ?? row.recipient_default_category_id ?? null,
    // When overridden, clear matched_pattern_id — the link is now manual.
    patternId: row.user_override_recipient_id
      ? null
      : (row.matched_pattern_id ?? null),
  };
}

/**
 * Commit rows carrying the versioned identity contract. Legacy canonical rows
 * remain a field-count fallback; modern rows use the stored fingerprint and
 * the database unique index as the concurrent-import arbiter.
 *
 * @param {{ chunk: any[], batchId: ImportBatchId }} args
 * @returns {Promise<ChunkResult>}
 */
async function commitChunkWithFingerprints({ chunk, batchId }) {
  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  /** @type {InsertedRow[]} */
  const inserted = [];

  for (const row of chunk) {
    const d = deriveRow(row);
    if (!d.idValid) {
      errors++;
      continue;
    }
    const modernDuplicate = await transactionRepository.findImportFingerprint(
      d.fingerprintVersion,
      d.dedupFingerprint,
    );
    const legacyCount =
      modernDuplicate !== undefined
        ? 0
        : await transactionRepository.countLegacyImportDuplicates({
            date: d.dateStr,
            amount: row.amount,
            recipientId: d.recipientId,
            memo: d.memoNorm,
            accountId: d.accountId,
            currency: d.currencyKey,
          });
    if (modernDuplicate === undefined) {
      logger.info("[pipeline:commit] legacy identity fallback evaluated", {
        batchId,
        stagingRowId: row.id,
        matches: legacyCount,
      });
    }
    if (
      modernDuplicate !== undefined ||
      (d.dedupOccurrence != null && d.dedupOccurrence <= legacyCount)
    ) {
      duplicates++;
      await markStagingRowDuplicate(row.id);
      continue;
    }

    try {
      const insertedId = await withSavepointIfInTransaction(ROW_SAVEPOINT, () =>
        transactionRepository.insertImportedRow({
          date: d.dateStr,
          accountId: d.accountId,
          recipientId: d.recipientId,
          categoryId: d.categoryId,
          amount: row.amount,
          memo: row.memo || "",
          currency: d.currencyKey,
          balance: row.balance != null ? row.balance : null,
          comment: row.comment || null,
          importBatchId: batchId,
          matchedPatternId: d.patternId,
          sourceRecordHash: d.sourceRecordHash,
          dedupFingerprint: d.dedupFingerprint,
          fingerprintVersion: d.fingerprintVersion,
        }),
      );
      if (insertedId === undefined) {
        duplicates++;
        await markStagingRowDuplicate(row.id);
        continue;
      }
      imported++;
      inserted.push({
        id: insertedId,
        recipient_id: d.recipientId,
        amount: row.amount,
        transaction_date: d.dateStr,
      });
      await markStagingRowCommitted(row.id);
    } catch (err) {
      errors++;
      await markStagingRowError(
        row.id,
        err?.message?.slice(0, 500) || "insert failed",
      );
    }
  }
  return { imported, duplicates, errors, inserted };
}

/**
 * Resolve every distinct staging label of this chunk to its `accounts.id` and
 * stamp it onto the rows as `resolved_account_id` (read by deriveRow).
 *
 * Resolve-OR-CREATE, matching the sync trigger's INSERT behaviour exactly
 * (ADR-088 addendum D1 — implicit minting stays, on the normalized
 * lower(btrim) identity; `accountRepository.resolveOrCreateByName` targets the
 * same 0066 unique expression index the trigger uses, and pre-trims with SQL
 * btrim semantics — U+0020 only — so a label padded with non-ASCII whitespace
 * cannot fork into one account here and a different one in the trigger). This
 * is what lets the dedup key and probe compare `account_id` instead of the
 * retired bank_account string.
 *
 * Called INSIDE the chunk's transaction (commitChunk), before its SAVEPOINT:
 * the module-level query routes onto the transaction's client, so a chunk
 * that ultimately rolls back also rolls back any accounts it minted — the
 * same lifecycle the BEFORE-INSERT trigger's minting always had — while a
 * bulk-insert failure that only rolls back to the savepoint keeps them for
 * the per-row replay.
 *
 * Blank-path parity: a label that is null or btrims to '' resolves to null
 * (the trigger leaves account_id NULL for those rows too).
 *
 * @param {any[]} rows staging rows (mutated: `resolved_account_id` added)
 * @param {{ multiCurrencyCash?: boolean }} [capabilities]
 * @returns {Promise<void>}
 */
async function resolveChunkAccounts(rows, capabilities = {}) {
  // Cache key = the btrimmed label VERBATIM (no JS lowercasing): Postgres
  // lower() is the case authority for the identity, and JS toLowerCase() can
  // disagree with it on edge-case code points. Case variants of one label
  // therefore each hit the DB once — and converge on the same id via the
  // ON CONFLICT arbiter — rather than sharing a possibly-wrong cache slot.
  /** @type {Map<string, number|null>} */
  const idByLabel = new Map();
  for (const row of rows) {
    const label = row.bank_account == null ? "" : String(row.bank_account);
    const key = label.replace(/^ +| +$/g, ""); // SQL btrim — U+0020 only
    if (key === "") {
      row.resolved_account_id = null;
      continue;
    }
    if (!idByLabel.has(key)) {
      idByLabel.set(
        key,
        (await accountRepository.resolveOrCreateByName(label, capabilities)) ??
          null,
      );
    }
    row.resolved_account_id = idByLabel.get(key);
  }
}

/**
 * Commit one chunk through the versioned identity path.
 *
 * @param {{ chunk: any[], batchId: ImportBatchId, capabilities?: { multiCurrencyCash?: boolean } }} args
 * @returns {Promise<ChunkResult>}
 */
async function commitChunk({ chunk, batchId, capabilities }) {
  // Account creation and row commits share the chunk transaction.
  await resolveChunkAccounts(chunk, capabilities);
  return commitChunkWithFingerprints({ chunk, batchId });
}

/**
 * Run the commit phase: drain 'matched' staging rows into `transactions` with
 * chunk-batched dedup and insert, then auto-link planned payments. Rows still
 * lacking a recipient (unresolved at match, unassigned in review) are decided
 * into 'error' before any chunk is planned — never attempted against the
 * NOT NULL `transactions.recipient_id`.
 *
 * @param {{ batchId: ImportBatchId, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ imported: number, duplicates: number, errors: number, autoLinkedCount: number }>}
 */
export async function commitBatch({ batchId, onProgress }) {
  const statusResult = await query(
    `UPDATE import_batches SET status = 'committing' WHERE id = $1
     RETURNING adapter_name`,
    [batchId],
  );
  const adapter = getAdapter(statusResult.rows[0]?.adapter_name);
  const capabilities = {
    multiCurrencyCash: adapter?.multiCurrencyCash === true,
  };

  const { rows: reviewed } = await query(
    `SELECT isr.id,
            isr.row_index,
            to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
            isr.bank_account,
            isr.recipient_raw,
            isr.memo,
            isr.amount,
            isr.currency,
            isr.balance,
            isr.comment,
            isr.source_record_hash,
            isr.dedup_fingerprint,
            isr.dedup_fingerprint_version,
            isr.dedup_occurrence,
            isr.resolved_recipient_id,
            isr.user_override_recipient_id,
            isr.matched_pattern_id,
            isr.override_category_id,
            r.default_category_id AS recipient_default_category_id
       FROM import_staging_rows isr
       LEFT JOIN recipients r
         ON r.id = COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id)
      WHERE isr.batch_id = $1 AND isr.status = 'matched'
      ORDER BY isr.row_index ASC`,
    [batchId],
  );

  // Unresolved rows stay 'matched' through review (the only status the
  // preview and the override paths accept — see matchBatch), so a row can
  // arrive here with no recipient at all: the matcher resolved nothing and the
  // user assigned nothing. `transactions.recipient_id` is NOT NULL, so decide
  // those rows into 'error' up front — attempting them would make the bulk
  // INSERT fail on the constraint and demote the whole chunk to the per-row
  // replay, surfacing the right outcome by the wrong mechanism.
  const unresolvedRows = reviewed.filter(
    (/** @type {any} */ r) =>
      (r.user_override_recipient_id ?? r.resolved_recipient_id) == null,
  );
  const matched = reviewed.filter(
    (/** @type {any} */ r) =>
      (r.user_override_recipient_id ?? r.resolved_recipient_id) != null,
  );

  if (unresolvedRows.length > 0) {
    await query(
      `UPDATE import_staging_rows
          SET status = 'error', error_message = $2
        WHERE id = ANY($1::bigint[])`,
      [
        unresolvedRows.map((/** @type {any} */ r) => r.id),
        UNRESOLVED_RECIPIENT_MESSAGE,
      ],
    );
    await query(
      `UPDATE import_batches
          SET rows_error = COALESCE(rows_error, 0) + $2
        WHERE id = $1`,
      [batchId, unresolvedRows.length],
    );
    logger.warn(
      "[pipeline:commit] rows without a resolved recipient marked as errors",
      {
        batchId,
        rows: unresolvedRows.length,
      },
    );
  }

  const total = matched.length;
  let seen = 0;
  let imported = 0;
  let duplicates = 0;
  let errors = unresolvedRows.length;
  // Inserted rows fed to planned-payment auto-link after the whole batch
  // commits (so matching sees the full import — both ambiguity directions).
  /** @type {InsertedRow[]} */
  const insertedRows = [];

  if (onProgress) onProgress({ phase: "committing", current: 0, total });

  for (let start = 0; start < total; start += COMMIT_CHUNK) {
    const chunk = matched.slice(start, start + COMMIT_CHUNK);
    // Chunk-local counters: only folded into the running totals (and the
    // import_batches checkpoint) *after* withTransaction resolves, so a chunk
    // that rolls back doesn't leave the JS counters — and the persisted
    // checkpoint — inflated past what's actually in `transactions`.
    let chunkImported = 0;
    let chunkDuplicates = 0;
    let chunkErrors = 0;
    /** @type {InsertedRow[]} */
    let chunkInserted = [];
    await withTransaction(async () => {
      const res = await commitChunk({ chunk, batchId, capabilities });
      chunkImported = res.imported;
      chunkDuplicates = res.duplicates;
      chunkErrors = res.errors;
      chunkInserted = res.inserted ?? [];
    });

    // The chunk transaction is now committed. Clearing inside an individual
    // INSERT would let an outside request refill the cache from the old
    // committed snapshot before COMMIT and retain that stale count afterward.
    if (chunkImported > 0) clearTransactionCountCache();

    // Transaction committed — only now is it safe to fold the chunk's counts
    // into the running totals and the persisted checkpoint.
    imported += chunkImported;
    duplicates += chunkDuplicates;
    errors += chunkErrors;
    insertedRows.push(...chunkInserted);
    seen += chunk.length;

    // Checkpoint counters per chunk so a crash mid-import leaves recoverable
    // state in import_batches. Increment by chunk-local delta to preserve
    // any rows_error already set by earlier pipeline phases (validate).
    await query(
      `UPDATE import_batches
          SET rows_imported = COALESCE(rows_imported, 0) + $2,
              rows_duplicate = COALESCE(rows_duplicate, 0) + $3,
              rows_error = COALESCE(rows_error, 0) + $4
        WHERE id = $1`,
      [batchId, chunkImported, chunkDuplicates, chunkErrors],
    );

    if (onProgress) {
      onProgress({
        phase: "committing",
        current: seen,
        total,
        imported,
        duplicates,
        errors,
      });
    }
  }

  logger.info("[pipeline:commit] done", {
    batchId,
    total,
    imported,
    duplicates,
    errors,
  });

  // Auto-clear matching planned payments for the just-imported transactions.
  // Runs after commit (rows are durable) and never fails the import.
  let autoLinkedCount = 0;
  if (insertedRows.length > 0) {
    try {
      const auto = await autoLinkTransactions(insertedRows);
      autoLinkedCount = auto.autoLinkedCount;
      if (autoLinkedCount > 0) {
        logger.info("[pipeline:commit] auto-linked planned payments", {
          batchId,
          autoLinkedCount,
        });
      }
    } catch (err) {
      logger.warn("[pipeline:commit] planned auto-link failed", {
        batchId,
        error: err?.message,
      });
    }
  }

  return { imported, duplicates, errors, autoLinkedCount };
}
