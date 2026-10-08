import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  getTestPool,
  closeTestPool,
  hasTestDatabase,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import {
  syntheticKinesisScope,
  syntheticKinesisManual,
} from "./helpers/kinesisAdoptionScope.js";
import {
  readReconciliationSources,
  readReconciliationHistory,
  compareAndSetReconciledTransaction,
  insertReconciliationReceipt,
  PORTFOLIO_TRANSACTION_SNAPSHOT_SQL,
} from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { withTransaction } from "../src/database/connection.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.js";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.js";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.js";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.js";
import {
  getRowsForPortfolioMath,
  mapPortfolioTxRow,
} from "../src/repositories/portfolioTxRepo.reads.ts";
import { buildInvestmentSummaryCorePartitioned } from "@vision/shared-utils/portfolio";
import { commitBatch as commit } from "../src/services/portfolioImportPipeline/commit.js";
const historicalWarm = vi.hoisted(() => ({ available: true }));
import { clearHistoricalCache } from "../src/services/currency/rateFetcher.js";
const pool = getTestPool();
const owned = { investments: [], accounts: [], batches: [] };
const describeDb = hasTestDatabase() ? describe : describe.skip;
async function stage(account, investment) {
  const source = await syntheticKinesisScope({ account, investment });
  const batch = Number(
    (
      await pool.query(
        "INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_error,account_id,is_brokerage) VALUES('kinesis_transaction_history',$1,'awaiting_review',$2,$3,$4,true) RETURNING id",
        [
          JSON.stringify(source.batches[0].custom_config),
          source.rows.length,
          source.rows.filter((r) => r.status === "error").length,
          account,
        ],
      )
    ).rows[0].id,
  );
  owned.batches.push(batch);
  for (const row of source.rows)
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,name_raw,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,source_transaction_id,source_account_identity,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,error_message,asset_transfer_details,asset_adjustment_details,note)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [
        batch,
        row.row_index,
        row.status,
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
        row.investment_id,
        row.raw_data,
        row.source_record_hash,
        row.source_transaction_id,
        row.source_account_identity,
        row.dedup_fingerprint,
        row.dedup_fingerprint_version,
        row.dedup_occurrence,
        row.error_message ?? null,
        row.asset_transfer_details,
        row.asset_adjustment_details,
        row.note,
      ],
    );
  return batch;
}
async function fixture() {
  const account = (
    await pool.query(
      "INSERT INTO accounts(name,type,currency) VALUES('Income pair test','brokerage','EUR') RETURNING id",
    )
  ).rows[0].id;
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Income pair asset','KAU','metals','EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  const prior = await stage(account, investment);
  const fresh = await stage(account, investment);
  const rows = await readReconciliationSources([prior]);
  const row = rows.find((r) => r.source_transaction_id === "TX-YIELD:units");
  const manual = syntheticKinesisManual(row);
  const id = (
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note) VALUES($1,'gift',$2,0,$3,0,0,0,$4,$5) RETURNING id",
      [investment, row.tx_date, row.units, "EUR", manual.note],
    )
  ).rows[0].id;
  const before = (await readReconciliationHistory([investment])).find(
    (r) => r.id === id,
  );
  const after = {
    ...before,
    account_id: account,
    source_record_hash: row.source_record_hash,
    dedup_fingerprint: row.dedup_fingerprint,
    dedup_fingerprint_version: row.dedup_fingerprint_version,
  };
  await withTransaction(async () => {
    const persisted = await compareAndSetReconciledTransaction(before, after);
    await insertReconciliationReceipt({
      batchId: prior,
      stagingRowId: Number(row.id),
      transactionId: id,
      action: "adopt",
      policy: "preserve_existing",
      before,
      after: persisted,
    });
  });
  await pool.query(
    "UPDATE portfolio_import_staging_rows SET status='duplicate' WHERE id=$1",
    [row.id],
  );
  await pool.query(
    "UPDATE portfolio_import_batches SET rows_duplicate=1 WHERE id=$1",
    [prior],
  );
  return { account, investment, prior, fresh, unitId: id };
}
const preview = (fx) =>
  previewPortfolioImportReconciliation({
    batchIds: [fx.fresh],
    adoptPolicy: "preserve_existing",
    reconciliationScope: "record_in_kind_income_only",
  });
