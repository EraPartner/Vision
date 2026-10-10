/** Native funding evidence corrects retained base-currency cash, never trades. */
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { Decimal, toDecimal } from "../lib/money.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import { assignImportIdentities, portfolioIdentityBase } from "./importIdentity.ts";
import { getIbkrFundingPrimaryEvidence } from "./portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import {
  readIbkrCashCorrectionContext,
  readIbkrCashImagesForUpdate,
  writeIbkrCashCorrection,
  writeIbkrCashCorrectionRepeat,
  writeIbkrCashRestoration,
  guardOriginalIbkrCashRollback,
} from "../repositories/portfolioImportCashRepository.ts";
import type {
  CashTransactionSnapshot,
  IbkrBaseCashEvidence,
  IbkrCashCorrectionAction,
  IbkrCashCorrectionContext,
  IbkrCashEnvelope,
  IbkrCashFinancialImage,
  IbkrCashProof,
  IbkrCashSourceBinding,
  IbkrFundingEvidence,
} from "../repositories/portfolioImportCashRepository.ts";
import type {
  ReconciliationBatchScopeRow,
  ReconciliationSourceRow,
} from "../repositories/portfolioImportReconciliationRepository.ts";

/**
 * A staged cash row from any reader (reconciliation sources, commit chunks).
 * Every field read here is re-validated before it proves anything.
 */
type StagedCashRow = Readonly<Partial<Record<string, unknown>>>;
/** A batch row carrying at least its id, account, status and config. */
type CashBatchRow = Pick<ReconciliationBatchScopeRow, "id" | "account_id" | "status" | "custom_config">;
type CashReceiptLike = { before_data: unknown; after_data: unknown };
type IbkrCashReceiptOf<T> = T & {
  id: string | number;
  transaction_id: number;
  action: string;
  policy: string;
  before_data: IbkrCashEnvelope;
  after_data: IbkrCashEnvelope;
};
interface OwnerEvidence {
  proof: IbkrBaseCashEvidence;
  reference?: { row: StagedCashRow; batch: CashBatchRow | undefined; proof: IbkrBaseCashEvidence };
}
interface CashCorrectionBlocker {
  reason: string;
  batchId: number;
  rowId: number;
  rowOrdinal: number;
  candidateTransactionIds: number[];
}
export interface IbkrCashCorrectionProofResult {
  actions: IbkrCashCorrectionAction[];
  duplicates: IbkrCashCorrectionAction[];
  blockers: CashCorrectionBlocker[];
  originalBatchIds: number[];
  contextFingerprint: string;
}

export { readIbkrCashCorrectionContext, guardOriginalIbkrCashRollback };
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const clean = (value: unknown): string => String(value ?? "").trim().replace(/^-$/, "");
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const fingerprint = (value: unknown): string => hash(JSON.stringify(canonical(value)));
/** Batch config as stored; a legacy reader may still hand over its JSON text. */
const json = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
/** `value?.[key]` on parsed JSON: a member of an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const isString = (value: unknown): value is string => typeof value === "string";
// toDecimal on a staged value; any other JSON type throws, as toDecimal did.
const decimal = (value: unknown): Decimal => {
  if (value == null || typeof value === "string" || typeof value === "number" || value instanceof Decimal) return toDecimal(value);
  throw new TypeError("Expected a decimal value");
};
const date = (value: unknown): string => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "");
const amount = (value: unknown): string => decimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
const zero = (value: unknown): boolean => value == null || decimal(value).eq(0);
const equal4 = (left: unknown, right: unknown): boolean => amount(left) === amount(right);
const stale = () => new ConflictError("IBKR cash source or ledger image changed", { details: { reason: "cash_receipt_changed" } });

/** Full account equality, or a masked account with at least four literal digits. */
function ibkrFundingAccountMatches(left: unknown, right: unknown): boolean {
  const a = clean(left).toUpperCase();
  const b = clean(right).toUpperCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const matchesMask = (masked: string, full: string): boolean => {
    if (!/^[UX*]+\d{4,}$/.test(masked) || !/[X*]/.test(masked) || !/^U\d+$/.test(full)) return false;
    const suffix = /\d+$/.exec(masked)?.[0];
    return !!suffix && full.endsWith(suffix);
  };
  return matchesMask(a, b) || matchesMask(b, a);
}

