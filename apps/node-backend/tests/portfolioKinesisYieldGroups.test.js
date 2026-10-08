import { describe, it, expect } from "vitest";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
import { syntheticKinesisYieldGroup } from "./helpers/kinesisYieldGroups.js";

const build = (source) =>
  buildPortfolioImportReconciliationPlan({
    ...source,
    adoptPolicy: "preserve_existing",
    reconciliationScope: "adopt_existing_only",
  });
const correct = (source) =>
  buildPortfolioImportReconciliationPlan({
    ...source,
    adoptPolicy: "prefer_source",
    reconciliationScope: "correct_existing_only",
  });
describe("closed original deposit-boundary yield groups", () => {
  it("corrects the whole closed group's broker payment dates with a typed exception and unchanged financials", async () => {
    const { source } = await syntheticKinesisYieldGroup({
      scope: "correct_existing_only",
    });
    const result = correct(source);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 2, duplicate: 2, insert: 0, repair_duplicate: 0 },
      pending: 5,
    });
    expect(result.adoptions).toHaveLength(2);
    for (const { before, after } of result.adoptions) {
      for (const field of [
        "id",
        "investment_id",
        "type",
        "units",
        "amount",
        "price_per_unit",
        "fees",
        "taxes",
        "currency",
        "fx_rate_to_eur",
        "note",
      ])
        expect(after[field]).toBe(before[field]);
      expect(after.date).toBe("2024-04-15");
      const action = result.plan.actions.find(
        (item) => item.existingTransactionId === before.id,
      );
      expect(action).toMatchObject({
        corrections: ["date"],
        policy: "prefer_source",
        dateProof: {
          kind: "closed_kinesis_yield_group",
          recordedDate: before.date,
          paymentDate: after.date,
          memberCount: 3,
        },
      });
      expect(action.dateProof.groupKey).toMatch(/^[a-f0-9]{64}$/);
      expect(action.source).toEqual({ ...action.existing, date: after.date });
    }
  });
  it("binds tiny paired income using PostgreSQL stored precision without changing or importing the income leg", async () => {
    const { source } = await syntheticKinesisYieldGroup({
      scope: "correct_existing_only",
      halfwayIncome: true,
    });
    const result = correct(source);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 2, insert: 0 },
    });
    expect(
      result.plan.actions.every(
        (action) =>
          source.rows.find((row) => row.id === action.rowId).type === "gift",
      ),
    ).toBe(true);
  });
  it("reproves original XML dates from before-images on same-file date correction repeats", async () => {
    const { source } = await syntheticKinesisYieldGroup({
      scope: "correct_existing_only",
    });
    const first = correct(source);
    for (const item of first.adoptions) {
      source.history[
        source.history.findIndex((row) => row.id === item.before.id)
      ] = structuredClone(item.after);
      const retained = structuredClone(item.row);
      retained.status = "duplicate";
      source.kinesisAdoptionContext.sources.push(retained);
      source.kinesisAdoptionContext.receipts.push({
        id: 30 + item.row.id,
        batch_id: item.row.batch_id,
        staging_row_id: item.row.id,
        transaction_id: item.before.id,
        policy: "prefer_source",
        before_data: structuredClone(item.before),
        after_data: structuredClone(item.after),
      });
    }
    source.kinesisAdoptionContext.batches.push(
      structuredClone(source.batches[0]),
    );
    for (const row of source.rows)
      if (
        !source.kinesisAdoptionContext.sources.some(
          (retained) => retained.id === row.id,
        )
      )
        source.kinesisAdoptionContext.sources.push(structuredClone(row));
    source.kinesisAdoptionContext.sources.sort(
      (a, b) => a.batch_id - b.batch_id || a.row_index - b.row_index,
    );
    const repeated = correct(source);
    expect(repeated.plan).toMatchObject({
      ready: true,
      summary: { adopt: 0, duplicate: 4 },
    });
    expect(repeated.adoptions).toEqual([]);
    source.kinesisAdoptionContext.receipts.at(-1).before_data.date =
      "2024-03-07";
    expect(correct(source).plan.ready).toBe(false);
    expect(correct(source).adoptions).toEqual([]);
  });
  it("does not authorize ordinary date differences when the closed reference proof is absent", async () => {
    const { source } = await syntheticKinesisYieldGroup({
      scope: "correct_existing_only",
      withReference: false,
    });
    expect(correct(source).adoptions).toEqual([]);
  });
  it("closes the whole documentary interval and adopts distinct old rows without changing any financial/date/note field", async () => {
    const { source, groupPlan } = await syntheticKinesisYieldGroup();
    expect(groupPlan.blockers).toEqual([]);
    expect(groupPlan.yieldGroupEvidence.manifests).toHaveLength(1);
    const result = build(source);
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 2, insert: 0, repair_duplicate: 0 },
      pending: 4,
    });
    expect(new Set(result.adoptions.map((item) => item.before.id)).size).toBe(
      2,
    );
    for (const { before, after } of result.adoptions)
      for (const field of [
        "id",
        "investment_id",
        "type",
        "date",
        "units",
        "amount",
        "price_per_unit",
        "fees",
        "taxes",
        "currency",
        "fx_rate_to_eur",
        "note",
      ])
        expect(after[field]).toBe(before[field]);
    expect(result.plan.selectedRowIds).toEqual(
      result.plan.actions.map((action) => action.rowId),
    );
  });
  it("does not infer a broad date window without retained complete-document proof", async () => {
    const { source } = await syntheticKinesisYieldGroup({
      withReference: false,
    });
    expect(build(source).adoptions).toEqual([]);
  });
  it.each([
    "source_hash",
    "reference_literal",
    "deposit_note",
    "yield_anchor",
    "old_note",
    "currency",
    "extra_history",
    "extra_xml",
    "extra_source_identity",
    "missing_pp_member",
  ])(
    "rejects changed or nonclosed %s evidence without partially selecting group members",
    async (kind) => {
      const { source } = await syntheticKinesisYieldGroup();
      if (kind === "source_hash")
        source.rows[2].source_record_hash = "e".repeat(64);
      if (kind === "reference_literal")
        source.batches[0].custom_config.portfolio_performance_reference.yieldGroupEvidence.reference.events[1].literal.sharesMinor =
          "9";
      if (kind === "deposit_note") source.history[0].note = "Changed boundary";
      if (kind === "yield_anchor") source.history[3].note = "Changed anchor";
      if (kind === "old_note")
        source.kinesisAdoptionContext.receipts[1].after_data.note =
          "Not the current anchor";
      if (kind === "currency") source.history[1].amount = "1.0000";
      if (kind === "extra_history")
        source.history.push({
          ...source.history[1],
          id: 999,
          units: "0.00099999",
        });
      if (kind === "extra_xml")
        source.batches[0].custom_config.portfolio_performance_reference.yieldGroupEvidence.reference.events.push(
          {
            ...source.batches[0].custom_config.portfolio_performance_reference
              .yieldGroupEvidence.reference.events[1],
            id: "extra",
          },
        );
      if (kind === "extra_source_identity")
        source.rows[2].source_transaction_id = "hidden:units";
      if (kind === "missing_pp_member")
        source.batches[0].custom_config.portfolio_performance_reference.yieldGroupEvidence.reference.events.splice(
          1,
          1,
        );
      const result = build(source);
      expect(result.plan.ready).toBe(false);
      expect(result.adoptions).toEqual([]);
    },
  );
  it("rejects a global quantity collision outside the proved interval", async () => {
    const { source } = await syntheticKinesisYieldGroup();
    source.history.push({ ...source.history[1], id: 999, date: "2023-01-01" });
    expect(build(source).plan.ready).toBe(false);
    expect(build(source).adoptions).toEqual([]);
  });
  it("rejects a whole-sum residual hidden by independently rounded source members", async () => {
    const { source } = await syntheticKinesisYieldGroup({
      fractionalResidual: true,
    });
    expect(build(source).plan.ready).toBe(false);
    expect(build(source).adoptions).toEqual([]);
  });
  it("settles all same-file group members from unchanged receipts without a second adoption", async () => {
    const { source } = await syntheticKinesisYieldGroup();
    const first = build(source);
    for (const item of first.adoptions) {
      source.history[
        source.history.findIndex((row) => row.id === item.before.id)
      ] = item.after;
      const retained = structuredClone(item.row);
      retained.status = "duplicate";
      source.kinesisAdoptionContext.sources.push(retained);
      source.kinesisAdoptionContext.receipts.push({
        id: 30 + item.row.id,
        batch_id: item.row.batch_id,
        staging_row_id: item.row.id,
        transaction_id: item.before.id,
        policy: "preserve_existing",
        before_data: item.before,
        after_data: item.after,
      });
    }
    source.kinesisAdoptionContext.batches.push(source.batches[0]);
    for (const row of source.rows)
      if (
        !source.kinesisAdoptionContext.sources.some(
          (retained) => retained.id === row.id,
        )
      )
        source.kinesisAdoptionContext.sources.push(structuredClone(row));
    source.kinesisAdoptionContext.sources.sort(
      (a, b) => a.batch_id - b.batch_id || a.row_index - b.row_index,
    );
    expect(build(source).plan).toMatchObject({
      ready: true,
      summary: { adopt: 0, duplicate: 5 },
    });
    expect(build(source).adoptions).toEqual([]);
  });
  it("rejects a changed retained account mapping without any partial group adoption", async () => {
    const { source } = await syntheticKinesisYieldGroup();
    source.batches[0].custom_config.portfolio_performance_reference.yieldGroupEvidence.accountMappings[0].accountId = 999;
    expect(build(source).plan.ready).toBe(false);
    expect(build(source).adoptions).toEqual([]);
  });
});
