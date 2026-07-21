import { describe, it, expect, afterEach } from "vitest";
import {
  mapFromAPI,
  mapToCreateAPI,
  mapToUpdateAPI,
  type PlannedPayment,
} from "./plannedPaymentMapper";
import { configureCurrencyFormatDefaults } from "@/utils/currency";
import type { PlannedTransaction } from "@/types/api";

// Minimal valid backend row; individual tests override the fields under test.
function makePT(overrides: Partial<PlannedTransaction> = {}): PlannedTransaction {
  return {
    id: 1,
    planned_date: "2025-02-01",
    bank_account: "BE12345678901234",
    recipient_id: 7,
    recipient_name: "Landlord",
    memo: "Monthly rent",
    amount: 1200,
    currency: "EUR",
    is_recurring: true,
    recurrence_pattern: "monthly",
    is_executed: false,
    execution_count: 0,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    links: [],
    ...overrides,
  };
}

// configureCurrencyFormatDefaults mutates a module-level singleton — restore
// the shipped default so no test leaks a currency into the rest of the suite.
afterEach(() => configureCurrencyFormatDefaults({ defaultCurrency: "EUR" }));

describe("mapFromAPI", () => {
  it("maps core wire fields to the frontend view model", () => {
    const p = mapFromAPI(
      makePT({
        category_id: 3,
        category_name: "HOUSING:RENT",
        comment: "pay by the 1st",
        url: "https://example.com",
      }),
    );
    expect(p).toMatchObject({
      id: 1,
      name: "Monthly rent",
      amount: 1200,
      currency: "EUR",
      due_date: "2025-02-01",
      recipient: "Landlord",
      recipient_id: 7,
      category: "HOUSING:RENT",
      category_id: 3,
      bank_account: "BE12345678901234",
      notes: "pay by the 1st",
      url: "https://example.com",
      is_active: true,
      created_at: "2025-01-01T00:00:00.000Z",
    });
  });

  it("falls back name to recipient_name, then to 'Unnamed payment'", () => {
    expect(mapFromAPI(makePT({ memo: undefined })).name).toBe("Landlord");
    expect(mapFromAPI(makePT({ memo: "" })).name).toBe("Landlord");
    expect(mapFromAPI(makePT({ memo: undefined, recipient_name: undefined })).name).toBe(
      "Unnamed payment",
    );
  });

  it("falls back a missing currency to the configured app default", () => {
    configureCurrencyFormatDefaults({ defaultCurrency: "CHF" });
    expect(mapFromAPI(makePT({ currency: undefined })).currency).toBe("CHF");
  });

  it("strips the time portion from an ISO datetime planned_date", () => {
    const p = mapFromAPI(makePT({ planned_date: "2025-02-01T00:00:00.000Z" }));
    expect(p.due_date).toBe("2025-02-01");
  });

  it.each([
    ["daily", "daily"],
    ["weekly", "weekly"],
    ["biweekly", "biweekly"],
    ["bi-weekly", "biweekly"], // DB-enum compat spelling
    ["monthly", "monthly"],
    ["quarterly", "quarterly"],
    ["yearly", "yearly"],
    ["Monthly", "monthly"], // case-insensitive
  ] as const)("parses recurrence_pattern %s as frequency %s", (pattern, frequency) => {
    const p = mapFromAPI(makePT({ recurrence_pattern: pattern }));
    expect(p.frequency).toBe(frequency);
    expect(p.custom_interval_days).toBeUndefined();
  });

  it("parses a custom pattern like 'every 10 days' into frequency custom + interval", () => {
    const p = mapFromAPI(makePT({ recurrence_pattern: "every 10 days" }));
    expect(p.frequency).toBe("custom");
    expect(p.custom_interval_days).toBe(10);
  });

  it("defaults an unrecognized non-numeric pattern to monthly", () => {
    expect(mapFromAPI(makePT({ recurrence_pattern: "fortnightly-ish" })).frequency).toBe("monthly");
  });

  it("leaves frequency undefined for non-recurring rows even if a pattern is present", () => {
    const p = mapFromAPI(makePT({ is_recurring: false, recurrence_pattern: "monthly" }));
    expect(p.is_recurring).toBe(false);
    expect(p.frequency).toBeUndefined();
  });

  it("converts null loan fields to undefined and defaults the flag/schedule", () => {
    const p = mapFromAPI(
      makePT({
        is_loan: undefined,
        loan_type: null,
        loan_principal: null,
        loan_annual_interest_rate: null,
        loan_term_months: null,
        loan_start_date: null,
        loan_payment_day: null,
        loan_regular_payment_amount: null,
        loan_first_payment_date: null,
        loan_schedule: undefined,
      }),
    );
    expect(p.is_loan).toBe(false);
    expect(p.loan_type).toBeUndefined();
    expect(p.loan_principal).toBeUndefined();
    expect(p.loan_annual_interest_rate).toBeUndefined();
    expect(p.loan_term_months).toBeUndefined();
    expect(p.loan_start_date).toBeUndefined();
    expect(p.loan_payment_day).toBeUndefined();
    expect(p.loan_regular_payment_amount).toBeUndefined();
    expect(p.loan_first_payment_date).toBeUndefined();
    expect(p.loan_schedule).toEqual([]);
  });

  it("passes populated loan fields through", () => {
    const schedule = [
      {
        installment_number: 1,
        due_date: "2025-03-01",
        payment_amount: 500,
        principal_amount: 400,
        interest_amount: 100,
        remaining_principal: 11600,
      },
    ];
    const p = mapFromAPI(
      makePT({
        is_loan: true,
        loan_type: "amortizing",
        loan_principal: 12000,
        loan_annual_interest_rate: 3.5,
        loan_term_months: 24,
        loan_start_date: "2025-02-01",
        loan_payment_day: 1,
        loan_regular_payment_amount: 500,
        loan_first_payment_date: "2025-03-01",
        loan_schedule: schedule,
      }),
    );
    expect(p.is_loan).toBe(true);
    expect(p.loan_type).toBe("amortizing");
    expect(p.loan_principal).toBe(12000);
    expect(p.loan_annual_interest_rate).toBe(3.5);
    expect(p.loan_term_months).toBe(24);
    expect(p.loan_start_date).toBe("2025-02-01");
    expect(p.loan_payment_day).toBe(1);
    expect(p.loan_regular_payment_amount).toBe(500);
    expect(p.loan_first_payment_date).toBe("2025-03-01");
    expect(p.loan_schedule).toEqual(schedule);
  });

  it("maps null recurrence bounds to undefined and keeps set ones", () => {
    const cleared = mapFromAPI(makePT({ recurrence_end_date: null, max_occurrences: null }));
    expect(cleared.end_date).toBeUndefined();
    expect(cleared.max_occurrences).toBeUndefined();

    const bounded = mapFromAPI(makePT({ recurrence_end_date: "2026-12-31", max_occurrences: 12 }));
    expect(bounded.end_date).toBe("2026-12-31");
    expect(bounded.max_occurrences).toBe(12);
  });

  it("flattens tags to slugs and defaults executions/tags/count", () => {
    const tag = {
      id: 1,
      slug: "rent",
      color: null,
      is_active: true,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    };
    expect(mapFromAPI(makePT({ tags: [tag] })).tags).toEqual(["rent"]);

    const bare = mapFromAPI(makePT({ tags: undefined, executions: undefined }));
    expect(bare.tags).toEqual([]);
    expect(bare.executions).toEqual([]);
    expect(bare.execution_count).toBe(0);
  });
});

