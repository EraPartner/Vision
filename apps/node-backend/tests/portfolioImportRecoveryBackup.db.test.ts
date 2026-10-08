import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { installFreshBaseline } from "../src/database/freshBaseline.ts";
import { hasTestDatabase } from "./setup/db.ts";
import { __CASH_SNAPSHOT_SQL as CASH_SNAPSHOT_SQL } from "../src/repositories/portfolioImportCashRepository.ts";

const run = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(import.meta.url);
const { createBundle, encryptBundle, openBundle } = require(
  path.join(repoRoot, "packaging/electron/backup/bundle.js"),
);
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
];
const sourceName = `vision_import_backup_source_${process.pid}`;
const restoredName = `vision_import_backup_restored_${process.pid}`;
function urlFor(name: string) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}
/** The parts of `openBundle`'s result this suite reads. */
interface OpenedBundle {
  metadata: { schemaHead: string };
  dbSqlPath: string;
  cleanup(): void;
}
let source: pg.Client,
  restored: pg.Client,
  directory: string,
  opened: OpenedBundle | undefined;
async function snapshot(client: pg.Client) {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const name of tableNames) {
    const order =
      name === "portfolio_asset_adjustment_sources"
        ? "adjustment_id,staging_row_id"
        : "id";
    result[name] = (
      await client.query(
        `SELECT to_jsonb(t) AS data FROM ${name} t ORDER BY ${order}`,
      )
    ).rows.map((row) => row.data);
  }
  return result;
}
async function postgresBin() {
  for (const candidate of [
    process.env.VISION_TEST_POSTGRES_BIN,
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
    "/usr/lib/postgresql/18/bin",
  ].filter((candidate): candidate is string => Boolean(candidate))) {
    try {
      await fs.access(path.join(candidate, "pg_dump"));
      return candidate;
    } catch {
      /* Try the next installed runtime. */
    }
  }
  throw new Error("PostgreSQL backup tools are unavailable");
}

