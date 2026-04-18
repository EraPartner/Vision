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

  describe("exclusions", () => {
    const categories = [
      { id: 1, general: "Food", detail: "Groceries" },
      { id: 2, general: "Transport", detail: "Fuel" },
      { id: 3, general: "Income", detail: "Salary" },
    ] as any;

    const transactions = [
      // Food: Jan income + expense
      { transaction_date: "2026-01-10", amount: 100, amount_eur: 100, category_id: 3, recipient_id: 11, recipient_name: "Employer" },
      { transaction_date: "2026-01-15", amount: -40, amount_eur: -40, category_id: 1, recipient_id: 12, recipient_name: "Store A" },
      // Food: Feb expense
      { transaction_date: "2026-02-05", amount: -30, amount_eur: -30, category_id: 1, recipient_id: 13, recipient_name: "Store B" },
      // Transport: Dec 2025 expense
      { transaction_date: "2025-12-20", amount: -15, amount_eur: -15, category_id: 2, recipient_id: 13, recipient_name: "Store B" },
    ] as any;

    it("skips transactions whose category is excluded from all aggregations", () => {
      const result = processTransactions(transactions, categories, new Set([1]), new Set());

      // Food is excluded: only income (100) + transport expense (15) remain
      expect(result.totalIncome).toBe(100);
      expect(result.totalSpending).toBe(15);
      expect(result.categoryPivot.find((c) => c.categoryId === 1)).toBeUndefined();
      expect(result.categoryPivot.find((c) => c.categoryId === 2)?.expenseTotal).toBe(15);

      // Top recipients: Store A (Food/excluded) omitted; Store B keeps only transport expense
      const storeA = result.topRecipients.find((r) => r.name === "Store A");
      expect(storeA).toBeUndefined();
      const storeB = result.topRecipients.find((r) => r.name === "Store B");
      expect(storeB?.total).toBe(15);

      // Yearly
      expect(result.yearlyComparison.find((y) => y.year === 2026)?.totalSpending).toBe(0);
      expect(result.yearlyComparison.find((y) => y.year === 2025)?.totalSpending).toBe(15);
    });

    it("skips transactions whose recipient is excluded from all aggregations", () => {
      // Exclude Store B (recipient 13) — removes Feb Food expense + Dec 2025 transport expense
      const result = processTransactions(transactions, categories, new Set(), new Set([13]));

      expect(result.totalIncome).toBe(100);
      expect(result.totalSpending).toBe(40);

      // Category Food: only Jan remains
      const food = result.categoryPivot.find((c) => c.categoryId === 1);
      expect(food?.expenseTotal).toBe(40);
      expect(food?.expenseMonths["2026-02"]).toBeUndefined();
      // Transport: fully excluded (only recipient was Store B)
      expect(result.categoryPivot.find((c) => c.categoryId === 2)).toBeUndefined();

      // Top recipients: Store B removed
      expect(result.topRecipients.find((r) => r.name === "Store B")).toBeUndefined();
      // Yearly: 2025 fully excluded
      expect(result.yearlyComparison.find((y) => y.year === 2025)).toBeUndefined();
    });

    it("applies both excluded categories and recipients together", () => {
      // Exclude Food (cat 1) AND Store B (recipient 13)
      const result = processTransactions(transactions, categories, new Set([1]), new Set([13]));

      // Remaining: Jan income (100) only — Food excluded by cat; Store B excluded by recipient (was transport).
      expect(result.totalIncome).toBe(100);
      expect(result.totalSpending).toBe(0);
      expect(result.topRecipients).toHaveLength(0);
      expect(result.categoryPivot).toHaveLength(1);
      expect(result.categoryPivot[0]?.categoryId).toBe(3);
    });

    it("returns identical output to unfiltered run when exclusion sets are empty", () => {
      const filtered = processTransactions(transactions, categories, new Set(), new Set());
      const baseline = processTransactions(transactions, categories, new Set(), new Set());
      expect(filtered.totalIncome).toBe(baseline.totalIncome);
      expect(filtered.totalSpending).toBe(baseline.totalSpending);
      expect(filtered.categoryPivot.length).toBe(baseline.categoryPivot.length);
      expect(filtered.topRecipients.length).toBe(baseline.topRecipients.length);
    });

    it("does not mutate input transaction or category arrays", () => {
      const txSnapshot = JSON.stringify(transactions);
      const catSnapshot = JSON.stringify(categories);
      processTransactions(transactions, categories, new Set([1]), new Set([13]));
      expect(JSON.stringify(transactions)).toBe(txSnapshot);
      expect(JSON.stringify(categories)).toBe(catSnapshot);
    });

    it("excludes category from top recipients per-year breakdown", () => {
      const result = processTransactions(transactions, categories, new Set([1]), new Set());
      // Store A only appeared via Food/cat1 expense -> should not be in 2026 breakdown
      expect(result.topRecipientsByYear["2026"]?.find((r) => r.name === "Store A")).toBeUndefined();
      // Store B only appeared via cat1 (Feb 2026) and cat2 (Dec 2025); 2026 breakdown empty
      expect(result.topRecipientsByYear["2026"] ?? []).toHaveLength(0);
      // 2025 unaffected
      expect(result.topRecipientsByYear["2025"]?.[0]?.name).toBe("Store B");
    });
  });
});
