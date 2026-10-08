import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, it, expect } from "vitest";
import { installFreshBaseline } from "../src/database/freshBaseline.ts";
const run = promisify(execFile);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const isolated =
  process.env.VISION_TEST_DB_ISOLATED === "1" &&
  Boolean(process.env.TEST_DATABASE_URL);
const prior = "0124_portfolio_income_recognition";
const cashOrigin = "0125_brokerage_cash_origin";
const target = "0126_income_recognition_check_name";
async function disposable(fn) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  const name = `vision_additive_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url.toString() });
  const directory = await mkdtemp(path.join(os.tmpdir(), "vision-additive-"));
  await admin.connect();
  let client;
  try {
    await admin.query(
      `CREATE DATABASE "${name}" WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    url.pathname = `/${name}`;
    const connectionString = url.toString();
    client = new pg.Client({ connectionString });
    await client.connect();
    const env = {
      ...process.env,
      DATABASE_URL: connectionString,
      DATABASE_URL_MIGRATIONS: connectionString,
      VISION_SKIP_CONFIG_ENV_LOCAL: "1",
      VISION_CACHE_DIR: directory,
    };
    delete env.VISION_BASELINE_BRIDGE_APPROVED;
    const boot = () =>
      run(
        process.execPath,
        [path.join(root, "apps/node-backend/scripts/db-migrate.js"), "upgrade"],
        { cwd: root, env, timeout: 120000 },
      );
    const alembic = (...args) =>
      run(
        process.env.ALEMBIC_BIN || "alembic",
        ["-c", path.join(root, "config/alembic.ini"), ...args],
        { cwd: root, env, timeout: 120000 },
      );
    await fn({ client, connectionString, env, boot, alembic, directory });
  } finally {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
async function revision(client) {
  return (await client.query("SELECT version_num FROM alembic_version")).rows[0]
    .version_num;
}
async function retained(client) {
  return {
    transactions: (
      await client.query(
        "SELECT to_jsonb(t)-'income_recognition_role' AS data FROM portfolio_transactions t ORDER BY id",
      )
    ).rows,
    receipts: (
      await client.query(
        "SELECT to_jsonb(t) AS data FROM portfolio_import_reconciliation_journal t ORDER BY id",
      )
    ).rows,
    legacy: (
      await client.query(
        "SELECT to_jsonb(t) AS data FROM schema_version t ORDER BY id",
      )
    ).rows,
  };
}
describe.skipIf(!isolated)(
  "automatic reviewed additive migration registration",
  () => {
    it("guards brokerage-origin downgrade and preserves raw receipts after guarded cash removal", async () => {
      await disposable(async ({ client, connectionString, alembic, boot }) => {
        await installFreshBaseline({ repoRoot: root, connectionString });
        await boot();
        const account = (
          await client.query(
            "INSERT INTO accounts(name,type,currency) VALUES('Synthetic downgrade cash','brokerage','EUR') RETURNING id",
          )
        ).rows[0].id;
        const batch = (
          await client.query(
            "INSERT INTO portfolio_import_batches(adapter_name,status,account_id) VALUES('synthetic_cash_downgrade','complete',$1) RETURNING id",
            [account],
          )
        ).rows[0].id;
        const recipient = (
          await client.query(
            "INSERT INTO recipients(name,normalized_name) VALUES('Synthetic downgrade recipient','synthetic downgrade recipient') RETURNING id",
          )
        ).rows[0].id;
        const cash = (
          await client.query(
            "INSERT INTO transactions(account_id,recipient_id,date,amount,currency,memo,is_transfer,transfer_source) VALUES($1,$2,'2026-01-01',1,'EUR','Synthetic transfer',true,'brokerage'),($1,$2,'2026-01-01',-1,'EUR','Synthetic expense',false,'brokerage') RETURNING id",
            [account, recipient],
          )
        ).rows;
        const raw = JSON.stringify({
          primaryRawData: "Synthetic original",
          portfolioCashReceipt: {
            version: 1,
            proof: { kind: "closed_kinesis_cash" },
            after: { id: cash[0].id },
          },
        });
        const staged = (
          await client.query(
            "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) VALUES($1,0,'committed',$2) RETURNING id",
            [batch, raw],
          )
        ).rows[0].id;
        await expect(alembic("downgrade", prior)).rejects.toThrow(
          /before downgrade/,
        );
        // Each migration commits on its own, so 0126 has already stepped down.
        expect(await revision(client)).toBe(cashOrigin);
        await client.query(
          "UPDATE transactions SET is_active=false WHERE account_id=$1",
          [account],
        );
        await expect(alembic("downgrade", prior)).rejects.toThrow(
          /before downgrade/,
        );
        await client.query("DELETE FROM transactions WHERE account_id=$1", [
          account,
        ]);
        await client.query(
          "UPDATE portfolio_import_staging_rows SET status='matched',committed_txn_id=NULL WHERE id=$1",
          [staged],
        );
        await alembic("downgrade", prior);
        expect(await revision(client)).toBe(prior);
        expect(
          (
            await client.query(
              "SELECT raw_data FROM portfolio_import_staging_rows WHERE id=$1",
              [staged],
            )
          ).rows[0].raw_data,
        ).toBe(raw);
        await expect(
          client.query(
            "INSERT INTO transactions(account_id,recipient_id,date,amount,currency,memo,transfer_source) VALUES($1,$2,'2026-01-01',1,'EUR','Invalid old origin','brokerage')",
            [account, recipient],
          ),
        ).rejects.toThrow(/chk_transactions_transfer_source/);
        await boot();
        expect(await revision(client)).toBe(target);
        await expect(
          client.query(
            "UPDATE portfolio_import_staging_rows SET raw_data='Changed' WHERE id=$1",
            [staged],
          ),
        ).rejects.toThrow(/immutable/);
      });
    }, 120000);
    it("boots a populated legacy-shaped0124 profile to the additive head without rewriting rows/old receipts or running the bridge", async () => {
      await disposable(
        async ({ client, connectionString, alembic, boot, directory }) => {
          await installFreshBaseline({ repoRoot: root, connectionString });
          await alembic("upgrade", prior);
          // A retained legacy object distinguishes this from the canonical bridge.
          await client.query(
            "CREATE TABLE schema_version(id integer PRIMARY KEY,version text NOT NULL,recorded_at timestamp without time zone NOT NULL); INSERT INTO schema_version VALUES(1,'synthetic legacy marker','2021-10-06 12:34:56')",
          );
          const investment = (
            await client.query(
              "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Synthetic migration canary','MIGRATION','metals','EUR') RETURNING id",
            )
          ).rows[0].id;
          const batch = (
            await client.query(
              "INSERT INTO portfolio_import_batches(adapter_name,status) VALUES('synthetic_migration','complete') RETURNING id",
            )
          ).rows[0].id;
          const row = (
            await client.query(
              "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) VALUES($1,0,'duplicate','Synthetic retained receipt') RETURNING id",
              [batch],
            )
          ).rows[0].id;
          const tx = (
            await client.query(
              "INSERT INTO portfolio_transactions(investment_id,type,date,units,amount,price_per_unit,fees,taxes,currency,note) VALUES($1,'gift','2021-10-06',0.01234567,0,0,0,0,'EUR','Preserve manual note') RETURNING id",
              [investment],
            )
          ).rows[0].id;
          await client.query(
            "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt','preserve_existing',$4,$4)",
            [
              batch,
              row,
              tx,
              JSON.stringify({
                id: tx,
                date: "2021-10-06",
                units: "0.01234567",
                note: "Preserve manual note",
              }),
            ],
          );
          const before = await retained(client);
          const files = (await readdir(path.join(root, "alembic/versions")))
            .filter((name) => name.endsWith(".py") && !name.startsWith("_"))
            .sort();
          // Reproduce a stale success cache that already contains the new payload.
          await writeFile(
            path.join(directory, "alembic-head.json"),
            JSON.stringify({ head: prior, fingerprint: files.join(",") }),
          );
          const result = await boot();
          expect(result.stdout).not.toContain("bridge deferred");
          expect(await revision(client)).toBe(target);
          expect(await retained(client)).toEqual(before);
          expect(
            (
              await client.query(
                "SELECT income_recognition_role FROM portfolio_transactions WHERE id=$1",
                [tx],
              )
            ).rows,
          ).toEqual([{ income_recognition_role: "standard" }]);
          expect(
            (
              await client.query(
                "SELECT conname FROM pg_constraint WHERE conrelid='public.portfolio_transactions'::regclass AND conname LIKE '%portfolio_income_recognition_role'",
              )
            ).rows,
          ).toEqual([{ conname: "chk_portfolio_income_recognition_role" }]);
          expect(
            (
              await client.query(
                "SELECT COUNT(*)::int AS n FROM portfolio_import_income_recognition_journal",
              )
            ).rows[0].n,
          ).toBe(0);
          expect(
            (
              await client.query(
                "SELECT data_type FROM information_schema.columns WHERE table_name='schema_version' AND column_name='recorded_at'",
              )
            ).rows[0].data_type,
          ).toBe("timestamp without time zone");
          const audit = (
            await client.query(
              "SELECT COUNT(*)::int AS n FROM audit_chain_entries",
            )
          ).rows[0].n;
          const cache = JSON.parse(
            await readFile(path.join(directory, "alembic-head.json"), "utf8"),
          );
          expect(cache.head).toBe(target);
          const repeat = await boot();
          expect(repeat.stdout).toContain("cached head matches DB");
          expect(repeat.stdout).not.toContain("0118_audit_retention_pruner");
          expect(await retained(client)).toEqual(before);
          expect(
            (
              await client.query(
                "SELECT COUNT(*)::int AS n FROM audit_chain_entries",
              )
            ).rows[0].n,
          ).toBe(audit);
        },
      );
    }, 120000);
    it("keeps existing0118 profiles deferred without installing0120-0126 or executing0119", async () => {
      await disposable(async ({ client, connectionString, alembic, boot }) => {
        await installFreshBaseline({ repoRoot: root, connectionString });
        await alembic("downgrade", "0118_audit_retention_pruner");
        await client.query(
          "CREATE TABLE schema_version(id integer PRIMARY KEY,version text); INSERT INTO schema_version VALUES(1,'Preserve legacy shape')",
        );
        const before = (
          await client.query(
            "SELECT to_jsonb(t) AS data FROM audit_chain_entries t ORDER BY sequence",
          )
        ).rows;
        const result = await boot();
        expect(result.stdout).toContain(
          "0119 bridge awaits approved maintenance",
        );
        expect(await revision(client)).toBe("0118_audit_retention_pruner");
        expect(
          (
            await client.query(
              "SELECT to_regclass('portfolio_import_income_recognition_journal') AS journal",
            )
          ).rows[0].journal,
        ).toBeNull();
        expect(
          (
            await client.query(
              "SELECT to_jsonb(t) AS data FROM audit_chain_entries t ORDER BY sequence",
            )
          ).rows,
        ).toEqual(before);
      });
    }, 120000);
    it("refuses an unregistered revision and leaves the existing marker and domain data untouched", async () => {
      await disposable(async ({ client, connectionString, alembic, boot }) => {
        await installFreshBaseline({ repoRoot: root, connectionString });
        await alembic("upgrade", prior);
        await client.query(
          "UPDATE alembic_version SET version_num='0125_unregistered_extension'",
        );
        const before = (
          await client.query(
            "SELECT to_jsonb(t) AS data FROM audit_chain_entries t ORDER BY sequence",
          )
        ).rows;
        await expect(boot()).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "not registered for automatic additive upgrades",
          ),
        });
        expect(await revision(client)).toBe("0125_unregistered_extension");
        expect(
          (
            await client.query(
              "SELECT to_jsonb(t) AS data FROM audit_chain_entries t ORDER BY sequence",
            )
          ).rows,
        ).toEqual(before);
      });
    }, 120000);
    it("keeps the empty fresh installer and subsequent warm boot at0124", async () => {
      await disposable(async ({ client, boot }) => {
        await boot();
        expect(await revision(client)).toBe(target);
        expect(
          (
            await client.query(
              "SELECT column_default FROM information_schema.columns WHERE table_name='portfolio_transactions' AND column_name='income_recognition_role'",
            )
          ).rows[0].column_default,
        ).toContain("standard");
        const audit = (
          await client.query(
            "SELECT COUNT(*)::int AS n FROM audit_chain_entries",
          )
        ).rows[0].n;
        const result = await boot();
        expect(result.stdout).toContain("cached head matches DB");
        expect(result.stdout).not.toContain("0118_audit_retention_pruner");
        expect(await revision(client)).toBe(target);
        expect(
          (
            await client.query(
              "SELECT COUNT(*)::int AS n FROM audit_chain_entries",
            )
          ).rows[0].n,
        ).toBe(audit);
      });
    }, 120000);
  },
);