describe.skipIf(
  !hasTestDatabase() || process.env.VISION_TEST_DB_ISOLATED !== "1",
)("populated portfolio import recovery backup", () => {
  beforeAll(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "vision-import-recovery-backup-"),
    );
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      for (const name of [sourceName, restoredName])
        await admin.query(
          `CREATE DATABASE ${name} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
        );
    } finally {
      await admin.end();
    }
    await installFreshBaseline({
      repoRoot,
      connectionString: urlFor(sourceName),
    });
    await run(
      process.env.ALEMBIC_BIN || "alembic",
      ["-c", path.join(repoRoot, "config/alembic.ini"), "upgrade", "head"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: urlFor(sourceName),
          DATABASE_URL_MIGRATIONS: urlFor(sourceName),
        },
        timeout: 120000,
      },
    );
    source = new pg.Client({ connectionString: urlFor(sourceName) });
    restored = new pg.Client({ connectionString: urlFor(restoredName) });
    await source.connect();
    await restored.connect();
    const accounts = (
      await source.query(
        "INSERT INTO accounts(name,type) VALUES ('SYNTHETIC BACKUP EXCHANGE','crypto_exchange'),('SYNTHETIC BACKUP WALLET','wallet') RETURNING id",
      )
    ).rows.map((row) => row.id);
    const investment = (
      await source.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Synthetic recovery asset','RECOVERYTEST','crypto','EUR') RETURNING id",
      )
    ).rows[0].id;
    const batch = (
      await source.query(
        "INSERT INTO portfolio_import_batches(adapter_name,status,account_id,custom_config) VALUES ('synthetic_recovery','complete',$1,$2) RETURNING id",
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
    ).rows[0].id;
    const rows = (
      await source.query(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) SELECT $1,n,'duplicate','Synthetic immutable recovery provenance' FROM generate_series(0,3) n RETURNING id",
        [batch],
      )
    ).rows.map((row) => row.id);
    const transaction = (
      await source.query(
        "INSERT INTO portfolio_transactions(investment_id,account_id,type,date,amount,units,currency,note) VALUES ($1,$2,'gift','2026-01-01',0,10,'EUR','Synthetic preserved manual note') RETURNING to_jsonb(portfolio_transactions) AS data",
        [investment, accounts[0]],
      )
    ).rows[0].data;
    await source.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt','prefer_source',$4,$5)",
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
    await source.query(
      "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$1,$3,$4,'repair','preserve_existing',$5,$6)",
      [
        batch,
        rows[1],
        transaction.id,
        transaction.id + 1000,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
    await source.query(
      "INSERT INTO portfolio_asset_transfers(investment_id,source_account_id,destination_account_id,date,units,fee_units,fee_basis_allocations,import_batch_id,staging_row_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version) VALUES($1,$2,$3,'2026-01-02',2,0.1,$4,$5,$6,$7,$8,1)",
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
    await source.query(
      "INSERT INTO portfolio_asset_adjustments(investment_id,account_id,date,units,adjustment_kind,basis_policy,eligible_source_record_hashes,basis_allocations,import_batch_id,staging_row_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version) VALUES($1,$2,'2026-01-03',0.2,'yield_reversal','zero_yield_only',ARRAY[$3],$4,$5,$6,$7,$8,1)",
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
    await source.query(
      "INSERT INTO portfolio_asset_adjustment_sources(adjustment_id,staging_row_id,source_record_hash) SELECT id,$1,$2 FROM portfolio_asset_adjustments WHERE staging_row_id=$3",
      [rows[0], "d".repeat(64), rows[3]],
    );
    const incomeBatch = Number(
      (
        await source.query(
          "INSERT INTO portfolio_import_batches(adapter_name,status,account_id,custom_config) VALUES('kinesis_transaction_history','awaiting_review',$1,$2) RETURNING id",
          [
            accounts[0],
            JSON.stringify({
              format: "kinesis_transaction_history",
              yield_basis_policy: "zero",
              kinesis_source_context: { source_file_hash: "1".repeat(64) },
            }),
          ],
        )
      ).rows[0].id,
    );
    const incomeSource = (
      await source.query(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data,type,route) VALUES($1,0,'committed','Synthetic paired backup source','dividend','portfolio') RETURNING id",
        [incomeBatch],
      )
    ).rows[0].id;
    await source.query("BEGIN");
    const income = (
      await source.query(
        "INSERT INTO portfolio_transactions(investment_id,account_id,type,date,amount,fees,taxes,currency,import_batch_id,income_recognition_role) VALUES($1,$2,'dividend','2026-01-01',5,0,0,'EUR',$3,'included_in_units') RETURNING id",
        [investment, accounts[0], incomeBatch],
      )
    ).rows[0].id;
    await source.query(
      `INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,income_data,unit_data,proof_data)
      SELECT $1,$2,$3,i.id,u.id,'record',portfolio_income_transaction_snapshot(i),portfolio_income_transaction_snapshot(u),$4 FROM portfolio_transactions i,portfolio_transactions u WHERE i.id=$5 AND u.id=$6`,
      [
        incomeBatch,
        incomeSource,
        rows[0],
        JSON.stringify({ sourceFileHash: "1".repeat(64) }),
        income,
        transaction.id,
      ],
    );
    await source.query("COMMIT");
    const cashBatch = Number(
      (
        await source.query(
          "INSERT INTO portfolio_import_batches(adapter_name,status,account_id) VALUES('synthetic_cash_recovery','complete',$1) RETURNING id",
          [accounts[0]],
        )
      ).rows[0].id,
    );
    const cashRecipient = (
      await source.query(
        "INSERT INTO recipients(name,normalized_name) VALUES('Synthetic cash backup recipient','synthetic cash backup recipient') RETURNING id",
      )
    ).rows[0].id;
    const cashIds = (
      await source.query(
        "INSERT INTO transactions(account_id,recipient_id,date,amount,currency,memo,is_transfer,transfer_source) VALUES($1,$2,'2026-01-04',-9,'EUR','Synthetic net funding',true,'brokerage'),($1,$2,'2026-01-04',-1,'EUR','Synthetic funding fee',false,'brokerage') RETURNING id",
        [accounts[0], cashRecipient],
      )
    ).rows.map((row) => row.id);
    const cashImages = (
      await source.query(
        `SELECT ${CASH_SNAPSHOT_SQL} AS data FROM transactions t WHERE id=ANY($1::integer[]) ORDER BY id`,
        [cashIds],
      )
    ).rows.map((row) => row.data);
    // Synthetic full images exercise dump restoration and evidence protection;
    // literal source validation is covered by the cash scope lifecycle tests.
    await source.query(
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
    if (source) await source.end();
    if (restored) await restored.end();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      for (const name of [sourceName, restoredName])
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("restores populated journals, lot allocation receipts, source provenance and protection triggers from an encrypted production bundle", async () => {
    const expected = await snapshot(source);
    for (const name of tableNames)
      expect(expected[name].length).toBeGreaterThan(0);
    const bin = await postgresBin();
    const dump = path.join(directory, "db.sql");
    await run(
      path.join(bin, "pg_dump"),
      [
        "--dbname",
        urlFor(sourceName),
        "--no-owner",
        "--no-acl",
        "--file",
        dump,
      ],
      { timeout: 120000 },
    );
    const head = (await source.query("SELECT version_num FROM alembic_version"))
      .rows[0].version_num;
    const { bundlePath } = await createBundle({
      destDir: directory,
      deviceId: "synthetic",
      schemaHead: head,
      appVersion: "test",
      dbSqlPath: dump,
      attachmentsDir: null,
      frontendState: { keys: { "synthetic.import.scope": "[1]" } },
    });
    const passphrase = "Synthetic import recovery test passphrase";
    const { encPath } = await encryptBundle(bundlePath, passphrase);
    opened = (await openBundle(encPath, { passphrase })) as OpenedBundle;
    expect(opened.metadata.schemaHead).toBe(head);
    await run(
      path.join(bin, "psql"),
      [
        "--dbname",
        urlFor(restoredName),
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "--file",
        opened.dbSqlPath,
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(await snapshot(restored)).toEqual(expected);
    expect(
      (await restored.query("SELECT version_num FROM alembic_version")).rows[0]
        .version_num,
    ).toBe(head);
    await expect(
      restored.query(
        "UPDATE portfolio_import_reconciliation_journal SET policy='exact'",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      restored.query("DELETE FROM portfolio_import_duplicate_repair_journal"),
    ).rejects.toThrow("immutable");
    await expect(
      restored.query(
        "UPDATE portfolio_import_income_recognition_journal SET proof_data=proof_data",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      restored.query(
        "UPDATE portfolio_transactions SET note='Break active unit image' WHERE type='gift'",
      ),
    ).rejects.toThrow(/paired income/);
    await expect(
      restored.query(
        "DELETE FROM portfolio_transactions WHERE income_recognition_role='included_in_units'",
      ),
    ).rejects.toThrow(/paired income/);
    expect(
      Number(
        (
          await restored.query(
            "SELECT nextval('portfolio_import_income_recognition_journal_id_seq') AS id",
          )
        ).rows[0].id,
      ),
    ).toBeGreaterThan(
      Math.max(
        ...expected.portfolio_import_income_recognition_journal.map((row) =>
          Number(row.id),
        ),
      ),
    );
    await expect(
      restored.query("UPDATE portfolio_asset_transfers SET units=3"),
    ).rejects.toThrow("immutable");
    await expect(
      restored.query("UPDATE portfolio_asset_adjustments SET units=1"),
    ).rejects.toThrow("immutable");
    await expect(
      restored.query(
        "UPDATE portfolio_asset_adjustment_sources SET source_record_hash=$1",
        ["1".repeat(64)],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      restored.query("DELETE FROM portfolio_asset_adjustment_sources"),
    ).rejects.toThrow("immutable");
    await expect(
      restored.query("DELETE FROM portfolio_import_batches"),
    ).rejects.toThrow(/foreign key constraint|immutable/);
    await expect(
      restored.query(
        "UPDATE portfolio_import_staging_rows SET raw_data='Changed cash receipt' WHERE route='cash'",
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      restored.query(
        "DELETE FROM portfolio_import_staging_rows WHERE route='cash'",
      ),
    ).rejects.toThrow(/immutable/);
    expect(
      (
        await restored.query(
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
      ].flatMap((name) => expected[name].map((row) => Number(row.id))),
    );
    expect(
      Number(
        (
          await restored.query(
            "SELECT nextval('portfolio_transactions_id_seq') AS id",
          )
        ).rows[0].id,
      ),
    ).toBeGreaterThan(maximum);
  }, 180000);
});
