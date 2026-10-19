import { describe, expect, it } from "vitest";
import type { Account, AccountType } from "@/types/api";
import {
    ACCOUNT_GROUP_ORDER,
    accountGroupId,
    accountLabel,
    groupAccounts,
    isHoldingsOnlyPortfolioType,
    isPortfolioType,
} from "@/features/accounts/groupAccounts";
import { asAccountId, asCurrencyCode } from "@vision/types/brands";

let nextId = 1;

function makeAccount(overrides: Partial<Account> = {}): Account {
    const id = overrides.id ?? nextId++;
    return {
        id: asAccountId(id),
        name: `Account ${id}`,
        currency: asCurrencyCode("EUR"),
        type: "checking",
        liquidity_class: "liquid",
        spendable: true,
        in_net_worth: true,
        tax_wrapper: "none",
        owner: "me",
        multi_currency_cash: false,
        has_cash_sleeve: false,
        computed_balance: 0,
        is_active: true,
        created_at: "2025-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("accountGroupId", () => {
    it.each([
        ["checking", "cash"],
        ["savings", "cash"],
        ["pension", "cash"],
        ["brokerage", "portfolio"],
        ["crypto_exchange", "portfolio"],
        ["wallet", "portfolio"],
        ["liability", "liabilities"],
    ] as [AccountType, string][])("routes active %s → %s", (type, group) => {
        expect(accountGroupId(makeAccount({ type }))).toBe(group);
    });

    it.each([
        "checking",
        "savings",
        "pension",
        "brokerage",
        "crypto_exchange",
        "wallet",
        "liability",
    ] as AccountType[])(
        "archived overrides type: inactive %s → archived",
        (type) => {
            expect(
                accountGroupId(makeAccount({ type, is_active: false })),
            ).toBe("archived");
        },
    );
});

describe("isPortfolioType", () => {
    it("flags exactly brokerage/crypto_exchange/wallet", () => {
        const portfolio: AccountType[] = [
            "brokerage",
            "crypto_exchange",
            "wallet",
        ];
        const rest: AccountType[] = [
            "checking",
            "savings",
            "pension",
            "liability",
        ];
        portfolio.forEach((tp) => expect(isPortfolioType(tp)).toBe(true));
        rest.forEach((tp) => expect(isPortfolioType(tp)).toBe(false));
    });
});

describe("isHoldingsOnlyPortfolioType", () => {
    it("flags wallets and crypto exchanges without suppressing brokerage cash", () => {
        const holdingsOnly: AccountType[] = ["crypto_exchange", "wallet"];
        const rest: AccountType[] = [
            "checking",
            "savings",
            "brokerage",
            "pension",
            "liability",
        ];
        holdingsOnly.forEach((type) =>
            expect(isHoldingsOnlyPortfolioType(type)).toBe(true),
        );
        rest.forEach((type) =>
            expect(isHoldingsOnlyPortfolioType(type)).toBe(false),
        );
    });
});

describe("groupAccounts", () => {
    it("partitions into the fixed group order with archived last", () => {
        const accounts = [
            makeAccount({ type: "liability", name: "Mortgage" }),
            makeAccount({ type: "brokerage", name: "Degiro" }),
            makeAccount({ type: "checking", name: "KBC" }),
            makeAccount({
                type: "savings",
                name: "Old savings",
                is_active: false,
            }),
        ];
        const groups = groupAccounts(accounts);
        expect(groups.map((g) => g.id)).toEqual([
            "cash",
            "portfolio",
            "liabilities",
            "archived",
        ]);
        expect(ACCOUNT_GROUP_ORDER).toEqual([
            "cash",
            "portfolio",
            "liabilities",
            "archived",
        ]);
    });

    it("omits empty groups", () => {
        const groups = groupAccounts([makeAccount({ type: "checking" })]);
        expect(groups.map((g) => g.id)).toEqual(["cash"]);
    });

    it("returns no groups for no accounts", () => {
        expect(groupAccounts([])).toEqual([]);
    });

    it("sorts within a group by display label (display_name over name), locale-aware", () => {
        const groups = groupAccounts([
            makeAccount({ id: asAccountId(1), name: "zzz-internal", display_name: "Bunq" }),
            makeAccount({ id: asAccountId(2), name: "argenta savings", type: "savings" }),
            makeAccount({ id: asAccountId(3), name: "KBC Checking" }),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.accounts.map(accountLabel)).toEqual([
            "argenta savings", // case-insensitive: lowercase a before B/K
            "Bunq",
            "KBC Checking",
        ]);
    });

    it("breaks label ties deterministically by id", () => {
        const groups = groupAccounts([
            makeAccount({ id: asAccountId(9), name: "Twin" }),
            makeAccount({ id: asAccountId(2), name: "Twin" }),
        ]);
        expect(groups[0]?.accounts.map((a) => a.id)).toEqual([2, 9]);
    });

    it("routes every inactive account to archived regardless of type, sorted by label", () => {
        const groups = groupAccounts([
            makeAccount({
                id: asAccountId(1),
                name: "B liability",
                type: "liability",
                is_active: false,
            }),
            makeAccount({
                id: asAccountId(2),
                name: "A broker",
                type: "brokerage",
                is_active: false,
            }),
            makeAccount({ id: asAccountId(3), name: "C checking", is_active: false }),
        ]);
        expect(groups.map((g) => g.id)).toEqual(["archived"]);
        expect(groups[0]?.accounts.map((a) => a.name)).toEqual([
            "A broker",
            "B liability",
            "C checking",
        ]);
    });
});
