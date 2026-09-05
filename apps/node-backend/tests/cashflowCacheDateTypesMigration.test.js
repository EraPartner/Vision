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
const migration = readRepoFile(
  "alembic/versions/0093_cashflow_cache_date_types.py",
);

describe("migration 0093 cash-flow date keys", () => {
  it("converts all three text keys to DATE and restores their exact text shapes", () => {
    for (const column of ["as_of_month", "month", "today_iso"]) {
      expect(migration).toContain(`ALTER COLUMN ${column} TYPE DATE`);
      expect(migration).toContain(`ALTER COLUMN ${column} TYPE TEXT`);
    }
    expect(migration).toContain("pg_input_is_valid(today_iso, 'date')");
    expect(migration).toContain(
      "pg_input_is_valid(as_of_month || '-01', 'date')",
    );
    expect(migration).toContain("pg_input_is_valid(month || '-01', 'date')");
    expect(migration).toContain("to_char(as_of_month, 'YYYY-MM')");
    expect(migration).toContain("to_char(today_iso, 'YYYY-MM-DD')");
  });

  it("keeps the public repository strings at explicit DATE conversion boundaries", () => {
    const accuracy = readRepoFile(
      "apps/node-backend/src/repositories/cashflowForecastAccuracyRepository.js",
    );
    const monthly = readRepoFile(
      "apps/node-backend/src/repositories/cashflowForecastMcRepository.js",
    );
    const rolling = readRepoFile(
      "apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js",
    );

    expect(accuracy).toContain("($3 || '-01')::date");
    expect(accuracy).toContain(
      "to_char(as_of_month, 'YYYY-MM') AS as_of_month",
    );
    expect(monthly).toContain("($2 || '-01')::date");
    expect(rolling).toContain("today_iso = $2::date");
    expect(rolling).toContain("$2::date");
  });
});
