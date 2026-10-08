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
import {
  readReconciliationHistory,
  PORTFOLIO_TRANSACTION_SNAPSHOT_SQL,
} from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.js";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.js";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.js";
const pool = getTestPool();
const owned = { batches: [], accounts: [], investments: [] };
const describeDb = hasTestDatabase() ? describe : describe.skip;
async function stage(account, investment) {
  const source = await fullFixture({ account, investment });
  const batch = Number(
    (
      await pool.query(
        "INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_error,account_id,is_brokerage) VALUES('kinesis_transaction_history',$1,'awaiting_review',$2,0,$3,true) RETURNING id",
        [
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
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,name_raw,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,source_transaction_id,source_account_identity,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,asset_adjustment_details,note)
     VALUES($1,$2,'matched',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1,1,$21,$22)`,
      [
        batch,
        row.row_index,
        row.tx_date,
        row.type_raw,
        row.type,
        row.route,
        row.symbol_raw,
        row.name_raw,
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
        row.asset_adjustment_details,
        row.note,
      ],
    );
  return batch;
}
async function fixture() {
  const account = (
    await pool.query(
      "INSERT INTO accounts(name,type,currency) VALUES('Full pair source','brokerage','EUR') RETURNING id",
    )
  ).rows[0].id;
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Full pair units','KAU','metals','EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  const manual = (
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,fx_rate_to_eur,note) VALUES($1,'gift','2026-01-04',0,.001,NULL,0,0,'EUR',1,'Keep manual note') RETURNING id",
      [investment],
    )
  ).rows[0].id;
  const batch = await stage(account, investment);
  const before = (await readReconciliationHistory([investment])).find(
    (row) => Number(row.id) === manual,
  );
  for (const date of ["2026-01-04", "2026-02-04"])
    await pool.query(
      "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date) VALUES('USD',1.25,$1) ON CONFLICT(currency_code,rate_date) DO UPDATE SET rate_to_eur=1.25",
      [date],
    );
  return { account, investment, batch, manual, before };
}
const preview = (fx) =>
  previewPortfolioImportReconciliation({
    batchIds: [fx.batch],
    adoptPolicy: "prefer_source",
  });
const apply = (fx, plan) =>
  commitReviewedPortfolioImports({
    batchIds: [fx.batch],
    adoptPolicy: "prefer_source",
    expectedPlanFingerprint: plan.planFingerprint,
  });
async function state(fx) {
  return {
    history: (
      await pool.query(
        `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS image FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id`,
        [fx.investment],
      )
    ).rows,
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
    adoption: (
      await pool.query(
        "SELECT * FROM portfolio_import_reconciliation_journal WHERE batch_id=ANY($1::bigint[]) ORDER BY id",
        [owned.batches],
      )
    ).rows,
    income: (
      await pool.query(
        "SELECT * FROM portfolio_import_income_recognition_journal WHERE batch_id=ANY($1::bigint[]) ORDER BY id",
        [owned.batches],
      )
    ).rows,
  };
}
async function cleanup() {
  await pool.query(
    "DROP TRIGGER IF EXISTS full_income_failure ON portfolio_import_income_recognition_journal",
  );
  await pool.query("DROP FUNCTION IF EXISTS full_income_failure()");
  await pool.query(
    "TRUNCATE portfolio_import_income_recognition_journal,portfolio_import_reconciliation_journal RESTART IDENTITY",
  );
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.batches.length)
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
      [owned.batches],
    );
  if (owned.investments.length)
    await pool.query("DELETE FROM investments WHERE id=ANY($1::integer[])", [
      owned.investments,
    ]);
  if (owned.accounts.length)
    await pool.query("DELETE FROM accounts WHERE id=ANY($1::integer[])", [
      owned.accounts,
    ]);
  owned.batches = [];
  owned.accounts = [];
  owned.investments = [];
}
describeDb("full paired Kinesis import atomicity", () => {
  beforeAll(async () => acquireDbSuiteLock(pool));
  afterEach(cleanup);
  afterAll(async () => {
    await closePool();
    await releaseDbSuiteLock(pool);
    await closeTestPool();
  });
  it("writes existing quantity correction, new units and two descriptive incomes once", async () => {
    const fx = await fixture(),
      plan = await preview(fx);
    expect(plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 1, record_income: 2 },
    });
    expect(await apply(fx, plan)).toMatchObject({
      imported: 3,
      adopted: 1,
      recordedIncome: 2,
      recordedCash: 0,
      errors: 0,
    });
    const saved = await state(fx),
      manual = saved.history.find((row) => row.image.id === fx.manual).image;
    expect(manual).toEqual({
      ...fx.before,
      units: "0.00287000",
      account_id: fx.account,
      source_record_hash: manual.source_record_hash,
      dedup_fingerprint: manual.dedup_fingerprint,
      dedup_fingerprint_version: 1,
    });
    expect(saved.income).toHaveLength(2);
    expect(
      saved.history
        .filter((row) => row.image.type === "dividend")
        .every(
          (row) =>
            row.image.income_recognition_role === "included_in_units" &&
            row.image.fx_rate_to_eur == null,
        ),
    ).toBe(true);
    const second = await preview(fx);
    expect(second).toMatchObject({
      ready: true,
      summary: { record_income: 0, insert: 0, adopt: 0, settled: 4 },
    });
    const batch = await stage(fx.account, fx.investment),
      fresh = { ...fx, batch };
    const repeated = await preview(fresh);
    expect(repeated).toMatchObject({
      ready: true,
      summary: { record_income: 0, insert: 0, adopt: 0, duplicate: 4 },
    });
    expect(await apply(fresh, repeated)).toMatchObject({
      imported: 0,
      duplicates: 4,
      recordedIncome: 0,
    });
    expect((await state(fx)).history).toEqual(saved.history);
    expect((await state(fx)).income).toEqual(saved.income);
  });
  it.each(["note", "source", "rate"])(
    "rejects stale %s before any writer",
    async (kind) => {
      const fx = await fixture(),
        plan = await preview(fx);
      if (kind === "note")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Changed' WHERE id=$1",
          [fx.manual],
        );
      if (kind === "source")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET raw_data=raw_data||' ' WHERE batch_id=$1 AND row_index=0",
          [fx.batch],
        );
      if (kind === "rate")
        await pool.query(
          "UPDATE exchange_rates SET rate_to_eur=1.3 WHERE currency_code='USD' AND rate_date='2026-02-04'",
        );
      const before = await state(fx);
      await expect(apply(fx, plan)).rejects.toMatchObject({
        details: { reason: "stale_reconciliation_plan" },
      });
      expect(await state(fx)).toEqual(before);
    },
  );
  it("rolls all prior unit and receipt writes back if a later income receipt fails", async () => {
    const fx = await fixture(),
      plan = await preview(fx),
      before = await state(fx);
    await pool.query(
      "CREATE FUNCTION full_income_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM portfolio_import_income_recognition_journal)>0 THEN RAISE EXCEPTION 'forced second income receipt failure'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER full_income_failure BEFORE INSERT ON portfolio_import_income_recognition_journal FOR EACH ROW EXECUTE FUNCTION full_income_failure()",
    );
    await expect(apply(fx, plan)).rejects.toThrow(
      "forced second income receipt failure",
    );
    expect(await state(fx)).toEqual(before);
  });
  it("restores the original manual image after income is reversed and permits a fresh full restage", async () => {
    const fx = await fixture();
    await apply(fx, await preview(fx));
    await rollbackBatch(fx.batch);
    expect(await readReconciliationHistory([fx.investment])).toEqual([
      fx.before,
    ]);
    await expect(apply(fx, await preview(fx))).rejects.toThrow(/reviewable/);
    const fresh = { ...fx, batch: await stage(fx.account, fx.investment) };
    expect(await apply(fresh, await preview(fresh))).toMatchObject({
      imported: 3,
      adopted: 1,
      recordedIncome: 2,
    });
    const before = await state(fx);
    await expect(
      pool.query(
        "UPDATE portfolio_transactions SET note='Changed paired unit' WHERE id=$1",
        [fx.manual],
      ),
    ).rejects.toThrow();
    expect(await state(fx)).toEqual(before);
    await rollbackBatch(fresh.batch);
    expect(await readReconciliationHistory([fx.investment])).toEqual([
      fx.before,
    ]);
  });
});
