#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import type * as Pg from "../apps/node-backend/node_modules/@types/pg/index.d.ts";
import { readBaselineManifest } from "../apps/node-backend/src/database/baselineManifest.ts";

type Row = Record<string, unknown>;

/** The source manifest fields this check reads; written by the upgrade tools. */
interface SourceManifest {
  revision: unknown;
  schemaFingerprint: unknown;
  restoreFingerprint: unknown;
  tables: Row[];
}

function isSourceManifest(value: unknown): value is SourceManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "tables" in value &&
    Array.isArray(value.tables) &&
    value.tables.every(
      (table: unknown) => typeof table === "object" && table !== null,
    )
  );
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const requireFromBackend = createRequire(
  path.join(repoRoot, "apps", "node-backend", "package.json"),
);
// pg is a backend dependency; resolve it (and its published types) from there.
const pg: typeof Pg = requireFromBackend("pg");
const sourcePath = process.env.VISION_BASELINE_SOURCE_MANIFEST;
const connectionString = process.env.TEST_DATABASE_URL;
if (
  !sourcePath ||
  !connectionString ||
  process.env.VISION_TEST_DB_ISOLATED !== "1"
) {
  throw new Error(
    "Restore verification requires the disposable database harness",
  );
}
const source: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
if (!isSourceManifest(source)) {
  throw new Error("Source manifest is invalid");
}
const restored = await readBaselineManifest({ connectionString, repoRoot });
const preupgrade = process.env.VISION_BASELINE_RESTORE_STAGE === "preupgrade";
const knownSchemas = new Set([
  "9e634493345024873f8dce83c2fc142d46cf090becf6e519ac56d492a20ea146",
  "8508bf6f1c047ff28ea0eaa3e0381580c7c4e5ea94d5f772b0e4e5a2bd6cbc10",
]);
if (
  (preupgrade
    ? !/^0\d{3}_[a-z0-9_]+$/.test(String(source.revision)) ||
      source.revision === "0119_squashed_baseline" ||
      restored.restoreFingerprint !== source.restoreFingerprint
    : source.revision !== "0118_audit_retention_pruner" ||
      !knownSchemas.has(restored.schemaFingerprint)) ||
  restored.revision !== source.revision ||
  JSON.stringify(restored.tables) !== JSON.stringify(source.tables)
) {
  console.error(
    JSON.stringify({
      sourceRevision: source.revision,
      restoredRevision: restored.revision,
      sourceFingerprint: source.schemaFingerprint,
      restoredFingerprint: restored.schemaFingerprint,
      sourceRestoreFingerprint: source.restoreFingerprint,
      restoredRestoreFingerprint: restored.restoreFingerprint,
      sourceTableCount: source.tables.length,
      restoredTableCount: restored.tables.length,
      differingTables: source.tables
        .filter(
          (table, index) =>
            JSON.stringify(table) !== JSON.stringify(restored.tables[index]),
        )
        .map((table) => `${table.schema}.${table.name}`)
        .slice(0, 10),
    }),
  );
  throw new Error(
    "Restored schema, revision, row counts or row digests differ",
  );
}

const client = new pg.Client({
  connectionString,
  connectionTimeoutMillis: 5_000,
});
await client.connect();
try {
  await client.query("BEGIN");
  const general = `VISION_BASELINE_SMOKE_${randomUUID().replaceAll("-", "")}`;
  const row = await client.query<Row>(
    "INSERT INTO public.categories (general, detail) VALUES ($1, $2) RETURNING id",
    [general, "TEMP"],
  );
  const pathRow = await client.query<Row>(
    preupgrade
      ? "SELECT general, detail FROM public.categories WHERE id = $1"
      : "SELECT path_name FROM public.categories WHERE id = $1",
    [row.rows[0]?.id],
  );
  if (
    row.rows.length !== 1 ||
    (preupgrade
      ? pathRow.rows[0]?.general !== general ||
        pathRow.rows[0]?.detail !== "TEMP"
      : pathRow.rows[0]?.path_name !== `${general}:TEMP`)
  ) {
    throw new Error("Restored category write/read smoke failed");
  }
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
console.log(
  `[baseline-restore] Verified ${restored.tables.length} table digests and a rolled-back write.`,
);
