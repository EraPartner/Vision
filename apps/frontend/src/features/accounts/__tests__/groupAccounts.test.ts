import { describe, expect, it } from "vitest";
import type { Account, AccountType } from "@/types/api";
import {
    ACCOUNT_GROUP_ORDER,
    accountGroupId,
    accountLabel,
    computeNetCash,
    groupAccounts,
    isPortfolioType,
    sumConvertedBalances,
} from "@/features/accounts/groupAccounts";

let nextId = 1;

function makeAccount(overrides: Partial<Account> = {}): Account {
    const id = overrides.id ?? nextId++;
    return {
        id,
        name: `Account ${id}`,
        currency: "EUR",
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

const identity = (amount: number) => amount;

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
        "checking", "savings", "pension", "brokerage", "crypto_exchange", "wallet", "liability",
    ] as AccountType[])("archived overrides type: inactive %s → archived", (type) => {
        expect(accountGroupId(makeAccount({ type, is_active: false }))).toBe("archived");
    });
});

describe("isPortfolioType", () => {
    it("flags exactly brokerage/crypto_exchange/wallet", () => {
        const portfolio: AccountType[] = ["brokerage", "crypto_exchange", "wallet"];
        const rest: AccountType[] = ["checking", "savings", "pension", "liability"];
        portfolio.forEach((tp) => expect(isPortfolioType(tp)).toBe(true));
        rest.forEach((tp) => expect(isPortfolioType(tp)).toBe(false));
    });
});

describe("groupAccounts", () => {
    it("partitions into the fixed group order with archived last", () => {
        const accounts = [
            makeAccount({ type: "liability", name: "Mortgage" }),
            makeAccount({ type: "brokerage", name: "Degiro" }),
            makeAccount({ type: "checking", name: "KBC" }),
            makeAccount({ type: "savings", name: "Old savings", is_active: false }),
        ];
        const groups = groupAccounts(accounts);
        expect(groups.map((g) => g.id)).toEqual(["cash", "portfolio", "liabilities", "archived"]);
        expect(ACCOUNT_GROUP_ORDER).toEqual(["cash", "portfolio", "liabilities", "archived"]);
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
            makeAccount({ id: 1, name: "zzz-internal", display_name: "Bunq" }),
            makeAccount({ id: 2, name: "argenta savings", type: "savings" }),
            makeAccount({ id: 3, name: "KBC Checking" }),
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].accounts.map(accountLabel)).toEqual([
            "argenta savings", // case-insensitive: lowercase a before B/K
            "Bunq",
            "KBC Checking",
        ]);
    });

    it("breaks label ties deterministically by id", () => {
        const groups = groupAccounts([
            makeAccount({ id: 9, name: "Twin" }),
            makeAccount({ id: 2, name: "Twin" }),
        ]);
        expect(groups[0].accounts.map((a) => a.id)).toEqual([2, 9]);
    });

    it("routes every inactive account to archived regardless of type, sorted by label", () => {
        const groups = groupAccounts([
            makeAccount({ id: 1, name: "B liability", type: "liability", is_active: false }),
            makeAccount({ id: 2, name: "A broker", type: "brokerage", is_active: false }),
            makeAccount({ id: 3, name: "C checking", is_active: false }),
        ]);
        expect(groups.map((g) => g.id)).toEqual(["archived"]);
        expect(groups[0].accounts.map((a) => a.name)).toEqual([
            "A broker", "B liability", "C checking",
        ]);
    });
});

describe("sumConvertedBalances", () => {
    it("sums converted computed balances, treating missing balances as 0", () => {
        const accounts = [
            makeAccount({ computed_balance: 100, currency: "EUR" }),
            makeAccount({ computed_balance: 50, currency: "USD" }),
            makeAccount({ computed_balance: undefined }),
        ];
        const double = (amount: number, from?: string) => (from === "USD" ? amount * 2 : amount);
        expect(sumConvertedBalances(accounts, double)).toBe(200);
    });

    it("is naturally negative for liability balances", () => {
        const accounts = [
            makeAccount({ type: "liability", computed_balance: -1200 }),
            makeAccount({ type: "liability", computed_balance: -300 }),
        ];
        expect(sumConvertedBalances(accounts, identity)).toBe(-1500);
    });
});

describe("computeNetCash — reconciles with the WP-A1 Liquid+Liabilities population", () => {
    // Same-currency fixture so FX is identity: the reconciliation under test is
    // POPULATION + SIGN, matching WP-A1's net-worth definition (in_net_worth
    // gates aggregates; liabilities enter with their negative sign; portfolio
    // ledger balances are excluded until WP-C5 makes them real).
    const inNetWorthChecking = makeAccount({ type: "checking", computed_balance: 1000 });
    const inNetWorthSavings = makeAccount({ type: "savings", computed_balance: 500 });
    const inNetWorthLiability = makeAccount({ type: "liability", computed_balance: -300 });
    const notInNetWorth = makeAccount({
        type: "checking", in_net_worth: false, computed_balance: 999,
    });
    const archived = makeAccount({
        type: "savings", is_active: false, computed_balance: 555,
    });
    const portfolioBrokerage = makeAccount({ type: "brokerage", computed_balance: 42 });
    const fixture = [
        inNetWorthChecking, inNetWorthSavings, inNetWorthLiability,
        notInNetWorth, archived, portfolioBrokerage,
    ];

    it("equals Σ(in_net_worth, active, non-portfolio computed_balance) — 1000 + 500 − 300", () => {
        expect(computeNetCash(fixture, identity)).toBe(1200);
    });

    it("matches the Cash&Savings + Liabilities group subtotals over in_net_worth accounts", () => {
        const groups = groupAccounts(fixture);
        const netCashFromGroups = groups
            .filter((g) => g.id === "cash" || g.id === "liabilities")
            .flatMap((g) => g.accounts)
            .filter((a) => a.in_net_worth)
            .reduce((sum, a) => sum + (a.computed_balance ?? 0), 0);
        expect(computeNetCash(fixture, identity)).toBe(netCashFromGroups);
    });

    it("excludes the not-in-net-worth account", () => {
        expect(computeNetCash([...fixture], identity))
            .toBe(computeNetCash(fixture.filter((a) => a !== notInNetWorth), identity));
    });

    it("excludes the archived account", () => {
        expect(computeNetCash([...fixture], identity))
            .toBe(computeNetCash(fixture.filter((a) => a !== archived), identity));
    });

    it("excludes portfolio-type ledger balances", () => {
        expect(computeNetCash([...fixture], identity))
            .toBe(computeNetCash(fixture.filter((a) => a !== portfolioBrokerage), identity));
    });

    it("carries the liability's negative sign into the net", () => {
        const withoutLiability = fixture.filter((a) => a !== inNetWorthLiability);
        expect(computeNetCash(fixture, identity))
            .toBe(computeNetCash(withoutLiability, identity) - 300);
    });
});
