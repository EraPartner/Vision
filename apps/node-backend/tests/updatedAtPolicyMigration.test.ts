import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migration = readFileSync(
  path.join(repoRoot, "alembic/versions/0092_updated_at_policy.py"),
  "utf8",
);

const existingTimestampTables = [
  "exchange_rates",
  "user_settings",
  "ai_conversations",
  "provider_health",
];
const newTimestampTables = [
  "investment_ticker_prefs",
  "import_staging_rows",
  "portfolio_import_staging_rows",
];

describe("migration 0092 updated_at policy", () => {
  it("covers every audited mutable table with the shared trigger", () => {
    for (const table of [...existingTimestampTables, ...newTimestampTables]) {
      expect(migration).toContain(`"${table}"`);
    }
    expect(migration).toContain("EXECUTE FUNCTION update_updated_at_column()");
    expect(migration).toContain("BEFORE UPDATE");
  });

  it("adds and reverses timestamps only for tables that lacked them", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ",
    );
    expect(migration).toContain('"import_staging_rows": "created_at"');
    expect(migration).toContain(
      '"portfolio_import_staging_rows": "created_at"',
    );
    expect(migration).toContain("ALTER COLUMN updated_at SET DEFAULT NOW()");
    expect(migration).toContain("ALTER COLUMN updated_at SET NOT NULL");
    expect(migration).toContain("DROP COLUMN IF EXISTS updated_at");
    expect(migration).toContain("reversed(_NEW_UPDATED_AT_TABLES)");
    expect(migration).toContain(
      'down_revision: Union[str, Sequence[str], None] = "0091_import_staging_resolved_fks"',
    );
  });

  it("documents the trigger-maintained aggregate exception", () => {
    expect(migration).toContain("agg_split_outstanding");
    expect(migration).toContain("explicit exception");
  });
});
