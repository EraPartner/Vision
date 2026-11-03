/**
 * A populated portfolio import ledger survives the production backup path
 * (ADR-263): `db-file snapshot` (VACUUM INTO, then verify), the bundle writer,
 * AES-256-GCM encryption, openBundle, and the restore verification gate. The
 * restored file then replaces this suite's database, and the custody and
 * paired-income protections are proven on it through the backend's driver.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { copyFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeTestPool,
  getTestPool,
  resetTestDatabase,
} from "./setup/db.ts";
import type { DbRow } from "./setup/db.ts";
import { openDatabase, withTransaction } from "../src/database/connection.ts";
import { LEDGER_TABLE, loadMigrations } from "../src/database/migrate.ts";
import { portfolioIncomeTransactionSnapshotSql } from "../src/database/sqlite/schemaFunctions.ts";
import { snapshotDatabase, verifyDatabaseFile } from "../scripts/db-file.ts";
import { must } from "./helpers/must.ts";

interface IdRow {
  id: number;
}
/** BIGINT ids arrive as strings, as node-postgres returned them. */
interface BigIdRow {
  id: string;
}

/** A JSON boolean from a BOOLEAN (0/1) column, NULL kept. */
const jsonBool = (column: string) =>
  `CASE ${column} WHEN 1 THEN json('true') WHEN 0 THEN json('false') END`;
/**
 * A cash transaction's full image, as Kinesis cash receipts recorded it.
 * DECIMAL_TEXT columns are already their canonical text (PostgreSQL's
 * `amount::text`); the image is canonical jsonb.
 */
const CASH_SNAPSHOT_SQL = `vision_jsonb(json_object('id',t.id,'date',to_char(t.date,'YYYY-MM-DD'),
  'amount',t.amount,'currency',t.currency,'memo',t.memo,'comment',t.comment,'balance',t.balance,
  'account_id',t.account_id,'recipient_id',t.recipient_id,'recipient_bank_account_id',t.recipient_bank_account_id,
  'category_id',t.category_id,'is_active',${jsonBool("t.is_active")},'import_batch_id',t.import_batch_id,
  'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,
  'dedup_fingerprint_version',t.dedup_fingerprint_version,'is_transfer',${jsonBool("t.is_transfer")},
  'transfer_source',t.transfer_source,'transfer_peer_id',t.transfer_peer_id))`;
/** Every portfolio_transactions column, timestamps as their stored text (to_jsonb's form). */
const PT_ROW = `*, created_at AS "created_at::text", updated_at AS "updated_at::text"`;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(import.meta.url);
// Backend tests load the compiled Electron modules (ADR-196).
const { createBundle, encryptBundle, openBundle } = require(
  path.join(repoRoot, "packaging/electron/out/backup/bundle.js"),
) as BundleModule;
const tableNames = [
  "transactions",
  "portfolio_transactions",
  "portfolio_import_batches",
  "portfolio_import_staging_rows",
  "portfolio_import_reconciliation_journal",
  "portfolio_import_duplicate_repair_journal",
  "portfolio_import_income_recognition_journal",
  "portfolio_asset_transfers",
  "portfolio_asset_adjustments",
  "portfolio_asset_adjustment_sources",
  "vision_sequences",
  LEDGER_TABLE,
];
const ORDER_BY: Record<string, string> = {
  portfolio_asset_adjustment_sources: "adjustment_id,staging_row_id",
  vision_sequences: "name",
  [LEDGER_TABLE]: "version",
};
/** The parts of the packaged backup bundle module this suite calls. */
interface BundleModule {
  createBundle: (options: {
    destDir: string;
    deviceId: string;
    appVersion: string;
    databasePath: string;
    database: {
      schemaVersion: number;
      sqliteVersion: string;
      sha256: string;
      bytes: number;
    };
    attachmentsDir: string | null;
    frontendState: { keys: Record<string, string> };
  }) => Promise<{ bundlePath: string }>;
  encryptBundle: (
    bundlePath: string,
    passphrase: string,
  ) => Promise<{ encPath: string }>;
  openBundle: (
    encPath: string,
    options: { passphrase: string },
  ) => Promise<OpenedBundle>;
}
/** The parts of `openBundle`'s result this suite reads. */
interface OpenedBundle {
  metadata: Readonly<Record<string, unknown>>;
  databasePath: string | null;
  frontendState: unknown;
  cleanup(): void;
}
let directory: string, opened: OpenedBundle | undefined;
const pool = getTestPool();
const liveDatabase = () =>
  must(process.env.VISION_DATABASE_PATH, "process.env.VISION_DATABASE_PATH");

/**
 * Every row of the ledger tables exactly as stored: INTEGER values read as
 * bigint, so a REAL or TEXT that only looks equal would not compare equal.
 * Read on a read-only connection of its own, so it never joins the backend's.
 */
