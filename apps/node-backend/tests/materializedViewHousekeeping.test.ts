import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readRepoFile = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("materialized-view housekeeping", () => {
  it("drops the unused daily view and restores its historical shape on downgrade", () => {
    const migration = readRepoFile(
      "alembic/versions/0094_drop_mv_cashflow_daily.py",
    );

    expect(migration).toContain(
      "DROP MATERIALIZED VIEW IF EXISTS mv_cashflow_daily CASCADE",
    );
    expect(migration).toContain("destructive-ok:");
    expect(migration).toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cashflow_daily AS",
    );
    expect(migration).toContain("WITH NO DATA");
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cashflow_daily",
    );
  });
});
