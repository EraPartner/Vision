/**
 * Import pipeline — COMMIT
 *
 * Drains 'matched' staging rows into canonical `transactions`. Performs
 * field-based dedup (date+amount+recipient+memo+account_id+currency, with
 * the differing-tx_hash exemption) against `transactions`. Uses chunked
 * BEGIN/COMMIT so partial failures roll back cleanly on a chunk boundary
 * without losing prior committed chunks.
 *
 * Post-chunk: updates `import_batches` counters (`rows_imported`,
 * `rows_duplicate`, `rows_error`).
 *
 * ── Batched chunk plan (perf) ───────────────────────────────────────────────
 * The dedup verdict for a chunk used to cost five sequential round trips per
 * row (dup-check SELECT, SAVEPOINT, single-row INSERT, staging UPDATE, RELEASE
 * SAVEPOINT). A 2,000-row CSV issued ~10,000 statements. The chunk is now
 * planned in JS from two pre-load SELECTs and written with one multi-row
 * INSERT plus two staging UPDATEs — ~7 statements per chunk regardless of
 * size.
 *
 * The JS planner reproduces the old per-row SQL verdicts EXACTLY, including:
 *  - the differing-hash exemption applies only to rows still owned by the
 *    current batch. A deleted batch sets `import_batch_id` to NULL; that row
 *    remains a field-dedup candidate so deleting metadata cannot make its
 *    transaction silently re-importable;
 *  - stored and incoming memos both ignore surrounding ASCII whitespace;
 *  - the ordering effect: an earlier row of the same chunk, once inserted, is
 *    visible to a later row's dup check. The planner feeds each planned insert
 *    back into its in-memory candidate index as it goes;
 *  - constraint-before-conflict ordering: a row whose tx_hash is already in
 *    `transactions` is still submitted to the INSERT, because Postgres
 *    validates the tuple before resolving the conflict. The planner only
 *    PREDICTS the conflict (for counting and staging status) and verifies
 *    afterwards that exactly the predicted set was dropped.
 *
 * Because the planner speculates that every planned insert lands, ANY failure
 * of the bulk INSERT (a poison row, or a `RETURNING` count that does not match
 * the plan because a concurrent import won a tx_hash race) invalidates the
 * whole plan: a row that was ruled a duplicate *of* a row that then failed to
 * insert would have been inserted under the old semantics. So the bulk INSERT
 * runs under one chunk-level SAVEPOINT, and any failure rolls back to it and
 * replays the chunk through the original per-row/per-SAVEPOINT loop
 * (`commitChunkPerRow`), which is still the authority on semantics.
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

// Static identifier, never interpolated from data.
const CHUNK_SAVEPOINT = "sp_commit_chunk";
const ROW_SAVEPOINT = "sp_commit_row";

// error_message for a row that reaches commit with no recipient: the matcher
// could not resolve one (match.js stamps such rows 'matched' with a NULL
// resolved_recipient_id so they stay reviewable) and the user committed
// without assigning one in review.
const UNRESOLVED_RECIPIENT_MESSAGE =
  "unresolved recipient — no recipient was matched or assigned in review";

/**
 * Canonical text form of a NUMERIC value, so JS equality matches PostgreSQL's
 * `numeric = numeric`. `import_staging_rows.amount` is NUMERIC(20,4) and
 * `transactions.amount` is NUMERIC(18,4): both render with four decimals
 * today, but scale is a schema detail the dedup must not depend on
 * ('-5.00' and '-5.0000' are the same number).
 *
 * A value that is not a plain decimal literal is returned verbatim so it can
 * still only ever compare equal to an identical string. The only such form
 * worth naming is exponent notation ('1e3'), and it is unreachable on both
 * sides of the comparison: `numeric_out` never emits an exponent, and the
 * staging side is read back out of a NUMERIC(20,4) column by the same code
 * path. Returning it verbatim is therefore a dead-safe default, not a
 * comparison that silently mis-sorts real amounts.
 *
 * @param {unknown} v
 * @returns {string|null}
 */
function normalizeAmountKey(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  const sign = m[1] === "-" ? "-" : "";
  const int = (m[2] || "").replace(/^0+/, "");
  const frac = (m[3] || "").replace(/0+$/, "");
  if (int === "" && frac === "") return "0";
  return `${sign}${int || "0"}${frac ? `.${frac}` : ""}`;
}