function record(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 100000) return undefined;
  const rows: string[][] = parse(raw, { skip_empty_lines: true });
  return rows.length === 1 ? rows[0] : undefined;
}
function number(value: unknown, optional = false): Decimal | undefined {
  const literal = clean(value);
  if (!literal) return optional ? toDecimal(0) : undefined;
  return /^[+-]?\d+(?:[.,]\d+)?$/.test(literal) ? toDecimal(literal.replace(",", ".")) : undefined;
}

/** Reauthenticate the old literal cash event and every staged economic field. */
function getIbkrBaseCashEvidence(
  row: StagedCashRow,
  batch: CashBatchRow | undefined = undefined,
): IbkrBaseCashEvidence | undefined {
  try {
    const config = json(batch?.custom_config ?? row.custom_config);
    const context = field(config, "ibkr_source_context");
    const sourceFileHash = field(context, "source_file_hash");
    const sourceColumns = field(context, "source_columns");
    const recordHashes = field(context, "record_hashes");
    const baseCurrency = field(context, "base_currency");
    if (field(config, "format") !== "ibkr_transaction_history" || field(context, "version") !== 1 ||
      !isString(sourceFileHash) || !/^[a-f0-9]{64}$/.test(sourceFileHash) || !Array.isArray(sourceColumns) ||
      !Array.isArray(recordHashes) || !isString(baseCurrency) || !/^[A-Z]{3}$/.test(baseCurrency)) return undefined;
    const header = record(field(context, "header_record"));
    const summary = record(field(context, "summary_base_currency_record"));
    if (header?.[0] !== "Transaction History" || header[1] !== "Header" || summary?.[0] !== "Summary" ||
      summary[1] !== "Data" || clean(summary[2]) !== "Base Currency" || clean(summary[3]) !== baseCurrency ||
      JSON.stringify(header.slice(2).map(clean)) !== JSON.stringify(sourceColumns) ||
      // Equal to the cleaned header text, so every column name is a string.
      !sourceColumns.every(isString) ||
      new Set(sourceColumns).size !== sourceColumns.length) return undefined;
    const raw = row.raw_data;
    if (typeof raw !== "string" || hash(raw) !== row.source_record_hash || !recordHashes.includes(hash(raw))) return undefined;
    const values = record(raw);
    if (values?.[0] !== "Transaction History" || values[1] !== "Data" || values.length !== sourceColumns.length + 2) return undefined;
    const literal: Record<string, string> = Object.fromEntries(sourceColumns.map((key, index) => [key, clean(values[index + 2])]));
    const transactionType = literal["Transaction Type"];
    const type = transactionType === "Deposit" ? "deposit" : transactionType === "Withdrawal" ? "withdrawal" : undefined;
    const gross = number(literal["Gross Amount"]);
    const net = number(literal["Net Amount"]);
    const fx = number(literal["Exchange Rate"]);
    const commission = number(literal.Commission, true);
    const fees = number(literal["Transaction Fees"], true);
    if (!type || !gross || !net || !fx?.gt(0) || !commission?.eq(0) || !fees?.eq(0) || !gross.eq(net) ||
      (type === "deposit" ? !gross.gt(0) : !gross.lt(0)) || row.route !== "cash" || row.type != null ||
      row.type_raw !== literal["Transaction Type"] || row.investment_id != null || clean(row.symbol_raw) || clean(row.name_raw) ||
      row.units != null || row.price_per_unit != null || !zero(row.fees) || !zero(row.taxes) || !zero(row.fx_rate_to_eur) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(literal.Date ?? "") || literal.Date !== date(row.tx_date) || !literal.Account ||
      literal.Account !== row.source_account_identity || row.currency !== baseCurrency || literal["Price Currency"] ||
      !equal4(gross.abs(), row.amount) || clean(row.note) !== literal.Description ||
      !Number.isInteger(Number(row.account_id ?? batch?.account_id)) || Number(row.account_id ?? batch?.account_id) <= 0 ||
      (batch && Number(row.batch_id) !== Number(batch.id))) return undefined;
    return {
      version: 1, batchId: Number(row.batch_id), stagingRowId: Number(row.id), type, date: literal.Date!,
      baseCurrency, baseAmount: gross.toFixed(), fxRate: fx.toFixed(),
      // Equal to the staged source_record_hash, checked above.
      sourceAccount: literal.Account, sourceRecordHash: hash(raw),
      sourceFileHash, rawData: raw,
    };
  } catch { return undefined; }
}

