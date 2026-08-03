/**
 * Portfolio import pipeline — COMMIT
 *
 * Drains 'matched' staging rows into portfolio_transactions via the existing
 * portfolioTransactionRepository.create (so 2-of-3 unit math, oversell
 * prevention, and asset-class routing are reused). Each create is atomic on its
 * own connection, so a per-row failure (oversell, unresolved instrument) is
 * caught and recorded as a row error without aborting the batch.
 *
 * FX is auto-resolved (on-or-before stored rate) when the row has no rate and
 * is non-EUR. Dedup is field-based against portfolio_transactions (no tx_hash
 * column there) plus an intra-batch hash guard.
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import portfolioTransactionRepository from '../../repositories/portfolioTransactionRepository.js';
import recipientRepository from '../../repositories/recipientRepository.js';
import { autoResolveFxRateToEur } from '../portfolio/fxResolve.js';
import { classifyBrokerageRow } from '../importPipeline/brokerageRouting.js';

// Rows are drained in chunked BEGIN/COMMIT (mirrors importPipeline/commit.js):
// one transaction per chunk instead of one autocommit per statement collapses a
// 500-1000 row brokerage CSV from thousands of sequential round trips to a
// handful, while a per-row SAVEPOINT keeps crash-isolation (a bad row rolls back
// to its savepoint without poisoning the chunk).
/**
 * @typedef {import('../../types/rows.js').PortfolioImportStagingRow} PortfolioImportStagingRow
 * @typedef {import('./index.js').PortfolioImportBatchId} PortfolioImportBatchId
 * @typedef {import('./index.js').PortfolioImportProgressCallback} PortfolioImportProgressCallback
 */

/**
 * The projection commit.js drains. `tx_date` is `to_char`-ed to a 'YYYY-MM-DD'
 * string, `investment_id` is `COALESCE(user_override_investment_id,
 * resolved_investment_id)`, and the two `inv.*` columns come from the LEFT JOIN
 * on `investments` (null for cash rows and unresolved instruments).
 *
 * @typedef {Pick<PortfolioImportStagingRow,
 *   'id'|'type'|'route'|'type_raw'|'units'|'price_per_unit'|'amount'|'fees'|'taxes'|'currency'|'fx_rate_to_eur'|'note'|'tx_hash'>
 *   & {
 *     tx_date: string|null,
 *     investment_id: number|null,
 *     asset_class: string|null,
 *     investment_currency: string|null,
 *   }} MatchedPortfolioStagingRow
 */

const COMMIT_CHUNK = 1000;

// Staging stores cash magnitudes ABSOLUTE (adapter contract); the ledger sign
// comes from the kind. Without this every withdrawal was credited as a
// deposit (+500 instead of −500) — the sleeve error grew 2× per withdrawal.
/**
 * @param {Pick<MatchedPortfolioStagingRow, 'type_raw'|'amount'>} row
 * @returns {number} the ledger-signed cash amount (negative for withdrawals)
 */
function signedCashAmount(row) {
  const { direction } = classifyBrokerageRow({ kind: row.type_raw });
  return (direction ?? 1) * Math.abs(Number(row.amount));
}

/**
 * Run the commit phase: drain 'matched' staging rows into
 * `portfolio_transactions` (and, for brokerage cash rows, `transactions`), with
 * field-based dedup, an intra-batch hash guard, and a per-row SAVEPOINT.
 *
 * @param {{ batchId: PortfolioImportBatchId, onProgress?: PortfolioImportProgressCallback }} args
 * @returns {Promise<{ imported: number, duplicates: number, errors: number }>}
 */
