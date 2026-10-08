/** Complete primary-source binding for the bounded Kinesis adoption scope. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { toDecimal } from "../lib/money.ts";
import { parsedDateToYmd } from "../lib/importDates.ts";
import {
  portfolioPrimaryRawData,
  verifiedPortfolioPerformanceBasisReference,
  portfolioReferenceStagingBinding,
  requiredStagedValue,
} from "./portfolioPerformanceReferenceEvidence.ts";
import { reparseKinesisSourceEvents } from "./portfolioImportPipeline/kinesisTransactionHistoryAdapter.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "./importIdentity.ts";
import type {
  ReconciliationBatchScopeRow,
  ReconciliationSourceRow,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import type {
  ParsedPortfolioRow,
  ParsedPortfolioRows,
} from "./portfolioImportPipeline/portfolioGenericAdapter.ts";

export type KinesisSourceRow = ReconciliationSourceRow;
export type KinesisBatchRow = ReconciliationBatchScopeRow;
export type { ParsedPortfolioRow };
/** One captured statement event (see captureKinesisSourceContext). */
export interface KinesisSourceEvent {
  rawHash: string;
  sourceId: string | null;
  sourceAccountIdentity: string | null;
  occurrence: number;
  eventKey: string;
}
/** `custom_config.kinesis_source_context` as captured at stage time. */
export interface KinesisSourceContext {
  version: number;
  skipped: number;
  source_file_hash: string;
  source_columns: string[] | undefined;
  events: KinesisSourceEvent[];
}
/** `custom_config.portfolio_performance_reference` fields read here. */
interface KinesisReferenceConfig {
  effectiveBatchIds: number[];
  stagingBinding: string;
  sourceHash?: string;
}
/** The adapter-specific `custom_config` fields the Kinesis scope reads. */
interface KinesisBatchConfig {
  format?: string;
  included_symbols?: string[];
  scope_excluded_rows?: number | string;
  source_columns?: string[];
  yield_basis_policy?: "zero";
  kinesis_source_context?: KinesisSourceContext;
  portfolio_performance_reference?: KinesisReferenceConfig;
}
export interface KinesisSourceProof {
  eventKey: string;
  sourceFileHash: string;
  parsed: ParsedPortfolioRow;
}
export interface KinesisSourceIssue {
  batchId: number;
  rowId: number;
  rowOrdinal: number;
  reason: string;
  candidateTransactionIds: number[];
}
export interface KinesisSourceEvidence {
  proofs: Map<number, KinesisSourceProof>;
  literalProofs: Map<number, KinesisSourceProof>;
  issues: KinesisSourceIssue[];
}

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
/** Batch config is JSONB whose adapter-specific shape is read dynamically. */
const configOf = (value: unknown): KinesisBatchConfig =>
  typeof value === "string"
    ? (JSON.parse(value) as KinesisBatchConfig)
    : (value as KinesisBatchConfig | null) || {};
const tuple = (
  rawHash: string,
  sourceId: string | null | undefined,
  account: string | null | undefined,
): [string, string | null, string | null] => [
  rawHash,
  sourceId ?? null,
  account ?? null,
];

/** Capture before any symbol or reconciliation selection. */
export async function captureKinesisSourceContext(
  path: string,
  rows: ParsedPortfolioRows,
): Promise<KinesisSourceContext> {
  const occurrences = new Map<string, number>();
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

/** Validate the entire staged source before selecting existing adoptions. */
export function proveKinesisAdoptionSources(
  rows: KinesisSourceRow[],
  batches: KinesisBatchRow[],
  { recordedBasis = false }: { recordedBasis?: boolean } = {},
): KinesisSourceEvidence {
  const proofs = new Map<number, KinesisSourceProof>();
  const literalProofs = new Map<number, KinesisSourceProof>();
  const issues: KinesisSourceIssue[] = [];
  for (const batch of batches) {
    const scoped = rows
      .filter((row) => Number(row.batch_id) === Number(batch.id))
      .sort((a, b) => a.row_index - b.row_index);
    try {
      const config = configOf(batch.custom_config);
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
      const occurrences = new Map<string, number>();
      for (const [index, row] of scoped.entries()) {
        const raw = portfolioPrimaryRawData(requiredStagedValue(row.raw_data));
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
        scoped.map((row) =>
          portfolioPrimaryRawData(requiredStagedValue(row.raw_data)),
        ),
        {
          // A missing column list fails the adapter's column check either way.
          sourceColumns: context.source_columns ?? [],
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
        const identity = assignImportIdentities(
          [row],
          (source: KinesisSourceRow) =>
            portfolioIdentityBase(
              secondaryCurrency
                ? { ...source, currency: item.currency }
                : source,
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

/** Original primary identity remains separate from verified native-basis enrichment. */
export function proveKinesisCorrectionSources(
  rows: KinesisSourceRow[],
  batches: KinesisBatchRow[],
): KinesisSourceEvidence {
  return proveKinesisAdoptionSources(rows, batches, { recordedBasis: true });
}
