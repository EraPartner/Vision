import { describe, expect, it } from "vitest";
import { __formatTransaction } from "../src/routes/transactions.js";

describe("transaction response formatter", () => {
  it("emits only the canonical transaction_date field", () => {
    const formatted = __formatTransaction({
      id: 1,
      date: "2026-01-15",
      amount: "25.50",
      currency: "EUR",
    });

    expect(formatted.transaction_date).toBe("2026-01-15");
    expect(formatted).not.toHaveProperty("date");
  });
});
