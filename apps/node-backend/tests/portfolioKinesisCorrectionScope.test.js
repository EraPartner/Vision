import { describe, expect, it } from "vitest";
import { toDecimal } from "../src/lib/money.ts";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
import { portfolioReferenceStagingBinding } from "../src/services/portfolioPerformanceReferenceEvidence.ts";
import { proveKinesisCorrectionSources } from "../src/services/portfolioKinesisAdoptionScope.ts";
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./helpers/kinesisAdoptionScope.ts";
import {
  retainedEvent,
  retainedReference,
  retainedEvidenceRow,
} from "./fixtures/retainedPortfolioEvidence.ts";

const build = (source, extra = {}) =>
  buildPortfolioImportReconciliationPlan({
    ...source,
    adoptPolicy: "prefer_source",
    reconciliationScope: "correct_existing_only",
    ...extra,
  });
async function fixture() {
  const source = await syntheticKinesisScope();
  const gift = source.rows[6];
  source.history = [
    {
      ...syntheticKinesisManual(source.rows[0]),
      fees: toDecimal(source.rows[0].fees).plus(1).toFixed(4),
    },
    syntheticKinesisManual(source.rows[5], 41),
    {
      ...syntheticKinesisManual(gift, 42),
      amount: "200.0000",
      price_per_unit: toDecimal(200).div(gift.units).toFixed(6),
      currency: "EUR",
      fx_rate_to_eur: "1.0000000000",
    },
  ];
  const event = retainedEvent({
    date: gift.tx_date,
    shares: gift.units,
    amount: "200",
    currency: "USD",
  });
  const reference = retainedReference([event]);
  Object.assign(
    gift,
    retainedEvidenceRow(gift, reference, event, "recorded_native", {
      amount: "200",
      price_per_unit: toDecimal(200).div(gift.units).toFixed(6),
      currency: "USD",
      fx_rate_to_eur: null,
      asset_transfer_details: {
        direction: "in",
        basisStatus: "recorded_reference",
      },
    }),
  );
  const routing = [
    {
      batchId: 2,
      accountId: 7,
      originAccountId: null,
      destinationAccountId: null,
    },
  ];
  source.batches[0].custom_config.portfolio_performance_reference = {
    sourceHash: reference.sourceHash,
    reconciliationScope: "correct_existing_only",
    originalBatchIds: [2],
    effectiveBatchIds: [2],
    routing,
    stagingBinding: portfolioReferenceStagingBinding(source.rows),
    originalStagingBinding: portfolioReferenceStagingBinding(source.rows),
  };
  source.referenceOriginalRows = source.rows;
  source.historicalFxContext = [
    { currency: "USD", date: gift.tx_date, rate: "0.9" },
  ];
  return { source, reference };
}