const financialKeys = ["id", "date", "amount", "currency", "memo", "comment", "balance", "account_id", "recipient_id",
  "recipient_bank_account_id", "is_active", "import_batch_id", "source_record_hash", "dedup_fingerprint",
  "dedup_fingerprint_version"] as const satisfies readonly (keyof IbkrCashFinancialImage)[];
type CashImageSource = Partial<Record<keyof IbkrCashFinancialImage, unknown>>;
export function ibkrCashFinancialImage(snapshot: CashImageSource | null | undefined): IbkrCashFinancialImage {
  return Object.fromEntries(financialKeys.map((key) => [key, snapshot?.[key] ?? null])) as IbkrCashFinancialImage;
}
function ibkrCashImageEqual(left: CashImageSource | null | undefined, right: CashImageSource | null | undefined): boolean {
  return !!left && !!right && fingerprint(ibkrCashFinancialImage(left)) === fingerprint(ibkrCashFinancialImage(right));
}
/** Journal rows hold portfolio and cash receipts; this narrows to the cash kind. */
export function isIbkrCashReceipt<T extends CashReceiptLike>(receipt: T): receipt is IbkrCashReceiptOf<T> {
  const before = receipt?.before_data as Partial<IbkrCashEnvelope> | undefined;
  const after = receipt?.after_data as Partial<IbkrCashEnvelope> | undefined;
  return before?.ledgerKind === "cash" && after?.ledgerKind === "cash" &&
    before.version === 1 && after.version === 1 && after.proof?.kind === "ibkr_native_funding";
}
export const isIbkrCashCorrectionReceipt = isIbkrCashReceipt;

const bindingKeys = ["id", "batch_id", "row_index", "status", "tx_date", "type_raw", "type", "route", "symbol_raw", "name_raw",
  "units", "price_per_unit", "amount", "fees", "taxes", "currency", "fx_rate_to_eur", "raw_data", "source_record_hash",
  "source_transaction_id", "source_account_identity", "dedup_fingerprint", "dedup_fingerprint_version", "dedup_occurrence", "note", "committed_txn_id"];
const numericBindingKeys = new Set<string>(["id", "batch_id", "row_index", "units", "price_per_unit", "amount", "fees", "taxes", "fx_rate_to_eur",
  "dedup_fingerprint_version", "dedup_occurrence", "committed_txn_id"]);
function sourceBinding(row: StagedCashRow, batch: CashBatchRow | undefined): IbkrCashSourceBinding {
  const staging = Object.fromEntries(bindingKeys.filter((key) => key in row).map((key) => [key,
    key === "tx_date" ? date(row[key]) : numericBindingKeys.has(key) && row[key] != null ? Number(row[key]) : row[key] ?? null]));
  return { id: Number(row.id), batch_id: Number(row.batch_id), account_id: Number(batch?.account_id ?? row.account_id),
    custom_config: json(batch?.custom_config ?? row.custom_config), staging };
}
function sameNative(left: IbkrFundingEvidence, right: IbkrFundingEvidence): boolean {
  return left.type === right.type && left.date === right.date && left.currency === right.currency && equal4(left.amount, right.amount) &&
    left.sourceId === right.sourceId && ibkrFundingAccountMatches(left.sourceAccount, right.sourceAccount);
}
function oldLedgerEqualsSource(
  current: CashTransactionSnapshot | undefined,
  source: ReconciliationSourceRow,
  proof: IbkrBaseCashEvidence,
): boolean {
  // The original's proof authenticated its Deposit/Withdrawal type_raw.
  return !!current && current.is_active === true && Number(current.id) === Number(source.committed_txn_id) &&
    Number(current.account_id) === Number(source.account_id) && current.date === proof.date && current.currency === proof.baseCurrency &&
    equal4(current.amount, proof.baseAmount) && current.memo === (source.note || source.type_raw!.toUpperCase()) &&
    current.balance == null && (current.import_batch_id == null || Number(current.import_batch_id) === Number(source.batch_id)) &&
    current.source_record_hash === source.source_record_hash && current.dedup_fingerprint === source.dedup_fingerprint &&
    Number(current.dedup_fingerprint_version) === Number(source.dedup_fingerprint_version);
}

