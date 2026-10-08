import { describe, it, expect } from "vitest";
import { nativeGiftFixture } from "./helpers/kinesisNativeGifts.js";
import { proveKinesisNativeGiftGroups } from "../src/services/portfolioKinesisNetworkProof.ts";
import { buildPortfolioImportReconciliationPlan } from "../src/services/portfolioImportReconciliationService.ts";
const proof = (source) =>
  proveKinesisNativeGiftGroups(
    source.rows,
    source.batches,
    source.history,
    source.nativeGiftContext,
  );
function owned(source) {
  const group = proof(source).groups[0],
    manual = source.history[0];
  const history = source.rows.map((row, index) => ({
    ...manual,
    id: index ? 41 : manual.id,
    note: index ? row.note : manual.note,
    fx_rate_to_eur: index ? null : manual.fx_rate_to_eur,
    source_record_hash: row.source_record_hash,
    dedup_fingerprint: row.dedup_fingerprint,
    dedup_fingerprint_version: 1,
    import_batch_id: index ? row.batch_id : null,
  }));
  const manifest = { version: 1, proof: group.proof, after: history };
  const sources = source.rows.map((row, index) => ({
    ...row,
    status: index ? "committed" : "duplicate",
    committed_txn_id: index ? history[index].id : null,
    asset_transfer_details: {
      nativeGiftGroupReceipt: structuredClone(manifest),
    },
  }));
  return {
    ...source,
    history,
    nativeGiftContext: {
      sources,
      batches: source.batches.map((batch) => ({
        ...batch,
        status: "complete",
      })),
      receipts: [
        {
          transaction_id: manual.id,
          batch_id: source.rows[0].batch_id,
          staging_row_id: source.rows[0].id,
          policy: "prefer_source",
          before_data: manual,
          after_data: history[0],
        },
      ],
    },
  };
}
describe("closed native gift cardinality", () => {
  it("attaches one existing gift without changing its finances and creates one missing event", async () => {
    const source = await nativeGiftFixture(),
      before = structuredClone(source.history[0]);
    const result = buildPortfolioImportReconciliationPlan({
      ...source,
      adoptPolicy: "prefer_source",
    });
    expect(result.plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 1 },
    });
    expect(result.adoptions[0].after).toEqual({
      ...before,
      source_record_hash: source.rows[0].source_record_hash,
      dedup_fingerprint: source.rows[0].dedup_fingerprint,
      dedup_fingerprint_version: 1,
    });
    expect(result.adoptions[0].row.id).toBe(source.rows[0].id);
    expect(
      result.plan.actions.find((action) => action.action === "adopt")
        .corrections,
    ).toEqual([]);
    expect(source.history[0]).toEqual(before);
  });
  it.each([undefined, "preserve_existing"])(
    "requires source preference before association (%s)",
    async (adoptPolicy) => {
      const source = await nativeGiftFixture();
      expect(
        buildPortfolioImportReconciliationPlan({ ...source, adoptPolicy }).plan
          .ready,
      ).toBe(false);
    },
  );
  it.each([
    "none",
    "wrong_account",
    "wrong_date",
    "wrong_basis",
    "wrong_units",
    "two_manual",
    "one_source",
    "different_basis_file",
    "source_price",
  ])("rejects %s instead of inserting both gifts", async (kind) => {
    const source = await nativeGiftFixture();
    if (kind === "none") source.history = [];
    if (kind === "wrong_account") source.history[0].account_id = 99;
    if (kind === "wrong_date") source.history[0].date = "2026-01-03";
    if (kind === "wrong_basis") source.history[0].amount = "8";
    if (kind === "wrong_units") source.history[0].units = "0.3";
    if (kind === "two_manual")
      source.history.push({ ...source.history[0], id: 42 });
    if (kind === "one_source") source.rows.pop();
    if (kind === "different_basis_file")
      source.rows[1].raw_data = source.rows[1].raw_data.replaceAll(
        "f".repeat(64),
        "e".repeat(64),
      );
    if (kind === "source_price") source.rows[1].price_per_unit = "9";
    expect(proof(source).blockers.length).toBeGreaterThan(0);
    expect(
      buildPortfolioImportReconciliationPlan({
        ...source,
        adoptPolicy: "prefer_source",
      }).plan.ready,
    ).toBe(false);
  });
  it("requires both retained full images and treats JSONB ordering as equivalent", async () => {
    const source = owned(await nativeGiftFixture());
    source.nativeGiftContext.sources[1].asset_transfer_details.nativeGiftGroupReceipt =
      Object.fromEntries(
        Object.entries(
          source.nativeGiftContext.sources[1].asset_transfer_details
            .nativeGiftGroupReceipt,
        ).reverse(),
      );
    expect(proof(source)).toMatchObject({ groups: [], blockers: [] });
    expect(
      buildPortfolioImportReconciliationPlan({
        ...source,
        adoptPolicy: "prefer_source",
      }).plan,
    ).toMatchObject({
      ready: true,
      summary: { insert: 0, adopt: 0, duplicate: 2 },
    });
  });
  it.each([
    "note",
    "fx",
    "raw",
    "manifest_other",
    "manifest_malformed",
    "aborted",
    "pointer",
    "old_receipt",
  ])("rejects retained %s drift", async (kind) => {
    const source = owned(await nativeGiftFixture()),
      context = source.nativeGiftContext;
    if (kind === "note") source.history[0].note = "Changed note";
    if (kind === "fx") source.history[0].fx_rate_to_eur = "0.93";
    if (kind === "raw") context.sources[1].raw_data += " ";
    if (kind === "manifest_other")
      context.sources[1].asset_transfer_details.nativeGiftGroupReceipt.after[0].note =
        "Changed other member";
    if (kind === "manifest_malformed")
      context.sources[0].asset_transfer_details.nativeGiftGroupReceipt.after =
        {};
    if (kind === "aborted") context.batches[0].status = "aborted";
    if (kind === "pointer") context.sources[1].committed_txn_id = 900;
    if (kind === "old_receipt")
      context.receipts[0].before_data = {
        ...context.receipts[0].before_data,
        note: "Different before",
      };
    expect(proof(source).blockers.length).toBeGreaterThan(0);
  });
});
