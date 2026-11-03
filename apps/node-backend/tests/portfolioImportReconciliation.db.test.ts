import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
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
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import {
  closePool,
  getPoolStats,
  withTransaction,
} from "../src/database/connection.ts";
import { portfolioIncomeTransactionSnapshotSql } from "../src/database/sqlite/schemaFunctions.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { mockCurrencyConversion } from "./helpers/mockCurrencyConversion.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.ts";
import { __pruneOldImportBatches as pruneOldImportBatches } from "../src/startup/warmup.ts";
import {
  insertDuplicateRepairReceipt,
  readFullRepairTransaction,
  readOriginalRepairState,
  replaceRepairBatch,
  replaceRepairStaging,
} from "../src/repositories/portfolioImportDuplicateRepairRepository.ts";
import { must } from "./helpers/must.ts";
import type { TestPool } from "./setup/db.ts";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
/** A whole row (PostgreSQL: `to_jsonb(row)`): the id is known, the other columns are not read. */
type JsonRow = { id: number } & Record<string, unknown>;
/**
 * Every portfolio_transactions column, as PostgreSQL's to_jsonb(pt) held
 * them: the timestamps as their stored text (the hinted duplicates replace
 * the decoded columns), so a restored row must match to the microsecond.
 */
const PT_ROW = `pt.*, pt.created_at AS "created_at::text", pt.updated_at AS "updated_at::text"`;
interface IdRow {
  id: number;
}
/** BIGINT ids arrive from the driver as strings. */
interface BigIdRow {
  id: string;
}

const historicalWarm = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());
vi.mock(
  "../src/services/currency/currencyConversionService.ts",
  async (importOriginal) =>
    mockCurrencyConversion({
      ...(await importOriginal()),
      convertRowsToEur: (...args: unknown[]) => historicalWarm(...args),
    }),
);