const apply = (fx, plan) =>
  commitReviewedPortfolioImports({
    batchIds: [fx.fresh],
    adoptPolicy: "preserve_existing",
    reconciliationScope: "record_in_kind_income_only",
    expectedPlanFingerprint: plan.planFingerprint,
  });
async function state(fx) {
  return {
    transactions: (
      await pool.query(
        `SELECT ${PORTFOLIO_TRANSACTION_SNAPSHOT_SQL} AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id`,
        [fx.investment],
      )
    ).rows,
    staging: (
      await pool.query(
        "SELECT to_jsonb(s) AS data FROM portfolio_import_staging_rows s WHERE batch_id=ANY($1::bigint[]) ORDER BY id",
        [[fx.prior, fx.fresh]],
      )
    ).rows,
    batches: (
      await pool.query(
        "SELECT to_jsonb(b) AS data FROM portfolio_import_batches b WHERE id=ANY($1::bigint[]) ORDER BY id",
        [[fx.prior, fx.fresh]],
      )
    ).rows,
    journal: (
      await pool.query(
        "SELECT * FROM portfolio_import_income_recognition_journal ORDER BY id",
      )
    ).rows,
    oldJournal: (
      await pool.query(
        "SELECT * FROM portfolio_import_reconciliation_journal ORDER BY id",
      )
    ).rows,
  };
}
async function cleanup() {
  historicalWarm.available = true;
  clearHistoricalCache();
  await pool.query(
    "DELETE FROM exchange_rates WHERE currency_code='USD' AND rate_date IN ('2026-01-04','2025-12-26')",
  );
  await pool.query(
    "DROP TRIGGER IF EXISTS income_pair_test_failure ON portfolio_import_income_recognition_journal",
  );
  await pool.query("DROP FUNCTION IF EXISTS income_pair_test_failure()");
  await pool.query(
    "TRUNCATE portfolio_import_income_recognition_journal RESTART IDENTITY",
  );
  await pool.query(
    "TRUNCATE portfolio_import_reconciliation_journal RESTART IDENTITY",
  );
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.batches.length) {
    await pool.query(
      "DELETE FROM portfolio_import_staging_rows WHERE batch_id=ANY($1::bigint[])",
      [owned.batches],
    );
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
      [owned.batches],
    );
  }
  if (owned.investments.length)
    await pool.query("DELETE FROM investments WHERE id=ANY($1::integer[])", [
      owned.investments,
    ]);
  if (owned.accounts.length)
    await pool.query("DELETE FROM accounts WHERE id=ANY($1::integer[])", [
      owned.accounts,
    ]);
  for (const key of Object.keys(owned)) owned[key].length = 0;
}
describeDb("durable paired income scoped writer", () => {
  beforeAll(async () => {
    await acquireDbSuiteLock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (
          !String(url).startsWith(
            "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist",
          )
        )
          throw new Error(
            "Unexpected provider request in income DB regression",
          );
        return new Response(
          historicalWarm.available
            ? `<gesmes:Envelope xmlns:gesmes="urn:test" xmlns="urn:ecb"><Cube><Cube time="2026-01-02"><Cube currency="USD" rate="1.25"/></Cube></Cube></gesmes:Envelope>`
            : `<gesmes:Envelope xmlns:gesmes="urn:test" xmlns="urn:ecb"><Cube/></gesmes:Envelope>`,
          { status: 200 },
        );
      }),
    );
  }, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    vi.unstubAllGlobals();
    await releaseDbSuiteLock();
    await closePool();
    await closeTestPool();
  });
  it("records one source amount, retains unit/old receipt/excluded staging, repeats safely and rolls back income before unit", async () => {
    const fx = await fixture();
    const before = await state(fx);
    const plan = await preview(fx);
    expect(plan.blockers).toEqual([]);
    expect(plan).toMatchObject({
      ready: true,
      summary: { record_income: 1, insert: 0, adopt: 0, repair_duplicate: 0 },
    });
    const result = await apply(fx, plan);
    expect(result).toMatchObject({
      imported: 1,
      recordedIncome: 1,
      adopted: 0,
      repaired: 0,
      complete: false,
      batches: [{ imported: 1, recordedIncome: 1, pending: 11 }],
    });
    const after = await state(fx);
    expect(after.transactions[0]).toEqual(before.transactions[0]);
    expect(after.oldJournal).toEqual(before.oldJournal);
    expect(
      after.staging.filter((row) => row.data.id !== plan.selectedRowIds[0]),
    ).toEqual(
      before.staging.filter((row) => row.data.id !== plan.selectedRowIds[0]),
    );
    expect(after.journal).toHaveLength(1);
    const income = after.transactions[1].data;
    expect(income).toMatchObject({
      type: "dividend",
      income_recognition_role: "included_in_units",
      amount: "0.1618",
      units: null,
      price_per_unit: null,
      fees: "0.0000",
      taxes: "0.0000",
      fx_rate_to_eur: null,
    });
    expect(mapPortfolioTxRow(income).income_recognition_role).toBe(
      "included_in_units",
    );
    const math = await getRowsForPortfolioMath();
    const scoped = math.filter((row) => row.investment_id === fx.investment);
    const summary = buildInvestmentSummaryCorePartitioned(
      { asset_class: "metals", current_price: 100 },
      scoped,
      { costBasisMethod: "fifo", todayYmd: "2026-01-20", fxMultiplierNow: 1 },
    ).core;
    expect(summary.totalIncome.eq(0)).toBe(true);
    expect(summary.totalInKindIncome.toNumber()).toBeCloseTo(0.1618);
    const repeat = await preview(fx);
    expect(repeat).toMatchObject({
      ready: true,
      summary: { record_income: 0, settled: 1 },
    });
    expect(await apply(fx, repeat)).toMatchObject({
      imported: 0,
      recordedIncome: 0,
      duplicates: 0,
    });
    expect((await state(fx)).journal).toEqual(after.journal);
    const fresh = await stage(fx.account, fx.investment);
    const copy = { ...fx, fresh };
    const duplicate = await preview(copy);
    expect(duplicate).toMatchObject({
      ready: true,
      summary: { record_income: 0, duplicate: 1 },
    });
    expect(await apply(copy, duplicate)).toMatchObject({
      imported: 0,
      recordedIncome: 0,
      duplicates: 1,
    });
    await expect(rollbackBatch(fx.prior)).rejects.toThrow(/paired income/);
    await expect(
      portfolioTransactionService.update(fx.unitId, {
        note: "Break afterimage",
      }),
    ).rejects.toThrow(/paired income/);
    await expect(portfolioTransactionService.remove(fx.unitId)).rejects.toThrow(
      /paired income/,
    );
    await rollbackBatch(fx.fresh);
    expect((await state(fx)).transactions).toEqual(before.transactions);
    expect((await state(fx)).journal.map((r) => r.action)).toEqual([
      "record",
      "restore",
    ]);
    await rollbackBatch(fx.prior);
    expect((await state(fx)).transactions[0].data).toMatchObject({
      account_id: null,
      dedup_fingerprint: null,
    });
  });
  it("keeps an aborted income source terminal and permits a fresh identical source after restore", async () => {
    const fx = await fixture();
    const before = await state(fx);
    const initialPlan = await preview(fx);
    await apply(fx, initialPlan);
    await rollbackBatch(fx.fresh);
    const restored = await state(fx);
    expect(restored.transactions).toEqual(before.transactions);
    await expect(preview(fx)).rejects.toThrow(/aborted|review/i);
    await expect(apply(fx, initialPlan)).rejects.toThrow(/aborted|review/i);
    expect(await state(fx)).toEqual(restored);
    const copy = { ...fx, fresh: await stage(fx.account, fx.investment) };
    const plan = await preview(copy);
    expect(plan).toMatchObject({ ready: true, summary: { record_income: 1 } });
    expect(await apply(copy, plan)).toMatchObject({
      recordedIncome: 1,
      imported: 1,
    });
    const rerun = await state(copy);
    expect(rerun.transactions[0]).toEqual(before.transactions[0]);
    expect(rerun.oldJournal).toEqual(before.oldJournal);
    expect(rerun.journal.map((row) => row.action)).toEqual([
      "record",
      "restore",
      "record",
    ]);
    await rollbackBatch(copy.fresh);
    const final = await state(copy);
    expect(final.transactions).toEqual(before.transactions);
    expect(final.journal.map((row) => row.action)).toEqual([
      "record",
      "restore",
      "record",
      "restore",
    ]);
    expect(final.oldJournal).toEqual(before.oldJournal);
  });
  it("backfills a stale prior quote from the real batched provider resolver, defers misses and rejects changed rate fingerprints", async () => {
    const fx = await fixture();
    await pool.query(
      "INSERT INTO exchange_rates(currency_code,rate_date,rate_to_eur) VALUES('USD','2025-12-26',0.1)",
    );
    historicalWarm.available = false;
    const missing = await preview(fx);
    expect(missing).toMatchObject({
      ready: true,
      summary: { record_income: 0 },
      pending: 12,
    });
    const deferredBefore = await state(fx);
    expect(await apply(fx, missing)).toMatchObject({
      imported: 0,
      recordedIncome: 0,
      pending: 12,
    });
    const deferredAfter = await state(fx);
    for (const key of ["transactions", "staging", "journal", "oldJournal"])
      expect(deferredAfter[key]).toEqual(deferredBefore[key]);
    historicalWarm.available = true;
    clearHistoricalCache();
    const plan = await preview(fx);
    expect(plan).toMatchObject({ ready: true, summary: { record_income: 1 } });
    expect(
      (
        await pool.query(
          "SELECT rate_to_eur FROM exchange_rates WHERE currency_code='USD' AND rate_date='2026-01-04'",
        )
      ).rows,
    ).toHaveLength(1);
    await pool.query(
      "UPDATE exchange_rates SET rate_to_eur=0.9 WHERE currency_code='USD' AND rate_date='2026-01-04'",
    );
    const before = await state(fx);
    await expect(apply(fx, plan)).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    expect(await state(fx)).toEqual(before);
    await apply(fx, await preview(fx));
    expect((await state(fx)).transactions[1].data.fx_rate_to_eur).toBeNull();
  });
  it.each(["note", "source", "source_context"])(
    "rejects stale %s fingerprints atomically",
    async (kind) => {
      const fx = await fixture();
      const plan = await preview(fx);
      if (kind === "note")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Changed' WHERE id=$1",
          [fx.unitId],
        );
      if (kind === "source")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET amount=999 WHERE batch_id=$1 AND type='dividend'",
          [fx.fresh],
        );
      if (kind === "source_context")
        await pool.query(
          "UPDATE portfolio_import_batches SET custom_config=jsonb_set(custom_config,'{kinesis_source_context,source_file_hash}',to_jsonb(repeat('f',64))) WHERE id=$1",
          [fx.prior],
        );
      const before = await state(fx);
      await expect(apply(fx, plan)).rejects.toMatchObject({
        details: { reason: "stale_reconciliation_plan" },
      });
      expect(await state(fx)).toEqual(before);
    },
  );
  it("rolls back a runtime receipt failure with no canonical/staging/counter changes", async () => {
    const fx = await fixture();
    const plan = await preview(fx);
    const before = await state(fx);
    await pool.query(
      "CREATE FUNCTION income_pair_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected pair failure'; END $$; CREATE TRIGGER income_pair_test_failure BEFORE INSERT ON portfolio_import_income_recognition_journal FOR EACH ROW EXECUTE FUNCTION income_pair_test_failure()",
    );
    await expect(apply(fx, plan)).rejects.toThrow(/Injected pair failure/);
    expect(await state(fx)).toEqual(before);
  });
  it("prevents full zero-basis source drain from creating an ordinary dividend", async () => {
    const fx = await fixture();
    const before = await state(fx);
    await expect(commit({ batchId: fx.fresh })).rejects.toMatchObject({
      details: { reason: "paired_income_review_required" },
    });
    expect(await state(fx)).toEqual(before);
  });
  it("rejects manual role setters and unreceipted SQL roles", async () => {
    const fx = await fixture();
    await expect(
      portfolioTransactionService.update(fx.unitId, {
        income_recognition_role: "standard",
      }),
    ).rejects.toThrow(/read-only/);
    await expect(
      pool.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,income_recognition_role) VALUES($1,'dividend','2026-01-01',1,'EUR','included_in_units')",
        [fx.investment],
      ),
    ).rejects.toThrow(/proved active pair/);
    await expect(
      pool.query(
        "UPDATE portfolio_transactions SET income_recognition_role='included_in_units' WHERE id=$1",
        [fx.unitId],
      ),
    ).rejects.toThrow(/ck_portfolio_income/);
  });
});