/**
 * SQL `BTRIM(x, E' \\t\\n\\r\\f\\013')` equivalent for the ASCII
 * whitespace set used by the stored side of import memo deduplication.
 *
 * @param {string} s
 * @returns {string}
 */
function sqlTrimAsciiWhitespace(s) {
  return s.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
}

/**
 * SQL `a = b` for a bigint column compared to the batch id, in three-valued
 * logic: NULL (unknown) when the column is NULL.
 *
 * @param {unknown} a column value (pg returns BIGINT as a string)
 * @param {unknown} b batch id
 * @returns {boolean|null}
 */
function bigintEq(a, b) {
  if (a === null || a === undefined) return null;
  try {
    return BigInt(String(a)) === BigInt(String(b));
  } catch {
    return String(a) === String(b);
  }
}

/**
 * Composite key for the field-based dup check: date + amount + recipient +
 * memo + account + currency. Both sides must be normalized by their own
 * side's rules before being handed here (see `sqlTrimSpaces` and
 * `currencyKeyOf`).
 *
 * The account component is the resolved `account_id` (ADR-088), NOT the
 * retired bank_account string: the stored side reads `t.account_id`, the
 * incoming side resolves its staging label through the same lower(btrim)
 * identity the sync trigger uses (`resolveChunkAccounts`). Rows with no label
 * key on null, exactly as the old `IS NOT DISTINCT FROM` string compare did.
 *
 * @param {{ date: string, amountKey: string|null, recipientId: number|null, memoKey: string, accountId: number|null, currencyKey: string }} k
 * @returns {string}
 */
function dupKey(k) {
  return JSON.stringify([
    k.date,
    k.amountKey,
    k.recipientId,
    k.memoKey,
    k.accountId,
    k.currencyKey,
  ]);
}

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
 *   bankAccount: string|null, accountId: number|null,
 *   amountKey: string|null, currencyKey: string,
 *   txHash: string|null,
 *   idStr: string, idValid: boolean, categoryId: number|null, patternId: number|null,
 *   conflictPredicted: boolean,
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
    bankAccount: row.bank_account || null,
    // Stamped onto the row by resolveChunkAccounts (commitChunk, inside the
    // chunk transaction) before any planning: the label resolved to its
    // account id (ADR-088). null when the row carries no usable label.
    accountId: row.resolved_account_id ?? null,
    amountKey: normalizeAmountKey(row.amount),
    currencyKey: currencyKeyOf(row.currency),
    txHash: row.tx_hash || null,
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
    // Set by planChunk when the row's tx_hash is already in `transactions`:
    // it is still submitted to the bulk INSERT (so Postgres evaluates its
    // tuple constraints) but ON CONFLICT is expected to drop it.
    conflictPredicted: false,
  };
}

/**
 * Does `cand` satisfy the dup-check WHERE clause for an incoming row with
 * `rowHash`? Mirrors the last predicate of
 * `transactionRepository.findImportDuplicate`:
 *
 *   t.import_batch_id IS DISTINCT FROM $7 OR t.tx_hash IS NULL
 *   OR $6::text IS NULL OR t.tx_hash = $6
 *
 * @param {{ txHash: string|null, importBatchId: unknown }} cand
 * @param {string|null} rowHash
 * @param {ImportBatchId} batchId
 * @returns {boolean}
 */
function candidateVisible(cand, rowHash, batchId) {
  const sameBatch = bigintEq(cand.importBatchId, batchId); // true | false | null
  if (sameBatch !== true) return true;
  if (cand.txHash === null) return true; // t.tx_hash IS NOT NULL → FALSE
  if (rowHash === null) return true; // $6::text IS NOT NULL  → FALSE
  if (cand.txHash === rowHash) return true; // t.tx_hash <> $6      → FALSE
  // Same batch plus two present, differing hashes is the sole exemption.
  return false;
}

