import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool, withTransaction } from "../src/database/connection.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
import {
  commitPortfolioAssetTransfer,
  previewPortfolioAssetTransfer,
  validatePortfolioAssetTransferHistory,
} from "../src/services/portfolio/portfolioAssetTransferService.ts";
import {
  portfolioCustodyWriteHistory,
  withPortfolioCustodyImportScope,
} from "../src/services/portfolio/portfolioCustodyImportScope.ts";
import { getUnitEventsForInvestment } from "../src/repositories/portfolioTxRepo.reads.ts";
import { getPortfolioSummary } from "../src/services/portfolio/portfolioSummaryService.ts";

const pool = getTestPool();
const owned = { accounts: [], investments: [], batches: [] };
const hash = (value) => createHash("sha256").update(value).digest("hex");
let sequence = 0;
async function seed() {
  const accounts = (
    await pool.query(
      "INSERT INTO accounts(name,type) VALUES ('ATOMIC BROKER','brokerage'),('ATOMIC WALLET','wallet') RETURNING id",
    )
  ).rows.map((row) => row.id);
  owned.accounts.push(...accounts);
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Synthetic atomic custody','ATOMICTEST','crypto','EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.investments.push(investment);
  const originals = (
    await pool.query(
      `INSERT INTO portfolio_transactions(investment_id,account_id,type,date,units,amount,price_per_unit,currency,note)
      VALUES ($1,$2,'buy','2020-01-01',10,100,10,'EUR','Original acquisition'),
             ($1,$2,'sell','2022-01-01',8,160,20,'EUR','Original later sale') RETURNING id`,
      [investment, accounts[0]],
    )
  ).rows.map((row) => row.id);
  return { investment, source: accounts[0], wallet: accounts[1], originals };
}
async function stage(
  position,
  {
    includeReturn = true,
    includeFee = true,
    outgoingUnits = "10",
    returnedUnits = "9",
    feeUnits = "1",
  } = {},
) {
  const config = {
    format: "nexo_transaction_history",
    transfer_destination_account_id: position.wallet,
    transfer_origin_account_id: position.wallet,
  };
  const batch = (
    await pool.query(
      `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
      VALUES ('nexo_transaction_history',$1::jsonb,'awaiting_review',$2,$3,true) RETURNING *`,
      [
        JSON.stringify(config),
        1 + Number(includeReturn) + Number(includeFee),
        position.source,
      ],
    )
  ).rows[0];
  batch.id = Number(batch.id);
  batch.custom_config = config;
  owned.batches.push(batch.id);
  const inputs = [
    {
      date: "2021-01-01",
      route: "asset_transfer",
      units: outgoingUnits,
      transfer: {
        direction: "out",
        basisStatus: "carried",
        feeUnits: "0",
        receivedUnits: outgoingUnits,
      },
    },
  ];
  if (includeReturn)
    inputs.push({
      date: "2021-06-01",
      route: "asset_transfer",
      units: returnedUnits,
      transfer: {
        direction: "in",
        basisStatus: "carried",
        feeUnits: "0",
        receivedUnits: returnedUnits,
      },
    });
  if (includeFee)
    inputs.push({
      date: "2021-06-01",
      route: "asset_adjustment",
      units: feeUnits,
      adjustment: {
        kind: "asset_fee",
        basisPolicy: "carried",
        accountId: position.wallet,
      },
    });
  const rows = [];
  for (const [index, input] of inputs.entries()) {
    const identity = `atomic-custody-${++sequence}`;
    rows.push(
      (
        await pool.query(
          `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details,asset_adjustment_details)
      VALUES ($1,$2,'matched',$3,$4,$5,$6,0,0,0,'EUR',$7,$8,$9,$10,1,$11::jsonb,$12::jsonb)
      RETURNING *,to_char(tx_date,'YYYY-MM-DD') AS tx_date`,
          [
            batch.id,
            index,
            input.date,
            input.route === "asset_transfer"
              ? "AssetTransfer"
              : "AssetAdjustment",
            input.route,
            input.units,
            position.investment,
            identity,
            hash(identity),
            hash(`identity:${identity}`),
            input.transfer ? JSON.stringify(input.transfer) : null,
            input.adjustment ? JSON.stringify(input.adjustment) : null,
          ],
        )
      ).rows[0],
    );
  }
  return { batch, rows };
}
const countEvents = async (position) =>
  Number(
    (
      await pool.query(
        `SELECT
  (SELECT count(*) FROM portfolio_asset_transfers WHERE investment_id=$1) +
  (SELECT count(*) FROM portfolio_asset_adjustments WHERE investment_id=$1) AS n`,
        [position.investment],
      )
    ).rows[0].n,
  );
