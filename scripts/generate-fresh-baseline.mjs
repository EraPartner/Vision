#!/usr/bin/env node

// Transform a reviewed, empty PostgreSQL 18 dump into the fresh-install SQL.
// Refuse any unexpected row so a dump of financial data cannot become an artifact.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  __hashAuditEntry,
} from "../apps/node-backend/src/lib/auditChainCore.js";

const revision = "0119_squashed_baseline";
const allowedRows = new Map([
  ["adr109_legacy_cleanup_marker", 1],
  ["alembic_version", 1],
  ["audit_chain_entries", 2],
  ["audit_chain_head", 1],
  ["insight_digest_state", 1],
]);
const expectedTables = new Map(allowedRows);
const dumpPath = process.argv[2];
const outputPath = process.argv[3];
if (!dumpPath || !outputPath || process.argv.length !== 4) {
  throw new Error(
    "Usage: generate-fresh-baseline.mjs <synthetic-full-dump> <output-sql>",
  );
}
if (resolve(dumpPath) === resolve(outputPath)) {
  throw new Error("Input and output must differ");
}

const payload = {
  stream: "schema_migration",
  event: "baseline_installed",
  direction: "bootstrap",
  revision,
  heads: [revision],
};
const hash = __hashAuditEntry({
  sequence: 1,
  previousHash: AUDIT_CHAIN_GENESIS_HASH,
  payload,
});
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const insertLines = {
  adr109_legacy_cleanup_marker:
    'INSERT INTO "public"."adr109_legacy_cleanup_marker" VALUES (true, now());',
  alembic_version: `INSERT INTO "public"."alembic_version" VALUES (${quote(revision)});`,
  audit_chain_entries: `INSERT INTO "public"."audit_chain_entries" ("sequence", "version", "previous_hash", "entry_hash", "payload") VALUES (1, 1, ${quote(AUDIT_CHAIN_GENESIS_HASH)}, ${quote(hash)}, ${quote(JSON.stringify(payload))}::jsonb);`,
  audit_chain_head: `INSERT INTO "public"."audit_chain_head" ("singleton", "last_sequence", "last_hash", "legacy_db_editor_max_id", "legacy_split_max_id", "legacy_retag_max_id") VALUES (true, 1, ${quote(hash)}, 0, 0, 0);`,
};

const original = readFileSync(dumpPath, "utf8");
if (!original.includes("Dumped from database version 18.")) {
  throw new Error("A PostgreSQL 18 full SQL dump is required");
}
const lines = original.split("\n");
const result = [
  "-- Vision reviewed PostgreSQL 18 fresh-install baseline.",
  "-- Generated from a disposable 0118 database after all six guarded manual contracts.",
  "-- Historical migration files remain available for existing-install upgrades.",
];
for (const line of lines) {
  if (/^\\(?:un)?restrict\b/.test(line)) continue;
  if (/^-- Dumped (?:from database|by pg_dump) version /.test(line)) continue;
  // The native administrator owns preinstalled extensions and public schema.
  // Their comments are not part of the application contract and the migration
  // role cannot rewrite them.
  if (/^COMMENT ON EXTENSION /.test(line)) continue;
  if (/^COMMENT ON SCHEMA "public" /.test(line)) continue;
  if (/^COPY\s/i.test(line) || /^\\(?!restrict\b|unrestrict\b)/.test(line)) {
    throw new Error("Input must be a plain --inserts SQL dump");
  }
  const match = /^INSERT INTO "public"\."([a-z0-9_]+)" VALUES \(/.exec(line);
  if (!match) {
    if (/^INSERT INTO /.test(line)) {
      throw new Error("Unexpected inserted relation in input dump");
    }
    result.push(line);
    continue;
  }
  const table = match[1];
  if (!allowedRows.has(table)) {
    throw new Error(`Unexpected seed row in ${table}`);
  }
  allowedRows.set(table, allowedRows.get(table) - 1);
  if (allowedRows.get(table) < 0) {
    throw new Error(`Too many seed rows in ${table}`);
  }
  if (table === "audit_chain_entries") {
    if (allowedRows.get(table) === 1) result.push(insertLines[table]);
  } else {
    result.push(insertLines[table] ?? line);
  }
}
for (const [table, remaining] of allowedRows) {
  if (remaining !== 0 || expectedTables.get(table) < 1) {
    throw new Error(`Missing expected synthetic seed row in ${table}`);
  }
}
const output = `${result.join("\n").trimEnd()}\n`;
writeFileSync(outputPath, output, { flag: "wx", mode: 0o644 });
console.log(
  `Fresh baseline ${revision}: ${output.length} bytes, five seed rows`,
);
