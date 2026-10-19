/**
 * Backup Coverage Enforcement Tests
 *
 * These tests ensure that BACKUP_COVERED_TABLES stays in sync with the schema
 * built by db/migrations.  A new migration that creates a table not listed in the
 * registry will fail CI here, forcing the developer to update backup coverage.
 *
 * No database connection required — all assertions are static / file-based.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  __BACKUP_COVERED_TABLES as BACKUP_COVERED_TABLES,
  __BACKUP_EXCLUDED_TABLES as BACKUP_EXCLUDED_TABLES,
} from "../src/backup/coverage.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "../../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "db", "migrations");

// ---------------------------------------------------------------------------
// Helper: derive the net table set from db/migrations
// ---------------------------------------------------------------------------

const IDENT = String.raw`"?([a-z_][a-z0-9_]*)"?`;
const QUALIFIED = String.raw`(?:"?[a-z_][a-z0-9_]*"?\.)?${IDENT}`;

/**
 * Replay every up migration (0001_baseline.sql first) in order and track the
 * public tables it creates, drops and renames. Down migrations are excluded:
 * rollback DDL does not describe the current schema.
 */
function deriveMigrationTableSet() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();

  const schema = new Set<string>();
  const TOKEN_RE = new RegExp(
    String.raw`(?:(CREATE)\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|(DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?|(ALTER)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s+RENAME\s+TO\s+)${QUALIFIED}`,
    "gi",
  );

  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const m of content.matchAll(TOKEN_RE)) {
      const table = m[5]!.toLowerCase();
      if (m[1]) schema.add(table);
      else if (m[2]) schema.delete(table);
      else if (m[3]) {
        schema.delete(m[4]!.toLowerCase());
        schema.add(table);
      }
    }
  }

  return schema;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BACKUP_COVERED_TABLES registry", () => {
  it("is a non-empty frozen array sorted alphabetically", () => {
    expect(Array.isArray(BACKUP_COVERED_TABLES)).toBe(true);
    expect(BACKUP_COVERED_TABLES.length).toBeGreaterThan(0);

    const sorted = [...BACKUP_COVERED_TABLES].sort();
    expect([...BACKUP_COVERED_TABLES]).toEqual(sorted);

    // Verify it is actually frozen
    expect(Object.isFrozen(BACKUP_COVERED_TABLES)).toBe(true);
  });

  it("contains no duplicates", () => {
    const unique = new Set(BACKUP_COVERED_TABLES);
    expect(unique.size).toBe(BACKUP_COVERED_TABLES.length);
  });

  it("matches the net table set derived from db/migrations", () => {
    const migrationTables = deriveMigrationTableSet();

    // Tables in migrations but not in registry → backup gap (CI blocker)
    const missingFromRegistry = [...migrationTables].filter(
      (t) =>
        !BACKUP_COVERED_TABLES.includes(t) && !(t in BACKUP_EXCLUDED_TABLES),
    );

    // Tables in registry but not in migrations → stale entry (cleanup needed)
    const staleInRegistry = [...BACKUP_COVERED_TABLES].filter(
      (t) => !migrationTables.has(t),
    );

    expect(
      missingFromRegistry,
      [
        "These tables exist in the schema but are NOT covered by backup.",
        "Add them to BACKUP_COVERED_TABLES in apps/node-backend/src/backup/coverage.ts",
        "or to BACKUP_EXCLUDED_TABLES with a documented reason.",
        `Missing: ${missingFromRegistry.join(", ")}`,
      ].join("\n"),
    ).toEqual([]);

    expect(
      staleInRegistry,
      [
        "These tables are in BACKUP_COVERED_TABLES but no longer exist in the schema.",
        "Remove them from the registry.",
        `Stale: ${staleInRegistry.join(", ")}`,
      ].join("\n"),
    ).toEqual([]);
  });

  it("explicitly accounts for all known excluded tables", () => {
    const migrationTables = deriveMigrationTableSet();

    for (const excluded of Object.keys(BACKUP_EXCLUDED_TABLES)) {
      // Each excluded table must either have never existed or been truly dropped.
      // If it shows up in the net migration set, it was wrongly excluded.
      expect(
        migrationTables.has(excluded),
        `"${excluded}" is listed in BACKUP_EXCLUDED_TABLES but still exists in the net schema. ` +
          "Move it to BACKUP_COVERED_TABLES.",
      ).toBe(false);
    }
  });
});

describe("localStorage keys registry", () => {
  it("every localStorage.setItem/getItem call in frontend uses a registered key", () => {
    const frontendSrc = join(REPO_ROOT, "apps/frontend/src");
    const keysContent = readFileSync(
      join(frontendSrc, "lib/localStorage-keys.ts"),
      "utf8",
    );

    // Extract all string literals registered in LOCAL_STORAGE_KEYS
    const registeredKeys = new Set();
    const keyValueRe = /:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = keyValueRe.exec(keysContent)) !== null) {
      registeredKeys.add(m[1]);
    }

    // Also collect excluded keys
    const excludedContent =
      keysContent.match(/LOCAL_STORAGE_EXCLUDED_KEYS[\s\S]*?\]/)?.[0] ?? "";
    const excludedKeys = new Set();
    const excludedRe = /['"]([^'"]+)['"]/g;
    while ((m = excludedRe.exec(excludedContent)) !== null) {
      excludedKeys.add(m[1]);
    }

    const allKnownKeys = new Set([...registeredKeys, ...excludedKeys]);

    // Scan source files for raw localStorage string literals
    const sourceFiles = findTsFiles(frontendSrc);
    const unregisteredUsages = [];

    const usageRe = /localStorage\.[gs]etItem\s*\(\s*['"]([^'"]+)['"]/g;
    for (const file of sourceFiles) {
      if (file.endsWith("localStorage-keys.ts")) continue;
      const src = readFileSync(file, "utf8");
      usageRe.lastIndex = 0;
      while ((m = usageRe.exec(src)) !== null) {
        const key = m[1];
        if (!allKnownKeys.has(key)) {
          unregisteredUsages.push({ file: file.replace(frontendSrc, ""), key });
        }
      }
    }

    expect(
      unregisteredUsages,
      [
        "These localStorage keys are used in source but not registered in localStorage-keys.ts:",
        ...unregisteredUsages.map((u) => `  "${u.key}" in ${u.file}`),
        "Add them to LOCAL_STORAGE_KEYS or LOCAL_STORAGE_EXCLUDED_KEYS.",
      ].join("\n"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts / .tsx files under a directory.
 * Skips node_modules, dist, and .turbo.
 * @param {string} dir
 * @returns {string[]}
 */
function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo"
      )
        continue;
      results.push(...findTsFiles(full));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      results.push(full);
    }
  }
  return results;
}