const ownerReferenceKeys = ["route", "type", "type_raw", "tx_date", "investment_id", "account_id", "symbol_raw", "name_raw", "units",
  "price_per_unit", "amount", "fees", "taxes", "currency", "fx_rate_to_eur", "note", "raw_data", "source_record_hash",
  "source_transaction_id", "source_account_identity", "dedup_fingerprint", "dedup_fingerprint_version", "dedup_occurrence"];
function ownerReferenceImage(row: StagedCashRow): Record<string, unknown> {
  return Object.fromEntries(ownerReferenceKeys.map((key) => [key, key === "tx_date" ? date(row[key])
    : numericBindingKeys.has(key) && row[key] != null ? decimal(row[key]).toFixed() : row[key] ?? null]));
}
/** Missing legacy context is bridged only through a literal-identical retained source. */
export function getIbkrCashOwnerEvidence(
  row: StagedCashRow,
  batch: CashBatchRow | undefined,
  sources: readonly StagedCashRow[],
  batches: readonly CashBatchRow[],
): OwnerEvidence | undefined {
  const direct = getIbkrBaseCashEvidence(row, batch);
  if (direct) return { proof: direct };
  try {
    const ownerConfig = json(batch?.custom_config ?? row.custom_config);
    if (field(ownerConfig, "format") !== "ibkr_transaction_history" || field(ownerConfig, "ibkr_source_context") != null ||
      typeof row.raw_data !== "string" || hash(row.raw_data) !== row.source_record_hash) return undefined;
    const references = sources.filter((candidate) => Number(candidate.batch_id) !== Number(row.batch_id) && candidate.raw_data === row.raw_data)
      .map((candidate) => ({ row: candidate, batch: batches.find((item) => Number(item.id) === Number(candidate.batch_id)) }))
      .filter((candidate) => field(json(candidate.batch?.custom_config ?? candidate.row.custom_config), "ibkr_source_context") != null);
    if (!references.length) return undefined;
    const authenticated = references.map((reference) => ({ ...reference,
      proof: getIbkrBaseCashEvidence(reference.row, reference.batch) }));
    const expected = fingerprint(ownerReferenceImage(row));
    const proven = authenticated.filter((reference): reference is typeof reference & { proof: IbkrBaseCashEvidence } =>
      !!reference.proof && fingerprint(ownerReferenceImage(reference.row)) === expected);
    if (proven.length !== authenticated.length) return undefined;
    proven.sort((left, right) => Number(left.row.batch_id) - Number(right.row.batch_id) || Number(left.row.id) - Number(right.row.id));
    const reference = proven[0]!;
    return { proof: { ...reference.proof, batchId: Number(row.batch_id), stagingRowId: Number(row.id), sourceFileHash: null,
      contextOrigin: "retained_repeat_source" }, reference };
  } catch { return undefined; }
}
function receiptOriginalSourcesEqual(
  receipt: { after_data: IbkrCashEnvelope },
  context: IbkrCashCorrectionContext,
): boolean {
  const bindings = receipt.after_data.proof?.sourceBindings?.filter((binding) => field(binding.custom_config, "format") === "ibkr_transaction_history");
  if (!bindings?.length) return false;
  return bindings.every((binding) => {
    const row = context.sources.find((source) => Number(source.id) === Number(binding.id) && Number(source.batch_id) === Number(binding.batch_id));
    const batch = context.batches.find((source) => Number(source.id) === Number(binding.batch_id));
    return !!row && !!batch && fingerprint(sourceBinding(row, batch)) === fingerprint(binding);
  });
}

