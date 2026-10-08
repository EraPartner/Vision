import { describe, expect, it } from "vitest";
import { syntheticIbkrCashCorrection as fixture } from "./helpers/ibkrCashReconciliation.ts";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";

const build = (source, overrides = {}) => buildPortfolioImportReconciliationPlan({
  rows: [source.native], batches: source.nativeBatches, history: [],
  ibkrCashContext: source.context, reconciliationScope: "correct_existing_only",
  adoptPolicy: "prefer_source", ...overrides,
});

describe("IBKR native funding reviewed correction scope", () => {
  it("updates existing cash only and exposes its original and native amounts", () => {
    const result = build(fixture());
    expect(result.plan).toMatchObject({ ready: true, complete: true, pending: 0,
      summary: { adopt: 1, insert: 0, cash: 0 }, selectedRowIds: [20] });
    expect(result.plan.actions[0]).toMatchObject({ action: "adopt", isCash: true,
      investmentId: null, existingTransactionId: 40, corrections: ["amount", "currency"],
      existing: { amount: "80.0000", currency: "EUR" }, source: { amount: "100.0000", currency: "USD" } });
    expect(result.adoptions).toEqual([]);
    expect(result.cashCorrections).toHaveLength(1);
  });
  it("requires the reviewed source policy before applying changes", () => {
    const result = build(fixture(), { adoptPolicy: "preserve_existing" });
    expect(result.plan.ready).toBe(false);
    expect(result.plan.actions[0].action).toBe("policy_required");
    expect(result.plan.blockers[0].reason).toBe("source_policy_required");
  });
  it("blocks missing primary evidence and binds changed cash to the fingerprint", () => {
    const source = fixture();
    const before = build(source).plan.planFingerprint;
    source.context.ledger[0].amount = "79.0000";
    const changed = build(source);
    expect(changed.plan.ready).toBe(false);
    expect(changed.plan.planFingerprint).not.toBe(before);
    expect(changed.cashCorrections).toEqual([]);
  });
  it("rejects mixed funding/trade scopes and unrelated bounded scopes", () => {
    const source = fixture();
    expect(() => build(source, { batches: [...source.nativeBatches, { id: 3, custom_config: { format: "saxo_transaction_history" } }] })).toThrow("separate funding source scope");
    expect(() => build(source, { reconciliationScope: "record_cash_only" })).toThrow("separate funding source scope");
  });
  it("repeat review settles the corrected ID without another correction", () => {
    const source = fixture();
    const first = build(source).cashCorrections[0];
    source.context.ledger[0] = first.after.snapshot;
    source.context.receipts.push({ id: 90, transaction_id: 40, action: "adopt", policy: "prefer_source", before_data: first.before, after_data: first.after });
    const repeated = build(source);
    expect(repeated.plan).toMatchObject({ ready: true, summary: { adopt: 0, duplicate: 1, insert: 0 } });
    expect(repeated.cashCorrections).toEqual([]);
    expect(repeated.cashCorrectionRepeats).toHaveLength(1);
  });
});
