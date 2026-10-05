import { describe, expect, it } from "vitest";
import { applyPortfolioAssetScope } from "../src/services/portfolioImportPipeline/stage.js";
import { __buildPortfolioConfig } from "../src/routes/portfolioImportRoutes.js";

describe("explicit portfolio statement asset scope", () => {
  const base = {
    date_column: "Date",
    symbol_column: "Asset",
    default_asset_class: "crypto",
  };
  it("validates exact comma-separated symbols and keeps full imports implicit", () => {
    expect(
      __buildPortfolioConfig(base).customConfig.included_symbols,
    ).toBeUndefined();
    expect(
      __buildPortfolioConfig({ ...base, included_symbols: " btc, ETH,BTC " })
        .customConfig.included_symbols,
    ).toEqual(["BTC", "ETH"]);
    for (const included_symbols of ["", "BTC,", "BTC/ETH", [], 7])
      expect(() =>
        __buildPortfolioConfig({ ...base, included_symbols }),
      ).toThrow();
  });
  it("preserves literal asset rows and associated cash without hiding parse errors", () => {
    const rows = [
      { symbolRaw: "BTC", rawData: "literal swap" },
      { symbolRaw: "KAU", rawData: "literal swap" },
      { symbolRaw: "", rawData: "literal swap" },
      { symbolRaw: "", rawData: "unrelated cash" },
      { symbolRaw: "ETH", rawData: "literal other deposit" },
    ];
    rows.skipped = 2;
    rows.sourceColumns = ["Asset"];
    const scoped = applyPortfolioAssetScope(rows, ["BTC"]);
    expect(scoped).toHaveLength(2);
    expect(scoped[0]).toBe(rows[0]);
    expect(scoped[1]).toBe(rows[2]);
    expect(scoped.skipped).toBe(2);
    expect(scoped.sourceColumns).toEqual(["Asset"]);
    expect(rows).toHaveLength(5);
    expect(applyPortfolioAssetScope(rows, undefined)).toBe(rows);
  });
  it("rejects a symbol absent from the parsed source instead of staging an empty import", () => {
    expect(() =>
      applyPortfolioAssetScope([{ symbolRaw: "BTC" }], ["ETH"]),
    ).toThrow(/absent/);
  });
});