/** One-to-one proof joins a native export to an already committed original. */
export function proveIbkrCashCorrections(
  nativeRows: readonly ReconciliationSourceRow[],
  nativeBatches: readonly ReconciliationBatchScopeRow[],
  context: IbkrCashCorrectionContext,
): IbkrCashCorrectionProofResult {
  const actions: IbkrCashCorrectionAction[] = [];
  const duplicates: IbkrCashCorrectionAction[] = [];
  const blockers: CashCorrectionBlocker[] = [];
  const originalBatchIds = new Set<number>();
  const originalBatches = new Map(context.batches.map((batch) => [Number(batch.id), batch]));
  // Legacy validation hashed a PostgreSQL DATE through a timezone-sensitive
  // Date conversion. Preserve that opaque identity; literal source facts and
  // exact owner/reference/ledger equality authenticate it without guessing dates.
  const parsedOriginals = context.sources.filter((row) => row.route === "cash" && row.committed_txn_id != null)
    .map((row) => {
      const ownerEvidence = getIbkrCashOwnerEvidence(row, originalBatches.get(Number(row.batch_id)), context.sources, context.batches);
      return { row, batch: originalBatches.get(Number(row.batch_id)),
        identityValid: /^[a-f0-9]{64}$/.test(row.dedup_fingerprint || "") && Number(row.dedup_fingerprint_version) === 1,
        proof: ownerEvidence?.proof, reference: ownerEvidence?.reference };
    });
  const identities = assignImportIdentities([...nativeRows], (row) => portfolioIdentityBase(row, { accountIdentity: "UNASSIGNED" }));
  const originalUse = new Map<number, ReconciliationSourceRow[]>();
  const nativeUse = new Map<string, ReconciliationSourceRow[]>();
  const issue = (row: ReconciliationSourceRow, reason: string, candidates: readonly { row: StagedCashRow }[] = []) => blockers.push({ reason, batchId: Number(row.batch_id), rowId: Number(row.id),
    rowOrdinal: Number(row.row_index ?? 0) + 1, candidateTransactionIds: candidates.map((item) => Number(item.row.committed_txn_id)) });
  for (const [index, row] of nativeRows.entries()) {
    const batch = nativeBatches.find((candidate) => Number(candidate.id) === Number(row.batch_id));
    const native = getIbkrFundingPrimaryEvidence({ ...row, custom_config: batch?.custom_config ?? row.custom_config });
    if (!batch || !native || !["matched", "duplicate"].includes(row.status) || !["awaiting_review", "complete", "complete_with_errors"].includes(batch.status) ||
      Number(row.account_id ?? batch.account_id) !== Number(batch.account_id) || !Number(batch.account_id) ||
      row.dedup_fingerprint !== identities[index]?.fingerprint || Number(row.dedup_fingerprint_version) !== identities[index]?.version) {
      issue(row, "ibkr_native_funding_unverified"); continue;
    }
    const compatible = parsedOriginals.filter((item): item is typeof item & { proof: IbkrBaseCashEvidence } => !!item.proof && item.proof.type === native.type && item.proof.date === native.date &&
      Number(item.row.account_id) === Number(batch.account_id) && ibkrFundingAccountMatches(item.proof.sourceAccount, native.sourceAccount));
    const nativeSigned = toDecimal(native.amount).abs().times(native.type === "withdrawal" ? -1 : 1);
    const matching = compatible.filter((item) => equal4(nativeSigned.times(item.proof.fxRate), item.proof.baseAmount));
    if (matching.length !== 1) { issue(row, matching.length ? "ibkr_native_funding_ambiguous" : "ibkr_native_funding_source_missing", compatible); continue; }
    const original = matching[0]!;
    originalBatchIds.add(Number(original.row.batch_id));
    if (original.reference) originalBatchIds.add(Number(original.reference.row.batch_id));
    const source = original.row;
    const current = context.ledger.find((item) => Number(item.id) === Number(source.committed_txn_id));
    const receipts = (context.receipts ?? []).filter((receipt) => isIbkrCashReceipt(receipt) &&
      Number(receipt.transaction_id) === Number(source.committed_txn_id) &&
      receipt.after_data.proof.original.sourceRecordHash === source.source_record_hash);
    const id = Number(source.committed_txn_id);
    const claim = `${native.sourceAccount}:${native.sourceId}`;
    originalUse.set(id, [...(originalUse.get(id) ?? []), row]);
    nativeUse.set(claim, [...(nativeUse.get(claim) ?? []), row]);
    if (!original.identityValid || source.status !== "committed" || !["complete", "complete_with_errors"].includes(String(original.batch?.status)) ||
      !current || receipts.length > 1) { issue(row, "ibkr_native_funding_ledger_changed", matching); continue; }
    if (receipts.length === 1) {
      const receipt = receipts[0]!;
      if (!receiptOriginalSourcesEqual(receipt, context) || !sameNative(receipt.after_data.proof.native, native) || !ibkrCashImageEqual(receipt.after_data.snapshot, current) ||
        Number(current.account_id) !== Number(batch.account_id) || current.is_active !== true) {
        issue(row, "ibkr_native_funding_ledger_changed", matching); continue;
      }
      duplicates.push({ action: "duplicate", policy: "prefer_source", corrections: [], row, originalRow: source, transactionId: id, receiptId: Number(receipt.id),
        before: receipt.before_data, after: receipt.after_data, sourceBindings: [sourceBinding(source, original.batch), sourceBinding(row, batch),
          ...(original.reference ? [sourceBinding(original.reference.row, original.reference.batch)] : [])],
        settled: row.status === "duplicate" });
      continue;
    }
    if (row.status !== "matched" || !oldLedgerEqualsSource(current, source, original.proof)) {
      issue(row, "ibkr_native_funding_ledger_changed", matching); continue;
    }
    const snapshot = ibkrCashFinancialImage(current);
    const afterSnapshot = { ...snapshot, amount: amount(nativeSigned), currency: native.currency,
      dedup_fingerprint: row.dedup_fingerprint, dedup_fingerprint_version: Number(row.dedup_fingerprint_version) };
    if (context.ledger.some((item) => Number(item.id) !== id && item.dedup_fingerprint === afterSnapshot.dedup_fingerprint &&
      Number(item.dedup_fingerprint_version) === afterSnapshot.dedup_fingerprint_version)) {
      issue(row, "ibkr_native_funding_duplicate_identity", matching); continue;
    }
    const proof: IbkrCashProof = { kind: "ibkr_native_funding", version: 1, original: original.proof, native,
      oldFingerprint: snapshot.dedup_fingerprint, newFingerprint: afterSnapshot.dedup_fingerprint,
      ...(original.reference ? { primaryReference: original.reference.proof } : {}),
      sourceBindings: [sourceBinding(source, original.batch), sourceBinding(row, batch),
        ...(original.reference ? [sourceBinding(original.reference.row, original.reference.batch)] : [])] };
    proof.sourceBindings[1]!.staging.status = "duplicate";
    proof.sourceBindings[1]!.staging.committed_txn_id = null;
    const envelope = (image: IbkrCashFinancialImage): IbkrCashEnvelope => ({ ledgerKind: "cash", version: 1, snapshot: image, proof });
    actions.push({ action: "adopt", policy: "prefer_source", settled: false, row, originalRow: source, transactionId: id,
      before: envelope(snapshot), after: envelope(afterSnapshot), proof,
      corrections: (["amount", "currency"] as const).filter((key) => snapshot[key] !== afterSnapshot[key]).map((key) => ({ field: key, before: snapshot[key], after: afterSnapshot[key] })),
      sourceBindings: [sourceBinding(source, original.batch), sourceBinding(row, batch),
        ...(original.reference ? [sourceBinding(original.reference.row, original.reference.batch)] : [])] });
  }
  for (const group of [...originalUse.values(), ...nativeUse.values()]) if (group.length > 1)
    for (const row of group) if (!blockers.some((item) => item.rowId === Number(row.id))) issue(row, "ibkr_native_funding_ambiguous");
  const blocked = new Set(blockers.map((item) => item.rowId));
  return { actions: actions.filter((action) => !blocked.has(Number(action.row.id))),
    duplicates: duplicates.filter((action) => !blocked.has(Number(action.row.id))), blockers,
    originalBatchIds: [...originalBatchIds].sort((a, b) => a - b),
    contextFingerprint: fingerprint({ nativeRows, nativeBatches, context }) };
}

