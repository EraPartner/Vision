/**
 * Portfolio import pipeline — COMMIT
 *
 * Drains 'matched' staging rows into portfolio_transactions via the existing
 * portfolioTransactionService.create (so 2-of-3 unit math, oversell
 * prevention, and asset-class routing are reused). Creates run inside a chunk
 * transaction. A savepoint rolls back a failed row (oversell, unresolved
 * instrument) without aborting the chunk or discarding successful sibling rows.
 *
 * FX is auto-resolved (on-or-before stored rate) when the row has no rate and
 * is non-EUR. Dedup is occurrence-based against the destination tables: each
 * repeated identity in a statement is matched to one existing row, so
 * legitimate identical fills land while re-importing the statement is a no-op.
 */

import { query, withTransaction } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import portfolioTransactionService from "../portfolio/portfolioTransactionService.js";
import recipientRepository from "../../repositories/recipientRepository.js";
import categoryRepository from "../../repositories/categoryRepository.js";
import settingsRepository from "../../repositories/settingsRepository.js";
import { normalizeTransactionPayload } from "../portfolio/portfolioTransactionRules.js";
import { autoResolveFxRateToEur } from "../portfolio/fxResolve.js";
import { classifyBrokerageRow } from "../importPipeline/brokerageRouting.js";

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
 *   'id'|'status'|'type'|'route'|'type_raw'|'units'|'price_per_unit'|'amount'|'fees'|'taxes'|'currency'|'fx_rate_to_eur'|'note'|'tx_hash'>
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
// The kind is the row's canonical `type` when validate persisted one (the D6
// instrument-less dividend/interest/fee/tax cash rows — their type_raw may be
// a broker synonym like "Custody Fee" the classifier's kind sets don't know),
// falling back to `type_raw` for external deposit/withdrawal rows (which never
// normalize to a portfolio type, so their `type` is NULL). `hasInstrument:
// false` keeps the classifier on the D6 cash branch for the portfolio-kind
// cash rows; it is a no-op for deposit/withdrawal kinds.
/**
 * @param {Pick<MatchedPortfolioStagingRow, 'type'|'type_raw'|'amount'>} row
 * @returns {number} the ledger-signed cash amount (negative for
 *   withdrawals/fees/taxes, positive for deposits/dividends/interest)
 */
function signedCashAmount(row) {
  const { direction } = classifyBrokerageRow({
    kind: row.type ?? row.type_raw,
    hasInstrument: false,
  });
  return (direction ?? 1) * Math.abs(Number(row.amount));
}

const CASH_CATEGORY_SETTING_KEY = "brokerage_cash_category_ids";
const CASH_CATEGORY_KINDS = ["dividend", "interest", "fee", "tax"];

/**
 * Run the commit phase: drain 'matched' staging rows into
 * `portfolio_transactions` (and, for brokerage cash rows, `transactions`), with
 * occurrence-based field dedup and a per-row SAVEPOINT.
 *
 * @param {{ batchId: PortfolioImportBatchId, onProgress?: PortfolioImportProgressCallback }} args
 * @returns {Promise<{ imported: number, duplicates: number, errors: number }>}
 */
