import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import { commitReviewedPortfolioImport } from "../src/services/portfolioImportCommitService.js";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.js";

const pool = getTestPool();
const fixtures = { accountIds: [], investmentIds: [], batchIds: [] };
const hash = (value) => createHash("sha256").update(value).digest("hex");
let fixtureSequence = 0;

async function seedPosition() {
  fixtureSequence++;
  const accountId = (
    await pool.query(
      `INSERT INTO accounts (name, institution, type, is_active, currency)
       VALUES ($1, 'READINESS TEST BROKER', 'brokerage', true, 'EUR')
       RETURNING id`,
      [`READINESS TEST ACCOUNT ${fixtureSequence}`],
    )
  ).rows[0].id;
  fixtures.accountIds.push(accountId);
  const investmentId = (
    await pool.query(
      `INSERT INTO investments (name, symbol, asset_class, currency)
       VALUES ('Readiness test stock', 'READINESSTEST', 'stock', 'EUR') RETURNING id`,
    )
  ).rows[0].id;
  fixtures.investmentIds.push(investmentId);
  return { accountId, investmentId };
}

async function manualTrade(position, fields = {}) {
  return portfolioTransactionService.create({
    investment_id: position.investmentId,
    type: "buy",
    date: "2026-01-01",
    units: 5,
    price_per_unit: 100,
    currency: "EUR",
    ...fields,
  });
}

async function stageSource(position, source, opts = {}) {
  const batchId = Number(
    (
      await pool.query(
        `INSERT INTO portfolio_import_batches
           (adapter_name, custom_config, status, rows_total, rows_error, account_id, is_brokerage)
         VALUES ($1, $2, 'awaiting_review', $3, $4, $5, true) RETURNING id`,
        [
          opts.adapter ?? "custom",
          JSON.stringify(opts.config ?? { format: "saxo_transaction_history" }),
          source.length,
          source.filter((row) => row.status === "error").length,
          position.accountId,
        ],
      )
    ).rows[0].id,
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
       VALUES ($1, $2, $3, $4, $5, $6::portfolio_txn_type, $7, $8, $9, $10,
               $11, $12, 'EUR', $13, $14, $15, $16, $17, 1, 1)`,
      [
        batchId,
        rowIndex,
        row.status ?? "matched",
        row.date ?? "2026-01-01",
        cash ? "Deposit" : type,
        type,
        cash ? "cash" : "portfolio",
        units,
        price,
        row.amount ?? (cash ? 500 : units * price),
        row.fees ?? 0,
        row.taxes ?? 0,
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

async function canonicalCounts(position) {
  return (
    await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM portfolio_transactions WHERE investment_id = $1) AS portfolio,
              (SELECT COUNT(*)::int FROM transactions WHERE account_id = $2) AS cash`,
      [position.investmentId, position.accountId],
    )
  ).rows[0];
}

async function assertBlockedWithoutWrites(position, batchId, reason, ordinals) {
  const before = await canonicalCounts(position);
  const stagingBefore = (
    await pool.query(
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
              expect.objectContaining({ rowOrdinal }),
            ),
          }
        : { reason, count: ordinals.length, row_ordinals: ordinals },
  });
  expect(await canonicalCounts(position)).toEqual(before);
  expect(
    (
      await pool.query(
        `SELECT row_index, status, committed_txn_id, raw_data, dedup_fingerprint
           FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index`,
        [batchId],
      )
    ).rows,
  ).toEqual(stagingBefore);
  expect(
    (
      await pool.query(
        "SELECT status FROM portfolio_import_batches WHERE id = $1",
        [batchId],
      )
    ).rows[0].status,
  ).toBe("awaiting_review");
}

describe.skipIf(!hasTestDatabase())(
  "maintained portfolio import readiness (real Postgres)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      // Every fixture owns the disposable database under the suite advisory lock.
      await pool.query(
        "TRUNCATE portfolio_import_reconciliation_journal RESTART IDENTITY",
      );
      await pool.query(
        "TRUNCATE portfolio_import_duplicate_repair_journal RESTART IDENTITY",
      );
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
            await pool.query(
              "SELECT account_id, import_batch_id, dedup_fingerprint FROM portfolio_transactions WHERE id = $1",
              [existing.id],
            )
          ).rows,
        ).toEqual([
          { account_id: null, import_batch_id: null, dedup_fingerprint: null },
        ]);
      },
    );

    it("blocks assigned manual trades with equal quantity even when fees and principal differ", async () => {
      const position = await seedPosition();
      await manualTrade(position, { account_id: position.accountId, fees: 1 });
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

    it("requires reviewed repair when a source identity and a nearby manual trade both exist", async () => {
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
      await assertBlockedWithoutWrites(
        position,
        await stageSource(position, source),
        "existing_history_overlap",
        [2],
      );
      expect(await canonicalCounts(position)).toEqual(before);
    });

    it("does not exempt a fingerprint stored at a different account", async () => {
      const position = await seedPosition();
      const otherPosition = await seedPosition();
      const manual = await manualTrade(position);
      const canonical = await manualTrade(position, {
        account_id: otherPosition.accountId,
      });
      const batchId = await stageSource(position, [{}]);
      await pool.query(
        `UPDATE portfolio_transactions SET dedup_fingerprint = $2, dedup_fingerprint_version = 1 WHERE id = $1`,
        [canonical.id, hash(`fingerprint:${position.accountId}:0`)],
      );
      await assertBlockedWithoutWrites(
        position,
        batchId,
        "existing_history_overlap",
        [1],
      );
      expect(manual.id).not.toBe(canonical.id);
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
        (
          await pool.query(
            "SELECT status FROM portfolio_import_batches WHERE id = $1",
            [batchId],
          )
        ).rows[0].status,
      ).toBe("complete_with_errors");
    });

    it("waits for an in-flight exact manual insert before adopting it without duplicates", async () => {
      const position = await seedPosition();
      const batchId = await stageSource(position, [{ route: "cash" }, {}]);
      const writer = await pool.connect();
      let pending;
      try {
        await writer.query("BEGIN");
        await writer.query(
          `INSERT INTO portfolio_transactions (investment_id, type, date, units, price_per_unit, amount, currency)
           VALUES ($1, 'buy', '2026-01-01', 5, 100, 500, 'EUR')`,
          [position.investmentId],
        );
        pending = commitReviewedPortfolioImport({ batchId }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting =
            (
              await pool.query(
                `SELECT 1 FROM pg_locks
                WHERE relation = 'portfolio_transactions'::regclass
                  AND mode = 'ShareRowExclusiveLock' AND NOT granted`,
              )
            ).rows.length > 0;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await writer.query("COMMIT");
        expect(await pending).toMatchObject({
          value: { imported: 1, duplicates: 1, errors: 0 },
        });
        expect(await canonicalCounts(position)).toEqual({
          portfolio: 1,
          cash: 1,
        });
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
        if (pending) await pending;
      }
    });
  },
);
