import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../alembic/manual/drop_adr109_legacy_relations/up.sql",
    import.meta.url,
  ),
  "utf8",
);
const readme = readFileSync(
  new URL(
    "../../../alembic/manual/drop_adr109_legacy_relations/README.md",
    import.meta.url,
  ),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../../../alembic/versions/0087_flat_investments_conversion.py",
    import.meta.url,
  ),
  "utf8",
);

describe("ADR-109 operator-gated legacy cleanup", () => {
  it("requires an explicit verified backup before destructive SQL", () => {
    expect(sql).toContain(":{?backup_verified}");
    expect(sql).toContain("backup_verified must equal yes");
    expect(sql.indexOf("backup_verified must equal yes")).toBeLessThan(
      sql.indexOf("DROP VIEW"),
    );
    expect(readme).toContain("Rollback means restoring");
    expect(readme).toMatch(/not in the\s+auto-applied Alembic chain/);
  });

  it("checks the canonical flat shape and covers every 0087 rollback table", () => {
    expect(sql).toContain(
      "inv_kind IS DISTINCT FROM 'r' OR txn_kind IS DISTINCT FROM 'r'",
    );
    for (const relation of [
      "stock_investments_full",
      "etf_investments_full",
      "crypto_investments_full",
      "real_estate_investments_full",
      "savings_investments_full",
      "bond_investments_full",
      "legacy_inh_investments",
      "legacy_inh_portfolio_transactions",
    ]) {
      expect(sql).toContain(`'${relation}'`);
    }
    for (const relation of [
      "legacy_inh_investments_base",
      "legacy_inh_stock_investments",
      "legacy_inh_etf_investments",
      "legacy_inh_crypto_investments",
      "legacy_inh_metals_investments",
      "legacy_inh_real_estate_investments",
      "legacy_inh_savings_investments",
      "legacy_inh_bond_investments",
      "legacy_inh_portfolio_transactions_base",
      "legacy_inh_stock_transactions",
      "legacy_inh_etf_transactions",
      "legacy_inh_crypto_transactions",
      "legacy_inh_metals_transactions",
      "legacy_inh_real_estate_transactions",
      "legacy_inh_savings_transactions",
      "legacy_inh_bond_transactions",
      "investments_legacy",
      "portfolio_transactions_legacy",
    ]) {
      expect(sql).toContain(`'${relation}'`);
    }
    expect(sql).toContain("residue_count = 0");
    expect(sql).toContain("partial residue set");
    expect(sql).toContain("DROP VIEW public.%I CASCADE");
    expect(sql).toContain("DROP TABLE public.%I CASCADE");
  });

  it("leaves a durable marker that makes the 0087 downgrade fail closed", () => {
    expect(sql).toContain("public.adr109_legacy_cleanup_marker");
    expect(migration).toContain(
      "to_regclass('public.adr109_legacy_cleanup_marker') IS NOT NULL",
    );
    expect(migration).toContain("Refusing to downgrade 0087");
    expect(migration.indexOf("cleanup_completed")).toBeLessThan(
      migration.indexOf("converted = bool"),
    );
    expect(readme).toContain("refuses an Alembic downgrade");
  });
});
