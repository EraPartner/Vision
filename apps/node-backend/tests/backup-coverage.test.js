/**
 * Backup Coverage Enforcement Tests
 *
 * These tests ensure that BACKUP_COVERED_TABLES stays in sync with the actual
 * Alembic schema.  A new migration that creates a table not listed in the
 * registry will fail CI here, forcing the developer to update backup coverage.
 *
 * No database connection required — all assertions are static / file-based.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  BACKUP_COVERED_TABLES,
  BACKUP_EXCLUDED_TABLES,
} from "../src/backup/coverage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "../../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "alembic", "versions");

// ---------------------------------------------------------------------------
// Helper: derive the net table set from alembic migrations
// ---------------------------------------------------------------------------

/**
 * Parse all alembic migration files and simulate the schema after all
 * upgrade() calls have run.
 *
 * Handles three authoring styles found in Vision migrations:
 *   1. Raw SQL string constants at module level (0001-style baseline)
 *      → CREATE TABLE ... in text before `def upgrade()`
 *   2. Raw SQL inside op.execute() strings within upgrade()
 *      → CREATE TABLE / DROP TABLE in upgrade body text
 *   3. SQLAlchemy Alembic API calls within upgrade()
 *      → op.create_table('name', ...) / op.drop_table('name')
 *   4. Literal renames (0087-style conversion migrations)
 *      → ALTER TABLE a RENAME TO b — the old name leaves the schema, the new
 *        name enters it. Only literal names are tracked; dynamically built
 *        renames (f-strings/plpgsql) reference tables this parser never saw
 *        created, so they cannot desync the set.
 *
 * For correctness inside a single migration (e.g. 0014 drops then re-creates
 * the same table) the upgrade body tokens are processed IN SEQUENCE, not as
 * two independent sets.
 *
 * downgrade() bodies are intentionally excluded — rollback DDL should not
 * affect the current-schema computation.
 *
 * @returns {Set<string>}
 */
function deriveMigrationTableSet() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".py") && !f.startsWith("__"))
    .sort(); // alphabetical = chronological given the 0001_ prefix naming

  const schema = new Set();

  // Matches both raw SQL and SQLAlchemy API create calls.
  // Group 1 captures the table name.
  const CREATE_RE =
    /(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|op\.create_table\s*\(\s*['"])([a-z_][a-z0-9_]*)/gi;

  // Matches both raw SQL and SQLAlchemy API drop calls.
  const DROP_RE =
    /(?:DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?|op\.drop_table\s*\(\s*['"])([a-z_][a-z0-9_]*)/gi;

  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    // Split into: text before upgrade(), the upgrade() body, the rest.
    const upgradeIdx = content.search(/\ndef upgrade\s*\(/);
    const downgradeIdx = content.search(/\ndef downgrade\s*\(/);

    // Pre-upgrade: module-level SQL string constants (0001 baseline style).
    // Only CREATE TABLE is expected here; DROP would be unusual.
    const preUpgrade = upgradeIdx >= 0 ? content.slice(0, upgradeIdx) : "";

    // Upgrade body: from after "def upgrade():" until "def downgrade()" or EOF.
    const upgradeStart = upgradeIdx >= 0 ? upgradeIdx : 0;
    const upgradeEnd =
      downgradeIdx > upgradeStart ? downgradeIdx : content.length;
    const upgradeBody = content.slice(upgradeStart, upgradeEnd);

    // Step 1: apply pre-upgrade creates (module-level SQL constants).
    CREATE_RE.lastIndex = 0;
    for (const m of preUpgrade.matchAll(CREATE_RE)) {
      schema.add(m[1].toLowerCase());
    }

    // Step 2: process upgrade body tokens IN SEQUENCE so that drop+re-create
    // within the same migration is handled correctly.
    const TOKEN_RE =
      /(?:(CREATE)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|(DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?|op\.(create_table|drop_table)\s*\(\s*['"]|(ALTER)\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+RENAME\s+TO\s+)([a-z_][a-z0-9_]*)/gi;

    for (const m of upgradeBody.matchAll(TOKEN_RE)) {
      // m[1]: CREATE keyword (raw SQL create)
      // m[2]: DROP keyword (raw SQL drop)
      // m[3]: op.create_table | op.drop_table (alembic API)
      // m[4]: ALTER keyword (raw SQL rename) — m[5] is the old table name
      // m[6]: table name (created / dropped / rename target)
      const table = m[6].toLowerCase();
      const isCreate = !!(m[1] || m[3] === "create_table");
      const isDrop = !!(m[2] || m[3] === "drop_table");
      const isRename = !!m[4];

      if (isCreate) schema.add(table);
      else if (isDrop) schema.delete(table);
      else if (isRename) {
        schema.delete(m[5].toLowerCase());
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

  it("matches the net table set derived from alembic migrations", () => {
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
        "Add them to BACKUP_COVERED_TABLES in apps/node-backend/src/backup/coverage.js",
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
  it("LOCAL_STORAGE_KEYS can be imported and is non-empty", async () => {
    // Dynamic import resolves from the frontend src tree.
    // We verify the file exists and exports the expected shape.
    const keysPath = join(
      REPO_ROOT,
      "apps/frontend/src/lib/localStorage-keys.ts",
    );
    const content = readFileSync(keysPath, "utf8");

    // Assert all expected semantic keys are present in the file
    const requiredKeys = [
      "vision_theme",
      "vision_theme_variant",
      "vision.backup.passphrase.reminder.dismissed",
      "dismissed_upcoming_planned_payments",
      "dismissed_recurring_patterns",
      "vision.onboarding.draft.v1",
      "vision.research.chartBuilder.layouts.v2",
    ];

    for (const key of requiredKeys) {
      expect(
        content,
        `localStorage key "${key}" missing from localStorage-keys.ts`,
      ).toContain(key);
    }
  });

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
function findTsFiles(dir) {
  const results = [];
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
