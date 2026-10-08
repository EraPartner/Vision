/** Closed original-document intervals bind a whole payment without a date window. */
import { createHash } from "node:crypto";
import { toDecimal } from "../lib/money.ts";
import { parseCsvText } from "./importPipeline/adapters/_shared.js";
import {
  portfolioPrimaryRawData,
  verifiedPortfolioPerformanceBasisReference,
} from "./portfolioPerformanceReferenceEvidence.js";
import { proveKinesisCorrectionSources } from "./portfolioKinesisAdoptionScope.js";

/**
 * @typedef {import('@vision/shared-utils/money').DecimalInput} DecimalInput
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationSourceRow} ReconciliationSourceRow
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationBatchScopeRow} ReconciliationBatchScopeRow
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationReceiptContext} ReconciliationReceiptContext
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').ReconciliationJournalRow} ReconciliationJournalRow
 * @typedef {import('../repositories/portfolioImportReconciliationRepository.ts').PortfolioTransactionSnapshot} PortfolioTransactionSnapshot
 * @typedef {import('./portfolioImportPipeline/portfolioGenericAdapter.js').ParsedPortfolioRow} ParsedPortfolioRow
 * @typedef {ReturnType<typeof proveKinesisCorrectionSources>} KinesisCorrectionEvidence
 */
/**
 * The history fields read here. Custody transfer and adjustment events carry
 * no cash columns, so those stay optional.
 * @typedef {object} KinesisYieldHistoryEntry
 * @property {number} id
 * @property {number} investment_id
 * @property {string} type
 * @property {string} date 'YYYY-MM-DD'
 * @property {string | null} [amount]
 * @property {string | null} units
 * @property {string | null} [price_per_unit]
 * @property {string | null} [fees]
 * @property {string | null} [taxes]
 * @property {string | null} [currency]
 * @property {string | null} [fx_rate_to_eur]
 * @property {number | null} [account_id]
 * @property {string | null} import_batch_id
 * @property {string | null} source_record_hash
 * @property {string | null} dedup_fingerprint
 * @property {number | null} dedup_fingerprint_version
 */
/**
 * One retained Portfolio Performance event (JSON evidence in batch config).
 * @typedef {object} KinesisYieldReferenceEvent
 * @property {string} id
 * @property {string} portfolioId
 * @property {string} securityId
 * @property {string} type
 * @property {string} date 'YYYY-MM-DD'
 * @property {string} shares
 * @property {{ sharesMinor: string, [key: string]: unknown }} literal
 */
/**
 * @typedef {object} KinesisYieldReference
 * @property {string} sourceHash
 * @property {KinesisYieldReferenceEvent[]} events
 */
/**
 * @typedef {object} KinesisYieldAccountMapping
 * @property {string} portfolioId
 * @property {number} accountId
 */
/**
 * @typedef {object} KinesisYieldRetained
 * @property {ReconciliationJournalRow} receipt
 * @property {ReconciliationSourceRow} prior
 */
/**
 * @typedef {object} KinesisYieldManifestMember
 * @property {number} canonicalId
 * @property {string} eventKey
 * @property {string | null} sourceHash
 * @property {string | null} sourceId
 * @property {string} referenceId
 * @property {string} recordedDate
 * @property {string} paymentDate
 * @property {string} units
 */
/**
 * @typedef {object} KinesisYieldManifest
 * @property {string} sourceFileHash
 * @property {string} referenceHash
 * @property {number} accountId
 * @property {number} investmentId
 * @property {string} portfolioId
 * @property {string} securityId
 * @property {string} lower
 * @property {string} upper
 * @property {{ canonicalId: number, receiptId: number, sourceHash: string | null, referenceId: string }[]} boundaries
 * @property {KinesisYieldManifestMember[]} members
 */
/**
 * @typedef {object} KinesisYieldMember
 * @property {ReconciliationSourceRow} row
 * @property {KinesisYieldHistoryEntry} current
 * @property {KinesisYieldHistoryEntry | PortfolioTransactionSnapshot} recorded
 * @property {KinesisYieldReferenceEvent} referenceEvent
 * @property {KinesisYieldRetained | undefined} retained
 * @property {{ eventKey: string, sourceFileHash: string, parsed: ParsedPortfolioRow }} proof
 */
