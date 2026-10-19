/**
 * Reviewed duplicate repair receipts on the migrated schema: the journal is
 * append-only, its provenance cannot be deleted from under it, and only an
 * exact inverse receipt can restore a repair.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { hasTestDatabase } from "./setup/db.ts";
import {
  createMigratedDatabase,
  hasIsolatedTestDatabase,
} from "./setup/migratedDatabase.ts";
import type { DisposableDatabase } from "./setup/migratedDatabase.ts";

let scratch: DisposableDatabase | undefined;
let db: pg.Client;

describe.skipIf(!hasTestDatabase() || !hasIsolatedTestDatabase())(
  "portfolio duplicate repair journal",
  () => {
    beforeAll(async () => {
      scratch = await createMigratedDatabase("c_repairs");
      db = new pg.Client({ connectionString: scratch.url });
      await db.connect();
    }, 180000);
    afterAll(async () => {
      if (db) await db.end();
      await scratch?.drop();
    });

    it("keeps repair receipts immutable, protects their provenance, and validates inverse receipts", async () => {
      const batch = (
        await db.query(
          "INSERT INTO portfolio_import_batches(adapter_name,status) VALUES ('synthetic','complete') RETURNING id",
        )
      ).rows[0].id;
      const row = (
        await db.query(
          "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) VALUES ($1,0,'duplicate','Synthetic repair lifecycle source') RETURNING id",
          [batch],
        )
      ).rows[0].id;
      const before = {
        legacy: { id: 1, updated_at: "before" },
        imported: { id: 2 },
        originalBatch: { rows_imported: 1 },
        originalStaging: [
          { id: row, status: "committed", updated_at: "before" },
        ],
      };
      const after = {
        legacy: { id: 1, updated_at: "after" },
        imported: null,
        originalBatch: { rows_imported: 0 },
        originalStaging: [
          { id: row, status: "duplicate", updated_at: "after" },
        ],
      };
      const receipt = (
        await db.query(
          "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$1,1,2,'repair','prefer_source',$3,$4) RETURNING id",
          [batch, row, JSON.stringify(before), JSON.stringify(after)],
        )
      ).rows[0].id;
      await expect(
        db.query(
          "UPDATE portfolio_import_duplicate_repair_journal SET policy='preserve_existing' WHERE id=$1",
          [receipt],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        db.query("DELETE FROM portfolio_import_batches WHERE id=$1", [batch]),
      ).rejects.toThrow(/foreign key constraint/);
      await expect(
        db.query(
          "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data,previous_entry_id) VALUES($1,$2,$1,1,2,'restore','prefer_source',$3,$4,$5)",
          [
            batch,
            row,
            JSON.stringify(after),
            JSON.stringify({ ...before, imported: null }),
            receipt,
          ],
        ),
      ).rejects.toThrow(
        "Invalid portfolio duplicate repair restoration receipt",
      );
      const restored = {
        ...before,
        legacy: { ...before.legacy, updated_at: "restored" },
        originalStaging: [
          { ...before.originalStaging[0], updated_at: "restored" },
        ],
      };
      await db.query(
        "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data,previous_entry_id) VALUES($1,$2,$1,1,2,'restore','prefer_source',$3,$4,$5)",
        [batch, row, JSON.stringify(after), JSON.stringify(restored), receipt],
      );
      expect(
        (
          await db.query(
            "SELECT action FROM portfolio_import_duplicate_repair_journal WHERE batch_id=$1 ORDER BY id",
            [batch],
          )
        ).rows.map((r: { action: string }) => r.action),
      ).toEqual(["repair", "restore"]);
    });
  },
);
