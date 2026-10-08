import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  getTestPool,
  closeTestPool,
  hasTestDatabase,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import { fullFixture } from "./helpers/kinesisFullImport.js";
import { nativeGiftFixture } from "./helpers/kinesisNativeGifts.js";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { readReconciliationHistory } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
const pool = getTestPool(),
  owned = { batches: [], investments: [], accounts: [] },
  describeDb = hasTestDatabase() ? describe : describe.skip;
async function stage(account, investment, source = undefined) {
  source ??= await nativeGiftFixture({ account, investment });
  const batch = Number(
    (
      await pool.query(
        "INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_error,account_id,is_brokerage) VALUES($1,$2,'awaiting_review',$3,0,$4,true) RETURNING id",
        [
          source.batches[0].adapter_name,
          JSON.stringify(source.batches[0].custom_config),
          source.rows.length,
          account,
        ],
      )
    ).rows[0].id,
  );
  owned.batches.push(batch);
  for (const row of source.rows)
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,source_transaction_id,source_account_identity,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,note,asset_adjustment_details) VALUES($1,$2,'matched',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,1,$20,$21)`,
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
        investment,
        row.raw_data,
        row.source_record_hash,
        row.source_transaction_id,
        row.source_account_identity,
        row.dedup_fingerprint,
        row.note,
        row.asset_adjustment_details,
      ],
    );
  return batch;
}
async function fixture() {
  const account = (
      await pool.query(
        "INSERT INTO accounts(name,type,currency) VALUES('Native gift wallet','brokerage','EUR') RETURNING id",
      )
    ).rows[0].id,
    investment = (
      await pool.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Native gift gold','KAU','metals','USD') RETURNING id",
      )
    ).rows[0].id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  const manual = (
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,account_id,note) VALUES($1,'gift','2026-01-02',7.25,.4,NULL,0,0,'USD',.92,$2,'Keep original basis and note') RETURNING id",
      [investment, account],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date) VALUES('USD',.92,'2026-01-02') ON CONFLICT(currency_code,rate_date) DO UPDATE SET rate_to_eur=.92",
  );
  const before = (await readReconciliationHistory([investment]))[0];
  return {
    account,
    investment,
    manual,
    before,
    batch: await stage(account, investment),
  };
}
const preview = (fx) =>
  previewPortfolioImportReconciliation({
    batchIds: fx.batchIds ?? [fx.batch],
    adoptPolicy: "prefer_source",
  });
const apply = (fx, plan) =>
  commitReviewedPortfolioImports({
    batchIds: fx.batchIds ?? [fx.batch],
    adoptPolicy: "prefer_source",
    expectedPlanFingerprint: plan.planFingerprint,
  });
async function state(fx) {
  return {
    history: await readReconciliationHistory(owned.investments),
    staging: (
      await pool.query(
        "SELECT to_jsonb(s) AS image FROM portfolio_import_staging_rows s WHERE batch_id=ANY($1::bigint[]) ORDER BY id",
        [owned.batches],
      )
    ).rows,
    batches: (
      await pool.query(
        "SELECT to_jsonb(b) AS image FROM portfolio_import_batches b WHERE id=ANY($1::bigint[]) ORDER BY id",
        [owned.batches],
      )
    ).rows,
    journal: (
      await pool.query(
        "SELECT * FROM portfolio_import_reconciliation_journal WHERE batch_id=ANY($1::bigint[]) ORDER BY id",
        [owned.batches],
      )
    ).rows,
  };
}
async function cleanup() {
  await pool.query(
    "DROP TRIGGER IF EXISTS native_gift_income_failure ON portfolio_import_income_recognition_journal",
  );
  await pool.query("DROP FUNCTION IF EXISTS native_gift_income_failure()");
  await pool.query(
    "DROP TRIGGER IF EXISTS native_gift_failure ON portfolio_transactions",
  );
  await pool.query("DROP FUNCTION IF EXISTS native_gift_failure()");
  await pool.query(
    "TRUNCATE portfolio_import_income_recognition_journal,portfolio_import_reconciliation_journal RESTART IDENTITY",
  );
  await pool.query(
    "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::int[])",
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
describeDb("native gift cardinality persistence", () => {
  beforeAll(async () => acquireDbSuiteLock(pool), 180_000);
  afterEach(cleanup);
  afterAll(async () => {
    await closePool();
    await releaseDbSuiteLock(pool);
    await closeTestPool();
  });
  it("preserves the manual basis, creates one gift, repeats through generic context and restores both atomically", async () => {
    const fx = await fixture(),
      plan = await preview(fx);
    expect(plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 1 },
    });
    expect(await apply(fx, plan)).toMatchObject({
      adopted: 1,
      imported: 1,
      errors: 0,
    });
    const saved = await state(fx),
      first = saved.history.find((row) => Number(row.id) === fx.manual);
    expect(first).toEqual({
      ...fx.before,
      source_record_hash: first.source_record_hash,
      dedup_fingerprint: first.dedup_fingerprint,
      dedup_fingerprint_version: 1,
    });
    expect(saved.journal).toHaveLength(1);
    expect(
      saved.staging.every(
        (row) =>
          row.image.asset_transfer_details.nativeGiftGroupReceipt.after
            .length === 2,
      ),
    ).toBe(true);
    expect(await preview(fx)).toMatchObject({
      ready: true,
      summary: { adopt: 0, insert: 0, settled: 2 },
    });
    const fresh = { ...fx, batch: await stage(fx.account, fx.investment) },
      repeat = await preview(fresh);
    expect(repeat).toMatchObject({
      ready: true,
      summary: { adopt: 0, insert: 0, duplicate: 2 },
    });
    expect(await apply(fresh, repeat)).toMatchObject({
      adopted: 0,
      imported: 0,
      duplicates: 2,
    });
    expect((await state(fx)).history).toEqual(saved.history);
    expect((await state(fx)).journal).toEqual(saved.journal);
    await rollbackBatch(fresh.batch);
    await rollbackBatch(fx.batch);
    expect(await readReconciliationHistory([fx.investment])).toEqual([
      fx.before,
    ]);
  });
  it.each([false, true])(
    "finishes the generic receipt group within atomic full paired-income writes (failure=%s)",
    async (fail) => {
      const fx = await fixture(),
        account = (
          await pool.query(
            "INSERT INTO accounts(name,type,currency) VALUES('Combined broker','brokerage','EUR') RETURNING id",
          )
        ).rows[0].id,
        investment = (
          await pool.query(
            "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Combined yield','KAU','metals','EUR') RETURNING id",
          )
        ).rows[0].id;
      owned.accounts.push(account);
      owned.investments.push(investment);
      await pool.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,note) VALUES($1,'gift','2026-01-04',0,.001,NULL,0,0,'EUR',1,'Keep combined unit note')",
        [investment],
      );
      for (const date of ["2026-01-04", "2026-02-04"])
        await pool.query(
          "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date) VALUES('USD',.92,$1) ON CONFLICT(currency_code,rate_date) DO UPDATE SET rate_to_eur=.92",
          [date],
        );
      const source = await fullFixture({ account, investment }),
        batch = await stage(account, investment, source),
        combined = { ...fx, batchIds: [fx.batch, batch] },
        plan = await preview(combined);
      expect(plan).toMatchObject({
        ready: true,
        summary: { adopt: 2, insert: 2, record_income: 2 },
      });
      if (fail) {
        const before = await state(fx);
        await pool.query(
          "CREATE FUNCTION native_gift_income_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced combined income failure'; END $$",
        );
        await pool.query(
          "CREATE TRIGGER native_gift_income_failure BEFORE INSERT ON portfolio_import_income_recognition_journal FOR EACH ROW EXECUTE FUNCTION native_gift_income_failure()",
        );
        await expect(apply(combined, plan)).rejects.toThrow(
          "forced combined income failure",
        );
        expect(await state(fx)).toEqual(before);
        return;
      }
      const result = await apply(combined, plan);
      expect(result).toMatchObject({
        adopted: 2,
        imported: 4,
        recordedIncome: 2,
        errors: 0,
      });
      expect(
        result.batches.find((row) => row.batch_id === fx.batch),
      ).toMatchObject({ adopted: 1, imported: 1, recordedIncome: 0 });
      expect(
        result.batches.find((row) => row.batch_id === batch),
      ).toMatchObject({ adopted: 1, imported: 3, recordedIncome: 2 });
      expect(await preview(combined)).toMatchObject({
        ready: true,
        summary: { insert: 0, adopt: 0, record_income: 0, settled: 6 },
      });
      const before = (await state(fx)).history.find(
        (row) => Number(row.id) === fx.manual,
      );
      expect(before).toEqual({
        ...fx.before,
        source_record_hash: before.source_record_hash,
        dedup_fingerprint: before.dedup_fingerprint,
        dedup_fingerprint_version: 1,
      });
      await rollbackBatch(batch);
      await rollbackBatch(fx.batch);
      expect(await readReconciliationHistory([fx.investment])).toEqual([
        fx.before,
      ]);
    },
  );
  it.each(["note", "fx", "raw", "manifest"])(
    "blocks fresh repeats and rollback on retained %s drift",
    async (kind) => {
      const fx = await fixture();
      await apply(fx, await preview(fx));
      if (kind === "note")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Changed afterimage' WHERE id=$1",
          [fx.manual],
        );
      if (kind === "fx")
        await pool.query(
          "UPDATE portfolio_transactions SET fx_rate_to_eur=.93 WHERE id=$1",
          [fx.manual],
        );
      if (kind === "raw")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET raw_data=raw_data||' ' WHERE batch_id=$1 AND row_index=1",
          [fx.batch],
        );
      if (kind === "manifest")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET asset_transfer_details=jsonb_set(asset_transfer_details::jsonb,'{nativeGiftGroupReceipt,after,0,note}','\"Changed other member\"') WHERE batch_id=$1 AND row_index=1",
          [fx.batch],
        );
      const fresh = { ...fx, batch: await stage(fx.account, fx.investment) };
      expect((await preview(fresh)).ready).toBe(false);
      const before = await state(fx);
      await expect(rollbackBatch(fx.batch)).rejects.toThrow(
        /source evidence changed/,
      );
      expect(await state(fx)).toEqual(before);
    },
  );
  it("rolls source attachment and receipt back if the second gift writer fails", async () => {
    const fx = await fixture(),
      plan = await preview(fx),
      before = await state(fx);
    await pool.query(
      "CREATE FUNCTION native_gift_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced native gift failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER native_gift_failure BEFORE INSERT ON portfolio_transactions FOR EACH ROW EXECUTE FUNCTION native_gift_failure()",
    );
    await expect(apply(fx, plan)).rejects.toThrow();
    expect(await state(fx)).toEqual(before);
  });
});
