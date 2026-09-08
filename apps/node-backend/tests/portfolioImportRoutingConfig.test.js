import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/accountService.js", () => ({
  default: { get: vi.fn() },
}));

import accountService from "../src/services/accountService.js";
import { __normalizePortfolioParserConfig as normalizePortfolioParserConfig } from "../src/routes/portfolioImportRoutes.js";
import {
  assertPortfolioImportAccount,
  buildPortfolioImportPreviewRouting as buildPreviewRouting,
  getPortfolioImportAccountForPreview,
} from "../src/services/portfolioImportAccountService.js";

const config = (accountId) => ({
  dateColumn: "Date",
  symbolColumn: "Symbol",
  defaultAssetClass: "stock",
  accountId,
});

describe("portfolio parser broker routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores a strict optional account id without dropping other config keys", () => {
    expect(normalizePortfolioParserConfig(config("7"))).toEqual(config(7));
    expect(normalizePortfolioParserConfig(config(undefined))).toEqual(
      config(undefined),
    );
    for (const value of [0, -1, "1e3", "7.5", true]) {
      expect(() => normalizePortfolioParserConfig(config(value))).toThrow(
        "config.accountId must be a positive integer",
      );
    }
  });

  it("accepts only active portfolio accounts before staging", async () => {
    accountService.get.mockResolvedValueOnce({
      id: 7,
      type: "brokerage",
      is_active: true,
    });
    await expect(assertPortfolioImportAccount(7)).resolves.toMatchObject({
      id: 7,
    });

    for (const account of [
      { id: 8, type: "checking", is_active: true },
      { id: 9, type: "wallet", is_active: false },
    ]) {
      accountService.get.mockResolvedValueOnce(account);
      await expect(assertPortfolioImportAccount(account.id)).rejects.toThrow(
        "account_id must reference an active portfolio account",
      );
    }
  });

  it("publishes review routing and marks archived accounts unavailable", () => {
    expect(
      buildPreviewRouting(
        { account_id: 7 },
        {
          id: 7,
          name: "DEGIRO",
          display_name: "Degiro Broker",
          type: "brokerage",
          is_active: true,
        },
      ),
    ).toEqual({
      account_id: 7,
      account_name: "Degiro Broker",
      account_valid: true,
    });
    expect(
      buildPreviewRouting(
        { account_id: 7 },
        { name: "Old broker", type: "brokerage", is_active: false },
      ),
    ).toEqual({
      account_id: 7,
      account_name: "Old broker",
      account_valid: false,
    });
    expect(buildPreviewRouting({ account_id: null }, undefined)).toEqual({
      account_id: null,
      account_name: null,
      account_valid: false,
    });
  });

  it("turns a missing account into repairable preview state", async () => {
    accountService.get.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "NOT_FOUND" }),
    );
    await expect(
      getPortfolioImportAccountForPreview(99),
    ).resolves.toBeUndefined();

    accountService.get.mockRejectedValueOnce(new Error("database offline"));
    await expect(getPortfolioImportAccountForPreview(99)).rejects.toThrow(
      "database offline",
    );
  });
});
