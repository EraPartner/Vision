/** Complete primary-source binding for the bounded Kinesis adoption scope. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { toDecimal } from "../lib/money.ts";
import { parsedDateToYmd } from "../lib/importDates.ts";
import {
  portfolioPrimaryRawData,
  verifiedPortfolioPerformanceBasisReference,
  portfolioReferenceStagingBinding,
} from "./portfolioPerformanceReferenceEvidence.js";
import { reparseKinesisSourceEvents } from "./portfolioImportPipeline/kinesisTransactionHistoryAdapter.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "./importIdentity.js";

/**
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationSourceRow} KinesisSourceRow
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationBatchScopeRow} KinesisBatchRow
 * @typedef {import('./portfolioImportPipeline/portfolioGenericAdapter.ts').ParsedPortfolioRow} ParsedPortfolioRow
 */
/**
 * One captured statement event (see captureKinesisSourceContext).
 * @typedef {object} KinesisSourceEvent
 * @property {string} rawHash
 * @property {string|null} sourceId
 * @property {string|null} sourceAccountIdentity
 * @property {number} occurrence
 * @property {string} eventKey
 */
/**
 * `custom_config.kinesis_source_context` as captured at stage time.
 * @typedef {object} KinesisSourceContext
 * @property {number} version
 * @property {number} skipped
 * @property {string} source_file_hash
 * @property {string[]|undefined} source_columns
 * @property {KinesisSourceEvent[]} events
 */
/**
 * @typedef {object} KinesisSourceProof
 * @property {string} eventKey
 * @property {string} sourceFileHash
 * @property {ParsedPortfolioRow} parsed
 */
/**
 * @typedef {object} KinesisSourceIssue
 * @property {number} batchId
 * @property {number} rowId
 * @property {number} rowOrdinal
 * @property {string} reason
 * @property {number[]} candidateTransactionIds
 */
/**
 * @typedef {object} KinesisSourceEvidence
 * @property {Map<number, KinesisSourceProof>} proofs
 * @property {Map<number, KinesisSourceProof>} literalProofs
 * @property {KinesisSourceIssue[]} issues
 */

/** @param {string|Buffer} value */
const hash = (value) => createHash("sha256").update(value).digest("hex");
/**
 * Batch config is JSONB whose adapter-specific shape is read dynamically.
 * @param {unknown} value
 * @returns {any}
 */
const configOf = (value) =>
  typeof value === "string" ? JSON.parse(value) : value || {};
/**
 * @param {string} rawHash
 * @param {string|null|undefined} sourceId
 * @param {string|null|undefined} account
 */
const tuple = (rawHash, sourceId, account) => [
  rawHash,
  sourceId ?? null,
  account ?? null,
];

/** Capture before any symbol or reconciliation selection.
 * @param {string} path
 * @param {import('./portfolioImportPipeline/portfolioGenericAdapter.ts').ParsedPortfolioRows} rows
 */
export async function captureKinesisSourceContext(path, rows) {
  const occurrences = new Map();
  return {
    version: 1,
    skipped: rows.skipped ?? 0,
    source_file_hash: hash(await readFile(path)),
    source_columns: rows.sourceColumns,
    events: rows.map((row) => {
      const identity = tuple(
        hash(row.rawData),
        row.sourceId,
        row.sourceAccountIdentity,
      );
      const base = JSON.stringify(identity);
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      return {
        rawHash: identity[0],
        sourceId: identity[1],
        sourceAccountIdentity: identity[2],
        occurrence,
        eventKey: hash(JSON.stringify([...identity, occurrence])),
      };
    }),
  };
}

/** Validate the entire staged source before selecting existing adoptions.
 * @param {KinesisSourceRow[]} rows
 * @param {KinesisBatchRow[]} batches
 * @param {{ recordedBasis?: boolean }} [options]
 * @returns {KinesisSourceEvidence}
 */