const BASE_PAYMENT: Omit<PlannedPayment, "id" | "created_at"> = {
  name: "Monthly rent",
  amount: 1200,
  currency: "EUR",
  due_date: "2025-02-01",
  is_recurring: true,
  frequency: "monthly",
  bank_account: "BE12345678901234",
  recipient_id: 7,
  category_id: 3,
  notes: "pay by the 1st",
  is_active: true,
};

describe("mapToCreateAPI", () => {
  it("maps the view model to the create wire shape", () => {
    expect(mapToCreateAPI(BASE_PAYMENT)).toMatchObject({
      planned_date: "2025-02-01",
      bank_account: "BE12345678901234",
      recipient_id: 7,
      memo: "Monthly rent",
      amount: 1200,
      currency: "EUR",
      category_id: 3,
      comment: "pay by the 1st",
      is_recurring: true,
      recurrence_pattern: "monthly",
      is_loan: false,
    });
  });

  it("serializes a custom frequency as 'every N days'", () => {
    const result = mapToCreateAPI({
      ...BASE_PAYMENT,
      frequency: "custom",
      custom_interval_days: 10,
    });
    expect(result.recurrence_pattern).toBe("every 10 days");
  });

  it("omits recurrence_pattern for one-off payments", () => {
    const result = mapToCreateAPI({
      ...BASE_PAYMENT,
      is_recurring: false,
      frequency: undefined,
    });
    expect(result.is_recurring).toBe(false);
    expect(result.recurrence_pattern).toBeUndefined();
  });

  it("forwards recurrence bounds and turns a null clear into undefined", () => {
    const bounded = mapToCreateAPI({
      ...BASE_PAYMENT,
      end_date: "2026-12-31",
      max_occurrences: 12,
    });
    expect(bounded.recurrence_end_date).toBe("2026-12-31");
    expect(bounded.max_occurrences).toBe(12);

    // Create has no "clear" semantics — null collapses to undefined (omitted).
    const cleared = mapToCreateAPI({ ...BASE_PAYMENT, end_date: null, max_occurrences: null });
    expect(cleared.recurrence_end_date).toBeUndefined();
    expect(cleared.max_occurrences).toBeUndefined();
  });

  it("drops empty bank_account and forwards loan fields", () => {
    const result = mapToCreateAPI({
      ...BASE_PAYMENT,
      bank_account: "",
      is_loan: true,
      loan_type: "amortizing",
      loan_principal: 12000,
      loan_annual_interest_rate: 3.5,
      loan_term_months: 24,
      loan_start_date: "2025-02-01",
      loan_payment_day: 1,
      tags: ["rent"],
    });
    expect(result.bank_account).toBeUndefined();
    expect(result).toMatchObject({
      is_loan: true,
      loan_type: "amortizing",
      loan_principal: 12000,
      loan_annual_interest_rate: 3.5,
      loan_term_months: 24,
      loan_start_date: "2025-02-01",
      loan_payment_day: 1,
      tags: ["rent"],
    });
  });
});

