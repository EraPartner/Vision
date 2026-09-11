#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import pg from "../apps/node-backend/node_modules/pg/esm/index.mjs";

const { Client } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const target = new URL(databaseUrl);
if (
  target.hostname !== "127.0.0.1" ||
  target.pathname.replace(/^\//, "") !== "vision_test"
) {
  throw new Error(
    "Legacy-retirement lifecycle test requires the disposable loopback vision_test database",
  );
}

function migrate(args, shouldPass) {
  const result = spawnSync(
    process.execPath,
    ["run", "apps/node-backend/scripts/db-migrate.js", ...args],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  if ((result.status === 0) !== shouldPass) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[REDACTED_DATABASE_URL]")
      .trim();
    throw new Error(
      `Migration ${args.join(" ")} ${shouldPass ? "failed" : "unexpectedly passed"}${
        output ? `:\n${output}` : ""
      }`,
    );
  }
}

function expectCount(result, expected, message) {
  if (Number(result.rows[0]?.count) !== expected) throw new Error(message);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  migrate(["downgrade", "0103_import_identity_provenance"], true);

  await client.query(
    "INSERT INTO import_batches (adapter_name, status) VALUES ('_retirement_active', 'pending')",
  );
  migrate(["upgrade", "0104_drop_dormant_import_bank_resolution"], false);
  await client.query(
    "DELETE FROM import_batches WHERE adapter_name = '_retirement_active'",
  );

  const recipient = await client.query(
    "INSERT INTO recipients (name, normalized_name) VALUES ('_retirement', '_retirement') RETURNING id",
  );
  const bankAccount = await client.query(
    "INSERT INTO recipient_bank_accounts (recipient_id, account_number) VALUES ($1, '_retirement') RETURNING id",
    [recipient.rows[0].id],
  );
  const batch = await client.query(
    "INSERT INTO import_batches (adapter_name, status) VALUES ('_retirement_resolved', 'complete') RETURNING id",
  );
  await client.query(
    "INSERT INTO import_staging_rows (batch_id, row_index, resolved_bank_account_id) VALUES ($1, 0, $2)",
    [batch.rows[0].id, bankAccount.rows[0].id],
  );
  migrate(["upgrade", "0104_drop_dormant_import_bank_resolution"], false);
  await client.query("DELETE FROM import_staging_rows WHERE batch_id = $1", [
    batch.rows[0].id,
  ]);
  await client.query("DELETE FROM import_batches WHERE id = $1", [
    batch.rows[0].id,
  ]);
  await client.query("DELETE FROM recipient_bank_accounts WHERE id = $1", [
    bankAccount.rows[0].id,
  ]);
  await client.query("DELETE FROM recipients WHERE id = $1", [
    recipient.rows[0].id,
  ]);

  migrate(["upgrade", "0104_drop_dormant_import_bank_resolution"], true);
  expectCount(
    await client.query(
      "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'import_staging_rows' AND column_name = 'resolved_bank_account_id'",
    ),
    0,
    "Successful upgrade did not drop resolved_bank_account_id",
  );

  await client.query(
    "INSERT INTO exchange_rate_cache (from_ccy, to_ccy, rate_date, rate) VALUES ('EUR', 'USD', CURRENT_DATE, 1.1)",
  );
  migrate(["upgrade", "head"], false);
  expectCount(
    await client.query("SELECT count(*) FROM exchange_rate_cache"),
    1,
    "Populated-table refusal did not preserve exchange_rate_cache",
  );
  await client.query("TRUNCATE exchange_rate_cache");

  await client.query(
    "ALTER TABLE exchange_rate_cache ADD COLUMN unexpected text",
  );
  migrate(["upgrade", "head"], false);
  await client.query("ALTER TABLE exchange_rate_cache DROP COLUMN unexpected");

  await client.query(
    "ALTER TABLE exchange_rate_cache ALTER COLUMN rate SET DEFAULT 1",
  );
  migrate(["upgrade", "head"], false);
  await client.query(
    "ALTER TABLE exchange_rate_cache ALTER COLUMN rate DROP DEFAULT",
  );

  await client.query(
    "ALTER TABLE exchange_rate_cache ALTER COLUMN id SET DEFAULT 42",
  );
  migrate(["upgrade", "head"], false);
  await client.query(
    "ALTER TABLE exchange_rate_cache ALTER COLUMN id SET DEFAULT nextval('exchange_rate_cache_id_seq'::regclass)",
  );

  await client.query("DROP INDEX idx_exchange_rate_cache_date");
  await client.query(
    "CREATE INDEX idx_exchange_rate_cache_date ON exchange_rate_cache (to_ccy)",
  );
  migrate(["upgrade", "head"], false);
  await client.query("DROP INDEX idx_exchange_rate_cache_date");
  await client.query(
    "CREATE INDEX idx_exchange_rate_cache_date ON exchange_rate_cache (rate_date)",
  );

  await client.query(
    "CREATE FUNCTION _retirement_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'",
  );
  await client.query(
    "CREATE TRIGGER _retirement_trigger BEFORE INSERT ON exchange_rate_cache FOR EACH ROW EXECUTE FUNCTION _retirement_trigger()",
  );
  migrate(["upgrade", "head"], false);
  await client.query("DROP TRIGGER _retirement_trigger ON exchange_rate_cache");
  await client.query("DROP FUNCTION _retirement_trigger()");

  await client.query("DROP TABLE exchange_rate_cache");
  migrate(["upgrade", "head"], true);
  expectCount(
    await client.query(
      "SELECT count(*) FROM pg_class WHERE oid = to_regclass('public.exchange_rate_cache')",
    ),
    0,
    "Fresh-install no-op created exchange_rate_cache",
  );

  migrate(["downgrade", "0104_drop_dormant_import_bank_resolution"], true);
  expectCount(
    await client.query("SELECT count(*) FROM exchange_rate_cache"),
    0,
    "Downgrade did not recreate an empty exchange_rate_cache",
  );
  const fetchedAt = await client.query(
    "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'exchange_rate_cache' AND column_name = 'fetched_at'",
  );
  if (
    fetchedAt.rows.length !== 1 ||
    fetchedAt.rows[0].is_nullable !== "NO" ||
    !fetchedAt.rows[0].column_default?.includes("now()")
  ) {
    throw new Error(
      "Downgrade did not restore the legacy fetched_at NOT NULL default shape",
    );
  }
  migrate(["upgrade", "head"], true);

  migrate(["downgrade", "0105_retire_legacy_exchange_rate_cache"], true);
  await client.query(
    `INSERT INTO user_settings (key, value)
     VALUES ('belgian_tax_profile_snapshot_meta_v1', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        2025: {
          frozenCalculation: {
            federalPITBeforeExemption: 11,
            federalPITTotal: 10,
          },
        },
      }),
    ],
  );
  migrate(["upgrade", "head"], false);
  expectCount(
    await client.query(
      `SELECT count(*) FROM user_settings
       WHERE key = 'belgian_tax_profile_snapshot_meta_v1'
         AND (value #> '{2025,frozenCalculation}') ? 'federalPITTotal'`,
    ),
    1,
    "Divergent-alias refusal did not preserve federalPITTotal",
  );

  await client.query(
    `UPDATE user_settings
        SET value = $1::jsonb
      WHERE key = 'belgian_tax_profile_snapshot_meta_v1'`,
    [
      JSON.stringify({
        2025: {
          status: "frozen",
          frozenCalculation: {
            federalPITBeforeExemption: 10,
            federalPITTotal: 10,
            totalPIT: 8,
          },
        },
      }),
    ],
  );
  migrate(["upgrade", "head"], true);
  expectCount(
    await client.query(
      `SELECT count(*) FROM user_settings
       WHERE key = 'belgian_tax_profile_snapshot_meta_v1'
         AND (value #> '{2025,frozenCalculation}') ? 'federalPITTotal'`,
    ),
    0,
    "Successful upgrade did not remove federalPITTotal",
  );
  migrate(["downgrade", "0105_retire_legacy_exchange_rate_cache"], true);
  expectCount(
    await client.query(
      `SELECT count(*) FROM user_settings
       WHERE key = 'belgian_tax_profile_snapshot_meta_v1'
         AND (value #> '{2025,frozenCalculation,federalPITTotal}') = '10'::jsonb`,
    ),
    1,
    "Downgrade did not recreate federalPITTotal from the canonical value",
  );
  migrate(["upgrade", "head"], true);

  migrate(["downgrade", "0103_import_identity_provenance"], true);
  expectCount(
    await client.query(
      "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'import_staging_rows' AND column_name = 'resolved_bank_account_id'",
    ),
    1,
    "Downgrade did not restore resolved_bank_account_id",
  );
  expectCount(
    await client.query(
      "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_import_staging_rows_resolved_bank_account_id'",
    ),
    1,
    "Downgrade did not restore the bank-resolution index",
  );
  migrate(["upgrade", "head"], true);

  console.log(
    "Guarded bank-resolution, exchange-cache, and federal-PIT-alias retirement lifecycles passed.",
  );
} finally {
  await client.end();
}