async function cleanup() {
  for (const table of [
    "portfolio_asset_adjustments",
    "portfolio_asset_transfers",
    "portfolio_transactions",
  ])
    await pool.query(
      `DELETE FROM ${table} WHERE investment_id=ANY($1::int[])`,
      [owned.investments],
    );
  await pool.query(
    "DELETE FROM portfolio_import_staging_rows WHERE batch_id=ANY($1::bigint[])",
    [owned.batches],
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
  "reviewed atomic custody prefixes (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180000);
    afterEach(cleanup);
    afterAll(async () => {
      await releaseDbSuiteLock();
      await closePool();
      await closeTestPool();
    });

    it("commits an earlier outbound and later return/fee around an existing future sale", async () => {
      const position = await seed();
      const { batch, rows } = await stage(position);
      await expect(
        commitPortfolioAssetTransfer({ row: rows[0], batch }),
      ).rejects.toThrow(/oversell/);
      expect(await countEvents(position)).toBe(0);
      const preview = await previewPortfolioImportReconciliation({
        batchIds: [batch.id],
      });
      expect(preview).toMatchObject({
        ready: true,
        summary: { transfer: 2, adjustment: 1 },
      });
      const result = await commitReviewedPortfolioImports({
        batchIds: [batch.id],
        expectedPlanFingerprint: preview.planFingerprint,
      });
      expect(result).toMatchObject({ imported: 3, adopted: 0, errors: 0 });
      expect(await countEvents(position)).toBe(3);
      const originals = (
        await pool.query(
          "SELECT id,note FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
          [position.investment],
        )
      ).rows;
      expect(originals.map((row) => row.id)).toEqual(position.originals);
      expect(originals.map((row) => row.note)).toEqual([
        "Original acquisition",
        "Original later sale",
      ]);
      const allocation = (
        await pool.query(
          "SELECT basis_allocations FROM portfolio_asset_adjustments WHERE investment_id=$1",
          [position.investment],
        )
      ).rows[0].basis_allocations;
      for (const method of ["weighted_avg", "fifo", "lifo"])
        expect(allocation[method].lots).toEqual([
          expect.objectContaining({
            acquisitionId: position.originals[0],
            units: "1",
            nativeBasis: "10",
            eurBasis: "10",
          }),
        ]);
      validatePortfolioAssetTransferHistory(
        await getUnitEventsForInvestment(position.investment),
      );
      const repeated = await previewPortfolioImportReconciliation({
        batchIds: [batch.id],
      });
      expect(repeated.summary).toMatchObject({
        insert: 0,
        transfer: 0,
        adjustment: 0,
      });
      await rollbackBatch(batch.id);
      expect(await countEvents(position)).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT id,note FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
            [position.investment],
          )
        ).rows,
      ).toEqual(originals);
      validatePortfolioAssetTransferHistory(
        await getUnitEventsForInvestment(position.investment),
      );
    });

    it("replays settled fractional custody history once during repeat preview", async () => {
      const position = await seed();
      await pool.query(
        "DELETE FROM portfolio_transactions WHERE investment_id=$1",
        [position.investment],
      );
      await pool.query(
        `INSERT INTO portfolio_transactions(investment_id,account_id,type,date,units,amount,price_per_unit,currency)
        VALUES ($1,$2,'buy','2020-01-01',0.21739,100,460.00276,'EUR'),
               ($1,$2,'buy','2020-01-02',0.19377,100,516.07576,'EUR'),
               ($1,$2,'buy','2020-01-03',0.17267,100,579.13939,'EUR')`,
        [position.investment, position.source],
      );
      const { batch } = await stage(position, {
        outgoingUnits: "0.58383",
        returnedUnits: "0.58365715",
        feeUnits: "0.00017285",
      });
      const before = await previewPortfolioImportReconciliation({
        batchIds: [batch.id],
      });
      expect(before).toMatchObject({ ready: true });
      await commitReviewedPortfolioImports({
        batchIds: [batch.id],
        expectedPlanFingerprint: before.planFingerprint,
      });
      const persisted = await getUnitEventsForInvestment(position.investment);
      validatePortfolioAssetTransferHistory(persisted);
      const summary = await getPortfolioSummary("EUR");
      expect(
        summary.summaries.find((holding) => holding.id === position.investment),
      ).toMatchObject({ totalUnits: 0.58365715, oversold: false });
      const after = await previewPortfolioImportReconciliation({
        batchIds: [batch.id],
      });
      expect(after).toMatchObject({
        ready: true,
        blockers: [],
        summary: { insert: 0, transfer: 0, adjustment: 0, settled: 3 },
      });
      await expect(
        commitReviewedPortfolioImports({
          batchIds: [batch.id],
          expectedPlanFingerprint: after.planFingerprint,
        }),
      ).rejects.toThrow(/not in a reviewable state \(status: complete\)/);
      expect(await getUnitEventsForInvestment(position.investment)).toEqual(
        persisted,
      );
    });

    it("rejects a partial source scope with no return before preview or commit can change history", async () => {
      const position = await seed();
      const { batch } = await stage(position, {
        includeReturn: false,
        includeFee: false,
      });
      const preview = await previewPortfolioImportReconciliation({
        batchIds: [batch.id],
      });
      expect(preview.ready).toBe(false);
      expect(preview.blockers[0].reason).toBe("projected_history_conflict");
      await expect(
        commitReviewedPortfolioImports({ batchIds: [batch.id] }),
      ).rejects.toThrow(/oversell/);
      expect(await countEvents(position)).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT status FROM portfolio_import_batches WHERE id=$1",
            [batch.id],
          )
        ).rows[0].status,
      ).toBe("awaiting_review");
    });

    it("rolls back a residual incomplete timeline at scope exit and cleans the scope after errors", async () => {
      const position = await seed();
      const { batch, rows } = await stage(position, { includeFee: false });
      const events = rows.map(
        (row) => previewPortfolioAssetTransfer(row, batch).event,
      );
      await expect(
        withPortfolioCustodyImportScope(
          { events, validateHistory: validatePortfolioAssetTransferHistory },
          async () => {
            await commitPortfolioAssetTransfer({ row: rows[0], batch });
          },
        ),
      ).rejects.toThrow(/oversell/);
      expect(await countEvents(position)).toBe(0);
      await expect(
        commitPortfolioAssetTransfer({ row: rows[0], batch }),
      ).rejects.toThrow(/oversell/);
    });

    it("rejects altered event signatures and a different transaction client", async () => {
      const position = await seed();
      const { batch, rows } = await stage(position, { includeFee: false });
      const events = rows.map(
        (row) => previewPortfolioAssetTransfer(row, batch).event,
      );
      await expect(
        withPortfolioCustodyImportScope(
          { events, validateHistory: validatePortfolioAssetTransferHistory },
          async () => {
            await commitPortfolioAssetTransfer({
              row: { ...rows[0], units: "9" },
              batch,
            });
          },
        ),
      ).rejects.toThrow(/outside its reviewed transaction scope/);
      await expect(
        withPortfolioCustodyImportScope(
          { events, validateHistory: validatePortfolioAssetTransferHistory },
          async () => {
            portfolioCustodyWriteHistory([], events[0], {});
          },
        ),
      ).rejects.toThrow(/outside its reviewed transaction scope/);
      expect(await countEvents(position)).toBe(0);
    });

    it("does not allow a callback to silently omit all approved events", async () => {
      const position = await seed();
      const { batch, rows } = await stage(position, { includeFee: false });
      const events = rows.map(
        (row) => previewPortfolioAssetTransfer(row, batch).event,
      );
      await expect(
        withPortfolioCustodyImportScope(
          { events, validateHistory: validatePortfolioAssetTransferHistory },
          async () => undefined,
        ),
      ).rejects.toThrow(/did not retain every approved event/);
      expect(await countEvents(position)).toBe(0);
    });

    it("awaits asynchronous final validation before committing the scope", async () => {
      const position = await seed();
      const { batch, rows } = await stage(position, { includeFee: false });
      const events = rows.map(
        (row) => previewPortfolioAssetTransfer(row, batch).event,
      );
      await expect(
        withPortfolioCustodyImportScope(
          {
            events,
            validateHistory: async (history) => {
              validatePortfolioAssetTransferHistory(history);
              throw new Error("Asynchronous final validation failed");
            },
          },
          async () => {
            for (const row of rows) {
              await commitPortfolioAssetTransfer({ row, batch });
            }
          },
        ),
      ).rejects.toThrow("Asynchronous final validation failed");
      expect(await countEvents(position)).toBe(0);
    });

    it("binds the approved eligible yield source hashes", async () => {
      const position = await seed();
      const { batch, rows } = await stage(position, { includeFee: false });
      const transfer = previewPortfolioAssetTransfer(rows[0], batch).event;
      const event = {
        ...transfer,
        type: "asset_adjustment",
        account_id: position.source,
        source_account_id: undefined,
        destination_account_id: undefined,
        adjustment_kind: "yield_reversal",
        basis_policy: "zero_yield_only",
        eligible_source_record_hashes: ["a".repeat(64)],
      };
      await expect(
        withPortfolioCustodyImportScope(
          {
            events: [event],
            validateHistory: validatePortfolioAssetTransferHistory,
          },
          async () => {
            await withTransaction(async (client) => {
              portfolioCustodyWriteHistory(
                [],
                { ...event, eligible_source_record_hashes: ["b".repeat(64)] },
                client,
              );
            });
          },
        ),
      ).rejects.toThrow(/outside its reviewed transaction scope/);
      expect(await countEvents(position)).toBe(0);
    });
  },
);