describe("mapToUpdateAPI", () => {
  it("returns an empty object for no updates", () => {
    expect(mapToUpdateAPI({})).toEqual({});
  });

  it("only includes fields that are present, renaming to wire names", () => {
    expect(mapToUpdateAPI({ amount: 1500 })).toEqual({ amount: 1500 });
    expect(mapToUpdateAPI({ name: "New name", due_date: "2025-03-01", notes: "n" })).toEqual({
      memo: "New name",
      planned_date: "2025-03-01",
      comment: "n",
    });
  });

  it("forwards cleared recurrence bounds as explicit null, set ones verbatim", () => {
    expect(mapToUpdateAPI({ end_date: null, max_occurrences: null })).toEqual({
      recurrence_end_date: null,
      max_occurrences: null,
    });
    expect(mapToUpdateAPI({ end_date: "2026-12-31", max_occurrences: 12 })).toEqual({
      recurrence_end_date: "2026-12-31",
      max_occurrences: 12,
    });
    // undefined means "leave unchanged" — the keys must not appear at all.
    expect(mapToUpdateAPI({ amount: 1 })).not.toHaveProperty("recurrence_end_date");
    expect(mapToUpdateAPI({ amount: 1 })).not.toHaveProperty("max_occurrences");
  });

  it("rebuilds recurrence_pattern from frequency updates", () => {
    expect(mapToUpdateAPI({ frequency: "weekly" }).recurrence_pattern).toBe("weekly");
    expect(
      mapToUpdateAPI({ frequency: "custom", custom_interval_days: 10 }).recurrence_pattern,
    ).toBe("every 10 days");
    // An interval change without an accompanying frequency can't be serialized
    // on its own — no pattern is sent (long-standing behaviour, kept as-is).
    expect(mapToUpdateAPI({ custom_interval_days: 10 })).toEqual({});
  });

  it("forwards loan, active-state and tag updates", () => {
    expect(
      mapToUpdateAPI({
        is_loan: true,
        loan_type: "interest_only",
        loan_principal: 5000,
        loan_annual_interest_rate: 2,
        loan_term_months: 12,
        loan_start_date: "2025-02-01",
        loan_payment_day: 15,
        is_active: false,
        tags: ["loan"],
      }),
    ).toEqual({
      is_loan: true,
      loan_type: "interest_only",
      loan_principal: 5000,
      loan_annual_interest_rate: 2,
      loan_term_months: 12,
      loan_start_date: "2025-02-01",
      loan_payment_day: 15,
      is_active: false,
      tags: ["loan"],
    });
  });
});

describe("round-trip", () => {
  it("a recurring bounded server row survives mapFromAPI -> mapToCreateAPI", () => {
    const pt = makePT({
      recurrence_pattern: "every 10 days",
      recurrence_end_date: "2026-12-31",
      max_occurrences: 12,
    });
    const created = mapToCreateAPI(mapFromAPI(pt));
    expect(created.planned_date).toBe(pt.planned_date);
    expect(created.memo).toBe(pt.memo);
    expect(created.amount).toBe(pt.amount);
    expect(created.currency).toBe(pt.currency);
    expect(created.is_recurring).toBe(true);
    expect(created.recurrence_pattern).toBe("every 10 days");
    expect(created.recurrence_end_date).toBe("2026-12-31");
    expect(created.max_occurrences).toBe(12);
  });

  it("a loan server row survives mapFromAPI -> mapToUpdateAPI", () => {
    const pt = makePT({
      is_loan: true,
      loan_type: "fixed_principal",
      loan_principal: 24000,
      loan_annual_interest_rate: 4.2,
      loan_term_months: 48,
      loan_start_date: "2025-02-01",
      loan_payment_day: 5,
    });
    const update = mapToUpdateAPI(mapFromAPI(pt));
    expect(update).toMatchObject({
      is_loan: true,
      loan_type: "fixed_principal",
      loan_principal: 24000,
      loan_annual_interest_rate: 4.2,
      loan_term_months: 48,
      loan_start_date: "2025-02-01",
      loan_payment_day: 5,
    });
  });
});
