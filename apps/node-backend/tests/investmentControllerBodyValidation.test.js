import { afterEach, describe, expect, it, vi } from "vitest";
import investmentRepository from "../src/repositories/investmentRepository.js";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.js";
import {
  createTransaction,
  __parsePortfolioTransactionBody as parsePortfolioTransactionBody,
  updateTransaction,
} from "../src/controllers/investmentController.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portfolio transaction request body validation", () => {
  it.each([
    [{ date: "" }, /date cannot be cleared/],
    [{ date: "not-a-date" }, /date must be in YYYY-MM-DD format/],
    [{ date: "2026-02-30" }, /date is not a valid date/],
    [{ date: "0000-01-01" }, /date is not a valid date/],
    [{ amount: "Infinity" }, /amount must be a number/],
    [{ units: {} }, /units must be a number/],
    [{ amount: true }, /amount must be a number/],
    [{ amount: [7] }, /amount must be a number/],
    [{ amount: "0x10" }, /amount must be a number/],
    [{ amount: " 7 " }, /amount must be a number/],
    [{ date: ["2026-01-15"] }, /date must be in YYYY-MM-DD format/],
    [{ currency: ["usd"] }, /currency must be a 3-letter ISO code/],
    [{ amount: 100_000_000_000_000 }, /amount must be between/],
    [{ units: 10_000_000_000 }, /units must be between/],
    [{ price_per_unit: 1_000_000_000_000 }, /price_per_unit must be between/],
    [{ fx_rate_to_eur: 10_000_000_000 }, /fx_rate_to_eur must be between/],
    [{ is_recurring: "false" }, /is_recurring/],
    [{ recurrence_interval: "fortnightly" }, /recurrence_interval/],
    [
      { recurrence_end_date: "2026\/12\/31" },
      /recurrence_end_date must be in YYYY-MM-DD format/,
    ],
    [{ note: 123 }, /note/],
  ])("rejects malformed common fields in %j", (body, message) => {
    expect(() => parsePortfolioTransactionBody(body)).toThrow(message);
  });

  it("normalizes valid fields while preserving field-specific clear values", () => {
    expect(
      parsePortfolioTransactionBody({
        type: "buy",
        date: "2026-01-15",
        amount: "1200.5",
        fx_rate_to_eur: null,
        fees: null,
        taxes: "",
        currency: "usd",
        is_recurring: false,
        recurrence_interval: "",
        recurrence_end_date: "",
        note: null,
        account_id: null,
      }),
    ).toEqual({
      type: "buy",
      date: "2026-01-15",
      amount: 1200.5,
      fx_rate_to_eur: null,
      fees: null,
      taxes: "",
      currency: "USD",
      is_recurring: false,
      recurrence_interval: null,
      recurrence_end_date: null,
      note: null,
      account_id: null,
    });
  });

  it("accepts compatible numeric strings within the safe money boundary", () => {
    expect(parsePortfolioTransactionBody({ amount: "99999999999999" })).toEqual(
      {
        amount: 99_999_999_999_999,
      },
    );
    expect(parsePortfolioTransactionBody({ amount: "1e3" })).toEqual({
      amount: 1000,
    });
    expect(
      parsePortfolioTransactionBody({ price_per_unit: "999999999999" }),
    ).toEqual({
      price_per_unit: 999_999_999_999,
    });
  });
});

describe("portfolio transaction controller validation boundary", () => {
  it("rejects a malformed create body before repository create", async () => {
    vi.spyOn(investmentRepository, "getById").mockResolvedValue({
      id: 1,
      currency: "EUR",
    });
    const createSpy = vi.spyOn(portfolioTransactionService, "create");

    await expect(
      createTransaction(
        {
          params: { id: 1 },
          body: {
            type: "buy",
            date: "2026-01-15",
            amount: 1000,
            is_recurring: "false",
          },
        },
        {},
      ),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed patch body before repository update", async () => {
    const updateSpy = vi.spyOn(portfolioTransactionService, "update");

    await expect(
      updateTransaction(
        {
          params: { txnId: 1 },
          body: { date: "", amount: "Infinity" },
        },
        {},
      ),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
