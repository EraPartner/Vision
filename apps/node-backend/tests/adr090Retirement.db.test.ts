import { describe, expect, it } from "vitest";
import { column, objectSql } from "./helpers/sqliteCatalog.ts";

describe("ADR-090 transaction schema retirement", () => {
  it("removes the retired link and narrows transfer_source", async () => {
    expect(await column("transactions", "portfolio_transaction_id")).toBeUndefined();

    const table = await objectSql("transactions");
    const definitions = table.match(/CONSTRAINT chk_transactions_transfer_source CHECK \(([^\n]*)\),?$/mu) ?? [];
    expect(definitions).toHaveLength(2);
    const definition = definitions[1] ?? "";
    expect(definition).toContain("'auto'");
    expect(definition).toContain("'manual'");
    expect(definition).toContain("'opening'");
    expect(definition).toContain("'adjustment'");
    expect(definition).not.toContain("'trade'");
  });
});
