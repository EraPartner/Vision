import { describe, expect, it } from "vitest";
import { syntheticIbkrCashCorrection } from "./helpers/ibkrCashReconciliation.ts";
import type { IbkrCashCorrectionOptions } from "./helpers/ibkrCashReconciliation.ts";
import { loose } from "./helpers/partial.ts";
import {
  __getIbkrBaseCashEvidence,
  __ibkrFundingAccountMatches,
  __ibkrCashImageEqual,
  originalCashFingerprintAlreadyCorrected,
  proveIbkrCashCorrections,
} from "../src/services/portfolioIbkrCashReconciliation.ts";
import type { IbkrCashCorrectionContext } from "../src/repositories/portfolioImportCashRepository.ts";
import type { ReconciliationBatchScopeRow, ReconciliationSourceRow } from "../src/repositories/portfolioImportReconciliationRepository.ts";

type Fixture = ReturnType<typeof syntheticIbkrCashCorrection>;
type WireRow = Record<string, unknown>;
// The synthetic rows are wire-shaped, and the cases splice partial rows,
// receipts and after-images into the context as the DB would return them.
type Source = Omit<Fixture, "context"> & {
  context: { ledger: WireRow[]; sources: WireRow[]; batches: WireRow[]; receipts: WireRow[] };
};
const fixture = (options?: IbkrCashCorrectionOptions): Source => syntheticIbkrCashCorrection(options);
const prove = (rows: unknown[], batches: unknown, context: Source["context"]) => proveIbkrCashCorrections(
  loose<ReconciliationSourceRow[]>(rows), loose<ReconciliationBatchScopeRow[]>(batches), loose<IbkrCashCorrectionContext>(context));
const plan = (source: Source) => prove([source.native], source.nativeBatches, source.context);