export function applyIbkrCashCorrection(action: IbkrCashCorrectionAction): ReturnType<typeof writeIbkrCashCorrection> {
  return writeIbkrCashCorrection(action);
}
export function settleIbkrCashCorrectionRepeat(action: IbkrCashCorrectionAction): Promise<{ recordedCash: 0 }> {
  return action.settled ? Promise.resolve({ recordedCash: 0 as const }) : writeIbkrCashCorrectionRepeat(action);
}
export async function validateIbkrCashCorrectionRollback<T extends CashReceiptLike>(
  receipts: readonly T[],
): Promise<IbkrCashReceiptOf<T>[]> {
  const cash = receipts.filter((receipt): receipt is IbkrCashReceiptOf<T> => isIbkrCashReceipt(receipt));
  const ids = cash.map((receipt) => Number(receipt.transaction_id));
  if (new Set(ids).size !== ids.length) throw stale();
  const current = await readIbkrCashImagesForUpdate(ids);
  for (const receipt of cash) {
    if (receipt.action !== "adopt" || receipt.policy !== "prefer_source" ||
      Number(receipt.after_data.snapshot.id) !== Number(receipt.transaction_id) ||
      Number(receipt.before_data.snapshot.id) !== Number(receipt.transaction_id) ||
      fingerprint(receipt.after_data.proof) !== fingerprint(receipt.before_data.proof) ||
      !ibkrCashImageEqual(receipt.after_data.snapshot, current.find((item) => Number(item.id) === Number(receipt.transaction_id)))) throw stale();
  }
  return cash;
}
export function restoreIbkrCashCorrection(
  receipt: Parameters<typeof writeIbkrCashRestoration>[0],
): ReturnType<typeof writeIbkrCashRestoration> {
  return writeIbkrCashRestoration(receipt);
}