/**
 * @typedef {object} KinesisYieldGroup
 * @property {string} key
 * @property {KinesisYieldManifest} manifest
 * @property {KinesisYieldMember[]} members
 */
/**
 * @typedef {object} KinesisYieldBlocker
 * @property {string} reason
 * @property {number[]} candidateTransactionIds
 * @property {number} [batchId]
 * @property {number} [rowId]
 * @property {number} [rowOrdinal]
 */
/**
 * `custom_config.portfolio_performance_reference.yieldGroupEvidence`.
 * @typedef {object} KinesisYieldGroupEvidence
 * @property {number} version
 * @property {KinesisYieldReference} reference
 * @property {string} referenceDigest
 * @property {KinesisYieldAccountMapping[]} accountMappings
 * @property {KinesisYieldManifest[]} manifests
 */
/**
 * @typedef {object} KinesisYieldGroupsResult
 * @property {KinesisYieldGroup[]} groups
 * @property {KinesisYieldBlocker[]} blockers
 * @property {Set<number>} reservedRowIds
 * @property {KinesisCorrectionEvidence} [evidence]
 * @property {KinesisYieldAccountMapping[]} [accountMappings]
 */

/**
 * @param {unknown} value
 * @returns {unknown}
 */
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              canonical(/** @type {Record<string, unknown>} */ (value)[key]),
            ]),
        )
      : value;
// PostgreSQL JSONB may reorder object keys without changing documentary facts.
/** @param {unknown} reference */
export const kinesisYieldReferenceDigest = (reference) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(reference)))
    .digest("hex");
/**
 * @param {DecimalInput} a
 * @param {DecimalInput} b
 * @param {number} [places]
 */
const equal = (a, b, places = 8) =>
  a != null &&
  b != null &&
  toDecimal(a)
    .toDecimalPlaces(places, 4)
    .eq(toDecimal(b).toDecimalPlaces(places, 4));
/**
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 */
const snapshotEqual = (a, b) =>
  JSON.stringify(Object.entries(a || {}).sort()) ===
  JSON.stringify(Object.entries(b || {}).sort());
/** @param {{ amount?: DecimalInput, price_per_unit?: DecimalInput, fees?: DecimalInput, taxes?: DecimalInput }} row */
const zero = (row) =>
  /** @type {const} */ (["amount", "price_per_unit", "fees", "taxes"]).every(
    (key) => toDecimal(row[key] ?? 0).eq(0),
  );
/**
 * @param {string} day
 * @param {string} lower
 * @param {string} upper
 */
const inside = (day, lower, upper) => day > lower && day < upper;
/**
 * @param {ReconciliationSourceRow} row
 * @param {KinesisYieldHistoryEntry} current
 */
const sourceMatches = (row, current) =>
  current.dedup_fingerprint === row.dedup_fingerprint &&
  current.dedup_fingerprint_version === row.dedup_fingerprint_version &&
  Number(current.investment_id) === Number(row.investment_id);

/** Strict retained receipt binding, including complete original-file proof.
 * @param {ReconciliationSourceRow} row
 * @param {KinesisYieldHistoryEntry} current
 * @param {ReconciliationReceiptContext} context
 * @param {KinesisCorrectionEvidence} evidence
 * @param {KinesisCorrectionEvidence} priorEvidence
 * @returns {KinesisYieldRetained | undefined}
 */
