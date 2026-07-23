/**
 * Grouped-hub partitioning (WP-B3, ADR-107 §3 F8) — pure helpers so the
 * grouping, ordering and the "Net cash" reconciliation are unit-testable
 * without rendering.
 *
 * Groups (fixed order):
 *   cash        — checking · savings · pension
 *   portfolio   — brokerage · crypto_exchange · wallet (holdings arrive in WP-C5)
 *   liabilities — liability
 *   archived    — any account with is_active === false, regardless of type
 *                 (replaces the old Show-archived toggle; rendered collapsed)
 */

import type { Account, AccountType } from "@/types/api";

export type AccountGroupId = "cash" | "portfolio" | "liabilities" | "archived";

export const ACCOUNT_GROUP_ORDER: readonly AccountGroupId[] = [
    "cash",
    "portfolio",
    "liabilities",
    "archived",
] as const;

/** Types whose value lives in portfolio holdings, not the ledger (until WP-C5). */
export const PORTFOLIO_ACCOUNT_TYPES: readonly AccountType[] = [
    "brokerage",
    "crypto_exchange",
    "wallet",
] as const;

export function isPortfolioType(type: AccountType): boolean {
    return (PORTFOLIO_ACCOUNT_TYPES as readonly string[]).includes(type);
}

export function accountLabel(a: Pick<Account, "display_name" | "name">): string {
    return a.display_name || a.name;
}

/** Archived overrides type: every inactive account lands in "archived". */
export function accountGroupId(a: Pick<Account, "type" | "is_active">): AccountGroupId {
    if (a.is_active === false) return "archived";
    if (a.type === "liability") return "liabilities";
    if (isPortfolioType(a.type)) return "portfolio";
    return "cash";
}

export interface AccountGroup {
    id: AccountGroupId;
    accounts: Account[];
}

/**
 * Partition accounts into the four ordered groups. Within a group, accounts
 * sort by display label (locale-aware via Intl.Collator) with the numeric id
 * as a deterministic tie-breaker. Empty groups are omitted.
 */
export function groupAccounts(accounts: Account[], locale?: string): AccountGroup[] {
    const buckets = new Map<AccountGroupId, Account[]>(
        ACCOUNT_GROUP_ORDER.map((id) => [id, []]),
    );
    for (const a of accounts) {
        buckets.get(accountGroupId(a))!.push(a);
    }
    const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
    return ACCOUNT_GROUP_ORDER
        .map((id) => ({
            id,
            accounts: [...buckets.get(id)!].sort(
                (a, b) => collator.compare(accountLabel(a), accountLabel(b)) || a.id - b.id,
            ),
        }))
        .filter((g) => g.accounts.length > 0);
}

export type ConvertFn = (amount: number, fromCurrency?: string) => number;

/**
 * Converted subtotal of a set of accounts' computed balances (native →
 * display currency). Liability balances are negative, so a Liabilities
 * subtotal is naturally negative. Accounts without a computed balance
 * contribute 0.
 */
export function sumConvertedBalances(accounts: Account[], convert: ConvertFn): number {
    return accounts.reduce(
        (sum, a) => sum + convert(a.computed_balance ?? 0, a.currency),
        0,
    );
}

/**
 * The grand "Net cash" line — Σ converted computed_balance over ACTIVE,
 * in_net_worth accounts outside the portfolio group (i.e. Cash & Savings +
 * Liabilities). This is WP-A1's net-worth Liquid + Liabilities population
 * (in_net_worth gates aggregates, ADR-089), minus portfolio-type ledger
 * balances which aren't real value until WP-C5's holdings land. Signs come
 * from the balances themselves (liabilities negative), so the sum is the net.
 */
export function computeNetCash(accounts: Account[], convert: ConvertFn): number {
    return sumConvertedBalances(
        accounts.filter(
            (a) => a.is_active && a.in_net_worth && !isPortfolioType(a.type),
        ),
        convert,
    );
}
