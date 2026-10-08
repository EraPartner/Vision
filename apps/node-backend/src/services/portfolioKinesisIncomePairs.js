/** Literal paired income is descriptive when the proved acquisition already carries its gain. */
import { UNIT_BASED_ASSET_CLASSES } from "@vision/types/assetClasses";
import { toDecimal } from "../lib/money.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "./importIdentity.js";
import { portfolioPrimaryRawData } from "./portfolioPerformanceReferenceEvidence.js";
import { proveKinesisCorrectionSources } from "./portfolioKinesisAdoptionScope.js";
import { kinesisYieldReferenceDigest } from "./portfolioKinesisYieldGroups.js";

/**
 * @typedef {import('./portfolioKinesisAdoptionScope.js').KinesisSourceRow} KinesisSourceRow
 * @typedef {import('./portfolioKinesisAdoptionScope.js').KinesisBatchRow} KinesisBatchRow
 * @typedef {import('./portfolioKinesisAdoptionScope.js').KinesisSourceProof} KinesisSourceProof
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationReceiptContext} ReconciliationReceiptContext
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').PortfolioTransactionSnapshot} PortfolioTransactionSnapshot
 * @typedef {import('../lib/money.ts').DecimalInput} DecimalInput
 */
/**
 * Canonical history; income snapshots keep a non-standard recognition role.
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationHistoryEvent & { income_recognition_role?: "standard" | "included_in_units" }} KinesisHistoryEvent
 */
/**
 * A row of `portfolio_import_income_recognition_journal` (migration 0124).
 * @typedef {object} IncomeRecognitionReceipt
 * @property {string} id
 * @property {string} batch_id
 * @property {string} staging_row_id
 * @property {string} unit_staging_row_id
 * @property {number} income_transaction_id
 * @property {number} unit_transaction_id
 * @property {"record"|"restore"} action
 * @property {string|null} previous_entry_id
 * @property {Record<string, unknown>} income_data
 * @property {Record<string, unknown>} unit_data
 * @property {Record<string, unknown>} proof_data
 * @property {Date} created_at
 */
/**
 * @typedef {object} IncomeRecognitionContext
 * @property {IncomeRecognitionReceipt[]} receipts
 * @property {KinesisSourceRow[]} sources
 * @property {KinesisBatchRow[]} batches
 */
/**
 * A gift acquisition the same plan inserts or adopts.
 * @typedef {object} PlannedIncomeUnit
 * @property {string} action
 * @property {KinesisSourceRow} row
 * @property {KinesisHistoryEvent} after
 */

/**
 * @param {DecimalInput} a
 * @param {DecimalInput} b
 */
const equal = (a, b, places = 8) =>
  a == null || b == null
    ? a == null && b == null
    : toDecimal(a)
        .toDecimalPlaces(places, 4)
        .eq(toDecimal(b).toDecimalPlaces(places, 4));
/** @param {{ amount?: DecimalInput, price_per_unit?: DecimalInput, fees?: DecimalInput, taxes?: DecimalInput }} row */
const zero = (row) =>
  /** @type {const} */ (["amount", "price_per_unit", "fees", "taxes"]).every(
    (key) => toDecimal(row[key] ?? 0).eq(0),
  );
/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export const normalizeIncomeSnapshot = (row) => {
  const { income_recognition_role: role, ...rest } = row;
  return role == null || role === "standard"
    ? rest
    : { ...rest, income_recognition_role: role };
};
/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
const sameImage = (a, b) =>
  kinesisYieldReferenceDigest(normalizeIncomeSnapshot(a)) ===
  kinesisYieldReferenceDigest(normalizeIncomeSnapshot(b));
/** @param {KinesisSourceRow} row */
const identityMatches = (row) => {
  const identity = assignImportIdentities([row], (source) =>
    portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }),
  )[0];
  return (
    row.dedup_fingerprint === identity.fingerprint &&
    row.dedup_fingerprint_version === identity.version &&
    Number(row.dedup_occurrence) === identity.occurrence
  );
};
/**
 * @param {KinesisSourceRow} a
 * @param {KinesisSourceRow} b
 * @param {KinesisSourceProof|undefined} proofA
 * @param {KinesisSourceProof|undefined} proofB
 */
const samePrimary = (a, b, proofA, proofB) =>
  a.source_record_hash === b.source_record_hash &&
  a.source_transaction_id === b.source_transaction_id &&
  a.source_account_identity === b.source_account_identity &&
  a.dedup_fingerprint === b.dedup_fingerprint &&
  a.dedup_fingerprint_version === b.dedup_fingerprint_version &&
  Number(a.account_id) === Number(b.account_id) &&
  Number(a.investment_id) === Number(b.investment_id) &&
  portfolioPrimaryRawData(a.raw_data) === portfolioPrimaryRawData(b.raw_data) &&
  proofA?.sourceFileHash === proofB?.sourceFileHash;