function retainedReceipt(row, current, context, evidence, priorEvidence) {
  const receipts = context.receipts.filter(
    (entry) => Number(entry.transaction_id) === Number(current.id),
  );
  if (receipts.length !== 1) return undefined;
  const receipt = receipts[0];
  const prior = context.sources.find(
    (item) => Number(item.id) === Number(receipt.staging_row_id),
  );
  const proof = priorEvidence.proofs.get(Number(prior?.id));
  if (
    !prior ||
    !proof ||
    priorEvidence.issues.some(
      (issue) => issue.batchId === Number(prior.batch_id),
    ) ||
    !["preserve_existing", "prefer_source", "exact"].includes(receipt.policy) ||
    !snapshotEqual(current, receipt.after_data) ||
    current.import_batch_id != null ||
    prior.status !== "duplicate" ||
    prior.route !== "portfolio" ||
    Number(prior.batch_id) !== Number(receipt.batch_id) ||
    Number(prior.account_id) !== Number(row.account_id) ||
    Number(current.account_id) !== Number(row.account_id) ||
    Number(prior.investment_id) !== Number(row.investment_id) ||
    prior.type !== row.type ||
    current.type !== row.type ||
    !sourceMatches(row, current) ||
    current.source_record_hash !== row.source_record_hash ||
    prior.source_record_hash !== row.source_record_hash ||
    prior.dedup_fingerprint !== row.dedup_fingerprint ||
    prior.dedup_fingerprint_version !== row.dedup_fingerprint_version ||
    !equal(current.units, row.units) ||
    portfolioPrimaryRawData(prior.raw_data) !==
      portfolioPrimaryRawData(row.raw_data) ||
    proof.sourceFileHash !==
      evidence.literalProofs.get(Number(row.id))?.sourceFileHash
  )
    return undefined;
  return { receipt, prior };
}

/**
 * @param {ReconciliationSourceRow} row
 * @param {KinesisYieldHistoryEntry[]} history
 * @param {ReconciliationReceiptContext} context
 * @param {KinesisCorrectionEvidence} evidence
 * @param {KinesisCorrectionEvidence} priorEvidence
 * @param {KinesisYieldReference} reference
 */
function nativeBoundary(
  row,
  history,
  context,
  evidence,
  priorEvidence,
  reference,
) {
  const candidates = history.filter((current) => sourceMatches(row, current));
  if (candidates.length !== 1) return undefined;
  const current = candidates[0];
  const retained = retainedReceipt(
    row,
    current,
    context,
    evidence,
    priorEvidence,
  );
  if (!retained) return undefined;
  const basis = verifiedPortfolioPerformanceBasisReference(retained.prior);
  const matches = reference.events.filter(
    (event) => event.id === basis?.transactionId,
  );
  const event = matches[0];
  if (
    !basis?.meaningful ||
    basis.basisPolicy !== "recorded_native" ||
    basis.sourceHash !== reference.sourceHash ||
    Number(basis.accountId) !== Number(row.account_id) ||
    current.date !== row.tx_date ||
    !toDecimal(current.amount ?? 0).gt("0.01") ||
    current.currency !== basis.currency ||
    !equal(current.amount, basis.amount, 4) ||
    !equal(
      current.price_per_unit,
      toDecimal(basis.amount).div(current.units),
      6,
    ) ||
    !toDecimal(current.fees ?? 0).eq(0) ||
    !toDecimal(current.taxes ?? 0).eq(0) ||
    (basis.currency !== "EUR" &&
      !equalNullable(current.fx_rate_to_eur, basis.fxRateToEur, 10)) ||
    matches.length !== 1 ||
    event.type !== "DELIVERY_INBOUND" ||
    event.portfolioId !== basis.portfolioId ||
    event.securityId !== basis.securityId ||
    event.date !== current.date ||
    !equal(event.shares, current.units) ||
    kinesisYieldReferenceDigest(event.literal) !==
      kinesisYieldReferenceDigest(basis.literal)
  )
    return undefined;
  return { row, current, ...retained, event };
}
/**
 * @param {DecimalInput} a
 * @param {DecimalInput} b
 * @param {number} places
 */
function equalNullable(a, b, places) {
  return a == null || b == null ? a == null && b == null : equal(a, b, places);
}

/** A corrected date retains the original XML witness in the immutable before-image.
 * @param {ReconciliationSourceRow} row
 * @param {KinesisYieldHistoryEntry} current
 * @param {KinesisYieldRetained | undefined} retained
 * @param {ReconciliationReceiptContext} context
 * @returns {KinesisYieldHistoryEntry | PortfolioTransactionSnapshot | undefined}
 */
