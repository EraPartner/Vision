/**
 * Reviewed import of broker history into a portfolio that may already hold
 * manually entered transactions (ADR-177, simplified by ADR-236).
 *
 * Every staged row gets one action. A row whose fingerprint is already in the
 * ledger is a duplicate. A row with exactly one nearby, unassigned manual
 * candidate adopts that transaction: the existing ID, type and notes stay, the
 * row gains the source identity and account, and the batch journals a
 * before/after receipt so rollback can restore it. An inexact candidate needs
 * the reviewer's choice: keep the existing values (`preserve_existing`) or use
 * the imported ones (`prefer_source`). A row that another export of the same
 * broker, or a manual cash entry, already records is settled by the
 * cross-format rules (portfolioImportCrossFormat.ts). Everything else is
 * inserted by the ordinary commit pipeline.
 */
import { partitionOversellDeficits } from "@vision/shared-utils/portfolio";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";
import { withTransaction } from "../database/connection.ts";
import { toDecimal } from "../lib/money.ts";
import {
  asPartitionedTxns,
  normalizeTransactionPayload,
} from "./portfolio/portfolioTransactionRules.ts";
import type { NullablePartitionedTxn } from "./portfolio/portfolioTransactionRules.ts";
import {
  getNexoProSpotReconciliationEvidence,
  nexoProSourceMoneyMatches,
} from "./portfolioImportPipeline/nexoProTransactionHistoryAdapter.ts";
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
  markCrossFormatSourceDuplicate,
  readCashLedgerFingerprints,
  readCrossFormatLedgerSources,
  readCrossFormatSettledIdentities,
  readHistorySourceIds,
  readManualCashCandidates,
  readReconciliationBatchScope,
  readReconciliationHistory,
  readReconciliationSources,
  readReconciledProImportAccounts,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import {
  readActiveIbkrCashReceipts,
  readIbkrCashImagesForUpdate,
  writeCashAdoption,
} from "../repositories/portfolioImportCashRepository.ts";
import type { IbkrCashProof } from "../repositories/portfolioImportCashRepository.ts";
import { planCrossFormatSources } from "./portfolioImportCrossFormat.ts";
import type {
  CrossFormatContext,
  CrossFormatDecision,
} from "./portfolioImportCrossFormat.ts";
import {
  getActiveDuplicateRepairReceipts,
  financialRepairImage,
  validateDuplicatePortfolioRepairRollback,
} from "./portfolioImportDuplicateRepairService.ts";
import {
  isIbkrCashReceipt,
  restoreIbkrCashCorrection,
  validateIbkrCashCorrectionRollback,
} from "./portfolioImportLegacyReceipts.ts";
import {
  isZeroYieldKinesisBatch,
  kinesisInKindIncomeRowIds,
} from "./portfolioImportPipeline/kinesisInKindIncome.ts";
import type {
  ReconciliationSourceRow,
  ReconciliationBatchScopeRow,
  ReconciliationJournalRow,
  ReconciliationHistoryEvent,
  PortfolioTransactionSnapshot,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import type { DecimalInput } from "../lib/money.ts";
import type { PortfolioAssetAdjustmentRow } from "../repositories/portfolioAssetAdjustmentRepository.ts";
import type { NexoProSpotReconciliationEvidence } from "./portfolioImportPipeline/nexoProTransactionHistoryAdapter.ts";
import { firstNonZero } from "../lib/math.ts";
import { normalizeIdentityText } from "./importIdentity.ts";

/**
 * One reconciliation history event read by column name. Custody events
 * (asset transfers and adjustments) lack some transaction columns compared
 * here and add their own custody columns.
 */
export type HistoryImage = ReconciliationHistoryEvent &
  Partial<
    Omit<PortfolioTransactionSnapshot, "id" | "investment_id" | "type" | "date">
  > & {
    source_account_id?: number;
    destination_account_id?: number;
    fee_units?: string;
    adjustment_kind?: PortfolioAssetAdjustmentRow["adjustment_kind"];
    basis_policy?: PortfolioAssetAdjustmentRow["basis_policy"];
  };
/** normalizedSource's output: the staged values as exact NUMERIC text. */
export interface NormalizedSource {
  [field: string]: string | null;
  type: string | null;
  date: string | null;
  amount: string | null;
  units: string | null;
  price_per_unit: string | null;
  fees: string;
  taxes: string;
  currency: string;
  fx_rate_to_eur: string | null;
  dividend_amount_convention: string;
}
/** The staged fields normalizedSource reads. */
export type NormalizedSourceInput = Pick<
  ReconciliationSourceRow,
  "type" | "tx_date" | "asset_class" | "investment_currency" | "custom_config"
> & {
  amount: DecimalInput;
  units: DecimalInput;
  price_per_unit: DecimalInput;
  fees: DecimalInput;
  taxes: DecimalInput;
  fx_rate_to_eur: DecimalInput;
  currency: string | null;
};
/** A plan blocker. */
export interface PlanIssue {
  batchId: number;
  rowId: number;
  rowOrdinal: number;
  reason: string;
  candidateTransactionIds: number[];
}
/** One planned row outcome. `action` selects which optional fields are set. */
export interface PlanAction {
  batchId: number;
  rowId: number;
  rowOrdinal: number;
  action: string;
  reason?: string;
  candidateTransactionIds?: number[];
  investmentId?: number | null;
  source?: Record<string, unknown>;
  existing?: Record<string, unknown>;
  existingTransactionId?: number;
  duplicateOfRowId?: number;
  corrections?: string[];
  economicsProven?: boolean;
  policy?: string | null;
  /** settled by another export of the same broker or a manual cash entry */
  crossFormat?: boolean;
  /** the existing transaction is brokerage cash, not a portfolio row */
  cash?: boolean;
  transfer?: {
    date: string;
    units: string;
    feeUnits: string;
    receivedUnits: string;
    sourceAccountId: number;
    destinationAccountId: number;
  };
  adjustment?: {
    date: string;
    units: string;
    kind: string;
    basisPolicy: string;
    accountId: number;
  };
}
/** The row-scoped fields a planned row outcome starts from. */
export type PlanBaseAction = Omit<PlanAction, "action">;
/** A staged source or history image compared column by column. */
type ColumnImage = {
  readonly [column: string]: unknown;
  units?: DecimalInput;
  fee_units?: DecimalInput;
};
/** A staged row with its source values and nearby manual candidates. */
interface PreparedRow {
  row: ReconciliationSourceRow;
  source: NormalizedSource;
  proof: NexoProSpotReconciliationEvidence | undefined;
  candidates: HistoryImage[];
  baseAction: PlanBaseAction;
  inKindIncome: boolean;
}
/** The pre-read evidence and selection the plan builder is pure over. */
export interface ReconciliationPlanInput {
  rows: ReconciliationSourceRow[];
  history: HistoryImage[];
  batches: ReconciliationBatchScopeRow[];
  adoptPolicy?: string | undefined;
  batchPolicies?: BatchPolicy[] | undefined;
  priorProAccounts?: number[] | undefined;
  /** ledger evidence for rows another export or a manual entry records */
  crossFormat?: CrossFormatContext | undefined;
  /** `format\0source id` of each imported history transaction that has one */
  historySourceIds?: ReadonlyMap<number, string> | undefined;
  /** the owner's answer for rows that resemble an existing transaction */
  rowChoices?: RowChoice[] | undefined;
}
/**
 * The owner's answer for one staged row that resembles an existing
 * transaction no import can adopt: `keep_both` records it as a new
 * transaction, `same_transaction` settles it as a duplicate of that one.
 */
export type RowChoice = {
  batchId: number;
  rowId: number;
  choice: "keep_both" | "same_transaction";
};
/** A planned cash adoption: a funding correction or a manual cash twin. */
export interface PlanCashAdoption {
  row: ReconciliationSourceRow;
  decision: Extract<CrossFormatDecision, { kind: "adopt_cash" }>;
}
export interface PlanAdoption {
  row: ReconciliationSourceRow;
  before: PortfolioTransactionSnapshot;
  after: PortfolioTransactionSnapshot;
  policy: ReconciliationJournalRow["policy"];
}
export type BatchPolicy = { batchId: number; adoptPolicy: string };
export interface ReconciliationPlan {
  batchIds: number[];
  adoptPolicy: string | null;
  batchPolicies: BatchPolicy[];
  rowChoices: RowChoice[];
  ready: boolean;
  actions: PlanAction[];
  blockers: PlanIssue[];
  summary: Record<string, number>;
}
export interface ReconciliationPlanResult {
  plan: ReconciliationPlan;
  adoptions: PlanAdoption[];
  /**
   * Rows another export already records, or that the owner named the same
   * transaction as an existing one; commit settles them as duplicates.
   */
  settledDuplicates: ReconciliationSourceRow[];
  cashAdoptions: PlanCashAdoption[];
}
/** The batch selection and policies every locked plan read takes. */
export interface ReconciliationScopeOptions {
  batchIds: number[];
  adoptPolicy?: string | undefined;
  batchPolicies?: BatchPolicy[] | undefined;
  rowChoices?: RowChoice[] | undefined;
}
/** A history event or proposed event replayed by the projected-history check. */
type ProjectedHistoryEvent = NullablePartitionedTxn & {
  investment_id?: number | string | null;
};

/** A validated source adoption policy. */
export type AdoptPolicy = "preserve_existing" | "prefer_source";
const POLICIES = new Set<unknown>(["preserve_existing", "prefer_source"]);
const isPolicy = (value: unknown): value is AdoptPolicy => POLICIES.has(value);
/** Array membership for a column value that may be NULL. */
const isOneOf = (values: readonly unknown[], value: unknown): boolean =>
  values.includes(value);
const UNIT_TYPES = new Set<string | null>(["buy", "sell", "gift", "split"]);
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
] as const;
/** Staging columns that hold one CSV cell's NUMERIC value. */
export type StagedNumberColumn =
  "units" | "price_per_unit" | "amount" | "fees" | "taxes" | "fx_rate_to_eur";
