import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toDecimal } from "../src/lib/money.ts";
import { proveKinesisAdoptionSources } from "../src/services/portfolioKinesisAdoptionScope.ts";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./helpers/kinesisAdoptionScope.js";

const build = (fixture, extra = {}) =>
  buildPortfolioImportReconciliationPlan({
    ...fixture,
    adoptPolicy: "preserve_existing",
    reconciliationScope: "adopt_existing_only",
    ...extra,
  });
async function fixture() {
  const source = await syntheticKinesisScope();
  source.history = [
    syntheticKinesisManual(source.rows[0]),
    syntheticKinesisManual(source.rows[5], 41),
  ];
  return source;
}

describe("complete Kinesis literal source proof", () => {
  it("binds separate trade legs and derived distribution identities to full source context", async () => {
    const source = await fixture();
    const evidence = proveKinesisAdoptionSources(source.rows, source.batches);
    expect(evidence.issues).toEqual([]);
    expect([...evidence.proofs.keys()]).toEqual([20, 25, 26, 28]);
    expect(evidence.proofs.get(25).parsed).toMatchObject({
      typeRaw: "Gift",
      amount: 0,
      units: 0.00287,
    });
  });
  it.each([
    "missing_context",
    "header",
    "literal_hash",
    "event_key",
    "source_identity",
    "zero_identity",
    "source_account",
    "filtered",
    "skipped",
    "missing_row",
  ])("rejects %s complete-source binding", async (kind) => {
    const source = await fixture();
    const config = source.batches[0].custom_config;
    if (kind === "missing_context") delete config.kinesis_source_context;
    if (kind === "header")
      config.source_columns = config.source_columns.slice(1);
    if (kind === "literal_hash")
      source.rows[10].source_record_hash = "e".repeat(64);
    if (kind === "event_key")
      config.kinesis_source_context.events[10].eventKey = "e".repeat(64);
    if (kind === "source_identity")
      source.rows[10].source_transaction_id = "changed";
    if (kind === "zero_identity") source.rows[10].source_transaction_id = "000";
    if (kind === "source_account") source.rows[10].account_id = 8;
    if (kind === "filtered") config.included_symbols = ["KAU"];
    if (kind === "skipped") config.kinesis_source_context.skipped = 1;
    if (kind === "missing_row") source.rows.pop();
    expect(build(source).plan).toMatchObject({
      ready: false,
      summary: { adopt: 0 },
    });
    expect(build(source).plan.blockers[0].reason).toBe(
      "adoption_scope_source_unverified",
    );
  });
  it("rejects a literal zero distribution ID even after income and units identities are derived", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "vision-kinesis-zero-id-"));
    try {
      const original = await readFile(
        new URL(
          "fixtures/portfolio/kinesis-transaction-history.csv",
          import.meta.url,
        ),
        "utf8",
      );
      const path = join(temporary, "source.csv");
      await writeFile(path, original.replaceAll("TX-YIELD", "000"));
      const source = await syntheticKinesisScope({ sourcePath: path });
      expect(
        source.rows.slice(4, 6).map((row) => row.source_transaction_id),
      ).toEqual(["000:income", "000:units"]);
      source.history = [syntheticKinesisManual(source.rows[5])];
      const result = build(source);
      expect(result.plan).toMatchObject({
        ready: false,
        selectedRowIds: [],
        summary: { adopt: 0 },
      });
      expect(result.plan.blockers[0].reason).toBe(
        "adoption_scope_source_unverified",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("Kinesis adoption-only planning", () => {
  it.each(["matched", "duplicate"])(
    "defers an unqualified positive gift %s repeat before validating its older incomplete adoption receipt",
    async (status) => {
      const source = await fixture();
      const row = source.rows[6];
      row.status = status;
      const current = {
        ...syntheticKinesisManual(row, 42),
        amount: "100.0000",
        price_per_unit: "12743.090000",
        currency: "EUR",
        account_id: row.account_id,
        source_record_hash: row.source_record_hash,
        dedup_fingerprint: row.dedup_fingerprint,
        dedup_fingerprint_version: row.dedup_fingerprint_version,
      };
      source.history.push(current);
      const oldConfig = structuredClone(source.batches[0].custom_config);
      delete oldConfig.kinesis_source_context;
      const context = {
        receipts: [
          {
            id: 1,
            batch_id: 16,
            staging_row_id: 60,
            transaction_id: current.id,
            policy: "preserve_existing",
            after_data: structuredClone(current),
          },
        ],
        sources: [
          {
            ...structuredClone(row),
            id: 60,
            batch_id: 16,
            row_index: 0,
            status: "duplicate",
            custom_config: oldConfig,
          },
        ],
        batches: [
          {
            ...structuredClone(source.batches[0]),
            id: 16,
            status: "complete",
            rows_total: 1,
            custom_config: oldConfig,
          },
        ],
      };
      const before = structuredClone({ source, context });
      const full = build(source, {
        reconciliationScope: "full",
        kinesisAdoptionContext: context,
      });
      expect(
        full.plan.actions.find((action) => action.rowId === row.id).action,
      ).toBe(status === "matched" ? "duplicate" : "settled");
      const result = build(source, { kinesisAdoptionContext: context });
      expect(result.plan).toMatchObject({
        ready: true,
        blockers: [],
        summary: {
          adopt: 2,
          duplicate: 0,
          settled: 0,
          insert: 0,
          repair_duplicate: 0,
        },
        selectedRowIds: [20, 25],
        pending: status === "matched" ? 10 : 9,
        complete: false,
      });
      expect(result.adoptions.some((item) => item.before.id === 42)).toBe(
        false,
      );
      expect({ source, context }).toEqual(before);
    },
  );
  it("still blocks a financially qualifying repeat whose older receipt lacks complete retained source context", async () => {
    const source = await fixture();
    const initial = build(source);
    const context = {
      sources: structuredClone(source.rows),
      batches: structuredClone(source.batches),
      receipts: initial.adoptions.map((adoption, index) => ({
        id: index + 1,
        batch_id: 2,
        staging_row_id: adoption.row.id,
        transaction_id: adoption.before.id,
        policy: "preserve_existing",
        after_data: structuredClone(adoption.after),
      })),
    };
    delete context.batches[0].custom_config.kinesis_source_context;
    context.sources.forEach(
      (row) => delete row.custom_config.kinesis_source_context,
    );
    source.history = initial.adoptions.map((item) => item.after);
    source.rows.forEach((row) => {
      if (initial.plan.selectedRowIds.includes(row.id))
        row.status = "duplicate";
    });
    const result = build(source, { kinesisAdoptionContext: context });
    expect(result.plan).toMatchObject({ ready: false, selectedRowIds: [] });
    expect(result.plan.blockers.map((issue) => issue.reason)).toEqual([
      "adoption_scope_receipt_changed",
      "adoption_scope_receipt_changed",
    ]);
  });
  it("defers a meaningful gift whose original currency and valuation are absent from the literal source", async () => {
    const source = await fixture();
    const gift = syntheticKinesisManual(source.rows[6], 42);
    Object.assign(gift, {
      amount: "100.0000",
      price_per_unit: "12743.090000",
      currency: "EUR",
    });
    source.history.push(gift);
    expect(
      build(source, { reconciliationScope: "full" }).plan.summary.adopt,
    ).toBe(3);
    const result = build(source);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 2 },
      selectedRowIds: [20, 25],
      pending: 10,
    });
    expect(result.adoptions.some((item) => item.before.id === 42)).toBe(false);
  });
  it.each(["fees", "taxes", "amount", "currency", "staged_fee_tamper"])(
    "defers a buy with a known literal %s difference before provenance is attached",
    async (field) => {
      const source = await fixture();
      if (field === "currency") source.history[0].currency = "USD";
      else if (field === "staged_fee_tamper") {
        source.history[0].fees = "2.0000";
        source.rows[0].fees = "2.0000";
      } else
        source.history[0][field] = toDecimal(source.history[0][field])
          .plus(1)
          .toFixed(4);
      const result = build(source);
      expect(result.plan).toMatchObject({
        ready: true,
        summary: { adopt: 1 },
        selectedRowIds: [25],
        pending: 11,
      });
      expect(result.adoptions.some((item) => item.before.id === 40)).toBe(
        false,
      );
    },
  );
  it.each(["amount", "fees", "taxes"])(
    "defers a known-zero yield whose preserved %s is nonzero",
    async (field) => {
      const source = await fixture();
      source.history[1][field] = "1.0000";
      expect(build(source).plan).toMatchObject({
        ready: true,
        summary: { adopt: 1 },
        selectedRowIds: [20],
        pending: 11,
      });
    },
  );
  it("selects only existing buy/gift adoptions and defers every other event kind", async () => {
    const source = await fixture();
    const result = build(source);
    expect(result.plan).toMatchObject({
      ready: true,
      reconciliationScope: "adopt_existing_only",
      selectedRowIds: [20, 25],
      pending: 10,
      complete: false,
      summary: {
        adopt: 2,
        insert: 0,
        repair_duplicate: 0,
        cash: 0,
        adjustment: 0,
      },
    });
    expect(
      Object.values(result.plan.deferredCounts).reduce(
        (sum, count) => sum + count,
        0,
      ),
    ).toBe(10);
    expect(result.adoptions).toHaveLength(2);
    for (const adoption of result.adoptions)
      for (const key of [
        "date",
        "type",
        "amount",
        "units",
        "price_per_unit",
        "fees",
        "taxes",
        "currency",
        "fx_rate_to_eur",
        "note",
      ])
        expect(adoption.after[key]).toBe(adoption.before[key]);
    expect(result.companions).toEqual([]);
  });
  it("classifies all candidates before selection so excluded duplicate sources cannot hide ambiguity", async () => {
    const source = await fixture();
    source.history.push({ ...source.history[0], id: 42 });
    const result = build(source);
    expect(result.plan.ready).toBe(false);
    expect(
      result.plan.blockers.some(
        (issue) => issue.reason === "ambiguous_history",
      ),
    ).toBe(true);
    expect(result.plan.selectedRowIds).not.toContain(20);
  });
  it("does not hide an unproved deferred source that competes for a selected existing transaction", async () => {
    const source = await fixture();
    Object.assign(source.rows[10], {
      status: "matched",
      route: "portfolio",
      type: "buy",
      type_raw: "Buy",
      investment_id: 1,
      units: source.rows[0].units,
      price_per_unit: source.rows[0].price_per_unit,
      amount: source.history[0].amount,
      currency: "EUR",
      dedup_fingerprint: "e".repeat(64),
      dedup_fingerprint_version: 1,
    });
    const result = build(source);
    expect(result.plan.ready).toBe(false);
    expect(
      result.plan.blockers.some(
        (issue) =>
          issue.reason === "ambiguous_history" &&
          issue.candidateTransactionIds.includes(40),
      ),
    ).toBe(true);
    expect(result.plan.selectedRowIds).not.toContain(20);
  });
  it("requires explicit preserve-existing and a pure Kinesis scope", async () => {
    const source = await fixture();
    for (const policy of [undefined, "prefer_source"])
      expect(() => build(source, { adoptPolicy: policy })).toThrow(
        /requires Kinesis/,
      );
    expect(() =>
      build(source, {
        batchPolicies: [{ batchId: 2, adoptPolicy: "prefer_source" }],
      }),
    ).toThrow(/requires Kinesis/);
    source.batches[0].custom_config.format = "ibkr_transaction_history";
    expect(() => build(source)).toThrow(/requires Kinesis/);
  });
  it("binds excluded rows, complete history, literal context, and selected actions in its fingerprint", async () => {
    const source = await fixture();
    const initial = build(source).plan.planFingerprint;
    for (const mutate of [
      (copy) => (copy.rows[10].note = "Changed excluded row"),
      (copy) =>
        copy.history.push({ ...copy.history[1], id: 90, date: "2024-01-01" }),
      (copy) =>
        (copy.batches[0].custom_config.kinesis_source_context.source_file_hash =
          "e".repeat(64)),
    ]) {
      const copy = structuredClone(source);
      mutate(copy);
      expect(build(copy).plan.planFingerprint).not.toBe(initial);
    }
  });
  it("keeps full-scope behavior unchanged and allows exact receipt-backed repeats without new adoptions", async () => {
    const source = await fixture();
    expect(
      build(source, { reconciliationScope: "full" }).plan.summary.insert,
    ).toBeGreaterThan(0);
    const initial = build(source);
    const context = {
      sources: structuredClone(source.rows),
      batches: structuredClone(source.batches),
      receipts: initial.adoptions.map((adoption, index) => ({
        id: index + 1,
        batch_id: 2,
        staging_row_id: adoption.row.id,
        transaction_id: adoption.before.id,
        policy: "preserve_existing",
        after_data: structuredClone(adoption.after),
      })),
    };
    source.history = initial.adoptions.map((item) => item.after);
    for (const row of source.rows)
      if (initial.plan.selectedRowIds.includes(row.id))
        row.status = "duplicate";
    const repeat = build(source, { kinesisAdoptionContext: context });
    expect(repeat.plan).toMatchObject({
      ready: true,
      summary: { adopt: 0, settled: 2 },
      selectedRowIds: [20, 25],
      pending: 10,
    });
    expect(repeat.adoptions).toEqual([]);
    for (const mutate of [
      (copy) => (copy.history[0].note = "Changed manual note"),
      (copy) =>
        copy.kinesisAdoptionContext.receipts.push({
          ...copy.kinesisAdoptionContext.receipts[0],
          id: 3,
        }),
      (copy) => (copy.kinesisAdoptionContext.sources[0].raw_data += " "),
    ]) {
      const copy = structuredClone({
        ...source,
        kinesisAdoptionContext: context,
      });
      mutate(copy);
      expect(build(copy).plan.ready).toBe(false);
    }
  });
  it("does not settle a same-HIN repeat into a different Vision account", async () => {
    const source = await fixture();
    const initial = build(source);
    const context = {
      sources: structuredClone(source.rows),
      batches: structuredClone(source.batches),
      receipts: initial.adoptions.map((item, index) => ({
        id: index + 1,
        batch_id: 2,
        staging_row_id: item.row.id,
        transaction_id: item.before.id,
        policy: "preserve_existing",
        after_data: structuredClone(item.after),
      })),
    };
    source.history = initial.adoptions.map((item) => item.after);
    source.batches[0].account_id = 8;
    source.rows.forEach((row) => {
      row.account_id = 8;
    });
    const result = build(source, { kinesisAdoptionContext: context });
    expect(result.plan.ready).toBe(false);
    expect(
      result.plan.blockers.some(
        (issue) => issue.reason === "source_identity_conflict",
      ),
    ).toBe(true);
    expect(result.plan.summary.duplicate).toBe(0);
  });
});