/**
 * The original per-row commit loop: one dup-check SELECT, one SAVEPOINT, one
 * INSERT, one staging UPDATE and one RELEASE per row. Still the authority on
 * commit semantics, and the fallback whenever the batched plan cannot be
 * applied verbatim.
 *
 * @param {{ chunk: any[], batchId: ImportBatchId, committedHashes: Set<string> }} args
 * @returns {Promise<ChunkResult>}
 */
async function commitChunkPerRow({ chunk, batchId, committedHashes }) {
  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  /** @type {InsertedRow[]} */
  const inserted = [];

  for (const row of chunk) {
    const d = deriveRow(row);

    // Intra-batch dedup: a row whose tx_hash was already committed by an
    // earlier row in this same run is a duplicate even though it is not
    // yet visible to the field-based check below.
    if (d.txHash && committedHashes.has(d.txHash)) {
      duplicates++;
      await markStagingRowDuplicate(row.id);
      continue;
    }

    // Field-based duplicate check against canonical transactions.
    // Includes memo so two legitimate same-day same-amount same-recipient
    // purchases (e.g. two coffees) are not falsely deduped — but memo does
    // NOT discriminate card payments (Revolut stamps the identical
    // "CARD_PAYMENT - CURRENT" on every one), so three more guards:
    //  - same account only (account_id, resolved from the staging label —
    //    ADR-088): an identical purchase on a DIFFERENT account is a distinct
    //    transaction, not a duplicate;
    //  - same currency: one account may hold several (ADR-089 addendum —
    //    Revolut books its EUR and USD rows into ONE account rather than
    //    splitting per currency the way Wise does), so the account stopped
    //    discriminating them. The tx_hash guard below does NOT cover this: it
    //    is scoped to the current batch, and the case that bites is a −25.00
    //    USD row field-matching the −25.00 EUR row that an EARLIER import of
    //    the same rolling export already committed — silently dropping a real
    //    transaction into another currency's identity;
    //  - when both rows carry a tx_hash and the hashes DIFFER, the hash is
    //    the identity and the rows are distinct (two same-day card
    //    payments differ by running balance → different hash). Equal
    //    hashes never reach here (intra-batch set + ON CONFLICT below).
    //    Without this, the second of two identical same-batch card
    //    payments field-matched the first inside the same DB transaction
    //    and a REAL transaction was silently dropped.
    //    Scoped to `t.import_batch_id = $7` (this batch only): tx_hash is
    //    sha256 of the SOURCE-format row, so a cross-source re-import (the
    //    Vision export round-trip the csv/vision adapters exist to support)
    //    carries a different hash than the stored bank-format one. Without
    //    the batch scope that hash inequality would suppress the field
    //    match and re-insert every already-imported transaction — breaking
    //    the "re-import is a no-op" idempotency this dedup is meant to give.
    const duplicateId = await transactionRepository.findImportDuplicate({
      date: d.dateStr,
      amount: row.amount,
      recipientId: d.recipientId,
      memo: d.memoNorm,
      accountId: d.accountId,
      currency: d.currencyKey,
      txHash: d.txHash,
      batchId,
    });

    if (duplicateId !== undefined) {
      duplicates++;
      await markStagingRowDuplicate(row.id);
      continue;
    }

    // SAVEPOINT per row: if insert fails the transaction stays usable for the
    // remaining rows. Rows are processed sequentially, so one static name can
    // be reused. Keep BIGSERIAL validation as a data-integrity boundary for
    // repository and staging-row writes, independent of savepoint naming.
    if (!d.idValid) {
      errors++;
      continue;
    }
    try {
      const duplicate = await withSavepointIfInTransaction(
        ROW_SAVEPOINT,
        async () => {
          // ON CONFLICT on the partial unique index over tx_hash makes the
          // insert race-safe — a concurrent import that slipped past the
          // field-based check above can't double-insert.
          const insertedId = await transactionRepository.insertImportedRow({
            date: d.dateStr,
            // Dual-write (ADR-088 pre-drop): the string keeps feeding the sync
            // trigger; the resolved FK is written explicitly (decoupled half).
            bankAccount: d.bankAccount,
            accountId: d.accountId,
            recipientId: d.recipientId,
            categoryId: d.categoryId,
            amount: row.amount,
            memo: row.memo || "",
            // The SAME value the dup probe above was keyed on — currency is part
            // of the row's identity, so the probe and the write must not drift.
            currency: d.currencyKey,
            balance: row.balance != null ? row.balance : null,
            comment: row.comment || null,
            importBatchId: batchId,
            matchedPatternId: d.patternId,
            txHash: d.txHash,
          });

          if (insertedId === undefined) {
            // tx_hash conflict — another row/import already has this hash.
            duplicates++;
            await markStagingRowDuplicate(row.id);
            return true;
          }

          imported++;
          inserted.push({
            id: insertedId,
            recipient_id: d.recipientId,
            amount: row.amount,
            transaction_date: d.dateStr,
          });
          if (d.txHash) committedHashes.add(d.txHash);
          await markStagingRowCommitted(row.id);
          return false;
        },
      );
      if (duplicate) continue;
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
 * Raised when the bulk INSERT could not be applied exactly as planned, so the
 * chunk must be replayed row by row.
 */
class ChunkPlanInvalid extends Error {}

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
 * Load every `transactions` row that could satisfy the field-based dup check
 * for any row of this chunk, keyed by the composite dup key.
 *
 * Scope matches the per-row WHERE exactly: `t.is_active = true` plus the
 * chunk's dates. Everything else in that WHERE (amount, recipient, memo,
 * account_id, currency, hash exemption) is decided in JS from the returned
 * columns — so the candidate set is a strict superset, never a narrower one.
 *
 * @param {string[]} dates distinct 'YYYY-MM-DD' of the chunk
 * @returns {Promise<Map<string, Array<{ txHash: string|null, importBatchId: unknown }>>>}
 */
async function loadDupCandidates(dates) {
  /** @type {Map<string, Array<{ txHash: string|null, importBatchId: unknown }>>} */
  const index = new Map();
  if (dates.length === 0) return index;

  const { rows } = await query(
    `SELECT to_char(t.date, 'YYYY-MM-DD')     AS date_key,
            t.amount::text                    AS amount_key,
            t.recipient_id,
            COALESCE(BTRIM(t.memo, E' \\t\\n\\r\\f\\013'), '') AS memo_key,
            t.account_id,
            t.currency,
            t.tx_hash,
            t.import_batch_id
       FROM transactions t
      WHERE t.is_active = true
        AND t.date = ANY($1::date[])`,
    [dates],
  );

  for (const r of rows) {
    const key = dupKey({
      date: r.date_key,
      amountKey: normalizeAmountKey(r.amount_key),
      recipientId:
        r.recipient_id === null || r.recipient_id === undefined
          ? null
          : Number(r.recipient_id),
      memoKey: r.memo_key ?? "",
      accountId:
        r.account_id === null || r.account_id === undefined
          ? null
          : Number(r.account_id),
      // NOT NULL in the schema; `currencyKeyOf` is the same default the
      // incoming side applies, so the two keys agree on a legacy blank.
      currencyKey: currencyKeyOf(r.currency),
    });
    const bucket = index.get(key);
    const cand = {
      txHash: r.tx_hash ?? null,
      importBatchId: r.import_batch_id ?? null,
    };
    if (bucket) bucket.push(cand);
    else index.set(key, [cand]);
  }

  return index;
}

/**
 * Which of the chunk's tx_hashes already exist in `transactions`? Stands in
 * for the per-row `ON CONFLICT (tx_hash) DO NOTHING` returning no row.
 *
 * Deliberately NOT filtered by `is_active`: `uq_transactions_tx_hash` is a
 * partial index on `tx_hash IS NOT NULL` with no is_active predicate, so a
 * soft-deleted row still causes a conflict.
 *
 * @param {string[]} hashes
 * @returns {Promise<Set<string>>}
 */
async function loadExistingHashes(hashes) {
  if (hashes.length === 0) return new Set();
  const { rows } = await query(
    `SELECT tx_hash FROM transactions WHERE tx_hash = ANY($1::text[])`,
    [hashes],
  );
  return new Set(rows.map((/** @type {{ tx_hash: string }} */ r) => r.tx_hash));
}

/**
 * Plan a chunk: decide every row's verdict in JS from two pre-load SELECTs,
 * reproducing the per-row loop's decisions and its ordering effects.
 *
 * @param {{ chunk: any[], batchId: ImportBatchId, committedHashes: Set<string>, capabilities?: { multiCurrencyCash?: boolean } }} args
 * @returns {Promise<{
 *   toInsert: ReturnType<typeof deriveRow>[],
 *   committedIds: string[],
 *   duplicateIds: any[],
 *   duplicates: number,
 *   errors: number,
 *   newHashes: string[],
 * }>}
 */
async function planChunk({ chunk, batchId, committedHashes }) {
  const derived = chunk.map(deriveRow);

  const index = await loadDupCandidates([
    ...new Set(derived.map((d) => d.dateStr)),
  ]);
  const existingHashes = await loadExistingHashes([
    ...new Set(derived.map((d) => d.txHash).filter((h) => h !== null)),
  ]);

  /** @type {ReturnType<typeof deriveRow>[]} */
  const toInsert = [];
  /** @type {any[]} */
  const duplicateIds = [];
  /** @type {string[]} */
  const newHashes = [];
  // Hashes committed by earlier rows of THIS chunk. Kept separate from the
  // run-wide set so a fallback can discard them wholesale.
  const chunkHashes = new Set();
  let errors = 0;

  for (const d of derived) {
    // 1. Intra-batch hash dedup (earlier row of this run already wrote it).
    if (
      d.txHash &&
      (committedHashes.has(d.txHash) || chunkHashes.has(d.txHash))
    ) {
      duplicateIds.push(d.row.id);
      continue;
    }

    // 2. Field-based dup check against the pre-loaded candidate index.
    const key = dupKey({
      date: d.dateStr,
      amountKey: d.amountKey,
      recipientId: d.recipientId === null ? null : Number(d.recipientId),
      memoKey: d.memoNorm,
      accountId: d.accountId,
      currencyKey: d.currencyKey,
    });
    const bucket = index.get(key);
    if (bucket && bucket.some((c) => candidateVisible(c, d.txHash, batchId))) {
      duplicateIds.push(d.row.id);
      continue;
    }

    // 3. BIGSERIAL shape validation — ordered AFTER the duplicate checks
    //    exactly as the per-row loop orders it, so a malformed id on a
    //    duplicate row still counts as a duplicate rather than an error.
    if (!d.idValid) {
      errors++;
      continue;
    }

    // 4. ON CONFLICT (tx_hash) equivalent — PREDICTED, not applied.
    //
    // The row still goes into the bulk INSERT. PostgreSQL forms and validates
    // the tuple (NOT NULL, CHECK, numeric overflow) BEFORE it looks for a
    // conflict arbiter, so a row that both conflicts on tx_hash and violates
    // one of those raises an error under the per-row loop and must keep doing
    // so here — short-circuiting in JS would silently downgrade a real failure
    // to 'duplicate' and rob the user of the signal. (Foreign keys are the
    // other way round: RI is an AFTER trigger that never fires for a row
    // DO NOTHING skipped, so a bad FK on a conflicting row IS a duplicate.
    // Letting Postgres adjudicate reproduces both, at no extra round trip.)
    //
    // What is decided here is only the row's *bookkeeping*: it is counted and
    // marked 'duplicate', and — because the insert will not land — it is NOT
    // fed back into the candidate index or the hash set, so later rows of the
    // chunk cannot see it. `bulkInsertPlanned` verifies that Postgres dropped
    // exactly this predicted set and nothing else.
    if (d.txHash && existingHashes.has(d.txHash)) {
      d.conflictPredicted = true;
      duplicateIds.push(d.row.id);
      toInsert.push(d);
      continue;
    }

    // Planned insert. Feed it back into the candidate index and the hash set
    // so later rows of this chunk see it, exactly as an in-transaction INSERT
    // would have made it visible to the next row's dup check.
    toInsert.push(d);
    const selfKey = dupKey({
      date: d.dateStr,
      amountKey: d.amountKey,
      recipientId: d.recipientId === null ? null : Number(d.recipientId),
      // The stored memo is `row.memo || ''`; the dup check reads it back
      // through the same ASCII-whitespace BTRIM as the preload query.
      memoKey: sqlTrimAsciiWhitespace(d.row.memo || ""),
      // The INSERT writes both the label string and this resolved account_id;
      // the sync trigger re-resolves the string to the SAME id (the account
      // row already exists — resolveChunkAccounts created it), so this is
      // exactly what a later row of the chunk reads back via t.account_id.
      accountId: d.accountId,
      // The stored currency is `d.currencyKey` — that is what the INSERT below
      // writes, so that is what a later row of this chunk must match against.
      currencyKey: d.currencyKey,
    });
    const selfCand = { txHash: d.txHash, importBatchId: batchId };
    const selfBucket = index.get(selfKey);
    if (selfBucket) selfBucket.push(selfCand);
    else index.set(selfKey, [selfCand]);
    if (d.txHash) {
      chunkHashes.add(d.txHash);
      newHashes.push(d.txHash);
    }
  }

  return {
    toInsert,
    // Only rows Postgres is expected to actually write become 'committed';
    // the predicted conflicts are already in `duplicateIds`.
    committedIds: toInsert
      .filter((d) => !d.conflictPredicted)
      .map((d) => d.idStr),
    duplicateIds,
    duplicates: duplicateIds.length,
    errors,
    newHashes,
  };
}

/**
 * Write the planned inserts with a single multi-row INSERT (the
 * `SELECT UNNEST(...)` pattern already used by `match.js`), and map the
 * returned ids back onto the planned rows.
 *
 * @param {ReturnType<typeof deriveRow>[]} toInsert
 * @param {ImportBatchId} batchId
 * @returns {Promise<InsertedRow[]>}
 * @throws {ChunkPlanInvalid} when the write did not land exactly as planned
 */
async function bulkInsertPlanned(toInsert, batchId) {
  // Dual-write (ADR-088 pre-drop): bank_account keeps feeding the sync
  // trigger, account_id is written explicitly as the decoupled half (the
  // trigger re-resolves the string to the same id).
  const { rows } = await query(
    `INSERT INTO transactions
              (date, bank_account, account_id, recipient_id, category_id, amount, memo, currency, balance,
               comment, import_batch_id, matched_pattern_id, tx_hash, is_active)
          SELECT UNNEST($1::date[]),
                 UNNEST($2::text[]),
                 UNNEST($13::integer[]),
                 UNNEST($3::integer[]),
                 UNNEST($4::integer[]),
                 UNNEST($5::numeric[]),
                 UNNEST($6::text[]),
                 UNNEST($7::text[]),
                 UNNEST($8::numeric[]),
                 UNNEST($9::text[]),
                 $10::bigint,
                 UNNEST($11::integer[]),
                 UNNEST($12::text[]),
                 true
          ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING
          RETURNING id, tx_hash`,
    [
      toInsert.map((d) => d.dateStr),
      toInsert.map((d) => d.bankAccount),
      toInsert.map((d) => d.recipientId),
      toInsert.map((d) => d.categoryId),
      toInsert.map((d) => d.row.amount),
      toInsert.map((d) => d.row.memo || ""),
      toInsert.map((d) => d.currencyKey),
      toInsert.map((d) => (d.row.balance != null ? d.row.balance : null)),
      toInsert.map((d) => d.row.comment || null),
      batchId,
      toInsert.map((d) => d.patternId),
      toInsert.map((d) => d.txHash),
      toInsert.map((d) => d.accountId),
    ],
  );

  // `ON CONFLICT DO NOTHING` is expected to drop EXACTLY the rows the plan
  // predicted would conflict, and nothing else. Any other shortfall means a
  // concurrent import won a tx_hash race, in which case the plan's later
  // verdicts may be wrong (a row ruled a duplicate of a row that never
  // landed), so the chunk is replayed row by row.
  //
  // Note this stays a complete check for a chunk in which NO row carries a
  // hash: `expected` is then the whole plan (a NULL hash can never conflict),
  // so any shortfall at all trips this. The per-row hash comparison below is
  // vacuous for such a chunk — null vs null — and the count is what carries it.
  const expected = toInsert.filter((d) => !d.conflictPredicted);
  if (rows.length !== expected.length) {
    throw new ChunkPlanInvalid(
      `bulk insert returned ${rows.length} rows, expected ${expected.length} ` +
        `(${toInsert.length} planned, ${toInsert.length - expected.length} predicted conflicts)`,
    );
  }

  // `INSERT ... SELECT ... RETURNING` emits one output row per inserted row in
  // source order, and the skipped rows emit nothing, so `expected` and `rows`
  // line up index for index. Verify that against the returned tx_hash rather
  // than trusting it, when the driver gave us one: if a predicted conflict
  // actually inserted while a non-predicted row conflicted, the counts cancel
  // out and only this positional check catches the swap.
  const hashesReturned = rows.every((/** @type {any} */ r) =>
    Object.hasOwn(r, "tx_hash"),
  );

  /** @type {InsertedRow[]} */
  const inserted = [];
  for (let i = 0; i < expected.length; i++) {
    const d = expected[i];
    if (hashesReturned && (rows[i].tx_hash ?? null) !== d.txHash) {
      throw new ChunkPlanInvalid(
        "bulk insert RETURNING order did not match source order",
      );
    }
    inserted.push({
      id: rows[i].id,
      recipient_id: d.recipientId,
      amount: d.row.amount,
      transaction_date: d.dateStr,
    });
  }
  return inserted;
}

/**
 * Commit one chunk: try the batched plan, fall back to the per-row loop under
 * a chunk-level SAVEPOINT if the bulk write cannot be applied as planned.
 *
 * @param {{ chunk: any[], batchId: ImportBatchId, committedHashes: Set<string> }} args
 * @returns {Promise<ChunkResult>}
 */
async function commitChunk({ chunk, batchId, committedHashes, capabilities }) {
  // Inside the chunk transaction, before the SAVEPOINT: minted accounts roll
  // back with a failed chunk but survive the savepoint rollback that hands a
  // chunk to the per-row replay (see resolveChunkAccounts).
  await resolveChunkAccounts(chunk, capabilities);
  const plan = await planChunk({ chunk, batchId, committedHashes });

  /** @type {InsertedRow[]} */
  let inserted = [];
  if (plan.toInsert.length > 0) {
    try {
      inserted = await withSavepointIfInTransaction(CHUNK_SAVEPOINT, () =>
        bulkInsertPlanned(plan.toInsert, batchId),
      );
    } catch (err) {
      // A poison row (FK/NOT NULL violation) or a lost tx_hash race. Either
      // way the whole plan is suspect — every verdict downstream of the row
      // that failed could differ — so discard it and replay row by row.
      logger.warn(
        "[pipeline:commit] batched chunk insert failed, replaying per row",
        {
          batchId,
          rows: chunk.length,
          error: err?.message,
        },
      );
      return commitChunkPerRow({ chunk, batchId, committedHashes });
    }
  }

  // Staging bookkeeping, batched. Rows rejected by the id validation get no
  // staging write at all — the per-row loop does not write one either.
  if (plan.committedIds.length > 0) {
    await query(
      `UPDATE import_staging_rows SET status = 'committed' WHERE id = ANY($1::bigint[])`,
      [plan.committedIds],
    );
  }
  if (plan.duplicateIds.length > 0) {
    await query(
      `UPDATE import_staging_rows SET status = 'duplicate' WHERE id = ANY($1::bigint[])`,
      [plan.duplicateIds],
    );
  }

  for (const h of plan.newHashes) committedHashes.add(h);

  return {
    imported: inserted.length,
    duplicates: plan.duplicates,
    errors: plan.errors,
    inserted,
  };
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
            isr.tx_hash,
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
  // tx_hashes already written to `transactions` by this run — guards against
  // two identical rows inside the same CSV both passing the field-based dup
  // check (neither is in `transactions` yet when the first is processed).
  /** @type {Set<string>} */
  const committedHashes = new Set();
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
    // Snapshot so a rolled-back chunk cannot leave the run-wide hash set
    // holding hashes that were never actually committed.
    const hashesBefore = new Set(committedHashes);
    try {
      await withTransaction(async () => {
        const res = await commitChunk({
          chunk,
          batchId,
          committedHashes,
          capabilities,
        });
        chunkImported = res.imported;
        chunkDuplicates = res.duplicates;
        chunkErrors = res.errors;
        chunkInserted = res.inserted ?? [];
      });
    } catch (err) {
      committedHashes.clear();
      for (const h of hashesBefore) committedHashes.add(h);
      throw err;
    }

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
