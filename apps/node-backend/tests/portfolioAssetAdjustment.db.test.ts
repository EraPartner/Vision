import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  getTestPool,
  hasTestDatabase,
  closeTestPool,
} from "./setup/db.ts";
import { closePool, withTransaction } from "../src/database/connection.ts";
import transactionService from "../src/services/portfolio/portfolioTransactionService.ts";
import { stageBatch } from "../src/services/portfolioImportPipeline/stage.ts";
import { validateBatch } from "../src/services/portfolioImportPipeline/validate.ts";
import { matchBatch } from "../src/services/portfolioImportPipeline/matchInvestments.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
import { commitPortfolioAssetTransfer } from "../src/services/portfolio/portfolioAssetTransferService.ts";
import { toDecimal } from "../src/lib/money.ts";
import { commitPortfolioAssetAdjustment } from "../src/services/portfolio/portfolioAssetAdjustmentService.ts";
import { getUnitEventsForInvestment } from "../src/repositories/portfolioTxRepo.reads.ts";
import { buildInvestmentSummaryCorePartitioned } from "@vision/shared-utils/portfolio";
import { asPartitionedTxns } from "../src/services/portfolio/portfolioTransactionRules.ts";

const pool = getTestPool()!,
  owned: { accounts: number[]; investments: number[]; batches: number[] } = {
    accounts: [],
    investments: [],
    batches: [],
  };
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function seed() {
  const accounts = (
    await pool.query(
      "INSERT INTO accounts(name,type) VALUES ('ADJUSTMENT BROKER','crypto_exchange'),('ADJUSTMENT WALLET','wallet') RETURNING id",
    )
  ).rows.map((r) => r.id);
  owned.accounts.push(...accounts);
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Synthetic correction coin','REVTEST','crypto','EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.investments.push(investment);
  const buy = (await transactionService.create({
    investment_id: investment,
    account_id: accounts[0],
    type: "buy",
    date: "2020-01-01",
    units: 10,
    amount: 100,
    price_per_unit: 10,
    currency: "USD",
    fx_rate_to_eur: 2,
  }))!;
  return { account: accounts[0], wallet: accounts[1], investment, buy };
}
type Position = Awaited<ReturnType<typeof seed>>;
async function batch(
  position: Position,
  account = position.account,
  config: {
    format: string;
    yield_basis_policy?: string;
    transfer_destination_account_id?: number;
  } = {
    yield_basis_policy: "zero",
    format: "kinesis_transaction_history",
    transfer_destination_account_id: position.wallet,
  },
) {
  const row = (
    await pool.query(
      "INSERT INTO portfolio_import_batches(adapter_name,status,account_id,is_brokerage,default_asset_class,custom_config) VALUES ($1,'awaiting_review',$2,true,'crypto',$3::jsonb) RETURNING *",
      [config.format, account, JSON.stringify(config)],
    )
  ).rows[0];
  owned.batches.push(row.id);
  return row;
}
async function source(
  position: Position,
  {
    negative = 2,
    withdrawal = true,
  }: { negative?: number; withdrawal?: boolean } = {},
) {
  const input = await batch(position),
    directory = await mkdtemp(path.join(os.tmpdir(), "vision-zero-yield-"));
  const header =
    "DateTime,HIN,Currency_Code,Transaction_Type,Transaction_ID,Order_ID,Currency_Pair,Amount,Trade_Price,Total,Fee,Fee_Currency,Trade_Value,Trade_Value_Currency,Starting_Balance,Starting_Balance_Currency,Closing_Balance,Closing_Balance_Currency";
  const rows = [
    "2020-01-02 10:00:00 UTC,SYNTHETIC,REVTEST,Holder's_Distribution_Adjustment,YIELD-IN,,,5,,,,,,,10,REVTEST,15,REVTEST",
    `2020-01-03 10:00:00 UTC,SYNTHETIC,REVTEST,Holder's_Distribution_Adjustment,YIELD-OUT,,,-${negative},,,,,,,15,REVTEST,${15 - negative},REVTEST`,
  ];
  if (withdrawal)
    rows.push(
      "2020-01-04 10:00:00 UTC,SYNTHETIC,REVTEST,Withdrawal,CUSTODY-OUT,,,7,,,1,REVTEST,,,13,REVTEST,5,REVTEST",
    );
  try {
    const file = path.join(directory, "statement.csv");
    await writeFile(file, `${header}\n${rows.join("\n")}\n`);
    await stageBatch({
      batchId: input.id,
      filePath: file,
      customConfig: input.custom_config,
    });
    expect(await validateBatch({ batchId: input.id })).toMatchObject({
      errors: 0,
    });
    expect(await matchBatch({ batchId: input.id })).toMatchObject({
      unresolved: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return input;
}
async function fee(position: Position, units = "1") {
  const input = await batch(position, position.wallet, {
    format: "portfolio_performance_reference",
  });
  const raw =
    "<transaction id='synthetic-fee' type='DELIVERY_OUTBOUND' shares='1'/>";
  const row = (
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_adjustment_details)
    VALUES ($1,0,'matched','2020-02-01','AssetAdjustment','asset_adjustment',$2,0,0,0,$3,$4,$5,$6,1,$7::json) RETURNING *,to_char(tx_date,'YYYY-MM-DD') AS tx_date`,
      [
        input.id,
        units,
        position.investment,
        raw,
        hash(raw),
        hash(`fee:${raw}`),
        JSON.stringify({ kind: "asset_fee", basisPolicy: "carried" }),
      ],
    )
  ).rows[0];
  return { row, batch: input };
}
async function clear() {
  // The suite lock isolates fixture receipts; the native test cluster is disposable.
  await pool.query(
    "TRUNCATE portfolio_import_reconciliation_journal RESTART IDENTITY",
  );
  await pool.query(
    "TRUNCATE portfolio_import_duplicate_repair_journal RESTART IDENTITY",
  );
  await pool.query(
    "DELETE FROM portfolio_asset_adjustments WHERE investment_id=ANY($1::int[])",
    [owned.investments],
  );
  await pool.query(
    "DELETE FROM portfolio_asset_transfers WHERE investment_id=ANY($1::int[])",
    [owned.investments],
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
  owned.accounts.length = owned.investments.length = owned.batches.length = 0;
}
describe.skipIf(!hasTestDatabase())(
  "canonical asset corrections (disposable PostgreSQL)",
  () => {
    beforeAll(acquireDbSuiteLock, 180000);
    afterEach(clear);
    afterAll(async () => {
      await releaseDbSuiteLock();
      await closePool();
      await closeTestPool();
    });
    it("commits an exact remaining wallet fee after weighted allocation through a round trip", async () => {
      const position = await seed();
      await pool.query("DELETE FROM portfolio_transactions WHERE id=$1", [
        position.buy.id,
      ]);
      const units = ["0.12345678", "0.23456789", "0.34567891"];
      for (const [index, quantity] of units.entries())
        await transactionService.create({
          investment_id: position.investment,
          account_id: position.account,
          type: "buy",
          date: `2020-01-0${index + 1}`,
          units: Number(quantity),
          amount: toDecimal(quantity).times(1000).toNumber(),
          price_per_unit: 1000,
          currency: "EUR",
        });
      const transfer = async (
        account: number,
        destination: number,
        quantity: string,
        date: string,
        label: string,
      ) => {
        const input = await batch(position, account, {
          format: "portfolio_performance_reference",
          transfer_destination_account_id: destination,
        });
        const raw = `synthetic precision round trip ${label}`;
        const details = {
          direction: "out",
          basisStatus: "carried",
          feeUnits: "0",
          receivedUnits: quantity,
        };
        const staged = (
          await pool.query(
            "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,symbol_raw,units,amount,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details) VALUES($1,0,'matched',$2,'AssetTransfer','asset_transfer','REVTEST',$3,0,'EUR',$4,$5,$6,$7,1,$8::jsonb) RETURNING *",
            [
              input.id,
              date,
              quantity,
              position.investment,
              raw,
              hash(raw),
              hash(`${raw}:fingerprint`),
              JSON.stringify(details),
            ],
          )
        ).rows[0];
        return commitPortfolioAssetTransfer({
          batch: input,
          row: {
            ...staged,
            tx_date: date,
            account_id: account,
            investment_id: position.investment,
          },
        });
      };
      await transfer(
        position.account,
        position.wallet,
        "0.70370358",
        "2020-01-04",
        "out",
      );
      await transfer(
        position.wallet,
        position.account,
        "0.70360358",
        "2020-01-05",
        "back",
      );
      const adjustment = await commitPortfolioAssetAdjustment(
        await fee(position, "0.00010000"),
      );
      expect(adjustment.duplicate).toBe(false);
      const events = await getUnitEventsForInvestment(position.investment);
      for (const costBasisMethod of ["weighted_avg", "fifo", "lifo"] as const) {
        const summary = buildInvestmentSummaryCorePartitioned(
          { asset_class: "crypto", current_price: 1000 },
          asPartitionedTxns(events),
          { costBasisMethod, todayYmd: "2020-12-31" },
        );
        expect(summary.core.totalUnits.toFixed(8)).toBe("0.70360358");
      }
      const retained = (
        await pool.query(
          "SELECT basis_allocations FROM portfolio_asset_adjustments WHERE id=$1",
          [adjustment.id],
        )
      ).rows[0].basis_allocations;
      expect(Object.keys(retained).sort()).toEqual([
        "fifo",
        "lifo",
        "weighted_avg",
      ]);
    });
    it("adopts an original zero-basis yield ID before reversal and custody replay", async () => {
      const position = await seed();
      const manual = (await transactionService.create({
        investment_id: position.investment,
        type: "gift",
        date: "2020-01-02",
        units: 5,
        amount: 0,
        price_per_unit: 0,
        currency: "EUR",
        note: "Original synthetic yield",
      }))!;
      const input = await source(position);
      const plan = await previewPortfolioImportReconciliation({
        batchIds: [Number(input.id)],
      });
      expect(plan.ready).toBe(true);
      expect(plan.summary).toMatchObject({
        adopt: 1,
        adjustment: 1,
        transfer: 1,
      });
      expect(
        await commitReviewedPortfolioImports({
          batchIds: [Number(input.id)],
          expectedPlanFingerprint: plan.planFingerprint,
        }),
      ).toMatchObject({ imported: 2, adopted: 1, errors: 0 });
      const adjustment = (
        await pool.query(
          "SELECT * FROM portfolio_asset_adjustments WHERE import_batch_id=$1",
          [input.id],
        )
      ).rows[0];
      for (const method of ["weighted_avg", "fifo", "lifo"])
        expect(adjustment.basis_allocations[method].lots).toEqual([
          expect.objectContaining({
            acquisitionId: manual.id,
            units: "2",
            nativeBasis: "0",
            eurBasis: "0",
          }),
        ]);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM portfolio_asset_adjustment_sources WHERE adjustment_id=$1",
            [adjustment.id],
          )
        ).rows[0].count,
      ).toBe("1");
      await expect(
        pool.query(
          "DELETE FROM portfolio_asset_adjustment_sources WHERE adjustment_id=$1",
          [adjustment.id],
        ),
      ).rejects.toThrow(/source receipts are immutable/);
      await expect(
        pool.query(
          "UPDATE portfolio_asset_adjustment_sources SET source_record_hash=$2 WHERE adjustment_id=$1",
          [adjustment.id, hash("changed receipt")],
        ),
      ).rejects.toThrow(/source receipts are immutable/);
      expect(
        (
          await pool.query(
            "SELECT custom_config->'source_columns' AS headers FROM portfolio_import_batches WHERE id=$1",
            [input.id],
          )
        ).rows[0].headers,
      ).toHaveLength(18);
      await expect(
        transactionService.update(manual.id, { amount: 10 }),
      ).rejects.toThrow(/source-proven zero-basis/);
      await expect(
        pool.query(
          "UPDATE portfolio_asset_adjustments SET units=1 WHERE id=$1",
          [adjustment.id],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        pool.query(
          "DELETE FROM portfolio_import_staging_rows WHERE source_record_hash=ANY($1::text[]) AND batch_id=$2",
          [adjustment.eligible_source_record_hashes, input.id],
        ),
      ).rejects.toThrow();
      const events = await getUnitEventsForInvestment(position.investment);
      expect(
        events.filter((r) => r.type === "gift").map((r) => Number(r.id)),
      ).toEqual([manual.id]);
      expect(events.map((r) => r.type)).toEqual([
        "buy",
        "gift",
        "asset_adjustment",
        "asset_transfer",
      ]);
      await rollbackBatch(Number(input.id));
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM portfolio_asset_adjustment_sources WHERE adjustment_id=$1",
            [adjustment.id],
          )
        ).rows[0].count,
      ).toBe("0");
      expect(
        (await getUnitEventsForInvestment(position.investment)).map(
          (r) => r.type,
        ),
      ).toEqual(["buy", "gift"]);
    });
    it("preserves original FX for a proven wallet fee, rejects identity conflicts, and creates no disposal or cash", async () => {
      const position = await seed(),
        input = await source(position);
      const plan = await previewPortfolioImportReconciliation({
        batchIds: [Number(input.id)],
      });
      expect(plan.ready).toBe(true);
      await commitReviewedPortfolioImports({
        batchIds: [Number(input.id)],
        expectedPlanFingerprint: plan.planFingerprint,
      });
      const adjustment = await fee(position),
        first = await commitPortfolioAssetAdjustment(adjustment);
      expect(await commitPortfolioAssetAdjustment(adjustment)).toEqual({
        id: first.id,
        duplicate: true,
      });
      await expect(
        commitPortfolioAssetAdjustment({
          ...adjustment,
          row: { ...adjustment.row, units: "2" },
        }),
      ).rejects.toThrow(/identity conflicts/);
      const receipts = (
        await pool.query(
          "SELECT basis_allocations FROM portfolio_asset_adjustments WHERE id=$1",
          [first.id],
        )
      ).rows[0].basis_allocations;
      for (const method of ["weighted_avg", "fifo", "lifo"])
        for (const lot of receipts[method].lots)
          if (Number(lot.nativeBasis) > 0)
            expect(Number(lot.eurBasis)).toBeCloseTo(
              Number(lot.nativeBasis) * 2,
              8,
            );
      const events = await getUnitEventsForInvestment(position.investment);
      for (const costBasisMethod of ["weighted_avg", "fifo", "lifo"] as const) {
        const core = buildInvestmentSummaryCorePartitioned(
          { asset_class: "crypto", current_price: 20 },
          asPartitionedTxns(events),
          { costBasisMethod, todayYmd: "2020-03-01" },
        ).core;
        expect(core.totalUnits.toNumber()).toBe(11);
        expect(core.totalBuyCost.toNumber()).toBe(100);
        expect(core.totalSellProceeds.toNumber()).toBe(0);
      }
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM transactions WHERE account_id=ANY($1::int[])",
            [[position.account, position.wallet]],
          )
        ).rows[0].count,
      ).toBe("0");
      await expect(rollbackBatch(Number(input.id))).rejects.toThrow(
        /custody history is invalid/,
      );
      await pool.query(
        "UPDATE portfolio_import_batches SET status='complete' WHERE id=$1",
        [adjustment.batch.id],
      );
      await rollbackBatch(Number(adjustment.batch.id));
      await rollbackBatch(Number(input.id));
      expect(
        (await getUnitEventsForInvestment(position.investment)).map(
          (r) => r.type,
        ),
      ).toEqual(["buy"]);
    });
    it("blocks insufficient source-proven yields even when unrelated free gifts cover the quantity", async () => {
      const position = await seed();
      await transactionService.create({
        investment_id: position.investment,
        account_id: position.account,
        type: "gift",
        date: "2020-01-01",
        units: 100,
        amount: 0,
        currency: "EUR",
      });
      const input = await source(position, { negative: 6, withdrawal: false });
      const plan = await previewPortfolioImportReconciliation({
        batchIds: [Number(input.id)],
      });
      expect(plan.ready).toBe(false);
      expect(
        plan.blockers.some((r) => r.reason === "projected_history_conflict"),
      ).toBe(true);
      await expect(
        commitReviewedPortfolioImports({ batchIds: [Number(input.id)] }),
      ).rejects.toThrow(/source-proven zero-basis/);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM portfolio_asset_adjustments WHERE investment_id=$1",
            [position.investment],
          )
        ).rows[0].count,
      ).toBe("0");
    });
    it("rolls back a fee atomically when its caller transaction fails", async () => {
      const position = await seed();
      await transactionService.create({
        investment_id: position.investment,
        account_id: position.wallet,
        type: "buy",
        date: "2020-01-01",
        units: 2,
        amount: 20,
        price_per_unit: 10,
        currency: "EUR",
      });
      const adjustment = await fee(position);
      await expect(
        withTransaction(async () => {
          await commitPortfolioAssetAdjustment(adjustment);
          throw new Error("synthetic failure");
        }),
      ).rejects.toThrow(/synthetic failure/);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM portfolio_asset_adjustments WHERE investment_id=$1",
            [position.investment],
          )
        ).rows[0].count,
      ).toBe("0");
    });
    it.skipIf(process.env.VISION_TEST_DB_ISOLATED !== "1")(
      "guards populated downgrade then performs downgrade and upgrade",
      async () => {
        const position = await seed();
        await transactionService.create({
          investment_id: position.investment,
          account_id: position.wallet,
          type: "buy",
          date: "2020-01-01",
          units: 2,
          amount: 20,
          price_per_unit: 10,
          currency: "EUR",
        });
        const adjustment = await fee(position);
        await commitPortfolioAssetAdjustment(adjustment);
        const root = path.resolve(import.meta.dirname, "../../.."),
          migrate = (operation: string, target: string) =>
            spawnSync(
              process.execPath,
              [
                path.join(root, "apps/node-backend/scripts/db-migrate.js"),
                operation,
                target,
              ],
              { cwd: root, env: process.env, encoding: "utf8", timeout: 30000 },
            );
        const refused = migrate(
          "downgrade",
          "0122_portfolio_import_duplicate_repair",
        );
        expect(refused.status).not.toBe(0);
        expect(`${refused.stdout}${refused.stderr}`).toContain(
          "Roll back their imports before downgrade",
        );
        // Alembic commits each preceding downgrade before a guarded older
        // step, so the refusal at 0123 leaves the shared database without the
        // 0124/0125 schema. Restore head before touching it again; otherwise
        // every later DB suite runs against a partially downgraded database.
        expect(migrate("upgrade", "head").status).toBe(0);
        await pool.query(
          "UPDATE portfolio_import_batches SET status='complete' WHERE id=$1",
          [adjustment.batch.id],
        );
        await rollbackBatch(Number(adjustment.batch.id));
        try {
          expect(
            migrate("downgrade", "0122_portfolio_import_duplicate_repair")
              .status,
          ).toBe(0);
          expect(
            (
              await pool.query(
                "SELECT to_regclass('public.portfolio_asset_adjustments') AS name",
              )
            ).rows[0].name,
          ).toBeNull();
        } finally {
          expect(migrate("upgrade", "head").status).toBe(0);
        }
      },
      90000,
    );
  },
);
