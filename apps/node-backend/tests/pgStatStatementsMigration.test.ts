import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../alembic/versions/0095_enable_pg_stat_statements.py",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("pg_stat_statements migration", () => {
  it("creates and reverses the extension explicitly", () => {
    expect(migration).toContain(
      'op.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements;")',
    );
    expect(migration).toContain(
      'op.execute("DROP EXTENSION IF EXISTS pg_stat_statements;")',
    );
    expect(migration).toContain(
      'down_revision: Union[str, Sequence[str], None] = "0094_drop_mv_cashflow_daily"',
    );
  });
});
