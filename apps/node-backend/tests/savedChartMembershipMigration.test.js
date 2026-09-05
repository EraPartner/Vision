import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../alembic/versions/0096_normalize_saved_chart_filters.py",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("migration 0096 saved-chart memberships", () => {
  it("backfills three constrained membership tables and removes the arrays", () => {
    for (const [table, entityColumn, entityTable, arrayColumn] of [
      ["saved_chart_categories", "category_id", "categories", "category_ids"],
      ["saved_chart_recipients", "recipient_id", "recipients", "recipient_ids"],
      ["saved_chart_tags", "tag_id", "tags", "tag_ids"],
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
      expect(migration).toContain(
        `REFERENCES ${entityTable}(id) ON DELETE CASCADE`,
      );
      expect(migration).toContain(`unnest(sc.${arrayColumn})`);
      expect(migration).toContain(
        `array_agg(${entityColumn} ORDER BY ${entityColumn})`,
      );
      expect(migration).toContain(`ON ${table} (${entityColumn})`);
    }
    expect(migration.match(/SELECT DISTINCT sc\.id,/g)).toHaveLength(3);
    expect(migration).toContain(
      "REFERENCES saved_charts(id) ON DELETE CASCADE",
    );
    expect(migration).toContain("DROP COLUMN category_ids");
    expect(migration).toContain(
      "ADD COLUMN category_ids INTEGER[] NOT NULL DEFAULT '{}'",
    );
    expect(migration).toContain(
      'down_revision: Union[str, Sequence[str], None] = "0095_enable_pg_stat_statements"',
    );
  });
});
