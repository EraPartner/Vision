import { describe, expect, test } from "vitest";
import {
  ADD_TRANSACTION_FIELD_IDS,
  addTransactionSchema,
  createAddTransactionFormState,
} from "./addTransactionForm";
import { fieldErrorsFromZod } from "@/lib/forms/schemas";

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

describe("addTransactionSchema", () => {
  /** A form state that passes every rule. */
  const validForm = () => ({
    ...createAddTransactionFormState("EUR"),
    amount: "12,50",
    bank_account: "Main",
    recipient_id: "7",
  });

  /** First issue message for the given schema path, or undefined. */
  function issueFor(form: ReturnType<typeof validForm>, path: string): string | undefined {
    const result = addTransactionSchema.safeParse(form);
    if (result.success) return undefined;
    return result.error.issues.find((i) => i.path[0] === path)?.message;
  }

  test("accepts a valid form and parses the locale amount to a number", () => {
    const result = addTransactionSchema.safeParse(validForm());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.amount).toBe(12.5);
  });

  test("accepts EU and US thousand/decimal formats and negative amounts", () => {
    for (const [input, value] of [
      ["1.234,56", 1234.56],
      ["1,234.56", 1234.56],
      ["-5", -5],
    ] as const) {
      const result = addTransactionSchema.safeParse({ ...validForm(), amount: input });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.amount).toBe(value);
    }
  });

  test("empty date, amount, and recipient report the required key", () => {
    expect(issueFor({ ...validForm(), transaction_date: "" }, "transaction_date")).toBe("validation.required");
    expect(issueFor({ ...validForm(), amount: "" }, "amount")).toBe("validation.required");
    expect(issueFor({ ...validForm(), recipient_id: "" }, "recipient_id")).toBe("validation.required");
  });

  test("whitespace-only bank account reports the select-account key", () => {
    expect(issueFor({ ...validForm(), bank_account: "  " }, "bank_account")).toBe("portfolio.move.selectAccount");
  });

  test("unparseable and zero amounts report their dedicated keys", () => {
    expect(issueFor({ ...validForm(), amount: "abc" }, "amount")).toBe("addTxn.invalidAmount");
    expect(issueFor({ ...validForm(), amount: "0" }, "amount")).toBe("addTxn.zeroAmount");
    expect(issueFor({ ...validForm(), amount: "0,00" }, "amount")).toBe("addTxn.zeroAmount");
  });

  test("currency, category, memo, and comment pass through unvalidated", () => {
    const result = addTransactionSchema.safeParse({
      ...validForm(),
      currency: "not a currency",
      category_id: "",
      memo: "",
      comment: "",
    });
    expect(result.success).toBe(true);
  });

  test("maps onto the dialog's field ids through fieldErrorsFromZod", () => {
    const result = addTransactionSchema.safeParse({
      ...validForm(),
      transaction_date: "",
      amount: "abc",
      bank_account: "",
      recipient_id: "",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fieldErrorsFromZod(result.error, ADD_TRANSACTION_FIELD_IDS, (k) => k)).toEqual({
      tx_date: "validation.required",
      tx_amount: "addTxn.invalidAmount",
      tx_bank: "portfolio.move.selectAccount",
      tx_recipient: "validation.required",
    });
  });
});