export async function commitBatch({ batchId, onProgress }) {
  await query(
    `UPDATE portfolio_import_batches SET status = 'committing' WHERE id = $1`,
    [batchId],
  );

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

  const { rows: relevantRows } = await query(
    `SELECT isr.id,
            isr.status,
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
      WHERE isr.batch_id = $1
        AND isr.status IN ('matched', 'committed', 'duplicate')
      ORDER BY isr.row_index ASC`,
    [batchId],
  );
  const matched = relevantRows.filter((row) => row.status === "matched");

  const total = matched.length;
  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  // Per-run occurrence counters for field dedup: a statement may
  // legitimately repeat one (date, signed amount, memo) identity — e.g. two
  // identical per-exchange custody fees on one date — and each occurrence must
  // land, while a RE-import of that same statement must still be a no-op. The
  // rule: the i-th occurrence (0-based) of an identity in this batch is a
  // duplicate iff the ledger already held more than i matching rows BEFORE
  // this run (ledger matches minus what this run itself inserted). Fresh
  // import: 0 pre-existing → both fees insert. Re-import: 2 pre-existing →
  // both occurrences dedup.
  /** @type {Map<string, number>} */
  const cashSeenByIdentity = new Map();
  /** @type {Map<string, number>} */
  const cashInsertedByIdentity = new Map();
  /** @type {Map<string, number>} */
  const tradeSeenByIdentity = new Map();
  /** @type {Map<string, number>} */
  const tradeInsertedByIdentity = new Map();

  // A prior invocation may have committed one or more chunks before the
  // process stopped. Seed the occurrence positions from every row that this
  // batch already resolved (committed OR duplicate); otherwise a restart sees
  // destination rows from the earlier chunks but starts at occurrence zero and
  // incorrectly drops the first still-matched repeated fill.
  for (const row of relevantRows) {
    if (row.status === "matched") continue;
    if (isBrokerage && row.route === "cash") {
      const identity = cashIdentityKey(row);
      cashSeenByIdentity.set(
        identity,
        (cashSeenByIdentity.get(identity) ?? 0) + 1,
      );
      continue;
    }
    if (!row.investment_id) continue;
    const canonical = canonicalTradeValues(row);
    const identity = tradeIdentityKey(row, batchAccountId, canonical);
    tradeSeenByIdentity.set(
      identity,
      (tradeSeenByIdentity.get(identity) ?? 0) + 1,
    );
  }

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
  if (
    isBrokerage &&
    batchAccountId &&
    matched.some((/** @type {{route?: string}} */ r) => r.route === "cash")
  ) {
    const brokerName = [
      batchRows[0]?.account_institution,
      batchRows[0]?.account_name,
    ]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => v.length > 0);
    if (brokerName) {
      const { recipient } = await recipientRepository.createOrGet({
        name: brokerName,
      });
      cashRecipientId = recipient?.id ?? null;
    }
    if (cashRecipientId == null) {
      cashRecipientId = await recipientRepository.getOrCreateSystemId();
    }
  }

  // Resolve the configured IDs once per drain so all chunks use one coherent
  // mapping. Missing, malformed, deleted, or inactive IDs deliberately leave
  // the row uncategorized. Imports never create or reactivate categories.
  /** @type {Map<string, number>} */
  const cashCategoryIds = new Map();
  if (isBrokerage && batchAccountId) {
    const stored = await settingsRepository.get(CASH_CATEGORY_SETTING_KEY);
    const configured =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? stored
        : {};
    const requestedIds = CASH_CATEGORY_KINDS.map(
      (kind) => configured[kind],
    ).filter((id) => Number.isInteger(id) && id > 0);
    const activeIds = new Set(
      (await categoryRepository.getActiveByIds(requestedIds)).map((row) =>
        Number(row.id),
      ),
    );
    for (const kind of CASH_CATEGORY_KINDS) {
      const id = configured[kind];
      if (Number.isInteger(id) && activeIds.has(id)) {
        cashCategoryIds.set(kind, id);
      }
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
    const key = `${String(currency || "EUR").toUpperCase()}|${date}`;
    if (fxCache.has(key)) return fxCache.get(key);
    const rate = await autoResolveFxRateToEur(currency, date);
    fxCache.set(key, rate);
    return rate;
  }

  if (onProgress) onProgress({ phase: "committing", current: 0, total });

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

        // ── Brokerage cash row (ADR-095): an external deposit/withdrawal, or a
        // D6 instrument-less dividend/interest/fee/tax row → one signed plain
        // cash transaction on the sleeve (NOT a trade, no leg). ──
        if (isBrokerage && row.route === "cash") {
          if (!batchAccountId) {
            chunkErrors++;
            await markRow(
              row.id,
              "error",
              "brokerage cash row requires a batch account",
            );
            continue;
          }
          const identity = cashIdentityKey(row);
          const occurrence = cashSeenByIdentity.get(identity) ?? 0;
          cashSeenByIdentity.set(identity, occurrence + 1);
          const insertedThisRun = cashInsertedByIdentity.get(identity) ?? 0;
          const ledgerMatches = await countCashFieldMatches(
            batchAccountId,
            row,
          );
          if (occurrence < ledgerMatches - insertedThisRun) {
            chunkDuplicates++;
            await markRow(row.id, "duplicate");
            continue;
          }
          const sp = savepointFor(row.id);
          if (!sp) {
            chunkErrors++;
            continue;
          }
          await client.query(`SAVEPOINT ${sp}`);
          try {
            const memo =
              row.note ||
              (row.type_raw
                ? String(row.type_raw).toUpperCase()
                : "BROKERAGE CASH");
            const r = await query(
              `INSERT INTO transactions (date, amount, currency, memo, account_id, recipient_id, category_id, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING id`,
              [
                row.tx_date,
                signedCashAmount(row),
                row.currency || "EUR",
                memo,
                batchAccountId,
                cashRecipientId,
                (row.type != null && cashCategoryIds.get(String(row.type))) ||
                  null,
              ],
            );
            await query(
              `UPDATE portfolio_import_staging_rows SET status = 'committed', committed_txn_id = $2 WHERE id = $1`,
              [row.id, r.rows[0]?.id ?? null],
            );
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            chunkImported++;
            cashInsertedByIdentity.set(identity, insertedThisRun + 1);
          } catch (err) {
            // ROLLBACK TO SAVEPOINT before markRow: PostgreSQL poisons the whole
            // chunk txn on ANY statement error (25P02), so the row's error must
            // be recorded on a clean connection.
            await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            chunkErrors++;
            await markRow(
              row.id,
              "error",
              err?.message?.slice(0, 500) || "cash insert failed",
            );
          }
          continue;
        }

        if (!row.investment_id) {
          chunkErrors++;
          await markRow(
            row.id,
            "error",
            "unresolved instrument — pick or create a holding",
          );
          continue;
        }

        let canonical;
        try {
          canonical = canonicalTradeValues(row);
        } catch (err) {
          chunkErrors++;
          await markRow(
            row.id,
            "error",
            err?.message?.slice(0, 500) || "invalid transaction values",
          );
          continue;
        }
        const identity = tradeIdentityKey(row, batchAccountId, canonical);
        const occurrence = tradeSeenByIdentity.get(identity) ?? 0;
        tradeSeenByIdentity.set(identity, occurrence + 1);
        const insertedThisRun = tradeInsertedByIdentity.get(identity) ?? 0;
        const destinationMatches = await countTradeFieldMatches(
          row,
          batchAccountId,
          canonical,
        );
        if (occurrence < destinationMatches - insertedThisRun) {
          chunkDuplicates++;
          await markRow(row.id, "duplicate");
          continue;
        }

        const sp = savepointFor(row.id);
        if (!sp) {
          chunkErrors++;
          continue;
        }
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const currency = row.currency || row.investment_currency || "EUR";
          let fxRate =
            row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined;
          if (fxRate === undefined)
            fxRate = await resolveFx(currency, row.tx_date);

          const created = await portfolioTransactionService.create(
            /** @type {any} */ ({
              investment_id: row.investment_id,
              type: row.type,
              date: row.tx_date,
              amount: canonical.amount,
              units: canonical.units,
              price_per_unit: canonical.price_per_unit,
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
            }),
          );

          await query(
            `UPDATE portfolio_import_staging_rows SET status = 'committed', committed_txn_id = $2 WHERE id = $1`,
            [row.id, created?.id ?? null],
          );
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          chunkImported++;
          tradeInsertedByIdentity.set(identity, insertedThisRun + 1);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          chunkErrors++;
          await markRow(
            row.id,
            "error",
            err?.message?.slice(0, 500) || "insert failed",
          );
        }

        if (onProgress && (start + j + 1) % 50 === 0) {
          onProgress({
            phase: "committing",
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
      onProgress({
        phase: "committing",
        current: Math.min(start + chunk.length, total),
        total,
        imported,
        duplicates,
        errors,
      });
    }
  }

  logger.info("[portfolio-pipeline:commit] done", {
    batchId,
    total,
    imported,
    duplicates,
    errors,
    isBrokerage,
  });
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

/**
 * The cash-row dedup identity: (date, signed amount, currency, memo) — mirrors the SQL
 * predicate in {@link countCashFieldMatches} exactly (the account is constant
 * per batch), so the per-batch occurrence counters below count the same thing
 * the ledger probe counts.
 *
 * @param {MatchedPortfolioStagingRow} row
 * @returns {string}
 */
function cashIdentityKey(row) {
  const memo =
    row.note ||
    (row.type_raw ? String(row.type_raw).toUpperCase() : "BROKERAGE CASH");
  return `${row.tx_date}|${signedCashAmount(row)}|${row.currency || "EUR"}|${memo}`;
}

// Field-based dedup probe for a brokerage cash row (cash rows have no tx_hash
// partial-unique of their own here). Returns the COUNT of matching ledger
// rows, not a boolean: a statement can legitimately repeat one identity (two
// identical custody fees on one date, distinguishable only by a description
// the user didn't map into `note`), so the caller dedups by matching ledger
// occurrences against statement occurrences instead of collapsing them.
/**
 * @param {number} accountId the batch's brokerage sleeve account
 * @param {MatchedPortfolioStagingRow} row
 * @returns {Promise<number>} count of active ledger rows matching the identity
 */
async function countCashFieldMatches(accountId, row) {
  const memo =
    row.note ||
    (row.type_raw ? String(row.type_raw).toUpperCase() : "BROKERAGE CASH");
  const signed = signedCashAmount(row);
  // The legacy magnitude leg (`amount = $4`) exists ONLY for untyped external
  // cash rows (deposit/withdrawal): brokerage withdrawals committed before the
  // cash-sign fix are stored positive (+500) while the post-fix insert stores
  // −500, and a re-import must recognize both. Direction is still respected
  // there: the memo carries the kind (WITHDRAWAL vs DEPOSIT), and a deposit's
  // signed value equals its magnitude, so a −500 withdrawal never dedups
  // against a +500 deposit. D6 rows (`row.type` set) have NO pre-fix legacy —
  // for them the magnitude leg is pure false-positive surface (a new −10 fee
  // must not dedup against an unrelated +10 row sharing date and memo), so
  // they match the signed amount only.
  const legacyLeg = row.type == null;
  /** @type {(string|number|null)[]} */
  const params = [accountId, row.tx_date, signed];
  let amountPredicate = "amount = $3";
  if (legacyLeg) {
    params.push(Math.abs(signed));
    amountPredicate = "(amount = $3 OR amount = $4)";
  }
  params.push(row.currency || "EUR", memo);
  const currencyParam = `$${params.length - 1}`;
  const memoParam = `$${params.length}`;
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM transactions
      WHERE account_id = $1 AND date = $2::date
        AND ${amountPredicate}
        AND COALESCE(currency, 'EUR') = ${currencyParam}
        AND COALESCE(memo, '') = COALESCE(${memoParam}, '') AND is_active = true`,
    params,
  );
  return Number(r.rows[0]?.n) || 0;
}

/**
 * @param {MatchedPortfolioStagingRow} row
 * @param {number|undefined} batchAccountId
 * @param {{amount: number|undefined, units: number|undefined, price_per_unit: number|undefined}} canonical
 * @returns {string}
 */
function tradeIdentityKey(row, batchAccountId, canonical) {
  return [
    row.investment_id,
    row.tx_date,
    row.type,
    canonical.amount ?? 0,
    canonical.units ?? null,
    batchAccountId ?? null,
    row.currency || row.investment_currency || "EUR",
  ].join("|");
}

/**
 * Apply the exact repository normalization before deduplication. Unit-based
 * buy/sell rows support any two of amount, units, and price; comparing the raw
 * missing field to stored derived values would miss a reimport.
 *
 * @param {MatchedPortfolioStagingRow} row
 * @returns {{amount: number|undefined, units: number|undefined, price_per_unit: number|undefined}}
 */
function canonicalTradeValues(row) {
  const normalized = normalizeTransactionPayload(
    {
      type: row.type,
      amount: row.amount != null ? Number(row.amount) : undefined,
      units: row.units != null ? Number(row.units) : undefined,
      price_per_unit:
        row.price_per_unit != null ? Number(row.price_per_unit) : undefined,
      fees: row.fees != null ? Number(row.fees) : 0,
      taxes: row.taxes != null ? Number(row.taxes) : 0,
      fx_rate_to_eur:
        row.fx_rate_to_eur != null ? Number(row.fx_rate_to_eur) : undefined,
    },
    { assetClass: row.asset_class || undefined },
  );
  return {
    amount: normalized.amount,
    units: normalized.units,
    price_per_unit: normalized.price_per_unit,
  };
}

/**
 * Count destination rows matching one imported trade identity. A count, rather
 * than an existence probe, lets the caller pair repeated statement occurrences
 * one-for-one with rows already in the portfolio ledger.
 *
 * @param {MatchedPortfolioStagingRow} row
 * @param {number|undefined} batchAccountId
 * @param {{amount: number|undefined, units: number|undefined}} canonical
 * @returns {Promise<number>}
 */
async function countTradeFieldMatches(row, batchAccountId, canonical) {
  // account_id and currency are part of the identity: the same-shaped fill on
  // a different account (or in a different currency) is a distinct trade, not
  // a re-import of this one. IS NOT DISTINCT FROM keeps NULL==NULL matching
  // for account-less (non-brokerage) batches.
  const matches = await query(
    `SELECT COUNT(*)::int AS n
       FROM portfolio_transactions
      WHERE investment_id = $1
        AND date = $2::date
        AND type = $3::portfolio_txn_type
        AND amount = $4
        AND COALESCE(units, 0) = COALESCE($5, 0)
        AND account_id IS NOT DISTINCT FROM $6
        AND COALESCE(currency, 'EUR') = $7`,
    [
      row.investment_id,
      row.tx_date,
      row.type,
      canonical.amount ?? 0,
      canonical.units ?? null,
      batchAccountId ?? null,
      row.currency || row.investment_currency || "EUR",
    ],
  );
  return Number(matches.rows[0]?.n) || 0;
}