export async function commitBatch({ batchId, onProgress }) {
  await query(`UPDATE portfolio_import_batches SET status = 'committing' WHERE id = $1`, [batchId]);

  // Batch-level brokerage account (ADR-095): every lot from this batch lands on it,
  // giving imported holdings a real per-account position (ADR-091). NULL = unassigned.
  // In brokerage mode the batch ALSO routes external cash rows into the ledger.
  // The account's institution/name ride along as the broker label for the cash
  // rows' recipient (see cashRecipientId below).
  const { rows: batchRows } = await query(
    `SELECT b.account_id, b.is_brokerage,
            a.institution AS account_institution,
            a.name AS account_name
       FROM portfolio_import_batches b
       LEFT JOIN accounts a ON a.id = b.account_id
      WHERE b.id = $1`,
    [batchId],
  );
  const batchAccountId = batchRows[0]?.account_id ?? undefined;
  const isBrokerage = batchRows[0]?.is_brokerage === true;

  const { rows: matched } = await query(
    `SELECT isr.id,
            to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
            isr.type,
            isr.route,
            isr.type_raw,
            isr.units,
            isr.price_per_unit,
            isr.amount,
            isr.fees,
            isr.taxes,
            isr.currency,
            isr.fx_rate_to_eur,
            isr.note,
            isr.tx_hash,
            COALESCE(isr.user_override_investment_id, isr.resolved_investment_id) AS investment_id,
            inv.asset_class,
            inv.currency AS investment_currency
       FROM portfolio_import_staging_rows isr
       LEFT JOIN investments inv
         ON inv.id = COALESCE(isr.user_override_investment_id, isr.resolved_investment_id)
      WHERE isr.batch_id = $1 AND isr.status = 'matched'
      ORDER BY isr.row_index ASC`,
    [batchId],
  );

  const total = matched.length;
  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  /** @type {Set<string>} */
  const committedHashes = new Set();

  // ── Cash-row recipient, hoisted to once per commit ──
  // `transactions.recipient_id` has been NOT NULL since migration 0001, with no
  // default and no supplying trigger, so every brokerage cash INSERT must carry
  // a real id. The payee of an imported brokerage cash movement is the batch's
  // BROKER: the sleeve account's `institution`, or failing that its `name`,
  // resolved through recipientRepository.createOrGet — the same
  // trimmed/uppercased display name + normalized_name unique-key path every
  // other recipient takes, so re-imports and casing/whitespace variants
  // ("DEGIRO " vs "degiro") land on ONE identity instead of forking
  // near-duplicates. A batch whose account carries no usable label falls back
  // to the shared 'SYSTEM' recipient (recipientRepository.getOrCreateSystemId),
  // like the other server-generated ledger rows.
  //
  // Resolved here, OUTSIDE the chunk transactions: the recipient is shared
  // state, not batch state — a chunk rollback must not undo it, and the unique
  // key makes the write idempotent anyway.
  /** @type {number|null} */
  let cashRecipientId = null;
  if (isBrokerage && batchAccountId && matched.some((/** @type {{route?: string}} */ r) => r.route === 'cash')) {
    const brokerName = [batchRows[0]?.account_institution, batchRows[0]?.account_name]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0);
    if (brokerName) {
      const { recipient } = await recipientRepository.createOrGet({ name: brokerName });
      cashRecipientId = recipient?.id ?? null;
    }
    if (cashRecipientId == null) {
      cashRecipientId = await recipientRepository.getOrCreateSystemId();
    }
  }

  // Per-batch FX cache: the on-or-before stored-rate lookup is deterministic for
  // a given (currency, tx_date), so resolve each pair once instead of issuing a
  // fresh uncached lookup on every row — a single-currency CSV collapses ~N
  // lookups to one per distinct trade date.
  /** @type {Map<string, number|undefined>} */
  const fxCache = new Map();
  /**
   * @param {string|null} currency
   * @param {string|null} date 'YYYY-MM-DD'
   * @returns {Promise<number|undefined>}
   */
  async function resolveFx(currency, date) {
    const key = `${String(currency || 'EUR').toUpperCase()}|${date}`;
    if (fxCache.has(key)) return fxCache.get(key);
    const rate = await autoResolveFxRateToEur(currency, date);
    fxCache.set(key, rate);
    return rate;
  }

  if (onProgress) onProgress({ phase: 'committing', current: 0, total });

  for (let start = 0; start < total; start += COMMIT_CHUNK) {
    const chunk = matched.slice(start, start + COMMIT_CHUNK);
    // Chunk-local counters: folded into the running totals (and the persisted
    // checkpoint) only AFTER withTransaction resolves, so a chunk that rolls
    // back never leaves the JS counters — or the checkpoint — inflated past
    // what's actually committed. (Mirrors importPipeline/commit.js.)
    let chunkImported = 0;
    let chunkDuplicates = 0;
    let chunkErrors = 0;
    await withTransaction(async (client) => {
      // Reset inside the callback so a withTransaction retry recounts cleanly.
      chunkImported = 0;
      chunkDuplicates = 0;
      chunkErrors = 0;
      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j];

        // ── Brokerage cash row (ADR-095): an external deposit/withdrawal → a plain
        // cash transaction on the sleeve (NOT a trade, no leg). ──
        if (isBrokerage && row.route === 'cash') {
          if (!batchAccountId) {
            chunkErrors++;
            await markRow(row.id, 'error', 'brokerage cash row requires a batch account');
            continue;
          }
          if (row.tx_hash && committedHashes.has(row.tx_hash)) {
            chunkDuplicates++;
            await markRow(row.id, 'duplicate');
            continue;
          }
          if (await isCashFieldDuplicate(batchAccountId, row)) {
            chunkDuplicates++;
            await markRow(row.id, 'duplicate');
            continue;
          }
          const sp = savepointFor(row.id);
          if (!sp) { chunkErrors++; continue; }
          await client.query(`SAVEPOINT ${sp}`);
          try {
            const memo = row.note || (row.type_raw ? String(row.type_raw).toUpperCase() : 'BROKERAGE CASH');
            const r = await query(
              `INSERT INTO transactions (date, amount, currency, memo, account_id, recipient_id, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
              [row.tx_date, signedCashAmount(row), row.currency || 'EUR', memo, batchAccountId, cashRecipientId],
            );
            await query(
              `UPDATE portfolio_import_staging_rows SET status = 'committed', committed_txn_id = $2 WHERE id = $1`,
              [row.id, r.rows[0]?.id ?? null],
            );
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            chunkImported++;
            if (row.tx_hash) committedHashes.add(row.tx_hash);
          } catch (err) {
            // ROLLBACK TO SAVEPOINT before markRow: PostgreSQL poisons the whole
            // chunk txn on ANY statement error (25P02), so the row's error must
            // be recorded on a clean connection.
            await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            chunkErrors++;
            await markRow(row.id, 'error', err?.message?.slice(0, 500) || 'cash insert failed');
          }
          continue;
        }

        if (!row.investment_id) {
          chunkErrors++;
          await markRow(row.id, 'error', 'unresolved instrument — pick or create a holding');
          continue;
        }

        if (row.tx_hash && committedHashes.has(row.tx_hash)) {
          chunkDuplicates++;
          await markRow(row.id, 'duplicate');
          continue;
        }

        if (await isFieldDuplicate(row, batchAccountId)) {
          chunkDuplicates++;
          await markRow(row.id, 'duplicate');
          continue;
        }

        const sp = savepointFor(row.id);
        if (!sp) { chunkErrors++; continue; }
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const currency = row.currency || row.investment_currency || 'EUR';
          let fxRate = row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined;
          if (fxRate === undefined) fxRate = await resolveFx(currency, row.tx_date);

          const created = await portfolioTransactionRepository.create(/** @type {any} */ ({
            investment_id: row.investment_id,
            type: row.type,
            date: row.tx_date,
            amount: row.amount != null ? Number(row.amount) : undefined,
            units: row.units != null ? Number(row.units) : undefined,
            price_per_unit: row.price_per_unit != null ? Number(row.price_per_unit) : undefined,
            fees: row.fees != null ? Number(row.fees) : 0,
            taxes: row.taxes != null ? Number(row.taxes) : 0,
            currency,
            note: row.note || undefined,
            fx_rate_to_eur: fxRate,
            account_id: batchAccountId,
            // Import provenance (migration 0086) — the stamp rollback bulk-deletes
            // on. Trades only: a brokerage CASH row goes to `transactions`, whose
            // own import_batch_id FKs to the BANK `import_batches` table, so a
            // portfolio batch id must never be written there.
            import_batch_id: batchId,
            preloaded_asset_class: row.asset_class,
          }));

          await query(
            `UPDATE portfolio_import_staging_rows SET status = 'committed', committed_txn_id = $2 WHERE id = $1`,
            [row.id, created?.id ?? null],
          );
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          chunkImported++;
          if (row.tx_hash) committedHashes.add(row.tx_hash);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          chunkErrors++;
          await markRow(row.id, 'error', err?.message?.slice(0, 500) || 'insert failed');
        }

        if (onProgress && (start + j + 1) % 50 === 0) {
          onProgress({
            phase: 'committing',
            current: start + j + 1,
            total,
            imported: imported + chunkImported,
            duplicates: duplicates + chunkDuplicates,
            errors: errors + chunkErrors,
          });
        }
      }
    });

    // Transaction committed — only now fold the chunk's counts into the running
    // totals and the persisted checkpoint.
    imported += chunkImported;
    duplicates += chunkDuplicates;
    errors += chunkErrors;

    // Checkpoint per chunk (increment by chunk-local delta, preserving any
    // rows_error already set by earlier pipeline phases) so a crash mid-import
    // leaves recoverable state in portfolio_import_batches.
    await query(
      `UPDATE portfolio_import_batches
          SET rows_imported = COALESCE(rows_imported, 0) + $2,
              rows_duplicate = COALESCE(rows_duplicate, 0) + $3,
              rows_error = COALESCE(rows_error, 0) + $4
        WHERE id = $1`,
      [batchId, chunkImported, chunkDuplicates, chunkErrors],
    );

    if (onProgress) {
      onProgress({ phase: 'committing', current: Math.min(start + chunk.length, total), total, imported, duplicates, errors });
    }
  }

  logger.info('[portfolio-pipeline:commit] done', { batchId, total, imported, duplicates, errors, isBrokerage });
  return { imported, duplicates, errors };
}

// Build a per-row SAVEPOINT identifier. portfolio_import_staging_rows.id is
// BIGSERIAL — the pg driver returns BIGINT as a string to preserve int64
// precision, so validate against a digits-only regex to keep the interpolated
// identifier injection-safe. Returns null for a non-numeric id so the caller
// can skip the row rather than emit an unsafe savepoint name.
/**
 * @param {string|number} id
 * @returns {string|null} null when the id is not digits-only (unsafe to interpolate)
 */
function savepointFor(id) {
  const idStr = String(id);
  return /^\d+$/.test(idStr) ? `sp_prow_${idStr}` : null;
}

/**
 * @param {string|number} id
 * @param {'committed'|'duplicate'|'error'} status
 * @param {string|null} [message]
 * @returns {Promise<void>}
 */
async function markRow(id, status, message) {
  await query(
    `UPDATE portfolio_import_staging_rows SET status = $2, error_message = $3 WHERE id = $1`,
    [id, status, message ?? null],
  );
}

// Field-based dedup for an external brokerage cash row, so re-importing a
// statement is a no-op (cash rows have no tx_hash partial-unique of their own here).
/**
 * @param {number} accountId the batch's brokerage sleeve account
 * @param {MatchedPortfolioStagingRow} row
 * @returns {Promise<boolean>}
 */
async function isCashFieldDuplicate(accountId, row) {
  const memo = row.note || (row.type_raw ? String(row.type_raw).toUpperCase() : 'BROKERAGE CASH');
  const signed = signedCashAmount(row);
  const magnitude = Math.abs(signed);
  const dup = await query(
    `SELECT 1 FROM transactions
      WHERE account_id = $1 AND date = $2::date
        AND (amount = $3 OR amount = $4)
        AND COALESCE(memo, '') = COALESCE($5, '') AND is_active = true
      LIMIT 1`,
    // Match on magnitude, not the raw signed value, so a re-import is a no-op
    // ACROSS the cash-sign fix: brokerage withdrawals committed before the fix
    // are stored positive (+500), while the post-fix insert stores the signed
    // −500. `amount = $3` catches the correctly-signed (post-fix) row and
    // `amount = $4` catches the legacy positive magnitude (pre-fix) row.
    // Direction is still respected: the memo carries the kind (WITHDRAWAL vs
    // DEPOSIT), and a deposit's signed value equals its magnitude so it never
    // reaches the opposite-signed branch — a −500 withdrawal is not deduped
    // against a legitimate +500 deposit.
    [accountId, row.tx_date, signed, magnitude, memo],
  );
  return dup.rows.length > 0;
}

/**
 * @param {MatchedPortfolioStagingRow} row
 * @param {number|undefined} batchAccountId
 * @returns {Promise<boolean>}
 */
async function isFieldDuplicate(row, batchAccountId) {
  // account_id and currency are part of the identity: the same-shaped fill on
  // a different account (or in a different currency) is a distinct trade, not
  // a re-import of this one. IS NOT DISTINCT FROM keeps NULL==NULL matching
  // for account-less (non-brokerage) batches.
  const dup = await query(
    `SELECT 1
       FROM portfolio_transactions
      WHERE investment_id = $1
        AND date = $2::date
        AND type = $3::portfolio_txn_type
        AND amount = $4
        AND COALESCE(units, 0) = COALESCE($5, 0)
        AND account_id IS NOT DISTINCT FROM $6
        AND COALESCE(currency, 'EUR') = $7
      LIMIT 1`,
    [
      row.investment_id,
      row.tx_date,
      row.type,
      row.amount != null ? Number(row.amount) : 0,
      row.units != null ? Number(row.units) : null,
      batchAccountId ?? null,
      row.currency || row.investment_currency || 'EUR',
    ],
  );
  return dup.rows.length > 0;
}
