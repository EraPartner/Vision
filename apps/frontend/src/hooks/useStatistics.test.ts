import { describe, expect, it } from "vitest";
import { processTransactions } from "./statisticsProcessing";

describe("processTransactions", () => {
  it("computes category pivot absolute/income/expense/net totals", () => {
    const transactions = [
      {
        transaction_date: "2026-01-10",
        amount: 100,
        amount_eur: 100,
        category_id: 1,
        recipient_id: 11,
        recipient_name: "Employer",
      },
      {
        transaction_date: "2026-01-15",
        amount: -40,
        amount_eur: -40,
        category_id: 1,
        recipient_id: 12,
        recipient_name: "Store A",
      },
      {
        transaction_date: "2026-02-05",
        amount: -30,
        amount_eur: -30,
        category_id: 1,
        recipient_id: 13,
        recipient_name: "Store B",
      },
      {
        transaction_date: "2025-12-20",
        amount: -15,
        amount_eur: -15,
        category_id: 2,
        recipient_id: 13,
        recipient_name: "Store B",
      },
    ] as any;

    const categories = [
      { id: 1, general: "Food", detail: "Groceries" },
      { id: 2, general: "Transport", detail: "Fuel" },
    ] as any;

    const result = processTransactions(transactions, categories, new Set(), new Set());
    const food = result.categoryPivot.find((c) => c.categoryId === 1);
    expect(food).toBeDefined();
    expect(food?.total).toBe(170);
    expect(food?.incomeTotal).toBe(100);
    expect(food?.expenseTotal).toBe(70);
    expect(food?.netTotal).toBe(30);
    expect(food?.incomeMonths["2026-01"]).toBe(100);
    expect(food?.expenseMonths["2026-01"]).toBe(40);
    expect(food?.netMonths["2026-01"]).toBe(60);
  });

  it("aggregates top recipients by year", () => {
    const transactions = [
      {
        transaction_date: "2026-01-15",
        amount: -40,
        amount_eur: -40,
        category_id: 1,
        recipient_id: 12,
        recipient_name: "Store A",
      },
      {
        transaction_date: "2026-02-05",
        amount: -30,
        amount_eur: -30,
        category_id: 1,
        recipient_id: 13,
        recipient_name: "Store B",
      },
      {
        transaction_date: "2025-12-20",
        amount: -15,
        amount_eur: -15,
        category_id: 2,
        recipient_id: 13,
        recipient_name: "Store B",
      },
    ] as any;

    const categories = [
      { id: 1, general: "Food", detail: "Groceries" },
      { id: 2, general: "Transport", detail: "Fuel" },
    ] as any;

    const result = processTransactions(transactions, categories, new Set(), new Set());
    expect(result.topRecipientsByYear["2026"]?.[0]?.name).toBe("Store A");
    expect(result.topRecipientsByYear["2026"]?.[0]?.total).toBe(40);
    expect(result.topRecipientsByYear["2025"]?.[0]?.name).toBe("Store B");
    expect(result.topRecipientsByYear["2025"]?.[0]?.total).toBe(15);
  });
});