function storedRows(file: string) {
  const db = openDatabase(file, "inspect");
  try {
    const result: Record<string, Record<string, unknown>[]> = {};
    for (const name of tableNames) {
      const statement = db.prepare(
        `SELECT * FROM ${name} ORDER BY ${ORDER_BY[name] ?? "id"}`,
      );
      statement.setReadBigInts(true);
      result[name] = statement.all();
    }
    return result;
  } finally {
    db.close();
  }
}

describe("populated portfolio import recovery backup", () => {
  beforeAll(async () => {
    directory = await fs.mkdtemp(
      path.join(
        process.env.VISION_TEST_DB_DIR ?? os.tmpdir(),
        "vision-import-recovery-backup-",
      ),
    );
    await resetTestDatabase();
    const accounts = (
      await pool.query<IdRow>(
        "INSERT INTO accounts(name,type) VALUES ('SYNTHETIC BACKUP EXCHANGE','crypto_exchange'),('SYNTHETIC BACKUP WALLET','wallet') RETURNING id",
      )
    ).rows
      .map((row) => row.id)
      .sort((a, b) => a - b);
    const investment = must((
      await pool.query<IdRow>(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Synthetic recovery asset','RECOVERYTEST','crypto','EUR') RETURNING id",
      )
    ).rows[0], "query row").id;
    const batch = must((
      await pool.query<BigIdRow>(
        "INSERT INTO portfolio_import_batches(adapter_name,status,account_id,custom_config) VALUES ('synthetic_recovery','complete',$1,vision_jsonb($2)) RETURNING id",
        [
          accounts[0],
          JSON.stringify({
            reference: {
              hash: "a".repeat(64),
              placeholder_basis_policy: "zero",
            },
          }),
        ],
      )
    ).rows[0], "query row").id;
    await pool.query(
      "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) SELECT $1,value,'duplicate','Synthetic immutable recovery provenance' FROM json_each('[0,1,2,3]')",
      [batch],
    );
    const rows = (
      await pool.query<BigIdRow>(
        "SELECT id FROM portfolio_import_staging_rows WHERE batch_id=$1 ORDER BY row_index",
        [batch],
      )
    ).rows.map((row) => row.id);
    const transaction = must((
      await pool.query<{ id: number } & DbRow>(
        `INSERT INTO portfolio_transactions(investment_id,account_id,type,date,amount,units,currency,note) VALUES ($1,$2,'gift','2026-01-01','0.0000','10.00000000','EUR','Synthetic preserved manual note') RETURNING ${PT_ROW}`,
        [investment, accounts[0]],
      )
    ).rows[0], "query row");
    await pool.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt','prefer_source',vision_jsonb($4),vision_jsonb($5))",
      [
        batch,
        rows[0],
        transaction.id,
        JSON.stringify({ ...transaction, account_id: null }),
        JSON.stringify(transaction),
      ],
    );
    const before = {
      legacy: transaction,
      imported: { ...transaction, id: transaction.id + 1000 },
      originalBatch: { rows_imported: 1 },
      originalStaging: [{ id: rows[1], status: "committed" }],
    };
    const after = {
      legacy: transaction,
      imported: null,
      originalBatch: { rows_imported: 0 },
      originalStaging: [{ id: rows[1], status: "duplicate" }],
    };
    await pool.query(
      "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$1,$3,$4,'repair','preserve_existing',vision_jsonb($5),vision_jsonb($6))",
      [
        batch,
        rows[1],
        transaction.id,
        transaction.id + 1000,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
    await pool.query(
      "INSERT INTO portfolio_asset_transfers(investment_id,source_account_id,destination_account_id,date,units,fee_units,fee_basis_allocations,import_batch_id,staging_row_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version) VALUES($1,$2,$3,'2026-01-02','2.00000000','0.10000000',vision_jsonb($4),$5,$6,$7,$8,1)",
      [
        investment,
        ...accounts,
        JSON.stringify({
          FIFO: [
            { originalAcquisitionId: transaction.id, units: "0.1", basis: "0" },
          ],
        }),
        batch,
        rows[2],
        "b".repeat(64),
        "c".repeat(64),
      ],
    );
    await pool.query(
      "INSERT INTO portfolio_asset_adjustments(investment_id,account_id,date,units,adjustment_kind,basis_policy,eligible_source_record_hashes,basis_allocations,import_batch_id,staging_row_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version) VALUES($1,$2,'2026-01-03','0.20000000','yield_reversal','zero_yield_only',json_array($3),vision_jsonb($4),$5,$6,$7,$8,1)",
      [
        investment,
        accounts[0],
        "d".repeat(64),
        JSON.stringify({
          FIFO: [
            { originalAcquisitionId: transaction.id, units: "0.2", basis: "0" },
          ],
        }),
        batch,
        rows[3],
        "e".repeat(64),
        "f".repeat(64),
      ],
    );
    await pool.query(
      "INSERT INTO portfolio_asset_adjustment_sources(adjustment_id,staging_row_id,source_record_hash) SELECT id,$1,$2 FROM portfolio_asset_adjustments WHERE staging_row_id=$3",
      [rows[0], "d".repeat(64), rows[3]],
    );
    const incomeBatch = Number(
      must((
        await pool.query<BigIdRow>(
          "INSERT INTO portfolio_import_batches(adapter_name,status,account_id,custom_config) VALUES('kinesis_transaction_history','awaiting_review',$1,vision_jsonb($2)) RETURNING id",
          [
            accounts[0],
            JSON.stringify({
              format: "kinesis_transaction_history",
              yield_basis_policy: "zero",
              kinesis_source_context: { source_file_hash: "1".repeat(64) },
            }),
          ],
        )
      ).rows[0], "query row").id,
    );
    const incomeSource = must((
      await pool.query<BigIdRow>(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data,type,route) VALUES($1,0,'committed','Synthetic paired backup source','dividend','portfolio') RETURNING id",
        [incomeBatch],
      )
    ).rows[0], "query row").id;
    await withTransaction(async (client) => {
      const income = must((
        await client.query<IdRow>(
          "INSERT INTO portfolio_transactions(investment_id,account_id,type,date,amount,fees,taxes,currency,import_batch_id,income_recognition_role) VALUES($1,$2,'dividend','2026-01-01','5.0000','0.0000','0.0000','EUR',$3,'included_in_units') RETURNING id",
          [investment, accounts[0], incomeBatch],
        )
      ).rows[0], "query row").id;
      await client.query(
        `INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,income_data,unit_data,proof_data)
        SELECT $1,$2,$3,i.id,u.id,'record',${portfolioIncomeTransactionSnapshotSql("i")},${portfolioIncomeTransactionSnapshotSql("u")},vision_jsonb($4) FROM portfolio_transactions i,portfolio_transactions u WHERE i.id=$5 AND u.id=$6`,
        [
          incomeBatch,
          incomeSource,
          rows[0],
          JSON.stringify({ sourceFileHash: "1".repeat(64) }),
          income,
          transaction.id,
        ],
      );
    });
    const cashBatch = Number(
      must((
        await pool.query<BigIdRow>(
          "INSERT INTO portfolio_import_batches(adapter_name,status,account_id) VALUES('synthetic_cash_recovery','complete',$1) RETURNING id",
          [accounts[0]],
        )
      ).rows[0], "query row").id,
    );
    const cashRecipient = must((
      await pool.query<IdRow>(
        "INSERT INTO recipients(name,normalized_name) VALUES('Synthetic cash backup recipient','synthetic cash backup recipient') RETURNING id",
      )
    ).rows[0], "query row").id;
    const cashIds = (
      await pool.query<IdRow>(
        "INSERT INTO transactions(account_id,recipient_id,date,amount,currency,memo,is_transfer,transfer_source) VALUES($1,$2,'2026-01-04','-9.0000','EUR','Synthetic net funding',true,'brokerage'),($1,$2,'2026-01-04','-1.0000','EUR','Synthetic funding fee',false,'brokerage') RETURNING id",
        [accounts[0], cashRecipient],
      )
    ).rows
      .map((row) => row.id)
      .sort((a, b) => a - b);
    const cashImages = (
      await pool.query(
        `SELECT ${CASH_SNAPSHOT_SQL} AS "data::json" FROM transactions t WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id`,
        [JSON.stringify(cashIds)],
      )
    ).rows.map((row) => row.data);
    // Synthetic full images exercise backup restoration and evidence protection;
    // literal source validation is covered by the cash scope lifecycle tests.
    await pool.query(
      "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,route,committed_txn_id,raw_data) VALUES($1,0,'committed','cash',$2,$3)",
      [
        cashBatch,
        cashIds[0],
        JSON.stringify({
          primaryRawData: "Synthetic cash backup source",
          portfolioCashReceipt: {
            version: 1,
            proof: { kind: "closed_kinesis_cash", componentCount: 2 },
            after: cashImages[0],
            feeAfter: cashImages[1],
          },
        }),
      ],
    );
  }, 180000);

  afterAll(async () => {
    opened?.cleanup();
    await closeTestPool();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("restores populated journals, lot allocation receipts, source provenance and custody protection triggers from an encrypted production bundle", async () => {
    const live = liveDatabase();
    const expected = storedRows(live);
    for (const name of tableNames)
      expect(must(expected[name], "expected[name]").length).toBeGreaterThan(0);
    const head = must(loadMigrations().at(-1), "latest migration").version;
    expect(
      must((
        await pool.query<{ head: number }>(
          `SELECT max(version) AS head FROM ${LEDGER_TABLE}`,
        )
      ).rows[0], "query row").head,
    ).toBe(head);

    // The production capture: VACUUM INTO a new file, then verify it.
    const snapshot = await snapshotDatabase(
      live,
      path.join(directory, "db.sqlite3"),
    );
    expect(snapshot).toMatchObject({
      ok: true,
      schemaVersion: head,
      pendingMigrations: 0,
    });
    const frontendState = { keys: { "synthetic.import.scope": "[1]" } };
    const { bundlePath } = await createBundle({
      destDir: directory,
      deviceId: "synthetic",
      appVersion: "test",
      databasePath: snapshot.file,
      database: {
        schemaVersion: snapshot.schemaVersion,
        sqliteVersion: snapshot.sqliteVersion,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes,
      },
      attachmentsDir: null,
      frontendState,
    });
    const passphrase = "Synthetic import recovery test passphrase";
    const { encPath } = await encryptBundle(bundlePath, passphrase);
    opened = await openBundle(encPath, { passphrase });
    expect(opened.metadata).toMatchObject({
      bundleVersion: 2,
      database: "sqlite",
      schemaVersion: head,
      databaseSha256: snapshot.sha256,
    });
    expect(opened.frontendState).toEqual(frontendState);
    const restoredFile = must(opened.databasePath, "opened.databasePath");
    // The gate every restore passes before the file is activated.
    expect(await verifyDatabaseFile(restoredFile)).toMatchObject({
      ok: true,
      schemaVersion: head,
      sha256: snapshot.sha256,
      pendingMigrations: 0,
    });

    // A post-backup write proves the restore replaces state rather than
    // accepting an already identical database.
    await pool.query(
      "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) SELECT batch_id,99,'duplicate','Synthetic post-backup row' FROM portfolio_import_staging_rows ORDER BY id LIMIT 1",
    );
    expect(storedRows(live)).not.toEqual(expected);
    // Activate the restored file in place of this suite's database (the
    // backend reopens its connections on the next query).
    await closeTestPool();
    for (const suffix of ["-wal", "-shm"])
      rmSync(`${live}${suffix}`, { force: true });
    copyFileSync(restoredFile, live);

    expect(storedRows(live)).toEqual(expected);
    expect(
      must((
        await pool.query<{ head: number }>(
          `SELECT max(version) AS head FROM ${LEDGER_TABLE}`,
        )
      ).rows[0], "query row").head,
    ).toBe(head);
    await expect(
      pool.query(
        "UPDATE portfolio_transactions SET note='Break active unit image' WHERE type='gift'",
      ),
    ).rejects.toThrow(/paired income/);
    await expect(
      pool.query(
        "DELETE FROM portfolio_transactions WHERE income_recognition_role='included_in_units'",
      ),
    ).rejects.toThrow(/paired income/);
    // nextval() advances vision_sequences, so it runs on the writer.
    const nextId = (name: string) =>
      withTransaction(async (client) =>
        Number(
          must((
            await client.query<{ id: string }>(
              `SELECT nextval($1) AS "id::bigint"`,
              [name],
            )
          ).rows[0], "query row").id,
        ),
      );
    expect(
      await nextId("portfolio_import_income_recognition_journal_id_seq"),
    ).toBeGreaterThan(
      Math.max(
        ...must(expected.portfolio_import_income_recognition_journal, "expected.portfolio_import_income_recognition_jo...").map((row) =>
          Number(row.id),
        ),
      ),
    );
    await expect(
      pool.query("UPDATE portfolio_asset_transfers SET units='3.00000000'"),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query("UPDATE portfolio_asset_adjustments SET units='1.00000000'"),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query(
        "UPDATE portfolio_asset_adjustment_sources SET source_record_hash=$1",
        ["1".repeat(64)],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query("DELETE FROM portfolio_asset_adjustment_sources"),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query("DELETE FROM portfolio_import_batches"),
    ).rejects.toThrow(/foreign key constraint|immutable/);
    expect(
      (
        await pool.query(
          "SELECT is_transfer,transfer_source,transfer_peer_id FROM transactions ORDER BY id",
        )
      ).rows,
    ).toEqual([
      {
        is_transfer: true,
        transfer_source: "brokerage",
        transfer_peer_id: null,
      },
      {
        is_transfer: false,
        transfer_source: "brokerage",
        transfer_peer_id: null,
      },
    ]);
    const maximum = Math.max(
      ...[
        "portfolio_transactions",
        "portfolio_asset_transfers",
        "portfolio_asset_adjustments",
      ].flatMap((name) => must(expected[name], "expected[name]").map((row) => Number(row.id))),
    );
    expect(await nextId("portfolio_transactions_id_seq")).toBeGreaterThan(
      maximum,
    );
  }, 180000);
});
