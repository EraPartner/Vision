import { describe, expect, test } from "vitest";
import { createAddTransactionFormState } from "./addTransactionForm";

describe("createAddTransactionFormState", () => {
  test("uses app default currency when provided", () => {
    const form = createAddTransactionFormState("USD");
    expect(form.currency).toBe("USD");
  });

  test("falls back to EUR when no default currency is provided", () => {
    const form = createAddTransactionFormState(undefined);
    expect(form.currency).toBe("EUR");
  });

  test("initializes blank fields and today date", () => {
    const form = createAddTransactionFormState("CHF");

    expect(form.transaction_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(form.bank_account).toBe("");
    expect(form.recipient_id).toBe("");
    expect(form.category_id).toBe("");
    expect(form.memo).toBe("");
    expect(form.amount).toBe("");
    expect(form.comment).toBe("");
  });
});