function recordedMember(row, current, retained, context) {
  if (!retained) return current;
  const { receipt } = retained;
  const before = receipt.before_data;
  const metadata = new Set([
    "account_id",
    "source_record_hash",
    "dedup_fingerprint",
    "dedup_fingerprint_version",
  ]);
  if (receipt.policy === "preserve_existing")
    return Object.keys(current).every(
      (field) =>
        metadata.has(field) ||
        /** @type {Record<string, unknown>} */ (current)[field] ===
          /** @type {Record<string, unknown>} */ (before)[field],
    ) &&
      Object.keys(before).every(
        (field) =>
          metadata.has(field) ||
          /** @type {Record<string, unknown>} */ (current)[field] ===
            /** @type {Record<string, unknown>} */ (before)[field],
      )
      ? current
      : undefined;
  if (receipt.policy !== "prefer_source") return undefined;
  const batch = context.batches.find(
    (item) => Number(item.id) === Number(receipt.batch_id),
  );
  /** @type {KinesisYieldManifest[]} */
  const manifests =
    batch?.custom_config?.portfolio_performance_reference?.yieldGroupEvidence
      ?.manifests || [];
  const matches = manifests
    .flatMap((manifest) => manifest.members)
    .filter(
      (member) =>
        Number(member.canonicalId) === Number(current.id) &&
        member.sourceHash === row.source_record_hash &&
        member.sourceId === row.source_transaction_id &&
        member.paymentDate === row.tx_date &&
        member.recordedDate === receipt.before_data.date,
    );
  const allowed = new Set(["date", ...metadata]);
  if (
    matches.length !== 1 ||
    current.date !== row.tx_date ||
    before.date === current.date ||
    before.account_id != null ||
    before.import_batch_id != null ||
    before.dedup_fingerprint != null ||
    before.source_record_hash != null ||
    Object.keys(current).some(
      (field) =>
        !allowed.has(field) &&
        /** @type {Record<string, unknown>} */ (current)[field] !==
          /** @type {Record<string, unknown>} */ (before)[field],
    ) ||
    Object.keys(before).some(
      (field) =>
        !allowed.has(field) &&
        /** @type {Record<string, unknown>} */ (current)[field] !==
          /** @type {Record<string, unknown>} */ (before)[field],
    )
  )
    return undefined;
  return before;
}

/** No subset sums: every event between independently proved adjacent deposits participates.
 * @param {object} input
 * @param {ReconciliationSourceRow[]} input.rows
 * @param {ReconciliationBatchScopeRow[]} input.batches
 * @param {KinesisYieldHistoryEntry[]} input.history
 * @param {ReconciliationReceiptContext} input.context
 * @param {KinesisYieldReference} input.reference
 * @param {KinesisYieldAccountMapping[]} input.accountMappings
 */