/** Classify only after the entire original source and full canonical history have been loaded.
 * @param {{
 *   rows: KinesisSourceRow[],
 *   batches: KinesisBatchRow[],
 *   history: KinesisHistoryEvent[],
 *   context: ReconciliationReceiptContext,
 *   incomeContext?: IncomeRecognitionContext,
 *   plannedUnits?: PlannedIncomeUnit[],
 * }} input
 */
export function proveKinesisIncomePairs({
  rows,
  batches,
  history,
  context,
  incomeContext = { receipts: [], sources: [], batches: [] },
  plannedUnits = [],
}) {
  const evidence = proveKinesisCorrectionSources(rows, batches);
  const retained = proveKinesisCorrectionSources(
    context.sources,
    context.batches,
  );
  const oldIncome = proveKinesisCorrectionSources(
    incomeContext.sources,
    incomeContext.batches,
  );
  const records = [];
  const duplicates = [];
  const proofs = new Map();
  const blockers = [...evidence.issues];
  for (const row of rows) {
    const proof = evidence.literalProofs.get(Number(row.id));
    if (
      !proof ||
      proof.parsed.typeRaw !== "Dividend" ||
      !row.source_transaction_id?.endsWith(":income")
    )
      continue;
    /**
     * @param {string} reason
     * @param {(number|string)[]} [ids]
     */
    const issue = (reason, ids = []) =>
      blockers.push({
        reason,
        batchId: Number(row.batch_id),
        rowId: Number(row.id),
        rowOrdinal: row.row_index + 1,
        candidateTransactionIds: ids.map(Number),
      });
    const paired = rows.filter(
      (unit) =>
        unit.source_transaction_id ===
          row.source_transaction_id.replace(/:income$/, ":units") &&
        unit.source_record_hash === row.source_record_hash &&
        Number(unit.batch_id) === Number(row.batch_id),
    );
    const unit = paired[0],
      unitProof = evidence.proofs.get(Number(unit?.id));
    if (
      paired.length !== 1 ||
      !unitProof ||
      unitProof.parsed.assetAdjustment?.kind !== "yield_acquisition" ||
      unitProof.parsed.assetAdjustment.basisPolicy !== "zero"
    )
      continue;
    if (
      !(
        /** @type {readonly string[]} */ (UNIT_BASED_ASSET_CLASSES).includes(
          row.asset_class,
        )
      ) ||
      row.route !== "portfolio" ||
      row.type !== "dividend" ||
      row.type_raw !== "Dividend" ||
      unit.route !== "portfolio" ||
      unit.type !== "gift" ||
      !zero(unit) ||
      row.units != null ||
      row.price_per_unit != null ||
      !toDecimal(row.fees ?? 0).eq(0) ||
      !toDecimal(row.taxes ?? 0).eq(0) ||
      row.fx_rate_to_eur != null ||
      !toDecimal(proof.parsed.amount ?? 0).gt(0) ||
      !equal(row.amount, proof.parsed.amount, 4) ||
      row.currency !== proof.parsed.currency ||
      row.note !== proof.parsed.note ||
      Number(row.account_id) !== Number(unit.account_id) ||
      Number(row.investment_id) !== Number(unit.investment_id) ||
      row.tx_date !== unit.tx_date ||
      proof.parsed.currency !== unitProof.parsed.currency ||
      !identityMatches(row) ||
      !identityMatches(unit)
    ) {
      issue("paired_income_source_changed");
      continue;
    }
    const claims = rows.filter(
      (candidate) =>
        candidate.type === "dividend" &&
        candidate.dedup_fingerprint === row.dedup_fingerprint,
    );
    if (claims.length !== 1) {
      issue("paired_income_ambiguous_source");
      continue;
    }
    const units = history.filter(
      (current) =>
        current.dedup_fingerprint === unit.dedup_fingerprint &&
        current.dedup_fingerprint_version === unit.dedup_fingerprint_version &&
        Number(current.investment_id) === Number(unit.investment_id),
    );
    const planned = plannedUnits.filter(
      (item) => Number(item.row.id) === Number(unit.id),
    );
    if (units.length === 0 && planned.length === 0) continue;
    if (
      units.length > 1 ||
      planned.length > 1 ||
      (units.length && planned.length)
    ) {
      issue(
        "paired_income_ambiguous_acquisition",
        units.map((item) => item.id),
      );
      continue;
    }
    const plannedUnit = planned[0];
    const current = units[0] ?? plannedUnit.after;
    if (
      current.type !== "gift" ||
      !zero(current) ||
      !equal(current.units, unit.units) ||
      current.date !== unit.tx_date ||
      Number(current.account_id) !== Number(unit.account_id) ||
      current.source_record_hash !== unit.source_record_hash ||
      (current.income_recognition_role ?? "standard") !== "standard"
    ) {
      issue("paired_income_acquisition_changed", [current.id]);
      continue;
    }
    const receipts = context.receipts.filter(
      (receipt) => Number(receipt.transaction_id) === Number(current.id),
    );
    /** @type {KinesisSourceRow|undefined} */
    let prior;
    if (plannedUnit) {
      if (
        !["insert", "adopt"].includes(plannedUnit.action) ||
        Number(plannedUnit.row.batch_id) !== Number(row.batch_id) ||
        plannedUnit.row.dedup_fingerprint !== unit.dedup_fingerprint ||
        plannedUnit.row.source_record_hash !== unit.source_record_hash
      ) {
        issue("paired_income_acquisition_changed", [current.id]);
        continue;
      }
      prior = unit;
    } else if (current.import_batch_id == null) {
      const receipt = receipts[0];
      prior =
        receipt &&
        context.sources.find(
          (source) => Number(source.id) === Number(receipt.staging_row_id),
        );
      const priorProof = retained.proofs.get(Number(prior?.id));
      if (
        receipts.length !== 1 ||
        !prior ||
        !priorProof ||
        retained.issues.some(
          (issue) => issue.batchId === Number(prior.batch_id),
        ) ||
        !sameImage(current, receipt.after_data) ||
        prior.status !== "duplicate" ||
        !samePrimary(prior, unit, priorProof, unitProof) ||
        !["exact", "preserve_existing", "prefer_source"].includes(
          receipt.policy,
        )
      ) {
        issue("paired_income_acquisition_changed", [current.id]);
        continue;
      }
    } else {
      const candidates = context.sources.filter(
        (source) =>
          Number(source.batch_id) === Number(current.import_batch_id) &&
          Number(source.committed_txn_id) === Number(current.id) &&
          source.status === "committed",
      );
      prior = candidates[0];
      const priorProof = retained.proofs.get(Number(prior?.id));
      if (
        candidates.length !== 1 ||
        !priorProof ||
        retained.issues.some(
          (issue) => issue.batchId === Number(prior?.batch_id),
        ) ||
        !samePrimary(prior, unit, priorProof, unitProof) ||
        !zero(prior) ||
        current.note !== prior.note ||
        current.currency !== prior.currency ||
        current.fx_rate_to_eur != null ||
        current.is_recurring
      ) {
        issue("paired_income_acquisition_changed", [current.id]);
        continue;
      }
    }
    const data = {
      sourceFileHash: proof.sourceFileHash,
      incomeEventKey: proof.eventKey,
      unitEventKey: unitProof.eventKey,
      retainedUnitEventKey: plannedUnit
        ? unitProof.eventKey
        : retained.proofs.get(Number(prior.id)).eventKey,
      unitReceiptId: receipts[0]?.id ?? null,
    };
    const existing = history.filter(
      (income) =>
        income.dedup_fingerprint === row.dedup_fingerprint &&
        income.dedup_fingerprint_version === row.dedup_fingerprint_version,
    );
    const active = incomeContext.receipts.filter(
      (receipt) => Number(receipt.unit_transaction_id) === Number(current.id),
    );
    if (existing.length || active.length) {
      const receipt = active[0],
        income = existing[0];
      const old =
        receipt &&
        incomeContext.sources.find(
          (source) => Number(source.id) === Number(receipt.staging_row_id),
        );
      if (
        existing.length !== 1 ||
        active.length !== 1 ||
        !income ||
        income.income_recognition_role !== "included_in_units" ||
        Number(receipt.income_transaction_id) !== Number(income.id) ||
        !sameImage(income, receipt.income_data) ||
        !sameImage(current, receipt.unit_data) ||
        !old ||
        !samePrimary(
          old,
          row,
          oldIncome.literalProofs.get(Number(old.id)),
          proof,
        ) ||
        oldIncome.issues.some((issue) => issue.batchId === Number(old.batch_id))
      ) {
        issue("paired_income_existing_changed", [
          current.id,
          ...existing.map((item) => item.id),
        ]);
        continue;
      }
      duplicates.push({ row, current: income, unit: current, proof: data });
      proofs.set(Number(row.id), proof);
      continue;
    }
    records.push({
      row,
      unit: current,
      unitSource: prior,
      proof: data,
      ...(plannedUnit ? { plannedUnitRowId: Number(unit.id) } : {}),
    });
    proofs.set(Number(row.id), proof);
  }
  return { records, duplicates, proofs, blockers };
}
