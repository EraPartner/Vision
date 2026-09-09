/**
 * Portfolio import pipeline — VALIDATE
 *
 * For each pending staging row: normalize the transaction type, check the row
 * carries enough numeric fields for its type (a light pre-check; the repo
 * re-validates at commit), compute separate provenance and versioned
 * occurrence identity, and mark the row 'validated' or 'error'.
 */

import { query } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import { toYmd } from "../calculations/portfolioMath.js";
import { todayAppDateString } from "../../lib/timezone.js";
import { UNIT_BASED_ASSET_CLASSES } from "../portfolio/portfolioTransactionRules.js";
import { normalizeType } from "./portfolioTypeNormalizer.js";
import { classifyBrokerageRow } from "../importPipeline/brokerageRouting.js";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "../importIdentity.js";

/**
 * @typedef {import('../../types/rows.js').PortfolioImportStagingRow} PortfolioImportStagingRow
 * @typedef {import('./index.js').PortfolioImportBatchId} PortfolioImportBatchId
 * @typedef {import('./index.js').PortfolioImportProgressCallback} PortfolioImportProgressCallback
 */

/**
 * The projection validate.js reads. `tx_date` is selected RAW here (unlike the
 * transaction pipeline), so it really is a pg local-midnight `Date` —
 * `resolveAndCheck` formats it with LOCAL getters (`toYmd`) on purpose.
 *
 * @typedef {Pick<PortfolioImportStagingRow,
 *   'id'|'row_index'|'tx_date'|'type_raw'|'symbol_raw'|'name_raw'|'units'|'price_per_unit'|'amount'|'raw_data'>
 *   & { fees?: string|null, taxes?: string|null, currency?: string|null, note?: string|null,
 *       source_transaction_id?: string|null, source_account_identity?: string|null }} PendingPortfolioStagingRow
 */

const VALIDATE_CHUNK = 500;

/**
 * Run the validate phase: normalize each pending row's type, pre-check its
 * numeric fields, hash it, and mark it validated / error.
 *
 * @param {{ batchId: PortfolioImportBatchId, onProgress?: PortfolioImportProgressCallback }} args
 * @returns {Promise<{ validated: number, duplicates: number, errors: number }>}
 */