let pool: TestPool;
const describeDb = hasTestDatabase() ? describe : describe.skip;
const owned = {
  accounts: [] as number[],
  investments: [] as number[],
  batches: [] as number[],
  directories: [] as string[],
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let sequence = 0;

interface Fixture {
  account: number;
  investment: number;
}
/** Overrides for one staged Saxo row written by `batch` (NUMERIC as number or text). */
interface BatchRow {
  status?: string;
  date?: string;
  type?: string;
  units?: number | string | null;
  price?: number | string | null;
  amount?: number | string;
  fees?: number | string;
}

async function fixture(): Promise<Fixture> {
  const account: number = must((
    await pool.query<IdRow>(
      "INSERT INTO accounts(name,type,currency) VALUES ($1,'brokerage','EUR') RETURNING id",
      [`Reconciliation test broker ${++sequence}`],
    )
  ).rows[0], "query row").id;
  const investment: number = must((
    await pool.query<IdRow>(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Reconciliation test asset','RECONTEST','stock','EUR') RETURNING id",
    )
  ).rows[0], "query row").id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  return { account, investment };
}
async function legacy(
  fx: Fixture,
  {
    date = "2026-01-01",
    amount = 500,
    units = 5,
    price = 100,
    fees = 0,
    note = "Original manual note",
  } = {},
) {
  return must((
    await pool.query<IdRow>(
      `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,currency,note)
    VALUES ($1,'buy',$2,vision_numeric($3,18,4),vision_numeric($4,18,8),vision_numeric($5,18,6),vision_numeric($6,18,4),'EUR',$7) RETURNING id`,
      [fx.investment, date, String(amount), String(units), String(price), String(fees), note],
    )
  ).rows[0], "query row").id;
}
async function batch(
  fx: Fixture,
  rows: BatchRow[] = [{}],
  { identityPrefix = `receipt-${++sequence}` } = {},
) {
  const id = Number(
    must((
      await pool.query<BigIdRow>(
        `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
    VALUES ('saxo_transaction_history',vision_jsonb('{"format":"saxo_transaction_history"}'),'awaiting_review',$1,$2,true) RETURNING id`,
        [rows.length, fx.account],
      )
    ).rows[0], "query row").id,
  );
  owned.batches.push(id);
  for (const [index, row] of rows.entries()) {
    const identity = `${identityPrefix}-${index}`;
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      VALUES ($1,$2,$3,$4,$5,$5,'portfolio',vision_numeric($6,18,8),vision_numeric($7,18,6),vision_numeric($8,18,4),vision_numeric($9,18,4),'0.0000','EUR',$10,$11,$12,$13,1,1)`,
      [
        id,
        index,
        row.status ?? "matched",
        row.date ?? "2026-01-01",
        row.type ?? "buy",
        decimalParam(row.units === undefined ? 5 : row.units),
        decimalParam(row.price === undefined ? 100 : row.price),
        decimalParam(row.amount ?? 500),
        decimalParam(row.fees ?? 0),
        fx.investment,
        `Synthetic source ${identity}`,
        hash(`raw-${identity}`),
        hash(identity),
      ],
    );
  }
  return id;
}
/** A whole portfolio row without updated_at (PostgreSQL: to_jsonb(pt) - 'updated_at'). */
async function rowWithoutUpdatedAt(id: number): Promise<DbRow> {
  const row = must((
    await pool.query<DbRow>(
      `SELECT ${PT_ROW} FROM portfolio_transactions pt WHERE id=$1`,
      [id],
    )
  ).rows[0], "query row");
  const { updated_at: _updatedAt, ...rest } = row;
  return rest;
}
/** A NUMERIC fixture value as the text a decimal parameter binds as. */
function decimalParam(value: number | string | null): string | null {
  return value === null ? null : String(value);
}
async function cleanup() {
  historicalWarm.mockReset();
  await pool.query(
    "DELETE FROM exchange_rates WHERE currency_code='USD' AND rate_date='2026-01-05'",
  );
  for (const directory of owned.directories)
    await rm(directory, { recursive: true, force: true });
  owned.directories.length = 0;
  // This file's own database holds only this fixture corpus. DELETE and the
  // sequence reset replace TRUNCATE ... RESTART IDENTITY.
  for (const journal of [
    "portfolio_import_reconciliation_journal",
    "portfolio_import_duplicate_repair_journal",
    "portfolio_import_income_recognition_journal",
  ]) {
    // A restore entry references the entry it restores (ON DELETE
    // RESTRICT, checked per row), so delete from the newest links back.
    let deleted: number | null;
    do {
      ({ rowCount: deleted } = await pool.query(
        `DELETE FROM ${journal} WHERE NOT EXISTS (SELECT 1 FROM ${journal} child WHERE child.previous_entry_id = ${journal}.id)`,
      ));
    } while (deleted !== null && deleted > 0);
    await pool.query("UPDATE vision_sequences SET last_value = 0 WHERE name = $1", [
      `${journal}_id_seq`,
    ]);
  }
  if (owned.investments.length > 0)
    await pool.query(
      "DELETE FROM portfolio_asset_transfers WHERE investment_id IN (SELECT value FROM json_each($1))",
      [owned.investments],
    );
  if (owned.investments.length > 0)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id IN (SELECT value FROM json_each($1))",
      [owned.investments],
    );
  if (owned.batches.length > 0)
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE id IN (SELECT value FROM json_each($1))",
      [owned.batches],
    );
  if (owned.accounts.length > 0)
    await pool.query(
      "DELETE FROM transactions WHERE account_id IN (SELECT value FROM json_each($1))",
      [owned.accounts],
    );
  if (owned.investments.length > 0)
    await pool.query("DELETE FROM investments WHERE id IN (SELECT value FROM json_each($1))", [
      owned.investments,
    ]);
  if (owned.accounts.length > 0)
    await pool.query("DELETE FROM accounts WHERE id IN (SELECT value FROM json_each($1))", [
      owned.accounts,
    ]);
  owned.accounts.length = 0;
  owned.investments.length = 0;
  owned.batches.length = 0;
}


describeDb("real database reversible source adoption", () => {
  beforeAll(() => {
    pool = must(getTestPool(), "test pool");
  });
  beforeAll(acquireDbSuiteLock, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("adopts a base-fee execution whose literal amount PostgreSQL rounds at an exact half", async () => {
    const fx = await fixture();
    const old = await legacy(fx, { amount: 20, units: 10, price: 2 });
    const id = await batch(fx, [
      { units: "9.999925", price: 2, amount: "19.99985", fees: "0.00015" },
    ]);
    await pool.query(
      `UPDATE portfolio_import_batches SET adapter_name='nexo_pro_spot_history',
        custom_config=vision_jsonb('{"format":"nexo_pro_spot_history"}') WHERE id=$1`,
      [id],
    );
    await pool.query(
      `UPDATE portfolio_import_staging_rows SET symbol_raw='SYN',
        source_transaction_id='nexo-pro:spot:order:PRO-HALF-DECIMAL',raw_data=$2
        WHERE batch_id=$1`,
      [
        id,
        "203,2026-01-01 12:00:00,SYN/EUR,buy,limit,2,2,,10,10,0.000075,SYN,completed,PRO-HALF-DECIMAL",
      ],
    );
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(must(preview.actions[0], "preview.actions[0]").existingTransactionId).toBe(old);
    const result = await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(result).toMatchObject({ adopted: 1, imported: 0, errors: 0 });
    const saved = (
      await pool.query<DbRow>(
        "SELECT id,amount,units,fees FROM portfolio_transactions WHERE investment_id=$1",
        [fx.investment],
      )
    ).rows;
    expect(saved).toEqual([
      { id: old, amount: "19.9999", units: "9.99992500", fees: "0.0002" },
    ]);
  });

  it.each(["dividend", "interest"])(
    "corrects gross %s and withholding from a proven net manual amount",
    async (type) => {
      const fx = await fixture();
      const old = must((
        await pool.query<IdRow>(
          `INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,note,dividend_amount_convention)
      VALUES($1,$2,'2026-01-01','85.0000','EUR','Original income note',$3) RETURNING id`,
          [fx.investment, type, type === "dividend" ? "net" : "unknown"],
        )
      ).rows[0], "query row").id;
      const id = await batch(fx, [
        { type, amount: 100, units: null, price: null },
      ]);
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET taxes='15.0000' WHERE batch_id=$1",
        [id],
      );
      const plan = await previewPortfolioImportReconciliation({
        batchIds: [id],
        adoptPolicy: "prefer_source",
      });
      expect(plan.ready).toBe(true);
      expect(must(plan.actions[0], "plan.actions[0]").economicsProven).toBe(true);
      await commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
      });
      expect(
        (
          await pool.query<DbRow>(
            "SELECT amount,taxes,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
            [old],
          )
        ).rows[0],
      ).toEqual({
        amount: "100.0000",
        taxes: "15.0000",
        dividend_amount_convention: type === "dividend" ? "gross" : "unknown",
      });
      await rollbackBatch(id);
      expect(
        (
          await pool.query<DbRow>(
            "SELECT amount,taxes,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
            [old],
          )
        ).rows[0],
      ).toEqual({
        amount: "85.0000",
        taxes: "0.0000",
        dividend_amount_convention: type === "dividend" ? "net" : "unknown",
      });
    },
  );

  it("proves cross-currency net income only with the supplied source FX", async () => {
    const fx = await fixture();
    const old = must((
      await pool.query<IdRow>(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,dividend_amount_convention) VALUES($1,'dividend','2026-01-01','68.0000','EUR','net') RETURNING id",
        [fx.investment],
      )
    ).rows[0], "query row").id;
    const id = await batch(fx, [
      { type: "dividend", amount: 100, units: null, price: null },
    ]);
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET taxes='15.0000',currency='USD',fx_rate_to_eur='0.8000000000' WHERE batch_id=$1",
      [id],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(true);
    await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT amount,taxes,currency,fx_rate_to_eur FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      amount: "100.0000",
      taxes: "15.0000",
      currency: "USD",
      fx_rate_to_eur: "0.8000000000",
    });
    await rollbackBatch(id);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT amount,currency,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      amount: "68.0000",
      currency: "EUR",
      dividend_amount_convention: "net",
    });
  });

  it.each(["close", "type"])(
    "rechecks account eligibility after waiting for a concurrent %s",
    async (change) => {
      const fx = await fixture();
      const id = await batch(fx);
      // PostgreSQL showed the import waiting on the account row lock in
      // pg_stat_activity. Under SQLite (ADR-263) the manual writer holds the
      // single writer lock and the import queues on it
      // (getPoolStats().waitingCount) until the change commits.
      let releaseWriter!: () => void;
      const writerGate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let markChanged!: () => void;
      const changed = new Promise<void>((resolve) => {
        markChanged = resolve;
      });
      const writer = withTransaction(async (client) => {
        await client.query(
          change === "close"
            ? "UPDATE accounts SET is_active=false WHERE id=$1"
            : "UPDATE accounts SET type='checking' WHERE id=$1",
          [fx.account],
        );
        markChanged();
        await writerGate;
      });
      let pending;
      try {
        await changed;
        pending = commitReviewedPortfolioImports({ batchIds: [id] }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = getPoolStats().waitingCount > 0;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        releaseWriter();
        await writer;
        expect(await pending).toMatchObject({
          error: {
            status: 400,
            message: expect.stringContaining("active portfolio account") as unknown,
          },
        });
        expect(
          must((
            await pool.query<DbRow>(
              "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE investment_id=$1",
              [fx.investment],
            )
          ).rows[0], "query row").n,
        ).toBe(0);
        expect(
          must((
            await pool.query<DbRow>(
              "SELECT status FROM portfolio_import_batches WHERE id=$1",
              [id],
            )
          ).rows[0], "query row").status,
        ).toBe("awaiting_review");
      } finally {
        releaseWriter();
        await writer;
        if (pending) await pending;
      }
    },
  );

  it("keeps the original ID, notes and units, journals adoption, and restores them on rollback", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx);
    const before = await rowWithoutUpdatedAt(old);
    const result = await commitReviewedPortfolioImports({ batchIds: [id] });
    expect(result).toMatchObject({
      imported: 0,
      adopted: 1,
      duplicates: 0,
      errors: 0,
    });
    const current = (
      await pool.query<DbRow>("SELECT * FROM portfolio_transactions WHERE id=$1", [
        old,
      ])
    ).rows[0];
    expect(must(current, "current").account_id).toBe(fx.account);
    expect(must(current, "current").note).toBe("Original manual note");
    expect(must(current, "current").import_batch_id).toBeNull();
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [id],
        )
      ).rows[0], "query row").committed_txn_id,
    ).toBeNull();
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 0 });
    expect(await rowWithoutUpdatedAt(old)).toEqual(before);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT action FROM portfolio_import_reconciliation_journal ORDER BY id",
        )
      ).rows.map((row) => row.action),
    ).toEqual(["adopt", "restore"]);
  });

  it("requires a reviewed source policy, applies date/fee correction, and restores the original", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [{ date: "2026-01-03", fees: 2 }]);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [id] }),
    ).rejects.toMatchObject({ details: { reason: "reconciliation_required" } });
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan).toMatchObject({ ready: true, summary: { adopt: 1 } });
    await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT fees, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ fees: "2.0000", date: "2026-01-03" });
    await rollbackBatch(id);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT fees, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ fees: "0.0000", date: "2026-01-01" });
  });

  it("commits a reviewed mixed source policy and requires a policy for every corrected batch", async () => {
    const preserved = await fixture();
    const corrected = await fixture();
    const oldPreserved = await legacy(preserved);
    const oldCorrected = await legacy(corrected);
    const one = await batch(preserved, [{ date: "2026-01-03", fees: 2 }]);
    const two = await batch(corrected, [{ date: "2026-01-03", fees: 2 }]);
    const batchPolicies = [{ batchId: one, adoptPolicy: "preserve_existing" }];
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [two, one],
      adoptPolicy: "prefer_source",
      batchPolicies,
    });
    expect(plan).toMatchObject({ ready: true, batchPolicies });
    await expect(
      commitReviewedPortfolioImports({ batchIds: [one, two], batchPolicies }),
    ).rejects.toMatchObject({ details: { reason: "reconciliation_required" } });
    await commitReviewedPortfolioImports({
      batchIds: [one, two],
      adoptPolicy: "prefer_source",
      batchPolicies,
    });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT fees,to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [oldPreserved],
        )
      ).rows[0],
    ).toEqual({ fees: "0.0000", date: "2026-01-01" });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT fees,to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [oldCorrected],
        )
      ).rows[0],
    ).toEqual({ fees: "2.0000", date: "2026-01-03" });
    await rollbackBatch(one);
    await rollbackBatch(two);
  });

  it("adopts the history as it stands at commit time and restores that image", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx);
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "preserve_existing",
    });
    expect(plan.ready).toBe(true);
    await pool.query(
      "UPDATE portfolio_transactions SET note='Concurrent manual edit' WHERE id=$1",
      [old],
    );
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "preserve_existing",
      }),
    ).resolves.toMatchObject({ adopted: 1, imported: 0 });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT before_data->>'note' AS note FROM portfolio_import_reconciliation_journal WHERE action='adopt'",
        )
      ).rows,
    ).toEqual([{ note: "Concurrent manual edit" }]);
    await rollbackBatch(id);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT note,account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ note: "Concurrent manual edit", account_id: null });
  });

  it("refuses rollback after an adopted transaction was edited, including deleting new rows", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [
      {},
      { date: "2026-02-01", units: 2, amount: 200 },
    ]);
    await commitReviewedPortfolioImports({ batchIds: [id] });
    await pool.query(
      "UPDATE portfolio_transactions SET note='User edit after import' WHERE id=$1",
      [old],
    );
    await expect(rollbackBatch(id)).rejects.toMatchObject({
      details: { reason: "adopted_transaction_changed" },
    });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0], "query row").n,
    ).toBe(2);
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT status FROM portfolio_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0], "query row").status,
    ).toBe("complete");
  });

  it("dedups duplicate source exports globally before one adoption", async () => {
    const fx = await fixture();
    await legacy(fx);
    const one = await batch(fx, [{}], { identityPrefix: "same-export" });
    const two = await batch(fx, [{}], { identityPrefix: "same-export" });
    const result = await commitReviewedPortfolioImports({
      batchIds: [two, one],
    });
    expect(result).toMatchObject({ adopted: 1, imported: 0, duplicates: 1 });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0], "query row").n,
    ).toBe(1);
  });

  it("blocks partial unsupported input and rolls back another batch's valid changes", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const one = await batch(fx);
    const two = await batch(fx, [{ status: "error", date: "2026-02-01" }]);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [one, two] }),
    ).rejects.toMatchObject({ details: { reason: "incomplete_source" } });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0], "query row").account_id,
    ).toBeNull();
  });

  it("commits older funding buys before a sell from an earlier-selected batch", async () => {
    const fx = await fixture();
    const sell = await batch(fx, [
      { type: "sell", date: "2026-01-03", units: 4, amount: 400 },
    ]);
    const buy = await batch(fx);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [sell, buy] }),
    ).resolves.toMatchObject({ imported: 2, errors: 0 });
    const history = (
      await pool.query<DbRow>(
        "SELECT type FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
        [fx.investment],
      )
    ).rows;
    expect(history.map((row) => row.type)).toEqual(["buy", "sell"]);
  });

  it("rolls back adopted rows, receipts and prior sibling inserts after a runtime failure", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [
      {},
      { date: "2026-02-01", units: 2, amount: 200 },
      { date: "2026-03-01", units: 3, amount: 300 },
    ]);
    const original = portfolioTransactionService.create;
    let writes = 0;
    const spy = vi
      .spyOn(portfolioTransactionService, "create")
      .mockImplementation(async (...args) => {
        if (++writes === 2) throw new Error("Synthetic row write failure");
        return original(...args);
      });
    try {
      await expect(
        commitReviewedPortfolioImports({ batchIds: [id] }),
      ).rejects.toMatchObject({ details: { reason: "atomic_import_failed" } });
    } finally {
      spy.mockRestore();
    }
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0], "query row").account_id,
    ).toBeNull();
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0], "query row").n,
    ).toBe(1);
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0], "query row").n,
    ).toBe(0);
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT status FROM portfolio_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0], "query row").status,
    ).toBe("awaiting_review");
    expect(
      (
        await pool.query<DbRow>(
          "SELECT status FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [id],
        )
      ).rows.every((row) => row.status === "matched"),
    ).toBe(true);
  });

  it("atomically adopts the original acquisition and carries its dated custody without extra units", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const destination = must((
      await pool.query<IdRow>(
        "INSERT INTO accounts(name,type,currency) VALUES ('Reconciliation custody','brokerage','EUR') RETURNING id",
      )
    ).rows[0], "query row").id;
    owned.accounts.push(destination);
    const id = await batch(fx);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=vision_jsonb(json_set(custom_config,'$.transfer_destination_account_id',CAST($2 AS INTEGER))),rows_total=2 WHERE id=$1",
      [id, destination],
    );
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details)
      VALUES ($1,1,'matched','2026-01-05','AssetTransfer','asset_transfer','5.00000000','0.0000','0.0000','0.0000','EUR',$2,'Synthetic custody transfer',$3,$4,1,vision_jsonb('{"direction":"out","basisStatus":"carried","feeUnits":"0","receivedUnits":"5"}'))`,
      [id, fx.investment, hash(`transfer-raw-${id}`), hash(`transfer-${id}`)],
    );
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [id],
    });
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 1, transfer: 1 },
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
      }),
    ).resolves.toMatchObject({ adopted: 1, imported: 1 });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0], "query row").n,
    ).toBe(1);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT source_account_id,destination_account_id,units FROM portfolio_asset_transfers WHERE import_batch_id=$1",
          [id],
        )
      ).rows[0],
    ).toMatchObject({
      source_account_id: fx.account,
      destination_account_id: destination,
      units: "5.00000000",
    });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1 AND route='asset_transfer'",
          [id],
        )
      ).rows[0], "query row").committed_txn_id,
    ).toBeNull();
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 1 });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0], "query row").account_id,
    ).toBeNull();
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_asset_transfers WHERE import_batch_id=$1",
          [id],
        )
      ).rows[0], "query row").n,
    ).toBe(0);
  });

  it("requires Pro companion history and retains same-account Wallet movements without canonical transactions", async () => {
    const fx = await fixture();
    const wallet = await batch(fx, []);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=vision_jsonb($2),rows_total=1 WHERE id=$1",
      [wallet, JSON.stringify({ format: "nexo_transaction_history" })],
    );
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,currency,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details)
      VALUES ($1,0,'matched','2026-01-02','InternalMovement','account_internal','5.00000000','0.0000','0.0000','0.0000','EUR','Synthetic Wallet Pro movement',$2,$3,1,vision_jsonb('{"direction":"internal","basisStatus":"not_applicable"}'))`,
      [wallet, hash(`wallet-raw-${wallet}`), hash(`wallet-${wallet}`)],
    );
    expect(
      must((await previewPortfolioImportReconciliation({ batchIds: [wallet] }))
        .blockers[0], "previewPortfolioImportReconciliation result").reason,
    ).toBe("missing_companion_pro_history");
    const pro = await batch(fx);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=vision_jsonb($2) WHERE id=$1",
      [pro, JSON.stringify({ format: "nexo_pro_spot_history" })],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [wallet, pro],
    });
    expect(plan).toMatchObject({
      ready: true,
      summary: { internal_annotation: 1, insert: 1 },
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [wallet, pro],
      }),
    ).resolves.toMatchObject({ imported: 1, duplicates: 1, errors: 0 });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [wallet],
        )
      ).rows[0],
    ).toEqual({ status: "duplicate", committed_txn_id: null });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0], "query row").n,
    ).toBe(1);
    await expect(rollbackBatch(wallet)).resolves.toMatchObject({ deleted: 0 });
  });

  it("keeps adoption receipts bound to their source batch", async () => {
    const fx = await fixture();
    await legacy(fx);
    const id = await batch(fx);
    await commitReviewedPortfolioImports({ batchIds: [id] });
    await expect(
      pool.query<DbRow>("DELETE FROM portfolio_import_batches WHERE id=$1", [id]),
    ).rejects.toThrow(/violates.*foreign key constraint/);
  });

  async function duplicatedHistory({ count = 1 } = {}) {
    const fx = await fixture();
    const rows = Array.from({ length: count }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    }));
    const identityPrefix = `duplicate-repair-${++sequence}`;
    const originalBatch = await batch(fx, rows, { identityPrefix });
    await commitReviewedPortfolioImports({ batchIds: [originalBatch] });
    const imported = (
      await pool.query<JsonRow>(
        `SELECT ${PT_ROW} FROM portfolio_transactions pt WHERE import_batch_id=$1 ORDER BY date,id`,
        [originalBatch],
      )
    ).rows;
    const legacyIds: number[] = [];
    for (const row of rows)
      legacyIds.push(await legacy(fx, { ...row, fees: 2 }));
    const reviewBatch = await batch(fx, rows, { identityPrefix });
    return { fx, originalBatch, reviewBatch, imported, legacyIds };
  }

  /**
   * Write the state a duplicate repair applied before ADR-236 left behind:
   * the imported copy deleted, its source row settled, the manual twin
   * adopted, and a `repair` receipt in the journal.
   */
  async function applyLegacyDuplicateRepair(
    data: Awaited<ReturnType<typeof duplicatedHistory>>,
    index: number,
    policy: "preserve_existing" | "prefer_source",
  ) {
    const importedId = must(data.imported[index], "data.imported[index]").id;
    const legacyId = must(data.legacyIds[index], "data.legacyIds[index]");
    const legacyBefore = must(await readFullRepairTransaction(legacyId), "readFullRepairTransaction result");
    const importedBefore = must(await readFullRepairTransaction(importedId), "readFullRepairTransaction result");
    const state = await readOriginalRepairState(data.originalBatch, importedId);
    const source = must(state.originalStaging[0], "state.originalStaging[0]");
    const changedSource = must(await replaceRepairStaging(source, {
      ...source,
      status: "duplicate",
      committed_txn_id: null,
    }), "replaceRepairStaging result");
    await pool.query("DELETE FROM portfolio_transactions WHERE id=$1", [
      importedId,
    ]);
    await pool.query(
      policy === "prefer_source"
        ? "UPDATE portfolio_transactions SET account_id=$2,fees='0.0000' WHERE id=$1"
        : "UPDATE portfolio_transactions SET account_id=$2 WHERE id=$1",
      [legacyId, data.fx.account],
    );
    const changedBatch = must(await replaceRepairBatch(must(state.originalBatch, "state.originalBatch"), {
      ...must(state.originalBatch, "state.originalBatch"),
      rows_imported: must(state.originalBatch, "state.originalBatch").rows_imported - 1,
      rows_duplicate: must(state.originalBatch, "state.originalBatch").rows_duplicate + 1,
    }), "replaceRepairBatch result");
    const review = must((
      await pool.query<BigIdRow>(
        "UPDATE portfolio_import_staging_rows SET status='duplicate' WHERE batch_id=$1 AND row_index=$2 RETURNING id",
        [data.reviewBatch, index],
      )
    ).rows[0], "query row").id;
    await insertDuplicateRepairReceipt({
      batchId: data.reviewBatch,
      stagingRowId: review,
      originalBatchId: data.originalBatch,
      legacyId,
      importedId,
      action: "repair",
      policy,
      before: {
        legacy: legacyBefore,
        imported: importedBefore,
        originalBatch: must(state.originalBatch, "state.originalBatch"),
        originalStaging: state.originalStaging,
      },
      after: {
        legacy: must(await readFullRepairTransaction(legacyId), "readFullRepairTransaction result"),
        imported: null,
        originalBatch: changedBatch,
        originalStaging: [changedSource],
      },
    });
  }

  it("settles a repeat of an imported row as a duplicate and leaves a manual twin untouched", async () => {
    const data = await duplicatedHistory();
    const before = (
      await pool.query<DbRow>(
        `SELECT ${PT_ROW} FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id`,
        [data.fx.investment],
      )
    ).rows;
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [data.reviewBatch],
    });
    expect(plan).toMatchObject({ ready: true, summary: { duplicate: 1 } });
    await expect(
      commitReviewedPortfolioImports({ batchIds: [data.reviewBatch] }),
    ).resolves.toMatchObject({ imported: 0, adopted: 0, duplicates: 1 });
    expect(
      (
        await pool.query<DbRow>(
          `SELECT ${PT_ROW} FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id`,
          [data.fx.investment],
        )
      ).rows,
    ).toEqual(before);
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_import_duplicate_repair_journal",
        )
      ).rows[0], "query row").n,
    ).toBe(0);
  });

  it("restores a duplicate repair applied before ADR-236 with full original rows, pointers and counters", async () => {
    const data = await duplicatedHistory();
    await pool.query(
      "UPDATE portfolio_import_batches SET started_at=sub_interval(now(),'60 days') WHERE id IN (SELECT value FROM json_each($1))",
      [[data.originalBatch, data.reviewBatch]],
    );
    await applyLegacyDuplicateRepair(data, 0, "prefer_source");
    await expect(
      commitReviewedPortfolioImports({ batchIds: [data.reviewBatch] }),
    ).resolves.toMatchObject({ imported: 0, adopted: 0, errors: 0 });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT id,note,fees,import_batch_id FROM portfolio_transactions WHERE investment_id=$1",
          [data.fx.investment],
        )
      ).rows,
    ).toEqual([
      {
        id: data.legacyIds[0],
        note: "Original manual note",
        fees: "0.0000",
        import_batch_id: null,
      },
    ]);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ status: "duplicate", committed_txn_id: null });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 0, rows_duplicate: 1 });
    await expect(
      pool.query<DbRow>("DELETE FROM portfolio_import_batches WHERE id=$1", [
        data.originalBatch,
      ]),
    ).rejects.toThrow(/foreign key constraint/);
    await pruneOldImportBatches();
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_import_batches WHERE id IN (SELECT value FROM json_each($1))",
          [[data.originalBatch, data.reviewBatch]],
        )
      ).rows[0], "query row").n,
    ).toBe(2);
    await expect(rollbackBatch(data.reviewBatch)).resolves.toMatchObject({
      deleted: 0,
      restored: 1,
      restored_imported: 1,
    });
    expect(
      must((
        await pool.query<JsonRow>(
          `SELECT ${PT_ROW} FROM portfolio_transactions pt WHERE id=$1`,
          [must(data.imported[0], "data.imported[0]").id],
        )
      ).rows[0], "query row"),
    ).toEqual(data.imported[0]);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT account_id,fees,note FROM portfolio_transactions WHERE id=$1",
          [data.legacyIds[0]],
        )
      ).rows[0],
    ).toEqual({
      account_id: null,
      fees: "2.0000",
      note: "Original manual note",
    });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ status: "committed", committed_txn_id: must(data.imported[0], "data.imported[0]").id });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 1, rows_duplicate: 0 });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT action FROM portfolio_import_duplicate_repair_journal ORDER BY id",
        )
      ).rows.map((row) => row.action),
    ).toEqual(["repair", "restore"]);
  });

  it("restores several repairs from one old batch in reverse receipt order", async () => {
    const data = await duplicatedHistory({ count: 2 });
    // Separate dates must have a unique counterpart within the overlap window.
    await pool.query(
      "UPDATE portfolio_transactions SET units='6.00000000',amount='600.0000' WHERE id IN (SELECT value FROM json_each($1))",
      [[data.legacyIds[1], must(data.imported[1], "data.imported[1]").id]],
    );
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET units='6.00000000',amount='600.0000' WHERE batch_id IN (SELECT value FROM json_each($1)) AND row_index=1",
      [[data.originalBatch, data.reviewBatch]],
    );
    await applyLegacyDuplicateRepair(data, 0, "preserve_existing");
    await applyLegacyDuplicateRepair(data, 1, "preserve_existing");
    await commitReviewedPortfolioImports({ batchIds: [data.reviewBatch] });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 0, rows_duplicate: 2 });
    await expect(rollbackBatch(data.reviewBatch)).resolves.toMatchObject({
      restored: 2,
      restored_imported: 2,
    });
    expect(
      (
        await pool.query<DbRow>(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 2, rows_duplicate: 0 });
  });

  it.each(["legacy", "staging", "batch", "recreated_imported"])(
    "blocks repair rollback after hostile %s changes without deleting a new row",
    async (target) => {
      const data = await duplicatedHistory();
      await pool.query(
        "UPDATE portfolio_transactions SET date='2025-01-01' WHERE id=$1",
        [must(data.imported[0], "data.imported[0]").id],
      );
      await pool.query(
        "UPDATE portfolio_transactions SET date='2025-01-01' WHERE id=$1",
        [data.legacyIds[0]],
      );
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET tx_date='2025-01-01' WHERE batch_id IN (SELECT value FROM json_each($1))",
        [[data.originalBatch, data.reviewBatch]],
      );
      await pool.query(
        "UPDATE portfolio_import_batches SET rows_total=2 WHERE id=$1",
        [data.reviewBatch],
      );
      await pool.query(
        `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      VALUES($1,1,'matched','2026-01-01','buy','buy','portfolio','1.00000000','100.000000','100.0000','0.0000','0.0000','EUR',$2,'Synthetic genuinely new acquisition',$3,$4,1,1)`,
        [
          data.reviewBatch,
          data.fx.investment,
          hash(`hostile-newraw-${data.reviewBatch}`),
          hash(`hostile-new-${data.reviewBatch}`),
        ],
      );
      await applyLegacyDuplicateRepair(data, 0, "preserve_existing");
      await expect(
        commitReviewedPortfolioImports({ batchIds: [data.reviewBatch] }),
      ).resolves.toMatchObject({ imported: 1 });
      if (target === "legacy")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Edited after repair' WHERE id=$1",
          [data.legacyIds[0]],
        );
      if (target === "staging")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET note='Edited provenance' WHERE batch_id=$1",
          [data.originalBatch],
        );
      if (target === "batch")
        await pool.query(
          "UPDATE portfolio_import_batches SET rows_duplicate=rows_duplicate+1 WHERE id=$1",
          [data.originalBatch],
        );
      if (target === "recreated_imported")
        await pool.query(
          "INSERT INTO portfolio_transactions(id,investment_id,type,date,amount,units,currency) VALUES($1,$2,'buy','2025-01-01','500.0000','5.00000000','EUR')",
          [must(data.imported[0], "data.imported[0]").id, data.fx.investment],
        );
      const before = (
        await pool.query<DbRow>(
          `SELECT ${PT_ROW} FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id`,
          [data.fx.investment],
        )
      ).rows;
      await expect(rollbackBatch(data.reviewBatch)).rejects.toMatchObject({
        status: 409,
        details: { reason: "duplicate_repair_changed" },
      });
      expect(
        (
          await pool.query<DbRow>(
            `SELECT ${PT_ROW} FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id`,
            [data.fx.investment],
          )
        ).rows,
      ).toEqual(before);
      expect(
        must((
          await pool.query<DbRow>(
            "SELECT status FROM portfolio_import_batches WHERE id=$1",
            [data.reviewBatch],
          )
        ).rows[0], "query row").status,
      ).toBe("complete");
    },
  );
  it("restores an adoption journal row written before ADR-236 on rollback", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx);
    const snapshot = async () =>
      must((
        await pool.query<DbRow>(
          `SELECT ${portfolioIncomeTransactionSnapshotSql("pt")} AS "data::json" FROM portfolio_transactions pt WHERE id=$1`,
          [old],
        )
      ).rows[0], "query row").data;
    const before = await snapshot();
    // The state an applied pre-ADR-236 adoption left: the manual row moved to
    // the batch account, its source settled and an `adopt` receipt recorded.
    await pool.query(
      "UPDATE portfolio_transactions SET account_id=$2,fees='1.0000' WHERE id=$1",
      [old, fx.account],
    );
    const after = await snapshot();
    const source = must((
      await pool.query<BigIdRow>(
        "UPDATE portfolio_import_staging_rows SET status='duplicate' WHERE batch_id=$1 RETURNING id",
        [id],
      )
    ).rows[0], "query row").id;
    await pool.query(
      "UPDATE portfolio_import_batches SET status='complete',rows_duplicate=1 WHERE id=$1",
      [id],
    );
    await pool.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt','prefer_source',vision_jsonb($4),vision_jsonb($5))",
      [id, source, old, JSON.stringify(before), JSON.stringify(after)],
    );
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 0 });
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await pool.query<DbRow>(
          `SELECT action,previous_entry_id IS NOT NULL AS "linked::bool" FROM portfolio_import_reconciliation_journal ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      { action: "adopt", linked: false },
      { action: "restore", linked: true },
    ]);
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT status FROM portfolio_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0], "query row").status,
    ).toBe("aborted");
  });

  it("closes a paired income receipt written before ADR-236 when its batch rolls back", async () => {
    const fx = await fixture();
    const id = await batch(fx, [
      {
        type: "dividend",
        units: null,
        price: null,
        amount: 3,
        status: "committed",
      },
      { type: "gift", units: 0.5, price: 0, amount: 0, status: "committed" },
    ]);
    const [incomeSource, unitSource] = (
      await pool.query<BigIdRow>(
        "SELECT id FROM portfolio_import_staging_rows WHERE batch_id=$1 ORDER BY row_index",
        [id],
      )
    ).rows.map((row) => row.id);
    const unit = must((
      await pool.query<IdRow>(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,account_id,import_batch_id) VALUES($1,'gift','2026-01-01','0.0000','0.50000000','0.000000','0.0000','0.0000','EUR',$2,$3) RETURNING id",
        [fx.investment, fx.account, id],
      )
    ).rows[0], "query row").id;
    const income = must((
      await pool.query<IdRow>(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,fees,taxes,currency,account_id,import_batch_id,income_recognition_role) VALUES($1,'dividend','2026-01-01','3.0000','0.0000','0.0000','EUR',$2,$3,'included_in_units') RETURNING id",
        [fx.investment, fx.account, id],
      )
    ).rows[0], "query row").id;
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET committed_txn_id=CASE WHEN id=$2 THEN CAST($3 AS INTEGER) ELSE CAST($4 AS INTEGER) END WHERE batch_id=$1",
      [id, incomeSource, income, unit],
    );
    await pool.query(
      "UPDATE portfolio_import_batches SET status='complete',rows_imported=2 WHERE id=$1",
      [id],
    );
    await pool.query(
      `INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,income_data,unit_data,proof_data)
      SELECT $1,$2,$3,i.id,u.id,'record',${portfolioIncomeTransactionSnapshotSql("i")},${portfolioIncomeTransactionSnapshotSql("u")},vision_jsonb('{"sourceFileHash":"synthetic"}') FROM portfolio_transactions i,portfolio_transactions u WHERE i.id=$4 AND u.id=$5`,
      [id, incomeSource, unitSource, income, unit],
    );
    // An active pair still guards both transactions against direct edits.
    await expect(
      pool.query<DbRow>("DELETE FROM portfolio_transactions WHERE id=$1", [unit]),
    ).rejects.toThrow(/paired income/);
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 2 });
    expect(
      must((
        await pool.query<DbRow>(
          "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE id IN (SELECT value FROM json_each($1))",
          [[income, unit]],
        )
      ).rows[0], "query row").n,
    ).toBe(0);
    expect(
      (
        await pool.query<DbRow>(
          "SELECT action FROM portfolio_import_income_recognition_journal WHERE batch_id=$1 ORDER BY id",
          [id],
        )
      ).rows.map((row) => row.action),
    ).toEqual(["record", "restore"]);
  });
});
