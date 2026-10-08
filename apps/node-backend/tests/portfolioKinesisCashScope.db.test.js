import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  getTestPool,
  hasTestDatabase,
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  closeTestPool,
} from "./setup/db.js";
import { cashSource } from "./helpers/kinesisCashScope.js";
import { closePool } from "../src/database/connection.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
import { readReconciliationSources } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { __CASH_SNAPSHOT_SQL as CASH_SNAPSHOT_SQL } from "../src/repositories/portfolioImportCashRepository.ts";
import { cashReceipt } from "../src/services/portfolioKinesisCashScope.ts";
import { reconcileTransfers } from "../src/services/transferReconciliationService.ts";
import { commitBatch } from "../src/services/portfolioImportPipeline/commit.ts";
import { pruneOldImportBatches } from "../src/startup/warmup.ts";
const warming = vi.hoisted(() => ({ available: true, calls: [] }));
const refreshCash = vi.hoisted(() => vi.fn());
vi.mock("../src/services/materializedViewService.ts", async (original) => ({
  ...(await original()),
  scheduleRefresh: refreshCash,
}));
vi.mock("../src/services/currency/rateFetcher.ts", async (original) => {
  const real = await original();
  return {
    ...real,
    getUnindexedRatesToEurForDates: async (missing) => {
      warming.calls.push(
        [...missing].map(([currency, dates]) => ({ currency, dates })),
      );
      if (warming.available) {
        const { query } = await import("../src/database/connection.ts");
        for (const [currency, dates] of missing)
          for (const date of dates)
            await query(
              "INSERT INTO exchange_rates(currency_code,rate_date,rate_to_eur) VALUES($1,$2,0.8) ON CONFLICT(currency_code,rate_date) DO UPDATE SET rate_to_eur=excluded.rate_to_eur",
              [currency, date],
            );
        real.clearHistoricalCache();
      }
      return new Map();
    },
  };
});
import { clearHistoricalCache } from "../src/services/currency/rateFetcher.ts";
const pool = getTestPool();
const owned = { batches: [], accounts: [], investments: [] };
async function stage(account, investment) {
  const source = await cashSource({ account, investment });
  const batch = Number(
    (
      await pool.query(
        "INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage) VALUES('kinesis_transaction_history',$1,'awaiting_review',$2,$3,true) RETURNING id",
        [
          JSON.stringify(source.batches[0].custom_config),
          source.rows.length,
          account,
        ],
      )
    ).rows[0].id,
  );
  owned.batches.push(batch);
  const fields = [
    "row_index",
    "status",
    "tx_date",
    "type_raw",
    "type",
    "route",
    "symbol_raw",
    "name_raw",
    "units",
    "price_per_unit",
    "amount",
    "fees",
    "taxes",
    "currency",
    "raw_data",
    "source_record_hash",
    "source_transaction_id",
    "source_account_identity",
    "dedup_fingerprint",
    "dedup_fingerprint_version",
    "dedup_occurrence",
    "note",
    "asset_adjustment_details",
  ];
  for (const row of source.rows)
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,resolved_investment_id,${fields.join(",")}) VALUES(${Array.from({ length: fields.length + 2 }, (_, index) => `$${index + 1}`).join(",")})`,
      [batch, row.investment_id, ...fields.map((field) => row[field])],
    );
  return batch;
}
async function fixture() {
  const account = (
    await pool.query(
      "INSERT INTO accounts(name,type,currency) VALUES('Synthetic cash broker','brokerage','EUR') RETURNING id",
    )
  ).rows[0].id;
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Synthetic cash asset','KAU','metals','EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  await pool.query(
    "INSERT INTO portfolio_transactions(investment_id,type,date,units,amount,price_per_unit,fees,taxes,currency,note) VALUES($1,'gift','2025-01-01',0.5,0,NULL,0,0,'EUR','Old manual canary')",
    [investment],
  );
  return { account, investment, batch: await stage(account, investment) };
}
const preview = (fx) =>
  previewPortfolioImportReconciliation({
    batchIds: [fx.batch],
    adoptPolicy: "preserve_existing",
    reconciliationScope: "record_cash_only",
    cashFundingPolicy: "own_account_transfer",
  });
const apply = (fx, plan) =>
  commitReviewedPortfolioImports({
    batchIds: [fx.batch],
    adoptPolicy: "preserve_existing",
    reconciliationScope: "record_cash_only",
    cashFundingPolicy: "own_account_transfer",
    expectedPlanFingerprint: plan.planFingerprint,
  });
async function ledger(account) {
  return (
    await pool.query(
      `SELECT ${CASH_SNAPSHOT_SQL} AS data FROM transactions t WHERE account_id=$1 ORDER BY id`,
      [account],
    )
  ).rows.map((row) => row.data);
}
async function state(fx) {
  const result = { cash: await ledger(fx.account) };
  for (const table of [
    "portfolio_transactions",
    "portfolio_asset_transfers",
    "portfolio_asset_adjustments",
    "portfolio_import_reconciliation_journal",
    "portfolio_import_income_recognition_journal",
    "portfolio_import_staging_rows",
    "portfolio_import_batches",
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY id`)
    ).rows;
  return result;
}
async function cleanup() {
  refreshCash.mockClear();
  warming.available = true;
  warming.calls = [];
  clearHistoricalCache();
  await pool.query(
    "DROP TRIGGER IF EXISTS cash_test_failure ON transactions; DROP FUNCTION IF EXISTS cash_test_failure()",
  );
  // Disposable fixture teardown bypasses only the immutable evidence trigger.
  await pool.query(
    "ALTER TABLE portfolio_import_staging_rows DISABLE TRIGGER trg_portfolio_cash_receipt_immutable",
  );
  try {
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
      [owned.batches],
    );
  } finally {
    await pool.query(
      "ALTER TABLE portfolio_import_staging_rows ENABLE TRIGGER trg_portfolio_cash_receipt_immutable",
    );
  }
  await pool.query(
    "DELETE FROM transactions WHERE account_id=ANY($1::integer[])",
    [owned.accounts],
  );
  await pool.query(
    "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::integer[])",
    [owned.investments],
  );
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::integer[])", [
    owned.accounts,
  ]);
  await pool.query("DELETE FROM investments WHERE id=ANY($1::integer[])", [
    owned.investments,
  ]);
  await pool.query(
    "DELETE FROM exchange_rates WHERE currency_code='USD' AND rate_date IN ('2026-01-05','2026-01-06','2025-12-01')",
  );
  owned.batches = [];
  owned.accounts = [];
  owned.investments = [];
}
describe.skipIf(!hasTestDatabase())(
  "source-owned Kinesis cash atomic lifecycle",
  () => {
    beforeAll(acquireDbSuiteLock, 180000);
    afterEach(cleanup);
    afterAll(async () => {
      await releaseDbSuiteLock();
      await closePool();
      await closeTestPool();
    });
    it("records source events separately from fee components with no portfolio, custody or journal writes", async () => {
      const fx = await fixture();
      const before = await state(fx);
      const plan = await preview(fx);
      expect(plan).toMatchObject({
        ready: true,
        pending: 3,
        summary: { cash: 6, insert: 0, adopt: 0, repair_duplicate: 0 },
      });
      const result = await apply(fx, plan);
      expect(refreshCash).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        imported: 7,
        recordedCash: 7,
        adopted: 0,
        repaired: 0,
        pending: 3,
        complete: false,
        batches: [{ imported: 7, recordedCash: 7 }],
      });
      const cash = await ledger(fx.account);
      expect(cash).toHaveLength(7);
      expect(cash.filter((row) => row.is_transfer)).toHaveLength(4);
      expect(cash.filter((row) => !row.is_transfer)).toHaveLength(3);
      expect(
        cash.every(
          (row) =>
            row.transfer_source === "brokerage" &&
            row.transfer_peer_id === null &&
            row.balance === null,
        ),
      ).toBe(true);
      expect(cash.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(0);
      const after = await state(fx);
      for (const table of [
        "portfolio_transactions",
        "portfolio_asset_transfers",
        "portfolio_asset_adjustments",
        "portfolio_import_reconciliation_journal",
        "portfolio_import_income_recognition_journal",
      ])
        expect(after[table]).toEqual(before[table]);
      expect(
        after.portfolio_import_staging_rows.filter(
          (row) => row.data.route !== "cash",
        ),
      ).toEqual(
        before.portfolio_import_staging_rows.filter(
          (row) => row.data.route !== "cash",
        ),
      );
      expect(
        (
          await pool.query(
            "SELECT rows_imported,status,completed_at FROM portfolio_import_batches WHERE id=$1",
            [fx.batch],
          )
        ).rows[0],
      ).toEqual({
        rows_imported: 6,
        status: "awaiting_review",
        completed_at: null,
      });
      await reconcileTransfers();
      expect(await ledger(fx.account)).toEqual(cash);
    });
    it("repeats same/fresh full sources and re-records after guarded rollback with new staging IDs", async () => {
      const fx = await fixture();
      await apply(fx, await preview(fx));
      const first = await ledger(fx.account);
      const repeated = await preview(fx);
      expect(repeated).toMatchObject({
        ready: true,
        summary: { cash: 0, settled: 6 },
      });
      expect(
        repeated.actions.find((action) => action.cashProof.componentCount === 2)
          .existingCashFeeTransactionId,
      ).toBeGreaterThan(0);
      expect(await apply(fx, repeated)).toMatchObject({
        imported: 0,
        recordedCash: 0,
        duplicates: 0,
      });
      const fresh = { ...fx, batch: await stage(fx.account, fx.investment) };
      const duplicate = await preview(fresh);
      expect(duplicate).toMatchObject({
        ready: true,
        summary: { cash: 0, duplicate: 6 },
      });
      expect(await apply(fresh, duplicate)).toMatchObject({
        imported: 0,
        duplicates: 6,
      });
      expect(await ledger(fx.account)).toEqual(first);
      refreshCash.mockClear();
      expect(await rollbackBatch(fx.batch)).toMatchObject({ deleted: 7 });
      expect(await ledger(fx.account)).toEqual([]);
      expect(refreshCash).toHaveBeenCalledOnce();
      await expect(preview(fx)).rejects.toThrow(/reviewable/);
      const restaged = { ...fx, batch: await stage(fx.account, fx.investment) };
      expect(await apply(restaged, await preview(restaged))).toMatchObject({
        imported: 7,
        recordedCash: 7,
      });
      expect(await rollbackBatch(restaged.batch)).toMatchObject({ deleted: 7 });
    });
    it("guards a changed fee or main after-image before deleting any component", async () => {
      const fx = await fixture();
      await apply(fx, await preview(fx));
      const source = (await readReconciliationSources([fx.batch])).find(
        (row) => cashReceipt(row)?.feeAfter,
      );
      const receipt = cashReceipt(source);
      await pool.query(
        "UPDATE transactions SET comment='Changed fee note' WHERE id=$1",
        [receipt.feeAfter.id],
      );
      const before = await state(fx);
      expect(await preview(fx)).toMatchObject({
        ready: false,
        summary: { cash: 0, settled: 0 },
      });
      await expect(rollbackBatch(fx.batch)).rejects.toThrow(/image changed/);
      expect(await state(fx)).toEqual(before);
    });
    it("rejects stale source, ledger and rate fingerprints without writes", async () => {
      const fx = await fixture();
      const plan = await preview(fx);
      await pool.query(
        "UPDATE exchange_rates SET rate_to_eur=0.9 WHERE currency_code='USD' AND rate_date='2026-01-05'",
      );
      clearHistoricalCache();
      const before = await state(fx);
      await expect(apply(fx, plan)).rejects.toThrow(/changed/);
      expect(await state(fx)).toEqual(before);
      const fresh = await preview(fx);
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET note='Tampered primary stage' WHERE batch_id=$1 AND row_index=0",
        [fx.batch],
      );
      const changed = await state(fx);
      await expect(apply(fx, fresh)).rejects.toThrow(/changed/);
      expect(await state(fx)).toEqual(changed);
    });
    it("rolls back every source and both components when the fee insert fails", async () => {
      const fx = await fixture();
      const plan = await preview(fx);
      const before = await state(fx);
      await pool.query(
        "CREATE FUNCTION cash_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.memo LIKE '%withdrawal fee)%' THEN RAISE EXCEPTION 'Injected fee failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER cash_test_failure BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION cash_test_failure()",
      );
      await expect(apply(fx, plan)).rejects.toThrow(/Injected fee failure/);
      expect(await state(fx)).toEqual(before);
      expect(refreshCash).not.toHaveBeenCalled();
    });
    it("defers unavailable rates and warms strict stale misses through the established resolver", async () => {
      const fx = await fixture();
      warming.available = false;
      await pool.query(
        "INSERT INTO exchange_rates(currency_code,rate_date,rate_to_eur) VALUES('USD','2025-12-01',0.1)",
      );
      clearHistoricalCache();
      const before = await state(fx);
      expect(await preview(fx)).toMatchObject({
        ready: true,
        summary: { cash: 0 },
        selectedRowIds: [],
        pending: 9,
      });
      expect(await state(fx)).toEqual(before);
      warming.available = true;
      expect(await preview(fx)).toMatchObject({
        ready: true,
        summary: { cash: 6 },
      });
      expect(
        warming.calls
          .flat()
          .some(
            (item) =>
              item.currency === "USD" && item.dates.includes("2026-01-05"),
          ),
      ).toBe(true);
    });
    it("keeps typed evidence immutable while ordinary staged raw records remain editable", async () => {
      const fx = await fixture();
      await apply(fx, await preview(fx));
      await expect(
        pool.query(
          "UPDATE portfolio_import_staging_rows SET raw_data='Changed' WHERE batch_id=$1 AND route='cash'",
          [fx.batch],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query("DELETE FROM portfolio_import_batches WHERE id=$1", [
          fx.batch,
        ]),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query(
          "UPDATE portfolio_import_staging_rows SET raw_data=raw_data||' ' WHERE batch_id=$1 AND route='portfolio'",
          [fx.batch],
        ),
      ).resolves.toBeDefined();
    });
    it("requires confirmed cash-only review for new full-import cash and permits proved fresh repeats", async () => {
      const fx = await fixture();
      const ids = (await readReconciliationSources([fx.batch]))
        .filter((row) => row.route === "cash")
        .map((row) => Number(row.id));
      const before = await state(fx);
      await expect(
        commitBatch({ batchId: fx.batch, rowIds: ids }),
      ).rejects.toMatchObject({
        details: { reason: "cash_reconciliation_required" },
      });
      expect(await state(fx)).toEqual(before);
      await apply(fx, await preview(fx));
      const cash = await ledger(fx.account);
      const fresh = await stage(fx.account, fx.investment);
      const repeatedIds = (await readReconciliationSources([fresh]))
        .filter((row) => row.route === "cash")
        .map((row) => Number(row.id));
      expect(
        await commitBatch({ batchId: fresh, rowIds: repeatedIds }),
      ).toMatchObject({ imported: 0, duplicates: 6, errors: 0 });
      expect(await ledger(fx.account)).toEqual(cash);
    });
    it("rejects an unrelated account opening balance and a concurrent ledger addition without source writes", async () => {
      const fx = await fixture();
      const plan = await preview(fx);
      const recipient = (
        await pool.query(
          "INSERT INTO recipients(name,normalized_name) VALUES('Synthetic cash anchor','synthetic cash anchor') ON CONFLICT(normalized_name) DO UPDATE SET normalized_name=excluded.normalized_name RETURNING id",
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO transactions(account_id,recipient_id,date,amount,currency,memo,is_transfer,transfer_source) VALUES($1,$2,'2020-01-01',0.01,'GBP','Unrelated opening',true,'opening')",
        [fx.account, recipient],
      );
      const before = await state(fx);
      expect(await preview(fx)).toMatchObject({
        ready: false,
        summary: { cash: 0 },
      });
      await expect(apply(fx, plan)).rejects.toThrow(/changed|blocked/);
      expect(await state(fx)).toEqual(before);
    });
    it("retains terminal and rolled-back typed cash proofs while pruning unrelated old imports", async () => {
      const fx = await fixture();
      await apply(fx, await preview(fx));
      const ordinary = Number(
        (
          await pool.query(
            "INSERT INTO portfolio_import_batches(adapter_name,status,started_at) VALUES('synthetic_prune','complete',now()-interval '40 days') RETURNING id",
          )
        ).rows[0].id,
      );
      owned.batches.push(ordinary);
      await pool.query(
        "UPDATE portfolio_import_batches SET status='complete',started_at=now()-interval '40 days' WHERE id=$1",
        [fx.batch],
      );
      await pruneOldImportBatches();
      expect(
        (
          await pool.query(
            "SELECT id FROM portfolio_import_batches WHERE id=ANY($1::bigint[]) ORDER BY id",
            [[fx.batch, ordinary]],
          )
        ).rows,
      ).toEqual([{ id: fx.batch.toString() }]);
      expect(await rollbackBatch(fx.batch)).toMatchObject({ deleted: 7 });
      const sources = await readReconciliationSources([fx.batch]);
      await pruneOldImportBatches();
      expect(await readReconciliationSources([fx.batch])).toEqual(sources);
    });
    it("rejects a statement anchor inserted after preview without changing its reading or staged source", async () => {
      const fx = await fixture();
      const plan = await preview(fx);
      await pool.query(
        "INSERT INTO account_statement_balances(account_id,currency,balance,balance_date) VALUES($1,'EUR',0,'2020-01-01')",
        [fx.account],
      );
      const before = await state(fx);
      expect(await preview(fx)).toMatchObject({
        ready: false,
        summary: { cash: 0 },
        selectedRowIds: [],
      });
      await expect(apply(fx, plan)).rejects.toThrow(/changed|blocked/);
      expect(await state(fx)).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT balance::text AS balance FROM account_statement_balances WHERE account_id=$1",
            [fx.account],
          )
        ).rows,
      ).toEqual([{ balance: "0.0000" }]);
    });
  },
);