/** An old base-currency repeat may resolve only through an intact native receipt. */
export function originalCashFingerprintAlreadyCorrected(
  row: StagedCashRow,
  context: IbkrCashCorrectionContext,
): number | undefined {
  const original = getIbkrCashOwnerEvidence(row, context.batches.find((batch) => Number(batch.id) === Number(row.batch_id)),
    context.sources, context.batches)?.proof;
  if (!original) return undefined;
  const matches = (context.receipts ?? []).filter((receipt) => isIbkrCashReceipt(receipt) &&
    receipt.before_data.snapshot.dedup_fingerprint === row.dedup_fingerprint &&
    Number(receipt.before_data.snapshot.dedup_fingerprint_version) === Number(row.dedup_fingerprint_version) &&
    receipt.after_data.proof.original.sourceRecordHash === row.source_record_hash &&
    receipt.after_data.proof.original.sourceAccount === original.sourceAccount &&
    receipt.after_data.proof.original.date === original.date &&
    receipt.after_data.proof.original.type === original.type &&
    receipt.after_data.proof.original.baseCurrency === original.baseCurrency &&
    toDecimal(receipt.after_data.proof.original.baseAmount).eq(original.baseAmount) &&
    toDecimal(receipt.after_data.proof.original.fxRate).eq(original.fxRate) &&
    Number(receipt.after_data.snapshot.account_id) === Number(row.account_id));
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw stale();
  const receipt = matches[0]!;
  const current = context.ledger.find((item) => Number(item.id) === Number(receipt.transaction_id));
  if (!receiptOriginalSourcesEqual(receipt, context) || !ibkrCashImageEqual(receipt.after_data.snapshot, current) || current?.is_active !== true) throw stale();
  return Number(receipt.transaction_id);
}
async function findIbkrCashSourceAlias(row: StagedCashRow): Promise<number | undefined> {
  return originalCashFingerprintAlreadyCorrected(row, await readIbkrCashCorrectionContext());
}

export {
  findIbkrCashSourceAlias as __findIbkrCashSourceAlias,
  getIbkrBaseCashEvidence as __getIbkrBaseCashEvidence,
  ibkrCashImageEqual as __ibkrCashImageEqual,
  ibkrFundingAccountMatches as __ibkrFundingAccountMatches,
};
