/** One-to-one, reviewable adoption of existing portfolio history. */
import { createHash } from "node:crypto";
import { partitionOversellDeficits } from "@vision/shared-utils/portfolio";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";
import { withTransaction } from "../database/connection.ts";
import { toDecimal } from "../lib/money.ts";
import { normalizeTransactionPayload } from "./portfolio/portfolioTransactionRules.ts";
import {
  getStoredRateToEurOnOrBefore,
  getUnindexedRatesToEurForDates,
} from "./currency/rateFetcher.ts";
import {
  getNexoProSpotReconciliationEvidence,
  nexoProSourceMoneyMatches,
} from "./portfolioImportPipeline/nexoProTransactionHistoryAdapter.ts";
import {
  getSaxoCsvCompanionEvidence,
  getSaxoWorkbookReconciliationEvidence,
} from "./portfolioImportPipeline/saxoTransactionHistoryAdapter.ts";
import {
  portfolioPrimaryRawData,
  verifiedPortfolioPerformanceBasisReference,
  portfolioPerformanceBasisIdentifiesLegacy,
  portfolioPerformanceReferenceIdentifiesLegacy,
  portfolioPerformanceRoundedDepositIdentifiesLegacy,
  plausibleRoundedKinesisDepositLegacy,
  verifiedPortfolioPerformanceCustodyAnnotation,
  portfolioReferenceStagingBinding,
  zeroYieldIdentifiesLegacy,
} from "./portfolioPerformanceReferenceEvidence.js";
import {
  previewPortfolioAssetTransfer,
  validatePortfolioAssetTransferHistory,
} from "./portfolio/portfolioAssetTransferService.ts";
import { previewPortfolioAssetAdjustment } from "./portfolio/portfolioAssetAdjustmentService.ts";
import { getEligibleYieldSourceHashes } from "../repositories/portfolioAssetAdjustmentRepository.ts";
import {
  compareAndSetReconciledTransaction,
  getActiveAdoptionReceipts,
  insertReconciliationReceipt,
  markAdoptedSourceDuplicate,
  markSaxoCompanionSourceDuplicate,
  readReconciliationBatchScope,
  readReconciliationHistory,
  readReconciliationSources,
  readReconciledProImportAccounts,
  readSaxoAdoptionContext,
  readKinesisAdoptionContext,
  readKinesisNetworkContext,
  readKinesisNativeGiftContext,
  retainKinesisNetworkBinding,
  retainKinesisNativeGiftReceipt,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import {
  readDuplicateRepairContext,
  getActiveDuplicateRepairReceipts,
} from "../repositories/portfolioImportDuplicateRepairRepository.ts";
import {
  applyDuplicatePortfolioRepair,
  financialRepairImage,
  validateDuplicatePortfolioRepairRollback,
} from "./portfolioImportDuplicateRepairService.js";
import { narrowImportedIbkrRepairCandidates } from "./portfolioIbkrRepairCandidates.js";
import { ibkrPrimaryEvidenceIdentifiesLegacy } from "./portfolioIbkrPrimaryProof.js";
import {
  proveKinesisAdoptionSources,
  proveKinesisCorrectionSources,
} from "./portfolioKinesisAdoptionScope.js";
import { proveRetainedKinesisYieldGroups } from "./portfolioKinesisYieldGroups.js";
import {
  proveKinesisIncomePairs,
  normalizeIncomeSnapshot,
} from "./portfolioKinesisIncomePairs.js";
import {
  readKinesisIncomeUnitContext,
  readIncomeRecognitionContext,
  recordPairedPortfolioIncome,
} from "../repositories/portfolioIncomeRecognitionRepository.ts";

import {
  classifyKinesisCash,
  proveKinesisCashSources,
} from "./portfolioKinesisCashScope.js";
import { readKinesisCashContext } from "../repositories/portfolioImportCashRepository.ts";
import { recordKinesisCash } from "./portfolioImportCashService.js";
import { proveKinesisFullYieldCandidates } from "./portfolioKinesisFullImport.js";
import {
  proveKinesisNetworkBindings,
  verifiedKinesisNetworkRow,
  proveKinesisNativeGiftGroups,
} from "./portfolioKinesisNetworkProof.js";

/**
 * @typedef {import("../repositories/portfolioImportReconciliationRepository.ts").ReconciliationSourceRow} ReconciliationSourceRow
 * @typedef {import("../repositories/portfolioImportReconciliationRepository.ts").ReconciliationBatchScopeRow} ReconciliationBatchScopeRow
 * @typedef {import("../repositories/portfolioImportReconciliationRepository.ts").ReconciliationJournalRow} ReconciliationJournalRow
 * @typedef {import("../repositories/portfolioImportReconciliationRepository.ts").ReconciliationContext} ReconciliationContext
 * @typedef {import("../repositories/portfolioImportReconciliationRepository.ts").ReconciliationReceiptContext} ReconciliationReceiptContext
 * @typedef {import("../repositories/portfolioImportReconciliationRepository.ts").ReconciliationHistoryEvent} ReconciliationHistoryEvent
 * @typedef {import("../repositories/portfolioImportReconciliationRepository.ts").PortfolioTransactionSnapshot} PortfolioTransactionSnapshot
 * @typedef {import("../lib/money.ts").DecimalInput} DecimalInput
 * @typedef {import("./portfolioImportPipeline/portfolioGenericAdapter.ts").ParsedPortfolioRow} ParsedPortfolioRow
 * @typedef {import("./portfolioKinesisAdoptionScope.js").KinesisSourceProof} KinesisSourceProof
 */
/**
 * One reconciliation history event read by column name. Custody events
 * (asset transfers and adjustments) share the transaction columns compared
 * here and add their own custody columns.
 * @typedef {PortfolioTransactionSnapshot & {
 *   source_account_id?: number,
 *   destination_account_id?: number,
 *   fee_units?: string,
 *   adjustment_kind?: string,
 *   basis_policy?: string,
 * }} HistoryImage
 */
/**
 * normalizedSource's output: the staged values as exact NUMERIC text.
 * @typedef {Record<string, string | null>} NormalizedSource
 */
/**
 * @typedef {import("./portfolioKinesisCashScope.js").KinesisCashContext} CashContext
 * @typedef {import("./portfolioKinesisIncomePairs.js").IncomeRecognitionContext} IncomeContext
 */
/**
 * A stored EUR rate for one currency on one source date (null when absent).
 * @typedef {{ currency: string, date: string, rate: string | null }} HistoricalFxRate
 */
/**
 * A plan blocker. Retained yield-group evidence issues may name no row.
 * @typedef {object} PlanIssue
 * @property {number} [batchId]
 * @property {number} [rowId]
 * @property {number} [rowOrdinal]
 * @property {string} reason
 * @property {number[]} candidateTransactionIds
 */
/**
 * One planned row outcome. `action` selects which optional fields are set.
 * @typedef {object} PlanAction
 * @property {number} batchId
 * @property {number} rowId
 * @property {number} rowOrdinal
 * @property {string} action
 * @property {string} [reason]
 * @property {number[]} [candidateTransactionIds]
 * @property {number} [investmentId]
 * @property {Record<string, unknown>} [source]
 * @property {Record<string, unknown>} [existing]
 * @property {number} [existingTransactionId]
 * @property {number} [duplicateOfRowId]
 * @property {string[]} [corrections]
 * @property {boolean} [economicsProven]
 * @property {string | null} [policy]
 * @property {object} [incomeProof]
 * @property {unknown} [cashProof]
 * @property {{ date: string, units: string, feeUnits: string, receivedUnits: string, sourceAccountId: number, destinationAccountId: number }} [transfer]
 * @property {{ date: string, units: string, kind: string, basisPolicy: string, accountId: number }} [adjustment]
 */
/**
 * @typedef {object} PlanAdoption
 * @property {ReconciliationSourceRow} row
 * @property {PortfolioTransactionSnapshot} before
 * @property {PortfolioTransactionSnapshot} after
 * @property {ReconciliationJournalRow["policy"]} policy
 * @property {PortfolioTransactionSnapshot} [imported]
 * @property {ReconciliationJournalRow} [priorSaxoReceipt]
 */
/**
 * @typedef {{ batchId: number, adoptPolicy: string }} BatchPolicy
 */
/**
 * @typedef {object} ReconciliationPlan
 * @property {number[]} batchIds
 * @property {string | null} adoptPolicy
 * @property {BatchPolicy[]} batchPolicies
 * @property {string} planFingerprint
 * @property {boolean} ready
 * @property {PlanAction[]} actions
 * @property {PlanIssue[]} blockers
 * @property {Record<string, number>} summary
 * @property {string} [reconciliationScope]
 * @property {number[]} [selectedRowIds]
 * @property {number} [pending]
 * @property {boolean} [complete]
 * @property {Record<string, number>} [deferredCounts]
 * @property {Array<{ batchId: number, pending: number, complete: boolean, deferredCounts: Record<string, number> }>} [batchProgress]
 */
/**
 * @typedef {{ proof: unknown, members: ReconciliationSourceRow[] }} NativeGiftGroup
 */
/**
 * @typedef {object} ReconciliationPlanResult
 * @property {ReconciliationPlan} plan
 * @property {PlanAdoption[]} adoptions
 * @property {Array<{ row: ReconciliationSourceRow, primary: ReconciliationSourceRow }>} companions
 * @property {Map<number, ReconciliationSourceRow>} sourceOverrides
 * @property {Array<Parameters<typeof retainKinesisNetworkBinding>[0]>} networkBindings
 * @property {NativeGiftGroup[]} nativeGiftGroups
 * @property {ReturnType<typeof proveKinesisIncomePairs>["records"]} [incomeRecords]
 * @property {ReturnType<typeof classifyKinesisCash>["records"]} [cashRecords]
 */
/**
 * The binding a bounded plan records for one selected row.
 * @typedef {Pick<KinesisSourceProof, "eventKey" | "sourceFileHash">} RowProofBinding
 */

const POLICIES = new Set(["preserve_existing", "prefer_source"]);
const UNIT_TYPES = new Set(["buy", "sell", "gift", "split"]);
const VALUE_FIELDS = /** @type {const} */ ([
  "date",
  "amount",
  "units",
  "price_per_unit",
  "fees",
  "taxes",
  "currency",
  "fx_rate_to_eur",
  "dividend_amount_convention",
]);
/** @type {Record<string, number>} */
const PLACES = {
  amount: 4,
  units: 8,
  price_per_unit: 6,
  fees: 4,
  taxes: 4,
  fx_rate_to_eur: 10,
};

function equalNumber(left, right, places) {
  if (left == null || right == null) return left == null && right == null;
  return toDecimal(left)
    .toDecimalPlaces(places)
    .eq(toDecimal(right).toDecimalPlaces(places));
}

function sameValue(field, left, right) {
  if (field === "dividend_amount_convention")
    return (left ?? "unknown") === (right ?? "unknown");
  return field in PLACES
    ? equalNumber(left, right, PLACES[field])
    : left === right;
}

function dayDistance(left, right) {
  return (
    Math.abs(
      Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`),
    ) / 86400000
  );
}

function formatOf(row) {
  let config = row.custom_config;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      return undefined;
    }
  }
  return config?.format;
}

/** @returns {NormalizedSource} */
function normalizedSource(row) {
  const payload = normalizeTransactionPayload(
    {
      type: row.type,
      date: row.tx_date,
      amount: row.amount ?? undefined,
      units: row.units ?? undefined,
      price_per_unit: row.price_per_unit ?? undefined,
      fees: row.fees ?? 0,
      taxes: row.taxes ?? 0,
      fx_rate_to_eur: row.fx_rate_to_eur ?? undefined,
    },
    { assetClass: row.asset_class },
  );
  return {
    type: row.type,
    date: row.tx_date,
    amount: payload.amount == null ? null : String(payload.amount),
    units: payload.units == null ? null : String(payload.units),
    price_per_unit:
      payload.price_per_unit == null ? null : String(payload.price_per_unit),
    fees: String(payload.fees ?? 0),
    taxes: String(payload.taxes ?? 0),
    currency: row.currency || row.investment_currency || "EUR",
    fx_rate_to_eur:
      payload.fx_rate_to_eur == null ? null : String(payload.fx_rate_to_eur),
    dividend_amount_convention:
      row.type === "dividend" &&
      ["saxo_transaction_history", "ibkr_transaction_history"].includes(
        formatOf(row),
      )
        ? "gross"
        : payload.dividend_amount_convention,
  };
}

function sourceProof(row, source) {
  if (formatOf(row) !== "nexo_pro_spot_history") return undefined;
  const proof = getNexoProSpotReconciliationEvidence(
    portfolioPrimaryRawData(row.raw_data),
  );
  if (
    !proof ||
    proof.side !== source.type ||
    proof.symbol !== row.symbol_raw ||
    proof.currency !== source.currency ||
    row.source_transaction_id !==
      `nexo-pro:spot:order:${proof.sourceOrderId}` ||
    proof.sourceTimestamp.slice(0, 10) !== source.date ||
    !equalNumber(proof.netUnits, source.units, 8) ||
    !equalNumber(proof.unitPrice, source.price_per_unit, 6) ||
    !nexoProSourceMoneyMatches(proof.amount, source.amount) ||
    !nexoProSourceMoneyMatches(proof.quoteFee, source.fees) ||
    !equalNumber("0", source.taxes, 4)
  )
    return undefined;
  return proof;
}

/**
 * @param {ReconciliationSourceRow} row
 * @param {NormalizedSource} source
 */
function saxoSourceProof(row, source) {
  if (formatOf(row) !== "saxo_transaction_history") return undefined;
  const raw = portfolioPrimaryRawData(row.raw_data);
  if (
    typeof raw !== "string" ||
    createHash("sha256").update(raw).digest("hex") !== row.source_record_hash
  )
    return undefined;
  const proof = getSaxoWorkbookReconciliationEvidence(raw);
  if (
    !proof ||
    proof.typeRaw.toLowerCase() !== source.type ||
    proof.sourceId !== row.source_transaction_id ||
    proof.sourceAccountIdentity !== row.source_account_identity ||
    proof.symbolRaw !== row.symbol_raw ||
    proof.nameRaw !== row.name_raw ||
    proof.date.toISOString().slice(0, 10) !== source.date ||
    proof.currency !== source.currency ||
    source.fx_rate_to_eur != null
  )
    return undefined;
  const values = {
    units: proof.units,
    price_per_unit: proof.pricePerUnit,
    amount: proof.amount,
    fees: proof.fees,
    taxes: proof.taxes,
  };
  // Staging NUMERIC columns use PostgreSQL half-away-from-zero rounding.
  for (const [field, value] of Object.entries(values))
    if (
      value == null || source[field] == null
        ? value != null || source[field] != null
        : !toDecimal(value)
            .toDecimalPlaces(PLACES[field], 4)
            .eq(toDecimal(source[field]))
    )
      return undefined;
  return proof;
}

/**
 * @param {DecimalInput} value
 * @param {DecimalInput} staged
 * @param {number} places
 */
function sourceCellNumberMatches(value, staged, places) {
  if (value == null || staged == null) return value == null && staged == null;
  return toDecimal(value).toDecimalPlaces(places, 4).eq(toDecimal(staged));
}

/** @param {ReconciliationSourceRow} row */
function verifiedSaxoWorkbookRow(row) {
  const raw = portfolioPrimaryRawData(row.raw_data);
  const proof = getSaxoWorkbookReconciliationEvidence(raw);
  if (!proof || fingerprintRaw(raw) !== row.source_record_hash)
    return undefined;
  if (row.route === "portfolio") {
    try {
      return saxoSourceProof(row, normalizedSource(row));
    } catch {
      return undefined;
    }
  }
  if (
    row.route !== "cash" ||
    !["Deposit", "Withdrawal"].includes(proof.typeRaw) ||
    row.type_raw !== proof.typeRaw ||
    row.tx_date !== proof.date.toISOString().slice(0, 10) ||
    row.currency !== proof.currency ||
    row.source_transaction_id !== proof.sourceId ||
    row.source_account_identity !== proof.sourceAccountIdentity ||
    (row.symbol_raw || "") !== proof.symbolRaw ||
    (row.name_raw || "") !== proof.nameRaw ||
    row.fx_rate_to_eur != null ||
    !sourceCellNumberMatches(proof.amount, row.amount, 4) ||
    !sourceCellNumberMatches(proof.units, row.units, 8) ||
    !sourceCellNumberMatches(proof.pricePerUnit, row.price_per_unit, 6) ||
    !sourceCellNumberMatches(proof.fees ?? 0, row.fees ?? 0, 4) ||
    !sourceCellNumberMatches(proof.taxes ?? 0, row.taxes ?? 0, 4)
  )
    return undefined;
  return proof;
}

/**
 * @param {unknown} raw
 * @returns {string | undefined}
 */
function fingerprintRaw(raw) {
  return typeof raw === "string"
    ? createHash("sha256").update(raw).digest("hex")
    : undefined;
}

/**
 * Staging columns that hold one CSV cell's NUMERIC value.
 * @typedef {"units" | "price_per_unit" | "amount" | "fees" | "taxes" | "fx_rate_to_eur"} StagedNumberColumn
 */
/**
 * @param {ReconciliationSourceRow} row
 * @param {{ csv: ParsedPortfolioRow }} proof
 */
function saxoCsvStagingMatches(row, proof) {
  const csv = proof.csv;
  const unsupportedDividend =
    csv.typeRaw === "Unsupported Saxo event: Cashdividend";
  if (
    row.type_raw !== csv.typeRaw ||
    row.tx_date !== csv.date?.toISOString().slice(0, 10) ||
    row.source_transaction_id !== csv.sourceId ||
    row.source_account_identity !== csv.sourceAccountIdentity ||
    (row.symbol_raw || "") !== csv.symbolRaw ||
    (row.name_raw || "") !== csv.nameRaw ||
    row.currency !== csv.currency ||
    row.committed_txn_id != null ||
    (unsupportedDividend
      ? row.status !== "error" ||
        row.type != null ||
        row.route != null ||
        row.error_message !==
          'unknown transaction type "Unsupported Saxo event: Cashdividend"'
      : row.status !== "matched" ||
        (["Deposit", "Withdrawal"].includes(csv.typeRaw)
          ? row.route !== "cash" || row.type != null
          : row.route !== "portfolio" ||
            row.type !== csv.typeRaw.toLowerCase()))
  )
    return false;
  return Object.entries({
    units: csv.units,
    price_per_unit: csv.pricePerUnit,
    amount: csv.amount,
    fees: csv.fees,
    taxes: csv.taxes,
    fx_rate_to_eur: csv.fxRateToEur,
  }).every(
    (/** @type {[StagedNumberColumn, number | null]} */ [field, value]) =>
      sourceCellNumberMatches(value, row[field], PLACES[field]),
  );
}

/**
 * @param {Record<string, unknown> | undefined} left
 * @param {Record<string, unknown> | undefined} right
 */
function sameSnapshot(left, right) {
  if (!left || !right) return false;
  left = normalizeIncomeSnapshot(left);
  right = normalizeIncomeSnapshot(right);
  const keys = Object.keys(left).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(right).sort()) &&
    keys.every((key) => left[key] === right[key])
  );
}

/**
 * @param {PortfolioTransactionSnapshot} current
 * @param {NormalizedSource} source
 * @param {ReconciliationSourceRow} row
 * @returns {PortfolioTransactionSnapshot}
 */
function sourcePreferredImage(current, source, row) {
  const after = {
    ...current,
    account_id: row.account_id,
    source_record_hash: row.source_record_hash,
    dedup_fingerprint: row.dedup_fingerprint,
    dedup_fingerprint_version: row.dedup_fingerprint_version,
  };
  for (const field of VALUE_FIELDS) {
    if (
      field === "fx_rate_to_eur" &&
      source[field] == null &&
      source.currency === current.currency
    )
      continue;
    after[field] = source[field];
  }
  return after;
}

/**
 * @param {ReconciliationSourceRow} row
 * @param {PortfolioTransactionSnapshot} current
 * @param {ReconciliationReceiptContext} context
 */
function priorSaxoAdoption(row, current, context) {
  const receipts = context.receipts.filter(
    (receipt) => Number(receipt.transaction_id) === Number(current.id),
  );
  if (receipts.length !== 1)
    return { error: "source_correction_provenance_missing" };
  const receipt = receipts[0];
  if (!sameSnapshot(current, receipt.after_data))
    return { error: "source_correction_existing_changed" };
  const prior = context.sources.filter(
    (source) =>
      Number(source.id) === Number(receipt.staging_row_id) &&
      Number(source.batch_id) === Number(receipt.batch_id),
  );
  const batch = context.batches.find(
    (item) => Number(item.id) === Number(receipt.batch_id),
  );
  if (
    prior.length !== 1 ||
    !["complete", "complete_with_errors"].includes(batch?.status) ||
    Number(receipt.batch_id) === Number(row.batch_id)
  )
    return { error: "source_correction_provenance_missing" };
  const original = prior[0];
  let originalProof;
  try {
    originalProof = saxoSourceProof(original, normalizedSource(original));
  } catch {
    return { error: "source_correction_source_changed" };
  }
  if (
    original.status !== "duplicate" ||
    original.route !== "portfolio" ||
    original.type !== row.type ||
    current.type !== row.type ||
    current.import_batch_id != null ||
    original.account_id !== row.account_id ||
    Number(original.investment_id) !== Number(row.investment_id) ||
    original.dedup_fingerprint !== row.dedup_fingerprint ||
    original.dedup_fingerprint_version !== row.dedup_fingerprint_version ||
    original.source_record_hash !== row.source_record_hash ||
    current.source_record_hash !== row.source_record_hash ||
    portfolioPrimaryRawData(original.raw_data) !==
      portfolioPrimaryRawData(row.raw_data) ||
    !originalProof
  )
    return { error: "source_correction_source_changed" };
  return { receipt };
}

function transferWithoutBasis(row) {
  if (verifiedPortfolioPerformanceBasisReference(row)) return false;
  return (
    row.asset_transfer_details?.direction === "in" ||
    (row.type === "gift" &&
      /original cost basis unavailable|asset transfer in/i.test(row.note || ""))
  );
}

function plausibleUnits(left, right) {
  if (left == null || right == null) return left == null && right == null;
  const relative = toDecimal(left).abs().times("0.00000001");
  const tolerance = relative.gt("0.00000001")
    ? relative
    : toDecimal("0.00000001");
  return toDecimal(left).minus(right).abs().lte(tolerance);
}

function broadCandidate(row, source, current, proof) {
  const distance = dayDistance(source.date, current.date);
  const secondaryTradeIdentity = portfolioPerformanceReferenceIdentifiesLegacy(
    row,
    current,
  );
  const boundedProDateProof =
    proof &&
    distance <= 31 &&
    source.type === current.type &&
    (equalNumber(source.units, current.units, 8) ||
      (proof.feeCurrency === proof.symbol &&
        toDecimal(proof.feeUnits).gt(0) &&
        equalNumber(proof.grossUnits, current.units, 8))) &&
    equalNumber(proof.unitPrice, current.price_per_unit, 6) &&
    equivalentEconomics(source, current, proof);
  if (
    Number(row.investment_id) !== Number(current.investment_id) ||
    (distance > 7 && !boundedProDateProof && !secondaryTradeIdentity)
  )
    return false;
  const transfer = transferWithoutBasis(row);
  if (
    source.type !== current.type &&
    !(transfer && ["buy", "gift"].includes(current.type))
  )
    return false;
  if (!UNIT_TYPES.has(source.type)) return true;
  return (
    plausibleUnits(source.units, current.units) ||
    portfolioPerformanceRoundedDepositIdentifiesLegacy(row, current) ||
    (source.price_per_unit != null &&
      current.price_per_unit != null &&
      toDecimal(source.price_per_unit).gt(0) &&
      equalNumber(source.price_per_unit, current.price_per_unit, 6) &&
      equivalentEconomics(source, current, proof)) ||
    Boolean(
      proof &&
      proof.feeCurrency === proof.symbol &&
      toDecimal(proof.feeUnits).gt(0) &&
      equalNumber(proof.grossUnits, current.units, 8),
    )
  );
}

function equivalentEconomics(source, current, proof) {
  const signed = ["sell", "dividend", "interest"].includes(source.type)
    ? toDecimal(source.amount ?? 0)
        .minus(source.fees)
        .minus(source.taxes)
    : toDecimal(source.amount ?? 0)
        .plus(source.fees)
        .plus(source.taxes);
  const sourceAmounts = [
    source.amount,
    signed.toFixed(),
    ...(proof ? [proof.grossQuoteAmount] : []),
  ];
  if (source.currency === current.currency)
    return sourceAmounts.some((amount) =>
      equalNumber(amount, current.amount, 4),
    );
  const sourceRate =
    source.currency === "EUR"
      ? "1"
      : source.fx_rate_to_eur != null
        ? source.fx_rate_to_eur
        : undefined;
  const currentEur =
    current.currency === "EUR"
      ? current.amount
      : current.fx_rate_to_eur != null
        ? toDecimal(current.amount).times(current.fx_rate_to_eur).toFixed()
        : undefined;
  return (
    sourceRate !== undefined &&
    currentEur !== undefined &&
    sourceAmounts.some((amount) =>
      equalNumber(
        toDecimal(amount ?? 0)
          .times(sourceRate)
          .toFixed(),
        currentEur,
        4,
      ),
    )
  );
}

function publicValues(snapshot) {
  return Object.fromEntries(
    ["type", ...VALUE_FIELDS].map((field) => [field, snapshot[field] ?? null]),
  );
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalBatchPolicies(batchPolicies, batches) {
  const selected = new Set(batches.map((batch) => Number(batch.id)));
  if (!Array.isArray(batchPolicies) || batchPolicies.length > selected.size)
    throw new ValidationError(
      "batch_policies must contain at most one policy per selected batch",
    );
  const seen = new Set();
  const canonical = batchPolicies.map((override) => {
    if (
      !override ||
      !Number.isSafeInteger(override.batchId) ||
      !selected.has(override.batchId) ||
      seen.has(override.batchId) ||
      !POLICIES.has(override.adoptPolicy)
    )
      throw new ValidationError(
        "batch_policies must use unique selected batch IDs and supported adoption policies",
      );
    seen.add(override.batchId);
    return { batchId: override.batchId, adoptPolicy: override.adoptPolicy };
  });
  return canonical.sort((left, right) => left.batchId - right.batchId);
}

/** Pure plan builder used by preview and locked commit. No proximity match writes data. */
export function buildPortfolioImportReconciliationPlan({
  rows,
  history,
  batches,
  adoptPolicy,
  batchPolicies = [],
  priorProAccounts = [],
  referenceOriginalRows = [],
  saxoAdoptionContext = /** @type {ReconciliationReceiptContext} */ ({
    receipts: [],
    sources: [],
    batches: [],
  }),
  kinesisAdoptionContext = /** @type {ReconciliationReceiptContext} */ ({
    receipts: [],
    sources: [],
    batches: [],
  }),
  historicalFxContext = /** @type {HistoricalFxRate[]} */ ([]),
  incomeRecognitionContext = /** @type {IncomeContext} */ ({
    receipts: [],
    sources: [],
    batches: [],
  }),
  cashContext = /** @type {CashContext} */ ({
    ledger: [],
    sources: [],
    batches: [],
  }),
  cashFundingPolicy = /** @type {string | undefined} */ (undefined),
  networkContext = /** @type {ReconciliationContext} */ ({
    sources: [],
    batches: [],
  }),
  nativeGiftContext = /** @type {ReconciliationReceiptContext} */ (
    kinesisAdoptionContext
  ),
  reconciliationScope = "full",
  repairContext = {
    transactions: [],
    batches: [],
    staging: [],
    knownTransactionIds: [],
  },
}) {
  if (
    ![
      "full",
      "adopt_existing_only",
      "correct_existing_only",
      "record_in_kind_income_only",
      "record_cash_only",
    ].includes(reconciliationScope)
  )
    throw new ValidationError("Unsupported reconciliation_scope");
  if (adoptPolicy !== undefined && !POLICIES.has(adoptPolicy))
    throw new ValidationError(
      "adopt_policy must be preserve_existing or prefer_source",
    );
  const canonicalPolicies = canonicalBatchPolicies(batchPolicies, batches);
  const scopedPolicy =
    reconciliationScope === "correct_existing_only"
      ? "prefer_source"
      : "preserve_existing";
  if (
    reconciliationScope !== "full" &&
    (adoptPolicy !== scopedPolicy ||
      canonicalPolicies.some((policy) => policy.adoptPolicy !== scopedPolicy) ||
      batches.some(
        (/** @type {ReconciliationBatchScopeRow} */ batch) =>
          formatOf(batch) !== "kinesis_transaction_history",
      ))
  )
    throw new ValidationError(
      `${reconciliationScope} requires Kinesis sources and ${scopedPolicy}`,
    );
  if (
    reconciliationScope === "record_in_kind_income_only" &&
    batches.some(
      (/** @type {ReconciliationBatchScopeRow} */ batch) =>
        batch.custom_config?.yield_basis_policy !== "zero",
    )
  )
    throw new ValidationError(
      "record_in_kind_income_only requires explicit zero yield basis policy",
    );
  if (
    reconciliationScope === "record_cash_only" &&
    cashFundingPolicy !== "own_account_transfer"
  )
    throw new ValidationError(
      "record_cash_only requires confirmed own-account funding policy",
    );
  const overrides = new Map(
    canonicalPolicies.map((override) => [
      override.batchId,
      override.adoptPolicy,
    ]),
  );
  /** @type {any[]} */
  const actions = [];
  const blockers = [];
  const adoptions = [];
  const companions = [];
  const prepared = [];
  const network =
    reconciliationScope === "full"
      ? proveKinesisNetworkBindings(rows, batches, history, networkContext)
      : { overrides: new Map(), bindings: [], blockers: [] };
  const nativeGifts =
    reconciliationScope === "full"
      ? proveKinesisNativeGiftGroups(rows, batches, history, nativeGiftContext)
      : { candidates: new Map(), groups: [], blockers: [] };
  blockers.push(...network.blockers, ...nativeGifts.blockers);
  for (const group of nativeGifts.groups) {
    if (
      group.members.some(
        (row) =>
          (overrides.get(Number(row.batch_id)) ?? adoptPolicy) !==
          "prefer_source",
      )
    )
      for (const row of group.members)
        blockers.push({
          reason: "source_policy_required",
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          candidateTransactionIds: [],
        });
  }
  const fullYieldCandidates =
    reconciliationScope === "full"
      ? proveKinesisFullYieldCandidates(rows, batches, history)
      : { candidates: new Map() };
  const seenSources = new Map();
  const proAccounts = new Set(priorProAccounts);
  for (const row of rows)
    if (
      formatOf(row) === "nexo_pro_spot_history" &&
      row.route === "portfolio" &&
      ["buy", "sell"].includes(row.type) &&
      ["matched", "committed", "duplicate"].includes(row.status)
    )
      proAccounts.add(Number(row.account_id));
  const addBlocker = (row, reason, candidates = []) => {
    const issue = {
      batchId: Number(row.batch_id),
      rowId: Number(row.id),
      rowOrdinal: row.row_index + 1,
      reason,
      candidateTransactionIds: candidates.map((candidate) =>
        Number(candidate.id),
      ),
    };
    blockers.push(issue);
    actions.push({ ...issue, action: "blocked" });
  };
  const scope = batches.map((batch) => Number(batch.id)).sort((a, b) => a - b);
  const referenceIssues = new Set();
  for (const batch of batches) {
    const config = batch.custom_config || {};
    const reference = config.portfolio_performance_reference;
    const anchor = rows.find(
      (row) => Number(row.batch_id) === Number(batch.id),
    );
    const addReference = (issue) => {
      const key = JSON.stringify(issue);
      if (referenceIssues.has(key)) return;
      referenceIssues.add(key);
      const sourceRow =
        rows.find(
          (/** @type {ReconciliationSourceRow} */ row) =>
            Number(row.batch_id) === Number(issue.batchId) &&
            row.row_index + 1 === issue.rowOrdinal,
        ) || anchor;
      const publicIssue = {
        ...issue,
        batchId: Number(sourceRow?.batch_id ?? batch.id),
        ...(sourceRow
          ? { rowId: Number(sourceRow.id), rowOrdinal: sourceRow.row_index + 1 }
          : {}),
        candidateTransactionIds: [],
      };
      blockers.push(publicIssue);
      actions.push({ ...publicIssue, action: "blocked" });
    };
    if (
      reference &&
      JSON.stringify(scope) !== JSON.stringify(reference.effectiveBatchIds)
    )
      addReference({ reason: "reference_scope_changed" });
    if (reference) {
      const expected = reference.routing?.find(
        (item) => item.batchId === Number(batch.id),
      );
      if (
        !expected ||
        Number(expected.accountId) !== Number(batch.account_id) ||
        (expected.originAccountId ?? null) !==
          (config.transfer_origin_account_id ?? null) ||
        (expected.destinationAccountId ?? null) !==
          (config.transfer_destination_account_id ?? null)
      )
        addReference({ reason: "reference_scope_changed" });
    }
    if (
      reference &&
      (portfolioReferenceStagingBinding(rows) !== reference.stagingBinding ||
        portfolioReferenceStagingBinding(referenceOriginalRows) !==
          reference.originalStagingBinding)
    )
      addReference({ reason: "reference_scope_changed" });
    for (const issue of config.reference_blockers || []) addReference(issue);
  }
  const selectedWorkbook = rows.filter(
    (/** @type {ReconciliationSourceRow} */ selected) => {
      if (formatOf(selected) !== "saxo_transaction_history") return false;
      try {
        return (
          JSON.parse(portfolioPrimaryRawData(selected.raw_data))?.format ===
          "saxo_xlsx_v1"
        );
      } catch {
        return false;
      }
    },
  );
  for (const originalRow of rows) {
    const row = network.overrides.get(Number(originalRow.id)) ?? originalRow;
    if (["committed", "duplicate"].includes(row.status)) {
      actions.push({
        batchId: Number(row.batch_id),
        rowId: Number(row.id),
        rowOrdinal: row.row_index + 1,
        action: "settled",
      });
      continue;
    }
    if (formatOf(row) === "saxo_transaction_history") {
      const raw = portfolioPrimaryRawData(row.raw_data);
      let workbook = false;
      try {
        workbook = JSON.parse(raw)?.format === "saxo_xlsx_v1";
      } catch {
        /* Literal CSV. */
      }
      if (!workbook) {
        if (selectedWorkbook.length) {
          const candidates = selectedWorkbook.filter(
            (/** @type {ReconciliationSourceRow} */ selected) =>
              selected.source_transaction_id === row.source_transaction_id &&
              selected.source_account_identity === row.source_account_identity,
          );
          if (candidates.length !== 1) {
            addBlocker(row, "saxo_companion_source_ambiguous");
            continue;
          }
          const primary = candidates[0];
          const proof = getSaxoCsvCompanionEvidence(
            raw,
            row.custom_config?.source_columns,
            portfolioPrimaryRawData(primary.raw_data),
          );
          if (
            !proof ||
            fingerprintRaw(raw) !== row.source_record_hash ||
            !saxoCsvStagingMatches(row, proof) ||
            !verifiedSaxoWorkbookRow(primary) ||
            primary.account_id == null ||
            primary.account_id !== row.account_id ||
            (row.investment_id != null &&
              Number(row.investment_id) !== Number(primary.investment_id))
          ) {
            addBlocker(row, "saxo_companion_source_unverified");
            continue;
          }
          actions.push({
            batchId: Number(row.batch_id),
            rowId: Number(row.id),
            rowOrdinal: row.row_index + 1,
            action: "duplicate_source",
            duplicateOfRowId: Number(primary.id),
          });
          companions.push({ row, primary });
          continue;
        }
      }
    }
    if (
      row.status !== "matched" ||
      !row.tx_date ||
      (row.route !== "cash" &&
        row.route !== "account_internal" &&
        row.route !== "asset_transfer" &&
        row.route !== "asset_adjustment" &&
        (!row.type || !row.investment_id))
    ) {
      addBlocker(row, "incomplete_source");
      continue;
    }
    if (row.route === "account_internal") {
      const networkWitness = verifiedKinesisNetworkRow(row);
      if (networkWitness?.kind === "asset_transfer_witness") {
        actions.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          action: "internal_annotation",
        });
        continue;
      }
      const custody = verifiedPortfolioPerformanceCustodyAnnotation(row);
      if (
        (!custody && formatOf(row) !== "nexo_transaction_history") ||
        row.asset_transfer_details?.direction !== "internal"
      )
        addBlocker(row, "invalid_internal_annotation");
      else if (!custody && !proAccounts.has(Number(row.account_id)))
        addBlocker(row, "missing_companion_pro_history");
      else
        actions.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          action: "internal_annotation",
        });
      continue;
    }
    if (row.route === "cash") {
      if (row.account_id == null || row.amount == null)
        addBlocker(row, "incomplete_source");
      else
        actions.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          action: "cash",
        });
      continue;
    }
    if (row.route === "asset_adjustment") {
      const prepared = previewPortfolioAssetAdjustment(row, undefined, {
        sourceRows: rows,
      });
      if (prepared.error) addBlocker(row, prepared.error);
      else {
        const event = prepared.event;
        const identity = `${event.dedup_fingerprint_version}:${event.dedup_fingerprint}`;
        const canonical = history.find(
          (current) =>
            `${current.dedup_fingerprint_version}:${current.dedup_fingerprint}` ===
            identity,
        );
        const same = (current) =>
          current.type === "asset_adjustment" &&
          /** @type {const} */ ([
            "investment_id",
            "account_id",
            "date",
            "adjustment_kind",
            "basis_policy",
          ]).every(
            (field) => String(current[field]) === String(event[field]),
          ) &&
          equalNumber(current.units, event.units, 8);
        if (canonical && !same(canonical)) {
          addBlocker(row, "source_identity_conflict", [canonical]);
          continue;
        }
        const earlier = seenSources.get(identity);
        if (earlier && !same(earlier.source)) {
          addBlocker(row, "source_identity_conflict");
          continue;
        }
        actions.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          investmentId: Number(row.investment_id),
          action: canonical
            ? "duplicate"
            : earlier
              ? "duplicate_source"
              : "adjustment",
          adjustment: {
            date: event.date,
            units: event.units,
            kind: event.adjustment_kind,
            basisPolicy: event.basis_policy,
            accountId: event.account_id,
          },
          ...(canonical ? { existingTransactionId: Number(canonical.id) } : {}),
          ...(earlier ? { duplicateOfRowId: Number(earlier.row.id) } : {}),
        });
        if (!canonical && !earlier)
          seenSources.set(identity, { row, source: event });
      }
      continue;
    }
    if (row.route === "asset_transfer") {
      const preparedTransfer = previewPortfolioAssetTransfer(row);
      if (preparedTransfer.error) addBlocker(row, preparedTransfer.error);
      else {
        const event = preparedTransfer.event;
        const identity = `${event.dedup_fingerprint_version}:${event.dedup_fingerprint}`;
        const canonical = history.find(
          (current) =>
            `${current.dedup_fingerprint_version}:${current.dedup_fingerprint}` ===
            identity,
        );
        const sameTransfer = (current) =>
          current.type === "asset_transfer" &&
          /** @type {const} */ ([
            "investment_id",
            "source_account_id",
            "destination_account_id",
            "date",
          ]).every(
            (field) => String(current[field]) === String(event[field]),
          ) &&
          equalNumber(current.units, event.units, 8) &&
          equalNumber(current.fee_units, event.fee_units, 8);
        if (canonical && !sameTransfer(canonical)) {
          addBlocker(row, "source_identity_conflict", [canonical]);
          continue;
        }
        const earlier = seenSources.get(identity);
        if (earlier && !sameTransfer(earlier.source)) {
          addBlocker(row, "source_identity_conflict");
          continue;
        }
        actions.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          investmentId: Number(row.investment_id),
          transfer: {
            date: event.date,
            units: event.units,
            feeUnits: event.fee_units,
            receivedUnits: toDecimal(event.units)
              .minus(event.fee_units)
              .toFixed(),
            sourceAccountId: event.source_account_id,
            destinationAccountId: event.destination_account_id,
          },
          action: canonical
            ? "duplicate"
            : earlier
              ? "duplicate_source"
              : "transfer",
          ...(canonical ? { existingTransactionId: Number(canonical.id) } : {}),
          ...(earlier ? { duplicateOfRowId: Number(earlier.row.id) } : {}),
        });
        if (!canonical && !earlier)
          seenSources.set(identity, { row, source: event });
      }
      continue;
    }
    let source;
    try {
      source = normalizedSource(row);
    } catch {
      addBlocker(row, "invalid_source_values");
      continue;
    }
    const identity =
      row.dedup_fingerprint &&
      `${row.dedup_fingerprint_version}:${row.dedup_fingerprint}`;
    const baseAction = {
      batchId: Number(row.batch_id),
      rowId: Number(row.id),
      rowOrdinal: row.row_index + 1,
      investmentId: Number(row.investment_id),
      source: publicValues(source),
    };
    const canonical =
      identity &&
      history.find(
        (current) =>
          `${current.dedup_fingerprint_version}:${current.dedup_fingerprint}` ===
          identity,
      );
    if (canonical) {
      if (
        Number(canonical.investment_id) !== Number(row.investment_id) ||
        canonical.account_id !== row.account_id
      )
        addBlocker(row, "source_identity_conflict", [canonical]);
      else {
        const effectivePolicy =
          overrides.get(Number(row.batch_id)) ?? adoptPolicy;
        const preferred = sourcePreferredImage(canonical, source, row);
        const corrections = VALUE_FIELDS.filter(
          (field) =>
            !sameValue(
              field,
              preferred[field] ?? null,
              canonical[field] ?? null,
            ),
        );
        if (
          effectivePolicy === "prefer_source" &&
          formatOf(row) === "saxo_transaction_history" &&
          corrections.length > 0 &&
          canonical.import_batch_id == null
        ) {
          if (!saxoSourceProof(row, source)) {
            addBlocker(row, "source_correction_unverified_evidence", [
              canonical,
            ]);
            continue;
          }
          const prior = priorSaxoAdoption(row, canonical, saxoAdoptionContext);
          if (prior.error) {
            addBlocker(row, prior.error, [canonical]);
            continue;
          }
          if (identity && seenSources.has(identity)) {
            const earlier = seenSources.get(identity);
            if (
              JSON.stringify(earlier.source) !== JSON.stringify(source) ||
              (overrides.get(Number(earlier.row.batch_id)) ?? adoptPolicy) !==
                effectivePolicy
            )
              addBlocker(row, "source_policy_conflict");
            else
              actions.push({
                ...baseAction,
                action: "duplicate_source",
                duplicateOfRowId: Number(earlier.row.id),
              });
            continue;
          }
          seenSources.set(identity, { row, source });
          actions.push({
            ...baseAction,
            action: "adopt",
            existingTransactionId: Number(canonical.id),
            existing: publicValues(canonical),
            corrections,
            economicsProven: true,
            policy: effectivePolicy,
          });
          adoptions.push({
            row,
            before: canonical,
            after: preferred,
            policy: effectivePolicy,
            priorSaxoReceipt: prior.receipt,
          });
          continue;
        }
        const proof = sourceProof(row, source);
        const candidates = repairContext.knownTransactionIds.includes(
          Number(canonical.id),
        )
          ? []
          : history.filter(
              (current) =>
                Number(current.id) !== Number(canonical.id) &&
                current.import_batch_id == null &&
                current.dedup_fingerprint == null &&
                broadCandidate(row, source, current, proof),
            );
        if (candidates.length > 0) {
          const originalBatch = repairContext.batches.find(
            (batch) => Number(batch.id) === Number(canonical.import_batch_id),
          );
          const originalStaging = repairContext.staging.filter(
            (staged) =>
              Number(staged.batch_id) === Number(canonical.import_batch_id) &&
              staged.route !== "cash" &&
              Number(staged.committed_txn_id) === Number(canonical.id),
          );
          if (
            !canonical.import_batch_id ||
            !["complete", "complete_with_errors"].includes(
              originalBatch?.status,
            ) ||
            originalBatch.rows_imported < 1 ||
            originalStaging.length !== 1 ||
            originalStaging[0].status !== "committed" ||
            originalStaging[0].dedup_fingerprint !== canonical.dedup_fingerprint
          ) {
            addBlocker(row, "duplicate_repair_provenance_missing", [
              canonical,
              ...candidates,
            ]);
            continue;
          }
          const changedImportedFacts = ["type", ...VALUE_FIELDS]
            .filter((field) => field !== "dividend_amount_convention")
            .some(
              (field) =>
                !sameValue(
                  field,
                  source[field] ?? null,
                  canonical[field] ?? null,
                ),
            );
          if (changedImportedFacts) {
            addBlocker(row, "duplicate_repair_imported_changed", [
              canonical,
              ...candidates,
            ]);
            continue;
          }
          if (
            (canonical.note || "").trim() !==
              (originalStaging[0].note || "").trim() ||
            canonical.is_recurring ||
            canonical.recurrence_interval != null ||
            canonical.recurrence_end_date != null
          ) {
            addBlocker(row, "duplicate_repair_imported_annotations_changed", [
              canonical,
              ...candidates,
            ]);
            continue;
          }
          if (identity && seenSources.has(identity)) {
            const earlier = seenSources.get(identity);
            if (
              JSON.stringify(earlier.source) !== JSON.stringify(source) ||
              earlier.row.account_id !== row.account_id ||
              (overrides.get(Number(earlier.row.batch_id)) ?? adoptPolicy) !==
                (overrides.get(Number(row.batch_id)) ?? adoptPolicy)
            )
              addBlocker(row, "source_policy_conflict");
            else
              actions.push({
                ...baseAction,
                action: "duplicate_source",
                duplicateOfRowId: Number(earlier.row.id),
              });
            continue;
          }
          seenSources.set(identity, { row, source });
          prepared.push({
            row,
            source,
            proof,
            candidates,
            baseAction: {
              ...baseAction,
              importedTransactionId: Number(canonical.id),
              originalBatchId: Number(canonical.import_batch_id),
              importedExisting: publicValues(canonical),
            },
            imported: canonical,
          });
          continue;
        }
        actions.push({
          ...baseAction,
          action: "duplicate",
          existingTransactionId: Number(canonical.id),
        });
      }
      continue;
    }
    if (identity && seenSources.has(identity)) {
      const earlier = seenSources.get(identity);
      if (
        (overrides.get(Number(earlier.row.batch_id)) ?? adoptPolicy) !==
        (overrides.get(Number(row.batch_id)) ?? adoptPolicy)
      ) {
        addBlocker(row, "source_policy_conflict");
        continue;
      }
      if (
        earlier.row.account_id !== row.account_id ||
        earlier.row.investment_id !== row.investment_id ||
        JSON.stringify(earlier.source) !== JSON.stringify(source)
      )
        addBlocker(row, "source_identity_conflict");
      else
        actions.push({
          ...baseAction,
          action: "duplicate_source",
          duplicateOfRowId: Number(earlier.row.id),
        });
      continue;
    }
    if (identity) seenSources.set(identity, { row, source });
    const proof = sourceProof(row, source);
    let candidates = history.filter((/** @type {HistoryImage} */ current) =>
      broadCandidate(row, source, current, proof),
    );
    const fullYield = fullYieldCandidates.candidates.get(Number(row.id));
    if (fullYield) candidates = fullYield;
    const nativeGift = nativeGifts.candidates.has(Number(row.id));
    if (nativeGift) candidates = nativeGifts.candidates.get(Number(row.id));
    prepared.push({
      row,
      source,
      proof,
      candidates,
      baseAction,
      fullYield,
      nativeGift,
    });
  }
  const narrowed = narrowImportedIbkrRepairCandidates(prepared);
  for (const { baseAction, imported } of narrowed.settledDuplicates)
    actions.push({
      ...baseAction,
      action: "duplicate",
      existingTransactionId: Number(imported.id),
    });
  const uses = new Map();
  for (const item of narrowed.prepared)
    for (const candidate of item.candidates)
      uses.set(Number(candidate.id), (uses.get(Number(candidate.id)) ?? 0) + 1);
  for (const {
    row,
    source: originalSource,
    proof,
    candidates,
    baseAction,
    imported,
    fullYield,
    nativeGift,
  } of narrowed.prepared) {
    const effectivePolicy = overrides.get(Number(row.batch_id)) ?? adoptPolicy;
    const source =
      (fullYield || nativeGift) && candidates.length === 1
        ? {
            ...originalSource,
            ...publicValues(candidates[0]),
            units: originalSource.units,
          }
        : originalSource;
    if (fullYield || nativeGift) baseAction.source = publicValues(source);
    if (candidates.length === 0) {
      if (imported) {
        actions.push({
          ...baseAction,
          action: "duplicate",
          existingTransactionId: Number(imported.id),
        });
        continue;
      }
      const roundedDepositCandidates = history.filter((current) =>
        plausibleRoundedKinesisDepositLegacy(row, current),
      );
      const datedProCandidates = proof
        ? history.filter(
            (current) =>
              Number(current.investment_id) === Number(row.investment_id) &&
              current.type === source.type &&
              dayDistance(current.date, source.date) > 7 &&
              dayDistance(current.date, source.date) <= 31 &&
              (equalNumber(proof.netUnits, current.units, 8) ||
                (proof.feeCurrency === proof.symbol &&
                  equalNumber(proof.grossUnits, current.units, 8))),
          )
        : [];
      if (roundedDepositCandidates.length)
        addBlocker(
          row,
          roundedDepositCandidates.length > 1
            ? "ambiguous_history"
            : "unproven_units",
          roundedDepositCandidates,
        );
      else if (datedProCandidates.length)
        addBlocker(
          row,
          datedProCandidates.length > 1
            ? "ambiguous_history"
            : "unproven_economics",
          datedProCandidates,
        );
      else if (transferWithoutBasis(row))
        addBlocker(row, "missing_original_basis");
      else actions.push({ ...baseAction, action: "insert" });
      continue;
    }
    if (candidates.length !== 1 || uses.get(Number(candidates[0].id)) !== 1) {
      addBlocker(row, "ambiguous_history", candidates);
      continue;
    }
    const current = candidates[0];
    if (
      (current.account_id != null && !nativeGift) ||
      current.import_batch_id != null ||
      current.dedup_fingerprint != null
    ) {
      addBlocker(row, "existing_assigned_or_imported_history", candidates);
      continue;
    }
    if (!row.dedup_fingerprint || row.dedup_fingerprint_version == null) {
      addBlocker(row, "missing_source_identity", candidates);
      continue;
    }
    const corrections = ["type", ...VALUE_FIELDS].filter(
      (field) =>
        !sameValue(field, source[field] ?? null, current[field] ?? null),
    );
    const exact = corrections.length === 0;
    const hasBasis = toDecimal(current.amount ?? 0).gt(0);
    if (
      transferWithoutBasis(row) &&
      (!hasBasis || effectivePolicy !== "preserve_existing")
    ) {
      addBlocker(row, "missing_original_basis", candidates);
      continue;
    }
    const secondaryIdentity =
      portfolioPerformanceBasisIdentifiesLegacy(row, current) ||
      portfolioPerformanceReferenceIdentifiesLegacy(row, current) ||
      portfolioPerformanceRoundedDepositIdentifiesLegacy(row, current) ||
      zeroYieldIdentifiesLegacy(row, current) ||
      Boolean(fullYield || nativeGift) ||
      ((imported || source.type === "sell") &&
        ibkrPrimaryEvidenceIdentifiesLegacy(row, source, current, rows));
    const comparable =
      equivalentEconomics(source, current, proof) || secondaryIdentity;
    if ((!exact || imported) && effectivePolicy === undefined) {
      actions.push({
        ...baseAction,
        action: "policy_required",
        existingTransactionId: Number(current.id),
        existing: publicValues(current),
        corrections,
        economicsProven: comparable,
      });
      blockers.push({
        batchId: Number(row.batch_id),
        rowId: Number(row.id),
        rowOrdinal: row.row_index + 1,
        reason: imported
          ? "duplicate_repair_policy_required"
          : "source_policy_required",
        candidateTransactionIds: [Number(current.id)],
      });
      continue;
    }
    if (
      effectivePolicy === "prefer_source" &&
      (!comparable || source.type !== current.type)
    ) {
      addBlocker(
        row,
        source.currency !== current.currency
          ? "unproven_currency_conversion"
          : "unproven_economics",
        candidates,
      );
      continue;
    }
    if (
      effectivePolicy === "prefer_source" &&
      UNIT_TYPES.has(source.type) &&
      !equalNumber(source.units, current.units, 8) &&
      !fullYield &&
      !portfolioPerformanceRoundedDepositIdentifiesLegacy(row, current) &&
      !(
        proof &&
        proof.feeCurrency === proof.symbol &&
        toDecimal(proof.feeUnits).gt(0) &&
        equalNumber(proof.grossUnits, current.units, 8)
      )
    ) {
      addBlocker(row, "unproven_units", candidates);
      continue;
    }
    const after = {
      ...current,
      account_id: row.account_id,
      source_record_hash: row.source_record_hash,
      dedup_fingerprint: row.dedup_fingerprint,
      dedup_fingerprint_version: row.dedup_fingerprint_version,
    };
    if (effectivePolicy === "prefer_source")
      for (const field of VALUE_FIELDS) {
        // A source without an exchange rate cannot erase a known rate for the
        // same currency. A currency correction requires proven conversion.
        if (
          field === "fx_rate_to_eur" &&
          source[field] == null &&
          source.currency === current.currency
        )
          continue;
        after[field] = source[field];
      }
    const policy =
      exact && effectivePolicy === undefined ? "exact" : effectivePolicy;
    actions.push({
      ...baseAction,
      action: imported ? "repair_duplicate" : "adopt",
      existingTransactionId: Number(current.id),
      existing: publicValues(current),
      corrections,
      economicsProven: comparable,
      policy,
    });
    adoptions.push({ row, before: current, after, policy, imported });
  }
  const planFingerprint = fingerprint({
    policy: adoptPolicy ?? null,
    batchPolicies: canonicalPolicies,
    priorProAccounts,
    batches: batches.map((batch) => ({
      id: batch.id,
      account_id: batch.account_id,
      status: batch.status,
      custom_config: batch.custom_config,
    })),
    source: rows.map((row) => ({
      ...row,
      created_at: undefined,
      updated_at: undefined,
    })),
    history,
    repairContext,
    saxoAdoptionContext,
    kinesisAdoptionContext,
    historicalFxContext,
    incomeRecognitionContext,
    cashContext,
    cashFundingPolicy,
    networkContext,
    nativeGiftContext,
    networkBindings: network.bindings,
    nativeGiftGroups: nativeGifts.groups,
    reconciliationScope,
    referenceOriginalRows,
  });
  const result = {
    plan: {
      batchIds: batches.map((batch) => Number(batch.id)),
      adoptPolicy: adoptPolicy ?? null,
      batchPolicies: canonicalPolicies,
      planFingerprint,
      ready: blockers.length === 0,
      actions,
      blockers,
      summary: Object.fromEntries(
        [
          "insert",
          "record_income",
          "adopt",
          "repair_duplicate",
          "duplicate",
          "duplicate_source",
          "cash",
          "transfer",
          "adjustment",
          "internal_annotation",
          "settled",
          "blocked",
          "policy_required",
        ].map((action) => [
          action,
          actions.filter((item) => item.action === action).length,
        ]),
      ),
    },
    adoptions,
    companions,
    sourceOverrides: network.overrides,
    networkBindings: network.bindings,
    nativeGiftGroups: nativeGifts.groups,
  };
  return reconciliationScope === "record_cash_only"
    ? boundedKinesisCashPlan(
        result,
        rows,
        batches,
        cashContext,
        cashFundingPolicy,
        historicalFxContext,
      )
    : reconciliationScope === "record_in_kind_income_only"
      ? boundedKinesisIncomePlan(
          result,
          rows,
          history,
          batches,
          kinesisAdoptionContext,
          incomeRecognitionContext,
          historicalFxContext,
        )
      : reconciliationScope === "correct_existing_only"
        ? boundedKinesisCorrectionPlan(
            result,
            rows,
            history,
            batches,
            kinesisAdoptionContext,
            historicalFxContext,
          )
        : reconciliationScope === "adopt_existing_only"
          ? boundedKinesisAdoptionPlan(
              result,
              rows,
              history,
              batches,
              kinesisAdoptionContext,
            )
          : completeKinesisCashRepeatPlan(
              completeKinesisIncomePlan(
                result,
                rows,
                history,
                batches,
                kinesisAdoptionContext,
                incomeRecognitionContext,
                historicalFxContext,
              ),
              rows,
              batches,
              cashContext,
              historicalFxContext,
            );
}

/**
 * @param {ReconciliationPlanResult} full
 * @param {ReconciliationSourceRow[]} rows
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {CashContext} context
 * @param {HistoricalFxRate[]} rates
 */
function completeKinesisCashRepeatPlan(full, rows, batches, context, rates) {
  const sourceBatches = batches.filter(
    (batch) => formatOf(batch) === "kinesis_transaction_history",
  );
  if (!sourceBatches.length || !context.sources.length) return full;
  const ids = new Set(sourceBatches.map((batch) => Number(batch.id)));
  const sourceRows = rows.filter((row) => ids.has(Number(row.batch_id)));
  const proved = classifyKinesisCash({
    rows: sourceRows,
    batches: sourceBatches,
    context,
    fundingPolicy: "own_account_transfer",
    historicalFxContext: rates,
  });
  // Retained owned envelopes supply funding intent only for exact existing repeats.
  const repeated = proved.selected.filter((action) =>
    ["duplicate", "settled"].includes(action.action),
  );
  const replacements = new Map(
    repeated.map((action) => [action.rowId, action]),
  );
  /** @type {PlanAction[]} */
  const actions = full.plan.actions.map(
    (action) => replacements.get(action.rowId) ?? action,
  );
  const blockers = [...full.plan.blockers, ...proved.blockers];
  return {
    ...full,
    plan: {
      ...full.plan,
      actions,
      blockers,
      ready: blockers.length === 0,
      summary: Object.fromEntries(
        Object.keys(full.plan.summary).map((kind) => [
          kind,
          actions.filter((action) => action.action === kind).length,
        ]),
      ),
      planFingerprint: fingerprint({
        prior: full.plan.planFingerprint,
        cashContext: context,
        repeated,
        blockers,
      }),
    },
  };
}

/**
 * Ordinary full imports still need the same pair proof as income-only review.
 * @param {ReconciliationPlanResult} full
 * @param {ReconciliationSourceRow[]} rows
 * @param {HistoryImage[]} history
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {ReconciliationReceiptContext} context
 * @param {IncomeContext} incomeContext
 * @param {HistoricalFxRate[]} rates
 */
function completeKinesisIncomePlan(
  full,
  rows,
  history,
  batches,
  context,
  incomeContext,
  rates,
) {
  const sourceBatches = batches.filter(
    (batch) =>
      formatOf(batch) === "kinesis_transaction_history" &&
      batch.custom_config?.yield_basis_policy === "zero",
  );
  if (!sourceBatches.length) return full;
  const ids = new Set(sourceBatches.map((batch) => Number(batch.id)));
  const sourceRows = rows.filter((row) => ids.has(Number(row.batch_id)));
  const plannedUnits = full.plan.actions
    .filter(
      (action) =>
        ["insert", "adopt"].includes(action.action) &&
        action.source?.type === "gift",
    )
    .map((action) => {
      const row = sourceRows.find((row) => Number(row.id) === action.rowId);
      if (!row) return undefined;
      const adoption = full.adoptions.find(
        (item) => Number(item.row.id) === action.rowId,
      );
      return {
        action: action.action,
        row,
        // A planned insert's projected image: source values and identity only.
        after:
          adoption?.after ??
          /** @type {PortfolioTransactionSnapshot} */ ({
            ...normalizedSource(row),
            id: -Number(row.id),
            investment_id: Number(row.investment_id),
            account_id: row.account_id,
            source_record_hash: row.source_record_hash,
            note: row.note,
            dedup_fingerprint: row.dedup_fingerprint,
            dedup_fingerprint_version: row.dedup_fingerprint_version,
          }),
      };
    })
    .filter(Boolean);
  const proved = proveKinesisIncomePairs({
    rows: sourceRows,
    batches: sourceBatches,
    history,
    context,
    incomeContext,
    plannedUnits,
  });
  const records = [];
  const actions = [...full.plan.actions];
  const blockers = [...full.plan.blockers, ...proved.blockers];
  /** @param {ReconciliationSourceRow} row */
  const available = (row) =>
    row.currency === "EUR" ||
    rates.some(
      (rate) =>
        rate.currency === row.currency &&
        rate.date === row.tx_date &&
        Number(rate.rate) > 0,
    );
  const paired = new Map();
  for (const record of [...proved.records, ...proved.duplicates])
    paired.set(Number(record.row.id), record);
  for (const row of sourceRows.filter(
    (row) =>
      row.type === "dividend" && row.source_transaction_id?.endsWith(":income"),
  )) {
    const index = actions.findIndex(
      (action) => action.rowId === Number(row.id),
    );
    let action = actions[index];
    const record = paired.get(Number(row.id));
    // Two literal distributions can have the same informational value. A
    // proved income owned by another acquisition is not this new pair.
    if (
      record &&
      proved.records.includes(record) &&
      action?.action === "blocked" &&
      action.candidateTransactionIds?.length &&
      action.candidateTransactionIds.every((id) =>
        proved.duplicates.some(
          (other) =>
            Number(other.current.id) === Number(id) &&
            Number(other.unit.id) !== Number(record.unit.id),
        ),
      )
    ) {
      const issues = blockers.filter(
        (issue) => Number(issue.rowId) === Number(row.id),
      );
      if (
        issues.length &&
        issues.every(
          (issue) => issue.reason === "existing_assigned_or_imported_history",
        )
      ) {
        for (let position = blockers.length - 1; position >= 0; position--)
          if (Number(blockers[position].rowId) === Number(row.id))
            blockers.splice(position, 1);
        action = { ...action, action: "insert", candidateTransactionIds: [] };
      }
    }
    const unitRow = sourceRows.find(
      (unit) =>
        unit.source_transaction_id ===
          row.source_transaction_id.replace(/:income$/, ":units") &&
        unit.source_record_hash === row.source_record_hash,
    );
    const conflicting =
      record &&
      full.plan.blockers.some((issue) =>
        issue.candidateTransactionIds?.includes(Number(record.unit.id)),
      );
    if (
      !record ||
      !action ||
      conflicting ||
      action.candidateTransactionIds?.length ||
      !available(row)
    ) {
      blockers.push({
        batchId: Number(row.batch_id),
        rowId: Number(row.id),
        rowOrdinal: row.row_index + 1,
        reason:
          record && !available(row)
            ? "historical_income_rate_unavailable"
            : "paired_income_review_required",
        candidateTransactionIds:
          record && Number(record.unit.id) > 0 ? [Number(record.unit.id)] : [],
      });
      continue;
    }
    const repeat = proved.duplicates.includes(record);
    if (
      (!repeat && action.action !== "insert") ||
      (repeat && !["duplicate", "settled"].includes(action.action))
    ) {
      blockers.push({
        reason: "paired_income_existing_conflict",
        batchId: Number(row.batch_id),
        rowId: Number(row.id),
        rowOrdinal: row.row_index + 1,
        candidateTransactionIds: [],
      });
      continue;
    }
    const unitIndex = actions.findIndex(
      (action) => action.rowId === Number(unitRow.id),
    );
    if (unitIndex >= 0 && Number(record.unit.id) > 0)
      actions[unitIndex] = {
        ...actions[unitIndex],
        existingTransactionId: Number(record.unit.id),
        investmentId: Number(unitRow.investment_id),
      };
    actions[index] = {
      ...action,
      investmentId: Number(row.investment_id),
      action: repeat ? action.action : "record_income",
      ...(repeat
        ? { existingTransactionId: Number(record.current.id) }
        : {
            source: {
              ...publicValues(normalizedSource(row)),
              income_recognition_role: "included_in_units",
            },
          }),
      incomeProof: {
        kind: "paired_kinesis_income",
        unitRowId: Number(unitRow.id),
        ...(Number(record.unit.id) > 0
          ? { unitTransactionId: Number(record.unit.id) }
          : {}),
      },
    };
    if (!repeat) records.push(record);
  }
  return {
    ...full,
    incomeRecords: records,
    plan: {
      ...full.plan,
      actions,
      blockers,
      ready: blockers.length === 0,
      summary: Object.fromEntries(
        Object.keys(full.plan.summary).map((kind) => [
          kind,
          actions.filter((action) => action.action === kind).length,
        ]),
      ),
      planFingerprint: fingerprint({
        prior: full.plan.planFingerprint,
        proofs: [...paired.values()].map((record) => ({
          rowId: record.row.id,
          unit: record.unit,
          proof: record.proof,
        })),
        actions,
        blockers,
      }),
    },
  };
}

/**
 * @param {ReconciliationPlanResult} full
 * @param {ReconciliationSourceRow[]} rows
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {CashContext} context
 * @param {string | undefined} fundingPolicy
 * @param {HistoricalFxRate[]} historicalFxContext
 */
function boundedKinesisCashPlan(
  full,
  rows,
  batches,
  context,
  fundingPolicy,
  historicalFxContext,
) {
  const proved = classifyKinesisCash({
    rows,
    batches,
    context,
    fundingPolicy,
    historicalFxContext,
  });
  const blockers = [
    ...proved.blockers,
    ...full.plan.blockers.filter((issue) =>
      [
        "source_identity_conflict",
        "source_policy_conflict",
        "reference_scope_changed",
        "reference_account_mapping_conflict",
      ].includes(issue.reason),
    ),
  ];
  return {
    ...boundedKinesisPlanResult(
      full,
      rows,
      batches,
      context,
      proved.proofs,
      proved.selected,
      [],
      blockers,
      "record_cash_only",
    ),
    cashRecords: proved.records,
  };
}

/**
 * @param {ReconciliationPlanResult} full
 * @param {ReconciliationSourceRow[]} rows
 * @param {HistoryImage[]} history
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {ReconciliationReceiptContext} context
 * @param {IncomeContext} incomeContext
 * @param {HistoricalFxRate[]} historicalFxContext
 */
function boundedKinesisIncomePlan(
  full,
  rows,
  history,
  batches,
  context,
  incomeContext,
  historicalFxContext,
) {
  /** @param {ReconciliationSourceRow} row */
  const availableRate = (row) =>
    row.currency === "EUR" ||
    historicalFxContext.some(
      (pair) =>
        pair.currency === row.currency &&
        pair.date === row.tx_date &&
        pair.rate != null &&
        Number.isFinite(Number(pair.rate)) &&
        Number(pair.rate) > 0,
    );
  const proved = proveKinesisIncomePairs({
    rows,
    batches,
    history,
    context,
    incomeContext,
  });
  const blockers = [
    ...proved.blockers,
    ...full.plan.blockers.filter((issue) =>
      [
        "source_identity_conflict",
        "source_policy_conflict",
        "reference_scope_changed",
        "reference_ambiguous_match",
        "reference_account_mapping_conflict",
      ].includes(issue.reason),
    ),
  ];
  const selected = [];
  const records = [];
  for (const record of proved.records) {
    const action = full.plan.actions.find(
      (action) => action.rowId === Number(record.row.id),
    );
    if (
      !action ||
      !["insert", "blocked"].includes(action.action) ||
      action.candidateTransactionIds?.length
    ) {
      blockers.push({
        reason: "paired_income_existing_conflict",
        batchId: Number(record.row.batch_id),
        rowId: Number(record.row.id),
        rowOrdinal: record.row.row_index + 1,
        candidateTransactionIds: action?.candidateTransactionIds || [],
      });
      continue;
    }
    const contested = full.plan.blockers.filter((issue) =>
      issue.candidateTransactionIds?.includes(Number(record.unit.id)),
    );
    if (contested.length) {
      blockers.push(...contested);
      continue;
    }
    if (!availableRate(record.row)) continue;
    selected.push({
      ...action,
      action: "record_income",
      source: {
        ...publicValues({
          ...record.row,
          date: record.row.tx_date,
          dividend_amount_convention: "unknown",
        }),
        income_recognition_role: "included_in_units",
      },
      incomeProof: {
        kind: "paired_kinesis_income",
        unitTransactionId: Number(record.unit.id),
      },
    });
    records.push(record);
  }
  for (const repeated of proved.duplicates) {
    if (!availableRate(repeated.row)) continue;
    const action = full.plan.actions.find(
      (action) => action.rowId === Number(repeated.row.id),
    );
    selected.push({
      ...action,
      action: ["committed", "duplicate"].includes(repeated.row.status)
        ? "settled"
        : "duplicate",
      existingTransactionId: Number(repeated.current.id),
      incomeProof: {
        kind: "paired_kinesis_income",
        unitTransactionId: Number(repeated.unit.id),
      },
    });
  }
  return {
    ...boundedKinesisPlanResult(
      full,
      rows,
      batches,
      { ...context, incomeContext },
      proved.proofs,
      selected,
      [],
      blockers,
      "record_in_kind_income_only",
    ),
    incomeRecords: records,
  };
}

/**
 * @param {ReconciliationSourceRow} row
 * @param {HistoryImage} current
 * @param {ParsedPortfolioRow} parsed
 */
function kinesisSourceFactsMatchExisting(row, current, parsed) {
  if (
    row.type === "gift" &&
    parsed.assetAdjustment?.kind === "yield_acquisition" &&
    parsed.assetAdjustment.basisPolicy === "zero" &&
    toDecimal(parsed.amount ?? 0).isZero() &&
    /** @type {const} */ (["amount", "price_per_unit", "fees", "taxes"]).every(
      (field) => toDecimal(current[field] ?? 0).isZero(),
    )
  )
    return true;
  // A preserved positive gift basis needs a literal valuation and currency.
  // Stamping an unknown basis would prevent a later reviewed source correction.
  if (!parsed.currency || (row.type === "gift" && parsed.amount == null))
    return false;
  const source = normalizedSource({
    ...row,
    units: parsed.units,
    price_per_unit: parsed.pricePerUnit,
    amount: parsed.amount,
    fees: parsed.fees,
    taxes: parsed.taxes,
    currency: parsed.currency,
    fx_rate_to_eur: parsed.fxRateToEur,
  });
  return (
    /** @type {const} */ ([
      "type",
      "amount",
      "units",
      "price_per_unit",
      "fees",
      "taxes",
      "currency",
    ]).every((field) => sameValue(field, source[field], current[field])) &&
    (source.fx_rate_to_eur == null ||
      sameValue(
        "fx_rate_to_eur",
        source.fx_rate_to_eur,
        current.fx_rate_to_eur,
      ))
  );
}

const KINESIS_CORRECTION_FIELDS = /** @type {const} */ ([
  "amount",
  "price_per_unit",
  "fees",
  "taxes",
  "currency",
  "fx_rate_to_eur",
]);

/**
 * @param {ReconciliationSourceRow} row
 * @param {KinesisSourceProof | undefined} proof
 * @returns {NormalizedSource | undefined}
 */
function kinesisCorrectionSource(row, proof) {
  if (!proof) return undefined;
  const parsed = proof.parsed;
  const source = normalizedSource(row);
  if (row.type === "buy") {
    const literal = normalizedSource({
      ...row,
      amount: parsed.amount,
      units: parsed.units,
      price_per_unit: parsed.pricePerUnit,
      fees: parsed.fees,
      taxes: parsed.taxes,
      currency: parsed.currency,
      fx_rate_to_eur: parsed.fxRateToEur,
    });
    return parsed.currency &&
      ["units", ...KINESIS_CORRECTION_FIELDS].every((field) =>
        sameValue(field, source[field] ?? null, literal[field] ?? null),
      )
      ? source
      : undefined;
  }
  const basis = verifiedPortfolioPerformanceBasisReference(row);
  if (
    row.type !== "gift" ||
    !basis?.meaningful ||
    basis.basisPolicy !== "recorded_native" ||
    Number(basis.accountId) !== Number(row.account_id) ||
    basis.sourceHash !==
      row.custom_config?.portfolio_performance_reference?.sourceHash ||
    (parsed.currency && parsed.currency !== basis.currency) ||
    !basis.literal.units.every(
      (/** @type {{ type: string }} */ unit) => unit.type === "GROSS_VALUE",
    ) ||
    !equalNumber(source.fees, "0", 4) ||
    !equalNumber(source.taxes, "0", 4) ||
    !equalNumber(source.fx_rate_to_eur, basis.fxRateToEur ?? null, 10) ||
    !equalNumber(
      source.price_per_unit,
      toDecimal(basis.amount).div(row.units).toFixed(),
      6,
    )
  )
    return undefined;
  return source;
}

/**
 * @param {ReconciliationPlanResult} full
 * @param {ReconciliationSourceRow[]} rows
 * @param {HistoryImage[]} history
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {ReconciliationReceiptContext} context
 * @param {HistoricalFxRate[]} historicalFxContext
 */
function boundedKinesisCorrectionPlan(
  full,
  rows,
  history,
  batches,
  context,
  historicalFxContext,
) {
  const { proofs, literalProofs, issues } = proveKinesisCorrectionSources(
    rows,
    batches,
  );
  const priorProofs = proveKinesisCorrectionSources(
    context.sources,
    context.batches,
  ).proofs;
  const selected = [];
  /** @type {PlanAdoption[]} */
  const adoptions = [];
  const groups = proveRetainedKinesisYieldGroups({
    rows,
    batches,
    history,
    context,
  });
  const groupedRowIds = new Set(groups.reservedRowIds);
  const blockers = [
    ...issues,
    ...groups.blockers,
    ...full.plan.blockers.filter(
      (issue) =>
        [
          "reference_scope_changed",
          "source_identity_conflict",
          "source_policy_conflict",
          "reference_account_mapping_conflict",
          "reference_ambiguous_match",
        ].includes(issue.reason) ||
        (proofs.has(issue.rowId) &&
          ["ambiguous_history", "duplicate_repair_provenance_missing"].includes(
            issue.reason,
          )),
    ),
  ];
  for (const group of groups.groups) {
    const ids = new Set(
      group.members.map((member) => Number(member.current.id)),
    );
    const contested = full.plan.blockers.filter((issue) =>
      issue.candidateTransactionIds.some((id) => ids.has(Number(id))),
    );
    if (contested.length) {
      blockers.push(...contested);
      continue;
    }
    for (const member of group.members) {
      const { row, current, recorded } = member;
      const rowId = Number(row.id);
      groupedRowIds.add(rowId);
      if (
        member.retained?.receipt.policy === "preserve_existing" ||
        recorded.date === row.tx_date
      )
        continue;
      proofs.set(rowId, member.proof);
      const action = full.plan.actions.find((item) => item.rowId === rowId);
      if (member.retained) {
        selected.push({
          ...action,
          action: ["duplicate", "committed"].includes(row.status)
            ? "settled"
            : "duplicate",
          existingTransactionId: Number(current.id),
        });
        continue;
      }
      // Yield group members bind gift transactions: full snapshot images.
      const after = /** @type {PortfolioTransactionSnapshot} */ ({
        ...current,
        date: row.tx_date,
        account_id: row.account_id,
        source_record_hash: row.source_record_hash,
        dedup_fingerprint: row.dedup_fingerprint,
        dedup_fingerprint_version: row.dedup_fingerprint_version,
      });
      selected.push({
        ...action,
        action: "adopt",
        existingTransactionId: Number(current.id),
        policy: "prefer_source",
        existing: publicValues(current),
        source: publicValues({ ...current, date: row.tx_date }),
        corrections: ["date"],
        candidateTransactionIds: [Number(current.id)],
        dateProof: {
          kind: "closed_kinesis_yield_group",
          groupKey: group.key,
          recordedDate: recorded.date,
          paymentDate: row.tx_date,
          memberCount: group.members.length,
        },
      });
      adoptions.push({
        row,
        before: /** @type {PortfolioTransactionSnapshot} */ (current),
        after,
        policy: "prefer_source",
      });
    }
  }
  for (const action of full.plan.actions) {
    if (groupedRowIds.has(action.rowId)) continue;
    const row = rows.find((item) => Number(item.id) === action.rowId);
    const proof =
      proofs.get(action.rowId) ||
      (["duplicate", "settled"].includes(action.action)
        ? literalProofs.get(action.rowId)
        : undefined);
    if (!row || !proof) continue;
    if (action.action === "adopt") {
      const adoption = full.adoptions.find(
        (item) => Number(item.row.id) === action.rowId,
      );
      const source = kinesisCorrectionSource(row, proof);
      if (
        !adoption ||
        adoption.imported ||
        adoption.policy !== "prefer_source" ||
        !source
      )
        continue;
      const before = adoption.before;
      const after = {
        ...adoption.after,
        units: before.units,
        date: before.date,
      };
      const corrections = KINESIS_CORRECTION_FIELDS.filter(
        (field) => !sameValue(field, before[field], after[field]),
      );
      if (
        !corrections.length ||
        before.type !== row.type ||
        before.date !== row.tx_date ||
        !equalNumber(before.units, row.units, 8) ||
        (row.type === "gift" && !toDecimal(before.amount ?? 0).gt("0.01")) ||
        /** @type {const} */ ([
          "id",
          "investment_id",
          "type",
          "date",
          "units",
          "note",
        ]).some((field) => !sameValue(field, before[field], after[field])) ||
        !KINESIS_CORRECTION_FIELDS.every((field) =>
          sameValue(
            field,
            after[field],
            sourcePreferredImage(before, source, row)[field],
          ),
        ) ||
        (row.type === "gift" &&
          !portfolioPerformanceBasisIdentifiesLegacy(row, before))
      )
        continue;
      if (
        source.currency !== before.currency &&
        source.currency !== "EUR" &&
        source.fx_rate_to_eur == null &&
        !historicalFxContext.some(
          (rate) =>
            rate.currency === source.currency &&
            rate.date === row.tx_date &&
            rate.rate != null &&
            toDecimal(rate.rate).gt(0),
        )
      )
        continue;
      selected.push({ ...action, corrections });
      adoptions.push({ ...adoption, after });
    } else if (["duplicate", "settled"].includes(action.action)) {
      const current = history.filter(
        (item) =>
          item.dedup_fingerprint === row.dedup_fingerprint &&
          item.dedup_fingerprint_version === row.dedup_fingerprint_version &&
          Number(item.investment_id) === Number(row.investment_id),
      );
      const receipts = context.receipts.filter(
        (receipt) => Number(receipt.transaction_id) === Number(current[0]?.id),
      );
      if (!receipts.some((receipt) => receipt.policy === "prefer_source"))
        continue;
      const receipt = receipts[0];
      const prior = context.sources.find(
        (item) => Number(item.id) === Number(receipt.staging_row_id),
      );
      const priorSource =
        prior &&
        kinesisCorrectionSource(prior, priorProofs.get(Number(prior.id)));
      const correctionReference = context.batches.some(
        (batch) =>
          Number(batch.id) === Number(receipt.batch_id) &&
          batch.custom_config?.portfolio_performance_reference
            ?.reconciliationScope === "correct_existing_only",
      );
      if (
        !priorSource &&
        !kinesisCorrectionSource(row, proof) &&
        !correctionReference
      )
        continue;
      if (
        current.length !== 1 ||
        receipts.length !== 1 ||
        receipt.policy !== "prefer_source" ||
        !sameSnapshot(current[0], receipt.after_data) ||
        !priorSource ||
        prior.status !== "duplicate" ||
        prior.route !== "portfolio" ||
        Number(prior.batch_id) !== Number(receipt.batch_id) ||
        current[0].import_batch_id != null ||
        Number(current[0].account_id) !== Number(row.account_id) ||
        Number(prior.account_id) !== Number(row.account_id) ||
        Number(prior.investment_id) !== Number(row.investment_id) ||
        current[0].type !== row.type ||
        prior.type !== row.type ||
        current[0].date !== row.tx_date ||
        !equalNumber(current[0].units, row.units, 8) ||
        prior.source_record_hash !== row.source_record_hash ||
        current[0].source_record_hash !== row.source_record_hash ||
        prior.dedup_fingerprint !== row.dedup_fingerprint ||
        portfolioPrimaryRawData(prior.raw_data) !==
          portfolioPrimaryRawData(row.raw_data) ||
        priorProofs.get(Number(prior.id)).sourceFileHash !==
          proof.sourceFileHash ||
        !KINESIS_CORRECTION_FIELDS.every((field) =>
          sameValue(
            field,
            current[0][field],
            sourcePreferredImage(current[0], priorSource, prior)[field],
          ),
        ) ||
        (row.type === "buy" &&
          !kinesisSourceFactsMatchExisting(row, current[0], proof.parsed))
      ) {
        blockers.push({
          batchId: Number(row.batch_id),
          rowId: Number(row.id),
          rowOrdinal: row.row_index + 1,
          reason: "source_correction_existing_changed",
          candidateTransactionIds: current.map((item) => Number(item.id)),
        });
        continue;
      }
      selected.push({
        ...action,
        existingTransactionId: Number(current[0].id),
      });
      proofs.set(action.rowId, proof);
    }
  }
  return boundedKinesisPlanResult(
    full,
    rows,
    batches,
    context,
    proofs,
    selected,
    adoptions,
    blockers,
    "correct_existing_only",
  );
}

/**
 * @param {ReconciliationPlanResult} full
 * @param {ReconciliationSourceRow[]} rows
 * @param {HistoryImage[]} history
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {ReconciliationReceiptContext} context
 */
function boundedKinesisAdoptionPlan(full, rows, history, batches, context) {
  const { proofs, issues } = proveKinesisAdoptionSources(rows, batches);
  const corrected = boundedKinesisCorrectionPlan(
    full,
    rows,
    history,
    batches,
    context,
    [],
  );
  const correctionProofs = proveKinesisCorrectionSources(rows, batches).proofs;
  const groups = proveRetainedKinesisYieldGroups({
    rows,
    batches,
    history,
    context,
  });
  const selected = [];
  /** @type {PlanAdoption[]} */
  const adoptions = [];
  const blockers = [
    ...issues,
    ...groups.blockers,
    ...corrected.plan.blockers.filter(
      (issue) => issue.reason === "source_correction_existing_changed",
    ),
    ...full.plan.blockers.filter(
      (issue) =>
        [
          "reference_scope_changed",
          "source_identity_conflict",
          "source_policy_conflict",
          "reference_account_mapping_conflict",
          "reference_ambiguous_match",
        ].includes(issue.reason) ||
        (proofs.has(issue.rowId) &&
          ["ambiguous_history", "duplicate_repair_provenance_missing"].includes(
            issue.reason,
          )),
    ),
  ];
  const priorProofs = proveKinesisCorrectionSources(
    context.sources,
    context.batches,
  ).proofs;
  /** @param {ReconciliationSourceRow} row */
  const currentFor = (row) =>
    history.filter(
      (current) =>
        current.dedup_fingerprint === row.dedup_fingerprint &&
        current.dedup_fingerprint_version === row.dedup_fingerprint_version &&
        Number(current.investment_id) === Number(row.investment_id),
    );
  const handled = new Set();
  for (const action of corrected.plan.actions) {
    if (!["duplicate", "settled"].includes(action.action)) continue;
    selected.push(action);
    handled.add(action.rowId);
    proofs.set(action.rowId, correctionProofs.get(action.rowId));
  }
  for (const group of groups.groups)
    for (const member of group.members) {
      const { row, current } = member;
      const rowId = Number(row.id);
      handled.add(rowId);
      proofs.set(rowId, member.proof);
      const action = full.plan.actions.find((item) => item.rowId === rowId);
      if (member.retained) {
        selected.push({
          ...action,
          action: ["duplicate", "committed"].includes(row.status)
            ? "settled"
            : "duplicate",
          existingTransactionId: Number(current.id),
        });
      } else {
        // Yield group members bind gift transactions: full snapshot images.
        const after = /** @type {PortfolioTransactionSnapshot} */ ({
          ...current,
          account_id: row.account_id,
          source_record_hash: row.source_record_hash,
          dedup_fingerprint: row.dedup_fingerprint,
          dedup_fingerprint_version: row.dedup_fingerprint_version,
        });
        selected.push({
          ...action,
          action: "adopt",
          existingTransactionId: Number(current.id),
          policy: "preserve_existing",
          existing: publicValues(current),
          source: publicValues(normalizedSource(row)),
          corrections: [],
          candidateTransactionIds: [Number(current.id)],
        });
        adoptions.push({
          row,
          before: /** @type {PortfolioTransactionSnapshot} */ (current),
          after,
          policy: "preserve_existing",
        });
      }
    }
  for (const action of full.plan.actions) {
    if (handled.has(action.rowId) || groups.reservedRowIds.has(action.rowId))
      continue;
    const row = rows.find((item) => Number(item.id) === action.rowId);
    if (!row || !proofs.has(action.rowId)) continue;
    if (action.action === "adopt") {
      const adoption = full.adoptions.find(
        (item) => Number(item.row.id) === action.rowId,
      );
      if (
        !adoption ||
        adoption.imported ||
        adoption.policy !== "preserve_existing" ||
        adoption.before.type !== row.type ||
        adoption.before.date !== row.tx_date ||
        !equalNumber(adoption.before.units, row.units, 8) ||
        !kinesisSourceFactsMatchExisting(
          row,
          adoption.before,
          proofs.get(action.rowId).parsed,
        ) ||
        !["buy", "gift"].includes(row.type) ||
        /** @type {const} */ (["type", ...VALUE_FIELDS, "note"]).some(
          (field) =>
            !sameValue(field, adoption.before[field], adoption.after[field]),
        )
      )
        continue;
      selected.push(action);
      adoptions.push(adoption);
    } else if (["duplicate", "settled"].includes(action.action)) {
      const current = currentFor(row);
      if (
        current.length === 1 &&
        !kinesisSourceFactsMatchExisting(
          row,
          current[0],
          proofs.get(action.rowId).parsed,
        )
      )
        continue;
      const receipts = context.receipts.filter(
        (receipt) => Number(receipt.transaction_id) === Number(current[0]?.id),
      );
      const receipt = receipts[0];
      const prior = context.sources.find(
        (source) => Number(source.id) === Number(receipt?.staging_row_id),
      );
      if (
        current.length !== 1 ||
        current[0].import_batch_id != null ||
        receipts.length !== 1 ||
        receipt.policy !== "preserve_existing" ||
        !sameSnapshot(current[0], receipt.after_data) ||
        !prior ||
        Number(current[0].account_id) !== Number(row.account_id) ||
        Number(prior.account_id) !== Number(row.account_id) ||
        Number(prior.investment_id) !== Number(row.investment_id) ||
        prior.type !== row.type ||
        current[0].type !== row.type ||
        current[0].date !== row.tx_date ||
        !equalNumber(current[0].units, row.units, 8) ||
        !priorProofs.has(Number(prior.id)) ||
        prior.source_record_hash !== row.source_record_hash ||
        prior.dedup_fingerprint !== row.dedup_fingerprint ||
        priorProofs.get(Number(prior.id)).sourceFileHash !==
          proofs.get(action.rowId).sourceFileHash
      ) {
        if (current[0]?.import_batch_id == null)
          blockers.push({
            batchId: Number(row.batch_id),
            rowId: Number(row.id),
            rowOrdinal: row.row_index + 1,
            reason: "adoption_scope_receipt_changed",
            candidateTransactionIds: current.map((item) => Number(item.id)),
          });
        continue;
      }
      selected.push({
        ...action,
        existingTransactionId: Number(current[0].id),
      });
    }
  }
  return boundedKinesisPlanResult(
    full,
    rows,
    batches,
    context,
    proofs,
    selected,
    adoptions,
    blockers,
    "adopt_existing_only",
  );
}

/**
 * @param {ReconciliationPlanResult} full
 * @param {ReconciliationSourceRow[]} rows
 * @param {ReconciliationBatchScopeRow[]} batches
 * @param {object} context the scope's evidence context, bound into the fingerprint
 * @param {Map<number, RowProofBinding>} proofs
 * @param {PlanAction[]} selected
 * @param {PlanAdoption[]} adoptions
 * @param {PlanIssue[]} blockers
 * @param {string} scope
 */
function boundedKinesisPlanResult(
  full,
  rows,
  batches,
  context,
  proofs,
  selected,
  adoptions,
  blockers,
  scope,
) {
  const selectedTransactionIds = new Set(
    selected.map((action) => action.existingTransactionId),
  );
  for (const issue of full.plan.blockers)
    if (
      issue.candidateTransactionIds.some((id) =>
        selectedTransactionIds.has(id),
      ) &&
      !blockers.includes(issue)
    )
      blockers.push(issue);
  const selectedRowIds = selected.map((action) => action.rowId);
  const selectedIds = new Set(selectedRowIds);
  const deferred = rows.filter(
    (row) =>
      !selectedIds.has(Number(row.id)) &&
      !["committed", "duplicate"].includes(row.status),
  );
  /** @type {Record<string, number>} */
  const deferredCounts = {};
  for (const row of deferred) {
    const kind = [
      "cash",
      "asset_transfer",
      "asset_adjustment",
      "account_internal",
    ].includes(row.route)
      ? row.route
      : row.type || "unsupported";
    deferredCounts[kind] = (deferredCounts[kind] ?? 0) + 1;
  }
  const batchProgress = batches.map((batch) => {
    const pending = deferred.filter(
      (row) => Number(row.batch_id) === Number(batch.id),
    );
    /** @type {Record<string, number>} */
    const counts = {};
    for (const row of pending) {
      const kind = [
        "cash",
        "asset_transfer",
        "asset_adjustment",
        "account_internal",
      ].includes(row.route)
        ? row.route
        : row.type || "unsupported";
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return {
      batchId: Number(batch.id),
      pending: pending.length,
      complete: pending.length === 0,
      deferredCounts: counts,
    };
  });
  return {
    ...full,
    adoptions,
    companions: /** @type {ReconciliationPlanResult["companions"]} */ ([]),
    plan: {
      ...full.plan,
      actions: selected,
      blockers,
      ready: blockers.length === 0,
      reconciliationScope: scope,
      selectedRowIds,
      pending: deferred.length,
      complete: deferred.length === 0,
      deferredCounts,
      batchProgress,
      summary: Object.fromEntries(
        Object.keys(full.plan.summary).map((kind) => [
          kind,
          selected.filter((action) => action.action === kind).length,
        ]),
      ),
      planFingerprint: fingerprint({
        full: full.plan.planFingerprint,
        context,
        scope,
        selected,
        bindings: selectedRowIds.map((id) => ({
          rowId: id,
          eventKey: proofs.get(id).eventKey,
          sourceFileHash: proofs.get(id).sourceFileHash,
        })),
        deferredCounts,
      }),
    },
  };
}

function scopeIds(batchIds) {
  if (
    !Array.isArray(batchIds) ||
    batchIds.length === 0 ||
    batchIds.length > 100 ||
    batchIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw new ValidationError(
      "batch_ids must contain 1 to 100 positive import batch IDs",
    );
  return [...new Set(batchIds)].sort((left, right) => left - right);
}

/**
 * @param {number[]} batchIds
 * @param {string | undefined} adoptPolicy
 * @param {BatchPolicy[]} [batchPolicies]
 * @param {string} [reconciliationScope]
 * @param {string} [cashFundingPolicy]
 */
async function loadPlan(
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
) {
  const ids = scopeIds(batchIds);
  const [batches, rows] = await Promise.all([
    readReconciliationBatchScope(ids),
    readReconciliationSources(ids),
  ]);
  if (batches.length !== ids.length)
    throw new ValidationError(
      "Reconciliation scope contains a missing import batch",
    );
  if (
    ["record_in_kind_income_only", "record_cash_only"].includes(
      reconciliationScope,
    )
  ) {
    const terminal = batches.find(
      (batch) =>
        !["awaiting_review", "matching", "complete_with_errors"].includes(
          batch.status,
        ),
    );
    if (terminal)
      throw new ValidationError(
        `Batch ${terminal.id} is not in a reviewable state (status: ${terminal.status})`,
      );
  }
  await Promise.all(
    rows
      .filter((row) => row.asset_adjustment_details?.kind === "yield_reversal")
      .map(async (row) => {
        const hashes = await getEligibleYieldSourceHashes(
          Number(row.investment_id),
          Number(row.asset_adjustment_details.accountId ?? row.account_id),
        );
        row.asset_adjustment_details = {
          ...row.asset_adjustment_details,
          eligibleSourceRecordHashes: hashes,
        };
      }),
  );
  const history = await readReconciliationHistory([
    ...new Set(rows.map((row) => Number(row.investment_id)).filter(Boolean)),
  ]);
  const priorProAccounts = await readReconciledProImportAccounts([
    ...new Set(
      batches.map((batch) => batch.account_id).filter((id) => id != null),
    ),
  ]);
  const repairContext = await readDuplicateRepairContext(history);
  const saxoAdoptionContext = await readSaxoAdoptionContext(history);
  const fullKinesis =
    reconciliationScope === "full" &&
    batches.some((batch) => formatOf(batch) === "kinesis_transaction_history");
  const kinesisAdoptionContext =
    reconciliationScope !== "full" || fullKinesis
      ? reconciliationScope === "record_in_kind_income_only" || fullKinesis
        ? await readKinesisIncomeUnitContext(history)
        : await readKinesisAdoptionContext(history)
      : { receipts: [], sources: [], batches: [] };
  const incomeRecognitionContext =
    reconciliationScope === "record_in_kind_income_only" || fullKinesis
      ? await readIncomeRecognitionContext(history)
      : { receipts: [], sources: [], batches: [] };
  const cashContext =
    reconciliationScope === "record_cash_only" || fullKinesis
      ? await readKinesisCashContext()
      : /** @type {CashContext} */ ({ ledger: [], sources: [], batches: [] });
  const networkContext = fullKinesis
    ? await readKinesisNetworkContext(history)
    : { sources: [], batches: [] };
  const nativeGiftContext =
    reconciliationScope === "full"
      ? await readKinesisNativeGiftContext(history)
      : { receipts: [], sources: [], batches: [] };
  const historicalFxContext = [];
  if (reconciliationScope === "correct_existing_only") {
    const pairs = new Map();
    for (const row of rows) {
      const basis = verifiedPortfolioPerformanceBasisReference(row);
      if (
        !basis?.meaningful ||
        row.fx_rate_to_eur != null ||
        row.currency === "EUR" ||
        !history.some(
          (current) =>
            Number(current.investment_id) === Number(row.investment_id) &&
            current.type === row.type &&
            current.date === row.tx_date &&
            equalNumber(current.units, row.units, 8) &&
            ("currency" in current ? current.currency : undefined) !==
              row.currency &&
            toDecimal(current.amount ?? 0).gt("0.01"),
        )
      )
        continue;
      pairs.set(`${row.currency}:${row.tx_date}`, {
        currency: row.currency,
        date: row.tx_date,
      });
    }
    for (const pair of [...pairs.values()].sort((left, right) =>
      `${left.currency}:${left.date}`.localeCompare(
        `${right.currency}:${right.date}`,
      ),
    )) {
      const rate = await getStoredRateToEurOnOrBefore(pair.currency, pair.date);
      historicalFxContext.push({
        ...pair,
        rate:
          rate != null && Number.isFinite(rate) && rate > 0
            ? String(rate)
            : null,
      });
    }
  }
  if (
    fullKinesis ||
    ["record_in_kind_income_only", "record_cash_only"].includes(
      reconciliationScope,
    )
  ) {
    const fullSources = fullKinesis
      ? proveKinesisCorrectionSources(
          rows.filter((row) => formatOf(row) === "kinesis_transaction_history"),
          batches.filter(
            (batch) => formatOf(batch) === "kinesis_transaction_history",
          ),
        )
      : undefined;
    const proved = fullKinesis
      ? {
          records: rows
            .filter(
              (row) =>
                (row.route === "cash" ||
                  (row.type === "dividend" &&
                    row.source_transaction_id?.endsWith(":income"))) &&
                fullSources.literalProofs.has(Number(row.id)),
            )
            .map((row) => ({ row })),
          duplicates:
            /** @type {Array<{ row: ReconciliationSourceRow }>} */ ([]),
        }
      : reconciliationScope === "record_cash_only"
        ? {
            records: proveKinesisCashSources(
              rows,
              batches,
              cashFundingPolicy,
            ).groups.flatMap((group) => group.members),
            duplicates: [],
          }
        : proveKinesisIncomePairs({
            rows,
            batches,
            history,
            context: kinesisAdoptionContext,
            incomeContext: incomeRecognitionContext,
          });
    const pairs = new Map();
    for (const { row } of [...proved.records, ...proved.duplicates])
      if (row.currency !== "EUR")
        pairs.set(`${row.currency}:${row.tx_date}`, {
          currency: row.currency,
          date: row.tx_date,
        });
    const ordered = [...pairs.values()].sort((a, b) =>
      `${a.currency}:${a.date}`.localeCompare(`${b.currency}:${b.date}`),
    );
    // A stale prior quote must not suppress normal historical backfill.
    const missingDates = new Map();
    for (const pair of ordered) {
      const rate = await getStoredRateToEurOnOrBefore(pair.currency, pair.date);
      if (rate != null && Number.isFinite(rate) && rate > 0) continue;
      if (!missingDates.has(pair.currency)) missingDates.set(pair.currency, []);
      missingDates.get(pair.currency).push(pair.date);
    }
    await getUnindexedRatesToEurForDates(missingDates);
    for (const pair of ordered) {
      const rate = await getStoredRateToEurOnOrBefore(pair.currency, pair.date);
      historicalFxContext.push({
        ...pair,
        rate:
          rate != null && Number.isFinite(rate) && rate > 0
            ? String(rate)
            : null,
      });
    }
  }
  const referenceOriginalBatchIds = [
    ...new Set(
      batches.flatMap(
        (batch) =>
          batch.custom_config?.portfolio_performance_reference
            ?.originalBatchIds || [],
      ),
    ),
  ].sort((a, b) => a - b);
  const referenceOriginalRows = referenceOriginalBatchIds.length
    ? await readReconciliationSources(referenceOriginalBatchIds)
    : [];
  return {
    ...buildPortfolioImportReconciliationPlan({
      rows,
      history,
      batches,
      adoptPolicy,
      batchPolicies,
      priorProAccounts,
      referenceOriginalRows,
      repairContext,
      saxoAdoptionContext,
      kinesisAdoptionContext,
      historicalFxContext,
      incomeRecognitionContext,
      cashContext,
      cashFundingPolicy,
      networkContext,
      nativeGiftContext,
      reconciliationScope,
    }),
    history,
    rows,
    referenceOriginalBatchIds,
    priorSaxoBatchIds: saxoAdoptionContext.batches.map((batch) =>
      Number(batch.id),
    ),
    priorCashBatchIds: cashContext.batches.map((batch) => Number(batch.id)),
    priorNetworkBatchIds: [
      ...new Set(
        [...networkContext.batches, ...nativeGiftContext.batches].map((batch) =>
          Number(batch.id),
        ),
      ),
    ],
    priorIncomeBatchIds: incomeRecognitionContext.batches.map((batch) =>
      Number(batch.id),
    ),
    priorKinesisBatchIds: kinesisAdoptionContext.batches.map((batch) =>
      Number(batch.id),
    ),
  };
}

/**
 * @param {object} options
 * @param {number[]} options.batchIds
 * @param {string} [options.adoptPolicy]
 * @param {BatchPolicy[]} [options.batchPolicies]
 * @param {string} [options.reconciliationScope]
 * @param {string} [options.cashFundingPolicy]
 */
export async function previewPortfolioImportReconciliation({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
}) {
  return withTransaction(async () => {
    const loaded = await loadPlan(
      batchIds,
      adoptPolicy,
      batchPolicies,
      reconciliationScope,
      cashFundingPolicy,
    );
    if (loaded.plan.ready) {
      try {
        assertProjectedHistory(
          loaded.history,
          projectedReconciliationHistory(loaded),
        );
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        const row =
          loaded.rows.find((source) =>
            ["asset_transfer", "asset_adjustment"].includes(source.route),
          ) ?? loaded.rows[0];
        loaded.plan.blockers.push({
          batchId: Number(row?.batch_id ?? batchIds[0]),
          rowId: Number(row?.id ?? 0),
          rowOrdinal: Number(row?.row_index ?? 0) + 1,
          reason: "projected_history_conflict",
          candidateTransactionIds: [],
        });
        loaded.plan.ready = false;
      }
    }
    return loaded.plan;
  });
}

function assertProjectedHistory(before, after) {
  const investmentIds = new Set(
    [...before, ...after].map((row) => Number(row.investment_id)),
  );
  for (const investmentId of investmentIds) {
    // Unchanged rows are shared by both projections. Read each timeline once,
    // rather than duplicating their custody events through object identity.
    const beforeRows = before.filter(
      (row) => Number(row.investment_id) === investmentId,
    );
    const afterRows = after.filter(
      (row) => Number(row.investment_id) === investmentId,
    );
    validatePortfolioAssetTransferHistory(afterRows);
    const prior = partitionOversellDeficits(beforeRows);
    const next = partitionOversellDeficits(afterRows);
    for (const [accountId, deficit] of next)
      if (deficit - (prior.get(accountId) ?? 0) > 1e-8)
        throw new ConflictError(
          "Reconciliation would create or worsen an oversold portfolio partition",
          { details: { reason: "projected_history_conflict" } },
        );
  }
}

/**
 * @param {object} input
 * @param {Pick<ReconciliationPlan, "actions">} input.plan
 * @param {PlanAdoption[]} input.adoptions
 * @param {ReconciliationHistoryEvent[]} input.history
 * @param {ReconciliationSourceRow[]} input.rows
 * @param {Map<number, ReconciliationSourceRow>} [input.sourceOverrides]
 */
function projectedReconciliationHistory({
  plan,
  adoptions,
  history,
  rows,
  sourceOverrides = new Map(),
}) {
  const replacements = new Map(
    adoptions.map((item) => [Number(item.before.id), item.after]),
  );
  const proposedActions = plan.actions
    .filter((action) =>
      ["insert", "transfer", "adjustment"].includes(action.action),
    )
    .map((action) => ({
      action,
      row:
        sourceOverrides.get(action.rowId) ??
        rows.find((row) => Number(row.id) === action.rowId),
    }))
    .sort(
      (left, right) =>
        left.row.tx_date.localeCompare(right.row.tx_date) ||
        Number(left.row.batch_id) - Number(right.row.batch_id) ||
        left.row.row_index - right.row.row_index,
    );
  const proposed = proposedActions.map(({ action, row }, index) => ({
    ...(action.action === "transfer"
      ? previewPortfolioAssetTransfer(row).event
      : action.action === "adjustment"
        ? previewPortfolioAssetAdjustment(row, undefined, { sourceRows: rows })
            .event
        : {
            ...action.source,
            investment_id: action.investmentId,
            account_id: row.account_id ?? null,
            source_record_hash: row.source_record_hash,
          }),
    // Both event tables share a sequence, so reflect their actual writer order.
    id: Number.MAX_SAFE_INTEGER - proposedActions.length + index,
  }));
  const removedCopies = new Set(
    adoptions
      .filter((item) => item.imported)
      .map((item) => Number(item.imported.id)),
  );
  return [
    ...history
      .filter((row) => !removedCopies.has(Number(row.id)))
      .map((row) => replacements.get(Number(row.id)) ?? row),
    ...proposed,
  ];
}

/**
 * Caller holds every selected batch lock, then account and portfolio writer locks.
 * @param {object} options
 * @param {number[]} options.batchIds
 * @param {string} [options.adoptPolicy]
 * @param {BatchPolicy[]} [options.batchPolicies]
 * @param {string} [options.expectedPlanFingerprint]
 * @param {number[]} [options.lockedBatchIds]
 * @param {string} [options.reconciliationScope]
 * @param {string} [options.cashFundingPolicy]
 */
export async function applyPortfolioImportReconciliation({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  expectedPlanFingerprint,
  lockedBatchIds = batchIds,
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
}) {
  const {
    plan,
    adoptions,
    companions,
    history,
    rows,
    priorSaxoBatchIds,
    priorKinesisBatchIds,
    priorIncomeBatchIds,
    incomeRecords = [],
    cashRecords = [],
    priorCashBatchIds = [],
    priorNetworkBatchIds = [],
    sourceOverrides = new Map(),
    networkBindings = [],
    nativeGiftGroups = [],
  } = await loadPlan(
    batchIds,
    adoptPolicy,
    batchPolicies,
    reconciliationScope,
    cashFundingPolicy,
  );
  if (
    expectedPlanFingerprint !== undefined &&
    expectedPlanFingerprint !== plan.planFingerprint
  )
    throw new ConflictError(
      "Portfolio history or source selection changed. Review the reconciliation plan again.",
      { details: { reason: "stale_reconciliation_plan" } },
    );
  if (
    (adoptPolicy !== undefined || plan.batchPolicies.length > 0) &&
    expectedPlanFingerprint === undefined
  )
    throw new ValidationError(
      "An explicit source policy requires expected_plan_fingerprint from its preview",
    );
  if (!plan.ready)
    throw new ConflictError(
      "Import needs reconciliation before any history can be changed",
      {
        details: { reason: "reconciliation_required", blockers: plan.blockers },
      },
    );
  if (
    priorNetworkBatchIds.some((id) => !lockedBatchIds.includes(id)) ||
    priorCashBatchIds.some((id) => !lockedBatchIds.includes(id)) ||
    priorSaxoBatchIds.some((id) => !lockedBatchIds.includes(id)) ||
    priorKinesisBatchIds.some((id) => !lockedBatchIds.includes(id)) ||
    priorIncomeBatchIds.some((id) => !lockedBatchIds.includes(id)) ||
    (await readReconciliationBatchScope(batchIds)).some((batch) =>
      (
        batch.custom_config?.portfolio_performance_reference
          ?.originalBatchIds || []
      ).some((id) => !lockedBatchIds.includes(Number(id))),
    ) ||
    adoptions.some(
      (item) =>
        (item.imported &&
          !lockedBatchIds.includes(Number(item.imported.import_batch_id))) ||
        (item.priorSaxoReceipt &&
          !lockedBatchIds.includes(Number(item.priorSaxoReceipt.batch_id))),
    )
  )
    throw new ConflictError(
      "Duplicate repair provenance changed. Review the source scope again.",
      { details: { reason: "stale_reconciliation_plan" } },
    );
  assertProjectedHistory(
    history,
    projectedReconciliationHistory({
      plan,
      adoptions,
      history,
      rows,
      sourceOverrides,
    }),
  );
  for (const binding of networkBindings)
    if (!(await retainKinesisNetworkBinding(binding)))
      throw new ConflictError("Native custody source changed during import", {
        details: { reason: "stale_reconciliation_plan" },
      });
  const recordedCashByBatch = new Map();
  for (const record of cashRecords) {
    // classifyKinesisCash returns only grouped members, which carry their proof.
    const recorded = await recordKinesisCash(
      /** @type {Parameters<typeof recordKinesisCash>[0]} */ (record),
    );
    const id = Number(record.row.batch_id);
    recordedCashByBatch.set(
      id,
      (recordedCashByBatch.get(id) ?? 0) + recorded.recordedCash,
    );
  }
  const recordedIncomeByBatch = new Map();
  for (const record of reconciliationScope === "full" ? [] : incomeRecords) {
    await recordPairedPortfolioIncome(record);
    const batchId = Number(record.row.batch_id);
    recordedIncomeByBatch.set(
      batchId,
      (recordedIncomeByBatch.get(batchId) ?? 0) + 1,
    );
  }
  const adoptedByBatch = new Map();
  const repairedByBatch = new Map();
  const companionsByBatch = new Map();
  for (const { row } of companions) {
    if (!(await markSaxoCompanionSourceDuplicate(row)))
      throw new ConflictError(
        "Saxo companion source changed during reconciliation",
        { details: { reason: "stale_reconciliation_plan" } },
      );
    companionsByBatch.set(
      Number(row.batch_id),
      (companionsByBatch.get(Number(row.batch_id)) ?? 0) + 1,
    );
  }
  for (const { row, before, after, policy, imported } of adoptions) {
    if (imported) {
      await applyDuplicatePortfolioRepair({
        row,
        before,
        after,
        policy,
        imported,
      });
      repairedByBatch.set(
        Number(row.batch_id),
        (repairedByBatch.get(Number(row.batch_id)) ?? 0) + 1,
      );
      continue;
    }
    const persisted = await compareAndSetReconciledTransaction(before, after);
    if (!persisted)
      throw new ConflictError(
        "An existing portfolio transaction changed during reconciliation",
        { details: { reason: "stale_existing_transaction" } },
      );
    await insertReconciliationReceipt({
      batchId: Number(row.batch_id),
      stagingRowId: Number(row.id),
      transactionId: Number(before.id),
      action: "adopt",
      policy,
      before,
      after: persisted,
    });
    await markAdoptedSourceDuplicate(Number(row.id), Number(row.batch_id));
    adoptedByBatch.set(
      Number(row.batch_id),
      (adoptedByBatch.get(Number(row.batch_id)) ?? 0) + 1,
    );
  }
  for (const action of plan.actions.filter(
    (action) =>
      action.action === "duplicate" &&
      (reconciliationScope !== "full" ||
        action.incomeProof ||
        action.cashProof ||
        sourceOverrides.has(action.rowId)),
  )) {
    await markAdoptedSourceDuplicate(action.rowId, action.batchId);
    companionsByBatch.set(
      action.batchId,
      (companionsByBatch.get(action.batchId) ?? 0) + 1,
    );
  }
  return {
    plan,
    adoptedByBatch,
    repairedByBatch,
    companionsByBatch,
    recordedIncomeByBatch,
    recordedCashByBatch,
    nativeGiftGroups,
    deferredIncomeRowIds:
      reconciliationScope === "full"
        ? incomeRecords.map((record) => Number(record.row.id))
        : [],
  };
}

/**
 * Unit writers have finished inside the same locked transaction; bind their actual images.
 * @param {object} options
 * @param {number[]} options.batchIds
 * @param {number[]} options.rowIds
 * @param {string} [options.adoptPolicy]
 * @param {BatchPolicy[]} [options.batchPolicies]
 */
export async function completePortfolioImportIncome({
  batchIds,
  rowIds,
  adoptPolicy,
  batchPolicies = [],
}) {
  if (!rowIds.length) return new Map();
  const loaded = await loadPlan(batchIds, adoptPolicy, batchPolicies);
  const selected = new Set(rowIds);
  const records = (loaded.incomeRecords ?? []).filter((record) =>
    selected.has(Number(record.row.id)),
  );
  if (
    !loaded.plan.ready ||
    records.length !== selected.size ||
    records.some((record) => record.plannedUnitRowId)
  )
    throw new ConflictError(
      "Paired acquisition changed during the complete import",
      {
        details: { reason: "stale_reconciliation_plan" },
      },
    );
  const counts = new Map();
  for (const record of records) {
    await recordPairedPortfolioIncome(record);
    const id = Number(record.row.batch_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Exact proved rows from the locked scope may bypass only source-readiness errors.
 * @param {object} options
 * @param {number[]} options.batchIds
 * @param {string} [options.adoptPolicy]
 * @param {BatchPolicy[]} [options.batchPolicies]
 * @param {string} [options.reconciliationScope]
 * @param {string} [options.cashFundingPolicy]
 */
export async function getPortfolioImportCompanionRowIds({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
}) {
  const { companions } = await loadPlan(
    batchIds,
    adoptPolicy,
    batchPolicies,
    reconciliationScope,
    cashFundingPolicy,
  );
  return companions.map(({ row }) => Number(row.id));
}

/**
 * Selection is derived from the complete source under the caller's locks.
 * @param {object} options
 * @param {number[]} options.batchIds
 * @param {string} [options.adoptPolicy]
 * @param {BatchPolicy[]} [options.batchPolicies]
 * @param {string} [options.reconciliationScope]
 * @param {string} [options.cashFundingPolicy]
 */
export async function getPortfolioImportScopedSelection({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
}) {
  const loaded = await loadPlan(
    batchIds,
    adoptPolicy,
    batchPolicies,
    reconciliationScope,
    cashFundingPolicy,
  );
  return loaded.plan;
}

/**
 * @param {object} options
 * @param {number[]} options.batchIds
 * @param {string} [options.adoptPolicy]
 * @param {BatchPolicy[]} [options.batchPolicies]
 * @param {string} [options.reconciliationScope]
 * @param {string} [options.cashFundingPolicy]
 */
export async function getPortfolioImportRepairBatchIds({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
}) {
  const loaded = await loadPlan(
    batchIds,
    adoptPolicy,
    batchPolicies,
    reconciliationScope,
    cashFundingPolicy,
  );
  return [
    ...new Set(
      loaded.adoptions
        .filter((item) => item.imported)
        .map((item) => Number(item.imported.import_batch_id))
        .concat(
          loaded.referenceOriginalBatchIds,
          loaded.priorSaxoBatchIds,
          loaded.priorKinesisBatchIds,
          loaded.priorIncomeBatchIds,
          loaded.priorCashBatchIds,
          loaded.priorNetworkBatchIds,
        ),
    ),
  ].sort((a, b) => a - b);
}

export async function validatePortfolioImportAdoptionRollback(
  batchId,
  removalRows,
) {
  const receipts = await getActiveAdoptionReceipts(batchId);
  const repairs = await getActiveDuplicateRepairReceipts(batchId);
  await validateDuplicatePortfolioRepairRollback(repairs);
  const sourceRows = await readReconciliationSources([batchId]);
  const history = await readReconciliationHistory([
    ...new Set([
      ...receipts.map((receipt) => receipt.before_data.investment_id),
      ...repairs.map((receipt) => receipt.before_data.legacy.investment_id),
      ...sourceRows.map((row) => Number(row.investment_id)).filter(Boolean),
      ...removalRows.map((row) => Number(row.investment_id)).filter(Boolean),
    ]),
  ]);
  for (const receipt of receipts) {
    const current = history.find(
      (row) => Number(row.id) === Number(receipt.transaction_id),
    );
    if (!sameSnapshot(current, receipt.after_data))
      throw new ConflictError(
        "An adopted portfolio transaction was changed. Rollback needs review.",
        { details: { reason: "adopted_transaction_changed" } },
      );
  }
  const removed = new Set(removalRows.map((row) => Number(row.id)));
  const restored = new Map(
    /** @type {Array<[number, any]>} */ ([
      ...receipts.map((receipt) => [
        Number(receipt.transaction_id),
        receipt.before_data,
      ]),
      ...repairs.map((receipt) => [
        Number(receipt.legacy_transaction_id),
        financialRepairImage(receipt.before_data.legacy),
      ]),
    ]),
  );
  assertProjectedHistory(history, [
    ...history
      .filter((row) =>
        ["asset_transfer", "asset_adjustment"].includes(row.type)
          ? Number(row.import_batch_id) !== batchId
          : !removed.has(Number(row.id)),
      )
      .map((row) => restored.get(Number(row.id)) ?? row),
    ...repairs.map((receipt) =>
      financialRepairImage(receipt.before_data.imported),
    ),
  ]);
  return receipts;
}

export async function restorePortfolioImportAdoptions(receipts) {
  for (const receipt of receipts) {
    const restored = await compareAndSetReconciledTransaction(
      receipt.after_data,
      receipt.before_data,
    );
    if (!restored)
      throw new ConflictError(
        "An adopted portfolio transaction changed during rollback",
        { details: { reason: "adopted_transaction_changed" } },
      );
    await insertReconciliationReceipt({
      batchId: Number(receipt.batch_id),
      stagingRowId: Number(receipt.staging_row_id),
      transactionId: Number(receipt.transaction_id),
      action: "restore",
      policy: receipt.policy,
      before: receipt.after_data,
      after: restored,
      previousEntryId: Number(receipt.id),
    });
  }
}

/**
 * Capture both canonical after-images in the retained literal group source.
 * @param {NativeGiftGroup[]} groups
 */
export async function completePortfolioImportNativeGiftGroups(groups) {
  for (const group of groups) {
    const ids = [
      ...new Set(group.members.map((row) => Number(row.investment_id))),
    ];
    const history = await readReconciliationHistory(ids);
    const sources = await readReconciliationSources([
      ...new Set(group.members.map((row) => Number(row.batch_id))),
    ]);
    const after = [];
    for (const member of group.members) {
      const current = history.filter(
        (row) =>
          row.dedup_fingerprint === member.dedup_fingerprint &&
          row.dedup_fingerprint_version === member.dedup_fingerprint_version,
      );
      const source = sources.find(
        (row) => Number(row.id) === Number(member.id),
      );
      if (
        current.length !== 1 ||
        !source ||
        !["duplicate", "committed"].includes(source.status) ||
        source.source_record_hash !== member.source_record_hash ||
        source.raw_data !== member.raw_data ||
        source.dedup_fingerprint !== member.dedup_fingerprint
      )
        throw new ConflictError("Native gift group changed during import", {
          details: { reason: "network_gift_receipt_changed" },
        });
      after.push(current[0]);
    }
    const receipt = { version: 1, proof: group.proof, after };
    for (const member of group.members)
      if (!(await retainKinesisNativeGiftReceipt(member, receipt)))
        throw new ConflictError("Native gift group changed during import", {
          details: { reason: "network_gift_receipt_changed" },
        });
  }
}