describe("bounded Kinesis financial correction", () => {
  it("corrects literal quote fees and recorded native gift currency while preserving primary identity and immutable manual fields", async () => {
    const { source } = await fixture();
    const evidence = proveKinesisCorrectionSources(source.rows, source.batches);
    expect(evidence.issues).toEqual([]);
    expect(evidence.proofs.has(26)).toBe(true);
    const result = build(source);
    expect(result.plan).toMatchObject({
      ready: true,
      selectedRowIds: [20, 26],
      pending: 10,
      complete: false,
      summary: {
        adopt: 2,
        insert: 0,
        repair_duplicate: 0,
        cash: 0,
        transfer: 0,
        adjustment: 0,
      },
    });
    expect(result.plan.actions.map((action) => action.corrections)).toEqual([
      ["fees"],
      ["currency", "fx_rate_to_eur"],
    ]);
    for (const { before, after, policy } of result.adoptions) {
      expect(policy).toBe("prefer_source");
      for (const key of [
        "id",
        "investment_id",
        "type",
        "date",
        "units",
        "note",
      ])
        expect(after[key]).toBe(before[key]);
    }
    expect(result.adoptions[1].after).toMatchObject({
      currency: "USD",
      fx_rate_to_eur: null,
    });
    expect(source.rows[6].dedup_fingerprint).toBe(
      result.adoptions[1].after.dedup_fingerprint,
    );
  });
  it("defers missing historical conversion while independent literal fees remain selectable and binds rate evidence in the fingerprint", async () => {
    const { source } = await fixture();
    const missing = build(source, { historicalFxContext: [] });
    expect(missing.plan).toMatchObject({
      ready: true,
      selectedRowIds: [20],
      pending: 11,
      summary: { adopt: 1 },
    });
    expect(missing.plan.planFingerprint).not.toBe(
      build(source).plan.planFingerprint,
    );
    expect(
      build(source, {
        historicalFxContext: [{ ...source.historicalFxContext[0], rate: null }],
      }).plan.selectedRowIds,
    ).toEqual([20]);
  });
  it.each(["fees", "amount", "price_per_unit", "currency", "fx_rate_to_eur"])(
    "does not correct a buy using tampered staged %s instead of literal execution facts",
    async (field) => {
      const { source } = await fixture();
      source.rows[0][field] = field === "currency" ? "USD" : "2";
      const result = build(source);
      expect(result.plan.selectedRowIds).not.toContain(20);
    },
  );
  it.each(["account", "source_hash", "fx", "basis", "primary_currency"])(
    "rejects an unverified native gift %s projection",
    async (kind) => {
      const { source } = await fixture();
      const row = source.rows[6];
      const envelope = JSON.parse(row.raw_data);
      if (kind === "account")
        envelope.__portfolioPerformanceReference.accountId = 8;
      if (kind === "source_hash")
        envelope.__portfolioPerformanceReference.sourceHash = "e".repeat(64);
      if (kind === "basis") row.amount = "201";
      if (kind === "fx") row.fx_rate_to_eur = "0.5";
      if (kind === "primary_currency") row.currency = "EUR";
      row.raw_data = JSON.stringify(envelope);
      const result = build(source);
      expect(result.plan.selectedRowIds).not.toContain(26);
    },
  );
  it("does not inflate an existing zero-basis gift from meaningful retained valuation", async () => {
    const { source } = await fixture();
    source.history[2].amount = "0.0000";
    source.history[2].price_per_unit = "0.000000";
    expect(build(source).plan.selectedRowIds).toEqual([20]);
  });
  it("classifies the complete source before selection and preserves contested candidate blockers", async () => {
    const { source } = await fixture();
    source.history.push({ ...source.history[0], id: 43 });
    expect(build(source).plan.ready).toBe(false);
  });
  it("settles a fresh original CSV without XML from its corrected receipt and guards changed notes, receipt ambiguity and retained proof", async () => {
    const { source } = await fixture();
    const initial = build(source);
    const context = {
      sources: structuredClone(source.rows),
      batches: structuredClone(source.batches),
      receipts: initial.adoptions.map((item, index) => ({
        id: index + 1,
        batch_id: 2,
        staging_row_id: item.row.id,
        transaction_id: item.before.id,
        policy: "prefer_source",
        after_data: structuredClone(item.after),
      })),
    };
    context.sources.forEach((row) => {
      if (initial.plan.selectedRowIds.includes(row.id))
        row.status = "duplicate";
    });
    const fresh = await syntheticKinesisScope({ batchId: 3, rowStart: 100 });
    fresh.history = source.history.map(
      (item) =>
        initial.adoptions.find((adoption) => adoption.before.id === item.id)
          ?.after ?? item,
    );
    const repeat = build(fresh, { kinesisAdoptionContext: context });
    expect(repeat.plan).toMatchObject({
      ready: true,
      selectedRowIds: [100, 106],
      summary: { adopt: 0, duplicate: 2 },
      pending: 10,
    });
    for (const mutate of [
      (copy) => (copy.history[0].note = "Changed note"),
      (copy) =>
        copy.kinesisAdoptionContext.receipts.push({
          ...copy.kinesisAdoptionContext.receipts[0],
          id: 3,
        }),
      (copy) => (copy.kinesisAdoptionContext.sources[6].raw_data += " "),
    ]) {
      const copy = structuredClone({
        ...fresh,
        kinesisAdoptionContext: context,
      });
      mutate(copy);
      expect(build(copy).plan.ready).toBe(false);
    }
  });
  it("requires explicit prefer_source and rejects a conflicting policy or other format", async () => {
    const { source } = await fixture();
    for (const adoptPolicy of [undefined, "preserve_existing"])
      expect(() => build(source, { adoptPolicy })).toThrow(/requires Kinesis/);
    expect(() =>
      build(source, {
        batchPolicies: [{ batchId: 2, adoptPolicy: "preserve_existing" }],
      }),
    ).toThrow(/requires Kinesis/);
  });
});
