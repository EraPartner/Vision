import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool, withTransaction } from "../src/database/connection.js";
import {
  getRowsForPortfolioMath,
  getUnitEventsForInvestment,
} from "../src/repositories/portfolioTxRepo.reads.js";
import {
  commitPortfolioAssetTransfer,
  rollbackPortfolioAssetTransfersForBatch,
} from "../src/services/portfolio/portfolioAssetTransferService.js";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.js";
import { buildInvestmentSummaryCorePartitioned } from "@vision/shared-utils/portfolio";
import { stageBatch } from "../src/services/portfolioImportPipeline/stage.js";
import { validateBatch } from "../src/services/portfolioImportPipeline/validate.js";
import { matchBatch } from "../src/services/portfolioImportPipeline/matchInvestments.js";

const pool = getTestPool();
const ids = { investments: [], accounts: [], batches: [] };
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function seed() {
  const accounts = (
    await pool.query(
      "INSERT INTO accounts(name,type) VALUES ('CUSTODY SOURCE','crypto_exchange'),('CUSTODY DESTINATION','wallet') RETURNING id",
    )
  ).rows.map((r) => r.id);
  ids.accounts.push(...accounts);
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Synthetic custody coin','CUSTODYTEST','crypto','EUR') RETURNING id",
    )
  ).rows[0].id;
  ids.investments.push(investment);
  const acquisition = await portfolioTransactionService.create({
    investment_id: investment,
    account_id: accounts[0],
    type: "buy",
    date: "2020-01-01",
    units: 10,
    amount: 100,
    price_per_unit: 10,
    fees: 0,
    taxes: 0,
    currency: "EUR",
  });
  return {
    source: accounts[0],
    destination: accounts[1],
    investment,
    acquisition,
  };
}
async function stage(
  position,
  {
    units = "5",
    fee = "1",
    date = "2020-02-01",
    identity = "synthetic-source",
  } = {},
) {
  const batch = (
    await pool.query(
      "INSERT INTO portfolio_import_batches(adapter_name,status,account_id,custom_config) VALUES ('kinesis_transaction_history','awaiting_review',$1,$2::jsonb) RETURNING id",
      [
        position.source,
        JSON.stringify({
          transfer_destination_account_id: position.destination,
        }),
      ],
    )
  ).rows[0];
  ids.batches.push(batch.id);
  const row = (
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,resolved_investment_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details)
    VALUES ($1,0,'matched',$2,'AssetTransfer','asset_transfer',$3,0,$4,$5,$6,1,$7::json) RETURNING *,to_char(tx_date,'YYYY-MM-DD') AS tx_date`,
      [
        batch.id,
        date,
        units,
        position.investment,
        digest(identity),
        digest(`dedup:${identity}`),
        JSON.stringify({
          direction: "out",
          basisStatus: "carried",
          feeUnits: fee,
        }),
      ],
    )
  ).rows[0];
  return {
    row,
    batch: {
      ...batch,
      account_id: position.source,
      custom_config: { transfer_destination_account_id: position.destination },
    },
  };
}
async function transferCount() {
  return Number(
    (
      await pool.query(
        "SELECT count(*) FROM portfolio_asset_transfers WHERE investment_id=ANY($1::int[])",
        [ids.investments],
      )
    ).rows[0].count,
  );
}

describe.skipIf(!hasTestDatabase())(
  "canonical dated asset transfers (real Postgres)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180000);
    afterEach(async () => {
      await pool.query(
        "DELETE FROM portfolio_asset_transfers WHERE investment_id=ANY($1::int[])",
        [ids.investments],
      );
      await pool.query(
        "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::int[])",
        [ids.investments],
      );
      await pool.query(
        "DELETE FROM portfolio_import_staging_rows WHERE batch_id=ANY($1::bigint[])",
        [ids.batches],
      );
      await pool.query(
        "DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
        [ids.batches],
      );
      await pool.query("DELETE FROM investments WHERE id=ANY($1::int[])", [
        ids.investments,
      ]);
      await pool.query("DELETE FROM accounts WHERE id=ANY($1::int[])", [
        ids.accounts,
      ]);
      ids.investments.length = ids.accounts.length = ids.batches.length = 0;
    });
    afterAll(async () => {
      await releaseDbSuiteLock();
      await closePool();
      await closeTestPool();
    });

    it("stores one immutable event, reimports once, and creates no cash or trade legs", async () => {
      const position = await seed(),
        input = await stage(position);
      const cashBefore = Number(
        (
          await pool.query(
            "SELECT count(*) FROM transactions WHERE account_id=ANY($1::int[])",
            [[position.source, position.destination]],
          )
        ).rows[0].count,
      );
      const first = await commitPortfolioAssetTransfer(input);
      expect(first.duplicate).toBe(false);
      const second = await commitPortfolioAssetTransfer(await stage(position));
      expect(second).toEqual({ ...first, duplicate: true });
      expect(await transferCount()).toBe(1);
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM portfolio_transactions WHERE investment_id=$1",
              [position.investment],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM transactions WHERE account_id=ANY($1::int[])",
              [[position.source, position.destination]],
            )
          ).rows[0].count,
        ),
      ).toBe(cashBefore);
      await expect(
        pool.query("UPDATE portfolio_asset_transfers SET units=4 WHERE id=$1", [
          first.id,
        ]),
      ).rejects.toThrow(/immutable/);
      const receipt = (
        await pool.query(
          "SELECT fee_basis_allocations FROM portfolio_asset_transfers WHERE id=$1",
          [first.id],
        )
      ).rows[0].fee_basis_allocations;
      for (const method of ["weighted_avg", "fifo", "lifo"])
        expect(receipt[method].lots).toEqual([
          expect.objectContaining({
            acquisitionId: position.acquisition.id,
            acquisitionDate: "2020-01-01",
            currency: "EUR",
            units: "1",
            nativeBasis: "10",
            eurBasis: "10",
          }),
        ]);
    });
    it("stages, validates, matches and commits a literal withdrawal without manual row mapping", async () => {
      const position = await seed(),
        input = await stage(position);
      await pool.query(
        "DELETE FROM portfolio_import_staging_rows WHERE batch_id=$1",
        [input.batch.id],
      );
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "vision-custody-pipeline-"),
      );
      try {
        const header = (
          await readFile(
            new URL(
              "fixtures/portfolio/kinesis-transaction-history.csv",
              import.meta.url,
            ),
            "utf8",
          )
        ).split("\n")[0];
        const literal =
          "2020-02-01 10:00:00 UTC,SYNTHETIC,CUSTODYTEST,Withdrawal,SYNTHETIC-OUT,,,4,,,1,CUSTODYTEST,,,10,CUSTODYTEST,5,CUSTODYTEST";
        const file = path.join(directory, "history.csv");
        await writeFile(file, `${header}\n${literal}\n`);
        const config = {
          format: "kinesis_transaction_history",
          transfer_destination_account_id: position.destination,
        };
        await pool.query(
          "UPDATE portfolio_import_batches SET custom_config=$2::jsonb,default_asset_class='crypto',is_brokerage=true WHERE id=$1",
          [input.batch.id, JSON.stringify(config)],
        );
        expect(
          await stageBatch({
            batchId: input.batch.id,
            filePath: file,
            customConfig: config,
          }),
        ).toMatchObject({ rowsTotal: 1, rowsSkipped: 0 });
        expect(await validateBatch({ batchId: input.batch.id })).toMatchObject({
          validated: 1,
          errors: 0,
        });
        expect(await matchBatch({ batchId: input.batch.id })).toMatchObject({
          unresolved: 0,
          total: 1,
        });
        const row = (
          await pool.query(
            "SELECT *,to_char(tx_date,'YYYY-MM-DD') AS tx_date FROM portfolio_import_staging_rows WHERE batch_id=$1",
            [input.batch.id],
          )
        ).rows[0];
        expect(row).toMatchObject({
          status: "matched",
          route: "asset_transfer",
          type: null,
          raw_data: literal,
          resolved_investment_id: position.investment,
        });
        expect(row.asset_transfer_details).toMatchObject({
          feeUnits: "1",
          receivedUnits: "4",
        });
        expect(
          (await commitPortfolioAssetTransfer({ row, batch: input.batch }))
            .duplicate,
        ).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    it.each(["weighted_avg", "fifo", "lifo"])(
      "summary replay reads canonical custody and original basis under %s",
      async (method) => {
        const position = await seed();
        await commitPortfolioAssetTransfer(await stage(position));
        const history = await getUnitEventsForInvestment(position.investment);
        expect(history.map((r) => r.type)).toEqual(["buy", "asset_transfer"]);
        const result = buildInvestmentSummaryCorePartitioned(
          { asset_class: "crypto", current_price: 20 },
          history,
          { costBasisMethod: method, todayYmd: "2020-02-02" },
        );
        expect(result.core.totalUnits.toNumber()).toBe(9);
        expect(result.core.totalInvested.toNumber()).toBe(90);
        expect(
          result.partitions
            .find((p) => p.accountId === position.destination)
            .core.totalUnits.toNumber(),
        ).toBe(4);
        const mathRows = await getRowsForPortfolioMath();
        expect(
          mathRows.filter(
            (r) =>
              Number(r.investment_id) === position.investment &&
              r.type === "asset_transfer",
          ),
        ).toHaveLength(1);
      },
    );
    it("rolls back all writes when the outer transaction fails", async () => {
      const position = await seed(),
        input = await stage(position);
      await expect(
        withTransaction(async () => {
          await commitPortfolioAssetTransfer(input);
          throw new Error("synthetic outer failure");
        }),
      ).rejects.toThrow(/outer failure/);
      expect(await transferCount()).toBe(0);
    });
    it("imports a partial return from its origin lots without creating new acquisition basis", async () => {
      const position = await seed();
      await pool.query("UPDATE investments SET symbol='CUSTODY' WHERE id=$1", [
        position.investment,
      ]);
      const outgoing = await stage(position);
      await commitPortfolioAssetTransfer(outgoing);
      const incoming = await stage(position, {
        units: "3",
        fee: "0",
        date: "2020-03-01",
        identity: "synthetic-return",
      });
      await pool.query(
        "DELETE FROM portfolio_import_staging_rows WHERE batch_id=$1",
        [incoming.batch.id],
      );
      const config = {
        format: "nexo_transaction_history",
        transfer_origin_account_id: position.destination,
        transfer_destination_account_id: position.destination,
      };
      await pool.query(
        "UPDATE portfolio_import_batches SET adapter_name='nexo_transaction_history',custom_config=$2::jsonb,default_asset_class='crypto',is_brokerage=true WHERE id=$1",
        [incoming.batch.id, JSON.stringify(config)],
      );
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "vision-custody-return-"),
      );
      try {
        const header =
          "Transaction,Type,Input Currency,Input Amount,Output Currency,Output Amount,USD Equivalent,Fee,Fee Currency,Details,Date / Time (UTC)";
        const literal =
          "SYNTHETIC-RETURN,Top up Crypto,CUSTODY,3,CUSTODY,3,999,-,-,approved / synthetic return,2020-03-01 10:00:00";
        const file = path.join(directory, "history.csv");
        await writeFile(file, `${header}\n${literal}\n`);
        expect(
          await stageBatch({
            batchId: incoming.batch.id,
            filePath: file,
            customConfig: config,
          }),
        ).toMatchObject({ rowsTotal: 1, rowsSkipped: 0 });
        expect(
          await validateBatch({ batchId: incoming.batch.id }),
        ).toMatchObject({ validated: 1, errors: 0 });
        expect(await matchBatch({ batchId: incoming.batch.id })).toMatchObject({
          unresolved: 0,
          total: 1,
        });
        const row = (
          await pool.query(
            "SELECT *,to_char(tx_date,'YYYY-MM-DD') AS tx_date FROM portfolio_import_staging_rows WHERE batch_id=$1",
            [incoming.batch.id],
          )
        ).rows[0];
        expect(row).toMatchObject({
          route: "asset_transfer",
          type: null,
          raw_data: literal,
          asset_transfer_details: { direction: "in", basisStatus: "carried" },
        });
        await commitPortfolioAssetTransfer({
          row,
          batch: { ...incoming.batch, custom_config: config },
        });
        const history = await getUnitEventsForInvestment(position.investment);
        for (const costBasisMethod of ["weighted_avg", "fifo", "lifo"]) {
          const result = buildInvestmentSummaryCorePartitioned(
            { asset_class: "crypto", current_price: 20 },
            history,
            { costBasisMethod, todayYmd: "2020-03-02" },
          );
          expect(result.core.totalUnits.toNumber()).toBe(9);
          expect(result.core.totalInvested.toNumber()).toBe(90);
          expect(result.core.totalBuyCost.toNumber()).toBe(100);
          expect(
            result.partitions
              .find((p) => p.accountId === position.source)
              .core.totalUnits.toNumber(),
          ).toBe(8);
          expect(
            result.partitions
              .find((p) => p.accountId === position.destination)
              .core.totalUnits.toNumber(),
          ).toBe(1);
        }
        await expect(
          rollbackPortfolioAssetTransfersForBatch(outgoing.batch.id),
        ).rejects.toThrow(/exceeds source/);
        expect(await transferCount()).toBe(2);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    it("rejects unassigned manual acquisitions after custody events without changing holdings", async () => {
      const position = await seed();
      await commitPortfolioAssetTransfer(await stage(position));
      for (const type of ["buy", "gift"])
        await expect(
          portfolioTransactionService.create({
            investment_id: position.investment,
            type,
            date: "2020-03-01",
            units: 1,
            amount: 10,
            price_per_unit: 10,
            currency: "EUR",
          }),
        ).rejects.toThrow(/must name their custody account/);
      await expect(
        portfolioTransactionService.update(position.acquisition.id, {
          account_id: null,
        }),
      ).rejects.toThrow(/must name their custody account/);
      expect(
        (await getUnitEventsForInvestment(position.investment)).map(
          (row) => row.type,
        ),
      ).toEqual(["buy", "asset_transfer"]);
    });
    it("rejects source deficits and destination identity reuse atomically", async () => {
      const position = await seed();
      await expect(
        commitPortfolioAssetTransfer(await stage(position, { units: "11" })),
      ).rejects.toThrow(/exceeds source/);
      expect(await transferCount()).toBe(0);
      const input = await stage(position, { identity: "valid" });
      await commitPortfolioAssetTransfer(input);
      await expect(
        commitPortfolioAssetTransfer({
          ...input,
          row: { ...input.row, units: "6" },
        }),
      ).rejects.toThrow(/identity conflicts/);
      expect(await transferCount()).toBe(1);
    });
    it("protects original acquisitions and rejects rollback with a later destination sale", async () => {
      const position = await seed(),
        input = await stage(position);
      await commitPortfolioAssetTransfer(input);
      await expect(
        portfolioTransactionService.remove(position.acquisition.id),
      ).rejects.toThrow(/exceeds source/);
      await portfolioTransactionService.create({
        investment_id: position.investment,
        account_id: position.destination,
        type: "sell",
        date: "2020-03-01",
        units: 4,
        amount: 80,
        price_per_unit: 20,
        currency: "EUR",
      });
      await expect(
        rollbackPortfolioAssetTransfersForBatch(input.batch.id),
      ).rejects.toThrow(/downstream/);
      expect(await transferCount()).toBe(1);
    });
    it("removes the complete event when downstream history remains valid", async () => {
      const position = await seed(),
        input = await stage(position);
      await commitPortfolioAssetTransfer(input);
      expect(
        await rollbackPortfolioAssetTransfersForBatch(input.batch.id),
      ).toBe(1);
      expect(await transferCount()).toBe(0);
      const history = await getUnitEventsForInvestment(position.investment);
      expect(history).toHaveLength(1);
      expect(Number(history[0].units)).toBe(10);
    });
    it("validates a concurrent sale against the committed custody state", async () => {
      const position = await seed(),
        input = await stage(position, { units: "9", fee: "0" });
      let release, entered;
      const paused = new Promise((resolve) => {
        release = resolve;
      });
      const acquired = new Promise((resolve) => {
        entered = resolve;
      });
      const committing = withTransaction(async () => {
        await commitPortfolioAssetTransfer(input);
        entered();
        await paused;
      });
      await acquired;
      const sale = portfolioTransactionService
        .create({
          investment_id: position.investment,
          account_id: position.source,
          type: "sell",
          date: "2020-03-01",
          units: 2,
          amount: 20,
          price_per_unit: 10,
          currency: "EUR",
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      release();
      await committing;
      const outcome = await sale;
      expect(outcome.error?.message).toContain(
        "sell units exceed available holdings",
      );
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM portfolio_transactions WHERE investment_id=$1 AND type='sell'",
              [position.investment],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
    });
    it.skipIf(process.env.VISION_TEST_DB_ISOLATED !== "1")(
      "executes guarded downgrade and upgrade on the disposable cluster",
      async () => {
        const position = await seed(),
          input = await stage(position);
        await commitPortfolioAssetTransfer(input);
        const root = path.resolve(import.meta.dirname, "../../..");
        const migrate = (operation, target) =>
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
          "0120_portfolio_import_reconciliation",
        );
        expect(refused.status).not.toBe(0);
        expect(`${refused.stdout}${refused.stderr}`).toContain(
          "Roll back their imports before downgrade",
        );
        // Alembic commits each preceding downgrade before a guarded older step.
        expect(migrate("upgrade", "head").status).toBe(0);
        expect(await transferCount()).toBe(1);
        await rollbackPortfolioAssetTransfersForBatch(input.batch.id);
        try {
          const downgraded = migrate(
            "downgrade",
            "0120_portfolio_import_reconciliation",
          );
          expect(downgraded.status).toBe(0);
          expect(
            (
              await pool.query(
                "SELECT to_regclass('public.portfolio_asset_transfers') AS relation",
              )
            ).rows[0].relation,
          ).toBeNull();
        } finally {
          const upgraded = migrate("upgrade", "head");
          expect(upgraded.status).toBe(0);
        }
        expect(
          (
            await pool.query(
              "SELECT to_regclass('public.portfolio_asset_transfers') AS relation",
            )
          ).rows[0].relation,
        ).toBe("portfolio_asset_transfers");
      },
      90000,
    );
  },
);