export async function validateBatch({ batchId, onProgress }) {
  await query(
    `UPDATE portfolio_import_batches SET status = 'validating' WHERE id = $1`,
    [batchId],
  );

  const { rows: batchRows } = await query(
    `SELECT b.default_asset_class, b.default_type, b.custom_config, b.is_brokerage,
            b.adapter_name, a.import_identity::text AS account_import_identity
       FROM portfolio_import_batches b
       LEFT JOIN accounts a ON a.id = b.account_id
      WHERE b.id = $1`,
    [batchId],
  );
  const batch = batchRows[0] || {};
  const defaultAssetClass = batch.default_asset_class || undefined;
  const defaultType = batch.default_type || undefined;
  const isBrokerage = batch.is_brokerage === true;
  const config =
    typeof batch.custom_config === "string"
      ? JSON.parse(batch.custom_config)
      : batch.custom_config || {};
  const typeMapping = config.type_mapping || {};
  const unitBased = defaultAssetClass
    ? UNIT_BASED_ASSET_CLASSES.has(defaultAssetClass)
    : false;

  const { rows: allRows } = await query(
    `SELECT id, row_index, status, tx_date, type_raw, symbol_raw, name_raw, units,
            price_per_unit, amount, fees, taxes, currency, note, raw_data,
            source_transaction_id, source_account_identity
       FROM portfolio_import_staging_rows
      WHERE batch_id = $1
      ORDER BY row_index ASC`,
    [batchId],
  );

  // App-timezone calendar day (ADR-009), computed once — used to reject
  // future-dated rows below.
  const today = todayAppDateString();

  const pending = allRows.filter(
    (row) => row.status == null || row.status === "pending",
  );
  const total = pending.length;
  let seen = 0;
  let errors = 0;
  const duplicates = 0;

  const resolutions = allRows.map((row) =>
    resolveAndCheck(row, {
      typeMapping,
      defaultType,
      unitBased,
      isBrokerage,
      today,
    }),
  );
  const identities = assignImportIdentities(
    allRows.map((row, index) => ({ ...row, ...resolutions[index] })),
    (row) =>
      portfolioIdentityBase(row, {
        adapterName: batch.adapter_name || "portfolio_generic",
        accountIdentity: batch.account_import_identity || "UNASSIGNED",
      }),
  );
  const resolutionById = new Map(
    allRows.map((row, index) => [String(row.id), resolutions[index]]),
  );
  const identityById = new Map(
    allRows.map((row, index) => [String(row.id), identities[index]]),
  );

  if (onProgress) onProgress({ phase: "validating", current: 0, total });

  for (let start = 0; start < total; start += VALIDATE_CHUNK) {
    const chunk = pending.slice(start, start + VALIDATE_CHUNK);
    /** @type {string[]} */
    const ids = [];
    /** @type {string[]} */
    const statuses = [];
    /** @type {(string|null|undefined)[]} */
    const types = [];
    /** @type {(string|null|undefined)[]} */
    const routes = [];
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
      const row = /** @type {PendingPortfolioStagingRow} */ (chunk[chunkIndex]);
      const identity = identityById.get(String(row.id));
      ids.push(row.id);
      const { type, route, error } = resolutionById.get(String(row.id));
      if (error) {
        errors++;
        statuses.push("error");
        types.push(null);
        routes.push(null);
        txHashes.push(null);
        sourceRecordHashes.push(identity.sourceRecordHash);
        fingerprintVersions.push(null);
        occurrences.push(null);
        errorMessages.push(error);
        continue;
      }
      statuses.push("validated");
      types.push(type);
      routes.push(route);
      txHashes.push(identity.fingerprint);
      sourceRecordHashes.push(identity.sourceRecordHash);
      fingerprintVersions.push(identity.version);
      occurrences.push(identity.occurrence);
      errorMessages.push(null);
    }

    await query(
      `UPDATE portfolio_import_staging_rows s
          SET status        = v.status,
              type          = v.type::portfolio_txn_type,
              route         = v.route,
              tx_hash       = v.tx_hash,
              source_record_hash = v.source_record_hash,
              dedup_fingerprint = v.tx_hash,
              dedup_fingerprint_version = v.fingerprint_version,
              dedup_occurrence = v.occurrence,
              error_message = v.error_message
         FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::smallint[], $8::integer[], $9::text[])
              AS v(id, status, type, route, tx_hash, source_record_hash, fingerprint_version, occurrence, error_message)
        WHERE s.id = v.id`,
      [
        ids,
        statuses,
        types,
        routes,
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

  if (errors > 0) {
    await query(
      `UPDATE portfolio_import_batches SET rows_error = COALESCE(rows_error, 0) + $2 WHERE id = $1`,
      [batchId, errors],
    );
  }

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  const validated = total - errors - duplicates;
  logger.info("[portfolio-pipeline:validate] done", {
    batchId,
    total,
    validated,
    duplicates,
    errors,
  });
  return { validated, duplicates, errors };
}

/**
 * Resolve one staging row's canonical type and brokerage route, or report why
 * it cannot be committed.
 *
 * @param {PendingPortfolioStagingRow} row
 * @param {{ typeMapping: Record<string, string>, defaultType: string|undefined, unitBased: boolean, isBrokerage: boolean, today: string }} options
 * @returns {{ type?: string, route?: string, error?: string }} exactly one of `type`/`error` is meaningful
 */
function resolveAndCheck(
  row,
  { typeMapping, defaultType, unitBased, isBrokerage, today },
) {
  if (!row.tx_date) return { error: "missing date" };

  // Reject future-dated rows: a typo'd year (e.g. 2035) or a broker export with a
  // trade-settlement date ahead of today would otherwise pass validation and
  // commit a transaction dated in the future, skewing every time-based portfolio
  // calc. tx_date is a pg DATE (local-midnight Date) — format with local getters
  // (toYmd), never UTC, then compare against the app-timezone calendar day.
  if (today) {
    const rowYmd = toYmd(row.tx_date);
    if (rowYmd && rowYmd > today)
      return { error: "transaction date is in the future" };
  }

  // Try the portfolio type first (handles aliases + the user's type_mapping).
  // Brokerage dividend/interest/fee/tax rows resolve here and route 'portfolio'
  // when they name an instrument; instrument-less ones route 'cash' below (D6,
  // ADR-095 addendum). External cash (deposit/withdrawal) never normalizes as a
  // portfolio type and takes the cash route in the error branch.
  const { type, error } = normalizeType(row.type_raw, {
    typeMapping,
    defaultType,
  });
  if (error) {
    if (isBrokerage) {
      const { target } = classifyBrokerageRow({ kind: row.type_raw });
      if (target === "cash") {
        if (row.amount == null) return { error: "cash row requires an amount" };
        return { type: undefined, route: "cash" };
      }
    }
    return { error };
  }

  const hasUnits = row.units != null;
  const hasPrice = row.price_per_unit != null;
  const hasAmount = row.amount != null;

  if ((type === "buy" || type === "sell") && unitBased) {
    if (Number(hasUnits) + Number(hasPrice) + Number(hasAmount) < 2) {
      return { error: "provide at least two of units, price, amount" };
    }
  } else if (type === "gift") {
    if (!hasUnits) return { error: "gift requires units" };
  } else if (!hasAmount) {
    return { error: "missing amount" };
  }

  if (isBrokerage && type) {
    // D6 (ADR-095 addendum): an instrument-less dividend/interest/fee/tax row
    // is a cash movement — one signed transactions row on the sleeve — instead
    // of a portfolio row that can only ever error "unresolved instrument" at
    // commit. Deterministic from the row itself: no symbol AND no name means
    // there is nothing the matcher (or the user) could ever attach it to. A
    // row that names an instrument keeps the portfolio route, where an
    // unresolved match is a correct signal for user review. The row's
    // canonical `type` is persisted alongside route='cash' so commit derives
    // the ledger sign and the auto-category from the kind.
    const hasInstrument = Boolean(
      String(row.symbol_raw || "").trim() || String(row.name_raw || "").trim(),
    );
    const { target } = classifyBrokerageRow({ kind: type, hasInstrument });
    if (target === "cash") return { type, route: "cash" };
  }

  return { type, route: isBrokerage ? "portfolio" : undefined };
}
