/**
 * Runs the portfolio import review reads that no workflow suite reaches
 * (batch list/detail, preview rows) and the batch-config reads against a
 * migrated PostgreSQL database, so a row schema in
 * src/database/rows/portfolioImport.ts that disagrees with what pg really
 * returns fails here (tests run the contracts in throw mode).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import {
  getBatch,
  getPreviewRows,
  listBatches,
  lockBatchForUpdate,
} from "../src/repositories/portfolioImportBatchRepository.ts";
import { readReconciliationBatchScope } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { batchConfigFields } from "../src/database/rows/portfolioImport.ts";

const pool = getTestPool();
const created = { batchIds: [] as string[], investmentIds: [] as number[] };

async function insertBatch(customConfig: string): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO portfolio_import_batches
       (adapter_name, source_filename, source_size_bytes, custom_config,
        status, rows_total)
     VALUES ('portfolio_generic', 'synthetic.csv', 42, $1::jsonb,
             'awaiting_review', 2)
     RETURNING id`,
    [customConfig],
  );
  const id = result.rows[0]!.id;
  created.batchIds.push(id);
  return id;
}

describe.skipIf(!hasTestDatabase())(
  "portfolio import row contracts against PostgreSQL",
  () => {
    let objectBatch: string;
    let textBatch: string;

    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
      const investment = await pool!.query<{ id: number }>(
        `INSERT INTO investments (name, symbol, asset_class, currency)
         VALUES ('Synthetic Row Contract Fund', 'SYNRC', 'stock', 'EUR')
         RETURNING id`,
      );
      const investmentId = investment.rows[0]!.id;
      created.investmentIds.push(investmentId);
      objectBatch = await insertBatch(
        JSON.stringify({ date_format: "%Y-%m-%d", source_columns: ["Date"] }),
      );
      // A config stored as a JSONB string: the readers tolerate it.
      textBatch = await insertBatch(
        JSON.stringify(JSON.stringify({ format: "saxo_transaction_history" })),
      );
      await pool!.query(
        `INSERT INTO portfolio_import_staging_rows
           (batch_id, row_index, status, route, tx_date, type, type_raw,
            symbol_raw, name_raw, units, price_per_unit, amount, fees, taxes,
            currency, fx_rate_to_eur, note, match_source,
            resolved_investment_id)
         VALUES
           ($1, 0, 'matched', 'portfolio', '2026-01-05', 'buy', 'BUY',
            'SYNRC', 'Synthetic', 2, 50, 100, 0, 0, 'EUR', 1, 'synthetic',
            'symbol', $2),
           ($1, 1, 'error', NULL, NULL, NULL, 'UNKNOWN', NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        [objectBatch, investmentId],
      );
    }, 180000);

    afterAll(async () => {
      try {
        await pool!.query(
          "DELETE FROM portfolio_import_staging_rows WHERE batch_id = ANY($1::bigint[])",
          [created.batchIds],
        );
        await pool!.query(
          "DELETE FROM portfolio_import_batches WHERE id = ANY($1::bigint[])",
          [created.batchIds],
        );
        await pool!.query("DELETE FROM investments WHERE id = ANY($1)", [
          created.investmentIds,
        ]);
      } finally {
        await releaseDbSuiteLock();
        await closePool();
        await closeTestPool();
      }
    });

    it("lists and reads batches with their total", async () => {
      const { batches, total } = await listBatches({ limit: 500 });
      expect(total).toBeGreaterThanOrEqual(2);
      expect(batches.map((batch) => batch.id)).toEqual(
        expect.arrayContaining([objectBatch, textBatch]),
      );
      const batch = await getBatch(objectBatch);
      expect(batch).toMatchObject({
        id: objectBatch,
        source_size_bytes: "42",
        status: "awaiting_review",
        rows_total: 2,
      });
      expect(batch?.started_at).toBeInstanceOf(Date);
    });

    it("reads preview rows with and without an effective investment", async () => {
      const rows = await getPreviewRows(objectBatch);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        row_index: 0,
        tx_date: "2026-01-05",
        units: expect.any(String),
        investment_symbol: "SYNRC",
        effective_investment_id: created.investmentIds[0],
      });
      expect(rows[1]).toMatchObject({
        row_index: 1,
        tx_date: null,
        units: null,
        effective_investment_id: null,
        investment_name: null,
      });
    });

    it("accepts a batch config stored as an object or as JSON text", async () => {
      const scope = await readReconciliationBatchScope([
        objectBatch,
        textBatch,
      ]);
      expect(typeof scope[0]!.custom_config).toBe("object");
      expect(typeof scope[1]!.custom_config).toBe("string");
      // Readers that do not parse the text see a config without fields.
      expect(batchConfigFields(scope[1]!.custom_config)?.format).toBe(
        undefined,
      );
      const locked = await lockBatchForUpdate(textBatch);
      expect(typeof locked?.custom_config).toBe("string");
    });
  },
);
