import { isHoldingsOnlyPortfolioType } from "@/features/accounts/groupAccounts";
import { addAll, roundMoney, toNumber } from "@/lib/money";
import type { PortfolioSummaryResponse } from "@/lib/api/info";
import type { Account } from "@/types/api";

export interface NetWorthAccountRow {
    key: string;
    accountId: number | null;
    label: string;
    cash: number;
    holdings: number;
    total: number;
}

export function buildNetWorthAccountRows(
    accounts: readonly Account[],
    summary: PortfolioSummaryResponse,
    convertToTarget: (amount: number, currency?: string) => number | undefined,
    unassignedLabel: string,
): NetWorthAccountRow[] | undefined {
    const accountsById = new Map(
        accounts.map((account) => [account.id, account]),
    );
    const values = new Map<
        number | null,
        { cash: number[]; holdings: number[] }
    >();
    const getValue = (accountId: number | null) => {
        const current = values.get(accountId) ?? { cash: [], holdings: [] };
        values.set(accountId, current);
        return current;
    };

    for (const account of accounts) {
        if (!account.in_net_worth) continue;
        const value = getValue(account.id);
        if (!isHoldingsOnlyPortfolioType(account.type)) {
            const converted = convertToTarget(
                account.computed_balance ?? 0,
                account.currency,
            );
            if (converted === undefined) return undefined;
            value.cash.push(converted);
        }
    }
    for (const partition of summary.byAccount) {
        getValue(partition.account_id).holdings.push(partition.currentValue);
    }

    return [...values.entries()]
        .map(([accountId, value]) => {
            const account =
                accountId == null ? undefined : accountsById.get(accountId);
            const cash = roundMoney(addAll(value.cash));
            const holdings = roundMoney(addAll(value.holdings));
            return {
                key: accountId == null ? "unassigned" : `account-${accountId}`,
                accountId,
                label:
                    accountId == null
                        ? unassignedLabel
                        : account?.display_name ||
                          account?.name ||
                          `#${accountId}`,
                cash,
                holdings,
                total: roundMoney(addAll([cash, holdings])),
            };
        })
        .sort((a, b) => {
            if (a.accountId == null) return 1;
            if (b.accountId == null) return -1;
            return a.label.localeCompare(b.label, undefined, {
                sensitivity: "base",
                numeric: true,
            });
        });
}

export function sumNetWorthAccountRows(rows: readonly NetWorthAccountRow[]) {
    return toNumber(addAll(rows.map((row) => row.total)));
}
