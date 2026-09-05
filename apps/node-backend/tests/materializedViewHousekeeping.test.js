import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readRepoFile = (relativePath) =>
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

  it("keeps the removed view out of the current runtime-managed set", () => {
    const service = readRepoFile(
      "apps/node-backend/src/services/materializedViewService.js",
    );
    const currentRuntime = service.slice(
      service.indexOf("const MATERIALIZED_VIEWS"),
    );

    expect(currentRuntime).not.toContain("mv_cashflow_daily");
    expect(currentRuntime).toContain("mv_monthly_summary");
    expect(currentRuntime).toContain("mv_category_totals");
  });

  it("records create, index, and refresh as distinct post-listen boot phases", () => {
    const warmup = readRepoFile("apps/node-backend/src/startup/warmup.js");

    for (const phase of [
      "materialized_views_create",
      "materialized_views_indexes",
      "materialized_views_refresh",
    ]) {
      expect(warmup).toMatch(new RegExp(`markPhase\\(\\s*"${phase}"`));
    }
  });
});
