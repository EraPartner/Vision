import { fileURLToPath } from "node:url";
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./helpers/kinesisAdoptionScope.js";
import { describe, expect, it } from "vitest";
import { fullFixture } from "./helpers/kinesisFullImport.js";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
import { syntheticKinesisIncomePair } from "./helpers/kinesisIncomePairs.js";

const plan = (source) =>
  buildPortfolioImportReconciliationPlan({
    ...source,
    adoptPolicy: "prefer_source",
  });

describe("complete Kinesis paired-income import", () => {
  it("corrects the sole manual zero-basis yield units and plans new units before included income", async () => {
    const source = await fullFixture();
    const before = structuredClone(source);
    const result = plan(source);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 1, record_income: 2 },
    });
    expect(result.adoptions[0].after).toEqual({
      ...source.history[0],
      units: "0.00287",
      account_id: 7,
      source_record_hash: result.adoptions[0].row.source_record_hash,
      dedup_fingerprint: result.adoptions[0].row.dedup_fingerprint,
      dedup_fingerprint_version: 1,
    });
    expect(
      result.plan.actions.find((action) => action.action === "adopt")
        .corrections,
    ).toEqual(["units"]);
    const income = result.plan.actions.filter(
      (action) => action.action === "record_income",
    );
    expect(income.map((action) => action.incomeProof.unitRowId)).toHaveLength(
      2,
    );
    expect(income[0].incomeProof.unitTransactionId).toBe(40);
    expect(income[1].incomeProof).not.toHaveProperty("unitTransactionId");
    expect(
      income.every(
        (action) =>
          action.source.income_recognition_role === "included_in_units",
      ),
    ).toBe(true);
    expect(source).toEqual(before);
  });
  it("retains strict existing acquisition receipts in ordinary full review", async () => {
    const source = await syntheticKinesisIncomePair();
    const result = plan(source);
    expect(
      result.plan.actions.find((action) => action.rowId === source.income.id),
    ).toMatchObject({
      action: "record_income",
      incomeProof: { unitTransactionId: 40, unitRowId: source.unit.id },
    });
    source.kinesisAdoptionContext.receipts[0].after_data.note =
      "Changed receipt";
    expect(
      plan(source).plan.blockers.some(
        (issue) => issue.reason === "paired_income_acquisition_changed",
      ),
    ).toBe(true);
  });
  it.each([
    "two_manual",
    "assigned",
    "positive_basis",
    "recurring",
    "changed_date",
    "missing_capture",
    "filtered",
    "tampered",
    "missing_fx",
  ])("does not guess %s", async (kind) => {
    const source = await fullFixture();
    if (kind === "two_manual")
      source.history.push({ ...source.history[0], id: 41 });
    if (kind === "assigned") source.history[0].account_id = 8;
    if (kind === "positive_basis") source.history[0].amount = "1.0000";
    if (kind === "recurring") source.history[0].is_recurring = true;
    if (kind === "changed_date") source.history[0].date = "2026-01-05";
    if (kind === "missing_capture")
      delete source.batches[0].custom_config.kinesis_source_context;
    if (kind === "filtered")
      source.batches[0].custom_config.included_symbols = ["KAU"];
    if (kind === "tampered") source.rows[1].raw_data += " ";
    if (kind === "missing_fx") source.historicalFxContext = [];
    const result = plan(source);
    if (kind !== "missing_fx") expect(result.adoptions).toHaveLength(0);
    if (
      [
        "two_manual",
        "missing_capture",
        "filtered",
        "tampered",
        "missing_fx",
      ].includes(kind)
    )
      expect(result.plan.ready).toBe(false);
    expect(source.history[0].units).toBe("0.00100000");
  });
  it("requires source preference before changing existing quantities", async () => {
    const source = await fullFixture();
    expect(buildPortfolioImportReconciliationPlan(source).plan.ready).toBe(
      false,
    );
    const preserve = buildPortfolioImportReconciliationPlan({
      ...source,
      adoptPolicy: "preserve_existing",
    });
    expect(preserve.plan.ready).toBe(false);
  });
});

it("keeps equal-valued distributions tied to different proved acquisitions", async () => {
  const sourcePath = fileURLToPath(
    new URL(
      "./fixtures/portfolio/kinesis-equal-value-income.csv",
      import.meta.url,
    ),
  );
  const source = await syntheticKinesisScope({ sourcePath }),
    prior = await syntheticKinesisScope({
      sourcePath,
      batchId: 1,
      rowStart: 100,
    });
  const unit = source.rows.find(
      (row) => row.source_transaction_id === "TX-OLDER:units",
    ),
    income = source.rows.find(
      (row) => row.source_transaction_id === "TX-OLDER:income",
    ),
    newUnit = source.rows.find(
      (row) => row.source_transaction_id === "TX-NEW:units",
    );
  const before = syntheticKinesisManual(unit),
    current = {
      ...before,
      account_id: unit.account_id,
      source_record_hash: unit.source_record_hash,
      dedup_fingerprint: unit.dedup_fingerprint,
      dedup_fingerprint_version: 1,
    };
  const oldUnit = prior.rows.find(
      (row) => row.source_transaction_id === unit.source_transaction_id,
    ),
    oldIncome = prior.rows.find(
      (row) => row.source_transaction_id === income.source_transaction_id,
    );
  oldUnit.status = "duplicate";
  oldIncome.status = "committed";
  oldIncome.committed_txn_id = 41;
  const oldDividend = {
    ...syntheticKinesisManual(income, 41),
    account_id: income.account_id,
    units: null,
    price_per_unit: null,
    import_batch_id: 1,
    source_record_hash: income.source_record_hash,
    dedup_fingerprint: income.dedup_fingerprint,
    dedup_fingerprint_version: 1,
    income_recognition_role: "included_in_units",
  };
  source.history = [
    current,
    oldDividend,
    { ...syntheticKinesisManual(newUnit, 42), units: "0.001", currency: "EUR" },
  ];
  source.kinesisAdoptionContext = {
    sources: prior.rows,
    batches: prior.batches,
    receipts: [
      {
        id: 1,
        transaction_id: 40,
        staging_row_id: oldUnit.id,
        batch_id: 1,
        policy: "preserve_existing",
        before_data: before,
        after_data: current,
      },
    ],
  };
  source.incomeRecognitionContext = {
    sources: prior.rows,
    batches: prior.batches,
    receipts: [
      {
        unit_transaction_id: 40,
        income_transaction_id: 41,
        staging_row_id: oldIncome.id,
        batch_id: 1,
        unit_data: current,
        income_data: oldDividend,
      },
    ],
  };
  source.historicalFxContext = [
    { currency: "USD", date: income.tx_date, rate: "0.8" },
  ];
  const result = plan(source);
  expect(result.plan).toMatchObject({
    ready: true,
    summary: { adopt: 1, record_income: 1, duplicate: 2 },
  });
  expect(
    result.plan.actions.find((row) => row.action === "record_income")
      .incomeProof.unitTransactionId,
  ).toBe(42);
});
