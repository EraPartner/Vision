#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaselineSchemaInventory } from "../apps/node-backend/src/database/baselineManifest.js";

const expectedPath = process.argv[2];
if (!expectedPath || !path.isAbsolute(expectedPath)) {
  throw new Error(
    "Pass an absolute path to a reviewed synthetic schema inventory",
  );
}
const connectionString =
  process.env.DATABASE_URL_MIGRATIONS?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("Migration database URL is required");
const url = new URL(connectionString);
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
) {
  throw new Error("Schema comparison requires a local PostgreSQL URL");
}
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
if (
  !Array.isArray(expected) ||
  !expected.every((entry) => Array.isArray(entry) && entry.length === 3)
) {
  throw new Error("Expected inventory is invalid");
}

try {
  const actual = await readBaselineSchemaInventory({
    connectionString,
    repoRoot,
  });
  const counts = new Map();
  for (const entry of expected) {
    const key = JSON.stringify(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const entry of actual) {
    const key = JSON.stringify(entry);
    counts.set(key, (counts.get(key) || 0) - 1);
  }
  const differences = [...counts].filter(([, count]) => count !== 0);
  const names = differences.map(([key, count]) => {
    const [kind, name] = JSON.parse(key);
    return `${count > 0 ? "expected" : "actual"}:${kind}:${name}`;
  });
  const expectedByName = new Map(
    expected.map((entry) => [`${entry[0]}:${entry[1]}`, entry[2]]),
  );
  const actualByName = new Map(
    actual.map((entry) => [`${entry[0]}:${entry[1]}`, entry[2]]),
  );
  const changedColumns = [...expectedByName]
    .filter(
      ([key, value]) =>
        key.startsWith("column:") &&
        actualByName.has(key) &&
        JSON.stringify(value) !== JSON.stringify(actualByName.get(key)),
    )
    .slice(0, 16)
    .map(([key, value]) => ({
      name: key.slice("column:".length),
      expected: value,
      actual: actualByName.get(key),
    }));
  const differingByKind = Object.fromEntries(
    [...new Set(differences.map(([key]) => JSON.parse(key)[0]))].map((kind) => [
      kind,
      differences.filter(([key]) => JSON.parse(key)[0] === kind).length,
    ]),
  );
  console.log(
    JSON.stringify({
      matches: differences.length === 0,
      expectedObjects: expected.length,
      actualObjects: actual.length,
      differingEntries: differences.length,
      differingByKind,
      firstDifferences: names.slice(0, 40),
      changedColumns,
    }),
  );
} catch (error) {
  console.error(`Schema comparison failed (${error.code || error.name})`);
  process.exitCode = 1;
}