export function buildKinesisYieldGroups({
  rows,
  batches,
  history,
  context,
  reference,
  accountMappings,
}) {
  const evidence = proveKinesisCorrectionSources(rows, batches);
  const priorEvidence = proveKinesisCorrectionSources(
    context.sources,
    context.batches,
  );
  /** @type {KinesisYieldGroup[]} */
  const groups = [];
  const provedMappings = new Map();
  const reservedRowIds = new Set();
  /** @type {KinesisYieldBlocker[]} */
  const blockers = [...evidence.issues];
  if (blockers.length) return { groups, blockers, evidence, reservedRowIds };
  const recordGroups = new Map();
  for (const row of rows) {
    const proof = evidence.literalProofs.get(Number(row.id));
    if (!proof) continue;
    const batch = batches.find(
      (item) => Number(item.id) === Number(row.batch_id),
    );
    const raw = portfolioPrimaryRawData(row.raw_data);
    let records;
    try {
      records = parseCsvText(raw, {
        columns: batch.custom_config.source_columns,
        relax_column_count: false,
      });
    } catch {
      continue;
    }
    if (records.length !== 1) continue;
    const key = `${row.batch_id}:${row.source_record_hash}`;
    if (!recordGroups.has(key))
      recordGroups.set(key, { literal: records[0], rows: [], proof });
    recordGroups.get(key).rows.push(row);
  }
  const records = [...recordGroups.values()];
  for (const batch of batches) {
    const scoped = records.filter(
      (item) => Number(item.rows[0].batch_id) === Number(batch.id),
    );
    const assets = new Set(
      scoped
        .filter((item) => item.literal.Transaction_Type === "Deposit")
        .map((item) => item.literal.Currency_Code),
    );
    for (const asset of assets) {
      const deposits = scoped
        .filter(
          (item) =>
            item.literal.Currency_Code === asset &&
            item.literal.Transaction_Type === "Deposit",
        )
        .sort((a, b) => a.proof.parsed.date - b.proof.parsed.date);
      for (let index = 1; index < deposits.length; index++) {
        const first = deposits[index - 1];
        const last = deposits[index];
        const lower = first.rows[0].tx_date;
        const upper = last.rows[0].tx_date;
        if (lower >= upper) continue;
        const interval = scoped.filter(
          (item) =>
            item.literal.Currency_Code === asset &&
            inside(item.rows[0].tx_date, lower, upper),
        );
        if (
          interval.length < 2 ||
          new Set(interval.map((item) => item.rows[0].tx_date)).size !== 1 ||
          interval.some(
            (item) =>
              !["Holder's_Distribution", "Velocity's_Distribution"].includes(
                item.literal.Transaction_Type,
              ),
          )
        )
          continue;
        const bounds = [first, last].map((item) => {
          const row = item.rows.find(
            (/** @type {ReconciliationSourceRow} */ candidate) =>
              candidate.type === "gift" && candidate.route === "portfolio",
          );
          return (
            row &&
            nativeBoundary(
              row,
              history,
              context,
              evidence,
              priorEvidence,
              reference,
            )
          );
        });
        if (bounds.some((bound) => !bound)) continue;
        const [start, end] = bounds;
        if (
          start.event.portfolioId !== end.event.portfolioId ||
          start.event.securityId !== end.event.securityId ||
          Number(start.row.investment_id) !== Number(end.row.investment_id) ||
          Number(start.row.account_id) !== Number(end.row.account_id)
        )
          continue;
        const mappings = accountMappings.filter(
          (item) => item.portfolioId === start.event.portfolioId,
        );
        if (
          mappings.length > 1 ||
          mappings.some(
            (item) => Number(item.accountId) !== Number(batch.account_id),
          )
        )
          continue;
        // Both native boundary envelopes independently bind the same routed account.
        const mapped = provedMappings.get(start.event.portfolioId);
        if (mapped != null && mapped !== Number(batch.account_id)) continue;
        provedMappings.set(start.event.portfolioId, Number(batch.account_id));
        for (const item of interval)
          for (const row of item.rows)
            if (row.type === "gift") reservedRowIds.add(Number(row.id));
        const witnessesById = new Map();
        for (const item of interval) {
          const row = item.rows.find(
            (/** @type {ReconciliationSourceRow} */ candidate) =>
              candidate.type === "gift",
          );
          const current =
            row && history.find((candidate) => sourceMatches(row, candidate));
          if (!current) continue;
          const retained = retainedReceipt(
            row,
            current,
            context,
            evidence,
            priorEvidence,
          );
          const recorded =
            retained && recordedMember(row, current, retained, context);
          if (recorded) witnessesById.set(Number(current.id), recorded);
        }
        const currentInterval = history.filter(
          (current) =>
            Number(current.investment_id) === Number(start.row.investment_id) &&
            inside(
              (witnessesById.get(Number(current.id)) || current).date,
              lower,
              upper,
            ),
        );
        const referenceInterval = reference.events.filter(
          (event) =>
            event.portfolioId === start.event.portfolioId &&
            event.securityId === start.event.securityId &&
            inside(event.date, lower, upper),
        );
        const fail = () =>
          blockers.push({
            batchId: Number(batch.id),
            rowId: Number(interval[0].rows[0].id),
            rowOrdinal: interval[0].rows[0].row_index + 1,
            reason: "yield_group_not_closed",
            candidateTransactionIds: currentInterval.map((current) =>
              Number(current.id),
            ),
          });
        if (
          referenceInterval.length !== interval.length ||
          currentInterval.length !== interval.length ||
          referenceInterval.some(
            (event) => event.type !== "DELIVERY_INBOUND",
          ) ||
          currentInterval.some(
            (current) =>
              current.type !== "gift" ||
              !zero(current) ||
              (current.account_id != null &&
                Number(current.account_id) !== Number(batch.account_id)),
          )
        ) {
          fail();
          continue;
        }
        const members = [];
        for (const item of interval) {
          const unitRows = item.rows.filter(
            (/** @type {ReconciliationSourceRow} */ row) =>
              row.type === "gift" &&
              row.source_transaction_id ===
                `${item.literal.Transaction_ID}:units`,
          );
          const incomeRows = item.rows.filter(
            (/** @type {ReconciliationSourceRow} */ row) =>
              row.type === "dividend" &&
              row.source_transaction_id ===
                `${item.literal.Transaction_ID}:income`,
          );
          const row = unitRows[0];
          const income = incomeRows[0];
          const proof = evidence.proofs.get(Number(row?.id));
          const incomeProof = evidence.literalProofs.get(Number(income?.id));
          if (
            unitRows.length !== 1 ||
            incomeRows.length !== 1 ||
            !proof ||
            !incomeProof ||
            item.rows.length !== 2 ||
            row.route !== "portfolio" ||
            !zero(row) ||
            !zero({
              amount: proof.parsed.amount,
              price_per_unit: proof.parsed.pricePerUnit,
            }) ||
            income.route !== "portfolio" ||
            income.type_raw !== "Dividend" ||
            income.units != null ||
            income.price_per_unit != null ||
            !toDecimal(income.fees ?? 0).eq(0) ||
            !toDecimal(income.taxes ?? 0).eq(0) ||
            income.fx_rate_to_eur != null ||
            !equal(income.amount, incomeProof.parsed.amount, 4) ||
            income.currency !== incomeProof.parsed.currency ||
            Number(row.investment_id) !== Number(start.row.investment_id) ||
            Number(income.investment_id) !== Number(row.investment_id) ||
            Number(row.account_id) !== Number(batch.account_id) ||
            Number(income.account_id) !== Number(batch.account_id) ||
            Number(row.dedup_occurrence) !== 1
          )
            break;
          const globalSources = rows.filter((candidate) => {
            const literalProof = evidence.literalProofs.get(
              Number(candidate.id),
            );
            return (
              literalProof?.parsed.symbolRaw === asset &&
              literalProof.parsed.units != null &&
              equal(literalProof.parsed.units, row.units)
            );
          });
          const globalHistory = history.filter(
            (current) =>
              Number(current.investment_id) === Number(row.investment_id) &&
              equal(current.units, row.units),
          );
          if (globalSources.length !== 1 || globalHistory.length !== 1) break;
          const current = globalHistory[0];
          let retained;
          if (
            current.dedup_fingerprint != null ||
            current.import_batch_id != null ||
            current.account_id != null ||
            current.source_record_hash != null
          ) {
            retained = retainedReceipt(
              row,
              current,
              context,
              evidence,
              priorEvidence,
            );
            if (!retained) break;
          }
          const recorded = recordedMember(row, current, retained, context);
          if (!recorded) break;
          const witnesses = reference.events.filter(
            (event) =>
              event.securityId === start.event.securityId &&
              event.portfolioId === start.event.portfolioId &&
              event.type === "DELIVERY_INBOUND" &&
              event.date === recorded.date &&
              equal(event.shares, current.units),
          );
          if (
            !currentInterval.includes(current) ||
            witnesses.length !== 1 ||
            !referenceInterval.includes(witnesses[0])
          )
            break;
          members.push({
            row,
            current,
            recorded,
            referenceEvent: witnesses[0],
            retained,
            proof,
          });
        }
        if (
          members.length !== interval.length ||
          new Set(members.map((member) => member.current.id)).size !==
            members.length ||
          !members.some(
            (member) =>
              member.retained?.receipt.policy === "preserve_existing" &&
              member.current.date === member.row.tx_date,
          )
        ) {
          fail();
          continue;
        }
        // Round the complete literal sums once; per-member rounding can hide a residual.
        if (
          interval.some(
            (item) => !/^\d+(?:\.\d+)?$/.test(item.literal.Amount.trim()),
          )
        ) {
          fail();
          continue;
        }
        const sourceSum = interval.reduce(
          (total, item) => total.plus(item.literal.Amount.trim()),
          toDecimal(0),
        );
        const currentSum = members.reduce(
          (total, member) => total.plus(member.current.units),
          toDecimal(0),
        );
        const referenceSum = referenceInterval.reduce(
          (total, event) =>
            total.plus(toDecimal(event.literal.sharesMinor).div("100000000")),
          toDecimal(0),
        );
        if (!equal(sourceSum, currentSum) || !equal(sourceSum, referenceSum)) {
          fail();
          continue;
        }
        const manifest = {
          sourceFileHash: interval[0].proof.sourceFileHash,
          referenceHash: reference.sourceHash,
          accountId: Number(batch.account_id),
          investmentId: Number(start.row.investment_id),
          portfolioId: start.event.portfolioId,
          securityId: start.event.securityId,
          lower,
          upper,
          boundaries: bounds.map((bound) => ({
            canonicalId: Number(bound.current.id),
            receiptId: Number(bound.receipt.id),
            sourceHash: bound.row.source_record_hash,
            referenceId: bound.event.id,
          })),
          members: members.map((member) => ({
            canonicalId: Number(member.current.id),
            eventKey: member.proof.eventKey,
            sourceHash: member.row.source_record_hash,
            sourceId: member.row.source_transaction_id,
            referenceId: member.referenceEvent.id,
            recordedDate: member.recorded.date,
            paymentDate: member.row.tx_date,
            units: toDecimal(member.current.units).toFixed(8),
          })),
        };
        groups.push({
          key: kinesisYieldReferenceDigest(manifest),
          manifest,
          members,
        });
      }
    }
  }
  const used = new Set();
  for (const group of groups)
    for (const member of group.members) {
      const key = Number(member.current.id);
      if (used.has(key))
        blockers.push({
          reason: "yield_group_overlap",
          candidateTransactionIds: [key],
          batchId: Number(member.row.batch_id),
          rowId: Number(member.row.id),
          rowOrdinal: member.row.row_index + 1,
        });
      used.add(key);
    }
  return {
    groups,
    blockers,
    evidence,
    reservedRowIds,
    accountMappings: [...provedMappings].map(([portfolioId, accountId]) => ({
      portfolioId,
      accountId,
    })),
  };
}

