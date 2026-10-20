/**
 * Real-PostgreSQL Kinesis imports after ADR-236: fiat cash is ordinary
 * brokerage cash, and a zero yield-basis distribution records its literal
 * income with the in-kind role beside the zero-basis units. Both repeat as
 * duplicates and roll back with their batch.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { runPortfolioImportPipeline } from "../src/services/portfolioImportPipeline/index.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";

const pool = getTestPool()!;
const describeDb = hasTestDatabase() ? describe : describe.skip;
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/portfolio/${name}`, import.meta.url));
const owned = { accounts: [] as number[], investments: [] as number[] };

async function account(): Promise<number> {
  const id = Number(
    (
      await pool.query(
        "INSERT INTO accounts(name,institution,type,currency) VALUES('KINESIS SYNTHETIC','Kinesis','brokerage','EUR') RETURNING id",
      )
    ).rows[0].id,
  );
  owned.accounts.push(id);
  return id;
}

async function investment(symbol: string): Promise<number> {
  const id = Number(
    (
      await pool.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES($1,$1,'metals','EUR') RETURNING id",
        [symbol],
      )
    ).rows[0].id,
  );
  owned.investments.push(id);
  return id;
}

/** Stage one Kinesis statement and commit it the way the review page does. */
async function importKinesis(file: string, accountId: number) {
  const staged = await runPortfolioImportPipeline({
    filePath: fixture(file),
    adapterName: "kinesis_transaction_history",
    customConfig: {
      format: "kinesis_transaction_history",
      yield_basis_policy: "zero",
    },
    defaultAssetClass: "crypto",
    isBrokerage: true,
    accountId,
  });
  if (!staged.requiresReview) return staged;
  const result = await commitReviewedPortfolioImports({
    batchIds: [staged.batchId],
  });
  return { batchId: staged.batchId, ...result };
}

async function cleanup() {
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.accounts.length) {
    await pool.query(
      "DELETE FROM portfolio_asset_adjustment_sources WHERE adjustment_id IN (SELECT id FROM portfolio_asset_adjustments WHERE account_id=ANY($1::integer[]))",
      [owned.accounts],
    );
    await pool.query(
      "DELETE FROM portfolio_asset_adjustments WHERE account_id=ANY($1::integer[])",
      [owned.accounts],
    );
    await pool.query(
      "DELETE FROM transactions WHERE account_id=ANY($1::integer[])",
      [owned.accounts],
    );
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE account_id=ANY($1::integer[])",
      [owned.accounts],
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
  owned.accounts.length = 0;
  owned.investments.length = 0;
}

describeDb("Kinesis imports without reconciliation scopes", () => {
  beforeAll(acquireDbSuiteLock, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("records fiat cash as ordinary signed brokerage cash, repeats as duplicates and rolls back", async () => {
    const sleeve = await account();
    await investment("KAU");
    const first = await importKinesis("kinesis-closed-cash.csv", sleeve);
    expect(first).toMatchObject({ errors: 0 });
    const ledger = async () =>
      (
        await pool.query(
          "SELECT to_char(date,'YYYY-MM-DD') AS date,amount::text AS amount,currency,memo FROM transactions WHERE account_id=$1 ORDER BY date,id",
          [sleeve],
        )
      ).rows;
    // Each cash amount is the literal balance movement, so the sleeve closes
    // at the statement's closing balances: 0 EUR and 0 USD.
    expect(await ledger()).toEqual([
      {
        date: "2026-01-01",
        amount: "100.0000",
        currency: "EUR",
        memo: "Kinesis cash deposit",
      },
      {
        date: "2026-01-02",
        amount: "-60.0000",
        currency: "EUR",
        memo: "Kinesis trade cash leg KAU_EUR",
      },
      {
        date: "2026-01-03",
        amount: "-10.0000",
        currency: "EUR",
        memo: "Kinesis card payment",
      },
      {
        date: "2026-01-04",
        amount: "-30.0000",
        currency: "EUR",
        memo: "Kinesis cash withdrawal",
      },
      {
        date: "2026-01-05",
        amount: "20.0000",
        currency: "USD",
        memo: "Kinesis cash deposit",
      },
      {
        date: "2026-01-06",
        amount: "-20.0000",
        currency: "USD",
        memo: "Kinesis card payment",
      },
    ]);
    const repeat = await importKinesis("kinesis-closed-cash.csv", sleeve);
    expect(repeat).toMatchObject({ imported: 0, errors: 0 });
    expect(await ledger()).toHaveLength(6);
    await rollbackBatch(repeat.batchId);
    expect(await ledger()).toHaveLength(6);
    await rollbackBatch(first.batchId);
    expect(await ledger()).toEqual([]);
  });

  it("records a zero yield-basis distribution as in-kind income beside its zero-basis units", async () => {
    const sleeve = await account();
    const kau = await investment("KAU");
    const first = await importKinesis("kinesis-full-paired-income.csv", sleeve);
    expect(first).toMatchObject({ errors: 0 });
    const history = async () =>
      (
        await pool.query(
          `SELECT type,to_char(date,'YYYY-MM-DD') AS date,amount::text AS amount,units::text AS units,
            price_per_unit::text AS price,fees::text AS fees,taxes::text AS taxes,currency,
            fx_rate_to_eur::text AS fx,income_recognition_role AS role
           FROM portfolio_transactions WHERE investment_id=$1 ORDER BY date,type`,
          [kau],
        )
      ).rows;
    const committed = await history();
    expect(committed.filter((row) => row.type === "dividend")).toEqual([
      expect.objectContaining({
        date: "2026-01-04",
        units: null,
        price: null,
        fees: "0.0000",
        taxes: "0.0000",
        fx: null,
        role: "included_in_units",
      }),
      expect.objectContaining({
        date: "2026-02-04",
        units: null,
        price: null,
        fees: "0.0000",
        taxes: "0.0000",
        fx: null,
        role: "included_in_units",
      }),
    ]);
    expect(committed.filter((row) => row.type === "gift")).toEqual([
      expect.objectContaining({
        date: "2026-01-04",
        units: "0.00287000",
        role: "standard",
      }),
      expect.objectContaining({
        date: "2026-02-04",
        units: "0.00163000",
        role: "standard",
      }),
    ]);
    const repeat = await importKinesis("kinesis-full-paired-income.csv", sleeve);
    expect(repeat).toMatchObject({ imported: 0, errors: 0 });
    expect(await history()).toEqual(committed);
    await rollbackBatch(repeat.batchId);
    await rollbackBatch(first.batchId);
    expect(await history()).toEqual([]);
  });
});
