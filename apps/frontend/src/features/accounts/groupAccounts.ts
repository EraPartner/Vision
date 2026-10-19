/**
 * Grouped-hub partitioning (WP-B3, ADR-107 §3 F8) — pure presentation helpers
 * for grouping and ordering. The group subtotals and "Net cash" are computed on
 * the server (GET /api/accounts/totals, ADR-216) with the same groups.
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

/** Portfolio accounts whose value and activity live only in holdings. */
export function isHoldingsOnlyPortfolioType(type: AccountType): boolean {
    return type === "crypto_exchange" || type === "wallet";
}

export function accountLabel(
    a: Pick<Account, "display_name" | "name">,
): string {
    return a.display_name || a.name;
}

/** Archived overrides type: every inactive account lands in "archived". */
export function accountGroupId(
    a: Pick<Account, "type" | "is_active">,
): AccountGroupId {
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
export function groupAccounts(
    accounts: Account[],
    locale?: string,
): AccountGroup[] {
    const buckets = new Map<AccountGroupId, Account[]>(
        ACCOUNT_GROUP_ORDER.map((id) => [id, []]),
    );
    for (const a of accounts) {
        buckets.get(accountGroupId(a))!.push(a);
    }
    const collator = new Intl.Collator(locale, {
        sensitivity: "base",
        numeric: true,
    });
    return ACCOUNT_GROUP_ORDER.map((id) => ({
        id,
        accounts: [...buckets.get(id)!].sort((a, b) => {
            const byLabel = collator.compare(accountLabel(a), accountLabel(b));
            return byLabel !== 0 ? byLabel : a.id - b.id;
        }),
    })).filter((g) => g.accounts.length > 0);
}
