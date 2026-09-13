import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_DATASET_CATALOG_VERSION,
  ANALYSIS_DATASETS_V1,
  assertAnalysisDatasetReference,
  getAnalysisDataset,
} from "@vision/types/analysis-datasets";
import { calculateCostBasis } from "@vision/shared-utils/portfolio";

const migration = readFileSync(
  new URL(
    "../../../alembic/versions/0107_analysis_dataset_views.py",
    import.meta.url,
  ),
  "utf8",
);

describe("versioned analysis datasets", () => {
  it("publishes four immutable, scoped version-1 datasets", () => {
    expect(ANALYSIS_DATASET_CATALOG_VERSION).toBe(1);
    expect(ANALYSIS_DATASETS_V1.map(({ id }) => id)).toEqual([
      "transactions",
      "accounts",
      "holdings",
      "cash-flows",
    ]);
    expect(Object.isFrozen(ANALYSIS_DATASETS_V1)).toBe(true);
    expect(Object.isFrozen(ANALYSIS_DATASETS_V1[0].joinPaths)).toBe(true);
    for (const dataset of ANALYSIS_DATASETS_V1) {
      expect(dataset.relation).toMatch(/^vision_analysis\.[a-z_]+_v1$/);
      expect(dataset.authorizationScope).toBe("local-user-database");
      expect(dataset.grain).not.toBe("");
      expect(dataset.currencySemantics).not.toBe("");
      expect(dataset.signSemantics).not.toBe("");
      expect(dataset.coverage).not.toBe("");
    }
  });

  it("fails closed for unknown versions and authorization scopes", () => {
    expect(getAnalysisDataset("transactions", 2)).toBeUndefined();
    expect(() =>
      assertAnalysisDatasetReference({
        id: "transactions",
        schemaVersion: 1,
        authorizationScope: "admin",
      }),
    ).toThrow("scope mismatch");
    expect(() =>
      assertAnalysisDatasetReference({
        id: "secrets",
        schemaVersion: 1,
        authorizationScope: "local-user-database",
      }),
    ).toThrow("Unsupported analysis dataset");
  });

  it("materializes security-barrier views without secret or admin surfaces", () => {
    for (const relation of [
      "transactions_v1",
      "accounts_v1",
      "holding_events_v1",
      "cash_flows_v1",
    ]) {
      expect(migration).toContain(`CREATE VIEW vision_analysis.${relation}`);
    }
    expect(migration).toContain("security_barrier = true");
    expect(migration).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA vision_analysis FROM PUBLIC",
    );
    for (const forbidden of [
      "provider_api_keys",
      "db_editor_audit",
      "raw_csv_line",
      "dedup_fingerprint",
      "tx_hash",
    ]) {
      expect(migration).not.toContain(`public.${forbidden}`);
    }
  });

  it("keeps transfers out of spending and leaves refunds distinguishable", () => {
    const rows = [
      { amount: -100, isTransfer: false },
      { amount: 25, isTransfer: false },
      { amount: -50, isTransfer: true },
      { amount: 50, isTransfer: true },
    ];
    const spending = rows.reduce(
      (sum, row) => sum + (!row.isTransfer && row.amount < 0 ? -row.amount : 0),
      0,
    );
    const positiveFlow = rows.reduce(
      (sum, row) => sum + (!row.isTransfer && row.amount > 0 ? row.amount : 0),
      0,
    );
    expect(spending).toBe(100);
    expect(positiveFlow).toBe(25);
    expect(getAnalysisDataset("cash-flows").signSemantics).toContain(
      "income and refunds",
    );
  });

  it("delegates partial-sale and mixed-FX holdings math to the canonical engine", () => {
    const result = calculateCostBasis([
      {
        id: 1,
        type: "buy",
        date: "2026-01-02",
        units: 10,
        amount: 1000,
        price_per_unit: 100,
        fees: 0,
        taxes: 0,
        fxMultiplier: 0.9,
      },
      {
        id: 2,
        type: "sell",
        date: "2026-02-02",
        units: 4,
        amount: 520,
        price_per_unit: 130,
        fees: 0,
        taxes: 0,
        fxMultiplier: 0.92,
      },
    ]);
    expect(result.totalUnits).toBe(6);
    expect(result.realizedGainConv).toBeCloseTo(118.4, 8);
    expect(getAnalysisDataset("holdings").coverage).toContain(
      "canonical engine",
    );
  });

  it("declares a reversible migration chain", () => {
    expect(migration).toContain(
      'down_revision: Union[str, Sequence[str], None] = "0106_remove_federal_pit_total_alias"',
    );
    expect(migration).toContain("DROP VIEW vision_analysis.cash_flows_v1");
    expect(migration).toContain("DROP SCHEMA vision_analysis");
  });
});
