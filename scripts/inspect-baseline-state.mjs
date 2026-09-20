#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "../apps/node-backend/node_modules/pg/lib/index.js";

const connectionString =
  process.env.DATABASE_URL_MIGRATIONS?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("Migration database URL is required");
const url = new URL(connectionString);
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
) {
  throw new Error("Baseline inspection requires a local PostgreSQL URL");
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fingerprintSql = readFileSync(
  path.join(repoRoot, "alembic", "baseline", "schema_fingerprint.sql"),
  "utf8",
);
const reviewedContracted0113 =
  "2d8e56cc83e4af35a5e611cbc8001d5e04650dd46acf6ac35c3ecc89c3b564b8";
const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
});

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const state = await client.query(`
    SELECT current_setting('server_version_num')::int / 10000 AS postgres_major,
           to_regclass('public.alembic_version') IS NOT NULL AS has_version,
           (SELECT count(*)::int FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND backend_type = 'client backend') AS other_clients
  `);
  const hasVersion = state.rows[0].has_version;
  const revision = hasVersion
    ? await client.query("SELECT version_num FROM public.alembic_version")
    : { rows: [] };
  const fingerprint = await client.query(fingerprintSql);
  await client.query("ROLLBACK");
  console.log(
    JSON.stringify({
      postgresMajor: state.rows[0].postgres_major,
      revision: revision.rows.map((row) => row.version_num),
      schemaFingerprint: fingerprint.rows[0]?.schema_fingerprint,
      matchesReviewedContracted0113:
        revision.rows.length === 1 &&
        revision.rows[0].version_num === "0113_scoped_ai_references" &&
        fingerprint.rows[0]?.schema_fingerprint === reviewedContracted0113,
      otherClients: state.rows[0].other_clients,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`Baseline inspection failed (${error.code || error.name})`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
