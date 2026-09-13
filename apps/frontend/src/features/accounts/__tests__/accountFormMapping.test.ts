import { describe, expect, it } from "vitest";
import { toAccountEditPayload } from "../accountFormMapping";
import type { AccountFormValues } from "../AddAccountDialog";

const values: AccountFormValues = {
    name: "Main",
    display_name: "Main",
    institution: "Bank",
    currency: "EUR",
    type: "checking",
    owner: "me",
    liquidity_class: "liquid",
    tax_wrapper: "none",
    spendable: true,
    in_net_worth: true,
    multi_currency_cash: false,
    has_cash_sleeve: false,
};

describe("toAccountEditPayload", () => {
    it("keeps statement readings out of account metadata updates", () => {
        const payload = toAccountEditPayload(values, "EUR", "eu");
        expect(payload.currency).toBe("EUR");
        expect(payload).not.toHaveProperty("statement_balance");
        expect(payload).not.toHaveProperty("statement_balance_date");
    });

    it("does not relabel the original statement reading when currency changes", () => {
        const payload = toAccountEditPayload(
            { ...values, currency: "USD" },
            "EUR",
            "eu",
        );
        expect(payload.currency).toBe("USD");
        expect(payload).not.toHaveProperty("statement_balance");
        expect(payload).not.toHaveProperty("statement_balance_date");
    });
});
