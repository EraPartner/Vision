/** Closed original-document intervals bind a whole payment without a date window. */
import { createHash } from "node:crypto";
import { toDecimal } from "../lib/money.ts";
import { parseCsvText } from "./importPipeline/adapters/_shared.ts";
import {
  portfolioPrimaryRawData,
  requiredStagedValue,
  verifiedPortfolioPerformanceBasisReference,
} from "./portfolioPerformanceReferenceEvidence.ts";
import { proveKinesisCorrectionSources } from "./portfolioKinesisAdoptionScope.ts";
import type { DecimalInput } from "../lib/money.ts";
import type {
  PortfolioTransactionSnapshot,
  ReconciliationBatchScopeRow,
  ReconciliationJournalRow,
  ReconciliationReceiptContext,
  ReconciliationSourceRow,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import type { KinesisSourceProof } from "./portfolioKinesisAdoptionScope.ts";
import { batchConfigFields } from "../database/rows/portfolioImport.ts";

export type KinesisCorrectionEvidence = ReturnType<
  typeof proveKinesisCorrectionSources
>;
/** A literally proved source row; its proof bound `tx_date` to the source date. */
export type KinesisDatedSourceRow = ReconciliationSourceRow & {
  tx_date: string;
};
/**
 * The history fields read here. Custody transfer and adjustment events carry
 * no cash columns, so those stay optional.
 */
export type KinesisYieldHistoryEntry = {
  id: number;
  investment_id: number;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  amount?: string | null;
  units: string | null;
  price_per_unit?: string | null;
  fees?: string | null;
  taxes?: string | null;
  currency?: string | null;
  fx_rate_to_eur?: string | null;
  account_id?: number | null;
  import_batch_id: string | null;
  source_record_hash: string | null;
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
};
/** One retained Portfolio Performance event (JSON evidence in batch config). */
export interface KinesisYieldReferenceEvent {
  id: string;
  portfolioId: string;
  securityId: string;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  shares: string;
  literal: { sharesMinor: string; [key: string]: unknown };
}
export interface KinesisYieldReference {
  sourceHash: string;
  events: KinesisYieldReferenceEvent[];
}
export interface KinesisYieldAccountMapping {
  portfolioId: string;
  accountId: number;
}
export interface KinesisYieldRetained {
  receipt: ReconciliationJournalRow;
  prior: ReconciliationSourceRow;
}
export interface KinesisYieldManifestMember {
  canonicalId: number;
  eventKey: string;
  sourceHash?: string | null;
  sourceId?: string | null;
  referenceId: string;
  recordedDate: string;
  paymentDate: string;
  units: string;
}
export interface KinesisYieldManifest {
  sourceFileHash: string;
  referenceHash: string;
  accountId: number;
  investmentId: number;
  portfolioId: string;
  securityId: string;
  lower: string;
  upper: string;
  boundaries: {
    canonicalId: number;
    receiptId: number;
    sourceHash?: string | null;
    referenceId: string;
  }[];
  members: KinesisYieldManifestMember[];
}
export interface KinesisYieldMember {
  row: KinesisDatedSourceRow;
  current: KinesisYieldHistoryEntry;
  recorded: KinesisYieldHistoryEntry | PortfolioTransactionSnapshot;
  referenceEvent: KinesisYieldReferenceEvent;
  retained: KinesisYieldRetained | undefined;
  proof: KinesisSourceProof;
}
export interface KinesisYieldGroup {
  key: string;
  manifest: KinesisYieldManifest;
  members: KinesisYieldMember[];
}
export interface KinesisYieldBlocker {
  reason: string;
  candidateTransactionIds: number[];
  batchId?: number;
  rowId?: number;
  rowOrdinal?: number;
}
/** `custom_config.portfolio_performance_reference.yieldGroupEvidence`. */
export interface KinesisYieldGroupEvidence {
  version: number;
  reference: KinesisYieldReference;
  referenceDigest: string;
  accountMappings: KinesisYieldAccountMapping[];
  manifests: KinesisYieldManifest[];
}
export interface KinesisYieldGroupsResult {
  groups: KinesisYieldGroup[];
  blockers: KinesisYieldBlocker[];
  reservedRowIds: Set<number>;
  evidence?: KinesisCorrectionEvidence;
  accountMappings?: KinesisYieldAccountMapping[];
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              canonical((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;
// PostgreSQL JSONB may reorder object keys without changing documentary facts.
export const kinesisYieldReferenceDigest = (reference: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(reference)))
    .digest("hex");
const equal = (a: DecimalInput, b: DecimalInput, places = 8) =>
  a != null &&
  b != null &&
  toDecimal(a)
    .toDecimalPlaces(places, 4)
    .eq(toDecimal(b).toDecimalPlaces(places, 4));
const snapshotEqual = (
  a: object | null | undefined,
  b: object | null | undefined,
) =>
  JSON.stringify(Object.entries(a || {}).sort()) ===
  JSON.stringify(Object.entries(b || {}).sort());
const zero = (row: {
  amount?: DecimalInput;
  price_per_unit?: DecimalInput;
  fees?: DecimalInput;
  taxes?: DecimalInput;
}) =>
  (["amount", "price_per_unit", "fees", "taxes"] as const).every((key) =>
    toDecimal(row[key] ?? 0).eq(0),
  );
const inside = (day: string, lower: string, upper: string) =>
  day > lower && day < upper;
const sourceMatches = (
  row: ReconciliationSourceRow,
  current: KinesisYieldHistoryEntry,
) =>
  current.dedup_fingerprint === row.dedup_fingerprint &&
  current.dedup_fingerprint_version === row.dedup_fingerprint_version &&
  Number(current.investment_id) === Number(row.investment_id);

/** Strict retained receipt binding, including complete original-file proof. */
function retainedReceipt(
  row: ReconciliationSourceRow,
  current: KinesisYieldHistoryEntry,
  context: ReconciliationReceiptContext,
  evidence: KinesisCorrectionEvidence,
  priorEvidence: KinesisCorrectionEvidence,
): KinesisYieldRetained | undefined {
  const receipts = context.receipts.filter(
    (entry) => Number(entry.transaction_id) === Number(current.id),
  );
  const [receipt] = receipts;
  if (receipts.length !== 1 || !receipt) return undefined;
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

function nativeBoundary(
  row: ReconciliationSourceRow,
  history: KinesisYieldHistoryEntry[],
  context: ReconciliationReceiptContext,
  evidence: KinesisCorrectionEvidence,
  priorEvidence: KinesisCorrectionEvidence,
  reference: KinesisYieldReference,
) {
  const candidates = history.filter((current) => sourceMatches(row, current));
  const [current] = candidates;
  if (candidates.length !== 1 || !current) return undefined;
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
  const [event] = matches;
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
      toDecimal(basis.amount).div(requiredStagedValue(current.units)),
      6,
    ) ||
    !toDecimal(current.fees ?? 0).eq(0) ||
    !toDecimal(current.taxes ?? 0).eq(0) ||
    (basis.currency !== "EUR" &&
      !equalNullable(current.fx_rate_to_eur, basis.fxRateToEur, 10)) ||
    matches.length !== 1 ||
    !event ||
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
function equalNullable(a: DecimalInput, b: DecimalInput, places: number) {
  return a == null || b == null ? a == null && b == null : equal(a, b, places);
}

/** A corrected date retains the original XML witness in the immutable before-image. */
function recordedMember(
  row: ReconciliationSourceRow,
  current: KinesisYieldHistoryEntry,
  retained: KinesisYieldRetained | undefined,
  context: ReconciliationReceiptContext,
): KinesisYieldHistoryEntry | PortfolioTransactionSnapshot | undefined {
  if (!retained) return current;
  const { receipt } = retained;
  const before = receipt.before_data;
  const currentFields: Record<string, unknown> = current;
  const beforeFields: Record<string, unknown> = before;
  const metadata = new Set([
    "account_id",
    "source_record_hash",
    "dedup_fingerprint",
    "dedup_fingerprint_version",
  ]);
  if (receipt.policy === "preserve_existing")
    return Object.keys(current).every(
      (field) =>
        metadata.has(field) || currentFields[field] === beforeFields[field],
    ) &&
      Object.keys(before).every(
        (field) =>
          metadata.has(field) || currentFields[field] === beforeFields[field],
      )
      ? current
      : undefined;
  if (receipt.policy !== "prefer_source") return undefined;
  const batch = context.batches.find(
    (item) => Number(item.id) === Number(receipt.batch_id),
  );
  const manifests: KinesisYieldManifest[] =
    batchConfigFields(batch?.custom_config)?.portfolio_performance_reference
      ?.yieldGroupEvidence?.manifests || [];
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
        !allowed.has(field) && currentFields[field] !== beforeFields[field],
    ) ||
    Object.keys(before).some(
      (field) =>
        !allowed.has(field) && currentFields[field] !== beforeFields[field],
    )
  )
    return undefined;
  return before;
}

const dated = (row: ReconciliationSourceRow): row is KinesisDatedSourceRow =>
  row.tx_date != null;

/** No subset sums: every event between independently proved adjacent deposits participates. */
export function buildKinesisYieldGroups({
  rows,
  batches,
  history,
  context,
  reference,
  accountMappings,
}: {
  rows: ReconciliationSourceRow[];
  batches: ReconciliationBatchScopeRow[];
  history: KinesisYieldHistoryEntry[];
  context: ReconciliationReceiptContext;
  reference: KinesisYieldReference;
  accountMappings: KinesisYieldAccountMapping[];
}): KinesisYieldGroupsResult {
  const evidence = proveKinesisCorrectionSources(rows, batches);
  const priorEvidence = proveKinesisCorrectionSources(
    context.sources,
    context.batches,
  );
  const groups: KinesisYieldGroup[] = [];
  const provedMappings = new Map<string, number>();
  const reservedRowIds = new Set<number>();
  const blockers: KinesisYieldBlocker[] = [...evidence.issues];
  if (blockers.length) return { groups, blockers, evidence, reservedRowIds };
  const recordGroups = new Map<
    string,
    {
      literal: Record<string, string>;
      rows: KinesisDatedSourceRow[];
      proof: KinesisSourceProof;
    }
  >();
  for (const row of rows) {
    const proof = evidence.literalProofs.get(Number(row.id));
    // A literal proof also guarantees a non-NULL date and raw record.
    if (!proof || !dated(row)) continue;
    const batch = batches.find(
      (item) => Number(item.id) === Number(row.batch_id),
    );
    const raw = portfolioPrimaryRawData(requiredStagedValue(row.raw_data));
    let records: Record<string, string>[];
    try {
      records = parseCsvText(raw, {
        // A literal proof exists only for rows of a batch in `batches`.
        columns: batchConfigFields(batch!.custom_config)!.source_columns,
        relax_column_count: false,
      });
    } catch {
      continue;
    }
    const [literal] = records;
    if (records.length !== 1 || !literal) continue;
    const key = `${row.batch_id}:${row.source_record_hash}`;
    if (!recordGroups.has(key))
      recordGroups.set(key, { literal, rows: [], proof });
    recordGroups.get(key)!.rows.push(row);
  }
  // Every record group holds the row that created it.
  const records = [...recordGroups.values()].map((group) => ({
    ...group,
    firstRow: group.rows[0]!,
  }));
  for (const batch of batches) {
    const scoped = records.filter(
      (item) => Number(item.firstRow.batch_id) === Number(batch.id),
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
        .sort(
          (a, b) => Number(a.proof.parsed.date) - Number(b.proof.parsed.date),
        );
      for (let index = 1; index < deposits.length; index++) {
        // 1 <= index < deposits.length
        const first = deposits[index - 1]!;
        const last = deposits[index]!;
        const lower = first.firstRow.tx_date;
        const upper = last.firstRow.tx_date;
        if (lower >= upper) continue;
        const interval = scoped.filter(
          (item) =>
            item.literal.Currency_Code === asset &&
            inside(item.firstRow.tx_date, lower, upper),
        );
        if (
          interval.length < 2 ||
          new Set(interval.map((item) => item.firstRow.tx_date)).size !== 1 ||
          interval.some(
            (item) =>
              item.literal.Transaction_Type !== "Holder's_Distribution" &&
              item.literal.Transaction_Type !== "Velocity's_Distribution",
          )
        )
          continue;
        const bounds = [first, last].map((item) => {
          const row = item.rows.find(
            (candidate) =>
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
        const [start, end] = bounds;
        if (!start || !end) continue;
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
        const witnessesById = new Map<
          number,
          KinesisYieldHistoryEntry | PortfolioTransactionSnapshot
        >();
        for (const item of interval) {
          const row = item.rows.find((candidate) => candidate.type === "gift");
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
        // The interval check above admits at least two records.
        const firstItem = interval[0]!;
        const fail = () =>
          blockers.push({
            batchId: Number(batch.id),
            rowId: Number(firstItem.firstRow.id),
            rowOrdinal: firstItem.firstRow.row_index + 1,
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
        const members: KinesisYieldMember[] = [];
        for (const item of interval) {
          const unitRows = item.rows.filter(
            (row) =>
              row.type === "gift" &&
              row.source_transaction_id ===
                `${item.literal.Transaction_ID}:units`,
          );
          const incomeRows = item.rows.filter(
            (row) =>
              row.type === "dividend" &&
              row.source_transaction_id ===
                `${item.literal.Transaction_ID}:income`,
          );
          const [row] = unitRows;
          const [income] = incomeRows;
          const proof = evidence.proofs.get(Number(row?.id));
          const incomeProof = evidence.literalProofs.get(Number(income?.id));
          if (
            unitRows.length !== 1 ||
            incomeRows.length !== 1 ||
            !row ||
            !income ||
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
              literalProof !== undefined &&
              literalProof.parsed.symbolRaw === asset &&
              literalProof.parsed.units != null &&
              equal(literalProof.parsed.units, row.units)
            );
          });
          const globalHistory = history.filter(
            (current) =>
              Number(current.investment_id) === Number(row.investment_id) &&
              equal(current.units, row.units),
          );
          const [current] = globalHistory;
          if (
            globalSources.length !== 1 ||
            globalHistory.length !== 1 ||
            !current
          )
            break;
          let retained: KinesisYieldRetained | undefined;
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
          const [witness] = witnesses;
          if (
            !currentInterval.includes(current) ||
            witnesses.length !== 1 ||
            !witness ||
            !referenceInterval.includes(witness)
          )
            break;
          members.push({
            row,
            current,
            recorded,
            referenceEvent: witness,
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
            // A proved Kinesis record carries every required column.
            (item) => !/^\d+(?:\.\d+)?$/.test(item.literal.Amount!.trim()),
          )
        ) {
          fail();
          continue;
        }
        const sourceSum = interval.reduce(
          (total, item) => total.plus(item.literal.Amount!.trim()),
          toDecimal(0),
        );
        const currentSum = members.reduce(
          // equal() above already required these units to be non-NULL.
          (total, member) =>
            total.plus(requiredStagedValue(member.current.units)),
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
        const manifest: KinesisYieldManifest = {
          sourceFileHash: firstItem.proof.sourceFileHash,
          referenceHash: reference.sourceHash,
          accountId: Number(batch.account_id),
          investmentId: Number(start.row.investment_id),
          portfolioId: start.event.portfolioId,
          securityId: start.event.securityId,
          lower,
          upper,
          boundaries: [start, end].map((bound) => ({
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
  const used = new Set<number>();
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

/** Reconstruct the proof from the retained full typed original reference. */
export function proveRetainedKinesisYieldGroups({
  rows,
  batches,
  history,
  context,
}: {
  rows: ReconciliationSourceRow[];
  batches: ReconciliationBatchScopeRow[];
  history: KinesisYieldHistoryEntry[];
  context: ReconciliationReceiptContext;
}): KinesisYieldGroupsResult {
  const entries: KinesisYieldGroupEvidence[] = batches
    .map(
      (batch) =>
        batchConfigFields(batch.custom_config)?.portfolio_performance_reference
          ?.yieldGroupEvidence,
    )
    .filter((item): item is KinesisYieldGroupEvidence => Boolean(item));
  const [entry] = entries;
  if (!entry) return { groups: [], blockers: [], reservedRowIds: new Set() };
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
    batches.some((batch) => {
      // Every batch carries yield evidence (entries.length checked above).
      const reference = batchConfigFields(
        batch.custom_config,
      )!.portfolio_performance_reference!;
      return (
        (reference.reconciliationScope !== "adopt_existing_only" &&
          reference.reconciliationScope !== "correct_existing_only") ||
        reference.sourceHash !== entry.reference.sourceHash
      );
    })
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