const PLACES: Record<StagedNumberColumn, number> = {
  amount: 4,
  units: 8,
  price_per_unit: 6,
  fees: 4,
  taxes: 4,
  fx_rate_to_eur: 10,
};
const SUMMARY_KINDS = [
  "insert",
  "adopt",
  "duplicate",
  "duplicate_source",
  "cash",
  "transfer",
  "adjustment",
  "internal_annotation",
  "settled",
  "blocked",
  "policy_required",
] as const;
/** Ordinary nearby legacy matching window, in calendar days. */
const NEARBY_DAYS = 7;
/** Literal Nexo Pro execution proof may widen the window to this many days. */
const NEXO_PRO_DAYS = 31;

function equalNumber(
  left: DecimalInput,
  right: DecimalInput,
  places: number,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return toDecimal(left)
    .toDecimalPlaces(places)
    .eq(toDecimal(right).toDecimalPlaces(places));
}

function isPlacesField(field: string): field is StagedNumberColumn {
  return field in PLACES;
}

function sameValue(field: string, left: DecimalInput, right: DecimalInput): boolean {
  if (field === "dividend_amount_convention")
    return (left ?? "unknown") === (right ?? "unknown");
  return isPlacesField(field)
    ? equalNumber(left, right, PLACES[field])
    : left === right;
}

