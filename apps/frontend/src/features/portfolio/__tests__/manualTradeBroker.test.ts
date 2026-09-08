import { describe, expect, it } from "vitest";
import type { Account, PortfolioTransaction } from "@/types/api";
import {
    activeBrokerAccounts,
    resolveManualTradeBrokerId,
} from "@/features/portfolio/manualTradeBroker";

function account(id: number, overrides: Partial<Account> = {}): Account {
    return {
        id,
        name: `Broker ${id}`,
        currency: "EUR",
        type: "brokerage",
        liquidity_class: "liquid",
        spendable: false,
        in_net_worth: true,
        tax_wrapper: "none",
        owner: "me",
        multi_currency_cash: false,
        has_cash_sleeve: false,
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

function transaction(
    id: number,
    investmentId: number,
    accountId: number | undefined,
    overrides: Partial<PortfolioTransaction> = {},
): PortfolioTransaction {
    return {
        id,
        investment_id: investmentId,
        type: "buy",
        date: `2026-01-${String(id).padStart(2, "0")}`,
        amount: 100,
        currency: "EUR",
        account_id: accountId,
        import_batch_id: null,
        is_recurring: false,
        created_at: `2026-01-${String(id).padStart(2, "0")}T12:00:00Z`,
        updated_at: `2026-01-${String(id).padStart(2, "0")}T12:00:00Z`,
        ...overrides,
    };
}

describe("manual trade broker defaults", () => {
    const accounts = [account(1), account(2), account(3)];

    it("prefers the instrument's most recent assigned broker", () => {
        expect(
            resolveManualTradeBrokerId({
                investmentId: 10,
                accounts,
                transactions: [
                    transaction(1, 10, 1),
                    transaction(2, 20, 3),
                    transaction(3, 10, 2),
                ],
            }),
        ).toBe(2);
    });

    it("falls back to the latest manually entered broker", () => {
        expect(
            resolveManualTradeBrokerId({
                investmentId: 99,
                accounts,
                transactions: [
                    transaction(1, 10, 1),
                    transaction(3, 20, 3, { import_batch_id: "42" }),
                    transaction(2, 20, 2),
                ],
            }),
        ).toBe(2);
    });

    it("ignores archived and non-portfolio accounts and permits Unassigned", () => {
        const available = [
            account(1, { is_active: false }),
            account(2, { type: "checking" }),
        ];
        expect(activeBrokerAccounts(available)).toEqual([]);
        expect(
            resolveManualTradeBrokerId({
                investmentId: 10,
                accounts: available,
                transactions: [transaction(2, 10, 1), transaction(3, 20, 2)],
            }),
        ).toBeUndefined();
    });
});
