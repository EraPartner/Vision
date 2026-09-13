import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(
  new URL(
    "../../../alembic/versions/0108_provider_neutral_provenance.py",
    import.meta.url,
  ),
);
const migration = readFileSync(migrationPath, "utf8");

describe("provider-neutral provenance expand migration", () => {
  it("preserves every known source table and tolerates the optional custom table", () => {
    for (const source of [
      "belfius",
      "revolut",
      "kbc",
      "sabb",
      "wise",
      "vision",
      "custom",
      "manual",
    ]) {
      expect(migration).toContain(
        `(\"${source}\", \"${source}_raw_transactions\")`,
      );
    }
    expect(migration).toContain("to_regclass");
    expect(migration).toContain("to_jsonb(r)");
    expect(migration).toContain("raw_csv_line");
    expect(migration).not.toContain("chk_transaction_source_hash");
  });

  it("keeps linked, unlinked, and dangling history explicit", () => {
    expect(migration).toContain("transaction_source_links");
    expect(migration).toContain("legacy_transaction_id");
    expect(migration).toContain("dangling-reference");
    expect(migration).toContain("missing_legacy_source");
    expect(migration).toContain("LEFT JOIN transactions");
  });

  it("moves active manual identity to a neutral claim table", () => {
    expect(migration).toContain("manual_transaction_dedup_claims");
    expect(migration).toContain("WHERE m.deduplication_hash ~");
    expect(migration).toContain("ON CONFLICT (deduplication_hash) DO UPDATE");
  });

  it("is additive and has an explicit downgrade", () => {
    const upgrade = migration.slice(
      migration.indexOf("def upgrade"),
      migration.indexOf("def downgrade"),
    );
    expect(upgrade).not.toMatch(/DROP TABLE/);
    expect(migration).toContain("def downgrade");
    expect(migration).toContain("DROP TABLE transaction_source_records");
  });
});
