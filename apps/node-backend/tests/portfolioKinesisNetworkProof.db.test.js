import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  getTestPool,
  closeTestPool,
  hasTestDatabase,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import { networkBindingFixture } from "./helpers/kinesisNetworkBinding.js";
import { networkSource } from "./helpers/kinesisNetwork.js";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
import { pruneOldImportBatches } from "../src/startup/warmup.ts";
const pool = getTestPool(),
  owned = { batches: [], investments: [], accounts: [] },
  describeDb = hasTestDatabase() ? describe : describe.skip;
async function stage(scope) {
  const batch = Number(
    (
      await pool.query(
        "INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_error,account_id,is_brokerage) VALUES($1,$2,'awaiting_review',$3,0,$4,true) RETURNING id",
        [
          scope.batches[0].custom_config.format ?? "portfolio_generic",
          JSON.stringify(scope.batches[0].custom_config),
          scope.rows.length,
          scope.batches[0].account_id,
        ],
      )
    ).rows[0].id,
  );
  owned.batches.push(batch);
  for (const row of scope.rows)
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,source_transaction_id,source_account_identity,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,asset_adjustment_details,asset_transfer_details,note) VALUES($1,$2,'matched',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,1,$20,$21,$22)`,
      [
        batch,
        row.row_index,
        row.tx_date,
        row.type_raw,
        row.type,
        row.route,
        row.symbol_raw,
        row.units,
        row.price_per_unit,
        row.amount,
        row.fees,
        row.taxes,
        row.currency,
        row.investment_id,
        row.raw_data,
        row.source_record_hash,
        row.source_transaction_id,
        row.source_account_identity,
        row.dedup_fingerprint,
        row.asset_adjustment_details,
        row.asset_transfer_details,
        row.note,
      ],
    );
  return batch;
}
async function fixture() {
  const accounts = (
      await pool.query(
        "INSERT INTO accounts(name,type,currency) VALUES('Native broker','brokerage','EUR'),('Native logical wallet','brokerage','EUR') RETURNING id",
      )
    ).rows.map((r) => r.id),
    investments = (
      await pool.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Native silver','KAG','metals','EUR'),('Native gold','KAU','metals','EUR') RETURNING id",
      )
    ).rows.map((r) => r.id);
  owned.accounts.push(...accounts);
  owned.investments.push(...investments);
  for (const investment of investments)
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,account_id,note) VALUES($1,'gift','2026-01-01',0,1,NULL,0,0,'EUR',1,$2,'Preserve initial literal acquisition')",
      [investment, accounts[1]],
    );
  const source = await networkBindingFixture({
      broker: accounts[0],
      wallet: accounts[1],
      investment: investments[0],
    }),
    fee = await networkSource({
      kind: "asset_fee",
      asset: "KAU",
      investment: investments[1],
      account: accounts[1],
    }),
    primary = await stage(source.primary),
    witness = await stage(source.witness),
    feeBatch = await stage(fee);
  return {
    accounts,
    investments,
    batchIds: [primary, witness, feeBatch],
    primary,
    witness,
    feeBatch,
  };
}
const preview = (fx) =>
  previewPortfolioImportReconciliation({
    batchIds: fx.batchIds,
    adoptPolicy: "prefer_source",
  });
const apply = (fx, plan) =>
  commitReviewedPortfolioImports({
    batchIds: fx.batchIds,
    adoptPolicy: "prefer_source",
    expectedPlanFingerprint: plan.planFingerprint,
  });
async function state(fx) {
  const result = {};
  for (const [key, table] of Object.entries({
    portfolio: "portfolio_transactions",
    transfers: "portfolio_asset_transfers",
    adjustments: "portfolio_asset_adjustments",
  }))
    result[key] = (
      await pool.query(
        `SELECT to_jsonb(t) AS image FROM ${table} t WHERE investment_id=ANY($1::int[]) ORDER BY id`,
        [fx.investments],
      )
    ).rows;
  for (const [key, table] of Object.entries({
    staging: "portfolio_import_staging_rows",
    batches: "portfolio_import_batches",
  }))
    result[key] = (
      await pool.query(
        `SELECT to_jsonb(t) AS image FROM ${table} t WHERE ${key === "staging" ? "batch_id" : "id"}=ANY($1::bigint[]) ORDER BY id`,
        [owned.batches],
      )
    ).rows;
  return result;
}
async function cleanup() {
  await pool.query(
    "DROP TRIGGER IF EXISTS native_second_writer_failure ON portfolio_asset_adjustments",
  );
  await pool.query("DROP FUNCTION IF EXISTS native_second_writer_failure()");
  await pool.query(
    "DELETE FROM portfolio_asset_adjustment_sources WHERE adjustment_id IN (SELECT id FROM portfolio_asset_adjustments WHERE investment_id=ANY($1::int[]))",
    [owned.investments],
  );
  for (const table of [
    "portfolio_asset_transfers",
    "portfolio_asset_adjustments",
    "portfolio_transactions",
  ])
    await pool.query(
      `DELETE FROM ${table} WHERE investment_id=ANY($1::int[])`,
      [owned.investments],
    );
  await pool.query(
    "DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
    [owned.batches],
  );
  await pool.query("DELETE FROM investments WHERE id=ANY($1::int[])", [
    owned.investments,
  ]);
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::int[])", [
    owned.accounts,
  ]);
  owned.batches = [];
  owned.investments = [];
  owned.accounts = [];
}
describeDb("native wallet proof full import lifecycle", () => {
  beforeAll(async () => acquireDbSuiteLock(pool), 180_000);
  afterEach(cleanup);
  afterAll(async () => {
    await closePool();
    await releaseDbSuiteLock(pool);
    await closeTestPool();
  });
  it("commits with a NULL-instrument InternalMovement witness and repeats the original alone", async () => {
    const fx = await fixture(),
      before = await state(fx),
      plan = await preview(fx);
    const originalWitness = before.staging.find(
      (row) => Number(row.image.batch_id) === fx.witness,
    ).image;
    expect(originalWitness).toMatchObject({
      type: null,
      type_raw: "InternalMovement",
      route: "account_internal",
      resolved_investment_id: null,
      user_override_investment_id: null,
    });
    expect(plan.ready).toBe(true);
    expect(await apply(fx, plan)).toMatchObject({ imported: 2, errors: 0 });
    const saved = await state(fx);
    expect(saved.portfolio).toEqual(before.portfolio);
    expect(saved.transfers).toHaveLength(1);
    expect(saved.adjustments).toHaveLength(1);
    expect(
      saved.staging.find((row) => row.image.id === originalWitness.id).image,
    ).toMatchObject({
      type: null,
      type_raw: "InternalMovement",
      resolved_investment_id: null,
      user_override_investment_id: null,
      raw_data: originalWitness.raw_data,
      source_record_hash: originalWitness.source_record_hash,
      dedup_fingerprint: originalWitness.dedup_fingerprint,
    });
    const source = saved.staging.find(
        (r) => Number(r.image.batch_id) === fx.primary,
      ).image,
      original = before.staging.find((r) => r.image.id === source.id).image;
    expect(source).toMatchObject({
      source_record_hash: original.source_record_hash,
      dedup_fingerprint: original.dedup_fingerprint,
      raw_data: original.raw_data,
      route: "asset_transfer",
      units: 0.03015,
    });
    const freshScope = await networkBindingFixture({
        broker: fx.accounts[0],
        wallet: fx.accounts[1],
        investment: fx.investments[0],
      }),
      fresh = { ...fx, batchIds: [await stage(freshScope.primary)] },
      repeat = await preview(fresh);
    expect(repeat).toMatchObject({
      ready: true,
      summary: { duplicate: 1, insert: 0 },
    });
    expect(await apply(fresh, repeat)).toMatchObject({
      imported: 0,
      duplicates: 1,
    });
    expect((await state(fx)).transfers).toEqual(saved.transfers);
    const protectedState = await state(fx);
    await expect(rollbackBatch(fx.witness)).rejects.toThrow(/still used/);
    expect(await state(fx)).toEqual(protectedState);
    await rollbackBatch(fx.primary);
    await rollbackBatch(fx.witness);
    await rollbackBatch(fx.feeBatch);
    const undone = await state(fx);
    expect(undone.portfolio).toEqual(before.portfolio);
    expect(undone.transfers).toEqual([]);
    expect(undone.adjustments).toEqual([]);
  });
  it("rolls all writers back on native fee failure", async () => {
    const fx = await fixture(),
      plan = await preview(fx),
      before = await state(fx);
    await pool.query(
      "CREATE FUNCTION native_second_writer_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced native writer failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER native_second_writer_failure BEFORE INSERT ON portfolio_asset_adjustments FOR EACH ROW EXECUTE FUNCTION native_second_writer_failure()",
    );
    await expect(apply(fx, plan)).rejects.toMatchObject({
      details: { reason: "atomic_import_failed" },
    });
    expect(await state(fx)).toEqual(before);
  });
  it.each(["witness", "fee"])(
    "fails closed on retained %s source drift",
    async (kind) => {
      const fx = await fixture();
      await apply(fx, await preview(fx));
      const changedBatch = kind === "witness" ? fx.witness : fx.feeBatch;
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET raw_data=raw_data||' ' WHERE batch_id=$1",
        [changedBatch],
      );
      const before = await state(fx);
      await expect(rollbackBatch(changedBatch)).rejects.toThrow();
      expect(await state(fx)).toEqual(before);
      if (kind === "witness") {
        const source = await networkBindingFixture({
            broker: fx.accounts[0],
            wallet: fx.accounts[1],
            investment: fx.investments[0],
          }),
          fresh = { ...fx, batchIds: [await stage(source.primary)] };
        expect((await preview(fresh)).ready).toBe(false);
      }
    },
  );
  it("retains terminal typed evidence during automatic pruning", async () => {
    const fx = await fixture();
    await apply(fx, await preview(fx));
    await pool.query(
      "UPDATE portfolio_import_batches SET started_at=now()-interval '60 days' WHERE id=ANY($1::bigint[])",
      [fx.batchIds],
    );
    await pruneOldImportBatches();
    expect((await state(fx)).batches).toHaveLength(3);
  });
});
