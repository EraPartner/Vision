// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import type { Account } from "@/types/api";
import { AccountsList } from "../AccountsList";
import { asAccountId, asCurrencyCode } from "@vision/types/brands";

const state = vi.hoisted(() => ({ items: [] as Account[], usdRate: 0.5 }));

// Stand-in for GET /api/accounts/totals: the server converts each balance
// (USD at `usdRate`, no rate for any other currency).
vi.mock("@/hooks/useAccounts", () => ({
    useAccounts: () => ({ data: { items: state.items } }),
    useAccountTotals: () => ({
        data: {
            accounts: state.items.map((item) => {
                const balance = item.computed_balance ?? 0;
                const rate =
                    item.currency === "EUR"
                        ? 1
                        : item.currency === "USD"
                          ? state.usdRate
                          : undefined;
                return {
                    id: item.id,
                    converted_balance: rate === undefined ? 0 : balance * rate,
                    unconverted_currencies:
                        rate === undefined ? [item.currency] : [],
                };
            }),
        },
    }),
}));

function account(id: number, balance?: number, currency = "EUR"): Account {
    return {
        id: asAccountId(id),
        name: `Account ${id}`,
        type: "checking",
        currency: asCurrencyCode(currency),
        liquidity_class: "liquid",
        spendable: true,
        in_net_worth: true,
        tax_wrapper: "none",
        owner: "me",
        multi_currency_cash: false,
        has_cash_sleeve: false,
        is_active: true,
        created_at: "2026-10-10",
        computed_balance: balance,
    };
}

function rowIds() {
    return screen
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
        .filter((href) => href?.startsWith("/accounts/"));
}

beforeEach(() => {
    state.items = [];
    state.usdRate = 0.5;
});

describe("Home AccountsList", () => {
    it("selects the six highest balances across all accounts without mutating cached rows", () => {
        state.items = Array.from({ length: 8 }, (_, index) =>
            account(index + 1, index * 10),
        );
        renderWithApp(<AccountsList />);
        expect(rowIds()).toEqual(
            [8, 7, 6, 5, 4, 3].map((id) => `/accounts/${id}`),
        );
        expect(state.items.map(({ id }) => id)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8,
        ]);
    });

    it("compares converted balances, preserves ties, and places unavailable balances last", () => {
        state.items = [
            account(1, 100, "USD"),
            account(2, 75),
            account(3, 50),
            account(4, undefined),
            account(5, 1000, "XYZ"),
            account(6, -10),
        ];
        renderWithApp(<AccountsList />);
        expect(rowIds()).toEqual(
            [2, 1, 3, 6, 4, 5].map((id) => `/accounts/${id}`),
        );
        expect(
            screen.getByRole("link", { name: /^Account 1Checking/ }),
        ).toHaveTextContent(/100,00/);
    });

    it("reorders when balances or exchange rates update", () => {
        state.items = [account(1, 100, "USD"), account(2, 75)];
        const { rerender } = renderWithApp(<AccountsList />);
        expect(rowIds()).toEqual(["/accounts/2", "/accounts/1"]);
        state.usdRate = 1;
        rerender(<AccountsList />);
        expect(rowIds()).toEqual(["/accounts/1", "/accounts/2"]);
        state.items = [account(1, 100, "USD"), account(2, 150)];
        rerender(<AccountsList />);
        expect(rowIds()).toEqual(["/accounts/2", "/accounts/1"]);
    });
});