describe("IBKR native funding correction proof", () => {
  it("adopts the existing cash ID, retaining source identity, notes and account", () => {
    const source = fixture();
    const result = plan(source);
    expect(result.blockers).toEqual([]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ action: "adopt", transactionId: 40, before: { ledgerKind: "cash", snapshot: { amount: "80.0000", currency: "EUR" } },
      after: { ledgerKind: "cash", snapshot: { id: 40, amount: "100.0000", currency: "USD", memo: source.original.note,
        comment: "Keep user comment", account_id: 7, import_batch_id: null, source_record_hash: source.original.source_record_hash,
        dedup_fingerprint: source.native.dedup_fingerprint } } });
    expect(result.actions[0].after.snapshot).not.toHaveProperty("category_id");
    expect(result.actions[0].after.snapshot).not.toHaveProperty("transfer_peer_id");
    expect(result.originalBatchIds).toEqual([1]);
  });
  it("uses exactly four-decimal base rounding, not a loose amount tolerance", () => {
    expect(plan(fixture({ baseAmount: "81.2345", rate: "0.812345" })).blockers).toEqual([]);
    expect(plan(fixture({ baseAmount: "81.2346", rate: "0.812345" })).actions).toHaveLength(0);
  });
  it("retains the withdrawal debit sign while adopting the literal native amount", () => {
    const result = plan(fixture({ kind: "withdrawal" }));
    expect(result.blockers).toEqual([]);
    expect(result.actions[0]).toMatchObject({ before: { snapshot: { amount: "-80.0000", currency: "EUR" } },
      after: { snapshot: { amount: "-100.0000", currency: "USD" } }, proof: { native: { type: "withdrawal", status: "Sent" } } });
  });
  it("binds a missing-context owner to the lowest consistent literal-identical retained reference", () => {
    const source = fixture();
    const reference = { ...source.original, id: 30, batch_id: 3, status: "duplicate", committed_txn_id: null };
    const config = structuredClone(source.original.custom_config);
    delete (source.original.custom_config as Partial<Fixture["original"]["custom_config"]>).ibkr_source_context;
    source.context.sources.push(reference, { ...reference, id: 40, batch_id: 4 });
    source.context.batches.push({ id: 3, account_id: 7, status: "complete", custom_config: config }, { id: 4, account_id: 7, status: "complete", custom_config: config });
    const result = plan(source);
    expect(result.blockers).toEqual([]);
    expect(result.actions[0].proof).toMatchObject({ original: { batchId: 1, stagingRowId: 10, sourceFileHash: null, contextOrigin: "retained_repeat_source" },
      primaryReference: { batchId: 3, stagingRowId: 30, sourceFileHash: config.ibkr_source_context.source_file_hash } });
    expect(result.actions[0].sourceBindings).toHaveLength(3);
    expect(result.originalBatchIds).toEqual([1, 3]);
    expect(source.original.custom_config).not.toHaveProperty("ibkr_source_context");
  });
  it.each(["account", "amount", "rawHash", "context", "date", "fingerprint"])("rejects a missing-context bridge with changed reference %s", (kind) => {
    const source = fixture();
    const config = structuredClone(source.original.custom_config);
    const reference = { ...source.original, id: 30, batch_id: 3, status: "duplicate", committed_txn_id: null, custom_config: config };
    delete (source.original.custom_config as Partial<Fixture["original"]["custom_config"]>).ibkr_source_context;
    source.context.sources.push(reference);
    source.context.batches.push({ id: 3, account_id: 7, status: "complete", custom_config: config });
    if (kind === "account") reference.source_account_identity = "U99999999";
    if (kind === "amount") reference.amount = "81";
    if (kind === "rawHash") reference.source_record_hash = "f".repeat(64);
    if (kind === "context") config.ibkr_source_context.record_hashes = [];
    if (kind === "date") reference.tx_date = "2026-01-02";
    if (kind === "fingerprint") reference.dedup_fingerprint = "f".repeat(64);
    expect(plan(source).actions).toEqual([]);
    expect(plan(source).blockers).not.toHaveLength(0);
  });
  it("does not conceal an invalid present owner context by using a valid repeat", () => {
    const source = fixture();
    const config = structuredClone(source.original.custom_config);
    source.original.custom_config.ibkr_source_context.record_hashes = [];
    source.context.sources.push({ ...source.original, id: 30, batch_id: 3, status: "duplicate", committed_txn_id: null, custom_config: config });
    source.context.batches.push({ id: 3, account_id: 7, status: "complete", custom_config: config });
    expect(plan(source).actions).toEqual([]);
  });
  it("preserves a legacy opaque fingerprint and recognizes its intact source repeat", () => {
    const source = fixture();
    source.original.dedup_fingerprint = "a".repeat(64);
    source.context.ledger[0].dedup_fingerprint = source.original.dedup_fingerprint;
    const adopted = plan(source).actions[0];
    expect(adopted.before.snapshot.dedup_fingerprint).toBe("a".repeat(64));
    source.context.ledger[0] = adopted.after.snapshot;
    source.context.receipts.push({ id: 90, transaction_id: 40, before_data: adopted.before, after_data: adopted.after });
    expect(originalCashFingerprintAlreadyCorrected(source.original, loose<IbkrCashCorrectionContext>(source.context))).toBe(40);
    expect(originalCashFingerprintAlreadyCorrected({ ...source.original, dedup_fingerprint: "b".repeat(64) }, loose<IbkrCashCorrectionContext>(source.context))).toBeUndefined();
  });
  it.each(["raw", "context", "grossNet", "baseCurrency", "date", "sourceAccount", "route", "instrument", "fingerprint"])("rejects altered original %s evidence", (kind) => {
    const source = fixture();
    if (kind === "raw") source.original.raw_data += " ";
    if (kind === "context") source.original.custom_config.ibkr_source_context.record_hashes = [];
    if (kind === "grossNet") source.original.amount = "81";
    if (kind === "baseCurrency") source.original.currency = "USD";
    if (kind === "date") source.original.tx_date = "2026-01-02";
    if (kind === "sourceAccount") source.original.source_account_identity = "U87654321";
    if (kind === "route") source.original.route = "portfolio";
    if (kind === "instrument") source.original.symbol_raw = "SHARES";
    if (kind === "fingerprint") source.original.dedup_fingerprint = "f".repeat(64);
    expect(plan(source).actions).toHaveLength(0);
    expect(plan(source).blockers).not.toHaveLength(0);
  });
  it.each(["amount", "currency", "date", "memo", "is_active", "source_record_hash", "dedup_fingerprint", "account_id"])("rejects changed cash %s", (key) => {
    const source = fixture();
    source.context.ledger[0][key] = key === "is_active" ? false : key === "amount" ? "81.0000" : key === "account_id" ? 8 : "changed";
    expect(plan(source).actions).toHaveLength(0);
    expect(plan(source).blockers[0].reason).toBe("ibkr_native_funding_ledger_changed");
  });
  it("does not adopt a competing source or duplicate reference", () => {
    const source = fixture();
    source.context.sources.push({ ...source.original, id: 11, committed_txn_id: 41 });
    expect(plan(source).actions).toHaveLength(0);
    const second = fixture();
    const result = prove([second.native, { ...second.native, id: 21 }], second.nativeBatches, second.context);
    expect(result.actions).toEqual([]);
    expect(result.blockers).toHaveLength(2);
  });
  it("blocks an unrelated record holding the native fingerprint", () => {
    const source = fixture();
    source.context.ledger.push({ ...source.context.ledger[0], id: 41, dedup_fingerprint: source.native.dedup_fingerprint });
    expect(plan(source).blockers[0].reason).toBe("ibkr_native_funding_duplicate_identity");
  });
  it("settles a repeat through its intact receipt, allowing new categories and transfer pairs", () => {
    const source = fixture();
    const adopted = plan(source).actions[0];
    source.context.ledger[0] = { ...adopted.after.snapshot, category_id: 20, is_transfer: true, transfer_peer_id: 50, transfer_source: "auto" };
    source.context.receipts.push({ id: 90, transaction_id: 40, action: "adopt", policy: "prefer_source", before_data: adopted.before, after_data: adopted.after });
    const result = plan(source);
    expect(result.blockers).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.duplicates).toHaveLength(1);
    expect(originalCashFingerprintAlreadyCorrected(source.original, loose<IbkrCashCorrectionContext>(source.context))).toBe(40);
    source.context.ledger[0].amount = "101.0000";
    expect(plan(source).duplicates).toEqual([]);
    expect(() => originalCashFingerprintAlreadyCorrected(source.original, loose<IbkrCashCorrectionContext>(source.context))).toThrow("IBKR cash source or ledger image changed");
  });
  it("does not use the old-fingerprint alias for an unrelated account or source", () => {
    const source = fixture();
    const adopted = plan(source).actions[0];
    source.context.ledger[0] = adopted.after.snapshot;
    source.context.receipts.push({ id: 90, transaction_id: 40, before_data: adopted.before, after_data: adopted.after });
    expect(originalCashFingerprintAlreadyCorrected({ ...source.original, account_id: 8 }, loose<IbkrCashCorrectionContext>(source.context))).toBeUndefined();
    expect(originalCashFingerprintAlreadyCorrected({ ...source.original, source_record_hash: "f".repeat(64) }, loose<IbkrCashCorrectionContext>(source.context))).toBeUndefined();
  });
  it("requires exact literal account identity or a bounded masked suffix", () => {
    expect(__ibkrFundingAccountMatches("U****5678", "U12345678")).toBe(true);
    expect(__ibkrFundingAccountMatches("U***678", "U12345678")).toBe(false);
    expect(__ibkrFundingAccountMatches("U87654321", "U12345678")).toBe(false);
    expect(__ibkrFundingAccountMatches("", "")).toBe(false);
  });
  it("keeps financial receipt equality independent of category and pairing metadata", () => {
    const image = syntheticIbkrCashCorrection().context.ledger[0];
    const recategorized = { ...image, category_id: 20, is_transfer: true, transfer_peer_id: 50 };
    expect(__ibkrCashImageEqual(image, recategorized)).toBe(true);
    expect(__ibkrCashImageEqual(image, { ...image, comment: "Changed after preview" })).toBe(false);
    expect(__getIbkrBaseCashEvidence(fixture().original)).toMatchObject({ baseCurrency: "EUR", baseAmount: "80", fxRate: "0.8" });
  });
});
