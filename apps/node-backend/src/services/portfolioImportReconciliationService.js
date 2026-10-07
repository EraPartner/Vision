/** One-to-one, reviewable adoption of existing portfolio history. */
import { createHash } from "node:crypto";
import { partitionOversellDeficits } from "@vision/shared-utils/portfolio";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";
import { withTransaction } from "../database/connection.ts";
import { toDecimal } from "../lib/money.ts";
import { normalizeTransactionPayload } from "./portfolio/portfolioTransactionRules.js";
import {
  getNexoProSpotReconciliationEvidence,
  nexoProSourceMoneyMatches,
} from "./portfolioImportPipeline/nexoProTransactionHistoryAdapter.js";
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
} from "./portfolio/portfolioAssetTransferService.js";
import { previewPortfolioAssetAdjustment } from "./portfolio/portfolioAssetAdjustmentService.js";
import { getEligibleYieldSourceHashes } from "../repositories/portfolioAssetAdjustmentRepository.js";
import {
  compareAndSetReconciledTransaction,
  getActiveAdoptionReceipts,
  insertReconciliationReceipt,
  markAdoptedSourceDuplicate,
  readReconciliationBatchScope,
  readReconciliationHistory,
  readReconciliationSources,
  readReconciledProImportAccounts,
} from "../repositories/portfolioImportReconciliationRepository.js";
import {
  readDuplicateRepairContext,
  getActiveDuplicateRepairReceipts,
} from "../repositories/portfolioImportDuplicateRepairRepository.js";
import {
  applyDuplicatePortfolioRepair,
  financialRepairImage,
  validateDuplicatePortfolioRepairRollback,
} from "./portfolioImportDuplicateRepairService.js";

const POLICIES = new Set(["preserve_existing", "prefer_source"]);
const UNIT_TYPES = new Set(["buy", "sell", "gift", "split"]);
const VALUE_FIELDS = [
  "date",
  "amount",
  "units",
  "price_per_unit",
  "fees",
  "taxes",
  "currency",
  "fx_rate_to_eur",
  "dividend_amount_convention",
];
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
  repairContext = {
    transactions: [],
    batches: [],
    staging: [],
    knownTransactionIds: [],
  },
}) {
  if (adoptPolicy !== undefined && !POLICIES.has(adoptPolicy))
    throw new ValidationError(
      "adopt_policy must be preserve_existing or prefer_source",
    );
  const canonicalPolicies = canonicalBatchPolicies(batchPolicies, batches);
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
  const prepared = [];
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
          (row) =>
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
  for (const row of rows) {
    if (["committed", "duplicate"].includes(row.status)) {
      actions.push({
        batchId: Number(row.batch_id),
        rowId: Number(row.id),
        rowOrdinal: row.row_index + 1,
        action: "settled",
      });
      continue;
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
          [
            "investment_id",
            "account_id",
            "date",
            "adjustment_kind",
            "basis_policy",
          ].every((field) => String(current[field]) === String(event[field])) &&
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
          [
            "investment_id",
            "source_account_id",
            "destination_account_id",
            "date",
          ].every((field) => String(current[field]) === String(event[field])) &&
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
    const candidates = history.filter((current) =>
      broadCandidate(row, source, current, proof),
    );
    prepared.push({ row, source, proof, candidates, baseAction });
  }
  const uses = new Map();
  for (const item of prepared)
    for (const candidate of item.candidates)
      uses.set(Number(candidate.id), (uses.get(Number(candidate.id)) ?? 0) + 1);
  for (const {
    row,
    source,
    proof,
    candidates,
    baseAction,
    imported,
  } of prepared) {
    const effectivePolicy = overrides.get(Number(row.batch_id)) ?? adoptPolicy;
    if (candidates.length === 0) {
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
      current.account_id != null ||
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
      zeroYieldIdentifiesLegacy(row, current);
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
    referenceOriginalRows,
  });
  return {
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

async function loadPlan(batchIds, adoptPolicy, batchPolicies = []) {
  const ids = scopeIds(batchIds);
  const [batches, rows] = await Promise.all([
    readReconciliationBatchScope(ids),
    readReconciliationSources(ids),
  ]);
  if (batches.length !== ids.length)
    throw new ValidationError(
      "Reconciliation scope contains a missing import batch",
    );
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
    }),
    history,
    rows,
    referenceOriginalBatchIds,
  };
}

export async function previewPortfolioImportReconciliation({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
}) {
  return withTransaction(async () => {
    const loaded = await loadPlan(batchIds, adoptPolicy, batchPolicies);
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

function projectedReconciliationHistory({ plan, adoptions, history, rows }) {
  const replacements = new Map(
    adoptions.map((item) => [Number(item.before.id), item.after]),
  );
  const proposedActions = plan.actions
    .filter((action) =>
      ["insert", "transfer", "adjustment"].includes(action.action),
    )
    .map((action) => ({
      action,
      row: rows.find((row) => Number(row.id) === action.rowId),
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

/** Caller holds every selected batch lock, then account and portfolio writer locks. */
export async function applyPortfolioImportReconciliation({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  expectedPlanFingerprint,
  lockedBatchIds = batchIds,
}) {
  const { plan, adoptions, history, rows } = await loadPlan(
    batchIds,
    adoptPolicy,
    batchPolicies,
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
    (await readReconciliationBatchScope(batchIds)).some((batch) =>
      (
        batch.custom_config?.portfolio_performance_reference
          ?.originalBatchIds || []
      ).some((id) => !lockedBatchIds.includes(Number(id))),
    ) ||
    adoptions.some(
      (item) =>
        item.imported &&
        !lockedBatchIds.includes(Number(item.imported.import_batch_id)),
    )
  )
    throw new ConflictError(
      "Duplicate repair provenance changed. Review the source scope again.",
      { details: { reason: "stale_reconciliation_plan" } },
    );
  assertProjectedHistory(
    history,
    projectedReconciliationHistory({ plan, adoptions, history, rows }),
  );
  const adoptedByBatch = new Map();
  const repairedByBatch = new Map();
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
  return { plan, adoptedByBatch, repairedByBatch };
}

export async function getPortfolioImportRepairBatchIds({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
}) {
  const loaded = await loadPlan(batchIds, adoptPolicy, batchPolicies);
  return [
    ...new Set(
      loaded.adoptions
        .filter((item) => item.imported)
        .map((item) => Number(item.imported.import_batch_id))
        .concat(loaded.referenceOriginalBatchIds),
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
    if (JSON.stringify(current) !== JSON.stringify(receipt.after_data))
      throw new ConflictError(
        "An adopted portfolio transaction was changed. Rollback needs review.",
        { details: { reason: "adopted_transaction_changed" } },
      );
  }
  const removed = new Set(removalRows.map((row) => Number(row.id)));
  const restored = new Map([
    ...receipts.map((receipt) => [
      Number(receipt.transaction_id),
      receipt.before_data,
    ]),
    ...repairs.map((receipt) => [
      Number(receipt.legacy_transaction_id),
      financialRepairImage(receipt.before_data.legacy),
    ]),
  ]);
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
