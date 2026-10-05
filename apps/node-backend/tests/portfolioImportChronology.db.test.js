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
import { commitBatch } from "../src/services/portfolioImportPipeline/commit.js";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.js";

const pool = getTestPool();
const fixtures = { accountIds: [], investmentIds: [], batchIds: [] };

async function seedPosition() {
  const accountId = (
    await pool.query(
      `INSERT INTO accounts (name, display_name)
       VALUES ('IMPORT CHRONOLOGY TEST', 'IMPORT CHRONOLOGY TEST') RETURNING id`,
    )
  ).rows[0].id;
  fixtures.accountIds.push(accountId);
  const investmentId = (
    await pool.query(
      `INSERT INTO investments (name, symbol, asset_class, currency)
       VALUES ('Import chronology test stock', 'CHRONOTEST', 'stock', 'EUR') RETURNING id`,
    )
  ).rows[0].id;
  fixtures.investmentIds.push(investmentId);
  return { accountId, investmentId };
}

async function stageSource({ accountId, investmentId }, source) {
  const batchId = Number(
    (
      await pool.query(
        `INSERT INTO portfolio_import_batches
           (adapter_name, status, rows_total, account_id, is_brokerage)
         VALUES ('generic', 'awaiting_review', $1, $2, false) RETURNING id`,
        [source.length, accountId],
      )
    ).rows[0].id,
  );
  fixtures.batchIds.push(batchId);
  const occurrences = new Map();
  for (const [rowIndex, row] of source.entries()) {
    const rawData = `${row.date},${row.type},${row.units},${row.price}`;
    const occurrence = (occurrences.get(rawData) ?? 0) + 1;
    occurrences.set(rawData, occurrence);
    const sourceHash = createHash("sha256").update(rawData).digest("hex");
    const fingerprint = createHash("sha256")
      .update(`${investmentId}|${accountId}|${rawData}|${occurrence}`)
      .digest("hex");
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows
         (batch_id, row_index, status, tx_date, type_raw, type, route,
          units, price_per_unit, amount, currency, resolved_investment_id,
          raw_data, source_record_hash, dedup_fingerprint,
          dedup_fingerprint_version, dedup_occurrence)
       VALUES ($1, $2, 'matched', $3, $4::text, $4::text::portfolio_txn_type, 'portfolio',
               $5, $6, $7, 'EUR', $8, $9, $10, $11, 1, $12)`,
      [
        batchId,
        rowIndex,
        row.date,
        row.type,
        row.units,
        row.price,
        row.units * row.price,
        investmentId,
        rawData,
        sourceHash,
        fingerprint,
        occurrence,
      ],
    );
  }
  return batchId;
}

async function stagingProvenance(batchId) {
  return (
    await pool.query(
      `SELECT row_index, raw_data, source_record_hash, dedup_fingerprint,
              dedup_fingerprint_version, dedup_occurrence
         FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index`,
      [batchId],
    )
  ).rows;
}

async function committedTrades(investmentId) {
  return (
    await pool.query(
      `SELECT type, to_char(date, 'YYYY-MM-DD') AS date, units::float8 AS units,
              source_record_hash, dedup_fingerprint, dedup_fingerprint_version
         FROM portfolio_transactions WHERE investment_id = $1 ORDER BY id`,
      [investmentId],
    )
  ).rows;
}

describe.skipIf(!hasTestDatabase())(
  "portfolio import commit chronology (real Postgres)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      for (const investmentId of fixtures.investmentIds) {
        await pool.query(
          "DELETE FROM portfolio_transactions WHERE investment_id = $1",
          [investmentId],
        );
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

    it("funds descending-source sales with earlier buys, preserves provenance and duplicate occurrences, and reimports without changing units", async () => {
      const position = await seedPosition();
      const source = [
        { date: "2026-02-01", type: "sell", units: 8, price: 110 },
        { date: "2026-01-03", type: "buy", units: 2, price: 105 },
        { date: "2026-01-01", type: "buy", units: 5, price: 100 },
        { date: "2026-01-01", type: "buy", units: 5, price: 100 },
      ];
      const batchId = await stageSource(position, source);
      const provenance = await stagingProvenance(batchId);

      expect(await commitBatch({ batchId })).toEqual({
        imported: 4,
        duplicates: 0,
        errors: 0,
      });
      const trades = await committedTrades(position.investmentId);
      expect(
        trades.map(({ date, type, units }) => ({ date, type, units })),
      ).toEqual([
        { date: "2026-01-01", type: "buy", units: 5 },
        { date: "2026-01-01", type: "buy", units: 5 },
        { date: "2026-01-03", type: "buy", units: 2 },
        { date: "2026-02-01", type: "sell", units: 8 },
      ]);
      expect(
        trades.reduce(
          (units, trade) =>
            units + (trade.type === "sell" ? -1 : 1) * trade.units,
          0,
        ),
      ).toBe(4);
      expect(await stagingProvenance(batchId)).toEqual(provenance);
      expect(provenance.map((row) => row.dedup_occurrence)).toEqual([
        1, 1, 1, 2,
      ]);
      expect(trades.map((row) => row.dedup_fingerprint)).toEqual(
        [2, 3, 1, 0].map((index) => provenance[index].dedup_fingerprint),
      );
      expect(trades.map((row) => row.source_record_hash)).toEqual(
        [2, 3, 1, 0].map((index) => provenance[index].source_record_hash),
      );
      expect(trades.every((row) => row.dedup_fingerprint_version === 1)).toBe(
        true,
      );

      const reimportId = await stageSource(position, source);
      expect(await commitBatch({ batchId: reimportId })).toEqual({
        imported: 0,
        duplicates: 4,
        errors: 0,
      });
      expect(await committedTrades(position.investmentId)).toEqual(trades);
      expect(
        (
          await pool.query(
            "SELECT status FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index",
            [reimportId],
          )
        ).rows.map((row) => row.status),
      ).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);
    });

    it("keeps an existing historical buy and imports only missing occurrences before the later sale", async () => {
      const position = await seedPosition();
      const existing = await portfolioTransactionService.create({
        investment_id: position.investmentId,
        account_id: position.accountId,
        type: "buy",
        date: "2026-01-01",
        units: 5,
        price_per_unit: 100,
        currency: "EUR",
      });
      const source = [
        { date: "2026-02-01", type: "sell", units: 8, price: 110 },
        { date: "2026-01-01", type: "buy", units: 5, price: 100 },
        { date: "2026-01-01", type: "buy", units: 5, price: 100 },
      ];
      const batchId = await stageSource(position, source);

      expect(await commitBatch({ batchId })).toEqual({
        imported: 2,
        duplicates: 1,
        errors: 0,
      });
      const trades = await committedTrades(position.investmentId);
      expect(trades.map(({ type, units }) => ({ type, units }))).toEqual([
        { type: "buy", units: 5 },
        { type: "buy", units: 5 },
        { type: "sell", units: 8 },
      ]);
      expect(
        (
          await pool.query(
            "SELECT id, import_batch_id, dedup_fingerprint FROM portfolio_transactions WHERE id = $1",
            [existing.id],
          )
        ).rows,
      ).toEqual([
        { id: existing.id, import_batch_id: null, dedup_fingerprint: null },
      ]);

      const reimportId = await stageSource(position, source);
      expect(await commitBatch({ batchId: reimportId })).toEqual({
        imported: 0,
        duplicates: 3,
        errors: 0,
      });
      expect(await committedTrades(position.investmentId)).toEqual(trades);
    });

    it("preserves source row order for sales and buys sharing a date", async () => {
      const position = await seedPosition();
      const batchId = await stageSource(position, [
        { date: "2026-01-03", type: "sell", units: 3, price: 110 },
        { date: "2026-01-03", type: "buy", units: 2, price: 105 },
        { date: "2026-01-01", type: "buy", units: 5, price: 100 },
      ]);

      expect(await commitBatch({ batchId })).toEqual({
        imported: 3,
        duplicates: 0,
        errors: 0,
      });
      expect(
        (await committedTrades(position.investmentId)).map((row) => row.type),
      ).toEqual(["buy", "sell", "buy"]);
    });

    it("retains the oversell error when a same-day source sale precedes its only funding buy", async () => {
      const position = await seedPosition();
      const batchId = await stageSource(position, [
        { date: "2026-01-03", type: "sell", units: 3, price: 110 },
        { date: "2026-01-03", type: "buy", units: 5, price: 105 },
      ]);

      expect(await commitBatch({ batchId })).toEqual({
        imported: 1,
        duplicates: 0,
        errors: 1,
      });
      const staged = (
        await pool.query(
          "SELECT status, error_message FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index",
          [batchId],
        )
      ).rows;
      expect(staged.map((row) => row.status)).toEqual(["error", "committed"]);
      expect(staged[0].error_message).toMatch(/exceed.*holdings/i);
    });
  },
);
