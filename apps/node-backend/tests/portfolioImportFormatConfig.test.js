import { describe, expect, it } from "vitest";

import {
  __assertPortfolioFormatBrokerage,
  __buildPortfolioConfig,
} from "../src/routes/portfolioImportRoutes.js";

const minimal = {
  date_column: "Date",
  symbol_column: "Symbol",
  default_asset_class: "stock",
};

describe("portfolio import format contract", () => {
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

  it.each(["nexo_transaction_history", "saxo_transaction_history"])(
    "passes the supported %s format into the parser config",
    (format) => {
      const parsed = __buildPortfolioConfig({
        ...minimal,
        portfolio_format: format,
      });

      expect(parsed.customConfig.format).toBe(format);
    },
  );

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
