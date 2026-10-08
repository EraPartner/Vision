import { describe, expect, it } from "vitest";
import { __formatTransaction } from "../src/routes/transactions.ts";

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
  it("retains account and transfer identities needed to safely pair existing records", () => {
    const formatted = __formatTransaction({ id: 2, date: "2026-01-15", amount: "-100",
      currency: "USD", account_id: 7, is_transfer: true, transfer_source: "manual", transfer_peer_id: 3 });
    expect(formatted).toMatchObject({ account_id: 7, is_transfer: true, transfer_source: "manual", transfer_peer_id: 3 });
  });
});
