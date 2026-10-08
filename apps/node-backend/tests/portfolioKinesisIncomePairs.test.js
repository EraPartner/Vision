import { describe, it, expect } from "vitest";
import { syntheticKinesisIncomePair } from "./helpers/kinesisIncomePairs.js";
import { proveKinesisIncomePairs } from "../src/services/portfolioKinesisIncomePairs.ts";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
const proof = (source) =>
  proveKinesisIncomePairs({
    ...source,
    context: source.kinesisAdoptionContext,
  });
const plan = (source) =>
  buildPortfolioImportReconciliationPlan({
    ...source,
    adoptPolicy: "preserve_existing",
    reconciliationScope: "record_in_kind_income_only",
  }).plan;
describe("proved paired Kinesis income", () => {
  it("records only descriptive income and preserves the existing acquisition", async () => {
    const source = await syntheticKinesisIncomePair();
    const before = structuredClone(source);
    expect(proof(source)).toMatchObject({
      records: [{ row: { id: source.income.id }, unit: { id: 40 } }],
      blockers: [],
    });
    expect(plan(source)).toMatchObject({
      ready: true,
      summary: { record_income: 1, insert: 0, adopt: 0, repair_duplicate: 0 },
      selectedRowIds: [source.income.id],
      pending: source.rows.length - 1,
    });
    expect(plan(source).actions[0]).toMatchObject({
      action: "record_income",
      incomeProof: { kind: "paired_kinesis_income", unitTransactionId: 40 },
      source: {
        income_recognition_role: "included_in_units",
        type: "dividend",
      },
    });
    expect(source).toEqual(before);
  });
  it.each([
    "missing_context",
    "filtered",
    "missing_pair",
    "income_amount",
    "income_fx",
    "income_fee",
    "income_date",
    "unit_receipt",
    "unit_afterimage",
    "unit_account",
    "ambiguous_unit",
    "different_file",
    "nonunit_asset",
  ])("rejects %s evidence without writes", async (kind) => {
    const source = await syntheticKinesisIncomePair();
    if (kind === "missing_context")
      delete source.batches[0].custom_config.kinesis_source_context;
    if (kind === "filtered")
      source.batches[0].custom_config.included_symbols = ["KAU"];
    if (kind === "missing_pair")
      source.rows = source.rows.filter((row) => row.id !== source.unit.id);
    if (kind === "income_amount") source.income.amount = "999.0000";
    if (kind === "income_fx") source.income.fx_rate_to_eur = "0.8000000000";
    if (kind === "income_fee") source.income.fees = "1.0000";
    if (kind === "income_date") source.income.tx_date = "2026-01-06";
    if (kind === "unit_receipt") source.kinesisAdoptionContext.receipts = [];
    if (kind === "unit_afterimage") source.history[0].note = "Changed note";
    if (kind === "unit_account") source.history[0].account_id = 8;
    if (kind === "ambiguous_unit")
      source.history.push({ ...source.history[0], id: 41 });
    if (kind === "nonunit_asset") source.income.asset_class = "savings";
    if (kind === "different_file")
      source.kinesisAdoptionContext.batches[0].custom_config.kinesis_source_context.source_file_hash =
        "f".repeat(64);
    expect(plan(source)).toMatchObject({
      ready: false,
      summary: { record_income: 0 },
    });
  });
  it("defers an unproved acquisition and never inserts a second gift", async () => {
    const source = await syntheticKinesisIncomePair();
    source.history = [];
    expect(plan(source)).toMatchObject({
      ready: true,
      summary: { record_income: 0, insert: 0 },
      selectedRowIds: [],
    });
  });
  it("rejects a competing full-history income claim", async () => {
    const source = await syntheticKinesisIncomePair();
    source.history.push({
      ...source.history[0],
      id: 41,
      type: "dividend",
      units: null,
      price_per_unit: null,
      amount: source.income.amount,
      dedup_fingerprint: source.income.dedup_fingerprint,
    });
    expect(plan(source)).toMatchObject({
      ready: false,
      summary: { record_income: 0 },
    });
  });
  it("requires explicit preserve policy and zero basis", async () => {
    const source = await syntheticKinesisIncomePair();
    expect(() =>
      buildPortfolioImportReconciliationPlan({
        ...source,
        reconciliationScope: "record_in_kind_income_only",
      }),
    ).toThrow(/preserve_existing/);
    source.batches[0].custom_config.yield_basis_policy = "recorded";
    expect(() => plan(source)).toThrow(/zero/);
  });
  it("blocks ordinary full-source dividend creation without acquisition proof", async () => {
    const source = await syntheticKinesisIncomePair();
    source.kinesisAdoptionContext.receipts = [];
    const result = buildPortfolioImportReconciliationPlan({
      ...source,
      adoptPolicy: "preserve_existing",
    });
    expect(result.plan.ready).toBe(false);
    expect(
      result.plan.blockers.some(
        (item) => item.reason === "paired_income_review_required",
      ),
    ).toBe(true);
  });
});

it("accepts a unique unchanged imported acquisition from the same complete source", async () => {
  const source = await syntheticKinesisIncomePair();
  const unit = source.kinesisAdoptionContext.sources.find(
    (row) => row.source_transaction_id === "TX-YIELD:units",
  );
  unit.status = "committed";
  unit.committed_txn_id = 40;
  source.history[0].import_batch_id = "1";
  source.history[0].note = unit.note;
  source.kinesisAdoptionContext.receipts = [];
  expect(plan(source)).toMatchObject({
    ready: true,
    summary: { record_income: 1 },
  });
  source.history[0].note = "Changed imported note";
  expect(plan(source)).toMatchObject({
    ready: false,
    summary: { record_income: 0 },
  });
});
it("normalizes explicit standard afterimages without rewriting old receipts", async () => {
  const source = await syntheticKinesisIncomePair();
  source.history[0].income_recognition_role = "standard";
  expect(plan(source)).toMatchObject({
    ready: true,
    summary: { record_income: 1 },
  });
  expect(
    source.kinesisAdoptionContext.receipts[0].after_data,
  ).not.toHaveProperty("income_recognition_role");
});

it("binds literal USD income to an unchanged zero-basis EUR acquisition afterimage", async () => {
  const source = await syntheticKinesisIncomePair();
  source.history[0].currency = "EUR";
  source.kinesisAdoptionContext.receipts[0].after_data.currency = "EUR";
  expect(plan(source)).toMatchObject({
    ready: true,
    summary: { record_income: 1 },
  });
  expect(plan(source).actions[0].source.currency).toBe("USD");
  expect(source.history[0].currency).toBe("EUR");
});

it("defers unavailable historical income rates and binds usable quotes in the preview fingerprint", async () => {
  const source = await syntheticKinesisIncomePair();
  const initial = plan(source);
  source.historicalFxContext[0].rate = "0.9";
  expect(plan(source).planFingerprint).not.toBe(initial.planFingerprint);
  source.historicalFxContext[0].rate = null;
  expect(plan(source)).toMatchObject({
    ready: true,
    summary: { record_income: 0 },
    pending: source.rows.length,
  });
  expect(source.income.fx_rate_to_eur).toBeNull();
});