export function proveKinesisAdoptionSources(
  rows,
  batches,
  { recordedBasis = false } = {},
) {
  /** @type {Map<number, KinesisSourceProof>} */
  const proofs = new Map();
  /** @type {Map<number, KinesisSourceProof>} */
  const literalProofs = new Map();
  /** @type {KinesisSourceIssue[]} */
  const issues = [];
  for (const batch of batches) {
    const scoped = rows
      .filter((row) => Number(row.batch_id) === Number(batch.id))
      .sort((a, b) => a.row_index - b.row_index);
    try {
      const config = configOf(batch.custom_config);
      /** @type {KinesisSourceContext|undefined} */
      const context = config.kinesis_source_context;
      const reference = config.portfolio_performance_reference;
      if (
        recordedBasis &&
        reference &&
        portfolioReferenceStagingBinding(
          rows.filter((row) =>
            reference.effectiveBatchIds.includes(Number(row.batch_id)),
          ),
        ) !== reference.stagingBinding
      )
        throw new Error("reference source binding");
      if (
        config.format !== "kinesis_transaction_history" ||
        config.included_symbols?.length ||
        Number(config.scope_excluded_rows || 0) > 0 ||
        context?.version !== 1 ||
        context.skipped !== 0 ||
        !/^[a-f0-9]{64}$/.test(context.source_file_hash || "") ||
        !Array.isArray(context.events) ||
        context.events.length !== scoped.length ||
        scoped.length !== Number(batch.rows_total) ||
        JSON.stringify(context.source_columns) !==
          JSON.stringify(config.source_columns)
      )
        throw new Error("source scope");
      const accounts = new Set(
        context.events.map((event) => event.sourceAccountIdentity),
      );
      if (accounts.size !== 1 || ![...accounts][0] || batch.account_id == null)
        throw new Error("source account");
      const occurrences = new Map();
      for (const [index, row] of scoped.entries()) {
        const raw = portfolioPrimaryRawData(row.raw_data);
        const expected = context.events[index];
        const identity = tuple(
          hash(raw),
          row.source_transaction_id,
          row.source_account_identity,
        );
        const base = JSON.stringify(identity);
        const occurrence = (occurrences.get(base) ?? 0) + 1;
        occurrences.set(base, occurrence);
        if (
          row.row_index !== index ||
          identity[0] !== row.source_record_hash ||
          expected.rawHash !== identity[0] ||
          expected.sourceId !== identity[1] ||
          expected.sourceAccountIdentity !== identity[2] ||
          expected.occurrence !== occurrence ||
          expected.eventKey !==
            hash(JSON.stringify([...identity, occurrence])) ||
          !row.source_transaction_id ||
          /^0+(?::(?:income|units))?$/.test(row.source_transaction_id) ||
          row.account_id !== batch.account_id
        )
          throw new Error("source event");
      }
      const parsed = reparseKinesisSourceEvents(
        scoped.map((row) => portfolioPrimaryRawData(row.raw_data)),
        {
          sourceColumns: context.source_columns,
          yield_basis_policy: config.yield_basis_policy,
        },
      );
      if (!parsed) throw new Error("literal source");
      for (const [index, row] of scoped.entries()) {
        const matches = parsed.filter(
          (item) =>
            item.sourceId === row.source_transaction_id &&
            item.sourceAccountIdentity === row.source_account_identity &&
            item.rawData === portfolioPrimaryRawData(row.raw_data),
        );
        if (matches.length !== 1) throw new Error("literal identity");
        const item = matches[0];
        if (
          parsedDateToYmd(item.date) !== row.tx_date ||
          (item.symbolRaw || null) !== (row.symbol_raw || null)
        )
          throw new Error("literal binding");
        literalProofs.set(Number(row.id), {
          eventKey: context.events[index].eventKey,
          sourceFileHash: context.source_file_hash,
          parsed: item,
        });
        const basis = recordedBasis
          ? verifiedPortfolioPerformanceBasisReference(row)
          : undefined;
        if (
          recordedBasis &&
          reference &&
          item.typeRaw === "Gift" &&
          item.currency &&
          item.currency !== row.currency
        )
          throw new Error("literal currency conflict");
        const secondaryCurrency =
          basis?.meaningful &&
          basis.basisPolicy === "recorded_native" &&
          Number(basis.accountId) === Number(row.account_id) &&
          basis.sourceHash ===
            config.portfolio_performance_reference?.sourceHash &&
          item.typeRaw === "Gift" &&
          !item.currency;
        const identity = assignImportIdentities([row], (source) =>
          portfolioIdentityBase(
            secondaryCurrency ? { ...source, currency: item.currency } : source,
            { accountIdentity: "UNASSIGNED" },
          ),
        )[0];
        const eligible =
          ["Buy", "Gift"].includes(item.typeRaw) &&
          row.route === "portfolio" &&
          row.type === item.typeRaw.toLowerCase() &&
          row.type_raw === item.typeRaw &&
          ((item.currency || null) === (row.currency || null) ||
            secondaryCurrency) &&
          item.units != null &&
          row.units != null &&
          toDecimal(item.units).toDecimalPlaces(8, 4).eq(row.units) &&
          row.dedup_fingerprint === identity.fingerprint &&
          row.dedup_fingerprint_version === identity.version &&
          Number(row.dedup_occurrence) === identity.occurrence;
        if (eligible)
          proofs.set(Number(row.id), {
            eventKey: context.events[index].eventKey,
            sourceFileHash: context.source_file_hash,
            parsed: item,
          });
      }
    } catch {
      issues.push({
        batchId: Number(batch.id),
        rowId: Number(scoped[0]?.id || 0),
        rowOrdinal: Number(scoped[0]?.row_index || 0) + 1,
        reason: "adoption_scope_source_unverified",
        candidateTransactionIds: [],
      });
    }
  }
  return { proofs, literalProofs, issues };
}

/** Original primary identity remains separate from verified native-basis enrichment.
 * @param {KinesisSourceRow[]} rows
 * @param {KinesisBatchRow[]} batches
 */
export function proveKinesisCorrectionSources(rows, batches) {
  return proveKinesisAdoptionSources(rows, batches, { recordedBasis: true });
}