/** Reconstruct the proof from the retained full typed original reference.
 * @param {object} input
 * @param {ReconciliationSourceRow[]} input.rows
 * @param {ReconciliationBatchScopeRow[]} input.batches
 * @param {KinesisYieldHistoryEntry[]} input.history
 * @param {ReconciliationReceiptContext} input.context
 * @returns {KinesisYieldGroupsResult}
 */
export function proveRetainedKinesisYieldGroups({
  rows,
  batches,
  history,
  context,
}) {
  /** @type {KinesisYieldGroupEvidence[]} */
  const entries = batches
    .map(
      (batch) =>
        batch.custom_config?.portfolio_performance_reference
          ?.yieldGroupEvidence,
    )
    .filter(Boolean);
  if (!entries.length)
    return { groups: [], blockers: [], reservedRowIds: new Set() };
  const entry = entries[0];
  if (
    entries.length !== batches.length ||
    entries.some(
      (item) =>
        kinesisYieldReferenceDigest(item) !==
        kinesisYieldReferenceDigest(entry),
    ) ||
    entry.version !== 1 ||
    !entry.reference ||
    entry.referenceDigest !== kinesisYieldReferenceDigest(entry.reference) ||
    batches.some(
      (batch) =>
        !["adopt_existing_only", "correct_existing_only"].includes(
          batch.custom_config.portfolio_performance_reference
            .reconciliationScope,
        ) ||
        batch.custom_config.portfolio_performance_reference.sourceHash !==
          entry.reference.sourceHash,
    )
  )
    return {
      groups: [],
      reservedRowIds: new Set(),
      blockers: [
        { reason: "yield_group_evidence_changed", candidateTransactionIds: [] },
      ],
    };
  const result = buildKinesisYieldGroups({
    rows,
    batches,
    history,
    context,
    reference: entry.reference,
    accountMappings: entry.accountMappings,
  });
  if (
    kinesisYieldReferenceDigest(
      result.groups.map((group) => group.manifest),
    ) !== kinesisYieldReferenceDigest(entry.manifests)
  )
    result.blockers.push({
      reason: "yield_group_evidence_changed",
      candidateTransactionIds: [],
    });
  return result;
}