function dayDistance(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  return (
    Math.abs(
      Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`),
    ) / 86400000
  );
}

function formatOf(
  row: Pick<ReconciliationBatchScopeRow, "custom_config">,
): unknown {
  const stored = row.custom_config;
  let config: unknown = stored;
  if (typeof stored === "string") {
    try {
      config = JSON.parse(stored);
    } catch {
      return undefined;
    }
  }
  // Any parsed JSON value: only an object has a format key.
  return typeof config === "object" && config !== null
    ? (config as Record<string, unknown>).format
    : undefined;
}

const GROSS_DIVIDEND_FORMATS = new Set<unknown>([
  "saxo_transaction_history",
  "ibkr_transaction_history",
]);

function normalizedSource(row: NormalizedSourceInput): NormalizedSource {
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
    { assetClass: row.asset_class ?? undefined },
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
      row.type === "dividend" && GROSS_DIVIDEND_FORMATS.has(formatOf(row))
        ? "gross"
        : payload.dividend_amount_convention,
  };
}

/** The literal CSV record, also when an earlier writer wrapped it in JSON. */
function literalRawData(rawData: string | null): string | null {
  if (typeof rawData !== "string" || !rawData.startsWith("{")) return rawData;
  try {
    const envelope: unknown = JSON.parse(rawData);
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      "primaryRawData" in envelope &&
      typeof envelope.primaryRawData === "string"
    )
      return envelope.primaryRawData;
  } catch {
    /* An ordinary record that starts with a brace. */
  }
  return rawData;
}

/** The Nexo Pro execution facts that stay literal in the staged row. */
function nexoProProof(
  row: ReconciliationSourceRow,
  source: NormalizedSource,
): NexoProSpotReconciliationEvidence | undefined {
  if (formatOf(row) !== "nexo_pro_spot_history") return undefined;
  const proof = getNexoProSpotReconciliationEvidence(
    literalRawData(row.raw_data),
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

/** A base-currency fee charged in units explains a gross/net unit difference. */
function proFeeExplainsUnits(
  proof: NexoProSpotReconciliationEvidence | undefined,
  current: HistoryImage,
): boolean {
  return Boolean(
    proof &&
    proof.feeCurrency === proof.symbol &&
    toDecimal(proof.feeUnits).gt(0) &&
    equalNumber(proof.grossUnits, current.units, 8),
  );
}

function transferWithoutBasis(row: ReconciliationSourceRow): boolean {
  return (
    row.asset_transfer_details?.direction === "in" ||
    (row.type === "gift" &&
      /original cost basis unavailable|asset transfer in/i.test(row.note || ""))
  );
}

function plausibleUnits(left: DecimalInput, right: DecimalInput): boolean {
  if (left == null || right == null) return left == null && right == null;
  const relative = toDecimal(left).abs().times("0.00000001");
  const tolerance = relative.gt("0.00000001")
    ? relative
    : toDecimal("0.00000001");
  return toDecimal(left).minus(right).abs().lte(tolerance);
}

/** A manual transaction that may record the same event as the staged row. */
function nearbyCandidate(
  row: ReconciliationSourceRow,
  source: NormalizedSource,
  current: HistoryImage,
  proof: NexoProSpotReconciliationEvidence | undefined,
): boolean {
  if (Number(row.investment_id) !== Number(current.investment_id)) return false;
  const distance = dayDistance(source.date, current.date);
  const boundedProDateProof =
    proof &&
    distance <= NEXO_PRO_DAYS &&
    source.type === current.type &&
    (equalNumber(source.units, current.units, 8) ||
      proFeeExplainsUnits(proof, current)) &&
    equalNumber(proof.unitPrice, current.price_per_unit, 6) &&
    equivalentEconomics(source, current, proof);
  if (distance > NEARBY_DAYS && !boundedProDateProof) return false;
  const transfer = transferWithoutBasis(row);
  if (
    source.type !== current.type &&
    !(transfer && ["buy", "gift"].includes(current.type))
  )
    return false;
  if (!UNIT_TYPES.has(source.type)) return true;
  return (
    plausibleUnits(source.units, current.units) ||
    (source.price_per_unit != null &&
      current.price_per_unit != null &&
      toDecimal(source.price_per_unit).gt(0) &&
      equalNumber(source.price_per_unit, current.price_per_unit, 6) &&
      equivalentEconomics(source, current, proof)) ||
    proFeeExplainsUnits(proof, current)
  );
}

/** The imported and recorded amounts describe the same money. */
function equivalentEconomics(
  source: NormalizedSource,
  current: HistoryImage,
  proof: NexoProSpotReconciliationEvidence | undefined,
): boolean {
  const signed = isOneOf(["sell", "dividend", "interest"], source.type)
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
    source.currency === "EUR" ? "1" : (source.fx_rate_to_eur ?? undefined);
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

function publicValues(
  snapshot: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    ["type", ...VALUE_FIELDS].map((field) => [field, snapshot[field] ?? null]),
  );
}

function canonicalBatchPolicies(
  batchPolicies: BatchPolicy[],
  batches: readonly ReconciliationBatchScopeRow[],
): Array<{ batchId: number; adoptPolicy: AdoptPolicy }> {
  const selected = new Set(batches.map((batch) => Number(batch.id)));
  if (!Array.isArray(batchPolicies) || batchPolicies.length > selected.size)
    throw new ValidationError(
      "batch_policies must contain at most one policy per selected batch",
    );
  const seen = new Set<number>();
  const canonical = batchPolicies.map((override) => {
    if (
      override == null ||
      !Number.isSafeInteger(override.batchId) ||
      !selected.has(override.batchId) ||
      seen.has(override.batchId) ||
      !isPolicy(override.adoptPolicy)
    )
      throw new ValidationError(
        "batch_policies must use unique selected batch IDs and supported adoption policies",
      );
    seen.add(override.batchId);
    return { batchId: override.batchId, adoptPolicy: override.adoptPolicy };
  });
  return canonical.sort((left, right) => left.batchId - right.batchId);
}

const ROW_CHOICES = new Set<unknown>(["keep_both", "same_transaction"]);

/** One choice per staged row of the selected batches, sorted. */
function canonicalRowChoices(
  rowChoices: RowChoice[],
  rows: readonly ReconciliationSourceRow[],
): RowChoice[] {
  const staged = new Set(
    rows.map((row) => `${Number(row.batch_id)}:${Number(row.id)}`),
  );
  const seen = new Set<string>();
  if (!Array.isArray(rowChoices))
    throw new ValidationError("row_choices must be a list");
  const canonical = rowChoices.map((item) => {
    const key = `${item?.batchId}:${item?.rowId}`;
    if (
      item == null ||
      !Number.isSafeInteger(item.batchId) ||
      !Number.isSafeInteger(item.rowId) ||
      !staged.has(key) ||
      seen.has(key) ||
      !ROW_CHOICES.has(item.choice)
    )
      throw new ValidationError(
        "row_choices must name distinct staged rows of the selected batches with a supported choice",
      );
    seen.add(key);
    return { batchId: item.batchId, rowId: item.rowId, choice: item.choice };
  });
  return canonical.sort((left, right) =>
    firstNonZero(left.batchId - right.batchId, left.rowId - right.rowId),
  );
}

/** The import format and normalized source id of a staged row, if it has one. */
function stagedSourceId(row: ReconciliationSourceRow): string | undefined {
  const format = formatOf(row) ?? row.adapter_name;
  const id = normalizeIdentityText(row.source_transaction_id);
  return typeof format === "string" && format && id
    ? `${format}\u0000${id}`
    : undefined;
}

/** Dividend rows that a zero-basis Kinesis yield gift already represents. */
function inKindIncomeRows(
  rows: readonly ReconciliationSourceRow[],
  batches: readonly ReconciliationBatchScopeRow[],
): Set<number> {
  const ids = new Set<number>();
  for (const batch of batches.filter((item) =>
    isZeroYieldKinesisBatch(item.custom_config),
  ))
    for (const id of kinesisInKindIncomeRowIds(
      rows.filter((row) => Number(row.batch_id) === Number(batch.id)),
    ))
      ids.add(id);
  return ids;
}

/** Pure plan builder used by preview and locked commit. No proximity match writes data. */
export function buildPortfolioImportReconciliationPlan({
  rows,
  history,
  batches,
  adoptPolicy,
  batchPolicies = [],
  priorProAccounts = [],
  crossFormat = undefined,
  historySourceIds = new Map(),
  rowChoices = [],
}: ReconciliationPlanInput): ReconciliationPlanResult {
  if (adoptPolicy !== undefined && !isPolicy(adoptPolicy))
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
  const policyOf = (row: Pick<ReconciliationSourceRow, "batch_id">) =>
    overrides.get(Number(row.batch_id)) ?? adoptPolicy;
  const canonicalChoices = canonicalRowChoices(rowChoices, rows);
  const choices = new Map(
    canonicalChoices.map((item) => [
      `${item.batchId}:${item.rowId}`,
      item.choice,
    ]),
  );
  const choiceOf = (row: Pick<ReconciliationSourceRow, "batch_id" | "id">) =>
    choices.get(`${Number(row.batch_id)}:${Number(row.id)}`);
  /**
   * An existing transaction may record the same event as the staged row only
   * on the same account (or none yet, for a manual entry an import adopts),
   * and never when both carry different source ids of the same export.
   */
  const mayRecordSameEvent = (
    row: ReconciliationSourceRow,
    current: HistoryImage,
  ) => {
    if (
      current.account_id != null &&
      Number(current.account_id) !== Number(row.account_id)
    )
      return false;
    // Custody events number their own table; the ids name transactions.
    const recorded = isOneOf(["asset_transfer", "asset_adjustment"], current.type)
      ? undefined
      : historySourceIds.get(Number(current.id));
    const staged = stagedSourceId(row);
    return !(recorded && staged && recorded !== staged);
  };
  const actions: PlanAction[] = [];
  const blockers: PlanIssue[] = [];
  const adoptions: PlanAdoption[] = [];
  const settledDuplicates: ReconciliationSourceRow[] = [];
  const cashAdoptions: PlanCashAdoption[] = [];
  const prepared: PreparedRow[] = [];
  const crossFormatDecisions = crossFormat
    ? planCrossFormatSources({ rows, context: crossFormat, policyOf })
    : new Map<number, CrossFormatDecision>();
  const inKindIncome = inKindIncomeRows(rows, batches);
  const zeroYieldBatches = new Set(
    batches
      .filter((batch) => isZeroYieldKinesisBatch(batch.custom_config))
      .map((batch) => Number(batch.id)),
  );
  const seenSources = new Map<
    string,
    { row: ReconciliationSourceRow; source: ColumnImage }
  >();
  const proAccounts = new Set(priorProAccounts);
  for (const row of rows)
    if (
      formatOf(row) === "nexo_pro_spot_history" &&
      row.route === "portfolio" &&
      isOneOf(["buy", "sell"], row.type) &&
      ["matched", "committed", "duplicate"].includes(row.status)
    )
      proAccounts.add(Number(row.account_id));
  const rowAction = (
    row: Pick<ReconciliationSourceRow, "batch_id" | "id" | "row_index">,
  ) => ({
    batchId: Number(row.batch_id),
    rowId: Number(row.id),
    rowOrdinal: row.row_index + 1,
  });
  const addBlocker = (
    row: Pick<ReconciliationSourceRow, "batch_id" | "id" | "row_index">,
    reason: string,
    candidates: readonly { id: number | string }[] = [],
  ) => {
    const issue = {
      ...rowAction(row),
      reason,
      candidateTransactionIds: candidates.map((candidate) =>
        Number(candidate.id),
      ),
    };
    blockers.push(issue);
    actions.push({ ...issue, action: "blocked" });
  };
  // The first history row per fingerprint identity.
  const historyByIdentity = new Map<string, HistoryImage>();
  for (const current of history) {
    const identity = `${current.dedup_fingerprint_version}:${current.dedup_fingerprint}`;
    if (!historyByIdentity.has(identity)) historyByIdentity.set(identity, current);
  }
  /** A custody event: a ledger duplicate, an in-session duplicate, or new. */
  const custodyAction = <E extends ColumnImage>(
    row: ReconciliationSourceRow,
    event: E & {
      dedup_fingerprint: string | null;
      dedup_fingerprint_version: number | null;
    },
    same: (current: ColumnImage) => boolean,
    kind: "transfer" | "adjustment",
    detail: Pick<PlanAction, "transfer" | "adjustment">,
  ) => {
    const identity = `${event.dedup_fingerprint_version}:${event.dedup_fingerprint}`;
    const canonical = historyByIdentity.get(identity);
    if (canonical && !same(canonical)) {
      addBlocker(row, "source_identity_conflict", [canonical]);
      return;
    }
    const earlier = seenSources.get(identity);
    if (earlier && !same(earlier.source)) {
      addBlocker(row, "source_identity_conflict");
      return;
    }
    actions.push({
      ...rowAction(row),
      investmentId: Number(row.investment_id),
      ...detail,
      action: canonical ? "duplicate" : earlier ? "duplicate_source" : kind,
      ...(canonical ? { existingTransactionId: Number(canonical.id) } : {}),
      ...(earlier ? { duplicateOfRowId: Number(earlier.row.id) } : {}),
    });
    if (!canonical && !earlier) seenSources.set(identity, { row, source: event });
  };
  for (const row of rows) {
    if (["committed", "duplicate"].includes(row.status)) {
      actions.push({ ...rowAction(row), action: "settled" });
      continue;
    }
    const crossDecision = crossFormatDecisions.get(Number(row.id));
    // A row kept apart from its near match takes the ordinary path below.
    const decision =
      crossDecision?.kind === "kept_apart" ? undefined : crossDecision;
    if (decision) {
      const base = {
        ...rowAction(row),
        investmentId:
          row.investment_id == null ? null : Number(row.investment_id),
        crossFormat: true,
      };
      if (decision.kind === "blocked")
        addBlocker(
          row,
          decision.reason,
          decision.candidateTransactionIds.map((id) => ({ id })),
        );
      else if (decision.kind === "duplicate_source") {
        actions.push({
          ...base,
          action: "duplicate_source",
          duplicateOfRowId: decision.duplicateOfRowId,
          // A near match the owner paired by choosing prefer_source.
          ...(decision.policy ? { policy: decision.policy } : {}),
        });
        settledDuplicates.push(row);
      } else if (decision.kind === "duplicate") {
        actions.push({
          ...base,
          action: "duplicate",
          existingTransactionId: decision.existingTransactionId,
          ...(decision.policy ? { policy: decision.policy } : {}),
        });
        settledDuplicates.push(row);
      } else {
        const source = {
          date: row.tx_date,
          amount:
            decision.kind === "adopt_cash"
              ? decision.after.amount
              : decision.existing.amount,
          currency:
            decision.kind === "adopt_cash"
              ? decision.after.currency
              : decision.existing.currency,
        };
        const corrections = (["date", "amount", "currency"] as const).filter(
          (field) =>
            field === "amount"
              ? !equalNumber(source.amount, decision.existing.amount, 4)
              : source[field] !== decision.existing[field],
        );
        const cash = {
          ...base,
          investmentId: null,
          cash: true,
          existingTransactionId: decision.transactionId,
          existing: decision.existing,
          source,
          corrections,
        };
        if (decision.kind === "policy_required") {
          actions.push({ ...cash, action: "policy_required" });
          blockers.push({
            ...rowAction(row),
            reason: "source_policy_required",
            candidateTransactionIds: [decision.transactionId],
          });
        } else {
          actions.push({ ...cash, action: "adopt", policy: decision.policy });
          cashAdoptions.push({ row, decision });
        }
      }
      continue;
    }
    if (
      row.status !== "matched" ||
      !row.tx_date ||
      (row.route !== "cash" &&
        row.route !== "account_internal" &&
        row.route !== "asset_transfer" &&
        row.route !== "asset_adjustment" &&
        (!row.type || row.investment_id == null))
    ) {
      addBlocker(row, "incomplete_source");
      continue;
    }
    if (row.route === "account_internal") {
      // A Nexo wallet-to-Pro movement is an annotation inside one account; the
      // companion Pro trade history supplies its economic events.
      if (
        formatOf(row) !== "nexo_transaction_history" ||
        row.asset_transfer_details?.direction !== "internal"
      )
        addBlocker(row, "invalid_internal_annotation");
      else if (!proAccounts.has(Number(row.account_id)))
        addBlocker(row, "missing_companion_pro_history");
      else actions.push({ ...rowAction(row), action: "internal_annotation" });
      continue;
    }
    if (row.route === "cash") {
      const identity =
        row.dedup_fingerprint &&
        `${row.dedup_fingerprint_version}:${row.dedup_fingerprint}`;
      if (row.account_id == null || row.amount == null)
        addBlocker(row, "incomplete_source");
      // Commit settles a movement the cash ledger already holds as a duplicate.
      else if (
        identity &&
        (crossFormat?.cashFingerprints.has(identity) ||
          crossFormat?.correctedAliases.has(identity))
      )
        actions.push({ ...rowAction(row), action: "duplicate", cash: true });
      else actions.push({ ...rowAction(row), action: "cash" });
      continue;
    }
    if (row.route === "asset_adjustment") {
      const preview = previewPortfolioAssetAdjustment(row, undefined, {
        sourceRows: rows,
      });
      if (preview.error) addBlocker(row, preview.error);
      else {
        const event = preview.event;
        custodyAction(
          row,
          event,
          (current) =>
            current.type === "asset_adjustment" &&
            (
              [
                "investment_id",
                "account_id",
                "date",
                "adjustment_kind",
                "basis_policy",
              ] as const
            ).every((field) => String(current[field]) === String(event[field])) &&
            equalNumber(current.units, event.units, 8),
          "adjustment",
          {
            adjustment: {
              date: event.date,
              units: event.units,
              kind: event.adjustment_kind,
              basisPolicy: event.basis_policy,
              accountId: event.account_id,
            },
          },
        );
      }
      continue;
    }
    if (row.route === "asset_transfer") {
      const preview = previewPortfolioAssetTransfer(row);
      if (preview.error) addBlocker(row, preview.error);
      else {
        const event = preview.event;
        custodyAction(
          row,
          event,
          (current) =>
            current.type === "asset_transfer" &&
            (
              [
                "investment_id",
                "source_account_id",
                "destination_account_id",
                "date",
              ] as const
            ).every((field) => String(current[field]) === String(event[field])) &&
            equalNumber(current.units, event.units, 8) &&
            equalNumber(current.fee_units, event.fee_units, 8),
          "transfer",
          {
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
          },
        );
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
    const income = inKindIncome.has(Number(row.id));
    if (
      !income &&
      zeroYieldBatches.has(Number(row.batch_id)) &&
      row.type === "dividend" &&
      row.source_transaction_id?.endsWith(":income")
    ) {
      addBlocker(row, "paired_income_units_missing");
      continue;
    }
    const baseAction = {
      ...rowAction(row),
      investmentId: Number(row.investment_id),
      source: {
        ...publicValues(source),
        ...(income ? { income_recognition_role: "included_in_units" } : {}),
      },
    };
    const canonical = identity ? historyByIdentity.get(identity) : undefined;
    if (canonical) {
      if (
        Number(canonical.investment_id) !== Number(row.investment_id) ||
        canonical.account_id !== row.account_id
      )
        addBlocker(row, "source_identity_conflict", [canonical]);
      else
        actions.push({
          ...baseAction,
          action: "duplicate",
          existingTransactionId: Number(canonical.id),
        });
      continue;
    }
    const earlier = identity ? seenSources.get(identity) : undefined;
    if (earlier) {
      if (policyOf(earlier.row) !== policyOf(row))
        addBlocker(row, "source_policy_conflict");
      else if (
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
    const proof = nexoProProof(row, source);
    prepared.push({
      row,
      source,
      proof,
      // The owner said this row is a transaction of its own.
      candidates:
        choiceOf(row) === "keep_both"
          ? []
          : history.filter((current) => {
              const keptApart = crossFormatDecisions.get(Number(row.id));
              return (
                !(
                  keptApart?.kind === "kept_apart" &&
                  keptApart.transactionIds.includes(Number(current.id))
                ) &&
                mayRecordSameEvent(row, current) &&
                nearbyCandidate(row, source, current, proof)
              );
            }),
      baseAction,
      inKindIncome: income,
    });
  }
  // A candidate claimed by two staged rows is ambiguous for both.
  const uses = new Map<number, number>();
  for (const item of prepared)
    for (const candidate of item.candidates)
      uses.set(Number(candidate.id), (uses.get(Number(candidate.id)) ?? 0) + 1);
  for (const { row, source, proof, candidates, baseAction, inKindIncome: income } of prepared) {
    const effectivePolicy = policyOf(row);
    if (candidates.length === 0) {
      const datedProCandidates =
        proof && choiceOf(row) !== "keep_both"
        ? history.filter(
            (current) =>
              Number(current.investment_id) === Number(row.investment_id) &&
              mayRecordSameEvent(row, current) &&
              current.type === source.type &&
              dayDistance(current.date, source.date) > NEARBY_DAYS &&
              dayDistance(current.date, source.date) <= NEXO_PRO_DAYS &&
              (equalNumber(proof.netUnits, current.units, 8) ||
                (proof.feeCurrency === proof.symbol &&
                  equalNumber(proof.grossUnits, current.units, 8))),
          )
        : [];
      if (datedProCandidates.length > 0)
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
    // In-kind income is recorded only as a new row with its accounting role.
    // An existing manual dividend for the same yield needs a manual decision.
    if (income) {
      addBlocker(row, "paired_income_existing_conflict", candidates);
      continue;
    }
    const [current] = candidates;
    if (
      candidates.length !== 1 ||
      !current ||
      uses.get(Number(current.id)) !== 1
    ) {
      addBlocker(row, "ambiguous_history", candidates);
      continue;
    }
    if (
      current.account_id != null ||
      current.import_batch_id != null ||
      current.dedup_fingerprint != null
    ) {
      // Another import or an account already owns it, so it cannot be
      // adopted. Only the owner can say whether the row is that transaction
      // (settled as its duplicate) or a separate one (`keep_both`, above).
      if (choiceOf(row) === "same_transaction") {
        actions.push({
          ...baseAction,
          action: "duplicate",
          existingTransactionId: Number(current.id),
          existing: publicValues(current),
        });
        settledDuplicates.push(row);
      } else
        addBlocker(row, "existing_assigned_or_imported_history", candidates);
      continue;
    }
    if (!row.dedup_fingerprint || row.dedup_fingerprint_version == null) {
      addBlocker(row, "missing_source_identity", candidates);
      continue;
    }
    const corrections = (["type", ...VALUE_FIELDS] as const).filter(
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
    const comparable = equivalentEconomics(source, current, proof);
    if (!exact && effectivePolicy === undefined) {
      actions.push({
        ...baseAction,
        action: "policy_required",
        existingTransactionId: Number(current.id),
        existing: publicValues(current),
        corrections,
        economicsProven: comparable,
      });
      blockers.push({
        ...rowAction(row),
        reason: "source_policy_required",
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
      !proFeeExplainsUnits(proof, current)
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
    // The staged source supplies each value column by name.
    const columns: Record<string, unknown> = after;
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
        columns[field] = source[field];
      }
    const policy = effectivePolicy ?? "exact";
    actions.push({
      ...baseAction,
      action: "adopt",
      existingTransactionId: Number(current.id),
      existing: publicValues(current),
      corrections,
      economicsProven: comparable,
      policy,
    });
    // Candidates share a staged transaction type, so they are never custody
    // events: both images are full portfolio transaction snapshots.
    adoptions.push({
      row,
      before: current as PortfolioTransactionSnapshot,
      after: after as PortfolioTransactionSnapshot,
      policy,
    });
  }
  return {
    plan: {
      batchIds: batches.map((batch) => Number(batch.id)),
      adoptPolicy: adoptPolicy ?? null,
      batchPolicies: canonicalPolicies,
      rowChoices: canonicalChoices,
      ready: blockers.length === 0,
      actions,
      blockers,
      summary: Object.fromEntries(
        SUMMARY_KINDS.map((action) => [
          action,
          actions.filter((item) => item.action === action).length,
        ]),
      ),
    },
    adoptions,
    settledDuplicates,
    cashAdoptions,
  };
}

function scopeIds(batchIds: unknown): number[] {
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

async function loadPlan({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  rowChoices = [],
}: ReconciliationScopeOptions) {
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
          // The filter above selected rows with adjustment details.
          Number(row.asset_adjustment_details!.accountId ?? row.account_id),
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
  const historySourceIds = new Map(
    (
      await readHistorySourceIds(
        history
          .filter(
            (current) =>
              current.dedup_fingerprint != null &&
              !isOneOf(["asset_transfer", "asset_adjustment"], current.type),
          )
          .map((current) => Number(current.id)),
      )
    ).map((source) => [
      Number(source.id),
      `${source.format}\u0000${normalizeIdentityText(source.source_transaction_id)}`,
    ]),
  );
  const accountIds = [
    ...new Set(
      batches.map((batch) => batch.account_id).filter((id) => id != null),
    ),
  ];
  const priorProAccounts = await readReconciledProImportAccounts(accountIds);
  const cashRows = rows.filter(
    (row) => row.route === "cash" && row.tx_date != null,
  );
  const cashDates = cashRows.map((row) => row.tx_date!).sort();
  const shift = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
      .toISOString()
      .slice(0, 10);
  const crossFormat: CrossFormatContext = {
    ledgerSources: await readCrossFormatLedgerSources(accountIds, ids),
    settledIdentities: await readCrossFormatSettledIdentities(accountIds, ids),
    cashFingerprints: await readCashLedgerFingerprints(
      cashRows.map((row) => row.dedup_fingerprint).filter((fp) => fp != null),
    ),
    correctedAliases: new Set(
      (await readActiveIbkrCashReceipts())
        .map((receipt) => receipt.before_data.snapshot)
        .filter((snapshot) => snapshot?.dedup_fingerprint)
        .map(
          (snapshot) =>
            `${snapshot.dedup_fingerprint_version}:${snapshot.dedup_fingerprint}`,
        ),
    ),
    manualCash:
      cashDates.length > 0
        ? await readManualCashCandidates(
            accountIds,
            shift(cashDates[0]!, -7),
            shift(cashDates.at(-1)!, 7),
          )
        : [],
  };
  return {
    ...buildPortfolioImportReconciliationPlan({
      rows,
      history,
      batches,
      adoptPolicy,
      batchPolicies,
      priorProAccounts,
      crossFormat,
      historySourceIds,
      rowChoices,
    }),
    history,
    rows,
  };
}

export async function previewPortfolioImportReconciliation({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  rowChoices = [],
}: ReconciliationScopeOptions): Promise<ReconciliationPlan> {
  return withTransaction(async () => {
    const loaded = await loadPlan({
      batchIds,
      adoptPolicy,
      batchPolicies,
      rowChoices,
    });
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
            isOneOf(["asset_transfer", "asset_adjustment"], source.route),
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

function assertProjectedHistory(
  before: readonly ProjectedHistoryEvent[],
  after: readonly ProjectedHistoryEvent[],
): void {
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
    validatePortfolioAssetTransferHistory(asPartitionedTxns(afterRows));
    const prior = partitionOversellDeficits(asPartitionedTxns(beforeRows));
    const next = partitionOversellDeficits(asPartitionedTxns(afterRows));
    for (const [accountId, deficit] of next)
      if (deficit - (prior.get(accountId) ?? 0) > 1e-8)
        throw new ConflictError(
          "Reconciliation would create or worsen an oversold portfolio partition",
          { details: { reason: "projected_history_conflict" } },
        );
  }
}

function projectedReconciliationHistory({
  plan,
  adoptions,
  history,
  rows,
}: {
  plan: Pick<ReconciliationPlan, "actions">;
  adoptions: PlanAdoption[];
  history: HistoryImage[];
  rows: ReconciliationSourceRow[];
}): ProjectedHistoryEvent[] {
  const replacements = new Map(
    adoptions.map((item) => [Number(item.before.id), item.after]),
  );
  const proposedActions = plan.actions
    .filter((action) =>
      ["insert", "transfer", "adjustment"].includes(action.action),
    )
    .map((action) => ({
      action,
      // Insert, transfer and adjustment actions come from these matched rows.
      row: rows.find((row) => Number(row.id) === action.rowId)!,
    }))
    .sort((left, right) =>
      firstNonZero(
        left.row.tx_date!.localeCompare(right.row.tx_date!),
        Number(left.row.batch_id) - Number(right.row.batch_id),
        left.row.row_index - right.row.row_index,
      ),
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
  return [
    ...history.map((row) => replacements.get(Number(row.id)) ?? row),
    ...proposed,
  ];
}

/** Caller holds every selected batch lock, then account and portfolio writer locks. */
export async function applyPortfolioImportReconciliation({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  rowChoices = [],
}: ReconciliationScopeOptions) {
  const { plan, adoptions, settledDuplicates, cashAdoptions, history, rows } =
    await loadPlan({ batchIds, adoptPolicy, batchPolicies, rowChoices });
  if (!plan.ready)
    throw new ConflictError(
      "Import needs reconciliation before any history can be changed",
      {
        details: { reason: "reconciliation_required", blockers: plan.blockers },
      },
    );
  assertProjectedHistory(
    history,
    projectedReconciliationHistory({ plan, adoptions, history, rows }),
  );
  const adoptedByBatch = new Map<number, number>();
  for (const { row, before, after, policy } of adoptions) {
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
  // Duplicates and adoptions are disjoint counts: an adopted row is reported
  // once, as adopted, although its staging row is settled as a duplicate.
  const settledByBatch = new Map<number, number>();
  const settle = async (row: ReconciliationSourceRow, adopted = false) => {
    if (!(await markCrossFormatSourceDuplicate(row)))
      throw new ConflictError(
        "An import row changed during reconciliation",
        { details: { reason: "stale_existing_transaction" } },
      );
    if (!adopted)
      settledByBatch.set(
        Number(row.batch_id),
        (settledByBatch.get(Number(row.batch_id)) ?? 0) + 1,
      );
  };
  for (const row of settledDuplicates) await settle(row);
  for (const { row, decision } of cashAdoptions) {
    const [before] = await readIbkrCashImagesForUpdate([
      decision.transactionId,
    ]);
    if (
      !before ||
      !before.is_active ||
      Number(before.account_id) !== Number(row.account_id) ||
      before.date !== decision.existing.date ||
      before.currency !== decision.existing.currency ||
      !equalNumber(before.amount, decision.existing.amount, 4) ||
      (decision.reason === "manual_cash" &&
        (before.dedup_fingerprint != null || before.source_record_hash != null))
    )
      throw new ConflictError(
        "An existing cash transaction changed during reconciliation",
        { details: { reason: "stale_existing_transaction" } },
      );
    const binding = (source: { batchId: number; stagingRowId: number }) => ({
      id: source.stagingRowId,
      batch_id: source.batchId,
      account_id: Number(row.account_id),
      custom_config: null,
      staging: {},
    });
    const imported = { batchId: Number(row.batch_id), stagingRowId: Number(row.id) };
    const proof: IbkrCashProof =
      decision.reason === "ibkr_native_funding" && decision.original
        ? {
            kind: "ibkr_native_funding",
            version: 1,
            original: decision.original,
            native: imported,
            sourceBindings: [binding(decision.original), binding(imported)],
          }
        : { kind: "cash_adoption", version: 1, sourceBindings: [binding(imported)] };
    await writeCashAdoption({
      batchId: Number(row.batch_id),
      stagingRowId: Number(row.id),
      policy: decision.policy,
      before,
      after: {
        ...before,
        amount: decision.after.amount,
        currency: decision.after.currency as typeof before.currency,
        dedup_fingerprint: row.dedup_fingerprint,
        dedup_fingerprint_version: row.dedup_fingerprint_version,
      },
      proof,
    });
    await settle(row, true);
    adoptedByBatch.set(
      Number(row.batch_id),
      (adoptedByBatch.get(Number(row.batch_id)) ?? 0) + 1,
    );
  }
  return { plan, adoptedByBatch, settledByBatch };
}

/** The locked plan's custody events name these accounts. */
export async function getPortfolioImportPlanAccountIds(
  options: ReconciliationScopeOptions,
): Promise<number[]> {
  const { plan } = await loadPlan(options);
  return plan.actions
    .flatMap((action) => [
      action.transfer?.sourceAccountId,
      action.transfer?.destinationAccountId,
      action.adjustment?.accountId,
    ])
    .filter((id) => id != null);
}

/**
 * Validate every receipt a batch owns before rollback deletes anything.
 * Resolves to the batch's active adoption receipts (portfolio and IBKR cash).
 */
export async function validatePortfolioImportAdoptionRollback(
  batchId: number,
  removalRows: readonly { id: number | string; investment_id?: unknown }[],
): Promise<ReconciliationJournalRow[]> {
  const receipts = await getActiveAdoptionReceipts(batchId);
  await validateIbkrCashCorrectionRollback(receipts);
  const portfolioReceipts = receipts.filter(
    (receipt) => !isIbkrCashReceipt(receipt),
  );
  const repairs = await getActiveDuplicateRepairReceipts(batchId);
  await validateDuplicatePortfolioRepairRollback(repairs);
  const sourceRows = await readReconciliationSources([batchId]);
  const history = await readReconciliationHistory([
    ...new Set([
      ...portfolioReceipts.map((receipt) => receipt.before_data.investment_id),
      ...repairs.map((receipt) => receipt.before_data.legacy.investment_id),
      ...sourceRows.map((row) => Number(row.investment_id)).filter(Boolean),
      ...removalRows.map((row) => Number(row.investment_id)).filter(Boolean),
    ]),
  ]);
  for (const receipt of portfolioReceipts) {
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
  const restored = new Map<number, ProjectedHistoryEvent>([
    ...portfolioReceipts.map((receipt): [number, ProjectedHistoryEvent] => [
      Number(receipt.transaction_id),
      receipt.before_data,
    ]),
    ...repairs.map((receipt): [number, ProjectedHistoryEvent] => [
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
    // A repair receipt's before-image holds the imported copy it deleted.
    ...repairs.map((receipt) =>
      financialRepairImage(receipt.before_data.imported!),
    ),
  ]);
  return receipts;
}

/** Compare receipt snapshots; an absent accounting role means `standard`. */
function sameSnapshot(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  if (!left || !right) return false;
  const normalize = (image: Record<string, unknown>) => {
    const { income_recognition_role: role, ...rest } = image;
    return role == null || role === "standard" ? rest : image;
  };
  const leftImage = normalize(left);
  const rightImage = normalize(right);
  const keys = Object.keys(leftImage).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(rightImage).sort()) &&
    keys.every((key) => leftImage[key] === rightImage[key])
  );
}

export async function restorePortfolioImportAdoptions(
  receipts: readonly ReconciliationJournalRow[],
): Promise<void> {
  for (const receipt of receipts) {
    if (isIbkrCashReceipt(receipt)) {
      await restoreIbkrCashCorrection(receipt);
      continue;
    }
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
