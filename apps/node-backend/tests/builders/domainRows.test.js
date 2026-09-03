import { describe, expect, it } from "vitest";
import {
  makeImportStagingRow,
  makeInvestmentRow,
  makePlannedTransactionRow,
  makePortfolioImportStagingRow,
  makePortfolioTransactionRow,
  makeTransactionRow,
} from "./domainRows.js";

describe("domain row builders", () => {
  it("preserves raw pg NUMERIC, BIGINT, and DATE representations", () => {
    const transaction = makeTransactionRow();
    const planned = makePlannedTransactionRow();
    const staging = makeImportStagingRow();
    const portfolioStaging = makePortfolioImportStagingRow();

    expect(transaction).toMatchObject({
      amount: "-12.5000",
      import_batch_id: null,
    });
    expect(transaction.date).toBeInstanceOf(Date);
    expect(planned.amount).toBe("-50.0000");
    expect(planned.planned_date).toBeInstanceOf(Date);
    expect(staging).toMatchObject({
      id: "1",
      batch_id: "1",
      amount: "-12.5000",
    });
    expect(staging.tx_date).toBeInstanceOf(Date);
    expect(portfolioStaging).toMatchObject({ id: "1", units: "10.00000000" });
    expect(portfolioStaging.tx_date).toBeInstanceOf(Date);
  });

  it("uses mapped wire representations for investment and portfolio rows", () => {
    expect(makeInvestmentRow({ maturity_date: "2030-12-31" })).toMatchObject({
      current_price: 100,
      maturity_date: "2030-12-31",
    });
    expect(makePortfolioTransactionRow()).toMatchObject({
      date: "2026-01-15",
      amount: 1000,
      units: 10,
    });
  });

  it("applies overrides last without deep merging", () => {
    expect(
      makeTransactionRow({ id: 9, amount: "42.0000", tags: [{ id: 1 }] }),
    ).toMatchObject({
      id: 9,
      amount: "42.0000",
      tags: [{ id: 1 }],
    });
  });

  it("does not leak mutable arrays or dates between calls", () => {
    const first = makePlannedTransactionRow();
    const second = makePlannedTransactionRow();
    first.tags.push({ id: 1 });
    first.executions.push({ id: 1 });
    first.planned_date.setUTCFullYear(2040);

    expect(second.tags).toEqual([]);
    expect(second.executions).toEqual([]);
    expect(second.loan_schedule).toEqual([]);
    expect(second.planned_date.getUTCFullYear()).toBe(2026);
  });
});
