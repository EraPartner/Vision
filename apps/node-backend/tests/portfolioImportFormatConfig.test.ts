import { describe, expect, it } from "vitest";

import {
  __assertPortfolioFormatBrokerage,
  __buildPortfolioConfig,
} from "../src/routes/portfolioImportRoutes.ts";

const minimal = {
  date_column: "Date",
  symbol_column: "Symbol",
  default_asset_class: "stock",
};

describe("portfolio import format contract", () => {
  it("retains only an explicit known-zero yield basis policy", () => {
    expect(__buildPortfolioConfig(minimal).customConfig).not.toHaveProperty(
      "yield_basis_policy",
    );
    expect(
      __buildPortfolioConfig({ ...minimal, yield_basis_policy: "zero" })
        .customConfig.yield_basis_policy,
    ).toBe("zero");
    for (const policy of ["estimate", "market", true, 0, ""]) {
      expect(() =>
        __buildPortfolioConfig({ ...minimal, yield_basis_policy: policy }),
      ).toThrow();
    }
  });
  it("retains explicit custody origin and destination as validated IDs", () => {
    const parsed = __buildPortfolioConfig({
      ...minimal,
      transfer_origin_account_id: "7",
      transfer_destination_account_id: "8",
    });
    expect(parsed.customConfig.transfer_origin_account_id).toBe(7);
    expect(parsed.customConfig.transfer_destination_account_id).toBe(8);
    for (const value of ["7tail", -1, "1.5"]) {
      expect(() =>
        __buildPortfolioConfig({
          ...minimal,
          transfer_origin_account_id: value,
        }),
      ).toThrow();
    }
  });
  it("passes the supported IBKR format into the parser config", () => {
    const parsed = __buildPortfolioConfig({
      ...minimal,
      portfolio_format: "ibkr_transaction_history",
    });

    expect(parsed.customConfig.format).toBe("ibkr_transaction_history");
    expect(parsed.adapterName).toBe("portfolio_generic");
  });

  it("passes the supported Kinesis format into the parser config", () => {
    const parsed = __buildPortfolioConfig({
      ...minimal,
      portfolio_format: "kinesis_transaction_history",
    });

    expect(parsed.customConfig.format).toBe("kinesis_transaction_history");
  });

  it.each([
    "nexo_transaction_history",
    "nexo_pro_spot_history",
    "saxo_transaction_history",
  ])("passes the supported %s format into the parser config", (format) => {
    const parsed = __buildPortfolioConfig({
      ...minimal,
      portfolio_format: format,
    });

    expect(parsed.customConfig.format).toBe(format);
  });

  it("rejects an unknown specialized format", () => {
    expect(() =>
      __buildPortfolioConfig({ ...minimal, portfolio_format: "guess" }),
    ).toThrow(/portfolio_format must be a supported portfolio format/);
  });

  it("requires an explicit brokerage account for IBKR cash routing", () => {
    const config = { format: "ibkr_transaction_history" };

    expect(() =>
      __assertPortfolioFormatBrokerage(config, {
        isBrokerage: false,
        accountId: undefined,
      }),
    ).toThrow(/requires is_brokerage=true and account_id/);
    expect(() =>
      __assertPortfolioFormatBrokerage(config, {
        isBrokerage: true,
        accountId: 7,
      }),
    ).not.toThrow();
  });

  it("requires an explicit brokerage account for Kinesis cash routing", () => {
    const config = { format: "kinesis_transaction_history" };

    expect(() =>
      __assertPortfolioFormatBrokerage(config, {
        isBrokerage: false,
        accountId: undefined,
      }),
    ).toThrow(/Kinesis Transaction History requires/);
    expect(() =>
      __assertPortfolioFormatBrokerage(config, {
        isBrokerage: true,
        accountId: 7,
      }),
    ).not.toThrow();
  });

  it.each([
    ["nexo_transaction_history", "Nexo"],
    ["nexo_pro_spot_history", "Nexo Pro Spot"],
    ["saxo_transaction_history", "Saxo"],
  ])("requires an explicit brokerage account for %s", (format, label) => {
    const config = { format };

    expect(() =>
      __assertPortfolioFormatBrokerage(config, {
        isBrokerage: false,
        accountId: undefined,
      }),
    ).toThrow(new RegExp(`${label} Transaction History requires`));
    expect(() =>
      __assertPortfolioFormatBrokerage(config, {
        isBrokerage: true,
        accountId: 7,
      }),
    ).not.toThrow();
  });

  it("does not impose brokerage routing on the generic mapper", () => {
    expect(() =>
      __assertPortfolioFormatBrokerage(
        {},
        {
          isBrokerage: false,
          accountId: undefined,
        },
      ),
    ).not.toThrow();
  });
});
