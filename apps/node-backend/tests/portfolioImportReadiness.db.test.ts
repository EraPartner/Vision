import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { commitReviewedPortfolioImport } from "../src/services/portfolioImportCommitService.ts";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.ts";
import type { PortfolioTransactionInput } from "../src/services/portfolio/portfolioTransactionRules.ts";
import {
  asAccountId,
  asCurrencyCode,
  asInvestmentId,
} from "@vision/types/brands";
import { must } from "./helpers/must.ts";
import type { TestPool } from "./setup/db.ts";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
interface IdRow {
  id: number;
}
/** BIGINT ids arrive from the driver as strings. */
interface BigIdRow {
  id: string;
}

let pool: TestPool;
const fixtures = {
  accountIds: [] as number[],
  investmentIds: [] as number[],
  batchIds: [] as number[],
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
let fixtureSequence = 0;

interface Position {
  accountId: number;
  investmentId: number;
}
/** One staged source row; omitted fields take the defaults in `stageSource`. */
interface SourceRow {
  route?: string;
  status?: string;
  type?: string;
  date?: string;
  units?: number;
  price?: number;
  amount?: number;
  fees?: number;
  taxes?: number;
  identity?: string;
  unresolved?: boolean;
  overrideInvestmentId?: number;
}

async function seedPosition(): Promise<Position> {
  fixtureSequence++;
  const accountId: number = must((
    await pool.query<IdRow>(
      `INSERT INTO accounts (name, institution, type, is_active, currency)
       VALUES ($1, 'READINESS TEST BROKER', 'brokerage', true, 'EUR')
       RETURNING id`,
      [`READINESS TEST ACCOUNT ${fixtureSequence}`],
    )
  ).rows[0], "query row").id;
  fixtures.accountIds.push(accountId);
  const investmentId: number = must((
    await pool.query<IdRow>(
      `INSERT INTO investments (name, symbol, asset_class, currency)
       VALUES ('Readiness test stock', 'READINESSTEST', 'stock', 'EUR') RETURNING id`,
    )
  ).rows[0], "query row").id;
  fixtures.investmentIds.push(investmentId);
  return { accountId, investmentId };
}

async function manualTrade(
  position: Position,
  fields: Partial<PortfolioTransactionInput> = {},
) {
  return portfolioTransactionService.create({
    investment_id: asInvestmentId(position.investmentId),
    type: "buy",
    date: "2026-01-01",
    units: 5,
    price_per_unit: 100,
    currency: asCurrencyCode("EUR"),
    ...fields,
  });
}

async function stageSource(
  position: Position,
  source: SourceRow[],
  opts: { adapter?: string; config?: unknown } = {},
) {
  const batchId = Number(
    must((
      await pool.query<BigIdRow>(
        `INSERT INTO portfolio_import_batches
           (adapter_name, custom_config, status, rows_total, rows_error, account_id, is_brokerage)
         VALUES ($1, vision_jsonb($2), 'awaiting_review', $3, $4, $5, true) RETURNING id`,
        [
          opts.adapter ?? "custom",
          JSON.stringify(opts.config ?? { format: "saxo_transaction_history" }),
          source.length,
          source.filter((row) => row.status === "error").length,
          position.accountId,
        ],
      )
    ).rows[0], "query row").id,
  );
  fixtures.batchIds.push(batchId);
  for (const [rowIndex, row] of source.entries()) {
    const cash = row.route === "cash";
    const type = cash ? (row.type ?? null) : (row.type ?? "buy");
    const units = cash ? null : (row.units ?? 5);
    const price = cash ? null : (row.price ?? 100);
    const identity = row.identity ?? `${position.accountId}:${rowIndex}`;
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows
         (batch_id, row_index, status, tx_date, type_raw, type, route, units,
          price_per_unit, amount, fees, taxes, currency, resolved_investment_id,
          user_override_investment_id, raw_data, source_record_hash,
          dedup_fingerprint, dedup_fingerprint_version, dedup_occurrence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, vision_numeric($8, 18, 8),
               vision_numeric($9, 18, 6), vision_numeric($10, 18, 4),
               vision_numeric($11, 18, 4), vision_numeric($12, 18, 4), 'EUR',
               $13, $14, $15, $16, $17, 1, 1)`,
      [
        batchId,
        rowIndex,
        row.status ?? "matched",
        row.date ?? "2026-01-01",
        cash ? "Deposit" : type,
        type,
        cash ? "cash" : "portfolio",
        units == null ? null : String(units),
        price == null ? null : String(price),
        // Non-cash rows always carry units and a price.
        String(
          row.amount ?? (cash ? 500 : must(units, "units") * must(price, "price")),
        ),
        String(row.fees ?? 0),
        String(row.taxes ?? 0),
        cash || row.unresolved ? null : position.investmentId,
        row.overrideInvestmentId ?? null,
        `synthetic readiness source ${identity}`,
        hash(`source:${identity}`),
        hash(`fingerprint:${identity}`),
      ],
    );
  }
  return batchId;
}

async function canonicalCounts(position: Position) {
  return (
    await pool.query<DbRow>(
      `SELECT (SELECT COUNT(*) FROM portfolio_transactions WHERE investment_id = $1) AS portfolio,
              (SELECT COUNT(*) FROM transactions WHERE account_id = $2) AS cash`,
      [position.investmentId, position.accountId],
    )
  ).rows[0];
}

async function assertBlockedWithoutWrites(
  position: Position,
  batchId: number,
  reason: string,
  ordinals: number[],
) {
  const before = await canonicalCounts(position);
  const stagingBefore = (
    await pool.query<DbRow>(
      `SELECT row_index, status, committed_txn_id, raw_data, dedup_fingerprint
         FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index`,
      [batchId],
    )
  ).rows;
  const rejection = commitReviewedPortfolioImport({ batchId });
  await expect(rejection).rejects.toMatchObject({
    status: 409,
    details:
      reason === "existing_history_overlap"
        ? {
            reason: "reconciliation_required",
            blockers: ordinals.map((rowOrdinal) =>
              expect.objectContaining({ rowOrdinal }) as unknown,
            ),
          }
        : { reason, count: ordinals.length, row_ordinals: ordinals },
  });
  expect(await canonicalCounts(position)).toEqual(before);
  expect(
    (
      await pool.query<DbRow>(
        `SELECT row_index, status, committed_txn_id, raw_data, dedup_fingerprint
           FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index`,
        [batchId],
      )
    ).rows,
  ).toEqual(stagingBefore);
  expect(
    must((
      await pool.query<DbRow>(
        "SELECT status FROM portfolio_import_batches WHERE id = $1",
        [batchId],
      )
    ).rows[0], "query row").status,
  ).toBe("awaiting_review");
}

describe.skipIf(!hasTestDatabase())(
  "maintained portfolio import readiness (real database)",
  () => {
    beforeAll(() => {
      pool = must(getTestPool(), "test pool");
    });
    beforeAll(async () => {
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      // Every fixture owns this file's disposable database. DELETE and the
      // sequence reset replace TRUNCATE ... RESTART IDENTITY.
      for (const journal of [
        "portfolio_import_reconciliation_journal",
        "portfolio_import_duplicate_repair_journal",
      ]) {
        // A restore entry references the entry it restores (ON DELETE
        // RESTRICT, checked per row), so delete from the newest links back.
        let deleted: number | null;
        do {
          ({ rowCount: deleted } = await pool.query(
            `DELETE FROM ${journal} WHERE NOT EXISTS (SELECT 1 FROM ${journal} child WHERE child.previous_entry_id = ${journal}.id)`,
          ));
        } while (deleted !== null && deleted > 0);
        await pool.query(
          "UPDATE vision_sequences SET last_value = 0 WHERE name = $1",
          [`${journal}_id_seq`],
        );
      }
      for (const investmentId of fixtures.investmentIds) {
        await pool.query(
          "DELETE FROM portfolio_transactions WHERE investment_id = $1",
          [investmentId],
        );
      }
      for (const accountId of fixtures.accountIds) {
        await pool.query("DELETE FROM transactions WHERE account_id = $1", [
          accountId,
        ]);
      }
      for (const batchId of fixtures.batchIds) {
        await pool.query(
          "DELETE FROM portfolio_import_staging_rows WHERE batch_id = $1",
          [batchId],
        );
        await pool.query("DELETE FROM portfolio_import_batches WHERE id = $1", [
          batchId,
        ]);
      }
      for (const investmentId of fixtures.investmentIds) {
        await pool.query("DELETE FROM investments WHERE id = $1", [
          investmentId,
        ]);
      }
      for (const accountId of fixtures.accountIds) {
        await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
      }
      await pool.query(
        "DELETE FROM recipients WHERE name = 'READINESS TEST BROKER'",
      );
      fixtures.investmentIds.length = 0;
      fixtures.batchIds.length = 0;
      fixtures.accountIds.length = 0;
    });

    afterAll(async () => {
      try {
        await releaseDbSuiteLock();
      } finally {
        try {
          await closeTestPool();
        } finally {
          await closePool();
        }
      }
    });

    it.each(["error", "pending", "validated"])(
      "blocks a %s source row before inserting otherwise-ready cash and trades",
      async (status) => {
        const position = await seedPosition();
        const batchId = await stageSource(position, [
          { route: "cash" },
          {},
          { status },
        ]);
        await assertBlockedWithoutWrites(
          position,
          batchId,
          "incomplete_source",
          [3],
        );
        expect(await canonicalCounts(position)).toEqual({
          portfolio: 0,
          cash: 0,
        });
      },
    );

    it("blocks an unresolved matched instrument before either canonical route", async () => {
      const position = await seedPosition();
      const batchId = await stageSource(position, [
        { route: "cash" },
        {},
        { unresolved: true },
      ]);
      await assertBlockedWithoutWrites(
        position,
        batchId,
        "incomplete_source",
        [3],
      );
    });

    it.each(["2026-01-01", "2026-01-02", "2026-01-08"])(
      "blocks an unassigned real trade on %s without appending broker duplicates",
      async (date) => {
        const position = await seedPosition();
        const existing = await manualTrade(position);
        const batchId = await stageSource(position, [
          { route: "cash" },
          { date, fees: 3, price: 110 },
        ]);
        await assertBlockedWithoutWrites(
          position,
          batchId,
          "existing_history_overlap",
          [2],
        );
        expect(
          (
            await pool.query<DbRow>(
              "SELECT account_id, import_batch_id, dedup_fingerprint FROM portfolio_transactions WHERE id = $1",
              [must(existing, "existing").id],
            )
          ).rows,
        ).toEqual([
          { account_id: null, import_batch_id: null, dedup_fingerprint: null },
        ]);
      },
    );

    it("blocks assigned manual trades with equal quantity even when fees and principal differ", async () => {
      const position = await seedPosition();
      await manualTrade(position, { account_id: asAccountId(position.accountId), fees: 1 });
      const batchId = await stageSource(position, [
        { units: 5.00000002, fees: 2, price: 120 },
      ]);
      await assertBlockedWithoutWrites(
        position,
        batchId,
        "existing_history_overlap",
        [1],
      );
    });

    it("blocks a nearby dividend despite different amount and tax treatment", async () => {
      const position = await seedPosition();
      await manualTrade(position, {
        type: "dividend",
        amount: 10,
        units: undefined,
        price_per_unit: undefined,
        taxes: 2,
      });
      const batchId = await stageSource(position, [
        { route: "cash" },
        {
          type: "dividend",
          date: "2026-01-03",
          amount: 12,
          units: 0,
          price: 0,
          taxes: 3,
        },
      ]);
      await assertBlockedWithoutWrites(
        position,
        batchId,
        "existing_history_overlap",
        [2],
      );
    });

    it("uses the user override investment for historical overlap checks", async () => {
      const sourcePosition = await seedPosition();
      const existingPosition = await seedPosition();
      await manualTrade(existingPosition);
      const batchId = await stageSource(sourcePosition, [
        { overrideInvestmentId: existingPosition.investmentId, fees: 2 },
      ]);
      await assertBlockedWithoutWrites(
        sourcePosition,
        batchId,
        "existing_history_overlap",
        [1],
      );
      expect(await canonicalCounts(existingPosition)).toEqual({
        portfolio: 1,
        cash: 0,
      });
    });

    it("imports a complete maintained source with no historical overlap", async () => {
      const position = await seedPosition();
      const batchId = await stageSource(position, [{ route: "cash" }, {}]);
      expect(await commitReviewedPortfolioImport({ batchId })).toEqual({
        imported: 2,
        duplicates: 0,
        errors: 0,
      });
      expect(await canonicalCounts(position)).toEqual({
        portfolio: 1,
        cash: 1,
      });
    });

    it("allows distinct quantities and events outside the seven-day overlap window", async () => {
      const position = await seedPosition();
      await manualTrade(position);
      const batchId = await stageSource(position, [
        { units: 6 },
        { date: "2026-01-09" },
      ]);
      expect(await commitReviewedPortfolioImport({ batchId })).toEqual({
        imported: 2,
        duplicates: 0,
        errors: 0,
      });
      expect(await canonicalCounts(position)).toEqual({
        portfolio: 3,
        cash: 0,
      });
    });

    it("settles a repeated source identity as a duplicate even beside a nearby manual trade", async () => {
      const position = await seedPosition();
      const source = [{ route: "cash" }, {}];
      expect(
        await commitReviewedPortfolioImport({
          batchId: await stageSource(position, source),
        }),
      ).toEqual({
        imported: 2,
        duplicates: 0,
        errors: 0,
      });
      await manualTrade(position);
      const before = await canonicalCounts(position);
      // ADR-236: an exact fingerprint is a duplicate; the manual trade is
      // left for the owner instead of planning a duplicate repair.
      expect(
        await commitReviewedPortfolioImport({
          batchId: await stageSource(position, source),
        }),
      ).toEqual({
        imported: 0,
        duplicates: 2,
        errors: 0,
      });
      expect(await canonicalCounts(position)).toEqual(before);
    });

    it("does not exempt a fingerprint stored at a different account", async () => {
      const position = await seedPosition();
      const otherPosition = await seedPosition();
      const manual = await manualTrade(position);
      const canonical = await manualTrade(position, {
        account_id: asAccountId(otherPosition.accountId),
      });
      const batchId = await stageSource(position, [{}]);
      await pool.query(
        `UPDATE portfolio_transactions SET dedup_fingerprint = $2, dedup_fingerprint_version = 1 WHERE id = $1`,
        [must(canonical, "canonical").id, hash(`fingerprint:${position.accountId}:0`)],
      );
      await assertBlockedWithoutWrites(
        position,
        batchId,
        "existing_history_overlap",
        [1],
      );
      expect(must(manual, "manual").id).not.toBe(must(canonical, "canonical").id);
    });

    it("preserves generic partial-commit behavior", async () => {
      const position = await seedPosition();
      await manualTrade(position);
      const batchId = await stageSource(
        position,
        [{ route: "cash" }, {}, { status: "error" }],
        {
          adapter: "generic",
          config: {},
        },
      );
      expect(await commitReviewedPortfolioImport({ batchId })).toEqual({
        imported: 2,
        duplicates: 0,
        errors: 0,
      });
      expect(await canonicalCounts(position)).toEqual({
        portfolio: 2,
        cash: 1,
      });
      expect(
        must((
          await pool.query<DbRow>(
            "SELECT status FROM portfolio_import_batches WHERE id = $1",
            [batchId],
          )
        ).rows[0], "query row").status,
      ).toBe("complete_with_errors");
    });

    // PostgreSQL proved the wait through pg_locks: the import's
    // SHARE ROW EXCLUSIVE lock request queued behind the manual writer. Under
    // SQLite (ADR-263) the single writer lock provides that exclusion: the
    // import's withTransaction() queues on it (getPoolStats().waitingCount)
    // until the manual writer commits, then sees the manual trade.
    it("waits for an in-flight exact manual insert before adopting it without duplicates", async () => {
      const position = await seedPosition();
      const batchId = await stageSource(position, [{ route: "cash" }, {}]);
      let releaseWriter!: () => void;
      const writerGate = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let markInserted!: () => void;
      const inserted = new Promise<void>((resolve) => {
        markInserted = resolve;
      });
      const writer = withTransaction(async (client) => {
        await client.query(
          `INSERT INTO portfolio_transactions (investment_id, type, date, units, price_per_unit, amount, currency)
           VALUES ($1, 'buy', '2026-01-01', '5.00000000', '100.000000', '500.0000', 'EUR')`,
          [position.investmentId],
        );
        markInserted();
        await writerGate;
      });
      let pending:
        | Promise<{ value: unknown } | { error: unknown }>
        | undefined;
      try {
        await inserted;
        // Called from outside the writer's callback, so it does not join the
        // manual transaction.
        pending = commitReviewedPortfolioImport({ batchId }).then(
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
        // Nothing of the import is visible while the manual writer holds on.
        expect(await canonicalCounts(position)).toEqual({
          portfolio: 0,
          cash: 0,
        });
        releaseWriter();
        await writer;
        expect(await pending).toMatchObject({
          value: { imported: 1, duplicates: 1, errors: 0 },
        });
        expect(await canonicalCounts(position)).toEqual({
          portfolio: 1,
          cash: 1,
        });
      } finally {
        releaseWriter();
        await writer;
        if (pending) await pending;
      }
    });
  },
);
